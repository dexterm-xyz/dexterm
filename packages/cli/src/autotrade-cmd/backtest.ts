// `dexterm autotrade backtest|sweep|extract` (task-1503 AT-1, AUTOTRADE-SPEC §3/§3a). PAPER, recorded data only:
// the recorder DB is opened read-only, fills are modelled, no network, no model, no keys. Mechanical entries
// (`auto`): the agent's judgement is what the runner card measures, so a backtest never spawns a session.

import { dextermHome } from '@dexterm/custom';
import { defaultDbPath } from '@dexterm/data';
import { openHistoryReadOnly } from '@dexterm/recorder';
import {
  backtest, backtestEvidence, everyCandidate, recordBacktestEvidence, renderHeldOut, fmtIssue, loadTape, renderRecall, renderReport, renderSweep, renderYoloReplay, builtinTapePath, runnerRecall, saveTape, sweep, tapeFromDb, tapeFromDoc, yoloReplay,
  type Grid, type ResolvedStrategy, type Tape,
} from '@dexterm/autotrade';
import type { AutotradeIo } from '../autotrade-cmd.ts';
import { parseArgs, resolveStrategyArg, storeFor } from './strategies.ts';

const BOOL = ['json', 'every-candidate', 'no-held-out'];

function strategyFrom(pos: string[], opts: Record<string, string | true>, io: AutotradeIo, usage: string, anyMode = false): ResolvedStrategy | null {
  const arg = typeof opts.strategy === 'string' ? opts.strategy : pos[0];
  const r = resolveStrategyArg(arg, io);
  if (!r) { io.stderr.write(`usage: ${usage}\n`); return null; }
  for (const w of r.warnings) io.stderr.write(`warning ${fmtIssue(w)}\n`);
  if (!r.ok) { for (const e of r.errors) io.stderr.write(`error ${fmtIssue(e)}\n`); return null; }
  if (r.strategy.mode !== 'paper' && !anyMode) { io.stderr.write(`dexterm autotrade: ${r.strategy.id} is mode "${r.strategy.mode}": autotrade runs paper only\n`); return null; }
  return r.strategy;
}

function numOpt(opts: Record<string, string | true>, k: string, dflt: number): number {
  const v = opts[k];
  const n = typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : dflt;
}

/**
 * `dexterm autotrade yolo-replay <id|file>` (task-1532): a full-port paper replay of a strategy (a live-mode copy too:
 * the replay always runs a paper copy) over recorded history, with the rugs, the loss spread and how often a run of
 * entries zeroed the wallet. Read-only: recorded data, modelled fills, no network, no model, no keys.
 */
export async function yoloReplayCmd(argv: string[], io: AutotradeIo): Promise<number> {
  const { pos, opts } = parseArgs(argv, ['json']);
  const usage = 'dexterm autotrade yolo-replay <id|file> [--tape FILE | --db PATH [--days N | --since T] [--until T]] [--seed N] [--json]';
  const s = strategyFrom(pos, opts, io, usage, true);
  if (!s) return 2;
  const tape = tapeFrom(opts, io);
  if (!tape) return 2;
  const r = await yoloReplay(s, tape, { seed: numOpt(opts, 'seed', 1) });
  io.stdout.write(opts.json ? JSON.stringify(r, null, 2) + '\n' : renderYoloReplay(r) + '\n');
  return 0;
}

/** `--since/--until`: epoch ms or an ISO time (pins a backtest to the exact tape window of an earlier run). */
function timeOpt(v: string | true | undefined): number | undefined {
  if (typeof v !== 'string') return undefined;
  const n = /^\d+$/.test(v) ? Number(v) : Date.parse(v);
  return Number.isFinite(n) ? n : undefined;
}

/** The recorder DB, read-only; null when it is missing, in memory, or not a recorder DB. */
function openDb(path: string): ReturnType<typeof openHistoryReadOnly> {
  if (path === ':memory:') return null;
  try { return openHistoryReadOnly(path); } catch { return null; }
}

