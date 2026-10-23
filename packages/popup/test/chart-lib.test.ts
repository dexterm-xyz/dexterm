// task-1325: the chart page's pure helpers (src/pages/chart-lib.js), loaded exactly as the page gets them
// (one script, attaches window.DTChart) through node:vm.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import { fmtPrice as tuiFmtPrice, fmtCompact as tuiFmtCompact, fmtCompactUsd as tuiFmtCompactUsd, chartMarkers as tuiMarkers, markerGlyph as tuiGlyph } from '@dexterm/tui';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, '..', 'src', 'pages', 'chart-lib.js'), 'utf8');

type Bar = { t: number; time: number; open: number; high: number; low: number; close: number; volume: number };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function load(): any { const win: Record<string, unknown> = {}; vm.runInNewContext(src, { window: win }); return win.DTChart; }
const C = load();
const H = 3_600_000, M = 60_000;
/** vm-realm arrays/objects → this realm (deepStrictEqual checks prototypes). */
const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const candle = (t: number, o: number, h: number, l: number, c: number, v = 1) => ({ t, o, h, l, c, v });

test('toBars: sorts, de-duplicates, drops non-finite, keeps the real ms in t', () => {
  const bars: Bar[] = C.toBars([candle(2 * H, 2, 3, 1, 2.5), candle(H, 1, 2, 0.5, 1.5), candle(2 * H, 9, 9, 9, 9), { t: 3 * H, o: NaN, h: 1, l: 1, c: 1, v: 1 }]);
  assert.equal(bars.length, 2);
  assert.deepEqual(plain(bars.map((b) => b.time)), [3600, 7200]);
  assert.equal(bars[1].close, 9, 'a later duplicate replaces the earlier one');
  assert.equal(bars[0].t, H);
});

test('setTzOffset shifts chart time only (VWAP keeps anchoring on the real UTC day)', () => {
  const D = load();
  D.setTzOffset(-4 * 3600);
  const bars: Bar[] = D.toBars([candle(H, 1, 1, 1, 1)]);
  assert.equal(bars[0].time, 3600 - 4 * 3600);
  assert.equal(bars[0].t, H);
  assert.equal(D.barTimeOf(H + 5 * M, H), 3600 - 4 * 3600);
});

test('ema: SMA seed then the standard recursion', () => {
  const bars: Bar[] = C.toBars([1, 2, 3, 4, 5, 6].map((c, i) => candle(i * M, c, c, c, c)));
  const e = C.ema(bars, 3);
  assert.equal(e.length, 4);
  assert.equal(e[0].value, 2); // (1+2+3)/3
  assert.equal(e[1].value, 4 * 0.5 + 2 * 0.5);
  assert.deepEqual(plain(C.ema(bars.slice(0, 2), 3)), [], 'not enough bars → empty');
});

test('sma over volume points', () => {
  const pts = [1, 2, 3, 4].map((v, i) => ({ time: i, value: v }));
  assert.deepEqual(plain(C.sma(pts, 2).map((p: { value: number }) => p.value)), [1.5, 2.5, 3.5]);
});

test('vwap: volume-weighted typical price, resets at 00:00 UTC', () => {
  const day = 86_400_000;
  const bars: Bar[] = C.toBars([candle(day - 2 * H, 10, 12, 8, 10, 1), candle(day - H, 20, 22, 18, 20, 3), candle(day, 100, 100, 100, 100, 5)]);
  const v = C.vwap(bars);
  assert.equal(v[0].value, 10);
  assert.equal(v[1].value, (10 * 1 + 20 * 3) / 4);
  assert.equal(v[2].value, 100, 'new UTC day: anchored again');
});

test('tapeMarkers: one arrow per side per EXISTING bar, sized by USD, sorted', () => {
  const bars: Bar[] = C.toBars([candle(0, 1, 1, 1, 1), candle(M, 1, 1, 1, 1)]);
  const times = new Set(bars.map((b) => b.time));
  const trades = [
    { t: 5_000, side: 'buy', usd: 10, price: 1 }, { t: 6_000, side: 'buy', usd: 10_000, price: 1 }, { t: 70_000, side: 'sell', usd: 50, price: 1 },
    { t: 10 * M, side: 'buy', usd: 5, price: 1 }, // no bar at 10m → no marker
    { t: 7_000, side: 'transfer', usd: 1, price: 1 }, // junk side ignored
  ];
  const m = C.tapeMarkers(trades, M, times, { up: 'g', down: 'r' });
  assert.equal(m.length, 2);
  assert.deepEqual(plain(m.map((x: { shape: string; time: number }) => [x.time, x.shape])), [[0, 'arrowUp'], [60, 'arrowDown']]);
  assert.ok(m[0].size > m[1].size, 'more USD → bigger marker');
});

