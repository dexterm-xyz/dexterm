// The strategy factory's files, config and caps (task-2159). PAPER ONLY.
//
// Everything lives under $DEXTERM_HOME/autotrade/factory/ (0700 dirs, 0600 files):
//   factory.json        the user's config (dexterm-factory/1): interval, caps, windows, model. Missing = the defaults.
//   state.json          the run log summary: last run, its verdict, why it stopped
//   runs.jsonl          one line per run (append-only): attempts, rejects, the candidate, spend
//   spend.jsonl         one line per analyst call: t, run, costUsd (the per-day caps read this)
//   lessons.md          what the factory has learned so far (what failed, what held up); fed to the analyst
//   FACTORY-STOP        a stop file: while it exists nothing runs (same convention as the fleets' STOP files)
//   run.lock            one run at a time
//   generated/<id>/     report.json (held-out result, rationale, parents, stage), rationale.md, strategy.json
//   pending/<code>.json chat changes waiting for the user's confirm (control.ts)
//   AGENT-PAUSE         an MCP agent's pause (task-2167): honoured like FACTORY-STOP; an agent lifts only this one
//   evidence.json       the evidence table the last full run showed the analyst (what an external agent may cite)
//   inbox/<id>.json     candidates an external agent offered (offer.ts); the next run admits them through the same gate
//
// Caps only stop things: a cap that is hit ends the run with the reason, it never loosens anything else.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { freemem } from 'node:os';
import { writeJsonAtomic } from '../ledger.ts';

export const FACTORY_SCHEMA = 'dexterm-factory/1';
export const FACTORY_REPORT_SCHEMA = 'dexterm-factory-candidate/1';

export const factoryDir = (home: string): string => join(home, 'autotrade', 'factory');
export const factoryConfigPath = (home: string): string => join(factoryDir(home), 'factory.json');
export const factoryStatePath = (home: string): string => join(factoryDir(home), 'state.json');
export const factoryRunsPath = (home: string): string => join(factoryDir(home), 'runs.jsonl');
export const factorySpendPath = (home: string): string => join(factoryDir(home), 'spend.jsonl');
export const factoryLessonsPath = (home: string): string => join(factoryDir(home), 'lessons.md');
export const factoryStopPath = (home: string): string => join(factoryDir(home), 'FACTORY-STOP');
export const factoryLockPath = (home: string): string => join(factoryDir(home), 'run.lock');
export const generatedDir = (home: string): string => join(factoryDir(home), 'generated');
export const generatedPath = (home: string, id: string): string => join(generatedDir(home), id);

export interface FactoryConfig {
  schema: typeof FACTORY_SCHEMA;
  /** Hours between scheduled runs (the job checks on its own calendar slot; a run never starts sooner than this). */
  intervalHours: number;
  /** Local time of the daily slot (HH:MM). Default 04:10: after the nightly tuner (02:40) has finished, never with it. */
  at: string;
  /** New candidates kept per run. */
  maxCandidatesPerRun: number;
  /** Analyst replies tried per run before the run gives up (a rejected reply is logged, never retried forever). */
  maxAttemptsPerRun: number;
  /** Forward tests of generated strategies running at once (the forward machinery's own limit of 3 still applies). */
  maxConcurrentForward: number;
  /** Generated strategies not retired (candidate, backtested, queued, forward-testing, passed). At the cap nothing new is made. */
  maxActiveGenerated: number;
  /** Analyst calls: per run and per local day. */
  maxCallsPerRun: number;
  maxCallsPerDay: number;
  /** Analyst spend in USD (the CLI's reported cost): per call (--max-budget-usd), per run and per local day. */
  maxUsdPerCall: number;
  maxUsdPerRun: number;
  maxUsdPerDay: number;
  /** Disk for generated/ + the logs, in MB. At the cap nothing new is written. */
  maxDiskMb: number;
  /** A scheduled run skips itself when the machine has less memory than this available (MB; a run peaks near 2 GB). 0 = no check. */
  minFreeMemMb: number;
  /** Days of history the analyst sees (the evidence window ends where the held-out window starts). */
  evidenceDays: number;
  /** The newest days, held back: the analyst never sees them; the held-out test runs on them. */
  heldOutDays: number;
  /** The Claude model for the analyst call (the user's own CLI, like the in-app analyst). */
  model: string;
  /** Forward test window for a candidate (the forward machinery caps it at 72 h / 200 trades). */
  forward: { hours: number; trades: number; autoStart: boolean; skipHeldOutLosers: boolean };
  /** Minimum closed forward entries for a forward test to be judged; fewer = retired as "too few entries". */
  minForwardEntries: number;
  /** The every-candidate unit size for the evidence and held-out numbers. */
  unitUsd: number;
  /** Recorder tape picker (same knobs as `autotrade backtest --db`). */
  tape: { minPeakLiqUsd: number; spanHours: number; minLiveRows: number; maxMints: number };
}

