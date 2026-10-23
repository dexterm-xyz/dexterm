// dexterm autotrade — safety: stop, flatten, pause, the kill switch every step, the dead-man, the run audit and the
// session isolation proof (task-1509 AT-7, AUTOTRADE-SPEC §6.3, §6.4). PAPER ONLY.
//
// Control file: $DEXTERM_HOME/autotrade/control.json (`dexterm-autotrade-control/1`) carries ONE request for ONE run
// (its runId): stop (soft: no new entries, every session closed, orders dropped, mechanical exits keep running),
// flatten (a stop, then every position sold at its next tick), pause / resume-entries (new entries only). The CLI
// (`dexterm autotrade stop|flatten`) and the Q screen (`!`, `f` + y, `p`) write it; the runner re-reads it on every
// step (a stat, then a parse when it changed). A request for another run never touches this one. A file that cannot
// be read counts as a stop (fail closed), like the panic file. A stop or flatten is final for the run: a later
// request can escalate a stop to a flatten but never lift it, and nothing here lifts the panic file.
//
// RunnerSafety.step() is what the runner calls every step. It folds in:
//   - the panic file (`dexterm wallet panic`, KillSwitch), re-read every step; the halt is sticky for the run, and
//     a new run refuses to start while it is engaged (resume is `dexterm wallet resume`, a keypress on a real TTY);
//   - the control file;
//   - the dead-man for entries: no new entries while the runner's own heartbeat cannot be written (the TUI and the
//     monitor would see it as dead), or while the position monitor is down when it runs the exits (desk executor).
//     Those lift by themselves; mechanical exits never wait on any of them.
//
// Audit: auditRun() recomputes the hash chain of runs/<runId>.jsonl (verifyChain) and checks it against the run's
// summary (written on every heartbeat with the head at that moment), so lines cut from the END of a ledger, which a
// chain alone cannot see, show up as missing events.
//
// Isolation: sessionIsolation() reads a session's stream-json init event: tools and MCP servers must be 0 (the
// session is ended otherwise, sessions.ts); plugins, agents, skills and slash commands are counted for the ledger.
// The user's plugins and agents still list as loaded with these flags; with no tools they cannot act (§4).
//
// Nothing here holds a key, touches a wallet, the signer or the network, and no model can reach any of it: sessions
// have no tools, and only a keypress or a command the user runs writes the control file.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { GENESIS, RUN_SUMMARY_SCHEMA, readLedgerFile, runFiles, runsDir, verifyChain, writeJsonAtomic } from './ledger.ts';
import { runLockPath, runnerRendezvousPath, type RunLock } from './runner.ts';

export const CONTROL_SCHEMA = 'dexterm-autotrade-control/1';
export type ControlAction = 'stop' | 'flatten' | 'pause' | 'resume-entries';
const ACTIONS: readonly ControlAction[] = ['stop', 'flatten', 'pause', 'resume-entries'];
export interface ControlRequest { schema: typeof CONTROL_SCHEMA; runId: string; action: ControlAction; at: number; by: ControlBy }
/** Who wrote a request: the command line, the Q screen, or a paired chat (task-1527: chat writes the same file). */
export type ControlBy = 'cli' | 'tui' | 'chat';

export const controlPath = (home: string): string => join(home, 'autotrade', 'control.json');

/** The request in the control file, `unreadable` when it exists but cannot be parsed, or null when there is none. */
export function readControl(home: string): ControlRequest | 'unreadable' | null {
  const p = controlPath(home);
  if (!existsSync(p)) return null;
  try {
    const d = JSON.parse(readFileSync(p, 'utf8')) as Partial<ControlRequest>;
    if (d.schema !== CONTROL_SCHEMA || typeof d.runId !== 'string' || !ACTIONS.includes(d.action as ControlAction) || typeof d.at !== 'number') return 'unreadable';
    return { schema: CONTROL_SCHEMA, runId: d.runId, action: d.action as ControlAction, at: d.at, by: d.by === 'tui' || d.by === 'chat' ? d.by : 'cli' };
  } catch { return 'unreadable'; }
}

const FINAL: readonly ControlAction[] = ['stop', 'flatten'];

export type ControlWrite = { ok: true; request: ControlRequest; already: boolean } | { ok: false; why: string; current: ControlRequest };

/**
 * Write a request for a run. A stop or flatten already on file for the same run is never lifted: pause and
 * resume-entries are refused, a second stop is a no-op, and only stop → flatten escalates.
 */
export function requestControl(home: string, runId: string, action: ControlAction, by: ControlBy, now = Date.now()): ControlWrite {
  const cur = readControl(home);
  if (cur && cur !== 'unreadable' && cur.runId === runId && FINAL.includes(cur.action)) {
    if (cur.action === action || (cur.action === 'flatten' && action === 'stop')) return { ok: true, request: cur, already: true };
    if (action !== 'flatten') return { ok: false, why: `the runner is already ${cur.action === 'stop' ? 'stopping' : 'flattening'}; only a flatten can follow a stop`, current: cur };
  }
  const request: ControlRequest = { schema: CONTROL_SCHEMA, runId, action, at: now, by };
  mkdirSync(join(home, 'autotrade'), { recursive: true, mode: 0o700 });
  writeJsonAtomic(controlPath(home), request);
  return { ok: true, request, already: false };
}

