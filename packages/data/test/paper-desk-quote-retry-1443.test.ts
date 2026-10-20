// task-1443 capture round 3: a PAPER exit that hits a keyless Jupiter 429 is re-quoted inside a bounded budget
// instead of being refused at once (run3: the +25% TP1 sell was refused "retry in 58s" and filled after the dump).
// The retry is journaled and reported before it runs; the fill is booked from the FRESH quote (never an old one);
// the budget, a non-rate-limit error and a pause during the wait all still refuse with nothing booked.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FakeClock } from '../src/clock.ts';
import { Journal } from '../src/trade/plans/journal.ts';
import { draftMandate } from '../src/trade/plans/mandate.ts';
import { PaperWallet, PaperExecutor, SOL_MINT } from '../src/paper.ts';
import { JupiterRateLimitedError, type QuoteRequest, type SwapQuote } from '../src/sources/jupiter-swap.ts';
import { HttpError } from '../src/http.ts';
import { PaperAgentDesk, PaperDeskError, isRateLimitedQuoteError, type DeskControl, type QuoteRetryInfo } from '../src/trade/agent/paper-desk.ts';

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function quoteAt(req: QuoteRequest, lamportsPerTokenRaw: number, fetchedAt: number): SwapQuote {
  const buy = req.inputMint === SOL_MINT;
  const outAmount = buy
    ? BigInt(Math.max(1, Math.floor(Number(req.amount) / lamportsPerTokenRaw)))
    : BigInt(Math.max(1, Math.floor(Number(req.amount) * lamportsPerTokenRaw)));
  return {
    inputMint: req.inputMint, outputMint: req.outputMint, inAmount: req.amount, outAmount,
    otherAmountThreshold: outAmount, mode: 'ExactIn', slippageBps: req.slippageBps,
    priceImpactPct: 0.5, route: ['Pump.fun Amm'], platformFeeBps: null, platformFeeAmount: null,
    usdValue: null, contextSlot: null, source: 'jupiter-swap', fetchedAt,
  };
}

/**
 * A desk on a FakeClock whose quote replays a script: each entry is an Error to throw, a price to quote at, or
 * 'hang' (never resolves until the caller aborts). Buys before the script starts quote at 1000.
 */
function rig(opts: { maxAttempts?: number; maxWaitMs?: number; maxTotalMs?: number } = {}) {
  const clock = new FakeClock(1_700_000_000_000);
  const wallet = new PaperWallet({ path: ':memory:', clock });
  const journal = new Journal({ clock });
  const control = { v: { state: 'running' } as DeskControl };
  const m = draftMandate({}, { clock }); m.status = 'armed'; m.armedAt = clock.now();
  const script: Array<Error | number | 'hang'> = [];
  const calls: Array<{ side: 'buy' | 'sell'; at: number; aborted: boolean }> = [];
  const retries: QuoteRetryInfo[] = [];
  const quote = (req: QuoteRequest, signal?: AbortSignal): Promise<SwapQuote> => {
    const side = req.inputMint === SOL_MINT ? 'buy' : 'sell';
    const call = { side, at: clock.now(), aborted: false } as (typeof calls)[number];
    calls.push(call);
    const step = side === 'buy' ? 1000 : script.shift() ?? 1000;
    if (step instanceof Error) return Promise.reject(step);
    if (step === 'hang') {
      return new Promise((_, reject) => signal?.addEventListener('abort', () => {
        call.aborted = true; reject(Object.assign(new Error('aborted by caller'), { name: 'AbortError' }));
      }, { once: true }));
    }
    return Promise.resolve(quoteAt(req, step, clock.now()));
  };
  const desk = new PaperAgentDesk({
    mandate: m, wallet, executor: new PaperExecutor(wallet, { clock }), quote,
    solUsd: () => 150, control: () => control.v, journal, clock, agent: 'test-agent',
    quoteRetry: { maxAttempts: opts.maxAttempts ?? 4, maxWaitMs: opts.maxWaitMs ?? 6_000, maxTotalMs: opts.maxTotalMs ?? 25_000 },
    onQuoteRetry: (i) => retries.push(i),
  });
  const buy = async () => { const t = desk.open({ mint: MINT, symbol: 'SAMPLE', decimals: 6, side: 'buy' }); desk.size(t.id, { usd: 5 }); await desk.confirm(t.id); };
  /** Run a desk call to completion while the fake clock moves forward in 500 ms steps. */
  const drive = async <T>(p: Promise<T>, maxMs = 60_000): Promise<T> => {
    let done = false; const out = p.finally(() => { done = true; });
    out.catch(() => { /* asserted by the caller */ });
    for (let t = 0; !done && t < maxMs; t += 500) await clock.advance(500);
    return out;
  };
  return { clock, desk, wallet, journal, control, script, calls, retries, buy, drive };
}

