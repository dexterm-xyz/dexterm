// task-1483 — BUY / SELL markers on the terminal charts: the ledger adapter (paper, no fetch; task-1571: no live ledger), candleChart's
// marks (fill time → column, fill price → row, avg-entry dashed line, glyph + letter that read under NO_COLOR, legend
// and the off-chart note), the live token screen at 176 / 120 / 90 columns, the display.chartMarkers setting, the chart
// popup's VM + MARKERS control, and the agent views' traces (brain DATA, HUD PnL).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { THEMES, Canvas, candleChart, fmtCompact, type ChartTradeFill } from '@dexterm/tui';
import type { Candle, DataLayer, TradeRecord } from '@dexterm/data';
import { PaperWallet, Cache } from '@dexterm/data';
import { makeFixtureState, type AppState } from '../src/state.ts';
import { initCustom } from '../src/custom.ts';
import { chartMarkersOn, configChartMarkers, setChartMarkers, displayCommand } from '../src/display.ts';
import { paperChartFill, chartFillsFor, ChartFills } from '../src/live/chart-fills.ts';
import { renderTokenLive } from '../src/live/screens/token-live.ts';
import { emptyView, type TokenView } from '../src/live/token.ts';
import { PositionsLive } from '../src/live/trade.ts';
import type { LiveContext } from '../src/live/index.ts';
import type { PopupManager, PopupManagerOptions, ChartVM, ServerEvent } from '@dexterm/popup';
import { CHART_MARKS_MAX } from '@dexterm/popup';
import { validateEventPayload, POPUP_EVENTS } from '../../popup/src/server.ts';
import { TokenPopups, chartMarksFrom, type ChartSource } from '../src/popup.ts';
import { traceMarks, renderBrainPanel, agentBrainModel, type CoinFacts } from '../src/screens/brain.ts';
import { traceFillCols } from '../src/screens/agent-hud.ts';
import { AgentStory } from '@dexterm/agents';

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 20, 13, 0, 0);
const MINT = 'Fake1483Mint11111111111111111111111111111111';

/** 40 one-minute candles drifting 0.00100 → 0.00139 (deterministic). */
function candles(n = 40, start = T0): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const o = 0.001 + i * 0.00001;
    return { t: start + i * MIN, o, h: o + 0.000012, l: o - 0.000004, c: o + 0.000008, v: 1000 + i * 10 };
  });
}
const f = (o: Partial<ChartTradeFill> & Pick<ChartTradeFill, 't' | 'side'>): ChartTradeFill => ({ source: 'paper', priceUsd: 0.0011, tokens: 1000, sol: 0.01, ...o });
const tmp = (): string => mkdtempSync(join(tmpdir(), 'dexterm-1483-'));

// ------------------------------------------------------------------ ledger adapters

test('paperChartFill: tokens from the raw delta and decimals, SOL from the gross leg, the recorded USD price', () => {
  const r = { t: T0, side: 'sell' as const, decimals: 6, tokenDelta: -2_500_000n, grossLamports: 250_000_000n, priceUsd: 0.0123 };
  assert.deepEqual(paperChartFill(r), { t: T0, side: 'sell', source: 'paper', priceUsd: 0.0123, tokens: 2.5, sol: 0.25 });
  assert.equal(paperChartFill({ ...r, priceUsd: null }).priceUsd, null);
});

test('chartFillsFor: this mint only, oldest first; an unreadable ledger contributes nothing', () => {
  const paperRows = [
    { id: 2, t: T0 + 2 * MIN, mint: MINT, side: 'sell', decimals: 6, tokenDelta: -1_000_000n, grossLamports: 1n, priceUsd: 0.002 },
    { id: 1, t: T0, mint: MINT, side: 'buy', decimals: 6, tokenDelta: 2_000_000n, grossLamports: 1n, priceUsd: 0.001 },
    { id: 3, t: T0 + MIN, mint: 'Other', side: 'buy', decimals: 6, tokenDelta: 1n, grossLamports: 1n, priceUsd: 1 },
  ] as unknown as TradeRecord[];
  const all = chartFillsFor(MINT, { paper: () => paperRows });
  assert.deepEqual(all.map((x) => [x.t - T0, x.side, x.source]), [[0, 'buy', 'paper'], [2 * MIN, 'sell', 'paper']]);
  const broken = chartFillsFor(MINT, { paper: () => { throw new Error('db locked'); } });
  assert.deepEqual(broken, []);
});

