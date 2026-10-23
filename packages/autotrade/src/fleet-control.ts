// dexterm autotrade — per-strategy control, the fleet status file and the comparison table (task-1529). PAPER today.
//
// One process runs every strategy of autotrade.json (fleet.ts). It holds the machine's one runner lock under the
// FLEET's run id, so the existing `dexterm autotrade stop | flatten`, the Q screen's `!` / `f` / `p`, the panic file
// and the dead-man act on EVERY strategy at once (the global switch, safety.ts). This file adds the per-strategy
// switch:
//
//   $DEXTERM_HOME/autotrade/fleet/<strategy>.control.json   (dexterm-autotrade-fleet-control/1)
//     stop | flatten | pause | resume-entries   for that strategy's CURRENT run (its run id), same meaning as the
//                                               global ones, scoped to one book: another strategy never sees it
//     start                                     a strategy of autotrade.json that is not running starts at the next
//                                               tick (paper only, its own config; nothing else can be changed here)
//
// One file per strategy, so two requests never overwrite each other. A stop or flatten is final for that run (only
// stop → flatten escalates); an unreadable file halts THAT strategy (fail closed) and nothing else.
//
//   $DEXTERM_HOME/autotrade/fleet-status.json   (dexterm-autotrade-fleet/1), rewritten every heartbeat: each
//     strategy's state, book, spend and stats, the global caps and their use today, the machine load.
//
// compareRows() turns that file into the comparison table (`dexterm autotrade status --all`, the Q screen's FLEET
// view, the MCP compare tool): P/L, win rate, rug exposure, missed runners, model spend per entry.
//
// Nothing here holds a key, touches a wallet or the signer, or can switch a strategy to live.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from './ledger.ts';
import { STRATEGY_ID } from './store.ts';
import type { SafetyVerdict } from './safety.ts';
import type { PaperAccountView } from './paper-accounts.ts';

export const FLEET_CONTROL_SCHEMA = 'dexterm-autotrade-fleet-control/1';
export const FLEET_STATUS_SCHEMA = 'dexterm-autotrade-fleet/1';
export type MemberAction = 'start' | 'stop' | 'flatten' | 'pause' | 'resume-entries';
export const MEMBER_ACTIONS: readonly MemberAction[] = ['start', 'stop', 'flatten', 'pause', 'resume-entries'];
export type ControlSource = 'cli' | 'tui' | 'mcp' | 'chat';
const BY: readonly ControlSource[] = ['cli', 'tui', 'mcp', 'chat'];

export interface MemberRequest { schema: typeof FLEET_CONTROL_SCHEMA; fleetId: string; member: string; runId: string | null; action: MemberAction; at: number; by: ControlSource }

export const fleetDir = (home: string): string => join(home, 'autotrade', 'fleet');
export const fleetStatusPath = (home: string): string => join(home, 'autotrade', 'fleet-status.json');
export function memberControlPath(home: string, member: string): string {
  if (!STRATEGY_ID.test(member)) throw new Error(`not a strategy id: ${JSON.stringify(member)}`);
  return join(fleetDir(home), `${member}.control.json`);
}

export function readMemberControl(home: string, member: string): MemberRequest | 'unreadable' | null {
  const p = memberControlPath(home, member);
  if (!existsSync(p)) return null;
  try {
    const d = JSON.parse(readFileSync(p, 'utf8')) as Partial<MemberRequest>;
    if (d.schema !== FLEET_CONTROL_SCHEMA || typeof d.fleetId !== 'string' || d.member !== member || !(d.runId === null || typeof d.runId === 'string')
      || !MEMBER_ACTIONS.includes(d.action as MemberAction) || typeof d.at !== 'number') return 'unreadable';
    return { schema: FLEET_CONTROL_SCHEMA, fleetId: d.fleetId, member, runId: d.runId, action: d.action as MemberAction, at: d.at, by: BY.includes(d.by as ControlSource) ? d.by as ControlSource : 'cli' };
  } catch { return 'unreadable'; }
}

const FINAL: readonly MemberAction[] = ['stop', 'flatten'];

export type MemberWrite = { ok: true; request: MemberRequest; already: boolean } | { ok: false; why: string };

