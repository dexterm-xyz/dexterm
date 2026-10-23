// task-1483 — the BUY / SELL marker model: fills → markers bucketed to the chart timeframe, partial fills, the open
// position's average entry, round trips, window clipping (omitted, never moved), and the price → row mapping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chartMarkers, replayFills, cleanFills, bucketOf, markerGlyph, markerLetter, markerLegend, omittedNote, markerRow, markerLabel,
  fmtCompact, MARKER_PERIOD_MS, type ChartTradeFill,
} from '../src/index.ts';

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 20, 13, 0, 0); // a whole hour
const bars = (n: number, period: number, start = T0) => Array.from({ length: n }, (_, i) => start + i * period);
const fill = (o: Partial<ChartTradeFill> & Pick<ChartTradeFill, 't' | 'side'>): ChartTradeFill => ({ source: 'paper', priceUsd: 0.001, tokens: 1000, sol: 0.01, ...o });

test('bucketOf: a fill belongs to the bar whose period contains it (1m / 1h / 1d)', () => {
  assert.equal(bucketOf(T0 + 59_999, MIN), T0);
  assert.equal(bucketOf(T0 + 60_000, MIN), T0 + MIN);
  assert.equal(bucketOf(T0 + 59 * MIN, MARKER_PERIOD_MS['1h']), T0);
  assert.equal(bucketOf(T0 + 10 * 3600e3, MARKER_PERIOD_MS['1d']), Date.UTC(2026, 9, 20));
});

test('chartMarkers: each fill lands on its own bar index at its own price; the timeframe re-buckets them', () => {
  const fills = [fill({ t: T0 + 2 * MIN + 5_000, side: 'buy', priceUsd: 0.001 }), fill({ t: T0 + 7 * MIN + 1, side: 'sell', priceUsd: 0.0015 })];
  const m1 = chartMarkers(fills, { periodMs: MIN, barTimes: bars(30, MIN) });
  assert.deepEqual(m1.markers.map((m) => [m.side, m.index, m.bucket - T0, m.priceUsd]), [['buy', 2, 2 * MIN, 0.001], ['sell', 7, 7 * MIN, 0.0015]]);
  // 5m: both fills move to their 5-minute bars (index 0 and 1)
  const m5 = chartMarkers(fills, { periodMs: 5 * MIN, barTimes: bars(12, 5 * MIN) });
  assert.deepEqual(m5.markers.map((m) => [m.side, m.index]), [['buy', 0], ['sell', 1]]);
  // 1h: one bar holds both; still one marker per side (a buy and a sell are never merged)
  const mh = chartMarkers(fills, { periodMs: 3600e3, barTimes: bars(5, 3600e3) });
  assert.deepEqual(mh.markers.map((m) => [m.side, m.index, m.count]), [['buy', 0, 1], ['sell', 0, 1]]);
});

test('partial sells each get a marker on a fine timeframe, and one ×N marker (token-weighted price) when a bar holds several', () => {
  const fills = [
    fill({ t: T0, side: 'buy', tokens: 3000, priceUsd: 0.001 }),
    fill({ t: T0 + 3 * MIN, side: 'sell', tokens: 1000, priceUsd: 0.002 }),
    fill({ t: T0 + 4 * MIN, side: 'sell', tokens: 1000, priceUsd: 0.003 }),
    fill({ t: T0 + 9 * MIN, side: 'sell', tokens: 1000, priceUsd: 0.004 }),
  ];
  const m1 = chartMarkers(fills, { periodMs: MIN, barTimes: bars(15, MIN) });
  const sells = m1.markers.filter((m) => m.side === 'sell');
  assert.equal(sells.length, 3);
  assert.deepEqual(sells.map((m) => [m.partial, m.closes]), [[true, false], [true, false], [false, true]]);
  const m5 = chartMarkers(fills, { periodMs: 5 * MIN, barTimes: bars(3, 5 * MIN) });
  const s5 = m5.markers.filter((m) => m.side === 'sell');
  assert.deepEqual(s5.map((m) => [m.index, m.count, m.tokens]), [[0, 2, 2000], [1, 1, 1000]]);
  assert.ok(Math.abs((s5[0].priceUsd ?? 0) - 0.0025) < 1e-12, 'token-weighted average of the two partial sells');
  assert.equal(s5[0].partial, true);
  assert.equal(s5[1].closes, true);
});

