// dexterm history recorder: retention under a DB cap (task-1504, AUTOTRADE-SPEC §3 + §10 Q4).
//
// Before this, the collector's only answer to a full disk was to PAUSE observation above `--max-db-mb`, while the
// outcome sweeps kept writing: the cap stopped exactly the rows autotrade needs and the DB still grew past it.
// This module keeps the DB under the cap by EVICTING the oldest recorder history instead, so observation never
// pauses:
//
//   age       ticks after `ticksDays` (14), sampled candles after `candlesDays` (90). Snapshot / feed-member /
//             sweep rows keep the recorder's existing `columnsDays` rule (recorder.ts prune; Q4's "prune raw rows
//             older than 14 days" is `columnsDays: 14`).
//   reclaim   (optional) once the cap is reached, the host's cheap space goes first: the collector passes the data
//             layer's own expired-cache prune (`Cache.prune()`, entries a day past their TTL), measured on
//             2026-10-21 at ~470 MB of a 1,173 MB file that only held ~430 MB of recorder history.
//   cap       once the DB's USED bytes (pages minus the freelist) reach `highWater` × `maxBytes`, delete the
//             oldest slice of history (`sliceMs`, all recorder tables: ticks, candles, snapshots incl. sweep rows,
//             feed members; the small sweep ledger keeps its age rule) and repeat until used ≤ `lowWater` × `maxBytes`. Rows newer than
//             `keepMs` are never evicted. Outcomes, verdicts and creators are tiny and stay forever.
//
// SQLite does not shrink the file on DELETE: freed pages go to the freelist and new rows reuse them. So the file
// stops growing at about the high-water mark; a file that is ALREADY above the cap stays that size (only
// `VACUUM`, with the collector stopped, gives the space back) but no longer grows.

import type { DatabaseSync } from 'node:sqlite';

export interface CapPolicy {
  /** Cap on the DB's used bytes; null = no cap (age rules only). */
  maxBytes: number | null;
  /** Start evicting at this fraction of the cap (default 0.95). */
  highWater: number;
  /** Evict down to this fraction of the cap (default 0.85). */
  lowWater: number;
  /** One eviction step removes this much of the oldest history (default 1 h). */
  sliceMs: number;
  /** Never evict rows newer than this (default 1 h): the coins on screen keep their recent path. */
  keepMs: number;
  /** At most this many slices per pass, so a pass never stalls the collector (default 500). */
  maxSlices: number;
  /** Called once per pass when the cap is reached, before any history is evicted; returns rows it freed. */
  reclaim?: () => number;
}

export interface AgePolicy {
  ticksDays: number;
  candlesDays: number;
}

export const DEFAULT_CAP: CapPolicy = { maxBytes: null, highWater: 0.95, lowWater: 0.85, sliceMs: 3_600_000, keepMs: 3_600_000, maxSlices: 500 };
export const DEFAULT_AGE: AgePolicy = { ticksDays: 14, candlesDays: 90 };
/** The Q4 default cap when retention-by-cap is switched on (3 GB). */
export const DEFAULT_CAP_BYTES = 3_000_000_000;

/** Tables the cap may evict from, each with its time column. */
const EVICTABLE: readonly { table: string; col: string }[] = [
  { table: 'autotrade_ticks', col: 't' },
  { table: 'autotrade_candles_1m', col: 't' },
  { table: 'exit_probes', col: 't' },
  { table: 'token_snapshots', col: 't' },
  { table: 'feed_members', col: 't' },
];

export interface DbSize {
  /** The file as SQLite sees it (page_count × page_size). */
  fileBytes: number;
  /** In use (the file minus freelist pages): what new rows grow. */
  usedBytes: number;
}

export function dbSize(db: DatabaseSync): DbSize {
  const one = (sql: string): number => Number(Object.values(db.prepare(sql).get() as Record<string, number>)[0]);
  const ps = one('PRAGMA page_size');
  const pc = one('PRAGMA page_count');
  const fl = one('PRAGMA freelist_count');
  return { fileBytes: pc * ps, usedBytes: (pc - fl) * ps };
}

