// dexterm autotrade — the yolo (full-port) helpers (task-1532). HIGH RISK, PAPER only (task-1571: dexterm holds no
// key and places no live order).
//
// yoloReplay: the honest numbers for a full-port strategy. The same engine, clamp and monitor as a backtest, on a
// paper copy sized at 100% of the book (one position at a time), over recorded history: the rugs, the spread of
// losses, the chronological full-port wallet path, and a seeded bootstrap of entry sequences (how often a run of N
// entries zeroed the wallet). A replay is not a forecast; DATA_LIMITS print next to the numbers.
import { SKILL_MIN_N } from '@dexterm/packs';
import { DATA_LIMITS, RUG_PCT, quantile, rng } from './backtest.ts';
import { writeJsonAtomic } from './ledger.ts';
import { runAutotrade } from './runner.ts';
import { round, type ResolvedStrategy } from './strategy.ts';
import type { Tape } from './replay.ts';

export const YOLO_REPLAY_LIMITS = [
  'Full port: each entry is measured once at the same stake (the strategy\'s startUsd), then the wallet is compounded through the entries in order with all of it in each one, so one rug takes the wallet down with it.',
  'The strategy\'s book halts (day loss, drawdown) are lifted while measuring so one early rug does not hide every later entry; a paper run keeps them (and a zeroed book stops it for good).',
  'A bag that cannot be sold (the pool was pulled) stays open at 0 and blocks every later entry, as it does in a run with one position at a time; on such a tape the replay ends at that rug.',
  'Bootstrap: entries drawn at random (with replacement) from the replayed ones, as if they were independent; real entries cluster (one bad hour, one bad day), so the true spread is wider.',
  'The LARP gate and the agent need the live web and a model: this replay enters mechanically on the screen, the safety gates and the triggers only.',
];

/** A trade at or below this is a rug (the backtest's RUG_PCT); a full-port wallet at or below ZEROED_FRAC of its start is "zeroed". */
export const ZEROED_FRAC = 0.1;
/** The bootstrap horizon: random runs of this many full-port entries (about two days at the preset's entry cap). */
export const YOLO_SEQUENCE = 10;

export interface YoloBucket { label: string; n: number }
export interface YoloReplay {
  strategy: { id: string; version: string; hash: string };
  tape: { source: string; mints: number; ticks: number; from: string | null; to: string | null };
  entries: number;
  wins: number;
  rugs: number;
  costRecovered: number;
  /** Per-entry result (% of the stake) in buckets, worst first. */
  spread: YoloBucket[];
  /** The full-port wallet compounded through the entries in order, as multiples of the start (stops once zeroed). */
  path: { final: number; low: number; high: number; zeroed: boolean; zeroedAtEntry: number | null };
  /** Seeded bootstrap over random runs of `sequence` entries. */
  bootstrap: { sequence: number; resamples: number; zeroedPct: number; halvedPct: number; doubledPct: number; p10: number; p50: number; p90: number } | null;
  small: boolean;
  limits: string[];
}

/** The stake-to-book ratio of the measuring copy: every entry is the same stake on a book this many times larger. */
const MEASURE_BOOK_X = 1000;

/**
 * The paper copy the replay measures with: the strategy as written (screen, gates, triggers, exits, one position at a
 * time, the per-day entry cap, the loss-streak cooldown, one entry per coin), entering mechanically, with every entry
 * the SAME stake (the strategy's startUsd, so the modelled price impact is the one a full-port entry of that size
 * would see) on a much larger book, and the book-level halts (day loss, drawdown) lifted. That way one early rug does
 * not halt the replay and hide every later entry: each entry the rules would take is measured once, and the full-port
 * wallet is then compounded from those results in order (yoloReplay). Built in code on purpose: no strategy file can
 * say 100% (the schema's ceiling is 25%).
 */
