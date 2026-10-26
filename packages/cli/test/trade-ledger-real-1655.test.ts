// task-1655 (0.2.0 integration, probe p1 finding F-a): a REAL-mode autotrade run's fills must never read "paper" in
// the unified trade ledger. They import as walletMode `real` (dexterm's model of the trades it signalled to the user's
// own executor), the `mode` filter takes `real`, and no PnL card is made for them (PAPER and LIVE stamps would both be
// wrong). A paper run still imports as paper. Offline: a hand-chained run file in a temp dir, made-up mint.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger, importRunLedger } from '@dexterm/autotrade';
import { WALLET_MODES } from '@dexterm/data/ledger';
import { ledgerCardInput, type LedgerCardRow } from '../src/pnl-card.ts';

const MINT = 'Fx7aBcDeFgHjJkLmNpPqRsTuVwXyZ123456789Apump';
const T0 = 1_792_400_000_000;

function runFile(dir: string, mode: 'paper' | 'real'): string {
  const l = new Ledger();
  l.add(T0, 'run_start', { runId: `r-${mode}`, strategy: 'scalp', version: '1.0.0', strategyHash: '0'.repeat(16), mode, decide: 'auto', executor: mode === 'real' ? 'real-signal' : 'sim' });
  l.add(T0 + 1_000, 'fill', { positionId: 'p1', mint: MINT, side: 'buy', reason: 'entry', usd: 50, tokens: 1_000_000, price: 0.00005, ...(mode === 'real' ? { nonce: 1, tag: 'real-signal' } : {}) });
  l.add(T0 + 60_000, 'fill', { positionId: 'p1', mint: MINT, side: 'sell', reason: 'tp1', usd: 60, tokens: 1_000_000, price: 0.00006, ...(mode === 'real' ? { nonce: 2, tag: 'real-signal' } : {}) });
  const p = join(dir, `${mode}.jsonl`);
  writeFileSync(p, l.events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return p;
}

const modesOf = (p: string, runId: string) => [...new Set(importRunLedger(p, runId).drafts.filter((d) => d.kind === 'fill').map((d) => (d as { walletMode: string }).walletMode))];

test('1655 F-a: a real-mode run imports as walletMode real, a paper run as paper', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-ledger-1655-'));
  try {
    assert.deepEqual(modesOf(runFile(dir, 'real'), 'r-real'), ['real']);
    assert.deepEqual(modesOf(runFile(dir, 'paper'), 'r-paper'), ['paper']);
    assert.ok(WALLET_MODES.includes('real'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('1655 F-a: no PnL card for a real-mode row (neither PAPER nor LIVE is true of it)', () => {
  const row: LedgerCardRow = {
    tradeId: 'run:r-real:p1', source: 'autotrade', walletMode: 'real', mint: MINT, symbol: 'FIXT', decimals: 6, runId: 'r-real', supply: null,
    fills: [{ t: T0, side: 'buy', sol: 0.3, usd: 50, tokens: 1_000_000, feeSol: null, txSig: null }, { t: T0 + 60_000, side: 'sell', sol: 0.36, usd: 60, tokens: 1_000_000, feeSol: null, txSig: null }],
  };
  assert.throws(() => ledgerCardInput(row), /real-mode trade: dexterm only modelled this fill/);
  assert.doesNotThrow(() => ledgerCardInput({ ...row, walletMode: 'paper' }));
});
