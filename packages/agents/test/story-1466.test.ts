// task-1466 (spectator v2): the AgentStory folds spectator events into the phase rail, heartbeat, timeline,
// thought ribbon, touched rows and the PAPER trade arc. Every number on the arc must be the app's own (fill /
// position detail, the app's mark price), agent text only reaches the ribbon (scrubbed), and a kill is final.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentStory, ribbonText, ribbonLines, sanitizeDetail, redactSpectatorEvent, EXEC_HOLD_MS, type SpectatorEvent, type SpectatorDetail } from '../src/index.ts';

const A = 'AAAAaaaa1111111111111111111111111111111pump';
const B = 'BBBBbbbb2222222222222222222222222222222pump';
let seq = 0;
const ev = (t: number, tool: string, detail: SpectatorDetail | null = null, extra: Partial<SpectatorEvent> = {}): SpectatorEvent =>
  ({ v: 1, seq: ++seq, t, phase: extra.phase ?? 'result', agent: 'claude-code', transport: 'mcp', tool, summary: tool, ok: true, ms: 40, detail, ...extra });

/** A full lifecycle: scan → vet → ticket → fill → hold (marks) → partial exit → full exit. */
function lifecycle(): AgentStory {
  const s = new AgentStory('claude-code');
  s.apply(ev(1000, 'screener_query', { rows: [{ mint: A, symbol: 'RUNR', chg: 41 }, { mint: B, symbol: 'DUD', chg: -3 }] }));
  s.apply(ev(2000, 'open_token', { coin: { mint: A, symbol: 'RUNR' } }, { phase: 'nav', nav: { screen: 'token', mint: A } }));
  s.apply(ev(3000, 'get_trades', { coin: { mint: A } }));
  s.apply(ev(4000, 'larp_check', { coin: { mint: A, symbol: 'RUNR' }, larp: { flags: 1, items: ['no GitHub repo advertised'] } }));
  s.apply(ev(5000, 'analyze_token', { coin: { mint: A, symbol: 'RUNR' }, verdict: { label: 'WATCH', rug: 0.12 } }));
  s.apply(ev(6000, 'paper_open_ticket', { ticket: { side: 'buy', symbol: 'RUNR', mint: A } }));
  s.apply(ev(7000, 'paper_size_ticket', { ticket: { side: 'buy', symbol: 'RUNR', mint: A, usd: 10 } }));
  s.apply(ev(8000, 'paper_confirm', {
    fill: { side: 'buy', symbol: 'RUNR', mint: A, sol: -0.0667, qty: 1_000_000, priceUsd: 0.00001, impactPct: 0.4, realizedSol: 0 },
    position: { mint: A, symbol: 'RUNR', qty: 1_000_000, costSol: 0.0667, realizedSol: 0 },
  }));
  return s;
}

test('scan → vet → size → execute → hold: the rail moves through the phases in order', () => {
  const s = new AgentStory('claude-code');
  assert.equal(s.view(0).phase, 'idle');
  s.apply(ev(1000, 'screener_query', { rows: [{ mint: A, symbol: 'RUNR', chg: 41 }] }));
  assert.equal(s.view(1000).phase, 'scanning');
  s.apply(ev(2000, 'get_candles', { coin: { mint: A } }));
  assert.equal(s.view(2000).phase, 'vetting');
  s.apply(ev(3000, 'paper_open_ticket', { ticket: { side: 'buy', symbol: 'RUNR', mint: A } }));
  assert.equal(s.view(3000).phase, 'sizing');
  s.apply(ev(4000, 'paper_confirm', { fill: { side: 'buy', symbol: 'RUNR', mint: A, sol: -0.1, qty: 100, priceUsd: 1, impactPct: 0.1, realizedSol: 0 }, position: { mint: A, symbol: 'RUNR', qty: 100, costSol: 0.1, realizedSol: 0 } }));
  assert.equal(s.view(4000).phase, 'executing', 'the execution moment is lit right after the fill');
  // A read during the moment does not cut it short …
  s.apply(ev(4500, 'paper_positions', null));
  assert.equal(s.view(4500).phase, 'executing');
  // … and it settles into HOLDING afterwards; scanning while holding is a sub-activity, not a phase change.
  assert.equal(s.view(4000 + EXEC_HOLD_MS + 1).phase, 'holding');
  s.apply(ev(9000, 'screener_query', { rows: [{ mint: B, symbol: 'DUD', chg: 1 }] }));
  const v = s.view(9000);
  assert.equal(v.phase, 'holding');
  assert.equal(v.sub, 'scanning');
});

