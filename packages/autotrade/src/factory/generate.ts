// One strategy-factory run (task-2159). PAPER ONLY: the factory writes paper strategy files, backtests them on recorded
// data and queues paper forward tests. It never promotes to always-on, never to real, never arms, never signs.
//
// A run, in order (any stop ends it with the reason, written to state.json and runs.jsonl):
//   0. FACTORY-STOP file, a bad factory.json, another run holding run.lock → stop.
//   1. Housekeeping: a finished forward test of a generated strategy is judged (enough closed entries and net above 0
//      = forward-passed, still a candidate; anything else = retired, kept on disk with the reason); queued candidates
//      start their forward test while slots are free.
//   2. Caps: active generated strategies, disk, per-day analyst calls and USD. A scheduled run that is not due skips.
//   3. Evidence: every paper strategy's numbers on the evidence window, which ends where the held-out window starts
//      (the newest heldOutDays are never shown to the analyst).
//   4. The analyst (bounded attempts): parse, number cross-check, ops policy, validate, rules-hash and near-duplicate
//      checks. A rejected reply is logged with its reasons and the next attempt is told why; no retry past the caps.
//   5. The accepted candidate is stored (a user strategy, GENERATED, paper, decide auto), tested once on the held-out
//      days (n, mean, 95% range, 2x costs, without top 3, rug rate) → generated/<id>/report.json; the same held-out
//      backtest is its journey evidence (backtested rung); then it is queued for a forward test.
//   6. lessons.md gets one line per candidate and per retirement.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { backtestEvidence, latestForward, loadJourney, recordBacktestEvidence, rulesHash } from '../journey.ts';
import { createForwardTest, FORWARD_LIMITS, requestForwardStop, isActive, listForwardTests, liveState, loadForwardTest, saveForwardTest, type ForwardTest } from '../forward.ts';
import { writeJsonAtomic } from '../ledger.ts';
import type { Tape } from '../replay.ts';
import { StrategyStore } from '../store.ts';
import type { ResolvedStrategy, Strategy } from '../strategy.ts';
import { buildCandidate, buildPrompt, crossCheck, wordingProblems, jsonNumbers, numbersIn, parseProposal, SYSTEM_PROMPT, type FactoryAnalyst, type Proposal } from './analyst.ts';
import {
  acquireFactoryLock, agentPaused, appendRunLine, appendSpend, availableMemoryMb, ensureFactoryDir, factoryDiskMb, factoryHalt, factoryLessonsPath, factoryStopped, FACTORY_REPORT_SCHEMA,
  generatedDir, generatedPath, loadFactoryConfig, loadFactoryState, saveFactoryState, spendToday, type FactoryConfig,
} from './config.ts';
import { entryStats, evidenceNumbers, evidenceText, gatherEvidence, rulesView, type EntryStats, type EvidenceTable } from './evidence.ts';
import { EVIDENCE_SNAPSHOT_SCHEMA, listOffers, resolveOffer, saveEvidenceSnapshot } from './inbox.ts';
import { describeFactorySchedule } from './schedule.ts';

export const GENERATED_STAGES = ['candidate', 'backtested', 'queued-forward', 'forward-testing', 'forward-passed', 'retired'] as const;
export type GeneratedStage = (typeof GENERATED_STAGES)[number];
export const LABEL = 'GENERATED · PAPER · SIMULATED · a candidate, not an edge';

export interface HeldOutResult extends EntryStats { window: { from: string; to: string; days: number }; mints: number; verdict: string }

export interface GeneratedReport {
  schema: typeof FACTORY_REPORT_SCHEMA;
  id: string;
  name: string;
  label: string;
  paper: true;
  createdAt: number;
  runId: string;
  stage: GeneratedStage;
  base: string;
  parents: string[];
  hash: string;
  rulesHash: string;
  ops: Proposal['ops'];
  rationale: Proposal['rationale'];
  citations: Proposal['citations'];
  /** Retirements the analyst proposed: shown to the user, never applied by the factory. */
  retireProposals: Proposal['retire'];
  evidenceWindow: EvidenceTable['window'];
  heldOut: HeldOutResult | null;
  model: string;
  costUsd: number;
  forward: { forwardId: string | null; queuedAt: number | null; startedAt: number | null; result: { state: string; trades: number; netUsd: number | null; netPct: number | null } | null };
  retired: { at: number; by: string; why: string } | null;
  history: { t: number; stage: GeneratedStage; note: string }[];
  /** task-2167: who acted as the generator: `factory` (the user's own Claude) or `mcp:<client>` (an offer). Older reports: absent = factory. */
  source?: string;
  /** task-2167: the inbox offer it came from (mcp only). */
  offerId?: string | null;
  /** task-2167: the lessons.md run lines the generator was shown (as the prompt saw them; bounded). */
  lessonsUsed?: string[];
}

const reportPath = (home: string, id: string): string => join(generatedPath(home, id), 'report.json');

export function loadGenerated(home: string, id: string): GeneratedReport | null {
  const p = reportPath(home, id);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')) as GeneratedReport; } catch { return null; }
}

export function listGenerated(home: string): GeneratedReport[] {
  const d = generatedDir(home);
  if (!existsSync(d)) return [];
  return readdirSync(d).map((id) => loadGenerated(home, id)).filter((r): r is GeneratedReport => !!r).sort((a, b) => b.createdAt - a.createdAt);
}

export function saveGenerated(home: string, r: GeneratedReport): void {
  mkdirSync(generatedPath(home, r.id), { recursive: true, mode: 0o700 });
  writeJsonAtomic(reportPath(home, r.id), r);
}

export function setStage(home: string, r: GeneratedReport, stage: GeneratedStage, note: string, now = Date.now()): GeneratedReport {
  const next = { ...r, stage, history: [...r.history, { t: now, stage, note: note.slice(0, 300) }].slice(-40) };
  saveGenerated(home, next);
  return next;
}