/** A tape from --tape FILE, else read-only from the recorder DB (--db, DEXTERM_DB_PATH, the default path). */
export function tapeFrom(opts: Record<string, string | true>, io: AutotradeIo): Tape | null {
  if (typeof opts.tape === 'string') {
    try { return loadTape(builtinTapePath(opts.tape)); } catch (e) { io.stderr.write(`dexterm autotrade: ${(e as Error).message}\n`); return null; }
  }
  const path = typeof opts.db === 'string' ? opts.db : (io.env.DEXTERM_DB_PATH || defaultDbPath(io.env));
  const db = openDb(path);
  if (!db) { io.stderr.write(`dexterm autotrade: no recorded history in ${path} (run the app with the recorder on first, or pass --tape FILE)\n`); return null; }
  try {
    const days = numOpt(opts, 'days', 0);
    return tapeFromDoc(tapeFromDb(db, {
      since: timeOpt(opts.since) ?? (days > 0 ? Date.now() - days * 86_400_000 : undefined),
      until: timeOpt(opts.until),
      minPeakLiqUsd: numOpt(opts, 'min-peak-liq', 20_000),
      spanHours: numOpt(opts, 'span-hours', 80),
    }));
  } finally { db.close(); }
}

export async function backtestCmd(argv: string[], io: AutotradeIo): Promise<number> {
  const { pos, opts } = parseArgs(argv, BOOL);
  const usage = 'dexterm autotrade backtest <id|file> [--tape FILE | --db PATH] [--days N | --since T] [--until T] [--every-candidate [--unit-usd 20]] [--recall 5,10] [--no-held-out] [--json]';
  const arg = typeof opts.strategy === 'string' ? opts.strategy : pos[0];
  const s0 = strategyFrom(pos, opts, io, usage);
  if (!s0) return 2;
  const tape = tapeFrom(opts, io);
  if (!tape) return 2;
  const s = opts['every-candidate'] ? everyCandidate(s0, numOpt(opts, 'unit-usd', 20)) : s0;
  const { report, run } = await backtest(s, tape);
  const recallAt = typeof opts.recall === 'string' ? opts.recall.split(',').map(Number).filter((x) => Number.isFinite(x) && x > 1) : [];
  const recall = recallAt.length ? runnerRecall(s, tape, run, recallAt) : null;
  if (!opts['every-candidate']) {
    try { storeFor(io).recordBacktest({ hash: s.hash, t: Date.now(), trades: report.trades, netUsd: report.netUsd, netPct: report.netPct, maxDrawdownPct: report.maxDrawdownPct, tape: `${report.tape.mints} coins ${report.tape.from ?? ''}..${report.tape.to ?? ''}` }); } catch { /* the line is a convenience for `list`; never fail a backtest on it */ }
  }
  // task-1647: a stored strategy's backtest is journey evidence: the same rules on each half of the held-out split.
  let evidence: Awaited<ReturnType<typeof backtestEvidence>>['evidence'] | null = null;
  const stored = !!arg && !opts['every-candidate'] && !opts['no-held-out'] && storeFor(io).get(arg)?.ok === true && arg === s.id;
  if (stored) {
    const days = numOpt(opts, 'days', 0);
    evidence = (await backtestEvidence(s, tape, { by: 'user', days: days > 0 ? days : null, full: { report, run } })).evidence;
    try { recordBacktestEvidence(dextermHome(io.env), evidence); } catch (e) { io.stderr.write(`warning: the journey record was not written (${(e as Error).message})\n`); }
  }
  if (opts.json) { io.stdout.write(JSON.stringify({ ...report, ...(recall ? { recall } : {}), ...(evidence ? { heldOut: evidence.heldOut, evidence: { verdict: evidence.verdict, claim: evidence.claim, rulesHash: evidence.rulesHash } } : {}) }, null, 2) + '\n'); return 0; }
  io.stdout.write(renderReport(report) + '\n');
  if (evidence) io.stdout.write(renderHeldOut(evidence).join('\n') + `\n  journey: recorded as the backtest of ${s.id} v${s.version} (dexterm autotrade journey ${s.id})\n`);
  if (opts['every-candidate']) io.stdout.write(`  every-candidate copy of ${s0.id}: each candidate entered at $${numOpt(opts, 'unit-usd', 20)} with the book caps lifted (an evaluation, not a strategy to run)\n`);
  if (recall) io.stdout.write(renderRecall(recall, s) + '\n');
  io.stdout.write('  Paper only, recorded data, not financial advice. A backtest is not a forecast.\n');
  return 0;
}

