// kev-local and jev-hosted: both speak POST /v1/systemone; they differ in endpoint, auth, cost and model naming.
//
// kev-local : a llama.cpp `llama-server` (a build with PR #29818, merged 2026-10-02; tested on release b11969) serving a Kev GGUF on
//             loopback. No key, no cost. The server reports the GGUF's local PATH as `model`, so the result uses the
//             catalog id instead (no machine paths in outputs).
// jev-hosted: TypeSafe's API (https://api.typesafe.ai) with the USER'S OWN key (Bearer). Never bundled, never in
//             fixtures or CI. Per-call cost = input tokens x the user's configured price (null = unpriced, never $0),
//             a daily call budget, and a minimum gap between calls; 429 surfaces as rate_limited with Retry-After.

import { buildRequest, parseResponse } from '../systemone.ts';
import { ClassifierError, type PreparedState, type Provider, type ProviderAnswer, type QuestionSet } from '../types.ts';
import { httpJson, type FetchLike } from './http.ts';

export interface KevLocalOpts {
  endpoint: string;
  /** Catalog id of the served model, e.g. `kev-4b-q4`. */
  modelId: string;
  modelVersion?: string | null;
  timeoutMs?: number;
  fetch?: FetchLike;
}

const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/;

export function kevLocalProvider(o: KevLocalOpts): Provider {
  if (!LOOPBACK.test(o.endpoint)) throw new ClassifierError('invalid', 'kev-local endpoint must be a loopback URL (127.0.0.1 / localhost); use jev-hosted for remote APIs');
  const base = o.endpoint.replace(/\/+$/, '');
  return {
    id: 'kev-local',
    model: () => o.modelId,
    async status() {
      try {
        const h = await httpJson('GET', `${base}/health`, undefined, { fetch: o.fetch, timeoutMs: 3000 }) as { status?: string };
        return { ready: h?.status === 'ok', detail: h?.status === 'ok' ? `llama-server up at ${base}` : `llama-server at ${base} says ${JSON.stringify(h?.status ?? null)}` };
      } catch (e) {
        return { ready: false, detail: `no llama-server at ${base} (${(e as Error).message}); start it with: dexterm classifier serve` };
      }
    },
    async classify(set: QuestionSet, s: PreparedState, opt?: { signal?: AbortSignal }): Promise<ProviderAnswer> {
      const body = await httpJson('POST', `${base}/v1/systemone`, buildRequest(set, s.state), { fetch: o.fetch, timeoutMs: o.timeoutMs ?? 120_000, signal: opt?.signal });
      const r = parseResponse(set, body);
      return {
        model: o.modelId, model_version: o.modelVersion ?? null, answers: r.answers, input_tokens: r.inputTokens, cost_usd: 0, cost_note: 'local (no per-call cost)',
        calibration: { kind: 'provider', note: "the model's own temperature, fitted by its author on general text, not on memecoins" },
      };
    },
  };
}

export interface JevHostedOpts {
  endpoint?: string;
  model?: string;
  /** Resolves the user's key at call time (env / key file). Returns null when none is configured. */
  apiKey: () => Promise<string | null> | string | null;
  /** USD per 1M input tokens, from the user's config. null = unpriced. */
  pricePerMTokUsd?: number | null;
  /** Calls allowed per UTC day (default 1000); counted through `usage`. */
  maxCallsPerDay?: number;
  /** Minimum ms between calls (default 250). */
  minGapMs?: number;
  usage?: UsageStore;
  timeoutMs?: number;
  fetch?: FetchLike;
  now?: () => number;
}

/** Persists per-day call / token / cost counters (the CLI stores them under the dexterm home). */
export interface UsageStore {
  get(day: string): { calls: number; input_tokens: number; cost_usd: number | null };
  add(day: string, d: { calls: number; input_tokens: number; cost_usd: number | null }): void;
}

export function memoryUsage(): UsageStore {
  const m = new Map<string, { calls: number; input_tokens: number; cost_usd: number | null }>();
  return {
    get: (d) => m.get(d) ?? { calls: 0, input_tokens: 0, cost_usd: 0 },
    add: (d, x) => {
      const c = m.get(d) ?? { calls: 0, input_tokens: 0, cost_usd: 0 };
      m.set(d, { calls: c.calls + x.calls, input_tokens: c.input_tokens + x.input_tokens, cost_usd: c.cost_usd === null || x.cost_usd === null ? null : c.cost_usd + x.cost_usd });
    },
  };
}

export const JEV_DEFAULT_ENDPOINT = 'https://api.typesafe.ai';

export function jevHostedProvider(o: JevHostedOpts): Provider {
  const base = (o.endpoint ?? JEV_DEFAULT_ENDPOINT).replace(/\/+$/, '');
  if (!/^https:\/\//.test(base) && !LOOPBACK.test(base)) throw new ClassifierError('invalid', 'jev-hosted endpoint must be https (or loopback for a test server)');
  const model = o.model ?? 'jev-latest';
  const usage = o.usage ?? memoryUsage();
  const now = o.now ?? Date.now;
  let last = 0;
  const day = () => new Date(now()).toISOString().slice(0, 10);
  return {
    id: 'jev-hosted',
    model: () => model,
    async status() {
      const key = await o.apiKey();
      if (!key) return { ready: false, detail: 'no TypeSafe API key configured (dexterm classifier key set); hosted Jev is optional' };
      const u = usage.get(day());
      return { ready: true, detail: `key configured; ${u.calls}/${o.maxCallsPerDay ?? 1000} calls today; price ${o.pricePerMTokUsd == null ? 'unpriced (set classifier.jev.pricePerMTokUsd)' : `$${o.pricePerMTokUsd}/1M input tokens`}` };
    },
    async classify(set: QuestionSet, s: PreparedState, opt?: { signal?: AbortSignal }): Promise<ProviderAnswer> {
      const key = await o.apiKey();
      if (!key) throw new ClassifierError('not_ready', 'jev-hosted: no API key configured');
      const today = day();
      const cap = o.maxCallsPerDay ?? 1000;
      if (usage.get(today).calls >= cap) throw new ClassifierError('rate_limited', `jev-hosted: daily budget of ${cap} calls used (classifier.jev.maxCallsPerDay)`, null);
      const gap = (o.minGapMs ?? 250) - (now() - last);
      if (gap > 0) await new Promise((r) => setTimeout(r, gap));
      last = now();
      const body = await httpJson('POST', `${base}/v1/systemone`, buildRequest(set, s.state, model), {
        fetch: o.fetch, timeoutMs: o.timeoutMs ?? 30_000, signal: opt?.signal, headers: { authorization: `Bearer ${key}` },
      });
      const r = parseResponse(set, body);
      const tokens = r.inputTokens ?? 0;
      const cost = o.pricePerMTokUsd == null ? null : (tokens / 1e6) * o.pricePerMTokUsd;
      usage.add(today, { calls: 1, input_tokens: tokens, cost_usd: cost });
      return {
        model: r.model || model, model_version: r.model || null, answers: r.answers, input_tokens: r.inputTokens, cost_usd: cost,
        cost_note: cost === null ? 'unpriced: set classifier.jev.pricePerMTokUsd to track spend' : `${tokens} input tokens at $${o.pricePerMTokUsd}/1M`,
        calibration: { kind: 'provider', note: "TypeSafe's own calibration on its training mix, not measured on memecoins by dexterm" },
      };
    },
  };
}
