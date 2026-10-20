// task-1473: the analyst panel's BRAIN VIEW in auto modes (following an agent, AI scan). Pure view-model tests for
// each block (reasoning stream, vetting checklist, data strip, plan/position, decision log + scoreboard), the
// degrade order, the auto-mode switch (back to the normal analyst panel when the agent is killed / quiet / the scan
// is off), calm mode (no typing), NO_COLOR glyph cues, display-only text (scrubbed, addresses shortened), and frame
// snapshots of the token screen at 192x54 and smaller.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentStory, type SpectatorEvent, type SpectatorDetail } from '@dexterm/agents';
import { parseArgs, stateFromArgs, applyEffectArgs, renderFrame } from '../src/index.ts';
import {
  agentBrainActive, agentStream, vetRows, dataCells, planVM, planFromThoughts, decisionLog, scoreLine, layoutBlocks,
  scanStream, scanBrainModel, factsFromFixture, brainFor, agentBrainModel, AGENT_QUIET_MS, type CoinFacts,
} from '../src/screens/brain.ts';
import { makeScanUi, scanLog } from '../src/scan/ui.ts';
import { pnlChipVM, chipText } from '../src/screens/pnl-chip.ts';
import { markPriceFor } from '../src/main.ts';

const W = 192, H = 54;
const T0 = 1_800_000_000_000;
const MINT = 'So11111111111111111111111111111111111111112';

let seq = 0;
const ev = (dt: number, tool: string, detail: SpectatorDetail | null = null, extra: Partial<SpectatorEvent> = {}): SpectatorEvent =>
  ({ v: 1, seq: ++seq, t: T0 + dt, phase: extra.phase ?? 'result', agent: 'claude-code', transport: 'mcp', tool, summary: tool, ok: true, ms: 50, detail, ...extra });

function fixtureState(screen: string, extra: string[] = [], w = W, h = H) {
  const a = parseArgs(['--fixtures', '--screen', screen, '--width', String(w), '--height', String(h), '--selected', '0', '--frame', '40', '--theme', 'cyberspace', ...extra]);
  const s = stateFromArgs(a);
  applyEffectArgs(s, a);
  return s;
}

/** A story about `mint`: passes a decoy coin, vets the coin, buys PAPER, holds with a mark, optionally exits. */
function story(mint: string, symbol: string, upTo: number, opts: { thoughts?: boolean; demo?: boolean } = {}): AgentStory {
  const s = new AgentStory('claude-code');
  const decoy = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
  const say = (dt: number, text: string) => { if (opts.thoughts !== false) s.thought(text, T0 + dt, 'agent', !!opts.demo); };
  const steps: Array<[number, () => void]> = [
    [0, () => s.apply(ev(0, 'paper_pnl', { caps: { perTradeUsd: 10, totalUsd: 100, maxPriceImpactPct: 3 } }))],
    [500, () => say(500, 'Flat. Scanning the movers first.')],
    [1000, () => s.apply(ev(1000, 'screener_query', { rows: [{ mint, symbol, chg: 12 }, { mint: decoy, symbol: 'DECOY', chg: 40 }] }))],
    [1500, () => s.apply(ev(1500, 'open_token', { coin: { mint: decoy, symbol: 'DECOY' } }, { phase: 'nav', nav: { screen: 'token', mint: decoy } }))],
    [1800, () => s.apply(ev(1800, 'analyze_token', { coin: { mint: decoy }, verdict: { label: 'AVOID', rug: 0.72 } }))],
    [1900, () => say(1900, `DECOY sells beat buys and the dev holds ${decoy}. Passing.`)],
    [2000, () => s.apply(ev(2000, 'open_token', { coin: { mint, symbol } }, { phase: 'nav', nav: { screen: 'token', mint } }))],
    [2500, () => s.apply(ev(2500, 'get_trades', { coin: { mint, symbol } }))],
    [2800, () => s.apply(ev(2800, 'get_holders', { coin: { mint, symbol } }))],
    [3000, () => s.apply(ev(3000, 'larp_check', { coin: { mint, symbol }, larp: { flags: 1, items: ['no GitHub repo advertised'] } }))],
    [3500, () => s.apply(ev(3500, 'analyze_token', { coin: { mint, symbol }, verdict: { label: 'WATCH', rug: 0.12 } }))],
    [3800, () => say(3800, `${symbol} passes. Buying $10 PAPER, TP1 +40%, no stop.`)],
    [4000, () => s.apply(ev(4000, 'paper_open_ticket', { ticket: { side: 'buy', symbol, mint } }))],
    [5000, () => s.apply(ev(5000, 'paper_size_ticket', { ticket: { side: 'buy', symbol, mint, usd: 10 } }))],
    [6000, () => s.apply(ev(6000, 'paper_confirm', { fill: { side: 'buy', symbol, mint, sol: -0.0667, qty: 1000, priceUsd: 0.01, impactPct: 0.4, realizedSol: 0 }, position: { mint, symbol, qty: 1000, costSol: 0.0667, realizedSol: 0 } }))],
    [9000, () => s.mark(mint, 0.0131, T0 + 9000)],
    [12_000, () => s.mark(mint, 0.0124, T0 + 12_000)],
    [20_000, () => s.apply(ev(20_000, 'paper_close', { fill: { side: 'sell', symbol, mint, sol: 0.09, qty: 1000, priceUsd: 0.0135, impactPct: 0.3, realizedSol: 0.0233 }, position: { mint, symbol, qty: 0, costSol: 0, realizedSol: 0.0233 } }))],
  ];
  for (const [at, f] of steps) if (at <= upTo) f();
  return s;
}

