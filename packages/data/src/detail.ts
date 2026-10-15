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

const NS = { mint: 'rpc:mint', holders: 'rpc:holders', rug: 'rugcheck', pools: 'gt:pools', goplus: 'goplus', trades: 'gt:trades' } as const;
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
          return await this.pool.topHolders(mint, { info });
        } catch (rpcErr) {
          const agg = await this.aggregateHolders(mint, info).catch(() => null);
          if (agg) return agg;
          throw rpcErr;
        }
      },
      { ttlMs: TTL.holders, source: this.pool.primary.source },
    );
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