export function measureCopy(s: ResolvedStrategy): ResolvedStrategy {
  const c = structuredClone(s);
  const stake = c.bankroll.startUsd;
  c.mode = 'paper';
  c.bankroll = { ...c.bankroll, startUsd: stake * MEASURE_BOOK_X, source: 'fixed' };
  c.entry = { ...c.entry, decide: 'auto' };
  c.sizing = { mode: 'fixed', fixedUsd: stake, maxPctOfBankroll: 25, maxUsd: stake, minUsd: Math.min(c.sizing.minUsd, stake) };
  c.risk = { ...c.risk, perTrade: { ...c.risk.perTrade, maxLossPctOfBankroll: 100 }, dailyLossHaltPct: 100, drawdown: { ...c.risk.drawdown, sizeDownAtPct: 100, haltAtPct: 100 }, maxExposurePct: 100, maxConcurrent: 1 };
  return c;
}

const BUCKETS: [string, (pct: number) => boolean][] = [
  [`rug (<= ${RUG_PCT}%)`, (p) => p <= RUG_PCT],
  [`${RUG_PCT}% to -50%`, (p) => p > RUG_PCT && p <= -50],
  ['-50% to -20%', (p) => p > -50 && p <= -20],
  ['-20% to 0%', (p) => p > -20 && p <= 0],
  ['0% to +100%', (p) => p > 0 && p < 100],
  ['+100% or more (2x+)', (p) => p >= 100],
];

export async function yoloReplay(s: ResolvedStrategy, tape: Tape, o: { resamples?: number; seed?: number; sequence?: number } = {}): Promise<YoloReplay> {
  const copy = measureCopy(s);
  const run = await runAutotrade({ strategy: copy, tape, sessions: null, pacing: { mode: 'lockstep' } });
  // Entries in the order they opened; a position still open at the end counts at its liquidation mark (0 when stuck).
  const rows = run.trades.map((t) => ({ at: t.openedAt, pct: t.pnlPct, stuck: t.stuck, recovered: t.fills.some((f) => f.reason === 'cost-recovery'), pnl: t.pnlUsd }));
  for (const p of run.openAtEnd) {
    const pos = run.book.open.get(p.mint)!;
    const pnl = p.markUsd + pos.realizedUsd - pos.costUsd;
    rows.push({ at: pos.openedAt, pct: round((pnl / pos.costUsd) * 100), stuck: p.stuck, recovered: pos.fills.some((f) => f.reason === 'cost-recovery'), pnl });
  }
  rows.sort((a, b) => a.at - b.at);
  const multiples = rows.map((r) => (r.stuck ? 0 : Math.max(0, 1 + r.pct / 100)));
  // The full-port wallet, entry after entry: all of it into each entry in order; once zeroed it stays zeroed.
  let w = 1, low = 1, high = 1, zeroedAt: number | null = null;
  for (const [i, m] of multiples.entries()) {
    w *= m; low = Math.min(low, w); high = Math.max(high, w);
    if (w <= ZEROED_FRAC) { zeroedAt = i + 1; break; }
  }
  let bootstrap: YoloReplay['bootstrap'] = null;
  if (multiples.length) {
    const sequence = o.sequence ?? YOLO_SEQUENCE;
    const resamples = o.resamples ?? 2000;
    const r = rng(o.seed ?? 1);
    const finals: number[] = [];
    let zeroed = 0, halved = 0, doubled = 0;
    for (let b = 0; b < resamples; b++) {
      let v = 1, hitZero = false;
      for (let i = 0; i < sequence && !hitZero; i++) {
        v *= multiples[Math.floor(r() * multiples.length)];
        if (v <= ZEROED_FRAC) hitZero = true;
      }
      if (hitZero) zeroed++;
      if (v <= 0.5) halved++;
      if (v >= 2) doubled++;
      finals.push(v);
    }
    finals.sort((a, b) => a - b);
    const pct = (n: number) => round((n / resamples) * 100, 1);
    bootstrap = { sequence, resamples, zeroedPct: pct(zeroed), halvedPct: pct(halved), doubledPct: pct(doubled), p10: round(quantile(finals, 0.1), 3), p50: round(quantile(finals, 0.5), 3), p90: round(quantile(finals, 0.9), 3) };
  }
  const first = tape.ticks[0]?.t, lastT = tape.ticks[tape.ticks.length - 1]?.t;
  return {
    strategy: { id: s.id, version: s.version, hash: s.hash },
    tape: { source: tape.source, mints: tape.mints.length, ticks: tape.ticks.length, from: first ? new Date(first).toISOString() : null, to: lastT ? new Date(lastT).toISOString() : null },
    entries: rows.length,
    wins: rows.filter((x) => x.pnl > 0).length,
    rugs: rows.filter((x) => x.pct <= RUG_PCT || x.stuck).length,
    costRecovered: rows.filter((x) => x.recovered).length,
    spread: BUCKETS.map(([label, f]) => ({ label, n: rows.filter((x) => f(x.stuck ? -100 : x.pct)).length })),
    path: { final: round(w, 3), low: round(low, 3), high: round(high, 3), zeroed: zeroedAt !== null, zeroedAtEntry: zeroedAt },
    bootstrap,
    small: rows.length < SKILL_MIN_N,
    limits: [...YOLO_REPLAY_LIMITS, ...DATA_LIMITS],
  };
}

