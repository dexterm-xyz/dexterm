// dexterm — the AUTOTRADE (paper) screen's state and verbs (`Q`, task-1508, AUTOTRADE-SPEC §2b). PAPER ONLY.
//
// Five views on one screen key ('autotrade'), cycled with tab:
//   list      presets + the user's strategies (mode, version, hash, last backtest, the active runner's marker)
//   editor    one form, six sections; every field re-validates on change (validateStrategy), errors inline with
//             their path; the screen filter is checked by the screener's own parser (error column highlighted);
//             `s` saves only a valid draft (a new version through StrategyStore.patch), `u` undoes with the
//             custom patch inverses (an unsaved edit first, else the last saved patch as a new version)
//   compare   two strategies side by side (changed fields highlighted) + both backtests on one tape
//   backtest  the §3 report (attribution, equity sparkline, clamps/refusals, limits) + a sweep with the held-out verdict
//   runner    the runner's rendezvous file (heartbeat, halt, candidates, sessions, positions, ledger tail)
//
// What this screen can never do: switch a strategy to live (the editor refuses /mode, an import is forced to
// paper), touch a wallet, a key, a mandate or the signer, or apply a model's edit (chat proposals are shown as
// cards; applying them is the chat card's keypress flow). Kill / pause / flatten go through RunnerControl: the
// runner's control file (task-1509 fileControl), the same request `dexterm autotrade stop|flatten` writes.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { applyOps, dextermHome, type PatchOp } from '@dexterm/custom';
import {
  StrategyStore, MAX_OPS, recordBacktestEvidence, type BacktestEvidence, STRATEGY_ID, activeRunner, bumpPatch, fmtIssue, readControl, readFleetStatus, requestControl, runnerRendezvousPath, validateStrategy,
  type BacktestReport, type FleetStatus, type ControlAction, type Grid, type Issue, type ListEntry, type ResolvedStrategy, type Strategy, type StrategyCheck, type SweepResult,
} from '@dexterm/autotrade';
import type { ProposalFiles } from '@dexterm/mcp';
import { parseFilter } from '../screener/filter.ts';
import { proposalFilesFor, proposalSource, type ProposalReview } from './autotrade-proposals.ts';
import { confirmPromote, type ForwardSpawn, type JourneyPanel } from './autotrade-journey.ts';

/** task-1647: `journey` (J on a strategy) is opened, never tab-cycled: the tabs stay the five views. */
export type AutotradeView = 'list' | 'editor' | 'compare' | 'backtest' | 'runner' | 'journey';
export const AUTOTRADE_VIEWS: readonly AutotradeView[] = ['list', 'editor', 'compare', 'backtest', 'runner'];
export const VIEW_TITLE: Record<AutotradeView, string> = { list: 'STRATEGIES', editor: 'EDITOR', compare: 'COMPARE', backtest: 'BACKTEST', runner: 'RUNNER', journey: 'JOURNEY' };

export const SECTIONS = ['entry', 'exits', 'risk', 'sizing', 'agent', 'execution'] as const;
export type Section = (typeof SECTIONS)[number];

/** Who the journal names for an edit made on this screen (the same actor the CLI uses for the user's own edits). */
export const TUI_ACTOR = 'user';
/** The default backtest window (the chat tool's limit, §2a). */
export const BACKTEST_DAYS = 14;
/** The runner writes its heartbeat every 10 s (§6.3); older than this the view says stale. */
export const HEARTBEAT_STALE_MS = 30_000;
export const INPUT_MAX = 400;

// ───────────────────────────── injected services ─────────────────────────────

/** task-1647: a single-strategy backtest also carries the held-out evidence the journey records. */
export interface BacktestOutcome { report: BacktestReport; curve: number[]; evidence?: BacktestEvidence }
/** Backtests and sweeps run off the render loop (a worker thread in the app, inline over a fixture tape in tests). */
export interface BacktestJobs {
  /** Every strategy on the SAME tape (one window), results in order. */
  backtest(ss: ResolvedStrategy[], o: { days: number; until: number }): Promise<BacktestOutcome[]>;
  sweep(s: ResolvedStrategy, grid: Grid, o: { days: number; until: number }): Promise<SweepResult>;
}

/** Kill / pause / flatten. Nothing here reaches a wallet or the signer. */
export interface RunnerControl {
  readonly wired: boolean;
  kill(): string;
  pause(): string;
  flatten(): string;
}
export const STUB_CONTROL: RunnerControl = {
  wired: false,
  kill: () => 'kill is not wired in this build yet (it ships with the runner\'s stop command) · `dexterm wallet panic` stops every paper desk now',
  pause: () => 'pause is not wired in this build yet (it ships with the runner\'s stop command)',
  flatten: () => 'flatten is not wired in this build yet (it ships with the runner\'s flatten command) · nothing was sold',
};

/**
 * The running runner's control file (task-1509, @dexterm/autotrade safety.ts): `!` is a soft stop (no new entries,
 * sessions closed, orders dropped, mechanical exits keep running), `p` pauses or resumes new entries, `f` + y
 * flattens. A stop or flatten is final for the run; the runner reads the request on its next tick.
 */
