// dexterm autotrade — real mode (task-1645, 0.2.0 card A). dexterm still holds NO key and signs nothing.
//
// A strategy runs real only when ALL of these hold, checked by the runner before its first tick:
//   1. its document says `mode: "real"` (import, `new` and every model proposal force or keep paper: `/mode` is on
//      the model deny-list)
//   2. $DEXTERM_HOME/autotrade/real/arming.json arms that strategy id AT THAT HASH (any edit to the strategy, by
//      anyone, changes the hash and voids the arming). Arming is `dexterm autotrade signal arm <id>`: a real terminal
//      only, the evidence panel (backtest, forward test, caps, channels), a typed phrase with a one-time code, and a
//      journal line. No MCP tool, no decision verb, no chat command can arm.
//   3. the global real-mode kill switch is off ($DEXTERM_HOME/autotrade/real/kill.json; unreadable = engaged)
//   4. the hard caps file exists ($DEXTERM_HOME/autotrade/real/caps.json): per-trade SOL, daily SOL, buys per day,
//      open positions. Raising any cap needs the typed confirmation; lowering does not.
//   5. at least one channel an executor can read is set up (webhook, command hook, JSONL stream, MCP feed)
//
// Then RealSignalExecutor wraps the run's paper executor: every fill of the paper model (the monitor's own view, so
// clamps, exits, monitor and ledger are exactly those of paper) is first written to the outbox as a trade-fire
// signal, and only then booked. A buy over a cap is clamped to the per-trade cap, or refused at the daily caps; a
// signal that cannot be written is a refused order (the book never holds what no signal announced). With the kill
// switch on, no signal of any kind goes out except one final `halted`.
//
// Receipts (receipts.ts) move a position from `unconfirmed` to executed / rejected / failed; they are data and
// never trigger an order. The dead-man: every signal carries a TTL; a run that ends (or halts) sends `halted`
// listing its outstanding nonces; a run that died without one gets it from the next outbox open (`deadManSweep`).

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { Fill, Position } from './engine.ts';
import type { MarketTick } from './replay.ts';
import type { Executor, OrderContext } from './runner.ts';
import { strategyHash, type ResolvedStrategy } from './strategy.ts';
import { writeJsonAtomic } from './ledger.ts';
import { localDay } from './chat/audit.ts';
import { allOutboxSignals, EXECUTOR_CHANNELS, Outbox, realDir, type ChannelHealth, type ChannelName } from './outbox.ts';
import { ACCOUNT_ID_RE, buildHaltedSignal, buildTradeSignal, clampTtl, type SignalHeader, type TradeFireSignal, type TradeInput } from './signal.ts';
import { ReceiptsTail, divergenceOf, readReceipts, type ConfirmState, type Divergence, type Receipt } from './receipts.ts';
import {
  DEFAULT_LIMITS, buyPause, checkBuy, checkSell, effectiveLimits, emptyLimits, limitField, limitsForRealRun, limitsStamp, loadLimits, loadRiskState, planLimitsSave, raises, recordBuy, recordSell, saveLimits, saveRiskState,
  strictestOf, type EffectiveLimits, type LimitsDoc, type LimitsPlan, type RiskState,
} from './limits.ts';
import { executorHealth, type ExecutorHealth } from './executor-health.ts';

export const ARMING_SCHEMA = 'dexterm-real-arming/1';
export const CAPS_SCHEMA = 'dexterm-real-caps/1';

export const armingPath = (home: string): string => join(realDir(home), 'arming.json');
/** card A's caps file: read once and migrated into limits.json (limits.ts). */
export const capsPath = (home: string): string => join(realDir(home), 'caps.json');
export const killPath = (home: string): string => join(realDir(home), 'kill.json');
export const realJournalPath = (home: string): string => join(realDir(home), 'journal.jsonl');

// ───────────────────────────── journal ─────────────────────────────

export interface RealJournalLine { t: number; action: string; by: 'local-terminal' | 'runner' | 'cli'; data: Record<string, unknown> }

export function journalReal(home: string, line: RealJournalLine): void {
  mkdirSync(realDir(home), { recursive: true, mode: 0o700 });
  appendFileSync(realJournalPath(home), `${JSON.stringify(line)}\n`, { mode: 0o600 });
}

export function readRealJournal(home: string): RealJournalLine[] {
  if (!existsSync(realJournalPath(home))) return [];
  return readFileSync(realJournalPath(home), 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as RealJournalLine]; } catch { return []; } });
}

// ───────────────────────────── caps (card A's view of the limits) ─────────────────────────────
//
// task-1654: the caps are now four of the limits in limits.ts (`global` scope). This API stays for `signal caps`,
// the arming record and older callers; limits.json is the one file (card A's caps.json is migrated on first read).

export interface RealCaps { perTradeSol: number; dailySol: number; buysPerDay: number; maxOpenPositions: number }
/** The placeholder defaults (limits.ts DEFAULT_LIMITS): arming asks for your own numbers first. */
export const DEFAULT_REAL_CAPS: RealCaps = { perTradeSol: DEFAULT_LIMITS.perTradeSol!, dailySol: DEFAULT_LIMITS.dailySol!, buysPerDay: DEFAULT_LIMITS.buysPerDay!, maxOpenPositions: DEFAULT_LIMITS.maxOpenPositions! };
const CAP_KEYS = ['perTradeSol', 'dailySol', 'buysPerDay', 'maxOpenPositions'] as const;

export function capsProblem(c: Partial<RealCaps>): string | null {
  for (const k of CAP_KEYS) {
    const f = limitField(k)!;
    const v = c[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < f.lo || v > f.hi) return `${k} must be a number from ${f.lo} up (${f.unit})`;
    if (f.int && !Number.isInteger(v)) return `${k} must be a whole number`;
  }
  if (c.dailySol! < c.perTradeSol!) return 'dailySol must be at least perTradeSol';
  return null;
}