/** Retire a generated strategy: marked, kept on disk (strategy file, report, journey), its forward test asked to stop. */
export function retireGenerated(home: string, id: string, by: string, why: string, now = Date.now()): { ok: true; report: GeneratedReport; already: boolean } | { ok: false; why: string } {
  const r = loadGenerated(home, id);
  if (!r) return { ok: false, why: `${id} is not a generated strategy` };
  if (r.stage === 'retired') return { ok: true, report: r, already: true };
  const fid = r.forward.forwardId;
  if (fid) { const t = loadForwardTest(home, fid); if (t && isActive(t, now)) requestForwardStop(home, fid, by, now); }
  const next = setStage(home, { ...r, retired: { at: now, by, why: why.slice(0, 300) } }, 'retired', why, now);
  appendLesson(home, `${isoDay(now)} retired ${id}: ${why.slice(0, 200)}`);
  return { ok: true, report: next, already: false };
}

/** task-2167: the user's undo of a retire (their terminal only): queued for a forward test again (or a candidate without a held-out test). */
export function unretireGenerated(home: string, id: string, by: string, now = Date.now()): { ok: true; report: GeneratedReport } | { ok: false; why: string } {
  const r = loadGenerated(home, id);
  if (!r) return { ok: false, why: `${id} is not a generated strategy` };
  if (r.stage !== 'retired') return { ok: false, why: `${id} is not retired (${r.stage})` };
  const stage: GeneratedStage = r.heldOut ? 'queued-forward' : 'candidate';
  const next = setStage(home, { ...r, retired: null, forward: { forwardId: null, queuedAt: r.heldOut ? now : null, startedAt: null, result: null } }, stage, `un-retired by ${by} (was: ${r.retired?.why ?? 'retired'})`, now);
  appendLesson(home, `${isoDay(now)} un-retired ${id} by ${by}`);
  return { ok: true, report: next };
}

export const isActiveGenerated = (r: GeneratedReport): boolean => r.stage !== 'retired';

// ───────────────────────────── lessons ─────────────────────────────

export const LESSONS_SEED = [
  '# Strategy factory lessons',
  '',
  'Carried over from the all-data synthesis (research/strategy-synthesis-2026-11, task-2134), in words:',
  '- No strategy cleared the bar there: every fleet lost on paper after costs; "no edge found" was the confident statement.',
  '- Rugs were predictable from holder data; winners were not. Loosening holder-safety gates to catch "missed winners" raised the rug rate sharply.',
  '- Every exit rule lost on dense ticks; taking the cost back early helped a little (an A/B on paper, not an edge).',
  '- A profile\'s fit.minLiquidityUsd is a second entry gate: check it against the screen\'s liquidity floor.',
  '- Coins on a top-trending feed rugged far less, but a feed allowlist cannot be written in a strategy file.',
  '- A result that flips sign on a small filter change is noise.',
  '',
  'Factory runs (newest last):',
].join('\n');

export function readLessons(home: string): string {
  const p = factoryLessonsPath(home);
  if (!existsSync(p)) return LESSONS_SEED;
  return readFileSync(p, 'utf8');
}

/**
 * lessons.md as the analyst may see it: run lines are stamped with their UTC day and describe data up to that day's end at
 * the latest, so a line whose day reaches `heldOutFrom` (a candidate's held-out numbers, a forward result) is hidden.
 */
export function lessonsForPrompt(text: string, heldOutFrom: number): string {
  let hidden = 0;
  const kept = text.split('\n').filter((l) => {
    const m = /^- (\d{4}-\d{2}-\d{2}) /.exec(l);
    if (!m) return true;
    if (Date.parse(`${m[1]}T00:00:00Z`) + 86_400_000 <= heldOutFrom) return true;
    hidden++;
    return false;
  });
  if (hidden) kept.push(`(${hidden} newer lines hidden: they come from the held-out days)`);
  return kept.join('\n');
}

export function appendLesson(home: string, line: string): void {
  ensureFactoryDir(home);
  const p = factoryLessonsPath(home);
  const cur = existsSync(p) ? readFileSync(p, 'utf8') : `${LESSONS_SEED}\n`;
  // Bounded: the seed + the newest 80 run lines.
  const lines = cur.trimEnd().split('\n');
  const head = lines.slice(0, lines.indexOf('Factory runs (newest last):') + 1);
  const runs = lines.slice(head.length).filter(Boolean);
  writeFileSync(p, `${[...(head.length ? head : LESSONS_SEED.split('\n')), ...[...runs, `- ${line.replace(/\s+/g, ' ')}`].slice(-80)].join('\n')}\n`, { mode: 0o600 });
}

const isoDay = (t: number): string => new Date(t).toISOString().slice(0, 10);

// ───────────────────────────── duplicates ─────────────────────────────

function leaves(v: unknown, at = '', out = new Map<string, unknown>()): Map<string, unknown> {
  if (v && typeof v === 'object') { for (const [k, x] of Object.entries(v)) leaves(x, `${at}/${k}`, out); if (Array.isArray(v) && !v.length) out.set(at, '[]'); }
  else out.set(at, v);
  return out;
}

/** Near duplicate: the same rule keys, and every difference is a number within 5% (or 0.5 for small values). */
export function nearDuplicate(a: ResolvedStrategy, b: ResolvedStrategy): boolean {
  const la = leaves(rulesView(a));
  const lb = leaves(rulesView(b));
  if (la.size !== lb.size) return false;
  let diffs = 0;
  for (const [k, x] of la) {
    if (!lb.has(k)) return false;
    const y = lb.get(k);
    if (x === y) continue;
    if (typeof x !== 'number' || typeof y !== 'number') return false;
    if (Math.abs(x - y) > Math.max(0.5, Math.abs(y) * 0.05)) return false;
    diffs++;
  }
  return diffs > 0;
}

// ───────────────────────────── the run ─────────────────────────────

