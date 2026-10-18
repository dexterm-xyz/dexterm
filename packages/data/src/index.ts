// @dexterm/data public surface. Lane B (D-02) owns this package; the shared model
// types were agreed on day 1 (D-01) and live in ./model.ts.
export * from './model.ts';
export * from './clock.ts';
export * from './limiter.ts';
export * from './health.ts';
export * from './cache.ts';
export * from './http.ts';
export * from './fixtures.ts';
export * from './store.ts';
export * from './sources/dexscreener.ts';
export * from './sources/jupiter.ts';
export * from './sources/jupiter-swap.ts';
export * from './sources/geckoterminal.ts';
export * from './sources/solana-rpc.ts';
export * from './sources/rugcheck.ts';
export * from './sources/goplus.ts';
export * from './sources/pumpportal.ts';
export * from './sources/solana-ws.ts';
export * from './sources/pump-curve.ts';
export * from './sources/pda.ts';
export * from './fast-lane.ts';
export * from './candles.ts';
export * from './detail.ts';
export * from './rpc-config.ts';
export * from './rpc-pool.ts';
export * from './credits.ts';
export * from './budget.ts';
export * from './watchlist.ts';
export * from './paper.ts';
export * from './trade/caps.ts';
export * from './trade/bridge.ts';
export * from './trade/swap-build.ts';
export * from './trade/rpc-exec.ts';
export * from './trade/executor.ts';
export * from './trade/link-store.ts';
export * from './trade/tx-decode.ts';
export * from './trade/sol-usd.ts';
export * from './trade/kill-switch.ts';
export * from './trade/token-delta.ts';
// task-1443: the paper agent desk + its rendezvous (agents paper-trade inside an armed mandate; never sign/send).
export * from './trade/agent/paper-desk.ts';
export * from './trade/agent/rendezvous.ts';
export * from './trade/signer/protocol.ts';
export * from './trade/signer/service.ts';
export * from './trade/signer/host.ts';
export * from './trade/signer/client.ts';
export * from './trade/signer/probe-builder.ts';
export * from './trade/signer/fast-wallet.ts';
export * from './trade/signer/sol-usd-feed.ts';
export { parseSignerArgs, buildSignerService, type SignerArgs } from './trade/signer/main.ts';
export * from './larp/links.ts';
export * from './larp/safe-fetch.ts';
export * from './larp/evidence.ts';
export * from './larp/link-baseline.ts';
// task-1401: parse a CA / coin link from any input (go-to, analyst chat, filter line, --mint, MCP refs).
export * from './coin-target.ts';
export * from './analyst-actions.ts';
export * from './intel/rules.ts';
export * from './intel/holder-class.ts';
export * from './intel/helius-history.ts';
export * from './intel/scan.ts';
export * from './intel/live-signals.ts';
export * from './images/index.ts';
// task-1330 (I-03): social / news / trending layer. `Provenance` and `Credibility`-style names are
// namespaced under `Social*` where they would collide with the core model.
export {
  type Platform, type AuthorTier, type PostFlag, type SocialAuthor, type PostMetrics, type RawPost, type SocialPost, type KolList, type KolListSource,
  type Credibility, type VenueSignal, type TrendRow, type Narrative, type NewsTag, type NewsItem, POST_DISPLAY_MAX, POST_STORED_MAX, BIO_MAX,
} from './social/model.ts';
export * from './social/firewall.ts';
export * from './social/dedupe.ts';
export * from './social/rank.ts';
export * from './social/kol.ts';
export * from './social/venues.ts';
export * from './social/rss.ts';
export * from './social/chain.ts';
export * from './social/summary.ts';
export * from './social/feed.ts';
// task-1357 (I-02): Login with X (OAuth2 PKCE on a loopback callback) + the user-authorized X read adapter.
export * from './x/index.ts';

