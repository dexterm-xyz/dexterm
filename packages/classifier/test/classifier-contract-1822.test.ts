// task-1822: one adapter contract suite for every provider, against the mock System One server (and a recorded
// Kev-0.8B fixture). The hosted provider is tested ONLY against the mock: no real key exists in tests or CI.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, before, describe, it } from 'node:test';
import {
  ClassifierError, COIN_RISK, LARP_BAD, NARRATIVE, classify, classifyBatch, coinDossier, describeResult, heuristicProvider,
  jevHostedProvider, jevOpenProvider, kevLocalProvider, labelsOf, llmProvider, memoryUsage,
  type ClassifyResult, type Provider, type QuestionSet,
} from '../src/index.ts';
import { startMock, type MockServer } from './mock-systemone.ts';

const FIXTURE = JSON.parse(fs.readFileSync(new URL('./fixtures/kev-0.8b-coin-risk.json', import.meta.url), 'utf8'));
const KEY = 'ts_test_not_a_real_key_0123456789';
const coin = coinDossier({ mint: 'Mint1111111111111111111111111111111111111', symbol: 'CAT', name: 'Cat Coin', liquidity_usd: 25_000, mcap_usd: 90_000, age_min: 30, holders: 500, top10_pct: 20, link: { web: 'none', x: 'none', tg: false, webMatchesToken: null, cheapTld: null } });

const HEAD = { slots: { ranges: { noul: [0, 2] as [number, number], score: [2, 8] as [number, number], choice: [8, 24] as [number, number] } }, verbalizer_ids: Array.from({ length: 24 }, (_, i) => 1000 + i), bias: Array.from({ length: 24 }, () => 0) };

let mock: MockServer;
let hosted: MockServer;
before(async () => { mock = await startMock({ fixtures: [FIXTURE] }); hosted = await startMock({ requireKey: KEY }); });
after(async () => { await mock.close(); await hosted.close(); });

function contract(r: ClassifyResult, set: QuestionSet) {
  assert.equal(r.label, 'model-estimate');
  assert.ok(r.model && !r.model.includes('/Users/') && !r.model.startsWith('/'), `model id is not a path: ${r.model}`);
  assert.equal(r.question_set, set.id);
  for (const q of set.questions) {
    const a = r.answers[q.id];
    assert.ok(a, `answer for ${q.id}`);
    assert.equal(a.type, q.type);
    assert.deepEqual(Object.keys(a.probs).sort(), labelsOf(q).sort());
    const sum = Object.values(a.probs).reduce((x, y) => x + y, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, `${q.id} sums to 1`);
    for (const [l, p] of Object.entries(a.probs)) { assert.ok(p >= 0 && p <= 1); assert.ok(Number.isFinite(a.logits[l])); }
    assert.equal(a.top, Object.entries(a.probs).sort((x, y) => y[1] - x[1])[0][0]);
    assert.ok(a.confidence >= 0 && a.confidence <= 1);
  }
  assert.ok(r.latency_ms >= 0);
  assert.ok(typeof r.calibration.note === 'string' && r.calibration.note.length > 10);
}

const providers: Array<[string, () => Provider]> = [
  ['heuristic', () => heuristicProvider()],
  ['kev-local', () => kevLocalProvider({ endpoint: mock.url, modelId: 'kev-0.8b-q8' })],
  ['jev-hosted', () => jevHostedProvider({ endpoint: hosted.url, apiKey: () => KEY, pricePerMTokUsd: 2 })],
  ['jev-open', () => jevOpenProvider({ endpoint: mock.url, modelId: 'jev-9b', head: HEAD, calibration: { per_kind: { noul: 1.5, score: 1.2, choice: 1.1 } } })],
  ['llm', () => llmProvider({ id: 'claude', model: 'claude-test', run: async ({ schema }) => {
    const props = (schema as any).properties as Record<string, any>;
    const out: Record<string, Record<string, number>> = {};
    for (const [qid, s] of Object.entries(props)) { const ls = s.required as string[]; out[qid] = Object.fromEntries(ls.map((l, i) => [l, i === 0 ? 2 : 1])); }
    return { text: '```json\n' + JSON.stringify(out) + '\n```', costUsd: 0.001 };
  } })],
];

describe('provider contract (every provider, every built-in set)', () => {
  for (const [name, make] of providers) {
    for (const set of [COIN_RISK, LARP_BAD, NARRATIVE]) {
      it(`${name} answers ${set.id} in the shared shape`, async () => {
        const r = await classify(make(), set, coin, { fallback: null });
        contract(r, set);
        assert.equal(r.fallback_from, undefined);
      });
    }
    it(`${name} status() never throws`, async () => {
      const s = await make().status();
      assert.equal(typeof s.ready, 'boolean');
      assert.ok(!s.detail.includes(KEY));
    });
  }
});