export interface FactoryDeps {
  home: string;
  analyst: FactoryAnalyst;
  /** The recorder tape for a time window (read-only); null = no recorder data. */
  tape: (w: { since: number; until: number }, c: FactoryConfig) => Tape | null;
  now?: () => number;
  /** Starts a forward test's host (detached `dexterm autotrade forward run <fid>`); null = could not start. */
  forwardSpawner?: ((home: string, t: ForwardTest) => number | null) | null;
  log?: (line: string) => void;
  /** Who started the run: `cli`, `schedule`, `chat`. */
  by?: string;
  /** A scheduled run skips when the last scheduled run is newer than the interval. */
  scheduled?: boolean;
  /** Overrides (CLI flags); never above the config's own caps. */
  maxCandidates?: number;
  /** task-2167: admit queued inbox offers only: no evidence pass, no analyst call, no spend. */
  inboxOnly?: boolean;
  /** The user's focus for this run (CLI `--focus`): what to try, in words; shown to the analyst after the evidence. */
  focus?: string;
  /** Available memory in MB (tests); default availableMemoryMb(). Only scheduled runs check it (a run by hand is the user's call). */
  freeMemMb?: () => number | null;
}

export interface Reject { attempt: number; reasons: string[]; costUsd: number }

export interface FactoryRunResult {
  runId: string;
  ok: boolean;
  /** What happened, in one line. */
  verdict: string;
  /** The cap or guard that ended the run early (null = it ran to the end). */
  stop: string | null;
  candidates: GeneratedReport[];
  rejects: Reject[];
  calls: number;
  spendUsd: number;
  housekeeping: string[];
  ms: number;
}

/** A run focus: one line of plain text, control characters dropped, at most 500 characters. */
export const cleanFocus = (x: string | undefined): string => (x ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);

export const newFactoryRunId = (now: number): string => `fr_${now.toString(36)}_${randomBytes(3).toString('hex')}`;
export const newGeneratedId = (now: number): string => {
  const d = new Date(now);
  return `gen-${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}-${randomBytes(2).toString('hex')}`;
};

/** The held-out test says it loses: enough entries and the whole 95% range below zero. */
export const heldOutLoses = (h: Pick<EntryStats, 'n' | 'hi'>): boolean => h.n >= 20 && h.hi !== null && h.hi < 0;

export function heldOutVerdict(h: Pick<EntryStats, 'n' | 'meanPct' | 'lo' | 'hi' | 'mean2xPct' | 'noTop3Pct'>): string {
  if (h.n < 20) return `too few held-out entries to say anything (n ${h.n} < 20)`;
  if (heldOutLoses(h)) return 'loses on the held-out days (the whole 95% range is below zero)';
  if (h.lo !== null && h.lo > 0 && (h.mean2xPct ?? -1) > 0 && (h.noTop3Pct ?? -1) > 0) return 'held up on the held-out days, also at 2x costs and without the top 3; still a paper candidate until a forward test agrees';
  return 'no edge shown on the held-out days (the 95% range includes zero or a stress test fails)';
}

/** Judge finished forward tests; start queued ones while slots are free. Returns what it did, one line each. */
export function housekeeping(home: string, c: FactoryConfig, o: { now: number; by: string; spawner: FactoryDeps['forwardSpawner']; store: StrategyStore }): string[] {
  const out: string[] = [];
  const gens = listGenerated(home);
  for (let r of gens) {
    if (r.stage !== 'forward-testing' || !r.forward.forwardId) continue;
    const t = loadForwardTest(home, r.forward.forwardId);
    if (!t) { retireGenerated(home, r.id, 'factory', 'its forward test record is gone', o.now); out.push(`${r.id}: retired (forward test record missing)`); continue; }
    const st = liveState(t, o.now);
    if (st === 'starting' || st === 'running') continue;
    const fr = latestForward(loadJourney(home, r.id), r.rulesHash);
    const m = fr?.forwardId === t.forwardId ? fr.metrics : t.metrics;
    const result = { state: st, trades: m?.trades ?? 0, netUsd: m?.netUsd ?? null, netPct: m?.netPct ?? null };
    r = { ...r, forward: { ...r.forward, result } };
    saveGenerated(home, r);
    if (st !== 'done') { retireGenerated(home, r.id, 'factory', `its forward test ended ${st}${t.endReason ? ` (${t.endReason.slice(0, 80)})` : ''} before its window`, o.now); out.push(`${r.id}: retired (forward ${st})`); continue; }
    if (result.trades < c.minForwardEntries) { retireGenerated(home, r.id, 'factory', `forward test: ${result.trades} closed trades, fewer than ${c.minForwardEntries} to judge`, o.now); out.push(`${r.id}: retired (too few forward trades)`); continue; }
    if ((result.netUsd ?? 0) <= 0) { retireGenerated(home, r.id, 'factory', `forward test lost: net ${result.netUsd} USD (${result.netPct}%) over ${result.trades} trades`, o.now); out.push(`${r.id}: retired (forward net <= 0)`); continue; }
    setStage(home, r, 'forward-passed', `forward test net ${result.netUsd} USD over ${result.trades} trades; still a candidate (the "good" bar needs >= 100 entries); promotion is the user's`, o.now);
    appendLesson(home, `${isoDay(o.now)} ${r.id} survived its forward test: net ${result.netUsd} USD over ${result.trades} trades (paper; not the "good" bar)`);
    out.push(`${r.id}: forward-passed (${result.trades} trades, net ${result.netUsd} USD)`);
  }
  if (!c.forward.autoStart || !o.spawner) return out;
  const running = () => listGenerated(home).filter((r) => r.stage === 'forward-testing').length;
  for (const r of listGenerated(home).filter((x) => x.stage === 'queued-forward').reverse()) {
    if (running() >= c.maxConcurrentForward) { out.push(`${r.id}: waits for a forward slot (${c.maxConcurrentForward} at once)`); break; }
    if (listForwardTests(home).filter((t) => isActive(t, o.now)).length >= FORWARD_LIMITS.maxRunning) { out.push(`${r.id}: waits (${FORWARD_LIMITS.maxRunning} forward tests already run on this home)`); break; }
    const got = o.store.get(r.id);
    const raw = o.store.raw(r.id);
    if (!got || !got.ok || !raw) { retireGenerated(home, r.id, 'factory', 'its strategy file is missing or no longer validates', o.now); out.push(`${r.id}: retired (strategy file gone)`); continue; }
    if (got.strategy.hash !== r.hash) { retireGenerated(home, r.id, 'factory', 'its strategy file was edited after it was generated (a new rules hash starts the ladder again)', o.now); out.push(`${r.id}: retired (edited)`); continue; }
    const ct = createForwardTest(home, got.strategy, raw as Strategy, { hours: c.forward.hours, trades: c.forward.trades, by: `factory:${o.by}`, now: o.now, source: 'live' });
    if (!ct.ok) { out.push(`${r.id}: forward test not started: ${ct.why}`); continue; }
    const pid = o.spawner(home, ct.test);
    if (!pid) { saveForwardTest(home, { ...ct.test, state: 'failed', endedAt: o.now, endReason: 'the factory could not start the host' }); out.push(`${r.id}: forward host could not start; stays queued`); continue; }
    setStage(home, { ...r, forward: { ...r.forward, forwardId: ct.test.forwardId, startedAt: o.now } }, 'forward-testing', `forward test ${ct.test.forwardId} (${c.forward.hours} h or ${c.forward.trades} trades, paper, live data, own bankroll)`, o.now);
    out.push(`${r.id}: forward test ${ct.test.forwardId} started`);
  }
  return out;
}

