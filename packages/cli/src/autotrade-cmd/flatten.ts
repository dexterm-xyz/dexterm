// `dexterm autotrade flatten` (task-1509 AT-7, AUTOTRADE-SPEC §6.3). PAPER ONLY.
//
// A stop (no new entries, sessions closed, orders dropped), then every paper position sells at its next tick; one
// that cannot sell (a pulled pool) stays stuck and is retried every tick. The runner ends once nothing is held. It
// asks for a y keypress on a real terminal first, or takes `--yes` (selling only lowers risk; nothing here can buy,
// arm a mandate or sign). Nothing here touches a wallet, a key or the signer.

import { dextermHome } from '@dexterm/custom';
import { activeRunner } from '@dexterm/autotrade';
import type { AutotradeIo } from '../autotrade-cmd.ts';
import { parseArgs } from './strategies.ts';
import { sendControl, waitArg } from './stop.ts';

export const FLATTEN_USAGE = 'dexterm autotrade flatten [--strategy ID] [--yes] [--wait SEC] [--json]';

export interface FlattenOverrides { keypressTimeoutMs?: number }

export async function flattenCmd(argv: string[], io: AutotradeIo, over: FlattenOverrides = {}): Promise<number> {
  const { pos, opts } = parseArgs(argv, ['json', 'yes']);
  if (pos.length) { io.stderr.write(`usage: ${FLATTEN_USAGE}\n`); return 2; }
  const home = dextermHome(io.env);
  const member = typeof opts.strategy === 'string' ? opts.strategy : null;
  const r = activeRunner(home);
  if (!r) {
    if (opts.json) io.stdout.write(`${JSON.stringify({ requested: false, runId: null, why: 'no autotrade runner is running' })}\n`);
    else io.stdout.write('no autotrade runner is running; nothing to flatten.\n');
    return 0;
  }
  if (!opts.yes) {
    const stdin = io.stdin;
    if (!stdin || stdin.isTTY !== true) { io.stderr.write('dexterm autotrade flatten: confirm with y on a real terminal, or pass --yes\n'); return 2; }
    io.stdout.write(member ? `flatten strategy ${member} only: stop it, then sell its paper positions at their next tick (the other strategies keep running)? y to confirm, any other key cancels… `
      : `flatten run ${r.runId}: stop, then sell every paper position at its next tick (${r.positions} open)? y to confirm, any other key cancels… `);
    const { ttyKeypress } = await import('../wallet-cmd.ts');
    const key = await ttyKeypress(stdin, over.keypressTimeoutMs ?? 30_000);
    io.stdout.write('\n');
    if (key !== 'y' && key !== 'Y') { io.stdout.write('flatten cancelled; nothing was sold\n'); return 1; }
  }
  // task-1529: one strategy of a parallel run; the others keep running.
  if (member) return (await import('./strategy-control.ts')).memberStopCmd(io, member, 'flatten', opts);
  const res = await sendControl(io, 'flatten', waitArg(opts.wait), r);
  if ('error' in res) { io.stderr.write(`dexterm autotrade flatten: ${res.error}\n`); return 1; }
  if (opts.json) { io.stdout.write(`${JSON.stringify(res)}\n`); return 0; }
  io.stdout.write(`flatten ${res.already ? 'was already requested' : 'requested'} for run ${r.runId} (pid ${r.pid})\n`);
  if (!res.acknowledged) io.stdout.write('the runner has not confirmed yet: it reads the request on its next tick. Watch the Q screen, or run this again.\n');
  else if (res.ended) io.stdout.write('✓ flat: the runner sold what it held and stopped\n');
  else io.stdout.write(`✓ flattening: no new entries, sessions closed; ${res.positions} paper position${res.positions === 1 ? '' : 's'} sell${res.positions === 1 ? 's' : ''} at the next tick (a stuck one is retried every tick)\n`);
  return 0;
}