export function fileControl(home: string): RunnerControl {
  const send = (action: ControlAction): string => {
    const r = activeRunner(home);
    if (!r) return 'no autotrade runner is running';
    const w = requestControl(home, r.runId, action, 'tui');
    if (!w.ok) return w.why;
    switch (action) {
      case 'stop': return w.already ? 'stop already requested · mechanical exits keep running until nothing is held' : 'stop requested: no new entries, sessions close, orders dropped · mechanical exits keep running until nothing is held';
      case 'flatten': return w.already ? 'flatten already requested' : 'flatten requested: every paper position sells at its next tick, then the runner stops';
      case 'pause': return 'new entries paused · open positions keep their exits · p again resumes';
      default: return 'new entries resumed';
    }
  };
  return {
    wired: true,
    kill: () => send('stop'),
    pause: () => {
      const r = activeRunner(home);
      const cur = readControl(home);
      const paused = !!r && cur !== null && cur !== 'unreadable' && cur.runId === r.runId && cur.action === 'pause';
      return send(paused ? 'resume-entries' : 'pause');
    },
    flatten: () => send('flatten'),
  };
}

/**
 * A strategy edit proposed in chat (§2a `strategy_propose_edit`), as a card on the list. Applying it is the user's
 * keypress on its review card (`o`, then y; a LOOSER one needs a second y), task-1507 autotrade-proposals.ts.
 */
export interface StrategyProposal {
  proposalId: string;
  id: string;
  beforeHash: string;
  afterHash: string;
  diff: string[];
  validation: { ok: boolean; errors: Issue[] };
  riskDelta: 'tighter' | 'looser' | 'neutral';
  why: string;
}

// ───────────────────────────── the runner rendezvous ─────────────────────────────

export const RUNNER_SCHEMA = 'dexterm-autotrade-runner/1';
/** The runner's rendezvous, `$DEXTERM_HOME/autotrade/runner-status.json` (the runner owns the path; runner.json next to it is
 *  the runner config, §7.3), written atomically every heartbeat; this screen only reads it. */
export { runnerRendezvousPath };

export interface RunnerSnapshot {
  schema: typeof RUNNER_SCHEMA;
  pid: number;
  state: 'running' | 'paused' | 'halted' | 'stopped';
  /** task-1645: real = the paper engine + LIVE TRADE FIRE signals to the user's executor (no key). */
  mode: 'paper' | 'real';
  startedAt: number;
  heartbeatAt: number;
  haltReason: string | null;
  strategy: { id: string; version: string; hash: string };
  book: { startUsd: number; equityUsd: number; cashUsd: number; realizedTodayUsd: number };
  spend: { todayUsd: number; dayCapUsd: number };
  candidates: { mint: string; symbol: string; ageSec: number; matched: string[]; session: string | null }[];
  sessions: { id: string; mint: string; symbol: string; turns: number; costUsd: number; budgetUsd: number; lastDecision: string | null }[];
  positions: { mint: string; symbol: string; profile: string; costUsd: number; pnlUsd: number; pnlPct: number; next: string | null; freeBag?: boolean; confirm?: string }[];
  ledgerTail: { seq: number; t: number; kind: string; text: string }[];
  /** task-1645: real mode only (status, never a control). */
  real?: {
    accountId: string; killed: string | null; outboxDepth: number; lastNonce: number;
    caps: { perTradeSol: number; dailySol: number; buysPerDay: number; maxOpenPositions: number };
    day: { buySol: number; buys: number };
    channels: { name: string; pending: number; failing: number; lastErr: string | null }[];
    positions: { mint: string; symbol: string; state: string; nonce: number }[];
    /** task-1654: the limits in force (absent from card A runners), the risk pauses, the executor's health. */
    limits?: Record<string, number | null>;
    risk?: { dayPnlSol: number; lossStreak: number; pausedUntil: number | null; breaker: { at: number; drawdownSol: number } | null; buyPause: string | null };
    executor?: { alive: boolean | null; windowMin: number | null; silentSec: number | null; lastSeenBy: string | null; heartbeat: { executor: string; dryRun: boolean | null } | null; lastReceipt: { nonce: number; status: string } | null; receiptLagSec: number | null };
  };
}
export type RunnerRead = { kind: 'none'; path: string } | { kind: 'bad'; path: string; error: string } | { kind: 'ok'; path: string; snap: RunnerSnapshot; readAt: number };

