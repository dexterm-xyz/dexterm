// The System One wire protocol (`POST /v1/systemone`): TypeSafe's public API, which llama.cpp's llama-server
// (PR #29818, 2026-10-02) and the Kev reference server also implement. One request = one state + named questions.
//
// Request : { model?, state, questions: { id: { type, instructions, criteria? } } }
// Response: { model, answers: { id: { type, choice?|noul?|score?, probabilities?, confidence?, legend? } }, usage }
//
// Normalised here into `Answer` (probs per label + ln-p logits + top + confidence). Anything malformed raises
// ClassifierError('bad_response') rather than guessing.

import { labelsOf } from './questions.ts';
import { ClassifierError, type Answer, type QuestionSet } from './types.ts';

export interface SystemOneRequest {
  model?: string;
  state: Record<string, unknown> | string;
  questions: Record<string, { type: string; instructions: string; criteria?: Record<string, string | null> | string[] }>;
}

export function buildRequest(set: QuestionSet, state: Record<string, unknown>, model?: string): SystemOneRequest {
  const questions: SystemOneRequest['questions'] = {};
  for (const q of set.questions) {
    const entry: SystemOneRequest['questions'][string] = { type: q.type, instructions: q.instructions };
    if (q.criteria !== undefined) entry.criteria = q.criteria;
    questions[q.id] = entry;
  }
  return model ? { model, state, questions } : { state, questions };
}

const EPS = 1e-12;

/** Entropy-based confidence (1 - H/ln n): 0 for a uniform answer, 1 for a certain one. */
export function entropyConfidence(probs: Record<string, number>): number {
  const ps = Object.values(probs);
  if (ps.length < 2) return 1;
  const h = -ps.reduce((s, p) => s + (p > 0 ? p * Math.log(p) : 0), 0);
  return Math.max(0, Math.min(1, 1 - h / Math.log(ps.length)));
}

export function finishAnswer(type: Answer['type'], probs: Record<string, number>, confidence?: number | null): Answer {
  const sum = Object.values(probs).reduce((a, b) => a + b, 0);
  if (!(sum > 0)) throw new ClassifierError('bad_response', 'answer has no probability mass');
  const norm: Record<string, number> = {};
  const logits: Record<string, number> = {};
  let top = '';
  let best = -1;
  for (const [k, v] of Object.entries(probs)) {
    const p = v / sum;
    norm[k] = p;
    logits[k] = Math.log(Math.max(p, EPS));
    if (p > best) { best = p; top = k; }
  }
  const conf = typeof confidence === 'number' && Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : entropyConfidence(norm);
  return { type, probs: norm, logits, top, confidence: conf };
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

/** Parse a /v1/systemone response body against the question set that was asked. */
export function parseResponse(set: QuestionSet, body: unknown): { model: string; answers: Record<string, Answer>; inputTokens: number | null } {
  if (!body || typeof body !== 'object') throw new ClassifierError('bad_response', 'response is not an object');
  const b = body as { model?: unknown; answers?: unknown; usage?: { input_tokens?: unknown } };
  if (!b.answers || typeof b.answers !== 'object') throw new ClassifierError('bad_response', 'response has no answers');
  const raw = b.answers as Record<string, Record<string, unknown>>;
  const answers: Record<string, Answer> = {};
  for (const q of set.questions) {
    const a = raw[q.id];
    if (!a || typeof a !== 'object') throw new ClassifierError('bad_response', `no answer for ${q.id}`);
    if (q.type === 'noul') {
      const p = num(a.noul);
      if (p === null || p > 1) throw new ClassifierError('bad_response', `${q.id}: noul is not a probability`);
      answers[q.id] = finishAnswer('noul', { yes: p, no: 1 - p }, null);
      continue;
    }
    const pr = a.probabilities as Record<string, unknown> | undefined;
    if (!pr || typeof pr !== 'object') throw new ClassifierError('bad_response', `${q.id}: no probabilities`);
    const labels = labelsOf(q);
    const probs: Record<string, number> = {};
    for (const l of labels) {
      const p = num(pr[l]);
      if (p === null) throw new ClassifierError('bad_response', `${q.id}: missing probability for ${l}`);
      probs[l] = p;
    }
    answers[q.id] = finishAnswer(q.type, probs, num(a.confidence));
  }
  const tokens = num(b.usage?.input_tokens);
  return { model: typeof b.model === 'string' ? b.model : '', answers, inputTokens: tokens };
}
