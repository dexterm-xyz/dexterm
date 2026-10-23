// task-1537 — MCP: every price field keeps a market-cap twin and the price-bearing tools name the basis, so external
// agents talk in market cap by default too. JSON always carries BOTH `price` and `mcap`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpTools, TOOLS, PRICE_FIELD_TOOLS } from '../src/server.ts';

const PUMP = 'Pump1111111111111111111111111111111111pump';
const OTHER = 'Abcd1111111111111111111111111111111111111';
const NOW = Date.now();

function fakeData() {
  return {
    store: {
      enrich: async (mints: string[]) => ({
        rows: mints.map((mint) => ({ mint, token: { symbol: 'X', name: 'x', launchpad: 'raydium' }, pair: { priceUsd: 0.002, mcap: 2_000_000, fetchedAt: NOW }, mcap: { value: 2_000_000 } })),
        errors: [],
      }),
    },
    detail: {
      topPool: async () => ({ address: 'POOL1111111111111111111111111111111111111', name: 'p', dex: 'raydium' }),
      trades: async () => ({ value: [{ t: NOW - 1000, side: 'buy', usd: 50, price: 0.0000697, wallet: 'W1' }, { t: NOW - 500, side: 'sell', usd: 20, price: 0.00007, wallet: 'W2' }], fetchedAt: NOW }),
      candles: async () => ({ candles: [{ t: NOW - 7200e3, o: 0.00005, h: 0.00008, l: 0.00004, c: 0.00006, v: 10 }, { t: NOW - 3600e3, o: 0.00006, h: 0.00009, l: 0.00005, c: 0.0000697, v: 10 }], fetchedAt: NOW }),
    },
  };
}

test('the price-bearing tools say every price has an mcap twin and name the basis (market cap by default)', () => {
  for (const name of PRICE_FIELD_TOOLS) {
    const t = TOOLS.find((x) => x.name === name);
    assert.ok(t, name);
    assert.match(t!.description, /market-cap twin \(`mcap`/, name);
    assert.match(t!.description, /basis: talk in market cap by default/, name);
  }
  assert.doesNotMatch(TOOLS.find((x) => x.name === 'kb_lookup')!.description, /market-cap twin/);
});

test('get_trades: each trade keeps price and adds mcap; a pump.fun mint uses the fixed 1B supply; basis follows the app', async () => {
  const tools = new McpTools(fakeData() as never, () => ({ screen: 'token', app: { priceMode: 'mcap' } }));
  const r = await tools.call('get_trades', { mint: PUMP });
  const trades = r.trades as Array<Record<string, number | null>>;
  assert.equal(trades[0].price, 0.0000697);
  assert.equal(Math.round(trades[0].mcap!), 69_700);
  assert.equal(r.basis, 'mcap');
  assert.equal(r.supply, 'pump.fun fixed supply');
  const p = new McpTools(fakeData() as never, () => ({ screen: 'token', app: { priceMode: 'price' } }));
  assert.equal((await p.call('get_trades', { mint: PUMP })).basis, 'price');
});

test('get_candles: the summary keeps first/last/high/low/vwap and adds their caps; an unknown supply leaves them null and says so', async () => {
  const tools = new McpTools(fakeData() as never, () => ({ screen: 'token' }));
  const r = await tools.call('get_candles', { mint: PUMP });
  const s = r.summary as Record<string, number | null>;
  assert.equal(s.last, 0.0000697);
  assert.equal(Math.round(s.lastMcap!), 69_700);
  assert.equal(Math.round(s.highMcap!), 90_000);
  assert.equal(r.basis, 'mcap');
  const u = await tools.call('get_candles', { mint: OTHER });
  const us = u.summary as Record<string, number | null>;
  assert.equal(us.last, 0.0000697);
  assert.equal(us.lastMcap, null);
  assert.match(String(u.supply), /unknown \(no supply recorded\)/);
});

test('a coin the server already resolved keeps its source supply (mcap ÷ price) for later trades', async () => {
  const tools = new McpTools(fakeData() as never, () => ({ screen: 'token' }));
  await tools.call('get_token', { mint: OTHER }); // 2M cap at $0.002 = 1B tokens
  const r = await tools.call('get_trades', { mint: OTHER });
  const trades = r.trades as Array<Record<string, number | null>>;
  assert.equal(Math.round(trades[0].mcap!), 69_700);
  assert.equal(r.supply, 'market cap ÷ price');
});
