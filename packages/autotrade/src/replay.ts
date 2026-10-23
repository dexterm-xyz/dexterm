// dexterm autotrade — the replay tape (task-1498 spike, AUTOTRADE-SPEC §3).
//
// A tape is recorded market history in time order: one row per (mint, t) taken from the recorder's
// `token_snapshots` (the app's own SQLite file, read-only). The same MarketTick type feeds the live screener
// daemon, the paper runner, the monitor and the backtester, so a backtest replays exactly what a live run
// would have seen. `tapeFromDb` extracts one; `saveTape` / `loadTape` keep a compact committed fixture.
//
// Honest limits of the recorded data (written into every report): rows are written on material change
// (≥ 5 % price/liquidity) or every 30 min, at the app's ~2-minute refresh cadence, and only while a coin is on
// a screen, plus sweep re-observations at 1 h…72 h. A gap therefore means "moved less than ~5 %" while the coin
// was listed, and "unknown" after it left. There are no trades or holder lists in the history.
//
// task-1504: where the recorder's tick lane ran (`autotrade_ticks`: a sample every 5–10 s for watchlist / open /
// candidate / held coins), `tapeFromDb` merges those samples in tape order (t, a snapshot row before a tick at the
// same t). A tick carries price, liquidity, mcap and the 5 m / 1 h windows; the slower fields (24 h windows, holders,
// top-10, dev, authorities, organic score) are carried forward from the mint's latest earlier snapshot, never from a
// later one, and the resolved mcap is scaled by the price move. Coins without ticks replay exactly as before.