export const DEFAULT_FACTORY_CONFIG: FactoryConfig = {
  schema: FACTORY_SCHEMA,
  intervalHours: 24,
  at: '04:10',
  maxCandidatesPerRun: 1,
  maxAttemptsPerRun: 3,
  maxConcurrentForward: 1,
  maxActiveGenerated: 5,
  maxCallsPerRun: 3,
  maxCallsPerDay: 3,
  maxUsdPerCall: 1,
  maxUsdPerRun: 2,
  maxUsdPerDay: 2,
  maxDiskMb: 50,
  minFreeMemMb: 4096,
  evidenceDays: 10,
  heldOutDays: 3,
  model: 'sonnet',
  forward: { hours: 72, trades: 200, autoStart: true, skipHeldOutLosers: true },
  minForwardEntries: 10,
  unitUsd: 20,
  tape: { minPeakLiqUsd: 10_000, spanHours: 80, minLiveRows: 1, maxMints: 20_000 },
};

/** Hard ceilings: a config above these is refused (the factory is a small background job). */
export const FACTORY_CEILINGS = {
  maxCandidatesPerRun: 3, maxAttemptsPerRun: 5, maxConcurrentForward: 3, maxActiveGenerated: 20, maxCallsPerRun: 5, maxCallsPerDay: 20,
  maxUsdPerCall: 5, maxUsdPerRun: 10, maxUsdPerDay: 20, maxDiskMb: 1024, evidenceDays: 60, heldOutDays: 14,
} as const;

type NumKey = { [K in keyof FactoryConfig]: FactoryConfig[K] extends number ? K : never }[keyof FactoryConfig];
const NUM_RANGES: Record<NumKey, [number, number]> = {
  intervalHours: [1, 24 * 14],
  maxCandidatesPerRun: [1, FACTORY_CEILINGS.maxCandidatesPerRun],
  maxAttemptsPerRun: [1, FACTORY_CEILINGS.maxAttemptsPerRun],
  maxConcurrentForward: [0, FACTORY_CEILINGS.maxConcurrentForward],
  maxActiveGenerated: [1, FACTORY_CEILINGS.maxActiveGenerated],
  maxCallsPerRun: [1, FACTORY_CEILINGS.maxCallsPerRun],
  maxCallsPerDay: [1, FACTORY_CEILINGS.maxCallsPerDay],
  maxUsdPerCall: [0.05, FACTORY_CEILINGS.maxUsdPerCall],
  maxUsdPerRun: [0.05, FACTORY_CEILINGS.maxUsdPerRun],
  maxUsdPerDay: [0.05, FACTORY_CEILINGS.maxUsdPerDay],
  maxDiskMb: [1, FACTORY_CEILINGS.maxDiskMb],
  minFreeMemMb: [0, 1_048_576],
  evidenceDays: [1, FACTORY_CEILINGS.evidenceDays],
  heldOutDays: [1, FACTORY_CEILINGS.heldOutDays],
  minForwardEntries: [1, 1000],
  unitUsd: [1, 1000],
};

export type FactoryConfigCheck = { ok: true; config: FactoryConfig; path: string; exists: boolean } | { ok: false; errors: string[]; path: string };