export function readRunnerRendezvous(path: string, now = Date.now()): RunnerRead {
  if (!existsSync(path)) return { kind: 'none', path };
  let doc: unknown;
  try { doc = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { return { kind: 'bad', path, error: `not JSON: ${(e as Error).message}` }; }
  const err = runnerShapeError(doc);
  if (err) return { kind: 'bad', path, error: err };
  return { kind: 'ok', path, snap: doc as RunnerSnapshot, readAt: now };
}

function runnerShapeError(d: unknown): string | null {
  if (!d || typeof d !== 'object') return 'not an object';
  const o = d as Record<string, unknown>;
  if (o.schema !== RUNNER_SCHEMA) return `unknown rendezvous shape ${JSON.stringify(o.schema)} (expected ${RUNNER_SCHEMA})`;
  // Paper, or real (task-1645: signals to the user's executor). Anything else is an error, never a running live runner.
  if (o.mode !== 'paper' && o.mode !== 'real') return `mode ${JSON.stringify(o.mode)}: this screen shows paper runners only (and real-mode signal runners)`;
  for (const k of ['pid', 'startedAt', 'heartbeatAt']) if (typeof o[k] !== 'number') return `${k} is not a number`;
  if (!['running', 'paused', 'halted', 'stopped'].includes(o.state as string)) return `unknown state ${JSON.stringify(o.state)}`;
  for (const k of ['candidates', 'sessions', 'positions', 'ledgerTail']) if (!Array.isArray(o[k])) return `${k} is not a list`;
  for (const k of ['strategy', 'book', 'spend']) if (!o[k] || typeof o[k] !== 'object') return `${k} is missing`;
  return null;
}

export function heartbeatStale(r: RunnerRead, now: number): boolean {
  return r.kind === 'ok' && now - r.snap.heartbeatAt > HEARTBEAT_STALE_MS;
}

// ───────────────────────────── state ─────────────────────────────

export interface AutotradeDeps {
  store: StrategyStore;
  jobs: BacktestJobs | null;
  readRunner: () => RunnerRead;
  /** task-1529: the parallel runner's fleet-status.json (each strategy side by side), or null. */
  readFleet?: () => FleetStatus | null;
  control: RunnerControl;
  proposals: () => StrategyProposal[];
  /** task-1507: the pending proposal files behind `proposals` (absent in tests that only show cards). */
  proposalSource?: ReturnType<typeof proposalSource>;
  proposalFiles?: ProposalFiles;
  /** Where `x` writes an exported strategy file. */
  exportDir: string;
  /** task-1647: starts a forward test's host (default: the dexterm entry, detached). */
  forwardSpawn?: ForwardSpawn;
  now: () => number;
}

export interface Field {
  path: string;
  section: Section;
  /** The value's JSON type when the form was built (decides how a typed value is read). */
  kind: 'number' | 'string' | 'boolean' | 'null' | 'json';
}

export interface EditorState {
  id: string;
  source: 'user' | 'preset';
  draft: Strategy;
  /** The stored version the draft started from. */
  baseVersion: string;
  /** Unsaved edits, oldest first; each carries its inverse (custom applyOps), which is what `u` applies. */
  edits: { op: PatchOp; inverse: PatchOp[] }[];
  fields: Field[];
  selected: number;
  check: StrategyCheck;
  /** The value being typed into the selected field (null = not typing) and its live validation. */
  typing: { path: string; text: string; check: StrategyCheck | null; parseError: string | null } | null;
}

export interface JobState<T> { key: string; status: 'running' | 'done' | 'error'; startedAt: number; doneAt?: number; result?: T; error?: string }

export interface AutotradeUi {
  view: AutotradeView;
  deps: AutotradeDeps;
  entries: ListEntry[];
  selected: number;
  /** Strategies marked for compare (`c` marks; the second mark opens the view). */
  marked: string[];
  notice: string | null;
  /** A one-line input on the list (a new strategy id, or a file to import). */
  input: { kind: 'new' | 'dup' | 'import'; text: string; from?: string } | null;
  editor: EditorState | null;
  compare: { a: string; b: string; scroll: number } | null;
  /** The strategy the backtest view shows. */
  focusId: string | null;
  backtests: Map<string, JobState<BacktestOutcome>>;
  compareRun: JobState<BacktestOutcome[]> | null;
  sweep: JobState<SweepResult> & { id: string; grid: Grid } | null;
  runner: RunnerRead;
  /** task-1529: set while the runner is a `run --all` (its run id is the fleet's). */
  fleet: FleetStatus | null;
  runnerReadAt: number;
  /** The flatten confirm card (`f`, then y); task-1647: the always-on promotion card (`A` on the journey, then y). */
  confirm: { kind: 'flatten' } | { kind: 'promote'; proposalId: string } | null;
  /** task-1507: the chat proposal's review card (`o`; y applies, a LOOSER one needs a second y). */
  review: ProposalReview | null;
  /** task-1647: the journey view's strategy and what it last read. */
  journey: JourneyPanel | null;
}

export function defaultDeps(env: NodeJS.ProcessEnv = process.env, jobs: BacktestJobs | null = null): AutotradeDeps {
  const home = dextermHome(env);
  const proposalFiles = proposalFilesFor(env);
  const source = proposalSource(proposalFiles);
  return {
    store: new StrategyStore({ env }),
    jobs,
    readRunner: () => readRunnerRendezvous(runnerRendezvousPath(home)),
    readFleet: () => { const r = readFleetStatus(home); return r.ok ? r.status : null; },
    control: fileControl(home),
    proposals: source.cards,
    proposalSource: source,
    proposalFiles,
    exportDir: join(home, 'exports'),
    now: Date.now,
  };
}

export function newAutotradeUi(deps: AutotradeDeps): AutotradeUi {
  const ui: AutotradeUi = {
    view: 'list', deps, entries: [], selected: 0, marked: [], notice: null, input: null, editor: null, compare: null,
    focusId: null, backtests: new Map(), compareRun: null, sweep: null, runner: { kind: 'none', path: '' }, fleet: null, runnerReadAt: 0, confirm: null, review: null, journey: null,
  };
  reloadList(ui);
  refreshRunner(ui);
  return ui;
}

export function reloadList(ui: AutotradeUi): void {
  try { ui.entries = ui.deps.store.list(); } catch (e) { ui.entries = []; ui.notice = `strategies unreadable: ${(e as Error).message}`; }
  ui.selected = Math.max(0, Math.min(ui.entries.length - 1, ui.selected));
}

export function refreshRunner(ui: AutotradeUi): void {
  ui.runner = ui.deps.readRunner();
  const f = ui.runner.kind === 'ok' ? ui.deps.readFleet?.() ?? null : null;
  // Only the fleet the rendezvous names: a fleet-status.json left by an earlier parallel run is never shown as this one.
  ui.fleet = f && ui.runner.kind === 'ok' && f.fleetId === (ui.runner.snap as { runId?: string }).runId ? f : null;
  ui.runnerReadAt = ui.deps.now();
}

/** The loop's 2 Hz tick: re-read the rendezvous every 2 s while the runner (or list, for its marker) is on screen. */
export function autotradeTick(ui: AutotradeUi): void {
  if (ui.deps.now() - ui.runnerReadAt >= 2000) refreshRunner(ui);
}

export const selectedEntry = (ui: AutotradeUi): ListEntry | undefined => ui.entries[ui.selected];

/** Whether the screen is capturing typed keys (an input line, a field value, or the flatten confirm). */
export function autotradeCapturing(ui: AutotradeUi): boolean {
  return ui.input !== null || ui.confirm !== null || ui.review !== null || (ui.view === 'editor' && !!ui.editor?.typing);
}

// ───────────────────────────── the form ─────────────────────────────

/** Every editable leaf of the six sections, in document order. Empty lists/objects and nulls are leaves typed as JSON. */
export function fieldsOf(doc: Strategy): Field[] {
  const out: Field[] = [];
  const walk = (v: unknown, path: string, section: Section): void => {
    if (v !== null && typeof v === 'object') {
      const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x] as const) : Object.entries(v as Record<string, unknown>);
      if (!entries.length) { out.push({ path, section, kind: 'json' }); return; }
      for (const [k, x] of entries) walk(x, `${path}/${k}`, section);
      return;
    }
    out.push({ path, section, kind: v === null ? 'null' : typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'string' });
  };
  for (const s of SECTIONS) walk((doc as unknown as Record<string, unknown>)[s], `/${s}`, s);
  return out;
}

