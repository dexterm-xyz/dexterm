// dexterm — the MEMES + NARRATIVES tracker's app wiring (task-1818, EXPERIMENTAL). One RecorderNarratives per recorder DB
// for the life of the process (WeakMap db → service), so the N screen's `n` heat table, the coin pane's Narrative row and
// the rules' narrative_* fields all read the SAME tracker (stable ids). Only the heat table ever BUILDS it: the first
// build replays the last 26 h of the recorder (tens of seconds of CPU; the replay yields to the event loop every 40 ms,
// so the app keeps drawing, and it starts on a timer after the "building…" frame paints); later refreshes replay only the new rows, at most every 60 s while the view is
// on screen. The coin pane and the rules read whatever is already built and never start a build. No recorder DB
// (fixtures / replay): a tracker over the visible screener rows instead. Measured heat, never advice.
import type { DatabaseSync } from 'node:sqlite';
import { NarrativeTracker, RecorderNarratives, coinField, embedderFromEnv, sanitize, type CoinNarrative, type NarrativeSnapshot } from '@dexterm/narratives';
import type { AppState } from './state.ts';
import type { ScreenerRow } from './screener/rows.ts';

/** Later refreshes run at most this often (the first one runs on open). */
export const NARRATIVES_REFRESH_MS = 60_000;
/** Rows in the heat table. */
export const HEAT_LIMIT = 50;
export const UNTRUSTED_NOTE = 'names are untrusted, shown control-stripped';

/** The N screen's experimental mode: theme board (default) ⇄ heat table, the drill-down, and the build status. */
export interface NarrativesUi {
  mode: 'board' | 'heat';
  /** cursor in the heat table */
  selected: number;
  /** the narrative drilled into (its member list, cursor on a member), or null = the table */
  drill: { id: string; selected: number } | null;
  /** a build/refresh is running (the first one takes tens of seconds; the screen stays live) */
  busy: boolean;
  error: string | null;
  source: 'recorded' | 'screen' | null;
  /** last finished refresh (0 = never) */
  refreshedAt: number;
  buildMs: number | null;
}

const services = new WeakMap<DatabaseSync, RecorderNarratives>();
const screenTrackers = new WeakMap<AppState, NarrativeTracker>();

export function narrativesUiOf(state: AppState): NarrativesUi {
  if (!state.narrativesUi) state.narrativesUi = { mode: 'board', selected: 0, drill: null, busy: false, error: null, source: null, refreshedAt: 0, buildMs: null };
  return state.narrativesUi;
}

const dbOf = (state: AppState): DatabaseSync | null => state.live?.recorder?.database ?? null;
export const narrativesSource = (state: AppState): 'recorded' | 'screen' => (dbOf(state) ? 'recorded' : 'screen');

/** The tracker ALREADY built for this state, or null. Never builds (the coin pane / rules / renders call this). */
export function currentTracker(state: AppState): NarrativeTracker | null {
  const db = dbOf(state);
  return (db ? services.get(db)?.tracker ?? null : null) ?? screenTrackers.get(state) ?? null;
}

/** Install a tracker for a state with no recorder DB (tests; the screen-rows fallback uses the same slot). */
export function setNarrativeTracker(state: AppState, tr: NarrativeTracker | null): void { if (tr) screenTrackers.set(state, tr); else screenTrackers.delete(state); }

/**
 * Build or refresh the tracker. Recorder DB: the per-process RecorderNarratives (first call = the 26 h replay, later
 * calls replay only new rows; it self-throttles to NARRATIVES_REFRESH_MS). No DB: the visible screener rows are fed
 * to a per-state tracker (first sightings once, a sample per row each call) and ticked now.
 */
