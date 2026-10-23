// dexterm autotrade — parallel strategies: N strategies on ONE data feed (task-1529). PAPER today.
//
//                    ┌──────────── one source (the live keyless data layer, or one tape) ────────────┐
//                    │   focus = the union of every strategy's candidate + held coins (one fast lane) │
//                    └──────────────────────────────┬─────────────────────────────────────────────────┘
//                                       TickHub.publish(k)  (a tape: a barrier, so a replay is deterministic)
//              ┌────────────────────────────────────┼────────────────────────────────────┐
//        member A: runAutotrade             member B: runAutotrade               member C …
//        own book (bankroll), breaker,      own book, breaker, ledger,
//        ledger + run id, entry rules,      entry rules, sessions, spend
//        sessions, spend budget             budget
//              │  MemberGate ─────────────── FleetGuard (global: model sessions open at once, $/day, sessions/day,
//              │                                         turns/day, the shared Claude allowance, ONE load check)
//              └── safety: the fleet's RunnerSafety (panic file, global stop/flatten/pause, dead-man) ⊕ the
//                  strategy's own MemberSafety (fleet-control.ts)
//
// Each member is an ordinary runAutotrade run (runner.ts, unchanged): its own SimBook, so a breaker (daily loss,
// drawdown) or a stop of one strategy never stops another; only the global switches reach all of them. The shared
// parts never multiply work: one source fetches for everyone (each strategy screens the same ticks with its own entry
// rules), one dossier per coin per 30 s whoever asks (sharedDossier), one load sample per 5 s.
//
// Paper accounts (task-1538, paper-accounts.ts): members that name an account share that account's cash instead of
// owning a bankroll; each keeps its own book of positions, breaker and ledger. One strategy can run on several accounts
// (one member per account). The accounts live for the run: a member started again joins the same account.
//
// Execution: every member binds its own executor (bindExecutors). Paper members each get their own simulated book.
// Live members (refused in this build: fleet-config.ts) would share ONE port per trading wallet, so their orders meet
// the same signer and its caps together: two live strategies can never exceed the wallet's caps between them.
//
// Nothing here holds a key, touches a wallet or the signer.

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, rmSync } from 'node:fs';
import { loadavg } from 'node:os';
import { Ledger, runFiles, runsDir, type LedgerEvent, type RunFiles } from './ledger.ts';
import type { MarketTick, Tape } from './replay.ts';
import type { ResolvedStrategy } from './strategy.ts';
import type { AgentSession } from './session.ts';
import { SessionGate, type GateCheck, type SessionKind, type AllowanceReading } from './sessions.ts';
import { effectiveCaps, type EffectiveCaps, type RunnerConfig } from './runner-config.ts';
import { runAutotrade, simExecutor, type DossierFn, type Executor, type FocusMark, type RunResult, type RunSessionFactory, type RunnerState, type VetFn } from './runner.ts';
import type { SafetyVerdict } from './safety.ts';
import type { GlobalCaps, MemberConfig } from './fleet-config.ts';
import { PaperAccount } from './paper-accounts.ts';
import {
  FLEET_STATUS_SCHEMA, MISSED_RUNNER_X, MemberSafety, isRugExit, mergeVerdicts, readMemberControl, memberControlPath,
  type FleetMemberView, type FleetStatus, type MemberState, type MemberStats,
} from './fleet-control.ts';

// ───────────────────────────── the tick hub (one feed, N strategies) ─────────────────────────────

interface Sub { id: string; queue: MarketTick[]; waiter: ((r: IteratorResult<MarketTick>) => void) | null; closed: boolean; dropped: number }

/**
 * Fan-out of one tick stream. `barrier` (tapes): a tick goes out only once every subscriber has taken the previous
 * one and asked for more, so N strategies over one tape run in a fixed order. Live: no barrier (a slow strategy never
 * holds the others back); a subscriber more than `maxQueue` ticks behind loses its oldest ones (counted).
 */
export class TickHub {
  private readonly subs = new Map<string, Sub>();
  private ended = false;
  private notify: (() => void) | null = null;
  readonly barrier: boolean;
  private readonly maxQueue: number;
  constructor(o: { barrier: boolean; maxQueue?: number }) { this.barrier = o.barrier; this.maxQueue = o.maxQueue ?? 5000; }

  private changed(): void { const n = this.notify; this.notify = null; n?.(); }

  /** `id` must be unique per subscription (a run id): a re-started strategy gets a new one. */
  subscribe(id: string): AsyncIterable<MarketTick> {
    if (this.subs.has(id)) throw new Error(`tick hub: ${id} is already subscribed`);
    const sub: Sub = { id, queue: [], waiter: null, closed: false, dropped: 0 };
    this.subs.set(id, sub);
    const close = () => { if (!sub.closed) { sub.closed = true; this.subs.delete(id); this.changed(); } };
    const it: AsyncIterator<MarketTick> = {
      next: () => {
        if (sub.queue.length) return Promise.resolve({ value: sub.queue.shift()!, done: false });
        if (this.ended || sub.closed) { close(); return Promise.resolve({ value: undefined, done: true }); }
        return new Promise<IteratorResult<MarketTick>>((resolve) => { sub.waiter = resolve; this.changed(); });
      },
      return: () => { close(); return Promise.resolve({ value: undefined, done: true }); },
    };
    return { [Symbol.asyncIterator]: () => it };
  }

