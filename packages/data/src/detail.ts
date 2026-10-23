// Token-detail data (SPEC §4.3, D-06): candles, on-chain authorities, top-20
// holders and the RugCheck summary, each cached with its SPEC §3.4 TTL and
// stale-while-revalidate, so the detail screen and the MCP tools share one
// set of requests.

import type { Cache, FetchResult } from './cache.ts';
import { TTL } from './cache.ts';
import type { CandleRequest, CandleSeries, CandleStore } from './candles.ts';
import type { CandleInterval } from './model.ts';
import type { RpcPool } from './rpc-pool.ts';
import type { GeckoTerminal, GtPool, GtTrade } from './sources/geckoterminal.ts';
import type { GoPlus, GoPlusSecurity } from './sources/goplus.ts';
import type { RugCheck, RugSummary } from './sources/rugcheck.ts';
import type { MintInfo, TopHolders } from './sources/solana-rpc.ts';
import { classifyHolder, EX_POOL_TAGS } from './intel/holder-class.ts';

/**
 * Keyless aggregate holder data (task-1309): holder count + top-10 concentration from a source that
 * answers without a key (Jupiter). Used only when the RPC pool cannot serve the ranked top-20 list.
 */
export interface HoldersAggregate {
  holderCount: number | null;
  top10Pct: number | null;
  source: 'jupiter-tokens';
  fetchedAt: number;
}

const NS = { mint: 'rpc:mint', holders: 'rpc:holders', ownerMeta: 'rpc:owner-meta', rug: 'rugcheck', pools: 'gt:pools', goplus: 'goplus', trades: 'gt:trades' } as const;
/** The program that owns an account (a pool, a curve PDA, a wallet) does not change: a week per owner. */
const OWNER_META_TTL = 7 * 86_400_000;
/** Pools for a mint change rarely; one lookup per hour per mint. */
const POOLS_TTL = 3_600_000;
/** The trades tape shares GeckoTerminal's 10/min bucket with the candles: refresh at most every 20 s per pool. */
export const TRADES_TTL = 20_000;

export class TokenDetail {
  private readonly cache: Cache;
  private readonly gecko: GeckoTerminal;
  /** RPC pool: rotates across keyed + keyless endpoints with health scoring and 429 backoff (task-1309). */
  private readonly pool: RpcPool;
  /** Keyless holder aggregate (Jupiter) used when no RPC endpoint can serve the ranked list. */
  private readonly holdersAggregate: ((mint: string) => Promise<HoldersAggregate | null>) | null;
  private readonly rug: RugCheck;
  private readonly goplus: GoPlus | null;
  readonly candleStore: CandleStore;

  constructor(deps: {
    cache: Cache;
    gecko: GeckoTerminal;
    pool: RpcPool;
    holdersAggregate?: ((mint: string) => Promise<HoldersAggregate | null>) | null;
    rugcheck: RugCheck;
    goplus?: GoPlus | null;
    candles: CandleStore;
  }) {
    this.cache = deps.cache;
    this.gecko = deps.gecko;
    this.pool = deps.pool;
    this.holdersAggregate = deps.holdersAggregate ?? null;
    this.rug = deps.rugcheck;
    this.goplus = deps.goplus ?? null;
    this.candleStore = deps.candles;
  }

  /** Candles for a pool (pass DexScreener's `pair.pairAddress` to avoid a pool lookup). */
  candles(pool: string, interval: CandleInterval, req?: CandleRequest): Promise<CandleSeries> {
    return this.candleStore.get(pool, interval, req);
  }

  /** Most liquid GeckoTerminal pool for a mint (one request per hour per mint). */
  async topPool(mint: string): Promise<GtPool | null> {
    const r = await this.cache.fetch<GtPool[]>(NS.pools, mint, () => this.gecko.tokenPools(mint), { ttlMs: POOLS_TTL, source: 'geckoterminal' });
    return r.value[0] ?? null;
  }

  /** Mint/freeze authority truth from chain (TTL audit, 10 min). RPC pool: keyed endpoints first, keyless public RPC rotation behind them. */
  mintInfo(mint: string): Promise<FetchResult<MintInfo>> {
    return this.cache.fetch(NS.mint, mint, () => this.pool.mintInfo(mint), { ttlMs: TTL.audit, source: this.pool.primary.source });
  }

  /**
   * Top-20 holders (TTL holders, 60 s); reuses the cached mint info for supply/decimals. The RPC pool
   * rotates across every endpoint; the result's `source` says which answered. When no endpoint can serve
   * the ranked list (keyless: getTokenLargestAccounts is throttled/blocked everywhere), fall back to the
   * Jupiter aggregate (`aggregateOnly`: holder count + top-10 share, empty list). Only when that also fails
   * does the RPC error propagate, so the caller shows "unavailable".
   */
  async holders(mint: string): Promise<FetchResult<TopHolders>> {
    return this.cache.fetch(
      NS.holders,
      mint,
      async () => {
        const info = (await this.mintInfo(mint)).value;
        try {
          return await this.exPool(await this.pool.topHolders(mint, { info }));
        } catch (rpcErr) {
          const agg = await this.aggregateHolders(mint, info).catch(() => null);
          if (agg) return agg;
          throw rpcErr;
        }
      },
      { ttlMs: TTL.holders, source: this.pool.primary.source },
    );
  }