export async function ensureNarratives(state: AppState, now = Date.now()): Promise<NarrativeTracker | null> {
  const db = dbOf(state);
  if (db) {
    let svc = services.get(db);
    if (!svc) services.set(db, (svc = new RecorderNarratives(db, { embedder: embedderFromEnv(process.env), minRefreshMs: NARRATIVES_REFRESH_MS })));
    return svc.refresh(now);
  }
  const rows = (state.screener.rows as ScreenerRow[]).filter((r) => r.mint && !r.skeleton);
  let tr = screenTrackers.get(state) ?? null;
  if (!rows.length) return tr;
  if (!tr) screenTrackers.set(state, (tr = new NarrativeTracker()));
  const at = (r: ScreenerRow): number => Math.min(now, r.fetchedAt ?? now);
  await tr.addCoins(rows.map((r) => ({ mint: r.mint, t: at(r), symbol: r.symbol, name: r.name })));
  for (const r of rows) tr.addSample({ mint: r.mint, t: at(r), price: r.price, liq: r.liq, mcap: r.mcap, vol5m: r.vol5m, vol1h: r.vol1h, vol6h: r.vol6h, vol24h: r.vol24 });
  tr.tick(now, true);
  return tr;
}

/**
 * Start a build/refresh in the background unless one is running or the last finished < NARRATIVES_REFRESH_MS ago
 * (`force` skips the age check). The work starts on a short timer so the "building…" frame paints first; the recorder
 * replay then yields to the event loop every 40 ms (RecorderNarratives), so frames keep drawing. Returns whether it started.
 */
export function kickNarratives(state: AppState, opts: { now?: number; force?: boolean; delayMs?: number; onDone?: () => void } = {}): boolean {
  const ui = narrativesUiOf(state);
  const now = opts.now ?? Date.now();
  if (ui.busy) return false;
  if (!opts.force && ui.refreshedAt && now - ui.refreshedAt < NARRATIVES_REFRESH_MS) return false;
  ui.busy = true; ui.error = null;
  const run = (): void => {
    const t0 = Date.now();
    void ensureNarratives(state, Date.now())
      .then(() => { ui.source = narrativesSource(state); ui.buildMs = Date.now() - t0; })
      .catch((e: unknown) => { ui.error = e instanceof Error ? e.message : String(e); })
      .finally(() => { ui.busy = false; ui.refreshedAt = Date.now(); opts.onDone?.(); });
  };
  const tm = setTimeout(run, opts.delayMs ?? 40);
  tm.unref?.();
  return true;
}

/** The heat table's rows (control-stripped labels). The screen-rows fallback has no history, so solo coins show too. */
export function heatRows(state: AppState): NarrativeSnapshot[] {
  const tr = currentTracker(state);
  if (!tr) return [];
  return tr.top(HEAT_LIMIT, { minMembers: narrativesSource(state) === 'screen' ? 1 : 2 }).map((s) => sanitize(s));
}

/** The drilled narrative (with its member list in spawn order), or null. */
export function drillDetail(state: AppState): ReturnType<NarrativeTracker['detail']> {
  const id = state.narrativesUi?.drill?.id;
  const tr = currentTracker(state);
  if (!id || !tr) return null;
  const d = tr.detail(id);
  if (d) d.memberList.sort((a, b) => a.spawn - b.spawn);
  return d;
}

/** One coin's narrative from the already-built tracker (null = not built or not tracked). */
export function narrativeFor(state: AppState, mint: string): CoinNarrative | null {
  return currentTracker(state)?.narrativeOf(mint) ?? null;
}

/** The coin pane's Narrative row value + level: warn when copy-cat saturated or fading/dead, else the neutral na (heat is
 *  never shown as a green "ok": it is not a quality mark of the coin). */
export function narrativeCell(state: AppState, mint: string): [string, 'warn' | 'na'] {
  if (!currentTracker(state)) return ['open N → n to build', 'na'];
  const n = narrativeFor(state, mint);
  const text = coinField(n).replace(/^narrative: /, '');
  if (!n) return [text, 'na'];
  return [text, n.saturated || n.lifecycle === 'fading' || n.lifecycle === 'dead' ? 'warn' : 'na'];
}

/** The rules' narrative fields for one coin (all null when not built / not tracked; a rule clause on them is then false). */
export function narrativeRuleFields(state: AppState, mint: string): { narrativeRank: number | null; narrativeScore: number | null; narrativeLifecycle: string | null; narrativeSaturated: boolean | null } {
  const n = narrativeFor(state, mint);
  return { narrativeRank: n?.rank ?? null, narrativeScore: n?.score ?? null, narrativeLifecycle: n?.lifecycle ?? null, narrativeSaturated: n ? n.saturated : null };
}