test('ChartFills memoises one mint for a second and invalidate() re-reads at once', () => {
  let now = 0, reads = 0;
  const cf = new ChartFills({ paper: () => { reads++; return []; } }, () => now);
  cf.for(MINT); cf.for(MINT); now = 999; cf.for(MINT);
  assert.equal(reads, 1);
  now = 1000; cf.for(MINT);
  assert.equal(reads, 2);
  cf.invalidate(); cf.for(MINT);
  assert.equal(reads, 3);
});

test('a real PaperWallet ledger round trip feeds the chart (the paper engine is only read)', () => {
  const w = new PaperWallet({ path: ':memory:' });
  const book = (side: 'buy' | 'sell', t: number, tokens: bigint, lamports: bigint, px: number) => w.book(
    { mint: MINT, symbol: 'MRK', decimals: 6, side, amountRaw: side === 'buy' ? lamports : tokens, slippageBps: 50 },
    { t, mint: MINT, symbol: 'MRK', side, decimals: 6, solDelta: side === 'buy' ? -lamports : lamports, tokenDelta: side === 'buy' ? tokens : -tokens, grossLamports: lamports, feeLamports: 0n, priceSol: 0, priceUsd: px, priceImpactPct: null, slippageBps: 50, route: [], realizedLamports: 0n, paper: true },
  );
  book('buy', T0 + 3 * MIN, 1_000_000_000n, 100_000_000n, 0.00105);
  book('sell', T0 + 9 * MIN, 400_000_000n, 60_000_000n, 0.0011);
  const fills = chartFillsFor(MINT, { paper: (n) => w.trades(n) });
  assert.deepEqual(fills.map((x) => [x.side, x.tokens, x.priceUsd]), [['buy', 1000, 0.00105], ['sell', 400, 0.0011]]);
});

// ------------------------------------------------------------------ candleChart marks

test('candleChart: a buy and a partial sell land in their bars’ columns at their price rows; glyph + letter; nothing else moves', () => {
  const cs = candles();
  const plain = new Canvas(120, 24, THEMES.midnight);
  candleChart(plain, 0, 0, 120, 24, cs, { interval: '1m' });
  const c = new Canvas(120, 24, THEMES.midnight);
  const fills = [f({ t: T0 + 10 * MIN + 5_000, side: 'buy', priceUsd: 0.00110, tokens: 2000 }), f({ t: T0 + 20 * MIN, side: 'sell', priceUsd: 0.00121, tokens: 500 })];
  const info = candleChart(c, 0, 0, 120, 24, cs, { interval: '1m', trades: { fills } })!;
  assert.equal(info.drawn.length, 1);
  // plotW = 110 → 27 candles of 4 columns fit: candles 13..39 are on screen, so bar 10 is not, bar 20 is
  const n = Math.floor((120 - 10) / 4);
  assert.equal(n, 27);
  const first = cs.length - n;
  assert.equal(info.set.before, 1, 'the buy at bar 10 is left of the window: omitted, counted');
  const sell = info.drawn[0];
  assert.equal(sell.marker.side, 'sell');
  assert.equal(sell.col, (20 - first) * 4 + 1, 'the wick column of bar 20');
  assert.equal(sell.marker.partial, true, 'a 500-of-2000 sell is partial (the buy before the window still counts)');
  const lines = c.toPlain().split('\n');
  assert.equal(lines[sell.row].slice(sell.col, sell.col + 2), '▽S', 'paper sell: hollow ▽ + S');
  assert.match(c.toPlain(), /△B ▽S paper/, 'legend');
  assert.match(c.toPlain(), /\+1 fill off-chart \(1 earlier\)/, 'what was omitted');
  // the candles' own cells outside the marker row are unchanged
  const p = plain.toPlain().split('\n');
  for (let r = 0; r < 20; r++) if (r !== sell.row && r !== 0 && r !== 19) assert.equal(lines[r].slice(0, 110), p[r].slice(0, 110), `row ${r}`);
});

