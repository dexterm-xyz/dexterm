// dexterm autotrade — the trade-fire outbox (task-1645, 0.2.0 card A).
//
// Every real-mode signal is written here (fsync) BEFORE the runner books its fill, then delivered to each channel
// the user enabled: at-least-once, in nonce order per channel, retried with backoff (1 s doubling to 30 s) until
// the channel acks, rejects it for good, or the signal's TTL passes (then it is marked expired and never sent late).
//
//   $DEXTERM_HOME/autotrade/real/outbox.jsonl   append-only records, replayed on open (a restart resumes delivery)
//       {k:"enq", signal, channels}             a signal and the channels it was addressed to
//       {k:"ack"|"rej"|"exp"|"drop", nonce, ch} a channel's terminal outcome (drop: the channel is no longer set up)
//       {k:"try", nonce, ch, why, attempt}      a failed attempt (retried)
//       {k:"run", runId, state:"open"|"closed"} run markers: a run left "open" died without its halted signal
//       {k:"base", lastNonce}                   the head of an outbox started by compaction (r2): the nonce floor
//   $DEXTERM_HOME/autotrade/real/nonce.json     the last nonce handed out (written before the signal exists)
//   $DEXTERM_HOME/autotrade/real/outbox.lock    one writer at a time (a stale lock of a dead pid is reclaimed)
//
// Nonces only grow: the next one is max(nonce.json, the outbox's base record, the newest in the outbox) + 1, so
// neither a restart, a compaction nor a lost nonce file can hand out a number twice. A record that cannot be parsed is skipped and counted (`corrupt`).

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from './ledger.ts';
import { validateSignal, type TradeFireSignal } from './signal.ts';

export type ChannelName = 'webhook' | 'cmd' | 'jsonl' | 'mcp' | 'telegram';
export const CHANNEL_NAMES: readonly ChannelName[] = ['webhook', 'cmd', 'jsonl', 'mcp', 'telegram'];
/** Channels an executor can read. The Telegram copy is for the human: a bot cannot read another bot's messages. */
export const EXECUTOR_CHANNELS: readonly ChannelName[] = ['webhook', 'cmd', 'jsonl', 'mcp'];

export type DeliveryResult = { ok: true; duplicate?: boolean } | { ok: false; retry: boolean; why: string };

export interface SignalChannel {
  readonly name: ChannelName;
  deliver(signal: TradeFireSignal, line: string): Promise<DeliveryResult>;
}

export const realDir = (home: string): string => join(home, 'autotrade', 'real');
export const outboxPath = (home: string): string => join(realDir(home), 'outbox.jsonl');
export const noncePath = (home: string): string => join(realDir(home), 'nonce.json');
const lockPath = (home: string): string => join(realDir(home), 'outbox.lock');

export const BACKOFF_MIN_MS = 1000;
export const BACKOFF_MAX_MS = 30_000;
const COMPACT_ABOVE_BYTES = 1 << 20;
const MAX_PER_PUMP = 50;

type Terminal = 'ack' | 'rej' | 'exp' | 'drop';
interface ChanState { done: Terminal | null; dup?: boolean; attempts: number; nextAt: number; lastWhy: string | null }
interface Entry { signal: TradeFireSignal; line: string; ch: Map<ChannelName, ChanState> }

export interface ChannelHealth { name: ChannelName; pending: number; lastOkAt: number | null; lastErrAt: number | null; lastErr: string | null; failing: number }
export type SignalState = 'pending' | 'delivered' | 'partial' | 'expired' | 'rejected';
export interface PumpReport { acked: number; retried: number; rejected: number; expired: number; dropped: number }

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };

function appendSync(path: string, line: string): void {
  const fd = openSync(path, 'a', 0o600);
  try { writeSync(fd, line.endsWith('\n') ? line : `${line}\n`); fsyncSync(fd); } finally { closeSync(fd); }
}

export interface OutboxOpts {
  channels: SignalChannel[];
  now?: () => number;
  /** Set up but not reachable from this process (the Telegram copy outside a run): left pending, never dropped. */
  defer?: ChannelName[];
  /** Read-only views and tests: skip the single-writer lock (and compaction). */
  noLock?: boolean;
}

export class Outbox {
  readonly home: string;
  readonly path: string;
  private channels = new Map<ChannelName, SignalChannel>();
  private readonly defer: Set<ChannelName>;
  private readonly entries: Entry[] = [];
  private readonly byNonce = new Map<number, Entry>();
  private readonly runs = new Map<string, { state: 'open' | 'closed'; at: number; strategy?: TradeFireSignal['strategy']; accountId?: string; reason?: string }>();
  private readonly health = new Map<ChannelName, ChannelHealth>();
  private readonly now: () => number;
  private lastNonce = 0;
  private running: Promise<PumpReport> | null = null;
  private queued: Promise<PumpReport> | null = null;
  private locked = false;
  corrupt = 0;

