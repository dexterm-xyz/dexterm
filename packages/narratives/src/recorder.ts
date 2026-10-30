// dexterm narratives (task-1818): build / replay the tracker from the recorder DB (read-only, node:sqlite).
// Rows are fed strictly in time order, one tick interval at a time: the interval's first sightings are clustered,
// its samples ingested, then the tick at the interval's END runs. So a tick at T only ever saw rows with t <= T.
import type { DatabaseSync } from 'node:sqlite';
import { NarrativeTracker, type CoinInput, type Sample, type TrackerOptions } from './tracker.ts';

export interface ReplayOptions extends TrackerOptions {
  from: number;
  to: number;
  /** Tick interval (default 5 min). */
  tickMs?: number;
  /** Only 'live' rows (default false: daily sweep rows are real observations too). */
  liveOnly?: boolean;
  tracker?: NarrativeTracker;
  /** Yield to the event loop (setImmediate) when an interval loop has run this long, so a UI keeps drawing (default off). */
  yieldMs?: number;
}

export interface ReplayHooks {
  /** Called before an interval's rows are ingested: the tracker state is as of `t` (the last tick). */
  beforeInterval?(t: number, end: number, tracker: NarrativeTracker, firstSightings: CoinInput[]): void | Promise<void>;
  /** Called after the interval's first sightings are clustered and BEFORE its samples: metrics are still as of `t`. */
  afterCoins?(t: number, end: number, tracker: NarrativeTracker, firstSightings: CoinInput[]): void | Promise<void>;
  afterTick?(t: number, tracker: NarrativeTracker): void | Promise<void>;
}

const SQL = `SELECT mint, t, kind, symbol, name, price_usd, mcap, liquidity_usd, vol_m5, vol_h1, vol_h6, vol_h24,
  num_traders_h1, net_buyers_h1, holder_count FROM token_snapshots WHERE t > ? AND t <= ? ORDER BY t`;

type Row = Record<string, string | number | null>;
const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function rowToSample(r: Row): Sample {
  return { mint: String(r.mint), t: Number(r.t), price: n(r.price_usd), mcap: n(r.mcap), liq: n(r.liquidity_usd), vol5m: n(r.vol_m5), vol1h: n(r.vol_h1), vol6h: n(r.vol_h6), vol24h: n(r.vol_h24), traders1h: n(r.num_traders_h1), netBuyers1h: n(r.net_buyers_h1), holders: n(r.holder_count) };
}

/** Replay [from, to] through a tracker (created if not given). Returns it after the last tick. */
export async function replayRecorder(db: DatabaseSync, opts: ReplayOptions, hooks: ReplayHooks = {}): Promise<NarrativeTracker> {
  const tickMs = opts.tickMs ?? 300_000;
  const tr = opts.tracker ?? new NarrativeTracker({ ...opts, tickMs });
  const stmt = db.prepare(SQL);
  let t = opts.from;
  let slice = performance.now();
  while (t < opts.to) {
    if (opts.yieldMs && performance.now() - slice >= opts.yieldMs) { await new Promise<void>((r) => setImmediate(r)); slice = performance.now(); }
    const end = Math.min(opts.to, t + tickMs);
    const rows = (stmt.all(t, end) as Row[]).filter((r) => !opts.liveOnly || r.kind === 'live');
    const fresh: CoinInput[] = []; const seen = new Set<string>();
    for (const r of rows) {
      const m = String(r.mint);
      if (tr.coins.has(m) || seen.has(m)) continue;
      seen.add(m); fresh.push({ mint: m, t: Number(r.t), symbol: (r.symbol as string) ?? null, name: (r.name as string) ?? null });
    }
    if (hooks.beforeInterval) await hooks.beforeInterval(t, end, tr, fresh);
    await tr.addCoins(fresh);
    if (hooks.afterCoins) await hooks.afterCoins(t, end, tr, fresh);
    for (const r of rows) tr.addSample(rowToSample(r));
    tr.tick(end, true);
    if (hooks.afterTick) await hooks.afterTick(end, tr);
    t = end;
  }
  return tr;
}

/** The live board: replay the last `lookbackMs` (default 26 h) of the recorder into a fresh tracker. */
export async function trackerFromRecorder(db: DatabaseSync, opts: Partial<ReplayOptions> & { now?: number; lookbackMs?: number } = {}): Promise<NarrativeTracker> {
  const now = opts.now ?? Date.now();
  const from = now - (opts.lookbackMs ?? 26 * 3_600_000);
  const fine = opts.tickMs ?? 300_000;
  // older history at 15-min ticks (lifecycle only needs "an hour ago" and the 24 h max), the last 2 h at the fine tick
  const split = Math.max(from, now - 2 * 3_600_000);
  const tracker = opts.tracker ?? new NarrativeTracker({ ...opts, tickMs: fine });
  if (split > from) await replayRecorder(db, { ...opts, from, to: split, tickMs: Math.max(fine, 900_000), tracker });
  return replayRecorder(db, { ...opts, from: split, to: now, tickMs: fine, tracker });
}

/**
 * A cached tracker over a recorder DB for the app surfaces (TUI panel, MCP tools, coin pane, watch rules).
 * The first refresh replays the last `lookbackMs` (26 h); later refreshes replay only the rows since the last
 * tick onto the same tracker, so ids stay stable for the life of the process and a refresh costs one interval.
 */
export class RecorderNarratives {
  private tr: NarrativeTracker | null = null;
  private lastT = 0;
  private busy: Promise<NarrativeTracker> | null = null;
  private db: DatabaseSync;
  private opts: TrackerOptions & { lookbackMs?: number; minRefreshMs?: number; yieldMs?: number };
  constructor(db: DatabaseSync, opts: TrackerOptions & { lookbackMs?: number; minRefreshMs?: number; yieldMs?: number } = {}) { this.db = db; this.opts = opts; }

  get tracker(): NarrativeTracker | null { return this.tr; }

  async refresh(now = Date.now()): Promise<NarrativeTracker> {
    if (this.busy) return this.busy;
    if (this.tr && now - this.lastT < (this.opts.minRefreshMs ?? 60_000)) return this.tr;
    this.busy = (async () => {
      const from = this.tr ? this.lastT : now - (this.opts.lookbackMs ?? 26 * 3_600_000);
      const tickMs = this.opts.tickMs ?? 300_000;
      // replay whole ticks, then one partial tick up to now
      const yieldMs = this.opts.yieldMs ?? 40;   // keep the app's render loop alive during the first 26 h build
      this.tr = this.tr
        ? await replayRecorder(this.db, { ...this.opts, from, to: now, tickMs, tracker: this.tr, yieldMs })
        : await trackerFromRecorder(this.db, { ...this.opts, now, lookbackMs: this.opts.lookbackMs, tickMs, yieldMs });
      this.lastT = now;
      return this.tr;
    })();
    try { return await this.busy; } finally { this.busy = null; }
  }
}
