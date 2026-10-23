// task-1368 — Jupiter 429 / 5xx handling on the quote path. A ticket died on an HTTP 429 from the keyless Jupiter API.
// These tests replay the RECORDED shape of a keyless Jupiter rate limit (fixtures/trade/jupiter-429-2026-10-12.json:
// 429, body `[API Gateway] Too many requests`, NO Retry-After, x-ratelimit-reset a few seconds out) plus the
// standards-form Retry-After variant and the 503 the alternate host answered the same minute, through the REAL
// HttpClient + RateLimiter on a fake clock, into the real (paper) quote adapter. No network. task-1571: the signer and
// swap-build cases left with the local signer.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { FakeClock } from '../src/clock.ts';
import { HealthRegistry } from '../src/health.ts';
import { HttpClient, HttpError } from '../src/http.ts';
import type { HttpRequest, HttpResponse, Transport } from '../src/http.ts';
import { RateLimiter } from '../src/limiter.ts';
import { JupiterSwap, JupiterHosts, JupiterRateLimitedError, isTransientJupiterError, JUP_RETRY_MAX_TOTAL_MS } from '../src/sources/jupiter-swap.ts';
import { SOL_MINT } from '../src/paper.ts';
import { drive } from './helpers.ts';

const TEST_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

interface Recorded429 { responses: { n: number; status: number; headers: Record<string, string>; body?: string; epochNowSeconds?: number }[]; retryAfterVariant: { status: number; headers: Record<string, string>; body: string }; liteApiSameMinute: { status: number; headers: Record<string, string>; body: string } }
const FIX: Recorded429 = JSON.parse(readFileSync(fileURLToPath(new URL('../fixtures/trade/jupiter-429-2026-10-12.json', import.meta.url)), 'utf8'));
const REC_429 = FIX.responses.find((r) => r.status === 429)!;
/** Fake time = the recorded "now" of the 429, so x-ratelimit-reset is 3 s out exactly as it was. */
const T0 = REC_429.epochNowSeconds! * 1000;
const RESET_MS = Number(REC_429.headers['x-ratelimit-reset']) * 1000 - T0; // 3000

const QUOTE = { inputMint: SOL_MINT, outputMint: TEST_MINT, amount: 10_000_000n, slippageBps: 50, mode: 'ExactIn' as const };
const RAW_QUOTE = { inputMint: SOL_MINT, outputMint: TEST_MINT, inAmount: '10000000', outAmount: '1092439', otherAmountThreshold: '1086977', swapMode: 'ExactIn', slippageBps: 50, priceImpactPct: '0', platformFee: null, routePlan: [{ swapInfo: { label: 'Meteora' } }], contextSlot: 1, swapUsdValue: '1.09' };

const r429 = (): HttpResponse => ({ status: 429, headers: { ...REC_429.headers }, body: REC_429.body!, latencyMs: 5 });
const r429RetryAfter = (): HttpResponse => ({ status: FIX.retryAfterVariant.status, headers: { ...FIX.retryAfterVariant.headers }, body: FIX.retryAfterVariant.body, latencyMs: 5 });
const r503 = (): HttpResponse => ({ status: 503, headers: { ...FIX.liteApiSameMinute.headers }, body: FIX.liteApiSameMinute.body, latencyMs: 5 });
const r200 = (body: unknown = RAW_QUOTE): HttpResponse => ({ status: 200, headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '3' }, body: JSON.stringify(body), latencyMs: 5 });
const rStatus = (status: number): HttpResponse => ({ status, headers: {}, body: '{}', latencyMs: 5 });

/** A scripted transport: answers in order, records every request (host + path + fake time). */
function scripted(script: (HttpResponse | Error)[]) {
  const seen: { url: string; method: string; at: number }[] = [];
  const clock = new FakeClock(T0);
  const transport: Transport = async (req: HttpRequest) => {
    seen.push({ url: req.url, method: req.method, at: clock.now() });
    const next = script.shift();
    if (!next) throw new Error(`scripted transport exhausted at ${req.url}`);
    if (next instanceof Error) throw next;
    return next;
  };
  // A generous bucket: pacing here comes only from the 429 handling, never from the rpm budget.
  const limiter = new RateLimiter({ jupiter: { rpm: 6000, safety: 1, burst: 100 } }, clock);
  const health = new HealthRegistry({ clock });
  const http = new HttpClient({ transport, limiter, health, clock, rateLimitPauseMs: 3_000 });
  return { http, clock, limiter, seen, hosts: () => seen.map((s) => new URL(s.url).hostname) };
}

// task-1571: the retry policy is exercised through the PAPER quote adapter (the swap build left with the signer).
const build = (s: ReturnType<typeof scripted>, random = () => 0) => new JupiterSwap(s.http, undefined, { random });
const fetchFailed = () => new TypeError('fetch failed');

// ------------------------------------------------------------------------------------ the policy