  /**
   * The HOLDERS panel's ex-pool rule (task-1367 `classifyHolder`) for every caller of `holders()` (the MCP
   * `get_holders` / `get_dossier` concentration, the autotrade dossier, rug-check), task-1518. A top account whose
   * owner is a pool, a bonding curve, a launch vault, a lock or the burn address is not a person's position: it gets
   * `poolSide` (and `label: 'LP'` for a pool, curve or vault) and is left out of `top10Pct`. Without this, every young
   * PumpSwap pool (the vault owner is the pool account) and every Meteora DAMM v2 pool (the global pool authority)
   * read as one 80-95 % "holder". One extra getMultipleAccounts over the owners not yet known (no data, <= 20
   * addresses, cached a week per owner: an account's program does not change), the same lookup the wallet-intel scan
   * makes; when it fails, only the derived authorities and the pump.fun curve are recognised and every other owner
   * stays counted (never hidden).
   */
  private async exPool(h: TopHolders): Promise<TopHolders> {
    if (h.aggregateOnly || !h.holders.length) return h;
    const owners = [...new Set(h.holders.map((x) => x.owner).filter((o): o is string => !!o))];
    type Meta = { programOwner: string | null; exists: boolean; lamports: number };
    const meta = new Map<string, Meta>();
    const misses: string[] = [];
    for (const o of owners) { const hit = this.cache.get<Meta>(NS.ownerMeta, o); if (hit) meta.set(o, hit.value); else misses.push(o); }
    if (misses.length) {
      try {
        const got = await this.pool.accountMeta(misses);
        // an address with no account yet can be created later: an hour for those, a week for accounts that exist
        for (const [o, m] of got) { meta.set(o, m); this.cache.set(NS.ownerMeta, o, m, { ttlMs: m.exists ? OWNER_META_TTL : 3_600_000, source: this.pool.primary.source }); }
      } catch { /* counted, never hidden */ }
    }
    const holders = h.holders.map((x) => {
      if (!x.owner || x.label) return x;
      const c = classifyHolder({ mint: h.mint, owner: x.owner, tokenAccounts: [x.tokenAccount], meta: meta.get(x.owner), cex: null, dev: null, poolRule: null, linked: null });
      if (!EX_POOL_TAGS.has(c.tag)) return x;
      return { ...x, ...(c.tag === 'POOL' || c.tag === 'CURVE' || c.tag === 'VAULT' ? { label: 'LP' as const } : {}), poolSide: { tag: c.tag, program: c.program, reason: c.reason } };
    });
    const sum = (xs: { pct: number }[]) => Math.round(xs.reduce((s, x) => s + x.pct, 0) * 1000) / 1000;
    const notCounted = new Set(['LP', 'cex', 'bridge']);
    const counted = holders.filter((x) => !x.poolSide && !(x.label && notCounted.has(x.label))).slice(0, 10);
    return { ...h, holders, top10Pct: h.top10Pct === null ? null : sum(counted), top10PctRaw: h.top10Pct === null ? null : sum(holders.slice(0, 10)) };
  }

  /** Build an aggregate-only TopHolders from the keyless Jupiter holder data; null when unavailable. */
  private async aggregateHolders(mint: string, info: MintInfo): Promise<TopHolders | null> {
    if (!this.holdersAggregate) return null;
    const a = await this.holdersAggregate(mint);
    if (!a || (a.holderCount === null && a.top10Pct === null)) return null;
    return {
      mint,
      holders: [],
      top10Pct: a.top10Pct,
      supply: info.supply,
      decimals: info.decimals,
      source: a.source,
      fetchedAt: a.fetchedAt,
      aggregateOnly: true,
      holderCount: a.holderCount,
    };
  }

  rugcheck(mint: string): Promise<FetchResult<RugSummary>> {
    return this.cache.fetch(NS.rug, mint, () => this.rug.summary(mint), { ttlMs: TTL.rugcheck, source: 'rugcheck' });
  }

  /** GoPlus second opinion (TTL rugcheck, 10 min). Throws when the adapter is not configured. */
  security(mint: string): Promise<FetchResult<GoPlusSecurity>> {
    const gp = this.goplus;
    if (!gp) throw new Error('goplus adapter not configured');
    return this.cache.fetch(NS.goplus, mint, () => gp.tokenSecurity(mint), { ttlMs: TTL.rugcheck, source: 'goplus' });
  }

  /** Recent trades of the token's pool from GeckoTerminal (best keyless tape), newest first, 20 s TTL. */
  trades(pool: string, mint?: string): Promise<FetchResult<GtTrade[]>> {
    return this.cache.fetch(NS.trades, `${pool}:${mint ?? ''}`, async () => (await this.gecko.trades(pool, { mint })).trades, { ttlMs: TRADES_TTL, source: 'geckoterminal' });
  }
}
