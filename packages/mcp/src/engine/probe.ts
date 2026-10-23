// dexterm local engine: the capability probe and the bar per restriction profile (task-1543).
//
// `dexterm doctor` and `dexterm ai probe` ask the user's Ollama: is it reachable, is the model pulled, can it call
// tools, how much context does it have, and (for paper/full) does it answer a fixed JSON protocol reliably. A
// model below the bar for the enabled profile gets a warning with the fix; nothing is blocked by the probe
// itself (the user decides), but the limits outside the model apply regardless.

import { OllamaError, type OllamaClient } from './ollama.ts';
import { RESTRICTION_RANK, type Restriction } from './restrictions.ts';

/**
 * Tool-capable model families to start with. These are suggestions from Ollama's public library ("tools"
 * capability), not a dexterm benchmark: the probe checks the copy you pulled. Smaller = faster, weaker.
 */
export const SUGGESTED_MODELS: ReadonlyArray<{ name: string; size: string; note: string }> = [
  { name: 'qwen3:8b', size: '~5 GB', note: 'good default on a 16 GB machine' },
  { name: 'qwen3:14b', size: '~9 GB', note: 'steadier tool use, needs ~16 GB free' },
  { name: 'llama3.1:8b', size: '~5 GB', note: 'widely used tool caller' },
  { name: 'mistral-small3.2', size: '~15 GB', note: 'strong tool use on a 32 GB machine' },
];

export interface Bar { tools: boolean; minCtx: number; json: number }

/** What a model should manage at each profile (json = passes out of 3 protocol probes). */
export const BAR: Record<Restriction, Bar> = {
  observe: { tools: false, minCtx: 4096, json: 0 },
  propose: { tools: true, minCtx: 8192, json: 0 },
  paper: { tools: true, minCtx: 8192, json: 2 },
  full: { tools: true, minCtx: 16384, json: 3 },
};

export interface ModelProbe {
  host: string;
  local: boolean;
  reachable: boolean;
  version: string | null;
  error: string | null;
  /** task-1551: the host answered with a redirect (refused, never followed). */
  redirect?: boolean;
  models: string[];
  model: string | null;
  present: boolean;
  capabilities: string[] | null;
  /** null = the server did not say (older Ollama). */
  tools: boolean | null;
  contextLength: number | null;
  parameterSize: string | null;
  /** The context dexterm asks for (min of the configured numCtx and the model's own). */
  numCtx: number;
  /** Protocol probe: passes out of runs, or null when not run. */
  json: { pass: number; runs: number } | null;
}

const PROBE_SCHEMA = {
  type: 'object',
  properties: { action: { type: 'string', enum: ['enter', 'wait', 'skip'] }, confidence: { type: 'number' }, reason: { type: 'string' } },
  required: ['action', 'confidence', 'reason'],
};

const PROBE_PROMPTS = [
  'Coin A: price up 12% in 5 minutes, buyers 40 vs sellers 12, liquidity $80K. Decide.',
  'Coin B: price down 30% in 5 minutes, liquidity halved, top holder sold. Decide.',
  'Coin C: flat for an hour, liquidity $5K, 3 holders. Decide.',
];

/** Run the probe. Never throws; `json` runs only when asked (it costs three short generations). */
export async function probeModel(client: OllamaClient, model: string | null, o: { numCtx: number; json?: boolean } ): Promise<ModelProbe> {
  const p: ModelProbe = { host: client.host.url, local: client.host.local, reachable: false, version: null, error: null, models: [], model, present: false, capabilities: null, tools: null, contextLength: null, parameterSize: null, numCtx: o.numCtx, json: null };
  try {
    p.version = await client.version();
    p.reachable = true;
    p.models = await client.tags();
  } catch (e) {
    p.error = (e as Error).message;
    if (e instanceof OllamaError && e.redirect) p.redirect = true;
    return p;
  }
  if (!model) return p;
  p.present = p.models.includes(model) || p.models.includes(`${model}:latest`) || (!model.includes(':') && p.models.some((m) => m.startsWith(`${model}:`)));
  if (!p.present) return p;
  try {
    const s = await client.show(model);
    p.capabilities = s.capabilities;
    p.tools = s.capabilities ? s.capabilities.includes('tools') : null;
    p.contextLength = s.contextLength;
    p.parameterSize = s.parameterSize;
    if (s.contextLength) p.numCtx = Math.min(o.numCtx, s.contextLength);
  } catch (e) {
    p.error = (e as Error).message;
    if (e instanceof OllamaError && e.kind === 'model-missing') p.present = false;
    return p;
  }
  if (o.json) {
    let pass = 0;
    for (const q of PROBE_PROMPTS) {
      try {
        const r = await client.chat({ model, messages: [{ role: 'system', content: 'Answer with the JSON object only: {"action":"enter|wait|skip","confidence":0..1,"reason":"short"}' }, { role: 'user', content: q }], format: PROBE_SCHEMA, options: { num_ctx: Math.min(p.numCtx, 4096), temperature: 0 } }, { timeoutMs: 120_000 });
        const v = JSON.parse(r.content.trim()) as Record<string, unknown>;
        if (['enter', 'wait', 'skip'].includes(String(v.action)) && typeof v.confidence === 'number' && v.confidence >= 0 && v.confidence <= 1 && typeof v.reason === 'string') pass++;
      } catch { /* a failed run is a miss */ }
    }
    p.json = { pass, runs: PROBE_PROMPTS.length };
  }
  return p;
}

/** Warnings when the probed model is below the bar for a profile (empty = fine). Each says how to fix it. */
export function belowBar(level: Restriction, p: ModelProbe): string[] {
  const bar = BAR[level];
  const w: string[] = [];
  if (!p.reachable || !p.present) return w;
  if (bar.tools && p.tools === false) w.push(`${p.model} cannot call tools: at ${level} it answers from the dossier only; pull a tool-capable model (e.g. ollama pull ${SUGGESTED_MODELS[0].name})`);
  const ctx = p.contextLength ?? p.numCtx;
  if (ctx < bar.minCtx) w.push(`${p.model} has a ${ctx}-token context; ${level} wants at least ${bar.minCtx} (long dossiers get cut)`);
  if (p.json && p.json.pass < bar.json) w.push(`${p.model} answered ${p.json.pass}/${p.json.runs} protocol probes; ${level} wants ${bar.json}/3 (decisions it cannot format are refused, which means fewer trades, not bigger ones)`);
  if (RESTRICTION_RANK[level] >= RESTRICTION_RANK.paper && p.json === null) w.push(`run \`dexterm ai probe --json\` to check ${p.model} formats decisions reliably before ${level}`);
  return w;
}

/** Pick a model when none is configured: the first suggested one that is pulled, else the first pulled model. */
export function pickModel(pulled: readonly string[]): string | null {
  for (const s of SUGGESTED_MODELS) {
    const hit = pulled.find((m) => m === s.name || m === `${s.name}:latest`);
    if (hit) return hit;
  }
  return pulled.find((m) => !/embed/i.test(m)) ?? null;
}