export async function runFactory(d: FactoryDeps): Promise<FactoryRunResult> {
  const now = d.now ?? Date.now;
  const t0 = now();
  const runId = newFactoryRunId(t0);
  const log = d.log ?? (() => {});
  const by = d.by ?? 'cli';
  const res: FactoryRunResult = { runId, ok: false, verdict: '', stop: null, candidates: [], rejects: [], calls: 0, spendUsd: 0, housekeeping: [], ms: 0 };
  const home = d.home;
  const focus = cleanFocus(d.focus);
  const finish = (stop: string | null, verdict: string, ok: boolean): FactoryRunResult => {
    res.stop = stop; res.verdict = verdict; res.ok = ok; res.ms = now() - t0;
    try {
      const st = loadFactoryState(home);
      saveFactoryState(home, { ...st, ...(d.scheduled && stop !== 'not-due' ? { lastScheduledAt: t0 } : {}), lastRunAt: t0, lastRunId: runId, lastVerdict: verdict, lastStop: stop, runs: st.runs + 1, candidates: st.candidates + res.candidates.length });
      appendRunLine(home, { runId, t: t0, by, ok, stop, verdict, ...(focus ? { focus } : {}), candidates: res.candidates.map((x) => x.id), rejects: res.rejects, calls: res.calls, spendUsd: round4(res.spendUsd), housekeeping: res.housekeeping, ms: res.ms });
    } catch { /* a full disk must not hide the result */ }
    log(`factory ${runId}: ${verdict}`);
    return res;
  };

  // 0. guards (the user's FACTORY-STOP, or an agent's AGENT-PAUSE: task-2167)
  const halt = factoryHalt(home);
  if (halt) { const h = halt.info; res.verdict = `stopped: ${halt.kind} (${h.by}${h.why ? `: ${h.why}` : ''}); \`dexterm autotrade factory resume\` lifts it`; res.stop = halt.kind; return res; }
  const cfg = loadFactoryConfig(home);
  if (!cfg.ok) { res.stop = 'config'; res.verdict = `stopped: ${cfg.path} is invalid: ${cfg.errors.join('; ')}`; return res; }
  const c = cfg.config;
  const lock = acquireFactoryLock(home, t0);
  if (!lock.ok) { res.stop = 'busy'; res.verdict = `stopped: another factory run holds the lock (pid ${lock.holder.pid})`; return res; }
  try {
    const store = new StrategyStore({ home, now });
    // 1. housekeeping
    res.housekeeping = housekeeping(home, c, { now: t0, by, spawner: d.forwardSpawner ?? null, store });
    for (const h of res.housekeeping) log(`housekeeping: ${h}`);

    // 2. caps
    const st = loadFactoryState(home);
    const lastSched = st.lastScheduledAt ?? null;
    if (d.scheduled && lastSched !== null && t0 - lastSched < (c.intervalHours - 0.5) * 3600e3) return finish('not-due', `skipped: the last scheduled run was ${((t0 - lastSched) / 3600e3).toFixed(1)} h ago (interval ${c.intervalHours} h)`, true);
    const mem = d.scheduled && c.minFreeMemMb > 0 ? (d.freeMemMb ?? availableMemoryMb)() : null;
    if (mem !== null && mem < c.minFreeMemMb) return finish('low-memory', `skipped: ${mem} MB of memory available, under minFreeMemMb ${c.minFreeMemMb} (a run peaks near 2 GB)`, true);
    const active = listGenerated(home).filter(isActiveGenerated);
    if (active.length >= c.maxActiveGenerated) return finish('cap:maxActiveGenerated', `stopped: ${active.length} generated strategies are active (cap maxActiveGenerated ${c.maxActiveGenerated}); retire some first`, true);
    const disk = factoryDiskMb(home);
    if (disk >= c.maxDiskMb) return finish('cap:maxDiskMb', `stopped: the factory uses ${disk} MB (cap maxDiskMb ${c.maxDiskMb})`, true);
    const offers = listOffers(home, 'queued');
    let inboxOnly = !!d.inboxOnly;
    if (inboxOnly && !offers.length) return finish('no-offers', 'nothing to do: no queued offers in the inbox (inbox-only run, no analyst call)', true);
    const today = spendToday(home, t0);
    const spendCap = today.calls >= c.maxCallsPerDay ? { stop: 'cap:maxCallsPerDay', why: `${today.calls} analyst calls today (cap maxCallsPerDay ${c.maxCallsPerDay})` }
      : today.usd + c.maxUsdPerCall > c.maxUsdPerDay + 1e-9 ? { stop: 'cap:maxUsdPerDay', why: `$${today.usd} spent today; one more call could pass the cap (maxUsdPerDay ${c.maxUsdPerDay}, a call may cost up to maxUsdPerCall ${c.maxUsdPerCall})` } : null;
    if (!inboxOnly && spendCap) {
      if (!offers.length) return finish(spendCap.stop, `stopped: ${spendCap.why}`, true);
      inboxOnly = true; // the spend cap stops the analyst, not the admission of offers (they cost nothing)
      log(`analyst skipped: ${spendCap.why}; admitting queued offers only`);
    }

    // 3. evidence (the held-out days are cut off first and never reach the prompt)
    const DAY = 86_400_000;
    const heldOut = { from: t0 - c.heldOutDays * DAY, to: t0 };
    const window = { from: heldOut.from - c.evidenceDays * DAY, to: heldOut.from };
    const isoMin = (t: number): string => new Date(t).toISOString().slice(0, 16) + 'Z';
    const hoWindow = { from: isoMin(heldOut.from), to: isoMin(heldOut.to), days: Math.round(c.heldOutDays * 10) / 10 };
    const gens = listGenerated(home);
    let ev: EvidenceTable | null = null;
    if (!inboxOnly) {
      let evTape = d.tape({ since: window.from, until: window.to - 1 }, c);
      if (!evTape || !evTape.mints.length) return finish('no-data', 'stopped: no recorded data in the evidence window (is the recorder running on this machine?)', false);
      log(`evidence: ${evTape.mints.length} coins (${new Date(window.from).toISOString()} → ${new Date(window.to).toISOString()})`);
      const genMap = new Map(gens.map((g) => [g.id, { parents: g.parents, stage: g.stage }]));
      const retired = new Set(gens.filter((g) => g.stage === 'retired').map((g) => g.id));
      ev = await gatherEvidence({ store, home, tape: evTape, window, heldOut, unitUsd: c.unitUsd, generated: genMap, skip: retired, now: t0, onProgress: (id) => log(`evidence: ${id}`) });
      evTape = null; // one tape in memory at a time: the held-out tape is read after the evidence tape is released
    }
    const hoTape = d.tape({ since: heldOut.from, until: heldOut.to }, c);
    if (!hoTape || !hoTape.mints.length) return finish('no-data', `stopped: no recorded data in the newest ${c.heldOutDays} days to hold out (is the recorder running?)`, false);
    log(`held out: ${hoTape.mints.length} coins (${new Date(heldOut.from).toISOString()} → ${new Date(heldOut.to).toISOString()}), never shown to the generator`);
    const known = store.list().filter((e) => e.ok).map((e) => store.get(e.id)).filter((g): g is NonNullable<typeof g> & { ok: true } => !!g && g.ok).map((g) => g.strategy);
    const knownRules = new Set([...known.map((s) => rulesHash(s)), ...gens.map((g) => g.rulesHash)]);
    const want = Math.min(c.maxCandidatesPerRun, d.maxCandidates ?? c.maxCandidatesPerRun);

    // 5. store, hold-out test, ladder: ONE path for the analyst's reply and an agent's offer (task-2167)
    interface AdmitMeta { source: string; actor: string; model: string; costUsd: number; note: string; offerId: string | null; evidenceWindow: EvidenceTable['window']; lessonsUsed: string[] }
    const admit = async (built: Extract<ReturnType<typeof buildCandidate>, { ok: true }>, p: Proposal, rh: string, meta: AdmitMeta): Promise<GeneratedReport | { error: string[] }> => {
      const w = store.create(built.doc, { actor: meta.actor, why: `generated (${meta.source}) in strategy factory run ${runId} from ${p.parents.join(', ')}` });
      if (!w.ok) return { error: w.errors.map((e) => `store refused it: ${e.path} ${e.msg}`) };
      const s = w.strategy;
      knownRules.add(rh);
      known.push(s);
      let rep: GeneratedReport = {
        schema: FACTORY_REPORT_SCHEMA, id: s.id, name: s.name, label: LABEL, paper: true, createdAt: now(), runId, stage: 'candidate',
        base: p.base, parents: p.parents, hash: s.hash, rulesHash: rh, ops: p.ops, rationale: p.rationale, citations: p.citations, retireProposals: p.retire,
        evidenceWindow: meta.evidenceWindow, heldOut: null, model: meta.model, costUsd: round4(meta.costUsd),
        forward: { forwardId: null, queuedAt: null, startedAt: null, result: null }, retired: null,
        history: [{ t: now(), stage: 'candidate', note: meta.note }],
        source: meta.source, offerId: meta.offerId, lessonsUsed: meta.lessonsUsed,
      };
      saveGenerated(home, rep);
      writeJsonAtomic(join(generatedPath(home, s.id), 'strategy.json'), built.doc);
      writeFileSync(join(generatedPath(home, s.id), 'rationale.md'), rationaleMd(rep), { mode: 0o600 });
      log(`candidate ${s.id}: held-out test on ${hoTape.mints.length} coins`);
      const ho = await entryStats(s, hoTape, c.unitUsd);
      rep = { ...rep, heldOut: { ...ho, window: hoWindow, mints: hoTape.mints.length, verdict: heldOutVerdict(ho) } };
      const { evidence } = await backtestEvidence(s, hoTape, { by: `factory:${by}`, now: now(), days: c.heldOutDays });
      recordBacktestEvidence(home, evidence);
      rep = setStage(home, rep, 'backtested', `held out: n ${ho.n}, mean ${ho.meanPct}% (${ho.lo} to ${ho.hi}), 2x costs ${ho.mean2xPct}%, without top 3 ${ho.noTop3Pct}%: ${rep.heldOut!.verdict}`, now());
      const loser = heldOutLoses(ho);
      if (!(loser && c.forward.skipHeldOutLosers)) rep = setStage(home, { ...rep, forward: { ...rep.forward, queuedAt: now() } }, 'queued-forward', `queued for a ${c.forward.hours} h / ${c.forward.trades} trade paper forward test`, now());
      writeFileSync(join(generatedPath(home, s.id), 'rationale.md'), rationaleMd(rep), { mode: 0o600 });
      appendLesson(home, `${isoDay(now())} ${s.id} from ${p.parents.join('+')}${meta.source === 'factory' ? '' : ` (offered by ${meta.source})`}: ${p.rationale.summary.slice(0, 140)} → held out n ${ho.n}, mean ${ho.meanPct}% (${ho.lo} to ${ho.hi}), 2x costs ${ho.mean2xPct}%, without top 3 ${ho.noTop3Pct}%`);
      // A candidate whose whole held-out range is below zero cannot pass the forward gate's bar on this evidence; it does
      // not take one of the few forward slots (kept on disk, retired with the reason; forward.skipHeldOutLosers false = queue it anyway).
      if (loser && c.forward.skipHeldOutLosers) { rep = retireGenerated(home, s.id, 'factory', `held out: the whole 95% range is below zero (n ${ho.n}, ${ho.lo} to ${ho.hi}); not given a forward slot`, now()).ok ? loadGenerated(home, s.id) ?? rep : rep; writeFileSync(join(generatedPath(home, s.id), 'rationale.md'), rationaleMd(rep), { mode: 0o600 }); }
      return rep;
    };

    // 4a. offers from external agents (task-2167): checked at offer time against the evidence snapshot they were shown;
    // here they get the checks that depend on the present (base still there, duplicates, caps) and the same admission.
    for (const o of offers) {
      if (res.candidates.length >= want) break;
      const rejectOffer = (reasons: string[]): void => {
        resolveOffer(home, o, { status: 'rejected', reasons, runId, now: now() });
        res.rejects.push({ attempt: 0, reasons: [`offer ${o.offerId} (${o.source}): ${reasons[0] ?? 'rejected'}`, ...reasons.slice(1)].slice(0, 12), costUsd: 0 });
        log(`rejected offer ${o.offerId}: ${reasons.slice(0, 4).join('; ')}`);
      };
      if (listGenerated(home).filter(isActiveGenerated).length >= c.maxActiveGenerated) { log(`offers wait: ${c.maxActiveGenerated} generated strategies are active (cap maxActiveGenerated)`); break; }
      if (o.windowEndMs > heldOut.from) { rejectOffer(['its evidence snapshot reaches into this run\'s held-out days, so the held-out test would not be honest; offer it again against the newest evidence']); continue; }
      const baseS = known.find((s) => s.id === o.proposal.base);
      if (!baseS) { rejectOffer([`base ${o.proposal.base} no longer exists or no longer validates`]); continue; }
      const goneParents = o.proposal.parents.filter((x) => !known.some((s) => s.id === x));
      if (goneParents.length) { rejectOffer([`parents no longer exist: ${goneParents.join(', ')}`]); continue; }
      const built = buildCandidate(baseS, o.proposal, { id: newGeneratedId(now()), summary: o.proposal.rationale.summary });
      if (!built.ok) { rejectOffer(built.problems.map((x) => `invalid strategy: ${x}`)); continue; }
      const rh = rulesHash(built.strategy);
      if (knownRules.has(rh)) { rejectOffer([`duplicate: the same rules (rules hash ${rh}) already exist`]); continue; }
      const near = known.find((s) => nearDuplicate(built.strategy, s));
      if (near) { rejectOffer([`near duplicate of ${near.id}: every change is a number within 5%`]); continue; }
      const diskO = factoryDiskMb(home);
      if (diskO >= c.maxDiskMb) return finish('cap:maxDiskMb', `stopped: the factory uses ${diskO} MB (cap ${c.maxDiskMb}); ${summary(res)}`, res.candidates.length > 0);
      const a = await admit(built, o.proposal, rh, { source: o.source, actor: o.source, model: o.source, costUsd: 0, note: `offered by ${o.source} (${o.offerId}), admitted by run ${runId}`, offerId: o.offerId, evidenceWindow: o.window, lessonsUsed: [] });
      if ('error' in a) { rejectOffer(a.error); continue; }
      resolveOffer(home, o, { status: 'admitted', candidateId: a.id, runId, now: now() });
      log(`offer ${o.offerId} (${o.source}) admitted as ${a.id}`);
      res.candidates.push(a);
    }

    // 4b. the analyst, bounded (a full run only)
    if (ev && res.candidates.length < want) {
      const evNums = evidenceNumbers(ev);
      const lessons = lessonsForPrompt(readLessons(home), heldOut.from);
      const extra = [...numbersIn(lessons), c.forward.hours, c.forward.trades, c.heldOutDays, c.evidenceDays, c.unitUsd, c.minForwardEntries, 20, 80, 100, 95];
      const recent = gens.slice(0, 12).map((g) => `${g.id} (${g.stage}): ${g.rationale.summary.slice(0, 160)}`);
      const basePrompt = buildPrompt(evidenceText(ev), lessons, recent, focus);
      const lessonsUsed = lessons.split('\n').filter((l) => /^- \d{4}-\d{2}-\d{2} /.test(l)).slice(-20).map((l) => l.slice(0, 300));
      // what an external agent may read and cite (factory_evidence): exactly what this analyst is shown, nothing newer
      saveEvidenceSnapshot(home, { schema: EVIDENCE_SNAPSHOT_SCHEMA, runId, at: t0, window: ev.window, heldOut: ev.heldOut, windowEndMs: window.to, rows: ev.rows.map((r) => ({ ref: r.ref, id: r.id, rulesHash: r.rulesHash })), text: evidenceText(ev), numbers: Object.fromEntries(evNums), extra });
      let feedback = '';
      for (let attempt = 1; attempt <= c.maxAttemptsPerRun && res.candidates.length < want; attempt++) {
        if (res.calls >= c.maxCallsPerRun) return finish('cap:maxCallsPerRun', `stopped: ${res.calls} analyst calls this run (cap maxCallsPerRun ${c.maxCallsPerRun}); ${summary(res)}`, res.candidates.length > 0);
        const day = spendToday(home, now());
        if (day.calls >= c.maxCallsPerDay) return finish('cap:maxCallsPerDay', `stopped: ${day.calls} analyst calls today (cap ${c.maxCallsPerDay}); ${summary(res)}`, res.candidates.length > 0);
        if (res.spendUsd + c.maxUsdPerCall > c.maxUsdPerRun + 1e-9) return finish('cap:maxUsdPerRun', `stopped: $${round4(res.spendUsd)} this run; one more call could pass maxUsdPerRun ${c.maxUsdPerRun}; ${summary(res)}`, res.candidates.length > 0);
        if (day.usd + c.maxUsdPerCall > c.maxUsdPerDay + 1e-9) return finish('cap:maxUsdPerDay', `stopped: $${day.usd} today; one more call could pass maxUsdPerDay ${c.maxUsdPerDay}; ${summary(res)}`, res.candidates.length > 0);
        const midHalt = factoryHalt(home);
        if (midHalt) return finish(midHalt.kind, `stopped mid-run: ${midHalt.kind} appeared; ${summary(res)}`, res.candidates.length > 0);
        if (listGenerated(home).filter(isActiveGenerated).length >= c.maxActiveGenerated) return finish('cap:maxActiveGenerated', `stopped: cap maxActiveGenerated ${c.maxActiveGenerated} reached; ${summary(res)}`, res.candidates.length > 0);
        log(`analyst: attempt ${attempt} (${c.model}, up to $${c.maxUsdPerCall})`);
        const reply = await d.analyst({ system: SYSTEM_PROMPT, prompt: basePrompt + feedback, model: c.model, budgetUsd: c.maxUsdPerCall });
        res.calls++;
        res.spendUsd += reply.costUsd;
        appendSpend(home, { t: now(), runId, costUsd: reply.costUsd, ok: !reply.error });
        const reject = (reasons: string[]): void => {
          res.rejects.push({ attempt, reasons: reasons.slice(0, 12), costUsd: round4(reply.costUsd) });
          log(`rejected (attempt ${attempt}): ${reasons.slice(0, 4).join('; ')}`);
          feedback = `\n\n## Your previous reply was rejected\n${reasons.slice(0, 8).map((x) => `- ${x}`).join('\n')}\nFix these and reply again with one JSON object.`;
        };
        if (reply.error) { reject([`analyst error: ${reply.error}`]); continue; }
        const parsed = parseProposal(reply.text);
        if (!parsed.ok) { reject(parsed.problems); continue; }
        const p = parsed.proposal;
        const baseS = known.find((s) => s.id === p.base);
        if (!baseS) { reject([`base ${p.base} is not one of the strategies in the evidence`]); continue; }
        const unknownParents = p.parents.filter((x) => !known.some((s) => s.id === x));
        if (unknownParents.length) { reject([`parents not in the evidence: ${unknownParents.join(', ')}`]); continue; }
        const built = buildCandidate(baseS, p, { id: newGeneratedId(now()), summary: p.rationale.summary });
        if (!built.ok) { reject(built.problems.map((x) => `invalid strategy: ${x}`)); continue; }
        const parentsS = p.parents.map((x) => known.find((s) => s.id === x)!).filter(Boolean);
        const ruleNums = [...jsonNumbers(rulesView(built.strategy)), ...parentsS.flatMap((s) => jsonNumbers(rulesView(s)))];
        const cc = crossCheck({ proposal: p, evidence: evNums, extra, rules: ruleNums });
        if (cc.length) { reject(cc.map((x) => `numbers: ${x}`)); continue; }
        const wd = wordingProblems(p);
        if (wd.length) { reject(wd); continue; }
        const rh = rulesHash(built.strategy);
        if (knownRules.has(rh)) { reject([`duplicate: the same rules (rules hash ${rh}) already exist`]); continue; }
        const near = known.find((s) => nearDuplicate(built.strategy, s));
        if (near) { reject([`near duplicate of ${near.id}: every change is a number within 5%`]); continue; }
        const disk2 = factoryDiskMb(home);
        if (disk2 >= c.maxDiskMb) return finish('cap:maxDiskMb', `stopped: the factory uses ${disk2} MB (cap ${c.maxDiskMb}); ${summary(res)}`, res.candidates.length > 0);
        const a = await admit(built, p, rh, { source: 'factory', actor: `factory:${by}`, model: c.model, costUsd: reply.costUsd, note: `generated by run ${runId} (attempt ${attempt})`, offerId: null, evidenceWindow: ev.window, lessonsUsed });
        if ('error' in a) { reject(a.error); continue; }
        res.candidates.push(a);
      }
    }
    // queued candidates start now if a slot is free
    if (res.candidates.length) for (const h of housekeeping(home, c, { now: now(), by, spawner: d.forwardSpawner ?? null, store })) { res.housekeeping.push(h); log(`housekeeping: ${h}`); }
    if (!res.candidates.length) return finish(inboxOnly ? 'offers' : 'attempts', inboxOnly ? `no candidate: ${res.rejects.length} offer(s) rejected, ${listOffers(home, 'queued').length} still queued; ${summary(res)}` : `no candidate: ${res.rejects.length} replies rejected (cap maxAttemptsPerRun ${c.maxAttemptsPerRun}); ${summary(res)}`, false);
    const fresh = res.candidates.map((x) => loadGenerated(home, x.id) ?? x);
    res.candidates = fresh;
    return finish(null, `made ${fresh.map((x) => `${x.id} (${x.stage}; held out: ${x.heldOut?.verdict})`).join(', ')}; ${summary(res)}`, true);
  } finally { lock.release(); }
}