export function getAt(doc: unknown, path: string): unknown {
  let o: unknown = doc;
  for (const seg of path.split('/').slice(1)) {
    if (o === null || typeof o !== 'object') return undefined;
    o = (o as Record<string, unknown>)[seg.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return o;
}

/** Fields only the user may change by hand in a file, never on this screen (no path to live mode from the TUI). */
export const READ_ONLY_PATHS: ReadonlySet<string> = new Set(['/mode', '/id', '/schema', '/kind']);

/** A typed value: strings stay verbatim (the screen filter, model ids, builtin refs), everything else is JSON. */
export function parseFieldInput(text: string, kind: Field['kind']): { ok: true; value: unknown } | { ok: false; error: string } {
  if (kind === 'string') return { ok: true, value: text };
  const t = text.trim();
  if (!t) return { ok: false, error: 'type a value (JSON: a number, true/false, null, a list or an object)' };
  try { return { ok: true, value: JSON.parse(t) }; } catch { return { ok: false, error: `not a JSON value: ${t.slice(0, 40)}` }; }
}

export function openEditor(ui: AutotradeUi, id: string): string | null {
  const got = ui.deps.store.get(id);
  const raw = ui.deps.store.raw(id);
  if (!got || !raw) return `no strategy ${id}`;
  const check = validateStrategy(raw);
  ui.editor = { id, source: got.source, draft: raw, baseVersion: raw.version, edits: [], fields: fieldsOf(raw), selected: 0, check, typing: null };
  ui.view = 'editor';
  return got.source === 'preset' ? `${id} is a shipped preset (read-only): edits here are a draft · d on the list makes your own copy` : null;
}

/** Issues pinned to the first field at or under their path; the rest (whole-document ones) go to `loose`. */
export function issuesByField(fields: readonly Field[], issues: readonly Issue[]): { at: Map<string, Issue[]>; loose: Issue[] } {
  const at = new Map<string, Issue[]>();
  const loose: Issue[] = [];
  for (const i of issues) {
    const f = fields.find((x) => x.path === i.path || x.path.startsWith(`${i.path}/`));
    if (!f || !i.path) { loose.push(i); continue; }
    at.set(f.path, [...(at.get(f.path) ?? []), i]);
  }
  return { at, loose };
}

export function beginFieldEdit(ui: AutotradeUi): string | null {
  const ed = ui.editor;
  if (!ed) return null;
  const f = ed.fields[ed.selected];
  if (!f) return null;
  if (READ_ONLY_PATHS.has(f.path)) return `${f.path} cannot be changed here`;
  const cur = getAt(ed.draft, f.path);
  // booleans flip in place (one keypress, re-validated like any edit)
  if (f.kind === 'boolean') return commitField(ui, f.path, !cur);
  const text = f.kind === 'string' ? String(cur ?? '') : JSON.stringify(cur);
  ed.typing = { path: f.path, text, check: null, parseError: null };
  revalidateTyping(ui);
  return null;
}

/** Re-validate the draft with the value being typed (every keystroke). */
export function revalidateTyping(ui: AutotradeUi): void {
  const ed = ui.editor;
  if (!ed?.typing) return;
  const f = ed.fields.find((x) => x.path === ed.typing!.path);
  const p = parseFieldInput(ed.typing.text, f?.kind ?? 'json');
  if (!p.ok) { ed.typing.parseError = p.error; ed.typing.check = null; return; }
  ed.typing.parseError = null;
  try { ed.typing.check = validateStrategy(applyOps(ed.draft, [{ op: 'replace', path: ed.typing.path, value: p.value }]).doc); }
  catch (e) { ed.typing.parseError = (e as Error).message; ed.typing.check = null; }
}

export function commitTyping(ui: AutotradeUi): string | null {
  const ed = ui.editor;
  if (!ed?.typing) return null;
  const { path, text } = ed.typing;
  const f = ed.fields.find((x) => x.path === path);
  const p = parseFieldInput(text, f?.kind ?? 'json');
  if (!p.ok) return p.error;
  ed.typing = null;
  return commitField(ui, path, p.value);
}

function commitField(ui: AutotradeUi, path: string, value: unknown): string | null {
  const ed = ui.editor!;
  if (READ_ONLY_PATHS.has(path)) return `${path} cannot be changed here`;
  if (JSON.stringify(getAt(ed.draft, path)) === JSON.stringify(value)) return 'unchanged';
  const op: PatchOp = { op: 'replace', path, value };
  let next: { doc: Strategy; inverse: PatchOp[] };
  try { next = applyOps(ed.draft, [op]); } catch (e) { return (e as Error).message; }
  ed.draft = next.doc;
  ed.edits.push({ op, inverse: next.inverse });
  rebuildForm(ed, path);
  return ed.check.ok ? null : `✗ ${ed.check.errors.length} problem${ed.check.errors.length === 1 ? '' : 's'} (fix before saving)`;
}

function rebuildForm(ed: EditorState, keepPath?: string): void {
  ed.check = validateStrategy(ed.draft);
  ed.fields = fieldsOf(ed.draft);
  if (keepPath) { const i = ed.fields.findIndex((x) => x.path === keepPath || x.path.startsWith(`${keepPath}/`)); if (i >= 0) ed.selected = i; }
  ed.selected = Math.max(0, Math.min(ed.fields.length - 1, ed.selected));
}

/** The unsaved edits as the fewest ops: the last value per path, in first-touched order. */
export function pendingOps(ed: EditorState): PatchOp[] {
  const last = new Map<string, PatchOp>();
  for (const e of ed.edits) { last.delete(e.op.path); last.set(e.op.path, e.op); }
  return [...last.values()];
}

/** `s`: only a valid draft is written, as a new version; the journal line carries the ops and their inverse. */
export function saveEditor(ui: AutotradeUi): string {
  const ed = ui.editor;
  if (!ed) return 'nothing to save';
  if (ed.source === 'preset') return `${ed.id} is a shipped preset (read-only) · press d on the list to make your own copy, then edit that`;
  if (!ed.edits.length) return 'nothing to save (no changes)';
  if (!ed.check.ok) return `not saved: ${ed.check.errors.length} problem${ed.check.errors.length === 1 ? '' : 's'} · first: ${fmtIssue(ed.check.errors[0])}`;
  const ops = pendingOps(ed);
  const store = ui.deps.store;
  const r = ops.length <= MAX_OPS
    ? store.patch(ed.id, ops, { actor: TUI_ACTOR, why: 'edited on the Q screen' })
    : store.update(ed.id, { ...ed.draft, version: bumpPatch(ed.baseVersion) }, { actor: TUI_ACTOR, why: 'edited on the Q screen' });
  if (!r.ok) return `not saved: ${fmtIssue(r.errors[0])}`;
  const raw = store.raw(ed.id)!;
  ui.editor = { ...ed, draft: raw, baseVersion: raw.version, edits: [], fields: fieldsOf(raw), check: validateStrategy(raw), typing: null };
  reloadList(ui);
  return `saved ${ed.id} v${r.strategy.version} (${r.strategy.hash}) · ${ops.length} change${ops.length === 1 ? '' : 's'} journaled`;
}

/**
 * `u`: undo the newest unsaved edit with its inverse; with nothing unsaved, undo the last saved patch of this
 * strategy by applying that journal line's inverse as a new version (refused when the file changed since).
 */
export function undoEditor(ui: AutotradeUi): string {
  const ed = ui.editor;
  if (!ed) return 'nothing to undo';
  const last = ed.edits.pop();
  if (last) {
    try { ed.draft = applyOps(ed.draft, last.inverse).doc; } catch (e) { ed.edits.push(last); return `undo failed: ${(e as Error).message}`; }
    rebuildForm(ed, last.op.path);
    return `undid ${last.op.path}`;
  }
  if (ed.source === 'preset') return 'nothing to undo';
  const store = ui.deps.store;
  const j = store.journal(ed.id).filter((x) => x.action !== 'remove');
  const top = j[j.length - 1];
  if (!top || top.action !== 'patch' || !top.inverse?.length) return 'nothing to undo (the last saved change was not a field edit)';
  const cur = store.get(ed.id);
  if (!cur?.ok || cur.strategy.hash !== top.afterHash) return 'undo refused: the file changed since the last saved edit';
  const inverse = top.inverse.filter((x) => x.path !== '/version');
  const r = store.patch(ed.id, inverse, { actor: TUI_ACTOR, why: `undo of v${top.version}` });
  if (!r.ok) return `undo refused: ${fmtIssue(r.errors[0])}`;
  const raw = store.raw(ed.id)!;
  ui.editor = { ...ed, draft: raw, baseVersion: raw.version, edits: [], fields: fieldsOf(raw), check: validateStrategy(raw), typing: null };
  reloadList(ui);
  return `undid v${top.version} → saved as v${r.strategy.version} (${r.strategy.hash})`;
}

/** The screen filter split for highlighting: the screener's tokens with their columns, and the parser's error column. */
export function screenHighlight(src: string): { error: string | null; at: number | null } {
  const r = parseFilter(src);
  return r.ok ? { error: null, at: null } : { error: r.error, at: r.at };
}

// ───────────────────────────── list verbs ─────────────────────────────

export function beginNew(ui: AutotradeUi, dup: boolean): string | null {
  const e = selectedEntry(ui);
  if (!e) return 'no strategy selected';
  if (!dup && e.source !== 'preset') return 'n starts from a preset: select one (or d to duplicate this one)';
  ui.input = { kind: dup ? 'dup' : 'new', text: `${e.id}-copy`.slice(0, 32), from: e.id };
  return null;
}

export function beginImport(ui: AutotradeUi): void { ui.input = { kind: 'import', text: '' }; }

export function commitInput(ui: AutotradeUi): string {
  const inp = ui.input;
  if (!inp) return '';
  ui.input = null;
  const store = ui.deps.store;
  if (inp.kind === 'import') return importFile(ui, inp.text.trim());
  const id = inp.text.trim();
  if (!STRATEGY_ID.test(id)) return `bad id ${JSON.stringify(id)} (lowercase letters, digits and dashes, 2-32 chars)`;
  const r = store.createFrom(inp.from!, id, { actor: TUI_ACTOR, why: `${inp.kind === 'dup' ? 'duplicated' : 'new from preset'} ${inp.from} on the Q screen` });
  if (!r.ok) return `not created: ${fmtIssue(r.errors[0])}`;
  reloadList(ui);
  ui.selected = Math.max(0, ui.entries.findIndex((x) => x.id === id && x.source === 'user'));
  return `created ${id} v${r.strategy.version} from ${inp.from} · e to edit`;
}

/** `i`: a strategy file into the store. Always paper, whatever the file says (§2c); validated; an existing id is refused. */
export function importFile(ui: AutotradeUi, file: string): string {
  if (!file) return 'no file';
  let doc: Record<string, unknown>;
  try { doc = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>; } catch (e) { return `not imported: ${(e as Error).message}`; }
  if (!doc || typeof doc !== 'object') return 'not imported: not a strategy document';
  const forced = doc.mode !== 'paper';
  doc = { ...doc, mode: 'paper' };
  const r = ui.deps.store.create(doc, { actor: 'import', why: `import ${file} on the Q screen` });
  if (!r.ok) return `not imported: ${fmtIssue(r.errors[0])}`;
  reloadList(ui);
  return `imported ${r.strategy.id} v${r.strategy.version}${forced ? ' · mode forced to paper' : ''}`;
}

/** `x`: the strategy document as a shareable file (paper; never a key, a wallet or a mandate: the schema has none). */
export function exportSelected(ui: AutotradeUi): string {
  const e = selectedEntry(ui);
  if (!e) return 'no strategy selected';
  const raw = ui.deps.store.raw(e.id);
  if (!raw) return `${e.id} is not readable`;
  mkdirSync(ui.deps.exportDir, { recursive: true, mode: 0o700 });
  const path = join(ui.deps.exportDir, `strategy-${raw.id}-v${raw.version}.json`);
  writeFileSync(path, JSON.stringify({ ...raw, mode: 'paper' }, null, 2) + '\n', { mode: 0o600 });
  return `exported ${raw.id} v${raw.version} → ${path}`;
}

export function toggleMark(ui: AutotradeUi): string | null {
  const e = selectedEntry(ui);
  if (!e) return 'no strategy selected';
  const key = e.id;
  ui.marked = ui.marked.includes(key) ? ui.marked.filter((x) => x !== key) : [...ui.marked, key].slice(-2);
  if (ui.marked.length === 2) {
    ui.compare = { a: ui.marked[0], b: ui.marked[1], scroll: 0 };
    ui.marked = [];
    ui.view = 'compare';
    return null;
  }
  return ui.marked.length ? `marked ${key} · c on a second strategy compares them` : `unmarked ${key}`;
}

// ───────────────────────────── compare ─────────────────────────────

export interface CompareRow { path: string; a: string; b: string; changed: boolean }

/** Every leaf of both documents (union, a's order first); `changed` when the JSON differs. */
export function compareRows(a: unknown, b: unknown): CompareRow[] {
  const leaves = (doc: unknown): Map<string, string> => {
    const m = new Map<string, string>();
    const walk = (v: unknown, path: string): void => {
      if (v !== null && typeof v === 'object') {
        const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x] as const) : Object.entries(v as Record<string, unknown>);
        if (!entries.length) { m.set(path, JSON.stringify(v)); return; }
        for (const [k, x] of entries) walk(x, `${path}/${k}`);
        return;
      }
      m.set(path || '/', typeof v === 'string' ? v : JSON.stringify(v));
    };
    walk(doc, '');
    return m;
  };
  const la = leaves(a), lb = leaves(b);
  const paths = [...la.keys(), ...[...lb.keys()].filter((k) => !la.has(k))];
  return paths.map((p) => ({ path: p, a: la.get(p) ?? '—', b: lb.get(p) ?? '—', changed: la.get(p) !== lb.get(p) }));
}

