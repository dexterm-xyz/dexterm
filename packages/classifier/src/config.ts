// ~/.dexterm/classifier.json (schema dexterm.classifier/1). `provider` is the one switch (`classifier.provider`);
// `default` is the shipped recommendation (`classifier.default`), chosen by the task-1822 benchmark. Loading never
// throws: each bad field falls back to its default and is reported. Writing is atomic, 0600 in a 0700 dir.
// The hosted API key is NOT stored here: it lives in its own 0600 file (or the TYPESAFE_API_KEY env var).

import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Platt } from './calibrate.ts';
import { CATALOG } from './models.ts';
import { PROVIDER_IDS, type ProviderId } from './types.ts';

export const CLASSIFIER_SCHEMA = 'dexterm.classifier/1';

/**
 * The shipped default (task-1822 benchmark, research/classifier-2026-10/REPORT.md §3, picked on VALID before any
 * held-out read). No decision model beat the built-in scores by the pre-registered margin, so the PROVIDER stays
 * `heuristic` (nothing fetched on first run). For users who opt in, the suggested local model is Kev 4B Q4: the best
 * Kev measured (Kev 0.8B ranked coins no better than chance on dexterm's labelled history).
 */
export const SHIPPED_DEFAULT = { provider: 'heuristic' as ProviderId, model: 'kev-4b-q4' };

export interface ClassifierConfig {
  schema: typeof CLASSIFIER_SCHEMA;
  provider: ProviderId;
  /** The recommended local model id (catalog id). */
  default: string;
  kev: { endpoint: string; model: string; threads: number | null };
  jev: { endpoint: string; model: string; pricePerMTokUsd: number | null; maxCallsPerDay: number };
  jevOpen: { endpoint: string; model: string; headPath: string | null; calibrationPath: string | null };
  llm: { claudeModel: string; ollamaModel: string | null };
  /** Local Platt maps keyed `${model}|${question}`. */
  calibration: Record<string, Platt>;
  /** Model ids the user consented to download (recorded with the time). */
  consent: Record<string, string>;
  /** Fall back to the heuristic when the provider fails (default true). */
  fallback: boolean;
}

export function dextermHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.DEXTERM_HOME && env.DEXTERM_HOME.trim() ? env.DEXTERM_HOME : path.join(homedir(), '.dexterm');
}
export const classifierConfigPath = (env: NodeJS.ProcessEnv = process.env): string => path.join(dextermHome(env), 'classifier.json');
export const typesafeKeyPath = (env: NodeJS.ProcessEnv = process.env): string => path.join(dextermHome(env), 'keys', 'typesafe');
export const classifierUsagePath = (env: NodeJS.ProcessEnv = process.env): string => path.join(dextermHome(env), 'classifier-usage.json');

export function defaultClassifierConfig(): ClassifierConfig {
  return {
    schema: CLASSIFIER_SCHEMA,
    provider: SHIPPED_DEFAULT.provider,
    default: SHIPPED_DEFAULT.model,
    kev: { endpoint: 'http://127.0.0.1:8031', model: SHIPPED_DEFAULT.model, threads: null },
    jev: { endpoint: 'https://api.typesafe.ai', model: 'jev-latest', pricePerMTokUsd: null, maxCallsPerDay: 1000 },
    jevOpen: { endpoint: 'http://127.0.0.1:8000', model: 'jev-9b', headPath: null, calibrationPath: null },
    llm: { claudeModel: 'claude-haiku-5-5', ollamaModel: null },
    calibration: {},
    consent: {},
    fallback: true,
  };
}

export interface LoadedClassifierConfig { config: ClassifierConfig; exists: boolean; path: string; errors: string[] }

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,99}$/;
const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/;

