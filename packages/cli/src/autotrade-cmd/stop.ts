// `dexterm autotrade stop` (task-1509 AT-7, AUTOTRADE-SPEC §6.3). PAPER ONLY.
//
// A soft stop of the running paper runner: no new entries, every session closed, pending orders dropped, and the
// mechanical exits (stops, take-profits, trails, rug exits) keep running until nothing is held; then the runner
// ends. It writes a request for that run into $DEXTERM_HOME/autotrade/control.json, which the runner re-reads on every
// step, and waits a few seconds for the runner to confirm through its rendezvous. A stop is final for the run.
// `dexterm wallet panic` is the harder switch: every paper desk and signer re-reads it, and only
// `dexterm wallet resume` on a real terminal lifts it. Nothing here touches a wallet, a key or the signer.

import { dextermHome } from '@dexterm/custom';
import { activeRunner, requestControl, type ActiveRunner, type ControlAction } from '@dexterm/autotrade';
import type { AutotradeIo } from '../autotrade-cmd.ts';
import { parseArgs } from './strategies.ts';

export const STOP_USAGE = 'dexterm autotrade stop [--strategy ID] [--wait SEC] [--json]';

const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** True once the runner shows the request in its rendezvous (or is gone). */
function acknowledged(r: ActiveRunner | null, runId: string, action: ControlAction): boolean {
  if (!r || r.runId !== runId) return true;
  if (r.state === 'stopped') return true;
  return action === 'flatten' ? r.haltReason === 'flatten' : r.haltReason !== null && r.state === 'halted';
}

export interface ControlOutcome { requested: boolean; runId: string | null; acknowledged: boolean; already: boolean; positions: number; sessions: number; ended: boolean }

/** Send stop or flatten to the active runner and wait up to waitSec for it to confirm. */
export async function sendControl(io: AutotradeIo, action: 'stop' | 'flatten', waitSec: number, runner: ActiveRunner): Promise<ControlOutcome | { error: string }> {
  const home = dextermHome(io.env);
  const w = requestControl(home, runner.runId, action, 'cli');
  if (!w.ok) return { error: w.why };
  const until = Date.now() + Math.max(0, waitSec) * 1000;
  let cur: ActiveRunner | null = activeRunner(home);
  while (!acknowledged(cur, runner.runId, action) && Date.now() < until) { await tick(200); cur = activeRunner(home); }
  const same = cur && cur.runId === runner.runId ? cur : null;
  return { requested: true, runId: runner.runId, acknowledged: acknowledged(cur, runner.runId, action), already: w.already, positions: same ? same.positions : 0, sessions: same ? same.sessions : 0, ended: !same || same.state === 'stopped' };
}

export function waitArg(v: string | true | undefined): number {
  const n = typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 120) : 10;
}

export async function stopCmd(argv: string[], io: AutotradeIo): Promise<number> {
  const { pos, opts } = parseArgs(argv, ['json']);
  if (pos.length) { io.stderr.write(`usage: ${STOP_USAGE}\n`); return 2; }
  // task-1529: one strategy of a parallel run; the others keep running.
  if (typeof opts.strategy === 'string') return (await import('./strategy-control.ts')).memberStopCmd(io, opts.strategy, 'stop', opts);
  const home = dextermHome(io.env);
  const r = activeRunner(home);
  if (!r) {
    if (opts.json) io.stdout.write(`${JSON.stringify({ requested: false, runId: null, why: 'no autotrade runner is running' })}\n`);
    else io.stdout.write('no autotrade runner is running; nothing to stop. (`dexterm wallet panic` halts every paper desk and signer.)\n');
    return 0;
  }
  const res = await sendControl(io, 'stop', waitArg(opts.wait), r);
  if ('error' in res) { io.stderr.write(`dexterm autotrade stop: ${res.error}\n`); return 1; }
  if (opts.json) { io.stdout.write(`${JSON.stringify(res)}\n`); return 0; }
  io.stdout.write(`stop ${res.already ? 'was already requested' : 'requested'} for run ${r.runId} (pid ${r.pid})\n`);
  if (!res.acknowledged) io.stdout.write('the runner has not confirmed yet: it reads the request on its next tick. Watch the Q screen, or run this again.\n');
  else if (res.ended) io.stdout.write('✓ the runner stopped (nothing was held)\n');
  else io.stdout.write(`✓ halted: no new entries, sessions closed, orders dropped${res.positions ? `; ${res.positions} paper position${res.positions === 1 ? '' : 's'} keep${res.positions === 1 ? 's' : ''} its mechanical exits until closed (\`dexterm autotrade flatten\` sells now)` : ''}\n`);
  return 0;
}