  /** True when every subscriber has drained its queue and waits for more (or has gone). */
  private caughtUp(): boolean {
    for (const s of this.subs.values()) if (!s.closed && (s.queue.length || !s.waiter)) return false;
    return true;
  }

  async publish(k: MarketTick): Promise<void> {
    if (this.barrier) while (!this.caughtUp()) await new Promise<void>((r) => { this.notify = r; });
    for (const s of this.subs.values()) {
      // Each strategy gets its own copy: nothing one run does to a tick can leak into another's.
      const mine = { ...k };
      if (s.waiter) { const w = s.waiter; s.waiter = null; w({ value: mine, done: false }); continue; }
      s.queue.push(mine);
      if (s.queue.length > this.maxQueue) { s.queue.shift(); s.dropped++; }
    }
  }

  /** Wait until every subscriber took everything (the end of a tape). */
  async drain(): Promise<void> { while (!this.caughtUp()) await new Promise<void>((r) => { this.notify = r; }); }

  end(): void {
    this.ended = true;
    for (const s of [...this.subs.values()]) if (s.waiter && !s.queue.length) { const w = s.waiter; s.waiter = null; s.closed = true; this.subs.delete(s.id); w({ value: undefined, done: true }); }
  }

  /** Drop a subscriber that will never ask again (a run that failed before its first tick), so a barrier never waits on it. */
  unsubscribe(id: string): void {
    const s = this.subs.get(id);
    if (!s) return;
    s.closed = true; this.subs.delete(id);
    if (s.waiter) { const w = s.waiter; s.waiter = null; w({ value: undefined, done: true }); }
    this.changed();
  }

  get size(): number { return this.subs.size; }
  droppedBy(id: string): number { return this.subs.get(id)?.dropped ?? 0; }
}

// ───────────────────────────── the global guard ─────────────────────────────

export interface LoadConfig { pauseAboveLoad1m: number; resumeBelowLoad1m: number; sustainSec: number }
export const DEFAULT_FLEET_LOAD: LoadConfig = { pauseAboveLoad1m: 25, resumeBelowLoad1m: 20, sustainSec: 60 };

/** ONE machine-load check for every strategy: sampled at most every 5 s, with hysteresis. */
export class LoadGuard {
  private readonly cfg: LoadConfig;
  private readonly read: () => number;
  private readonly clock: () => number;
  private lastAt = -Infinity;
  private aboveSince: number | null = null;
  load1m: number | null = null;
  paused = false;
  constructor(cfg: LoadConfig, o: { loadavg?: () => number; clock?: () => number } = {}) { this.cfg = cfg; this.read = o.loadavg ?? (() => loadavg()[0]); this.clock = o.clock ?? Date.now; }
  sample(): void {
    const now = this.clock();
    if (now - this.lastAt < 5000) return;
    this.lastAt = now;
    const l = this.read();
    this.load1m = Math.round(l * 100) / 100;
    if (l > this.cfg.pauseAboveLoad1m) { this.aboveSince ??= now; if (now - this.aboveSince >= this.cfg.sustainSec * 1000) this.paused = true; }
    else { this.aboveSince = null; if (l < this.cfg.resumeBelowLoad1m) this.paused = false; }
  }
  get config(): LoadConfig { return this.cfg; }
}

/**
 * The caps across every strategy: model sessions open at once (candidate and position sessions of all of them),
 * model $ / turns / sessions per day, the shared Claude allowance (one account: a reading from any session applies to
 * all), a misconfigured account (blocks every strategy), and the load check. The day counters run on the WALL clock.
 */
export class FleetGuard {
  readonly caps: GlobalCaps;
  readonly gate: SessionGate;
  readonly load: LoadGuard;
  private readonly members = new Set<MemberGate>();
  live = 0;
  readonly liveBy = new Map<string, number>();