// ───────────────────────────── backtests ─────────────────────────────

function resolved(ui: AutotradeUi, id: string): ResolvedStrategy | string {
  const g = ui.deps.store.get(id);
  if (!g) return `no strategy ${id}`;
  if (!g.ok) return `${id} is invalid: ${fmtIssue(g.errors[0])}`;
  if (g.strategy.mode !== 'paper') return `${id} is mode "${g.strategy.mode}": autotrade runs paper only`;
  return g.strategy;
}

const errText = (e: unknown): string => ((e as Error)?.message ?? String(e)).split('\n')[0].slice(0, 200);

/** `b`: backtest the selected (or focused) strategy on recorded history, off the render loop. */
export function startBacktest(ui: AutotradeUi, id: string): string {
  const s = resolved(ui, id);
  if (typeof s === 'string') return s;
  ui.focusId = id;
  ui.view = 'backtest';
  if (!ui.deps.jobs) return 'backtests need the recorder history (not available in this mode)';
  const cur = ui.backtests.get(s.hash);
  if (cur?.status === 'running') return 'a backtest of this version is already running';
  const job: JobState<BacktestOutcome> = { key: s.hash, status: 'running', startedAt: ui.deps.now() };
  ui.backtests.set(s.hash, job);
  const until = ui.deps.now();
  void ui.deps.jobs.backtest([s], { days: BACKTEST_DAYS, until }).then(([out]) => {
    job.status = 'done'; job.result = out; job.doneAt = ui.deps.now();
    recordLine(ui, s, out.report);
    // task-1647: the held-out split of a stored strategy is its journey evidence
    if (out.evidence && ui.deps.store.get(s.id)?.ok) { try { recordBacktestEvidence(dirname(ui.deps.store.dir), out.evidence); } catch { /* evidence is best effort here */ } }
  }, (e) => { job.status = 'error'; job.error = errText(e); job.doneAt = ui.deps.now(); });
  return `backtesting ${s.id} v${s.version} on the last ${BACKTEST_DAYS} days of recorded history…`;
}

