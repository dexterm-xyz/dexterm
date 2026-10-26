// task-1654 (0.2.0 card E): the `paper` scope of limits.json. Without it a paper run ignores the limits (exactly as
// before); with it, a paper forward test obeys the same guard as a real run, on its own in-memory state, and never
// touches real mode's files (it has no home: its state is the run's own, in memory). The recorded tape, the paper fill model only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadPreset } from '../src/strategy.ts';
import { loadTape } from '../src/replay.ts';
import { runAutotrade, simExecutor } from '../src/runner.ts';
import { effectiveLimits, emptyLimits } from '../src/limits.ts';
import { PaperLimitsExecutor } from '../src/paper-limits.ts';

const TAPE = loadTape(fileURLToPath(new URL('./fixtures/autotrade-1498-tape.json', import.meta.url)));
const SOL_USD = 200;

test('paper obeys the limits only with a paper scope: clamps, refusals and trips show what real mode would have done', async () => {
  const s = loadPreset('scalp');
  const base = await runAutotrade({ strategy: s, tape: TAPE, sessions: null });
  // No paper scope: nothing applies.
  assert.equal(effectiveLimits({ ...emptyLimits(), global: { perTradeSol: 0.01 } }, { strategyId: s.id, accountId: '-', mode: 'paper' }).applies, false);
  const e = effectiveLimits({ ...emptyLimits(), global: { perTradeSol: 0.1, dailyLossSol: 0.05, maxBuysPerMinute: null, executorSilenceMin: null }, modes: { paper: { maxOpenPositions: 1 } } }, { strategyId: s.id, accountId: '-', mode: 'paper' });
  assert.equal(e.applies, true);
  const trips: string[] = [];
  let book = s.bankroll.startUsd;
  const ex = new PaperLimitsExecutor({ inner: simExecutor(s.execution), limits: e.values, solUsd: () => SOL_USD, bookUsd: () => book, onTrip: (l) => trips.push(l) });
  const res = await runAutotrade({ strategy: s, tape: TAPE, sessions: null, executor: ex, onState: (st) => { book = st.book.equityUsd; } });
  const buys = res.ledger.events.filter((x) => x.kind === 'fill' && x.side === 'buy');
  assert.ok(buys.length >= 1);
  assert.ok(buys.every((b) => Number(b.usd) <= 0.1 * SOL_USD + 1e-9), 'perTradeSol 0.1 clamps every paper buy');
  assert.ok(res.refusals['fill-paper-limit-max-open'] >= 1, 'one open position at a time (the paper scope)');
  assert.ok(trips.some((l) => /^PAPER LIMIT: daily loss limit reached/.test(l)), trips.join('\n'));
  assert.ok(res.refusals['fill-paper-limit-daily-loss'] >= 1);
  assert.ok(base.trades.length > res.trades.length, 'fewer trades than the unlimited paper run');
});