import { Cache } from './cache.ts';
import type { Clock } from './clock.ts';
import { systemClock } from './clock.ts';
import { HealthRegistry } from './health.ts';
import type { RequestMeta, HttpRequest, Transport } from './http.ts';
import { HttpClient, liveTransport } from './http.ts';
import type { BucketConfig } from './limiter.ts';
import { DEFAULT_BUCKETS, RateLimiter, SOURCE_BUCKET } from './limiter.ts';
import type { SourceId } from './model.ts';
import { DexScreener } from './sources/dexscreener.ts';
import { Jupiter } from './sources/jupiter.ts';
import { JupiterSwap } from './sources/jupiter-swap.ts';
import { GeckoTerminal } from './sources/geckoterminal.ts';
import { RugCheck } from './sources/rugcheck.ts';
import { GoPlus } from './sources/goplus.ts';
import { SOLANA_PUBLIC_RPC, SolanaRpc } from './sources/solana-rpc.ts';
import { CandleStore } from './candles.ts';
import { TokenDetail, type HoldersAggregate } from './detail.ts';
import { Store } from './store.ts';
import { HELIUS_RPC_HOST, PUBLIC_RPC_POOL } from './rpc-config.ts';
import { RpcPool, type RpcEndpointSpec, bucketFor } from './rpc-pool.ts';
import { CreditMeter, type CreditMeterOptions } from './credits.ts';
import { BudgetMeter, type BudgetMeterOptions } from './budget.ts';

export interface DataLayerOptions {
  /** SQLite path; default in-memory. Use defaultDbPath() for the XDG location. */
  dbPath?: string;
  /** Default: live keyless fetch. Tests pass replayTransport(). */
  transport?: Transport;
  /**
   * Shutdown controller whose signal close() aborts (task-1319). When the caller builds its own
   * `transport` (createLiveFeed does), it must build that transport with THIS controller's signal so
   * close() actually aborts the in-flight fetch; otherwise the default live transport is wired to a
   * fresh controller here. Supplying it is the only way a caller-built transport gets the shutdown abort.
   */
  shutdownController?: AbortController;
  clock?: Clock;
  buckets?: Record<string, BucketConfig>;
  /** Safety factor applied to every documented rpm (default 0.7). */
  safety?: number;
  keys?: Partial<Record<SourceId, boolean>>;
  disabled?: SourceId[];
  /**
   * Solana RPC URL (default: public mainnet). Read-only methods only. A `mainnet.helius-rpc.com` URL
   * (see resolveRpcUrl) is treated as the keyed `helius` source: its own bucket, health entry and credit
   * meter, with the public RPC as the fallback for mint info and holders. Never log this value.
   */
  rpcUrl?: string;
  /** Fallback RPC when the primary fails (default: public mainnet when the primary is not already it; null disables). */
  rpcFallbackUrl?: string | null;
  /** Extra user-supplied free RPC endpoints (read-only) added to the pool after the primary. Never logged. */
  rpcExtraUrls?: string[];
  /** Add the keyless public RPC seed list (PUBLIC_RPC_POOL) to the pool for extra keyless reliability. Default false. */
  rpcPublicPool?: boolean;
  /** Helius credit meter settings (day budget, per-run cap). */
  credits?: Omit<CreditMeterOptions, 'clock' | 'cache' | 'onLevel'>;
  /** Per-source request budget meter settings (soft daily caps). */
  budget?: Omit<BudgetMeterOptions, 'clock' | 'cache'>;
  onRequest?: (req: HttpRequest, meta: RequestMeta, outcome: { status: number | null; latencyMs: number }) => void;
  /** Base pause after a 429 without Retry-After (doubles per consecutive 429 on a bucket; default 30 s). The signer process uses a shorter one (task-1368). */
  rateLimitPauseMs?: number;
}