test('candleChart: price → row uses the candle mapping; the sell sits on the row of its price', () => {
  const cs = candles(20);
  const c = new Canvas(100, 24, THEMES.midnight);
  const info = candleChart(c, 0, 0, 100, 24, cs, { interval: '1m', trades: { fills: [f({ t: T0 + 5 * MIN, side: 'buy', priceUsd: 0.00105 })] } })!;
  const plotH = 24 - 3 - 1;
  let lo = Infinity, hi = -Infinity;
  for (const k of cs) { lo = Math.min(lo, k.l); hi = Math.max(hi, k.h); }
  const pad = (hi - lo) * 0.06; lo -= pad; hi += pad;
  assert.equal(info.drawn[0].row, Math.floor(((hi - 0.00105) / (hi - lo)) * plotH));
});

test('live vs paper read differently without colour: ▲B / ▼S solid for live, △B / ▽S hollow for paper; NO_COLOR keeps them', () => {
  const cs = candles(20);
  const c = new Canvas(100, 24, THEMES.midnight);
  candleChart(c, 0, 0, 100, 24, cs, { interval: '1m', trades: { fills: [f({ t: T0 + 4 * MIN, side: 'buy', source: 'live', priceUsd: 0.00105 }), f({ t: T0 + 12 * MIN, side: 'sell', source: 'live', priceUsd: 0.00113 }), f({ t: T0 + 8 * MIN, side: 'buy', priceUsd: 0.00109 })] } });
  const nc = c.toAnsi({ depth: 'none' });
  assert.doesNotMatch(nc, /\x1b\[[0-9;]*(38|48);/, 'no colour codes under NO_COLOR');
  const text = nc.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  for (const s of ['▲B', '▼S', '△B', '△B ▽S paper', '▲B ▼S live']) assert.ok(text.includes(s), s);
});

test('avg entry while open: a dashed ┄ line through the empty cells and an `avg` axis tag; none when flat', () => {
  const cs = candles(20);
  const c = new Canvas(100, 24, THEMES.midnight);
  const info = candleChart(c, 0, 0, 100, 24, cs, { interval: '1m', trades: { fills: [f({ t: T0 + 4 * MIN, side: 'buy', priceUsd: 0.00105 })], avgEntry: { usd: 0.00105, source: 'paper' } } })!;
  assert.ok(info.avgRow !== null);
  const row = c.toPlain().split('\n')[info.avgRow!];
  assert.ok((row.match(/┄/g) ?? []).length > 20, 'dashed line');
  assert.match(row, /^avg┄/, 'reads `avg` without colour');
  assert.match(row, / 0\.00105$/, 'axis tag');
  assert.match(c.toPlain(), /┄ avg entry/);
  const flat = new Canvas(100, 24, THEMES.midnight);
  const fi = candleChart(flat, 0, 0, 100, 24, cs, { interval: '1m', trades: { fills: [f({ t: T0 + 4 * MIN, side: 'buy' }), f({ t: T0 + 6 * MIN, side: 'sell' })], avgEntry: null } })!;
  assert.equal(fi.avgRow, null);
  assert.doesNotMatch(flat.toPlain(), /┄/);
});

test('mcap axis: the markers stay where they are (price units); only the labels read market cap', () => {
  const cs = candles(20);
  const fills = [f({ t: T0 + 6 * MIN, side: 'buy', priceUsd: 0.00107 })];
  const a = new Canvas(100, 24, THEMES.midnight), b = new Canvas(100, 24, THEMES.midnight);
  const ia = candleChart(a, 0, 0, 100, 24, cs, { interval: '1m', trades: { fills } })!;
  const ib = candleChart(b, 0, 0, 100, 24, cs, { interval: '1m', trades: { fills }, scale: 1e9, axisFmt: fmtCompact })!;
  assert.deepEqual([ia.drawn[0].col, ia.drawn[0].row], [ib.drawn[0].col, ib.drawn[0].row]);
  assert.match(b.toPlain(), /B 1\.07M/, 'the label is the market cap (0.00107 × 1e9)');
  assert.match(a.toPlain(), /B 0\.00107/);
});

test('timeframe re-bucketing: the same fills on 5m land on 5-minute bars', () => {
  const c5: Candle[] = Array.from({ length: 12 }, (_, i) => ({ t: T0 + i * 5 * MIN, o: 0.001, h: 0.0012, l: 0.0009, c: 0.0011, v: 1 }));
  const c = new Canvas(80, 20, THEMES.midnight);
  const info = candleChart(c, 0, 0, 80, 20, c5, { interval: '5m', trades: { fills: [f({ t: T0 + 7 * MIN, side: 'buy' }), f({ t: T0 + 9 * MIN, side: 'buy' })] } })!;
  assert.deepEqual(info.drawn.map((d) => [d.marker.index, d.marker.count]), [[1, 2]]);
  assert.match(c.toPlain(), /△B2/, 'two fills in one bar: B with a count');
});

test('a fill newer than the last candle is not pulled onto it; it is counted as newer than the last candle', () => {
  const cs = candles(10);
  const c = new Canvas(80, 20, THEMES.midnight);
  const info = candleChart(c, 0, 0, 80, 20, cs, { interval: '1m', trades: { fills: [f({ t: T0 + 12 * MIN, side: 'buy' })] } })!;
  assert.equal(info.drawn.length, 0);
  assert.equal(info.set.after, 1);
  assert.match(c.toPlain(), /newer than the last candle/);
});

test('no trades option (or an empty list): the chart is byte-identical to before', () => {
  const cs = candles();
  const a = new Canvas(120, 24, THEMES.midnight), b = new Canvas(120, 24, THEMES.midnight), d = new Canvas(120, 24, THEMES.midnight);
  candleChart(a, 0, 0, 120, 24, cs, { interval: '1m' });
  candleChart(b, 0, 0, 120, 24, cs, { interval: '1m', trades: { fills: [] } });
  candleChart(d, 0, 0, 120, 24, cs, { interval: '1m', trades: null });
  assert.equal(b.toAnsi(), a.toAnsi());
  assert.equal(d.toAnsi(), a.toAnsi());
});

// ------------------------------------------------------------------ the live token screen (widths, setting)

function harness(fills: ChartTradeFill[]): { state: AppState; view: TokenView } {
  const wallet = new PaperWallet({ path: ':memory:' });
  const positions = new PositionsLive({} as DataLayer, wallet, { now: () => T0 + 60 * MIN });
  const cache = new Cache({ path: ':memory:' });
  const view = emptyView({ mint: MINT, symbol: 'MRK', name: 'Marker Test', launchpad: 'pump.fun', price: 0.0014 }, '1m');
  view.candles = candles(40);
  view.mcap = 1_400_000;
  view.panels.candles = { state: 'ok', via: 'geckoterminal', reason: null, fetchedAt: T0, stale: false };
  const dl = { cache } as unknown as DataLayer;
  const live = {
    dl, positions, positionSource: positions, token: { dl, view }, rpc: { provider: 'helius', basis: 'test' }, fastLane: null,
    badgeFor: () => 'POLL', livePrice: () => null, watch: { has: () => false }, creditsStatus: () => undefined,
    chartFills: { for: (m: string) => (m === MINT ? fills : []) },
  } as unknown as LiveContext;
  const state = makeFixtureState({ screen: 'token', theme: THEMES.midnight, calm: true });
  state.screener.source = 'live';
  state.live = live;
  state.sol = { price: 150, chg24: 0 };
  state.now = new Date(T0 + 60 * MIN);
  return { state, view };
}

test('token screen: markers drawn at 176 / 120 / 90 columns, every line within the width; markers off hides them', () => {
  const fills = [f({ t: T0 + 30 * MIN, side: 'buy', priceUsd: 0.00131 }), f({ t: T0 + 36 * MIN, side: 'sell', priceUsd: 0.00137, tokens: 400 })];
  const h = harness(fills);
  for (const [w, ht] of [[176, 48], [120, 40], [90, 32]] as const) {
    const c = new Canvas(w, ht, THEMES.midnight);
    c.fill(0, 0, w, ht, ' ', { bg: THEMES.midnight.bg });
    renderTokenLive(c, h.state, h.view);
    const out = c.toPlain();
    for (const l of out.split('\n')) assert.ok([...l].length <= w, `${w}: ${l.length}`);
    assert.match(out, /▽S/, `${w}: sell marker`);
  }
  h.state.chartMarkers = 'off';
  const c = new Canvas(176, 48, THEMES.midnight);
  renderTokenLive(c, h.state, h.view);
  assert.doesNotMatch(c.toPlain(), /[△▽]B|[△▽]S|△B ▽S paper/);
});

// ------------------------------------------------------------------ display.chartMarkers

test('display.chartMarkers: default on, persisted through the journal, closed set in the schema, `dexterm display markers`', () => {
  assert.equal(chartMarkersOn(undefined), true);
  assert.equal(configChartMarkers(null), 'on');
  assert.equal(configChartMarkers({ display: { chartMarkers: 'off' } }), 'off');
  assert.equal(configChartMarkers({ display: { chartMarkers: 'maybe' } }), 'on');
  const home = tmp();
  const state = makeFixtureState({ screen: 'token', calm: true });
  state.custom = initCustom({ DEXTERM_HOME: home });
  assert.match(setChartMarkers(state), /markers: OFF · saved/);
  assert.equal(chartMarkersOn(state), false);
  assert.equal(configChartMarkers(initCustom({ DEXTERM_HOME: home }).config), 'off', 'saved for the next run');
  assert.match(setChartMarkers(state, 'on'), /ON · saved/);
  // closed set
  const bad = tmp();
  writeFileSync(join(bad, 'config.json'), JSON.stringify({ version: 4, display: { chartMarkers: 'sign' } }));
  assert.notEqual(initCustom({ DEXTERM_HOME: bad }).config.display?.chartMarkers, 'sign');
  // the CLI
  const out: string[] = [], err: string[] = [];
  const io = { stdout: { write: (s: string) => out.push(s) }, stderr: { write: (s: string) => err.push(s) }, env: { DEXTERM_HOME: home } };
  assert.equal(displayCommand(['markers', 'off'], io), 0);
  assert.equal(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).display.chartMarkers, 'off');
  assert.equal(displayCommand(['markers'], io), 0);
  assert.match(out.join(''), /display\.chartMarkers = off\n$/);
  assert.equal(displayCommand(['markers', 'loud'], io), 2);
  assert.match(err.join(''), /expected on or off/);
});