export function parseClassifierConfig(raw: unknown): { config: ClassifierConfig; errors: string[] } {
  const c = defaultClassifierConfig();
  const errors: string[] = [];
  const o = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, any>;
  if (o.provider !== undefined) { if ((PROVIDER_IDS as readonly string[]).includes(o.provider)) c.provider = o.provider; else errors.push(`provider must be one of ${PROVIDER_IDS.join('|')}`); }
  if (o.default !== undefined) { if (CATALOG.some((e) => e.id === o.default)) c.default = o.default; else errors.push('default is not a catalog model id'); }
  if (o.kev && typeof o.kev === 'object') {
    if (o.kev.endpoint !== undefined) { if (typeof o.kev.endpoint === 'string' && LOOPBACK.test(o.kev.endpoint)) c.kev.endpoint = o.kev.endpoint; else errors.push('kev.endpoint must be http://127.0.0.1:<port> (loopback only)'); }
    if (o.kev.model !== undefined) { if (CATALOG.some((e) => e.id === o.kev.model)) c.kev.model = o.kev.model; else errors.push('kev.model is not a catalog model id'); }
    if (o.kev.threads !== undefined && o.kev.threads !== null) { if (Number.isInteger(o.kev.threads) && o.kev.threads >= 1 && o.kev.threads <= 256) c.kev.threads = o.kev.threads; else errors.push('kev.threads must be an integer 1..256'); }
  }
  if (o.jev && typeof o.jev === 'object') {
    if (o.jev.endpoint !== undefined) { if (typeof o.jev.endpoint === 'string' && /^https:\/\/[^\s/]+(\/[^\s]*)?$/.test(o.jev.endpoint)) c.jev.endpoint = o.jev.endpoint.replace(/\/+$/, ''); else errors.push('jev.endpoint must be an https URL'); }
    if (o.jev.model !== undefined) { if (typeof o.jev.model === 'string' && MODEL_RE.test(o.jev.model)) c.jev.model = o.jev.model; else errors.push('jev.model is not a model name'); }
    if (o.jev.pricePerMTokUsd !== undefined) { if (o.jev.pricePerMTokUsd === null || (typeof o.jev.pricePerMTokUsd === 'number' && o.jev.pricePerMTokUsd >= 0 && o.jev.pricePerMTokUsd < 1000)) c.jev.pricePerMTokUsd = o.jev.pricePerMTokUsd; else errors.push('jev.pricePerMTokUsd must be null or a number 0..1000'); }
    if (o.jev.maxCallsPerDay !== undefined) { if (Number.isInteger(o.jev.maxCallsPerDay) && o.jev.maxCallsPerDay >= 0 && o.jev.maxCallsPerDay <= 1_000_000) c.jev.maxCallsPerDay = o.jev.maxCallsPerDay; else errors.push('jev.maxCallsPerDay must be an integer 0..1000000'); }
  }
  if (o.jevOpen && typeof o.jevOpen === 'object') {
    if (typeof o.jevOpen.endpoint === 'string') { if (LOOPBACK.test(o.jevOpen.endpoint)) c.jevOpen.endpoint = o.jevOpen.endpoint; else errors.push('jevOpen.endpoint must be loopback'); }
    if (typeof o.jevOpen.model === 'string' && MODEL_RE.test(o.jevOpen.model)) c.jevOpen.model = o.jevOpen.model;
    for (const k of ['headPath', 'calibrationPath'] as const) if (typeof o.jevOpen[k] === 'string' || o.jevOpen[k] === null) c.jevOpen[k] = o.jevOpen[k];
  }
  if (o.llm && typeof o.llm === 'object') {
    if (typeof o.llm.claudeModel === 'string' && MODEL_RE.test(o.llm.claudeModel)) c.llm.claudeModel = o.llm.claudeModel;
    if (o.llm.ollamaModel === null || (typeof o.llm.ollamaModel === 'string' && MODEL_RE.test(o.llm.ollamaModel))) c.llm.ollamaModel = o.llm.ollamaModel;
  }
  if (o.calibration && typeof o.calibration === 'object') {
    for (const [k, v] of Object.entries(o.calibration as Record<string, any>)) {
      if (v && Number.isFinite(v.a) && Number.isFinite(v.b) && Number.isInteger(v.n) && typeof v.fitted_on === 'string') c.calibration[k.slice(0, 120)] = { a: v.a, b: v.b, n: v.n, fitted_on: v.fitted_on.slice(0, 200) };
      else errors.push(`calibration.${k.slice(0, 40)} is not a Platt map {a,b,n,fitted_on}`);
    }
  }
  if (o.consent && typeof o.consent === 'object') for (const [k, v] of Object.entries(o.consent)) if (CATALOG.some((e) => e.id === k) && typeof v === 'string') c.consent[k] = v;
  if (o.fallback !== undefined) { if (typeof o.fallback === 'boolean') c.fallback = o.fallback; else errors.push('fallback must be true or false'); }
  return { config: c, errors };
}