test('the trade arc carries the app numbers: entry, size, live mark PnL, peak, exits and the result card', () => {
  const s = lifecycle();
  let v = s.view(8000);
  assert.equal(v.arc?.stage, 'open');
  assert.equal(v.arc?.sizeUsd, 10);
  assert.equal(v.arc?.entryUsd, 0.00001);
  assert.equal(v.arc?.spentSol, 0.0667);
  assert.equal(s.heldMint, A);
  // The app's own mark price ticks the PnL.
  s.mark(A, 0.000013, 9000);
  s.mark(A, 0.000016, 10_000);
  s.mark(A, 0.000015, 11_000);
  v = s.view(11_000);
  assert.ok(Math.abs((v.arc!.pnlPct ?? 0) - 0.5) < 1e-9);
  assert.ok(Math.abs((v.arc!.peakPct ?? 0) - 0.6) < 1e-9);
  assert.equal(v.arc!.trace.length, 4);
  // A mark for another coin is ignored.
  s.mark(B, 1, 11_500);
  assert.ok(Math.abs((s.view(11_500).arc!.pnlPct ?? 0) - 0.5) < 1e-9);
  // Partial exit, then the rest.
  s.apply(ev(12_000, 'paper_close', { fill: { side: 'sell', symbol: 'RUNR', mint: A, sol: 0.05, qty: 500_000, priceUsd: 0.000015, impactPct: 0.3, realizedSol: 0.0167 }, position: { mint: A, symbol: 'RUNR', qty: 500_000, costSol: 0.03335, realizedSol: 0.0167 } }));
  v = s.view(12_000);
  assert.equal(v.phase, 'exiting');
  assert.equal(v.arc?.stage, 'open');
  s.apply(ev(20_000, 'paper_close', { fill: { side: 'sell', symbol: 'RUNR', mint: A, sol: 0.06, qty: 500_000, priceUsd: 0.000018, impactPct: 0.3, realizedSol: 0.0266 }, position: { mint: A, symbol: 'RUNR', qty: 0, costSol: 0, realizedSol: 0.0433 } }));
  v = s.view(20_000);
  assert.equal(v.arc?.stage, 'closed');
  assert.equal(v.arc?.result?.exits, 2);
  assert.equal(v.arc?.result?.realizedSol, 0.0433, 'realized comes from the desk position, not recomputed');
  assert.ok(Math.abs((v.arc!.result!.pct ?? 0) - 0.0433 / 0.0667) < 1e-9);
  assert.equal(v.arc?.result?.holdMs, 12_000);
  assert.equal(s.heldMint, null);
  // After the moment the rail returns to scanning; a new ticket starts a new arc and keeps the old result.
  assert.equal(s.view(20_000 + EXEC_HOLD_MS + 1).phase, 'scanning');
  s.apply(ev(30_000, 'paper_open_ticket', { ticket: { side: 'buy', symbol: 'DUD', mint: B } }));
  v = s.view(30_000);
  assert.equal(v.arc?.mint, B);
  assert.equal(v.lastResult?.mint, A);
});

