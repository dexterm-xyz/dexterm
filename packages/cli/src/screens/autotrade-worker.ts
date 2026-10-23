// dexterm — AUTOTRADE screen backtests off the render loop (task-1508). A lockstep backtest over two weeks of
// recorded history is CPU-bound for seconds and a sweep for much longer, so the Q screen runs them in a worker
// thread: the worker opens the recorder DB read-only, builds the tape once, runs the engine and posts the
// report back. PAPER, recorded data only: no network, no model, no keys. The same module is the worker entry
// (it checks workerData) and the main-thread client (workerJobs). Tests use inlineJobs over a fixture tape.

import { existsSync } from 'node:fs';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { defaultDbPath } from '@dexterm/data';
import { openHistoryReadOnly } from '@dexterm/recorder';
import { backtest, sweep, tapeFromDb, tapeFromDoc, type Grid, type ResolvedStrategy, type SweepResult, type Tape } from '@dexterm/autotrade';
import type { BacktestJobs, BacktestOutcome } from './autotrade-ui.ts';

const DAY_MS = 86_400_000;
/** The equity curve is resampled to this many points before it crosses the thread boundary (it feeds a sparkline). */
const CURVE_POINTS = 240;

type Job =
  | { kind: 'backtest'; strategies: ResolvedStrategy[]; days: number; until: number; dbPath: string }
  | { kind: 'sweep'; strategy: ResolvedStrategy; grid: Grid; days: number; until: number; dbPath: string };
const TAG = 'dexterm-autotrade-job/1';

function resample(xs: number[], n: number): number[] {
  if (xs.length <= n) return xs;
  return Array.from({ length: n }, (_, i) => xs[Math.round((i * (xs.length - 1)) / (n - 1))]);
}

/** The recorder's history as a tape, read-only (the same window rules as `dexterm autotrade backtest --days N`). */
export function tapeFromRecorder(dbPath: string, days: number, until: number): Tape {
  const none = `no recorded history in ${dbPath} (run the app with the recorder on first)`;
  if (!existsSync(dbPath)) throw new Error(none);
  let db: ReturnType<typeof openHistoryReadOnly>;
  try { db = openHistoryReadOnly(dbPath); } catch { throw new Error(none); }
  if (!db) throw new Error(none);
  try { return tapeFromDoc(tapeFromDb(db, { since: until - days * DAY_MS, until, minPeakLiqUsd: 20_000, spanHours: 80 })); }
  finally { db.close(); }
}

export async function backtestOn(tape: Tape, ss: ResolvedStrategy[]): Promise<BacktestOutcome[]> {
  const out: BacktestOutcome[] = [];
  for (const s of ss) {
    const { report, run } = await backtest(s, tape);
    out.push({ report, curve: resample(run.equityCurve.map((p) => p.equity), CURVE_POINTS) });
  }
  return out;
}

/** Jobs that run on the calling thread over a tape the caller supplies (tests, over a committed fixture tape). */
export function inlineJobs(tape: () => Tape): BacktestJobs {
  return {
    backtest: async (ss) => backtestOn(tape(), ss),
    sweep: async (s, grid) => sweep(s, tape(), grid),
  };
}

/** Jobs in a worker thread over the recorder DB (the app). One worker per job; it exits when done. */
export function workerJobs(env: NodeJS.ProcessEnv = process.env): BacktestJobs {
  const dbPath = env.DEXTERM_DB_PATH || defaultDbPath(env);
  const run = <T,>(job: Job): Promise<T> => new Promise<T>((resolve, reject) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { tag: TAG, job } });
    w.unref();
    w.once('message', (m: { ok: true; value: T } | { ok: false; error: string }) => { if (m.ok) resolve(m.value); else reject(new Error(m.error)); });
    w.once('error', reject);
    w.once('exit', (code) => { if (code !== 0) reject(new Error(`backtest worker exited with code ${code}`)); });
  });
  return {
    backtest: (strategies, o) => run<BacktestOutcome[]>({ kind: 'backtest', strategies, days: o.days, until: o.until, dbPath }),
    sweep: (strategy, grid, o) => run<SweepResult>({ kind: 'sweep', strategy, grid, days: o.days, until: o.until, dbPath }),
  };
}

// ───────────────────────────── worker entry ─────────────────────────────

if (!isMainThread && parentPort && (workerData as { tag?: string } | null)?.tag === TAG) {
  const job = (workerData as { job: Job }).job;
  const port = parentPort;
  void (async () => {
    try {
      const tape = tapeFromRecorder(job.dbPath, job.days, job.until);
      const value = job.kind === 'backtest' ? await backtestOn(tape, job.strategies) : await sweep(job.strategy, tape, job.grid);
      port.postMessage({ ok: true, value });
    } catch (e) {
      port.postMessage({ ok: false, error: (e as Error).message ?? String(e) });
    }
  })();
}
