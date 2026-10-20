// task-1471: the LARP score's calibrated link points and its published numbers must match a fresh fit on the
// committed task-1401 eval set, and the committed report must match what the harness prints today.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LARP_SCORE_WEIGHTS, LARP_SCORE_MEASURED } from '@dexterm/data';
import { larpScoreBacktest, calibrateLinkPoints, auroc, type SkillEvalSet } from '../src/index.ts';

const EVAL = fileURLToPath(new URL('../eval/skills-eval.json', import.meta.url));
const REPORT = fileURLToPath(new URL('../eval/larp-score-backtest.json', import.meta.url));
const set = JSON.parse(fs.readFileSync(EVAL, 'utf8')) as SkillEvalSet;

test('the shipped calibrated points equal a fresh train-split fit', () => {
  const r = larpScoreBacktest(set);
  assert.equal(r.shipped_matches_fit, true);
  for (const f of r.fit) assert.equal(LARP_SCORE_WEIGHTS[f.id].source, f.source, `${f.id} source`);
});

test('the published test/train numbers equal the harness output', () => {
  const r = larpScoreBacktest(set);
  const m = LARP_SCORE_MEASURED;
  assert.equal(r.test.n, m.test.n); assert.equal(r.test.bad, m.test.bad);
  assert.equal(r.test.auroc, m.test.auroc);
  assert.equal(r.train.auroc, m.train.auroc);
  for (const b of ['low', 'medium', 'high'] as const) assert.deepEqual({ n: r.test.by_band[b].n, bad: r.test.by_band[b].bad }, m.test.by_band[b], b);
});

test('the committed report is current', () => {
  const committed = JSON.parse(fs.readFileSync(REPORT, 'utf8'));
  assert.deepEqual(committed, JSON.parse(JSON.stringify(larpScoreBacktest(set))));
});

test('calibration refuses held-out rows; AUROC handles ties and empty classes', () => {
  assert.throws(() => calibrateLinkPoints(set.rows.slice(-3)), /held out/);
  assert.equal(auroc([{ score: 1, bad: true }, { score: 0, bad: false }]), 1);
  assert.equal(auroc([{ score: 1, bad: true }, { score: 1, bad: false }]), 0.5);
  assert.equal(auroc([{ score: 1, bad: false }]), null);
});
