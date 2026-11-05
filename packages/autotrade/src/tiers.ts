// dexterm autotrade — confidence-tiered sizing, EXPERIMENTAL, UNPROVEN and PAPER ONLY (0.2.2, from the rules v4 research).
//
// A strategy opts in with `sizing.tiers` (strategy.ts). The ENGINE (clampEntry) then scores every candidate tick on
// two measured points, maps the score to a tier and the tier to a size in % of the book. Nothing here reads the
// agent's own confidence: the research found no held-out signal in it. The rules, all enforced in the engine:
//   - T0 (score 0, or a failed tier gate) is a skip: no entry.
//   - No tier runs above 25% of the book (TIERS_HARD_CAP_PCT). The cap is code: the table's evidence or cap fields,
//     the strategy file and the agent cannot lift it, and the engine applies it again on the dollar size and on every
//     ladder add. No tier is proven, so a tier configured above 25% is recorded as capped.
//   - The tick must be fresh and listed: a sweep row, a tick time that is not a number, or a tick older than 5 min at
//     decision time (the bs5m window) is T0.
//   - The tier's size is the strategy's pick; every existing ceiling (strategy and profile max %, max $, per-trade loss,
//     exposure, cash, price impact, drawdown size-down, a young-pool cap) still applies, and the stricter one wins.
//   - One open position at a time unless the block says otherwise.
// Refused outside paper: validateStrategy (mode real / live), the runner (a real-signal run) and the engine itself.
//
// The verdict, shown on every TIER line and in validation: unproven; on the held-out data no tier made money, and no
// dexterm strategy has shown an edge (strategy synthesis, 2026-11).
//
// Pure: no I/O.

import type { MarketTick } from './replay.ts';

export const TIER_TABLE_IDS = ['v4-1785'] as const;
export type TierTableId = (typeof TIER_TABLE_IDS)[number];
export type TierId = 'T0' | 'T1' | 'T2' | 'T3' | 'T4';
export type TierEvidence = 'skip' | 'n/a' | 'unproven' | 'proven';

/** The one verdict line. Printed by validation and on every TIER line. */
export const TIERS_VERDICT = 'EXPERIMENTAL, UNPROVEN, PAPER ONLY: on our held-out data no tier made money and no dexterm strategy has shown an edge; every tier runs at 25% of the book at most.';

/** The engine's ceiling for any tier, in % of the book. Code, not data: nothing a strategy file or table says lifts it. */
export const TIERS_HARD_CAP_PCT = 25;

/** A tick older than this at decision time is T0: bs5m describes a 5 min window that has moved on. */
export const TIER_TICK_MAX_AGE_MS = 5 * 60_000;

/** Held-out result of one tier: per-entry mean % with its 95% interval, wins and rugs (n 0 = no held-out entry). */
export interface TierHeldOut { n: number; meanPct: number | null; loPct: number | null; hiPct: number | null; wins: number | null; rugs: number | null }

export interface TierPoint {
  id: string;
  signal: 'turnover1h' | 'bs5m';
  op: '<=' | '>=';
  value: number;
  /** What the signal is, from the tick. */
  what: string;
}

export interface TierRow { id: TierId; minScore: number; sizePct: number; evidence: TierEvidence; heldOut: TierHeldOut }

export interface TierTable {
  id: TierTableId;
  /** Where the numbers come from (no paths, no names). */
  provenance: string;
  unprovenCapPct: number;
  /** "Full port" leaves this much of the book as cash for the exit's fee and slippage. */
  reservePct: number;
  points: readonly TierPoint[];
  tiers: readonly TierRow[];
  /** A failed gate is T0 whatever the score. Pool age is a gate here and in the rug-proof block (see tierGateFailures). */
  gates: { minPoolAgeMin: number; minLiqUsd: number; youngVertical: { maxAgeHours: number; maxH1Pct: number } };
}

const freeze = <T>(x: T): T => {
  if (x && typeof x === 'object') { for (const v of Object.values(x as Record<string, unknown>)) freeze(v); Object.freeze(x); }
  return x;
};

/**
 * The frozen v4 table (schema dexterm-challenge-tiers/1, version 4.0.0), as data. The points were fitted on TRAIN only;
 * the held-out set was scored once. Changing a number here is a new table id, never an edit.
 */
