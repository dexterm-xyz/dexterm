// task-1472 — the one chart formatter: lowercase k, then M/B/T, one decimal below 10 of the unit and none after,
// unit promoted after rounding, subscript form below 1, never scientific notation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtCompact, fmtCompactUsd, compactDecimalsFor } from '../src/index.ts';

test('fmtCompact: the card cases (999, 1k, 4.9k, 42k, 1M edge, 1.2B)', () => {
  const cases: Array<[number, string]> = [
    [999, '999'], [1000, '1k'], [4930, '4.9k'], [42_100, '42k'], [487_000, '487k'], [999_900, '1M'], [1.2e9, '1.2B'],
    [1_230_000, '1.2M'], [48_000_000, '48M'], [1.3e9, '1.3B'], [9_960, '10k'], [9_949, '9.9k'], [99_960, '100k'],
    [999_499, '999k'], [999_500, '1M'], [1_000_000, '1M'], [2.5e12, '2.5T'], [3.2e15, '3200T'],
    [1, '1'], [4.93, '4.9'], [12.34, '12'], [950, '950'], [-4930, '-4.9k'],
  ];
  for (const [n, want] of cases) assert.equal(fmtCompact(n), want, String(n));
});

test('fmtCompact: tiny, zero and missing values; never scientific notation, never a long run of zeros', () => {
  assert.equal(fmtCompact(0), '0');
  assert.equal(fmtCompact(0.42), '0.42');
  assert.equal(fmtCompact(0.5), '0.5');
  assert.equal(fmtCompact(4.93e-6), '0.0₅493');
  assert.equal(fmtCompact(1.2e-10), '0.0₉12');
  assert.equal(fmtCompact(null), '—');
  assert.equal(fmtCompact(Number.NaN), '—');
  assert.equal(fmtCompact(Number.POSITIVE_INFINITY), '—');
  for (let e = -12; e <= 15; e += 0.37) {
    const s = fmtCompact(10 ** e);
    assert.ok(!/e[+-]?\d/i.test(s), `${10 ** e} → ${s}`);
    assert.ok(!/0{4,}/.test(s), `${10 ** e} → ${s} (long run of zeros)`);
    assert.ok(!/K/.test(s), `${10 ** e} → ${s} (uppercase K)`);
  }
});

test('fmtCompactUsd: the $ form used on the axis, crosshair and volume', () => {
  assert.equal(fmtCompactUsd(4930), '$4.9k');
  assert.equal(fmtCompactUsd(42_000), '$42k');
  assert.equal(fmtCompactUsd(487_000), '$487k');
  assert.equal(fmtCompactUsd(1.2e6), '$1.2M');
  assert.equal(fmtCompactUsd(48e6), '$48M');
  assert.equal(fmtCompactUsd(1.3e9), '$1.3B');
  assert.equal(fmtCompactUsd(-1200), '-$1.2k');
  assert.equal(fmtCompactUsd(null), '—');
});

test('compactDecimalsFor: extra decimals only when neighbouring ticks would read the same', () => {
  assert.equal(compactDecimalsFor(4930, 500), 0, 'a normal memecoin range needs none');
  assert.equal(compactDecimalsFor(48_300_000, 100_000), 1, '48.1M–48.6M: one more decimal');
  assert.equal(fmtCompact(48_300_000, 1), '48.3M');
  assert.equal(fmtCompact(48_300_000, 0), '48M');
  assert.equal(compactDecimalsFor(4_930, 10), 1);
  assert.equal(fmtCompact(4_930, 1), '4.93k');
  assert.equal(compactDecimalsFor(Number.NaN, 1), 0);
  assert.equal(compactDecimalsFor(4930, 0), 0);
});