  constructor(caps: GlobalCaps, runner: RunnerConfig, o: { clock?: () => number; loadavg?: () => number; load?: LoadConfig } = {}) {
    // The runner config (machine-local, one per process) caps the whole fleet too: the stricter number wins.
    this.caps = {
      maxConcurrentSessions: caps.maxConcurrentSessions,
      modelUsdPerDay: Math.min(caps.modelUsdPerDay, runner.caps.modelUsdPerDay),
      candidateSessionsPerDay: Math.min(caps.candidateSessionsPerDay, runner.caps.candidateSessionsPerDay),
      positionSessionsPerDay: Math.min(caps.positionSessionsPerDay, runner.caps.positionSessionsPerDay),
      turnsPerDay: Math.min(caps.turnsPerDay, runner.caps.turnsPerDay),
    };
    const eff: EffectiveCaps = { maxSessions: Infinity, budgetUsdPerSession: Infinity, maxTurnsPerSession: Infinity, modelUsdPerDay: this.caps.modelUsdPerDay, candidateSessionsPerDay: this.caps.candidateSessionsPerDay, positionSessionsPerDay: this.caps.positionSessionsPerDay, turnsPerDay: this.caps.turnsPerDay };
    this.gate = new SessionGate(eff, runner.allowanceGuard, { clock: o.clock });
    const lc = o.load ?? (runner.load ? { pauseAboveLoad1m: runner.load.pauseAboveLoad1m, resumeBelowLoad1m: runner.load.resumeBelowLoad1m, sustainSec: runner.load.sustainSec } : DEFAULT_FLEET_LOAD);
    this.load = new LoadGuard(lc, { loadavg: o.loadavg, clock: o.clock });
  }

  register(g: MemberGate): void { this.members.add(g); }

  canOpen(kind: SessionKind): GateCheck {
    this.load.sample();
    if (this.load.paused) return { ok: false, reason: 'fleet-load-high' };
    if (this.live >= this.caps.maxConcurrentSessions) return { ok: false, reason: 'fleet-max-sessions' };
    const g = this.gate.canOpen(kind, 0);
    return g.ok ? g : { ok: false, reason: `fleet-${g.reason}` };
  }

  /** A session factory that counts its sessions in the fleet-wide open total (closed by the runner, always). */
  track(member: string, f: RunSessionFactory): RunSessionFactory {
    return (id, s, ctx) => {
      const x: AgentSession = f(id, s, ctx);
      this.live++; this.liveBy.set(member, (this.liveBy.get(member) ?? 0) + 1);
      let closed = false;
      const close = x.close.bind(x);
      x.close = async (reason: string) => {
        if (!closed) { closed = true; this.live--; this.liveBy.set(member, Math.max(0, (this.liveBy.get(member) ?? 1) - 1)); }
        return close(reason);
      };
      return x;
    };
  }

  rateLimit(r: AllowanceReading, from: MemberGate): void {
    this.gate.rateLimit(r);
    for (const m of this.members) if (m !== from) m.shareRateLimit(r);
  }

  block(reason: string, from: MemberGate): void {
    this.gate.block(reason);
    for (const m of this.members) if (m !== from) m.shareBlock(reason);
  }

  paused(): boolean { return this.gate.paused() || this.load.paused; }
}

/** The caps one strategy runs under: the stricter of the strategy, its autotrade.json caps and runner.json. */
export function memberCaps(s: ResolvedStrategy, runner: RunnerConfig, m: MemberConfig['caps']): EffectiveCaps {
  const e = effectiveCaps(s, runner);
  const min = (a: number, b: number | undefined) => (b === undefined ? a : Math.min(a, b));
  return {
    ...e,
    maxSessions: min(e.maxSessions, m.maxSessions),
    modelUsdPerDay: min(e.modelUsdPerDay, m.modelUsdPerDay),
    candidateSessionsPerDay: min(e.candidateSessionsPerDay, m.candidateSessionsPerDay),
    positionSessionsPerDay: min(e.positionSessionsPerDay, m.positionSessionsPerDay),
    turnsPerDay: min(e.turnsPerDay, m.turnsPerDay),
  };
}

/**
 * One strategy's session gate: its own caps first (SessionGate), then the fleet's. Every turn and every dollar counts
 * against both, so the global $/day holds across all strategies and each strategy's own budget holds on its own.
 */
export class MemberGate extends SessionGate {
  readonly member: string;
  private readonly fleet: FleetGuard;
  constructor(member: string, caps: EffectiveCaps, runner: RunnerConfig, fleet: FleetGuard, o: { clock?: () => number } = {}) {
    super(caps, runner.allowanceGuard, o);
    this.member = member; this.fleet = fleet;
    fleet.register(this);
  }
  override canOpen(kind: SessionKind, live: number): GateCheck {
    const own = super.canOpen(kind, live);
    return own.ok ? this.fleet.canOpen(kind) : own;
  }
  override opened(kind: SessionKind): void { super.opened(kind); this.fleet.gate.opened(kind); }
  override turn(costDeltaUsd: number): void { super.turn(costDeltaUsd); this.fleet.gate.turn(costDeltaUsd); }
  override spend(usd: number): void { super.spend(usd); this.fleet.gate.spend(usd); }
  override overDay(): string | null { const o = super.overDay(); if (o) return o; const g = this.fleet.gate.overDay(); return g ? `fleet-${g}` : null; }
  override rateLimit(r: AllowanceReading): void { super.rateLimit(r); this.fleet.rateLimit(r, this); }
  override block(reason: string): void { super.block(reason); this.fleet.block(reason, this); }
  override paused(): boolean { return super.paused() || this.fleet.paused(); }
  /** A reading another strategy's session made (the same Claude account). */
  shareRateLimit(r: AllowanceReading): void { super.rateLimit(r); }
  shareBlock(reason: string): void { super.block(reason); }
}