// ------------------------------------------------------------------ the chart popup: VM marks + the MARKERS control

function popupHarness(fills: ChartTradeFill[], on: { v: boolean }) {
  const pushes: ChartVM[] = [];
  let onEvent: ((e: ServerEvent) => void) | undefined;
  const mgr = (o: PopupManagerOptions): PopupManager => {
    onEvent = o.onEvent;
    return {
      native: true, reason: 'test', hotkeyRegistered: false, port: 1,
      async open(req) { pushes.push(req.data as ChartVM); return { id: 'p1', kind: 'chart', native: true, setData: (d) => pushes.push(d as ChartVM), close() {}, show() {}, hide() {}, focus() {}, alwaysOnTop() {} }; },
      setData() {}, close() {}, async shutdown() {},
    };
  };
  const asked: boolean[] = [];
  const source: ChartSource = {
    series: () => null, livePrice: () => null, feed: () => 'POLL', positions: null, fills: () => [], solUsd: () => 150,
    markFills: (m) => (m === MINT ? fills : []), chartMarkers: () => on.v, setChartMarkers: (b) => { asked.push(b); on.v = b; },
  };
  const tp = new TokenPopups({ theme: THEMES.midnight, env: { DEXTERM_HOME: '/nonexistent-1483' }, source, createManager: mgr, syncMinMs: 0 });
  return { tp, pushes, asked, ev: (e: ServerEvent) => onEvent?.(e) };
}

