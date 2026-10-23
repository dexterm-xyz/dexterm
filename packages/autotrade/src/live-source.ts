// dexterm autotrade — Store-fed MarketTicks for a live paper run (task-1505 AT-3, AUTOTRADE-SPEC §4 "Daemon").
//
// The same data layer as the TUI, so the runner screens exactly what the screener shows:
//   pool       Store.discover(preset, …, {max}) every `discoverEveryMs` (60 s; the feeds are list calls, keyless
//              pacing applies), then Store.enrich(pool) every `refreshMs` (10 s). Enrich serves DexScreener pairs from
//              the shared cache (TTL 10 s) and Jupiter records from the cache only, so a refresh never queues behind the
//              keyless Jupiter bucket.
//   fast lane  candidate and held coins every `fastMs` (5 s) straight from DexScreener `tokens/v1`, batches of 30
//              (never per-coin Jupiter calls: keyless Jupiter allows about 5 per 10 s per IP), under a daily call
//              ceiling. The slow fields a pair does not carry (holders, top 10, dev share, authorities, organic score)
//              are carried from the coin's last pool row, the way the recorder's tick lane does.
//
// Every row becomes the MarketTick a recorded tape would hold for it (same fields, same nulls), in time order. A row
// whose data did not change since the last tick of that coin (same fetch) is not emitted twice.

import type { DsTokenView, EnrichedRow, Launchpad, Preset } from '@dexterm/data';
import type { FocusMark } from './runner.ts';
import type { MarketTick } from './replay.ts';

const fin = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean | null => (v === null || v === undefined ? null : Boolean(v));

/** Display-safe symbol (control, bidi and zero-width code points dropped, 16 chars); the firewall still wraps it for a model. */
export function cleanSymbol(s: unknown): string {
  let out = '';
  for (const ch of String(s ?? '').normalize('NFC')) {
    const cp = ch.codePointAt(0) as number;
    if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0x2060 || cp === 0xfeff) continue;
    if ((cp >= 0x200e && cp <= 0x200f) || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)) continue;
    out += ch;
  }
  out = out.replace(/\s+/g, ' ').trim();
  return out.length > 16 ? `${out.slice(0, 16)}…` : out;
}

/** A screener row as a tape tick (`t` = the newest fetch among its parts). */
export function tickFromRow(r: EnrichedRow, now = Date.now()): MarketTick {
  const { token, pair, stats, audit } = r;
  const t = Math.max(token.fetchedAt || 0, pair.fetchedAt || 0, stats?.fetchedAt ?? 0, audit?.fetchedAt ?? 0) || now;
  return {
    mint: r.mint, t, kind: 'live',
    symbol: cleanSymbol(token.symbol), launchpad: (token.launchpad ?? 'unknown') as Launchpad,
    createdAt: fin(token.createdAt ?? pair.createdAt),
    price: fin(pair.priceUsd), mcap: fin(pair.mcap), mcapResolved: fin(r.mcap?.value), mcapFlagged: !!r.mcap?.flagged,
    liq: fin(pair.liquidityUsd), vol5m: fin(pair.volume.m5), vol1h: fin(pair.volume.h1), vol24: fin(pair.volume.h24),
    buys5m: fin(pair.txns.m5?.buys), sells5m: fin(pair.txns.m5?.sells), buys24: fin(pair.txns.h24?.buys), sells24: fin(pair.txns.h24?.sells),
    chg5m: fin(pair.priceChange.m5), chg1h: fin(pair.priceChange.h1), chg6h: fin(pair.priceChange.h6), chg24h: fin(pair.priceChange.h24),
    holders: fin(stats?.holderCount), top10: fin(audit?.top10Pct), dev: fin(audit?.devPct),
    mintAuth: bool(audit?.mintAuthority), freezeAuth: bool(audit?.freezeAuthority), org: fin(stats?.organicScore),
  };
}