// ───────────────────────────── shared dossier, executors ─────────────────────────────

/**
 * One dossier record per coin per `ttlMs`, whoever asks: two strategies that pick the same coin at the same time cost
 * one fetch. The record is shared; each strategy renders its own text (its own bounds and bankroll).
 */
export function sharedDossier<R>(fetch: (mint: string) => Promise<R>, ttlMs = 30_000, clock: () => number = Date.now): { get(mint: string): Promise<R>; fetches: () => number } {
  const cache = new Map<string, { at: number; rec: Promise<R> }>();
  let n = 0;
  return {
    get(mint) {
      const now = clock();
      const hit = cache.get(mint);
      if (hit && now - hit.at < ttlMs) return hit.rec;
      n++;
      const rec = fetch(mint);
      cache.set(mint, { at: now, rec });
      rec.catch(() => cache.delete(mint));
      if (cache.size > 500) for (const [k, v] of cache) if (now - v.at >= ttlMs) cache.delete(k);
      return rec;
    },
    fetches: () => n,
  };
}

export interface ExecutorBinding {
  /** Each paper member's own executor (its own simulated fills). */
  paper: (m: { id: string; strategy: ResolvedStrategy }) => Executor;
  /** The live port of a trading wallet; called ONCE per wallet, whatever the number of live members. Absent: live is refused. */
  live?: (wallet: string) => Executor;
}

/** Executors by member id. Live members share one port per wallet, so the wallet's signer caps hold across them. */
export function bindExecutors(members: { id: string; mode: 'paper' | 'live'; wallet?: string; strategy: ResolvedStrategy }[], b: ExecutorBinding): { ok: true; executors: Map<string, Executor>; livePorts: number } | { ok: false; why: string } {
  const out = new Map<string, Executor>();
  const ports = new Map<string, Executor>();
  for (const m of members) {
    if (m.mode === 'paper') { out.set(m.id, b.paper(m)); continue; }
    if (!b.live) return { ok: false, why: `${m.id}: live execution is not available for parallel strategies in this build` };
    const w = m.wallet ?? 'trading-wallet';
    if (!ports.has(w)) ports.set(w, b.live(w));
    out.set(m.id, ports.get(w)!);
  }
  return { ok: true, executors: out, livePorts: ports.size };
}

// ───────────────────────────── per-strategy stats (for the comparison table) ─────────────────────────────

/**
 * Folds one strategy's ledger events into its stats, and watches the shared feed for coins it saw as candidates but
 * did not enter: one that later trades at >= MISSED_RUNNER_X its candidate price is a missed runner.
 */
export class MemberStatsTracker {
  readonly stats: MemberStats = { candidates: 0, entries: 0, closed: 0, wins: 0, losses: 0, realizedUsd: 0, rugExits: 0, rugCostUsd: 0, enteredUsd: 0, missedRunners: 0, missedSample: [], spendUsd: 0 };
  private endedSpend = 0;
  private readonly watch = new Map<string, { symbol: string; price: number; entered: boolean; missed: boolean }>();
  private readonly positions = new Map<string, number>();

  onEvent(e: LedgerEvent): void {
    switch (e.kind) {
      case 'candidate': {
        this.stats.candidates++;
        const price = (e.tick as { price?: number | null } | undefined)?.price ?? null;
        const mint = String(e.mint);
        const w = this.watch.get(mint);
        if (price && price > 0 && !w) this.watch.set(mint, { symbol: String(e.symbol ?? ''), price, entered: false, missed: false });
        break;
      }
      case 'fill': {
        const usd = Number(e.usd) || 0;
        if (e.side === 'buy') {
          this.stats.enteredUsd += usd;
          if (e.profile !== undefined) this.stats.entries++;
          const w = this.watch.get(String(e.mint));
          if (w) w.entered = true;
          this.positions.set(String(e.positionId), (this.positions.get(String(e.positionId)) ?? 0) + usd);
        }
        break;
      }
      case 'trade_closed': {
        const t = e.trade as { pnlUsd: number; exitReason: string; stuck: boolean; costUsd: number } | undefined;
        if (!t) break;
        this.stats.closed++;
        if (t.pnlUsd > 0) this.stats.wins++; else this.stats.losses++;
        this.stats.realizedUsd = Math.round((this.stats.realizedUsd + t.pnlUsd) * 1e6) / 1e6;
        if (isRugExit(t.exitReason, t.stuck)) { this.stats.rugExits++; this.stats.rugCostUsd += t.costUsd; }
        break;
      }
      case 'session_end': this.endedSpend += Number(e.costUsd) || 0; break;
    }
  }