export interface DataLayer {
  clock: Clock;
  cache: Cache;
  limiter: RateLimiter;
  health: HealthRegistry;
  http: HttpClient;
  dexscreener: DexScreener;
  jupiter: Jupiter;
  /** Keyless swap-quote source (SPEC §3.1 S11) — paper trading only; never builds/signs/sends. */
  jupiterSwap: JupiterSwap;
  gecko: GeckoTerminal;
  rpc: SolanaRpc;
  /** Public RPC behind a Helius/custom primary; null when the primary is the public one. */
  rpcFallback: SolanaRpc | null;
  /** RPC pool (rotation + health + 429 backoff) the detail layer reads through (task-1309). */
  rpcPool: RpcPool;
  rugcheck: RugCheck;
  goplus: GoPlus;
  /** Helius credit meter; null without a Helius endpoint. */
  credits: CreditMeter | null;
  /** Per-source request budget meter (visible usage, soft caps). */
  budget: BudgetMeter;
  candles: CandleStore;
  detail: TokenDetail;
  store: Store;
  close(): void;
}

/** `helius` for a Helius endpoint (keyed source S9), else the public/custom RPC source S6. */
export function rpcSourceFor(url: string | undefined): 'helius' | 'solana-rpc' {
  if (!url) return 'solana-rpc';
  try { return new URL(url).hostname === HELIUS_RPC_HOST ? 'helius' : 'solana-rpc'; } catch { return 'solana-rpc'; }
}

export function createDataLayer(opts: DataLayerOptions = {}): DataLayer {
  const clock = opts.clock ?? systemClock;
  const limiter = new RateLimiter(opts.buckets ?? DEFAULT_BUCKETS, clock, opts.safety);
  const rpcSource = rpcSourceFor(opts.rpcUrl);
  const keys = { ...opts.keys };
  if (rpcSource === 'helius') keys.helius = true;
  const health = new HealthRegistry({
    clock,
    keys,
    disabled: opts.disabled,
    usage: (source) => {
      const bucket = SOURCE_BUCKET[source];
      if (!bucket) return undefined;
      const s = limiter.bucket(bucket).stats();
      return { rpmUsed: s.rpmUsed, rpmLimit: s.rpmLimit };
    },
  });
  const cache = new Cache({ path: opts.dbPath, clock });
  // Helius credit meter: every request to the keyed endpoint is charged; at 90 % of the day budget or the
  // per-run cap the source is switched off (health `disabled`) so holders fall back to the public RPC.
  const credits = rpcSource === 'helius'
    ? new CreditMeter({
      ...opts.credits,
      clock,
      cache,
      onLevel: (level) => health.setDisabled('helius', level === 'degraded'),
    })
    : null;
  if (credits && credits.level() === 'degraded') health.setDisabled('helius', true);
  // Per-source request budget meter: counts every request (persisted per UTC day) so usage is visible.
  const budget = new BudgetMeter({ ...opts.budget, clock, cache });
  const onRequest: DataLayerOptions['onRequest'] = (req, meta, o) => {
    budget.charge(meta.source);
    if (credits && meta.source === 'helius') {
      let method: string | null = null;
      try { method = req.body ? ((JSON.parse(req.body) as { method?: string }).method ?? null) : null; } catch { method = null; }
      credits.charge(CreditMeter.costOf(method));
    }
    opts.onRequest?.(req, meta, o);
  };
  // Shutdown signal (task-1319): close() aborts it so any in-flight live fetch rejects immediately and
  // the event loop is not held for the per-request timeout. A caller that builds its own transport must
  // pass its controller as opts.shutdownController and build that transport with its signal, so close()
  // reaches the real app's transport (createLiveFeed does exactly this); otherwise we own the controller
  // and wire it into the default live transport.
  const shutdown = opts.shutdownController ?? new AbortController();
  const http = new HttpClient({ transport: opts.transport ?? liveTransport({ shutdownSignal: shutdown.signal }), limiter, health, clock, onRequest, ...(opts.rateLimitPauseMs !== undefined ? { rateLimitPauseMs: opts.rateLimitPauseMs } : {}) });
  const dexscreener = new DexScreener(http);
  const jupiter = new Jupiter(http);
  const jupiterSwap = new JupiterSwap(http);
  const gecko = new GeckoTerminal(http);
  const rpc = new SolanaRpc(http, { url: opts.rpcUrl, source: rpcSource });
  const fallbackUrl = opts.rpcFallbackUrl === undefined ? (rpc.url === SOLANA_PUBLIC_RPC ? null : SOLANA_PUBLIC_RPC) : opts.rpcFallbackUrl;
  const rpcFallback = fallbackUrl && fallbackUrl !== rpc.url ? new SolanaRpc(http, { url: fallbackUrl, source: 'solana-rpc' }) : null;
  // The pool the detail layer reads through. By default it mirrors the old primary+fallback pair exactly
  // (so behaviour is unchanged); extra user endpoints and the keyless public seed list are opt-in.
  const pool = new RpcPool(http, limiter, buildEndpointSpecs({ rpcUrl: rpc.url, rpcSource, fallbackUrl, opts }), { clock });
  // Keyless holder aggregate: Jupiter's holder count + top-10 share, used when no RPC endpoint serves the ranked list.
  const holdersAggregate = async (mint: string): Promise<HoldersAggregate | null> => {
    const views = await jupiter.search(mint);
    const v = views.find((x) => x.token.mint === mint) ?? views[0];
    if (!v) return null;
    return { holderCount: v.stats.holderCount, top10Pct: v.audit.top10Pct, source: 'jupiter-tokens', fetchedAt: v.stats.fetchedAt };
  };
  const rugcheck = new RugCheck(http);
  const goplus = new GoPlus(http);
  const candles = new CandleStore({ cache, gecko, clock });
  const detail = new TokenDetail({ cache, gecko, pool, holdersAggregate, rugcheck, goplus, candles });
  const store = new Store({ cache, dexscreener, jupiter });
  return { clock, cache, limiter, health, http, dexscreener, jupiter, jupiterSwap, gecko, rpc, rpcFallback, rpcPool: pool, rugcheck, goplus, credits, budget, candles, detail, store, close: () => { shutdown.abort(); limiter.close(); cache.close(); } };
}