/**
 * At a runner's start: a request left for an older run is removed (it can never apply to this one). Returns false
 * when the file cannot be read: the new run must refuse to start until the user looks at it (fail closed).
 */
export function clearStaleControl(home: string, runId: string): boolean {
  const cur = readControl(home);
  if (cur === 'unreadable') return false;
  if (cur && cur.runId !== runId) rmSync(controlPath(home), { force: true });
  return true;
}

/** At a runner's end: remove its own request (a later run never sees it). */
export function clearControl(home: string, runId: string): void {
  const cur = readControl(home);
  if (cur && cur !== 'unreadable' && cur.runId === runId) rmSync(controlPath(home), { force: true });
}

// ───────────────────────────── the per-step verdict ─────────────────────────────

export interface SafetyVerdict {
  /** Why this run takes no new entries and closes every session, for good (kill-switch, stop, flatten, control-unreadable), or null. */
  halt: string | null;
  /** A plain-language detail for the ledger (the panic reason, who asked). */
  detail?: string;
  /** Sell every position at its next tick. */
  flatten: boolean;
  /** No new candidates while set (pause, or the entry dead-man); lifts by itself. */
  pauseEntries: string | null;
  /** End the run once nothing is held and no order is pending (a stop or flatten request). */
  endWhenFlat: boolean;
}

export const HEARTBEAT_STALE_MS = 30_000;

export interface RunnerSafetyOpts {
  home: string;
  runId: string;
  /** The panic file (`dexterm wallet panic`); re-read every step. */
  killSwitch?: { engaged(): { reason: string } | null };
  /** Entries need the position monitor up (an executor whose exits run in the monitor process). Default: not needed. */
  monitorAlive?: () => boolean;
  /** Ms since the runner's own heartbeat (rendezvous) was last written OK. Default: always fresh. */
  heartbeatAgeMs?: () => number;
  staleMs?: number;
}

export class RunnerSafety {
  private haltWhy: string | null = null;
  private haltDetail = '';
  private flattening = false;
  /** A stop or flatten was asked for (also after a panic halt): the run ends once nothing is held. */
  private stopAsked = false;
  private sig = '';
  private ctl: ControlRequest | 'unreadable' | null = null;
  private readonly o: RunnerSafetyOpts;
  constructor(o: RunnerSafetyOpts) { this.o = o; }

  /** The control request, re-parsed only when the file changed (a stat per step). */
  private control(): ControlRequest | 'unreadable' | null {
    const p = controlPath(this.o.home);
    let sig = '';
    try { const st = statSync(p); sig = `${st.mtimeMs}:${st.size}:${st.ino}`; } catch { sig = ''; }
    if (sig !== this.sig) { this.sig = sig; this.ctl = sig ? readControl(this.o.home) : null; }
    return this.ctl;
  }

  step(): SafetyVerdict {
    const halt = (why: string, detail: string) => { if (!this.haltWhy) { this.haltWhy = why; this.haltDetail = detail; } };
    const panic = this.o.killSwitch?.engaged() ?? null;
    if (panic) halt('kill-switch', `panic file: ${panic.reason}`);
    const c = this.control();
    let pause: string | null = null;
    if (c === 'unreadable') { halt('control-unreadable', 'the control file cannot be read (treated as a stop)'); this.stopAsked = true; }
    else if (c && c.runId === this.o.runId) {
      if (c.action === 'stop' || c.action === 'flatten') {
        halt(c.action, `requested from the ${c.by === 'tui' ? 'Q screen' : c.by === 'chat' ? 'paired chat' : 'command line'}`);
        this.stopAsked = true;
        if (c.action === 'flatten') this.flattening = true;
      } else if (c.action === 'pause') pause = 'paused';
    }
    if (!pause && (this.o.heartbeatAgeMs?.() ?? 0) > (this.o.staleMs ?? HEARTBEAT_STALE_MS)) pause = 'heartbeat-stale';
    if (!pause && this.o.monitorAlive && !this.o.monitorAlive()) pause = 'monitor-heartbeat-stale';
    return { halt: this.haltWhy, ...(this.haltWhy ? { detail: this.haltDetail } : {}), flatten: this.flattening, pauseEntries: pause, endWhenFlat: this.stopAsked };
  }
}

// ───────────────────────────── the active runner ─────────────────────────────

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };

export interface ActiveRunner { runId: string; pid: number; startedAt: number; state: string | null; haltReason: string | null; heartbeatAt: number | null; positions: number; sessions: number }