test('isTransientJupiterError: 429 and 5xx retry, a dropped connection and a timeout retry, 4xx and a caller abort do not', () => {
  assert.equal(isTransientJupiterError(new HttpError(429, 'u')), true);
  assert.equal(isTransientJupiterError(new HttpError(503, 'u')), true);
  assert.equal(isTransientJupiterError(new HttpError(500, 'u')), true);
  assert.equal(isTransientJupiterError(new HttpError(400, 'u')), false);
  assert.equal(isTransientJupiterError(new HttpError(401, 'u')), false);
  assert.equal(isTransientJupiterError(fetchFailed()), true);
  assert.equal(isTransientJupiterError(Object.assign(new Error('x'), { name: 'TimeoutError' })), true);
  assert.equal(isTransientJupiterError(Object.assign(new Error('x'), { name: 'AbortError' })), false);
  assert.equal(isTransientJupiterError(new Error('malformed quote')), false);
});

test('recorded 429 on /quote (no Retry-After, x-ratelimit-reset 3 s out): one retry on the OTHER host after the reset; the quote succeeds; the plan is never dropped', async () => {
  const s = scripted([r429(), r200()]);
  const b = build(s);
  const raw = await drive(s.clock, b.quote(QUOTE), 100);
  assert.equal(raw.outAmount, 1092439n);
  assert.deepEqual(s.hosts(), ['api.jup.ag', 'lite-api.jup.ag'], 'alternated to lite-api for the retry');
  // The wait honoured the server's reset (3 s), not the 1 s backoff: the retry went out once the bucket's pause ended.
  assert.ok(s.seen[1].at - s.seen[0].at >= RESET_MS, `retry after ${s.seen[1].at - s.seen[0].at} ms (reset ${RESET_MS})`);
  assert.ok(s.seen[1].at - s.seen[0].at < JUP_RETRY_MAX_TOTAL_MS);
  assert.equal(b.host, 'https://lite-api.jup.ag', 'stays on the host that answered');
});

test('bounded: 429 twice in a row → the health gate cools the source down (SPEC §3.3) and the typed error names the host and an honest "retry in Ns" (≈ the cool-down); the third attempt never hits the wire', async () => {
  const s = scripted([r429(), r429(), r200()]);
  const b = build(s);
  const err = await drive(s.clock, b.quote(QUOTE).then(() => null, (e: unknown) => e), 100);
  assert.ok(err instanceof JupiterRateLimitedError, String(err));
  assert.equal(err.status, 429);
  assert.equal(err.attempts, 3);
  assert.equal(s.seen.length, 2, 'the third attempt was refused by the health gate, not sent; the 200 behind it was never requested');
  assert.match(err.message, /^Jupiter is rate limiting this IP \(429 from (api|lite-api)\.jup\.ag\); retry in \d+s$/);
  assert.ok(err.retryAfterMs >= s.http.unavailableFor('jupiter-swap') && err.retryAfterMs >= s.http.pausedFor('jupiter'), 'never shorter than the cool-down or the bucket pause');
  assert.ok(err.retryAfterMs >= 20_000 && err.retryAfterMs <= 60_000, `retryAfterMs ${err.retryAfterMs} ≈ the 30 s health backoff`);
  // While the source is cooling down a new call fails at once with the remaining wait, in the cool-down wording.
  await s.clock.advance(5_000);
  const again = await drive(s.clock, b.quote(QUOTE).then(() => null, (e: unknown) => e), 100);
  assert.ok(again instanceof JupiterRateLimitedError && again.status === 0 && again.attempts === 1, String(again));
  assert.match(again.message, /^Jupiter calls are paused after repeated rate limits \(dexterm cool-down\); retry in \d+s$/);
  assert.ok(again.retryAfterMs < err.retryAfterMs, 'the wait counts down');
  assert.equal(s.seen.length, 2);
  // After the cool-down the next call goes out and succeeds.
  await s.clock.advance(again.retryAfterMs + 100);
  const raw = await drive(s.clock, b.quote(QUOTE), 100);
  assert.equal(raw.outAmount, 1092439n);
  assert.equal(s.seen.length, 3);
});

test('bounded in TIME: a Retry-After longer than the 10 s budget fails at once (no sleep, one request) with that wait', async () => {
  const long = r429RetryAfter(); long.headers['retry-after'] = '30';
  const s = scripted([long, r200()]);
  const b = build(s);
  const t0 = s.clock.now();
  const err = await drive(s.clock, b.quote(QUOTE).then(() => null, (e: unknown) => e), 100);
  assert.ok(err instanceof JupiterRateLimitedError);
  assert.equal(err.attempts, 1);
  assert.equal(s.seen.length, 1);
  assert.equal(err.retryAfterMs, 30_000);
  assert.ok(s.clock.now() - t0 < 1_000, 'did not sleep out a wait it could not afford');
});