/** The four caps as the effective `global` values (Infinity when a limit is turned off). */
export function capsOfValues(v: EffectiveLimits['values']): RealCaps {
  return { perTradeSol: v.perTradeSol ?? Infinity, dailySol: v.dailySol ?? Infinity, buysPerDay: v.buysPerDay ?? Infinity, maxOpenPositions: v.maxOpenPositions ?? Infinity };
}

export function loadCaps(home: string): { ok: true; caps: RealCaps } | { ok: false; why: string } {
  const l = loadLimits(home);
  if (!l.ok) return { ok: false, why: l.missing ? 'no real-mode limits are set (dexterm autotrade limits set …, or arm a strategy: it asks for your numbers)' : l.why };
  return { ok: true, caps: capsOfValues(effectiveLimits(l.doc, { strategyId: '-', accountId: '-', mode: 'real' }).values) };
}

/** Which caps the new set raises (needs the typed local confirmation). */
export function capsRaised(before: RealCaps | null, after: RealCaps): (keyof RealCaps)[] {
  if (!before) return Object.keys(after) as (keyof RealCaps)[];
  return (Object.keys(after) as (keyof RealCaps)[]).filter((k) => after[k] > before[k]);
}

/** The limits document `signal caps set` would save: the four caps into the file's `global` (the rest as it is). */
function capsDoc(home: string, next: RealCaps): LimitsDoc {
  const cur = loadLimits(home);
  const doc: LimitsDoc = cur.ok ? structuredClone(cur.doc) : emptyLimits();
  for (const k of CAP_KEYS) doc.global[k] = next[k];
  delete doc.migratedFrom;
  return doc;
}

/**
 * task-1654 r3 (verify F2): what `signal caps set` would save, against dexterm's last journaled save, so any hand
 * edit of limits.json that raises something (in any scope) is shown and confirmed with the caps, never carried along.
 */
export function planCaps(home: string, next: RealCaps): LimitsPlan | { error: string } {
  const p = capsProblem(next);
  return p ? { error: p } : planLimitsSave(home, capsDoc(home, next));
}

/** `signal caps set`: `confirmed` is the list of raises (planCaps) the user typed the phrase for. */
export function saveCaps(home: string, next: RealCaps, o: { confirmed: readonly string[]; baseline?: string; now?: number }): { ok: true; raised: string[] } | { ok: false; why: string } {
  const p = capsProblem(next);
  if (p) return { ok: false, why: p };
  const r = saveLimits(home, capsDoc(home, next), { confirmed: o.confirmed, baseline: o.baseline, action: 'caps-set', now: o.now });
  if (!r.ok) {
    const up = raises(r.changes ?? []).filter((c) => !o.confirmed.includes(`${c.scope}.${c.key}`)).map((c) => (c.scope === 'global' ? String(c.key) : `${c.scope}.${c.key}`));
    return { ok: false, why: up.length && !r.issues ? `raising ${up.join(', ')} needs the typed confirmation on a real terminal` : r.why };
  }
  return { ok: true, raised: raises(r.changes).map((c) => String(c.key)) };
}

// ───────────────────────────── kill switch ─────────────────────────────

/** null = off. A kill file that cannot be read counts as engaged (fail closed). */
export function realKill(home: string): { reason: string; at: number } | null {
  const p = killPath(home);
  if (!existsSync(p)) return null;
  try { const d = JSON.parse(readFileSync(p, 'utf8')) as { reason?: string; at?: number }; return { reason: String(d.reason ?? 'kill').slice(0, 80), at: Number(d.at) || 0 }; } catch { return { reason: 'kill file unreadable', at: 0 }; }
}

export function engageRealKill(home: string, reason: string, by: RealJournalLine['by'] = 'cli', now = Date.now()): void {
  mkdirSync(realDir(home), { recursive: true, mode: 0o700 });
  writeJsonAtomic(killPath(home), { reason: reason.slice(0, 80), at: now, by });
  journalReal(home, { t: now, action: 'kill', by, data: { reason: reason.slice(0, 80) } });
}

/** Lifting the kill switch needs the typed confirmation (the CLI asks on a real terminal). */
export function releaseRealKill(home: string, o: { confirmed: boolean; now?: number }): { ok: true } | { ok: false; why: string } {
  if (!o.confirmed) return { ok: false, why: 'lifting the real-mode kill switch needs the typed confirmation on a real terminal' };
  rmSync(killPath(home), { force: true });
  journalReal(home, { t: o.now ?? Date.now(), action: 'unkill', by: 'local-terminal', data: {} });
  return { ok: true };
}

// ───────────────────────────── arming ─────────────────────────────

export interface Arming {
  strategyId: string;
  /** The hash of the strategy document in mode "real": any later edit voids the arming. */
  strategyHash: string;
  version: string;
  accountId: string;
  armedAt: number;
  caps: RealCaps;
  /** task-1654: the effective limits shown at arming and confirmed by the typed phrase (absent on card A armings). */
  limits?: EffectiveLimits['values'];
  limitsHash?: string;
  channels: ChannelName[];
  evidence: string[];
  /** How it was confirmed: always a typed phrase on a real terminal. The code itself is not stored. */
  confirmation: { method: 'typed-tty'; codeHash: string };
  /**
   * task-1679: armed below the evidence floor or past a missing rung of the ladder, by the user's typed OVERRIDE
   * phrase (a separate one-time code; also journaled as `evidence-override`). Absent when nothing was overridden.
   */
  override?: { skipsLadder: string | null; floor: string[]; minTrades: number; codeHash: string };
}