/** Defaults overlaid with the user's file; every value range-checked (a bad file is refused, never half-applied). */
export function parseFactoryConfig(doc: unknown, path = 'factory.json'): FactoryConfigCheck {
  const errors: string[] = [];
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { ok: false, errors: ['not a JSON object'], path };
  const d = doc as Record<string, unknown>;
  if (d.schema !== undefined && d.schema !== FACTORY_SCHEMA) errors.push(`schema must be ${FACTORY_SCHEMA}`);
  const c: FactoryConfig = structuredClone(DEFAULT_FACTORY_CONFIG);
  const known = new Set([...Object.keys(DEFAULT_FACTORY_CONFIG)]);
  for (const k of Object.keys(d)) if (!known.has(k)) errors.push(`unknown key ${k}`);
  for (const [k, [lo, hi]] of Object.entries(NUM_RANGES) as [NumKey, [number, number]][]) {
    if (d[k] === undefined) continue;
    const v = d[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) errors.push(`${k} must be a number from ${lo} to ${hi}`);
    else (c as unknown as Record<string, number>)[k] = v;
  }
  if (d.at !== undefined) { if (typeof d.at === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(d.at)) c.at = d.at; else errors.push('at must be HH:MM (24 h, local time)'); }
  if (d.model !== undefined) { if (typeof d.model === 'string' && /^[a-z0-9][a-z0-9.\-[\]]{1,63}$/i.test(d.model)) c.model = d.model; else errors.push('model must be a model name (sonnet, opus, …)'); }
  if (d.forward !== undefined) {
    const f = d.forward as Record<string, unknown>;
    if (!f || typeof f !== 'object') errors.push('forward must be an object');
    else {
      if (f.hours !== undefined) { if (typeof f.hours === 'number' && f.hours >= 0.25 && f.hours <= 72) c.forward.hours = f.hours; else errors.push('forward.hours must be 0.25 to 72'); }
      if (f.trades !== undefined) { if (Number.isInteger(f.trades) && (f.trades as number) >= 1 && (f.trades as number) <= 200) c.forward.trades = f.trades as number; else errors.push('forward.trades must be 1 to 200'); }
      if (f.autoStart !== undefined) { if (typeof f.autoStart === 'boolean') c.forward.autoStart = f.autoStart; else errors.push('forward.autoStart must be true or false'); }
      if (f.skipHeldOutLosers !== undefined) { if (typeof f.skipHeldOutLosers === 'boolean') c.forward.skipHeldOutLosers = f.skipHeldOutLosers; else errors.push('forward.skipHeldOutLosers must be true or false'); }
    }
  }
  if (d.tape !== undefined) {
    const t = d.tape as Record<string, unknown>;
    if (!t || typeof t !== 'object') errors.push('tape must be an object');
    else for (const [k, lo, hi] of [['minPeakLiqUsd', 0, 1e9], ['spanHours', 1, 24 * 30], ['minLiveRows', 1, 1000], ['maxMints', 100, 200_000]] as const) {
      if (t[k] === undefined) continue;
      if (typeof t[k] === 'number' && (t[k] as number) >= lo && (t[k] as number) <= hi) (c.tape as Record<string, number>)[k] = t[k] as number;
      else errors.push(`tape.${k} must be ${lo} to ${hi}`);
    }
  }
  if (c.maxUsdPerCall > c.maxUsdPerRun) errors.push('maxUsdPerCall must not be above maxUsdPerRun');
  if (c.maxUsdPerRun > c.maxUsdPerDay) errors.push('maxUsdPerRun must not be above maxUsdPerDay');
  if (c.maxCallsPerRun > c.maxCallsPerDay) errors.push('maxCallsPerRun must not be above maxCallsPerDay');
  return errors.length ? { ok: false, errors, path } : { ok: true, config: c, path, exists: true };
}