test('a desk refusal stamps the arc and goes red on the timeline; it never becomes a fill', () => {
  const s = new AgentStory('a');
  s.apply(ev(1000, 'paper_open_ticket', { ticket: { side: 'buy', symbol: 'RUNR', mint: A } }));
  s.apply(ev(2000, 'paper_size_ticket', { refusal: 'per-trade-cap' }, { ok: false, phase: 'refused', summary: 'error: over cap' }));
  const v = s.view(2000);
  assert.equal(v.arc?.stage, 'refused');
  assert.equal(v.arc?.refusal, 'per-trade-cap');
  assert.equal(v.nodes.at(-1)?.status, 'refused');
  assert.equal(v.nodes.at(-1)?.label, 'REFUSED');
  assert.equal(v.beats.refusedAt, 2000);
  assert.equal(v.arc?.fills.length, 0);
  assert.notEqual(v.phase, 'executing');
});

test('timeline chips: ok green, slow amber, failures red; paper nodes are marked', () => {
  const s = new AgentStory('a');
  s.apply(ev(1000, 'get_token', { coin: { mint: A } }, { ms: 120 }));
  s.apply(ev(2000, 'analyze_token', { coin: { mint: A } }, { ms: 9000 }));
  s.apply(ev(3000, 'get_holders', null, { ok: false, summary: 'error: rpc' }));
  s.apply(ev(4000, 'paper_pnl', { caps: { perTradeUsd: 10, totalUsd: 100, maxPriceImpactPct: 3 } }));
  const v = s.view(4000);
  assert.deepEqual(v.nodes.map((n) => n.status), ['ok', 'slow', 'fail', 'ok']);
  assert.equal(v.nodes[3].paper, true);
  assert.deepEqual(v.caps, { perTradeUsd: 10, totalUsd: 100, maxPriceImpactPct: 3 });
});

test('a holding agent polling its price folds into one timeline node with a count', () => {
  const s = lifecycle();
  for (let i = 0; i < 5; i++) s.apply(ev(9000 + i * 2500, 'get_token', { coin: { mint: A, priceUsd: 0.000011 } }));
  const v = s.view(20_000);
  const last = v.nodes.at(-1)!;
  assert.equal(last.tool, 'get_token');
  assert.equal(last.count, 5);
  assert.equal(v.nodes.filter((n) => n.tool === 'get_token').length, 1);
  s.apply(ev(30_000, 'paper_pnl', null));
  s.apply(ev(31_000, 'get_token', { coin: { mint: A } }));
  assert.equal(s.view(31_000).nodes.at(-1)?.count, 1, 'a different call in between starts a new node');
});

test('touched rows: a scan glows each row (staggered), an open moves the cursor, stale scans fade out', () => {
  const s = new AgentStory('a');
  s.apply(ev(1000, 'screener_query', { rows: [{ mint: A, symbol: 'RUNR' }, { mint: B, symbol: 'DUD' }] }));
  let v = s.view(1000);
  const a = v.touched.find((r) => r.mint === A)!;
  const b = v.touched.find((r) => r.mint === B)!;
  assert.equal(a.kind, 'scan');
  assert.ok(b.at > a.at, 'the glow sweeps down the rows');
  s.apply(ev(2000, 'open_token', { coin: { mint: A } }, { phase: 'nav', nav: { screen: 'token', mint: A } }));
  v = s.view(2000);
  assert.equal(v.cursor?.mint, A);
  assert.equal(v.cursor?.symbol, 'RUNR');
  assert.equal(v.touched.find((r) => r.mint === A)?.kind, 'open');
  assert.equal(s.view(60_000).touched.length, 0);
});

test('focus coin collects checks, the verdict and LARP evidence', () => {
  const s = lifecycle();
  const f = s.view(8000).focus!;
  assert.equal(f.symbol, 'RUNR');
  assert.deepEqual(f.checks, ['tape', 'larp', 'verdict']);
  assert.deepEqual(f.verdict && { label: f.verdict.label, rug: f.verdict.rug }, { label: 'WATCH', rug: 0.12 });
  assert.equal(f.larp?.flags, 1);
});

