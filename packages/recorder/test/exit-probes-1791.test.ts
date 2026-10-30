// verify-1791 regression (task-1786 fix r1): the exit-probe lane classified misses on the error TEXT, and every quote
// error from the data layer embeds the quote URL (`slippageBps=500`), so `\b5\d\d\b` turned every no-route answer into a
// silent "transient" miss: a drained coin left no row. These tests throw the data layer's real errors, and the last one
// drives the real `createDataLayer` + JupiterSwap quote path over a fake transport (no network).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDataLayer, HttpError, JupiterRateLimitedError, SourceUnavailableError, RateDeferredError } from '@dexterm/data';
import { Recorder } from '../src/recorder.ts';
import { isTransientProbeError, probeErrorText, type ExitProbeDeps } from '../src/exit-probes.ts';

const MINT = '4veRZzp7aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaapump';
const QUOTE_URL = `https://api.jup.ag/swap/v1/quote?inputMint=${MINT}&outputMint=So11111111111111111111111111111111111111112&amount=500000000&slippageBps=500&swapMode=ExactIn`;
const named = (name: string, message = name) => Object.assign(new Error(message), { name });

test('classified on type and status: a 4xx or a 2xx error body is the coin (written); 429/5xx/limiter/network are not', () => {
  // Jupiter answered, no quote for this sell: the drain signal
  assert.equal(isTransientProbeError(new HttpError(400, QUOTE_URL)), false, 'HTTP 400 with slippageBps=500 in the URL');
  assert.equal(isTransientProbeError(new HttpError(404, QUOTE_URL)), false);
  assert.equal(isTransientProbeError(new HttpError(422, QUOTE_URL)), false);
  assert.equal(isTransientProbeError(new HttpError(200, QUOTE_URL, `No routes found (${QUOTE_URL})`)), false, '200 + short error');
  assert.equal(isTransientProbeError(new Error('no route found')), false);
  // says nothing about the coin
  for (const s of [401, 403, 408, 429, 500, 502, 503, 504]) assert.equal(isTransientProbeError(new HttpError(s, QUOTE_URL)), true, `HTTP ${s}`);
  assert.equal(isTransientProbeError(new HttpError(200, QUOTE_URL, `invalid JSON from ${QUOTE_URL}`)), true);
  assert.equal(isTransientProbeError(new JupiterRateLimitedError(429, 'https://lite-api.jup.ag', 30_000, 3)), true);
  assert.equal(isTransientProbeError(new JupiterRateLimitedError(0, 'https://lite-api.jup.ag', 30_000, 1)), true);
  assert.equal(isTransientProbeError(new SourceUnavailableError('jupiter' as never, 'cooling')), true);
  assert.equal(isTransientProbeError(new RateDeferredError('jupiter')), true);
  assert.equal(isTransientProbeError(named('AbortError', 'rate-limit wait aborted')), true);
  assert.equal(isTransientProbeError(named('TimeoutError', 'The operation was aborted due to timeout')), true);
  assert.equal(isTransientProbeError(new TypeError('fetch failed')), true);
  assert.equal(isTransientProbeError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })), true);
  // the text fallback never sees a URL's digits or words
  assert.equal(isTransientProbeError(new Error(`Could not find any route (${QUOTE_URL.replace('ExactIn', 'network-timeout')})`)), false);
  assert.equal(probeErrorText(new HttpError(400, QUOTE_URL)), 'HTTP 400 for https://api.jup.ag/swap/v1/quote', 'query string dropped');
  assert.equal(probeErrorText(new HttpError(200, QUOTE_URL, `No routes found (${QUOTE_URL})`)), 'No routes found (https://api.jup.ag/swap/v1/quote)');
});

test('lane: a real HttpError(400) is written as an error row; a 503 and a decimals failure are deferred, no row', async () => {
  const rec = new Recorder({ path: ':memory:', ticks: { focus: () => [{ mint: MINT, role: 'held' }] }, exitProbes: { policy: { everyMs: 0, maxPerMinute: 100 } } });
  try {
    rec.database.prepare("INSERT INTO autotrade_ticks (mint, t, role, price_usd, liquidity_usd) VALUES (?, ?, 'held', ?, 0)").run(MINT, Date.now(), 0.0001);
    let status = 503, decimalsFail = true;
    const d: ExitProbeDeps = {
      async quote() { throw new HttpError(status, QUOTE_URL); },
      async decimals() { if (decimalsFail) throw new HttpError(400, 'https://rpc.example/?api-key=x'); return 6; },
      limiter: { bucket: () => ({ stats: () => ({ pausedUntil: 0 }) }) } as never,
    };
    assert.equal((await rec.probeExits(d))?.deferred, 1, 'mint-info failure: no quote sent, no row');
    decimalsFail = false;
    assert.equal((await rec.probeExits(d))?.deferred, 1, '503: deferred');
    assert.equal(rec.database.prepare('SELECT count(*) n FROM exit_probes').get()!.n, 0);
    status = 400;
    assert.deepEqual(await rec.probeExits(d), { probed: 1, ok: 0, failed: 1, skipped: null });
    const row = rec.database.prepare('SELECT error, sol_out, tokens_in FROM exit_probes').get() as Record<string, unknown>;
    assert.equal(row.error, 'HTTP 400 for https://api.jup.ag/swap/v1/quote');
    assert.equal(row.sol_out, null);
    assert.equal(row.tokens_in, '500000000000', '$50 / $0.0001 = 500,000 tokens at 6 decimals');
  } finally { rec.close(); }
});

test('end to end over the real data layer: a 400 and a 200 "No routes found" are written; a 429 is not', async () => {
  for (const [status, body, written] of [
    [400, { error: 'Could not find any route', errorCode: 'COULD_NOT_FIND_ANY_ROUTE' }, true],
    [200, { error: 'No routes found' }, true],
    [429, { error: 'Too many requests' }, false],
  ] as const) {
    const transport = async (req: { url: string }) => req.url.includes('/swap/v1/quote')
      ? { status, headers: { 'content-type': 'application/json' }, latencyMs: 5, body: JSON.stringify(body) }
      : { status: 404, headers: {}, body: '{}', latencyMs: 1 };
    const dl = createDataLayer({ dbPath: ':memory:', transport: transport as never });
    const rec = new Recorder({ path: ':memory:', ticks: { focus: () => [{ mint: MINT, role: 'held' }] }, exitProbes: {} });
    try {
      rec.database.prepare("INSERT INTO autotrade_ticks (mint, t, role, price_usd, liquidity_usd) VALUES (?, ?, 'held', ?, 0)").run(MINT, Date.now(), 0.0001);
      const deps: ExitProbeDeps = {
        quote: async (req, signal) => { const q = await dl.jupiterSwap.quote(req, signal); return { outAmount: q.outAmount, priceImpactPct: q.priceImpactPct, routeHops: q.route.length }; },
        decimals: async () => 6,
        limiter: dl.limiter,
      };
      const r = await rec.probeExits(deps);
      const errs = (rec.database.prepare('SELECT error FROM exit_probes').all() as { error: string | null }[]).map((x) => x.error);
      if (written) {
        assert.equal(r?.failed, 1, `${status}: written`);
        assert.equal(errs.length, 1);
        assert.ok(errs[0] && !errs[0].includes('slippageBps'), `${status}: query string dropped: ${errs[0]}`);
      } else {
        assert.equal(r?.deferred, 1, `${status}: deferred`);
        assert.equal(errs.length, 0);
      }
    } finally { rec.close(); }
  }
});