const rl = (s: number) => new JupiterRateLimitedError(429, 'https://api.jup.ag', s * 1000, 3);

test('a rate-limited exit quote is re-quoted after a bounded wait and books the FRESH quote', async () => {
  const r = rig();
  await r.buy();
  const held = r.wallet.position(MINT)!.tokensRaw;
  // run3's refusal verbatim: the shared bucket said 58 s. The desk waits at most 6 s, then quotes again at a NEW price.
  r.script.push(rl(58), 1300);
  const t0 = r.clock.now();
  const res = await r.drive(r.desk.close({ mint: MINT, fraction: 1 / 3 }));
  assert.equal(res.fill.side, 'sell');
  assert.equal(res.quoteAttempts, 2);
  const sells = r.calls.filter((c) => c.side === 'sell');
  assert.equal(sells.length, 2, 'one refused quote, one fresh re-quote');
  assert.equal(sells[1].at - t0, 6_000, 'the 58 s stated wait is cut to the 6 s bound');
  // The fill is priced from the second quote (1300 lamports/raw token), not from anything earlier.
  const soldRaw = held - r.wallet.position(MINT)!.tokensRaw;
  assert.equal(res.fill.solDelta + 5_000n, BigInt(Math.floor(Number(soldRaw) * 1300)), 'SOL out = the fresh quote amount minus the simulated fee');
  // The retry was reported before it ran and journaled with the verbatim refusal text.
  assert.equal(r.retries.length, 1);
  assert.deepEqual({ ...r.retries[0], message: undefined }, { stage: 'close', mint: MINT, side: 'sell', attempt: 2, maxAttempts: 4, waitMs: 6_000, message: undefined });
  assert.match(r.retries[0].message, /^Jupiter is rate limiting this IP \(429 from api\.jup\.ag\); retry in 58s$/);
  const types = r.journal.types();
  assert.ok(types.indexOf('agent.paper.quote-retry') < types.lastIndexOf('agent.paper.fill'), 'retry journaled before the fill');
  assert.ok(r.journal.verify().ok);
});

test('a short stated wait is honoured as stated (never shorter than 1 s)', async () => {
  const r = rig();
  await r.buy();
  r.script.push(rl(2), new JupiterRateLimitedError(0, 'https://api.jup.ag', 200, 1), 1000);
  const t0 = r.clock.now();
  const res = await r.drive(r.desk.close({ mint: MINT }));
  assert.equal(res.quoteAttempts, 3);
  assert.deepEqual(r.retries.map((i) => i.waitMs), [2_000, 1_000]);
  const sells = r.calls.filter((c) => c.side === 'sell');
  assert.deepEqual(sells.map((c) => c.at - t0), [0, 2_000, 3_000]);
});

test('a 429 that outlasts the attempt budget is refused as before, nothing booked', async () => {
  const r = rig({ maxAttempts: 3 });
  await r.buy();
  const held = r.wallet.position(MINT)!.tokensRaw;
  r.script.push(rl(58), rl(51), rl(45), 1300);
  await assert.rejects(r.drive(r.desk.close({ mint: MINT })), (e: unknown) => e instanceof PaperDeskError && e.reason === 'quote-failed'
    && /^could not price the trade: Jupiter is rate limiting this IP \(429 from api\.jup\.ag\); retry in 45s \(3 quote attempts in 12s\)$/.test(e.message));
  assert.equal(r.calls.filter((c) => c.side === 'sell').length, 3, 'never more than maxAttempts quotes');
  assert.equal(r.wallet.position(MINT)!.tokensRaw, held, 'nothing was sold');
  assert.equal(r.retries.length, 2);
});

