// `dexterm autotrade status [--all]`, `start <strategy>`, `pause | resume [--strategy ID]`, and the per-strategy
// `stop | flatten --strategy ID` (task-1529, parallel strategies). PAPER ONLY.
//
// Without --strategy, pause and resume act on the whole runner (control.json, like the Q screen's `p`), whether it
// runs one strategy or several. With --strategy they act on one strategy of `dexterm autotrade run --all` through its
// own control file (autotrade/fleet/<id>.control.json): another strategy never sees it. `start` starts a strategy of
// autotrade.json that is not running (paper, with its own config; nothing else can be changed from here).
// Nothing here touches a wallet, a key or the signer.

import { dextermHome } from '@dexterm/custom';
import {
  accountTable, activeRunner, compareRows, compareTable, fleetTotals, readFleetStatus, requestControl, requestMemberControl, type FleetMemberView, type MemberAction,
} from '@dexterm/autotrade';
import type { AutotradeIo } from '../autotrade-cmd.ts';
import { parseArgs } from './strategies.ts';

export const STATUS_USAGE = 'dexterm autotrade status [--all] [--json]';
export const START_USAGE = 'dexterm autotrade start <strategy> [--wait SEC] [--json]';
export const PAUSE_USAGE = 'dexterm autotrade pause [--strategy ID] [--json]';
export const RESUME_USAGE = 'dexterm autotrade resume [--strategy ID] [--json]';

const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const waitSec = (v: string | true | undefined, dflt = 10): number => { const n = typeof v === 'string' ? Number(v) : NaN; return Number.isFinite(n) && n >= 0 ? Math.min(n, 120) : dflt; };

function memberNow(home: string, id: string): FleetMemberView | null {
  const st = readFleetStatus(home);
  return st.ok ? st.status.members.find((m) => m.id === id) ?? null : null;
}

/** True once the strategy's state shows the request (or the fleet is gone). */
function acknowledged(m: FleetMemberView | null, action: MemberAction, runId: string | null): boolean {
  if (!m) return true;
  switch (action) {
    case 'start': return m.runId !== null && m.runId !== runId && m.state !== 'idle';
    case 'stop': return m.runId !== runId || m.state === 'stopped' || m.state === 'halted';
    case 'flatten': return m.runId !== runId || m.state === 'stopped' || m.haltReason === 'flatten';
    case 'pause': return m.state === 'paused' || m.state === 'halted' || m.state === 'stopped';
    case 'resume-entries': return m.state !== 'paused';
  }
}

export interface MemberOutcome { strategy: string; action: MemberAction; requested: boolean; already: boolean; acknowledged: boolean; runId: string | null; state: string | null }

/** Write one strategy's request and wait up to `wait` seconds for its runner to show it. */
export async function sendMemberControl(io: AutotradeIo, id: string, action: MemberAction, wait: number): Promise<MemberOutcome | { error: string }> {
  const home = dextermHome(io.env);
  const before = memberNow(home, id);
  const w = requestMemberControl(home, id, action, 'cli');
  if (!w.ok) return { error: w.why };
  const prevRun = action === 'start' ? before?.runId ?? null : w.request.runId;
  const until = Date.now() + wait * 1000;
  let cur = memberNow(home, id);
  while (!acknowledged(cur, action, prevRun) && Date.now() < until) { await tick(200); cur = memberNow(home, id); }
  return { strategy: id, action, requested: true, already: w.already, acknowledged: acknowledged(cur, action, prevRun), runId: cur?.runId ?? null, state: cur?.state ?? null };
}

const WORD: Record<MemberAction, string> = { start: 'start', stop: 'stop', flatten: 'flatten', pause: 'pause', 'resume-entries': 'resume' };

export function printMemberOutcome(io: AutotradeIo, res: MemberOutcome, json: boolean): void {
  if (json) { io.stdout.write(`${JSON.stringify(res)}\n`); return; }
  io.stdout.write(`${WORD[res.action]} ${res.already ? 'was already requested' : 'requested'} for strategy ${res.strategy} (the others are not touched)\n`);
  if (!res.acknowledged) io.stdout.write('the runner has not confirmed yet: it reads the request on its next tick. `dexterm autotrade status --all` shows each strategy.\n');
  else io.stdout.write(`✓ ${res.strategy}: ${res.state ?? 'gone'}${res.action === 'start' && res.runId ? ` (run ${res.runId})` : ''}\n`);
}

/** `dexterm autotrade stop | flatten --strategy ID` (called from stop.ts / flatten.ts). */
export async function memberStopCmd(io: AutotradeIo, id: string, action: 'stop' | 'flatten', opts: Record<string, string | true>): Promise<number> {
  const res = await sendMemberControl(io, id, action, waitSec(opts.wait));
  if ('error' in res) { io.stderr.write(`dexterm autotrade ${action}: ${res.error}\n`); return 1; }
  printMemberOutcome(io, res, !!opts.json);
  return 0;
}

export async function startCmd(argv: string[], io: AutotradeIo): Promise<number> {
  const { pos, opts } = parseArgs(argv, ['json']);
  const id = typeof opts.strategy === 'string' ? opts.strategy : pos[0];
  if (!id || pos.length > 1) { io.stderr.write(`usage: ${START_USAGE}\n  (starts a strategy of autotrade.json in the running \`dexterm autotrade run --all --paper\`)\n`); return 2; }
  const res = await sendMemberControl(io, id, 'start', waitSec(opts.wait));
  if ('error' in res) { io.stderr.write(`dexterm autotrade start: ${res.error}\n`); return 1; }
  printMemberOutcome(io, res, !!opts.json);
  return 0;
}