// task-1483: the position-only `fillMarkers` (which snapped a fill newer than the last candle onto it) is replaced by
// the markers model below; those two tests moved here, with the snapping now a counted omission.
const T0 = Date.UTC(2026, 9, 20, 13);
const mf = (o: Record<string, unknown>) => ({ source: 'paper', priceUsd: 0.001, tokens: 1000, sol: 0.01, ...o });

test('task-1483 chartMarkers: each fill on its own bar at its own price; re-bucketed by the timeframe; buy/sell never merged', () => {
  const times = Array.from({ length: 30 }, (_, i) => T0 + i * M);
  const fills = [mf({ t: T0 + 2 * M + 5_000, side: 'buy' }), mf({ t: T0 + 7 * M, side: 'sell', priceUsd: 0.0015 })];
  const s = C.chartMarkers(fills, M, times);
  assert.deepEqual(plain(s.markers.map((m: { side: string; index: number; priceUsd: number }) => [m.side, m.index, m.priceUsd])), [['buy', 2, 0.001], ['sell', 7, 0.0015]]);
  const s5 = C.chartMarkers(fills, 5 * M, Array.from({ length: 6 }, (_, i) => T0 + i * 5 * M));
  assert.deepEqual(plain(s5.markers.map((m: { index: number }) => m.index)), [0, 1]);
  const sh = C.chartMarkers(fills, H, [T0]);
  assert.deepEqual(plain(sh.markers.map((m: { side: string; index: number }) => [m.side, m.index])), [['buy', 0], ['sell', 0]]);
});

test('task-1483 chartMarkers: a fill newer than the last candle is NOT snapped onto it (was fillMarkers); before / gap counted too', () => {
  const times = [T0, T0 + M, T0 + 3 * M]; // minute 2 had no trades
  const s = C.chartMarkers([mf({ t: T0 - M, side: 'buy' }), mf({ t: T0 + 2 * M + 1, side: 'buy' }), mf({ t: T0 + 4 * M + 5_000, side: 'sell' })], M, times);
  assert.equal(s.markers.length, 0);
  assert.deepEqual([s.before, s.gap, s.after], [1, 1, 1]);
  assert.equal(C.omittedNote(s), '+3 fills off-chart (1 earlier, 1 newer than the last candle, 1 in a period with no candle)');
});

test('task-1483 partial sells: one marker each on 1m; one ×2 marker on 5m with the token-weighted price; closes flagged', () => {
  const fills = [mf({ t: T0, side: 'buy', tokens: 3000 }), mf({ t: T0 + 3 * M, side: 'sell', priceUsd: 0.002 }), mf({ t: T0 + 4 * M, side: 'sell', priceUsd: 0.003 }), mf({ t: T0 + 9 * M, side: 'sell', priceUsd: 0.004 })];
  const s1 = C.chartMarkers(fills, M, Array.from({ length: 10 }, (_, i) => T0 + i * M));
  assert.deepEqual(plain(s1.markers.filter((m: { side: string }) => m.side === 'sell').map((m: { partial: boolean; closes: boolean }) => [m.partial, m.closes])), [[true, false], [true, false], [false, true]]);
  const s5 = C.chartMarkers(fills, 5 * M, [T0, T0 + 5 * M]);
  const sells = s5.markers.filter((m: { side: string }) => m.side === 'sell');
  assert.deepEqual(plain(sells.map((m: { count: number; tokens: number }) => [m.count, m.tokens])), [[2, 2000], [1, 1000]]);
  assert.ok(Math.abs(sells[0].priceUsd - 0.0025) < 1e-12);
});

test('task-1483 parity: chart-lib chartMarkers === @dexterm/tui chartMarkers on mixed paper + live fills, three timeframes', () => {
  const fills = [
    mf({ t: T0 - 30 * M, side: 'buy', tokens: 4000, priceUsd: 0.0009 }),
    mf({ t: T0 + 1 * M + 7, side: 'buy', source: 'live', tokens: 500, priceUsd: 0.001 }),
    mf({ t: T0 + 2 * M, side: 'sell', tokens: 1000, priceUsd: 0.0012 }),
    mf({ t: T0 + 2 * M + 9, side: 'sell', tokens: 500, source: 'live', priceUsd: null }),
    mf({ t: T0 + 11 * M, side: 'buy', tokens: 250, sol: null }),
    mf({ t: T0 + 23 * M, side: 'sell', tokens: 3250, priceUsd: 0.0021 }),
    mf({ t: T0 + 90 * M, side: 'buy' }),
  ];
  for (const [p, n] of [[M, 40], [5 * M, 10], [15 * M, 4]] as const) {
    const times = Array.from({ length: n }, (_, i) => T0 + i * p).filter((t) => t !== T0 + 5 * p);
    assert.deepEqual(plain(C.chartMarkers(fills, p, times)), plain(tuiMarkers(fills as never, { periodMs: p, barTimes: times })), `period ${p}`);
  }
  assert.equal(C.markerGlyph('buy', 'paper'), tuiGlyph('buy', 'paper'));
  assert.equal(C.markerGlyph('sell', 'live'), tuiGlyph('sell', 'live'));
});

