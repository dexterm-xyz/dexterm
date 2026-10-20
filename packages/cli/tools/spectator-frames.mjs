#!/usr/bin/env node
// task-1466: render the spectator v2 agent HUD over the real app frames (fixture data) at chosen moments of a
// scripted paper-trade story, to HTML + PNG, so the look can be reviewed frame by frame without a live agent.
// Deterministic: a fixed story and fixed clock per frame. The story events are SAMPLE events built from the
// fixture coins on screen (labelled SAMPLE DATA in every frame); nothing here talks to a server or a wallet.
//   node packages/cli/tools/spectator-frames.mjs [--out DIR] [--only name,name] [--width 192] [--height 54] [--scale 1] [--text]
// --text writes only the plain-text frames (no Chrome).
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AgentStory } from '@dexterm/agents';
import { renderFrame, parseArgs, stateFromArgs, applyEffectArgs } from '../src/index.ts';
import { screenerView } from '../src/screener/view.ts';
import { makeScanUi } from '../src/scan/ui.ts';
import { OwnPnlTracker } from '../src/screens/pnl-chip.ts';

/** Puppeteer from any parent node_modules (not a dependency), like shot.mjs. */
function findPuppeteer() {
  for (const start of [process.cwd(), here, process.env.DEXTERM_NODE_MODULES_FROM].filter(Boolean)) {
    let dir = start;
    for (let i = 0; i < 8; i++) {
      if (existsSync(resolve(dir, 'node_modules', 'puppeteer'))) return createRequire(resolve(dir, 'package.json'))('puppeteer');
      dir = resolve(dir, '..');
    }
  }
  throw new Error('puppeteer not found in any parent node_modules (set DEXTERM_NODE_MODULES_FROM)');
}

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const outDir = resolve(opt('--out', '/tmp/spectator-frames'));
const only = opt('--only', '').split(',').filter(Boolean);
const W = Number(opt('--width', '192')), H = Number(opt('--height', '54'));
const scale = Number(opt('--scale', '1'));
const textOnly = args.includes('--text');
mkdirSync(outDir, { recursive: true });

function baseState(screen, extra = []) {
  const a = parseArgs(['--fixtures', '--screen', screen, '--width', String(W), '--height', String(H), '--theme', 'cyberspace', '--selected', '0', '--frame', '40', ...extra]);
  const s = stateFromArgs(a);
  applyEffectArgs(s, a);
  return s;
}

