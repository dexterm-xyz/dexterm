// dexterm autotrade — the position monitor process (task-1506 AT-4, AUTOTRADE-SPEC §5, §6.3, §7.4). PAPER ONLY.
//
// Its own loop next to the runner, with no LLM, so a stuck or slow session can never delay an exit. Per tick of a
// held coin it runs `monitorTick` (the §5 order: rug / liquidity pull → thesis breaks → max hold → hard stop →
// cost recovery → TP ladder → bag trail → trailing stop → time stop → ladder adds; a full exit ends the tick) and
// executes each sell through the paper desk at once, journaled there as agent.paper.exit.<rule>. Only then do the
// tick's wakes go to the position's session, all of them in ONE message.
//
// What a session can do with a wake: hold, exit, trim, tighten, or re-profile along an allowed edge. It can never
// add size and never block or undo a mechanical exit: replies are applied when they land (serialized with the
// ticks), a reply for a closed position or after its deadline is logged and ignored, and nobody answering a time
// review applies the profile's `wake.noAnswer` (the other wakes hold; the mechanical rules keep running).
//
// Positions come from the paper journal: every autotrade entry registers a desk exit plan (desk-executor.ts), and
// the monitor adopts each live plan it finds there. A restart rebuilds the same way (paper journal + run ledgers +
// the last status checkpoint for peaks and windows), and never re-sends an exit that was journaled but not filled:
// the next tick decides afresh from the fills.
//
// Dead-man: the monitor writes $DEXTERM_HOME/autotrade/monitor-status.json every 10 s; the desk executor refuses
// entries when it is stale (30 s), and the monitor refuses ladder adds when the runner's heartbeat is stale. The
// monitor itself keeps exiting whether the runner is up or not, and no guard pauses it.

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { ExitPlan, PaperPositionView } from '@dexterm/data';
import type { JournalEvent } from '@dexterm/data/plans';
import type { Fill, Position } from './engine.ts';
import { monitorTick, pnlPct, type WakeEvent } from './monitor.ts';
import type { MarketTick } from './replay.ts';
import { Ledger, type LedgerEvent } from './ledger.ts';
import { runnerHeartbeatAge } from './runner.ts';
import { parseDecision, renderEvent, type AgentSession, type Decision } from './session.ts';
import type { ExitProfile, ResolvedStrategy } from './strategy.ts';
import type { EntryContext, ExecResult, ExitContext } from './desk-executor.ts';
import { withMcap } from '@dexterm/data/basis';
import { DEFAULT_PRICE_BASIS, tickHints, type PriceBasis } from './basis-text.ts';

export const MONITOR_STATUS_SCHEMA = 'dexterm-autotrade-monitor/1';
export const MONITOR_HEARTBEAT_MS = 10_000;
/** Three missed beats: the desk executor refuses entries past this. */
export const MONITOR_STALE_MS = 30_000;
/** The runner's rendezvous (task-1505 writes it every 10 s): ladder adds need it fresher than this. */
export const RUNNER_STALE_MS = 30_000;

export const monitorStatusPath = (home: string): string => join(home, 'autotrade', 'monitor-status.json');
export const monitorLockPath = (home: string): string => join(home, 'autotrade', 'monitor.lock');
export const monitorLedgerDir = (home: string): string => join(home, 'autotrade', 'monitor');

function heartbeatAge(path: string, now: number): number {
  try {
    const d = JSON.parse(readFileSync(path, 'utf8')) as { heartbeatAt?: unknown; state?: unknown };
    return d.state === 'stopped' || typeof d.heartbeatAt !== 'number' ? Infinity : Math.max(0, now - d.heartbeatAt);
  } catch { return Infinity; }
}
/** Age of the monitor's heartbeat in ms (Infinity when there is none or it stopped cleanly). */
export const monitorHeartbeatAge = (home: string, now = Date.now()): number => heartbeatAge(monitorStatusPath(home), now);
export const monitorAlive = (home: string, now = Date.now()): boolean => monitorHeartbeatAge(home, now) <= MONITOR_STALE_MS;
/** True while the runner's heartbeat (its `dexterm-autotrade-runner/1` rendezvous, task-1505) is fresh. */
export const runnerHeartbeatFresh = (home: string, now = Date.now()): boolean => runnerHeartbeatAge(home, now) <= RUNNER_STALE_MS;

// ───────────────────────────── the executor + wake interfaces ─────────────────────────────

/** What the monitor needs from an executor (DeskExecutor in the product; a fake in tests). */
export interface MonitorExecutor {
  readonly name: string;
  sell(k: MarketTick, tokens: number, reason: string, ctx?: ExitContext): Promise<ExecResult> | ExecResult;
  buy(k: MarketTick, usd: number, ctx?: EntryContext): Promise<ExecResult> | ExecResult;
  /** The proceeds curve for a cost-recovery slice (quoted); null defers the cost recovery to the next tick. */
  costRecoverySellUsd?(p: Position, prof: ExitProfile, k: MarketTick): Promise<{ sellUsd: (tokens: number) => number; quotes: number } | null>;
  /** The desk's book, for re-capping ladder adds. */
  book?(): { cashUsd: number; openCostUsd: number; equityUsd: number } | null;
}

export type ReplyAction = 'hold' | 'exit' | 'tighten' | 'reprofile';

/** One tick's wakes for one position, as the ONE message its session gets. */
export interface WakeBatch { id: string; positionId: string; mint: string; t: number; events: WakeEvent[]; text: string; allowed: ReplyAction[]; deadline: number }

/**
 * Where wakes go. `deliver` returns null when there is no session for the position (the profile's noAnswer then
 * applies at once), or a promise of the session's decision (null = no answer / dead session).
 */
