// dexterm autotrade — the run loop (task-1498 spike, task-1505 AT-3; AUTOTRADE-SPEC §4–§6).
//
// tick → (held coin)   monitor: mechanical exits at once, WAKE events to the position's session (or, with
//                      agent.respawnOnWake, a one-answer position session when the coin has none)
//      → (candidate)   delta to its session (coalesced to the strategy cadence, urgent moves at once)
//      → (other coin)  screener: entry rules → precheck clamp → candidate → session with the full dossier, or auto entry
// session reply → validated DECISION → clamp (strategy bounds) → paper order → fill after the latency.
//
// Ticks come from a recorded tape (backtests, `--replay`) or a live source (`dexterm autotrade run --paper`, the
// Store fed from the keyless data layer). Pacing: lockstep awaits every reply before the next tick (deterministic
// backtests); paced replays sleep per tick while a session is live and let replies land when they land; live runs
// never sleep (the source paces itself) and replies land when they land.
//
// Every step lands in the hash-chained run ledger (ledger.ts) with the exact inputs (the tick, the message text, the
// raw reply, the clamp). Paper, or real (task-1645: the paper engine plus a trade-fire signal per fill, through the
// real-mode hook only); any other mode is refused before the first tick. The
// sessions' day caps and allowance guard live in SessionGate (sessions.ts); with none given, the strategy's own
// limits apply; the gate counts real usage per wall-clock day, so a fast --replay over many tape days never resets
// the $/day cap. The host part at the end of this file (lock, rendezvous, heartbeat) is what the CLI uses.

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { uptime } from 'node:os';
import { join } from 'node:path';
import { Ledger, writeJsonAtomic } from './ledger.ts';
import type { ResolvedStrategy } from './strategy.ts';
import { EntryRules, SimBook, clampEntry, simBuy, simSell, type ClosedTrade, type Exec, type Fill, type Position } from './engine.ts';
import { monitorTick, type WakeEvent } from './monitor.ts';
import type { MarketTick, Tape } from './replay.ts';
import { buildDelta, renderDelta, renderEvent, urgent, view, type AgentSession, type Bounds, type Decision, type Reply, type TickView } from './session.ts';
import { SessionGate, renderDossierRecord, renderPositionDossier, tapeDossierRecord, type CliSession, type SessionKind } from './sessions.ts';
import { DEFAULT_RUNNER_CONFIG, effectiveCaps } from './runner-config.ts';
import { DEFAULT_PRICE_BASIS, fillMcaps, levelText, type PriceBasis } from './basis-text.ts';
import type { SafetyVerdict } from './safety.ts';
import type { PaperAccount } from './paper-accounts.ts';
import type { RealStatus } from './real-mode.ts';
import type { Receipt } from './receipts.ts';

export { Ledger, type LedgerEvent } from './ledger.ts';

/** A session factory; `ctx` says whether it is a candidate session or a one-answer position session (§5). */
export type RunSessionFactory = (id: string, strategy: ResolvedStrategy, ctx: { kind: SessionKind; mint: string }) => AgentSession;

/** The model-facing first message for a candidate. Default: @dexterm/mcp buildDossier over what the tape row has. */
export type DossierFn = (k: MarketTick, history: MarketTick[], matched: string[], bounds: Bounds) => string | Promise<string>;
/** task-1532: a check that needs the network (the LARP gate) before a coin becomes a candidate. Once per coin per run. */
export type VetFn = (k: MarketTick) => Promise<{ ok: true; note?: string } | { ok: false; rule: string; detail: string }>;

/** What an order carries to the executor besides its size (task-1527: an approved entry's single-use proof). */
export interface OrderContext { proofId?: string; proposalId?: string; orderHash?: string }

/** Where paper orders execute. SimExecutor (the constant-product fill model) until the paper desk executor lands (AT-4). */
export interface Executor {
  readonly name: string;
  buy(k: MarketTick, usd: number, ctx?: OrderContext): Fill | { refused: string } | Promise<Fill | { refused: string }>;
  sell(k: MarketTick, tokens: number, reason: string): Fill | { refused: string } | Promise<Fill | { refused: string }>;
}

export function simExecutor(x: Exec): Executor {
  return { name: 'sim', buy: (k, usd) => simBuy(k, usd, x), sell: (k, tokens, reason) => simSell(k, tokens, x, reason) };
}

export interface FocusMark { mint: string; role: 'held' | 'candidate' }

// ───────────────────────────── approvals (task-1527, AUTOTRADE-SPEC §8.4 tier 3, §8.5) ─────────────────────────────
//
// With an approval hook that says an entry needs approval (strategy `entry.decide: "agent+approve"`, or approvals
// turned on), the clamp's result becomes a PROPOSAL instead of an order. The hook (the chat broker) answers later:
// approved (a size at most the proposal's, re-clamped against the book as it is then, with a single-use proof for
// the executor) or not (skipped, expired, refused, cancelled, undelivered). Not approved means no order. A kill, a
// pause or a halt cancels every open proposal; an answer that lands after one is dropped. Exits never wait on it.

/** What a proposal shows (all numbers from the engine; the reason is the agent's, shown as quoted data). */
export interface EntryProposal {
  runId: string | null;
  mint: string;
  symbol: string;
  strategy: { id: string; version: string; hash: string };
  profileId: string;
  /** The planned size (every tranche) after the clamp, and the first order of it. */
  usd: number;
  firstTrancheUsd: number;
  pctOfBook: number;
  bookUsd: number;
  price: number | null;
  liq: number | null;
  /** Constant-product estimate of the first order's impact, %. */
  impactPct: number;
  slippageBps: number;
  maxImpactPct: number;
  exitPlan: string;
  reason: string;
  sessionId: string | null;
  clamps: string[];
  decidedAt: number;
}

/** What the broker may read while a proposal is open (never a way to place an order). */
export interface ProposalLive {
  /** The coin's newest tick (the re-quote). */
  tick(): MarketTick | undefined;
  /** Re-clamp a size against the book as it is now: it can shrink or refuse, never grow. */
  reclamp(usd: number): { ok: true; usd: number; clamps: string[] } | { ok: false; refused: string };
  /** Why no entry may happen now (kill, stop, pause, halt), or null. */
  blocked(): string | null;
}

export type ApprovalOutcome =
  | { approved: true; proposalId: string; usd: number; proofId?: string; orderHash?: string; via: string }
  | { approved: false; proposalId?: string; state: string; why: string };

export interface ApprovalHook {
  /** True when this strategy's entries need an approval right now. */
  required(s: ResolvedStrategy): boolean;
  request(p: EntryProposal, live: ProposalLive): Promise<ApprovalOutcome>;
  /** Cancel every open proposal (kill, pause, halt, end of run). Their requests resolve as not approved. */
  cancelAll(reason: string): void;
  /** A confirmed chat [Sell] for a held coin, taken once (it lowers risk: an agent-exit equivalent at this tick). */
  takeExit?(mint: string): { id: string; via: string } | null;
  exitResult?(id: string, result: 'sold' | 'stuck' | 'partial' | 'not-held'): void;
}

/**
 * task-1645: real mode. The run's executor (real-mode.ts RealSignalExecutor) turns every fill of the paper model into
 * a LIVE TRADE FIRE signal for the user's own executor; this side of it is what the loop calls each tick.
 */
export interface RealRunHook {
  readonly accountId: string;
  /** New receipts (ledger rows) and a real-mode kill (the run halts). */
  step(): { receipts: Receipt[]; halt: string | null };
  /** The run's last signal (`halted`), idempotent. */
  sendHalted(reason: string): void;
  confirmOf(mint: string): string | null;
  status(): RealStatus;
  /** r2: real positions an earlier run of this strategy + account left open; the book adopts them at the start. */
  inherited(): Position[];
  /** r2: the run's end, before `halted`: the book's view of what is still open, saved for the next run. */
  carry(open: Position[]): void;
  /** task-1654: the maxHoldMinutes limit (the stricter of it and each exit profile's own cap applies), or null. */
  maxHoldMinutes?(): number | null;
}

