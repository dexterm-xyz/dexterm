// The built-in question sets (task-1822). Question text is first-party and frozen per set id: changing a wording
// means a new id, so recorded results and calibration maps stay tied to the exact question they were fitted on.
// Validation mirrors the System One API limits (choice: 1-255 options, score: 2-10 levels).

import { ClassifierError, type Question, type QuestionSet } from './types.ts';

/** Rug / drain risk and the 6 h outcome class. Labels match the task-1734 winner-recall classes. */
export const COIN_RISK: QuestionSet = {
  id: 'coin-risk/1',
  questions: [
    {
      id: 'drain_6h',
      type: 'noul',
      instructions: 'Within the next 6 hours, will this token be drained: its pool liquidity pulled, or its price collapsing below a fifth of the current price?',
      criteria: { true: 'drained within 6 hours (rug pull or collapse)', false: 'liquidity and price hold above those floors for 6 hours' },
    },
    {
      id: 'outcome_6h',
      type: 'choice',
      instructions: 'Which outcome is most likely for this token over the next 6 hours?',
      criteria: {
        RUG: 'drained (liquidity pulled or price below a fifth) without first doubling',
        WIN: 'price reaches at least 3x the current price while the pool still holds at least $10k of liquidity',
        DUD: 'neither: it drifts, fades or stalls',
      },
    },
  ],
};

/** The LARP eval question: does the coin go bad (rug or dead) within 72 h. Matches the task-1401 eval label. */
export const LARP_BAD: QuestionSet = {
  id: 'larp-bad/1',
  questions: [
    {
      id: 'bad_72h',
      type: 'noul',
      instructions: 'Within 72 hours, will this token be rugged or dead (liquidity pulled, or trading stopped)?',
      criteria: { true: 'rugged or dead within 72 hours', false: 'still trading after 72 hours (flat, fading or running)' },
    },
  ],
};

/** Narrative category of a coin (task-1818's tracker). Options are the tracker's coarse buckets. */
export const NARRATIVE: QuestionSet = {
  id: 'narrative/1',
  questions: [
    {
      id: 'category',
      type: 'choice',
      instructions: 'Which narrative category best describes this token, judging only from its name, symbol and description?',
      criteria: {
        animal: 'an animal or pet meme (dogs, cats, frogs, ...)',
        ai: 'AI, agents or robots',
        politics: 'politicians, elections or news figures',
        celebrity: 'a celebrity, influencer or brand',
        culture: 'an internet meme, joke or cultural moment',
        tech: 'a product, utility, protocol or tool',
        other: 'none of these',
      },
    },
  ],
};

export const QUESTION_SETS: Record<string, QuestionSet> = {
  [COIN_RISK.id]: COIN_RISK,
  [LARP_BAD.id]: LARP_BAD,
  [NARRATIVE.id]: NARRATIVE,
};

const ID_RE = /^[a-z][a-z0-9_]{0,39}$/;

/** Throws ClassifierError('invalid') on a malformed set. Returns the set for chaining. */
export function validateQuestionSet(set: QuestionSet): QuestionSet {
  if (!set || typeof set.id !== 'string' || !set.id) throw new ClassifierError('invalid', 'question set needs an id');
  if (!Array.isArray(set.questions) || set.questions.length === 0) throw new ClassifierError('invalid', `${set.id}: no questions`);
  const seen = new Set<string>();
  for (const q of set.questions) {
    if (!ID_RE.test(q.id)) throw new ClassifierError('invalid', `${set.id}: bad question id ${JSON.stringify(q.id)}`);
    if (seen.has(q.id)) throw new ClassifierError('invalid', `${set.id}: duplicate question id ${q.id}`);
    seen.add(q.id);
    if (typeof q.instructions !== 'string' || !q.instructions.trim()) throw new ClassifierError('invalid', `${set.id}/${q.id}: empty instructions`);
    const n = labelsOf(q).length;
    if (q.type === 'choice' && (n < 1 || n > 255)) throw new ClassifierError('invalid', `${set.id}/${q.id}: choice needs 1-255 options`);
    if (q.type === 'score' && (n < 2 || n > 10)) throw new ClassifierError('invalid', `${set.id}/${q.id}: score needs 2-10 levels`);
    if (q.type !== 'choice' && q.type !== 'noul' && q.type !== 'score') throw new ClassifierError('invalid', `${set.id}/${q.id}: unknown type`);
  }
  return set;
}

/** The labels an answer to `q` carries probabilities for. noul: ['yes','no']; score: '0'..'n-1'. */
export function labelsOf(q: Question): string[] {
  if (q.type === 'noul') return ['yes', 'no'];
  if (q.type === 'score') return Array.isArray(q.criteria) ? q.criteria.map((_, i) => String(i)) : [];
  return q.criteria && !Array.isArray(q.criteria) ? Object.keys(q.criteria) : [];
}