test('the alternate host answering 503 (recorded from lite-api the same minute) alternates straight back; 500 three times rethrows the HttpError, not a rate-limit error', async () => {
  const s = scripted([r429(), r503(), r200()]);
  const raw = await drive(s.clock, build(s).quote(QUOTE), 100);
  assert.equal(raw.inAmount, 10000000n);
  assert.deepEqual(s.hosts(), ['api.jup.ag', 'lite-api.jup.ag', 'api.jup.ag']);

  const s2 = scripted([rStatus(500), rStatus(500), rStatus(500)]);
  const err = await drive(s2.clock, build(s2).quote(QUOTE).then(() => null, (e: unknown) => e), 100);
  assert.ok(err instanceof HttpError && err.status === 500, String(err));
  assert.equal(s2.seen.length, 3);
});

test('a dropped connection (undici "fetch failed") retries on the other host; a 400 does not retry at all', async () => {
  const s = scripted([fetchFailed(), r200()]);
  await drive(s.clock, build(s).quote(QUOTE), 100);
  assert.deepEqual(s.hosts(), ['api.jup.ag', 'lite-api.jup.ag']);

  const s2 = scripted([rStatus(400), r200()]);
  const err = await drive(s2.clock, build(s2).quote(QUOTE).then(() => null, (e: unknown) => e), 100);
  assert.ok(err instanceof HttpError && err.status === 400);
  assert.equal(s2.seen.length, 1);
});

test('401 keyless refusal keeps the sticky session failover (no wait, not a retry); later calls start on lite-api', async () => {
  const s = scripted([rStatus(401), r200(), r200()]);
  const b = build(s);
  await drive(s.clock, b.quote(QUOTE), 100);
  assert.deepEqual(s.hosts(), ['api.jup.ag', 'lite-api.jup.ag']);
  assert.equal(s.seen[1].at, s.seen[0].at, 'no backoff on a refusal');
  await drive(s.clock, b.quote({ ...QUOTE, amount: 20_000_000n }), 100);
  assert.equal(s.hosts()[2], 'lite-api.jup.ag');
});

test('jitter: the backoff is base × 2^(attempt−1) × [0.5, 1.5), and Retry-After wins when longer', async () => {
  const at = async (random: number) => {
    const s = scripted([rStatus(500), rStatus(500), r200()]);
    await drive(s.clock, build(s, () => random).quote(QUOTE), 50);
    return [s.seen[1].at - s.seen[0].at, s.seen[2].at - s.seen[1].at];
  };
  assert.deepEqual(await at(0), [500, 1000], 'lowest jitter: 1 s × 0.5, then 2 s × 0.5');
  const hi = await at(0.999);
  assert.ok(hi[0] >= 1_499 && hi[0] < 1_550 && hi[1] >= 2_998 && hi[1] < 3_100, `highest jitter ${hi}`);
  const s = scripted([r429RetryAfter(), r200()]);
  await drive(s.clock, build(s, () => 0).quote(QUOTE), 50);
  assert.ok(s.seen[1].at - s.seen[0].at >= 2_000, 'Retry-After 2 s beats the 0.5 s backoff');
});

test('a caller abort during the backoff rejects with AbortError and sends nothing more', async () => {
  const s = scripted([r429(), r200()]);
  const ac = new AbortController();
  const p = build(s).quote(QUOTE, ac.signal).then(() => null, (e: unknown) => e);
  await s.clock.advance(200);
  ac.abort();
  const err = await drive(s.clock, p, 100);
  assert.ok(err instanceof Error && err.name === 'AbortError', String(err));
  assert.equal(s.seen.length, 1);
});

test('JupiterHosts: one host still retries in place; maxAttempts 1 means no retry', async () => {
  const clock = new FakeClock(T0);
  let n = 0;
  const one = new JupiterHosts(['https://api.jup.ag'], { clock, random: () => 0 });
  const p = one.run(async (host) => { n++; if (n < 2) throw new HttpError(503, host); return host; });
  assert.equal(await drive(clock, p, 100), 'https://api.jup.ag');
  assert.equal(n, 2);
  const none = new JupiterHosts(['https://api.jup.ag', 'https://lite-api.jup.ag'], { clock, maxAttempts: 1 });
  await assert.rejects(none.run(async () => { throw new HttpError(503, 'u'); }), (e: unknown) => e instanceof HttpError && e.status === 503);
});

// ------------------------------------------------------------------------------------ one limiter: quote reuse

test('the PAPER quote adapter (JupiterSwap) follows the same policy: recorded 429 → other host → normalized quote', async () => {
  const s = scripted([r429(), r200()]);
  const js = new JupiterSwap(s.http, undefined, { random: () => 0 });
  const q = await drive(s.clock, js.quote(QUOTE), 100);
  assert.equal(q.outAmount, 1092439n);
  assert.equal(q.priceImpactPct, 0);
  assert.deepEqual(s.hosts(), ['api.jup.ag', 'lite-api.jup.ag']);
});
