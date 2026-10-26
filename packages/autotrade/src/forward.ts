// dexterm autotrade — FORWARD TESTS (0.2.0 card C). PAPER ONLY.
//
// A forward test runs one strategy, frozen at the version it started with, on the LIVE tape, on paper, for a chosen
// window (hours, or N closed trades, whichever comes first), with its own bankroll (an isolated simulated book: no
// paper account, no other strategy's cash) and its own run file. It is started and stopped from the chat
// (strategy_forward_start / _stop), the Q screen's journey view and `dexterm autotrade forward start|status|stop|report`.
//
// It does not take the machine's run.lock: a forward test runs next to the always-on service or a foreground run, in
// its own process (`dexterm autotrade forward run <fid>`, started detached), with its own status file and stop marker:
//
//   $DEXTERM_HOME/autotrade/forward/tests/<fid>.json   dexterm-forward-test/1: the frozen strategy, the window, state,
//                                                     heartbeat, progress and, at the end, the metrics
//   $DEXTERM_HOME/autotrade/forward/tests/<fid>.stop   the stop marker (CLI, chat, Q screen); the host flattens and ends
//   $DEXTERM_HOME/autotrade/forward/tests/<fid>.log    the detached host's output
//   $DEXTERM_HOME/autotrade/forward/<id>.json          the latest result line for real mode's arm panel (card A)
//   $DEXTERM_HOME/autotrade/runs/<runId>.jsonl         the run ledger, hash-chained like every other run
//
// At the end of its window the host flattens (every position sold at its next tick, so the numbers are closed
// numbers), then writes the metrics in the backtest's own shape (backtest.ts report()) and records the result in
// the strategy's journey. Only a test that ran its whole window on live data is the "forward-tested" rung; one that
// was stopped early, ran on a replay or died is shown, never counted. The panic file stops it like any run.
//
// Model spend: a forward test of an agent strategy opens sessions on the user's own engine inside the strategy's
// budgets and runner.json's caps, like `run`. A strategy that needs a chat approval for every entry cannot be
// forward-tested (no tap reaches a forward test). Nothing here holds a key, signs or touches a wallet.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { report } from './backtest.ts';
import { compareForward, renderComparison, latestBacktest, loadJourney, metricsLine, metricsOf, recordForwardResult, rulesHash, runFills, usd, type Comparison, type ForwardResult, type JourneyMetrics } from './journey.ts';
import { fileLedger, writeJsonAtomic, type LedgerEvent } from './ledger.ts';
import type { MarketTick, Tape } from './replay.ts';
import { runAutotrade, simExecutor, type DossierFn, type RunResult, type RunSessionFactory, type RunnerState, type VetFn } from './runner.ts';
import type { SafetyVerdict } from './safety.ts';
import type { SessionGate } from './sessions.ts';
import { STRATEGY_ID } from './store.ts';
import { validateStrategy, type ResolvedStrategy, type Strategy } from './strategy.ts';

export const FORWARD_SCHEMA = 'dexterm-forward-test/1';
/** The panic file (`dexterm wallet panic`), as @dexterm/data's KillSwitch exposes it. */
export interface KillSwitchLike { engaged(): { reason: string } | null }
export const FORWARD_LIMITS = { minHours: 0.25, maxHours: 72, maxTrades: 200, maxRunning: 3, minBankrollUsd: 10, maxBankrollUsd: 1_000_000 } as const;
/** A running host rewrites its status at least this often; older means the host is gone. */
export const FORWARD_HEARTBEAT_MS = 10_000;
export const FORWARD_STALE_MS = 90_000;
/** After the window ends, how long (tape time) the flatten may keep trying before the stream is closed. */
export const FLATTEN_GRACE_MS = 30 * 60_000;
/** Live data: an ended test whose stream took no step for this long is closed (the report is written). */
export const STALL_MS = 2 * 60_000;