function recordLine(ui: AutotradeUi, s: ResolvedStrategy, r: BacktestReport): void {
  try {
    ui.deps.store.recordBacktest({ hash: s.hash, t: ui.deps.now(), trades: r.trades, netUsd: r.netUsd, netPct: r.netPct, maxDrawdownPct: r.maxDrawdownPct, tape: `${r.tape.mints} coins ${r.tape.from ?? ''}..${r.tape.to ?? ''}` });
    reloadList(ui);
  } catch { /* the line is a convenience for the list; never fail a backtest on it */ }
}

/** `b` on compare: both strategies on the SAME tape window. */
export function startCompareBacktest(ui: AutotradeUi): string {
  if (!ui.compare) return 'nothing to compare';
  const a = resolved(ui, ui.compare.a), b = resolved(ui, ui.compare.b);
  if (typeof a === 'string') return a;
  if (typeof b === 'string') return b;
  if (!ui.deps.jobs) return 'backtests need the recorder history (not available in this mode)';
  if (ui.compareRun?.status === 'running') return 'already running';
  const job: JobState<BacktestOutcome[]> = { key: `${a.hash}|${b.hash}`, status: 'running', startedAt: ui.deps.now() };
  ui.compareRun = job;
  void ui.deps.jobs.backtest([a, b], { days: BACKTEST_DAYS, until: ui.deps.now() }).then((outs) => {
    job.status = 'done'; job.result = outs; job.doneAt = ui.deps.now();
    recordLine(ui, a, outs[0].report); recordLine(ui, b, outs[1].report);
  }, (e) => { job.status = 'error'; job.error = errText(e); job.doneAt = ui.deps.now(); });
  return `backtesting ${a.id} and ${b.id} on one tape (last ${BACKTEST_DAYS} days)…`;
}

