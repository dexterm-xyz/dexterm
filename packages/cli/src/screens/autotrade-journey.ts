// dexterm — the AUTOTRADE screen's JOURNEY view (`Q`, then `J` on a strategy; 0.2.0 card C). One strategy's ladder:
// draft → backtested → forward-tested → always-on (paper) → real, with the last backtest (held-out split), the forward
// test (running or its result next to the backtest), the always-on service membership and the mode.
//
// Keys on the view: `b` backtests (recorded as evidence), `F` starts a 24 h forward test (paper, live data, the
// strategy's own bankroll, in the background), `X` stops it, `A` opens the pending ALWAYS-ON promotion's card (y
// applies it: autotrade.json gets the paper member). A promotion to REAL is never applied here: it needs the user's own
// caps and the typed phrase on a terminal (`dexterm autotrade promote apply <pp-id>`). Nothing here reaches a wallet,
// a key, a mandate or the signer.

import { dirname } from 'node:path';
import {
  PromotionFiles, applyAlwaysOn, createForwardTest, findForwardTest, forwardReport, journeyView, liveState, loadArmings, requestForwardStop, saveForwardTest, windowText,
  type ForwardReport, type ForwardTest, type JourneyView, type PromotionProposal, type Strategy,
} from '@dexterm/autotrade';
import { spawnForwardHost } from '../autotrade-cmd/forward.ts';
import type { AutotradeUi } from './autotrade-ui.ts';

export interface JourneyPanel {
  id: string;
  view: JourneyView | null;
  error: string | null;
  forward: ForwardTest | null;
  report: ForwardReport | null;
  pending: PromotionProposal[];
  readAt: number;
}

/** Starts a forward test's host (the app: the dexterm entry, detached; tests: in-process). */
export type ForwardSpawn = (home: string, t: ForwardTest) => number | null;
export const defaultForwardSpawn: ForwardSpawn = (home, t) => spawnForwardHost(home, t, process.env);

const homeOf = (ui: AutotradeUi): string => dirname(ui.deps.store.dir);

export function openJourney(ui: AutotradeUi, id: string | undefined): string | null {
  if (!id) return 'no strategy selected';
  ui.journey = { id, view: null, error: null, forward: null, report: null, pending: [], readAt: 0 };
  ui.view = 'journey';
  refreshJourney(ui, true);
  return ui.journey.error;
}

/** Re-read the journey (at most every 2 s unless forced): evidence, forward test, pending promotions. */
export function refreshJourney(ui: AutotradeUi, force = false): void {
  const j = ui.journey;
  if (!j) return;
  const now = ui.deps.now();
  if (!force && now - j.readAt < 2000) return;
  j.readAt = now;
  const home = homeOf(ui);
  const got = ui.deps.store.get(j.id);
  if (!got || !got.ok) { j.view = null; j.error = got ? `${j.id} does not validate` : `no strategy ${j.id}`; return; }
  try {
    j.view = journeyView(home, got.strategy, { armedHash: loadArmings(home)[j.id]?.strategyHash ?? null });
    j.forward = findForwardTest(home, j.id, now);
    j.report = j.forward ? forwardReport(home, j.forward, now) : null;
    j.pending = new PromotionFiles(home).list({ status: 'pending', id: j.id });
    j.error = null;
  } catch (e) { j.error = `journey unreadable: ${(e as Error).message}`; }
}

/** `F`: a 24 h forward test of this version, on paper, live data, its own bankroll, started in the background. */
export function journeyForward(ui: AutotradeUi): string {
  const j = ui.journey;
  if (!j) return 'F starts a forward test from the journey view (J)';
  const got = ui.deps.store.get(j.id);
  if (!got || !got.ok) return `no valid strategy ${j.id}`;
  if (got.source !== 'user') return `${j.id} is a preset: copy it first (d)`;
  const home = homeOf(ui);
  const c = createForwardTest(home, got.strategy, ui.deps.store.raw(j.id) as Strategy, { hours: 24, by: 'user:tui', now: ui.deps.now() });
  if (!c.ok) return c.why;
  const pid = (ui.deps.forwardSpawn ?? defaultForwardSpawn)(home, c.test);
  if (!pid) { saveForwardTest(home, { ...c.test, state: 'failed', endedAt: ui.deps.now(), endReason: 'could not start the host' }); return `could not start it; in a terminal: dexterm autotrade forward start ${j.id}`; }
  refreshJourney(ui, true);
  return `forward test ${c.test.forwardId} started · ${windowText(c.test.window)} · paper, live data, own bankroll $${c.test.bankrollUsd} · X stops it`;
}