  /** A tick from the shared feed (every strategy sees the same ones). */
  onTick(k: MarketTick): void {
    const w = this.watch.get(k.mint);
    if (!w || w.entered || w.missed || !k.price) return;
    const x = k.price / w.price;
    if (x >= MISSED_RUNNER_X) {
      w.missed = true;
      this.stats.missedRunners++;
      if (this.stats.missedSample.length < 5) this.stats.missedSample.push({ symbol: w.symbol, x: Math.round(x * 10) / 10 });
    }
  }

  /** Spend = ended sessions + what the live ones show now; stuck bags still held count as rug exposure. */
  view(st: RunnerState | null): MemberStats {
    const liveSpend = st ? st.sessions.reduce((a, s) => a + s.costUsd, 0) : 0;
    const stuck = st ? st.positions.filter((p) => p.next?.startsWith('stuck')) : [];
    return {
      ...this.stats,
      rugExits: this.stats.rugExits + stuck.length,
      rugCostUsd: Math.round((this.stats.rugCostUsd + stuck.reduce((a, p) => a + p.costUsd, 0)) * 100) / 100,
      enteredUsd: Math.round(this.stats.enteredUsd * 100) / 100,
      spendUsd: Math.round((this.endedSpend + liveSpend) * 1e4) / 1e4,
      missedSample: [...this.stats.missedSample],
    };
  }
}

// ───────────────────────────── the fleet runner ─────────────────────────────

export interface FleetMemberSpec {
  config: MemberConfig;
  strategy: ResolvedStrategy;
  basedOn: { id: string; version: string; hash: string };
  bankroll: { usd: number; sol?: number; solUsd?: number };
}

export interface FleetHooks {
  /** Every ledger event of every strategy, tagged with its strategy id and run id (the chat notify bus, task-1527). */
  onMemberEvent?: (member: string, runId: string, e: LedgerEvent) => void;
  onMemberState?: (member: string, runId: string, st: RunnerState) => void;
  onFleetState?: (st: FleetStatus) => void;
}

/**
 * A chat connector's notify bus (task-1527) reads one run's ledger events. Under parallel strategies it reads EVERY
 * strategy's events through this, each tagged with `strategyId` and `runId`, so every message can name the strategy
 * it is about. One sink for all; a sink that throws never stops a run (the ledger tap swallows it).
 */
export interface StrategyEventSink { onEvent(e: LedgerEvent): void }
export function strategyTaggedHooks(sink: StrategyEventSink, also: FleetHooks = {}): FleetHooks {
  return {
    ...also,
    onMemberEvent: (member, runId, e) => { also.onMemberEvent?.(member, runId, e); sink.onEvent({ ...e, strategyId: member, runId }); },
  };
}

export interface FleetOpts {
  fleetId: string;
  home: string;
  members: FleetMemberSpec[];
  tape?: Tape;
  source?: { name: string; ticks: AsyncIterable<MarketTick>; startT?: number; setFocus?: (f: FocusMark[]) => void };
  pacing?: { mode: 'lockstep' } | { mode: 'paced'; msPerTick: number } | { mode: 'live' };
  runner: RunnerConfig;
  guard: FleetGuard;
  /** A member's session factory (null: the strategies decide mechanically). Built per member so its log goes to its own ledger. */
  sessions: ((m: FleetMemberSpec, gate: MemberGate, log: (kind: string, data: Record<string, unknown>) => void, clock: () => number) => RunSessionFactory) | null;
  dossier?: (m: FleetMemberSpec) => DossierFn | undefined;
  /** A member's network gates (its entry.safety.larp) on live data, as a single run has them; absent on a tape. */
  vet?: (m: FleetMemberSpec) => VetFn | undefined;
  executors?: ExecutorBinding;
  /** Shared paper accounts (task-1538); a member whose config names one trades from its cash. */
  accounts?: { id: string; startUsd: number; sol?: number; solUsd?: number }[];
  /** Where a member run writes its ledger (default: runs/<runId>.jsonl). */
  ledgerFor?: (member: string, runId: string, tap: (e: LedgerEvent) => void) => { ledger: Ledger; files: RunFiles | null };
  newRunId: (member: string) => string;
  fleetLedger: Ledger;
  fleetLedgerPath?: string;
  /** The fleet's own verdict, every step (panic file, global stop / flatten / pause, dead-man, a local stop). */
  globalSafety: () => SafetyVerdict;
  /** Read per-strategy control files (default true; tests of the engine alone can switch it off). */
  memberControl?: boolean;
  hooks?: FleetHooks;
  onLine?: (s: string) => void;
  onStatus?: (st: FleetStatus) => void;
  verbose?: boolean;
  clock?: () => number;
}

interface Live {
  spec: FleetMemberSpec;
  state: MemberState;
  error?: string;
  runId: string | null;
  gate: MemberGate | null;
  stats: MemberStatsTracker;
  last: RunnerState | null;
  ledgerPath: string | null;
  done: Promise<RunResult | null> | null;
  result: RunResult | null;
  focus: FocusMark[];
  startedAt: number | null;
  endedAt: number | null;
}

