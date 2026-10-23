// `dexterm autotrade requests list|run|dismiss` (task-1530): the user's side of the MCP `backtest_request` tool. An
// agent can only FILE a request ($DEXTERM_HOME/autotrade/requests/<id>.json); nothing runs until the user runs it here.
// `run` is the ordinary `dexterm autotrade backtest <id> --days N` on the recorded history (paper, no network, no
// model), and its one-line result is written back so the agent reads it with `backtest_requests`.

import { BacktestRequests, isRequestId, type BacktestRequest } from '@dexterm/mcp';
import { dextermHomeDir } from '@dexterm/data/ledger';
import type { AutotradeIo } from '../autotrade-cmd.ts';
import { backtestCmd } from './backtest.ts';

const USAGE = 'dexterm autotrade requests [list [--all] [--json] | run <br_id> | dismiss <br_id>]';

const when = (t: number): string => new Date(t).toISOString().slice(0, 16).replace('T', ' ');

function line(r: BacktestRequest): string {
  const head = `${r.requestId}  ${r.status.padEnd(9)} ${when(r.createdAt)}  ${r.id}${r.version ? `@${r.version}` : ''} · ${r.days}d${r.everyCandidate ? ' · every candidate' : ''} · by ${r.actor}`;
  return `${head}\n    why: ${r.why}${r.result ? `\n    result: ${r.result}` : ''}`;
}

export async function requestsCmd(argv: string[], io: AutotradeIo): Promise<number> {
  const files = new BacktestRequests(dextermHomeDir(io.env));
  const sub = argv[0] ?? 'list';
  if (sub === 'list') {
    const all = argv.includes('--all');
    const rows = files.list(all ? {} : { status: 'pending' });
    if (argv.includes('--json')) { io.stdout.write(`${JSON.stringify({ requests: rows })}\n`); return 0; }
    if (!rows.length) { io.stdout.write(all ? 'no backtest requests\n' : 'no pending backtest requests (--all shows the resolved ones)\n'); return 0; }
    for (const r of rows) io.stdout.write(`${line(r)}\n`);
    io.stdout.write('\nAn agent filed these; nothing ran. `dexterm autotrade requests run <id>` runs one (paper, recorded data); `dismiss <id>` drops it.\n');
    return 0;
  }
  if (sub !== 'run' && sub !== 'dismiss') { io.stderr.write(`dexterm autotrade requests: unknown action ${JSON.stringify(sub)}\n  ${USAGE}\n`); return 2; }
  const id = argv[1];
  if (!isRequestId(id)) { io.stderr.write(`dexterm autotrade requests ${sub}: pass a request id (br_…, from \`dexterm autotrade requests\`)\n`); return 2; }
  const r = files.get(id);
  if (!r) { io.stderr.write(`dexterm autotrade requests: no request ${id}\n`); return 2; }
  if (r.status !== 'pending') { io.stderr.write(`dexterm autotrade requests: ${id} is already ${r.status}\n`); return 2; }
  if (sub === 'dismiss') {
    files.resolve(id, 'dismissed', 'dismissed by the user');
    io.stdout.write(`${id} dismissed\n`);
    return 0;
  }
  // run: the ordinary backtest, its JSON captured for the one-line result, the human report shown after
  let out = '';
  let err = '';
  const args = [r.id, '--days', String(r.days), ...(r.everyCandidate ? ['--every-candidate'] : []), '--json'];
  const rc = await backtestCmd(args, { ...io, stdout: { write: (s: string) => { out += s; return true; } }, stderr: { write: (s: string) => { err += s; return true; } } });
  if (rc !== 0) {
    const why = err.trim().split('\n')[0] || `the backtest exited ${rc}`;
    files.resolve(id, 'failed', why);
    io.stderr.write(`${id} failed: ${why}\n`);
    return rc;
  }
  let result: string;
  try {
    const rep = JSON.parse(out) as { trades?: number; netUsd?: number; netPct?: number; maxDrawdownPct?: number; winRate?: { value: number; lo: number; hi: number } | null; strategy?: { version?: unknown; hash?: unknown } };
    const wr = rep.winRate ? `${rep.winRate.value}% (95% ${rep.winRate.lo}–${rep.winRate.hi}%)` : '—';
    result = `paper backtest ${r.days}d: ${rep.trades ?? 0} trades · win ${wr} · net $${(rep.netUsd ?? 0).toFixed(2)} (${rep.netPct ?? 0}%) · max drawdown ${rep.maxDrawdownPct ?? 0}%`;
  } catch {
    result = 'the backtest ran but its report was not readable JSON';
  }
  files.resolve(id, 'done', result);
  io.stdout.write(`${id} done: ${result}\n  (the agent reads this with backtest_requests; the full report: \`dexterm autotrade backtest ${r.id} --days ${r.days}\`)\n`);
  return 0;
}
