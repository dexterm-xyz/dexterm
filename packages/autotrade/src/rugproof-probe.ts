// dexterm autotrade — the rug-proof probes (task-1748): the network half of rugproof.ts. READ-ONLY, PAPER ONLY.
//
//   DexScreener tokens/v1      the coin's deepest pool: dex, base / quote mint, creation time, liquidity     keyless
//   Solana RPC                 the PumpSwap pool account (creator, lp mint, vaults), the LP mint's supply and
//                              largest holders, the pool's newest transactions (Withdraw scan), the SOL vault   public or the user's own key
//   Jupiter lite quote         token -> SOL for a given raw amount                                          keyless
//
// No wallet, no key of any wallet, no signing, no send: only reads. An RPC URL may carry an api key: it is never
// printed (redactSecrets) and never written to the ledger. Every read has a timeout; a read that fails is `error`
// and the gate that needed it refuses (fail closed). The vet runs the gates in rugproof.ts order and stops at the first
// refusal, so a coin refused by a free gate costs no network call.

import { redactSecrets, base58 } from '@dexterm/data';
import type { MarketTick } from './replay.ts';
import type { VetContext, VetFn, VetResult, DrainWatch, DrainWatchPosition } from './runner.ts';
import {
  PUMPSWAP_PROGRAM, WSOL_MINT, drainVerdict, gateHolders, gateLiquidityRecheck, gateLpLocked, gatePoolAge, gatePoolStructure,
  gateSellRoute, gateWithdrawHistory, verdictOf, type DrainBase, type DrainGuardRules, type DrainVerdict, type GateResult, type PoolLp,
  type PoolPair, type RouteRead, type RugproofRules, type WithdrawScan,
} from './rugproof.ts';

export type FetchJson = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; json: unknown }>;

export const defaultFetchJson = (timeoutMs = 12_000): FetchJson => async (url, init) => {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  let json: unknown = null;
  try { json = await r.json(); } catch { json = null; }
  return { status: r.status, json };
};

export interface ProbeDeps {
  fetchJson: FetchJson;
  /** Solana JSON-RPC endpoint (may carry a key: never printed). null = no RPC: chain gates refuse (unknown). */
  rpcUrl: string | null;
  dexscreenerBase?: string;
  jupiterBase?: string;
}

type Obj = Record<string, unknown>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isObj = (x: unknown): x is Obj => !!x && typeof x === 'object' && !Array.isArray(x);
const str = (x: unknown): string | null => (typeof x === 'string' && x ? x : null);
const fin = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

export class RugProbe {
  private id = 0;
  readonly d: ProbeDeps;
  /** Per-run cache: a pool's structure does not change, its LP and history are re-read at most every 10 min. */
  private readonly lpCache = new Map<string, { t: number; v: PoolLp | null | 'error' }>();
  private readonly decimals = new Map<string, number>();
  rpcCalls = 0;
  /** Backoff unit after a rate limit (ms); tests set 0. */
  backoffMs: number;
  constructor(d: ProbeDeps & { backoffMs?: number }) { this.d = d; this.backoffMs = d.backoffMs ?? 1500; }

