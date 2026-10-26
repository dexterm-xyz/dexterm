// dexterm autotrade chat — tier 2, control (task-1527, AUTOTRADE-SPEC §8.4).
//
// The command list is closed; anything else gets the help text. Chat can always make things SAFER and never less
// safe:
//   /status /positions /strategies /help   read-only (positions come with a [Sell] button each, bound like a proposal)
//   /pause                                  no new entries; exits keep running                       always
//   /resume                                 lifts a PAUSE only; never a kill, panic, breaker halt or guard
//   /kill (= /stop)                         `autotrade stop`: sessions closed, no entries, exits running  always
//   /flatten                                sells everything at the next tick, after a [Yes, flatten] button
//   /use <id>                               an equal-or-tighter validated strategy only, after a [Yes, switch] button;
//                                           never changes paper/live; a looser one says "change it locally"
//   /approvals on                           every entry waits for a tap (safer). `off` is local only
// Not from chat, ever: live mode, looser caps or strategies, approvals off, resuming after a kill or a panic.
// The router only calls the ControlPort the host gives it; the port writes the same control file the CLI and the
// Q screen write, so chat is a remote control for the same local engine and adds no path around its fences.

import type { InboundCommand } from './connector.ts';
import { inert, pct, shortMint } from './format.ts';

export type Result = { ok: boolean; message: string };

export interface StatusView {
  runId: string;
  state: string;
  haltReason: string | null;
  strategy: { id: string; version: string; hash: string };
  open: number;
  candidates: number;
  dayPnlPct: number | null;
  spend: { todayUsd: number; dayCapUsd: number };
  allowance: { fiveHour: number | null; sevenDay: number | null } | null;
  approvals: 'required by the strategy' | 'on' | 'off';
  /** task-1654: a real run's executor health and limits, as engine-made lines (absent on paper). */
  real?: { executor: string; limits: string; pause: string | null };
}

export interface PositionView { mint: string; symbol: string; profile: string; pnlPct: number; freeBag: boolean; next: string | null }

export interface StrategyChoice { id: string; version: string; hash: string; preset: boolean; current: boolean; allowed: boolean; why: string }

export interface ControlPort {
  status(): StatusView | null;
  positions(): PositionView[];
  pause(): Result;
  resume(): Result;
  kill(): Result;
  flatten(): Result;
  strategies(): StrategyChoice[];
  use(id: string): Result;
  approvalsOn(): Result;
  /** Queue a whole-position sell for the next tick (an agent-exit equivalent). */
  sell(mint: string): Result;
}

/** What a command answers: lines, and optionally a confirm card the hub asks the broker for. */
export interface ControlReply {
  lines: string[];
  confirm?: { kind: 'flatten' | 'use' | 'sell'; lines: string[]; yes: string; payload: Record<string, unknown> }[];
}

export const HELP_LINES = [
  'dexterm bot · commands:',
  '/status · /positions · /strategies',
  '/pause (no new entries) · /resume (lifts a pause only)',
  '/kill or /stop (stop the runner: no entries, exits keep running)',
  '/flatten (sell everything, asks first)',
  '/use <strategy> (equal or tighter only, asks first)',
  '/approvals on (every entry waits for your tap)',
  'Trades are approved only with buttons. I never ask for keys or seed phrases.',
];

export const NEVER_RATE_LIMITED: readonly string[] = ['kill', 'stop', 'pause', 'flatten'];

export class ControlRouter {
  private readonly port: ControlPort;
  constructor(port: ControlPort) { this.port = port; }