/** Pool endpoints: the primary first (keyed when Helius/custom), then the public fallback, then any opt-in extras. */
function buildEndpointSpecs(args: { rpcUrl: string; rpcSource: 'helius' | 'solana-rpc'; fallbackUrl: string | null; opts: DataLayerOptions }): RpcEndpointSpec[] {
  const { rpcUrl, rpcSource, fallbackUrl, opts } = args;
  const specs: RpcEndpointSpec[] = [];
  const seen = new Set<string>();
  const add = (spec: RpcEndpointSpec) => {
    if (seen.has(spec.url)) return;
    seen.add(spec.url);
    specs.push(spec);
  };
  // Primary keeps its natural source bucket (helius 600rpm / solana-rpc 30rpm) and credit-meter semantics.
  const keyed = rpcSource === 'helius';
  add({ url: rpcUrl, source: rpcSource, bucket: rpcSource, rpm: keyed ? 600 : 30, burst: keyed ? 5 : 1, label: keyed ? 'Helius (free key)' : 'public RPC', keyed });
  if (fallbackUrl && fallbackUrl !== rpcUrl) add({ url: fallbackUrl, source: 'solana-rpc', bucket: 'solana-rpc', rpm: 30, burst: 1, label: 'public RPC (fallback)' });
  for (const url of opts.rpcExtraUrls ?? []) {
    const src = rpcSourceFor(url);
    add({ url, source: src, bucket: bucketFor(url), rpm: src === 'helius' ? 600 : 30, burst: src === 'helius' ? 5 : 1, label: 'user RPC', basis: 'env DEXTERM_RPC_URLS', keyed: src === 'helius' });
  }
  if (opts.rpcPublicPool) {
    for (const p of PUBLIC_RPC_POOL) add({ url: p.url, source: 'solana-rpc', bucket: bucketFor(p.url), rpm: 30, burst: 1, label: p.label, basis: p.basis });
  }
  return specs;
}
export { fetchPage, robotsAllows } from './larp/robots.ts';