test('popup VM: every paper + live fill of the coin (not only the open position), with the markers setting', async () => {
  const fills = [f({ t: T0, side: 'buy' }), f({ t: T0 + MIN, side: 'sell' }), f({ t: T0 + 2 * MIN, side: 'buy', source: 'live', sol: null })];
  const on = { v: true };
  const h = popupHarness(fills, on);
  const v = emptyView({ mint: MINT, symbol: 'MRK', name: 'Marker', launchpad: 'pump.fun' }, '1m');
  await h.tp.openChart(v);
  const vm = h.pushes.at(-1)!;
  assert.equal(vm.marks?.on, true);
  assert.deepEqual(vm.marks?.fills.map((x) => [x.side, x.source]), [['buy', 'paper'], ['sell', 'paper'], ['buy', 'live']], 'a closed paper round trip is still marked');
  assert.equal(vm.position ?? null, null, 'flat: no position row, markers still there');
});

test('popup: MARKERS / k asks the terminal (closed-set boolean), which saves and re-pushes; junk payloads change nothing', async () => {
  const on = { v: true };
  const h = popupHarness([f({ t: T0, side: 'buy' })], on);
  await h.tp.openChart(emptyView({ mint: MINT, symbol: 'MRK', name: 'Marker', launchpad: 'pump.fun' }, '1m'));
  h.ev({ ev: 'popup.ready', popupId: 'p1', kind: 'chart', openToReadyMs: 1, page: 'chart' });
  const n = h.pushes.length;
  h.ev({ ev: 'popup.event', popupId: 'p1', name: 'chart.markers', payload: { on: false } });
  assert.deepEqual(h.asked, [false]);
  assert.equal(h.pushes.length, n + 1);
  assert.equal(h.pushes.at(-1)?.marks?.on, false);
  h.ev({ ev: 'popup.event', popupId: 'p1', name: 'chart.markers', payload: { on: 'yes' } });
  assert.deepEqual(h.asked, [false], 'not a boolean: ignored');
});

