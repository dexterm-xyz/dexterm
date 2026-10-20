// task-1472 — the chart Y axis: market cap by default (new AND existing configs), `A` / the popup's MCAP | PRICE
// control flip it and persist display.chartAxis through the journal; the `$` table mode is independent; both chart
// surfaces use the compact k/M/B formatter and never print scientific notation.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { THEMES, Canvas, candleChart, parseKeys, DEFAULT_KEYMAP } from '@dexterm/tui';
import type { Candle } from '@dexterm/data';
import type { PopupManager, PopupManagerOptions, ChartVM, ServerEvent } from '@dexterm/popup';
import { validateEventPayload, POPUP_EVENTS } from '../../popup/src/server.ts';
import { makeFixtureState, renderFrame } from '../src/state.ts';
import { initCustom } from '../src/custom.ts';
import { chartAxisOf, configChartAxis, setChartAxis, chartMode, chartTitle, MCAP_UNAVAILABLE_LABEL, type ChartAxis } from '../src/display.ts';
import { TokenPopups, type ChartSource } from '../src/popup.ts';
import { emptyView } from '../src/live/token.ts';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'dexterm-1472-'));

test('chart axis defaults to MARKET CAP: unset state, a config without display.chartAxis, and a v4 config with priceMode price', () => {
  assert.equal(chartAxisOf(undefined), 'mcap');
  assert.equal(chartAxisOf({}), 'mcap');
  assert.equal(configChartAxis(null), 'mcap');
  assert.equal(configChartAxis({ display: { priceMode: 'price' } } as never), 'mcap', 'existing users get mcap too');
  assert.equal(configChartAxis({ display: { chartAxis: 'price' } }), 'price');
  assert.equal(configChartAxis({ display: { chartAxis: 'bogus' } }), 'mcap');
});

test('A flips the chart axis, persists display.chartAxis through the journal, leaves priceMode alone, and a new run starts in it', () => {
  const home = tmp();
  const state = makeFixtureState({ screen: 'token', calm: true });
  state.custom = initCustom({ DEXTERM_HOME: home });
  state.priceMode = 'price';
  state.chartAxis = configChartAxis(state.custom.config);
  assert.equal(state.chartAxis, 'mcap');
  assert.match(setChartAxis(state), /chart Y axis: PRICE · saved/);
  assert.equal(state.chartAxis, 'price');
  assert.equal(state.priceMode, 'price', '$ mode untouched');
  assert.equal(configChartAxis(initCustom({ DEXTERM_HOME: home }).config), 'price', 'saved for the next run');
  assert.match(setChartAxis(state, 'mcap'), /MARKET CAP · saved/);
  const saved = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as { display?: { chartAxis?: string; priceMode?: string } };
  assert.equal(saved.display?.chartAxis, 'mcap');
});