test('task-1483 clusterMarkers: re-bucket on zoom — narrow bars merge runs of k bars per side + source; wide bars untouched', () => {
  const ms = [0, 1, 2, 5].map((i) => ({ side: 'buy', source: 'paper', bucket: T0 + i * M, index: i, t: T0 + i * M, tLast: T0 + i * M, priceUsd: 1 + i, tokens: 1, sol: 1, count: 1, partial: false, closes: false }));
  assert.equal(C.clusterMarkers(ms, 20).length, 4, '20 px bars: no merge');
  const c = C.clusterMarkers(ms, 4, 14); // k = 4 bars per group
  assert.deepEqual(plain(c.map((m: { index: number; count: number; span: number }) => [m.index, m.count, m.span])), [[2, 3, 4], [5, 1, 4]]);
  assert.equal(c[0].priceUsd, 2, 'token-weighted price of 1, 2, 3');
  const mixed = C.clusterMarkers([...ms.slice(0, 2), { ...ms[1], side: 'sell' }, { ...ms[0], source: 'live' }], 2, 14);
  assert.equal(mixed.length, 3, 'sides and sources never merge');
});

test('task-1483 markerShape: the triangle tip is ON the price (buy points up from below, sell down from above); hit box covers glyph + letter', () => {
  const b = C.markerShape('buy', 100, 50, 6);
  assert.deepEqual(plain(b.tri[0]), [100, 50]);
  assert.ok(b.tri[1][1] > 50 && b.labelY > b.tri[1][1], 'below the price');
  const s = C.markerShape('sell', 100, 50, 6);
  assert.ok(s.tri[1][1] < 50 && s.labelY < s.tri[1][1], 'above the price');
  assert.ok(b.hit.x0 < 94 && b.hit.x1 > 106 && b.hit.y0 <= 50 && b.hit.y1 >= b.labelY);
});

test('task-1483 markerTooltip: time, price (mcap + price on an mcap axis), size + SOL, and the ledger', () => {
  const m = { side: 'sell', source: 'paper', t: T0, tLast: T0, priceUsd: 0.0000412, tokens: 2_500_000, sol: 0.5, count: 1, partial: true, closes: false };
  const fmt = (ms: number) => `@${(ms - T0) / M}`;
  assert.deepEqual(plain(C.markerTooltip(m, C.displayOf({ priceMode: 'mcap', supply: 1e9 }), fmt)), ['▽S SELL (partial)', '@0', 'MC 41k ($0.0₄412)', '2.50M tokens · 0.50 SOL', 'PAPER · simulated ledger']);
  const live = { ...m, source: 'live', side: 'buy', partial: false, count: 3, tLast: T0 + 2 * M, priceUsd: null, sol: null };
  assert.deepEqual(plain(C.markerTooltip(live, C.displayOf(null), fmt)), ['▲B BUY ×3', '@0 – @2', 'price not recorded', '2.50M tokens', 'LIVE · confirmed on-chain fill']);
});

test('mergeTail: replaces the forming bar, appends a new one, ignores older-than-window', () => {
  const bars: Bar[] = C.toBars([0, 1, 2, 3, 4].map((i) => candle(i * M, 1, 1, 1, 1)));
  const a: Bar[] = C.mergeTail(bars, [candle(4 * M, 1, 2, 1, 2)]);
  assert.equal(a.length, 5); assert.equal(a[4].close, 2);
  const b2: Bar[] = C.mergeTail(a, [candle(4 * M, 1, 2, 1, 2), candle(5 * M, 2, 3, 2, 3)]);
  assert.equal(b2.length, 6); assert.equal(b2[5].close, 3);
  assert.equal(bars[4].close, 1, 'input not mutated');
});

test('logicalOf / timeOfLogical are inverses, extrapolating past both ends', () => {
  const bars: Bar[] = C.toBars([0, 1, 2, 3].map((i) => candle(i * M, 1, 1, 1, 1)));
  for (const t of [-120, 0, 30, 90, 180, 300]) assert.ok(Math.abs(C.timeOfLogical(bars, C.logicalOf(bars, t, 60), 60) - t) < 1e-9, String(t));
});