async function pauseResume(argv: string[], io: AutotradeIo, action: 'pause' | 'resume-entries'): Promise<number> {
  const { pos, opts } = parseArgs(argv, ['json']);
  const name = action === 'pause' ? 'pause' : 'resume';
  if (pos.length) { io.stderr.write(`usage: ${action === 'pause' ? PAUSE_USAGE : RESUME_USAGE}\n`); return 2; }
  if (typeof opts.strategy === 'string') {
    const res = await sendMemberControl(io, opts.strategy, action, waitSec(opts.wait, 5));
    if ('error' in res) { io.stderr.write(`dexterm autotrade ${name}: ${res.error}\n`); return 1; }
    printMemberOutcome(io, res, !!opts.json);
    return 0;
  }
  const home = dextermHome(io.env);
  const r = activeRunner(home);
  if (!r) { io.stdout.write(opts.json ? `${JSON.stringify({ requested: false, why: 'no autotrade runner is running' })}\n` : `no autotrade runner is running; nothing to ${name}\n`); return 0; }
  const w = requestControl(home, r.runId, action, 'cli');
  if (!w.ok) { io.stderr.write(`dexterm autotrade ${name}: ${w.why}\n`); return 1; }
  if (opts.json) { io.stdout.write(`${JSON.stringify({ requested: true, runId: r.runId, action })}\n`); return 0; }
  io.stdout.write(action === 'pause'
    ? `pause requested for run ${r.runId}: no new entries${r.runId.includes('-fleet-') ? ' in any strategy' : ''}; open positions keep their exits (\`dexterm autotrade resume\` lifts it)\n`
    : `resume requested for run ${r.runId}: new entries allowed again\n`);
  return 0;
}

export const pauseCmd = (argv: string[], io: AutotradeIo): Promise<number> => pauseResume(argv, io, 'pause');
export const resumeCmd = (argv: string[], io: AutotradeIo): Promise<number> => pauseResume(argv, io, 'resume-entries');

export function statusCmd(argv: string[], io: AutotradeIo): number {
  const { pos, opts } = parseArgs(argv, ['all', 'json']);
  if (pos.length) { io.stderr.write(`usage: ${STATUS_USAGE}\n`); return 2; }
  const home = dextermHome(io.env);
  const r = activeRunner(home);
  const fs = readFleetStatus(home);
  const fleetCurrent = fs.ok && r?.runId === fs.status.fleetId;
  if (opts.json) {
    io.stdout.write(`${JSON.stringify({
      paper: true, runner: r,
      ...(fs.ok && (opts.all || fleetCurrent) ? { fleet: { fleetId: fs.status.fleetId, state: r?.runId === fs.status.fleetId ? fs.status.state : 'stopped', stale: fs.stale, global: fs.status.global, totals: fleetTotals(fs.status), strategies: compareRows(fs.status), ...(fs.status.accounts ? { accounts: fs.status.accounts } : {}) } } : {}),
    }, null, 2)}\n`);
    return 0;
  }
  if (!r) io.stdout.write('no autotrade runner is running\n');
  else io.stdout.write(`paper runner ${r.runId} (pid ${r.pid}) · ${r.state ?? 'starting'}${r.haltReason ? ` (${r.haltReason})` : ''} · ${r.positions} open · ${r.sessions} sessions${r.heartbeatAt ? ` · heartbeat ${Math.round((Date.now() - r.heartbeatAt) / 1000)} s ago` : ''}\n`);
  if (!opts.all && !fleetCurrent) {
    if (r) io.stdout.write('(one strategy; `dexterm autotrade run --all --paper` runs every strategy of autotrade.json at once)\n');
    return 0;
  }
  if (!fs.ok) { io.stdout.write(`parallel strategies: ${fs.why}\n`); return 0; }
  const st = fs.status;
  const running = r?.runId === st.fleetId;
  io.stdout.write(`\nPARALLEL STRATEGIES · PAPER · fleet ${st.fleetId} · ${running ? st.state : 'ended'}${fs.stale && running ? ' (heartbeat stale)' : ''} · ${st.source}\n`);
  const g = st.global;
  io.stdout.write(`global: ${g.liveSessions}/${g.caps.maxConcurrentSessions} sessions open · $${g.today.modelUsd.toFixed(2)}/$${g.caps.modelUsdPerDay} model spend today · ${g.today.candidateSessions}/${g.caps.candidateSessionsPerDay} candidate sessions · load ${g.load.load1m ?? '—'}${g.load.paused ? ' (sessions paused: machine busy)' : ''}${g.blocked ? ` · blocked: ${g.blocked}` : ''}\n\n`);
  for (const l of compareTable(compareRows(st))) io.stdout.write(`${l}\n`);
  const acct = accountTable(st);
  if (acct.length) io.stdout.write(`\npaper accounts (shared simulated wallets):\n${acct.join('\n')}\n`);
  const tot = fleetTotals(st);
  io.stdout.write(`\ntogether: ${tot.pnlUsd >= 0 ? '+' : '-'}$${Math.abs(tot.pnlUsd).toFixed(2)}${tot.pnlPct === null ? '' : ` (${tot.pnlPct >= 0 ? '+' : ''}${tot.pnlPct}%)`} on $${tot.startUsd.toFixed(2)} · ${tot.closed} closed · ${tot.open} open · $${tot.spendUsd.toFixed(4)} model spend. Paper, simulated fills; not financial advice.\n`);
  const missed = st.members.flatMap((m) => m.stats.missedSample.map((x) => `${m.id}: ${x.symbol} ${x.x}x`));
  if (missed.length) io.stdout.write(`missed runners (seen, not entered, later >= 2x): ${missed.slice(0, 6).join(' · ')}\n`);
  for (const m of st.members) if (m.state === 'error') io.stdout.write(`${m.id}: failed: ${m.error ?? 'unknown'}\n`);
  return 0;
}
