// dexterm history recorder: exit probes (task-1786, research/winner-recall-2026-10/DATA-GAPS.md item 2). DexScreener's
// `liquidity.usd` says a pool is there; it does not say the coin can be sold (the control's $NOTHING ran, sold TP1, then
// sat at liquidity $0 with no route). This lane asks Jupiter, once a minute per HELD focus coin, for a keyless sell
// quote of a fixed USD size (default $50 at the last tick price) into SOL and writes what came back: the SOL out, the
// price impact and the hop count, or the error ("no route" is the drain). Quotes only: nothing is built, signed or sent.
//
//   who       focus coins with role 'held' (the tick lane's focus: the collector's DB, focus files, the focus module)
//   cadence   one quote per coin per `everyMs` (60 s), at most `maxPerPoll` (1) per poll and `maxPerMinute` (4) in any
//             60 s whatever the number of held coins (the IP's keyless Jupiter budget is shared with the feed and with
//             any process that sells); a per-UTC-day ceiling on top
//   budget    the data layer's shared keyless `jupiter` bucket at 'high' priority: the feed's own Jupiter calls keep
//             that bucket's queue minutes long, so a 'low' or 'normal' probe times out behind them (task-1786 smoke);
//             'high' only jumps the queue, the bucket's 60 s ceiling is unchanged. Skipped while it is paused (429)
//             A quote may wait up to 75 s (one full window) for a slot; the host runs it detached from the ticks.
//   sizing    tokens = usd / the coin's last tick price, in base units (decimals from the cached mint info)
//
// Retention: rows go with the ticks (14 days) and the cap may evict them (retention.ts).

import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { HttpError, withPriority, systemClock, type Clock, type DataLayer, type RateLimiter } from '@dexterm/data';
import { mergeFocus, type FocusEntry } from './ticks.ts';

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

export interface ExitProbePolicy {
  /** One quote per held coin at most this often (default 60 s). */
  everyMs: number;
  /** Quotes per poll at most (default 1; the host polls every 5 s). */
  maxPerPoll: number;
  /** Quotes in any 60 s at most, all coins together (default 4). */
  maxPerMinute: number;
  /** USD size of the probe sell (default 50). */
  usd: number;
  slippageBps: number;
  /** Per-UTC-day ceiling on quotes (default 8,000 ≈ 5.5 a minute). */
  maxCallsPerDay: number;
}

export const DEFAULT_EXIT_PROBES: ExitProbePolicy = { everyMs: 60_000, maxPerPoll: 1, maxPerMinute: 4, usd: 50, slippageBps: 500, maxCallsPerDay: 8_000 };

/** The two data-layer calls the lane makes, injected (tests pass fakes). */
export interface ExitProbeDeps {
  quote(req: { inputMint: string; outputMint: string; amount: bigint; slippageBps: number }, signal?: AbortSignal): Promise<{ outAmount: bigint; priceImpactPct?: number | null; routeHops?: number }>;
  decimals(mint: string): Promise<number>;
  limiter: RateLimiter;
}

export interface ExitProbeResult { probed: number; ok: number; failed: number; /** Transient misses (our limiter, a timeout, a 429/5xx): no row, retried next minute. */ deferred?: number; skipped: 'no-held' | 'not-due' | 'paused' | 'in-flight' | 'day-cap' | 'minute-cap' | null }

const fin = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));
/** Message-text fallback for errors that carry no status (a dropped socket, DNS, our own limiter). Never applied to
 *  an `HttpError`: its message embeds the quote URL (`slippageBps=500`, the amount), so a digit pattern matches every
 *  answer (verify-1791). URLs are stripped before the test either way. */