const facts = (over: Partial<CoinFacts> = {}): CoinFacts => ({
  mint: MINT, symbol: 'COIN', price: 0.0124, mcap: 1_240_000, liq: 48_000, chg5m: 3.2, chg1h: 12.5, buys: 62, sells: 40, wallets: 31,
  holders: 1840, top10: 18.4, mintAuth: false, freezeAuth: false, lpLocked: 100, dev: ['2 launches · 0 rugs', 'ok'], rugScore: 12,
  larpVerdict: null, closes: [1, 2, 3, 2, 4, 5], ...over,
});

// ---------------------------------------------------------------------------------------------------------------
// auto-mode switch

test('agentBrainActive: off before the first call, on while acting or holding, off after a kill or when quiet', () => {
  assert.equal(agentBrainActive(new AgentStory('a').view(T0), T0), false, 'nothing has happened yet');
  const s = story(MINT, 'COIN', 3000);
  assert.equal(agentBrainActive(s.view(T0 + 3000), T0 + 3000), true);
  assert.equal(agentBrainActive(s.view(T0 + 3000 + AGENT_QUIET_MS + 1), T0 + 3000 + AGENT_QUIET_MS + 1), false, 'quiet agent → normal panel');
  const held = story(MINT, 'COIN', 12_000);
  assert.equal(agentBrainActive(held.view(T0 + 12_000 + AGENT_QUIET_MS * 2), T0 + 12_000 + AGENT_QUIET_MS * 2), true, 'an open position keeps it up');
  held.setControl('killed', T0 + 13_000);
  assert.equal(agentBrainActive(held.view(T0 + 14_000), T0 + 14_000), false, 'a kill restores the normal panel');
});

// ---------------------------------------------------------------------------------------------------------------
// 1) stream

test('stream: agent thoughts with clock + phase tag, newest last; narration labelled when no thoughts feed', () => {
  const v = story(MINT, 'COIN', 6000).view(T0 + 6000);
  const s = agentStream(v, 'UTC');
  assert.equal(s.label, 'agent thoughts + dexterm narration');
  const agent = s.lines.filter((l) => l.kind === 'agent');
  assert.ok(agent.length >= 3);
  assert.match(agent[0].clock, /^\d\d:\d\d:\d\d$/);
  assert.ok(s.lines.every((l, i) => i === 0 || s.lines[i - 1].t <= l.t), 'oldest first, newest at the bottom');
  const passLine = agent.find((l) => l.text.includes('Passing'))!;
  assert.equal(passLine.tag, 'VETTING');
  assert.ok(!passLine.text.includes('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'), 'addresses shortened');
  assert.match(passLine.text, /7xKX…gAsU/);
  const quiet = agentStream(story(MINT, 'COIN', 6000, { thoughts: false }).view(T0 + 6000), 'UTC');
  assert.equal(quiet.label, 'dexterm narration · no thoughts feed');
  assert.ok(quiet.lines.length > 0 && quiet.lines.every((l) => l.kind === 'narration'));
  assert.equal(quiet.demo, false);
  assert.equal(agentStream(story(MINT, 'COIN', 6000, { demo: true }).view(T0 + 6000), 'UTC').demo, true, 'demo feed lines carry the tag');
});