test('markers before / after the window and in a period with no bar are omitted and counted, never moved', () => {
  const fills = [
    fill({ t: T0 - 10 * MIN, side: 'buy' }),            // before the first bar
    fill({ t: T0 + 2 * MIN, side: 'buy' }),             // on screen
    fill({ t: T0 + 4 * MIN + 30_000, side: 'sell', tokens: 500 }), // bar 4 is missing (quiet minute)
    fill({ t: T0 + 20 * MIN, side: 'sell', tokens: 500 }), // after the last bar (candle not here yet)
  ];
  const times = bars(10, MIN).filter((t) => t !== T0 + 4 * MIN);
  const s = chartMarkers(fills, { periodMs: MIN, barTimes: times });
  assert.deepEqual(s.markers.map((m) => [m.side, m.bucket - T0]), [['buy', 2 * MIN]]);
  assert.deepEqual([s.before, s.after, s.gap], [1, 1, 1]);
  assert.equal(omittedNote(s), '+3 fills off-chart (1 earlier, 1 newer than the last candle, 1 in a period with no candle)');
  assert.equal(omittedNote({ before: 0, after: 0, gap: 0 }), '');
  // no bars at all: everything counts as omitted, nothing is placed
  const none = chartMarkers(fills, { periodMs: MIN, barTimes: [] });
  assert.equal(none.markers.length, 0);
  assert.equal(none.before, 4);
});

test('a fill before the window still counts for the replay: a later sell on screen is partial, the avg entry stays right', () => {
  const fills = [fill({ t: T0 - 3600e3, side: 'buy', tokens: 2000, priceUsd: 0.001 }), fill({ t: T0 + MIN, side: 'sell', tokens: 1000, priceUsd: 0.002 })];
  const s = chartMarkers(fills, { periodMs: MIN, barTimes: bars(5, MIN) });
  assert.equal(s.before, 1);
  assert.equal(s.markers.length, 1);
  assert.equal(s.markers[0].partial, true);
  assert.equal(s.avgEntry.paper, 0.001);
});

test('paper and live replay separately: avg entry per source while open, null when flat', () => {
  const fills = [
    fill({ t: T0, side: 'buy', tokens: 1000, priceUsd: 0.001, source: 'paper' }),
    fill({ t: T0 + MIN, side: 'buy', tokens: 1000, priceUsd: 0.003, source: 'paper' }),
    fill({ t: T0 + 2 * MIN, side: 'buy', tokens: 500, priceUsd: 0.002, source: 'live' }),
    fill({ t: T0 + 3 * MIN, side: 'sell', tokens: 500, priceUsd: 0.004, source: 'live' }),
  ];
  const r = replayFills(fills);
  assert.equal(r.avgEntry.paper, 0.002);
  assert.equal(r.avgEntry.live, null, 'live is flat');
  assert.equal(r.fills[1].partial, true, 'the second paper buy scales in');
  assert.deepEqual(r.trips.map((x) => [x.source, x.entryUsd, x.exitUsd]), [['live', 0.002, 0.004]]);
  // a partial sell keeps the average cost (average-cost ledger rule)
  const r2 = replayFills([...fills, fill({ t: T0 + 4 * MIN, side: 'sell', tokens: 1000, priceUsd: 0.01, source: 'paper' })]);
  assert.equal(r2.avgEntry.paper, 0.002);
  // a buy without a USD price makes the average unknown rather than wrong
  const r3 = replayFills([fill({ t: T0, side: 'buy', priceUsd: null })]);
  assert.equal(r3.avgEntry.paper, null);
});

