// Tier 4 — rug-probability model (H1 v0 + logistic v1). Offline, no model, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  h1Score, h1Model, H1_VERSION, H1_FLAG_THRESHOLD,
  rugFeaturesFromToken, rugFeaturesFromRecord, rugFeatureValue, evalLogistic, logisticModel, tokenRugScorer,
  type RugFeatures, type LogisticRugModel,
} from '../src/rug-model.ts';

const feat = (o: Partial<RugFeatures>): RugFeatures => ({
  liquidity_usd: null, mcap: null, age_sec: null, top_holders_pct: null, dev_pct: null, organic_score: null,
  holder_count: null, mint_auth_enabled: null, freeze_auth_enabled: null, has_pool: null, is_verified: null, ...o,
});
const near = (a: number, b: number): void => assert.ok(Math.abs(a - b) < 1e-9, `expected ~${b}, got ${a}`);

test('H1 reproduces the pre-registered prototype points exactly', () => {
  // base 0.15, nothing fires but liq<5000 (+0.20) and age<3600 (+0.10) and thin-liq is skipped (mcap 0) → 0.45
  near(h1Score(feat({ liquidity_usd: 1000, mcap: 0, age_sec: 100 })), 0.45);
  // freeze (+0.35) + mint (+0.25) + top>=30 (+0.15) + dev>=10 (+0.15) + organic<10 (+0.10) + liq<5000 (+0.20)
  // + age<3600 (+0.10) = 0.15 + 1.30 = clamp to 0.98
  const hot = h1Score(feat({ freeze_auth_enabled: true, mint_auth_enabled: true, top_holders_pct: 40, dev_pct: 20, organic_score: 2, liquidity_usd: 100, age_sec: 60 }));
  assert.equal(hot, 0.98);
  // established: holders>=1000 & liq>=50000 (−0.25), age>=7d & liq>=100000 (−0.20); base 0.15 → clamp to 0.02
  const safe = h1Score(feat({ holder_count: 5000, liquidity_usd: 200000, age_sec: 30 * 86400, mcap: 10_000_000, organic_score: 80 }));
  assert.equal(safe, 0.02);
});

test('H1 thin-liquidity-vs-cap term only fires with a real pool and a cap', () => {
  // liq 2000 (<5000 +0.20), mcap 1e6 → liq/mcap 0.002 < 0.03 (+0.10), age<3600 (+0.10) → 0.55
  assert.ok(Math.abs(h1Score(feat({ liquidity_usd: 2000, mcap: 1_000_000, age_sec: 100 })) - 0.55) < 1e-9);
});

test('h1Model exposes the pre-registered threshold and id', () => {
  const m = h1Model();
  assert.equal(m.id, H1_VERSION);
  assert.equal(m.threshold, H1_FLAG_THRESHOLD);
  assert.equal(m.kind, 'heuristic');
});

test('rugFeaturesFromToken maps dossier feature names and infers has_pool from liquidity', () => {
  const f = rugFeaturesFromToken({ liquidity_usd: 12000, mcap: 500000, age_sec: 7200, top10_pct: 25, dev_pct: 3, organic_score: 65, holder_count: 800, mint_authority: false, freeze_authority: false });
  assert.equal(f.top_holders_pct, 25);
  assert.equal(f.has_pool, true);
  const f0 = rugFeaturesFromToken({ liquidity_usd: 0, mcap: null, age_sec: 1, top10_pct: null, dev_pct: null, organic_score: null, holder_count: null, mint_authority: null, freeze_authority: null });
  assert.equal(f0.has_pool, false);
});

test('rugFeaturesFromRecord reads t0 columns and src_market → has_pool', () => {
  const f = rugFeaturesFromRecord({ liquidity_usd: 9000, mcap: 40000, age_sec: 300, top_holders_pct: 55, dev_pct: 12, organic_score: 5, holder_count: 30, mint_auth_enabled: 1, freeze_auth_enabled: 0, src_market: 'dexscreener', is_verified: 0 });
  assert.equal(f.has_pool, true);
  assert.equal(f.mint_auth_enabled, true);
  assert.equal(f.freeze_auth_enabled, false);
  const jup = rugFeaturesFromRecord({ liquidity_usd: null, src_market: 'jupiter-tokens' });
  assert.equal(jup.has_pool, false);
});

test('rugFeatureValue log1p-compresses heavy-tailed features and passes others through', () => {
  const f = feat({ liquidity_usd: 1000, organic_score: 60, freeze_auth_enabled: true });
  assert.ok(Math.abs((rugFeatureValue('liquidity_usd', f) as number) - Math.log1p(1000)) < 1e-9);
  assert.equal(rugFeatureValue('organic_score', f), 60);
  assert.equal(rugFeatureValue('freeze_auth_enabled', f), 1);
  assert.equal(rugFeatureValue('mcap', feat({})), null);
});

test('evalLogistic: a trivial model gives sigmoid(bias) when every feature is at its mean / missing', () => {
  const m: LogisticRugModel = {
    schema: 'dexterm-rug-model/1', id: 'rug-lr-test', version: '0', features: ['liquidity_usd', 'organic_score'],
    means: [Math.log1p(10000), 50], stds: [1, 10], weights: [-0.5, -0.3], bias: 0,
    threshold: 0.5, trained_on: { from: '', to: '', n: 0, positives: 0 },
    metrics: { auc_test: null, brier_test: null, brier_base_rate: null, n_test: 0 }, labeler_version: '0.2.0', positive_class: 'rug|dead',
  };
  // missing features → mean → z=0 → sigmoid(0)=0.5
  assert.equal(evalLogistic(m, feat({})), 0.5);
  // low liquidity (below mean after log1p) with negative weight → p > 0.5
  const p = evalLogistic(m, feat({ liquidity_usd: 100, organic_score: 50 }));
  assert.ok(p > 0.5, `expected risk up for thin liquidity, got ${p}`);
});

test('tokenRugScorer wraps a model as the token-dossier RugScorer seam', () => {
  const s = tokenRugScorer(h1Model());
  const p = s.score({ liquidity_usd: 100, mcap: 0, age_sec: 60, top10_pct: null, dev_pct: null, organic_score: null, holder_count: null, mint_authority: null, freeze_authority: null });
  near(p, h1Score(feat({ liquidity_usd: 100, mcap: 0, age_sec: 60, has_pool: true })));
  assert.equal(s.id, H1_VERSION);
});

test('logisticModel carries provenance (trained_on + metrics) for the UI', () => {
  const m: LogisticRugModel = {
    schema: 'dexterm-rug-model/1', id: 'rug-lr-v1', version: '1.0.0', features: ['liquidity_usd'],
    means: [8], stds: [2], weights: [-0.4], bias: -0.2, threshold: 0.5,
    trained_on: { from: '2026-10-01T00:00:00Z', to: '2026-10-08T00:00:00Z', n: 500, positives: 90 },
    metrics: { auc_test: 0.78, brier_test: 0.12, brier_base_rate: 0.16, n_test: 120 }, labeler_version: '0.2.0', positive_class: 'rug|dead',
  };
  const model = logisticModel(m);
  assert.equal(model.kind, 'logistic');
  assert.equal(model.trained_on?.n, 500);
  assert.equal(model.metrics?.auc_test, 0.78);
});
