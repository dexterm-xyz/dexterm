// jev-open: the autotrust/JEV-* open students (community distillations of Jev 1.13, Apache-2.0) served by vLLM with
// their decision LoRA. The model card's System 1 recipe, ported: one constrained 1-token completion per question
// (`allowed_token_ids` = the option verbalizer tokens, `logprobs`), then client-side `+ head bias` and `/ per-kind
// temperature`, then softmax. The two small JSON files come from the model repo (`adapter_vllm/decision_head.json`,
// `calibration.json`) and are passed in as parsed objects.
//
// Limits from the card: noul -> [false, true]; score -> 6 levels (0-5); choice -> up to 16 options (A-P).
// Hardware: JEV-9B is ~18 GB in bf16, so it does not fit a 16 GB GPU unquantized (see the benchmark report).

import { labelsOf } from '../questions.ts';
import { finishAnswer } from '../systemone.ts';
import { ClassifierError, type Answer, type PreparedState, type Provider, type ProviderAnswer, type Question, type QuestionSet } from '../types.ts';
import { httpJson, type FetchLike } from './http.ts';

export interface JevDecisionHead {
  slots: { ranges: Record<'noul' | 'score' | 'choice', [number, number]> };
  verbalizer_ids: number[];
  bias: number[];
}
export interface JevCalibration { per_kind: Record<'noul' | 'score' | 'choice', number> }

export interface JevOpenOpts {
  endpoint: string;
  /** vLLM `--lora-modules` name of the decision adapter (card default `jev-decision`). */
  loraName?: string;
  modelId: string;
  head: JevDecisionHead;
  calibration: JevCalibration;
  timeoutMs?: number;
  fetch?: FetchLike;
}

const LETTERS = 'ABCDEFGHIJKLMNOP';

export function jevPrompt(q: Question, state: unknown): { prompt: string; options: string[] } {
  const labels = labelsOf(q);
  if (q.type === 'choice' && labels.length > 16) throw new ClassifierError('invalid', `jev-open: ${q.id} has ${labels.length} options (max 16)`);
  if (q.type === 'score' && labels.length !== 6) throw new ClassifierError('invalid', `jev-open: ${q.id} must have exactly 6 levels`);
  const options = q.type === 'noul' ? ['false', 'true'] : q.type === 'score' ? labels : labels;
  const crit = q.criteria && !Array.isArray(q.criteria) ? q.criteria : null;
  const lines = q.type === 'choice'
    ? labels.map((l, i) => `${LETTERS[i]}) ${l}${crit?.[l] ? `: ${crit[l]}` : ''}`)
    : q.type === 'score' ? (q.criteria as string[]).map((d, i) => `${i}) ${d}`) : options;
  const st = typeof state === 'string' ? state : JSON.stringify(state);
  return { prompt: `[kind] ${q.type}\n[state] ${st}\n[question] ${q.instructions}\n[options]\n${lines.join('\n')}\n[decision]:`, options };
}

export function jevOpenProvider(o: JevOpenOpts): Provider {
  const base = o.endpoint.replace(/\/+$/, '');
  return {
    id: 'jev-open',
    model: () => o.modelId,
    async status() {
      try {
        await httpJson('GET', `${base}/v1/models`, undefined, { fetch: o.fetch, timeoutMs: 3000 });
        return { ready: true, detail: `vLLM up at ${base}` };
      } catch (e) {
        return { ready: false, detail: `no vLLM server at ${base} (${(e as Error).message})` };
      }
    },
    async classify(set: QuestionSet, s: PreparedState, opt?: { signal?: AbortSignal }): Promise<ProviderAnswer> {
      const answers: Record<string, Answer> = {};
      let tokens = 0;
      for (const q of set.questions) {
        const { prompt, options } = jevPrompt(q, s.state);
        const [start] = o.head.slots.ranges[q.type];
        const ids = o.head.verbalizer_ids.slice(start, start + options.length);
        if (ids.length !== options.length) throw new ClassifierError('invalid', `jev-open: decision head has too few ${q.type} slots`);
        const body = await httpJson('POST', `${base}/v1/completions`, {
          model: o.loraName ?? 'jev-decision', prompt, max_tokens: 1, temperature: 1.0, logprobs: options.length,
          allowed_token_ids: ids, add_special_tokens: false, return_tokens_as_token_ids: true,
        }, { fetch: o.fetch, timeoutMs: o.timeoutMs ?? 60_000, signal: opt?.signal }) as { choices?: Array<{ logprobs?: { top_logprobs?: Array<Record<string, number>> } }>; usage?: { prompt_tokens?: number } };
        const top = body.choices?.[0]?.logprobs?.top_logprobs?.[0];
        if (!top) throw new ClassifierError('bad_response', `jev-open: no logprobs for ${q.id}`);
        const lp = new Map<number, number>();
        for (const [k, v] of Object.entries(top)) { const id = Number(k.split(':')[1] ?? k); if (Number.isFinite(id)) lp.set(id, v); }
        const T = o.calibration.per_kind[q.type] || 1;
        const z = ids.map((t, i) => ((lp.get(t) ?? -1e9) + (o.head.bias[start + i] ?? 0)) / T);
        const m = Math.max(...z);
        const e = z.map((x) => Math.exp(x - m));
        const sum = e.reduce((a, b) => a + b, 0);
        const labels = labelsOf(q);
        const probs: Record<string, number> = {};
        if (q.type === 'noul') { probs.yes = e[1] / sum; probs.no = e[0] / sum; } else labels.forEach((l, i) => { probs[l] = e[i] / sum; });
        answers[q.id] = finishAnswer(q.type, probs);
        tokens += body.usage?.prompt_tokens ?? 0;
      }
      return {
        model: o.modelId, model_version: null, answers, input_tokens: tokens || null, cost_usd: 0, cost_note: 'local (no per-call cost)',
        calibration: { kind: 'provider', note: 'per-kind temperatures from the model repo (fitted against Jev on general text), not on memecoins' },
      };
    },
  };
}