interface ArmingFile { schema: typeof ARMING_SCHEMA; armed: Record<string, Arming> }

export function loadArmings(home: string): Record<string, Arming> {
  if (!existsSync(armingPath(home))) return {};
  try {
    const d = JSON.parse(readFileSync(armingPath(home), 'utf8')) as ArmingFile;
    return d.schema === ARMING_SCHEMA && d.armed && typeof d.armed === 'object' ? d.armed : {};
  } catch { return {}; }
}

export function saveArming(home: string, a: Arming): void {
  if (!ACCOUNT_ID_RE.test(a.accountId)) throw new Error('account id: lowercase letters, digits, - and _ (32 max)');
  const all = loadArmings(home);
  all[a.strategyId] = a;
  mkdirSync(realDir(home), { recursive: true, mode: 0o700 });
  writeJsonAtomic(armingPath(home), { schema: ARMING_SCHEMA, armed: all });
  journalReal(home, { t: a.armedAt, action: 'arm', by: 'local-terminal', data: { strategyId: a.strategyId, strategyHash: a.strategyHash, version: a.version, accountId: a.accountId, caps: a.caps, channels: a.channels } });
}

export function disarm(home: string, id: string, reason: string, now = Date.now()): boolean {
  const all = loadArmings(home);
  if (!all[id]) return false;
  delete all[id];
  writeJsonAtomic(armingPath(home), { schema: ARMING_SCHEMA, armed: all });
  journalReal(home, { t: now, action: 'disarm', by: 'cli', data: { strategyId: id, reason: reason.slice(0, 80) } });
  return true;
}

