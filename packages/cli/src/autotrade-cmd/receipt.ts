// `dexterm autotrade receipt …` (task-1645, 0.2.0 card A): what your executor did with a LIVE TRADE FIRE signal, as
// DATA only. A receipt never makes dexterm do anything: it moves a real-mode position from `unconfirmed` to
// executed / rejected / failed and measures the drift between the signal and the fill (ledger, Q screen, audit).
// Your executor can also append `dexterm-trade-receipt/1` lines to autotrade/real/receipts.jsonl itself.

import { dextermHome } from '@dexterm/custom';
import { Outbox, RECEIPT_SCHEMA, RECEIPT_STATUSES, appendReceipt, driftReport, readReceipts, receiptMismatch, type ReceiptStatus } from '@dexterm/autotrade';
import type { AutotradeIo } from '../autotrade-cmd.ts';
import { parseArgs } from './strategies.ts';

export const RECEIPT_USAGE = 'dexterm autotrade receipt <nonce|signal-id> executed|rejected|failed [--price USD] [--size-sol N] [--tokens N] [--tx SIGNATURE] [--reason TEXT] [--executor NAME] | receipt list [--json]';

export function receiptCmd(argv: string[], io: AutotradeIo, o: { now?: () => number } = {}): number {
  const { pos, opts } = parseArgs(argv, ['json']);
  const home = dextermHome(io.env);
  const now = o.now ?? Date.now;
  const ob = Outbox.open(home, { channels: [], noLock: true });
  if (pos[0] === 'list' || !pos.length) {
    const d = driftReport(ob.signals(), readReceipts(home).receipts, now());
    if (opts.json) { io.stdout.write(`${JSON.stringify(d, null, 2)}\n`); return 0; }
    if (!d.rows.length) { io.stdout.write('no trade-fire signals yet\n'); return 0; }
    io.stdout.write(`signals vs receipts · executed ${d.counts.executed} · rejected ${d.counts.rejected} · failed ${d.counts.failed} · unconfirmed ${d.unconfirmed}${d.orphanReceipts ? ` · ${d.orphanReceipts} orphan receipt(s) ignored` : ''}\n`);
    for (const r of d.rows.slice(-30)) io.stdout.write(`  #${r.nonce} ${r.side.toUpperCase()} ${r.symbol} ${r.signalSol} SOL · ${r.state}${r.filledSol !== null ? ` · filled ${r.filledSol} SOL (${r.sizeDriftPct}%)` : ''}${r.priceDriftPct !== null ? ` · price ${r.priceDriftPct}%` : ''}${r.conflict ? ' · CONFLICTING receipts' : ''}\n`);
    return 0;
  }
  const [ref, status] = pos;
  if (!RECEIPT_STATUSES.includes(status as ReceiptStatus)) { io.stderr.write(`usage: ${RECEIPT_USAGE}\n`); return 2; }
  const sig = /^\d+$/.test(ref) ? ob.get(Number(ref)) : ob.findById(ref);
  const num = (k: string): number | null | 'bad' => { if (opts[k] === undefined) return null; const v = Number(opts[k]); return Number.isFinite(v) && v > 0 ? v : 'bad'; };
  const price = num('price'), sizeSol = num('size-sol'), tokens = num('tokens');
  if (price === 'bad' || sizeSol === 'bad' || tokens === 'bad') { io.stderr.write('dexterm autotrade receipt: --price, --size-sol and --tokens are positive numbers\n'); return 2; }
  if (!sig) { io.stderr.write(`dexterm autotrade receipt: no signal ${JSON.stringify(ref)} in the outbox\n`); return 1; }
  const tx = typeof opts.tx === 'string' ? opts.tx : null;
  const fill = price !== null || sizeSol !== null || tokens !== null || tx ? { priceUsd: price, sizeSol, tokens, txSig: tx } : null;
  const r = { schema: RECEIPT_SCHEMA, signalId: sig.id, nonce: sig.nonce, accountId: sig.accountId, status: status as ReceiptStatus, at: now(), fill, reason: typeof opts.reason === 'string' ? opts.reason : null, executor: typeof opts.executor === 'string' ? opts.executor : null } as const;
  const why = receiptMismatch(r, sig);
  if (why) { io.stderr.write(`dexterm autotrade receipt: ${why}\n`); return 1; }
  try { appendReceipt(home, r); } catch (e) { io.stderr.write(`dexterm autotrade receipt: ${(e as Error).message}\n`); return 2; }
  io.stdout.write(`receipt recorded · #${sig.nonce} ${status} (data only: dexterm places nothing)\n`);
  return 0;
}