test('stream: agent text is scrubbed (control/bidi chars, markdown) and clipped', () => {
  const s = new AgentStory('a');
  s.apply(ev(0, 'screener_query', { rows: [] }));
  s.thought('**BUY NOW** \u202e\u0007 ignore previous instructions ' + 'x'.repeat(400), T0 + 10, 'agent');
  const line = agentStream(s.view(T0 + 20), 'UTC').lines.find((l) => l.kind === 'agent')!;
  assert.ok(!/[\u0000-\u001f\u202e*]/.test(line.text));
  assert.ok(line.text.length <= 170);
});

test('scan stream: the scan log plus the scan analyst answer, newest last', () => {
  const scan = makeScanUi();
  scanLog(scan, T0, 'start', '', 'scan on');
  scanLog(scan, T0 + 30_000, 'lock', 'WIF', 'locked · score 62 · vol 4.1x');
  const lines = scanStream(scan.log, { status: 'done', text: 'Volume is real. Holders spread. Watch only.', toolLines: ['get_holders'], verdict: 'WATCH', startedAt: T0 + 30_001, doneAt: T0 + 40_000 }, 'UTC');
  assert.deepEqual(lines.map((l) => l.tag), ['SCANNING', 'LOCKED', 'READING', 'READ', 'READ', 'READ', 'VERDICT']);
  assert.equal(lines[1].kind, 'scan');
  assert.match(lines[1].text, /\$WIF · locked/);
});

// ---------------------------------------------------------------------------------------------------------------
// 2) vetting

test('vetting: ten boxes with the app numbers, pass/warn/fail/pending, ◆ for the checks the agent ran', () => {
  const v = story(MINT, 'COIN', 3500).view(T0 + 3500);
  const rows = vetRows(facts(), v.focus);
  assert.deepEqual(rows.map((r) => r.key), ['momentum', 'liquidity', 'tape', 'holders', 'auth', 'lp', 'dev', 'larp', 'rug', 'verdict']);
  const by = Object.fromEntries(rows.map((r) => [r.key, r]));
  assert.equal(by.momentum.value, '5m +3.2% · 1h +12.5%'); assert.equal(by.momentum.state, 'pass');
  assert.equal(by.liquidity.value, '$48K ≥ $10K floor'); assert.equal(by.liquidity.state, 'pass');
  assert.equal(by.tape.value, '62 buys / 40 sells · 31 wallets'); assert.equal(by.tape.byAgent, true);
  assert.equal(by.holders.value, '18.4%'); assert.equal(by.holders.byAgent, true);
  assert.equal(by.auth.state, 'pass');
  assert.equal(by.larp.value, '1 flag · no GitHub repo advertised'); assert.equal(by.larp.state, 'warn');
  assert.equal(by.rug.label, 'rug heuristic'); assert.equal(by.rug.value, '12%'); assert.equal(by.rug.state, 'pass');
  assert.equal(by.verdict.value, 'WATCH'); assert.equal(by.verdict.state, 'pass');
  // pending until a number exists; fail on the screen's thresholds
  const bad = vetRows(facts({ liq: 4000, chg5m: -2, chg1h: -9, top10: 51, mintAuth: true, lpLocked: null, buys: null, sells: null }), null);
  const b = Object.fromEntries(bad.map((r) => [r.key, r]));
  assert.equal(b.liquidity.state, 'fail'); assert.match(b.liquidity.value, /< \$10K floor/);
  assert.equal(b.momentum.state, 'fail');
  assert.equal(b.holders.state, 'fail');
  assert.equal(b.auth.state, 'fail'); assert.match(b.auth.value, /mint ENABLED/);
  assert.equal(b.lp.state, 'pending'); assert.equal(b.tape.state, 'pending');
  assert.equal(b.verdict.state, 'pending'); assert.equal(b.rug.label, 'rug score');
  assert.ok(bad.every((r) => !r.byAgent), 'no ◆ without an agent');
});

// ---------------------------------------------------------------------------------------------------------------
// 3) data strip

test('data strip: mcap, price, liq, 5m, 1h, buy/sell, holders with direction', () => {
  const d = dataCells(facts());
  assert.deepEqual(d.map((x) => x.k), ['mcap', 'price', 'liq', '5m', '1h', 'b/s', 'holders']);
  assert.equal(d[3].v, '+3.2%'); assert.equal(d[3].dir, 1);
  assert.equal(d[5].v, '62/40'); assert.equal(d[5].dir, 1);
  assert.equal(dataCells(facts({ mcap: null }))[0].v, '—');
});

