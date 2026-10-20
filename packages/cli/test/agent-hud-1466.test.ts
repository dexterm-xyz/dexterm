// task-1466 (spectator v2): the agent HUD a following terminal draws. The dock sits BELOW the app's own frame
// (no data hidden), PAPER is always visible, the controls are always visible until a kill, a kill is a hard cut
// with a stamp, NO_COLOR keeps meaning in glyphs, calm (reduced motion) drops the motion, and the thoughts feed
// is parsed as display text only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentStory, type SpectatorEvent, type SpectatorDetail } from '@dexterm/agents';
import { parseArgs, stateFromArgs, applyEffectArgs, renderFrame } from '../src/index.ts';
import { markPriceFor, shouldDrawFrame } from '../src/main.ts';
import { DOCK_ROWS, HUD_MIN_H, hudAnimating } from '../src/screens/agent-hud.ts';
import { McpFollowSession, thoughtsOf } from '../src/mcp-follow.ts';
import { screenerView } from '../src/screener/view.ts';

const W = 192, H = 54;
const T0 = 1_800_000_000_000;
const KATA = /[ｦ-ﾝ]/;

function fixtureState(screen: string, extra: string[] = []) {
  const a = parseArgs(['--fixtures', '--screen', screen, '--width', String(W), '--height', String(H), '--selected', '0', '--frame', '40', ...extra]);
  const s = stateFromArgs(a);
  applyEffectArgs(s, a);
  return s;
}

let seq = 0;
const ev = (dt: number, tool: string, detail: SpectatorDetail | null = null, extra: Partial<SpectatorEvent> = {}): SpectatorEvent =>
  ({ v: 1, seq: ++seq, t: T0 + dt, phase: extra.phase ?? 'result', agent: 'claude-code', transport: 'mcp', tool, summary: tool, ok: true, ms: 50, detail, ...extra });

function storyFor(mint: string, symbol: string, upTo: number): AgentStory {
  const s = new AgentStory('claude-code');
  const steps: Array<[number, () => void]> = [
    [0, () => s.apply(ev(0, 'paper_pnl', { caps: { perTradeUsd: 10, totalUsd: 100, maxPriceImpactPct: 3 } }))],
    [1000, () => s.apply(ev(1000, 'screener_query', { rows: [{ mint, symbol, chg: 12 }] }))],
    [2000, () => s.apply(ev(2000, 'open_token', { coin: { mint, symbol } }, { phase: 'nav', nav: { screen: 'token', mint } }))],
    [3000, () => s.apply(ev(3000, 'larp_check', { coin: { mint, symbol }, larp: { flags: 1, items: ['no GitHub repo advertised'] } }))],
    [4000, () => s.apply(ev(4000, 'paper_open_ticket', { ticket: { side: 'buy', symbol, mint } }))],
    [5000, () => s.apply(ev(5000, 'paper_size_ticket', { ticket: { side: 'buy', symbol, mint, usd: 10 } }))],
    [6000, () => s.apply(ev(6000, 'paper_confirm', { fill: { side: 'buy', symbol, mint, sol: -0.0667, qty: 1000, priceUsd: 0.01, impactPct: 0.4, realizedSol: 0 }, position: { mint, symbol, qty: 1000, costSol: 0.0667, realizedSol: 0 } }))],
    [12_000, () => s.mark(mint, 0.0135, T0 + 12_000)],
    [20_000, () => s.apply(ev(20_000, 'paper_close', { fill: { side: 'sell', symbol, mint, sol: 0.09, qty: 1000, priceUsd: 0.0135, impactPct: 0.3, realizedSol: 0.0233 }, position: { mint, symbol, qty: 0, costSol: 0, realizedSol: 0.0233 } }))],
  ];
  for (const [at, f] of steps) if (at <= upTo) f();
  return s;
}

function hudFrame(screen: string, dt: number, opts: { extra?: string[]; story?: AgentStory; depth?: 'none'; h?: number; axis?: 'mcap' | 'price' } = {}) {
  const st = fixtureState(screen, opts.extra);
  if (opts.axis) st.chartAxis = opts.axis; // task-1472
  const row = screenerView(st.screener)[0];
  const story = opts.story ?? storyFor(row.mint, row.symbol, dt);
  if (opts.depth) st.colorDepth = opts.depth;
  st.agentHud = { story, clock: () => T0 + dt, dataLabel: 'SAMPLE DATA' };
  const c = renderFrame(st, W, opts.h ?? H);
  const rows = c.toPlain().split('\n');
  return { c, rows, dock: rows.slice((opts.h ?? H) - DOCK_ROWS).join('\n'), story, row };
}

