// `dexterm backtest [--subject heuristic|pack_verdicts] [--horizon 3600] [--db PATH] [--json]`
// (task-1356, AI-SUITE-DESIGN §6). Scores the rug model (or recorded pack verdicts) against the
// recorder's LABELLED outcomes and prints HONEST metrics: base rate, precision/recall, Brier vs the
// base-rate Brier, AUC, a calibration table, a per-feed breakdown, and the worst misses/false alarms with
// their t0 numbers. No network, no model, read-only on the DB. The numbers are re-runnable from history.
//
// Subjects shipped here are the metric-bearing ones (a probability per row). The `filter` subject of the
// harness (label distribution for a grammar filter) needs a features→ScreenerRow adapter and is exercised
// through the harness API / packs tests, not this command yet.
import type { DatabaseSync } from 'node:sqlite';
import { defaultDbPath } from '@dexterm/data';
import { exportRecorded, openHistoryReadOnly, readLarpJoin, type Label } from '@dexterm/recorder';
import { runBacktest, h1Model, larpEval, renderLarpEvalText, type BacktestKind, type BacktestResult } from '@dexterm/packs';

export interface BacktestIo {
  stdout: { write(s: string): unknown };
  stderr: { write(s: string): unknown };
  env: NodeJS.ProcessEnv;
}

const HORIZONS = [3600, 7200, 21600, 86400, 259200];

export const BACKTEST_HELP = `dexterm backtest: score the rug model against recorded outcomes (task-1356). No network, no model.

  dexterm backtest [--subject heuristic|pack_verdicts|larp] [--horizon SEC] [--db PATH] [--json]

  --subject   heuristic (default, the pre-registered H1 rug model), pack_verdicts (recorded pack rug_p), or
              larp (task-1359: recorded LARP-detector verdicts vs the outcome labels; counts only below
              50 matched verdicts, 95% Wilson intervals above; agreement with bad outcomes, not ground truth).
  --horizon   outcome horizon in seconds: ${HORIZONS.join(', ')} (default 3600 = 1h).
  --json      print the full result object instead of the human table.
  --db        defaults to DEXTERM_DB_PATH, else ~/.local/share/dexterm/dexterm.db.

  Metrics are honest: features are the t0 snapshot the user would have seen, labels are the outcome AFTER
  t0, the split is by time, and the per-feed breakdown is shown so a model that only learns "which feed"
  is exposed. It needs recorded, outcome-labelled history (the app running with the recorder on long
  enough for the horizon to elapse); with none it says so rather than inventing numbers.`;

function parse(argv: string[]): Record<string, string | true> {
  const opts: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const v = argv[i + 1];
    if (v !== undefined && !v.startsWith('--') && k !== 'json') { opts[k] = v; i++; } else opts[k] = true;
  }
  return opts;
}

const pctOr = (x: number | null): string => (x === null ? ' — ' : `${(x * 100).toFixed(0)}%`);
const numOr = (x: number | null, d = 3): string => (x === null ? '—' : x.toFixed(d));
const usdOr = (x: number | null): string => {
  if (x === null) return '—';
  const a = Math.abs(x);
  if (a >= 1e6) return `$${(x / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${Math.round(x / 1e3)}K`;
  return `$${Math.round(x)}`;
};