// ---------------------------------------------------------------------------------------------------------------
// 4) plan + position

test('plan: entry, size, the TP/stop the agent said (labelled), mark PnL, peak, drawdown, held, waiting for', () => {
  const v = story(MINT, 'COIN', 12_000).view(T0 + 15_000);
  const p = planVM(v, T0 + 15_000)!;
  assert.equal(p.stage, 'open');
  assert.equal(p.entry, '$0.0100');
  assert.match(p.size, /^\$10\.00 \(0\.0667 SOL\)$/);
  assert.equal(p.tp, "TP +40% (agent's plan)");
  assert.equal(p.stop, 'no stop');
  assert.ok(Math.abs(p.pnlPct! - 0.24) < 1e-9);
  assert.ok(Math.abs(p.pnlUsd! - 2.4) < 1e-9);
  assert.ok(Math.abs(p.peakPct! - 0.31) < 1e-9);
  assert.ok(p.ddPct! < 0);
  assert.equal(p.heldMs, 9000);
  assert.match(p.waiting, /TP \+40%/);
  assert.equal(planVM(story(MINT, 'COIN', 20_000).view(T0 + 21_000), T0 + 21_000), null, 'closed → no plan block');
  const sized = planVM(story(MINT, 'COIN', 5000).view(T0 + 5000), T0 + 5000)!;
  assert.equal(sized.stage, 'sized'); assert.match(sized.waiting, /confirm/);
  assert.deepEqual(planFromThoughts([{ t: T0, text: 'take profit at $0.02, stop -15%', source: 'agent' }], T0), { tp: '$0.02', stop: '−15%' });
  assert.deepEqual(planFromThoughts([{ t: T0, text: 'TP1 +40%', source: 'dexterm' }], T0), { tp: null, stop: null }, 'narration is never a plan');
});

// ---------------------------------------------------------------------------------------------------------------
// 5) decisions + scoreboard

test('decision log: rejected the decoy (verdict), entered, exited; scoreboard is PAPER simulated', () => {
  const v = story(MINT, 'COIN', 20_000).view(T0 + 21_000);
  const log = decisionLog(v, 'UTC');
  assert.deepEqual(log.map((l) => [l.glyph, l.symbol]), [['✗', 'DECOY'], ['▲', 'COIN'], ['▼', 'COIN']]);
  assert.match(log[0].text, /^rejected · verdict AVOID · rug heuristic 72%/);
  assert.match(log[0].said ?? '', /Passing/);
  assert.match(log[1].text, /entered · 0\.0667 SOL \(\$10\.00\) @ \$0\.0100/);
  assert.match(log[2].text, /realized \+0\.0233 SOL/);
  assert.equal(scoreLine(v.score), 'PAPER simulated · vetted 2 · entries 1 · closed 1 (1W) · +0.0233 SOL');
});

// ---------------------------------------------------------------------------------------------------------------
// degrade order

test('layout: everything at 192x54; smaller panels drop decisions, then data, then fold the checklist', () => {
  const m = agentBrainModel(story(MINT, 'COIN', 12_000).view(T0 + 13_000), facts(), T0 + 13_000, 'UTC');
  const ids = (h: number, w = 63) => layoutBlocks(m, w, h).map((b) => b.id + (b.compact ? '*' : ''));
  assert.deepEqual(ids(44), ['stream', 'vet', 'data', 'plan', 'log']);
  assert.ok(!ids(30).includes('log') || layoutBlocks(m, 63, 30).find((b) => b.id === 'log')!.rows <= 4);
  assert.deepEqual(ids(22), ['stream', 'vet*', 'plan']);
  assert.deepEqual(ids(14), ['stream', 'plan']);
  for (const h of [44, 30, 22, 14, 9]) {
    const bs = layoutBlocks(m, 63, h);
    assert.ok(bs.reduce((s, b) => s + b.rows, 0) <= h, `fits in ${h}`);
    assert.equal(bs[0].id, 'stream');
  }
});

// ---------------------------------------------------------------------------------------------------------------
// frames

function tokenFrame(dt: number, opts: { w?: number; h?: number; extra?: string[]; depth?: 'none'; thoughts?: boolean; demo?: boolean; kill?: number } = {}) {
  const w = opts.w ?? W, h = opts.h ?? H;
  const st = fixtureState('token', opts.extra, w, h);
  const tk = st.token || st.fx.tokens[st.selected || 0];
  const s = story(tk.mint, tk.symbol, dt, { thoughts: opts.thoughts, demo: opts.demo });
  if (opts.kill !== undefined) s.setControl('killed', T0 + opts.kill);
  if (opts.depth) st.colorDepth = opts.depth;
  st.agentHud = { story: s, clock: () => T0 + dt, dataLabel: 'SAMPLE DATA' };
  const c = renderFrame(st, w, h);
  return { c, text: c.toPlain(), tk, st };
}