describe('kev-local', () => {
  it('reproduces the recorded Kev-0.8B answer exactly (wire parse)', async () => {
    const p = kevLocalProvider({ endpoint: mock.url, modelId: 'kev-0.8b-q8' });
    const r = await classify(p, COIN_RISK, coinDossier(FIXTURE.coin), { fallback: null });
    assert.equal(r.answers.drain_6h.probs.yes, FIXTURE.response.answers.drain_6h.noul);
    assert.equal(r.answers.outcome_6h.top, 'DUD');
    assert.equal(r.answers.outcome_6h.confidence, FIXTURE.response.answers.outcome_6h.confidence);
    assert.equal(r.usage.input_tokens, 657);
    assert.equal(r.model, 'kev-0.8b-q8', 'catalog id, not the server-reported file path');
  });
  it('the request carries the firewalled state and every question', async () => {
    mock.requests.length = 0;
    await classify(kevLocalProvider({ endpoint: mock.url, modelId: 'kev-0.8b-q8' }), COIN_RISK, coin, { fallback: null });
    const body = mock.requests.at(-1)!.body;
    assert.deepEqual(Object.keys(body.questions), ['drain_6h', 'outcome_6h']);
    assert.match(body.state.token.symbol, /^<untrusted source="token" kind="symbol">CAT<\/untrusted>$/);
    assert.equal(body.model, undefined, 'local server picks its loaded model');
  });
  it('refuses a non-loopback endpoint', () => {
    assert.throws(() => kevLocalProvider({ endpoint: 'http://10.0.0.5:8031', modelId: 'kev-4b-q4' }), /loopback/);
  });
  it('maps 503 (model loading) to offline, garbage to bad_response, a missing answer to bad_response', async () => {
    const p = kevLocalProvider({ endpoint: mock.url, modelId: 'kev-0.8b-q8' });
    for (const [mode, code] of [['loading', 'offline'], ['garbage', 'bad_response'], ['missing_answer', 'bad_response']] as const) {
      mock.mode = mode;
      await assert.rejects(classify(p, COIN_RISK, coin, { fallback: null }), (e: ClassifierError) => e.code === code);
    }
    mock.mode = 'ok';
  });
  it('times out a slow server', async () => {
    mock.mode = 'slow';
    const p = kevLocalProvider({ endpoint: mock.url, modelId: 'kev-0.8b-q8', timeoutMs: 50 });
    await assert.rejects(classify(p, COIN_RISK, coin, { fallback: null }), (e: ClassifierError) => e.code === 'offline');
    mock.mode = 'ok';
  });
});

describe('offline behaviour + fallback', () => {
  it('a dead local server falls back to the heuristic and says so', async () => {
    const dead = kevLocalProvider({ endpoint: 'http://127.0.0.1:9', modelId: 'kev-4b-q4', timeoutMs: 2000 });
    const r = await classify(dead, COIN_RISK, coin);
    contract(r, COIN_RISK);
    assert.equal(r.provider, 'heuristic');
    assert.equal(r.fallback_from?.provider, 'kev-local');
    assert.match(r.fallback_from!.error, /^offline:/);
    assert.match(describeResult(r), /fallback from kev-local/);
  });
  it('status() of a dead server is not ready and names the fix', async () => {
    const s = await kevLocalProvider({ endpoint: 'http://127.0.0.1:9', modelId: 'kev-4b-q4' }).status();
    assert.equal(s.ready, false);
    assert.match(s.detail, /classifier serve/);
  });
  it('the heuristic makes no network call at all', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (() => { throw new Error('network used'); }) as typeof fetch;
    try { contract(await classify(heuristicProvider(), COIN_RISK, coin, { fallback: null }), COIN_RISK); } finally { globalThis.fetch = orig; }
  });
});