export interface RunOpts {
  strategy: ResolvedStrategy;
  /** task-1537: the price basis of the run's lines and the agents' messages (default market cap; the engine reads prices). */
  basis?: PriceBasis;
  /** A recorded tape (backtests, replays) ... */
  tape?: Tape;
  /** ... or a live tick stream (the Store-fed source); `startT` seeds the book's day. */
  source?: { name: string; ticks: AsyncIterable<MarketTick>; startT?: number };
  /** null → the strategy decides mechanically (decide: auto), whatever entry.decide says. */
  sessions: RunSessionFactory | null;
  /** lockstep: await every reply before the next tick (deterministic). paced: wall-clock pacing, replies land when they land. live: no sleeps. */
  pacing?: { mode: 'lockstep' } | { mode: 'paced'; msPerTick: number } | { mode: 'live' };
  /** Checked on every step (the app's panic file in a real run). */
  killSwitch?: () => boolean;
  /**
   * Read on every step (task-1509, safety.ts RunnerSafety): the panic file, stop / flatten / pause requests and the
   * entry dead-man. A halt is final for the run; flatten sells every position at its next tick; endWhenFlat ends
   * the run once nothing is held.
   */
  safety?: () => SafetyVerdict;
  ledger?: Ledger;
  /** Log every delta / message text (the demo, real runs); backtests keep the ledger lean. */
  verbose?: boolean;
  onLine?: (s: string) => void;
  /** Day caps + allowance guard (runner.json ∧ strategy). Default: the strategy's own limits. */
  gate?: SessionGate;
  dossier?: DossierFn;
  /** task-1532: the strategy's network gates (entry.safety.larp) on live data; absent in replays and backtests. */
  vet?: VetFn;
  executor?: Executor;
  /** The run's state after each step (the host writes the TUI rendezvous from it, throttled). */
  onState?: (s: RunnerState) => void;
  /** Candidate and held coins whenever the set changes (the fast lane and the recorder's focus file). */
  onFocus?: (f: FocusMark[]) => void;
  /** Entries that need an approval become proposals (task-1527). Without it, `agent+approve` entries are refused. */
  approvals?: ApprovalHook;
  /** The run id proposals carry (the host's). */
  runId?: string;
  /**
   * A shared paper account (task-1538): the book trades from the account's cash instead of the strategy's own
   * bankroll, next to the other strategies on it. Paper only. `member` names this run on the account (default: the
   * strategy id).
   */
  account?: PaperAccount;
  member?: string;
  /** task-1645: a strategy in mode "real" runs only with this hook, and `executor` must be the same signal executor. */
  real?: RealRunHook;
  /**
   * 0.2.0 card B: positions a crashed run of this strategy left open (service-recover.ts). The book adopts them at
   * the start; their exits run as usual. Nothing is bought for them, and no order of the crashed run is re-sent.
   */
  adopt?: Position[];
  /** task-1654: a paper run's maxHoldMinutes limit (the `paper` scope of limits.json), or null. */
  maxHoldMinutes?: () => number | null;
}

interface Candidate {
  mint: string;
  symbol: string;
  since: number;
  /** Last tick the entry rules still matched; the candidate expires candidateTtlSec after it. */
  lastMatch: number;
  matched: string[];
  session: AgentSession | null;
  sessionKind: SessionKind;
  lastSent: TickView;
  lastSentT: number;
  seq: number;
  inflight: Promise<void> | null;
  pendingText: string[];
  /** Engine notes (fills, refusals) that ride along with the next message instead of costing a turn. */
  notes: string[];
  closing: boolean;
  /** The review wake waiting for an answer (no answer → the profile's wake.noAnswer). */
  awaitingReview: WakeEvent | null;
  positionId: string | null;
  /** A position session answers once, then closes. */
  oneShot: boolean;
  costSeen: number;
  turns: number;
  lastDecision: string | null;
}

interface PendingOrder { mint: string; fillAt: number; decidedPrice: number; usd: number; firstUsd: number; profile: string; sessionId: string | null; trigger: string[]; ladder: Position['ladder']; kind: 'open' | 'add'; positionId?: string; ctx?: OrderContext }

export interface RunResult {
  trades: ClosedTrade[];
  openAtEnd: { mint: string; symbol: string; markUsd: number; costUsd: number; stuck: boolean }[];
  ledger: Ledger;
  book: SimBook;
  candidates: number;
  sessions: number;
  sessionCostUsd: number;
  maxDrawdownPct: number;
  equityCurve: { t: number; equity: number }[];
  refusals: Record<string, number>;
  clamps: Record<string, number>;
}