test('frame 192x54: the token screen analyst panel is the brain view with all five blocks', () => {
  const { text, tk } = tokenFrame(12_000);
  assert.match(text, /✦ BRAIN · claude-code/);
  assert.match(text, /REASONING · agent thoughts \+ dexterm narration/);
  assert.match(text, new RegExp(`VETTING \\$${tk.symbol}`));
  assert.match(text, /◆/);
  assert.match(text, /DATA .*app numbers · no extra fetch/);
  assert.match(text, new RegExp(`POSITION · PAPER \\$${tk.symbol}`));
  assert.match(text, /MARK PnL \+24\.0% \(\+\$2\.40 paper\)/);
  assert.match(text, /DECISIONS/);
  assert.match(text, /PAPER simulated/);
  assert.match(text, /display only · cannot trade/);
  assert.ok(!/Press {2}a {2}to run a full dossier/.test(text), 'the static help is gone');
});

test('frame: normal analyst panel returns after a kill (once the cut is over) and without follow', () => {
  const { text } = tokenFrame(20_000, { kill: 12_000 });
  assert.ok(!/✦ BRAIN/.test(text));
  const st = fixtureState('token');
  const plain = renderFrame(st, W, H).toPlain();
  assert.ok(!/✦ BRAIN/.test(plain));
  assert.match(plain, /ANALYST/);
});

test('frame: calm mode shows the newest line at once (no typing cursor); live mode types it in', () => {
  const live = tokenFrame(3801).text;
  const calm = tokenFrame(3801, { extra: ['--calm'] }).text;
  assert.match(calm, /Buying \$10 PAPER, TP1 \+40%, no stop\./);
  assert.ok(!/Buying \$10 PAPER, TP1 \+40%, no stop\./.test(live), 'still typing 1 ms after it arrived');
});

test('frame: NO_COLOR keeps the state glyphs and the demo-text tag shows for a stand-in feed', () => {
  const { text } = tokenFrame(12_000, { depth: 'none', demo: true });
  assert.match(text, /[✓!✗] ◆ tape b\/s/);
  assert.match(text, /✦ claude lines: demo text/);
  assert.ok(!/demo text/.test(tokenFrame(12_000).text), 'no tag for a real thoughts feed');
});

test('frame: degrades at 150x45 and 120x40 without overflow; compact (<100) has no panel', () => {
  for (const [w, h] of [[150, 45], [120, 40]] as const) {
    const { text } = tokenFrame(12_000, { w, h });
    assert.match(text, /✦ BRAIN/);
    assert.match(text, /REASONING/);
    assert.ok(text.split('\n').every((l) => [...l].length <= w), `no row wider than ${w}`); // toPlain trims trailing blanks
  }
  assert.ok(!/✦ BRAIN/.test(tokenFrame(12_000, { w: 96, h: 30 }).text));
});

test('brainFor: AI scan mode owns the panel on the locked coin only; typing into the analyst restores it', () => {
  const st = fixtureState('token');
  const tk = st.token || st.fx.tokens[0];
  const scan = makeScanUi();
  scan.engine.start(T0);
  st.scan = scan;
  scanLog(scan, T0, 'start', '', 'scan on');
  const f = factsFromFixture(tk);
  const b = brainFor(st, f, false, 'ai 1/8 per h');
  assert.ok(b);
  assert.equal(b.model.mode, 'scan');
  assert.match(b.model.score ?? '', /observe-only · never trades/);
  (scan.engine as unknown as { lock: unknown }).lock = { mint: 'other', symbol: 'X', score: 60, reads: 1 };
  assert.equal(brainFor(st, f, false), null, 'locked on another coin');
  (scan.engine as unknown as { lock: unknown }).lock = null;
  st.aiFocused = true;
  assert.equal(brainFor(st, f, false), null);
  const m = scanBrainModel({ mode: 'LOCKED', lock: { mint: tk.mint, symbol: tk.symbol, score: 61, reads: 2 }, note: 'next read ≥ 40s', scanned: 120, floorUsd: 10_000, log: scan.log, answer: null, usage: 'ai 2/8 per h' }, f, 'UTC');
  assert.match(m.status ?? '', /LOCKED \$\S+ · score 61 · read 2 · 120 coins · next read ≥ 40s/);
});

