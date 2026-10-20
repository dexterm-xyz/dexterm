// LARP score backtest + calibration (task-1471). Pure: input is the task-1401 eval set (skills-eval.json).
//
// The eval set holds, per coin, the URL-free link features the coin advertised at t0 and the recorder's 72 h
// outcome (bad = rug or dead). That is the only part of the LARP score history can replay: pages, domains, GitHub
// and X accounts were not captured point-in-time (and looking them up now leaks the outcome, because dead coins'
// sites and accounts disappear). So this fits and scores the LINK-SHAPE flags only, and says so in every output.
//
// Pre-registered rule (written before the test split was scored):
//  - fit on TRAIN only: for each link flag carried by ≥ LARP_SCORE_MIN_FLAG_N train coins,
//    points = clamp(round(8 × ln OR), 0, 12), OR = Haldane-smoothed odds ratio of a bad outcome with vs without it;
//    flags under that count keep their prior points;
//  - bands are the fixed round thresholds 25 / 50 (LARP_SCORE_BANDS), never tuned;
//  - report AUROC (ties count half) and P(bad) per band on train and on the held-out TEST split, with Wilson 95 %.

import { LARP_SCORE_BANDS, LARP_SCORE_WEIGHTS, bandOf, linkFlagIds, linkScore, type LarpBand, type LarpFlagId } from '@dexterm/data';
import { wilson, type Rate } from './larp-eval.ts';
import type { SkillEvalRow, SkillEvalSet } from './skill-backtest.ts';

export const LARP_SCORE_BACKTEST_SCHEMA = 'dexterm/packs/larp-score-backtest/1';
export const LARP_SCORE_MIN_FLAG_N = 20;
const SCALE = 8;
const CAP = 12;

/** The link-shape flags the eval set can carry (in a stable order). */
export const LINK_FLAG_IDS: LarpFlagId[] = ['no_website', 'no_x', 'x_not_account', 'no_telegram', 'site_is_social', 'site_is_launchpad', 'site_linktree', 'site_free_host', 'domain_no_name_match', 'cheap_tld'];

export interface FlagFit { id: LarpFlagId; n: number; bad: number; ln_or: number | null; points: number; source: 'calibrated' | 'prior' }

/** Fit the link-flag points on train rows. Throws on a test row (the split is fixed before tuning). */
export function calibrateLinkPoints(train: readonly SkillEvalRow[]): FlagFit[] {
  if (train.some((r) => r.split !== 'train')) throw new Error('calibrateLinkPoints: test rows are held out');
  const N = train.length, B = train.filter((r) => r.bad).length;
  return LINK_FLAG_IDS.map((id) => {
    const has = train.filter((r) => linkFlagIds(r.link).includes(id));
    const n = has.length, a = has.filter((r) => r.bad).length;
    if (n < LARP_SCORE_MIN_FLAG_N) return { id, n, bad: a, ln_or: null, points: LARP_SCORE_WEIGHTS[id].points, source: 'prior' as const };
    const b = B - a, m = N - n;
    const lnOr = Math.log(((a + 0.5) / (n - a + 0.5)) / ((b + 0.5) / (m - b + 0.5)));
    return { id, n, bad: a, ln_or: Math.round(lnOr * 1000) / 1000, points: Math.max(0, Math.min(CAP, Math.round(SCALE * lnOr))), source: 'calibrated' as const };
  });
}

/** AUROC with ties counted half. Null when a class is empty. */
export function auroc(rows: ReadonlyArray<{ score: number; bad: boolean }>): number | null {
  const pos = rows.filter((r) => r.bad).map((r) => r.score), neg = rows.filter((r) => !r.bad).map((r) => r.score);
  if (!pos.length || !neg.length) return null;
  let s = 0;
  for (const p of pos) for (const q of neg) s += p > q ? 1 : p === q ? 0.5 : 0;
  return s / (pos.length * neg.length);
}

export interface ScoreSplit {
  n: number; bad: number; auroc: number | null;
  by_band: Record<LarpBand, { n: number; bad: number; rate: Rate | null }>;
  /** P(bad | score ≥ t) for each band threshold: the "precision" of a medium-or-higher and a high score as a warning. */
  at_threshold: Array<{ threshold: number; flagged: number; precision: Rate | null; recall: Rate | null }>;
  score_quantiles: { p10: number; p50: number; p90: number; max: number };
}