test('the dock sits below the app frame: the screen renders DOCK_ROWS shorter, nothing of it is hidden', () => {
  const st = fixtureState('screener');
  const plainShort = renderFrame(st, W, H - DOCK_ROWS).toPlain().split('\n');
  st.agentHud = { story: new AgentStory('claude-code'), clock: () => T0, dataLabel: null };
  const withHud = renderFrame(st, W, H).toPlain().split('\n');
  assert.equal(withHud.length, H);
  assert.deepEqual(withHud.slice(0, H - DOCK_ROWS), plainShort, 'an idle HUD leaves every screen cell as the app drew it');
  assert.match(withHud.slice(H - DOCK_ROWS).join('\n'), /waiting for the agent/);
});

test('the rail lights the current phase; PAPER and the pause/kill keys are always on the dock', () => {
  for (const [dt, phase] of [[1000, 'SCANNING'], [3000, 'VETTING'], [5000, 'SIZING'], [6100, 'EXECUTING'], [12_000, 'HOLDING'], [20_100, 'EXITING']] as const) {
    const f = hudFrame('token', dt);
    assert.ok(f.dock.includes(`▸${phase}`), `${phase} lit at ${dt}`);
    assert.match(f.dock, /PAPER/);
    assert.match(f.dock, /\^P\s+pause/);
    assert.match(f.dock, /\^K\s+KILL/);
  }
});

test('the timeline shows the calls as nodes with timing chips, newest at the right', () => {
  const f = hudFrame('token', 6100);
  const tl = f.rows.slice(H - 2).join('\n');
  for (const l of ['scan', 'open', 'larp', 'TICKET', 'SIZE', 'FILL']) assert.ok(tl.includes(l), l);
  assert.ok(tl.indexOf('FILL') > tl.indexOf('TICKET'));
  assert.match(tl, /50ms/);
});

test('the execution moment: ticket assembles, FILLED with the app numbers, then the position panel ticks the mark PnL', () => {
  const ticket = hudFrame('token', 5500).rows.join('\n');
  assert.match(ticket, /PAPER ORDER TICKET/);
  assert.match(ticket, /\$10\.00   cap \$10\.00\/trade/);
  assert.match(ticket, /YOUR keypress armed the mandate · tier hands-free/);
  const filled = hudFrame('token', 7500).rows.join('\n');
  assert.match(filled, /FILLED · PAPER/);
  assert.match(filled, /0\.0667 SOL → 1\.0K \$/);
  // task-1473: on the token screen the analyst panel's brain view carries the position; the HUD card shows elsewhere
  const holding = hudFrame('screener', 13_000).rows.join('\n');
  assert.match(holding, /PAPER POSITION/);
  assert.match(holding, /peak \+35\.0%/);
  // task-1472: the chart axis defaults to market cap, so entry/mark read MC (compact k/M/B) when the supply is known
  assert.match(holding, /entry MC \$[\d.]+[kMBT]? · mark MC \$[\d.]+[kMBT]?/);
  assert.match(hudFrame('token', 13_000, { axis: 'price' }).rows.join('\n'), /entry \$0\.0100 · mark \$0\.0135/);
  const result = hudFrame('token', 21_000).rows.join('\n');
  assert.match(result, /PAPER RESULT/);
  assert.match(result, /\+0\.0233 SOL realized · held 14s · 1 exit/);
  assert.match(result, /simulated paper trade · not a result/);
});

test('the agent cursor marks the opened row on the screener; scanned rows are keyed by mint', () => {
  const f = hudFrame('screener', 2100);
  const line = f.rows.find((r) => r.includes(f.row.symbol) && r.includes('▶'));
  assert.ok(line, 'the opened row carries the ▶ cursor');
  assert.ok(f.c.rowMarks.some((m) => m.key === f.row.mint));
});