export const CONFIDENCE_TIERS_V4: TierTable = freeze({
  id: 'v4-1785',
  provenance: 'task-1785 rules v4 research (family strict): frozen 2026-10-28T03:17:49Z, held-out scored once 2026-10-28T03:18:28Z',
  unprovenCapPct: 25,
  reservePct: 2,
  points: [
    { id: 'turnover1h-max', signal: 'turnover1h', op: '<=', value: 9.878, what: '1 h volume / liquidity' },
    { id: 'bs5m-min', signal: 'bs5m', op: '>=', value: 3.714, what: 'buys / sells, 5 min' },
  ],
  tiers: [
    { id: 'T0', minScore: 0, sizePct: 0, evidence: 'skip', heldOut: { n: 19, meanPct: -17.0, loPct: -35.7, hiPct: 3.4, wins: 5, rugs: 2 } },
    { id: 'T1', minScore: 1, sizePct: 15, evidence: 'n/a', heldOut: { n: 0, meanPct: null, loPct: null, hiPct: null, wins: null, rugs: null } },
    { id: 'T2', minScore: 1, sizePct: 50, evidence: 'unproven', heldOut: { n: 0, meanPct: null, loPct: null, hiPct: null, wins: null, rugs: null } },
    { id: 'T3', minScore: 1, sizePct: 75, evidence: 'unproven', heldOut: { n: 17, meanPct: -7.6, loPct: -31.8, hiPct: 16.8, wins: 5, rugs: 1 } },
    { id: 'T4', minScore: 2, sizePct: 100, evidence: 'unproven', heldOut: { n: 0, meanPct: null, loPct: null, hiPct: null, wins: null, rugs: null } },
  ],
  gates: { minPoolAgeMin: 10, minLiqUsd: 30_000, youngVertical: { maxAgeHours: 2, maxH1Pct: 150 } },
});

export function tierTable(id: TierTableId): TierTable {
  if (id === 'v4-1785') return CONFIDENCE_TIERS_V4;
  throw new Error(`unknown tier table ${String(id)}`);
}

// ───────────────────────────── signals ─────────────────────────────

export interface TierSignals { liq: number | null; vol1h: number | null; turnover1h: number | null; buys5m: number | null; sells5m: number | null; bs5m: number | null }

const fin = (x: number | null | undefined): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
/** Liquidity, volume and trade counts are never negative: a negative or non-finite figure is unknown. */
const nonneg = (x: number | null | undefined): number | null => { const v = fin(x); return v !== null && v >= 0 ? v : null; };

/**
 * The research's feature definitions, on one tick:
 *   turnover1h = vol1h / liquidity (unknown when liquidity is not > 0 or vol1h is unknown)
 *   bs5m       = buys5m / sells5m; no sells with buys = 99 (all buys); no buys and no sells = 0
 * One difference, on the safe side: the research tape counted a missing sells figure as 0 (so buys alone gave 99);
 * here a missing buys or sells figure makes bs5m unknown, and an unknown signal never scores its point. A negative or
 * non-finite figure (NaN, Infinity) is unknown too.
 */
export function tierSignals(k: MarketTick): TierSignals {
  const liq = nonneg(k.liq); const vol1h = nonneg(k.vol1h);
  const b = nonneg(k.buys5m); const s = nonneg(k.sells5m);
  const turnover1h = liq !== null && liq > 0 && vol1h !== null ? vol1h / liq : null;
  const bs5m = b === null || s === null ? null : s > 0 ? b / s : b > 0 ? 99 : 0;
  return { liq, vol1h, turnover1h, buys5m: b, sells5m: s, bs5m };
}

// ───────────────────────────── selection ─────────────────────────────

export interface TierPointResult { id: string; signal: TierPoint['signal']; op: TierPoint['op']; value: number; actual: number | null; pass: boolean }

export interface TierPick {
  table: TierTableId;
  tier: TierId;
  score: number;
  of: number;
  points: TierPointResult[];
  /** Failed tier gates (any one = T0). */
  gates: string[];
  configuredPct: number;
  /** The % of the book this tier runs at (before the strategy's own limits). */
  effectivePct: number;
  evidence: TierEvidence;
  /** Configured above the unproven cap without proof: runs at the cap. */
  capped: boolean;
  heldOut: TierHeldOut;
}