const round4 = (x: number): number => Math.round(x * 10000) / 10000;
const summary = (r: FactoryRunResult): string => `${r.calls} analyst call${r.calls === 1 ? '' : 's'}, $${round4(r.spendUsd)}, ${r.rejects.length} rejected`;

export function rationaleMd(r: GeneratedReport): string {
  const h = r.heldOut;
  return [
    `# ${r.id}: ${r.name}`, '', `${r.label}`, '',
    `Parents: ${r.parents.join(', ')} (ops on ${r.base}). Run ${r.runId}, ${new Date(r.createdAt).toISOString()}, model ${r.model}, $${r.costUsd}.`, '',
    '## Why', r.rationale.summary, '',
    ...r.rationale.rules.map((x) => `- **${x.change}**: ${x.why}${x.cites.length ? ` (${x.cites.join(', ')})` : ''}`), '',
    `**Expected to fail on:** ${r.rationale.expectedFailure}`, '', `**Versus its parents:** ${r.rationale.versusParents}`, '',
    '## Held-out test (days the analyst never saw)',
    h ? `${h.window.from} to ${h.window.to}, ${h.mints} coins: n ${h.n}, mean ${h.meanPct}% per entry (95% ${h.lo} to ${h.hi}), at 2x costs ${h.mean2xPct}%, without the top 3 ${h.noTop3Pct}%, rug rate ${h.rugRatePct}%. ${h.verdict}.` : 'not run yet', '',
    ...(r.retireProposals.length ? ['## Retirements the analyst proposed (not applied)', ...r.retireProposals.map((x) => `- ${x.id}: ${x.why}`), ''] : []),
    `Stage: ${r.stage}. Paper and simulated; a candidate is not an edge.`, '',
  ].join('\n');
}

