// dexterm autotrade — backtest + parameter sweep (task-1498 spike, AUTOTRADE-SPEC §3).
//
// A backtest is the run loop over a recorded tape with the same engine, clamp and monitor a paper run uses
// (no separate "backtest logic" to drift). The report gives P/L, win rate, drawdown and per-rule attribution
// (which exit rule closed what, which trigger opened it, which clamp fired), and always prints the limits of
// the data next to the numbers.
//
// Sweeps follow the skill-care methodology: split the tape CHRONOLOGICALLY by first sighting (the newest
// 30 % of coins is the held-out TEST, fixed before any tuning; no coin is in both halves), tune on TRAIN only,
// then report TEST for the winner against the unchanged strategy. Below SKILL_MIN_N test trades the verdict
// is "too few trades" whatever the numbers say.
//
// task-1503 (AT-1, spec §3a): the moonbag lives on a rare tail, so the report also carries the per-entry
// expectancy with a bootstrap 95% interval, the exit-multiple quantiles, an every-candidate evaluation copy
// (fixed unit size, book caps lifted, so every entry is an independent sample) and runner recall (of the coins
// that later ran >= Nx, which did the entry rules pass, what refused the rest, which exit closed the entered).
// Verdict rule 6: no tuning claim unless train and test both have >= SKILL_MIN_N trades AND the held-out net is
// above 0 (a loser that loses less does not "win").

import { SKILL_MIN_N, wilson } from '@dexterm/packs';
import { EntryRules } from './engine.ts';
import { runAutotrade, type RunResult, type VetFn } from './runner.ts';
import { rugproofTapeVet } from './rugproof.ts';
import { validateStrategy, round, type ResolvedStrategy, type Strategy } from './strategy.ts';
import type { MarketTick, Tape } from './replay.ts';
import type { SessionFactory } from './session.ts';

export const DATA_LIMITS = [
  'Price path = recorder snapshots (~2-min cadence while listed, written on >= 5% moves or every 30 min), not candles or trades: intrabar spikes and dips are invisible, so stops and take-profits fill at the next recorded price.',
  'Fills are modelled (constant-product impact on half the recorded liquidity + fee + slippage + network fee), not Jupiter quotes.',
  'Survivorship: only coins the app recorded (on a screen or in a feed) are in the tape; coins nobody saw are absent.',
  'Rugs: when liquidity falls under the exit floor the bag cannot be sold (stuck) and is valued at 0 unless liquidity returns; a rug between two rows fills at whatever the next row says (often -99%), never at the level a rule wanted.',
  'Early entries look later than they are: a young pair enters the tape only once a feed lists it, and pairs that rugged before any feed saw them are missing, so the measured rug rate is a floor.',
  'Narrative, followed-wallet, social and dev-sell signals are not in the recorded history, so those triggers and exits never fire in a backtest.',
  'Mechanical entries (no agent): a lockstep backtest has no agent latency and no agent judgement; agent backtests cost Claude usage and stay small-n.',
];

/** A closed trade at or below this is counted as a rug (the challenge's rugAtPct). */
export const RUG_PCT = -80;

export interface Bucket { n: number; pnlUsd: number }
export interface BacktestReport {
  strategy: { id: string; version: string; hash: string };
  tape: { source: string; mints: number; ticks: number; from: string | null; to: string | null };
  trades: number;
  wins: number;
  losses: number;
  winRate: { value: number; lo: number; hi: number } | null;
  netUsd: number;
  netPct: number;
  profitFactor: number | null;
  avgWinPct: number | null;
  avgLossPct: number | null;
  worstPct: number | null;
  bestPct: number | null;
  maxDrawdownPct: number;
  /** Rug-adjusted tail view (what a moonbag lives on): trades closed at <= RUG_PCT, trades that took their cost back,
   *  the net without the single best trade, and that trade's proceeds as a multiple of its cost. */
  tail: {
    rugs: number; costRecovered: number; netWithoutBestUsd: number; bestMultiple: number | null;
    /** Mean P/L per $ staked (%), with a seeded bootstrap 95% interval (2,000 resamples of the trades). */
    perEntry: { meanPct: number; lo: number; hi: number } | null;
    /** Proceeds / cost per trade (open-at-end bags at their liquidation mark): median, P90, max. */
    multiples: { p50: number; p90: number; max: number } | null;
  };
  stuck: number;
  openAtEnd: number;
  candidates: number;
  sessions: number;
  sessionCostUsd: number;
  byExit: Record<string, Bucket>;
  byProfile: Record<string, Bucket>;
  byTrigger: Record<string, Bucket>;
  clamps: Record<string, number>;
  refusals: Record<string, number>;
  limits: string[];
}

