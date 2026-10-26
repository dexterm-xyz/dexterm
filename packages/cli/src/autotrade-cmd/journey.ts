// `dexterm autotrade journey` and `dexterm autotrade promote` (0.2.0 card C): a strategy's ladder, and the user's side
// of a promotion.
//
//   draft -> backtested -> forward-tested -> always-on (paper) -> real
//
// `journey [<id>]` shows where each strategy stands and what the next rung needs. `promote <id> --to always-on|real`
// writes a promotion proposal (the analyst writes the same file with strategy_promote_propose) and shows its evidence
// card; `promote list|show|apply|dismiss` resolve them. Applying always-on needs `y` typed on a real terminal (never a
// pipe, a flag or an agent) and adds the strategy to autotrade.json as a paper member of the always-on service.
// Real is never applied here: it hands over to `dexterm autotrade signal arm` (the evidence panel, the user's own
// caps, a typed phrase with a one-time code), and refuses until the user has set the real-mode caps themselves.
// No rung can be skipped on this path. task-1679: real also needs the evidence floor (a completed forward test with
// the user's minForwardTrades closed paper trades + a backtest); below it `promote --to real` refuses and says how the
// user alone can override it (`signal arm`, a typed OVERRIDE phrase on a real terminal, journaled).

import { dextermHome } from '@dexterm/custom';
import {
  PromotionFiles, applyAlwaysOn, checkPromotion, dismissPromotion, findForwardTest, isActive, isPromotionId, journeyView, loadArmings, loadCaps, proposePromotion, renderJourney, windowText,
  type JourneyView, type PromotionProposal, type ResolvedStrategy,
} from '@dexterm/autotrade';
import type { AutotradeIo } from '../autotrade-cmd.ts';
import { parseArgs, storeFor } from './strategies.ts';
import { signalCmd, type SignalDeps } from './signal.ts';

const BOOL = ['json'];
export const JOURNEY_USAGE = 'dexterm autotrade journey [<id>] [--json]';
export const PROMOTE_USAGE = [
  'dexterm autotrade promote <id> --to always-on|real',
  'dexterm autotrade promote list [--json] | show <pp-id> | apply <pp-id> | dismiss <pp-id>',
].join('\n');

const out = (io: AutotradeIo, s: string) => { io.stdout.write(`${s}\n`); };
const err = (io: AutotradeIo, cmd: string, s: string) => { io.stderr.write(`dexterm autotrade ${cmd}: ${s}\n`); };

/** Test seams: the terminal check and the typed line (the same seams as `signal`). */
export type JourneyDeps = SignalDeps;

function viewOf(io: AutotradeIo, id: string): { s: ResolvedStrategy; v: JourneyView } | { error: string } {
  const home = dextermHome(io.env);
  const got = storeFor(io).get(id);
  if (!got) return { error: `no strategy ${JSON.stringify(id)} (dexterm autotrade list)` };
  if (!got.ok) return { error: `${id} does not validate: ${got.errors.map((e) => `${e.path} ${e.msg}`).join('; ')}` };
  return { s: got.strategy, v: journeyView(home, got.strategy, { armedHash: loadArmings(home)[id]?.strategyHash ?? null }) };
}

export function journeyCmd(argv: string[], io: AutotradeIo): number {
  const { pos, opts } = parseArgs(argv, BOOL);
  const home = dextermHome(io.env);
  const store = storeFor(io);
  if (!pos[0]) {
    const rows = store.list().filter((e) => e.source === 'user' && e.ok).map((e) => { const r = viewOf(io, e.id); return 'error' in r ? null : r.v; }).filter((v): v is JourneyView => !!v);
    if (opts.json) { out(io, JSON.stringify({ paper: true, strategies: rows.map((v) => ({ id: v.id, version: v.version, stage: v.stage, next: v.next?.stage ?? null })) }, null, 2)); return 0; }
    if (!rows.length) { out(io, 'no strategies of your own yet: copy a preset (dexterm autotrade new my-scalp --from scalp) or ask the analyst to build one'); return 0; }
    for (const v of rows) out(io, `${v.id.padEnd(20)} v${v.version.padEnd(8)} ${v.stage.toUpperCase().padEnd(15)} ${v.next ? `next: ${v.next.stage}` : 'top of the ladder'}`);
    return 0;
  }
  const r = viewOf(io, pos[0]);
  if ('error' in r) { err(io, 'journey', r.error); return 1; }
  const fw = findForwardTest(home, r.s.id);
  const running = fw && isActive(fw) ? fw : null;
  const pending = new PromotionFiles(home).list({ status: 'pending', id: r.s.id });
  if (opts.json) { out(io, JSON.stringify({ paper: r.s.mode !== 'real', ...r.v, forwardRunning: running ? { forwardId: running.forwardId, window: running.window, progress: running.progress } : null, pendingPromotions: pending.map((p) => ({ proposalId: p.proposalId, to: p.to, actor: p.actor })) }, null, 2)); return 0; }
  for (const l of renderJourney(r.v)) out(io, l);
  if (running) out(io, `  forward test running: ${running.forwardId} · window ${windowText(running.window)}${running.progress ? ` · ${running.progress.closed} closed, ${running.progress.open} open` : ''}`);
  for (const p of pending) out(io, `  pending promotion ${p.proposalId} → ${p.to} (proposed by ${p.actor}): dexterm autotrade promote show ${p.proposalId}`);
  return 0;
}

function isTty(io: AutotradeIo, deps: JourneyDeps): boolean { return deps.tty ?? io.stdin?.isTTY === true; }