export const forwardRoot = (home: string): string => join(home, 'autotrade', 'forward');
export const forwardTestsDir = (home: string): string => join(forwardRoot(home), 'tests');
const FID = /^fw_[a-z0-9]{6,12}_[a-f0-9]{8}$/;
export const isForwardId = (x: unknown): x is string => typeof x === 'string' && FID.test(x);
const fpath = (home: string, fid: string, ext: string): string => {
  if (!isForwardId(fid)) throw new Error(`bad forward test id ${JSON.stringify(fid)}`);
  return join(forwardTestsDir(home), `${fid}.${ext}`);
};
export const forwardTestPath = (home: string, fid: string): string => fpath(home, fid, 'json');
export const forwardStopPath = (home: string, fid: string): string => fpath(home, fid, 'stop');
export const forwardLogPath = (home: string, fid: string): string => fpath(home, fid, 'log');
/** Card A's arm panel reads `autotrade/forward/<id>.json` (summary line). */
export const forwardSummaryPath = (home: string, id: string): string => {
  if (!STRATEGY_ID.test(id)) throw new Error(`bad strategy id ${JSON.stringify(id)}`);
  return join(forwardRoot(home), `${id}.json`);
};
export const newForwardId = (now = Date.now()): string => `fw_${now.toString(36)}_${randomBytes(4).toString('hex')}`;

export type ForwardState = 'starting' | 'running' | 'done' | 'stopped' | 'failed';
/** What a reader sees: `lost` = a starting/running test whose host is gone (no heartbeat, pid dead). */
export type ForwardLiveState = ForwardState | 'lost';

export interface ForwardTest {
  schema: typeof FORWARD_SCHEMA;
  forwardId: string;
  strategyId: string;
  version: string;
  hash: string;
  rulesHash: string;
  /** The frozen strategy document the test runs (mode paper, the test's bankroll). */
  doc: Strategy;
  bankrollUsd: number;
  window: { hours: number | null; trades: number | null };
  createdAt: number;
  by: string;
  /** `live` (the keyless data layer) or `replay <tape>`; only live counts as the rung. */
  source: string;
  stub: boolean;
  msPerTick: number | null;
  state: ForwardState;
  pid: number | null;
  runId: string | null;
  startedAt: number | null;
  /** The window's end in tape time (= wall time on live data), once started. */
  endsAt: number | null;
  heartbeatAt: number | null;
  endedAt: number | null;
  endReason: string | null;
  progress: { closed: number; open: number; equityUsd: number; netUsd: number; candidates: number } | null;
  metrics: JourneyMetrics | null;
  problems: string[];
}

export interface ForwardStartInput {
  hours?: number | null;
  trades?: number | null;
  bankrollUsd?: number | null;
  by: string;
  source?: string;
  stub?: boolean;
  msPerTick?: number | null;
  now?: number;
}

const pidAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };

export function liveState(t: ForwardTest, now = Date.now(), alive: (pid: number) => boolean = pidAlive): ForwardLiveState {
  if (t.state !== 'starting' && t.state !== 'running') return t.state;
  if (t.state === 'starting') return now - t.createdAt > FORWARD_STALE_MS && (!t.pid || !alive(t.pid)) ? 'lost' : 'starting';
  if (t.pid && !alive(t.pid)) return 'lost';
  return t.heartbeatAt && now - t.heartbeatAt > FORWARD_STALE_MS ? 'lost' : 'running';
}

export function loadForwardTest(home: string, fid: string): ForwardTest | null {
  if (!isForwardId(fid)) return null;
  const p = forwardTestPath(home, fid);
  if (!existsSync(p)) return null;
  try { const d = JSON.parse(readFileSync(p, 'utf8')) as ForwardTest; return d.schema === FORWARD_SCHEMA && d.forwardId === fid ? d : null; } catch { return null; }
}

export function saveForwardTest(home: string, t: ForwardTest): void {
  mkdirSync(forwardTestsDir(home), { recursive: true, mode: 0o700 });
  writeJsonAtomic(forwardTestPath(home, t.forwardId), t);
}