test('the total budget bounds the pricing step: a hung re-quote is aborted at it', async () => {
  const r = rig({ maxTotalMs: 10_000 });
  await r.buy();
  r.script.push(rl(58), 'hang');
  const t0 = r.clock.now();
  await assert.rejects(r.drive(r.desk.close({ mint: MINT })), (e: unknown) => e instanceof PaperDeskError && e.reason === 'quote-failed'
    && /^could not price the trade within 10s: Jupiter is rate limiting this IP/.test(e.message));
  const sells = r.calls.filter((c) => c.side === 'sell');
  assert.equal(sells.length, 2);
  assert.equal(sells[1].aborted, true, 'the in-flight quote was aborted at the budget');
  assert.ok(r.clock.now() - t0 <= 10_500, 'refused at the budget, not after the stated 58 s');
});

test('a wait that would overrun the budget is not started', async () => {
  const r = rig({ maxTotalMs: 5_000 });
  await r.buy();
  r.script.push(rl(58), 1300);
  await assert.rejects(r.drive(r.desk.close({ mint: MINT })), (e: unknown) => e instanceof PaperDeskError && e.reason === 'quote-failed' && /retry in 58s$/.test(e.message));
  assert.equal(r.calls.filter((c) => c.side === 'sell').length, 1);
  assert.equal(r.retries.length, 0);
});

test('a non-rate-limit quote error is not retried', async () => {
  const r = rig();
  await r.buy();
  r.script.push(new Error('no route found'), 1300);
  await assert.rejects(r.drive(r.desk.close({ mint: MINT })), (e: unknown) => e instanceof PaperDeskError && e.reason === 'quote-failed' && e.message === 'could not price the trade: no route found');
  assert.equal(r.calls.filter((c) => c.side === 'sell').length, 1);
});

test('a pause that lands during the retry wait halts the agent; nothing booked', async () => {
  const r = rig();
  await r.buy();
  const held = r.wallet.position(MINT)!.tokensRaw;
  r.script.push(rl(5), 1300);
  const p = r.desk.close({ mint: MINT });
  p.catch(() => { /* asserted below */ });
  await r.clock.advance(1_000);
  r.control.v = { state: 'takeover' };
  await assert.rejects(r.drive(p), (e: unknown) => e instanceof PaperDeskError && e.reason === 'takeover');
  assert.equal(r.calls.filter((c) => c.side === 'sell').length, 1, 'no re-quote after the take-over');
  assert.equal(r.wallet.position(MINT)!.tokensRaw, held);
});

test('maxAttempts 1 keeps the old one-shot behaviour', async () => {
  const r = rig({ maxAttempts: 1 });
  await r.buy();
  r.script.push(rl(58), 1300);
  await assert.rejects(r.drive(r.desk.close({ mint: MINT })), (e: unknown) => e instanceof PaperDeskError
    && e.message === 'could not price the trade: Jupiter is rate limiting this IP (429 from api.jup.ag); retry in 58s');
  assert.equal(r.retries.length, 0);
});

test('isRateLimitedQuoteError: 429s and the jupiter cool-down only', () => {
  assert.equal(isRateLimitedQuoteError(rl(3)), true);
  assert.equal(isRateLimitedQuoteError(new HttpError(429, 'https://api.jup.ag/swap/v1/quote')), true);
  assert.equal(isRateLimitedQuoteError(Object.assign(new Error('source jupiter-swap is degraded'), { name: 'SourceUnavailableError' })), true);
  assert.equal(isRateLimitedQuoteError(new HttpError(500, 'https://api.jup.ag/swap/v1/quote')), false);
  assert.equal(isRateLimitedQuoteError(new Error('no route found')), false);
  assert.equal(isRateLimitedQuoteError('429'), false);
});