// ---- the scripted story over the fixture coins (times in ms from T0)
const probe = baseState('screener');
const rows = screenerView(probe.screener).slice(0, 10);
const coin = rows[2] ?? rows[0];
const decoy = rows.find((r) => r.mint !== coin.mint) ?? coin; // task-1473: a coin it vets and rejects (decision log)
const T0 = 1_800_000_000_000;
let seq = 0;
const ev = (dt, tool, detail = null, extra = {}) => ({ v: 1, seq: ++seq, t: T0 + dt, phase: extra.phase ?? 'result', agent: 'claude-code', transport: 'mcp', tool, summary: tool, ok: extra.ok ?? true, ms: extra.ms ?? 60, detail, nav: extra.nav ?? null });
const entry = coin.price ?? 0.0001;
const SCRIPT = [
  { at: 0, thought: 'Caps are $10 per trade, $100 total. Flat. Scanning the trench movers first.' },
  { at: 600, e: ev(600, 'paper_pnl', { caps: { perTradeUsd: 10, totalUsd: 100, maxPriceImpactPct: 3 } }) },
  { at: 1500, e: ev(1500, 'screener_query', { rows: rows.map((r) => ({ mint: r.mint, symbol: r.symbol, chg: r.chg?.h1 ?? null })) }, { ms: 340 }) },
  { at: 2000, e: ev(2000, 'analyze_token', { coin: { mint: decoy.mint, symbol: decoy.symbol }, verdict: { label: 'AVOID', rug: 0.68 } }, { ms: 900 }) },
  { at: 2600, thought: `${decoy.symbol}: sells beat buys and the rug heuristic is 68%. Passing.` },
  { at: 3200, thought: `${coin.symbol} is the only row with buys beating sells and liquidity over $10k. Opening it.` },
  { at: 4200, e: ev(4200, 'open_token', { coin: { mint: coin.mint, symbol: coin.symbol } }, { phase: 'nav', nav: { screen: 'token', mint: coin.mint }, ms: 2 }) },
  { at: 5200, e: ev(5200, 'get_trades', { coin: { mint: coin.mint } }, { ms: 420 }) },
  { at: 5800, e: ev(5800, 'get_candles', { coin: { mint: coin.mint } }, { ms: 610 }) },
  { at: 6400, e: ev(6400, 'get_holders', { coin: { mint: coin.mint } }, { ms: 2900 }) },
  { at: 7300, e: ev(7300, 'larp_check', { coin: { mint: coin.mint, symbol: coin.symbol }, larp: { flags: 1, items: ['no GitHub repo advertised'] } }, { ms: 3400 }) },
  { at: 8600, e: ev(8600, 'analyze_token', { coin: { mint: coin.mint, symbol: coin.symbol }, verdict: { label: 'WATCH', rug: 0.11 } }, { ms: 1800 }) },
  { at: 9400, thought: 'Checklist passes: tape, holders, LARP is one soft flag. Entering $10 PAPER.' },
  { at: 10_200, e: ev(10_200, 'paper_open_ticket', { ticket: { side: 'buy', symbol: coin.symbol, mint: coin.mint } }, { ms: 4 }) },
  { at: 10_900, e: ev(10_900, 'paper_size_ticket', { ticket: { side: 'buy', symbol: coin.symbol, mint: coin.mint, usd: 10 } }, { ms: 3 }) },
  { at: 12_000, e: ev(12_000, 'paper_confirm', { fill: { side: 'buy', symbol: coin.symbol, mint: coin.mint, sol: -0.0667, qty: 10 / entry, priceUsd: entry, impactPct: 0.41, realizedSol: 0 }, position: { mint: coin.mint, symbol: coin.symbol, qty: 10 / entry, costSol: 0.0667, realizedSol: 0 } }, { ms: 880 }) },
  { at: 30_000, thought: 'Up 38%. Taking the first third off per the plan.' },
  { at: 31_000, e: ev(31_000, 'paper_close', { fill: { side: 'sell', symbol: coin.symbol, mint: coin.mint, sol: 0.0307, qty: 10 / entry / 3, priceUsd: entry * 1.38, impactPct: 0.33, realizedSol: 0.0085 }, position: { mint: coin.mint, symbol: coin.symbol, qty: (10 / entry) * 2 / 3, costSol: 0.0445, realizedSol: 0.0085 } }, { ms: 910 }) },
  { at: 52_000, e: ev(52_000, 'paper_close', { fill: { side: 'sell', symbol: coin.symbol, mint: coin.mint, sol: 0.0712, qty: (10 / entry) * 2 / 3, priceUsd: entry * 1.6, impactPct: 0.36, realizedSol: 0.0267 }, position: { mint: coin.mint, symbol: coin.symbol, qty: 0, costSol: 0, realizedSol: 0.0352 } }, { ms: 870 }) },
];
// the app's mark price while holding: a runner, sampled every 500 ms
const MARKS = [];
for (let dt = 12_500; dt < 52_000; dt += 500) {
  const k = (dt - 12_000) / 40_000;
  MARKS.push({ at: dt, px: entry * (1 + 0.62 * Math.sin(Math.min(1, k * 1.25) * Math.PI / 2) + 0.03 * Math.sin(dt / 900)) });
}

function storyAt(dt, controls = []) {
  const s = new AgentStory('claude-code');
  const items = [...SCRIPT.map((x) => ({ ...x, kind: 'script' })), ...MARKS.map((m) => ({ ...m, kind: 'mark' })), ...controls.map((c) => ({ ...c, kind: 'control' }))].sort((a, b) => a.at - b.at);
  for (const it of items) {
    if (it.at > dt) break;
    if (it.kind === 'mark') s.mark(coin.mint, it.px, T0 + it.at);
    else if (it.kind === 'control') s.setControl(it.c, T0 + it.at);
    else if (it.thought) s.thought(it.thought, T0 + it.at, 'agent');
    else s.apply(it.e);
  }
  return s;
}