/** Newest first. */
export function listForwardTests(home: string, filter: { strategyId?: string } = {}): ForwardTest[] {
  const dir = forwardTestsDir(home);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => loadForwardTest(home, f.slice(0, -5))).filter((t): t is ForwardTest => !!t && (!filter.strategyId || t.strategyId === filter.strategyId))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export const isActive = (t: ForwardTest, now = Date.now()): boolean => { const s = liveState(t, now); return s === 'starting' || s === 'running'; };

/** A forward test id, or a strategy id (its running test, else its newest). */
export function findForwardTest(home: string, ref: string, now = Date.now()): ForwardTest | null {
  if (isForwardId(ref)) return loadForwardTest(home, ref);
  if (!STRATEGY_ID.test(ref)) return null;
  const all = listForwardTests(home, { strategyId: ref });
  return all.find((t) => isActive(t, now)) ?? all[0] ?? null;
}

/**
 * Freeze a strategy into a new forward test (state `starting`); the caller then starts its host. Refuses a window
 * outside the limits, a second running test of the same strategy, more than FORWARD_LIMITS.maxRunning at once,
 * mode live, and a strategy that needs a chat approval for every entry.
 */
export function createForwardTest(home: string, s: ResolvedStrategy, raw: Strategy, o: ForwardStartInput): { ok: true; test: ForwardTest } | { ok: false; why: string } {
  const now = o.now ?? Date.now();
  if (s.mode === 'live') return { ok: false, why: `${s.id} is mode live, which does not run (dexterm holds no key and places no live order)` };
  if (s.entry.decide === 'agent+approve') return { ok: false, why: `${s.id} needs a chat approval for every entry (entry.decide "agent+approve"); no approval reaches a forward test, so it could never enter. Make a copy with decide "agent" or "auto" to forward-test it` };
  const hours = o.hours ?? null;
  const trades = o.trades ?? null;
  if (hours === null && trades === null) return { ok: false, why: 'a forward test needs a window: hours, a number of closed trades, or both (whichever comes first ends it)' };
  if (hours !== null && !(Number.isFinite(hours) && hours >= FORWARD_LIMITS.minHours && hours <= FORWARD_LIMITS.maxHours)) return { ok: false, why: `hours must be from ${FORWARD_LIMITS.minHours} to ${FORWARD_LIMITS.maxHours}` };
  if (trades !== null && !(Number.isInteger(trades) && trades >= 1 && trades <= FORWARD_LIMITS.maxTrades)) return { ok: false, why: `trades must be a whole number from 1 to ${FORWARD_LIMITS.maxTrades}` };
  const bankrollUsd = o.bankrollUsd ?? s.bankroll.startUsd;
  if (!(Number.isFinite(bankrollUsd) && bankrollUsd >= FORWARD_LIMITS.minBankrollUsd && bankrollUsd <= FORWARD_LIMITS.maxBankrollUsd)) return { ok: false, why: `the paper bankroll must be from $${FORWARD_LIMITS.minBankrollUsd} to $${FORWARD_LIMITS.maxBankrollUsd}` };
  const running = listForwardTests(home).filter((t) => isActive(t, now));
  const same = running.find((t) => t.strategyId === s.id);
  if (same) return { ok: false, why: `${s.id} already has a forward test running (${same.forwardId}); stop it first or read its report` };
  if (running.length >= FORWARD_LIMITS.maxRunning) return { ok: false, why: `${running.length} forward tests are already running (at most ${FORWARD_LIMITS.maxRunning} at once)` };
  // The frozen document: always paper (a real strategy forward-tests as its paper twin), the test's own bankroll.
  const doc: Strategy = { ...structuredClone(raw), mode: 'paper', bankroll: { ...raw.bankroll, startUsd: bankrollUsd } };
  const v = validateStrategy(doc);
  if (!v.ok) return { ok: false, why: `${s.id} does not validate as a paper forward test: ${v.errors.map((e) => `${e.path} ${e.msg}`).join('; ')}` };
  const test: ForwardTest = {
    schema: FORWARD_SCHEMA, forwardId: newForwardId(now), strategyId: s.id, version: s.version, hash: s.hash, rulesHash: rulesHash(s), doc, bankrollUsd,
    window: { hours, trades }, createdAt: now, by: o.by, source: o.source ?? 'live', stub: !!o.stub, msPerTick: o.msPerTick ?? null,
    state: 'starting', pid: null, runId: null, startedAt: null, endsAt: null, heartbeatAt: null, endedAt: null, endReason: null, progress: null, metrics: null, problems: [],
  };
  saveForwardTest(home, test);
  return { ok: true, test };
}