function splitReport(rows: readonly SkillEvalRow[], weights: Partial<Record<LarpFlagId, number>>): ScoreSplit {
  const scored = rows.map((r) => ({ score: linkScore(r.link, weights), bad: r.bad }));
  const by_band = { low: { n: 0, bad: 0, rate: null }, medium: { n: 0, bad: 0, rate: null }, high: { n: 0, bad: 0, rate: null } } as ScoreSplit['by_band'];
  for (const s of scored) { const b = by_band[bandOf(s.score)]; b.n++; if (s.bad) b.bad++; }
  for (const b of Object.values(by_band)) b.rate = b.n >= 20 ? wilson(b.bad, b.n) : null;
  const B = scored.filter((s) => s.bad).length;
  const at_threshold = [LARP_SCORE_BANDS.medium, LARP_SCORE_BANDS.high].map((t) => {
    const f = scored.filter((s) => s.score >= t), tp = f.filter((s) => s.bad).length;
    return { threshold: t, flagged: f.length, precision: f.length >= 20 ? wilson(tp, f.length) : null, recall: B ? wilson(tp, B) : null };
  });
  const sorted = scored.map((s) => s.score).sort((a, b) => a - b);
  const q = (p: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0;
  const a = auroc(scored);
  return { n: rows.length, bad: B, auroc: a === null ? null : Math.round(a * 1000) / 1000, by_band, at_threshold, score_quantiles: { p10: q(0.1), p50: q(0.5), p90: q(0.9), max: sorted.at(-1) ?? 0 } };
}

export interface LarpScoreBacktest {
  schema: typeof LARP_SCORE_BACKTEST_SCHEMA;
  eval: { built_at: string; horizon_sec: number; rows: number; label_rule: string; split_rule: string };
  part: string;
  method: string[];
  fit: FlagFit[];
  shipped_matches_fit: boolean;
  train: ScoreSplit;
  test: ScoreSplit;
  not_measured: string[];
}

/** Fit on train, score train and test with the fitted points. */
export function larpScoreBacktest(set: SkillEvalSet): LarpScoreBacktest {
  const train = set.rows.filter((r) => r.split === 'train'), test = set.rows.filter((r) => r.split === 'test');
  const fit = calibrateLinkPoints(train);
  const weights = Object.fromEntries(fit.map((f) => [f.id, f.points])) as Partial<Record<LarpFlagId, number>>;
  return {
    schema: LARP_SCORE_BACKTEST_SCHEMA,
    eval: { built_at: set.built_at, horizon_sec: set.horizon_sec, rows: set.rows.length, label_rule: set.label_rule, split_rule: set.split_rule },
    part: 'link-shape flags only (what the eval set holds point-in-time)',
    method: [
      `fit on the train split only (${train.length} coins): points = clamp(round(${SCALE} × ln odds ratio of a bad outcome), 0, ${CAP}) for a flag on ≥ ${LARP_SCORE_MIN_FLAG_N} train coins; rarer flags keep their prior points`,
      `bands fixed before scoring: low < ${LARP_SCORE_BANDS.medium} ≤ medium < ${LARP_SCORE_BANDS.high} ≤ high (not tuned)`,
      'AUROC with ties counted half; rates with 95% Wilson intervals, printed only for n ≥ 20',
      'meaning: how well the link-shape points rank coins that went bad (a price outcome) above the rest, NOT whether a product is real',
    ],
    fit,
    shipped_matches_fit: fit.every((f) => LARP_SCORE_WEIGHTS[f.id].points === f.points && LARP_SCORE_WEIGHTS[f.id].source === f.source),
    train: splitReport(train, weights),
    test: splitReport(test, weights),
    not_measured: [
      'website page flags (default page, wallet connect, drainer markers, never names the token): pages were not captured at t0',
      'domain flags (new domain, registrant privacy) and GitHub flags: not captured at t0',
      "X-account flags (new account, tiny following, no posts, suspended, handle mismatch): not captured at t0, and a lookup today leaks the outcome (dead coins' accounts get deleted or suspended); the X sources' robots.txt also rule out bulk crawling them for a backfill",
      'the high band: link shape alone tops out below it by design, so its precision is unmeasured',
    ],
  };
}

const pct = (r: Rate | null): string => (r === null ? 'counts only (n < 20)' : `${(r.value * 100).toFixed(1)}% [${(r.lo * 100).toFixed(0)}–${(r.hi * 100).toFixed(0)}]`);

export function renderLarpScoreBacktestText(r: LarpScoreBacktest): string {
  const L: string[] = [];
  L.push(`LARP SCORE BACKTEST  ${r.part}`);
  L.push(`  eval set built ${r.eval.built_at}, ${r.eval.rows} coins, horizon ${r.eval.horizon_sec}s; ${r.eval.label_rule}`);
  L.push('  fitted points (train split):');
  for (const f of r.fit) L.push(`    ${f.id.padEnd(22)} n=${String(f.n).padStart(4)} bad=${String(f.bad).padStart(4)} ln OR=${f.ln_or === null ? '   —  ' : f.ln_or.toFixed(2).padStart(6)}  → ${String(f.points).padStart(2)} pts (${f.source})`);
  L.push(`  shipped weights match this fit: ${r.shipped_matches_fit ? 'yes' : 'NO (re-tune or update LARP_SCORE_WEIGHTS)'}`);
  for (const [name, s] of [['train', r.train], ['TEST (held out)', r.test]] as const) {
    L.push(`  ${name}: n=${s.n} bad=${s.bad} (${((s.bad / Math.max(1, s.n)) * 100).toFixed(1)}%)  AUROC=${s.auroc === null ? '—' : s.auroc.toFixed(3)}  score p10/p50/p90/max=${s.score_quantiles.p10}/${s.score_quantiles.p50}/${s.score_quantiles.p90}/${s.score_quantiles.max}`);
    for (const [b, v] of Object.entries(s.by_band)) L.push(`    band ${b.padEnd(6)} n=${String(v.n).padStart(4)} bad=${String(v.bad).padStart(4)}  P(bad)=${pct(v.rate)}`);
    for (const t of s.at_threshold) L.push(`    score ≥ ${t.threshold}: flagged ${t.flagged}  precision=${pct(t.precision)}  recall=${t.recall ? pct(t.recall) : '—'}`);
  }
  L.push('  method:'); for (const m of r.method) L.push(`    - ${m}`);
  L.push('  not measured:'); for (const m of r.not_measured) L.push(`    - ${m}`);
  return L.join('\n') + '\n';
}