// ───────────────────────────── status ─────────────────────────────

export interface FactoryStatusView {
  paper: true;
  stopped: ReturnType<typeof factoryStopped>;
  /** task-2167: an MCP agent's pause (AGENT-PAUSE), separate from the user's FACTORY-STOP. */
  agentPause: ReturnType<typeof agentPaused>;
  /** task-2167: candidates external agents offered, by status. */
  offers: { queued: number; admitted: number; rejected: number };
  config: FactoryConfig | null;
  configErrors: string[];
  lastRun: { at: string | null; runId: string | null; verdict: string | null; stop: string | null };
  runs: number;
  spendToday: { calls: number; usd: number };
  diskMb: number;
  candidates: { id: string; name: string; stage: GeneratedStage; parents: string[]; createdAt: string; heldOut: string; forward: string; retired: string | null; summary: string }[];
  counts: Record<GeneratedStage, number>;
}

export function factoryStatus(home: string, now = Date.now()): FactoryStatusView {
  const cfg = loadFactoryConfig(home);
  const st = loadFactoryState(home);
  const gens = listGenerated(home);
  const counts = Object.fromEntries(GENERATED_STAGES.map((s) => [s, gens.filter((g) => g.stage === s).length])) as Record<GeneratedStage, number>;
  return {
    paper: true,
    stopped: factoryStopped(home),
    agentPause: agentPaused(home),
    offers: { queued: listOffers(home, 'queued').length, admitted: listOffers(home, 'admitted').length, rejected: listOffers(home, 'rejected').length },
    config: cfg.ok ? cfg.config : null,
    configErrors: cfg.ok ? [] : cfg.errors,
    lastRun: { at: st.lastRunAt ? new Date(st.lastRunAt).toISOString() : null, runId: st.lastRunId, verdict: st.lastVerdict, stop: st.lastStop },
    runs: st.runs,
    spendToday: spendToday(home, now),
    diskMb: factoryDiskMb(home),
    candidates: gens.map((g) => ({
      id: g.id, name: g.name, stage: g.stage, parents: g.parents, createdAt: new Date(g.createdAt).toISOString(),
      heldOut: g.heldOut ? `n ${g.heldOut.n}, mean ${g.heldOut.meanPct}% (${g.heldOut.lo} to ${g.heldOut.hi}), 2x ${g.heldOut.mean2xPct}%, w/o top 3 ${g.heldOut.noTop3Pct}%` : 'not run',
      forward: g.forward.result ? `${g.forward.result.state}: ${g.forward.result.trades} trades, net ${g.forward.result.netUsd} USD` : g.forward.forwardId ? `running (${g.forward.forwardId})` : g.forward.queuedAt ? 'queued' : '—',
      retired: g.retired ? g.retired.why : null,
      summary: g.rationale.summary,
    })),
    counts,
  };
}