/** Ask a forward test to end (the host flattens and writes its report). Idempotent. */
export function requestForwardStop(home: string, fid: string, by: string, now = Date.now()): { ok: true; already: boolean; test: ForwardTest } | { ok: false; why: string } {
  const t = loadForwardTest(home, fid);
  if (!t) return { ok: false, why: `no forward test ${fid}` };
  const st = liveState(t, now);
  if (st !== 'starting' && st !== 'running') return { ok: false, why: `${fid} is not running (${st})` };
  const p = forwardStopPath(home, fid);
  const already = existsSync(p);
  if (!already) writeFileSync(p, `${JSON.stringify({ at: now, by })}\n`, { mode: 0o600 });
  return { ok: true, already, test: t };
}

export function forwardStopRequested(home: string, fid: string): { at: number; by: string } | null {
  const p = forwardStopPath(home, fid);
  if (!existsSync(p)) return null;
  try { const d = JSON.parse(readFileSync(p, 'utf8')) as { at?: number; by?: string }; return { at: Number(d.at) || 0, by: typeof d.by === 'string' ? d.by.slice(0, 40) : 'unknown' }; } catch { return { at: 0, by: 'unknown' }; }
}

/** Mark a test whose host is gone as failed (a reader that finds it `lost` may call this). */
export function markLost(home: string, t: ForwardTest, now = Date.now()): ForwardTest {
  const next: ForwardTest = { ...t, state: 'failed', endedAt: now, endReason: 'the forward test host stopped without a report (crash, logout or kill)' };
  saveForwardTest(home, next);
  recordForwardResult(home, resultOf(next));
  return next;
}

function resultOf(t: ForwardTest): ForwardResult {
  const state = t.state === 'done' || t.state === 'stopped' ? t.state : 'failed';
  return {
    kind: 'forward', forwardId: t.forwardId, id: t.strategyId, version: t.version, rulesHash: t.rulesHash, startedAt: t.startedAt ?? t.createdAt, endedAt: t.endedAt ?? Date.now(),
    // Only a test on live data can be the forward-tested rung: a replay is a backtest in disguise.
    state: state === 'done' && !t.source.startsWith('live') ? 'stopped' : state,
    endReason: state === 'done' && !t.source.startsWith('live') ? `${t.endReason ?? 'window reached'} (on a replay, which does not count as a forward test)` : (t.endReason ?? ''),
    window: t.window, source: t.source, metrics: t.metrics,
  };
}

// ───────────────────────────── the report ─────────────────────────────

export interface ForwardReport {
  forwardId: string;
  strategyId: string;
  version: string;
  state: ForwardLiveState;
  source: string;
  window: string;
  elapsed: string;
  endReason: string | null;
  progress: ForwardTest['progress'];
  metrics: JourneyMetrics | null;
  comparison: Comparison;
  lines: string[];
}