test('pause and take-over say so on the band and the dock; a kill is a hard cut with a stamp, then KILLED stays', () => {
  const st = fixtureState('screener');
  const row = screenerView(st.screener)[0];
  const paused = storyFor(row.mint, row.symbol, 1000); paused.setControl('paused', T0 + 1100);
  const p = hudFrame('screener', 1500, { story: paused });
  assert.match(p.rows[1], /AGENT PAUSED BY YOU/);
  assert.match(p.dock, /PAUSED/);
  assert.match(p.dock, /\^P\s+resume/);
  const killed = storyFor(row.mint, row.symbol, 12_000); killed.setControl('killed', T0 + 12_000);
  const k = hudFrame('token', 13_600, { story: killed });
  assert.match(k.rows.join('\n'), /AGENT STOPPED/);
  assert.match(k.rows.join('\n'), /session closed · agent paper desk stopped/);
  assert.match(k.dock, /AGENT KILLED/);
  assert.doesNotMatch(k.dock, /\^P/);
  const later = hudFrame('token', 30_000, { story: killed });
  assert.doesNotMatch(later.rows.join('\n'), /AGENT STOPPED/, 'the stamp clears; the terminal is yours again');
  assert.match(later.dock, /AGENT KILLED/);
});

test('NO_COLOR keeps meaning in glyphs: ▸ on the active phase, ✓ on ok chips', () => {
  const f = hudFrame('token', 6100, { depth: 'none' });
  assert.match(f.dock, /▸EXECUTING/);
  assert.match(f.dock, /✓\d+ms/);
});

test('calm (reduced motion): no assembly noise or glitch; cards appear complete at once', () => {
  const open = hudFrame('token', 2200, { extra: ['--calm'] });
  assert.ok(!open.rows.slice(0, H - DOCK_ROWS).some((r) => KATA.test(r)), 'no katakana wipe in calm');
  const ticket = hudFrame('token', 4010, { extra: ['--calm'] }).rows.join('\n');
  assert.match(ticket, /EXITS {3}agent-managed/, 'every ticket line is there at once');
});

test('a terminal shorter than HUD_MIN_H gets no HUD (the toasts carry the status there); task-1473 r2: only the PnL chip on the band row', () => {
  const st = fixtureState('screener');
  const plain = renderFrame(st, W, HUD_MIN_H - 1).toPlain();
  st.agentHud = { story: storyFor(screenerView(st.screener)[0].mint, 'X', 6000), clock: () => T0 + 6100, dataLabel: null };
  const a = plain.split('\n'), b = renderFrame(st, W, HUD_MIN_H - 1).toPlain().split('\n');
  assert.equal(b.length, a.length);
  for (let i = 0; i < a.length; i++) if (i !== 1) assert.equal(b[i], a[i], `row ${i} unchanged: no dock, no overlays`);
  assert.match(b[1], /PAPER \$X │/, 'the agent holds: its PnL chip rides the band row');
});

test('frame gate: the HUD paints at full fps while it animates, never in calm (data ticks only)', () => {
  const base = { calm: false, transition: false, onTick: false, aiLive: false, awake: false, fxBusy: false, frame: 3, idleEvery: 6 };
  assert.equal(shouldDrawFrame({ ...base, hud: true }), true);
  assert.equal(shouldDrawFrame({ ...base, hud: false }), false);
  assert.equal(shouldDrawFrame({ ...base, calm: true, hud: true }), false);
  const s = storyFor('AAAAaaaa1111111111111111111111111111111pump', 'X', 6000);
  assert.equal(hudAnimating(s.view(T0 + 6100), T0 + 6100), true);
  assert.equal(hudAnimating(new AgentStory('a').view(T0), T0), false);
});

test('markPriceFor uses the price this terminal shows (screener row), else null', () => {
  const st = fixtureState('screener');
  const row = screenerView(st.screener)[0];
  assert.equal(markPriceFor(st, row.mint), row.price);
  assert.equal(markPriceFor(st, 'ZZZZzzzz1111111111111111111111111111111pump'), null);
});