export interface WakeSink { deliver(batch: WakeBatch, p: Position): Promise<Decision | null> | null }

/** A sink over in-process sessions (a runner's candidate session, or a respawned position session). */
export function sessionWakeSink(sessionFor: (p: Position, batch: WakeBatch) => AgentSession | null): WakeSink {
  return {
    deliver(batch, p) {
      const s = sessionFor(p, batch);
      if (!s) return null;
      return s.send(batch.text).then((r) => (r && r.decision.ok ? r.decision.decision : null), () => null);
    },
  };
}

// ───────────────────────────── cross-process wake mailbox ─────────────────────────────
//
// For a runner in another process: the monitor appends each batch to autotrade/wakes/outbox.jsonl; the runner
// (which holds the position's session) appends the session's raw reply to answers.jsonl. The monitor parses it with
// the closed DECISION schema, so the file can never carry more than a decision.

export const wakeOutboxPath = (home: string): string => join(home, 'autotrade', 'wakes', 'outbox.jsonl');
export const wakeAnswersPath = (home: string): string => join(home, 'autotrade', 'wakes', 'answers.jsonl');

function appendLine(path: string, doc: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${JSON.stringify(doc)}\n`, { mode: 0o600 });
}
function readLines<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) { if (!line.trim()) continue; try { out.push(JSON.parse(line) as T); } catch { /* a torn last line */ } }
  return out;
}

/** Runner side: the wake batches waiting for an answer (newest state per id). */
export function readWakeOutbox(home: string, now = Date.now()): WakeBatch[] {
  const answered = new Set(readLines<{ id: string }>(wakeAnswersPath(home)).map((a) => a.id));
  return readLines<WakeBatch>(wakeOutboxPath(home)).filter((b) => !answered.has(b.id) && b.deadline >= now);
}
/** Runner side: hand the session's raw reply text back (parsed by the monitor). */
export function answerWake(home: string, id: string, replyText: string): void {
  appendLine(wakeAnswersPath(home), { id, text: String(replyText).slice(0, 4000) });
}

export class MailboxWakeSink implements WakeSink {
  private readonly home: string;
  private readonly hasSession: (p: Position) => boolean;
  private readonly waiting = new Map<string, (d: Decision | null) => void>();
  constructor(home: string, hasSession: (p: Position) => boolean) { this.home = home; this.hasSession = hasSession; }
  deliver(batch: WakeBatch, p: Position): Promise<Decision | null> | null {
    if (!this.hasSession(p)) return null;
    appendLine(wakeOutboxPath(this.home), batch);
    return new Promise((res) => this.waiting.set(batch.id, res));
  }
  /** Pick up answers (call every cycle). */
  poll(): void {
    if (!this.waiting.size) return;
    for (const a of readLines<{ id: string; text: string }>(wakeAnswersPath(this.home))) {
      const res = this.waiting.get(a.id);
      if (!res) continue;
      this.waiting.delete(a.id);
      const d = parseDecision(String(a.text ?? ''));
      res(d.ok ? d.decision : null);
    }
  }
  /** Settle a batch the monitor gave up on (its deadline passed). */
  drop(id: string): void { const res = this.waiting.get(id); if (res) { this.waiting.delete(id); res(null); } }
}

// ───────────────────────────── the monitor ─────────────────────────────

export interface PositionMonitorOpts {
  strategy: ResolvedStrategy;
  /** task-1537: the price basis of the wake text the agent reads (default market cap). */
  basis?: PriceBasis;
  executor: MonitorExecutor;
  wakes?: WakeSink;
  ledger?: Ledger;
  /** True while the runner's heartbeat is fresh (ladder adds need it; exits never do). Default: true. */
  runnerAlive?: () => boolean;
  /** How long a wake waits for an answer (default: the strategy's agent.decideWithinSec). */
  decideWithinMs?: number;
  now?: () => number;
  onLine?: (s: string) => void;
}

interface Pending { batch: WakeBatch; review: WakeEvent | null; settled: boolean }

const REVIEW: WakeEvent['event'][] = ['time_review', 'time_tighten'];
const r6 = (x: number) => Number(x.toPrecision(6));

/** A tick with only what a recovered position knows (prices fill in on the next real tick). */
export function bareTick(mint: string, symbol: string, t: number, price: number | null, liq: number | null = null): MarketTick {
  return {
    mint, t, kind: 'live', symbol, launchpad: 'unknown' as MarketTick['launchpad'], createdAt: null, price, mcap: null, mcapResolved: null, mcapFlagged: false,
    liq, vol5m: null, vol1h: null, vol24: null, buys5m: null, sells5m: null, buys24: null, sells24: null, chg5m: null, chg1h: null, chg6h: null, chg24h: null,
    holders: null, top10: null, dev: null, mintAuth: null, freezeAuth: null, org: null,
  };
}

export class PositionMonitor {
  readonly strategy: ResolvedStrategy;
  readonly ledger: Ledger;
  /** Open positions by mint (the paper wallet holds one position per mint). */
  readonly positions = new Map<string, Position>();
  readonly closed: Position[] = [];
  private readonly exec: MonitorExecutor;
  private readonly wakes: WakeSink | null;
  private readonly runnerAlive: () => boolean;
  private readonly decideMs: number;
  private readonly now: () => number;
  private readonly say: (s: string) => void;
  private readonly basis: PriceBasis;
  private readonly pending = new Map<string, Pending>();
  private chain: Promise<unknown> = Promise.resolve();
  private batchSeq = 0;

  constructor(o: PositionMonitorOpts) {
    if (o.strategy.mode !== 'paper') throw new Error(`strategy ${o.strategy.id} is mode "${o.strategy.mode}": the autotrade monitor runs paper only`);
    this.strategy = o.strategy;
    this.exec = o.executor;
    this.wakes = o.wakes ?? null;
    this.ledger = o.ledger ?? new Ledger();
    this.runnerAlive = o.runnerAlive ?? (() => true);
    this.decideMs = o.decideWithinMs ?? o.strategy.agent.decideWithinSec * 1000;
    this.now = o.now ?? Date.now;
    this.say = o.onLine ?? (() => {});
    this.basis = o.basis ?? DEFAULT_PRICE_BASIS;
  }

  /** Serialize every mutation (ticks and replies), so a reply never interleaves with a tick's sells. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  profileOf(p: Position): ExitProfile {
    return this.strategy.exits.profiles[p.profileId] ?? this.strategy.exits.profiles[this.strategy.exits.default];
  }

  /** Take over a position (adopted from the journal or handed over in-process). */
  adopt(p: Position, why: string): void {
    if (this.positions.has(p.mint)) return;
    this.positions.set(p.mint, p);
    this.ledger.add(this.now(), 'adopt', { positionId: p.id, mint: p.mint, symbol: p.symbol, profile: p.profileId, why, tokens: r6(p.tokens), costUsd: r6(p.costUsd), realizedUsd: r6(p.realizedUsd), tpFilled: p.tpFilled, costRecovered: !!p.costRecovered, bagTrailPct: p.bagTrailPct ?? null, ladder: p.ladder });
    this.say(`ADOPT ${p.symbol} (${p.id}) ${why}`);
  }

  /** A position that left the desk by another path (closed by the user or an agent): stop watching it. */
  forget(mint: string, why: string): void {
    const p = this.positions.get(mint);
    if (!p) return;
    this.positions.delete(mint);
    p.status = 'closed'; p.closedAt = this.now(); p.exitReason = why;
    this.closed.push(p);
    this.ledger.add(this.now(), 'position_gone', { positionId: p.id, mint, why });
  }

  /** One market tick. Mechanical actions first (each sell executed at once), then this tick's wakes as ONE message. */
  tick(k: MarketTick): Promise<void> { return this.serial(() => this.tickNow(k)); }

  private async tickNow(k: MarketTick): Promise<void> {
    await this.expire();
    const p = this.positions.get(k.mint);
    if (!p || p.status !== 'open') return;
    let prof = this.profileOf(p);
    const x = this.strategy.execution;
    let sellUsd: ((t: number) => number) | undefined;
    // Cost recovery is sized on desk quotes; with none to be had it waits for the next tick (never a guess).
    if (prof.costRecovery && !p.costRecovered && k.price && pnlPct(p, k.price) >= prof.costRecovery.atPct && (k.liq ?? 0) >= x.minExitLiquidityUsd && !p.stuck) {
      const sized = this.exec.costRecoverySellUsd ? await this.exec.costRecoverySellUsd(p, prof, k) : { sellUsd: (t: number) => t * k.price!, quotes: 0 };
      if (sized) { sellUsd = sized.sellUsd; this.ledger.add(k.t, 'cost_recovery_sized', { positionId: p.id, quotes: sized.quotes }); }
      else { prof = { ...prof, costRecovery: null }; this.ledger.add(k.t, 'cost_recovery_deferred', { positionId: p.id, why: 'no quote' }); }
    }
    const acts = monitorTick(p, prof, k, { minExitLiquidityUsd: x.minExitLiquidityUsd, ...(sellUsd ? { sellUsd } : {}) });
    const wakes: WakeEvent[] = [];
    for (const a of acts) {
      if (a.kind === 'wake') { wakes.push(a.wake); continue; }
      if (p.status !== 'open') break;
      if (a.kind === 'sell') {
        const wasStuck = p.stuck;
        const ok = await this.sell(p, k, a.tokens, a.reason, a.detail, a.all);
        if (!ok) {
          // A refused partial sell is retried on the next tick (undo its bookkeeping); a refused full exit marks
          // the bag stuck, and monitorTick retries it every tick.
          if (a.reason === 'cost-recovery') p.costRecovered = false;
          const tp = /^tp(\d+)$/.exec(a.reason);
          if (tp) p.tpFilled = Math.min(p.tpFilled, Number(tp[1]) - 1);
          if (a.all && !wasStuck) wakes.push({ event: 'stuck', positionId: p.id, mint: p.mint, t: k.t, detail: `${a.reason}: the sell could not execute; retried every tick`, allowed: ['hold'] });
          break;
        }
      } else if (a.kind === 'add') await this.add(p, k, a.usd, a.index, a.detail);
    }
    if (wakes.length) await this.deliver(p, wakes, k);
  }

  private async sell(p: Position, k: MarketTick, tokens: number, reason: string, detail: string, all: boolean, agentReason?: string): Promise<boolean> {
    if (tokens <= 0) return true;
    const f = await this.exec.sell(k, Math.min(tokens, p.tokens), reason, { detail, positionId: p.id, ...(agentReason ? { agentReason } : {}) });
    if ('refused' in f) {
      this.ledger.add(k.t, 'refused', { rule: f.refused, stage: 'exit', positionId: p.id, mint: p.mint, reason });
      if (all && !p.stuck) { p.stuck = true; this.ledger.add(k.t, 'stuck', { positionId: p.id, mint: p.mint, why: f.refused, reason }); this.say(`STUCK ${p.symbol}: ${f.refused}`); }
      return false;
    }
    p.stuck = false;
    p.tokens = Math.max(0, p.tokens - f.tokens);
    if (all || p.tokens < p.origTokens * 1e-6) p.tokens = 0;
    p.realizedUsd += f.usd;
    p.fills.push(f);
    this.ledger.add(k.t, 'fill', { positionId: p.id, mint: p.mint, side: 'sell', usd: f.usd, tokens: r6(f.tokens), price: f.price, reason, detail, executor: this.exec.name });
    this.say(`SELL ${p.symbol} ${reason}: $${f.usd.toFixed(2)} — ${detail}`);
    if (p.tokens <= 0) {
      p.status = 'closed'; p.closedAt = k.t; p.exitReason = reason;
      this.positions.delete(p.mint);
      this.closed.push(p);
      const pnl = p.realizedUsd - p.costUsd;
      this.ledger.add(k.t, 'trade_closed', { positionId: p.id, mint: p.mint, symbol: p.symbol, profile: p.profileId, costUsd: r6(p.costUsd), proceedsUsd: r6(p.realizedUsd), pnlUsd: r6(pnl), pnlPct: Math.round((pnl / p.costUsd) * 1e4) / 100, exitReason: reason });
      // A position that closed by any path settles its open wakes (their late answers are ignored).
      for (const q of this.pending.values()) if (q.batch.positionId === p.id && !q.settled) { q.settled = true; this.ledger.add(k.t, 'wake_settled', { batchId: q.batch.id, why: 'position-closed' }); }
    }
    return true;
  }

  /** A ladder add: mechanical (the user's own strategy), re-capped, and only while the runner is up. */
  private async add(p: Position, k: MarketTick, usd: number, index: number, detail: string): Promise<void> {
    const s = this.strategy;
    if (!this.runnerAlive()) { this.ledger.add(k.t, 'refused', { rule: 'ladder-add-runner-down', positionId: p.id }); return; }
    const b = this.exec.book?.() ?? null;
    const room = b ? Math.min(usd, b.cashUsd, (b.equityUsd * s.risk.maxExposurePct) / 100 - b.openCostUsd) : usd;
    if (!(room >= s.sizing.minUsd)) { this.ledger.add(k.t, 'refused', { rule: 'ladder-add-no-room', positionId: p.id, usd: r6(usd) }); return; }
    const f = await this.exec.buy(k, room, { kind: 'add', positionId: p.id, profile: p.profileId, sessionId: p.sessionId, reason: detail });
    if ('refused' in f) { this.ledger.add(k.t, 'refused', { rule: f.refused, stage: 'ladder-add', positionId: p.id }); return; }
    const tokens = p.tokens + f.tokens;
    p.entryPrice = (p.entryPrice * p.tokens + f.price * f.tokens) / tokens;
    p.tokens = tokens; p.origTokens += f.tokens; p.costUsd += f.usd;
    p.fills.push(f);
    this.ledger.add(k.t, 'fill', { positionId: p.id, mint: p.mint, side: 'buy', usd: f.usd, tokens: r6(f.tokens), ...withMcap({ price: f.price }, { price: 'mcap' }, tickHints(k)), reason: 'ladder-add', index, executor: this.exec.name }); // task-1537: JSON keeps price and mcap
  }

  // ───────────────────────────── wakes ─────────────────────────────

  private async deliver(p: Position, events: WakeEvent[], k: MarketTick): Promise<void> {
    const t = this.now();
    const allowed = [...new Set(events.flatMap((w) => w.allowed))] as ReplyAction[];
    const text = events.map((w) => renderEvent(w, p, k, this.basis)).join('\n\n');
    const batch: WakeBatch = { id: `w${++this.batchSeq}-${t.toString(36)}`, positionId: p.id, mint: p.mint, t: k.t, events, text, allowed, deadline: t + this.decideMs };
    for (const w of events) this.ledger.add(k.t, 'wake', { positionId: p.id, mint: p.mint, event: w.event, detail: w.detail, batchId: batch.id });
    this.say(`WAKE ${p.symbol} ${events.map((w) => w.event).join(' + ')}`);
    const review = events.find((w) => REVIEW.includes(w.event)) ?? null;
    const reply = this.wakes ? this.wakes.deliver(batch, p) : null;
    this.ledger.add(k.t, 'message', { batchId: batch.id, positionId: p.id, events: events.map((w) => w.event), bytes: text.length, session: reply !== null });
    if (reply === null) { if (review) await this.noAnswerNow(p, review, 'no session'); return; }
    const q: Pending = { batch, review, settled: false };
    this.pending.set(batch.id, q);
    reply.then((d) => this.serial(() => this.onReply(q, d)), () => this.serial(() => this.onReply(q, null)));
  }

  /** Wakes past their deadline: the profile's noAnswer for a review, hold for the rest. Runs at every tick. */
  private async expire(): Promise<void> {
    const now = this.now();
    for (const q of [...this.pending.values()]) {
      if (q.settled || now < q.batch.deadline) continue;
      q.settled = true;
      this.pending.delete(q.batch.id);
      if (this.wakes instanceof MailboxWakeSink) this.wakes.drop(q.batch.id);
      this.ledger.add(now, 'session_timeout', { batchId: q.batch.id, positionId: q.batch.positionId });
      const p = [...this.positions.values()].find((x) => x.id === q.batch.positionId);
      if (p && q.review) await this.noAnswerNow(p, q.review, 'timeout');
      else if (p) this.ledger.add(now, 'no_answer', { positionId: p.id, events: q.batch.events.map((w) => w.event), why: 'timeout', rule: 'hold' });
    }
  }

  /** Check deadlines without a tick (the process loop calls this every cycle). */
  sweep(): Promise<void> { return this.serial(() => this.expire()); }

  get executorName(): string { return this.exec.name; }

  private async noAnswerNow(p: Position, w: WakeEvent, why: string): Promise<void> {
    const rule = this.profileOf(p).wake?.noAnswer ?? 'hold';
    this.ledger.add(this.now(), 'no_answer', { positionId: p.id, event: w.event, why, rule });
    if (rule === 'exit' && p.status === 'open') await this.sell(p, p.lastTick, p.tokens, `${w.event}:no-answer`, `${w.event} unanswered (${why}); the profile says exit`, true);
  }

  private async onReply(q: Pending, d: Decision | null): Promise<void> {
    const now = this.now();
    if (q.settled) { this.ledger.add(now, 'late_reply_ignored', { batchId: q.batch.id, positionId: q.batch.positionId, decision: d }); return; }
    q.settled = true;
    this.pending.delete(q.batch.id);
    const p = [...this.positions.values()].find((x) => x.id === q.batch.positionId);
    if (!p) { this.ledger.add(now, 'late_reply_ignored', { batchId: q.batch.id, positionId: q.batch.positionId, decision: d, why: 'position-closed' }); return; }
    if (!d) {
      this.ledger.add(now, 'no_answer', { positionId: p.id, events: q.batch.events.map((w) => w.event), why: 'no reply', rule: q.review ? (this.profileOf(p).wake?.noAnswer ?? 'hold') : 'hold' });
      if (q.review) await this.noAnswerNow(p, q.review, 'no reply');
      return;
    }
    this.ledger.add(now, 'reply', { batchId: q.batch.id, positionId: p.id, decision: d });
    await this.apply(p, d, q.batch.allowed);
  }

  /**
   * Apply a session's decision on an open position. Risk can only go down: exit / trim always, tighten (arm the
   * trail now, or halve a free bag's trail, never loosen), re-profile only along an allowed edge (an upgrade needs
   * TP1). Anything that would add size is refused and logged; nothing here can stop a mechanical exit.
   */
  private async apply(p: Position, d: Decision, allowed: ReplyAction[]): Promise<void> {
    const now = this.now();
    const refuse = (rule: string, extra: Record<string, unknown> = {}) => { this.ledger.add(now, 'refused', { rule, stage: 'wake-reply', positionId: p.id, action: d.action, ...extra }); };
    if (d.action === 'hold' || d.action === 'wait') return;
    if (d.action === 'enter' || d.action === 'skip') { refuse(d.action === 'enter' ? 'session-cannot-add-size' : 'action-not-allowed-while-holding'); return; }
    if (!allowed.includes(d.action)) { refuse('action-not-offered', { allowed }); return; }
    const prof = this.profileOf(p);
    if (d.action === 'exit') {
      const frac = Math.min(1, Math.max(0, d.fraction ?? 1));
      if (!(frac > 0)) { refuse('bad-fraction'); return; }
      const all = frac >= 0.999;
      await this.sell(p, p.lastTick, all ? p.tokens : p.tokens * frac, all ? 'agent-exit' : 'agent-trim', d.reason.slice(0, 200), all, d.reason);
      return;
    }
    if (d.action === 'tighten') {
      if (prof.bagTrail && p.costRecovered) {
        const before = p.bagTrailPct ?? prof.bagTrail.trailPct;
        p.bagTrailPct = Math.max(10, Math.min(before, Math.round(prof.bagTrail.trailPct / 2)));
        this.ledger.add(now, 'tighten', { positionId: p.id, armed: 'bag-trail', trailPct: p.bagTrailPct, from: before });
      } else if (prof.trailingStop) { p.trailArmed = true; this.ledger.add(now, 'tighten', { positionId: p.id, armed: 'trail' }); }
      else refuse('tighten-no-trail');
      return;
    }
    if (d.action === 'reprofile') {
      const to = d.profile ? this.strategy.exits.profiles[d.profile] : undefined;
      if (!to || !prof.reprofileTo.includes(to.id)) { refuse('reprofile-edge', { to: d.profile ?? null }); return; }
      if (to.sizing.maxSizePctOfBankroll > prof.sizing.maxSizePctOfBankroll && p.tpFilled < 1) { refuse('reprofile-upgrade-needs-tp1', { to: to.id }); return; }
      this.ledger.add(now, 'reprofile', { positionId: p.id, from: prof.id, to: to.id, reason: d.reason });
      p.profileId = to.id;
    }
  }

  /** Wait for every queued tick and reply to finish (tests and shutdown). */
  async idle(): Promise<void> {
    // Let settled replies queue their apply step first (a resolved reply joins the chain one turn later).
    await new Promise<void>((res) => setImmediate(res));
    await this.serial(async () => {});
  }

  /** The status the heartbeat file carries (and recovery reads back for peaks and windows). */
  status(): MonitorPositionState[] {
    return [...this.positions.values()].map((p) => ({
      positionId: p.id, mint: p.mint, symbol: p.symbol, profile: p.profileId, tokens: r6(p.tokens), costUsd: r6(p.costUsd), realizedUsd: r6(p.realizedUsd),
      peakPrice: p.peakPrice, entryPrice: p.entryPrice, lastPrice: p.lastTick.price, lastT: p.lastTick.t, tpFilled: p.tpFilled, costRecovered: !!p.costRecovered,
      bagTrailPct: p.bagTrailPct ?? null, trailArmed: p.trailArmed, stuck: p.stuck, liqWindow: p.liqWindow.slice(-20), lowTapeSince: p.lowTapeSince, wakeSent: { ...p.wakeSent },
      pnlPct: p.lastTick.price ? Math.round(pnlPct(p, p.lastTick.price) * 10) / 10 : null,
    }));
  }
  pendingWakes(): number { return [...this.pending.values()].filter((q) => !q.settled).length; }
}

export interface MonitorPositionState {
  positionId: string; mint: string; symbol: string; profile: string; tokens: number; costUsd: number; realizedUsd: number;
  peakPrice: number; entryPrice: number; lastPrice: number | null; lastT: number; tpFilled: number; costRecovered: boolean;
  bagTrailPct: number | null; trailArmed: boolean; stuck: boolean; liqWindow: { t: number; liq: number }[]; lowTapeSince: number | null;
  wakeSent: Record<string, boolean>; pnlPct: number | null;
}

export interface MonitorStatus {
  schema: typeof MONITOR_STATUS_SCHEMA;
  mode: 'paper';
  pid: number;
  state: 'running' | 'stopped';
  startedAt: number;
  heartbeatAt: number;
  strategy: { id: string; version: string; hash: string };
  executor: string;
  runnerAlive: boolean;
  positions: MonitorPositionState[];
  pendingWakes: number;
  ledgerPath: string | null;
  ledgerHead: string;
}

// ───────────────────────────── restart recovery ─────────────────────────────

export interface RecoveryInput {
  strategy: ResolvedStrategy;
  /** The paper journal's events (agent.paper.exit.plan / .done, agent.paper.fill with notes). */
  journal: readonly JournalEvent[];
  /** What the desk holds now (the paper wallet is the source of truth for tokens). */
  held: readonly PaperPositionView[];
  /** USD per SOL, to price the SOL fills (a fill's own priceUsd/priceSol wins when it has one). */
  solUsd: number;
  /** Run ledgers (the runner's and the monitor's): tighten, reprofile, wake and ladder events by position id. */
  ledgers?: readonly (readonly LedgerEvent[])[];
  /** The last monitor status (peaks, liquidity windows, tape clocks); optional. */
  checkpoint?: Pick<MonitorStatus, 'positions'> | null;
  /** Only this owner's plans (default: the autotrade monitor). */
  owner?: string;
  now?: number;
}

export interface Recovered {
  positions: Position[];
  /** Plans whose mint is no longer held (closed while the monitor was down). */
  closedWhileDown: { positionId: string; mint: string }[];
  /** Held mints with no live autotrade plan (another agent's or the user's own position): left alone. */
  notOurs: string[];
  /** Exits journaled with no fill after them (a crash mid-sell): never re-sent; the next tick decides afresh. */
  unresolvedExits: { positionId: string; rule: string; seq: number }[];
}

interface FillLine { ts: number; side: 'buy' | 'sell'; solDelta: number; tokenDelta: number; priceSol: number; priceUsd: number | null; mid: number | null; exit: string | null; seq: number }

/** Rebuild the open positions from the paper journal + run ledgers (+ the last checkpoint). Pure. */
export function recoverPositions(r: RecoveryInput): Recovered {
  const owner = r.owner ?? 'autotrade-monitor';
  const plans = new Map<string, ExitPlan & { seq: number }>();
  const fills = new Map<string, FillLine[]>();
  const exits = new Map<string, { rule: string; seq: number }[]>();
  for (const e of r.journal) {
    const d = (e.data ?? {}) as Record<string, unknown>;
    if (e.type === 'agent.paper.exit.plan') {
      if (d.owner !== owner || typeof d.mint !== 'string' || typeof d.positionId !== 'string') continue;
      plans.set(d.mint, { ...(d as unknown as ExitPlan), seq: e.seq });
    } else if (e.type === 'agent.paper.exit.done') {
      const pl = typeof d.mint === 'string' ? plans.get(d.mint) : undefined;
      if (pl && pl.positionId === d.positionId) plans.delete(d.mint as string);
    } else if (e.type === 'agent.paper.fill') {
      const note = (d.note ?? null) as Record<string, unknown> | null;
      const pid = note && typeof note.positionId === 'string' ? note.positionId : null;
      if (!pid) continue;
      const list = fills.get(pid) ?? [];
      list.push({ ts: e.ts, side: d.side === 'sell' ? 'sell' : 'buy', solDelta: Number(d.solDelta), tokenDelta: Number(d.tokenDelta), priceSol: Number(d.priceSol), priceUsd: typeof d.priceUsd === 'number' ? d.priceUsd : null, mid: typeof note!.mid === 'number' && note!.mid > 0 ? note!.mid : null, exit: typeof note!.exit === 'string' ? note!.exit : null, seq: e.seq });
      fills.set(pid, list);
    } else if (e.type.startsWith('agent.paper.exit.')) {
      if (typeof d.positionId !== 'string') continue;
      const list = exits.get(d.positionId) ?? [];
      list.push({ rule: e.type.slice('agent.paper.exit.'.length), seq: e.seq });
      exits.set(d.positionId, list);
    }
  }
  const held = new Map(r.held.filter((h) => h.tokens > 0).map((h) => [h.mint, h]));
  const ck = new Map((r.checkpoint?.positions ?? []).map((c) => [c.positionId, c]));
  const out: Recovered = { positions: [], closedWhileDown: [], notOurs: [], unresolvedExits: [] };
  for (const [mint] of held) if (!plans.has(mint)) out.notOurs.push(mint);
  const now = r.now ?? Date.now();
  for (const [mint, plan] of plans) {
    const h = held.get(mint);
    if (!h) { out.closedWhileDown.push({ positionId: plan.positionId, mint }); continue; }
    const fl = (fills.get(plan.positionId) ?? []).sort((a, b) => a.seq - b.seq);
    const usdOf = (f: FillLine) => (Math.abs(f.solDelta) / 1e9) * (f.priceUsd && f.priceSol ? f.priceUsd / f.priceSol : r.solUsd);
    const tokOf = (f: FillLine) => Math.abs(f.tokenDelta) / 10 ** h.decimals;
    const buys = fl.filter((f) => f.side === 'buy');
    const sells = fl.filter((f) => f.side === 'sell');
    const costUsd = buys.reduce((a, f) => a + usdOf(f), 0) || h.costSol * r.solUsd;
    const origTokens = buys.reduce((a, f) => a + tokOf(f), 0) || h.tokens;
    // The tick's mid price the entry was decided on (the note carries it), else the fill's own price.
    const midOf = (f: FillLine) => f.mid ?? f.priceUsd ?? f.priceSol * r.solUsd;
    const entryPrice = buys.length ? buys.reduce((a, f) => a + midOf(f) * tokOf(f), 0) / origTokens : costUsd / origTokens;
    const fillsE: Fill[] = fl.map((f) => ({ t: f.ts, side: f.side, usd: r6(usdOf(f)), tokens: tokOf(f), price: midOf(f), avgPrice: tokOf(f) ? usdOf(f) / tokOf(f) : 0, impactPct: 0, partial: false, reason: f.exit ?? (f.side === 'buy' ? 'entry' : 'sell') }));
    let tpFilled = 0;
    for (const f of sells) { const m = /^tp(\d+)$/.exec(f.exit ?? ''); if (m) tpFilled = Math.max(tpFilled, Number(m[1])); }
    const filledExits = new Set(sells.map((f) => f.exit));
    // An exit line whose fill never followed (a crash between the journal line and the booking): reported, not re-sent.
    const ex = exits.get(plan.positionId) ?? [];
    for (const x of ex) if (!fl.some((f) => f.side === 'sell' && f.seq > x.seq && f.exit === x.rule)) out.unresolvedExits.push({ positionId: plan.positionId, rule: x.rule, seq: x.seq });
    const c = ck.get(plan.positionId);
    let profileId = plan.profileId;
    let bagTrailPct: number | undefined = c?.bagTrailPct ?? undefined;
    let trailArmed = c?.trailArmed ?? false;
    const wakeSent: Record<string, boolean> = { ...(c?.wakeSent ?? {}) };
    let ladder: Position['ladder'] = [];
    for (const lg of r.ledgers ?? []) {
      for (const e of lg) {
        if (e.positionId !== plan.positionId) continue;
        if (e.kind === 'reprofile' && typeof e.to === 'string') profileId = e.to;
        else if (e.kind === 'tighten' && e.armed === 'bag-trail' && typeof e.trailPct === 'number') bagTrailPct = Math.min(bagTrailPct ?? Infinity, e.trailPct);
        else if (e.kind === 'tighten' && e.armed === 'trail') trailArmed = true;
        else if (e.kind === 'wake' && typeof e.event === 'string') {
          const key = e.event === 'time_review' || e.event === 'time_tighten' ? 'time' : e.event === 'drawdown' ? 'drawdown' : e.event === 'thesis_warning' ? 'thesis' : null;
          if (key) wakeSent[key] = true;
        } else if ((e.kind === 'adopt' || e.kind === 'fill') && Array.isArray(e.ladder) && !ladder.length) ladder = (e.ladder as Position['ladder']).map((t) => ({ ...t }));
        else if (e.kind === 'fill' && e.reason === 'ladder-add' && typeof e.index === 'number' && ladder[e.index]) ladder[e.index].usd = 0;
      }
    }
    if (!r.strategy.exits.profiles[profileId]) profileId = r.strategy.exits.default;
    const openedAt = buys[0]?.ts ?? plan.registeredAt;
    const lastPrice = c?.lastPrice ?? entryPrice;
    out.positions.push({
      id: plan.positionId, mint, symbol: h.symbol, profileId, openedAt, sessionId: null,
      tokens: h.tokens, origTokens, costUsd, realizedUsd: sells.reduce((a, f) => a + usdOf(f), 0), entryPrice,
      peakPrice: Math.max(entryPrice, c?.peakPrice ?? 0, ...fillsE.map((f) => f.price)), tpFilled, trailArmed,
      costRecovered: filledExits.has('cost-recovery') || (c?.costRecovered ?? false), ...(bagTrailPct !== undefined ? { bagTrailPct } : {}),
      ladder, fills: fillsE, status: 'open', stuck: false, closedAt: null, exitReason: null,
      liqWindow: c?.liqWindow?.map((w) => ({ ...w })) ?? [], lowTapeSince: c?.lowTapeSince ?? null, lastTick: bareTick(mint, h.symbol, c?.lastT ?? now, lastPrice), wakeSent,
    });
  }
  return out;
}

/**
 * Adopt every live autotrade plan in the paper journal that the monitor does not hold yet, and forget positions
 * whose plan is done or whose mint left the desk by another path. The same code path as a restart.
 */
export function syncFromJournal(m: PositionMonitor, input: Omit<RecoveryInput, 'strategy'>): Recovered {
  const r = recoverPositions({ ...input, strategy: m.strategy, ledgers: [...(input.ledgers ?? []), m.ledger.events] });
  const live = new Set(r.positions.map((p) => p.mint));
  for (const p of r.positions) if (!m.positions.has(p.mint)) m.adopt(p, 'journal');
  for (const mint of [...m.positions.keys()]) if (!live.has(mint)) m.forget(mint, 'plan-done-or-sold-elsewhere');
  return r;
}

// ───────────────────────────── the process host ─────────────────────────────

export interface MonitorLock { pid: number; startedAt: number }
const pidAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };

/** One monitor per machine: a lock holding the pid; a lock whose pid is gone is reclaimed. */
export function acquireMonitorLock(home: string, now = Date.now()): { ok: true; reclaimed: MonitorLock | null } | { ok: false; holder: MonitorLock } {
  const path = monitorLockPath(home);
  mkdirSync(join(home, 'autotrade'), { recursive: true, mode: 0o700 });
  let reclaimed: MonitorLock | null = null;
  for (let i = 0; i < 2; i++) {
    try { const fd = openSync(path, 'wx', 0o600); writeSync(fd, `${JSON.stringify({ pid: process.pid, startedAt: now })}\n`); closeSync(fd); return { ok: true, reclaimed }; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    let held: MonitorLock | null = null;
    try { held = JSON.parse(readFileSync(path, 'utf8')) as MonitorLock; } catch { held = null; }
    if (held && typeof held.pid === 'number' && held.pid !== process.pid && pidAlive(held.pid)) return { ok: false, holder: held };
    reclaimed = held;
    rmSync(path, { force: true });
  }
  throw new Error(`could not take ${path}`);
}
export function releaseMonitorLock(home: string): void {
  try { const held = JSON.parse(readFileSync(monitorLockPath(home), 'utf8')) as MonitorLock; if (held.pid === process.pid) rmSync(monitorLockPath(home), { force: true }); } catch { /* gone */ }
}

export function writeMonitorStatus(home: string, s: MonitorStatus): void {
  const path = monitorStatusPath(home);
  mkdirSync(join(home, 'autotrade'), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}
export function readMonitorStatus(home: string): MonitorStatus | null {
  try { const d = JSON.parse(readFileSync(monitorStatusPath(home), 'utf8')) as MonitorStatus; return d.schema === MONITOR_STATUS_SCHEMA && d.mode === 'paper' ? d : null; } catch { return null; }
}

/** A hash-chained monitor ledger appended to autotrade/monitor/<id>.jsonl (0600) as it happens. */
export function monitorFileLedger(home: string, id: string): { ledger: Ledger; path: string } {
  if (!/^[0-9A-Za-z-]{1,64}$/.test(id)) throw new Error(`not a monitor ledger id: ${JSON.stringify(id)}`);
  mkdirSync(monitorLedgerDir(home), { recursive: true, mode: 0o700 });
  const path = join(monitorLedgerDir(home), `${id}.jsonl`);
  if (existsSync(path)) throw new Error(`monitor ledger ${path} already exists`);
  closeSync(openSync(path, 'a', 0o600));
  return { ledger: new Ledger((_e, line) => appendFileSync(path, `${line}\n`)), path };
}

export interface MonitorProcessOpts {
  home: string;
  monitor: PositionMonitor;
  /** Fresh ticks for the held mints (the fast lane in the product; a fixture tape in tests). */
  ticks: (mints: string[]) => Promise<MarketTick[]>;
  /** Re-read the paper journal + desk holdings and adopt / forget positions (default: nothing to sync). */
  sync?: () => unknown;
  mailbox?: MailboxWakeSink;
  runnerAlive?: () => boolean;
  ledgerPath?: string | null;
  cycleMs?: number;
  /** Stop when this resolves true (a STOP file, a signal); checked every cycle. */
  shouldStop?: () => boolean;
  /** Cycles to run (tests); default: until stopped. */
  maxCycles?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * The monitor process body: sync positions from the journal → tick every held coin → settle wakes → heartbeat,
 * every `cycleMs` (5 s, the fast lane's cadence). It never pauses for a guard: only a stop ends it. On a clean
 * stop it writes `state: stopped`, so the desk refuses entries at once instead of after the stale window.
 */
export async function runMonitorProcess(o: MonitorProcessOpts): Promise<{ cycles: number }> {
  const now = o.now ?? Date.now;
  const cycleMs = o.cycleMs ?? 5_000;
  // A ref'd timer keeps node alive while the loop sleeps (an unref'd one lets the process exit mid-run).
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
  const startedAt = now();
  const m = o.monitor;
  let lastBeat = 0;
  let cycles = 0;
  const beat = (state: 'running' | 'stopped') => {
    writeMonitorStatus(o.home, {
      schema: MONITOR_STATUS_SCHEMA, mode: 'paper', pid: process.pid, state, startedAt, heartbeatAt: now(),
      strategy: { id: m.strategy.id, version: m.strategy.version, hash: m.strategy.hash }, executor: m.executorName,
      runnerAlive: o.runnerAlive?.() ?? false, positions: m.status(), pendingWakes: m.pendingWakes(), ledgerPath: o.ledgerPath ?? null, ledgerHead: m.ledger.head(),
    });
    lastBeat = now();
  };
  beat('running');
  try {
    while (!(o.shouldStop?.() ?? false) && (o.maxCycles === undefined || cycles < o.maxCycles)) {
      cycles++;
      try { await o.sync?.(); } catch (e) { m.ledger.add(now(), 'sync_failed', { error: e instanceof Error ? e.message.slice(0, 200) : String(e) }); }
      const mints = [...m.positions.keys()];
      if (mints.length) {
        let ticks: MarketTick[] = [];
        try { ticks = await o.ticks(mints); } catch (e) { m.ledger.add(now(), 'ticks_failed', { error: e instanceof Error ? e.message.slice(0, 200) : String(e) }); }
        for (const k of ticks) await m.tick(k);
      }
      o.mailbox?.poll();
      await m.sweep();
      if (now() - lastBeat >= MONITOR_HEARTBEAT_MS || cycles === 1) beat('running');
      if (o.maxCycles !== undefined && cycles >= o.maxCycles) break;
      await sleep(cycleMs);
    }
  } finally {
    await m.idle();
    beat('stopped');
  }
  return { cycles };
}