export function renderYoloReplay(r: YoloReplay): string {
  const x = (m: number) => `${m.toFixed(2)}x`;
  const b = r.bootstrap;
  return [
    `YOLO REPLAY ${r.strategy.id} v${r.strategy.version} (${r.strategy.hash}) · HIGH RISK · PAPER, full port, recorded data`,
    `tape: ${r.tape.mints} coins, ${r.tape.ticks} rows, ${r.tape.from ?? '—'} → ${r.tape.to ?? '—'}`,
    `entries ${r.entries} · won ${r.wins} · RUGS ${r.rugs}${r.entries ? ` (${Math.round((r.rugs / r.entries) * 100)}% of entries)` : ''} · cost taken back ${r.costRecovered}`,
    '  per entry (% of the stake):',
    ...r.spread.map((s) => `    ${s.label.padEnd(22)} ${String(s.n).padStart(4)}`),
    r.path.zeroed
      ? `  the wallet, all of it into each entry in order: ZEROED at entry ${r.path.zeroedAtEntry} of ${r.entries} (fell to <= ${x(ZEROED_FRAC)}) · highest ${x(r.path.high)} before that`
      : `  the wallet, all of it into each entry in order: ended at ${x(r.path.final)} of the start · lowest ${x(r.path.low)} · highest ${x(r.path.high)}`,
    b ? `  ${b.resamples} random runs of ${b.sequence} entries: ZEROED THE WALLET in ${b.zeroedPct}% · halved it or worse in ${b.halvedPct}% · doubled it in ${b.doubledPct}% · end P10 ${x(b.p10)} · median ${x(b.p50)} · P90 ${x(b.p90)}` : '  no entries on this history: nothing to resample (the gates refused every coin, or the tape is too short)',
    r.small ? `  NOTE: ${r.entries} entries is below n = ${SKILL_MIN_N}: read the counts, not the rates.` : '',
    '  limits of this replay:', ...r.limits.map((l) => `    - ${l}`),
    '  HIGH RISK. Paper only; not financial advice. A replay is not a forecast.',
  ].filter(Boolean).join('\n');
}

// ───────────────────────────── built-in tapes ─────────────────────────────

/** `--replay builtin:<name>`: a tape shipped with the app (assets/tapes); `yolo-rehearsal` is a short fixture tape for a paper yolo run. */
export function builtinTapePath(arg: string): string | URL {
  const m = /^builtin:([a-z][a-z0-9-]{1,40})$/.exec(arg);
  return m ? new URL(`../assets/tapes/${m[1]}.json`, import.meta.url) : arg;
}