describe('jev-hosted (mock only)', () => {
  it('sends the key as a Bearer header, the model name, and counts cost', async () => {
    hosted.requests.length = 0;
    const usage = memoryUsage();
    const p = jevHostedProvider({ endpoint: hosted.url, apiKey: () => KEY, pricePerMTokUsd: 2, usage, now: () => Date.parse('2026-10-28T12:00:00Z'), minGapMs: 0 });
    const r = await classify(p, COIN_RISK, coin, { fallback: null });
    const req = hosted.requests.at(-1)!;
    assert.equal(req.headers.authorization, `Bearer ${KEY}`);
    assert.equal(req.body.model, 'jev-latest');
    assert.ok(r.usage.cost_usd! > 0 && r.usage.cost_usd! < 0.01);
    assert.equal(usage.get('2026-10-28').calls, 1);
    assert.ok(!JSON.stringify(r).includes(KEY), 'the key never appears in a result');
  });
  it('unpriced means cost null with a note, never $0', async () => {
    const r = await classify(jevHostedProvider({ endpoint: hosted.url, apiKey: () => KEY, minGapMs: 0 }), LARP_BAD, coin, { fallback: null });
    assert.equal(r.usage.cost_usd, null);
    assert.match(r.usage.cost_note, /unpriced/);
  });
  it('no key -> not_ready without any request; with fallback -> heuristic', async () => {
    hosted.requests.length = 0;
    const p = jevHostedProvider({ endpoint: hosted.url, apiKey: () => null });
    await assert.rejects(classify(p, COIN_RISK, coin, { fallback: null }), (e: ClassifierError) => e.code === 'not_ready');
    assert.equal(hosted.requests.length, 0);
    const r = await classify(p, COIN_RISK, coin);
    assert.equal(r.provider, 'heuristic');
    assert.equal((await p.status()).ready, false);
  });
  it('a wrong key is unauthorized and the error does not echo it', async () => {
    const p = jevHostedProvider({ endpoint: hosted.url, apiKey: () => 'ts_wrong_key_abcdefgh', minGapMs: 0 });
    await assert.rejects(classify(p, COIN_RISK, coin, { fallback: null }), (e: ClassifierError) => e.code === 'unauthorized' && !e.message.includes('ts_wrong_key'));
  });
  it('429 surfaces rate_limited with Retry-After', async () => {
    hosted.mode = 'rate_limited';
    const p = jevHostedProvider({ endpoint: hosted.url, apiKey: () => KEY, minGapMs: 0 });
    await assert.rejects(classify(p, COIN_RISK, coin, { fallback: null }), (e: ClassifierError) => e.code === 'rate_limited' && e.retryAfterMs === 7000);
    hosted.mode = 'ok';
  });
  it('the daily call budget stops calls before the network', async () => {
    const usage = memoryUsage();
    const p = jevHostedProvider({ endpoint: hosted.url, apiKey: () => KEY, maxCallsPerDay: 1, usage, minGapMs: 0 });
    await classify(p, LARP_BAD, coin, { fallback: null });
    hosted.requests.length = 0;
    await assert.rejects(classify(p, LARP_BAD, coin, { fallback: null }), (e: ClassifierError) => e.code === 'rate_limited' && /budget/.test(e.message));
    assert.equal(hosted.requests.length, 0);
  });
  it('refuses plain-http remote endpoints', () => {
    assert.throws(() => jevHostedProvider({ endpoint: 'http://api.example.com', apiKey: () => KEY }), /https/);
  });
});

describe('jev-open', () => {
  it('asks one constrained 1-token completion per question with the verbalizer ids', async () => {
    mock.requests.length = 0;
    await classify(jevOpenProvider({ endpoint: mock.url, modelId: 'jev-9b', head: HEAD, calibration: { per_kind: { noul: 1, score: 1, choice: 1 } } }), COIN_RISK, coin, { fallback: null });
    const reqs = mock.requests.filter((r) => r.path === '/v1/completions');
    assert.equal(reqs.length, 2);
    assert.deepEqual(reqs[0].body.allowed_token_ids, [1000, 1001]);
    assert.deepEqual(reqs[1].body.allowed_token_ids, [1008, 1009, 1010]);
    assert.equal(reqs[0].body.max_tokens, 1);
    assert.match(reqs[1].body.prompt, /^\[kind\] choice\n\[state\] .*\n\[question\] .*\n\[options\]\nA\) RUG/s);
  });
});

describe('batch triage', () => {
  it('splits flag / pass / escalate by the drain probability and keeps going past failures', async () => {
    const coins = Array.from({ length: 12 }, (_, i) => coinDossier({ mint: `M${i}`.padEnd(32, 'x'), liquidity_usd: i * 3000, age_min: i * 10 }));
    const r = await classifyBatch(kevLocalProvider({ endpoint: mock.url, modelId: 'kev-0.8b-q8' }), COIN_RISK, coins, { concurrency: 4, triage: { question: 'drain_6h', lo: 0.3, hi: 0.7 }, fallback: null });
    assert.equal(r.results.length, 12);
    const t = r.triage!;
    assert.equal(t.flag.length + t.pass.length + t.escalate.length, 12);
  });
});