export function loadFactoryConfig(home: string): FactoryConfigCheck {
  const path = factoryConfigPath(home);
  if (!existsSync(path)) return { ok: true, config: structuredClone(DEFAULT_FACTORY_CONFIG), path, exists: false };
  let doc: unknown;
  try { doc = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { return { ok: false, errors: [`not JSON: ${(e as Error).message}`], path }; }
  return parseFactoryConfig(doc, path);
}

export function ensureFactoryDir(home: string): string {
  const d = factoryDir(home);
  mkdirSync(d, { recursive: true, mode: 0o700 });
  mkdirSync(generatedDir(home), { recursive: true, mode: 0o700 });
  return d;
}

/** Write the config (CLI `factory config set`). Only a validated document is written. */
export function saveFactoryConfig(home: string, doc: Record<string, unknown>): FactoryConfigCheck {
  const c = parseFactoryConfig({ ...doc, schema: FACTORY_SCHEMA }, factoryConfigPath(home));
  if (!c.ok) return c;
  ensureFactoryDir(home);
  writeJsonAtomic(factoryConfigPath(home), { ...doc, schema: FACTORY_SCHEMA });
  return c;
}

// ───────────────────────────── stop file ─────────────────────────────

export interface StopInfo { at: string; by: string; why: string }

export function factoryStopped(home: string): StopInfo | null {
  const p = factoryStopPath(home);
  if (!existsSync(p)) return null;
  try { const j = JSON.parse(readFileSync(p, 'utf8')); return { at: String(j.at ?? ''), by: String(j.by ?? 'unknown'), why: String(j.why ?? '') }; } catch { return { at: '', by: 'unknown', why: 'FACTORY-STOP exists' }; }
}

export function writeFactoryStop(home: string, by: string, why: string, now = Date.now()): StopInfo {
  ensureFactoryDir(home);
  const s: StopInfo = { at: new Date(now).toISOString(), by, why };
  writeFileSync(factoryStopPath(home), `${JSON.stringify(s)}\n`, { mode: 0o600 });
  return s;
}

export function clearFactoryStop(home: string): boolean {
  const p = factoryStopPath(home);
  if (!existsSync(p)) return false;
  unlinkSync(p);
  return true;
}

// ───────────────────────────── agent pause (task-2167) ─────────────────────────────
// An MCP agent pauses the factory with its own marker, never FACTORY-STOP: an agent can lift only its own pause, and no
// agent path removes the user's FACTORY-STOP. Every run honours both. The user's resume (CLI, confirmed chat) lifts both.

export const agentPausePath = (home: string): string => join(factoryDir(home), 'AGENT-PAUSE');

export function agentPaused(home: string): StopInfo | null {
  const p = agentPausePath(home);
  if (!existsSync(p)) return null;
  try { const j = JSON.parse(readFileSync(p, 'utf8')); return { at: String(j.at ?? ''), by: String(j.by ?? 'agent'), why: String(j.why ?? '') }; } catch { return { at: '', by: 'agent', why: 'AGENT-PAUSE exists' }; }
}

export function writeAgentPause(home: string, by: string, why: string, now = Date.now()): StopInfo {
  ensureFactoryDir(home);
  const s: StopInfo = { at: new Date(now).toISOString(), by: by.slice(0, 64), why: why.slice(0, 200) };
  writeFileSync(agentPausePath(home), `${JSON.stringify(s)}\n`, { mode: 0o600 });
  return s;
}

export function clearAgentPause(home: string): boolean {
  const p = agentPausePath(home);
  if (!existsSync(p)) return false;
  unlinkSync(p);
  return true;
}

/** Why no run may start now: the user's FACTORY-STOP first, else an agent's pause; null = it may run. */
export function factoryHalt(home: string): { kind: 'FACTORY-STOP' | 'AGENT-PAUSE'; info: StopInfo } | null {
  const s = factoryStopped(home);
  if (s) return { kind: 'FACTORY-STOP', info: s };
  const a = agentPaused(home);
  return a ? { kind: 'AGENT-PAUSE', info: a } : null;
}

/** True while another live process holds run.lock (read-only: never takes or clears it). */
export function factoryBusy(home: string, now = Date.now(), isAlive: (pid: number) => boolean = alive): boolean {
  const p = factoryLockPath(home);
  if (!existsSync(p)) return false;
  try { const h = JSON.parse(readFileSync(p, 'utf8')) as { pid: number; t: number }; return isAlive(h.pid) && now - h.t < LOCK_STALE_MS; } catch { return false; }
}

// ───────────────────────────── lock ─────────────────────────────

const LOCK_STALE_MS = 3 * 3600e3;
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };

export function acquireFactoryLock(home: string, now = Date.now(), isAlive: (pid: number) => boolean = alive): { ok: true; release: () => void } | { ok: false; holder: { pid: number; t: number } } {
  ensureFactoryDir(home);
  const p = factoryLockPath(home);
  if (existsSync(p)) {
    try {
      const h = JSON.parse(readFileSync(p, 'utf8')) as { pid: number; t: number };
      if (isAlive(h.pid) && now - h.t < LOCK_STALE_MS) return { ok: false, holder: h };
    } catch { /* unreadable = stale */ }
    try { unlinkSync(p); } catch { /* raced */ }
  }
  try { writeFileSync(p, JSON.stringify({ pid: process.pid, t: now }), { flag: 'wx', mode: 0o600 }); } catch { return { ok: false, holder: { pid: -1, t: now } }; }
  return { ok: true, release: () => { try { const h = JSON.parse(readFileSync(p, 'utf8')); if (h.pid === process.pid) unlinkSync(p); } catch { /* gone */ } } };
}

// ───────────────────────────── spend ─────────────────────────────

export interface SpendLine { t: number; runId: string; costUsd: number; ok: boolean }

export function readSpend(home: string): SpendLine[] {
  const p = factorySpendPath(home);
  if (!existsSync(p)) return [];
  const out: SpendLine[] = [];
  for (const l of readFileSync(p, 'utf8').split('\n')) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch { /* skip a torn line */ } }
  return out;
}