const r2 = (x: number): number => Math.round(x * 100) / 100;
const around = (x: number, lo: number, hi: number): number[] => [...new Set([x * 0.67, x, x * 1.5].map((v) => Math.max(lo, Math.min(hi, Math.abs(v) >= 5 ? Math.round(v) : r2(v)))))];

/**
 * The sweep grid for a strategy's default exit profile (§3 skill-care method): cost-back level × bag trail for a
 * moonbag profile, else the trail and the first take-profit, else the size. Three values each, around the current.
 */
export function defaultGrid(s: ResolvedStrategy): Grid {
  const p = s.exits.profiles[s.exits.default];
  const g: Grid = {};
  if (p.costRecovery) {
    g['profile.costRecovery.atPct'] = around(p.costRecovery.atPct, 10, 10000);
    if (p.bagTrail) g['profile.bagTrail.trailPct'] = around(p.bagTrail.trailPct, 10, 90);
  } else {
    if (p.trailingStop) g['profile.trailingStop.trailPct'] = around(p.trailingStop.trailPct, 5, 60);
    if (p.tpLadder.length) g['profile.tpLadder.0.atPct'] = around(p.tpLadder[0].atPct, 0.1, 10000);
  }
  if (!Object.keys(g).length) {
    if (s.sizing.mode === 'pct' && s.sizing.pct) g['sizing.pct'] = around(s.sizing.pct, 0.1, 25);
    else g['risk.maxConcurrent'] = [...new Set([Math.max(1, s.risk.maxConcurrent - 1), s.risk.maxConcurrent, Math.min(20, s.risk.maxConcurrent + 1)])];
  }
  return g;
}

