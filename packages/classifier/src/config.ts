// ~/.dexterm/classifier.json (schema dexterm.classifier/1). `provider` is the one switch (`classifier.provider`);
// `default` is the shipped recommendation (`classifier.default`), chosen by the task-1822 benchmark. Loading never
// throws: each bad field falls back to its default and is reported. Writing is atomic, 0600 in a 0700 dir.
// The hosted API key is NOT stored here: it lives in its own 0600 file (on Windows an owner-only ACL, see
// win-acl.ts) or the TYPESAFE_API_KEY env var.

import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Platt } from './calibrate.ts';
import { CATALOG } from './models.ts';
import { PROVIDER_IDS, type ProviderId } from './types.ts';
import { checkOwnerOnly, currentUserSid, lockOwnerOnly, type WinAclDeps } from './win-acl.ts';

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

/** Platform seams for the key file (tests drive the Windows path on any OS); `fresh` skips the remembered ACL check. */
export interface KeyFileOpts { platform?: NodeJS.Platform; acl?: WinAclDeps; fresh?: boolean }

export type TypesafeKeyState =
  | { source: 'env'; key: string }
  | { source: 'file'; key: string; path: string }
  | { source: 'none'; path: string }
  | { source: 'refused'; path: string; reason: string };

// A Windows ACL probe spawns PowerShell (~0.5 s) and hosted calls read the key per request, so a passing check is
// remembered for one minute per (path, size, mtime, ctime).
const aclOk = new Map<string, number>();
const ACL_OK_MS = 60_000;

/** Where the TypeSafe key comes from, or why the key file is refused. The key itself is never logged. */
export function typesafeKeyState(env: NodeJS.ProcessEnv = process.env, opts: KeyFileOpts = {}): TypesafeKeyState {
  const e = env.TYPESAFE_API_KEY?.trim();
  if (e) return { source: 'env', key: e };
  const p = typesafeKeyPath(env);
  let st: fs.Stats;
  try { st = fs.statSync(p); } catch { return { source: 'none', path: p }; }
  if ((opts.platform ?? process.platform) === 'win32') {
    // NTFS has no mode bits (stat says 0666 for every file): the access list decides
    const memo = `${p}|${st.size}|${st.mtimeMs}|${st.ctimeMs}`;
    if (opts.fresh || opts.acl || !((aclOk.get(memo) ?? 0) > Date.now())) {
      aclOk.delete(memo);
      const c = checkOwnerOnly(p, opts.acl);
      if (!c.ok) return { source: 'refused', path: p, reason: c.reason };
      if (!opts.acl) aclOk.set(memo, Date.now() + ACL_OK_MS); // injected (test) probes are never remembered
    }
  } else if ((st.mode & 0o077) !== 0) {
    // refuse a key file other users can read
    return { source: 'refused', path: p, reason: `other users can access it (mode ${(st.mode & 0o777).toString(8)}; chmod 600 it)` };
  }
  try {
    const k = fs.readFileSync(p, 'utf8').trim();
    return k ? { source: 'file', key: k, path: p } : { source: 'none', path: p };
  } catch (x) { return { source: 'refused', path: p, reason: `it cannot be read (${(x as NodeJS.ErrnoException).code ?? 'error'})` }; }
}

/** One line on why a key file is refused, naming the env var as the way out. Never contains the key. */
export const typesafeKeyRefusal = (s: { path: string; reason: string }): string =>
  `the TypeSafe key file ${s.path} is refused: ${s.reason}. Run \`dexterm classifier key set\` again, or set TYPESAFE_API_KEY in your environment instead.`;

/** The user's TypeSafe key: env TYPESAFE_API_KEY first, then the owner-only key file (0600; on Windows an owner-only ACL). Never logged. */
export function readTypesafeKey(env: NodeJS.ProcessEnv = process.env, opts: KeyFileOpts = {}): string | null {
  const s = typesafeKeyState(env, opts);
  return s.source === 'env' || s.source === 'file' ? s.key : null;
}

export function writeTypesafeKey(key: string, env: NodeJS.ProcessEnv = process.env, opts: KeyFileOpts = {}): string {
  const k = key.trim();
  if (!/^[\x21-\x7e]{8,512}$/.test(k)) throw new Error('that does not look like an API key (8-512 printable characters, no spaces)');
  const p = typesafeKeyPath(env);
  if ((opts.platform ?? process.platform) === 'win32') { writeKeyWindows(p, k + '\n', opts.acl); return p; }
  writeAtomic(p, k + '\n');
  fs.chmodSync(p, 0o600);
  return p;
}

/**
 * Windows: the temp file is created EMPTY, locked to the current user and checked before the key goes into it, then
 * renamed into place (a same-volume rename keeps its access list) and checked again. Any failure removes what was
 * written and throws a message naming TYPESAFE_API_KEY.
 */
function writeKeyWindows(p: string, text: string, acl?: WinAclDeps): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  const fail = (what: string): never => {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw new Error(`could not restrict the key file to your Windows account (${what}). Nothing was saved. Set TYPESAFE_API_KEY in your environment instead.`);
  };
  try { fs.writeFileSync(tmp, ''); } catch (e) { fail(`create: ${(e as NodeJS.ErrnoException).code ?? 'error'}`); }
  try { lockOwnerOnly(tmp, currentUserSid(acl), acl); } catch (e) { fail(`icacls: ${e instanceof Error ? e.message.split(/\r?\n/)[0] : String(e)}`); }
  const pre = checkOwnerOnly(tmp, acl);
  if (!pre.ok) fail(pre.reason);
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, p);
  const post = checkOwnerOnly(p, acl);
  if (!post.ok) { try { fs.rmSync(p, { force: true }); } catch { /* ignore */ } fail(post.reason); }
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