const dur = (ms: number): string => { const m = Math.max(0, Math.round(ms / 60_000)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
export const windowText = (w: ForwardTest['window']): string => [w.hours !== null ? `${w.hours} h` : '', w.trades !== null ? `${w.trades} closed trades` : ''].filter(Boolean).join(' or ') + (w.hours !== null && w.trades !== null ? ' (whichever first)' : '');

/** The forward test next to the backtest (held-out split) of the same rules, from the journey file. */
export function forwardReport(home: string, t: ForwardTest, now = Date.now()): ForwardReport {
  const state = liveState(t, now);
  const bt = latestBacktest(loadJourney(home, t.strategyId), t.rulesHash);
  const comparison = compareForward(bt, t.metrics);
  const elapsed = t.startedAt ? dur((t.endedAt ?? now) - t.startedAt) : '0 min';
  const lines = [
    `FORWARD TEST ${t.forwardId} · ${t.strategyId} v${t.version} · PAPER · ${t.source} · own bankroll $${t.bankrollUsd}`,
    `  state ${state.toUpperCase()}${t.endReason ? ` (${t.endReason})` : ''} · window ${windowText(t.window)} · ran ${elapsed}`,
    t.progress && !t.metrics ? `  so far: ${t.progress.closed} closed · ${t.progress.open} open · equity $${t.progress.equityUsd.toFixed(2)} (${usd(t.progress.netUsd)}) · ${t.progress.candidates} candidates` : '',
    t.metrics ? `  result: ${metricsLine(t.metrics)}` : '',
    ...(t.metrics || bt ? ['  forward vs backtest of the same rules (paper, modelled fills; not a prediction, not financial advice):', ...renderComparison(comparison)] : []),
    t.source.startsWith('live') ? '' : '  NOTE: this ran on a replay, so it is not a forward test of live data and does not count toward the journey',
  ].filter(Boolean);
  return { forwardId: t.forwardId, strategyId: t.strategyId, version: t.version, state, source: t.source, window: windowText(t.window), elapsed, endReason: t.endReason, progress: t.progress, metrics: t.metrics, comparison, lines };
}

// ───────────────────────────── the host ─────────────────────────────

export interface ForwardHostOpts {
  home: string;
  forwardId: string;
  /** The live tick stream (the CLI: the keyless data layer) … */
  source?: { name: string; ticks: AsyncIterable<MarketTick>; startT?: number; stop?: () => void };
  /** … or, for `--replay` (a smoke run that never counts as the rung), a recorded tape. */
  tape?: Tape;
  sessions: RunSessionFactory | null;
  gate?: SessionGate;
  dossier?: DossierFn;
  vet?: VetFn;
  pacing?: { mode: 'live' } | { mode: 'paced'; msPerTick: number } | { mode: 'lockstep' };
  killSwitch?: KillSwitchLike;
  onLine?: (s: string) => void;
  /** Wall clock (heartbeats); tests pass a fake one. */
  now?: () => number;
  pid?: number;
}

export type ForwardHostResult = { ok: true; test: ForwardTest } | { ok: false; why: string };

/**
 * Run a `starting` forward test to its end in this process: own ledger, own book (the frozen paper strategy and its
 * bankroll), the window, the stop marker and the panic file; then the metrics, the journey record and the summary.
 */
export async function hostForward(o: ForwardHostOpts): Promise<ForwardHostResult> {
  const { home, forwardId } = o;
  const clock = o.now ?? Date.now;
  const say = o.onLine ?? (() => {});
  let t = loadForwardTest(home, forwardId);
  if (!t) return { ok: false, why: `no forward test ${forwardId}` };
  if (!o.source === !o.tape) return { ok: false, why: 'a forward test runs on one live source or one replay tape' };
  const srcName = o.source?.name ?? `replay ${o.tape!.source}`;
  if (t.state !== 'starting') return { ok: false, why: `${forwardId} is ${t.state}; a forward test runs once` };
  const v = validateStrategy(t.doc);
  if (!v.ok || v.strategy.mode !== 'paper') return { ok: false, why: `${forwardId}: the frozen strategy does not validate as paper` };
  const strategy: ResolvedStrategy = v.strategy;
  const runId = `${new Date(clock()).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}-fwd-${strategy.id}-${forwardId.slice(-4)}`;
  let closed = 0;
  const { ledger, files } = fileLedger(home, runId, (e: LedgerEvent) => { if (e.kind === 'trade_closed') closed++; });
  const startedAt = clock();
  t = { ...t, state: 'running', pid: o.pid ?? process.pid, runId, startedAt, heartbeatAt: startedAt };
  saveForwardTest(home, t);
  ledger.add(startedAt, 'forward_start', { forwardId, strategy: strategy.id, version: t.version, rulesHash: t.rulesHash, window: t.window, bankrollUsd: t.bankrollUsd, source: srcName, by: t.by });
  say(`forward test ${forwardId} · ${strategy.id} v${t.version} · PAPER · ${srcName} · own bankroll $${t.bankrollUsd} · window ${windowText(t.window)} · run ${runId}`);

  // The window clock: tape time on a tape or a lockstep feed; WALL time on live data, where a cached row keeps the
  // last tick's time and the tape clock can stall (an hours window measured on it might never close).
  const wall = !o.tape && (o.pacing?.mode ?? 'live') === 'live';
  let tapeT: number | null = null;
  let endsAt: number | null = wall && t.window.hours !== null ? startedAt + t.window.hours * 3_600_000 : null;
  let ended: { state: 'done' | 'stopped'; reason: string } | null = null;
  let endedT: number | null = null;
  let lastStepAt = startedAt;
  let last: RunnerState | null = null;
  let lastBeat = 0;
  const windowNow = (): number | null => (wall ? clock() : tapeT);
  /** Panic, the stop marker and the window; checked on every step and on every heartbeat (a stream can go quiet). */
  const checkEnd = (panic: { reason: string } | null): void => {
    if (panic && !ended) ended = { state: 'stopped', reason: `the panic switch is engaged (${panic.reason})` };
    const stop = forwardStopRequested(home, forwardId);
    if (stop && !ended) ended = { state: 'stopped', reason: `stopped early by ${stop.by}` };
    const nowT = windowNow();
    if (!ended && nowT !== null && endsAt !== null && nowT >= endsAt) ended = { state: 'done', reason: `window reached (${t!.window.hours} h)` };
    if (!ended && t!.window.trades !== null && closed >= t!.window.trades) ended = { state: 'done', reason: `window reached (${closed} closed trades)` };
    if (ended && endedT === null) endedT = nowT ?? clock();
  };
  const beat = (force = false) => {
    const n = clock();
    if (!force && n - lastBeat < FORWARD_HEARTBEAT_MS / 2) return;
    lastBeat = n;
    const cur = loadForwardTest(home, forwardId) ?? t!;
    t = { ...cur, heartbeatAt: n, endsAt, progress: last ? { closed, open: last.positions.length, equityUsd: last.book.equityUsd, netUsd: last.book.equityUsd - last.book.startUsd, candidates: last.candidates.length } : cur.progress };
    try { saveForwardTest(home, t); } catch { /* the next beat retries */ }
  };
  const timer = setInterval(() => {
    beat(true);
    if (!wall) return;
    checkEnd(o.killSwitch?.engaged() ?? null);
    // Ended, but no step for a while (a quiet stream): close the stream so the run ends and the report is written.
    if (ended && clock() - lastStepAt > STALL_MS) o.source?.stop?.();
  }, FORWARD_HEARTBEAT_MS);
  timer.unref?.();
  const safety = (): SafetyVerdict => {
    const panic = o.killSwitch?.engaged() ?? null;
    checkEnd(panic);
    // The window end flattens at the next tick; a bag that cannot sell (no liquidity) ends the stream after a grace.
    const nowT = windowNow();
    if (ended && endedT !== null && nowT !== null && nowT - endedT > FLATTEN_GRACE_MS) o.source?.stop?.();
    if (ended) { return { halt: ended.state === 'done' ? 'forward-window' : panic ? 'kill-switch' : 'forward-stopped', detail: ended.reason, flatten: true, pauseEntries: null, endWhenFlat: true }; }
    return { halt: null, flatten: false, pauseEntries: null, endWhenFlat: false };
  };

  let res: RunResult | null = null;
  let error: string | null = null;
  try {
    res = await runAutotrade({
      strategy, ...(o.source ? { source: o.source } : { tape: o.tape }), sessions: o.sessions, gate: o.gate, dossier: o.dossier, vet: o.vet, executor: simExecutor(strategy.execution),
      pacing: o.pacing ?? { mode: 'live' }, ledger, runId, verbose: true, onLine: say, safety,
      onState: (st) => {
        if (!wall && tapeT === null && t!.window.hours !== null) endsAt = st.t + t!.window.hours * 3_600_000;
        tapeT = st.t;
        lastStepAt = clock();
        last = st;
        beat();
      },
    });
  } catch (e) { error = (e as Error).message.slice(0, 300); }
  clearInterval(timer);
  const endedAt = clock();
  const cur = loadForwardTest(home, forwardId) ?? t;
  let metrics: JourneyMetrics | null = null;
  if (res) {
    const r = report(strategy, { source: srcName, ticks: [], mints: [] }, res);
    metrics = metricsOf(r, runFills(res));
  }
  // A live stream that ends by itself (the data layer stopped) before the window is an early end, never "done".
  const fin: { state: ForwardState; reason: string } = error ? { state: 'failed', reason: `the run failed: ${error}` }
    : ended ? ended : { state: 'stopped', reason: 'the tick stream ended before the window' };
  t = { ...cur, state: fin.state, endReason: fin.reason, endedAt, endsAt, heartbeatAt: endedAt, metrics, progress: last ? { closed: metrics?.trades ?? closed, open: res?.openAtEnd.length ?? 0, equityUsd: (last as RunnerState).book.equityUsd, netUsd: metrics?.netUsd ?? 0, candidates: res?.candidates ?? 0 } : cur.progress };
  ledger.add(endedAt, 'forward_end', { forwardId, state: fin.state, reason: fin.reason, ...(metrics ? { trades: metrics.trades, netUsd: metrics.netUsd } : {}) });
  saveForwardTest(home, t);
  rmSync(forwardStopPath(home, forwardId), { force: true });
  recordForwardResult(home, resultOf(t));
  writeForwardSummary(home, t);
  say(`forward test ${forwardId} ${fin.state}: ${fin.reason}${metrics ? ` · ${metricsLine(metrics)}` : ''} · ledger ${files.ledger}`);
  return { ok: true, test: t };
}

/** The one-line result real mode's arm panel shows (card A reads `summary`). */
export function writeForwardSummary(home: string, t: ForwardTest): void {
  if (!t.metrics) return;
  const days = t.startedAt && t.endedAt ? Math.round(((t.endedAt - t.startedAt) / 86_400_000) * 100) / 100 : null;
  const counted = t.state === 'done' && t.source.startsWith('live');
  // ASCII only: real mode's arm panel prints this line through a printable-ASCII filter.
  const summary = `${t.forwardId} ${t.state}${counted ? '' : ' (does not count)'}; v${t.version}; ${t.metrics.trades} trades; net ${usd(t.metrics.netUsd)} (${t.metrics.netPct}%); ${t.source.startsWith('live') ? 'paper, live data' : 'paper, replay'}${t.metrics.trades < 20 ? '; too few trades to claim anything' : ''}`;
  mkdirSync(forwardRoot(home), { recursive: true, mode: 0o700 });
  writeJsonAtomic(forwardSummaryPath(home, t.strategyId), { schema: 'dexterm-forward-summary/1', forwardId: t.forwardId, version: t.version, rulesHash: t.rulesHash, state: t.state, counted, summary, trades: t.metrics.trades, netPct: t.metrics.netPct, days });
}
