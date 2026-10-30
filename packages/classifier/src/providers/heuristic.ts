// The always-available fallback: dexterm's existing hand-written scores, answered in the same typed shape.
//   drain_6h / outcome_6h RUG : H1-v0.1 p(rug) (@dexterm/packs rug-model, the screener's rug column)
//   bad_72h                   : the LARP link-shape score (task-1471), mapped to a probability by a Platt map
//                               fitted on the LARP eval TRAIN split (research/classifier-2026-10)
//   outcome_6h WIN            : a flat base rate (H1 knows nothing about winners; says so in the note)
//   category                  : a keyword match on the cleaned symbol / name, else `other`
// Zero cost, zero network, instant. Any question it does not know gets a uniform answer with confidence 0.

import { linkScore } from '@dexterm/data';
import { h1Model, rugFeaturesFromToken } from '@dexterm/packs';
import type { Platt } from '../calibrate.ts';
import { labelsOf } from '../questions.ts';
import { finishAnswer } from '../systemone.ts';
import type { Answer, PreparedState, Provider, ProviderAnswer, QuestionSet } from '../types.ts';

/** Fitted on the LARP eval TRAIN split (726 coins), never on TEST. See research/classifier-2026-10/REPORT.md. */
export const LARP_POINTS_PLATT: Platt = { a: 0.0828, b: -1.895, n: 726, fitted_on: 'larp-eval train (task-1401 set), score points as x (bench/fit_larp_points.mjs)' };
/** Share of covered TRAIN coins that were realizable >= 3x winners within 6 h (task-1734: 204 / 4,964). */
export const WIN_BASE_RATE = 0.041;

const H1 = h1Model();

const NARRATIVE_WORDS: Array<[string, RegExp]> = [
  ['animal', /\b(dog|doge|inu|shib|cat|kitty|frog|pepe|bonk|wif|monkey|ape|bear|bull|fish|bird|duck|hamster|penguin|panda)\b/i],
  ['ai', /\b(ai|agent|gpt|bot|robot|neural|llm|agi)\b/i],
  ['politics', /\b(trump|biden|maga|elon|president|vote|election|kamala|melania)\b/i],
  ['tech', /\b(protocol|swap|chain|labs|finance|fi|tool|app|network|dao)\b/i],
];

function num(v: unknown): number | null { return typeof v === 'number' && Number.isFinite(v) ? v : null; }
function bool(v: unknown): boolean | null { return typeof v === 'boolean' ? v : null; }

function pRug(s: PreparedState): number {
  const f = s.dossier.facts;
  const liq = num(f.liquidity_usd), age = num(f.age_minutes);
  return H1.score(rugFeaturesFromToken({
    liquidity_usd: liq, mcap: num(f.market_cap_usd), age_sec: age === null ? null : age * 60,
    top10_pct: num(f.top10_holders_pct), dev_pct: num(f.dev_holds_pct), organic_score: num(f.organic_score), holder_count: num(f.holders),
    mint_authority: bool(f.mint_authority_enabled), freeze_authority: bool(f.freeze_authority_enabled),
  }));
}

export function heuristicProvider(): Provider {
  return {
    id: 'heuristic',
    model: () => 'heuristic-h1+larp',
    status: async () => ({ ready: true, detail: 'built in (H1-v0.1 p(rug) + LARP link score); no download, no network' }),
    async classify(set: QuestionSet, s: PreparedState): Promise<ProviderAnswer> {
      const answers: Record<string, Answer> = {};
      for (const q of set.questions) {
        const labels = labelsOf(q);
        if (q.id === 'drain_6h' || q.id === 'rug') {
          const p = pRug(s);
          answers[q.id] = finishAnswer('noul', { yes: p, no: 1 - p });
        } else if (q.id === 'outcome_6h') {
          const r = pRug(s);
          answers[q.id] = finishAnswer('choice', { RUG: r, WIN: WIN_BASE_RATE * (1 - r), DUD: (1 - WIN_BASE_RATE) * (1 - r) });
        } else if (q.id === 'bad_72h' && s.dossier.link) {
          const pts = linkScore(s.dossier.link);
          const pb = 1 / (1 + Math.exp(-(LARP_POINTS_PLATT.a * pts + LARP_POINTS_PLATT.b)));
          answers[q.id] = finishAnswer('noul', { yes: pb, no: 1 - pb });
        } else if (q.id === 'category' && q.type === 'choice') {
          const text = `${s.dossier.untrusted?.symbol ?? ''} ${s.dossier.untrusted?.name ?? ''}`;
          const hit = NARRATIVE_WORDS.find(([l, re]) => labels.includes(l) && re.test(text))?.[0] ?? (labels.includes('other') ? 'other' : labels[0]);
          const probs: Record<string, number> = {};
          for (const l of labels) probs[l] = l === hit ? 0.6 : 0.4 / Math.max(1, labels.length - 1);
          answers[q.id] = finishAnswer('choice', probs);
        } else {
          const probs: Record<string, number> = {};
          for (const l of labels) probs[l] = 1 / labels.length;
          answers[q.id] = finishAnswer(q.type, probs, 0);
        }
      }
      return {
        model: 'heuristic-h1+larp', model_version: 'H1-v0.1 / larp-points-1471', answers, input_tokens: null, cost_usd: 0, cost_note: 'free (local arithmetic)',
        calibration: { kind: 'points', note: 'hand-written scores: H1 p(rug) is uncalibrated; bad_72h maps LARP points with a Platt map fitted on the LARP eval train split; WIN is a flat base rate' },
      };
    },
  };
}