/**
 * Ask one strategy of the running fleet to start, stop, flatten, pause or resume entries. The fleet's status file
 * says which strategies exist and which run is current; a request for a strategy that is not in the fleet, a start
 * for one that runs, or a stop for one that does not, is refused here with the reason.
 */
export function requestMemberControl(home: string, member: string, action: MemberAction, by: ControlSource, now = Date.now()): MemberWrite {
  if (!STRATEGY_ID.test(member)) return { ok: false, why: `not a strategy id: ${JSON.stringify(member)}` };
  const st = readFleetStatus(home);
  if (!st.ok) return { ok: false, why: st.why };
  if (st.status.state === 'stopped') return { ok: false, why: 'the parallel runner has stopped; start it with `dexterm autotrade run --all --paper`' };
  const m = st.status.members.find((x) => x.id === member);
  if (!m) return { ok: false, why: `${member} is not one of the running strategies (${st.status.members.map((x) => x.id).join(', ')}); add it to autotrade.json and start the runner again` };
  const running = m.runId !== null && m.state !== 'stopped' && m.state !== 'idle' && m.state !== 'error';
  if (action === 'start') {
    if (running) return { ok: false, why: `${member} is already running (run ${m.runId})` };
  } else if (!running) return { ok: false, why: `${member} is not running${m.state === 'error' ? ` (${m.error ?? 'it failed to start'})` : ''}${action === 'stop' || action === 'flatten' ? '; nothing to stop' : ''}` };
  const runId = action === 'start' ? null : m.runId;
  const cur = readMemberControl(home, member);
  if (cur && cur !== 'unreadable' && cur.fleetId === st.status.fleetId && cur.runId === runId && runId !== null && FINAL.includes(cur.action)) {
    if (cur.action === action || (cur.action === 'flatten' && action === 'stop')) return { ok: true, request: cur, already: true };
    if (action !== 'flatten') return { ok: false, why: `${member} is already ${cur.action === 'stop' ? 'stopping' : 'flattening'}; only a flatten can follow a stop` };
  }
  const request: MemberRequest = { schema: FLEET_CONTROL_SCHEMA, fleetId: st.status.fleetId, member, runId, action, at: now, by };
  mkdirSync(fleetDir(home), { recursive: true, mode: 0o700 });
  writeJsonAtomic(memberControlPath(home, member), request);
  return { ok: true, request, already: false };
}

/** At a fleet's start and end: drop the per-strategy requests of other fleets (they can never apply). */
export function clearMemberControls(home: string, keepFleetId: string | null): void {
  const dir = fleetDir(home);
  if (!existsSync(dir)) return;
  for (const f of readdirSafe(dir)) {
    if (!f.endsWith('.control.json')) continue;
    const id = f.slice(0, -'.control.json'.length);
    if (!STRATEGY_ID.test(id)) continue;
    const cur = readMemberControl(home, id);
    if (cur !== 'unreadable' && (!cur || cur.fleetId !== keepFleetId)) rmSync(join(dir, f), { force: true });
  }
}