test('round trips: entry → exit per closed cycle; a trip overlapping the window is kept, one fully outside is not', () => {
  const fills = [
    fill({ t: T0 - 50 * MIN, side: 'buy' }), fill({ t: T0 - 40 * MIN, side: 'sell' }),   // closed before the window
    fill({ t: T0 - 5 * MIN, side: 'buy' }), fill({ t: T0 + 3 * MIN, side: 'sell' }),     // overlaps the window start
    fill({ t: T0 + 5 * MIN, side: 'buy' }),                                              // still open
  ];
  const s = chartMarkers(fills, { periodMs: MIN, barTimes: bars(10, MIN) });
  assert.deepEqual(s.trips.map((r) => [r.openT - T0, r.closeT - T0]), [[-5 * MIN, 3 * MIN]]);
  assert.equal(s.avgEntry.paper, 0.001);
});

test('cleanFills drops bad rows (NaN time, zero tokens, unknown side/source) and sorts by time, stable', () => {
  const rows = [
    fill({ t: T0 + 2, side: 'sell' }), fill({ t: Number.NaN, side: 'buy' }), fill({ t: T0, side: 'buy', tokens: 0 }),
    { ...fill({ t: T0, side: 'buy' }), side: 'hold' as never }, { ...fill({ t: T0, side: 'buy' }), source: 'x' as never },
    fill({ t: T0 + 1, side: 'buy', priceUsd: -1 }),
  ];
  const c = cleanFills(rows);
  assert.deepEqual(c.map((f) => [f.t - T0, f.side, f.priceUsd]), [[1, 'buy', null], [2, 'sell', 0.001]]);
});

test('a marker with no known price is still placed on its bar (drawn against the bar) and labelled without a price', () => {
  const s = chartMarkers([fill({ t: T0 + MIN, side: 'buy', priceUsd: null })], { periodMs: MIN, barTimes: bars(3, MIN) });
  assert.equal(s.markers[0].priceUsd, null);
  assert.equal(markerLabel(s.markers[0], fmtCompact), 'B');
});

test('glyphs + letters read without colour: hollow = paper, solid = live; B / S always', () => {
  assert.equal(markerGlyph('buy', 'paper'), '△');
  assert.equal(markerGlyph('sell', 'paper'), '▽');
  assert.equal(markerGlyph('buy', 'live'), '▲');
  assert.equal(markerGlyph('sell', 'live'), '▼');
  assert.equal(markerLetter('buy'), 'B');
  assert.equal(markerLetter('sell'), 'S');
  assert.equal(markerLegend([{ source: 'paper' }]), '△B ▽S paper');
  assert.equal(markerLegend([{ source: 'paper' }, { source: 'live' }], true), '△B ▽S paper  ▲B ▼S live  ┄ avg entry');
  assert.equal(markerLegend([]), '');
});

test('markerRow: price → plot row with the candle mapping; outside the plotted range is null (omitted, not clamped)', () => {
  // lo 1, hi 2 over 10 rows: 2 → row 0, 1.55 → row 4, just above lo → row 9
  assert.equal(markerRow(2, 1, 2, 10), 0);
  assert.equal(markerRow(1.55, 1, 2, 10), 4);
  assert.equal(markerRow(1.0001, 1, 2, 10), 9);
  assert.equal(markerRow(2.5, 1, 2, 10), null);
  assert.equal(markerRow(0.5, 1, 2, 10), null);
  assert.equal(markerRow(1.5, 2, 1, 10), null, 'bad range');
});

test('markerLabel: the axis decides the number (mcap = price × supply, compact) — the marker position never changes', () => {
  const m = { side: 'sell' as const, count: 2, priceUsd: 0.0000412 };
  assert.equal(markerLabel(m, fmtCompact, 1e9), 'S×2 41k');
  assert.equal(markerLabel(m, fmtCompact), 'S×2 0.0₄412');
  const a = chartMarkers([fill({ t: T0, side: 'buy', priceUsd: 0.0000412 })], { periodMs: MIN, barTimes: bars(2, MIN) });
  assert.equal(a.markers[0].priceUsd, 0.0000412, 'the model is in price units whatever the axis');
});