import { readFileSync, writeFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { Launchpad } from '@dexterm/data';
import { deriveFlags, type ScreenerRow } from '../../cli/src/screener/rows.ts';

export const TAPE_SCHEMA = 'dexterm-autotrade-tape/1';

export interface MarketTick {
  mint: string;
  t: number;
  /** 'live' = observed while listed; 'sweep' = an outcome re-observation after the coin left the screen. */
  kind: 'live' | 'sweep';
  symbol: string;
  launchpad: Launchpad;
  createdAt: number | null;
  price: number | null;
  mcap: number | null;
  mcapResolved: number | null;
  mcapFlagged: boolean;
  liq: number | null;
  vol5m: number | null;
  vol1h: number | null;
  vol24: number | null;
  buys5m: number | null;
  sells5m: number | null;
  buys24: number | null;
  sells24: number | null;
  chg5m: number | null;
  chg1h: number | null;
  chg6h: number | null;
  chg24h: number | null;
  holders: number | null;
  top10: number | null;
  dev: number | null;
  mintAuth: boolean | null;
  freezeAuth: boolean | null;
  org: number | null;
}

/** Column order of a committed tape row (compact arrays keep fixtures small). */
export const TAPE_COLUMNS = [
  't', 'kind', 'price', 'mcap', 'mcapResolved', 'mcapFlagged', 'liq', 'vol5m', 'vol1h', 'vol24', 'buys5m', 'sells5m', 'buys24', 'sells24',
  'chg5m', 'chg1h', 'chg6h', 'chg24h', 'holders', 'top10', 'dev', 'mintAuth', 'freezeAuth', 'org',
] as const;

export interface TapeMint { mint: string; symbol: string; launchpad: Launchpad; createdAt: number | null; rows: unknown[][] }
export interface TapeDoc {
  schema: typeof TAPE_SCHEMA;
  source: string;
  extractedAt: string;
  window: { from: number; to: number };
  note: string;
  columns: readonly string[];
  mints: TapeMint[];
}

export interface Tape { source: string; ticks: MarketTick[]; mints: string[] }

const SIG = 6;
const sig = (x: number | null): number | null => (x === null || !Number.isFinite(x) ? null : Number(x.toPrecision(SIG)));
const bool = (x: unknown): boolean | null => (x === null || x === undefined ? null : Boolean(x));
const numOrNull = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

export interface ExtractOpts {
  since?: number;
  until?: number;
  /** Only mints whose highest live liquidity reached this (strategies below it never match anyway). */
  minPeakLiqUsd?: number;
  /** Only mints with at least this many live rows (a price path, not a single sighting). */
  minLiveRows?: number;
  maxMints?: number;
  /** Keep rows up to this long after a mint's first live row. */
  spanHours?: number;
  mints?: string[];
  /** task-1504: merge `autotrade_ticks` samples (default true; a DB without the table has none). */
  ticks?: boolean;
}

const SNAP_COLS = `t, kind, symbol, launchpad, created_at, pair_created_at, price_usd, mcap, mcap_resolved, mcap_flagged, liquidity_usd,
            vol_m5, vol_h1, vol_h24, buys_m5, sells_m5, buys_h24, sells_h24, chg_m5, chg_h1, chg_h6, chg_h24,
            holder_count, top_holders_pct, dev_pct, mint_auth_enabled, freeze_auth_enabled, organic_score`;

function hasTicks(db: DatabaseSync, since: number, until: number): boolean {
  const t = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'autotrade_ticks'").get();
  return !!t && !!db.prepare('SELECT 1 FROM autotrade_ticks WHERE t >= ? AND t <= ? LIMIT 1').get(since, until);
}

/**
 * Merge a mint's snapshot rows (time order) with its tick rows (time order) into snapshot-shaped rows: a tick takes
 * its own price / liquidity / mcap / 5 m + 1 h windows and carries the rest forward from the latest snapshot at or
 * before it (null before the first one).
 */
function mergeTicks(snaps: Record<string, unknown>[], ticks: Record<string, unknown>[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  let i = 0;
  let base: Record<string, unknown> | null = null;
  for (const k of ticks) {
    while (i < snaps.length && (snaps[i].t as number) <= (k.t as number)) { base = snaps[i]; out.push(snaps[i++]); }
    const price = numOrNull(k.price_usd);
    const basePrice = base ? numOrNull(base.price_usd) : null;
    const baseResolved = base ? numOrNull(base.mcap_resolved) : null;
    out.push({
      t: k.t, kind: 'live',
      symbol: base?.symbol ?? null, launchpad: base?.launchpad ?? null, created_at: base?.created_at ?? null, pair_created_at: k.pair_created_at ?? base?.pair_created_at ?? null,
      price_usd: price, mcap: numOrNull(k.mcap),
      mcap_resolved: baseResolved !== null && basePrice && price !== null ? baseResolved * (price / basePrice) : null,
      mcap_flagged: base?.mcap_flagged ?? 0, liquidity_usd: numOrNull(k.liquidity_usd),
      vol_m5: k.vol_m5, vol_h1: k.vol_h1, vol_h24: base?.vol_h24 ?? null, buys_m5: k.buys_m5, sells_m5: k.sells_m5, buys_h24: base?.buys_h24 ?? null, sells_h24: base?.sells_h24 ?? null,
      chg_m5: k.chg_m5, chg_h1: k.chg_h1, chg_h6: base?.chg_h6 ?? null, chg_h24: base?.chg_h24 ?? null,
      holder_count: base?.holder_count ?? null, top_holders_pct: base?.top_holders_pct ?? null, dev_pct: base?.dev_pct ?? null,
      mint_auth_enabled: base?.mint_auth_enabled ?? null, freeze_auth_enabled: base?.freeze_auth_enabled ?? null, organic_score: base?.organic_score ?? null,
    });
  }
  while (i < snaps.length) out.push(snaps[i++]);
  return out;
}

/**
 * Extract a tape from the recorder tables (read-only handle from `openHistoryReadOnly`): `token_snapshots` and, where
 * the tick lane ran, `autotrade_ticks` (task-1504), in tape order. A mint qualifies on its live rows of either kind.
 */
export function tapeFromDb(db: DatabaseSync, opts: ExtractOpts = {}): TapeDoc {
  const since = opts.since ?? 0;
  const until = opts.until ?? Number.MAX_SAFE_INTEGER;
  const minLive = opts.minLiveRows ?? 20;
  const minPeak = opts.minPeakLiqUsd ?? 20_000;
  const span = (opts.spanHours ?? 24) * 3600e3;
  const withTicks = opts.ticks !== false && hasTicks(db, since, until);
  // Without ticks in the window the pick is the exact pre-1504 query, so earlier backtests reproduce bit for bit.
  const picked = opts.mints ?? (db.prepare(withTicks
    ? `SELECT mint, SUM(n) AS n, MAX(peak) AS peak, MIN(first) AS first FROM (
         SELECT mint, COUNT(*) AS n, MAX(liquidity_usd) AS peak, MIN(t) AS first FROM token_snapshots
           WHERE kind = 'live' AND t >= ? AND t <= ? AND price_usd > 0 GROUP BY mint
         UNION ALL
         SELECT mint, COUNT(*) AS n, MAX(liquidity_usd) AS peak, MIN(t) AS first FROM autotrade_ticks
           WHERE t >= ? AND t <= ? AND price_usd > 0 GROUP BY mint
       ) GROUP BY mint HAVING n >= ? AND peak >= ? ORDER BY first, mint LIMIT ?`
    : `SELECT mint, COUNT(*) AS n, MAX(liquidity_usd) AS peak, MIN(t) AS first FROM token_snapshots
       WHERE kind = 'live' AND t >= ? AND t <= ? AND price_usd > 0 GROUP BY mint
       HAVING n >= ? AND peak >= ? ORDER BY first LIMIT ?`,
  ).all(...(withTicks ? [since, until, since, until] : [since, until]), minLive, minPeak, opts.maxMints ?? 100_000) as { mint: string }[]).map((r) => r.mint);
  const rowsQ = db.prepare(`SELECT ${SNAP_COLS} FROM token_snapshots WHERE mint = ? AND t >= ? AND t <= ? ORDER BY t, snap_id`);
  const ticksQ = withTicks ? db.prepare(
    `SELECT t, price_usd, liquidity_usd, mcap, vol_m5, vol_h1, buys_m5, sells_m5, chg_m5, chg_h1, pair_created_at
       FROM autotrade_ticks WHERE mint = ? AND t >= ? AND t <= ? ORDER BY t`,
  ) : null;
  // The carry-forward base may sit before `since`: the mint's latest snapshot at or before the window start.
  const baseQ = withTicks ? db.prepare(`SELECT ${SNAP_COLS} FROM token_snapshots WHERE mint = ? AND t < ? ORDER BY t DESC, snap_id DESC LIMIT 1`) : null;
  const mints: TapeMint[] = [];
  let from = Number.MAX_SAFE_INTEGER, to = 0;
  for (const mint of picked) {
    let rs = rowsQ.all(mint, since, until) as Record<string, unknown>[];
    if (ticksQ) {
      const ks = ticksQ.all(mint, since, until) as Record<string, unknown>[];
      if (ks.length) {
        const prior = baseQ!.get(mint, since) as Record<string, unknown> | undefined;
        rs = mergeTicks(prior ? [prior, ...rs] : rs, ks);
        if (prior) rs = rs.filter((r) => r !== prior);
      }
    }
    const first = rs.find((r) => r.kind === 'live');
    if (!first) continue;
    const t0 = first.t as number;
    const kept = rs.filter((r) => (r.t as number) >= t0 && (r.t as number) <= t0 + span && numOrNull(r.price_usd) !== null);
    if (!kept.length) continue;
    // Identity from the first row that has one (a mint seen by ticks before any snapshot has none on its first row).
    const named = rs.find((r) => r.symbol !== null && r.symbol !== undefined) ?? first;
    const created = numOrNull(named.created_at) ?? numOrNull(first.created_at) ?? numOrNull(first.pair_created_at);
    mints.push({
      mint,
      symbol: String(named.symbol ?? '?').slice(0, 16),
      launchpad: (String(named.launchpad ?? 'unknown') as Launchpad),
      createdAt: created,
      rows: kept.map((r) => [
        r.t, r.kind, sig(numOrNull(r.price_usd)), sig(numOrNull(r.mcap)), sig(numOrNull(r.mcap_resolved)), r.mcap_flagged ? 1 : 0, sig(numOrNull(r.liquidity_usd)),
        sig(numOrNull(r.vol_m5)), sig(numOrNull(r.vol_h1)), sig(numOrNull(r.vol_h24)), numOrNull(r.buys_m5), numOrNull(r.sells_m5), numOrNull(r.buys_h24), numOrNull(r.sells_h24),
        sig(numOrNull(r.chg_m5)), sig(numOrNull(r.chg_h1)), sig(numOrNull(r.chg_h6)), sig(numOrNull(r.chg_h24)),
        numOrNull(r.holder_count), sig(numOrNull(r.top_holders_pct)), sig(numOrNull(r.dev_pct)),
        r.mint_auth_enabled === null ? null : r.mint_auth_enabled ? 1 : 0, r.freeze_auth_enabled === null ? null : r.freeze_auth_enabled ? 1 : 0, sig(numOrNull(r.organic_score)),
      ]),
    });
    from = Math.min(from, kept[0].t as number);
    to = Math.max(to, kept[kept.length - 1].t as number);
  }
  return {
    schema: TAPE_SCHEMA,
    source: withTicks ? 'recorder token_snapshots + autotrade_ticks (read-only)' : 'recorder token_snapshots (read-only)',
    extractedAt: new Date().toISOString(),
    window: { from: mints.length ? from : 0, to },
    note: withTicks
      ? 'Change-driven rows while listed, sweep re-observations, and 5-10 s tick samples for focus coins (slow fields carried forward). No trades.'
      : 'Change-driven rows at the app refresh cadence while listed, plus sweep re-observations. No candles or trades.',
    columns: TAPE_COLUMNS,
    mints,
  };
}

export function saveTape(path: string, doc: TapeDoc): void {
  // One mint row array per line: diffable and still small.
  const head = { ...doc, mints: undefined };
  const lines = doc.mints.map((m) => `    ${JSON.stringify(m)}`).join(',\n');
  const json = JSON.stringify(head, null, 2).replace(/\n}$/, `,\n  "mints": [\n${lines}\n  ]\n}\n`);
  writeFileSync(path, json);
}

export function readTapeDoc(path: string | URL): TapeDoc {
  const doc = JSON.parse(readFileSync(path, 'utf8')) as TapeDoc;
  if (doc.schema !== TAPE_SCHEMA) throw new Error(`not a ${TAPE_SCHEMA} file`);
  return doc;
}

/** Expand a tape document into ticks in deterministic time order (t, then mint). */
export function tapeFromDoc(doc: TapeDoc): Tape {
  const col = new Map(doc.columns.map((c, i) => [c, i]));
  const at = (r: unknown[], k: (typeof TAPE_COLUMNS)[number]): unknown => r[col.get(k) ?? -1];
  const ticks: MarketTick[] = [];
  for (const m of doc.mints) {
    for (const r of m.rows) {
      ticks.push({
        mint: m.mint, t: at(r, 't') as number, kind: at(r, 'kind') === 'sweep' ? 'sweep' : 'live',
        symbol: m.symbol, launchpad: m.launchpad, createdAt: m.createdAt,
        price: numOrNull(at(r, 'price')), mcap: numOrNull(at(r, 'mcap')), mcapResolved: numOrNull(at(r, 'mcapResolved')), mcapFlagged: Boolean(at(r, 'mcapFlagged')),
        liq: numOrNull(at(r, 'liq')), vol5m: numOrNull(at(r, 'vol5m')), vol1h: numOrNull(at(r, 'vol1h')), vol24: numOrNull(at(r, 'vol24')),
        buys5m: numOrNull(at(r, 'buys5m')), sells5m: numOrNull(at(r, 'sells5m')), buys24: numOrNull(at(r, 'buys24')), sells24: numOrNull(at(r, 'sells24')),
        chg5m: numOrNull(at(r, 'chg5m')), chg1h: numOrNull(at(r, 'chg1h')), chg6h: numOrNull(at(r, 'chg6h')), chg24h: numOrNull(at(r, 'chg24h')),
        holders: numOrNull(at(r, 'holders')), top10: numOrNull(at(r, 'top10')), dev: numOrNull(at(r, 'dev')),
        mintAuth: bool(at(r, 'mintAuth')), freezeAuth: bool(at(r, 'freezeAuth')), org: numOrNull(at(r, 'org')),
      });
    }
  }
  ticks.sort((a, b) => a.t - b.t || (a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0));
  return { source: doc.source, ticks, mints: doc.mints.map((m) => m.mint) };
}

export const loadTape = (path: string | URL): Tape => tapeFromDoc(readTapeDoc(path));

/** The screener's row shape for a tick, so strategies reuse the exact filter grammar of the screen. */
export function tickRow(k: MarketTick): ScreenerRow {
  const base = { mintAuth: k.mintAuth, freezeAuth: k.freezeAuth, top10: k.top10, dev: k.dev, bundled: null, lpLocked: k.launchpad === 'pump.fun' ? 100 : null };
  return {
    mint: k.mint, symbol: k.symbol, name: '', launchpad: k.launchpad,
    price: k.price, mcap: k.mcap, mcapFlagged: k.mcapFlagged, fdv: null, liq: k.liq,
    vol24: k.vol24, vol6h: null, vol1h: k.vol1h, vol5m: k.vol5m,
    ageMin: k.createdAt ? Math.max(0, (k.t - k.createdAt) / 60000) : null,
    holders: k.holders, holders24: null, holdersChgPct: null,
    chg: { m5: k.chg5m, h1: k.chg1h, h6: k.chg6h, h24: k.chg24h }, spark: undefined,
    buys: k.buys24, sells: k.sells24, org: k.org, ...base, snipers: null, flags: deriveFlags(base),
    verified: false, sus: false, bonding: null, pair: null, sources: [], stale: k.kind === 'sweep', fetchedAt: k.t, aiNote: null, image: null,
  };
}
