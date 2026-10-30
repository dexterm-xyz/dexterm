// dexterm — STREAMER OVERLAY model (task-1427). A pure fold of spectator events into the three OBS scenes:
//   activity  the agent's recent calls (redacted), newest first
//   coin      the coin the agent is on: name, LARP evidence + verdict, a top-10 holder bar, live signals with ages
//   pnl       the agent's PAPER fills on that coin (drawn by the task-1407 card renderer, see overlay/pnl.ts)
//
// Honesty by construction:
//   - every event is passed through redactSpectatorEvent HERE, whatever its source already did, so a full address
//     or key can never reach a scene (addresses become head…tail; key material becomes [key]);
//   - every figure is copied from an event; nothing is estimated. Each scene carries the age of its data;
//   - a replayed recording is SAMPLE DATA: `sample` is set once by the caller and every scene view carries it.
// No I/O, no clock (callers pass `now`), no control surface: the overlay can only describe what already happened.

import { redactSpectatorEvent, type SpectatorEvent, type SpectatorDetail } from '@dexterm/agents';

/** How many activity rows a scene keeps (OBS lower thirds are short). */
export const OVERLAY_ACTIVITY_MAX = 8;
/** Live signals kept on the coin card. */
export const OVERLAY_FLAGS_MAX = 4;

export type OverlayScene = 'activity' | 'coin' | 'pnl';
export const OVERLAY_SCENES: readonly OverlayScene[] = ['activity', 'coin', 'pnl'];

export interface OverlayActivityRow {
  t: number;
  agent: string;
  phase: string;
  tool: string;
  summary: string;
  ok: boolean;
  /** The age the call's own result reported (seconds), null when it carried none. */
  dataAgeSec: number | null;
}

/** A dated value: when it was seen on the stream (`at`) and how old it already was then (`ageSec`). */
interface Dated { at: number; ageSec: number }

export interface OverlayCoinState {
  /** Masked mint (head…tail): the coin's identity on every scene. */
  mint: string;
  symbol: string | null;
  priceUsd: (Dated & { value: number }) | null;
  verdict: (Dated & { label: string; rug: number | null }) | null;
  larp: (Dated & { flags: number; items: string[] }) | null;
  holders: (Dated & { top10Pct: number; count: number | null; basis: 'ex-pools' | 'raw' }) | null;
  flags: Array<Dated & { kind: string; level: 'up' | 'down' | 'info' | 'warn'; title: string; text: string; source: string; stale: boolean }>;
  lastAt: number;
}

/** One PAPER fill as the stream carried it (paper desk numbers, signed SOL leg). */
export interface OverlayFill { t: number; side: 'buy' | 'sell'; sol: number; qty: number; priceUsd: number | null }

export interface OverlayPaperState { mint: string; symbol: string; fills: OverlayFill[] }

export interface OverlayState {
  sample: boolean;
  /** The time of the newest event folded (ms), null before the first one. */
  lastEventAt: number | null;
  events: number;
  activity: OverlayActivityRow[];
  /** Coins by masked mint; `current` names the one the agent is on. */
  coins: Map<string, OverlayCoinState>;
  current: string | null;
  /** PAPER fills by masked mint; `paperCurrent` is the coin of the newest fill. */
  paper: Map<string, OverlayPaperState>;
  paperCurrent: string | null;
}

export function emptyOverlayState(sample: boolean): OverlayState {
  return { sample, lastEventAt: null, events: 0, activity: [], coins: new Map(), current: null, paper: new Map(), paperCurrent: null };
}