async function typedLine(io: AutotradeIo, deps: JourneyDeps, prompt: string): Promise<string | null> {
  if (deps.typed) return deps.typed(prompt);
  io.stderr.write(prompt);
  const stdin = io.stdin as unknown as NodeJS.ReadStream | undefined;
  if (!stdin) return null;
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: stdin, terminal: false });
  try { return await new Promise<string | null>((resolve) => { rl.once('line', (l) => resolve(l)); rl.once('close', () => resolve(null)); }); } finally { rl.close(); stdin.pause?.(); }
}

function showCard(io: AutotradeIo, p: PromotionProposal): void {
  out(io, `promotion ${p.proposalId} · ${p.status.toUpperCase()} · proposed by ${p.actor} · ${new Date(p.createdAt).toISOString().slice(0, 16).replace('T', ' ')}`);
  out(io, `  why (as given, display only): ${p.why}`);
  for (const l of p.card) out(io, l);
}

export async function promoteCmd(argv: string[], io: AutotradeIo, deps: JourneyDeps = {}): Promise<number> {
  const { pos, opts } = parseArgs(argv, BOOL);
  const home = dextermHome(io.env);
  const files = new PromotionFiles(home);
  const now = deps.now ?? Date.now;
  const sub = pos[0];
  if (!sub || sub === 'help') { out(io, PROMOTE_USAGE); return sub ? 0 : 2; }
  if (sub === 'list') {
    const all = files.list().slice(0, 30);
    if (opts.json) { out(io, JSON.stringify({ promotions: all.map(({ card: _c, ...p }) => p) }, null, 2)); return 0; }
    if (!all.length) { out(io, 'no promotion proposals'); return 0; }
    for (const p of all) out(io, `${p.proposalId}  ${p.id.padEnd(20)} → ${p.to.padEnd(9)} ${p.status.padEnd(9)} by ${p.actor}`);
    return 0;
  }
  if (sub === 'show' || sub === 'apply' || sub === 'dismiss') {
    const pid = pos[1];
    const p = isPromotionId(pid) ? files.get(pid) : null;
    if (!p) { err(io, 'promote', `no promotion ${JSON.stringify(pid ?? '')} (dexterm autotrade promote list)`); return 1; }
    if (sub === 'show') { showCard(io, p); return 0; }
    if (p.status !== 'pending') { err(io, 'promote', `${p.proposalId} is ${p.status}`); return 1; }
    if (sub === 'dismiss') { dismissPromotion(home, p.proposalId, 'user', now()); out(io, `dismissed ${p.proposalId}; nothing changed`); return 0; }
    return applyCmd(io, deps, p, now);
  }
  // promote <id> --to always-on|real: the user's own proposal, then straight to the confirm.
  const id = sub;
  const to = typeof opts.to === 'string' ? opts.to : '';
  const r = viewOf(io, id);
  if ('error' in r) { err(io, 'promote', r.error); return 1; }
  const armedHash = loadArmings(home)[id]?.strategyHash ?? null;
  const c = checkPromotion(home, r.s, to, { armedHash });
  if (!c.ok) {
    err(io, 'promote', c.why);
    if (c.view) for (const l of renderJourney(c.view)) io.stderr.write(`${l}\n`);
    if (c.reason === 'evidence-floor') io.stderr.write(`  the floor is your limit minForwardTrades (dexterm autotrade limits explain minForwardTrades). To arm below it anyway, your call alone: dexterm autotrade signal arm ${id} on your own terminal asks for a typed OVERRIDE phrase, which is journaled.\n`);
    return 1;
  }
  const made = proposePromotion(home, r.s, to, { actor: 'user', why: 'asked on the command line', now: now(), armedHash });
  if (!made.ok) { err(io, 'promote', made.why); return 1; }
  return applyCmd(io, deps, made.proposal, now);
}

async function applyCmd(io: AutotradeIo, deps: JourneyDeps, p: PromotionProposal, now: () => number): Promise<number> {
  const home = dextermHome(io.env);
  const r = viewOf(io, p.id);
  if ('error' in r) { err(io, 'promote', r.error); return 1; }
  if (r.s.hash !== p.hash) { err(io, 'promote', `${p.id} changed since the proposal (v${p.version} → v${r.s.version}); dismiss it and ask for a new one`); return 1; }
  showCard(io, p);
  if (p.to === 'real') {
    // Caps are the user's: real is only reachable here once the user set them on purpose (task-1655: card E's limits.json).
    const caps = loadCaps(home);
    if (!caps.ok) { err(io, 'promote', `set your own real-mode caps first (your limits: dexterm autotrade limits set perTradeSol=X dailySol=Y buysPerDay=N maxOpenPositions=N, or signal caps set); ${caps.why}`); return 1; }
    out(io, `real mode is armed by card A's typed confirmation; handing over to: dexterm autotrade signal arm ${p.id}`);
    return signalCmd(['arm', p.id], io, deps);
  }
  if (!isTty(io, deps)) { err(io, 'promote', 'applying a promotion needs your y on a real terminal (a pipe, a flag or an agent cannot give it); or apply it on the Q screen'); return 1; }
  const got = await typedLine(io, deps, `add ${p.id} to the always-on service (paper)? type y to apply, anything else cancels: `);
  if ((got ?? '').trim().toLowerCase() !== 'y') { err(io, 'promote', 'not applied; nothing changed (the proposal stays pending)'); return 1; }
  const a = applyAlwaysOn(home, p.proposalId, r.s, { by: 'user', now: now() });
  if (!a.ok) { err(io, 'promote', a.why); return 1; }
  out(io, `applied: ${p.id} is ${a.created ? 'now' : 'again'} an always-on paper member (${a.memberId}) in autotrade.json. The service runs it from its next start: dexterm autotrade service status (restart it to pick it up now: service stop, then service start)`);
  return 0;
}