/**
 * The tier gates on the tick. Pool age: the tick carries the token's creation time only, and a pool is never older
 * than its token, so a token younger than minPoolAgeMin (or of unknown age) fails here; the pair's own age is the
 * rug-proof pool-age gate's job (validateStrategy requires it at minPoolAgeMin or more with tiers on).
 * The tick itself: a sweep row (the coin had left the screen), a tick time that is not a number, a tick older than
 * TIER_TICK_MAX_AGE_MS at `nowMs` or stamped after it fails. `nowMs` defaults to the tick's own time (a replay row).
 */
export function tierGateFailures(k: MarketTick, g: TierTable['gates'], nowMs: number = k.t): string[] {
  const out: string[] = [];
  const t = fin(k.t); const now = fin(nowMs);
  if (k.kind !== 'live') out.push(`tick not live (${String(k.kind)})`);
  if (t === null || now === null) out.push('tick time unknown');
  else if (now - t > TIER_TICK_MAX_AGE_MS) out.push(`tick stale (${Math.ceil((now - t) / 1000)} s old > ${TIER_TICK_MAX_AGE_MS / 1000} s)`);
  else if (t > now) out.push('tick time after the decision time');
  const created = fin(k.createdAt) !== null && (k.createdAt as number) > 0 ? (k.createdAt as number) : null;
  const ageMin = t !== null && created !== null ? (t - created) / 60e3 : null;
  if (ageMin === null) out.push(`pool age unknown (no token creation time) < ${g.minPoolAgeMin} min`);
  else if (ageMin < g.minPoolAgeMin) out.push(`pool age < ${g.minPoolAgeMin} min (token ${ageMin.toFixed(0)} min old)`);
  const liq = fin(k.liq);
  if (liq === null || liq < g.minLiqUsd) out.push(`liquidity ${liq === null ? 'unknown' : `$${Math.round(liq)}`} < $${g.minLiqUsd}`);
  // A young coin with no 1 h change figure cannot be cleared of "vertical": it fails (the research tape had the figure).
  const h1 = fin(k.chg1h);
  if (ageMin !== null && ageMin / 60 < g.youngVertical.maxAgeHours) {
    if (h1 === null) out.push(`young and h1 unknown (at ${(ageMin / 60).toFixed(1)} h)`);
    else if (h1 >= g.youngVertical.maxH1Pct) out.push(`young and vertical (h1 ${h1}% at ${(ageMin / 60).toFixed(1)} h)`);
  }
  return out;
}

/**
 * The size a tier runs at: never above TIERS_HARD_CAP_PCT (or the table's own cap when lower), whatever its evidence
 * says (0.2.2 has no proven tier and no path that lifts the cap), never above 100 - reservePct. A non-finite or
 * negative configured size runs at 0.
 */
export function tierRunsAtPct(t: TierRow, table: TierTable): { pct: number; capped: boolean } {
  const cfg = Number.isFinite(t.sizePct) && t.sizePct > 0 ? t.sizePct : 0;
  const tableCap = Number.isFinite(table.unprovenCapPct) && table.unprovenCapPct >= 0 ? table.unprovenCapPct : 0;
  const capPct = Math.min(TIERS_HARD_CAP_PCT, tableCap);
  let pct = cfg; let capped = false;
  if (pct > capPct) { pct = capPct; capped = true; }
  if (pct > 100 - table.reservePct) pct = 100 - table.reservePct;
  return { pct, capped };
}

/** Score the tick (one point per rule that holds; an unknown signal never passes), then the highest tier met wins. */
export function selectConfidenceTier(k: MarketTick, table: TierTable = CONFIDENCE_TIERS_V4, nowMs: number = k.t): TierPick {
  const sig = tierSignals(k);
  const points = table.points.map((p): TierPointResult => {
    const actual = sig[p.signal];
    const pass = actual !== null && (p.op === '>=' ? actual >= p.value : actual <= p.value);
    return { id: p.id, signal: p.signal, op: p.op, value: p.value, actual: actual === null ? null : Math.round(actual * 1000) / 1000, pass };
  });
  const score = points.filter((p) => p.pass).length;
  const gates = tierGateFailures(k, table.gates, nowMs);
  let row = table.tiers[0];
  if (!gates.length) for (const t of table.tiers) if (score >= t.minScore) row = t;
  const run = row.id === 'T0' ? { pct: 0, capped: false } : tierRunsAtPct(row, table);
  return { table: table.id, tier: row.id, score, of: points.length, points, gates, configuredPct: row.sizePct, effectivePct: run.pct, evidence: row.evidence, capped: run.capped, heldOut: row.heldOut };
}