/** `w`: a held-out sweep (newest 30% of coins never tuned on; the verdict needs >= 20 trades both sides and a positive held-out net). */
export function startSweep(ui: AutotradeUi, id: string): string {
  const s = resolved(ui, id);
  if (typeof s === 'string') return s;
  ui.focusId = id;
  ui.view = 'backtest';
  if (!ui.deps.jobs) return 'sweeps need the recorder history (not available in this mode)';
  if (ui.sweep?.status === 'running') return 'a sweep is already running';
  const grid = defaultGrid(s);
  const job = { key: s.hash, id: s.id, grid, status: 'running' as const, startedAt: ui.deps.now() } as NonNullable<AutotradeUi['sweep']>;
  ui.sweep = job;
  void ui.deps.jobs.sweep(s, grid, { days: BACKTEST_DAYS, until: ui.deps.now() }).then((res) => {
    job.status = 'done'; job.result = res; job.doneAt = ui.deps.now();
  }, (e) => { job.status = 'error'; job.error = errText(e); job.doneAt = ui.deps.now(); });
  return `sweeping ${s.id} over ${Object.keys(grid).join(' × ')} with a held-out split…`;
}

/** The strategy the backtest view is about: the focused one, else the list selection. */
export function backtestSubject(ui: AutotradeUi): { id: string; hash: string | null } | null {
  const id = ui.focusId ?? selectedEntry(ui)?.id ?? null;
  if (!id) return null;
  const e = ui.entries.find((x) => x.id === id);
  return { id, hash: e?.hash ?? null };
}

// ───────────────────────────── runner verbs ─────────────────────────────

export function runnerVerb(ui: AutotradeUi, verb: 'kill' | 'pause' | 'flatten'): string {
  if (ui.runner.kind !== 'ok') return 'no autotrade runner is running';
  if (verb === 'flatten') { ui.confirm = { kind: 'flatten' }; return 'flatten: sell every paper position at the next tick? y to confirm, any other key cancels'; }
  return verb === 'kill' ? ui.deps.control.kill() : ui.deps.control.pause();
}

export function confirmKey(ui: AutotradeUi, yes: boolean): string {
  const c = ui.confirm;
  ui.confirm = null;
  if (!c) return '';
  if (c.kind === 'promote') return confirmPromote(ui, c.proposalId, yes);
  return yes ? ui.deps.control.flatten() : 'flatten cancelled';
}

/** The views tab cycles through (compare only once two strategies were marked). */
export function nextView(ui: AutotradeUi): void {
  const order = AUTOTRADE_VIEWS.filter((v) => (v !== 'compare' || ui.compare) && (v !== 'editor' || ui.editor));
  ui.view = order[(order.indexOf(ui.view) + 1) % order.length] ?? 'list';
}