export interface CapResult {
  /** True when the cap was checked and eviction ran. */
  evicted: boolean;
  usedBefore: number;
  usedAfter: number;
  fileBytes: number;
  slices: number;
  /** Rows the `reclaim` hook freed. */
  reclaimed: number;
  /** Rows deleted per table. */
  deleted: Record<string, number>;
  /** Oldest kept time after the pass (null when nothing was evicted). */
  cutoff: number | null;
  /** Still above the high-water mark after the pass (only rows newer than keepMs left, or maxSlices hit). */
  over: boolean;
}

/**
 * Enforce the cap: a no-op below the high-water mark; above it, delete the oldest `sliceMs` of history across every
 * evictable table, one transaction per slice, until used ≤ the low-water mark. Never deletes rows newer than
 * `now - keepMs`. Outcome / verdict / creator rows are never touched.
 */
export function enforceCap(db: DatabaseSync, policy: Partial<CapPolicy>, now: number): CapResult {
  const p = { ...DEFAULT_CAP, ...policy };
  const size0 = dbSize(db);
  const res: CapResult = { evicted: false, usedBefore: size0.usedBytes, usedAfter: size0.usedBytes, fileBytes: size0.fileBytes, slices: 0, reclaimed: 0, deleted: {}, cutoff: null, over: false };
  if (p.maxBytes === null || p.maxBytes <= 0 || size0.usedBytes < p.highWater * p.maxBytes) return res;
  res.evicted = true;
  const target = p.lowWater * p.maxBytes;
  const floor = now - p.keepMs;
  const tables = EVICTABLE.filter((e) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(e.table));
  const oldestQ = tables.map((e) => ({ ...e, q: db.prepare(`SELECT MIN(${e.col}) AS m FROM ${e.table}`), del: db.prepare(`DELETE FROM ${e.table} WHERE ${e.col} < ?`) }));
  const delMints = db.prepare('DELETE FROM mints WHERE last_any_t < ?');
  let used = size0.usedBytes;
  if (p.reclaim) { res.reclaimed = p.reclaim(); used = dbSize(db).usedBytes; }
  while (used > target && res.slices < p.maxSlices) {
    let oldest = Infinity;
    for (const e of oldestQ) { const m = (e.q.get() as { m: number | null }).m; if (m !== null && Number(m) < oldest) oldest = Number(m); }
    if (!Number.isFinite(oldest) || oldest >= floor) break;
    const cutoff = Math.min(oldest + p.sliceMs, floor);
    db.exec('BEGIN');
    try {
      for (const e of oldestQ) res.deleted[e.table] = (res.deleted[e.table] ?? 0) + Number(e.del.run(cutoff).changes);
      res.deleted.mints = (res.deleted.mints ?? 0) + Number(delMints.run(cutoff).changes);
      db.exec('COMMIT');
    } catch (err) { db.exec('ROLLBACK'); throw err; }
    res.slices++;
    res.cutoff = cutoff;
    used = dbSize(db).usedBytes;
  }
  const size1 = dbSize(db);
  res.usedAfter = size1.usedBytes;
  res.fileBytes = size1.fileBytes;
  res.over = size1.usedBytes >= p.highWater * p.maxBytes;
  return res;
}

/** Age rules for the autotrade tables (the recorder's prune() calls this next to its own snapshot rules). */
export function pruneTicksByAge(db: DatabaseSync, policy: Partial<AgePolicy>, now: number): { ticks: number; candles: number } {
  const p = { ...DEFAULT_AGE, ...policy };
  const day = 86_400_000;
  const ticks = Number(db.prepare('DELETE FROM autotrade_ticks WHERE t < ?').run(now - p.ticksDays * day).changes);
  // task-1786: exit probes age out with the ticks they were sized on.
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'exit_probes'").get()) db.prepare('DELETE FROM exit_probes WHERE t < ?').run(now - p.ticksDays * day);
  const candles = Number(db.prepare('DELETE FROM autotrade_candles_1m WHERE t < ?').run(now - p.candlesDays * day).changes);
  return { ticks, candles };
}