test('price formatting matches the terminal (subscript zero-compression) and scales precision', () => {
  for (const p of [0.0000123, 0.00031, 0.0042, 0.5, 3.2, 142.1, 12345]) assert.equal(C.fmtPrice(p), tuiFmtPrice(p), String(p));
  assert.equal(C.fmtAxis(0.0000123), tuiFmtPrice(0.0000123).replace('$', ''));
  assert.ok(C.priceFormatFor(0.00000031).minMove <= 1e-9);
  assert.ok(C.priceFormatFor(142).minMove >= 0.001);
});

// ------------------------------------------------------------------ task-1366: market-cap axis

test('task-1472 fmtCompact / fmtMcapAxis mirror the terminal formatter (lowercase k, M/B/T, tiny and huge values)', () => {
  const ns = [0, 0.42, 0.0001234, 4.93e-6, 1.2e-10, 1, 4.93, 12.34, 950, 999, 999.9, 1000, 4500, 4930, 9_949, 9_960, 42_100, 45_000, 99_960, 300_000, 487_000,
    999_499, 999_500, 999_900, 999_999, 1_200_000, 1_234_567, 12_345_678, 48e6, 123_456_789, 999_999_999, 1.2e9, 1.3e9, 2.5e12, 3.2e15, -1.5e6, -4930];
  for (const n of ns) {
    assert.equal(C.fmtMcapAxis(n), tuiFmtCompact(n), String(n));
    assert.equal(C.fmtCompactUsd(n), tuiFmtCompactUsd(n), `usd ${n}`);
    for (const x of [1, 2, 3]) assert.equal(C.fmtCompact(n, x), tuiFmtCompact(n, x), `${n} +${x}`);
  }
  assert.equal(C.fmtMcapAxis(300_000), '300k');
  assert.equal(C.fmtMcapAxis(1_200_000), '1.2M');
  assert.equal(C.fmtMcapAxis(Number.NaN), '—');
});

test('task-1366 displayOf: mcap only with a usable supply; mcap mode without one is price + a visible note', () => {
  assert.deepEqual({ ...C.displayOf(null) }, { mode: 'price', supply: null, label: null, key: 'price' }); // spread: the lib runs in a vm realm
  assert.deepEqual({ ...C.displayOf({ priceMode: 'price', supply: 1e9 }) }, { mode: 'price', supply: null, label: null, key: 'price' });
  const d = C.displayOf({ priceMode: 'mcap', supply: 1e9 });
  assert.equal(d.mode, 'mcap'); assert.equal(d.supply, 1e9); assert.equal(d.label, 'mcap (current supply)');
  for (const supply of [null, 0, -5, Number.NaN, undefined]) {
    const f = C.displayOf({ priceMode: 'mcap', supply });
    assert.equal(f.mode, 'price', String(supply)); assert.equal(f.label, 'price (mcap unavailable)');
  }
  // a tick that moves the supply below the 4th significant digit keeps the key (no re-format per tick)
  assert.equal(C.displayOf({ priceMode: 'mcap', supply: 1_000_000_000 }).key, C.displayOf({ priceMode: 'mcap', supply: 1_000_040_000 }).key);
});

test('task-1366/1472 popup Y-axis formatter: price × supply in compact k/M/B; price mode keeps the price label', () => {
  const mc = C.axisFormatter(C.displayOf({ priceMode: 'mcap', supply: 1e9 }));
  assert.equal(mc(0.0003), '300k');
  assert.equal(mc(0.00000493), '4.9k');
  assert.equal(mc(0.0012), '1.2M');
  assert.equal(mc(1.5), '1.5B');
  const px = C.axisFormatter(C.displayOf({ priceMode: 'price' }));
  assert.equal(px(0.0000123), C.fmtAxis(0.0000123));
  assert.equal(C.axisFormatter(C.displayOf({ priceMode: 'mcap', supply: null }))(0.0012), C.fmtAxis(0.0012));
});

test('task-1366 crosshair legend: mcap with the price in parentheses on the close; price mode unchanged', () => {
  const bar = C.toBars([candle(0, 0.001, 0.0012, 0.0009, 0.0011)])[0];
  const lg = C.legendFor(bar, null, C.displayOf({ priceMode: 'mcap', supply: 1e9 }));
  assert.equal(lg.o, '1M'); assert.equal(lg.h, '1.2M'); assert.equal(lg.l, '900k');
  assert.equal(lg.v, C.fmtCompactUsd(bar.volume)); // task-1472: volume stays USD, compact k/M
  assert.equal(lg.c, `1.1M (${C.fmtPrice(0.0011)})`);
  const pl = C.legendFor(bar, null);
  assert.equal(pl.c, C.fmtAxis(0.0011));
  assert.deepEqual({ ...C.legendFor(bar, null, C.displayOf({ priceMode: 'mcap', supply: null })) }, { ...pl });
});
