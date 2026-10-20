// task-1473 round 2: the POSITION PnL chip everywhere an auto mode runs. One selector (pnlChipFor: the followed
// agent's PAPER ticket, else the user's own paper / live position while AI scan mode runs), drawn in the HUD dock,
// on the band row when there is no dock (terminals under HUD_MIN_H rows, scan mode), and on the chart popup
// (ChartVM.chip). Display only: nothing here has input; the tracker reads ledger samples and keeps a session peak.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentStory, type SpectatorEvent, type SpectatorDetail } from '@dexterm/agents';
import { aggregateCandles, type Candle } from '@dexterm/data';
import type { PopupManager, PopupManagerOptions, ChartVM, ServerEvent } from '@dexterm/popup';
import { THEMES } from '@dexterm/tui';
import { parseArgs, stateFromArgs, applyEffectArgs, renderFrame } from '../src/index.ts';
import { pnlChipFor } from '../src/state.ts';
import { OwnPnlTracker, chipText, chipSegments, PEAK_FLASH_MS, type OwnHeldSample } from '../src/screens/pnl-chip.ts';
import { HUD_MIN_H } from '../src/screens/agent-hud.ts';
import { makeScanUi } from '../src/scan/ui.ts';
import { ownHeldSample } from '../src/main.ts';
import { TokenPopups, chartChipFrom, type ChartSource } from '../src/popup.ts';
import { emptyView } from '../src/live/token.ts';
import type { HeldPosition } from '../src/live/trade.ts';

const T0 = 1_800_000_000_000;
const MINT = 'So11111111111111111111111111111111111111112';

let seq = 0;
const ev = (dt: number, tool: string, detail: SpectatorDetail | null = null, extra: Partial<SpectatorEvent> = {}): SpectatorEvent =>
  ({ v: 1, seq: ++seq, t: T0 + dt, phase: extra.phase ?? 'result', agent: 'claude-code', transport: 'mcp', tool, summary: tool, ok: true, ms: 50, detail, ...extra });

function fixtureState(screen: string, extra: string[] = [], w = 120, h = 40) {
  const a = parseArgs(['--fixtures', '--screen', screen, '--width', String(w), '--height', String(h), '--selected', '0', '--frame', '40', '--theme', 'cyberspace', ...extra]);
  const s = stateFromArgs(a);
  applyEffectArgs(s, a);
  return s;
}

/** An agent that bought $10 PAPER of `mint` at $0.01 and was marked to $0.0131 (9 s) then $0.0124 (12 s). */
function holding(mint: string, symbol: string, upTo = 12_000): AgentStory {
  const s = new AgentStory('claude-code');
  s.apply(ev(0, 'paper_pnl', { caps: { perTradeUsd: 10, totalUsd: 100, maxPriceImpactPct: 3 } }));
  s.thought(`${symbol} passes. Buying $10 PAPER, TP1 +40%, no stop.`, T0 + 3800, 'agent', false);
  s.apply(ev(4000, 'paper_open_ticket', { ticket: { side: 'buy', symbol, mint } }));
  s.apply(ev(5000, 'paper_size_ticket', { ticket: { side: 'buy', symbol, mint, usd: 10 } }));
  s.apply(ev(6000, 'paper_confirm', { fill: { side: 'buy', symbol, mint, sol: -0.0667, qty: 1000, priceUsd: 0.01, impactPct: 0.4, realizedSol: 0 }, position: { mint, symbol, qty: 1000, costSol: 0.0667, realizedSol: 0 } }));
  if (upTo >= 9000) s.mark(mint, 0.0131, T0 + 9000);
  if (upTo >= 12_000) s.mark(mint, 0.0124, T0 + 12_000);
  return s;
}

const own = (over: Partial<OwnHeldSample> = {}): OwnHeldSample => ({
  mint: MINT, symbol: 'MINE', kind: 'paper', entryUsd: 0.02, markUsd: 0.022, pnlPct: 0.1, pnlUsd: 1.5, openedAt: T0, targetUsd: null, ...over,
});

// ---------------------------------------------------------------------------------------------------------------
// the own-position tracker (AI scan mode)