const MASKED_RE = /^[1-9A-HJ-NP-Za-km-z]{4}…[1-9A-HJ-NP-Za-km-z]{4}$/;
// eslint-disable-next-line no-control-regex
const UNSAFE_RE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;
const clean = (s: unknown, max: number): string => (typeof s === 'string' ? s.replace(UNSAFE_RE, '').slice(0, max) : '');
const finite = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/** Fold one event (any source) into the state. Returns the redacted copy that was folded. */
export function foldOverlay(state: OverlayState, raw: SpectatorEvent): SpectatorEvent {
  const ev = redactSpectatorEvent(raw);
  const t = finite(ev.t) ?? 0;
  state.events++;
  state.lastEventAt = state.lastEventAt === null ? t : Math.max(state.lastEventAt, t);
  if (ev.phase !== 'note' || ev.tool !== 'live_signal') {
    state.activity.unshift({
      t, agent: clean(ev.agent, 24) || 'agent', phase: clean(ev.phase, 12), tool: clean(ev.tool ?? '', 28),
      summary: clean(ev.summary ?? '', 120), ok: ev.ok !== false, dataAgeSec: finite(ev.dataAgeSec),
    });
    if (state.activity.length > OVERLAY_ACTIVITY_MAX) state.activity.length = OVERLAY_ACTIVITY_MAX;
  }
  const d: SpectatorDetail = ev.detail ?? {};
  const age = finite(ev.dataAgeSec) ?? 0;
  const mint = [d.coin?.mint, d.fill?.mint, d.ticket?.mint, ev.nav?.mint].find((m): m is string => typeof m === 'string' && MASKED_RE.test(m)) ?? null;
  if (mint) {
    const c = coin(state, mint, t);
    if (ev.nav?.mint === mint || d.coin || d.verdict || d.larp || d.holders) state.current = mint;
    const sym = clean(d.coin?.symbol ?? d.fill?.symbol ?? d.ticket?.symbol ?? '', 16);
    if (sym && sym !== '?') c.symbol = sym;
    const px = finite(d.coin?.priceUsd ?? null) ?? finite(d.fill?.priceUsd ?? null);
    if (px !== null && px > 0) c.priceUsd = { value: px, at: t, ageSec: age };
    if (d.verdict) c.verdict = { label: clean(d.verdict.label, 18), rug: finite(d.verdict.rug ?? null), at: t, ageSec: age };
    if (d.larp) c.larp = { flags: Math.max(0, Math.round(d.larp.flags)), items: d.larp.items.slice(0, 4).map((x) => clean(x, 60)), at: t, ageSec: age };
    if (d.holders && finite(d.holders.top10Pct) !== null) {
      c.holders = { top10Pct: Math.max(0, Math.min(100, d.holders.top10Pct)), count: finite(d.holders.count ?? null), basis: d.holders.basis === 'raw' ? 'raw' : 'ex-pools', at: t, ageSec: finite(d.holders.ageSec ?? null) ?? age };
    }
    for (const f of d.liveFlags ?? []) {
      // dated on the event's clock: at the event the reading was its own age plus the time since the signal fired
      // (so a replayed recording, re-timed to the playback clock, keeps its signals' ages consistent)
      const fat = finite(f.at) ?? t;
      c.flags.unshift({ kind: clean(f.kind, 16), level: f.level, title: clean(f.title, 24), text: clean(f.text, 120), source: clean(f.source, 24), stale: f.stale === true, at: t, ageSec: Math.max(0, finite(f.ageSec) ?? 0) + Math.max(0, t - fat) / 1000 });
    }
    if (c.flags.length > OVERLAY_FLAGS_MAX) c.flags.length = OVERLAY_FLAGS_MAX;
    if (d.fill && ev.ok !== false) {
      const f = d.fill;
      const sol = finite(f.sol), qty = finite(f.qty);
      if (sol !== null && qty !== null && qty > 0 && (f.side === 'buy' || f.side === 'sell')) {
        const p = state.paper.get(mint) ?? { mint, symbol: c.symbol ?? '?', fills: [] };
        p.symbol = c.symbol ?? p.symbol;
        p.fills.push({ t, side: f.side, sol, qty, priceUsd: finite(f.priceUsd) });
        if (p.fills.length > 200) p.fills.splice(0, p.fills.length - 200);
        state.paper.set(mint, p);
        state.paperCurrent = mint;
      }
    }
  }
  return ev;
}

function coin(state: OverlayState, mint: string, t: number): OverlayCoinState {
  let c = state.coins.get(mint);
  if (!c) {
    c = { mint, symbol: null, priceUsd: null, verdict: null, larp: null, holders: null, flags: [], lastAt: t };
    state.coins.set(mint, c);
    // bounded: a long session touches many coins; keep the 50 most recent
    if (state.coins.size > 50) {
      const oldest = [...state.coins.values()].filter((x) => x.mint !== state.current).sort((a, b) => a.lastAt - b.lastAt)[0];
      if (oldest) state.coins.delete(oldest.mint);
    }
  }
  c.lastAt = Math.max(c.lastAt, t);
  return c;
}

// ------------------------------------------------------------------------------------------------ scene views