test('server: chart.markers is allow-listed with a boolean-only payload (rebuilt, extra keys dropped)', () => {
  assert.ok(POPUP_EVENTS.has('event:chart.markers'));
  assert.deepEqual(validateEventPayload('chart.markers', { on: true }), { on: true });
  assert.deepEqual(validateEventPayload('chart.markers', { on: false, sign: 1 }), { on: false });
  assert.equal(validateEventPayload('chart.markers', { on: 'off' }), null);
  assert.equal(validateEventPayload('chart.markers', { arm: true }), null);
});

test('chartMarksFrom: the newest CHART_MARKS_MAX fills, oldest first, and how many older ones were left out', () => {
  const many = Array.from({ length: CHART_MARKS_MAX + 7 }, (_, i) => f({ t: T0 + i, side: 'buy' }));
  const m = chartMarksFrom(true, many);
  assert.equal(m.fills.length, CHART_MARKS_MAX);
  assert.equal(m.truncated, 7);
  assert.equal(m.fills[0].t, T0 + 7);
});

// ------------------------------------------------------------------ the agent views: brain DATA trace + HUD PnL trace


const coin = (over: Partial<CoinFacts> = {}): CoinFacts => ({
  mint: MINT, symbol: 'MRK', price: 0.0012, mcap: 1_200_000, liq: 40_000, chg5m: 1, chg1h: 2, buys: 3, sells: 2, wallets: 4, holders: 100, top10: 20,
  mintAuth: false, freezeAuth: false, lpLocked: 100, dev: null, rugScore: 10, larpVerdict: null,
  closes: candles(20).map((k) => k.c), closeTimes: candles(20).map((k) => k.t), periodMs: MIN, ...over,
});