  private constructor(home: string, o: OutboxOpts) {
    this.home = home;
    this.path = outboxPath(home);
    this.now = o.now ?? Date.now;
    for (const c of o.channels) this.channels.set(c.name, c);
    this.defer = new Set(o.defer ?? []);
  }

  /** Open (and replay) the outbox of a dexterm home. Throws when another live process holds it. */
  static open(home: string, o: OutboxOpts): Outbox {
    mkdirSync(realDir(home), { recursive: true, mode: 0o700 });
    const b = new Outbox(home, o);
    if (!o.noLock) b.lock();
    b.replay();
    // Only the lock holder compacts (it writes): a read-only view never moves the file under a running writer.
    if (!o.noLock) b.compact();
    return b;
  }

  private lock(): void {
    const p = lockPath(this.home);
    for (let i = 0; i < 2; i++) {
      try { const fd = openSync(p, 'wx', 0o600); writeSync(fd, `${JSON.stringify({ pid: process.pid, at: this.now() })}\n`); closeSync(fd); this.locked = true; return; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
      let pid = 0;
      try { pid = Number((JSON.parse(readFileSync(p, 'utf8')) as { pid?: number }).pid) || 0; } catch { pid = 0; }
      if (pid && pid !== process.pid && alive(pid)) throw new Error(`the trade-fire outbox is in use by pid ${pid} (a running real-mode runner); stop it first`);
      rmSync(p, { force: true });
    }
    throw new Error('could not lock the trade-fire outbox');
  }

  close(): void {
    if (!this.locked) return;
    try { const d = JSON.parse(readFileSync(lockPath(this.home), 'utf8')) as { pid?: number }; if (d.pid === process.pid) rmSync(lockPath(this.home), { force: true }); } catch { /* gone */ }
    this.locked = false;
  }

  /** Swap the channel set (config changed). Pending deliveries to a channel that is gone are dropped at the next pump. */
  setChannels(cs: SignalChannel[]): void { this.channels = new Map(cs.map((c) => [c.name, c])); }
  channelNames(): ChannelName[] { return [...this.channels.keys()]; }

  private replay(): void {
    if (existsSync(noncePath(this.home))) {
      try { const n = Number((JSON.parse(readFileSync(noncePath(this.home), 'utf8')) as { last?: number }).last); if (Number.isSafeInteger(n) && n > 0) this.lastNonce = n; } catch { this.corrupt++; }
    }
    if (!existsSync(this.path)) return;
    for (const raw of readFileSync(this.path, 'utf8').split('\n')) {
      if (!raw.trim()) continue;
      let r: Record<string, unknown>;
      try { r = JSON.parse(raw) as Record<string, unknown>; } catch { this.corrupt++; continue; }
      this.apply(r, false);
    }
  }

  /** Apply one record to the in-memory state (replay and live writes share this). */
  private apply(r: Record<string, unknown>, live: boolean): void {
    const at = typeof r.at === 'number' ? r.at : 0;
    if (r.k === 'enq') {
      const v = validateSignal(r.signal);
      if (!v.ok || this.byNonce.has(v.signal.nonce)) { this.corrupt++; return; }
      const chs = Array.isArray(r.channels) ? (r.channels as unknown[]).filter((c): c is ChannelName => CHANNEL_NAMES.includes(c as ChannelName)) : [];
      const e: Entry = { signal: v.signal, line: JSON.stringify(v.signal), ch: new Map(chs.map((c) => [c, { done: null, attempts: 0, nextAt: 0, lastWhy: null }])) };
      this.entries.push(e);
      this.byNonce.set(e.signal.nonce, e);
      this.lastNonce = Math.max(this.lastNonce, e.signal.nonce);
      return;
    }
    if (r.k === 'base') {
      const n = Number(r.lastNonce);
      if (Number.isSafeInteger(n) && n > 0) this.lastNonce = Math.max(this.lastNonce, n); else this.corrupt++;
      return;
    }
    if (r.k === 'run' && typeof r.runId === 'string') {
      this.runs.set(r.runId, { state: r.state === 'closed' ? 'closed' : 'open', at, strategy: r.strategy as TradeFireSignal['strategy'] | undefined, accountId: typeof r.accountId === 'string' ? r.accountId : undefined, reason: typeof r.reason === 'string' ? r.reason : undefined });
      return;
    }
    const e = this.byNonce.get(Number(r.nonce));
    const name = r.ch as ChannelName;
    const st = e?.ch.get(name);
    if (!e || !st) { if (!live && !['try', 'ack', 'rej', 'exp', 'drop'].includes(String(r.k))) this.corrupt++; return; }
    if (r.k === 'try') { st.attempts = Number(r.attempt) || st.attempts + 1; st.lastWhy = String(r.why ?? '').slice(0, 200); st.nextAt = at + backoff(st.attempts); return; }
    if (r.k === 'ack' || r.k === 'rej' || r.k === 'exp' || r.k === 'drop') { st.done = r.k; st.dup = r.dup === true; st.lastWhy = typeof r.why === 'string' ? r.why.slice(0, 200) : st.lastWhy; }
  }

  private write(r: Record<string, unknown>): void {
    appendSync(this.path, JSON.stringify(r));
    this.apply(r, true);
  }

  /** Move a fully settled outbox aside once it is large (the run ledgers keep every signal for the audit). */
  private compact(): void {
    if (!existsSync(this.path) || statSync(this.path).size < COMPACT_ABOVE_BYTES) return;
    if (this.entries.some((e) => [...e.ch.values()].some((c) => !c.done)) || [...this.runs.values()].some((r) => r.state === 'open')) return;
    renameSync(this.path, join(realDir(this.home), `outbox.${this.now()}.done.jsonl`));
    this.entries.length = 0;
    this.byNonce.clear();
    this.runs.clear();
    // The fresh outbox starts with the nonce floor, so a lost nonce.json can never restart the count at 1.
    if (this.lastNonce > 0) this.write({ k: 'base', at: this.now(), lastNonce: this.lastNonce });
  }

  /** The next nonce, persisted before it is used (so a crash after this line can only skip a number, never reuse one). */
  allocateNonce(): number {
    const n = this.lastNonce + 1;
    writeJsonAtomic(noncePath(this.home), { last: n, at: this.now() });
    this.lastNonce = n;
    return n;
  }
  get lastNonceIssued(): number { return this.lastNonce; }

  /** Durably queue a signal for every channel set up now. Throws when the disk refuses (the caller then fires nothing). */
  enqueue(signal: TradeFireSignal): void {
    if (this.byNonce.has(signal.nonce)) throw new Error(`nonce ${signal.nonce} is already in the outbox`);
    if (signal.nonce > this.lastNonce) { writeJsonAtomic(noncePath(this.home), { last: signal.nonce, at: this.now() }); this.lastNonce = signal.nonce; }
    this.write({ k: 'enq', at: this.now(), channels: [...this.channels.keys()], signal });
  }

  markRun(runId: string, state: 'open' | 'closed', extra: { strategy?: TradeFireSignal['strategy']; accountId?: string; reason?: string } = {}): void {
    this.write({ k: 'run', at: this.now(), runId, state, ...extra });
  }
  /** Runs that were opened and never closed (their runner died before sending `halted`). */
  unclosedRuns(): { runId: string; at: number; strategy?: TradeFireSignal['strategy']; accountId?: string }[] {
    return [...this.runs.entries()].filter(([, r]) => r.state === 'open').map(([runId, r]) => ({ runId, at: r.at, strategy: r.strategy, accountId: r.accountId }));
  }

  /**
   * Deliver what is due. Serialized: a call while a pump runs queues ONE follow-up pump (signals queued meanwhile are
   * covered) and resolves with its report.
   */
  pump(): Promise<PumpReport> {
    if (this.running) {
      this.queued ??= this.running.then(() => { this.queued = null; return this.pump(); });
      return this.queued;
    }
    this.running = this.pumpOnce().finally(() => { this.running = null; });
    return this.running;
  }

  private async pumpOnce(): Promise<PumpReport> {
    const rep: PumpReport = { acked: 0, retried: 0, rejected: 0, expired: 0, dropped: 0 };
    const names = new Set<ChannelName>();
    for (const e of this.entries) for (const [n, st] of e.ch) if (!st.done) names.add(n);
    // Channels deliver side by side (a slow hook never holds up the stream); each one strictly in nonce order.
    await Promise.all([...names].map((name) => this.pumpChannel(name, rep)));
    return rep;
  }

  private async pumpChannel(name: ChannelName, rep: PumpReport): Promise<void> {
    const chan = this.channels.get(name);
    if (!chan && this.defer.has(name)) return;
    let sent = 0;
    for (const e of this.entries) {
      const st = e.ch.get(name);
      if (!st || st.done) continue;
      const now = this.now();
      if (!chan) { this.write({ k: 'drop', at: now, nonce: e.signal.nonce, ch: name, why: 'channel-not-configured' }); rep.dropped++; continue; }
      if (now > e.signal.expiresAt) { this.write({ k: 'exp', at: now, nonce: e.signal.nonce, ch: name }); rep.expired++; continue; }
      if (st.nextAt > now) return; // in order: a channel waits on its oldest undelivered signal
      if (sent++ >= MAX_PER_PUMP) return;
      let r: DeliveryResult;
      try { r = await chan.deliver(e.signal, e.line); } catch (err) { r = { ok: false, retry: true, why: (err as Error).message.slice(0, 160) }; }
      const at = this.now();
      const h = this.healthOf(name);
      if (r.ok) {
        this.write({ k: 'ack', at, nonce: e.signal.nonce, ch: name, ...(r.duplicate ? { dup: true } : {}) });
        h.lastOkAt = at; h.failing = 0; rep.acked++;
        continue;
      }
      h.lastErrAt = at; h.lastErr = r.why.slice(0, 160); h.failing++;
      if (!r.retry) { this.write({ k: 'rej', at, nonce: e.signal.nonce, ch: name, why: r.why.slice(0, 200) }); rep.rejected++; continue; }
      this.write({ k: 'try', at, nonce: e.signal.nonce, ch: name, why: r.why.slice(0, 200), attempt: st.attempts + 1 });
      rep.retried++;
      return;
    }
  }

  private healthOf(name: ChannelName): ChannelHealth {
    let h = this.health.get(name);
    if (!h) { h = { name, pending: 0, lastOkAt: null, lastErrAt: null, lastErr: null, failing: 0 }; this.health.set(name, h); }
    return h;
  }

  /** Per channel: pending deliveries, the last success and failure (this process), consecutive failures. */
  channelHealth(): ChannelHealth[] {
    const out: ChannelHealth[] = [];
    for (const name of new Set<ChannelName>([...this.channels.keys(), ...this.health.keys()])) {
      const h = { ...this.healthOf(name) };
      h.pending = this.entries.filter((e) => { const s = e.ch.get(name); return s && !s.done; }).length;
      if (h.lastErr === null) { const last = [...this.entries].reverse().map((e) => e.ch.get(name)).find((s) => s?.lastWhy); h.lastErr = last?.lastWhy ?? null; }
      out.push(h);
    }
    return out;
  }

  /** Signals with at least one channel not settled yet. */
  depth(): number { return this.entries.filter((e) => [...e.ch.values()].some((s) => !s.done)).length; }

  stateOf(nonce: number): SignalState | null {
    const e = this.byNonce.get(nonce);
    if (!e) return null;
    const ss = [...e.ch.values()];
    if (!ss.length) return this.now() > e.signal.expiresAt ? 'expired' : 'pending';
    if (ss.some((s) => !s.done)) return ss.some((s) => s.done === 'ack') ? 'partial' : 'pending';
    if (ss.length && ss.every((s) => s.done === 'ack')) return 'delivered';
    if (ss.some((s) => s.done === 'ack')) return 'partial';
    return ss.some((s) => s.done === 'rej') ? 'rejected' : 'expired';
  }

  /** Trade signals of a run that were queued or delivered and have not expired yet (the halted signal lists them). */
  outstanding(runId?: string): number[] {
    const now = this.now();
    return this.entries.filter((e) => e.signal.type === 'trade' && (!runId || e.signal.runId === runId) && now <= e.signal.expiresAt).map((e) => e.signal.nonce);
  }

  signals(): TradeFireSignal[] { return this.entries.map((e) => e.signal); }
  get(nonce: number): TradeFireSignal | undefined { return this.byNonce.get(nonce)?.signal; }
  findById(id: string): TradeFireSignal | undefined { return this.entries.find((e) => e.signal.id === id)?.signal; }
}

/**
 * Every valid signal ever queued on this home, oldest nonce first: the live outbox plus the archives compaction moved
 * aside. Read-only; used to rebuild the real holdings when held.json is missing.
 */
export function allOutboxSignals(home: string): TradeFireSignal[] {
  const dir = realDir(home);
  if (!existsSync(dir)) return [];
  const byNonce = new Map<number, TradeFireSignal>();
  for (const f of readdirSync(dir).filter((n) => /^outbox(\.\d+\.done)?\.jsonl$/.test(n))) {
    for (const raw of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (!raw.trim()) continue;
      try { const r = JSON.parse(raw) as { k?: string; signal?: unknown }; if (r.k !== 'enq') continue; const v = validateSignal(r.signal); if (v.ok && !byNonce.has(v.signal.nonce)) byNonce.set(v.signal.nonce, v.signal); } catch { /* torn line */ }
    }
  }
  return [...byNonce.values()].sort((a, b) => a.nonce - b.nonce);
}

export const backoff = (attempt: number): number => Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.max(0, attempt - 1));
