// task-1749 (strategy performance dashboard): the strategy-stats definitions over synthetic run ledgers. The rules are
// the challenge control's (control/report.mjs + mine.mjs): seeded bootstrap intervals pinned to the control's own
// numbers, write-offs of stuck bags, abandon-at-clean-stop, crash adoptions counted once, and the `<runId>/pN` adoption
// fix. When the challenge kit is checked out next to the app, the same fixtures go through its report.mjs as a parity
// check (skipped elsewhere, e.g. CI). Temp dirs only: no network, no model, no keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  meanCi, diffCi, wilsonCi, readStrategyLedgers, strategyRow, equityCurve, compareToBase, realizableUsd, decisionRule, MIN_CLOSED,
} from '../src/strategy-stats.ts';

const MIN = 60_000;
const T0 = 1_793_000_000_000;
type L = Record<string, unknown>;
function runs(files: Record<string, L[]>): string {
  const dir = mkdtempSync(join(tmpdir(), 'dash-1749-'));
  for (const [f, lines] of Object.entries(files)) writeFileSync(join(dir, f), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return dir;
}
const head = (member: string, t: number): L[] => [
  { kind: 'fleet_member', member, bankroll: { usd: 100, sol: 1 }, mode: 'paper', basedOn: { id: member, version: '1.0.0' }, t },
  { kind: 'run_start', strategy: member, mode: 'paper', t },
];
const buy = (id: string, mint: string, usd: number, t: number): L => ({ kind: 'fill', positionId: id, mint, side: 'buy', usd, reason: 'entry', profile: 'v3-swing', t });
const sell = (id: string, mint: string, usd: number, t: number): L => ({ kind: 'fill', positionId: id, mint, side: 'sell', usd, t });
const closed = (id: string, mint: string, cost: number, pnlUsd: number, opened: number, t: number, exitReason = 'tp'): L =>
  ({ kind: 'trade_closed', trade: { id, mint, symbol: mint.toUpperCase(), openedAt: opened, closedAt: t, costUsd: cost, pnlUsd, pnlPct: Math.round((pnlUsd / cost) * 1e4) / 100, exitReason, stuck: false }, t });

test('meanCi / diffCi / wilson reproduce the control (mine.mjs) numbers exactly', () => {
  const xs = [72.39, -100, 12.5, -35.2, 4.1, -90, 250];
  assert.deepEqual(meanCi(xs), { n: 7, mean: 16.255714285714284, lo: -56.44428571428572, hi: 100.68285714285715 });
  assert.deepEqual(diffCi(xs, [10, -20, 5, -60, 30]), { mean: 23.255714285714284, lo: -54.18571428571428, hi: 120.51142857142857 });
  assert.deepEqual(wilsonCi(2, 7), [0.08221716570901548, 0.6410709098517873]);
  assert.deepEqual(meanCi([]), { n: 0, mean: null, lo: null, hi: null });
});

test('closed trades, wins/losses, rugs, exits, ETA and the exploratory badge', () => {
  const dir = runs({ '20261027T000000Z-a-0001.jsonl': [...head('a', T0),
    { kind: 'candidate', mint: 'aaa', symbol: 'AAA', tick: { ageMin: 12, liq: 50_000, mcap: 90_000 }, t: T0 + 1 },
    buy('p1', 'aaa', 25, T0 + 2), sell('p1', 'aaa', 50, T0 + 60 * MIN), closed('p1', 'aaa', 25, 25, T0 + 2, T0 + 60 * MIN, 'tp'),
    buy('p2', 'bbb', 25, T0 + 61 * MIN), sell('p2', 'bbb', 2, T0 + 70 * MIN), closed('p2', 'bbb', 25, -23, T0 + 61 * MIN, T0 + 70 * MIN, 'rug-liquidity'),
    buy('p3', 'ccc', 25, T0 + 71 * MIN)] });
  const now = T0 + 2 * 86_400_000;
  const M = readStrategyLedgers(dir, { now });
  const r = strategyRow('a', M.a, { now });
  assert.equal(r.entries, 3); assert.equal(r.closed, 2); assert.equal(r.open, 1);
  assert.equal(r.wins, 1); assert.equal(r.losses, 1); assert.equal(r.rugs, 1); // -92% <= -80%
  assert.equal(r.meanPct, (100 + -92) / 2);
  assert.equal(r.sample, 'exploratory');
  assert.deepEqual(r.exits.map((e) => e.reason).sort(), ['rug-liquidity', 'tp']);
  assert.ok(Math.abs(r.entriesPerDay! - 1.5) < 1e-6); assert.ok(Math.abs(r.etaDays! - (MIN_CLOSED - 2) / 1.5) < 1e-4); // days since the first event (T0 + 1 ms)
  assert.equal(M.a.closed[0].entryAgeMin, 12); assert.equal(M.a.closed[0].symbol, 'AAA');
  assert.equal(M.a.startUsd, 100);
  const eq = equityCurve(M.a.closed, M.a.startUsd);
  assert.deepEqual(eq.points.map((p) => p.usd), [125, 102]);
  assert.equal(eq.maxDrawdownPct, 18.4); // 125 -> 102
});

test('a stuck bag is written off at its realizable value after 30 min; before that it is open and stuck', () => {
  const lines = [...head('w', T0), buy('p1', 'zzz', 20, T0), sell('p1', 'zzz', 5, T0 + MIN), { kind: 'stuck', positionId: 'p1', mint: 'zzz', reason: 'rug-liquidity', why: 'illiquid', t: T0 + 2 * MIN }];
  const dir = runs({ '20261027T000000Z-w-0001.jsonl': lines });
  const early = readStrategyLedgers(dir, { now: T0 + 20 * MIN }).w;
  assert.equal(early.open, 1); assert.equal(early.stuckOpen.length, 1); assert.equal(early.closed.length, 0);
  const late = readStrategyLedgers(dir, { now: T0 + 40 * MIN }).w;
  assert.equal(late.open, 0); assert.equal(late.closed.length, 1);
  const w = late.closed[0];
  assert.equal(w.writtenOff, true); assert.equal(w.held, true); assert.equal(w.pnlUsd, -15); assert.equal(w.pnlPct, -75); assert.equal(w.realizedUsd, 5);
  assert.match(w.reason!, /still held: stuck 38 min with no sell \(rug-liquidity \(illiquid\)\); unsold remainder valued 0/);
  assert.equal(strategyRow('w', late).rugs, 0); // a write-off is a rug only at <= -80%
});

test('a clean run end: a stuck bag is written off at once, a live one is abandoned (out of the sample)', () => {
  const dir = runs({ '20261027T000000Z-c-0001.jsonl': [...head('c', T0), buy('p1', 'aaa', 10, T0), { kind: 'stuck', positionId: 'p1', mint: 'aaa', reason: 'rug-liquidity', t: T0 + MIN },
    buy('p2', 'bbb', 10, T0 + 2 * MIN), { kind: 'run_end', t: T0 + 5 * MIN }] });
  const m = readStrategyLedgers(dir, { now: T0 + 6 * MIN }).c;
  assert.equal(m.entries, 2); assert.equal(m.open, 0); assert.equal(m.abandoned.length, 1); assert.equal(m.abandoned[0].mint, 'bbb');
  assert.equal(m.writtenOff.length, 1); assert.equal(m.closed[0].pnlPct, -100); assert.match(m.closed[0].reason!, /^dropped stuck at a clean run end/);
});

test('crash recovery: an adopted position counts once, by plain id (control) and by <runId>/pN (agent v4)', () => {
  // control form: the restart adopts `p1` and sells it under `p1`
  const plain = runs({
    '20261027T000000Z-k-0001.jsonl': [...head('k', T0), buy('p1', 'aaa', 10, T0)],
    '20261027T001000Z-k-0002.jsonl': [...head('k', T0 + 10 * MIN), { kind: 'position_adopted', positionId: 'p1', mint: 'aaa', position: { costUsd: 10, openedAt: T0 }, t: T0 + 10 * MIN },
      sell('p1', 'aaa', 12, T0 + 20 * MIN), closed('p1', 'aaa', 10, 2, T0, T0 + 20 * MIN)],
  });
  const k = readStrategyLedgers(plain, { now: T0 + 30 * MIN }).k;
  assert.equal(k.entries, 1); assert.equal(k.adopted, 1); assert.equal(k.closed.length, 1); assert.equal(k.abandoned.length, 0);
  // engine form seen live on agent v4: the adoption and its sells say `<runId>/p1`, and the new run numbers its own p1 again
  const run1 = '20261027T000000Z-v-0001';
  const slash = runs({
    [`${run1}.jsonl`]: [...head('v', T0), buy('p1', 'aaa', 10, T0)],
    '20261027T001000Z-v-0002.jsonl': [...head('v', T0 + 10 * MIN), { kind: 'position_adopted', positionId: `${run1}/p1`, mint: 'aaa', position: { id: `${run1}/p1`, costUsd: 10, openedAt: T0 }, t: T0 + 10 * MIN },
      { kind: 'candidate', mint: 'bbb', symbol: 'BBB', t: T0 + 11 * MIN }, buy('p1', 'bbb', 10, T0 + 12 * MIN),
      sell(`${run1}/p1`, 'aaa', 15, T0 + 20 * MIN), closed(`${run1}/p1`, 'aaa', 10, 5, T0, T0 + 20 * MIN), sell('p1', 'bbb', 9, T0 + 25 * MIN), closed('p1', 'bbb', 10, -1, T0 + 12 * MIN, T0 + 25 * MIN)],
  });
  const v = readStrategyLedgers(slash, { now: T0 + 30 * MIN }).v;
  assert.equal(v.entries, 2); assert.equal(v.closed.length, 2); assert.equal(v.abandoned.length, 0); assert.equal(v.open, 0);
  assert.deepEqual(v.closed.map((c) => c.pnlPct), [50, -10]);
});

test('compareToBase verdicts and the decision rule text', () => {
  const few = compareToBase('x', [1, 2], 'base', [3]);
  assert.equal(few.enough, false); assert.match(few.verdict, /^not yet: 2 \/ 1 closed \(needs 20 each\)/);
  const better = compareToBase('x', Array.from({ length: 20 }, (_, i) => 30 + (i % 3)), 'base', Array.from({ length: 20 }, (_, i) => -10 - (i % 3)));
  assert.equal(better.enough, true); assert.ok(better.diff.lo! > 0); assert.match(better.verdict, /passes/);
  assert.match(decisionRule('ctl-base-25'), /beats ctl-base-25 over >= 20 closed entries in BOTH/);
});

test('realizable value: the engine mark sold into half the pool, minus fees; unknown pool = null', () => {
  assert.equal(realizableUsd(10, null), null);
  const v = realizableUsd(100, 20_000)!; // impact 100/10100, then 2.3%, then $0.02
  assert.ok(Math.abs(v - (100 * (1 - 100 / 10_100) * (1 - 0.023) - 0.02)) < 1e-9);
});

// Parity with the challenge kit's report.mjs (only where the kit is checked out next to the app).
const KIT = resolve(fileURLToPath(import.meta.url), '../../../../../launch/send-out/challenge-100x/control/report.mjs');
test('parity: same rows as the control report.mjs on fixtures without a <runId>/pN adoption', { skip: !existsSync(KIT) && 'challenge kit not checked out here' }, async () => {
  const { readMembers, summarize } = await import(KIT);
  const now = T0 + 40 * MIN;
  const dir = runs({
    '20261027T000000Z-a-0001.jsonl': [...head('a', T0), buy('p1', 'aaa', 25, T0), closed('p1', 'aaa', 25, 10, T0, T0 + MIN), buy('p2', 'bbb', 25, T0 + 2 * MIN), { kind: 'stuck', positionId: 'p2', mint: 'bbb', reason: 'rug-liquidity', t: T0 + 3 * MIN }, buy('p3', 'ccc', 10, T0 + 4 * MIN)],
    '20261027T000500Z-a-0002.jsonl': [...head('a', T0 + 5 * MIN), { kind: 'position_adopted', positionId: 'p3', mint: 'ccc', position: { costUsd: 10 }, t: T0 + 5 * MIN }, sell('p3', 'ccc', 1, T0 + 6 * MIN), closed('p3', 'ccc', 10, -9, T0 + 4 * MIN, T0 + 6 * MIN, 'hard-stop'), { kind: 'run_end', t: T0 + 7 * MIN }],
  });
  const A = summarize(readMembers(dir, { now }), { now }).rows;
  const B = readStrategyLedgers(dir, { now });
  for (const a of A) {
    const b = strategyRow(a.id, B[a.id], { now });
    for (const k of ['entries', 'closed', 'open', 'writtenOff', 'stuckOpen', 'abandoned', 'adopted', 'wins', 'losses', 'rugs', 'meanPct', 'lo', 'hi', 'entriesPerDay', 'etaDays'] as const) assert.deepEqual(b[k], a[k], `${a.id} ${k}`);
  }
});
