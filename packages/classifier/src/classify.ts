// The one entry point the app calls: firewall the dossier, ask the configured provider, apply a local calibration
// map when one is configured for (model, question), fall back to the heuristic on failure, label the result.

import { applyPlatt, type Platt } from './calibrate.ts';
import { prepareState } from './dossier.ts';
import { heuristicProvider } from './providers/heuristic.ts';
import { validateQuestionSet } from './questions.ts';
import { finishAnswer } from './systemone.ts';
import { ClassifierError, type Answer, type ClassifyResult, type Dossier, type Provider, type QuestionSet } from './types.ts';

export interface ClassifyOpts {
  /** Platt maps keyed `${model}|${question id}` (binary questions: maps p(yes); choice: maps each label one-vs-rest, then renormalises). */
  calibration?: Record<string, Platt>;
  /** Provider to use when the main one fails. Default: the heuristic. `null` = no fallback (errors propagate). */
  fallback?: Provider | null;
  signal?: AbortSignal;
  now?: () => number;
}

export function calibrateAnswer(a: Answer, m: Platt): Answer {
  const mapped: Record<string, number> = {};
  for (const [k, p] of Object.entries(a.probs)) mapped[k] = a.type === 'noul' && k === 'no' ? NaN : applyPlatt(p, m);
  if (a.type === 'noul') mapped.no = 1 - mapped.yes;
  const out = finishAnswer(a.type, mapped);
  return { ...out, raw_probs: a.probs };
}

export async function classify(provider: Provider, set: QuestionSet, dossier: Dossier, o: ClassifyOpts = {}): Promise<ClassifyResult> {
  validateQuestionSet(set);
  const now = o.now ?? (() => performance.now());
  const prepared = prepareState(dossier);
  const t0 = now();
  let used: Provider = provider;
  let fallbackFrom: ClassifyResult['fallback_from'];
  let r;
  try {
    r = await provider.classify(set, prepared, { signal: o.signal });
  } catch (e) {
    const fb = o.fallback === undefined ? heuristicProvider() : o.fallback;
    if (!fb || fb.id === provider.id) throw e;
    fallbackFrom = { provider: provider.id, error: e instanceof ClassifierError ? `${e.code}: ${e.message}` : String((e as Error).message ?? e) };
    used = fb;
    r = await fb.classify(set, prepared, { signal: o.signal });
  }
  const latency = now() - t0;
  let calibration = r.calibration;
  const answers: Record<string, Answer> = {};
  for (const [qid, a] of Object.entries(r.answers)) {
    const m = o.calibration?.[`${r.model}|${qid}`];
    answers[qid] = m ? calibrateAnswer(a, m) : a;
    if (m) calibration = { kind: 'platt', note: `local Platt map fitted on ${m.fitted_on} (n ${m.n}); ${r.calibration.note}` };
  }
  return {
    label: 'model-estimate',
    provider: used.id,
    model: r.model,
    model_version: r.model_version,
    question_set: set.id,
    subject: dossier.subject,
    answers,
    latency_ms: Math.round(latency * 10) / 10,
    usage: { input_tokens: r.input_tokens, cost_usd: r.cost_usd, cost_note: r.cost_note },
    calibration,
    injection_suspected: prepared.injection_suspected,
    ...(fallbackFrom ? { fallback_from: fallbackFrom } : {}),
  };
}

export interface BatchOpts extends ClassifyOpts {
  concurrency?: number;
  /** Binary triage on one noul question: p >= hi -> flag, p <= lo -> pass, otherwise escalate (to Claude or a human). */
  triage?: { question: string; lo: number; hi: number };
  onResult?: (r: ClassifyResult, i: number) => void;
}

export interface BatchResult {
  results: Array<ClassifyResult | { subject: string; error: string }>;
  triage?: { flag: string[]; pass: string[]; escalate: string[] };
  ms: number;
}

export async function classifyBatch(provider: Provider, set: QuestionSet, dossiers: readonly Dossier[], o: BatchOpts = {}): Promise<BatchResult> {
  const t0 = performance.now();
  const results: BatchResult['results'] = new Array(dossiers.length);
  let next = 0;
  const worker = async () => {
    while (next < dossiers.length) {
      const i = next++;
      try {
        results[i] = await classify(provider, set, dossiers[i], o);
        o.onResult?.(results[i] as ClassifyResult, i);
      } catch (e) {
        results[i] = { subject: dossiers[i].subject, error: (e as Error).message };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(o.concurrency ?? 1, 16)) }, worker));
  const out: BatchResult = { results, ms: Math.round(performance.now() - t0) };
  if (o.triage) {
    const t = { flag: [] as string[], pass: [] as string[], escalate: [] as string[] };
    for (const r of results) {
      if ('error' in r) { t.escalate.push(r.subject); continue; }
      const p = r.answers[o.triage.question]?.probs.yes;
      if (p === undefined) t.escalate.push(r.subject);
      else if (p >= o.triage.hi) t.flag.push(r.subject);
      else if (p <= o.triage.lo) t.pass.push(r.subject);
      else t.escalate.push(r.subject);
    }
    out.triage = t;
  }
  return out;
}

/** One-line human summary, always labelled an estimate with the model id. Never advice. */
export function describeResult(r: ClassifyResult, question = 'drain_6h'): string {
  const a = r.answers[question];
  if (!a) return `${r.model}: no answer for ${question}`;
  const v = a.type === 'noul' ? `p(yes) ${a.probs.yes.toFixed(2)}` : `${a.top} ${a.probs[a.top].toFixed(2)}`;
  return `model estimate (${r.provider} ${r.model}, ${r.calibration.kind === 'platt' ? 'locally calibrated' : 'not calibrated on memecoins'}): ${question} ${v}${r.fallback_from ? ` [fallback from ${r.fallback_from.provider}]` : ''}`;
}
