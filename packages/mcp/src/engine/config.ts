// dexterm local engine: the AI engine settings file, $DEXTERM_HOME/ai.json (task-1543).
//
//   { "schema": "dexterm.ai/1",
//     "provider": "auto" | "claude" | "codex" | "ollama",          the global engine
//     "surfaces": { "analyst": …, "autotrade": …, "packs": …, "agent": … },   per-surface overrides
//     "restrictions": "observe" | "propose" | "paper" | "full",      the local-engine profile
//     "full": { "model": "<model>", "confirmedAt": "<iso>" } | null, the typed --full confirmation
//     "ollama": { "host": "http://127.0.0.1:11434", "model": "<model>", "numCtx": 16384 } }
//
// Only the user writes it, with `dexterm ai …` (or by hand). No MCP tool, chat message, Telegram command or model
// output reaches this file. `full` counts only with a confirmation recorded for the SAME model; otherwise the
// profile falls back to `paper` and every surface says why. The environment can lower the profile
// (DEXTERM_AI_RESTRICTIONS), never raise it.

import fs from 'node:fs';
import path from 'node:path';
import { dextermHome } from '../user-content.ts';
import { DEFAULT_OLLAMA_HOST, parseOllamaHost, type OllamaHost } from './ollama.ts';
import { DEFAULT_RESTRICTION, isRestriction, lowerOf, SURFACES, type Restriction, type Surface } from './restrictions.ts';

export const AI_CONFIG_SCHEMA = 'dexterm.ai/1';
export const ENGINES = ['claude', 'codex', 'ollama'] as const;
export type Engine = typeof ENGINES[number];
export const ENGINE_CHOICES = ['auto', ...ENGINES] as const;
export type EngineChoice = typeof ENGINE_CHOICES[number];

/** The phrase `dexterm ai engine ollama --full` asks the user to type. */
export const FULL_CONFIRM_PHRASE = 'ENABLE FULL';
/** Room for the analyst system prompt, the tool catalog, the live context and a few tool results (the probe clamps it to the model). */
export const DEFAULT_NUM_CTX = 32768;

export interface AiConfig {
  schema: typeof AI_CONFIG_SCHEMA;
  provider: EngineChoice;
  surfaces: Partial<Record<Surface, EngineChoice>>;
  restrictions: Restriction;
  full: { model: string; confirmedAt: string } | null;
  ollama: { host: string; model: string | null; numCtx: number };
}

export function defaultAiConfig(): AiConfig {
  return { schema: AI_CONFIG_SCHEMA, provider: 'auto', surfaces: {}, restrictions: DEFAULT_RESTRICTION, full: null, ollama: { host: DEFAULT_OLLAMA_HOST, model: null, numCtx: DEFAULT_NUM_CTX } };
}

export const aiConfigPath = (env: NodeJS.ProcessEnv = process.env): string => path.join(dextermHome(env), 'ai.json');

export function parseEngineChoice(v: unknown): EngineChoice | null {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return (ENGINE_CHOICES as readonly string[]).includes(s) ? s as EngineChoice : null;
}

/** An Ollama model name as `ollama pull` takes it (name[:tag], optional namespace/host path). */
export const MODEL_NAME = /^[a-z0-9][a-z0-9._\-/]{0,120}(:[a-z0-9._-]{1,64})?$/i;

export interface LoadedAiConfig {
  config: AiConfig;
  /** True when ai.json exists (a "new setup" has none). */
  exists: boolean;
  path: string;
  /** Problems in the file; each bad field fell back to its default. */
  errors: string[];
}

export function loadAiConfig(env: NodeJS.ProcessEnv = process.env): LoadedAiConfig {
  const p = aiConfigPath(env);
  const c = defaultAiConfig();
  const errors: string[] = [];
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { config: c, exists: false, path: p, errors };
    return { config: c, exists: true, path: p, errors: [`${p} is not valid JSON; using the defaults`] };
  }
  const o = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  if (o.provider !== undefined) { const v = parseEngineChoice(o.provider); if (v) c.provider = v; else errors.push('provider must be auto|claude|codex|ollama'); }
  if (o.surfaces && typeof o.surfaces === 'object') {
    for (const [k, v] of Object.entries(o.surfaces as Record<string, unknown>)) {
      const e = parseEngineChoice(v);
      if ((SURFACES as readonly string[]).includes(k) && e) c.surfaces[k as Surface] = e;
      else errors.push(`surfaces.${k.slice(0, 24)} is not a surface (${SURFACES.join('|')}) with an engine`);
    }
  }
  if (o.restrictions !== undefined) { if (isRestriction(o.restrictions)) c.restrictions = o.restrictions; else errors.push('restrictions must be observe|propose|paper|full'); }
  const full = o.full as Record<string, unknown> | null | undefined;
  if (full && typeof full === 'object' && typeof full.model === 'string' && typeof full.confirmedAt === 'string') c.full = { model: full.model, confirmedAt: full.confirmedAt };
  const ol = o.ollama as Record<string, unknown> | undefined;
  if (ol && typeof ol === 'object') {
    if (typeof ol.host === 'string') { const h = parseOllamaHost(ol.host); if ('error' in h) errors.push(`ollama.host: ${h.error}`); else c.ollama.host = h.url; }
    if (typeof ol.model === 'string' && MODEL_NAME.test(ol.model)) c.ollama.model = ol.model;
    else if (ol.model !== undefined && ol.model !== null) errors.push('ollama.model is not a model name');
    if (typeof ol.numCtx === 'number' && Number.isInteger(ol.numCtx) && ol.numCtx >= 2048 && ol.numCtx <= 1_048_576) c.ollama.numCtx = ol.numCtx;
    else if (ol.numCtx !== undefined) errors.push('ollama.numCtx must be an integer 2048..1048576');
  }
  return { config: c, exists: true, path: p, errors };
}