test('brain trace: a B / S cell on the candle of each fill (same model as the charts); none without fills', () => {
  const fills = [f({ t: T0 + 4 * MIN, side: 'buy' }), f({ t: T0 + 9 * MIN + 1, side: 'sell', source: 'live' }), f({ t: T0 - 5 * MIN, side: 'buy' })];
  const m = traceMarks(coin({ fills }));
  assert.deepEqual(m?.cells.map((x) => [x.index, x.side, x.source]), [[4, 'buy', 'paper'], [9, 'sell', 'live']]);
  assert.equal(m?.off, 1, 'the fill before the trace is counted, not drawn');
  assert.equal(traceMarks(coin()), null);
  assert.equal(traceMarks(coin({ fills, closeTimes: undefined })), null, 'no candle times: no marks (never guessed)');
});

test('brain panel draws the B / S cells on the DATA trace and says what they are', () => {
  const s = new AgentStory('claude-code');
  const facts = coin({ fills: [f({ t: T0 + 4 * MIN, side: 'buy' }), f({ t: T0 + 9 * MIN, side: 'sell' })] });
  const model = agentBrainModel(s.view(T0), facts, T0, 'UTC');
  const c = new Canvas(64, 44, THEMES.cyberspace);
  renderBrainPanel(c, 0, 0, 64, 44, model, { now: T0, calm: true, depth: 'none', frame: 0 });
  const lines = c.toPlain().split('\n');
  const head = lines.findIndex((l) => /DATA/.test(l));
  assert.ok(head >= 0, 'DATA block shown');
  assert.match(lines[head], /B\/S = your fills/);
  const trace = lines[head + 2];
  const at = trace.indexOf('▲') >= 0 ? trace.indexOf('▲') : trace.indexOf('▼');
  assert.equal(trace[at + 2 + 4], 'B', 'the buy candle (index 4)');
  assert.equal(trace[at + 2 + 9], 'S', 'the sell candle (index 9)');
});

test('HUD PnL trace: a fill sits at the first sample that shows it; cut-off or later fills get no column', () => {
  const ts = [100, 200, 300, 400, 500];
  assert.deepEqual(traceFillCols(ts, 0, [{ t: 90, side: 'buy' }, { t: 310, side: 'sell' }]), [{ col: 0, side: 'buy', count: 1 }, { col: 3, side: 'sell', count: 1 }]);
  assert.deepEqual(traceFillCols(ts, 2, [{ t: 90, side: 'buy' }, { t: 310, side: 'sell' }, { t: 999, side: 'sell' }]), [{ col: 1, side: 'sell', count: 1 }], 'the buy is before the shown window; the late sell has no sample yet');
  assert.deepEqual(traceFillCols(ts, 0, [{ t: 210, side: 'sell' }, { t: 250, side: 'sell' }]), [{ col: 2, side: 'sell', count: 2 }]);
});

test('avg entry on the last-price row: `avg` still marks the row; the legend never claims a line that is not drawn', () => {
  const cs = candles(20);
  const last = cs[cs.length - 1].c;
  const c = new Canvas(100, 24, THEMES.midnight);
  const info = candleChart(c, 0, 0, 100, 24, cs, { interval: '1m', trades: { fills: [f({ t: T0 + 4 * MIN, side: 'buy', priceUsd: last })], avgEntry: { usd: last, source: 'paper' } } })!;
  const row = c.toPlain().split('\n')[info.avgRow!];
  assert.match(row, /^avg/, 'labelled even when it shares the row with the last price');
  // a level far outside the plot (more than 3× away) draws nothing, and the legend does not mention it
  const d = new Canvas(100, 24, THEMES.midnight);
  const di = candleChart(d, 0, 0, 100, 24, cs, { interval: '1m', trades: { fills: [f({ t: T0 + 4 * MIN, side: 'buy' })], avgEntry: { usd: last * 10, source: 'paper' } } })!;
  assert.equal(di.avgRow, null);
  assert.doesNotMatch(d.toPlain(), /avg entry/);
});
