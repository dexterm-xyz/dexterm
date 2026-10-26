// `dexterm autotrade audit [<run>|--last] [--verify]` (task-1509 AT-7, AUTOTRADE-SPEC §6.4). PAPER ONLY. Read-only.
//
// Lists the run ledgers under $DEXTERM_HOME/autotrade/runs/, and with --verify recomputes each hash chain (every line's
// hash covers the previous hash and its own content) and checks it against the run's summary, so an edited, added,
// dropped, reordered or cut-off line is named with its event number. Exit 1 when any checked run is broken.

import { dextermHome } from '@dexterm/custom';
import { existsSync } from 'node:fs';
import { Outbox, allOutboxSignals, auditRun, divergenceLines, divergenceReport, driftReport, listRunIds, outboxPath, readReceipts, type DivergenceSummary, type DriftReport, type RunAudit } from '@dexterm/autotrade';
import type { AutotradeIo } from '../autotrade-cmd.ts';
import { parseArgs } from './strategies.ts';

export const AUDIT_USAGE = 'dexterm autotrade audit [<run-id>|--last] [--verify] [--json]';

function line(a: RunAudit, verify: boolean): string {
  const strat = a.strategy ? `${a.strategy.id} v${a.strategy.version}` : '?';
  const state = a.running ? 'running' : a.ended ? 'ended' : 'no run_end (crashed or cut short)';
  if (!verify) return `  ${a.runId}  ${strat}  ${a.events} events  ${state}`;
  if (a.ok) return `✓ ${a.runId}  ${strat}  ${a.events} events  head ${a.head}  ${state}${a.summary ? '' : '  (no summary)'}`;
  return `✗ ${a.runId}  ${strat}  broken at event ${a.brokenAt}: ${a.error}`;
}

export async function auditCmd(argv: string[], io: AutotradeIo): Promise<number> {
  const { pos, opts } = parseArgs(argv, ['verify', 'json', 'last']);
  if (pos.length > 1) { io.stderr.write(`usage: ${AUDIT_USAGE}\n`); return 2; }
  const home = dextermHome(io.env);
  const all = listRunIds(home);
  let ids = all;
  if (pos[0]) {
    const want = pos[0].replace(/\.jsonl$/, '');
    if (!all.includes(want)) { io.stderr.write(`dexterm autotrade audit: no run ledger ${JSON.stringify(want)} under autotrade/runs/\n`); return 1; }
    ids = [want];
  } else if (opts.last) ids = all.slice(-1);
  const verify = !!opts.verify;
  const audits = ids.map((id) => auditRun(home, id));
  const broken = verify ? audits.filter((a) => !a.ok) : [];
  // task-1645: real mode: the drift between the trade-fire signals and the executor's receipts.
  let real: Omit<DriftReport, 'rows'> | null = null;
  // task-1654: paper vs real: each receipted fill against dexterm's own paper fill (every outbox file, archives too).
  let divergence: DivergenceSummary | null = null;
  if (existsSync(outboxPath(home))) {
    const receipts = readReceipts(home).receipts;
    const { rows: _rows, ...rest } = driftReport(Outbox.open(home, { channels: [], noLock: true }).signals(), receipts, Date.now());
    real = rest;
    const { rows: _r2, ...dv } = divergenceReport(allOutboxSignals(home), receipts);
    divergence = dv;
  }
  if (opts.json) {
    io.stdout.write(`${JSON.stringify({ verified: verify, runs: audits, broken: broken.length, ...(real ? { realSignals: real } : {}), ...(divergence ? { paperVsReal: divergence } : {}) }, null, 2)}\n`);
    return broken.length ? 1 : 0;
  }
  if (!audits.length) { io.stdout.write('no autotrade runs yet (ledgers live in autotrade/runs/ under your dexterm home)\n'); return 0; }
  io.stdout.write(`${verify ? 'verifying' : 'runs'} (${audits.length}) · ledgers in autotrade/runs/ · paper and live runs\n`);
  for (const a of audits) io.stdout.write(`${line(a, verify)}\n`);
  if (verify) io.stdout.write(broken.length ? `${broken.length} broken ledger${broken.length === 1 ? '' : 's'}: the lines from that event on cannot be trusted\n` : 'every chain verifies\n');
  else io.stdout.write('add --verify to recompute the hash chains\n');
  if (real) io.stdout.write(`real-mode signals vs receipts · executed ${real.counts.executed} · rejected ${real.counts.rejected} · failed ${real.counts.failed} · unconfirmed ${real.unconfirmed}${real.sizeDrift ? ` · size drift on ${real.sizeDrift}` : ''}${real.orphanReceipts ? ` · ${real.orphanReceipts} orphan receipt(s)` : ''} (dexterm autotrade receipt list)\n`);
  if (divergence?.receipted) for (const l of divergenceLines(divergence)) io.stdout.write(`${l}\n`);
  return broken.length ? 1 : 0;
}