/** `X`: stop the running forward test (it flattens and writes its report; an early stop does not count). */
export function journeyStopForward(ui: AutotradeUi): string {
  const j = ui.journey;
  if (!j) return 'X stops a forward test from the journey view (J)';
  const t = findForwardTest(homeOf(ui), j.id, ui.deps.now());
  if (!t) return 'no forward test';
  const r = requestForwardStop(homeOf(ui), t.forwardId, 'tui', ui.deps.now());
  refreshJourney(ui, true);
  return r.ok ? `${r.already ? 'already stopping' : 'stop requested'}: ${t.forwardId} flattens and writes its report (an early stop does not count)` : r.why;
}

/** `A`: open the pending always-on promotion's confirm card (y applies). Real is a terminal-only step. */
export function journeyPromote(ui: AutotradeUi): string {
  const j = ui.journey;
  if (!j) return 'A applies a promotion from the journey view (J)';
  refreshJourney(ui, true);
  const p = j.pending.find((x) => x.to === 'always-on');
  if (p) { ui.confirm = { kind: 'promote', proposalId: p.proposalId }; return `promotion ${p.proposalId} → always-on (proposed by ${p.actor}): y applies, any key cancels`; }
  const real = j.pending.find((x) => x.to === 'real');
  if (real) return `real mode is armed only on your own terminal with your caps and a typed phrase: dexterm autotrade promote apply ${real.proposalId}`;
  return j.view?.next?.stage === 'always-on' ? `nothing pending: ask the analyst to propose it, or in a terminal: dexterm autotrade promote ${j.id} --to always-on` : 'no promotion pending';
}

/** The y / any-key answer on the promotion card. */
export function confirmPromote(ui: AutotradeUi, proposalId: string, yes: boolean): string {
  if (!yes) return 'promotion not applied (it stays pending)';
  const j = ui.journey;
  const got = j ? ui.deps.store.get(j.id) : null;
  if (!got || !got.ok) return 'the strategy is not valid any more';
  const a = applyAlwaysOn(homeOf(ui), proposalId, got.strategy, { by: 'user:tui', now: ui.deps.now() });
  refreshJourney(ui, true);
  return a.ok ? `applied: ${got.strategy.id} is an always-on paper member (${a.memberId}); the service runs it from its next start` : `not applied: ${a.why}`;
}

export function journeyLines(j: JourneyPanel, now: number): { text: string; tone: 'text' | 'ok' | 'warn' | 'dim' }[] {
  if (j.error || !j.view) return [{ text: j.error ?? 'loading…', tone: 'warn' }];
  const v = j.view;
  const out: { text: string; tone: 'text' | 'ok' | 'warn' | 'dim' }[] = [
    { text: `${v.id} v${v.version} · rules ${v.rulesHash.slice(0, 8)} · mode ${v.mode} · stage ${v.stage.toUpperCase()}`, tone: 'text' },
    { text: '', tone: 'dim' },
    ...v.rungs.map((r) => ({ text: `${r.ok ? '[x]' : '[ ]'} ${r.stage.padEnd(15)} ${r.detail}`, tone: (r.ok ? 'ok' : 'dim') as 'ok' | 'dim' })),
    ...v.notes.map((n) => ({ text: `!  ${n}`, tone: 'warn' as const })),
    { text: v.next ? `next: ${v.next.stage} — ${v.next.how}` : 'top of the ladder: real (caps, kill switch, receipts: dexterm autotrade signal status)', tone: 'text' },
    { text: '', tone: 'dim' },
  ];
  if (j.forward && j.report) {
    const st = liveState(j.forward, now);
    out.push({ text: `forward test ${j.forward.forwardId} · ${st.toUpperCase()} · ${windowText(j.forward.window)}`, tone: st === 'running' || st === 'starting' ? 'warn' : 'text' });
    for (const l of j.report.lines.slice(1)) out.push({ text: l.replace(/^  /, ''), tone: 'text' });
    out.push({ text: '', tone: 'dim' });
  }
  for (const p of j.pending) out.push({ text: `pending promotion ${p.proposalId} → ${p.to} (proposed by ${p.actor})${p.to === 'always-on' ? ' · A to review' : ' · terminal only: dexterm autotrade promote apply'}`, tone: 'warn' });
  return out;
}