export interface FleetResult { fleetId: string; members: { id: string; runId: string | null; result: RunResult | null; error?: string }[]; status: FleetStatus }

/** A member ledger appended to runs/<runId>.jsonl as it happens (0600), with a tap after each write. */
export function memberFileLedger(home: string, runId: string, tap: (e: LedgerEvent) => void): { ledger: Ledger; files: RunFiles } {
  const files = runFiles(home, runId);
  mkdirSync(runsDir(home), { recursive: true, mode: 0o700 });
  if (existsSync(files.ledger)) throw new Error(`run ledger ${files.ledger} already exists`);
  closeSync(openSync(files.ledger, 'a', 0o600));
  const ledger = new Ledger((e, line) => { appendFileSync(files.ledger, `${line}\n`); try { tap(e); } catch { /* a hook never stops the ledger */ } });
  return { ledger, files };
}

export async function runFleet(o: FleetOpts): Promise<FleetResult> {
  if (!o.tape && !o.source) throw new Error('runFleet needs a tape or a live source');
  for (const m of o.members) if (m.config.mode !== 'paper' && !o.executors?.live) throw new Error(`${m.config.id}: live execution is not available for parallel strategies in this build`);
  const accounts = new Map<string, PaperAccount>();
  for (const a of o.accounts ?? []) {
    if (accounts.has(a.id)) throw new Error(`paper account ${a.id} is listed twice`);
    accounts.set(a.id, new PaperAccount(a.id, a.startUsd, { ...(a.sol !== undefined ? { sol: a.sol, solUsd: a.solUsd } : {}) }));
  }
  for (const m of o.members) {
    if (!m.config.account) continue;
    if (!accounts.has(m.config.account)) throw new Error(`${m.config.id}: paper account ${m.config.account} is not defined`);
    if (m.config.mode !== 'paper') throw new Error(`${m.config.id}: a paper account never backs a live strategy`);
  }
  const clock = o.clock ?? Date.now;
  const say = o.onLine ?? (() => {});
  const pacing = o.pacing ?? { mode: 'lockstep' as const };
  const hub = new TickHub({ barrier: !!o.tape || pacing.mode !== 'live' });
  const fl = o.fleetLedger;
  const startedAt = clock();
  let now = o.tape ? (o.tape.ticks[0]?.t ?? 0) : (o.source!.startT ?? startedAt);
  const lives = new Map<string, Live>();
  for (const spec of o.members) lives.set(spec.config.id, { spec, state: 'idle', runId: null, gate: null, stats: new MemberStatsTracker(), last: null, ledgerPath: null, done: null, result: null, focus: [], startedAt: null, endedAt: null });

  const execs = bindExecutors(o.members.map((m) => ({ id: m.config.id, mode: m.config.mode, strategy: m.strategy })), o.executors ?? { paper: (m) => simExecutor(m.strategy.execution) });
  if (!execs.ok) throw new Error(execs.why);

  fl.add(now, 'fleet_start', {
    fleetId: o.fleetId, mode: 'paper', source: o.tape?.source ?? o.source!.name, pacing: pacing.mode,
    members: o.members.map((m) => ({ id: m.config.id, enabled: m.config.enabled, basedOn: m.basedOn, strategyHash: m.strategy.hash, bankroll: m.bankroll, mode: m.config.mode, caps: m.config.caps, ...(m.config.account ? { account: m.config.account } : {}) })),
    global: o.guard.caps, livePorts: execs.livePorts,
    ...(accounts.size ? { accounts: [...accounts.values()].map((a) => ({ id: a.id, startUsd: a.startUsd, ...(a.sol !== undefined ? { sol: a.sol, solUsd: a.solUsd } : {}) })) } : {}),
  });

  const publishFocus = () => {
    if (!o.source?.setFocus) return;
    const seen = new Map<string, FocusMark>();
    for (const l of lives.values()) for (const f of l.focus) { const cur = seen.get(f.mint); if (!cur || f.role === 'held') seen.set(f.mint, f); }
    o.source.setFocus([...seen.values()]);
  };

  const status = (state: FleetStatus['state'], haltReason: string | null): FleetStatus => {
    const g = o.guard;
    const day = g.gate.todayNow();
    return {
      schema: FLEET_STATUS_SCHEMA, fleetId: o.fleetId, pid: process.pid, mode: 'paper', state, haltReason, startedAt, heartbeatAt: clock(),
      source: o.tape ? `replay ${o.tape.source}` : 'live',
      global: {
        caps: g.caps, today: { modelUsd: Math.round(day.modelUsd * 1e4) / 1e4, turns: day.turns, candidateSessions: day.candidateSessions, positionSessions: day.positionSessions },
        liveSessions: g.live, load: { load1m: g.load.load1m, paused: g.load.paused, pauseAbove: g.load.config.pauseAboveLoad1m, resumeBelow: g.load.config.resumeBelowLoad1m },
        allowance: g.gate.allowance ? { fiveHour: g.gate.allowance.fiveHour, sevenDay: g.gate.allowance.sevenDay } : null, blocked: g.gate.blocked,
      },
      members: [...lives.values()].map((l): FleetMemberView => ({
        id: l.spec.config.id, runId: l.runId, state: l.state, ...(l.error ? { error: l.error } : {}), haltReason: l.last?.haltReason ?? null, mode: 'paper',
        basedOn: l.spec.basedOn, strategyHash: l.spec.strategy.hash, bankroll: l.spec.bankroll,
        book: l.last ? l.last.book : null, spend: l.last ? { todayUsd: l.last.spend.todayUsd, dayCapUsd: l.last.spend.dayCapUsd } : null,
        open: (l.last?.positions ?? []).map((p) => ({ mint: p.mint, symbol: p.symbol, profile: p.profile, costUsd: p.costUsd, pnlUsd: p.pnlUsd, pnlPct: p.pnlPct, ...(p.freeBag ? { freeBag: true } : {}), ...(p.next?.startsWith('stuck') ? { stuck: true } : {}) })),
        candidates: l.last?.candidates.length ?? 0, sessions: l.last?.sessions.length ?? 0,
        stats: l.stats.view(l.last), ledgerPath: l.ledgerPath, startedAt: l.startedAt, endedAt: l.endedAt,
        ...(l.spec.config.account ? { account: l.spec.config.account, pnlUsd: l.last?.account?.pnlUsd ?? null } : {}),
      })),
      ...(accounts.size ? { accounts: [...accounts.values()].map((a) => a.view()) } : {}),
      ledgerPath: o.fleetLedgerPath ?? '',
    };
  };
  let globalHalt: string | null = null;
  const emitStatus = (state: FleetStatus['state'] = globalHalt ? 'halted' : 'running') => {
    const st = status(state, globalHalt);
    o.onStatus?.(st);
    o.hooks?.onFleetState?.(st);
  };

  const startMember = (l: Live, why: string) => {
    const spec = l.spec;
    const id = spec.config.id;
    const runId = o.newRunId(id);
    l.runId = runId; l.state = 'running'; l.error = undefined; l.last = null; l.result = null; l.stats = new MemberStatsTracker(); l.startedAt = clock(); l.endedAt = null; l.focus = [];
    let memberNow = now;
    const tap = (e: LedgerEvent) => { l.stats.onEvent(e); o.hooks?.onMemberEvent?.(id, runId, e); };
    let ledger: Ledger;
    try {
      const lf = o.ledgerFor ? o.ledgerFor(id, runId, tap) : memberFileLedger(o.home, runId, tap);
      ledger = lf.ledger; l.ledgerPath = lf.files?.ledger ?? null;
    } catch (e) { l.state = 'error'; l.error = (e as Error).message.slice(0, 200); fl.add(now, 'member_error', { member: id, error: l.error }); return; }
    const account = spec.config.account ? accounts.get(spec.config.account) : undefined;
    ledger.add(now, 'fleet_member', { fleetId: o.fleetId, member: id, basedOn: spec.basedOn, strategyHash: spec.strategy.hash, bankroll: spec.bankroll, mode: spec.config.mode, caps: spec.config.caps, why, ...(account ? { account: account.id, accountCashUsd: Math.round(account.cashUsd * 100) / 100 } : {}) });
    const gate = new MemberGate(id, memberCaps(spec.strategy, o.runner, spec.config.caps), o.runner, o.guard, { clock });
    l.gate = gate;
    const log = (kind: string, data: Record<string, unknown>) => { ledger.add(memberNow, kind, data); };
    const sessions = o.sessions ? o.guard.track(id, o.sessions(spec, gate, log, () => memberNow)) : null;
    const msafety = o.memberControl === false ? null : new MemberSafety({ home: o.home, fleetId: o.fleetId, member: id, runId });
    fl.add(now, 'member_start', { member: id, runId, why, strategyHash: spec.strategy.hash, bankroll: spec.bankroll, ...(account ? { account: account.id } : {}) });
    say(`[${id}] started (run ${runId}, ${spec.basedOn.id} v${spec.basedOn.version}, ${account ? `paper account ${account.id} ($${account.cashUsd.toFixed(2)} cash of $${account.startUsd})` : `bankroll $${spec.bankroll.usd}${spec.bankroll.sol !== undefined ? ` = ${spec.bankroll.sol} SOL` : ''}`})`);
    const ticks = hub.subscribe(runId);
    l.done = runAutotrade({
      strategy: spec.strategy, source: { name: o.tape?.source ?? o.source!.name, ticks, startT: now }, sessions, gate, ledger, runId,
      dossier: o.dossier?.(spec), vet: o.vet?.(spec), executor: execs.executors.get(id), verbose: o.verbose ?? true, onLine: (s) => say(`[${id}] ${s}`),
      pacing, ...(account ? { account, member: id } : {}),
      safety: () => {
        const g = o.globalSafety();
        return msafety ? mergeVerdicts(g, msafety.step()) : g;
      },
      onState: (st) => {
        memberNow = st.t; l.last = st;
        l.state = st.state === 'stopped' ? 'stopped' : st.state;
        o.hooks?.onMemberState?.(id, runId, st);
      },
      onFocus: (marks) => { l.focus = marks; publishFocus(); },
    } as Parameters<typeof runAutotrade>[0]).then((res) => {
      hub.unsubscribe(runId);
      l.result = res; l.state = 'stopped'; l.endedAt = clock(); l.focus = []; publishFocus();
      const v = l.stats.view(l.last);
      const own = Math.round(res.book.ownPnlUsd() * 100) / 100;
      fl.add(now, 'member_end', { member: id, runId, trades: res.trades.length, openAtEnd: res.openAtEnd.length, equityUsd: Math.round(res.book.markedEquity() * 100) / 100, startUsd: spec.bankroll.usd, spendUsd: v.spendUsd, head: res.ledger.head(), ...(account ? { account: account.id, pnlUsd: own } : {}) });
      say(account
        ? `[${id}] ended · ${res.trades.length} closed, ${res.openAtEnd.length} open · its P/L ${own >= 0 ? '+' : '-'}$${Math.abs(own).toFixed(2)} on paper account ${account.id} (account equity $${res.book.markedEquity().toFixed(2)} of $${account.startUsd})`
        : `[${id}] ended · ${res.trades.length} closed, ${res.openAtEnd.length} open · equity $${res.book.markedEquity().toFixed(2)} of $${spec.bankroll.usd}`);
      return res;
    }, (e: unknown) => {
      hub.unsubscribe(runId);
      l.state = 'error'; l.error = (e as Error).message?.slice(0, 200) ?? String(e); l.endedAt = clock(); l.focus = []; publishFocus();
      fl.add(now, 'member_error', { member: id, runId, error: l.error });
      say(`[${id}] failed: ${l.error}`);
      return null;
    });
  };

  // Start requests: a strategy of the config that is not running starts at the next tick.
  const memberControlOn = o.memberControl !== false;
  const checkStarts = () => {
    if (!memberControlOn || globalHalt) return;
    for (const l of lives.values()) {
      if (l.state === 'running' || l.state === 'paused' || l.state === 'halted') continue;
      const id = l.spec.config.id;
      const c = readMemberControl(o.home, id);
      if (!c || c === 'unreadable' || c.fleetId !== o.fleetId || c.action !== 'start') continue;
      try { rmSync(memberControlPath(o.home, id), { force: true }); } catch { /* re-read next tick */ }
      fl.add(now, 'member_control', { member: id, action: 'start', by: c.by });
      startMember(l, `start requested (${c.by})`);
    }
  };

  for (const l of lives.values()) if (l.spec.config.enabled) startMember(l, 'enabled in autotrade.json');
  emitStatus();

  const anyRunning = () => [...lives.values()].some((l) => l.done && l.state !== 'stopped' && l.state !== 'error');
  const loop: AsyncIterable<MarketTick> = o.tape ? (async function* () { for (const k of o.tape!.ticks) yield k; })() : o.source!.ticks;
  let lastStatus = 0;
  for await (const k of loop) {
    now = k.t;
    const g = o.globalSafety();
    if (g.halt && !globalHalt) { globalHalt = g.halt; fl.add(now, 'fleet_halt', { reason: g.halt, ...(g.detail ? { detail: g.detail } : {}), flatten: g.flatten }); say(`FLEET ${g.halt.toUpperCase()}: every strategy takes no new entries; mechanical exits keep running`); }
    checkStarts();
    for (const l of lives.values()) l.stats.onTick(k);
    if (!anyRunning() && hub.size === 0) break;
    await hub.publish(k);
    if (clock() - lastStatus >= 1000) { lastStatus = clock(); emitStatus(); }
  }
  if (o.tape) await hub.drain();
  hub.end();
  const results = await Promise.all([...lives.values()].map((l) => l.done ?? Promise.resolve(null)));
  void results;
  const final = status('stopped', globalHalt);
  fl.add(now, 'fleet_end', { members: final.members.map((m) => ({ id: m.id, runId: m.runId, state: m.state, equityUsd: m.book?.equityUsd ?? null, startUsd: m.bankroll.usd, closed: m.stats.closed, spendUsd: m.stats.spendUsd, ...(m.account ? { account: m.account, pnlUsd: m.pnlUsd ?? null } : {}) })), ...(final.accounts ? { accounts: final.accounts } : {}), head: fl.head() });
  o.onStatus?.(final);
  o.hooks?.onFleetState?.(final);
  return { fleetId: o.fleetId, members: [...lives.values()].map((l) => ({ id: l.spec.config.id, runId: l.runId, result: l.result, ...(l.error ? { error: l.error } : {}) })), status: final };
}