export function renderFactoryStatus(v: FactoryStatusView): string[] {
  const c = v.config;
  const out = [
    `Strategy factory (PAPER; candidates are not edges)${v.stopped ? `: STOPPED by FACTORY-STOP (${v.stopped.by}${v.stopped.why ? `: ${v.stopped.why}` : ''})` : ''}`,
    ...(v.agentPause ? [`PAUSED by an agent (AGENT-PAUSE, ${v.agentPause.by}${v.agentPause.why ? `: ${v.agentPause.why}` : ''}); \`dexterm autotrade factory resume\` lifts it`] : []),
    `last run: ${v.lastRun.at ?? 'never'}${v.lastRun.verdict ? ` · ${v.lastRun.verdict}` : ''}`,
    ...(v.offers.queued + v.offers.admitted + v.offers.rejected ? [`agent offers: ${v.offers.queued} queued · ${v.offers.admitted} admitted · ${v.offers.rejected} rejected (the next run admits queued ones through the same gate)`] : []),
    `spend today: ${v.spendToday.calls} call(s), $${v.spendToday.usd}${c ? ` (caps ${c.maxCallsPerDay} calls, $${c.maxUsdPerDay}/day; $${c.maxUsdPerRun}/run; $${c.maxUsdPerCall}/call)` : ''} · disk ${v.diskMb} MB${c ? ` of ${c.maxDiskMb}` : ''}`,
    ...(c ? [`caps: ${c.maxCandidatesPerRun} candidate/run, ${c.maxAttemptsPerRun} attempts/run, ${c.maxActiveGenerated} active, ${c.maxConcurrentForward} forward test(s) at once · ${describeFactorySchedule(c.at, c.intervalHours)} · skips under ${c.minFreeMemMb} MB free memory · evidence ${c.evidenceDays} d, held out ${c.heldOutDays} d · model ${c.model}`] : [`factory.json is invalid: ${v.configErrors.join('; ')}`]),
    `candidates: ${GENERATED_STAGES.map((s) => `${s} ${v.counts[s]}`).join(' · ')}`,
  ];
  for (const g of v.candidates.slice(0, 20)) out.push(`  ${g.id}  ${g.stage.padEnd(15)} from ${g.parents.join('+')}  held out: ${g.heldOut}  forward: ${g.forward}${g.retired ? `  retired: ${g.retired}` : ''}`);
  return out;
}