test('OwnPnlTracker: session peak (first mark seeds it without a flash), new peak flashes, drawdown, reset on flat / coin change', () => {
  const t = new OwnPnlTracker();
  assert.equal(t.vm(T0), null, 'nothing sampled: no chip');
  t.update(own(), T0 + 1000);
  let m = t.vm(T0 + 1000)!;
  assert.equal(m.kind, 'PAPER');
  assert.equal(m.symbol, 'MINE');
  assert.equal(m.peakPct, 0.1);
  assert.equal(m.newPeak, false, 'the first mark only seeds the peak');
  assert.equal(m.heldMs, 1000);
  assert.equal(m.tp, null);
  assert.match(chipText(m, 200), /PAPER \$MINE │ ▲ \+10\.0% \+\$1\.50 │ peak \+10\.0% │ \$0\.0200 → \$0\.0220 │ held 1s │ TP not set/);
  t.update(own({ pnlPct: 0.25, pnlUsd: 3.75, markUsd: 0.025 }), T0 + 2000);
  m = t.vm(T0 + 2100)!;
  assert.equal(m.peakPct, 0.25);
  assert.equal(m.newPeak, true, 'raised peak flashes');
  assert.equal(t.vm(T0 + 2000 + PEAK_FLASH_MS + 1)!.newPeak, false, 'the flash expires');
  assert.match(chipText(m, 200), /peak \+25\.0% ★/, 'the ★ glyph carries the flash under calm / NO_COLOR');
  t.update(own({ pnlPct: 0.05, pnlUsd: 0.75, markUsd: 0.021, targetUsd: 0.03 }), T0 + 3000);
  m = t.vm(T0 + 3000)!;
  assert.equal(m.peakPct, 0.25, 'the peak holds');
  assert.ok(Math.abs(m.ddPct! - (1.05 / 1.25 - 1)) < 1e-9);
  assert.match(chipText(m, 200), /dd −16\.0% │ TP \$0\.0300/);
  t.update(own({ mint: 'OTHER', symbol: 'NEW', kind: 'live', pnlPct: -0.04, pnlUsd: -0.4 }), T0 + 4000);
  m = t.vm(T0 + 4000)!;
  assert.equal(m.kind, 'LIVE');
  assert.equal(m.peakPct, -0.04, 'a different coin starts a fresh peak');
  assert.match(chipText(m, 200), /^ LIVE \$NEW │ ▼ −4\.0% −\$0\.40/);
  t.update(null, T0 + 5000);
  assert.equal(t.vm(T0 + 5000), null, 'flat: no chip');
  assert.equal(t.mint, null);
});

// ---------------------------------------------------------------------------------------------------------------
// one selector

test('pnlChipFor: the agent ticket wins; else the own position only while AI scan mode runs; else null', () => {
  const st = fixtureState('screener');
  st.ownPnl = new OwnPnlTracker();
  st.ownPnl.update(own(), T0);
  assert.equal(pnlChipFor(st, T0), null, 'scan off: the own position has no chip (no auto mode)');
  st.scan = makeScanUi();
  st.scan.engine.start(T0);
  assert.equal(pnlChipFor(st, T0)!.symbol, 'MINE', 'scan on: the user\'s own position');
  const tk = st.fx.tokens[0];
  st.agentHud = { story: holding(tk.mint, tk.symbol), clock: () => T0 + 12_000, dataLabel: 'SAMPLE DATA' };
  assert.equal(pnlChipFor(st, T0 + 12_000)!.symbol, tk.symbol, 'following an agent that holds: its ticket');
  st.agentHud = { story: new AgentStory('claude-code'), clock: () => T0, dataLabel: null };
  assert.equal(pnlChipFor(st, T0)!.symbol, 'MINE', 'agent flat + scan on: falls back to the own position');
  st.scan.engine.stop(T0 + 1);
  assert.equal(pnlChipFor(st, T0), null);
});

// ---------------------------------------------------------------------------------------------------------------
// band-row chip (no HUD dock)