  handle(c: InboundCommand): ControlReply {
    const p = this.port;
    switch (c.command) {
      case 'help': case 'start': return { lines: HELP_LINES };
      case 'pair': return { lines: ['This chat is already paired. Pairing happens on your computer (dexterm telegram pair).'] };
      case 'status': {
        const s = p.status();
        if (!s) return { lines: ['No runner is running on your computer.'] };
        return {
          lines: [
            `STATUS · ${s.state}${s.haltReason ? ` (${inert(s.haltReason, 40)})` : ''}`,
            `strategy ${inert(s.strategy.id, 32)} v${inert(s.strategy.version, 12)} (${s.strategy.hash.slice(0, 8)})`,
            `open ${s.open} · candidates ${s.candidates} · day P/L ${pct(s.dayPnlPct)}`,
            `model spend today $${s.spend.todayUsd.toFixed(2)}${Number.isFinite(s.spend.dayCapUsd) ? ` of $${s.spend.dayCapUsd}` : ''}${s.allowance?.fiveHour !== null && s.allowance?.fiveHour !== undefined ? ` · 5 h window ${Math.round(s.allowance.fiveHour * 100)}%` : ''}`,
            `approvals: ${s.approvals}`,
            ...(s.real ? [`executor: ${inert(s.real.executor, 160)}`, `limits: ${inert(s.real.limits, 160)}`, ...(s.real.pause ? [`NEW BUYS PAUSED: ${inert(s.real.pause, 120)}`] : [])] : []),
          ],
        };
      }
      case 'positions': {
        const ps = p.positions();
        if (!ps.length) return { lines: ['No open positions.'] };
        const shown = ps.slice(0, 5);
        return {
          lines: [`POSITIONS · ${ps.length} open`, ...ps.slice(0, 10).map((x) => `"${inert(x.symbol, 20)}" ${shortMint(x.mint)} · ${inert(x.profile, 24)} · ${pct(x.pnlPct)}${x.freeBag ? ' · cost back' : ''}${x.next ? ` · ${inert(x.next, 40)}` : ''}`)],
          confirm: shown.map((x) => ({ kind: 'sell' as const, lines: [`SELL "${inert(x.symbol, 20)}" ${shortMint(x.mint)} at the next tick? (${pct(x.pnlPct)} now)`], yes: 'Sell', payload: { mint: x.mint } })),
        };
      }
      case 'pause': return { lines: [p.pause().message] };
      case 'resume': return { lines: [p.resume().message] };
      case 'kill': case 'stop': return { lines: [p.kill().message] };
      case 'flatten': {
        const s = p.status();
        if (!s) return { lines: ['No runner is running on your computer.'] };
        return { lines: [], confirm: [{ kind: 'flatten', lines: [`FLATTEN: stop the runner and sell all ${s.open} position${s.open === 1 ? '' : 's'} at the next tick?`], yes: 'Yes, flatten', payload: { runId: s.runId } }] };
      }
      case 'strategies': {
        const list = p.strategies();
        if (!list.length) return { lines: ['No strategies found.'] };
        return { lines: ['STRATEGIES (✓ = /use allowed: equal or tighter than the running one)', ...list.slice(0, 20).map((x) => `${x.current ? '▶' : x.allowed ? '✓' : '·'} ${inert(x.id, 32)} v${inert(x.version, 12)} (${x.hash.slice(0, 8)})${x.preset ? ' preset' : ''}${x.current ? ' (running)' : x.allowed ? '' : ` · ${inert(x.why, 60)}`}`)] };
      }
      case 'use': {
        const id = c.args[0] ?? '';
        if (!id) return { lines: ['Usage: /use <strategy id> (see /strategies)'] };
        const list = p.strategies();
        const x = list.find((q) => q.id === id);
        if (!x) return { lines: [`No validated strategy "${inert(id, 32)}". See /strategies.`] };
        if (x.current) return { lines: [`${inert(id, 32)} is already running.`] };
        if (!x.allowed) return { lines: [`Refused: ${inert(id, 32)} is not equal or tighter (${inert(x.why, 80)}). Change it locally.`] };
        return { lines: [], confirm: [{ kind: 'use', lines: [`SWITCH to ${inert(x.id, 32)} v${inert(x.version, 12)} (${x.hash.slice(0, 8)})? New entries stop now; the switch happens once the open positions have closed.`], yes: 'Yes, switch', payload: { id: x.id, hash: x.hash } }] };
      }
      case 'approvals': {
        const a = (c.args[0] ?? '').toLowerCase();
        if (a === 'on') return { lines: [p.approvalsOn().message] };
        if (a === 'off') return { lines: ['Approvals can be turned off only on your computer (dexterm telegram approvals off).'] };
        const s = p.status();
        return { lines: [`approvals: ${s?.approvals ?? 'unknown'} · /approvals on makes every entry wait for your tap`] };
      }
      default: return { lines: HELP_LINES };
    }
  }
}