/** Write ai.json (0600, atomic). Only the `dexterm ai` command calls this. */
export function saveAiConfig(c: AiConfig, env: NodeJS.ProcessEnv = process.env): string {
  const p = aiConfigPath(env);
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, p);
  return p;
}

export interface EffectiveRestriction {
  level: Restriction;
  /** Why the level is lower than the file says (missing --full confirmation, env lowered it), or null. */
  note: string | null;
}

/**
 * The profile that applies now. `full` needs a confirmation for the same model; the env may only lower it.
 */
export function effectiveRestriction(c: AiConfig, model: string | null, env: NodeJS.ProcessEnv = process.env): EffectiveRestriction {
  let level = c.restrictions;
  let note: string | null = null;
  if (level === 'full' && (!c.full || !model || c.full.model !== model)) {
    level = 'paper';
    note = c.full && model && c.full.model !== model
      ? `full was confirmed for ${c.full.model}, not ${model}: running at paper until you confirm again (dexterm ai engine ollama --full)`
      : 'full needs the typed confirmation (dexterm ai engine ollama --full): running at paper';
  }
  const lower = env.DEXTERM_AI_RESTRICTIONS;
  if (isRestriction(lower) && lowerOf(lower, level) !== level) { level = lower; note = `DEXTERM_AI_RESTRICTIONS lowers the profile to ${lower}`; }
  return { level, note };
}

export interface OllamaSettings { host: OllamaHost; model: string | null; numCtx: number; hostError: string | null }

/** Host / model / context, with the env overrides (DEXTERM_OLLAMA_HOST, DEXTERM_OLLAMA_MODEL). */
export function ollamaSettings(c: AiConfig, env: NodeJS.ProcessEnv = process.env): OllamaSettings {
  let hostError: string | null = null;
  let host = parseOllamaHost(env.DEXTERM_OLLAMA_HOST || c.ollama.host);
  if ('error' in host) { hostError = `DEXTERM_OLLAMA_HOST: ${host.error}`; host = parseOllamaHost(DEFAULT_OLLAMA_HOST) as OllamaHost; }
  const envModel = env.DEXTERM_OLLAMA_MODEL && MODEL_NAME.test(env.DEXTERM_OLLAMA_MODEL) ? env.DEXTERM_OLLAMA_MODEL : null;
  return { host, model: envModel ?? c.ollama.model, numCtx: c.ollama.numCtx, hostError };
}

/**
 * The engine CHOICE for a surface: DEXTERM_AI_PROVIDER, then the per-surface override, then the global provider.
 * (The analyst's own flag / DEXTERM_ANALYST_ENGINE / config analyst.engine still win for the analyst; main.ts.)
 */
export function engineChoiceFor(surface: Surface, c: AiConfig, env: NodeJS.ProcessEnv = process.env): EngineChoice {
  return parseEngineChoice(env.DEXTERM_AI_PROVIDER) ?? c.surfaces[surface] ?? c.provider;
}

/** Is a local Ollama setup configured (a model chosen)? `auto` uses it only then, after claude and codex. */
export function ollamaConfigured(c: AiConfig, env: NodeJS.ProcessEnv = process.env): boolean {
  return !!ollamaSettings(c, env).model;
}

/**
 * Resolve a choice to an engine. `auto`: claude when installed, else codex, else ollama when a model is set up,
 * else claude (whose missing-CLI error explains how to set up an AI backend).
 */
export function resolveEngineChoice(choice: EngineChoice, has: (engine: Engine) => boolean): Engine {
  if (choice !== 'auto') return choice;
  if (has('claude')) return 'claude';
  if (has('codex')) return 'codex';
  if (has('ollama')) return 'ollama';
  return 'claude';
}