test('thoughtsOf: stream-json text/thinking, brain feed, plain lines; junk and tool calls yield nothing', () => {
  assert.deepEqual(thoughtsOf(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Opening it.' }, { type: 'tool_use', name: 'x', input: {} }, { type: 'thinking', thinking: 'tape first' }] } })).map((x) => x.text), ['Opening it.', 'tape first']);
  assert.deepEqual(thoughtsOf(JSON.stringify({ tEpoch: T0, tRel: 1, ev: { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } } })), [{ text: 'hi', t: T0 }]);
  assert.deepEqual(thoughtsOf('{"thought":"plain"}'), [{ text: 'plain', t: null }]);
  assert.deepEqual(thoughtsOf('{"type":"user","message":{"content":[{"type":"tool_result","content":"x"}]}}'), []);
  assert.deepEqual(thoughtsOf('not json'), []);
});

test('a following session tails the thoughts file into the story (scrubbed), alongside the channel', () => {
  const home = mkdtempSync(join(tmpdir(), 'dexterm-hud-'));
  const thoughts = join(home, 'brain.jsonl');
  writeFileSync(thoughts, '');
  const s = new McpFollowSession({ env: { DEXTERM_HOME: home } as NodeJS.ProcessEnv, thoughtsFile: thoughts, now: () => T0 });
  appendFileSync(thoughts, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Buying ‮RUNR now. AAAAaaaa1111111111111111111111111111111pump looks clean.' }] } }) + '\n');
  appendFileSync(thoughts, '{"type":"assistant","message":{"content":[{"type":"text","text":"half a li'); // incomplete line waits
  s.pump();
  const th = s.storyView(T0).thoughts;
  assert.equal(th.length, 1);
  assert.equal(th[0].source, 'agent');
  assert.equal(th[0].text, 'Buying RUNR now. AAAA…pump looks clean.');
});

test('--spectate-thoughts needs --spectate-mcp', () => {
  assert.throws(() => parseArgs(['--spectate-thoughts', '/tmp/x.jsonl']), /needs --spectate-mcp/);
  assert.equal(parseArgs(['--spectate-mcp', '--spectate-thoughts', '/tmp/x.jsonl']).spectateThoughts, '/tmp/x.jsonl');
});

test('the spectator popup gets the same story, redacted: rail, heartbeat, ribbon, timeline, vetting and PAPER cards', async () => {
  const { buildSpectatorVM } = await import('../src/agent-spectator.ts');
  const { FollowController } = await import('@dexterm/agents');
  const mint = 'AAAAaaaa1111111111111111111111111111111pump';
  const story = storyFor(mint, 'RUNR', 12_000);
  story.thought(`watching ${mint} closely`, T0 + 12_100, 'agent');
  const vm = buildSpectatorVM(new FollowController(), { story: story.view(T0 + 12_200) });
  assert.ok(vm.story);
  assert.equal(vm.story!.phase, 'holding');
  assert.deepEqual(vm.story!.rail, ['scanning', 'vetting', 'sizing', 'executing', 'holding', 'exiting']);
  assert.equal(vm.story!.arc?.stage, 'open');
  assert.equal(vm.story!.arc?.sizeUsd, 10);
  assert.ok(Math.abs((vm.story!.arc?.pnlPct ?? 0) - 0.35) < 1e-9);
  assert.equal(vm.story!.focus?.larpFlags, 1);
  assert.ok(vm.story!.nodes.some((n) => n.label === 'FILL'));
  assert.ok(!JSON.stringify(vm.story).includes(mint), 'no full address reaches the popup');
  assert.match(vm.story!.thoughts.at(-1)!.text, /AAAA…pump/);
  const plain = buildSpectatorVM(new FollowController());
  assert.equal('story' in plain, false, 'an older caller without a story gets the old VM');
});

test('a desk refusal while holding (e.g. paused) is stamped on the position panel and goes red on the timeline', () => {
  const st = fixtureState('token');
  const row = screenerView(st.screener)[0];
  const story = storyFor(row.mint, row.symbol, 12_000);
  story.apply(ev(13_000, 'paper_close', { refusal: 'paused' }, { ok: false, phase: 'refused', summary: 'error: agent paper trading is paused' }));
  const f = hudFrame('token', 13_500, { story });
  assert.match(f.rows.join('\n'), /REFUSED BY THE DESK · paused/); // task-1473: stamped on the brain view's position block
  assert.match(f.dock, /REFUSED/);
  assert.match(hudFrame('token', 15_500, { story }).dock, /refused by the desk · paused/, 'narration, once typed in');
  assert.doesNotMatch(hudFrame('token', 20_000, { story }).rows.join('\n'), /REFUSED BY THE DESK/, 'the stamp clears');
});