test('short terminal (< HUD_MIN_H): the chip rides the band row on the screener and token screen while the agent holds', () => {
  for (const screen of ['screener', 'token', 'watchlist']) {
    for (const [w, h] of [[120, HUD_MIN_H - 1], [120, 20], [80, 16]] as const) {
      const st = fixtureState(screen, [], w, h);
      const tk = st.fx.tokens[0];
      st.agentHud = { story: holding(tk.mint, tk.symbol), clock: () => T0 + 12_000, dataLabel: 'SAMPLE DATA' };
      const lines = renderFrame(st, w, h).toPlain().split('\n');
      assert.match(lines[1], new RegExp(`PAPER \\$${tk.symbol} │ ▲ \\+24\\.0%`), `${screen} ${w}x${h}: chip on the band row`);
      for (const l of lines) assert.ok(l.length <= w);
    }
  }
  // at ≥ HUD_MIN_H the dock carries it and the band does not repeat it
  const st = fixtureState('screener', [], 120, HUD_MIN_H);
  const tk = st.fx.tokens[0];
  st.agentHud = { story: holding(tk.mint, tk.symbol), clock: () => T0 + 12_000, dataLabel: 'SAMPLE DATA' };
  const lines = renderFrame(st, 120, HUD_MIN_H).toPlain().split('\n');
  assert.ok(!/PAPER \$/.test(lines[1]), 'no band chip when the dock is up');
  assert.equal(lines.filter((l) => l.includes(`PAPER $${tk.symbol} │`)).length, 1, 'exactly one chip');
});

test('AI scan mode with the user\'s own position: band-row chip on the list screens and the token screen; calm + NO_COLOR keep the glyphs', () => {
  for (const screen of ['screener', 'token', 'newpairs']) {
    const st = fixtureState(screen, ['--calm']);
    st.colorDepth = 'none';
    st.scan = makeScanUi();
    st.scan.engine.start(T0);
    st.ownPnl = new OwnPnlTracker();
    st.ownPnl.update(own(), T0);
    st.ownPnl.update(own({ pnlPct: 0.3, pnlUsd: 4.5, markUsd: 0.026 }), Date.now()); // fixture frames read the wall clock
    const lines = renderFrame(st, 120, 40).toPlain().split('\n');
    assert.match(lines[1], /PAPER \$MINE │ ▲ \+30\.0% \+\$4\.50 │ peak \+30\.0%/, `${screen}: own chip on the band`);
  }
  const off = fixtureState('screener');
  off.ownPnl = new OwnPnlTracker();
  off.ownPnl.update(own(), T0);
  assert.ok(!/PAPER \$MINE/.test(renderFrame(off, 120, 40).toPlain()), 'no auto mode: no chip (the normal app is unchanged)');
});

test('ownHeldSample: the scan\'s locked coin when held, else the open token, else the first open mint; marked with the terminal price', () => {
  const st = fixtureState('screener');
  const held = (mint: string, symbol: string): HeldPosition => ({ mint, symbol, side: 'long', tokens: 1000, costSol: 0.1, avgEntrySol: 0.0001, realizedSol: 0, markSol: null, stopUsd: null, targetUsd: 0.03, kind: 'paper' });
  const pos: Record<string, HeldPosition> = { A: held('A', 'AAA'), B: held('B', 'BBB') };
  (st as unknown as { live: unknown }).live = {
    token: { view: { mint: 'B', price: 0.025 } }, badgeFor: () => 'POLL', livePrice: () => null,
    positionSource: { openMints: () => ['A', 'B'], held: (m: string) => pos[m] ?? null, solUsd: () => 150 },
    livePositions: null, wallet: { trades: () => [{ t: T0 - 60_000, mint: 'B', side: 'buy', tokenDelta: 1000n, grossLamports: -100_000_000n, decimals: 0, priceUsd: 0.015 }] },
  };
  st.sol = { price: 150, chg24: 0 };
  let s = ownHeldSample(st, T0)!;
  assert.equal(s.mint, 'B', 'the open token is held');
  assert.ok(Math.abs(s.markUsd! - 0.025) < 1e-12);
  assert.ok(Math.abs(s.entryUsd! - 0.015) < 1e-12, '0.0001 SOL × $150');
  assert.ok(Math.abs(s.pnlPct! - (0.025 / 0.015 - 1)) < 1e-9);
  assert.equal(s.openedAt, T0 - 60_000, 'held since the first fill of the current position');
  assert.equal(s.targetUsd, 0.03);
  st.scan = makeScanUi();
  (st.scan.engine as unknown as { lock: unknown }).lock = { mint: 'A', symbol: 'AAA', score: 60, reads: 1 };
  s = ownHeldSample(st, T0 + 6000)!;
  assert.equal(s.mint, 'A', 'the scan\'s locked coin wins when held');
  (st as unknown as { live: { positionSource: { openMints: () => string[] } } }).live.positionSource.openMints = () => [];
  assert.equal(ownHeldSample(st, T0 + 7000), null, 'flat');
});