export async function backtest(strategy: ResolvedStrategy, tape: Tape, sessions: SessionFactory | null = null, opts: { vet?: VetFn | null } = {}): Promise<{ report: BacktestReport; run: RunResult }> {
  // task-1748: a rug-proof strategy replays its tick gates + the pump.fun-mint proxy (the chain gates need live data).
  const rp = strategy.entry.safety.rugproof;
  const vet = opts.vet === null ? undefined : opts.vet ?? (rp ? rugproofTapeVet(rp) : undefined);
  // task-1645: a strategy in mode real backtests as its paper twin (a backtest never emits a trade-fire signal).
  const run = await runAutotrade({ strategy: strategy.mode === 'real' ? { ...strategy, mode: 'paper' } : strategy, tape, sessions, pacing: { mode: 'lockstep' }, ...(vet ? { vet } : {}) });
  return { report: report(strategy, tape, run), run };
}

export function report(s: ResolvedStrategy, tape: Tape, run: RunResult): BacktestReport {
  // Positions still open at the end are closed at their liquidation mark (0 when stuck) for the totals.
  const recovered = (fills: { reason: string }[]) => fills.some((f) => f.reason === 'cost-recovery');
  const closed = run.trades.map((t) => ({ pnl: t.pnlUsd, pct: t.pnlPct, exit: t.exitReason, profile: t.profileId, trig: t.entryTrigger, stuck: t.stuck, cost: t.costUsd, recovered: recovered(t.fills) }));
  for (const p of run.openAtEnd) {
    const pos = run.book.open.get(p.mint)!;
    const pnl = p.markUsd + pos.realizedUsd - pos.costUsd;
    closed.push({ pnl, pct: round((pnl / pos.costUsd) * 100), exit: p.stuck ? 'end-stuck' : 'end-of-tape', profile: pos.profileId, trig: [], stuck: p.stuck, cost: pos.costUsd, recovered: recovered(pos.fills) });
  }
  const best = closed.length ? closed.reduce((a, t) => (t.pnl > a.pnl ? t : a)) : null;
  const wins = closed.filter((t) => t.pnl > 0);
  const losses = closed.filter((t) => t.pnl <= 0);
  const net = closed.reduce((a, t) => a + t.pnl, 0);
  const gw = wins.reduce((a, t) => a + t.pnl, 0);
  const gl = -losses.reduce((a, t) => a + t.pnl, 0);
  const bucket = (key: (t: (typeof closed)[number]) => string[]) => {
    const out: Record<string, Bucket> = {};
    for (const t of closed) for (const k of key(t)) { const b = (out[k] ??= { n: 0, pnlUsd: 0 }); b.n++; b.pnlUsd = round(b.pnlUsd + t.pnl); }
    return out;
  };
  const avg = (xs: number[]) => (xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  const w = wilson(wins.length, closed.length);
  const first = tape.ticks[0]?.t, last = tape.ticks[tape.ticks.length - 1]?.t;
  return {
    strategy: { id: s.id, version: s.version, hash: s.hash },
    tape: { source: tape.source, mints: tape.mints.length, ticks: tape.ticks.length, from: first ? new Date(first).toISOString() : null, to: last ? new Date(last).toISOString() : null },
    trades: closed.length, wins: wins.length, losses: losses.length,
    winRate: w ? { value: round(w.value * 100, 1), lo: round(w.lo * 100, 1), hi: round(w.hi * 100, 1) } : null,
    netUsd: round(net), netPct: round((net / s.bankroll.startUsd) * 100),
    profitFactor: gl > 0 ? round(gw / gl) : null,
    avgWinPct: avg(wins.map((t) => t.pct)), avgLossPct: avg(losses.map((t) => t.pct)),
    worstPct: closed.length ? Math.min(...closed.map((t) => t.pct)) : null, bestPct: closed.length ? Math.max(...closed.map((t) => t.pct)) : null,
    maxDrawdownPct: run.maxDrawdownPct,
    tail: {
      rugs: closed.filter((t) => t.pct <= RUG_PCT || t.stuck).length, costRecovered: closed.filter((t) => t.recovered).length, netWithoutBestUsd: round(net - (best?.pnl ?? 0)), bestMultiple: best ? round((best.pnl + best.cost) / best.cost) : null,
      perEntry: bootstrapMean(closed.map((t) => (t.pnl / t.cost) * 100)),
      multiples: closed.length ? (() => { const m = closed.map((t) => (t.pnl + t.cost) / t.cost).sort((a, b) => a - b); return { p50: round(quantile(m, 0.5)), p90: round(quantile(m, 0.9)), max: round(m[m.length - 1]) }; })() : null,
    },
    stuck: closed.filter((t) => t.stuck).length, openAtEnd: run.openAtEnd.length,
    candidates: run.candidates, sessions: run.sessions, sessionCostUsd: round(run.sessionCostUsd, 4),
    byExit: bucket((t) => [t.exit]), byProfile: bucket((t) => [t.profile]), byTrigger: bucket((t) => (t.trig.length ? t.trig : ['(open at end)'])),
    clamps: run.clamps, refusals: run.refusals,
    limits: DATA_LIMITS,
  };
}

export function renderReport(r: BacktestReport): string {
  const usd = (x: number) => `${x >= 0 ? '+' : '-'}$${Math.abs(x).toFixed(2)}`;
  const rows = (o: Record<string, Bucket>) => Object.entries(o).sort((a, b) => b[1].n - a[1].n).map(([k, b]) => `    ${k.padEnd(22)} ${String(b.n).padStart(4)}  ${usd(b.pnlUsd)}`).join('\n');
  return [
    `BACKTEST ${r.strategy.id} v${r.strategy.version} (${r.strategy.hash}) · PAPER · recorded data`,
    `tape: ${r.tape.mints} coins, ${r.tape.ticks} rows, ${r.tape.from ?? '—'} → ${r.tape.to ?? '—'}`,
    `trades ${r.trades} · wins ${r.wins} · losses ${r.losses} · win rate ${r.winRate ? `${r.winRate.value}% (95% ${r.winRate.lo}–${r.winRate.hi}%)` : '—'}`,
    `net ${usd(r.netUsd)} (${r.netPct}% of the bankroll) · profit factor ${r.profitFactor ?? '—'} · avg win ${r.avgWinPct ?? '—'}% · avg loss ${r.avgLossPct ?? '—'}% · best ${r.bestPct ?? '—'}% · worst ${r.worstPct ?? '—'}%`,
    `tail: rugs (<= ${RUG_PCT}% or stuck) ${r.tail.rugs} · cost taken back ${r.tail.costRecovered} · net without the best trade ${usd(r.tail.netWithoutBestUsd)} · best trade ${r.tail.bestMultiple ?? '—'}x its cost`,
    `      per entry ${r.tail.perEntry ? `${r.tail.perEntry.meanPct}% of the stake (bootstrap 95% ${r.tail.perEntry.lo}% to ${r.tail.perEntry.hi}%)` : '—'} · exit multiple P50 ${r.tail.multiples?.p50 ?? '—'}x · P90 ${r.tail.multiples?.p90 ?? '—'}x · max ${r.tail.multiples?.max ?? '—'}x`,
    `max drawdown ${r.maxDrawdownPct}% · stuck (unsellable) ${r.stuck} · open at end ${r.openAtEnd} · candidates ${r.candidates} · sessions ${r.sessions} ($${r.sessionCostUsd})`,
    '  by exit rule:', rows(r.byExit),
    '  by profile:', rows(r.byProfile),
    '  by entry trigger:', rows(r.byTrigger),
    `  clamps fired: ${Object.entries(r.clamps).map(([k, n]) => `${k} ×${n}`).join(', ') || 'none'}`,
    `  entries refused: ${Object.entries(r.refusals).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k} ×${n}`).join(', ') || 'none'}`,
    r.trades < SKILL_MIN_N ? `  NOTE: ${r.trades} trades is below n = ${SKILL_MIN_N}: read the counts, not the rates.` : '',
    '  limits of this data:', ...r.limits.map((l) => `    - ${l}`),
  ].filter(Boolean).join('\n');
}

// ───────────────────────────── held-out split + sweep ─────────────────────────────

/** Chronological split by each coin's first row: the newest `testFrac` of coins is TEST. */
export function splitTape(tape: Tape, testFrac = 0.3): { train: Tape; test: Tape; cutoff: number } {
  const first = new Map<string, number>();
  for (const k of tape.ticks) if (!first.has(k.mint)) first.set(k.mint, k.t);
  const order = [...first.entries()].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1));
  const nTest = Math.max(1, Math.round(order.length * testFrac));
  const testSet = new Set(order.slice(order.length - nTest).map(([m]) => m));
  const cutoff = order[order.length - nTest]?.[1] ?? 0;
  const pick = (inTest: boolean): Tape => ({
    source: `${tape.source} [${inTest ? 'test' : 'train'}]`,
    ticks: tape.ticks.filter((k) => testSet.has(k.mint) === inTest),
    mints: tape.mints.filter((m) => testSet.has(m) === inTest),
  });
  return { train: pick(false), test: pick(true), cutoff };
}

/** A parameter path into the RESOLVED strategy; `profile.` targets the default exit profile. */
export type Grid = Record<string, number[]>;

export function withParams(s: ResolvedStrategy, params: Record<string, number>): ResolvedStrategy {
  const doc = JSON.parse(JSON.stringify({ ...s, hash: undefined, exits: { default: s.exits.default, profiles: Object.values(s.exits.profiles) } })) as Strategy & { hash?: string };
  delete doc.hash;
  for (const [path, v] of Object.entries(params)) {
    const parts = path.split('.');
    let o: Record<string, unknown> = doc as unknown as Record<string, unknown>;
    if (parts[0] === 'profile') {
      o = (doc.exits.profiles as unknown as Record<string, unknown>[]).find((p) => p.id === s.exits.default)!;
      parts.shift();
    }
    for (const p of parts.slice(0, -1)) {
      const next = o[p];
      if (next === null || typeof next !== 'object') throw new Error(`sweep path ${path}: ${p} is not an object`);
      o = next as Record<string, unknown>;
    }
    o[parts[parts.length - 1]] = v;
  }
  const r = validateStrategy(doc);
  if (!r.ok) throw new Error(`sweep params ${JSON.stringify(params)} make the strategy invalid: ${r.errors.map((e) => `${e.path} ${e.msg}`).join('; ')}`);
  return r.strategy;
}

export interface SweepRow { params: Record<string, number>; train: Pick<BacktestReport, 'trades' | 'netUsd' | 'maxDrawdownPct' | 'winRate'>; test?: Pick<BacktestReport, 'trades' | 'netUsd' | 'maxDrawdownPct' | 'winRate'> }
export interface SweepResult { split: { trainMints: number; testMints: number; cutoff: string }; combos: number; invalid: { params: Record<string, number>; error: string }[]; baseline: SweepRow; best: SweepRow; top: SweepRow[]; verdict: string }

const pickR = (r: BacktestReport) => ({ trades: r.trades, netUsd: r.netUsd, maxDrawdownPct: r.maxDrawdownPct, winRate: r.winRate });

/** Seeded PRNG (mulberry32) so a random sweep is reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function combos(grid: Grid, mode: 'grid' | 'random', max: number, seed = 1): Record<string, number>[] {
  const keys = Object.keys(grid);
  let all: Record<string, number>[] = [{}];
  for (const k of keys) all = all.flatMap((c) => grid[k].map((v) => ({ ...c, [k]: v })));
  if (mode === 'grid') return all.slice(0, max);
  const r = rng(seed);
  const out: Record<string, number>[] = [];
  const pool = [...all];
  while (out.length < max && pool.length) out.push(pool.splice(Math.floor(r() * pool.length), 1)[0]);
  return out;
}

export async function sweep(s: ResolvedStrategy, tape: Tape, grid: Grid, o: { testFrac?: number; mode?: 'grid' | 'random'; max?: number; seed?: number; minTrainTrades?: number } = {}): Promise<SweepResult> {
  const { train, test, cutoff } = splitTape(tape, o.testFrac ?? 0.3);
  const rows: SweepRow[] = [];
  const invalid: SweepResult['invalid'] = [];
  for (const params of combos(grid, o.mode ?? 'grid', o.max ?? 64, o.seed ?? 1)) {
    let st: ResolvedStrategy;
    // A combination the validator refuses (e.g. TP1 above TP2) is skipped and counted, never run.
    try { st = withParams(s, params); } catch (e) { invalid.push({ params, error: (e as Error).message.replace(/^.*invalid: /, '') }); continue; }
    rows.push({ params, train: pickR((await backtest(st, train)).report) });
  }
  if (!rows.length) throw new Error('every sweep combination is invalid');
  const minN = o.minTrainTrades ?? 5;
  const eligible = rows.filter((r) => r.train.trades >= minN);
  const best = [...(eligible.length ? eligible : rows)].sort((a, b) => b.train.netUsd - a.train.netUsd || a.train.maxDrawdownPct - b.train.maxDrawdownPct)[0];
  // TEST is touched exactly twice: the unchanged strategy and the train winner.
  const baseline: SweepRow = { params: {}, train: pickR((await backtest(s, train)).report), test: pickR((await backtest(s, test)).report) };
  best.test = pickR((await backtest(withParams(s, best.params), test)).report);
  const verdict = sweepVerdict(best, baseline);
  return {
    split: { trainMints: train.mints.length, testMints: test.mints.length, cutoff: new Date(cutoff).toISOString() },
    combos: rows.length, invalid, baseline, best, top: [...rows].sort((a, b2) => b2.train.netUsd - a.train.netUsd).slice(0, 5), verdict,
  };
}

/**
 * Verdict rule 6 (§3a): gain wording only when TRAIN and TEST both have >= SKILL_MIN_N trades, the held-out net
 * is above 0, the winner beats the unchanged strategy on TEST, and train agrees. A loser that loses less is
 * reported as exactly that, never as a gain.
 */
export function sweepVerdict(best: SweepRow, baseline: SweepRow): string {
  const t = best.test!, b = baseline.test!;
  if (best.train.trades < SKILL_MIN_N || t.trades < SKILL_MIN_N) return `too few trades (train ${best.train.trades}, held-out ${t.trades}; both need >= ${SKILL_MIN_N}): no tuning claim`;
  if (t.netUsd <= 0) {
    return t.netUsd > b.netUsd
      ? `no edge: the tuned strategy still loses on the held-out coins (${t.netUsd.toFixed(2)} USD; it only loses ${(t.netUsd - b.netUsd).toFixed(2)} USD less than unchanged): no tuning claim`
      : `no edge: the held-out net is ${t.netUsd.toFixed(2)} USD (unchanged ${b.netUsd.toFixed(2)}): keep the strategy as is`;
  }
  if (t.netUsd > b.netUsd && best.train.netUsd > baseline.train.netUsd) return `held-out gain ${(t.netUsd - b.netUsd).toFixed(2)} USD over the unchanged strategy, held-out net ${t.netUsd.toFixed(2)} USD (train and test agree)`;
  return `no held-out gain (test ${t.netUsd.toFixed(2)} vs unchanged ${b.netUsd.toFixed(2)}): keep the strategy as is`;
}

export function renderSweep(r: SweepResult): string {
  const usd = (x: number) => `${x >= 0 ? '+' : '-'}$${Math.abs(x).toFixed(2)}`;
  const row = (x: SweepRow) => `${JSON.stringify(x.params)}  train ${x.train.trades} trades ${usd(x.train.netUsd)} dd ${x.train.maxDrawdownPct}%${x.test ? `  · held-out ${x.test.trades} trades ${usd(x.test.netUsd)} dd ${x.test.maxDrawdownPct}%` : ''}`;
  return [
    `SWEEP · PAPER · recorded data · split by first sighting: train ${r.split.trainMints} coins, held-out ${r.split.testMints} coins (newest, from ${r.split.cutoff})`,
    `combinations run ${r.combos} · refused as invalid ${r.invalid.length}`,
    `  unchanged:   ${row(r.baseline)}`,
    `  train best:  ${row(r.best)}`,
    '  top 5 on train:', ...r.top.map((x) => `    ${row(x)}`),
    `VERDICT: ${r.verdict}`,
    '  The held-out coins were touched twice (the unchanged strategy and the train winner); nothing was tuned on them.',
  ].join('\n');
}

// ───────────────────────────── tail statistics ─────────────────────────────

export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/** Mean with a seeded percentile-bootstrap 95% interval (deterministic: same trades → same interval). */
export function bootstrapMean(xs: number[], resamples = 2000, seed = 1): { meanPct: number; lo: number; hi: number } | null {
  if (!xs.length) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const r = rng(seed);
  const means: number[] = [];
  for (let b = 0; b < resamples; b++) {
    let sum = 0;
    for (let i = 0; i < xs.length; i++) sum += xs[Math.floor(r() * xs.length)];
    means.push(sum / xs.length);
  }
  means.sort((a, b) => a - b);
  return { meanPct: round(mean), lo: round(quantile(means, 0.025)), hi: round(quantile(means, 0.975)) };
}

// ───────────────────────────── every-candidate evaluation copy ─────────────────────────────

/**
 * The every-candidate copy (§3a run b): each candidate is entered at a fixed unit size with the book caps lifted
 * (exposure, concurrency, day count, day-loss halt, drawdown size-down and halt, loss-streak cooldown), on a
 * book large enough that cash never binds. The strategy's own entry rules, per-coin rules, exit profiles and the
 * fill model are unchanged, so every entry is an independent sample and the result does not depend on which
 * candidates happened to arrive first. An evaluation copy, never a strategy to run.
 */
export function everyCandidate(s: ResolvedStrategy, unitUsd = 20): ResolvedStrategy {
  const doc = JSON.parse(JSON.stringify({ ...s, hash: undefined, exits: { default: s.exits.default, profiles: Object.values(s.exits.profiles) } })) as Strategy;
  doc.id = `${s.id.slice(0, 21)}-every`;
  doc.name = 'Every candidate (evaluation copy)';
  doc.description = `Evaluation copy of ${s.id}: every candidate entered at a fixed $${unitUsd} with the book caps lifted, so each entry is an independent sample.`;
  doc.bankroll = { ...doc.bankroll, startUsd: 100_000 };
  doc.sizing = { ...doc.sizing, mode: 'fixed', fixedUsd: unitUsd, maxUsd: unitUsd, minUsd: Math.min(doc.sizing.minUsd, unitUsd), ladder: undefined };
  delete doc.sizing.pct; delete doc.sizing.riskPct; delete doc.sizing.confidence; delete doc.sizing.ladder;
  const r = doc.risk;
  doc.risk = {
    ...r,
    dailyLossHaltPct: 100,
    drawdown: { sizeDownAtPct: 99, sizeDownMult: 1, recoverBelowPct: 0, haltAtPct: 100 },
    maxConcurrent: 20, maxExposurePct: 100, maxEntriesPerDay: 500,
    lossStreak: { losses: 50, cooldownMin: 0 },
    ...(r.recoveredBags ? { recoveredBags: { ...r.recoveredBags, maxBags: 50 } } : {}),
  };
  const v = validateStrategy(doc);
  if (!v.ok) throw new Error(`every-candidate copy of ${s.id} is invalid: ${v.errors.map((e) => `${e.path} ${e.msg}`).join('; ')}`);
  return v.strategy;
}

// ───────────────────────────── runner recall ─────────────────────────────

export interface RecallCoin { mint: string; symbol: string; peakX: number; windowRows: number; passed: boolean; refusedBy: Record<string, number>; trade: { exit: string; pnlPct: number | null; sells: string[] } | null }
export interface RecallReport { minX: number; runners: number; passed: number; entered: number; closedGreen: number; refusedBy: Record<string, number>; exits: Record<string, number>; coins: RecallCoin[] }

/**
 * Runner recall (§3a item 3). A coin is in the window while its age is inside the strategy's entry age range and
 * its liquidity is at least the default profile's fit.minLiquidityUsd. Its peak is the best price at that
 * liquidity from the first window row on, divided by the first window row's price. For each threshold: how many
 * such coins ran >= Nx, how many the entry rules passed on some window row, which rule refused the others (a coin
 * counts once per rule) and which exit closed each one the run entered.
 */
export function runnerRecall(s: ResolvedStrategy, tape: Tape, run: RunResult, thresholds: number[]): RecallReport[] {
  const rules = new EntryRules(s);
  const minLiq = s.exits.profiles[s.exits.default].fit.minLiquidityUsd;
  const { min, max } = s.entry.ageHours;
  const byMint = new Map<string, MarketTick[]>();
  for (const k of tape.ticks) { const a = byMint.get(k.mint); if (a) a.push(k); else byMint.set(k.mint, [k]); }
  const trades = new Map<string, RecallCoin['trade']>();
  for (const t of run.trades) if (!trades.has(t.mint)) trades.set(t.mint, { exit: t.exitReason, pnlPct: t.pnlPct, sells: t.fills.slice(1).map((f) => `${f.reason} ${(f.price / t.fills[0].price).toFixed(2)}x`) });
  for (const p of run.openAtEnd) if (!trades.has(p.mint)) trades.set(p.mint, { exit: p.stuck ? 'end-stuck' : 'end-of-tape', pnlPct: null, sells: [] });
  const coins: RecallCoin[] = [];
  for (const [mint, ks] of byMint) {
    const win = ks.filter((k) => k.kind === 'live' && k.createdAt !== null && k.price && (k.liq ?? 0) >= minLiq && (k.t - k.createdAt) / 3600e3 >= min && (max === null || (k.t - k.createdAt) / 3600e3 <= max));
    if (!win.length) continue;
    const p0 = win[0].price!;
    const peak = Math.max(...ks.filter((k) => k.t >= win[0].t && (k.liq ?? 0) >= minLiq && k.price).map((k) => k.price!));
    const res = win.map((k) => rules.screen(k));
    const refusedBy: Record<string, number> = {};
    for (const r of res) if (!r.pass) for (const f of r.failed) refusedBy[f] = (refusedBy[f] ?? 0) + 1;
    coins.push({ mint, symbol: ks[0].symbol, peakX: round(peak / p0, 1), windowRows: win.length, passed: res.some((r) => r.pass), refusedBy, trade: trades.get(mint) ?? null });
  }
  return thresholds.map((x) => {
    const rs = coins.filter((c) => c.peakX >= x).sort((a, b) => b.peakX - a.peakX);
    const refusedBy: Record<string, number> = {};
    for (const c of rs) if (!c.passed) for (const f of Object.keys(c.refusedBy)) refusedBy[f] = (refusedBy[f] ?? 0) + 1;
    const exits: Record<string, number> = {};
    for (const c of rs) if (c.trade) exits[c.trade.exit] = (exits[c.trade.exit] ?? 0) + 1;
    return { minX: x, runners: rs.length, passed: rs.filter((c) => c.passed).length, entered: rs.filter((c) => c.trade).length, closedGreen: rs.filter((c) => (c.trade?.pnlPct ?? 0) > 0).length, refusedBy, exits, coins: rs };
  });
}

export function renderRecall(rs: RecallReport[], s: ResolvedStrategy): string {
  const L: string[] = [];
  const top = (o: Record<string, number>) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
  for (const r of rs) {
    L.push(`RUNNER RECALL >= ${r.minX}x (${s.id}: coins in its entry window that later ran >= ${r.minX}x at sellable liquidity): ${r.runners} · entry rules passed ${r.passed} · entered ${r.entered} · closed green ${r.closedGreen}`);
    L.push(`  refused runners by rule (a coin counts once per rule): ${top(r.refusedBy)}`);
    L.push(`  how the entered runners closed: ${top(r.exits)}`);
    for (const c of r.coins.slice(0, 25)) {
      const short = `${c.mint.slice(0, 4)}…${c.mint.slice(-4)}`;
      const why = c.passed ? 'PASSED ' : `refused ${Object.entries(c.refusedBy).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([f, n]) => `${f} ${n}/${c.windowRows}`).join(', ')}`;
      const tr = c.trade ? ` · ${c.trade.sells.join(' → ') || '(no sell)'} · ${c.trade.pnlPct === null ? 'open at end' : `closed ${c.trade.pnlPct}% by ${c.trade.exit}`}` : '';
      L.push(`    ${short} ${String(c.peakX).padStart(6)}x  window rows ${String(c.windowRows).padStart(3)}  ${why}${tr}`);
    }
  }
  return L.join('\n');
}