test('heartbeat speeds up with the call rate and in the execution moment; stops when paused', () => {
  const s = new AgentStory('a');
  const rest = s.bpm(0);
  for (let i = 0; i < 6; i++) s.apply(ev(1000 + i * 100, 'get_token', { coin: { mint: A } }));
  assert.ok(s.bpm(2000) > rest);
  s.setControl('paused', 3000);
  assert.equal(s.bpm(3000), 0);
});

test('a kill is final: resume after kill is ignored', () => {
  const s = new AgentStory('a');
  s.setControl('killed', 1000);
  s.setControl('running', 2000);
  const v = s.view(2000);
  assert.equal(v.control, 'killed');
  assert.equal(v.controlAt, 1000);
});

test('thought ribbon: agent text is scrubbed (control/bidi, addresses, markdown), split and clipped', () => {
  assert.equal(ribbonText('‮evil‬ **bold** `code`'), 'evil bold code');
  assert.equal(ribbonText(`buy ${A} now`), 'buy AAAA…pump now');
  assert.match(ribbonText('the tape is strong '.repeat(12), 60), /…$/);
  assert.ok(ribbonText('word '.repeat(80), 60).length <= 60);
  assert.deepEqual(ribbonLines('Tape looks strong. Buys beat sells 3:1. Third sentence.', 120, 2), ['Tape looks strong.', 'Buys beat sells 3:1.']);
  const s = new AgentStory('a');
  s.thought('Safety passes. Now the tape.', 1000, 'agent');
  s.thought('Safety passes. Now the tape.', 1100, 'agent'); // a repeat of the last line is dropped
  s.thought(`${'Long sentence here. '.repeat(20)}`, 1200, 'agent');
  const th = s.view(1200).thoughts;
  assert.deepEqual(th.slice(0, 1).map((x) => x.text), ['Safety passes. Now the tape.'], 'one message = one ribbon line');
  assert.equal(th.length, 2);
  assert.ok(th[1].text.length <= 170 && th[1].text.endsWith('.'), 'whole sentences up to the width');
  assert.equal(th[0].source, 'agent');
});

test('narration lines come from the detail numbers (dexterm voice), never from agent args', () => {
  const s = lifecycle();
  const lines = s.view(8000).thoughts.filter((x) => x.source === 'dexterm').map((x) => x.text);
  assert.ok(lines.some((l) => l.startsWith('PAPER FILL · 0.0667 SOL → 1.00M $RUNR')), lines.join(' | '));
  assert.ok(lines.some((l) => l.includes('verdict WATCH · rug heuristic 12%')));
});

test('sanitizeDetail drops malformed fields and scrubs strings; redaction masks detail addresses', () => {
  assert.equal(sanitizeDetail(null), null);
  assert.equal(sanitizeDetail({ rows: [{ mint: 'not-a-mint', symbol: 'X' }] }), null);
  const d = sanitizeDetail({ rows: [{ mint: A, symbol: 'R‮UNR'.repeat(10), chg: 'NaN' }], fill: { side: 'buy', mint: A, sol: Infinity, qty: 1 }, caps: { perTradeUsd: 10, totalUsd: 100 } });
  assert.equal(d?.rows?.[0].symbol, 'RUNRRUNRRUNRRUNR');
  assert.equal(d?.rows?.[0].chg, null);
  assert.equal(d?.fill, undefined, 'a non-finite SOL amount never reaches the arc');
  assert.deepEqual(d?.caps, { perTradeUsd: 10, totalUsd: 100, maxPriceImpactPct: null });
  const red = redactSpectatorEvent(ev(1, 'paper_confirm', { fill: { side: 'buy', symbol: 'RUNR', mint: A, sol: -1, qty: 1, priceUsd: 1, impactPct: 0, realizedSol: 0 } }));
  assert.equal(red.detail?.fill?.mint, 'AAAA…pump');
  assert.ok(!JSON.stringify(red).includes(A));
});