/** The runner holding run.lock with a live pid (and what its rendezvous says), or null. */
export function activeRunner(home: string): ActiveRunner | null {
  let lock: RunLock;
  try { lock = JSON.parse(readFileSync(runLockPath(home), 'utf8')) as RunLock; } catch { return null; }
  if (typeof lock.pid !== 'number' || typeof lock.runId !== 'string' || !alive(lock.pid)) return null;
  const r = readRendezvousLoose(home);
  const same = r && r.runId === lock.runId;
  return {
    runId: lock.runId, pid: lock.pid, startedAt: lock.startedAt,
    state: same && typeof r.state === 'string' ? r.state : null,
    haltReason: same && typeof r.haltReason === 'string' ? r.haltReason : null,
    heartbeatAt: same && typeof r.heartbeatAt === 'number' ? r.heartbeatAt : null,
    positions: same && Array.isArray(r.positions) ? r.positions.length : 0,
    sessions: same && Array.isArray(r.sessions) ? r.sessions.length : 0,
  };
}

function readRendezvousLoose(home: string): Record<string, unknown> | null {
  try { return JSON.parse(readFileSync(runnerRendezvousPath(home), 'utf8')) as Record<string, unknown>; } catch { return null; }
}

// ───────────────────────────── audit ─────────────────────────────

export interface RunAudit {
  runId: string;
  ledger: string;
  events: number;
  ok: boolean;
  head: string | null;
  /** The first broken event (1-based) and why. */
  brokenAt?: number;
  error?: string;
  /** A run_end line closes the ledger (no run_end: still running, crashed, or lines were cut from the end). */
  ended: boolean;
  running: boolean;
  /** The summary's view: its event count and head match the chain at that event (null: no summary). */
  summary: { events: number; head: string; matches: boolean } | null;
  strategy: { id: string; version: string; hash: string } | null;
}

/** Run ids with a ledger under runs/, oldest first (ids sort by start time). */
export function listRunIds(home: string): string[] {
  const dir = runsDir(home);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.jsonl') && !f.endsWith('.stream.jsonl')).map((f) => f.slice(0, -'.jsonl'.length)).filter((id) => { try { runFiles(home, id); return true; } catch { return false; } }).sort();
}

/** Recompute one run's chain and check it against its summary. */
export function auditRun(home: string, runId: string): RunAudit {
  const files = runFiles(home, runId);
  const active = activeRunner(home);
  const running = active?.runId === runId;
  const base = { runId, ledger: files.ledger, running };
  let events: Record<string, unknown>[];
  try { events = readLedgerFile(files.ledger); } catch (e) {
    return { ...base, events: 0, ok: false, head: null, brokenAt: 0, error: `cannot read the ledger: ${(e as Error).message.slice(0, 160)}`, ended: false, summary: null, strategy: null };
  }
  const chain = verifyChain(events);
  const start = events.find((e) => e.kind === 'run_start');
  const strategy = start && typeof start.strategy === 'string' ? { id: start.strategy, version: String(start.version ?? ''), hash: String(start.strategyHash ?? '') } : null;
  // A parallel run's own ledger (task-1529) closes with fleet_end; each strategy's ledger with run_end.
  const ended = events.length > 0 && (events[events.length - 1].kind === 'run_end' || events[events.length - 1].kind === 'fleet_end');
  let summary: RunAudit['summary'] = null;
  try {
    const s = JSON.parse(readFileSync(files.summary, 'utf8')) as { schema?: string; events?: unknown; ledgerHead?: unknown };
    if (s.schema === RUN_SUMMARY_SCHEMA && typeof s.events === 'number' && typeof s.ledgerHead === 'string') {
      const at = s.events === 0 ? GENESIS : (events[s.events - 1]?.hash as string | undefined);
      summary = { events: s.events, head: s.ledgerHead, matches: at === s.ledgerHead };
    }
  } catch { summary = null; }
  if (!chain.ok) return { ...base, events: events.length, ok: false, head: null, brokenAt: chain.at, error: chain.error, ended, summary, strategy };
  if (summary && summary.events > events.length) {
    return { ...base, events: events.length, ok: false, head: chain.head, brokenAt: events.length + 1, error: `the summary counts ${summary.events} events but the ledger has ${events.length} (lines were cut from the end)`, ended, summary, strategy };
  }
  if (summary && !summary.matches) {
    return { ...base, events: events.length, ok: false, head: chain.head, brokenAt: summary.events, error: `the summary's head for event ${summary.events} does not match the ledger (the ledger was rewritten)`, ended, summary, strategy };
  }
  return { ...base, events: events.length, ok: true, head: chain.head, ended, summary, strategy };
}

// ───────────────────────────── session isolation ─────────────────────────────

export interface SessionIsolation { tools: number; mcpServers: number; plugins: number; agents: number; skills: number; slashCommands: number; ok: boolean }

/** Counts from a stream-json init event (-1 when a list is missing). Tools and MCP servers must both be 0. */
export function sessionIsolation(init: Record<string, unknown>): SessionIsolation {
  const n = (k: string): number => (Array.isArray(init[k]) ? (init[k] as unknown[]).length : -1);
  const tools = n('tools');
  const mcpServers = n('mcp_servers');
  return { tools, mcpServers, plugins: n('plugins'), agents: n('agents'), skills: n('skills'), slashCommands: n('slash_commands'), ok: tools === 0 && mcpServers === 0 };
}