/** Seconds → "12s" / "4m" / "2h" / "3d" (the scenes' age chips). */
export function fmtAgeShort(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec)) return '—';
  const s = Math.max(0, Math.round(sec));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86_400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86_400)}d`;
}

/** The age of a dated value at `now`: how old it was when it arrived plus the time since. */
export const ageAt = (d: Dated, now: number): number => d.ageSec + Math.max(0, now - d.at) / 1000;

/** What every scene view carries at the top: the stamp line and the data age. */
export interface SceneHeader {
  /** SAMPLE DATA tag (replay of a saved session) — shown on every scene, never optional. */
  sample: boolean;
  /** "data age 12s" for the scene's newest figure; "no data yet" before any. */
  age: string;
  ageSec: number | null;
}

export interface ActivityView extends SceneHeader { scene: 'activity'; rows: Array<{ when: string; agent: string; phase: string; tool: string; summary: string; ok: boolean; dataAge: string | null }> }
export interface CoinView extends SceneHeader {
  scene: 'coin';
  coin: null | {
    mint: string; symbol: string;
    price: { text: string; age: string } | null;
    verdict: { label: string; rug: string | null; age: string } | null;
    larp: { flags: number; items: string[]; age: string } | null;
    holders: { top10Pct: number; text: string; basis: string; age: string } | null;
    flags: Array<{ level: string; title: string; text: string; source: string; age: string; stale: boolean }>;
  };
}

function header(state: OverlayState, newestAgeSec: number | null): SceneHeader {
  return { sample: state.sample, ageSec: newestAgeSec, age: newestAgeSec === null ? 'no data yet' : `data age ${fmtAgeShort(newestAgeSec)}` };
}

export function activityView(state: OverlayState, now: number): ActivityView {
  const newest = state.activity[0];
  return {
    scene: 'activity',
    ...header(state, newest ? Math.max(0, now - newest.t) / 1000 + (newest.dataAgeSec ?? 0) : null),
    rows: state.activity.map((r) => ({
      when: fmtAgeShort(Math.max(0, now - r.t) / 1000), agent: r.agent, phase: r.phase, tool: r.tool, summary: r.summary, ok: r.ok,
      dataAge: r.dataAgeSec === null ? null : fmtAgeShort(r.dataAgeSec + Math.max(0, now - r.t) / 1000),
    })),
  };
}

const fmtUsdPrice = (v: number): string => (v >= 1 ? `$${v.toFixed(4)}` : v >= 0.0001 ? `$${v.toPrecision(4)}` : `$${v.toExponential(2)}`);

export function coinView(state: OverlayState, now: number): CoinView {
  const c = state.current ? state.coins.get(state.current) ?? null : null;
  if (!c) return { scene: 'coin', ...header(state, null), coin: null };
  const ages = [c.priceUsd, c.verdict, c.larp, c.holders, ...c.flags].filter((x): x is NonNullable<typeof x> => !!x).map((x) => ageAt(x, now));
  return {
    scene: 'coin',
    ...header(state, ages.length ? Math.min(...ages) : null),
    coin: {
      mint: c.mint,
      symbol: c.symbol ?? '?',
      price: c.priceUsd ? { text: fmtUsdPrice(c.priceUsd.value), age: fmtAgeShort(ageAt(c.priceUsd, now)) } : null,
      verdict: c.verdict ? { label: c.verdict.label, rug: c.verdict.rug === null ? null : `${Math.round(c.verdict.rug * 100)}%`, age: fmtAgeShort(ageAt(c.verdict, now)) } : null,
      larp: c.larp ? { flags: c.larp.flags, items: c.larp.items, age: fmtAgeShort(ageAt(c.larp, now)) } : null,
      holders: c.holders ? {
        top10Pct: +c.holders.top10Pct.toFixed(1),
        text: `top 10 hold ${c.holders.top10Pct.toFixed(1)}%${c.holders.count !== null ? ` · ${c.holders.count.toLocaleString('en-US')} holders` : ''}`,
        basis: c.holders.basis === 'ex-pools' ? 'pools, curves, locks and burns left out' : 'every account counted (raw)',
        age: fmtAgeShort(ageAt(c.holders, now)),
      } : null,
      flags: c.flags.map((f) => ({ level: f.level, title: f.title, text: f.text, source: f.source, age: fmtAgeShort(ageAt(f, now)), stale: f.stale })),
    },
  };
}