export function loadClassifierConfig(env: NodeJS.ProcessEnv = process.env): LoadedClassifierConfig {
  const p = classifierConfigPath(env);
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { config: defaultClassifierConfig(), exists: false, path: p, errors: [] };
    return { config: defaultClassifierConfig(), exists: true, path: p, errors: [`${p} is not valid JSON; using the defaults`] };
  }
  const { config, errors } = parseClassifierConfig(raw);
  return { config, exists: true, path: p, errors };
}

function writeAtomic(p: string, text: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, p);
}

export function saveClassifierConfig(c: ClassifierConfig, env: NodeJS.ProcessEnv = process.env): string {
  const p = classifierConfigPath(env);
  writeAtomic(p, JSON.stringify(c, null, 2) + '\n');
  return p;
}

/** The user's TypeSafe key: env TYPESAFE_API_KEY first, then the 0600 key file. Never logged. */
export function readTypesafeKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const e = env.TYPESAFE_API_KEY?.trim();
  if (e) return e;
  try {
    const p = typesafeKeyPath(env);
    const st = fs.statSync(p);
    if ((st.mode & 0o077) !== 0) return null; // refuse a key file other users can read
    const k = fs.readFileSync(p, 'utf8').trim();
    return k || null;
  } catch { return null; }
}

export function writeTypesafeKey(key: string, env: NodeJS.ProcessEnv = process.env): string {
  const k = key.trim();
  if (!/^[\x21-\x7e]{8,512}$/.test(k)) throw new Error('that does not look like an API key (8-512 printable characters, no spaces)');
  const p = typesafeKeyPath(env);
  writeAtomic(p, k + '\n');
  fs.chmodSync(p, 0o600);
  return p;
}

export function removeTypesafeKey(env: NodeJS.ProcessEnv = process.env): boolean {
  try { fs.rmSync(typesafeKeyPath(env)); return true; } catch { return false; }
}

/** File-backed usage counters for the hosted provider (per UTC day, last 31 days kept). */
export function fileUsage(env: NodeJS.ProcessEnv = process.env) {
  const p = classifierUsagePath(env);
  const read = (): Record<string, { calls: number; input_tokens: number; cost_usd: number | null }> => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; } };
  return {
    get: (day: string) => read()[day] ?? { calls: 0, input_tokens: 0, cost_usd: 0 },
    add: (day: string, d: { calls: number; input_tokens: number; cost_usd: number | null }) => {
      const all = read();
      const c = all[day] ?? { calls: 0, input_tokens: 0, cost_usd: 0 };
      all[day] = { calls: c.calls + d.calls, input_tokens: c.input_tokens + d.input_tokens, cost_usd: c.cost_usd === null || d.cost_usd === null ? null : c.cost_usd + d.cost_usd };
      const keep = Object.keys(all).sort().slice(-31);
      writeAtomic(p, JSON.stringify(Object.fromEntries(keep.map((k) => [k, all[k]])), null, 2) + '\n');
    },
  };
}