/** A one-time code for the typed confirmation (like the mandate ConfirmGate's challenge code: a recording cannot be replayed). */
export function newChallenge(rng: () => Buffer = () => randomBytes(4)): string {
  return [...rng()].map((b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('').slice(0, 4);
}
export const confirmPhrase = (action: string, id: string, code: string): string => `${action} ${id} ${code}`;
export const phraseMatches = (typed: string, action: string, id: string, code: string): boolean => typed.trim() === confirmPhrase(action, id, code);
export const codeHash = (code: string): string => strategyHash({ confirm: code }).slice(0, 16);

/** The strategy as it would be in paper mode: its backtests were run under this hash. */
export const paperTwinHash = (s: ResolvedStrategy): string => strategyHash({ ...s, mode: 'paper' });

export type RealCheck = { ok: true; arming: Arming; caps: RealCaps; /** task-1654: the effective limits for this strategy + account. */ limits: EffectiveLimits } | { ok: false; why: string };

/** Everything the runner checks before a real run's first tick (and the CLI before it takes the run lock). */
export function realModeCheck(home: string, s: ResolvedStrategy, channels: ChannelName[]): RealCheck {
  if (s.mode !== 'real') return { ok: false, why: `strategy ${s.id} is mode "${s.mode}", not "real"` };
  const a = loadArmings(home)[s.id];
  if (!a) return { ok: false, why: `strategy ${s.id} is not armed for real mode (dexterm autotrade signal arm ${s.id}, on your own terminal)` };
  if (a.strategyHash !== s.hash) return { ok: false, why: `strategy ${s.id} changed since it was armed (hash ${s.hash.slice(0, 8)} vs armed ${a.strategyHash.slice(0, 8)}): arm it again` };
  const k = realKill(home);
  if (k) return { ok: false, why: `the real-mode kill switch is on (${k.reason}); lift it with dexterm autotrade signal unkill on your own terminal` };
  // task-1654: the limits file (no silent defaults: it exists because you saved your numbers or armed with them); a
  // file changed outside dexterm that raises anything is refused here.
  const l = limitsForRealRun(home);
  if (!l.ok) return { ok: false, why: l.why };
  if (!channels.some((n) => EXECUTOR_CHANNELS.includes(n))) return { ok: false, why: 'no channel your executor can read is set up (webhook, signal-cmd, jsonl or mcp); the Telegram copy alone is not enough because a bot cannot read another bot' };
  const limits = effectiveLimits(l.doc, { strategyId: s.id, accountId: a.accountId, mode: 'real' });
  return { ok: true, arming: a, caps: capsOfValues(limits.values), limits };
}

// ───────────────────────────── holdings (r2) ─────────────────────────────
//
// What dexterm counts as held for real, across runs: $DEXTERM_HOME/autotrade/real/held.json, rewritten atomically on
// every buy and sell signal and at a run's end (then with the book's view of each position, so its exits resume
// where they were). It is separate from the outbox, so compaction cannot lose it. A missing or unreadable file is
// rebuilt from every outbox file on the home (live + compacted archives) - never treated as "nothing held".
//
// Rules it carries: the open-position cap counts every holding on the home; a mint held by another strategy or
// account is not bought again; the next real run of the same strategy + account takes its holdings over (exits keep
// firing); `halted` lists them in `open`. Only a sell signal, or `signal release` (typed, on a real terminal), ends one.

export const HELD_SCHEMA = 'dexterm-real-held/1';
export const heldPath = (home: string): string => join(realDir(home), 'held.json');

export interface RealHolding {
  mint: string;
  symbol: string;
  strategyId: string;
  accountId: string;
  /** The run that last signalled on it. */
  runId: string;
  /** The newest buy signal on it (the confirmation state follows that nonce's receipt). */
  nonce: number;
  tokens: number;
  costUsd: number;
  realizedUsd: number;
  /** task-1654: the cost basis already sold (partial exits), for the realized PnL behind the loss limits. */
  costOutUsd?: number;
  entryPrice: number;
  openedAt: number;
  at: number;
  /** The book's view of the position at its run's last end; absent after a crash (rebuilt from the fills then). */
  position?: Position;
}

export function loadHoldings(home: string): { holdings: Record<string, RealHolding>; source: 'file' | 'rebuilt' } {
  const p = heldPath(home);
  if (existsSync(p)) {
    try {
      const d = JSON.parse(readFileSync(p, 'utf8')) as { schema?: string; holdings?: Record<string, RealHolding> };
      if (d.schema === HELD_SCHEMA && d.holdings && typeof d.holdings === 'object') return { holdings: d.holdings, source: 'file' };
    } catch { /* rebuilt below */ }
  }
  return { holdings: holdingsFromSignals(allOutboxSignals(home)), source: 'rebuilt' };
}

export function saveHoldings(home: string, holdings: Record<string, RealHolding>, now = Date.now()): void {
  mkdirSync(realDir(home), { recursive: true, mode: 0o700 });
  writeJsonAtomic(heldPath(home), { schema: HELD_SCHEMA, updatedAt: now, holdings });
}

/** Replay trade signals (oldest first) into holdings: buys add, sells take their fraction, a full sell ends one. */
export function holdingsFromSignals(signals: TradeFireSignal[]): Record<string, RealHolding> {
  const out: Record<string, RealHolding> = {};
  for (const s of [...signals].sort((a, b) => a.nonce - b.nonce)) {
    if (s.type !== 'trade') continue;
    const h = out[s.mint];
    const px = s.price.usd ?? 0;
    if (s.side === 'buy') {
      const tokens = px > 0 ? s.sizeUsd / px : 0;
      if (h) { h.entryPrice = h.tokens + tokens > 0 ? (h.entryPrice * h.tokens + px * tokens) / (h.tokens + tokens) : px; h.tokens += tokens; h.costUsd += s.sizeUsd; h.nonce = s.nonce; h.runId = s.runId; h.at = s.issuedAt; }
      else out[s.mint] = { mint: s.mint, symbol: s.symbol, strategyId: s.strategy.id, accountId: s.accountId, runId: s.runId, nonce: s.nonce, tokens, costUsd: s.sizeUsd, realizedUsd: 0, entryPrice: px, openedAt: s.issuedAt, at: s.issuedAt };
    } else if (h) {
      const frac = s.sellFraction ?? 1;
      if (frac >= 0.999) { delete out[s.mint]; continue; }
      h.tokens *= 1 - frac; h.realizedUsd += s.sizeUsd; h.runId = s.runId; h.at = s.issuedAt;
    }
  }
  return out;
}

/** A placeholder tick at the last known price, until the live feed sends a real one. */
function placeholderTick(mint: string, symbol: string, t: number, price: number): MarketTick {
  return {
    mint, t, kind: 'live', symbol, launchpad: 'unknown' as MarketTick['launchpad'], createdAt: null, price, mcap: null, mcapResolved: null, mcapFlagged: false,
    liq: null, vol5m: null, vol1h: null, vol24: null, buys5m: null, sells5m: null, buys24: null, sells24: null,
    chg5m: null, chg1h: null, chg6h: null, chg24h: null, holders: null, top10: null, dev: null, mintAuth: null, freezeAuth: null, org: null,
  } as MarketTick;
}

/**
 * The position a run takes over. From the book's saved view when there is one (no unfilled ladder tranche: nothing is
 * added after a restart), else rebuilt from the signals (entry = average signal price, peak = entry).
 */
export function positionOfHolding(h: RealHolding, defaultProfile: string): Position {
  if (h.position) return { ...h.position, tokens: h.tokens, ladder: [], sessionId: null, wakeSent: {}, status: 'open', closedAt: null, exitReason: null };
  return {
    id: `real-${h.nonce}`, mint: h.mint, symbol: h.symbol, profileId: defaultProfile, openedAt: h.openedAt, sessionId: null,
    tokens: h.tokens, origTokens: h.tokens, costUsd: h.costUsd, realizedUsd: h.realizedUsd, entryPrice: h.entryPrice, peakPrice: h.entryPrice, troughPrice: h.entryPrice,
    tpFilled: 0, trailArmed: false, ladder: [], fills: [], status: 'open', stuck: false, closedAt: null, exitReason: null,
    liqWindow: [], lowTapeSince: null, lastTick: placeholderTick(h.mint, h.symbol, h.at, h.entryPrice), wakeSent: {},
  };
}

/** `signal release <mint>`: forget a holding the user closed by hand. Typed confirmation only; journaled. */
export function releaseHolding(home: string, mint: string, o: { confirmed: boolean; now?: number }): { ok: true; holding: RealHolding } | { ok: false; why: string } {
  if (!o.confirmed) return { ok: false, why: 'releasing a real holding needs the typed confirmation on a real terminal (it frees room under the open-position cap)' };
  const { holdings } = loadHoldings(home);
  const h = holdings[mint];
  if (!h) return { ok: false, why: `no real holding on ${mint}` };
  delete holdings[mint];
  saveHoldings(home, holdings, o.now);
  journalReal(home, { t: o.now ?? Date.now(), action: 'release-holding', by: 'local-terminal', data: { mint, symbol: h.symbol, strategyId: h.strategyId, accountId: h.accountId, nonce: h.nonce } });
  return { ok: true, holding: h };
}

// ───────────────────────────── the executor ─────────────────────────────

export interface RealStatus {
  mode: 'real';
  accountId: string;
  killed: string | null;
  caps: RealCaps;
  /** task-1654: the limits in force right now (the stricter of the run's start and the file now). */
  limits: EffectiveLimits['values'];
  day: { day: string; buySol: number; buys: number };
  /** task-1654: the risk state behind the limits (modelled fills) and why new buys are paused, if they are. */
  risk: { dayPnlSol: number; cumPnlSol: number; lossStreak: number; pausedUntil: number | null; breaker: RiskState['breaker']; buyPause: string | null };
  /** task-1654: executor health (heartbeat, receipts, acks) and the silence pause. */
  executor: ExecutorHealth;
  outboxDepth: number;
  lastNonce: number;
  channels: ChannelHealth[];
  /** Positions by mint and their confirmation state (unconfirmed until a receipt arrives). */
  positions: { mint: string; symbol: string; state: ConfirmState; nonce: number; /** r2: held by another strategy (counts against the cap; not traded by this run). */ heldBy?: string }[];
  receipts: { total: number; invalid: number; orphan: number };
}

export interface RealExecutorOpts {
  home: string;
  inner: Executor;
  outbox: Outbox;
  strategy: ResolvedStrategy;
  arming: Arming;
  caps: RealCaps;
  /**
   * task-1654: the effective limits at the run's start (realModeCheck). With them the executor enforces every limit
   * and re-reads limits.json when it changes (the stricter wins, so a lower applies at once and a raise only next
   * run). Without them (card A callers) only the four caps apply.
   */
  limits?: EffectiveLimits['values'];
  /** task-1654: a line for the run log and Telegram (executor silent / back, a risk limit tripped). */
  notify?: (line: string) => void;
  runId: string;
  ttlSec: number;
  /** SOL/USD now; null = unknown, and then every order is refused (no size can be stated in SOL). */
  solUsd: () => number | null;
  /** The strategy's book equity (USD) for % of book. */
  bookUsd: () => number;
  now?: () => number;
}

/** A fill that went out as a signal carries its nonce and id; the runner tags its ledger rows `real-signal`. */
export type SignalledFill = Fill & { signal?: { nonce: number; id: string } };

/** task-1654: a receipt the run turned into a ledger row, with what it says about paper-vs-real (receipts.ts). */
export type RunReceipt = Receipt & { divergence?: Divergence | null };

const finite = (v: number | undefined): number | undefined => (v !== undefined && Number.isFinite(v) ? v : undefined);

export class RealSignalExecutor implements Executor {
  readonly name: string;
  private readonly o: RealExecutorOpts;
  private readonly now: () => number;
  /** r2: every real holding on the home (all runs, strategies, accounts), persisted in held.json on each change. */
  private readonly holdings: Record<string, RealHolding>;
  readonly holdingsSource: 'file' | 'rebuilt';
  private readonly confirm = new Map<number, ConfirmState>();
  private readonly tail: ReceiptsTail;
  private receiptCount = 0;
  private halted = false;
  private killSeen: string | null = null;
  // task-1654
  private readonly startedAt: number;
  private stamp: number;
  private fileLimits: EffectiveLimits['values'] | null = null;
  private limitsBroken: string | null = null;
  private recentReceipts: Receipt[] = [];
  private silent = false;
  private watchedAt = -Infinity;

  constructor(o: RealExecutorOpts) {
    this.o = o;
    this.now = o.now ?? Date.now;
    this.name = `real-signal(${o.inner.name})`;
    this.tail = new ReceiptsTail(o.home, (n) => this.o.outbox.get(n));
    const l = loadHoldings(o.home);
    this.holdings = l.holdings;
    this.holdingsSource = l.source;
    if (l.source === 'rebuilt' && Object.keys(l.holdings).length) {
      saveHoldings(o.home, this.holdings, this.now());
      journalReal(o.home, { t: this.now(), action: 'holdings-rebuilt', by: 'runner', data: { mints: Object.keys(l.holdings) } });
    }
    this.startedAt = this.now();
    this.stamp = limitsStamp(o.home);
    // Receipts already on file before this run: the newest few count as signs of life and for the lag.
    try { this.recentReceipts = readReceipts(o.home).receipts.slice(-20); } catch { this.recentReceipts = []; }
  }

  get accountId(): string { return this.o.arming.accountId; }
  private mine(h: RealHolding): boolean { return h.strategyId === this.o.strategy.id && h.accountId === this.o.arming.accountId; }
  private save(): void { saveHoldings(this.o.home, this.holdings, this.now()); }
  private say(line: string, action: string, data: Record<string, unknown> = {}): void {
    try { journalReal(this.o.home, { t: this.now(), action, by: 'runner', data: { line, ...data } }); } catch { /* the line still goes out */ }
    try { this.o.notify?.(line); } catch { /* a notify hook never stops a signal */ }
  }

  /**
   * task-1654: the limits in force now. With start limits: the stricter of them and limits.json now (re-read when it
   * changes; an unreadable or invalid file refuses buys until fixed). Without: card A's four caps.
   */
  limitsNow(): EffectiveLimits['values'] {
    if (!this.o.limits) {
      const c = this.o.caps;
      return Object.fromEntries((['perTradeSol', 'dailySol', 'buysPerDay', 'maxOpenPositions'] as const).map((k) => [k, finite(c[k])]).filter(([, v]) => v !== undefined));
    }
    const st = limitsStamp(this.o.home);
    if (st !== this.stamp) {
      this.stamp = st;
      const l = loadLimits(this.o.home);
      if (!l.ok) { this.limitsBroken = l.why; this.fileLimits = null; }
      else { this.limitsBroken = null; this.fileLimits = effectiveLimits(l.doc, { strategyId: this.o.strategy.id, accountId: this.o.arming.accountId, mode: 'real' }).values; }
    }
    return this.fileLimits ? strictestOf(this.o.limits, this.fileLimits) : this.o.limits;
  }

  /** task-1654: the stricter of the exit profile's holding cap and the maxHoldMinutes limit (the runner applies it). */
  maxHoldMinutes(): number | null { return this.limitsNow().maxHoldMinutes ?? null; }

  private ttl(L: EffectiveLimits['values']): number { return Math.min(this.o.ttlSec, L.signalTtlSec ?? Infinity); }
  private slip(L: EffectiveLimits['values']): { slippageBps: number; maxImpactPct: number } {
    return { slippageBps: Math.min(this.o.strategy.execution.slippageBps, L.maxSlippageBps ?? Infinity), maxImpactPct: Math.min(this.o.strategy.execution.maxPriceImpactPct, L.maxPriceImpactPct ?? Infinity) };
  }

  /** task-1654: how the executor looks (heartbeat, receipts, webhook/command acks this run; the run start is the floor). */
  executorHealth(L: EffectiveLimits['values'] = this.limitsNow()): ExecutorHealth {
    const ackAt = this.o.outbox.channelHealth().filter((c) => c.name === 'webhook' || c.name === 'cmd').reduce<number | null>((a, c) => (c.lastOkAt && (!a || c.lastOkAt > a) ? c.lastOkAt : a), null);
    return executorHealth(this.o.home, { now: this.now(), windowMin: L.executorSilenceMin ?? null, ackAt, since: this.startedAt, signal: (n) => this.o.outbox.get(n), receipts: this.recentReceipts });
  }

  /** Track the silence pause; say it once when it starts and once when the executor is heard again. */
  private watchExecutor(L: EffectiveLimits['values']): ExecutorHealth {
    const h = this.executorHealth(L);
    if (h.alive === false && !this.silent) {
      this.silent = true;
      this.say(`EXECUTOR SILENT: nothing heard from your executor for ${Math.round((h.silentSec ?? 0) / 60)} min (executorSilenceMin ${L.executorSilenceMin}): new real BUY signals are paused; exits still go out. Check it, then dexterm autotrade signal test`, 'executor-silent', { silentSec: h.silentSec, lastSeenBy: h.lastSeenBy });
    } else if (h.alive === true && this.silent) {
      this.silent = false;
      this.say(`EXECUTOR BACK (${h.lastSeenBy}): new real buy signals resume`, 'executor-back', { lastSeenBy: h.lastSeenBy });
    }
    return h;
  }

  /** The positions an earlier run of this strategy + account left open: the runner adopts them so their exits fire. */
  inherited(): Position[] {
    return Object.values(this.holdings).filter((h) => this.mine(h)).map((h) => positionOfHolding(h, this.o.strategy.exits.default));
  }

  /** task-1679: what the `halted` signal lists as open (every real holding on this run's account), for the end print. */
  openOnAccount(): RealHolding[] { return Object.values(this.holdings).filter((h) => h.accountId === this.o.arming.accountId); }

  /** Holdings of other strategies or accounts: they count against the cap, but this run does not trade them. */
  heldElsewhere(): RealHolding[] { return Object.values(this.holdings).filter((h) => !this.mine(h)); }

  /** The run's end (before `halted`): save the book's view of what this run still holds, so the next run resumes it. */
  carry(open: Position[]): void {
    let changed = false;
    for (const p of open) {
      const h = this.holdings[p.mint];
      if (!h || !this.mine(h)) continue;
      h.position = JSON.parse(JSON.stringify({ ...p, ladder: [], sessionId: null, wakeSent: {} })) as Position;
      h.tokens = p.tokens; h.runId = this.o.runId; h.at = this.now();
      changed = true;
    }
    if (changed) this.save();
  }
  private header(nonce: number, ttlSec = this.o.ttlSec): SignalHeader {
    return { nonce, now: this.now(), ttlSec, runId: this.o.runId, accountId: this.o.arming.accountId, strategy: { id: this.o.strategy.id, version: this.o.strategy.version, hash: this.o.strategy.hash } };
  }

  private day(): { day: string; buySol: number; buys: number } {
    const r = loadRiskState(this.o.home, this.now());
    return { day: r.day, buySol: r.buySol, buys: r.buys };
  }

  /** Why no signal may go out now, or null. */
  private blocked(): string | null {
    if (this.halted) return 'real-run-ended';
    const k = realKill(this.o.home);
    return k ? 'real-kill' : null;
  }

  private emit(sig: TradeFireSignal): void {
    this.o.outbox.enqueue(sig);
    void this.o.outbox.pump().catch(() => { /* the host pumps again on its interval */ });
  }

  /** A state file that could not be written AFTER the signal went out: the fill stands (task-1654, verifier R7). */
  private stateError(what: string, e: unknown): void {
    try { journalReal(this.o.home, { t: this.now(), action: 'state-write-failed', by: 'runner', data: { what, error: (e as Error).message.slice(0, 120) } }); } catch { /* nothing more to do */ }
  }

  async buy(k: MarketTick, usd: number, ctx?: OrderContext): Promise<SignalledFill | { refused: string }> {
    const b = this.blocked();
    if (b) return { refused: b };
    const solUsd = this.o.solUsd();
    if (!solUsd || !(solUsd > 0)) return { refused: 'real-sol-price-unknown' };
    const L = this.limitsNow();
    if (this.limitsBroken) return { refused: 'real-limits-unreadable' };
    if (this.o.limits && this.watchExecutor(L).alive === false) return { refused: 'real-executor-silent' };
    const prior = this.holdings[k.mint];
    if (prior && !this.mine(prior)) return { refused: 'real-held-elsewhere' };
    if (!prior && L.maxOpenPositions !== undefined && Object.keys(this.holdings).length >= L.maxOpenPositions) return { refused: 'real-max-open' };
    const now = this.now();
    const risk = loadRiskState(this.o.home, now);
    const openCostUsd = Object.values(this.holdings).reduce((a, h) => a + Math.max(0, h.costUsd - (h.costOutUsd ?? 0)), 0);
    const v = checkBuy(L, risk, { now, solUsd, usd, bookUsd: this.o.bookUsd(), mint: k.mint, liqUsd: k.liq, mcapUsd: k.mcapResolved ?? k.mcap, positionCostUsd: prior ? Math.max(0, prior.costUsd - (prior.costOutUsd ?? 0)) : 0, openCostUsd });
    if (!v.ok) return { refused: v.refused };
    const size = v.usd;
    const ttl = this.ttl(L);
    const sl = this.slip(L);
    const input = (sizeUsd: number, model: TradeInput['model'] = null): TradeInput => ({ side: 'buy', mint: k.mint, symbol: k.symbol, sizeUsd, solUsd, bookUsd: this.o.bookUsd(), priceUsd: k.price, mcap: k.mcapResolved ?? k.mcap, liqUsd: k.liq, ...sl, model });
    const built = this.build(() => buildTradeSignal(input(size), this.header(1, ttl)));
    if ('refused' in built) return built;
    const f = await this.o.inner.buy(k, size, ctx);
    if ('refused' in f) return f;
    let sig: TradeFireSignal;
    try {
      const nonce = this.o.outbox.allocateNonce();
      sig = buildTradeSignal(input(f.usd, { priceUsd: f.price, tokens: f.tokens }), this.header(nonce, ttl));
      this.emit(sig);
    } catch (e) {
      return { refused: `real-outbox-unwritable:${(e as Error).message.slice(0, 60)}` };
    }
    // The signal is queued (fsync'd) from here: the fill stands even if a state file cannot be written.
    const t = this.now();
    try {
      const h = this.holdings[k.mint];
      if (h) { h.entryPrice = (h.entryPrice * h.tokens + f.price * f.tokens) / (h.tokens + f.tokens); h.tokens += f.tokens; h.costUsd += f.usd; h.nonce = sig.nonce; h.runId = this.o.runId; h.at = t; }
      else this.holdings[k.mint] = { mint: k.mint, symbol: sig.type === 'trade' ? sig.symbol : k.symbol, strategyId: this.o.strategy.id, accountId: this.o.arming.accountId, runId: this.o.runId, nonce: sig.nonce, tokens: f.tokens, costUsd: f.usd, realizedUsd: 0, entryPrice: f.price, openedAt: k.t, at: t };
      this.save();
    } catch (e) { this.stateError('held.json', e); }
    try { recordBuy(risk, k.mint, f.usd / solUsd, t); saveRiskState(this.o.home, risk); } catch (e) { this.stateError('risk.json', e); }
    this.confirm.set(sig.nonce, 'unconfirmed');
    return { ...f, signal: { nonce: sig.nonce, id: sig.id }, ...(v.clamps.length ? { limitClamps: v.clamps } : {}) } as SignalledFill;
  }

  async sell(k: MarketTick, tokens: number, reason: string): Promise<SignalledFill | { refused: string }> {
    const b = this.blocked();
    if (b) return { refused: b };
    const solUsd = this.o.solUsd();
    if (!solUsd || !(solUsd > 0)) return { refused: 'real-sol-price-unknown' };
    const L = this.limitsNow();
    const now = this.now();
    const risk = loadRiskState(this.o.home, now);
    const cs = checkSell(L, risk, now);
    if (!cs.ok) return { refused: cs.refused };
    const ttl = this.ttl(L);
    const sl = this.slip(L);
    const input = (sizeUsd: number, sellFraction: number, model: TradeInput['model'] = null): TradeInput => ({ side: 'sell', mint: k.mint, symbol: k.symbol, sizeUsd, solUsd, bookUsd: this.o.bookUsd(), sellFraction, priceUsd: k.price, mcap: k.mcapResolved ?? k.mcap, liqUsd: k.liq, exitReason: reason, ...sl, model });
    const built = this.build(() => buildTradeSignal(input(0, 1), this.header(1, ttl)));
    if ('refused' in built) return built;
    const f = await this.o.inner.sell(k, tokens, reason);
    if ('refused' in f) return f;
    const h = this.holdings[k.mint];
    const fraction = h && h.tokens > 0 ? Math.min(1, f.tokens / h.tokens) : 1;
    let sig: TradeFireSignal;
    try {
      const nonce = this.o.outbox.allocateNonce();
      sig = buildTradeSignal(input(Math.max(0, f.usd), fraction, { priceUsd: f.price, tokens: f.tokens }), this.header(nonce, ttl));
      this.emit(sig);
    } catch (e) {
      return { refused: `real-outbox-unwritable:${(e as Error).message.slice(0, 60)}` };
    }
    // The signal is queued from here: state writes that fail are journaled, the fill stands.
    let pnlUsd = 0;
    let closedPnlUsd: number | null = null;
    if (h) {
      const openCost = Math.max(0, h.costUsd - (h.costOutUsd ?? 0));
      const portion = openCost * fraction;
      pnlUsd = Math.max(0, f.usd) - portion;
      h.tokens -= f.tokens; h.realizedUsd += Math.max(0, f.usd); h.costOutUsd = (h.costOutUsd ?? 0) + portion; h.runId = this.o.runId; h.at = this.now();
      if (h.tokens <= 1e-12 || fraction >= 0.999) { closedPnlUsd = h.realizedUsd - h.costUsd; delete this.holdings[k.mint]; }
      try { this.save(); } catch (e) { this.stateError('held.json', e); }
    }
    try {
      const tripped = recordSell(L, risk, { pnlSol: pnlUsd / solUsd, closedPnlSol: closedPnlUsd === null ? null : closedPnlUsd / solUsd, now: this.now() });
      saveRiskState(this.o.home, risk);
      for (const line of tripped) this.say(`REAL LIMIT: ${line}`, 'limit-tripped', {});
    } catch (e) { this.stateError('risk.json', e); }
    this.confirm.set(sig.nonce, 'unconfirmed');
    return { ...f, signal: { nonce: sig.nonce, id: sig.id } };
  }

  /** A dry build first (nonce 1): a coin whose data cannot make a valid signal is refused before a nonce is spent. */
  private build(f: () => TradeFireSignal): { ok: true } | { refused: string } {
    try { f(); return { ok: true }; } catch (e) { return { refused: `real-signal-invalid:${(e as Error).message.replace(/^signal: /, '').slice(0, 40)}` }; }
  }

  /**
   * Once per tick (the runner calls it): new receipts (ledger rows, with their paper-vs-real divergence), the
   * executor's health (task-1654: the silence pause), and a kill switch that was turned on (the run halts, and the
   * one `halted` signal goes out).
   */
  step(): { receipts: RunReceipt[]; halt: string | null } {
    const receipts: RunReceipt[] = this.tail.poll().map((r) => ({ ...r, divergence: divergenceOf(this.o.outbox.get(r.nonce), r) }));
    for (const r of receipts) { this.confirm.set(r.nonce, r.status); this.receiptCount++; this.recentReceipts.push(r); }
    if (this.recentReceipts.length > 20) this.recentReceipts = this.recentReceipts.slice(-20);
    // The silence watch, at most every 5 s of the run's clock (a buy always checks it right before it goes out).
    if (this.o.limits && !this.halted && this.now() - this.watchedAt >= 5000) { this.watchedAt = this.now(); this.watchExecutor(this.limitsNow()); }
    const k = realKill(this.o.home);
    if (k && !this.killSeen) { this.killSeen = k.reason; this.sendHalted(`kill:${k.reason}`); }
    void this.o.outbox.pump().catch(() => {});
    return { receipts, halt: k ? 'real-kill' : null };
  }

  /** The run's last signal (end of run, halt, kill). Idempotent. Allowed with the kill switch on. */
  sendHalted(reason: string): void {
    if (this.halted) return;
    this.halted = true;
    try {
      const nonce = this.o.outbox.allocateNonce();
      const open = this.openOnAccount().map((h) => h.mint);
      this.emit(buildHaltedSignal(reason, this.o.outbox.outstanding(this.o.runId), { ...this.header(nonce), ttlSec: clampTtl(600) }, open));
      this.o.outbox.markRun(this.o.runId, 'closed', { reason: reason.slice(0, 60) });
    } catch { /* the next outbox open sends it (deadManSweep) */ }
  }

  confirmOf(mint: string): ConfirmState | null {
    const h = this.holdings[mint];
    return h ? this.confirm.get(h.nonce) ?? 'unconfirmed' : null;
  }

  status(): RealStatus {
    const L = this.limitsNow();
    const now = this.now();
    const r = loadRiskState(this.o.home, now);
    const pause = this.limitsBroken ? 'limits.json unreadable' : buyPause(L, r, now)?.detail ?? null;
    const ex = this.executorHealth(L);
    return {
      mode: 'real', accountId: this.o.arming.accountId, killed: realKill(this.o.home)?.reason ?? null, caps: capsOfValues(L), limits: L, day: { day: r.day, buySol: r.buySol, buys: r.buys },
      risk: { dayPnlSol: r.dayPnlSol, cumPnlSol: r.cumPnlSol, lossStreak: r.lossStreak, pausedUntil: r.pausedUntil, breaker: r.breaker, buyPause: pause ?? (this.o.limits && ex.alive === false ? 'executor silent' : null) },
      executor: ex,
      outboxDepth: this.o.outbox.depth(), lastNonce: this.o.outbox.lastNonceIssued, channels: this.o.outbox.channelHealth(),
      positions: Object.values(this.holdings).map((h) => ({ mint: h.mint, symbol: h.symbol, state: this.confirm.get(h.nonce) ?? 'unconfirmed', nonce: h.nonce, ...(this.mine(h) ? {} : { heldBy: h.strategyId }) })),
      receipts: { total: this.receiptCount, invalid: this.tail.invalid, orphan: this.tail.orphan },
    };
  }
}

/** Open the run: mark it in the outbox (so a crash is detectable) after sweeping runs that died without `halted`. */
export function openRealRun(outbox: Outbox, runId: string, s: ResolvedStrategy, accountId: string, now = Date.now()): { swept: string[] } {
  const swept = deadManSweep(outbox, now, runId);
  outbox.markRun(runId, 'open', { strategy: { id: s.id, version: s.version, hash: s.hash }, accountId });
  return { swept };
}

/**
 * The dead-man for a runner that stopped without its `halted` signal (a crash, a kill -9, a power cut): every run
 * still marked open (except `exceptRunId`) gets `halted` reason "runner-lost" with its outstanding nonces, then is
 * closed. Run on every outbox open by the real-mode runner and by `dexterm autotrade signal flush`; the always-on
 * service runs it on start too.
 */
export function deadManSweep(outbox: Outbox, now = Date.now(), exceptRunId?: string): string[] {
  const out: string[] = [];
  for (const r of outbox.unclosedRuns()) {
    if (r.runId === exceptRunId || !r.accountId || !r.strategy) continue;
    const nonce = outbox.allocateNonce();
    const open = Object.values(loadHoldings(outbox.home).holdings).filter((h) => h.accountId === r.accountId).map((h) => h.mint);
    outbox.enqueue(buildHaltedSignal('runner-lost', outbox.outstanding(r.runId), { nonce, now, ttlSec: 600, runId: r.runId, accountId: r.accountId, strategy: r.strategy }, open));
    outbox.markRun(r.runId, 'closed', { reason: 'runner-lost' });
    out.push(r.runId);
  }
  return out;
}