// ---------------------------------------------------------------------------------------------------------------
// the persistent POSITION PnL chip (HUD dock signal row, every screen while the agent holds)

test('pnl chip VM: coin, PnL % + paper $, entry → mark, peak, drawdown, held, the TP the agent said; null when flat', () => {
  const s = story(MINT, 'COIN', 12_000);
  const m = pnlChipVM(s.view(T0 + 12_000), T0 + 12_000)!;
  assert.equal(m.symbol, 'COIN');
  assert.ok(Math.abs(m.pnlPct! - 0.24) < 1e-9);
  assert.ok(Math.abs(m.pnlUsd! - 2.4) < 1e-9);
  assert.ok(Math.abs(m.peakPct! - 0.31) < 1e-9);
  assert.ok(m.ddPct! < 0);
  assert.equal(m.heldMs, 6000);
  assert.equal(m.tp, '+40%');
  assert.equal(m.newPeak, false, 'the 12 s mark is below the 9 s peak');
  assert.equal(pnlChipVM(s.view(T0 + 9100), T0 + 9100)!.newPeak, true, 'a fresh peak flashes');
  assert.equal(pnlChipVM(story(MINT, 'COIN', 5000).view(T0 + 5000), T0 + 5000), null, 'ticket only: no chip');
  assert.equal(pnlChipVM(story(MINT, 'COIN', 20_000).view(T0 + 20_000), T0 + 20_000), null, 'closed: no chip');
  const full = chipText(m, 200);
  assert.match(full, /PAPER \$COIN │ ▲ \+24\.0% \+\$2\.40 │ peak \+31\.0% │ \$0\.0100 → \$0\.0124 │ held 6s │ dd −5\.3% │ TP \+40%/);
  // narrower: fields drop from the right, the coin and the PnL stay
  assert.match(chipText(m, 40), /^ PAPER \$COIN │ ▲ \+24\.0% \+\$2\.40/);
  assert.ok(chipText(m, 40).length <= 40);
  const neg = { ...m, pnlPct: -0.12, pnlUsd: -1.2 };
  assert.match(chipText(neg, 60), /▼ −12\.0% −\$1\.20/, 'red/green also carried by sign + arrow (NO_COLOR)');
});

test('pnl chip frame: on the screener AND the token screen while holding; survives the held coin leaving the list; calm + NO_COLOR', () => {
  for (const screen of ['screener', 'token', 'watchlist']) {
    const st = fixtureState(screen);
    const tk = st.fx.tokens[0];
    st.agentHud = { story: story(tk.mint, tk.symbol, 12_000), clock: () => T0 + 12_000, dataLabel: 'SAMPLE DATA' };
    const text = renderFrame(st, W, H).toPlain();
    assert.match(text, new RegExp(`PAPER \\$${tk.symbol} │ ▲ \\+24\\.0% \\+\\$2\\.40`), `chip on ${screen}`);
  }
  // the held coin is not in the screener list any more: the chip still shows (it reads the story, not the rows)
  const st = fixtureState('screener', ['--calm']);
  st.colorDepth = 'none';
  st.agentHud = { story: story(MINT, 'GONE', 9100), clock: () => T0 + 9100, dataLabel: 'SAMPLE DATA' };
  assert.ok(!st.screener.rows.some((r) => r.mint === MINT));
  const text = renderFrame(st, 120, 40).toPlain();
  assert.match(text, /PAPER \$GONE │ ▲ \+31\.0%/);
  assert.match(text, /peak \+31\.0% ★/, 'calm / NO_COLOR: the new peak is a glyph, not only a flash');
  // flat: no chip
  const flat = fixtureState('screener');
  flat.agentHud = { story: story(MINT, 'COIN', 3000), clock: () => T0 + 3000, dataLabel: 'SAMPLE DATA' };
  assert.ok(!/PAPER \$COIN │/.test(renderFrame(flat, W, H).toPlain()));
});

test('markPriceFor: the held coin off the screener list is marked from the fast-lane price', () => {
  const st = fixtureState('screener');
  assert.equal(markPriceFor(st, MINT), null);
  (st as unknown as { live: unknown }).live = { token: null, badgeFor: () => 'LIVE', livePrice: (m: string) => (m === MINT ? 0.0123 : null) };
  assert.equal(markPriceFor(st, MINT), 0.0123);
});
