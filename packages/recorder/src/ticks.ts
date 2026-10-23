// dexterm history recorder: position-grade ticks for autotrade (task-1504, AUTOTRADE-SPEC §3 "Data today vs what
// must be recorded"). The change-driven `token_snapshots` rows land every ~2 min at best and only on a ≥ 5 % move,
// which hides the intrabar path a stop or a take-profit lives on. This lane samples the FEW coins that matter to a
// position every 5–10 s and writes every sample:
//
//   focus      held > open > candidate > watch, one role per mint (the highest wins), at most `maxCoins`
//              (default 60 = two calls). Sources are injected: the collector reads the watchlist and the paper
//              wallet from the DB and the autotrade focus file (`focus.json`, written by the runner / the app).
//   cadence    held + open coins every `fastEveryMs` (5 s), candidate + watch every `slowEveryMs` (10 s). A call
//              that goes out anyway is topped up with coins not yet due (oldest sample first): a batch of 30
//              costs the same one request.
//   budget     DexScreener `tokens/v1` batches of 30 only (never a per-coin keyless Jupiter call), through the
//              data layer's limiter and health gate; 'normal' priority when a held/open coin is in the call,
//              'low' otherwise; skipped while the bucket is paused after a 429; a per-UTC-day call ceiling.
//   candles    every sample with a price folds into `autotrade_candles_1m` (sampled OHLC: high/low are of the
//              samples, not of every trade).
//
// No change detection and no raw JSON: a tick row is ~100 bytes. Retention (retention.ts) keeps ticks 14 days.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { withPriority, systemClock, type Clock, type DexScreener, type DsTokenView, type RateLimiter } from '@dexterm/data';

export type FocusRole = 'held' | 'open' | 'candidate' | 'watch';
/** Priority order: earlier roles are sampled first and faster. */
export const FOCUS_ROLES: readonly FocusRole[] = ['held', 'open', 'candidate', 'watch'];
export interface FocusEntry { mint: string; role: FocusRole }

export interface TickPolicy {
  /** held + open coins: one sample at most this often (default 5 s). */
  fastEveryMs: number;
  /** candidate + watch coins (default 10 s). */
  slowEveryMs: number;
  /** Coins sampled per poll at most (default 60 = 2 calls); lower-priority coins past it are counted as `overCap`. */
  maxCoins: number;
  /** Mints per DexScreener tokens/v1 call (it takes 30). */
  batch: number;
  /** Hard per-UTC-day ceiling on tick calls (default 36,000 ≈ 25 a minute, a twelfth of DexScreener's 300 rpm). */
  maxCallsPerDay: number;
}

export const DEFAULT_TICKS: TickPolicy = { fastEveryMs: 5_000, slowEveryMs: 10_000, maxCoins: 60, batch: 30, maxCallsPerDay: 36_000 };