/** A fast-lane DexScreener view on top of the coin's last pool tick (slow fields carried, mcap re-resolved by the price move). */
export function tickFromDs(v: DsTokenView, base: MarketTick | undefined, now = Date.now()): MarketTick {
  const p = v.pair;
  const price = fin(p.priceUsd);
  const scaled = base?.mcapResolved !== null && base?.mcapResolved !== undefined && base.price && price !== null ? base.mcapResolved * (price / base.price) : fin(p.mcap);
  return {
    mint: v.token.mint, t: p.fetchedAt || now, kind: 'live',
    symbol: base?.symbol ?? cleanSymbol(v.token.symbol), launchpad: base?.launchpad ?? ((v.token.launchpad ?? 'unknown') as Launchpad),
    createdAt: base?.createdAt ?? fin(v.token.createdAt ?? p.createdAt),
    price, mcap: fin(p.mcap), mcapResolved: scaled, mcapFlagged: base?.mcapFlagged ?? false,
    liq: fin(p.liquidityUsd), vol5m: fin(p.volume.m5), vol1h: fin(p.volume.h1), vol24: fin(p.volume.h24) ?? base?.vol24 ?? null,
    buys5m: fin(p.txns.m5?.buys), sells5m: fin(p.txns.m5?.sells), buys24: fin(p.txns.h24?.buys) ?? base?.buys24 ?? null, sells24: fin(p.txns.h24?.sells) ?? base?.sells24 ?? null,
    chg5m: fin(p.priceChange.m5), chg1h: fin(p.priceChange.h1), chg6h: fin(p.priceChange.h6) ?? base?.chg6h ?? null, chg24h: fin(p.priceChange.h24) ?? base?.chg24h ?? null,
    holders: base?.holders ?? null, top10: base?.top10 ?? null, dev: base?.dev ?? null,
    mintAuth: base?.mintAuth ?? null, freezeAuth: base?.freezeAuth ?? null, org: base?.org ?? null,
  };
}

export interface LiveSourceDeps {
  store: { discover(preset: Preset, limit?: number, opts?: { max?: number }): Promise<{ mints: string[] }>; enrich(mints: string[], opts?: { price?: boolean; jup?: 'network' | 'cache' }): Promise<{ rows: EnrichedRow[] }> };
  dexscreener: { tokens(mints: string[]): Promise<Map<string, DsTokenView>> };
}

export interface LiveSourceOpts {
  presets?: Preset[];
  poolMax?: number;
  discoverEveryMs?: number;
  refreshMs?: number;
  fastMs?: number;
  batch?: number;
  maxFastCallsPerDay?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onLog?: (line: string) => void;
}

export const LIVE_DEFAULTS = { presets: ['trending', 'recent'] as Preset[], poolMax: 150, discoverEveryMs: 60_000, refreshMs: 10_000, fastMs: 5_000, batch: 30, maxFastCallsPerDay: 17_280 };

export class LiveSource {
  private readonly deps: LiveSourceDeps;
  private readonly o: typeof LIVE_DEFAULTS & { now: () => number; sleep: (ms: number) => Promise<void>; onLog: (l: string) => void };
  private focus: FocusMark[] = [];
  private pool: string[] = [];
  private readonly last = new Map<string, MarketTick>();
  private stopped = false;
  private wake: (() => void) | null = null;
  private fastDay = '';
  readonly stats = { discovers: 0, refreshes: 0, fastCalls: 0, fastCallsToday: 0, ticks: 0, errors: 0, fastSkippedCeiling: 0 };

