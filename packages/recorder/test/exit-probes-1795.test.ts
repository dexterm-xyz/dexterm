// verify-1795 regression (task-1786 fix r2): a no-route answer (400 COULD_NOT_FIND_ANY_ROUTE, or 200 + `error`) was
// recorded by the HTTP client as a `jupiter-swap` health failure. Three in a row degraded the source, and the gate then
// refused every later quote (JupiterRateLimitedError(0), deferred, no row), muting the drained coins AND the healthy held
// coins. The collector's deps (`exitProbeDeps`) now record such an answer as the source answering. The verifier's
// scenario over the real data layer, a fake transport and a fake clock (no network).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDataLayer, FakeClock, HttpError, JupiterRateLimitedError } from '@dexterm/data';
import { Recorder } from '../src/recorder.ts';
import { exitProbeDeps } from '../src/exit-probes.ts';

const mint = (c: string) => `${c.repeat(4)}${'x'.repeat(36)}pump`;
const HEALTHY = mint('H');
const DRAINED = [mint('A'), mint('B'), mint('C')];
const NO_ROUTE = JSON.stringify({ error: 'Could not find any route', errorCode: 'COULD_NOT_FIND_ANY_ROUTE' });

async function run(held: string[], noRoute: (m: string) => { status: number; body: string } | null, minutes: number) {
  const clock = new FakeClock(1_800_000_000_000);
  const thrown = new Map<string, number>();
  const transport = async (req: { url: string }) => {
    if (!req.url.includes('/swap/v1/quote')) return { status: 404, headers: {}, body: '{}', latencyMs: 1 };
    const m = new URL(req.url).searchParams.get('inputMint')!;
    const nr = noRoute(m);
    if (nr) return { status: nr.status, headers: { 'content-type': 'application/json' }, latencyMs: 5, body: nr.body };
    return { status: 200, headers: { 'content-type': 'application/json' }, latencyMs: 5, body: JSON.stringify({
      inputMint: m, outputMint: 'So11111111111111111111111111111111111111112', inAmount: '500000000000', outAmount: '480000000',
      otherAmountThreshold: '456000000', swapMode: 'ExactIn', slippageBps: 500, priceImpactPct: '0.4',
      routePlan: [{ swapInfo: { ammKey: 'k', label: 'Pump', inputMint: m, outputMint: 'So11111111111111111111111111111111111111112', inAmount: '500000000000', outAmount: '480000000', feeAmount: '0', feeMint: m }, percent: 100 }] }) };
  };
  const dl = createDataLayer({ dbPath: ':memory:', transport: transport as never, clock });
  const rec = new Recorder({ path: ':memory:', clock, ticks: { focus: () => held.map((m) => ({ mint: m, role: 'held' as const })) }, exitProbes: {} });
  try {
    for (const m of held) rec.database.prepare("INSERT INTO autotrade_ticks (mint, t, role, price_usd, liquidity_usd) VALUES (?, ?, 'held', ?, 0)").run(m, clock.now(), 0.0001);
    const base = exitProbeDeps(dl);
    const deps = { ...base, decimals: async () => 6, quote: async (req: never, s?: AbortSignal) => {
      try { return await base.quote(req, s); } catch (e) { const k = (e as Error).name; thrown.set(k, (thrown.get(k) ?? 0) + 1); throw e; }
    } };
    let deferred = 0;
    for (let i = 0; i < (minutes * 60) / 5; i++) {
      deferred += (await rec.probeExits(deps, clock.now()))?.deferred ?? 0;
      await clock.advance(5_000);
    }
    const per = Object.fromEntries(held.map((m) => [m.slice(0, 4), (rec.database.prepare('SELECT count(*) n, sum(error IS NOT NULL) e FROM exit_probes WHERE mint = ?').get(m) as { n: number; e: number })]));
    return { per, deferred, thrown: Object.fromEntries(thrown), health: dl.health.state('jupiter-swap') };
  } finally { rec.close(); dl.close(); }
}

test('3 no-route coins + 1 healthy for 60 min: every coin keeps its row a minute, the gate stays open', async () => {
  const r = await run([...DRAINED, HEALTHY], (m) => (DRAINED.includes(m) ? { status: 400, body: NO_ROUTE } : null), 60);
  for (const m of DRAINED) {
    const c = r.per[m.slice(0, 4)];
    assert.ok(c.n >= 58, `${m.slice(0, 4)}: ${c.n} rows (want ~60) ${JSON.stringify(r)}`);
    assert.equal(c.e, c.n, 'all no-route rows carry the error');
  }
  const h = r.per['HHHH'];
  assert.ok(h.n >= 58, `healthy coin muted: ${h.n} rows ${JSON.stringify(r)}`);
  assert.equal(h.e, 0);
  assert.equal(r.deferred, 0);
  assert.equal(r.thrown.JupiterRateLimitedError ?? 0, 0, 'the health gate never refused a probe');
  assert.equal(r.health, 'ok');
});

test('one coin alone answering 200 + error for 30 min: a row a minute, never deferred', async () => {
  const r = await run([DRAINED[0]], () => ({ status: 200, body: JSON.stringify({ error: 'No routes found' }) }), 30);
  assert.ok(r.per['AAAA'].n >= 29, JSON.stringify(r));
  assert.equal(r.per['AAAA'].e, r.per['AAAA'].n);
  assert.equal(r.deferred, 0);
  assert.equal(r.health, 'ok');
});

test('exitProbeDeps marks the source answering only for an answer, never for a 429, 5xx or the gate itself', async () => {
  for (const [err, marks] of [
    [new HttpError(400, 'https://api.jup.ag/swap/v1/quote?slippageBps=500'), true],
    [new HttpError(200, 'https://api.jup.ag/swap/v1/quote', 'No routes found (https://api.jup.ag/swap/v1/quote)'), true],
    [new HttpError(429, 'https://api.jup.ag/swap/v1/quote'), false],
    [new HttpError(503, 'https://api.jup.ag/swap/v1/quote'), false],
    [new JupiterRateLimitedError(0, 'https://api.jup.ag', 30_000, 1), false],
    [new TypeError('fetch failed'), false],
  ] as const) {
    const recorded: unknown[] = [];
    const deps = exitProbeDeps({
      jupiterSwap: { quote: async () => { throw err; } },
      detail: { mintInfo: async () => ({ value: { decimals: 6 } }) },
      limiter: {},
      health: { record: (s: string, o: unknown) => recorded.push([s, o]) },
    } as never);
    await assert.rejects(deps.quote({ inputMint: 'm', outputMint: 'o', amount: 1n, slippageBps: 500 }), (e) => e === err);
    assert.deepEqual(recorded, marks ? [['jupiter-swap', { ok: true }]] : [], `${err.name} ${(err as { status?: number }).status ?? ''}`);
  }
});