/** What the TUI's runner view and the heartbeat need (the rendezvous body minus pid/heartbeat, which the host adds). */
export interface RunnerState {
  t: number;
  state: 'running' | 'paused' | 'halted' | 'stopped';
  haltReason: string | null;
  strategy: { id: string; version: string; hash: string };
  book: { startUsd: number; equityUsd: number; cashUsd: number; realizedTodayUsd: number };
  /** On a shared paper account (task-1538): `book` is the account's; `pnlUsd` is this strategy's own share. */
  account?: { id: string; pnlUsd: number };
  spend: { todayUsd: number; dayCapUsd: number; turnsToday: number; candidateSessionsToday: number; positionSessionsToday: number; allowance: { fiveHour: number | null; sevenDay: number | null } | null };
  candidates: { mint: string; symbol: string; ageSec: number; matched: string[]; session: string | null }[];
  sessions: { id: string; kind: SessionKind; mint: string; symbol: string; turns: number; costUsd: number; budgetUsd: number; lastDecision: string | null }[];
  positions: { mint: string; symbol: string; profile: string; costUsd: number; pnlUsd: number; pnlPct: number; next: string | null; freeBag?: boolean; /** task-1645: real mode: unconfirmed until a receipt. */ confirm?: string }[];
  ledgerTail: { seq: number; t: number; kind: string; text: string }[];
  ledgerHead: string;
  events: number;
  /** task-1645: real mode only: the account, caps, kill, outbox depth, channel health, unconfirmed positions. */
  real?: RealStatus;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const REVIEW: WakeEvent['event'][] = ['time_review', 'time_tighten'];
const INFO_ONLY: WakeEvent['event'][] = ['mechanical_exit', 'stuck'];
/** Session ends that fail the same way every time: no new session for the rest of the run. */
const GUARD_REASONS = new Set(['account-mismatch', 'not-tool-less', 'account-unavailable']);

async function* fromArray(ticks: MarketTick[]): AsyncIterable<MarketTick> { for (const k of ticks) yield k; }

export async function runAutotrade(o: RunOpts): Promise<RunResult> {
  const s = o.strategy;
  // task-1571: autotrade runs on paper only. dexterm holds no key and places no live order; live trading happens in the
  // Telegram trading bot of the user's choice.
  // task-1645: mode "real" = the same paper engine, plus a LIVE TRADE FIRE signal per fill for the user's own executor;
  // it needs the real-mode hook (armed on the user's terminal, checked by the host) and never runs without it.
  if (s.mode === 'real' && !o.real) throw new Error(`strategy ${s.id} is mode "real": it runs only through the real-mode host (dexterm autotrade run ${s.id} --real, once armed on your own terminal)`);
  if (s.mode !== 'paper' && s.mode !== 'real') throw new Error(`strategy ${s.id} is mode "${s.mode}": autotrade runs paper only (dexterm holds no key and places no live order); mode real runs only through the real-mode host`);
  if (o.real && s.mode !== 'real') throw new Error(`strategy ${s.id} is mode "${s.mode}": the real-mode hook is for a strategy in mode "real" only`);
  if (o.real && (!o.executor || (o.executor as unknown) !== (o.real as unknown))) throw new Error('real mode: the executor must be the real-mode signal executor itself');
  if (!o.tape && !o.source) throw new Error('runAutotrade needs a tape or a live source');
  const ledger = o.ledger ?? new Ledger();
  const say = o.onLine ?? (() => {});
  const tapeTicks = o.tape?.ticks;
  const t0 = tapeTicks ? (tapeTicks[0]?.t ?? 0) : (o.source!.startT ?? Date.now());
  if (o.account && s.mode !== 'paper') throw new Error(`strategy ${s.id}: a paper account holds simulated cash only; it never backs a live run`);
  const book = new SimBook(s, t0, o.account, o.member);
  const rules = new EntryRules(s);
  const pacing = o.pacing ?? { mode: 'lockstep' as const };
  const decideAuto = o.sessions === null || s.entry.decide === 'auto';
  const x = s.execution;
  const exec = o.executor ?? simExecutor(x);
  // Without a runner config the strategy's own limits apply (no extra runner caps).
  const gate = o.gate ?? new SessionGate(effectiveCaps(s, { ...DEFAULT_RUNNER_CONFIG, caps: { candidateSessionsPerDay: Infinity, positionSessionsPerDay: Infinity, modelUsdPerDay: Infinity, turnsPerDay: Infinity } }), { fiveHourMax: 1, sevenDayMax: 1, onLimit: 'pause-until-reset' });
  const basis: PriceBasis = o.basis ?? DEFAULT_PRICE_BASIS;
  const lvl = (price: number, k: MarketTick | null | undefined): string => levelText(basis, price, k);
  const dossierFn: DossierFn = o.dossier ?? ((k, h, matched, b) => renderDossierRecord(tapeDossierRecord(k), { mint: k.mint, symbol: k.symbol, matched }, k, h, b, basis));
  const latest = new Map<string, MarketTick>();
  const hist = new Map<string, MarketTick[]>();
  const cands = new Map<string, Candidate>();
  const byPosition = new Map<string, Candidate>();
  const skippedUntil = new Map<string, number>();
  /** Coins the vet passed this run (a refused one goes to skippedUntil for good). */
  const vetted = new Set<string>();
  const orders: PendingOrder[] = [];
  const refusals: Record<string, number> = {};
  const clampCount: Record<string, number> = {};
  const curve: { t: number; equity: number }[] = [];
  let sessionsOpened = 0;
  let positionSessionsOpened = 0;
  let sessionCost = 0;
  let maxDd = 0;
  let now = t0;
  let killed = false;
  let haltReason: string | null = null;
  let flattening = false;
  let endWhenFlat = false;
  let entriesPaused: string | null = null;
  let focusSig = '';
  /** Every reply pump still running, including those of closed candidates (their late replies are logged before run_end). */
  const pumps = new Set<Promise<void>>();
  /** Proposals waiting for an answer, by mint (task-1527). */
  const approvalsOpen = new Map<string, Promise<void>>();

  ledger.add(t0, 'run_start', { strategy: s.id, version: s.version, strategyHash: s.hash, mode: s.mode, ...(o.real ? { tag: 'real-signal', accountId: o.real.accountId } : {}), ...(s.highRisk ? { highRisk: true } : {}), tape: o.tape?.source ?? o.source!.name, ticks: tapeTicks?.length ?? null, decide: decideAuto ? 'auto' : s.entry.decide, ...(o.approvals ? { approvals: o.approvals.required(s) ? 'required' : 'when-asked' } : {}), pacing: pacing.mode, executor: exec.name, caps: capsView(gate), ...(o.account ? { account: o.account.id } : {}) });
  // task-1645 r2: a real run takes over the real positions an earlier run of this strategy left open (held.json),
  // so their exits keep firing. A profile the strategy no longer has falls back to its default profile.
  for (const p of o.real?.inherited() ?? []) {
    const from = p.profileId;
    if (!s.exits.profiles[p.profileId]) p.profileId = s.exits.default;
    if (!book.adopt(p)) continue;
    ledger.add(t0, 'position_adopted', { tag: 'real-signal', positionId: p.id, mint: p.mint, symbol: p.symbol, ...(from !== p.profileId ? { profileFrom: from } : {}), position: { ...p, fills: p.fills } });
    say(`CARRIED ${p.symbol} (${p.mint.slice(0, 4)}…): real position from an earlier run, ${p.profileId}, cost $${(p.costUsd - p.realizedUsd).toFixed(2)} still open; its exits keep running`);
  }
  // 0.2.0 card B: positions a crashed run left open. A profile the (re-read) strategy no longer has falls back to
  // its default profile, so every adopted position has exits.
  for (const p of o.adopt ?? []) {
    const from = p.profileId;
    if (!s.exits.profiles[p.profileId]) p.profileId = s.exits.default;
    if (!book.adopt(p)) continue;
    ledger.add(t0, 'position_adopted', { positionId: p.id, mint: p.mint, symbol: p.symbol, ...(from !== p.profileId ? { profileFrom: from } : {}), position: { ...p, fills: p.fills } });
    say(`RESUMED ${p.symbol} (${p.mint.slice(0, 4)}…): ${p.profileId}, cost $${(p.costUsd - p.realizedUsd).toFixed(2)} still open; its exits keep running`);
  }

  const count = (rule: string) => { refusals[rule] = (refusals[rule] ?? 0) + 1; };
  const refuse = (rule: string, data: Record<string, unknown>) => { count(rule); ledger.add(now, 'refused', { rule, ...data }); };
  // A vet that throws or hangs is a check that could not run: the strategy's `unknown` decides (reject by default).
  const vetCoin = async (k: MarketTick): Promise<Awaited<ReturnType<VetFn>>> => {
    let r: Awaited<ReturnType<VetFn>>;
    try { r = await o.vet!(k); } catch (e) { r = { ok: false, rule: 'vet-error', detail: (e as Error).message.slice(0, 160) }; }
    if (r.ok) { vetted.add(k.mint); if (r.note) ledger.add(now, 'vetted', { mint: k.mint, note: r.note.slice(0, 200) }); }
    return r;
  };
  const liveCandidateSessions = () => [...cands.values()].filter((q) => q.session && !q.positionId).length;
  const everyLive = () => [...new Set([...cands.values(), ...byPosition.values()])];

  const newCand = (k: MarketTick, matched: string[], session: AgentSession | null, kind: SessionKind, positionId: string | null): Candidate => ({
    mint: k.mint, symbol: k.symbol, since: now, lastMatch: now, matched, session, sessionKind: kind, lastSent: view(k), lastSentT: now, seq: 0,
    inflight: null, pendingText: [], notes: [], closing: false, positionId, awaitingReview: null, oneShot: kind === 'position', costSeen: 0, turns: 0, lastDecision: null,
  });

  /**
   * Why the session's process ended on its own (null while alive). A session that proved the account or its tool list
   * wrong (or had no account) blocks new sessions for the run; the guard is logged once, by the session that set it.
   * Checked on every path that learns of a death: a null reply AND a close (a candidate's TTL can close a session that
   * already died, before its null reply is read; task-1712).
   */
  let guardLogged = false;
  const sessionDied = (c: Candidate): string | null => {
    const died = (c.session as { endReason?: () => string | null } | null)?.endReason?.() ?? null;
    if (c.session && died && GUARD_REASONS.has(died)) {
      if (!guardLogged && (gate.blocked === null || gate.blockedBy === c.session.id)) {
        guardLogged = true;
        ledger.add(now, 'guard', { state: died, effect: 'no new sessions this run; mechanical exits continue', sessionId: c.session.id });
      }
      gate.block(died, c.session.id);
    }
    return died;
  };

  const closeCandidate = async (c: Candidate, reason: string) => {
    if (c.closing) return;
    c.closing = true;
    if (cands.get(c.mint) === c) cands.delete(c.mint);
    if (c.positionId) { if (byPosition.get(c.positionId) === c) byPosition.delete(c.positionId); }
    else skippedUntil.set(c.mint, now + Math.max(s.entry.candidateTtlSec * 1000, s.risk.perCoin.cooldownMin * 60e3));
    if (c.session) {
      // Never await c.inflight here: a close can come from inside the reply pump itself. Closing the
      // session settles a pending send with null.
      const st = await c.session.close(reason);
      if (st.costUsd > c.costSeen) { gate.spend(st.costUsd - c.costSeen); c.costSeen = st.costUsd; }
      sessionCost += st.costUsd;
      // A session that had already failed its proof ended for that reason, whatever closed its candidate.
      const died = sessionDied(c);
      const why = died && GUARD_REASONS.has(died) ? died : reason;
      ledger.add(now, 'session_end', { sessionId: c.session.id, sessionKind: c.sessionKind, mint: c.mint, reason: why, turns: st.turns, costUsd: st.costUsd });
      say(`session ${c.session.id} ended (${why}) · ${st.turns} turns · $${st.costUsd.toFixed(4)}`);
    }
  };

  const sellPosition = async (p: Position, k: MarketTick, tokens: number, reason: string, detail: string): Promise<void> => {
    if (tokens <= 0) return;
    const f = await exec.sell(k, Math.min(tokens, p.tokens), reason);
    if ('refused' in f) {
      if (!p.stuck) { p.stuck = true; ledger.add(now, 'stuck', { positionId: p.id, mint: p.mint, why: f.refused, reason }); say(`STUCK ${p.symbol}: cannot sell (${f.refused})`); }
      return;
    }
    p.stuck = false;
    ledger.add(now, 'fill', { positionId: p.id, mint: p.mint, ...fillMcaps(fillView(f), k), detail, ...sigTag(f) });
    say(`SELL ${p.symbol} ${reason}: $${f.usd.toFixed(2)} at ${lvl(f.price, k)} (impact ${f.impactPct}%) — ${detail}`);
    const ct = book.sell(p, f);
    if (ct) {
      // task-1530: the price extremes the monitor saw while held (the trade ledger's MFE / MAE)
      ledger.add(now, 'trade_closed', { trade: { ...ct, fills: undefined }, entryPrice: p.entryPrice, peakPrice: p.peakPrice, troughPrice: p.troughPrice ?? null, ...(o.real ? { tag: 'real-signal' } : {}) });
      say(`CLOSED ${ct.symbol}: ${ct.pnlUsd >= 0 ? '+' : ''}$${ct.pnlUsd.toFixed(2)} (${ct.pnlPct}%) by ${ct.exitReason}`);
    }
  };

  /** Apply a validated decision at the current virtual time. */
  const apply = async (c: Candidate, d: Decision) => {
    const k = latest.get(c.mint)!;
    const pos = book.open.get(c.mint);
    if (!pos || pos.id !== c.positionId) {
      if (c.positionId) { ledger.add(now, 'late_reply_ignored', { sessionId: c.session?.id ?? null, mint: c.mint, decision: d, why: 'position already closed' }); return; }
      // Candidate phase: enter / wait / skip.
      if (d.action === 'skip') { await closeCandidate(c, 'agent-skip'); return; }
      if (d.action !== 'enter') return;
      if (orders.some((q) => q.mint === c.mint)) return;
      if (entriesPaused && !killed) { refuse('entries-paused', { mint: c.mint, why: entriesPaused }); await closeCandidate(c, 'refused:entries-paused'); return; }
      const req = { profile: d.profile, sizePct: d.sizePct, sizeUsd: d.sizeUsd, confidence: d.confidence };
      const r = clampEntry(book, k, req, killed);
      ledger.add(now, 'clamp', { mint: c.mint, sessionId: c.session?.id ?? null, request: req, result: r.ok ? { ok: true, usd: r.usd, firstTrancheUsd: r.firstTrancheUsd, profile: r.profile.id, basis: r.basis, clamps: r.clamps } : r });
      for (const cl of r.clamps) clampCount[cl.rule] = (clampCount[cl.rule] ?? 0) + 1;
      if (!r.ok) { refuse(r.refused, { mint: c.mint, stage: 'entry' }); await closeCandidate(c, `refused:${r.refused}`); return; }
      say(`clamp ${k.symbol}: asked ${d.sizePct !== undefined ? `${d.sizePct}%` : d.sizeUsd !== undefined ? `$${d.sizeUsd}` : 'default'} → $${r.usd} (${r.basis}${r.clamps.length ? `; clamped by ${r.clamps.map((q) => q.rule).join(', ')}` : ''})`);
      const needsApproval = s.entry.decide === 'agent+approve' || (o.approvals?.required(s) ?? false);
      if (needsApproval) { await propose(c, k, d, r); return; }
      const ladder = (s.sizing.ladder ?? []).slice(1).map((tr) => ({ frac: tr.frac, atPct: tr.atPct, deadline: now + tr.withinMin * 60e3, usd: r.usd * tr.frac }));
      orders.push({ mint: c.mint, fillAt: now + x.latencyMs, decidedPrice: k.price ?? 0, usd: r.firstTrancheUsd, firstUsd: r.firstTrancheUsd, profile: r.profile.id, sessionId: c.session?.id ?? null, trigger: c.matched, ladder, kind: 'open' });
      return;
    }
    // Position phase: hold / exit / tighten / reprofile. The agent may only reduce risk or move along profile edges.
    if (d.action === 'hold' || d.action === 'wait') return;
    if (d.action === 'exit') {
      const frac = Math.min(1, d.fraction ?? 1);
      await sellPosition(pos, k, pos.tokens * frac, frac >= 0.999 ? 'agent-exit' : 'agent-trim', d.reason);
      return;
    }
    if (d.action === 'tighten') {
      const prof = s.exits.profiles[pos.profileId];
      if (prof.trailingStop) { pos.trailArmed = true; ledger.add(now, 'tighten', { positionId: pos.id, armed: 'trail' }); }
      else if (prof.bagTrail && pos.costRecovered) {
        // A free bag tightens by halving its trail (never below 10%), once; it can never be loosened again.
        pos.bagTrailPct = Math.max(10, Math.min(pos.bagTrailPct ?? prof.bagTrail.trailPct, Math.round(prof.bagTrail.trailPct / 2)));
        ledger.add(now, 'tighten', { positionId: pos.id, armed: 'bag-trail', trailPct: pos.bagTrailPct });
      } else refuse('tighten-no-trail', { positionId: pos.id });
      return;
    }
    if (d.action === 'reprofile') {
      const from = s.exits.profiles[pos.profileId];
      const to = d.profile ? s.exits.profiles[d.profile] : undefined;
      if (!to || !from.reprofileTo.includes(to.id)) { refuse('reprofile-edge', { positionId: pos.id, to: d.profile ?? null }); return; }
      const upgrade = to.sizing.maxSizePctOfBankroll > from.sizing.maxSizePctOfBankroll;
      if (upgrade && pos.tpFilled < 1) { refuse('reprofile-upgrade-needs-tp1', { positionId: pos.id, to: to.id }); return; }
      ledger.add(now, 'reprofile', { positionId: pos.id, from: from.id, to: to.id, reason: d.reason });
      pos.profileId = to.id;
      return;
    }
    refuse('action-not-allowed-while-holding', { positionId: pos.id, action: d.action });
  };

  /** The clamp's entry as a proposal; the answer places the order (or not) whenever it lands. */
  const propose = async (c: Candidate, k: MarketTick, d: Decision, r: Extract<ReturnType<typeof clampEntry>, { ok: true }>) => {
    if (!o.approvals) { refuse('approval-unavailable', { mint: c.mint, why: 'entries need an approval and no approval channel is connected' }); await closeCandidate(c, 'refused:approval-unavailable'); return; }
    if (approvalsOpen.has(c.mint)) return;
    const bank = book.bookEquity();
    const R = (k.liq ?? 0) / 2;
    const prof = r.profile;
    const prop: EntryProposal = {
      runId: o.runId ?? null, mint: c.mint, symbol: k.symbol, strategy: { id: s.id, version: s.version, hash: s.hash }, profileId: prof.id,
      usd: r.usd, firstTrancheUsd: r.firstTrancheUsd, pctOfBook: bank > 0 ? Math.round((r.usd / bank) * 1000) / 10 : 0, bookUsd: round2(bank),
      price: k.price ?? null, liq: k.liq ?? null, impactPct: R > 0 ? Math.round((r.firstTrancheUsd / R) * 1e4) / 100 : 0,
      slippageBps: x.slippageBps, maxImpactPct: x.maxPriceImpactPct, exitPlan: exitPlanLine(prof), reason: d.reason, sessionId: c.session?.id ?? null,
      clamps: r.clamps.map((q) => q.rule), decidedAt: now,
    };
    const entryBlocked = (): string | null => (killed ? `halt:${haltReason ?? 'kill'}` : entriesPaused ? `paused:${entriesPaused}` : book.state.halted ? `halted:${book.state.halted}` : null);
    const live: ProposalLive = {
      tick: () => latest.get(c.mint),
      reclamp: (usd) => {
        const t = latest.get(c.mint);
        if (!t) return { ok: false, refused: 'no-tick' };
        const rc = clampEntry(book, t, { profile: prof.id, sizeUsd: usd }, killed);
        return rc.ok ? { ok: true, usd: rc.usd, clamps: rc.clamps.map((q) => q.rule) } : { ok: false, refused: rc.refused };
      },
      blocked: entryBlocked,
    };
    ledger.add(now, 'approval_requested', { mint: c.mint, symbol: k.symbol, sessionId: prop.sessionId, usd: prop.usd, firstTrancheUsd: prop.firstTrancheUsd, profile: prof.id, price: prop.price, liq: prop.liq });
    say(`PROPOSAL ${k.symbol}: $${prop.usd} (${prop.pctOfBook}% of book) [${prof.id}] waiting for approval`);
    const settle = async (out: ApprovalOutcome) => {
      if (!out.approved) {
        ledger.add(now, 'approval_declined', { mint: c.mint, proposalId: out.proposalId ?? null, state: out.state, why: out.why });
        say(`PROPOSAL ${k.symbol} ${out.state}: ${out.why}`);
        await closeCandidate(c, `approval:${out.state}`);
        return;
      }
      const blocked = entryBlocked();
      if (blocked || c.closing || book.open.has(c.mint) || orders.some((q) => q.mint === c.mint)) {
        refuse('approval-dropped', { mint: c.mint, proposalId: out.proposalId, why: blocked ?? (c.closing ? 'candidate closed' : 'already open or pending') });
        if (!c.closing) await closeCandidate(c, 'refused:approval-dropped');
        return;
      }
      const usd = Math.min(out.usd, r.usd);
      const scale = r.usd > 0 ? usd / r.usd : 0;
      const t = latest.get(c.mint) ?? k;
      ledger.add(now, 'approval_granted', { mint: c.mint, proposalId: out.proposalId, via: out.via, usd, proofId: out.proofId ? `${out.proofId.slice(0, 6)}…` : null });
      say(`APPROVED ${k.symbol}: $${round2(usd)} via ${out.via}`);
      const ladder = (s.sizing.ladder ?? []).slice(1).map((tr) => ({ frac: tr.frac, atPct: tr.atPct, deadline: now + tr.withinMin * 60e3, usd: usd * tr.frac }));
      const first = round2(r.firstTrancheUsd * scale);
      orders.push({ mint: c.mint, fillAt: now + x.latencyMs, decidedPrice: t.price ?? 0, usd: first, firstUsd: first, profile: prof.id, sessionId: c.session?.id ?? null, trigger: c.matched, ladder, kind: 'open', ctx: { proofId: out.proofId, proposalId: out.proposalId, orderHash: out.orderHash } });
    };
    const pending = o.approvals.request(prop, live)
      .catch((e: unknown): ApprovalOutcome => ({ approved: false, state: 'ERROR', why: e instanceof Error ? e.message.slice(0, 120) : String(e) }))
      .then(settle)
      .finally(() => { approvalsOpen.delete(c.mint); });
    approvalsOpen.set(c.mint, pending);
    // Lockstep (backtests, tests) waits for the answer; every other pacing lets it land when it lands.
    if (pacing.mode === 'lockstep') await pending;
  };

  const onReply = async (c: Candidate, r: Reply | null) => {
    if (!c.session) return;
    if (c.closing) {
      // A reply that lands after its candidate expired or its session was closed is never executed.
      ledger.add(now, 'late_reply_ignored', { sessionId: c.session.id, mint: c.mint, decision: r?.decision ?? null });
      if (r) say(`  ← ${c.session.id} late reply ignored (candidate already closed)`);
      return;
    }
    const review = c.awaitingReview;
    c.awaitingReview = null;
    if (r) {
      c.turns++;
      gate.turn(r.costUsd - c.costSeen);
      c.costSeen = Math.max(c.costSeen, r.costUsd);
    }
    if (!r || !r.decision.ok) {
      const died = sessionDied(c);
      if (!r) ledger.add(now, 'session_timeout', { sessionId: c.session.id, mint: c.mint, ended: died });
      if (review) await noAnswer(review, !r ? (died ?? 'timeout') : 'invalid-decision');
      if (!r) {
        // A dead process (account mismatch, a tool list that is not empty, an exit) ends the session for good; a
        // slow candidate is skipped (onTimeout: skip); a slow review leaves the position to the monitor.
        if (died || !c.positionId || c.oneShot) await closeCandidate(c, died ?? (c.oneShot ? 'position-session-timeout' : 'timeout'));
        return;
      }
    }
    ledger.add(now, 'reply', { sessionId: c.session.id, mint: c.mint, ms: r.ms, costUsd: r.costUsd, text: o.verbose ? r.text : undefined, decision: r.decision });
    say(`  ← ${c.session.id} ${r.decision.ok ? `${r.decision.decision.action}${r.decision.decision.sizePct !== undefined ? ` ${r.decision.decision.sizePct}%` : ''}: ${r.decision.decision.reason}` : `INVALID (${r.decision.error})`}${r.ms ? ` · ${(r.ms / 1000).toFixed(1)}s` : ''} · $${r.costUsd.toFixed(4)}`);
    if (r.decision.ok) c.lastDecision = r.decision.decision.action;
    if (r.costUsd >= gate.caps.budgetUsdPerSession) { await closeCandidate(c, 'budget'); return; }
    if (r.decision.ok) await apply(c, r.decision.decision);
    // invalid decisions do nothing (the next delta asks again)
    if (c.closing) return;
    if (c.oneShot) { await closeCandidate(c, 'position-session-answered'); return; }
    const over = gate.overDay();
    if (over) await closeCandidate(c, over);
  };

  /** Queue a message; send now if the session is idle. Lockstep awaits the reply. */
  const post = async (c: Candidate, text: string) => {
    if (!c.session || c.closing) return;
    c.pendingText.push(text);
    if (c.inflight) return;
    const pump = async (): Promise<void> => {
      while (c.pendingText.length && !c.closing) {
        // Once the position is gone, only the final mechanical-exit notice is still worth a turn.
        if (c.positionId && !book.open.has(c.mint)) {
          c.pendingText = c.pendingText.filter((t) => t.includes('EVENT mechanical_exit'));
          if (!c.pendingText.length) break;
        }
        // Coalesce: everything that piled up while the agent was thinking goes as ONE message.
        const msg = [...c.pendingText.splice(0), ...c.notes.splice(0)].join('\n\n');
        ledger.add(now, 'message', { sessionId: c.session!.id, mint: c.mint, bytes: msg.length, text: o.verbose ? msg : undefined });
        if (o.verbose) say(`  → ${c.session!.id} ${msg.split('\n')[0]}`);
        const r = await c.session!.send(msg);
        await onReply(c, r);
      }
    };
    if (pacing.mode === 'lockstep') { await pump(); return; }
    const p = pump().finally(() => { c.inflight = null; pumps.delete(p); });
    c.inflight = p;
    pumps.add(p);
  };

  const fillOrders = async () => {
    for (let i = 0; i < orders.length; i++) {
      const q = orders[i];
      if (q.fillAt > now) continue;
      orders.splice(i--, 1);
      const k = latest.get(q.mint)!;
      // Re-check at the fill, like a swap's slippage tolerance: a pool that drained or a price that ran
      // away between the decision and the fill refuses the order instead of buying into it.
      const prof0 = s.exits.profiles[q.profile];
      const why = (k.liq ?? 0) < prof0.fit.minLiquidityUsd ? 'fill-liquidity-gone'
        : k.price && q.decidedPrice && k.price > q.decidedPrice * (1 + x.slippageBps / 1e4) ? 'fill-slippage'
        // task-1538: on a shared paper account another strategy may have spent the cash since this order was decided;
        // the cash is held before the (async) fill so two strategies can never spend the same dollars.
        : book.account && !book.account.hold(q.usd) ? 'fill-account-cash' : null;
      let f: Fill | { refused: string };
      try { f = why ? { refused: why } : await exec.buy(k, q.usd, q.ctx); } finally { if (!why && book.account) book.account.release(q.usd); }
      if ('refused' in f) {
        const rule = f.refused.startsWith('fill-') ? f.refused : `fill-${f.refused}`;
        refuse(rule, { mint: q.mint, decided: q.decidedPrice, price: k.price, liq: k.liq });
        const c = cands.get(q.mint);
        if (c && q.kind === 'open') { say(`ORDER REFUSED ${k.symbol}: ${rule}`); await closeCandidate(c, `refused:${rule}`); }
        continue;
      }
      if (q.kind === 'add') {
        const p = book.open.get(q.mint);
        if (!p || p.id !== q.positionId) continue;
        f.reason = 'ladder-add';
        const bookUsd = round4(book.bookEquity()); // task-1530: the book before the fill (the trade ledger's % of book)
        book.addTranche(p, f);
        ledger.add(now, 'fill', { positionId: p.id, mint: p.mint, ...fillMcaps(fillView(f), k), bookUsd, ...sigTag(f) });
        say(`ADD ${k.symbol}: $${f.usd.toFixed(2)} at ${lvl(f.price, k)}`);
        continue;
      }
      const prof = s.exits.profiles[q.profile];
      const bookUsd = round4(book.bookEquity()); // task-1530: the book before the fill (the trade ledger's % of book)
      const p = book.openPosition(k, f, prof, q.sessionId, q.trigger, q.ladder);
      ledger.add(now, 'fill', { positionId: p.id, mint: p.mint, profile: prof.id, ...fillMcaps(fillView(f), k), bookUsd, ...(q.ctx?.proposalId ? { proposalId: q.ctx.proposalId } : {}), ...sigTag(f) });
      say(`BUY ${k.symbol} [${prof.id}]: $${f.usd.toFixed(2)} at ${lvl(f.price, k)}${f.partial ? ' (PARTIAL: impact cap)' : ''} · liq $${Math.round(k.liq ?? 0)}`);
      const c = cands.get(q.mint);
      if (c) {
        c.positionId = p.id; byPosition.set(p.id, c);
        c.notes.push(`ENGINE: your entry filled: $${f.usd.toFixed(2)} at ${lvl(f.price, k)} (impact ${f.impactPct}%${f.partial ? ', PARTIAL at the impact cap' : ''}), profile ${prof.id}. The monitor runs the exits now; you hear from it only through EVENTs.`);
      }
    }
  };

  /** A review nobody answered: the profile decides (hold, or exit everything). Mechanical exits never wait. */
  const noAnswer = async (w: WakeEvent, why: string) => {
    const p = [...book.open.values()].find((q) => q.id === w.positionId);
    if (!p) return;
    const rule = s.exits.profiles[p.profileId].wake?.noAnswer ?? 'hold';
    ledger.add(now, 'no_answer', { positionId: p.id, event: w.event, why, rule });
    if (rule === 'exit') await sellPosition(p, latest.get(p.mint)!, p.tokens, `${w.event}:no-answer`, `${w.event} unanswered (${why}); the profile says exit`);
  };

  /** All wakes of one tick go to the session as ONE message (one turn), after the mechanical actions ran. */
  const wakeSession = async (p: Position, ws: WakeEvent[], k: MarketTick) => {
    if (!ws.length) return;
    let c = byPosition.get(p.id);
    for (const w of ws) {
      ledger.add(now, 'wake', { positionId: p.id, mint: p.mint, event: w.event, detail: w.detail, sessionId: c?.session?.id ?? null });
      say(`WAKE ${p.symbol} ${w.event}: ${w.detail}`);
    }
    const review = ws.find((w) => REVIEW.includes(w.event));
    const judgement = ws.some((w) => !INFO_ONLY.includes(w.event));
    let first: string | null = null;
    if ((!c?.session || c.closing) && judgement && s.agent.respawnOnWake && o.sessions && !decideAuto && !killed && p.status === 'open') {
      // §5: a wake for a position whose session has ended starts a one-answer position session.
      const g = gate.canOpen('position', liveCandidateSessions());
      if (!g.ok) refuse(g.reason, { stage: 'position-session', positionId: p.id, mint: p.mint });
      else {
        const sid = `p${++positionSessionsOpened}`;
        const session = o.sessions(sid, s, { kind: 'position', mint: p.mint });
        gate.opened('position');
        c = newCand(k, [], session, 'position', p.id);
        byPosition.set(p.id, c);
        ledger.add(now, 'session_start', { sessionId: sid, sessionKind: 'position', agent: session.kind, mint: p.mint, positionId: p.id, model: sessionModel(session, s), budgetUsd: gate.caps.budgetUsdPerSession });
        say(`POSITION SESSION ${sid} for ${p.symbol} (${ws.map((w) => w.event).join(', ')})`);
        first = renderPositionDossier({ symbol: p.symbol, mint: p.mint, profile: p.profileId, costUsd: p.costUsd, entryPrice: p.entryPrice, tpFilled: p.tpFilled, leftPct: p.origTokens ? (p.tokens / p.origTokens) * 100 : 0, costRecovered: !!p.costRecovered, history: (hist.get(p.mint) ?? []).filter((h) => h.t >= p.openedAt), basis, tick: p.lastTick });
      }
    }
    if (c?.session && !c.closing) {
      if (review) c.awaitingReview = review;
      const events = ws.map((w) => renderEvent(w, p, k, basis)).join('\n\n');
      await post(c, first ? `${first}\n\n${events}` : events);
    } else if (review) await noAnswer(review, 'no session');
  };

  const bounds = (): Bounds => ({ profiles: Object.keys(s.exits.profiles), defaultProfile: s.exits.default, maxSizePct: Math.min(s.sizing.maxPctOfBankroll, s.exits.profiles[s.exits.default].sizing.maxSizePctOfBankroll), sizeMode: s.sizing.mode, bankrollUsd: book.bookEquity(), cashUsd: book.state.cashUsd, openPositions: book.open.size, maxConcurrent: s.risk.maxConcurrent });

  const publishFocus = () => {
    if (!o.onFocus) return;
    const marks: FocusMark[] = [...[...book.open.keys()].map((mint) => ({ mint, role: 'held' as const })), ...[...cands.values()].filter((c) => !c.positionId).map((c) => ({ mint: c.mint, role: 'candidate' as const }))];
    const sig = marks.map((m) => `${m.role}:${m.mint}`).sort().join(',');
    if (sig === focusSig) return;
    focusSig = sig;
    o.onFocus(marks);
  };

  const liquidationMark = (p: Position): number => { const f = simSell(p.lastTick, p.tokens, x, 'mark'); return 'refused' in f ? 0 : f.usd; };
  const snapshot = (state: RunnerState['state']): RunnerState => {
    const live = everyLive().filter((c) => c.session && !c.closing);
    const day = gate.todayNow();
    return {
      t: now, state, haltReason: killed ? haltReason : book.state.halted ?? entriesPaused ?? gate.blocked,
      strategy: { id: s.id, version: s.version, hash: s.hash },
      book: { startUsd: s.bankroll.startUsd, equityUsd: round2(book.markedEquity()), cashUsd: round2(book.state.cashUsd), realizedTodayUsd: round2(book.state.dayRealizedUsd) },
      ...(book.account ? { account: { id: book.account.id, pnlUsd: round2(book.ownPnlUsd()) } } : {}),
      spend: { todayUsd: round4(day.modelUsd), dayCapUsd: gate.caps.modelUsdPerDay, turnsToday: day.turns, candidateSessionsToday: day.candidateSessions, positionSessionsToday: day.positionSessions, allowance: gate.allowance ? { fiveHour: gate.allowance.fiveHour, sevenDay: gate.allowance.sevenDay } : null },
      candidates: [...cands.values()].filter((c) => !c.positionId).map((c) => ({ mint: c.mint, symbol: c.symbol, ageSec: Math.round((now - c.since) / 1000), matched: c.matched, session: c.session?.id ?? null })),
      sessions: live.map((c) => ({ id: c.session!.id, kind: c.sessionKind, mint: c.mint, symbol: c.symbol, turns: c.turns, costUsd: round4(c.session!.costUsd()), budgetUsd: gate.caps.budgetUsdPerSession, lastDecision: c.lastDecision })),
      positions: [...book.open.values()].map((p) => {
        const pnl = liquidationMark(p) + p.realizedUsd - p.costUsd;
        return { mint: p.mint, symbol: p.symbol, profile: p.profileId, costUsd: round2(p.costUsd), pnlUsd: round2(pnl), pnlPct: p.costUsd ? Math.round((pnl / p.costUsd) * 1000) / 10 : 0, next: p.stuck ? 'stuck: retried every tick' : null, ...(p.costRecovered ? { freeBag: true } : {}), ...(o.real ? { confirm: o.real.confirmOf(p.mint) ?? 'unconfirmed' } : {}) };
      }),
      ledgerTail: ledger.events.slice(-12).map((e) => ({ seq: e.seq, t: e.t, kind: e.kind, text: tailText(e) })),
      ledgerHead: ledger.head(),
      events: ledger.events.length,
      ...(o.real ? { real: o.real.status() } : {}),
    };
  };

  const loop = tapeTicks ? fromArray(tapeTicks) : o.source!.ticks;
  for await (const k of loop) {
    now = k.t;

    const v = o.safety?.() ?? null;
    // task-1645: receipts land in the ledger as data; the real-mode kill switch halts like the panic file.
    const rs = o.real?.step() ?? null;
    for (const r of rs?.receipts ?? []) { const dv = (r as Receipt & { divergence?: unknown }).divergence; ledger.add(now, 'receipt', { tag: 'real-signal', nonce: r.nonce, signalId: r.signalId, status: r.status, fill: r.fill, reason: r.reason, executor: r.executor, ...(dv ? { divergence: dv } : {}) }); }
    const haltWhy = v?.halt ?? (o.killSwitch?.() ? 'kill-switch' : null) ?? rs?.halt ?? null;
    if (!killed && haltWhy) {
      killed = true;
      haltReason = haltWhy;
      book.state.halted = 'kill-switch';
      ledger.add(now, 'halt', { reason: haltWhy, ...(v?.detail ? { detail: v.detail } : {}), openPositions: book.open.size, droppedOrders: orders.length });
      say(`${haltWhy === 'kill-switch' ? 'KILL SWITCH' : haltWhy.toUpperCase()}: no new entries, sessions closed, orders dropped, mechanical exits keep running`);
      o.approvals?.cancelAll(haltWhy);
      for (const c of everyLive()) await closeCandidate(c, haltWhy);
      orders.length = 0;
    }
    if (v?.flatten && !flattening) {
      flattening = true;
      ledger.add(now, 'flatten', { positions: [...book.open.values()].map((p) => ({ positionId: p.id, mint: p.mint })) });
      say(`FLATTEN: every paper position sells at its next tick (${book.open.size} open)`);
    }
    if (v?.endWhenFlat) endWhenFlat = true;
    const paused = killed ? null : v?.pauseEntries ?? null;
    if (paused !== entriesPaused) {
      ledger.add(now, paused ? 'entries_paused' : 'entries_resumed', paused ? { reason: paused } : { after: entriesPaused });
      say(paused ? `ENTRIES PAUSED (${paused}): no new candidates; open positions keep their exits` : 'entries resumed');
      entriesPaused = paused;
      if (paused) o.approvals?.cancelAll(`paused:${paused}`);
    }
    // Orders due by now fill at the price AS OF their fill time: the newest row before this one (rows are
    // written on >= 5 % moves, so no new row means the price had not moved much). Then this row lands. On a
    // single-coin tape that row can be minutes later; the fill still uses the price as of its fill time.
    await fillOrders();
    latest.set(k.mint, k);
    const h = hist.get(k.mint) ?? [];
    h.push(k); if (h.length > 120) h.shift();
    hist.set(k.mint, h);
    const haltedBefore = book.state.halted;
    book.roll(now);
    if (book.state.halted && book.state.halted !== haltedBefore) { ledger.add(now, 'halt', { reason: book.state.halted }); o.approvals?.cancelAll(`halted:${book.state.halted}`); }

    // Held coin → the monitor (mechanical first, then wakes).
    const pos = book.open.get(k.mint);
    const chatSell = o.approvals?.takeExit?.(k.mint) ?? null;
    if (chatSell && !pos) o.approvals?.exitResult?.(chatSell.id, 'not-held');
    if (pos && chatSell && !flattening) {
      await sellPosition(pos, k, pos.tokens, 'chat-sell', `sell requested by ${chatSell.via}`);
      o.approvals?.exitResult?.(chatSell.id, pos.status === 'closed' ? 'sold' : pos.stuck ? 'stuck' : 'partial');
      if (pos.status === 'closed') {
        const c = byPosition.get(pos.id);
        if (c) { if (c.inflight) await c.inflight; await closeCandidate(c, 'position-closed'); }
      }
    } else if (pos && flattening) {
      // Flatten: the whole position at this tick; an unsellable one stays stuck and is retried every tick.
      await sellPosition(pos, k, pos.tokens, 'flatten', 'flatten requested');
      if (pos.status === 'closed') {
        const c = byPosition.get(pos.id);
        if (c) { if (c.inflight) await c.inflight; await closeCandidate(c, 'position-closed'); }
      }
    } else if (pos) {
      const prof0 = s.exits.profiles[pos.profileId];
      // task-1654: a real run's (or a paper scope's) maxHoldMinutes limit tightens the profile's holding cap (never loosens it).
      const holdCap = o.real?.maxHoldMinutes?.() ?? o.maxHoldMinutes?.() ?? null;
      const prof = holdCap !== null && (prof0.maxHoldMinutes == null || holdCap < prof0.maxHoldMinutes) ? { ...prof0, maxHoldMinutes: holdCap } : prof0;
      const acts = monitorTick(pos, prof, k, { minExitLiquidityUsd: x.minExitLiquidityUsd, sellUsd: (tok) => { const f = simSell(k, tok, x, 'estimate'); return 'refused' in f ? 0 : f.usd; } });
      const wakes: WakeEvent[] = [];
      for (const a of acts) {
        if (a.kind === 'sell') {
          if (pos.status !== 'open') break;
          await sellPosition(pos, k, a.tokens, a.reason, a.detail);
        } else if (a.kind === 'add') {
          if (killed || book.state.halted) continue;
          const room = Math.min(a.usd, book.state.cashUsd, (book.bookEquity() * s.risk.maxExposurePct) / 100 - book.exposureUsd());
          if (room < s.sizing.minUsd) { refuse('ladder-add-no-room', { positionId: pos.id }); continue; }
          ledger.add(now, 'ladder_trigger', { positionId: pos.id, detail: a.detail, usd: room });
          orders.push({ mint: k.mint, fillAt: now + x.latencyMs, decidedPrice: k.price ?? 0, usd: room, firstUsd: room, profile: pos.profileId, sessionId: pos.sessionId, trigger: [], ladder: [], kind: 'add', positionId: pos.id });
        } else wakes.push(a.wake);
      }
      await wakeSession(pos, wakes, k);
      if (pos.status === 'closed') {
        const c = byPosition.get(pos.id);
        if (c) { if (c.inflight) await c.inflight; await closeCandidate(c, 'position-closed'); }
      }
    } else {
      const c = cands.get(k.mint);
      if (c) {
        if (rules.screen(k).pass) c.lastMatch = now;
        if (now - c.lastMatch > s.entry.candidateTtlSec * 1000 && !orders.some((q) => q.mint === c.mint) && !approvalsOpen.has(c.mint)) await closeCandidate(c, 'candidate-ttl');
        else if (c.session && !c.positionId) {
          const cur = view(k);
          const due = (now - c.lastSentT) / 1000 >= s.agent.deltaEverySec || urgent(c.lastSent, cur);
          const d = due ? buildDelta(c.lastSent, cur, c.seq + 1, c.since) : null;
          if (d) { c.seq++; c.lastSent = cur; c.lastSentT = now; await post(c, renderDelta(d)); }
        }
      } else if (!killed && !entriesPaused && !book.state.halted && (skippedUntil.get(k.mint) ?? 0) <= now) {
        const sr = rules.screen(k);
        if (sr.pass) {
          // Cheap pre-check so a full book does not spawn sessions it could never act on.
          const pre = clampEntry(book, k, {}, killed);
          const v = pre.ok && o.vet && !vetted.has(k.mint) ? await vetCoin(k) : null;
          if (!pre.ok) { if (!['already-open'].includes(pre.refused)) count(`precheck:${pre.refused}`); }
          else if (v && !v.ok) { refuse(v.rule, { mint: k.mint, symbol: k.symbol, stage: 'vet', detail: v.detail }); skippedUntil.set(k.mint, Infinity); say(`SKIP ${k.symbol} (${k.mint.slice(0, 4)}…): ${v.rule} (${v.detail})`); }
          else if (decideAuto) {
            const cand = newCand(k, sr.matched, null, 'candidate', null);
            cands.set(k.mint, cand);
            ledger.add(now, 'candidate', { mint: k.mint, symbol: k.symbol, matched: sr.matched, tick: view(k) });
            await apply(cand, { action: 'enter', reason: 'auto' });
            if (!orders.some((q) => q.mint === k.mint) && !approvalsOpen.has(k.mint)) cands.delete(k.mint);
          } else {
            const g = gate.canOpen('candidate', liveCandidateSessions());
            if (!g.ok) count(g.reason);
            else {
              const sid = `s${++sessionsOpened}`;
              const session = o.sessions!(sid, s, { kind: 'candidate', mint: k.mint });
              gate.opened('candidate');
              const cand = newCand(k, sr.matched, session, 'candidate', null);
              cands.set(k.mint, cand);
              ledger.add(now, 'candidate', { mint: k.mint, symbol: k.symbol, matched: sr.matched, tick: view(k) });
              ledger.add(now, 'session_start', { sessionId: sid, sessionKind: 'candidate', agent: session.kind, mint: k.mint, model: sessionModel(session, s), budgetUsd: gate.caps.budgetUsdPerSession });
              say(`CANDIDATE ${k.symbol} (${k.mint.slice(0, 4)}…) matched ${sr.matched.join(', ')} → session ${sid} (${session.kind})`);
              const text = await dossierFn(k, h.slice(0, -1), sr.matched, bounds());
              await post(cand, text);
            }
          }
        }
      }
    }
    // Session lifetime: a position that closed by ANY path (monitor, agent exit, kill) ends its session;
    // any session ends at sessionMaxMin (a held position keeps its mechanical exits; respawnOnWake can reopen one).
    for (const c of everyLive()) {
      if (c.positionId && !book.open.has(c.mint)) { if (c.inflight) await c.inflight; await closeCandidate(c, 'position-closed'); continue; }
      if (c.session && now - c.since > s.agent.sessionMaxMin * 60e3) await closeCandidate(c, 'session-max-minutes');
    }
    publishFocus();

    const eq = book.markedEquity();
    if (!curve.length || curve[curve.length - 1].equity !== eq) curve.push({ t: now, equity: eq });
    maxDd = Math.max(maxDd, ((book.state.peakEquityUsd - eq) / book.state.peakEquityUsd) * 100);
    if (o.onState) o.onState(snapshot(killed || book.state.halted ? 'halted' : entriesPaused || gate.blocked || gate.paused() ? 'paused' : 'running'));
    // A stop or flatten ends the run once nothing is held and nothing is pending (the panic file alone keeps it up).
    if (killed && endWhenFlat && !book.open.size && !orders.length) { ledger.add(now, 'stopped_flat', { reason: haltReason }); say('nothing held: the runner stops'); break; }
    // Paced replays fast-forward while no session is live (nothing is waiting on the market).
    if (pacing.mode === 'paced' && everyLive().some((c) => c.session && !c.closing)) await sleep(pacing.msPerTick);
  }

  // End of the tape / source: open proposals are cancelled, replies in flight land, sessions close, what is still open is marked.
  if (approvalsOpen.size) { o.approvals?.cancelAll(o.tape ? 'end-of-tape' : 'runner-stopped'); await Promise.allSettled([...approvalsOpen.values()]); }
  for (const c of everyLive()) { if (c.inflight) await c.inflight; await closeCandidate(c, o.tape ? 'end-of-tape' : 'runner-stopped'); }
  while (pumps.size) await Promise.allSettled([...pumps]);
  const openAtEnd = [...book.open.values()].map((p) => ({ mint: p.mint, symbol: p.symbol, markUsd: round2(liquidationMark(p)), costUsd: p.costUsd, stuck: p.stuck }));
  if (o.real) {
    // The dead-man's graceful half: the executor hears the run is over (its outstanding nonces may be cancelled).
    const why = killed ? `halt:${haltReason ?? 'kill'}` : o.tape ? 'end-of-tape' : 'runner-stopped';
    // r2: what is still open is carried (held.json): the next real run of this strategy adopts it and keeps its exits.
    o.real.carry([...book.open.values()]);
    o.real.sendHalted(why);
    ledger.add(now, 'real_halted', { tag: 'real-signal', reason: why, openAtEnd: openAtEnd.length });
  }
  ledger.add(now, 'run_end', { trades: book.closed.length, openAtEnd: openAtEnd.length, cashUsd: book.state.cashUsd, markedEquityUsd: book.markedEquity(), sessionCostUsd: sessionCost, sessions: sessionsOpened, positionSessions: positionSessionsOpened, head: ledger.head() });
  publishFocus();
  if (o.onState) o.onState(snapshot('stopped'));
  return { trades: book.closed, openAtEnd, ledger, book, candidates: ledger.events.filter((e) => e.kind === 'candidate').length, sessions: sessionsOpened + positionSessionsOpened, sessionCostUsd: sessionCost, maxDrawdownPct: Math.round(maxDd * 100) / 100, equityCurve: curve, refusals, clamps: clampCount };
}

const round2 = (v: number) => Math.round(v * 100) / 100;
/** The exit plan of a profile in one line, for a proposal (engine state only). */
export function exitPlanLine(p: import('./strategy.ts').ExitProfile): string {
  const parts: string[] = [];
  if (p.costRecovery) parts.push(`cost back at +${p.costRecovery.atPct}%`);
  if (p.bagTrail) parts.push(`then a ${p.bagTrail.trailPct}% bag trail`);
  if (p.tpLadder.length) parts.push(`take profit ${p.tpLadder.map((t) => `+${t.atPct}%`).join(', ')}`);
  if (p.trailingStop) parts.push(`${p.trailingStop.trailPct}% trail from +${p.trailingStop.armAtPct}%`);
  if (p.maxHoldMinutes) { const m = p.maxHoldMinutes; parts.push(`out after ${m >= 2880 ? `${Math.round(m / 1440)} days` : m >= 120 ? `${Math.round(m / 60)} h` : `${m} min`}`); }
  parts.push(p.hardStop.enabled && p.hardStop.atPct !== null ? `stop ${p.hardStop.atPct}%` : 'no hard stop');
  return `${p.id}: ${parts.join(', ')}`;
}
const round4 = (v: number) => Math.round(v * 1e4) / 1e4;
/** task-1645: a fill that went out as a trade-fire signal: the ledger row is tagged and names the signal. */
const sigTag = (f: Fill): Record<string, unknown> => { const x = f as Fill & { signal?: { nonce: number; id: string }; limitClamps?: string[] }; const g = x.signal; return g ? { tag: 'real-signal', nonce: g.nonce, signalId: g.id, ...(x.limitClamps?.length ? { limitClamps: x.limitClamps } : {}) } : {}; };
const fillView = (f: Fill) => ({ side: f.side, usd: f.usd, tokens: Number(f.tokens.toPrecision(8)), price: f.price, avgPrice: f.avgPrice, impactPct: f.impactPct, partial: f.partial, reason: f.reason });
/** Infinity (no runner cap) is written as null so the ledger stays JSON. */
/** The model a session actually runs (a run's --model override wins over the strategy's), for the ledger. */
// task-1543: any model-backed session (claude, ollama) records the model it runs; only the stub has none.
const sessionModel = (x: AgentSession, s: ResolvedStrategy): string => (x.kind === 'stub' ? 'stub' : (x as Partial<CliSession>).model ?? s.agent.model);
const capsView = (g: SessionGate) => Object.fromEntries(Object.entries(g.caps).map(([k, v]) => [k, Number.isFinite(v) ? v : null]));

/** One short line per ledger event for the runner view (no message text: that stays in the ledger). */
function tailText(e: Record<string, unknown>): string {
  const pick = (...ks: string[]) => ks.map((k) => (e[k] === undefined || e[k] === null ? null : `${k} ${typeof e[k] === 'object' ? JSON.stringify(e[k]).slice(0, 60) : String(e[k]).slice(0, 60)}`)).filter(Boolean).join(' · ');
  switch (e.kind) {
    case 'candidate': return pick('symbol', 'matched');
    case 'session_start': case 'session_end': return pick('sessionId', 'sessionKind', 'reason', 'turns', 'costUsd');
    case 'reply': {
      const d = e.decision as { ok: boolean; decision?: { action: string; reason: string }; error?: string } | undefined;
      return `${String(e.sessionId)} ${d?.ok ? `${d.decision!.action}: ${d.decision!.reason.slice(0, 80)}` : `invalid: ${d?.error ?? '?'}`}`;
    }
    case 'fill': return pick('side', 'usd', 'price', 'reason');
    case 'refused': return pick('rule', 'stage');
    case 'wake': return pick('event', 'detail');
    default: return pick('reason', 'mint', 'rule');
  }
}

// ───────────────────────────── host: lock, rendezvous, heartbeat ─────────────────────────────
//
// One runner per machine: $DEXTERM_HOME/autotrade/run.lock holds {pid, bootAt, runId, startedAt}. A lock whose pid is
// gone, or that was written before this boot, is stale and reclaimed; a live one refuses the second runner.
// The TUI's runner view and the monitor's dead-man read the rendezvous, rewritten (atomic) every 10 s and on change.

export const RUNNER_RENDEZVOUS_SCHEMA = 'dexterm-autotrade-runner/1';
export const HEARTBEAT_MS = 10_000;
export const runLockPath = (home: string): string => join(home, 'autotrade', 'run.lock');
/** The rendezvous (`dexterm-autotrade-runner/1`); runner.json next to it is the runner CONFIG (§7.3). */
export const runnerRendezvousPath = (home: string): string => join(home, 'autotrade', 'runner-status.json');

export interface RunLock { pid: number; bootAt: number; runId: string; startedAt: number }

const bootAt = (): number => Math.round((Date.now() - uptime() * 1000) / 60_000) * 60_000;
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };

export type LockResult = { ok: true; lock: RunLock; reclaimed: RunLock | null } | { ok: false; holder: RunLock };

export function acquireRunLock(home: string, runId: string, now = Date.now()): LockResult {
  const path = runLockPath(home);
  mkdirSync(join(home, 'autotrade'), { recursive: true, mode: 0o700 });
  const lock: RunLock = { pid: process.pid, bootAt: bootAt(), runId, startedAt: now };
  let reclaimed: RunLock | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeSync(fd, `${JSON.stringify(lock)}\n`);
      closeSync(fd);
      return { ok: true, lock, reclaimed };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    let held: RunLock | null = null;
    try { held = JSON.parse(readFileSync(path, 'utf8')) as RunLock; } catch { held = null; }
    const stale = !held || typeof held.pid !== 'number' || !alive(held.pid) || Math.abs((held.bootAt ?? 0) - lock.bootAt) > 5 * 60_000;
    if (!stale) return { ok: false, holder: held! };
    reclaimed = held;
    rmSync(path, { force: true });
  }
  throw new Error(`could not take ${path}`);
}

export function releaseRunLock(home: string, runId: string): void {
  const path = runLockPath(home);
  try { const held = JSON.parse(readFileSync(path, 'utf8')) as RunLock; if (held.runId === runId && held.pid === process.pid) rmSync(path, { force: true }); } catch { /* gone */ }
}

export interface RunnerRendezvous extends Omit<RunnerState, 't'> { schema: typeof RUNNER_RENDEZVOUS_SCHEMA; pid: number; mode: 'paper' | 'real' | 'devnet' | 'live'; runId: string; startedAt: number; heartbeatAt: number; ledgerPath: string }

export function writeRendezvous(home: string, r: RunnerRendezvous): void {
  mkdirSync(join(home, 'autotrade'), { recursive: true, mode: 0o700 });
  writeJsonAtomic(runnerRendezvousPath(home), r);
}

/** Age of the runner's heartbeat in ms (Infinity when there is none): the monitor refuses entries on a stale one. */
export function runnerHeartbeatAge(home: string, now = Date.now()): number {
  const p = runnerRendezvousPath(home);
  if (!existsSync(p)) return Infinity;
  try { const d = JSON.parse(readFileSync(p, 'utf8')) as { heartbeatAt?: number; state?: string }; return d.state === 'stopped' || typeof d.heartbeatAt !== 'number' ? Infinity : now - d.heartbeatAt; } catch { return Infinity; }
}