// ───────────────────────────── text ─────────────────────────────

const sgn = (x: number): string => `${x > 0 ? '+' : ''}${x.toFixed(1)}`;

/**
 * "unproven: held-out n 17, mean -7.6% per entry, lower bound -31.8% (upper +16.8%), rug 1/17". The text carries the
 * mean and its interval, never a win count or rate (a small-sample win rate reads as a claim the data does not make).
 */
export function tierEvidenceText(evidence: TierEvidence, h: TierHeldOut): string {
  const head = evidence === 'n/a' ? 'n/a (at or under the 25% cap)' : evidence;
  if (h.n === 0 || h.meanPct === null) return `${head}: held-out n 0 (too small to say)`;
  return `${head}: held-out n ${h.n}, mean ${h.meanPct.toFixed(1)}% per entry, lower bound ${h.loPct === null ? '?' : `${h.loPct.toFixed(1)}%`}${h.hiPct === null ? '' : ` (upper ${sgn(h.hiPct)}%)`}${h.rugs === null ? '' : `, rug ${h.rugs}/${h.n}`}`;
}

const short = (m: string): string => (m.length > 10 ? `${m.slice(0, 4)}…${m.slice(-4)}` : m);

/** The run log's TIER line: tier, score, size, evidence status and the verdict. `afterUsd` = the size after every limit. */
export function confidenceTierLine(p: TierPick, k: Pick<MarketTick, 'symbol' | 'mint'>, afterUsd?: number): string {
  const head = `TIER ${p.tier} for ${k.symbol} (${short(k.mint)}): score ${p.score}/${p.of}`;
  const ev = tierEvidenceText(p.evidence, p.heldOut);
  if (p.tier === 'T0') return `${head} · SKIP (size 0)${p.gates.length ? ` · gate: ${p.gates.join('; ')}` : ''} · ${ev} · ${TIERS_VERDICT}`;
  const pts = p.points.filter((x) => x.pass).map((x) => x.id).join(', ') || 'none';
  const size = p.capped ? `configured ${p.configuredPct}%, runs at ${p.effectivePct}% of the book (unproven: capped)` : `runs at ${p.effectivePct}% of the book`;
  return `${head} (${pts}) · ${size}${afterUsd !== undefined ? ` · $${afterUsd} after the strategy's limits` : ''} · ${ev} · ${TIERS_VERDICT}`;
}

/** Validation / docs text: one line per tier, the verdict first. */
export function tierTableLines(table: TierTable = CONFIDENCE_TIERS_V4): string[] {
  const rows = table.tiers.map((t, i) => {
    const run = t.id === 'T0' ? { pct: 0, capped: false } : tierRunsAtPct(t, table);
    const unreachable = i > 0 && table.tiers.slice(i + 1).some((u) => u.minScore === t.minScore);
    const size = t.id === 'T0' ? 'skip (size 0)' : run.capped ? `configured ${t.sizePct}%, runs at ${run.pct}% (unproven: capped)` : `runs at ${run.pct}%`;
    return `${t.id} score >= ${t.minScore}: ${size} · ${tierEvidenceText(t.evidence, t.heldOut)}${unreachable ? ` · never selected (a higher tier has the same score ${t.minScore})` : ''}`;
  });
  return [TIERS_VERDICT, ...rows, `table ${table.id}: ${table.provenance}`];
}

/** A compact record of the pick for the ledger. */
export function tierRecord(p: TierPick): Record<string, unknown> {
  return { table: p.table, tier: p.tier, score: p.score, of: p.of, points: p.points.map((x) => ({ id: x.id, actual: x.actual, pass: x.pass })), gates: p.gates, configuredPct: p.configuredPct, runsAtPct: p.effectivePct, capped: p.capped, evidence: tierEvidenceText(p.evidence, p.heldOut) };
}