// ---------------------------------------------------------------------------------------------------------------
// chart popup

const M = 60_000, H = 3_600_000;
function bars1m(n: number): Candle[] { return Array.from({ length: n }, (_, i) => ({ t: i * M, o: 1, h: 1.01, l: 0.99, c: 1 + i * 1e-4, v: 10 + i })); }

function popupHarness(chip: (() => ReturnType<NonNullable<ChartSource['pnlChip']>>) | undefined) {
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
  const source: ChartSource = {
    series: () => ({ candles: aggregateCandles(bars1m(600), M, H), fetchedAt: 1, stale: false, derived: true }),
    livePrice: () => null, feed: () => 'POLL',
    positions: { kind: 'paper', held: () => null, solUsd: () => 150 },
    fills: () => [], solUsd: () => 150,
    ...(chip ? { pnlChip: chip } : {}),
  };
  const tp = new TokenPopups({ theme: THEMES.cyberspace, env: { DEXTERM_HOME: '/nonexistent-1473' }, source, createManager: mgr, syncMinMs: 0 });
  return { tp, pushes, ev: (e: ServerEvent) => onEvent?.(e) };
}

function chartView(mint = 'CHARTED') {
  const v = emptyView({ mint, symbol: 'WIF', name: 'dogwifhat', launchpad: 'pump.fun' }, '1h');
  v.price = 1.5;
  v.candles = aggregateCandles(bars1m(600), M, H);
  v.panels.candles = { state: 'ok', via: 'geckoterminal', reason: null, fetchedAt: 1, stale: false };
  return v;
}

test('chart popup: the chip rides every push (the HELD coin, even when another coin is charted), same segments as the terminal', async () => {
  const st = fixtureState('token');
  const tk = st.fx.tokens[0];
  let now = T0 + 9100;
  const story = holding(tk.mint, tk.symbol, 9000);
  st.agentHud = { story, clock: () => now, dataLabel: 'SAMPLE DATA' };
  const h = popupHarness(() => pnlChipFor(st, now));
  await h.tp.openChart(chartView());
  let vm = h.pushes.at(-1)!;
  assert.ok(vm.chip, 'chip on the first push');
  assert.equal(vm.chip!.kind, 'PAPER');
  assert.equal(vm.chip!.symbol, tk.symbol, 'the held coin, not the charted WIF');
  assert.equal(vm.chip!.tone, 'up');
  assert.equal(vm.chip!.newPeak, true);
  assert.deepEqual(vm.chip!.segments, chipSegments(pnlChipFor(st, now)!));
  assert.match(vm.chip!.segments.map((s) => s.text).join(' │ '), /PAPER \$\S+ │ ▲ \+31\.0% \+\$3\.10 │ peak \+31\.0% ★/);
  // the next tick re-marks: the popup follows
  story.mark(tk.mint, 0.0085, T0 + 12_000);
  now = T0 + 12_000;
  h.ev({ ev: 'popup.ready', popupId: 'p1', kind: 'chart', openToReadyMs: 1, page: 'chart' });
  h.tp.syncChart(chartView());
  vm = h.pushes.at(-1)!;
  assert.equal(vm.chip!.tone, 'down');
  assert.match(vm.chip!.segments[1].text, /▼ −15\.0% −\$1\.50/);
  // no position / no auto mode: no chip; an old source without pnlChip: null too
  st.agentHud = null;
  h.tp.syncChart(chartView());
  assert.equal(h.pushes.at(-1)!.chip, null);
  const old = popupHarness(undefined);
  await old.tp.openChart(chartView());
  assert.equal(old.pushes.at(-1)!.chip, null);
});

test('chartChipFrom: tone from the sign (muted before a mark); null in, null out; no addresses in the chip', () => {
  assert.equal(chartChipFrom(null), null);
  const t = new OwnPnlTracker();
  t.update(own({ pnlPct: null, pnlUsd: null, markUsd: null }), T0);
  const c = chartChipFrom(t.vm(T0))!;
  assert.equal(c.tone, 'muted');
  assert.ok(!JSON.stringify(c).includes(MINT), 'the chip carries the symbol, never the mint');
});