const FRAMES = [
  { name: '01-scan-beam', screen: 'screener', dt: 1500 + 260 },
  { name: '02-scan-glow', screen: 'screener', dt: 3600 },
  { name: '03-open-cursor', screen: 'screener', dt: 4200 + 140 },
  { name: '04-token-assemble', screen: 'token', dt: 4200 + 330 },
  { name: '05-vetting-larp-sweep', screen: 'token', dt: 7300 + 380 },
  { name: '06-vetting-verdict', screen: 'token', dt: 9600 },
  { name: '07-ticket-assembling', screen: 'token', dt: 10_200 + 420 },
  { name: '08-ticket-sized', screen: 'token', dt: 11_600 },
  { name: '09-fill-flash', screen: 'token', dt: 12_000 + 120 },
  { name: '10-filled', screen: 'token', dt: 12_000 + 1500 },
  { name: '11-holding', screen: 'token', dt: 24_000 },
  { name: '12-exit-partial', screen: 'token', dt: 31_000 + 200 },
  { name: '13-holding-after-exit', screen: 'token', dt: 44_000 },
  { name: '14-result-card', screen: 'token', dt: 52_000 + 900 },
  { name: '15-paused', screen: 'screener', dt: 3600, controls: [{ at: 3000, c: 'paused' }] },
  { name: '16-kill-glitch', screen: 'token', dt: 24_000 + 400, controls: [{ at: 24_000, c: 'killed' }] },
  { name: '17-kill-stamp', screen: 'token', dt: 24_000 + 1600, controls: [{ at: 24_000, c: 'killed' }] },
  { name: '18-after-kill', screen: 'screener', dt: 34_000, controls: [{ at: 24_000, c: 'killed' }] },
  { name: '19-holding-calm', screen: 'token', dt: 24_000, calm: true },
  { name: '20-holding-nocolor', screen: 'token', dt: 24_000, depth: 'none' },
  { name: '21-scan-120x40', screen: 'screener', dt: 1500 + 260, w: 120, h: 40 },
  // task-1473: the brain view (token screen analyst panel) and the PnL chip (dock, every screen) with a position open
  { name: '22-brain-holding-120x40', screen: 'token', dt: 24_000, w: 120, h: 40 },
  { name: '23-screener-holding-chip', screen: 'screener', dt: 24_000 },
  { name: '24-watchlist-holding-chip', screen: 'watchlist', dt: 24_000 },
  { name: '25-brain-after-result', screen: 'token', dt: 60_000 },
  // task-1473 r2: under 24 rows there is no dock — the chip rides the band row; AI scan mode with the user's OWN
  // paper position (no agent): the same chip from the ledger sample (sample numbers, SAMPLE DATA coins)
  { name: '26-screener-chip-120x20', screen: 'screener', dt: 24_000, w: 120, h: 20 },
  { name: '27-token-chip-120x20', screen: 'token', dt: 24_000, w: 120, h: 20 },
  { name: '28-scan-own-chip-screener', screen: 'screener', dt: 24_000, own: true },
  { name: '29-scan-own-chip-token-120x40', screen: 'token', dt: 24_000, w: 120, h: 40, own: true },
];

const browser = textOnly ? null : await findPuppeteer().launch({ headless: true, args: ['--no-sandbox'] });
try {
  for (const f of FRAMES) {
    if (only.length && !only.some((o) => f.name.includes(o))) continue;
    const w = f.w ?? W, h = f.h ?? H;
    const state = baseState(f.screen, f.calm ? ['--calm'] : []);
    if (f.screen === 'token') { const i = state.fx.tokens.findIndex((tk) => tk.mint === coin.mint); if (i >= 0) { state.selected = i; state.token = state.fx.tokens[i]; } }
    if (f.depth) state.colorDepth = f.depth;
    if (f.own) {
      // AI scan mode on, no agent: the user's own PAPER position (a sample), peak raised once so the dd shows
      state.scan = makeScanUi(); state.scan.engine.start(state.now.getTime());
      state.ownPnl = new OwnPnlTracker();
      const now = state.now.getTime(), base = { mint: coin.mint, symbol: coin.symbol, kind: 'paper', entryUsd: coin.price / 1.24, openedAt: now - 64_000, targetUsd: coin.price * 1.4 };
      state.ownPnl.update({ ...base, markUsd: coin.price * 1.31 / 1.24, pnlPct: 0.31, pnlUsd: 3.1 }, now - 30_000);
      state.ownPnl.update({ ...base, markUsd: coin.price * 1.40 / 1.24, pnlPct: 0.40, pnlUsd: 4.0 }, now - 20_000);
      state.ownPnl.update({ ...base, markUsd: coin.price, pnlPct: 0.24, pnlUsd: 2.4 }, now);
    } else {
      const story = storyAt(f.dt, f.controls ?? []);
      state.agentHud = { story, clock: () => T0 + f.dt, dataLabel: 'SAMPLE DATA', reduced: false };
    }
    const canvas = renderFrame(state, w, h);
    const html = resolve(outDir, `${f.name}.html`);
    writeFileSync(html, canvas.toHtml({ title: `spectator v2 — ${f.name}`, depth: f.depth ?? 'truecolor' }));
    writeFileSync(resolve(outDir, `${f.name}.txt`), canvas.toPlain());
    if (!browser) { console.log(`wrote ${f.name}.txt`); continue; }
    const page = await browser.newPage();
    await page.setViewport({ width: 2600, height: 1600, deviceScaleFactor: scale });
    await page.goto(pathToFileURL(html).href, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    const el = await page.$('body');
    await el.screenshot({ path: resolve(outDir, `${f.name}.png`) });
    await page.close();
    console.log(`wrote ${f.name}`);
  }
} finally { await browser?.close(); }
void here;
