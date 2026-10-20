// task-1406 "watch the agent cook": bridge the follow-mode controller to the spectator popup VM, and map
// the popup's spectator.* UI events onto the controller's user-side controls. Nothing here can arm, sign
// or raise a cap — the controls are exactly the bus's pause/resume/kick, the same as the roster popup.

import { redactSpectatorEvent, redactString, maskAddress, STORY_RAIL, type FollowController, type SpectatorEvent, type StoryView } from '@dexterm/agents';
import type { SpectatorPopupVM, SpectatorActivityVM, SpectatorStoryVM } from '@dexterm/popup';

/** task-1466: the story for the popup, every string redacted (addresses masked, keys removed). */
export function storyVM(v: StoryView, redact = true): SpectatorStoryVM {
  const r = (s: string): string => (redact ? redactString(s) : s);
  const a = v.arc?.stage === 'closed' || !v.arc ? (v.arc ?? v.lastResult) : v.arc;
  return {
    phase: v.phase, rail: [...STORY_RAIL], sub: v.sub, bpm: v.bpm, control: v.control, calls: v.calls,
    thoughts: v.thoughts.slice(-4).map((x) => ({ t: x.t, text: r(x.text), source: x.source })),
    nodes: v.nodes.slice(-24).map((n) => ({ t: n.t, label: r(n.label), ms: n.ms, status: n.status, paper: n.paper, phase: n.phase, count: n.count })),
    focus: v.focus ? { symbol: r(v.focus.symbol), checks: [...v.focus.checks], verdict: v.focus.verdict?.label ?? null, rug: v.focus.verdict?.rug ?? null, larpFlags: v.focus.larp?.flags ?? null } : null,
    arc: a ? {
      symbol: r(a.symbol), stage: a.stage, sizeUsd: a.sizeUsd, entryUsd: a.entryUsd, markUsd: a.mark?.priceUsd ?? null, pnlPct: a.pnlPct, peakPct: a.peakPct,
      exits: a.fills.filter((f) => f.side === 'sell').length, realizedSol: a.result?.realizedSol ?? null, resultPct: a.result?.pct ?? null, refusal: a.refusal ? r(a.refusal) : null,
    } : null,
  };
}

function activityVM(ev: SpectatorEvent): SpectatorActivityVM {
  return {
    seq: ev.seq, t: ev.t, phase: ev.phase, agent: ev.agent, tier: ev.tier ?? null,
    tool: ev.tool ?? null, summary: ev.summary ?? '', ms: ev.ms ?? null, dataAgeSec: ev.dataAgeSec ?? null,
    ok: ev.ok, refusal: ev.refusal ?? null,
  };
}

/** Build the spectator popup VM from the follow controller. Redacts addresses/keys unless redact:false. */
export function buildSpectatorVM(follow: FollowController, opts: { redact?: boolean; title?: string; story?: StoryView | null } = {}): SpectatorPopupVM {
  const redact = opts.redact ?? true;
  const v = follow.view();
  const s = v.screen;
  const mask = (x: string | null): string | null => (x && redact ? maskAddress(x) : x);
  return {
    ...(opts.story ? { story: storyVM(opts.story, redact) } : {}),
    title: opts.title ?? 'watch the agent cook',
    now: Date.now(),
    redacted: redact,
    control: v.control,
    screen: { screen: s.screen, selectedMint: mask(s.selectedMint), feed: s.feed, filter: s.filter, highlight: mask(s.highlight) },
    agents: v.agents.map((a) => ({ name: a.name, tier: a.tier, status: a.status, lastAt: a.lastAt })),
    activity: v.activity.map((ev) => activityVM(redact ? redactSpectatorEvent(ev) : ev)),
  };
}

/** Apply a validated spectator popup event to the follow controller. Returns a short log line. */
export function applySpectatorEvent(follow: FollowController, name: string, agent: string): string {
  switch (name) {
    case 'spectator.pause': return follow.pause(agent);
    case 'spectator.resume': return follow.resume(agent);
    case 'spectator.takeover': return follow.takeOver(agent);
    case 'spectator.kill': return follow.kill(agent);
    default: return `ignored ${name}`;
  }
}
