// task-1466 (spectator v2): the MCP spectator record carries a `detail` with the app-computed numbers behind a
// call (screener rows, verdict, LARP evidence, PAPER ticket / fill / position / caps, a refusal reason). Copied
// from the tool's own result only. The MCP wire (tools/call replies) is untouched; this is the local channel.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordForToolCall, detailFor } from '../src/spectator-sink.ts';

const A = 'AAAAaaaa1111111111111111111111111111111pump';

test('screener_query → rows in screen order with the 1h change; bad mints dropped', () => {
  const d = detailFor('screener_query', {}, { rows: [{ mint: A, symbol: 'RUNR', priceChange: { h1: 41.5 } }, { mint: 'nope', symbol: 'X' }] });
  assert.deepEqual(d?.rows, [{ mint: A, symbol: 'RUNR', chg: 41.5 }]);
});

test('firewalled symbols are shown by their inner text, never the tag', () => {
  const d = detailFor('screener_query', {}, { rows: [{ mint: A, symbol: '<untrusted source="jupiter:symbol" kind="symbol">RUNR</untrusted>', priceChange: { h1: 1 } }] });
  assert.equal(d?.rows?.[0].symbol, 'RUNR');
});

test('analyze_token / larp_check → verdict + LARP flags from the result, not the args', () => {
  const v = detailFor('analyze_token', { mint: A }, { mint: A, symbol: 'RUNR', deterministic_verdict: 'WATCH', rug_probability: 0.12 });
  assert.deepEqual(v?.verdict, { label: 'WATCH', rug: 0.12 });
  assert.equal(v?.coin?.mint, A);
  const l = detailFor('larp_check', { mint: A }, { mint: A, flags: ['no website advertised', 'no GitHub repo advertised'] });
  assert.deepEqual(l?.larp, { flags: 2, items: ['no website advertised', 'no GitHub repo advertised'] });
});

test('paper tools → ticket, fill, position and caps exactly as the desk returned them', () => {
  const tk = detailFor('paper_size_ticket', {}, { paper: true, ticket: { id: 't1', mint: A, symbol: 'RUNR', side: 'buy', usd: 10, fraction: null } });
  assert.deepEqual(tk?.ticket, { side: 'buy', symbol: 'RUNR', mint: A, usd: 10, fraction: null });
  const f = detailFor('paper_confirm', {}, {
    paper: true,
    fill: { mint: A, symbol: 'RUNR', side: 'buy', solDelta: -0.0667, tokens: 1_000_000, priceUsd: 0.00001, priceImpactPct: 0.4, realizedSol: 0 },
    position: { mint: A, symbol: 'RUNR', decimals: 6, tokens: 1_000_000, costSol: 0.0667, realizedSol: 0, avgEntrySol: 6.67e-8 },
  });
  assert.deepEqual(f?.fill, { side: 'buy', symbol: 'RUNR', mint: A, sol: -0.0667, qty: 1_000_000, priceUsd: 0.00001, impactPct: 0.4, realizedSol: 0 });
  assert.deepEqual(f?.position, { mint: A, symbol: 'RUNR', qty: 1_000_000, costSol: 0.0667, realizedSol: 0 });
  const c = detailFor('paper_pnl', {}, { paper: true, mandate: { perTradeUsd: 10, totalUsd: 100, maxPriceImpactPct: 3 } });
  assert.deepEqual(c?.caps, { perTradeUsd: 10, totalUsd: 100, maxPriceImpactPct: 3 });
});

test('a refused paper call carries only the stable reason; an ordinary error carries nothing', () => {
  assert.deepEqual(detailFor('paper_confirm', {}, { error: 'over the per-trade cap', reason: 'per-trade-cap' }), { refusal: 'per-trade-cap' });
  assert.equal(detailFor('get_token', { mint: A }, { error: 'not found' }), null);
});

test('the record carries detail only when there is one; the rest of the shape is unchanged', () => {
  const plain = recordForToolCall({ seq: 1, agent: 'a', tool: 'kb_search', args: {}, result: { hits: [] }, ms: 3, now: () => 5 });
  assert.equal('detail' in plain, false);
  assert.deepEqual(Object.keys(plain).sort(), ['agent', 'dataAgeSec', 'ms', 'nav', 'ok', 'phase', 'seq', 'summary', 't', 'tool', 'transport', 'v']);
  const nav = recordForToolCall({ seq: 2, agent: 'a', tool: 'open_token', args: { mint: A }, result: { ok: true }, ms: 3, now: () => 5 });
  assert.equal(nav.phase, 'nav');
  assert.deepEqual(nav.detail, { coin: { mint: A, symbol: null } });
});