export const TRANSIENT_PROBE_ERROR = /rate.?limit|abort|timed? ?out|timeout|ECONN|ENOTFOUND|EAI_AGAIN|fetch failed|network|unavailable|paused/i;
const URL_RE = /https?:\/\/\S+/g;
/** The error text for a row: query strings dropped (the mint and amount are columns already), cut to 200 chars. */
export const probeErrorText = (err: unknown): string => msg(err).replace(URL_RE, (u) => u.replace(/[?#][^\s)]*/, '')).slice(0, 200);

/** A miss that says nothing about the coin, so no row is written and the coin is retried next minute: a 429 or 5xx,
 *  a 401/403/408, a non-JSON answer, our own limiter or health gate, a timeout or abort, the network. Anything else (any other
 *  4xx, or a 2xx carrying an `error` such as "No routes found") means Jupiter answered and had no quote for this
 *  sell, which is the drain signal: an `error` row. Classified on the error's type and status, not its text. */
export function isTransientProbeError(err: unknown): boolean {
  if (err instanceof HttpError || (err instanceof Error && err.name === 'HttpError')) {
    const status = Number((err as { status?: unknown }).status);
    // 401/403: a keyless refusal of this IP (the hosts already failed over); 408: the server's timeout. Not the coin.
    if (status === 401 || status === 403 || status === 408 || status === 429 || (status >= 500 && status <= 599) || !(status > 0)) return true;
    return /^invalid JSON from /.test(err.message);
  }
  if (!(err instanceof Error)) return TRANSIENT_PROBE_ERROR.test(String(err).replace(URL_RE, ''));
  if (['AbortError', 'TimeoutError', 'JupiterRateLimitedError', 'SourceUnavailableError', 'RateDeferredError'].includes(err.name)) return true;
  if (err instanceof TypeError) return true; // undici's `fetch failed` (DNS, reset, refused)
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && /^(ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|UND_ERR)/.test(code)) return true;
  return TRANSIENT_PROBE_ERROR.test(err.message.replace(URL_RE, ''));
}

/**
 * The lane's deps over a live data layer (the collector's `record run --exit-probes`).
 *
 * A no-route answer (a 4xx such as 400 COULD_NOT_FIND_ANY_ROUTE, or a 200 carrying an `error`) is a real answer from
 * Jupiter about ONE coin, but the HTTP client records it as a `jupiter-swap` health failure. Three in a row (or one
 * while probing) degrade the source, and the gate then refuses every later quote as `JupiterRateLimitedError(0)`: the
 * drain signal muted the lane and every healthy held coin with it (verify-1795). So after an answer like that, the
 * adapter records the source as answering (`ok`). A 429, 5xx, timeout or network miss is left alone, so the gate
 * still backs off on real rate limits.
 * Collector-only: in that process nothing else quotes on `jupiter-swap`, and the shared data layer's behaviour is
 * unchanged for every other caller (the challenge, the TUI).
 */
export function exitProbeDeps(dl: Pick<DataLayer, 'jupiterSwap' | 'detail' | 'limiter' | 'health'>): ExitProbeDeps {
  return {
    async quote(req, signal) {
      try {
        const q = await dl.jupiterSwap.quote(req, signal);
        return { outAmount: q.outAmount, priceImpactPct: q.priceImpactPct, routeHops: q.route.length };
      } catch (err) {
        if (err instanceof HttpError && !isTransientProbeError(err)) dl.health.record('jupiter-swap', { ok: true });
        throw err;
      }
    },
    decimals: async (mint) => (await dl.detail.mintInfo(mint)).value.decimals,
    limiter: dl.limiter,
  };
}

export class ExitProbeLane {
  readonly policy: ExitProbePolicy;
  private readonly db: DatabaseSync;
  private readonly focus: () => Iterable<FocusEntry>;
  private readonly clock: Clock;
  private readonly onLog?: (line: string) => void;
  private readonly last = new Map<string, number>();
  private readonly dec = new Map<string, number>();
  private polling = false;
  /** Times of the quotes sent in the last minute (the `maxPerMinute` window). */
  private recent: number[] = [];
  private day = '';
  private dayCalls = 0;
  readonly counters = { probes: 0, ok: 0, failed: 0 };
  private readonly stmts: { insert: StatementSync; price: StatementSync; meta: StatementSync };

  constructor(db: DatabaseSync, opts: { focus: () => Iterable<FocusEntry>; policy?: Partial<ExitProbePolicy>; clock?: Clock; onLog?: (line: string) => void }) {
    this.db = db;
    this.focus = opts.focus;
    this.policy = { ...DEFAULT_EXIT_PROBES, ...opts.policy };
    this.clock = opts.clock ?? systemClock;
    this.onLog = opts.onLog;
    this.stmts = {
      insert: db.prepare(`INSERT OR IGNORE INTO exit_probes (mint, t, role, usd_in, price_usd, liquidity_usd, tokens_in, sol_out, price_impact_pct, route_hops, error)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      price: db.prepare('SELECT price_usd, liquidity_usd FROM autotrade_ticks WHERE mint = ? AND price_usd IS NOT NULL ORDER BY t DESC LIMIT 1'),
      meta: db.prepare("INSERT OR REPLACE INTO recorder_meta (key, value) VALUES ('exit_probe_calls', ?)"),
    };
  }

  callsToday(now = this.clock.now()): number {
    const day = new Date(now).toISOString().slice(0, 10);
    if (day !== this.day) {
      this.day = day;
      this.dayCalls = 0;
      const r = this.db.prepare("SELECT value FROM recorder_meta WHERE key = 'exit_probe_calls'").get() as { value: string } | undefined;
      try { const v = r ? JSON.parse(r.value) as { day: string; calls: number } : null; if (v && v.day === day) this.dayCalls = Number(v.calls) || 0; } catch { /* reset */ }
    }
    return this.dayCalls;
  }

  /** Held coins due a probe, the longest-unprobed first. */
  due(now = this.clock.now()): FocusEntry[] {
    return mergeFocus(this.focus()).filter((e) => e.role === 'held' && e.mint !== WSOL_MINT && now - (this.last.get(e.mint) ?? -Infinity) >= this.policy.everyMs)
      .sort((a, b) => (this.last.get(a.mint) ?? 0) - (this.last.get(b.mint) ?? 0));
  }

  /** One poll (the collector's tick loop calls it right after the tick poll). Never throws. */
  async poll(deps: ExitProbeDeps, now = this.clock.now()): Promise<ExitProbeResult> {
    const none = (skipped: ExitProbeResult['skipped']): ExitProbeResult => ({ probed: 0, ok: 0, failed: 0, skipped });
    if (this.polling) return none('in-flight');
    let due: FocusEntry[];
    try { due = this.due(now); } catch (err) { this.log(`exit probe focus failed: ${msg(err)}`); return none('no-held'); }
    if (!due.length) return none(mergeFocus(this.focus()).some((e) => e.role === 'held') ? 'not-due' : 'no-held');
    if (this.callsToday(now) >= this.policy.maxCallsPerDay) return none('day-cap');
    this.recent = this.recent.filter((t) => now - t < 60_000);
    if (this.recent.length >= this.policy.maxPerMinute) return none('minute-cap');
    if (deps.limiter.bucket('jupiter').stats().pausedUntil > now) return none('paused');
    this.polling = true;
    const res: ExitProbeResult = { probed: 0, ok: 0, failed: 0, skipped: null };
    try {
      for (const e of due.slice(0, Math.min(this.policy.maxPerPoll, this.policy.maxPerMinute - this.recent.length))) {
        this.last.set(e.mint, now);
        const px = this.stmts.price.get(e.mint) as { price_usd: number; liquidity_usd: number | null } | undefined;
        if (!px || !(px.price_usd > 0)) continue; // no tick price yet: nothing to size the probe with
        let tokens: bigint | null = null, solOut: number | null = null, impact: number | null = null, hops: number | null = null, error: string | null = null;
        // Decimals come from the mint-info source, not Jupiter: a failure there says nothing about selling, so defer.
        let d = this.dec.get(e.mint);
        if (d === undefined) {
          try { d = await deps.decimals(e.mint); this.dec.set(e.mint, d); } catch { res.deferred = (res.deferred ?? 0) + 1; continue; }
        }
        try {
          tokens = BigInt(Math.max(1, Math.round((this.policy.usd / px.price_usd) * 10 ** d)));
          this.dayCalls++;
          this.recent.push(now);
          this.stmts.meta.run(JSON.stringify({ day: this.day, calls: this.dayCalls }));
          const q = await withPriority('high', () => deps.quote({ inputMint: e.mint, outputMint: WSOL_MINT, amount: tokens!, slippageBps: this.policy.slippageBps }, AbortSignal.timeout(75_000)));
          solOut = Number(q.outAmount) / 1e9;
          impact = fin(q.priceImpactPct ?? null);
          hops = fin(q.routeHops ?? null);
          res.ok++;
        } catch (err) {
          if (isTransientProbeError(err)) { res.deferred = (res.deferred ?? 0) + 1; continue; }
          error = probeErrorText(err);
          res.failed++;
        }
        res.probed++;
        this.stmts.insert.run(e.mint, this.clock.now(), e.role, this.policy.usd, px.price_usd, fin(px.liquidity_usd), tokens === null ? null : tokens.toString(), solOut, impact, hops, error);
      }
    } catch (err) {
      this.log(`exit probe failed: ${msg(err)}`);
    } finally {
      this.polling = false;
      this.counters.probes += res.probed; this.counters.ok += res.ok; this.counters.failed += res.failed;
    }
    if (this.last.size > 500) for (const [m, lt] of this.last) if (now - lt > 3_600_000) this.last.delete(m);
    return res;
  }

  private log(line: string): void {
    this.onLog?.(`recorder: ${line}\n`);
  }
}