function readdirSafe(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

/**
 * One strategy's switch, read on every step of its run: a stat per step, a parse when the file changed. A stop or
 * flatten is sticky for the run; pause lifts with resume-entries; an unreadable file halts this strategy only.
 */
export class MemberSafety {
  private haltWhy: string | null = null;
  private haltDetail = '';
  private flattening = false;
  private stopAsked = false;
  private sig = '';
  private ctl: MemberRequest | 'unreadable' | null = null;
  private readonly home: string;
  private readonly fleetId: string;
  private readonly member: string;
  private readonly runId: string;
  constructor(o: { home: string; fleetId: string; member: string; runId: string }) { this.home = o.home; this.fleetId = o.fleetId; this.member = o.member; this.runId = o.runId; }

  private control(): MemberRequest | 'unreadable' | null {
    const p = memberControlPath(this.home, this.member);
    let sig = '';
    try { const st = statSync(p); sig = `${st.mtimeMs}:${st.size}:${st.ino}`; } catch { sig = ''; }
    if (sig !== this.sig) { this.sig = sig; this.ctl = sig ? readMemberControl(this.home, this.member) : null; }
    return this.ctl;
  }

  step(): SafetyVerdict {
    const c = this.control();
    let pause: string | null = null;
    const halt = (why: string, detail: string) => { if (!this.haltWhy) { this.haltWhy = why; this.haltDetail = detail; } };
    if (c === 'unreadable') { halt('control-unreadable', `${this.member}'s control file cannot be read (treated as a stop of this strategy)`); this.stopAsked = true; }
    else if (c && c.fleetId === this.fleetId && c.runId === this.runId) {
      const from = c.by === 'tui' ? 'the Q screen' : c.by === 'mcp' ? 'an MCP client' : c.by === 'chat' ? 'a paired chat' : 'the command line';
      if (c.action === 'stop' || c.action === 'flatten') {
        halt(c.action, `this strategy only, requested from ${from}`);
        this.stopAsked = true;
        if (c.action === 'flatten') this.flattening = true;
      } else if (c.action === 'pause') pause = 'paused';
    }
    return { halt: this.haltWhy, ...(this.haltWhy ? { detail: this.haltDetail } : {}), flatten: this.flattening, pauseEntries: pause, endWhenFlat: this.stopAsked };
  }
}

/** The fleet's own verdict and a strategy's, folded: a global halt, flatten or pause reaches every strategy; a member one only its own. */
export function mergeVerdicts(global: SafetyVerdict, member: SafetyVerdict): SafetyVerdict {
  const halt = global.halt ?? member.halt;
  const detail = global.halt ? global.detail : member.detail;
  return { halt, ...(halt && detail ? { detail } : {}), flatten: global.flatten || member.flatten, pauseEntries: global.pauseEntries ?? member.pauseEntries, endWhenFlat: global.endWhenFlat || member.endWhenFlat };
}

// ───────────────────────────── the status file ─────────────────────────────

export interface MemberStats {
  candidates: number;
  entries: number;
  closed: number;
  wins: number;
  losses: number;
  realizedUsd: number;
  /** Closed by a rug or liquidity exit, or still held and unsellable. */
  rugExits: number;
  rugCostUsd: number;
  /** Cost of every entry (all tranches). */
  enteredUsd: number;
  /** Candidates this strategy saw and did not enter that later traded at >= MISSED_RUNNER_X their candidate price. */
  missedRunners: number;
  missedSample: { symbol: string; x: number }[];
  /** Model spend of this run (ended sessions + the live ones). */
  spendUsd: number;
}

export type MemberState = 'running' | 'paused' | 'halted' | 'stopped' | 'idle' | 'error';

export interface FleetMemberView {
  id: string;
  runId: string | null;
  state: MemberState;
  error?: string;
  haltReason: string | null;
  mode: 'paper';
  basedOn: { id: string; version: string; hash: string };
  strategyHash: string;
  bankroll: { usd: number; sol?: number; solUsd?: number };
  book: { startUsd: number; equityUsd: number; cashUsd: number; realizedTodayUsd: number } | null;
  spend: { todayUsd: number; dayCapUsd: number } | null;
  open: { mint: string; symbol: string; profile: string; costUsd: number; pnlUsd: number; pnlPct: number; freeBag?: boolean; stuck?: boolean }[];
  candidates: number;
  sessions: number;
  stats: MemberStats;
  ledgerPath: string | null;
  startedAt: number | null;
  endedAt: number | null;
  /** The shared paper account it trades from (task-1538): `book` is then the ACCOUNT's, `pnlUsd` this strategy's own. */
  account?: string;
  pnlUsd?: number | null;
}

export interface FleetStatus {
  schema: typeof FLEET_STATUS_SCHEMA;
  fleetId: string;
  pid: number;
  mode: 'paper';
  state: 'running' | 'halted' | 'stopped';
  haltReason: string | null;
  startedAt: number;
  heartbeatAt: number;
  source: string;
  global: {
    caps: { maxConcurrentSessions: number; modelUsdPerDay: number; candidateSessionsPerDay: number; positionSessionsPerDay: number; turnsPerDay: number };
    today: { modelUsd: number; turns: number; candidateSessions: number; positionSessions: number };
    liveSessions: number;
    load: { load1m: number | null; paused: boolean; pauseAbove: number; resumeBelow: number };
    allowance: { fiveHour: number | null; sevenDay: number | null } | null;
    blocked: string | null;
  };
  members: FleetMemberView[];
  /** Shared paper accounts (task-1538), each counted once. */
  accounts?: PaperAccountView[];
  ledgerPath: string;
}

export type FleetRead = { ok: true; status: FleetStatus; stale: boolean; path: string } | { ok: false; why: string; path: string };

export const FLEET_STALE_MS = 30_000;

export function readFleetStatus(home: string, now = Date.now()): FleetRead {
  const path = fleetStatusPath(home);
  if (!existsSync(path)) return { ok: false, why: 'no parallel runner has run here yet (`dexterm autotrade run --all --paper`)', path };
  let d: Partial<FleetStatus>;
  try { d = JSON.parse(readFileSync(path, 'utf8')) as Partial<FleetStatus>; } catch (e) { return { ok: false, why: `the fleet status file is not JSON: ${(e as Error).message}`, path }; }
  if (d.schema !== FLEET_STATUS_SCHEMA) return { ok: false, why: `unknown fleet status shape ${JSON.stringify(d.schema)}`, path };
  // Paper only: a status that claims anything else is an error, never shown as a running live fleet.
  if (d.mode !== 'paper') return { ok: false, why: `mode ${JSON.stringify(d.mode)}: only paper fleets are shown`, path };
  if (typeof d.fleetId !== 'string' || typeof d.heartbeatAt !== 'number' || !Array.isArray(d.members) || !d.global) return { ok: false, why: 'the fleet status file is missing fields', path };
  const status = d as FleetStatus;
  return { ok: true, status, stale: status.state !== 'stopped' && now - status.heartbeatAt > FLEET_STALE_MS, path };
}

// ───────────────────────────── the comparison table ─────────────────────────────

export const MISSED_RUNNER_X = 2;
const RUG_REASONS = new Set(['rug-liquidity', 'thesis-liquidity']);
export const isRugExit = (reason: string, stuck: boolean): boolean => stuck || RUG_REASONS.has(reason);

export interface CompareRow {
  id: string;
  /** The shared paper account (task-1538), or null: the strategy owns its bankroll. */
  account: string | null;
  state: MemberState;
  basedOn: string;
  bankrollUsd: number;
  equityUsd: number | null;
  pnlUsd: number | null;
  pnlPct: number | null;
  closed: number;
  winRatePct: number | null;
  open: number;
  rugExits: number;
  rugExposurePct: number | null;
  missedRunners: number;
  spendUsd: number;
  spendPerEntryUsd: number | null;
  entries: number;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

export function compareRows(st: FleetStatus): CompareRow[] {
  return st.members.map((m) => {
    // On a shared account the book is the account's: the strategy's P/L is its own trades (pnlUsd), against the account.
    const onAccount = typeof m.account === 'string';
    const eq = onAccount ? null : m.book?.equityUsd ?? null;
    const start = m.book?.startUsd ?? m.bankroll.usd;
    const pnl = onAccount ? (typeof m.pnlUsd === 'number' ? r2(m.pnlUsd) : null) : eq === null ? null : r2(eq - start);
    const s = m.stats;
    return {
      id: m.id, account: onAccount ? m.account! : null, state: m.state, basedOn: `${m.basedOn.id} v${m.basedOn.version}`, bankrollUsd: start,
      equityUsd: eq, pnlUsd: pnl, pnlPct: pnl === null || !start ? null : Math.round((pnl / start) * 1000) / 10,
      closed: s.closed, winRatePct: s.closed ? Math.round((s.wins / s.closed) * 1000) / 10 : null, open: m.open.length,
      rugExits: s.rugExits, rugExposurePct: s.enteredUsd > 0 ? Math.round((s.rugCostUsd / s.enteredUsd) * 1000) / 10 : null,
      missedRunners: s.missedRunners, spendUsd: Math.round(s.spendUsd * 1e4) / 1e4, spendPerEntryUsd: s.entries ? Math.round((s.spendUsd / s.entries) * 1e4) / 1e4 : null, entries: s.entries,
    };
  });
}

/** The fleet totals (every strategy's own book, and every shared paper account once; paper). */
export function fleetTotals(st: FleetStatus): { startUsd: number; equityUsd: number; cashUsd: number; pnlUsd: number; pnlPct: number | null; closed: number; wins: number; spendUsd: number; open: number } {
  let startUsd = 0, equityUsd = 0, cashUsd = 0, closed = 0, wins = 0, spendUsd = 0, open = 0;
  for (const m of st.members) {
    if (!m.book) continue;
    closed += m.stats.closed; wins += m.stats.wins; spendUsd += m.stats.spendUsd; open += m.open.length;
    if (typeof m.account === 'string') continue; // counted once below, with its account
    startUsd += m.book.startUsd; equityUsd += m.book.equityUsd; cashUsd += m.book.cashUsd;
  }
  for (const a of st.accounts ?? []) { startUsd += a.startUsd; equityUsd += a.equityUsd; cashUsd += a.cashUsd; }
  const pnlUsd = r2(equityUsd - startUsd);
  return { startUsd: r2(startUsd), equityUsd: r2(equityUsd), cashUsd: r2(cashUsd), pnlUsd, pnlPct: startUsd ? Math.round((pnlUsd / startUsd) * 1000) / 10 : null, closed, wins, spendUsd: Math.round(spendUsd * 1e4) / 1e4, open };
}

/** The shared paper accounts as plain text lines (empty when the run has none). */
export function accountTable(st: FleetStatus): string[] {
  const accts = st.accounts ?? [];
  if (!accts.length) return [];
  const head = ['ACCOUNT', 'START', 'EQUITY', 'CASH', 'P/L', 'P/L %', 'OPEN', 'STRATEGIES'];
  const body = accts.map((a) => [
    a.id, `$${a.startUsd.toFixed(0)}${a.sol !== undefined ? ` (${a.sol} SOL)` : ''}`, `$${a.equityUsd.toFixed(2)}`, `$${a.cashUsd.toFixed(2)}`, fmtUsd(a.pnlUsd), fmtPct(a.pnlPct), String(a.positions),
    st.members.filter((m) => m.account === a.id).map((m) => m.id).join(' ') || '—',
  ]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === 0 || i === cells.length - 1 ? c.padEnd(w[i]) : c.padStart(w[i]))).join('  ').trimEnd();
  return [line(head), ...body.map(line)];
}

const fmtPct = (v: number | null): string => (v === null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`);
const fmtUsd = (v: number | null): string => (v === null ? '—' : `${v >= 0 ? '+' : '-'}$${Math.abs(v).toFixed(2)}`);

/** The table as plain text lines (the CLI, the MCP text and the Q screen share one layout). */
export function compareTable(rows: readonly CompareRow[]): string[] {
  // An ACCOUNT column only when a strategy trades from a shared paper account (task-1538); BANKROLL is then the account's.
  const acct = rows.some((r) => r.account);
  const head = ['STRATEGY', ...(acct ? ['ACCOUNT'] : []), 'STATE', 'BANKROLL', 'P/L', 'P/L %', 'WIN', 'CLOSED', 'OPEN', 'RUGS', 'RUG EXP', 'MISSED', 'SPEND', '$/ENTRY'];
  const body = rows.map((r) => [
    r.id, ...(acct ? [r.account ?? '—'] : []), r.state, `$${r.bankrollUsd.toFixed(0)}`, fmtUsd(r.pnlUsd), fmtPct(r.pnlPct), r.winRatePct === null ? '—' : `${r.winRatePct.toFixed(0)}%`,
    String(r.closed), String(r.open), String(r.rugExits), r.rugExposurePct === null ? '—' : `${r.rugExposurePct.toFixed(0)}%`, String(r.missedRunners),
    `$${r.spendUsd.toFixed(2)}`, r.spendPerEntryUsd === null ? '—' : `$${r.spendPerEntryUsd.toFixed(3)}`,
  ]);
  const left = acct ? 2 : 1;
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => (i <= left ? c.padEnd(w[i]) : c.padStart(w[i]))).join('  ');
  return [line(head), ...body.map(line)];
}