  constructor(deps: LiveSourceDeps, opts: LiveSourceOpts = {}) {
    this.deps = deps;
    this.o = {
      ...LIVE_DEFAULTS, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)),
      now: opts.now ?? Date.now,
      sleep: opts.sleep ?? ((ms) => new Promise<void>((r) => { const t = setTimeout(r, ms); this.wake = () => { clearTimeout(t); r(); }; })),
      onLog: opts.onLog ?? (() => {}),
    } as LiveSource['o'];
  }

  /** The runner's candidate + held coins (the fast lane). */
  setFocus(marks: FocusMark[]): void { this.focus = marks.slice(0, 60); }

  stop(): void { this.stopped = true; this.wake?.(); }

  private emitNew(ticks: MarketTick[], out: MarketTick[]): void {
    for (const k of ticks) {
      const prev = this.last.get(k.mint);
      if (prev && k.t <= prev.t) continue;
      this.last.set(k.mint, k);
      out.push(k);
    }
  }

  /** One fast-lane pass over the focus coins; returns the new ticks. Respects the daily ceiling. */
  async fastPass(): Promise<MarketTick[]> {
    const mints = [...new Set(this.focus.map((f) => f.mint))];
    if (!mints.length) return [];
    const day = new Date(this.o.now()).toISOString().slice(0, 10);
    if (day !== this.fastDay) { this.fastDay = day; this.stats.fastCallsToday = 0; }
    const out: MarketTick[] = [];
    for (let i = 0; i < mints.length; i += this.o.batch) {
      if (this.stats.fastCallsToday >= this.o.maxFastCallsPerDay) { this.stats.fastSkippedCeiling++; break; }
      const batch = mints.slice(i, i + this.o.batch);
      this.stats.fastCalls++; this.stats.fastCallsToday++;
      try {
        const views = await this.deps.dexscreener.tokens(batch);
        const now = this.o.now();
        this.emitNew(batch.map((m) => views.get(m)).filter((v): v is DsTokenView => !!v).map((v) => tickFromDs(v, this.last.get(v.token.mint), now)), out);
      } catch (e) { this.stats.errors++; this.o.onLog(`fast lane: ${(e as Error).message}`); }
    }
    return out;
  }

  /** One pool pass: discover when due, then enrich the pool. */
  async poolPass(discover: boolean): Promise<MarketTick[]> {
    const out: MarketTick[] = [];
    try {
      if (discover || !this.pool.length) {
        const seen = new Set<string>();
        for (const p of this.o.presets) for (const m of (await this.deps.store.discover(p, 30, { max: this.o.poolMax })).mints) seen.add(m);
        this.pool = [...seen].slice(0, this.o.poolMax);
        this.stats.discovers++;
      }
      const { rows } = await this.deps.store.enrich(this.pool, { jup: 'cache' });
      this.stats.refreshes++;
      const now = this.o.now();
      this.emitNew(rows.filter((r) => r.mint && r.pair).map((r) => tickFromRow(r, now)), out);
    } catch (e) { this.stats.errors++; this.o.onLog(`pool refresh: ${(e as Error).message}`); }
    return out;
  }

  /** The tick stream: pool every refreshMs, fast lane every fastMs, in time order within each pass. Ends on stop(). */
  async *ticks(): AsyncIterable<MarketTick> {
    let lastPool = -Infinity;
    let lastDiscover = -Infinity;
    let lastT = 0;
    while (!this.stopped) {
      const t = this.o.now();
      const batch: MarketTick[] = [];
      if (t - lastPool >= this.o.refreshMs) {
        const disc = t - lastDiscover >= this.o.discoverEveryMs;
        batch.push(...await this.poolPass(disc));
        lastPool = t;
        if (disc) lastDiscover = t;
      }
      batch.push(...await this.fastPass());
      batch.sort((a, b) => a.t - b.t || (a.mint < b.mint ? -1 : 1));
      // The run clock never goes backwards: a cached row fetched before the last tick is stamped at that tick.
      for (const k of batch) { if (k.t < lastT) k.t = lastT; lastT = k.t; this.stats.ticks++; yield k; if (this.stopped) return; }
      if (this.stopped) return;
      await this.o.sleep(Math.max(250, this.o.fastMs - (this.o.now() - t)));
    }
  }
}