export interface TickPollResult {
  /** Coins in the call(s) (due + topped up). */
  coins: number;
  calls: number;
  answered: number;
  written: number;
  /** Focus coins left out by `maxCoins` this poll. */
  overCap: number;
  skipped: 'disabled' | 'no-focus' | 'not-due' | 'paused' | 'in-flight' | 'day-cap' | null;
  error?: string;
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MIN = 60_000;
const fin = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const isFast = (r: FocusRole): boolean => r === 'held' || r === 'open';

/** One role per mint (the highest-priority role wins), invalid mints dropped, in priority order. */
export function mergeFocus(entries: Iterable<FocusEntry>): FocusEntry[] {
  const best = new Map<string, FocusRole>();
  for (const e of entries) {
    if (!e || typeof e.mint !== 'string' || !BASE58.test(e.mint) || !FOCUS_ROLES.includes(e.role)) continue;
    const cur = best.get(e.mint);
    if (!cur || FOCUS_ROLES.indexOf(e.role) < FOCUS_ROLES.indexOf(cur)) best.set(e.mint, e.role);
  }
  return [...best].map(([mint, role]) => ({ mint, role })).sort((a, b) => FOCUS_ROLES.indexOf(a.role) - FOCUS_ROLES.indexOf(b.role));
}

export interface TickLaneOptions {
  focus: () => Iterable<FocusEntry>;
  policy?: Partial<TickPolicy>;
  clock?: Clock;
  onLog?: (line: string) => void;
}

/** The sampler. Owns no connection: it writes through the recorder's DB handle (same file, same thread). */
export class TickLane {
  readonly policy: TickPolicy;
  private readonly db: DatabaseSync;
  private readonly focus: () => Iterable<FocusEntry>;
  private readonly clock: Clock;
  private readonly onLog?: (line: string) => void;
  /** mint -> time of its last sample this process took. */
  private readonly last = new Map<string, number>();
  private polling = false;
  private day = '';
  private dayCalls = 0;
  readonly counters = { polls: 0, calls: 0, written: 0 };
  private readonly stmts: { tick: StatementSync; candle: StatementSync; meta: StatementSync };