export function renderBacktestText(subject: string, horizon: number, labeler: string, r: BacktestResult): string {
  const L: string[] = [];
  L.push(`BACKTEST  subject=${subject}  horizon=${horizon}s  labeler=${labeler}  (${r.data_tier})`);
  if (r.note && r.precision === null && r.auc === null) { L.push(`  ${r.note}`); return L.join('\n') + '\n'; }
  L.push(`  n=${r.n}  base rate=${pctOr(r.base_rate)}  flagged=${r.flagged ?? '—'}  (tp ${r.tp ?? '—'} / fp ${r.fp ?? '—'} / fn ${r.fn ?? '—'} / tn ${r.tn ?? '—'})`);
  L.push(`  precision=${pctOr(r.precision)}  recall=${pctOr(r.recall)}  specificity=${pctOr(r.specificity ?? null)}`);
  L.push(`  AUC=${numOr(r.auc)}  Brier=${numOr(r.brier, 4)}  (base-rate Brier=${numOr(r.brier_base_rate, 4)})`);
  if (r.calibration?.length) {
    L.push('  calibration (bucket: mean p → observed, n):');
    for (const c of r.calibration) L.push(`    ${c.bucket.padEnd(9)} ${numOr(c.mean_p)} → ${numOr(c.observed)}  (n=${c.n})`);
  }
  if (r.by_feed && Object.keys(r.by_feed).length) {
    L.push('  per feed (n / positives / flagged / tp / base rate):');
    for (const [f, b] of Object.entries(r.by_feed).sort((a, c) => c[1].n - a[1].n)) {
      L.push(`    ${f.padEnd(20)} ${b.n} / ${b.pos} / ${b.flagged} / ${b.tp} / ${pctOr(b.base_rate)}`);
    }
  }
  if (r.worst_misses?.length) {
    L.push('  worst misses (positive the model scored low):');
    for (const m of r.worst_misses.slice(0, 5)) L.push(`    ${(m.symbol ?? m.mint.slice(0, 6)).padEnd(10)} p=${numOr(m.p)} ${m.label.padEnd(6)} liq ${usdOr(m.liq)} mcap ${usdOr(m.mcap)}`);
  }
  if (r.worst_false_alarms?.length) {
    L.push('  worst false alarms (negative the model scored high):');
    for (const m of r.worst_false_alarms.slice(0, 5)) L.push(`    ${(m.symbol ?? m.mint.slice(0, 6)).padEnd(10)} p=${numOr(m.p)} ${m.label.padEnd(6)} liq ${usdOr(m.liq)} mcap ${usdOr(m.mcap)}`);
  }
  L.push(`  leakage: features t0-only=${r.leakage_checks.features_from_t0_only}  labels after t0=${r.leakage_checks.labels_after_t0}  no future feeds=${r.leakage_checks.no_future_feeds}`);
  return L.join('\n') + '\n';
}

export function backtestCommand(argv: string[], io: BacktestIo): number {
  const opts = parse(argv);
  if (opts.help || opts.h) { io.stdout.write(BACKTEST_HELP + '\n'); return 0; }
  const path = typeof opts.db === 'string' ? opts.db : (io.env.DEXTERM_DB_PATH || defaultDbPath(io.env));
  if (path === ':memory:') { io.stderr.write('dexterm backtest: an in-memory DB has no history\n'); return 2; }
  const horizon = typeof opts.horizon === 'string' && HORIZONS.includes(Number(opts.horizon)) ? Number(opts.horizon) : 3600;
  const kind: BacktestKind = opts.subject === 'pack_verdicts' ? 'pack_verdicts' : 'heuristic';
  let db: DatabaseSync | null = null;
  try {
    db = openHistoryReadOnly(path);
    if (!db) { io.stderr.write(`dexterm backtest: no recorded history in ${path} (run the app with the recorder on first)\n`); return 2; }
    if (opts.subject === 'larp') {
      const r = larpEval(readLarpJoin(db, horizon));
      if (opts.json) io.stdout.write(JSON.stringify({ subject: 'larp', db: path, ...r }, null, 2) + '\n');
      else io.stdout.write(renderLarpEvalText(r, path));
      return 0;
    }
    const doc = exportRecorded(db, { labelledOnly: true });
    if (!doc.records.length) {
      io.stdout.write(`dexterm backtest: the recorder has no outcome-labelled snapshots yet at any horizon.\nLabels need the horizon (${horizon}s) to have elapsed and a sweep to have run. Check back after the recorder has observed tokens for at least that long.\n`);
      return 0;
    }
    const verdictDb = db;
    const verdictRugP = kind === 'pack_verdicts'
      ? (mint: string, t0: number): number | null => {
          try {
            const row = verdictDb.prepare('SELECT rug_p FROM verdicts WHERE mint = ? AND t <= ? ORDER BY t DESC LIMIT 1').get(mint, t0) as { rug_p: number | null } | undefined;
            return row && typeof row.rug_p === 'number' ? row.rug_p : null;
          } catch { return null; }
        }
      : undefined;
    const result = runBacktest(doc, {
      kind, horizon_sec: horizon,
      subject: kind === 'pack_verdicts' ? { verdictRugP } : { model: h1Model() },
    });
    const subjectLabel = kind === 'heuristic' ? h1Model().id : 'pack_verdicts';
    if (opts.json) io.stdout.write(JSON.stringify({ subject: subjectLabel, horizon_sec: horizon, labeler_version: doc.labeler_version, ...result }, null, 2) + '\n');
    else io.stdout.write(renderBacktestText(subjectLabel, horizon, doc.labeler_version, result));
    return 0;
  } catch (e) {
    io.stderr.write(`dexterm backtest: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

// Re-export so a consumer that wants the Label enum for a custom positive class has it in one place.
export type { Label };