export function appendSpend(home: string, line: SpendLine): void {
  ensureFactoryDir(home);
  appendFileSync(factorySpendPath(home), `${JSON.stringify(line)}\n`, { mode: 0o600 });
}

/** Local-day start for `now` (the day caps reset at local midnight). */
export function dayStart(now: number): number { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); }

export function spendToday(home: string, now = Date.now()): { calls: number; usd: number } {
  const from = dayStart(now);
  const xs = readSpend(home).filter((s) => s.t >= from && s.t <= now);
  return { calls: xs.length, usd: Math.round(xs.reduce((a, s) => a + (s.costUsd || 0), 0) * 10000) / 10000 };
}

// ───────────────────────────── disk ─────────────────────────────

export function dirBytes(p: string): number {
  if (!existsSync(p)) return 0;
  const st = statSync(p);
  if (!st.isDirectory()) return st.size;
  let n = 0;
  for (const e of readdirSync(p)) n += dirBytes(join(p, e));
  return n;
}

export const factoryDiskMb = (home: string): number => Math.round((dirBytes(factoryDir(home)) / 1048576) * 100) / 100;

// ───────────────────────────── memory ─────────────────────────────

/** Memory the OS can hand out without swapping, in MB, from `vm_stat` output (free + inactive + speculative
 *  pages; os.freemem() on macOS counts only the free pages, which a busy Mac keeps near zero). Null = unparseable. */
export function vmStatAvailableMb(text: string): number | null {
  const size = /page size of (\d+) bytes/.exec(text);
  if (!size) return null;
  let pages = 0;
  for (const k of ['free', 'inactive', 'speculative']) {
    const m = new RegExp(`^Pages ${k}:\\s+(\\d+)`, 'm').exec(text);
    if (!m) return null;
    pages += Number(m[1]);
  }
  return Math.round((pages * Number(size[1])) / 1048576);
}

/** Linux `MemAvailable` from /proc/meminfo, in MB. Null = absent. */
export function memInfoAvailableMb(text: string): number | null {
  const m = /^MemAvailable:\s+(\d+) kB/m.exec(text);
  return m ? Math.round(Number(m[1]) / 1024) : null;
}

/** Available memory on this machine in MB (null = could not tell; the run then goes ahead). */
export function availableMemoryMb(): number | null {
  try {
    if (process.platform === 'darwin') return vmStatAvailableMb(execFileSync('/usr/bin/vm_stat', { encoding: 'utf8', timeout: 5000 }));
    if (process.platform === 'linux') return memInfoAvailableMb(readFileSync('/proc/meminfo', 'utf8'));
    return Math.round(freemem() / 1048576);
  } catch { return null; }
}

// ───────────────────────────── state + run log ─────────────────────────────

export interface FactoryState {
  schema: 'dexterm-factory-state/1';
  lastRunAt: number | null;
  /** Start of the last scheduled run that was due (the schedule's cadence counts only these; a run by hand, from chat or a
   *  hunt does not push the next slot back, the day caps bound the extra runs). */
  lastScheduledAt?: number | null;
  lastRunId: string | null;
  lastVerdict: string | null;
  /** The cap or guard that ended the last run early, or null. */
  lastStop: string | null;
  runs: number;
  candidates: number;
}

export function loadFactoryState(home: string): FactoryState {
  const p = factoryStatePath(home);
  const empty: FactoryState = { schema: 'dexterm-factory-state/1', lastRunAt: null, lastRunId: null, lastVerdict: null, lastStop: null, runs: 0, candidates: 0 };
  if (!existsSync(p)) return empty;
  try { return { ...empty, ...JSON.parse(readFileSync(p, 'utf8')) }; } catch { return empty; }
}

export function saveFactoryState(home: string, s: FactoryState): void { ensureFactoryDir(home); writeJsonAtomic(factoryStatePath(home), s); }

export function appendRunLine(home: string, line: Record<string, unknown>): void {
  ensureFactoryDir(home);
  appendFileSync(factoryRunsPath(home), `${JSON.stringify(line)}\n`, { mode: 0o600 });
}

export function readRunLines(home: string, max = 50): Record<string, unknown>[] {
  const p = factoryRunsPath(home);
  if (!existsSync(p)) return [];
  const rows = readFileSync(p, 'utf8').split('\n').filter(Boolean);
  const out: Record<string, unknown>[] = [];
  for (const l of rows.slice(-max)) { try { out.push(JSON.parse(l)); } catch { /* torn */ } }
  return out;
}