test('A on a run without a config flips for the run and says it was not saved', () => {
  const state = makeFixtureState({ screen: 'token', calm: true });
  state.custom = undefined;
  assert.match(setChartAxis(state), /PRICE \(not saved/);
  assert.equal(chartAxisOf(state), 'price');
});

test('a config with an unknown chartAxis value is rejected by the schema (closed set)', () => {
  const home = tmp();
  writeFileSync(join(home, 'config.json'), JSON.stringify({ version: 4, display: { chartAxis: 'volume' } }));
  const ui = initCustom({ DEXTERM_HOME: home });
  assert.notEqual(ui.config.display?.chartAxis, 'volume');
});

test('A is bound on the token screen only (the follows screen keeps its own A)', () => {
  const [k] = parseKeys('A');
  assert.equal(DEFAULT_KEYMAP.resolve(k, 'token'), 'display.chartAxis');
  assert.notEqual(DEFAULT_KEYMAP.resolve(k, 'screener'), 'display.chartAxis');
});

test('chartMode / chartTitle: mcap with a supply, price with the card label when the supply is unknown, plain price', () => {
  const mc = chartMode('mcap', 0.001, 1_000_000);
  assert.equal(mc.kind, 'mcap');
  assert.equal(chartTitle('WIF', '1h', mc), 'WIF · MCAP (current supply) · 1h');
  const na = chartMode('mcap', 0.001, null);
  assert.equal(na.kind, 'price');
  assert.equal(chartTitle('WIF', '1h', na), `WIF/USD · ${MCAP_UNAVAILABLE_LABEL} · 1h`);
  assert.equal(chartTitle('WIF', '1h', chartMode('price', 0.001, 1e6)), 'WIF/USD · 1h');
});

test('terminal token chart: default axis is mcap in lowercase-k/M/B; price axis on a tiny price never prints scientific notation', () => {
  const s = makeFixtureState({ screen: 'token', calm: true });
  const ml = renderFrame(s, 176, 48).toPlain();
  assert.match(ml, /· MCAP \(current supply\) · 1h/);
  assert.match(ml, /\s\d+(\.\d)?[kMB] │/, 'compact axis label');
  const rows = ml.split('\n');
  const top = rows.findIndex((l) => /· MCAP \(current supply\)/.test(l));
  const chart = rows.slice(top, rows.findIndex((l) => /ON-CHAIN/.test(l))).map((l) => l.slice(0, 118)).join('\n');
  assert.doesNotMatch(chart, /\dK\b|e[+-]\d/, 'no uppercase K, no scientific notation on the chart');
  s.chartAxis = 'price';
  const pl = renderFrame(s, 176, 48).toPlain();
  assert.doesNotMatch(pl, /· MCAP/);
  const C1: Candle[] = Array.from({ length: 30 }, (_, i) => ({ t: i * 60_000, o: 4.9e-6 + i * 1e-8, h: 5e-6 + i * 1e-8, l: 4.8e-6 + i * 1e-8, c: 4.95e-6 + i * 1e-8, v: 4930 + i }));
  const cv = new Canvas(80, 20, THEMES.cyberspace);
  candleChart(cv, 0, 0, 80, 20, C1, {});
  const out = cv.toPlain();
  assert.doesNotMatch(out, /\de-\d/, 'no 4.93e-6');
  assert.match(out, /0\.0₅\d+/, 'subscript price axis');
  assert.match(out, /\$4\.9\dk|\$5k|\$4\.9k/, 'volume compact k');
});

function popupHarness(axis: { v: ChartAxis }) {
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
  const asked: ChartAxis[] = [];
  const source: ChartSource = {
    series: () => null, livePrice: () => null, feed: () => 'POLL', positions: null, fills: () => [], solUsd: () => 150,
    priceMode: () => 'price',
    chartAxis: () => axis.v,
    setChartAxis: (a) => { asked.push(a); axis.v = a; },
  };
  const tp = new TokenPopups({ theme: THEMES.cyberspace, env: { DEXTERM_HOME: '/nonexistent-1472' }, source, createManager: mgr, syncMinMs: 0 });
  return { tp, pushes, asked, ev: (e: ServerEvent) => onEvent?.(e) };
}

test('popup: the VM carries the chart axis (not the $ table mode); MCAP | PRICE asks the terminal, which re-pushes', async () => {
  const axis = { v: 'mcap' as ChartAxis };
  const h = popupHarness(axis);
  const v = emptyView({ mint: 'MINT1', symbol: 'WIF', name: 'dogwifhat', launchpad: 'pump.fun' }, '1h');
  v.price = 0.001; v.mcap = 1_000_000;
  await h.tp.openChart(v);
  assert.equal(h.pushes.at(-1)?.priceMode, 'mcap', 'default mcap even though $ mode is price');
  h.ev({ ev: 'popup.ready', popupId: 'p1', kind: 'chart', openToReadyMs: 1, page: 'chart' });
  const n = h.pushes.length;
  h.ev({ ev: 'popup.event', popupId: 'p1', name: 'chart.axis', payload: { axis: 'price' } });
  assert.deepEqual(h.asked, ['price']);
  assert.equal(h.pushes.length, n + 1);
  assert.equal(h.pushes.at(-1)?.priceMode, 'price');
  h.ev({ ev: 'popup.event', popupId: 'p1', name: 'chart.axis', payload: { axis: 'volume' } });
  assert.deepEqual(h.asked, ['price'], 'anything outside the closed set is ignored');
});

test('server: chart.axis is a known popup event with a closed-set payload', () => {
  assert.ok(POPUP_EVENTS.has('event:chart.axis'));
  assert.deepEqual(validateEventPayload('chart.axis', { axis: 'mcap' }), { axis: 'mcap' });
  assert.deepEqual(validateEventPayload('chart.axis', { axis: 'price', evil: 1 }), { axis: 'price' });
  assert.equal(validateEventPayload('chart.axis', { axis: 'sign' }), null);
});