  constructor(db: DatabaseSync, opts: TickLaneOptions) {
    this.db = db;
    this.focus = opts.focus;
    this.policy = { ...DEFAULT_TICKS, ...opts.policy };
    this.clock = opts.clock ?? systemClock;
    this.onLog = opts.onLog;
    this.stmts = {
      tick: db.prepare(`INSERT OR IGNORE INTO autotrade_ticks (mint, t, role, price_usd, liquidity_usd, mcap, fdv, vol_m5, vol_h1, buys_m5, sells_m5, chg_m5, chg_h1, pair_address, pair_created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      candle: db.prepare(`INSERT INTO autotrade_candles_1m (mint, t, o, h, l, c, liq_c, mcap_c, n) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT(mint, t) DO UPDATE SET h = MAX(h, excluded.h), l = MIN(l, excluded.l), c = excluded.c, liq_c = excluded.liq_c, mcap_c = excluded.mcap_c, n = n + 1`),
      meta: db.prepare("INSERT OR REPLACE INTO recorder_meta (key, value) VALUES ('tick_calls', ?)"),
    };
  }

  /** Tick calls issued in the current UTC day (persisted in recorder_meta, so a restart keeps the count). */
  callsToday(now = this.clock.now()): number {
    const day = new Date(now).toISOString().slice(0, 10);
    if (day !== this.day) {
      this.day = day;
      this.dayCalls = 0;
      const r = this.db.prepare("SELECT value FROM recorder_meta WHERE key = 'tick_calls'").get() as { value: string } | undefined;
      try { const v = r ? JSON.parse(r.value) as { day: string; calls: number } : null; if (v && v.day === day) this.dayCalls = Number(v.calls) || 0; } catch { /* reset */ }
    }
    return this.dayCalls;
  }

  /**
   * Which coins this poll samples: every due coin in priority order up to `maxCoins`, then the last batch topped
   * up with coins not yet due (oldest sample first). `overCap` counts focus coins past `maxCoins`.
   */
  plan(now = this.clock.now(), maxCalls = Math.ceil(this.policy.maxCoins / this.policy.batch)): { coins: FocusEntry[]; due: number; overCap: number; focus: number } {
    const focus = mergeFocus(this.focus());
    const cap = Math.min(this.policy.maxCoins, maxCalls * this.policy.batch);
    const inCap = focus.slice(0, cap);
    const overCap = focus.length - inCap.length;
    const isDue = (e: FocusEntry): boolean => now - (this.last.get(e.mint) ?? -Infinity) >= (isFast(e.role) ? this.policy.fastEveryMs : this.policy.slowEveryMs);
    const due = inCap.filter(isDue);
    if (!due.length) return { coins: [], due: 0, overCap, focus: focus.length };
    const room = Math.ceil(due.length / this.policy.batch) * this.policy.batch - due.length;
    const ride = inCap.filter((e) => !isDue(e)).sort((a, b) => (this.last.get(a.mint) ?? 0) - (this.last.get(b.mint) ?? 0)).slice(0, room);
    return { coins: [...due, ...ride], due: due.length, overCap, focus: focus.length };
  }

  /** One poll. The host calls this every `fastEveryMs` (the collector's tick loop). Never throws. */
  async poll(deps: { dexscreener: DexScreener; limiter: RateLimiter }, now = this.clock.now()): Promise<TickPollResult> {
    const none = (skipped: TickPollResult['skipped'], overCap = 0): TickPollResult => ({ coins: 0, calls: 0, answered: 0, written: 0, overCap, skipped });
    if (this.polling) return none('in-flight');
    let budget = this.policy.maxCallsPerDay - this.callsToday(now);
    if (budget <= 0) return none('day-cap');
    let planned: ReturnType<TickLane['plan']>;
    try { planned = this.plan(now, Math.min(budget, Math.ceil(this.policy.maxCoins / this.policy.batch))); } catch (err) { this.log(`focus failed: ${msg(err)}`); return none('no-focus'); }
    if (!planned.coins.length) return none(planned.focus ? 'not-due' : 'no-focus', planned.overCap);
    if (deps.limiter.bucket('dexscreener').stats().pausedUntil > now) return none('paused', planned.overCap);
    this.polling = true;
    this.counters.polls++;
    const res: TickPollResult = { coins: planned.coins.length, calls: 0, answered: 0, written: 0, overCap: planned.overCap, skipped: null };
    try {
      for (let i = 0; i < planned.coins.length && budget > 0; i += this.policy.batch) {
        const chunk = planned.coins.slice(i, i + this.policy.batch);
        const priority = chunk.some((e) => isFast(e.role)) ? 'normal' : 'low';
        res.calls++; budget--;
        this.dayCalls++;
        this.stmts.meta.run(JSON.stringify({ day: this.day, calls: this.dayCalls }));
        const views = await withPriority(priority, () => deps.dexscreener.tokens(chunk.map((e) => e.mint)));
        const t = this.clock.now();
        const w = this.write(chunk, views, t);
        res.answered += w.answered;
        res.written += w.written;
      }
    } catch (err) {
      res.error = msg(err);
      this.log(`tick poll failed: ${res.error}`);
    } finally {
      this.polling = false;
      this.counters.calls += res.calls;
      this.counters.written += res.written;
    }
    return res;
  }

  /** Write one answered batch (one transaction): a tick per coin (NULL price when no pair came back) + candles. */
  write(chunk: readonly FocusEntry[], views: Map<string, DsTokenView>, t: number): { answered: number; written: number } {
    let answered = 0, written = 0;
    this.db.exec('BEGIN');
    try {
      for (const e of chunk) {
        this.last.set(e.mint, t);
        const p = views.get(e.mint)?.pair;
        if (p) answered++;
        const price = p ? fin(p.priceUsd) : null;
        const liq = p ? fin(p.liquidityUsd) : null;
        const mcap = p ? fin(p.mcap) : null;
        const r = this.stmts.tick.run(
          e.mint, t, e.role, price, liq, mcap, p ? fin(p.fdv) : null, p ? fin(p.volume.m5) : null, p ? fin(p.volume.h1) : null,
          p ? fin(p.txns.m5?.buys) : null, p ? fin(p.txns.m5?.sells) : null, p ? fin(p.priceChange.m5) : null, p ? fin(p.priceChange.h1) : null,
          p?.pairAddress || null, p ? fin(p.createdAt) : null,
        );
        if (Number(r.changes) > 0) written++;
        if (price !== null && price > 0 && Number(r.changes) > 0) this.stmts.candle.run(e.mint, Math.floor(t / MIN) * MIN, price, price, price, price, liq, mcap);
      }
      this.db.exec('COMMIT');
    } catch (err) { this.db.exec('ROLLBACK'); throw err; }
    // Forget coins that left the focus long ago (bounded memory over a long run).
    if (this.last.size > 4 * this.policy.maxCoins) for (const [m, lt] of this.last) if (t - lt > 3_600_000) this.last.delete(m);
    return { answered, written };
  }

  private log(line: string): void {
    this.onLog?.(`recorder: ${line}\n`);
  }
}

// ---------------------------------------------------------------- focus sources

/**
 * Focus coins the app's own DB already knows: every watchlist mint ('watch') and every paper position with a
 * token balance ('held'). Tables that do not exist yet (a fresh DB) contribute nothing.
 */
export function dbFocus(db: DatabaseSync): FocusEntry[] {
  const has = (name: string): boolean => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  const out: FocusEntry[] = [];
  if (has('watchlist')) for (const r of db.prepare('SELECT mint FROM watchlist').all() as { mint: string }[]) out.push({ mint: r.mint, role: 'watch' });
  if (has('paper_positions')) for (const r of db.prepare("SELECT mint FROM paper_positions WHERE tokens_raw NOT IN ('0', '')").all() as { mint: string }[]) out.push({ mint: r.mint, role: 'held' });
  return out;
}

/** The rendezvous file other processes (the autotrade runner, the app) publish focus coins in. */
export const FOCUS_FILE_SCHEMA = 'dexterm-autotrade-focus/1';
/** A focus file not rewritten for this long is ignored (a dead writer must not pin coins to the fast lane). */
export const FOCUS_FILE_STALE_MS = 30 * MIN;

export interface FocusFileEntry { mint: string; role: FocusRole; /** Unix ms after which the entry no longer counts. */ until?: number }
export interface FocusFileDoc { schema: typeof FOCUS_FILE_SCHEMA; updatedAt: number; entries: FocusFileEntry[] }

/** `<dexterm home>/autotrade/focus.json`. */
export const focusFilePath = (home: string): string => join(home, 'autotrade', 'focus.json');

/** Read a focus file: missing, garbled, stale or expired entries contribute nothing. Never throws. */
export function readFocusFile(path: string, now: number): FocusEntry[] {
  let doc: FocusFileDoc;
  try { doc = JSON.parse(readFileSync(path, 'utf8')) as FocusFileDoc; } catch { return []; }
  if (!doc || doc.schema !== FOCUS_FILE_SCHEMA || !Array.isArray(doc.entries) || !(now - Number(doc.updatedAt) <= FOCUS_FILE_STALE_MS)) return [];
  return mergeFocus(doc.entries.filter((e) => e && (e.until === undefined || Number(e.until) >= now)).map((e) => ({ mint: e.mint, role: e.role })));
}

/** Write a focus file atomically (tmp + rename, mode 0600). */
export function writeFocusFile(path: string, entries: readonly FocusFileEntry[], now: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const doc: FocusFileDoc = { schema: FOCUS_FILE_SCHEMA, updatedAt: now, entries: [...entries] };
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}

// ---------------------------------------------------------------- read side

export interface TickCandle { t: number; o: number; h: number; l: number; c: number; liq: number | null; mcap: number | null; n: number }

/** Sampled 1m candles for one mint, oldest first (read-only use). */
export function candlesFromDb(db: DatabaseSync, mint: string, from = 0, to = Number.MAX_SAFE_INTEGER): TickCandle[] {
  return (db.prepare('SELECT t, o, h, l, c, liq_c, mcap_c, n FROM autotrade_candles_1m WHERE mint = ? AND t >= ? AND t <= ? ORDER BY t').all(mint, from, to) as Record<string, number | null>[])
    .map((r) => ({ t: Number(r.t), o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), liq: r.liq_c ?? null, mcap: r.mcap_c ?? null, n: Number(r.n) }));
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