  async rpc(method: string, params: unknown[]): Promise<unknown> {
    if (!this.d.rpcUrl) throw new Error('no RPC endpoint');
    let r: { status: number; json: unknown } = { status: 0, json: null };
    // A rate limit (HTTP 429 or JSON-RPC -32429) is retried twice with a backoff before the read counts as failed.
    for (let attempt = 0; attempt < 3; attempt++) {
      this.rpcCalls++;
      try { r = await this.d.fetchJson(this.d.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }) }); }
      catch (e) { throw new Error(redactSecrets(`rpc ${method}: ${(e as Error).message}`).slice(0, 200)); }
      const limited = r.status === 429 || (isObj(r.json) && isObj(r.json.error) && r.json.error.code === -32429);
      if (!limited || attempt === 2) break;
      await sleep(this.backoffMs * (attempt + 1));
    }
    if (!isObj(r.json)) throw new Error(`rpc ${method}: HTTP ${r.status}`);
    if (r.json.error) throw new Error(redactSecrets(`rpc ${method}: ${JSON.stringify(r.json.error)}`).slice(0, 200));
    return r.json.result;
  }

  private readonly pairCache = new Map<string, { t: number; v: Promise<PoolPair | null> }>();
  private readonly scanCache = new Map<string, { t: number; v: WithdrawScan }>();

  /** The coin's deepest DexScreener pool (shared for 30 s: every fleet member asks about the same coin). */
  pair(mint: string, now = Date.now()): Promise<PoolPair | null> {
    const hit = this.pairCache.get(mint);
    if (hit && now - hit.t < 30_000) return hit.v;
    const v = this.readPair(mint);
    this.pairCache.set(mint, { t: now, v });
    v.catch(() => this.pairCache.delete(mint));
    return v;
  }

  private async readPair(mint: string): Promise<PoolPair | null> {
    const r = await this.d.fetchJson(`${this.d.dexscreenerBase ?? 'https://api.dexscreener.com'}/tokens/v1/solana/${mint}`);
    if (!Array.isArray(r.json)) throw new Error(`dexscreener HTTP ${r.status}`);
    const pairs = (r.json as Obj[]).filter((p) => isObj(p) && str(p.pairAddress)).sort((a, b) => (fin((b.liquidity as Obj)?.usd) ?? 0) - (fin((a.liquidity as Obj)?.usd) ?? 0));
    const p = pairs[0];
    if (!p) return null;
    return { address: p.pairAddress as string, dex: str(p.dexId) ?? 'unknown', baseMint: str((p.baseToken as Obj)?.address) ?? '', quoteMint: str((p.quoteToken as Obj)?.address) ?? '', createdAt: fin(p.pairCreatedAt), liqUsd: fin((p.liquidity as Obj)?.usd) };
  }

  /** The PumpSwap pool account + its LP mint (supply, largest holders' owners). null = not a PumpSwap account. */
  async poolLp(pool: string, now = Date.now()): Promise<PoolLp | null | 'error'> {
    const hit = this.lpCache.get(pool);
    if (hit && now - hit.t < 10 * 60e3 && hit.v !== 'error') return hit.v;
    let v: PoolLp | null | 'error';
    try { v = await this.readPoolLp(pool); } catch { v = 'error'; }
    this.lpCache.set(pool, { t: now, v });
    return v;
  }

  private async readPoolLp(pool: string): Promise<PoolLp | null> {
    const acc = await this.rpc('getAccountInfo', [pool, { encoding: 'base64' }]) as Obj | null;
    const value = isObj(acc) ? acc.value as Obj | null : null;
    if (!value) return null;
    if (value.owner !== PUMPSWAP_PROGRAM) return null;
    const data = Buffer.from(String((value.data as unknown[])[0] ?? ''), 'base64');
    const lp = decodePumpSwapPool(data);
    const sup = await this.rpc('getTokenSupply', [lp.lpMint]) as Obj;
    const lpSupply = BigInt(String(((sup?.value as Obj)?.amount) ?? '0'));
    let holders: PoolLp['holders'] = [];
    if (lpSupply > 0n) {
      const big = await this.rpc('getTokenLargestAccounts', [lp.lpMint]) as Obj;
      const rows = (((big?.value as Obj[]) ?? []).filter(isObj)).slice(0, 5);
      const accs = rows.length ? await this.rpc('getMultipleAccounts', [rows.map((x) => x.address), { encoding: 'jsonParsed' }]) as Obj : null;
      const vals = (accs?.value as (Obj | null)[]) ?? [];
      holders = rows.map((x, i) => {
        const owner = str((((vals[i]?.data as Obj)?.parsed as Obj)?.info as Obj)?.owner) ?? 'unknown';
        return { owner, amount: BigInt(String(x.amount ?? '0')) };
      }).sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0));
    }
    return { ...lp, lpSupply, holders };
  }

  /**
   * `Withdraw` instructions among the pool's newest `n` successful transactions (and how many the creator signed).
   * Fails closed: one transaction that cannot be read (after the rpc's rate-limit retries) could be the creator's
   * Withdraw, so any unread one makes the whole scan `error` (the gate refuses, the vet looks again in 5 min).
   */
  async withdraws(pool: string, creator: string, n: number, now = Date.now()): Promise<WithdrawScan | 'error'> {
    const hit = this.scanCache.get(pool);
    if (hit && now - hit.t < 10 * 60e3) return hit.v;
    const v = await this.scanWithdraws(pool, creator, n);
    if (v !== 'error') this.scanCache.set(pool, { t: now, v });
    return v;
  }

  private async scanWithdraws(pool: string, creator: string, n: number): Promise<WithdrawScan | 'error'> {
    try {
      const sigs = await this.rpc('getSignaturesForAddress', [pool, { limit: Math.min(100, n * 2) }]) as Obj[];
      const ok = (Array.isArray(sigs) ? sigs : []).filter((x) => isObj(x) && !x.err).slice(0, n);
      let withdraws = 0; let byCreator = 0; let scanned = 0;
      for (const s of ok) {
        // maxSupportedTransactionVersion 1: Helius answers -32015 for a version-1 transaction under 0 (task-1394).
        let tx: Obj | null = null;
        try { tx = await this.rpc('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1 }]) as Obj | null; } catch { return 'error'; }
        if (!isObj(tx)) return 'error';
        scanned++;
        const logs = ((tx.meta as Obj)?.logMessages as string[]) ?? [];
        if (!logs.some((l) => l === 'Program log: Instruction: Withdraw')) continue;
        withdraws++;
        const keys = (((tx.transaction as Obj)?.message as Obj)?.accountKeys as unknown[]) ?? [];
        const signer = keys.map((k) => (isObj(k) ? k.pubkey : k))[0];
        if (signer === creator) byCreator++;
      }
      return { scanned, withdraws, byCreator };
    } catch { return 'error'; }
  }

  async tokenDecimals(mint: string): Promise<number | null> {
    const hit = this.decimals.get(mint);
    if (hit !== undefined) return hit;
    try {
      const sup = await this.rpc('getTokenSupply', [mint]) as Obj;
      const d = fin((sup?.value as Obj)?.decimals);
      if (d !== null) { this.decimals.set(mint, d); return d; }
    } catch { /* below */ }
    // pump.fun mints are 6 decimals by construction.
    return mint.endsWith('pump') ? 6 : null;
  }

  /** Jupiter token -> SOL quote for `raw` units. HTTP 429 / a network failure is not a quote error. */
  async route(mint: string, raw: bigint): Promise<RouteRead> {
    if (raw <= 0n) return { ok: false, kind: 'no-route', error: 'zero amount' };
    let r: { status: number; json: unknown } = { status: 0, json: null };
    for (let attempt = 0; attempt < 3; attempt++) {
      try { r = await this.d.fetchJson(`${this.d.jupiterBase ?? 'https://lite-api.jup.ag'}/swap/v1/quote?inputMint=${mint}&outputMint=${WSOL_MINT}&amount=${raw}&slippageBps=1000`); }
      catch (e) { return { ok: false, kind: 'network', error: (e as Error).message.slice(0, 120) }; }
      if (r.status !== 429 || attempt === 2) break;
      await sleep(this.backoffMs * (attempt + 1));
    }
    if (r.status === 429) return { ok: false, kind: 'rate-limited', error: 'HTTP 429' };
    const j = isObj(r.json) ? r.json : {};
    if (str(j.outAmount) && !j.errorCode && !j.error) return { ok: true, outLamports: BigInt(j.outAmount as string), impactPct: fin(Number(j.priceImpactPct)) === null ? null : Math.round(Number(j.priceImpactPct) * 10000) / 100 };
    if (r.status >= 500 && !j.errorCode) return { ok: false, kind: 'network', error: `HTTP ${r.status}` };
    return { ok: false, kind: 'no-route', error: String(j.errorCode ?? j.error ?? `HTTP ${r.status}`).slice(0, 120) };
  }

  /** The pool's SOL vault balance (SOL). */
  async vaultSol(vault: string): Promise<number | null> {
    try {
      const b = await this.rpc('getTokenAccountBalance', [vault]) as Obj;
      const v = (b?.value as Obj) ?? {};
      return fin(v.uiAmount) ?? (str(v.amount) ? Number(v.amount) / 1e9 : null);
    } catch { return null; }
  }
}

/** PumpSwap `Pool`: disc 8, bump u8, index u16, creator, base_mint, quote_mint, lp_mint, base vault, quote vault, lp_supply u64, coin_creator. */
export function decodePumpSwapPool(d: Buffer): Omit<PoolLp, 'lpSupply' | 'holders'> {
  if (d.length < 211) throw new Error(`PumpSwap pool account too short (${d.length} bytes)`);
  const key = (o: number) => base58(d.subarray(o, o + 32));
  return { creator: key(11), baseMint: key(43), quoteMint: key(75), lpMint: key(107), baseVault: key(139), quoteVault: key(171) };
}

// ───────────────────────────── the vet ─────────────────────────────

export const UNKNOWN_RETRY_MS = 5 * 60e3;

export interface RugproofVetOpts { probe: RugProbe; log?: (rec: Record<string, unknown>) => void }

/**
 * The strategy's rug-proof gates as a runner vet: free gates first (tick + history), then the pair, the pool account,
 * the withdraw scan and the Jupiter route. The first refusal ends it; a time gate asks to be retried.
 */
export function rugproofVet(r: RugproofRules, o: RugproofVetOpts): VetFn {
  return async (k: MarketTick, ctx?: VetContext): Promise<VetResult> => {
    const results: GateResult[] = [];
    const now = k.t;
    const done = (x: GateResult): VetResult | null => {
      results.push(x);
      if (x.pass) return null;
      o.log?.({ mint: k.mint, symbol: k.symbol, gate: x.gate, rule: x.rule, detail: x.detail, results: results.map((y) => `${y.gate}:${y.pass ? 'ok' : 'no'}`) });
      // A read that failed (`-unknown`: a rate limit, an RPC outage) refuses now (fail closed) and looks again in 5 min,
      // instead of skipping the coin for the rest of the run; a structural refusal is for good.
      const retry = x.retryAfterMs ?? (x.rule.endsWith('-unknown') ? UNKNOWN_RETRY_MS : undefined);
      return { ok: false, rule: x.rule, detail: x.detail, ...(retry !== undefined ? { retryAfterMs: retry } : {}) };
    };
    const history = ctx?.history ?? [];
    const sizeUsd = ctx?.sizeUsd ?? 0;
    const floor = ctx?.exitFloorUsd ?? 2000;
    // 1-3: free.
    let f = done(gatePoolAge(r, k, undefined, now)); if (f) return f;
    f = done(gateHolders(k, ctx?.maxTop10Pct ?? null, ctx?.maxDevPct ?? null, ctx?.unknownHolders)); if (f) return f;
    f = done(gateLiquidityRecheck(r, history, k, floor)); if (f) return f;
    // 4: the pool as listed.
    let pair: PoolPair | null = null;
    let pairErr: string | null = null;
    try { pair = await o.probe.pair(k.mint); } catch (e) { pairErr = (e as Error).message.slice(0, 160); }
    results.shift(); // the token-age pass above is replaced by the pool's own age
    if (pairErr !== null) return done({ gate: 'pool-structure', pass: false, rule: 'rugproof:pool-structure-unknown', detail: `the pool could not be read: ${pairErr}` }) as VetResult;
    f = done(gatePoolAge(r, k, pair ? pair.createdAt : null, now)); if (f) return f;
    f = done(gatePoolStructure(r, k.mint, k.launchpad, pair)); if (f) return f;
    // 5-6: the chain.
    let lp: PoolLp | null | 'error' = null;
    if (r.requireSafePool && pair) {
      lp = o.probe.d.rpcUrl ? await o.probe.poolLp(pair.address, now) : 'error';
      f = done(gateLpLocked(r, pair, lp, k.mint)); if (f) return f;
      const poolLp = lp as PoolLp;
      const scan = poolLp.lpSupply === 0n && r.maxWithdraws === 0 ? null : await o.probe.withdraws(pair.address, poolLp.creator, r.withdrawScanTx);
      f = done(gateWithdrawHistory(r, scan, poolLp)); if (f) return f;
    }
    // 7: a sell route at routeX x the size.
    if (r.routeX !== null) {
      const dec = await o.probe.tokenDecimals(k.mint);
      let route: RouteRead | null = null;
      if (dec !== null && k.price) {
        const tokens = (sizeUsd * r.routeX) / k.price;
        route = await o.probe.route(k.mint, BigInt(Math.max(1, Math.round(tokens * 10 ** dec))));
      }
      f = done(gateSellRoute(r, route, sizeUsd)); if (f) return f;
    }
    const v = verdictOf(r, results, pair?.createdAt ? now - pair.createdAt : null);
    const note = `rugproof ok: ${results.map((x) => `${x.gate}${x.partial ? '~' : ''}`).join(', ')}${v.sizeCapPct !== null ? `; size cap ${v.sizeCapPct}% (young or partly verified pool)` : ''}`;
    o.log?.({ mint: k.mint, symbol: k.symbol, pass: true, sizeCapPct: v.sizeCapPct, results: results.map((x) => `${x.gate}:${x.partial ? 'partial' : 'ok'}`) });
    return { ok: true, note, recheck: true, ...(v.sizeCapPct !== null ? { sizeCapPct: v.sizeCapPct } : {}), ...(pair ? { pool: { address: pair.address, quoteVault: lp && lp !== 'error' ? lp.quoteVault : null } } : {}) };
  };
}

// ───────────────────────────── the drain poller ─────────────────────────────

interface Watched { pos: DrainWatchPosition; base: DrainBase; timer: ReturnType<typeof setInterval> | null; verdict: DrainVerdict | null; reads: number; quoteErrors: number; noRoute: number; busy: boolean; decimals: number | null }

/**
 * Polls every open position's pool (SOL vault when the pool is known, plus a Jupiter quote for the held amount)
 * every pollSec, outside the candle / tick cadence. The runner reads `verdict()` on every step and sells the whole
 * position on an exit verdict. Timers are unref'd: they never keep a process alive.
 */
export class DrainPoller implements DrainWatch {
  private readonly w = new Map<string, Watched>();
  readonly g: DrainGuardRules;
  private readonly probe: RugProbe;
  private readonly log?: (rec: Record<string, unknown>) => void;
  constructor(g: DrainGuardRules, probe: RugProbe, log?: (rec: Record<string, unknown>) => void) { this.g = g; this.probe = probe; this.log = log; }

  watch(p: DrainWatchPosition): void {
    if (this.w.has(p.positionId)) return;
    const x: Watched = { pos: p, base: { reserveSol: null, liqUsd: p.entryLiqUsd }, timer: null, verdict: null, reads: 0, quoteErrors: 0, noRoute: 0, busy: false, decimals: null };
    this.w.set(p.positionId, x);
    void this.poll(x, true);
    x.timer = setInterval(() => { void this.poll(x, false); }, Math.max(2, Math.min(10, this.g.pollSec)) * 1000);
    x.timer.unref?.();
  }

  unwatch(positionId: string): void {
    const x = this.w.get(positionId);
    if (x?.timer) clearInterval(x.timer);
    this.w.delete(positionId);
  }

  verdict(positionId: string): Extract<DrainVerdict, { exit: true }> | null {
    const v = this.w.get(positionId)?.verdict ?? null;
    return v && v.exit ? v : null;
  }

  stop(): void { for (const id of [...this.w.keys()]) this.unwatch(id); }

  /** One probe of one position (also called by tests). */
  async poll(x: Watched, first: boolean): Promise<void> {
    if (x.busy) return;
    x.busy = true;
    try {
      let vault = x.pos.quoteVault ?? null;
      if (!vault && x.pos.poolAddress && this.probe.d.rpcUrl) {
        const lp = await this.probe.poolLp(x.pos.poolAddress);
        if (lp && lp !== 'error') vault = x.pos.quoteVault = lp.quoteVault;
      }
      const reserveSol = vault && this.probe.d.rpcUrl ? await this.probe.vaultSol(vault) : null;
      if (first || x.base.reserveSol === null) { if (reserveSol !== null) x.base.reserveSol = reserveSol; }
      x.decimals ??= await this.probe.tokenDecimals(x.pos.mint);
      const tokens = x.pos.tokens();
      const route = this.g.exitOnNoRoute && x.decimals !== null && tokens > 0 ? await this.probe.route(x.pos.mint, BigInt(Math.max(1, Math.round(tokens * 10 ** x.decimals)))) : null;
      x.reads++;
      if (route && !route.ok && route.kind !== 'no-route') x.quoteErrors++;
      let v = drainVerdict(this.g, x.base, { t: Date.now(), reserveSol, liqUsd: null, route });
      // A quote error alone needs two reads in a row (one pollSec apart): a single odd answer is not a pull. A reserve
      // read decides at once. The poller keeps polling after an exit: a route that comes back lifts the verdict.
      x.noRoute = v.exit && v.reason === 'drain-no-route' ? x.noRoute + 1 : 0;
      if (v.exit && v.reason === 'drain-no-route' && x.noRoute < 2) v = { exit: false, note: 'no route once: re-checking' };
      const was = x.verdict?.exit ?? false;
      x.verdict = v;
      if (v.exit && !was) this.log?.({ positionId: x.pos.positionId, mint: x.pos.mint, drain: v.reason, detail: v.detail, reads: x.reads });
    } catch (e) {
      this.log?.({ positionId: x.pos.positionId, mint: x.pos.mint, probeError: (e as Error).message.slice(0, 160) });
    } finally { x.busy = false; }
  }

  stats(): { watched: number; reads: number; quoteErrors: number } {
    let reads = 0; let quoteErrors = 0;
    for (const x of this.w.values()) { reads += x.reads; quoteErrors += x.quoteErrors; }
    return { watched: this.w.size, reads, quoteErrors };
  }
}


/** Run vets in order (the rug-proof gates first: they are the cheapest); the first refusal wins; notes and caps merge. */
export function chainVets(...vets: (VetFn | undefined)[]): VetFn | undefined {
  const vs = vets.filter((v): v is VetFn => !!v);
  if (vs.length <= 1) return vs[0];
  return async (k, ctx) => {
    const notes: string[] = [];
    let out: VetResult = { ok: true };
    for (const v of vs) {
      const r = await v(k, ctx);
      if (!r.ok) return r;
      if (r.note) notes.push(r.note);
      out = { ...out, ...r, recheck: !!(out.ok && out.recheck) || !!r.recheck, ...(out.ok && out.sizeCapPct !== undefined && (r.sizeCapPct === undefined || out.sizeCapPct < r.sizeCapPct) ? { sizeCapPct: out.sizeCapPct } : {}) };
    }
    return notes.length ? { ...out, note: notes.join('; ') } as VetResult : out;
  };
}