export async function sweepCmd(argv: string[], io: AutotradeIo): Promise<number> {
  const { pos, opts } = parseArgs(argv, BOOL);
  const usage = 'dexterm autotrade sweep <id|file> [--tape FILE | --db PATH] [--grid JSON] [--mode grid|random] [--max N] [--seed N] [--test-frac 0.3] [--json]';
  const s0 = strategyFrom(pos, opts, io, usage);
  if (!s0) return 2;
  let grid: Grid;
  try {
    grid = typeof opts.grid === 'string' ? JSON.parse(opts.grid) as Grid : defaultGrid(s0);
    if (!grid || typeof grid !== 'object' || !Object.values(grid).every((v) => Array.isArray(v) && v.every((x) => typeof x === 'number'))) throw new Error('the grid maps parameter paths to arrays of numbers');
  } catch (e) { io.stderr.write(`dexterm autotrade: --grid: ${(e as Error).message}\n`); return 2; }
  const tape = tapeFrom(opts, io);
  if (!tape) return 2;
  const s = opts['every-candidate'] ? everyCandidate(s0, numOpt(opts, 'unit-usd', 20)) : s0;
  let r;
  try {
    r = await sweep(s, tape, grid, { mode: opts.mode === 'random' ? 'random' : 'grid', max: numOpt(opts, 'max', 64), seed: numOpt(opts, 'seed', 1), testFrac: numOpt(opts, 'test-frac', 0.3) });
  } catch (e) { io.stderr.write(`dexterm autotrade: ${(e as Error).message}\n`); return 2; }
  io.stdout.write(opts.json ? JSON.stringify(r, null, 2) + '\n' : renderSweep(r) + '\n  Paper only, recorded data, not financial advice.\n');
  return 0;
}

/** A small default grid on the default exit profile's own knobs (only the ones the profile has). */
export function defaultGrid(s: ResolvedStrategy): Grid {
  const p = s.exits.profiles[s.exits.default];
  const g: Grid = {};
  if (p.trailingStop) g['profile.trailingStop.trailPct'] = [15, 25, 35];
  if (p.tpLadder.length) g['profile.tpLadder.0.atPct'] = [30, 50, 80];
  if (p.costRecovery) g['profile.costRecovery.atPct'] = [60, 100, 150];
  if (p.bagTrail) g['profile.bagTrail.trailPct'] = [35, 55, 75];
  if (s.sizing.mode === 'pct' && s.sizing.pct !== undefined) g['sizing.pct'] = [s.sizing.pct / 2, s.sizing.pct].map((x) => Math.round(x * 10) / 10);
  return g;
}

export function extractCmd(argv: string[], io: AutotradeIo): number {
  const { opts } = parseArgs(argv);
  if (typeof opts.out !== 'string') { io.stderr.write('usage: dexterm autotrade extract --out FILE [--db PATH] [--max-mints N] [--min-peak-liq USD] [--span-hours H]\n'); return 2; }
  const path = typeof opts.db === 'string' ? opts.db : (io.env.DEXTERM_DB_PATH || defaultDbPath(io.env));
  const db = openDb(path);
  if (!db) { io.stderr.write(`dexterm autotrade: no recorded history in ${path}\n`); return 2; }
  try {
    const doc = tapeFromDb(db, { maxMints: typeof opts['max-mints'] === 'string' ? Number(opts['max-mints']) : undefined, minPeakLiqUsd: numOpt(opts, 'min-peak-liq', 20_000), spanHours: numOpt(opts, 'span-hours', 80) });
    saveTape(opts.out, doc);
    io.stdout.write(`wrote ${opts.out}: ${doc.mints.length} coins, ${doc.mints.reduce((a, m) => a + m.rows.length, 0)} rows (recorded market data only)\n`);
    return 0;
  } finally { db.close(); }
}
