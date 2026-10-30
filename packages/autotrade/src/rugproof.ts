// dexterm autotrade — rug-proofing (task-1748): who can pull the pool, and a fast exit when it starts to go. PAPER ONLY.
//
// The control's two 2026-10-26 losses ($NOTHING, $AMERICA) and the three on 10-27 were creator LP pulls on hand-made
// PumpSwap pools: WSOL as the pool's BASE mint, launchpad unknown, the mint not ending in `pump`, the creator holding the
// LP tokens (FINDINGS-2026-10-27 §1-2). A pull is ONE transaction with no build-up: every post-entry signal (the pool's
// SOL vault, a Jupiter quote, DexScreener liquidity) fires only after it. So the PRIMARY defense is pre-entry and
// structural; the drain guard below only shortens the time a position sits in a pool that is being emptied and makes
// the book honest. A same-block creator pull cannot be front-run by anyone reading the chain.
//
// Pre-entry gates, cheapest first, fail closed (a gate that cannot be evaluated refuses the coin with `-unknown`):
//   pool-age            pool (pair) age >= minPoolAgeMin. Token age is a free lower bound first (a token younger
//                       than the minimum has no older pool); the pair's own creation time decides.        tick, pair
//   holders             top-10 / dev share under the strategy's safety values (unknown = refuse)           tick
//   liquidity-recheck   two liquidity reads >= afterSec apart: both >= floorX x the exit floor, the newer
//                       not more than maxDropPct under the older                                           history
//   pool-structure      the pool is a pump.fun migration (PumpSwap, token = base, WSOL = quote) or a pool
//                       whose LP is verifiably burned / locked; WSOL as the BASE mint = hand-made: refuse   pair
//   lp-locked           PumpSwap pool account -> lp mint: supply 0 (burned) passes; supply > 0 with the
//                       largest holder the pool creator (or any wallet over maxHolderLpPct) refuses         RPC
//   withdraw-history    no `Withdraw` instruction among the pool's newest transactions (bounded scan)       RPC
//   sell-route          a Jupiter token -> SOL quote at routeX x the position size returns a route           Jupiter
// Every result has a named rule (`rugproof:<gate>[-why]`) that lands in the ledger; time gates (age, recheck) say
// when to look again instead of skipping the coin for good.
//
// Post-entry (drainVerdict): exit the whole position at once on liquidity / reserve down > liqDropPct from the entry
// read, a reserve near 0, or ANY Jupiter quote error (NO_ROUTES_FOUND, CANNOT_COMPUTE_…). A rate limit or a network
// failure is not a quote error (no exit on it; it is counted). Young or partly-verified pools get a smaller size
// (youngPoolSizeCapUsd).
//
// Pure: no I/O. The probes (DexScreener pair, PumpSwap pool account, LP mint, signatures, Jupiter) are in rugproof-probe.ts.

import type { MarketTick } from './replay.ts';
import type { VetContext, VetFn, VetResult } from './runner.ts';

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const PUMPSWAP_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

export interface DrainGuardRules {
  /** Probe each open position at most this many seconds apart (<= 10 s). */
  pollSec: number;
  /** Exit when liquidity (or the pool's SOL reserve) is this % under the entry read. */
  liqDropPct: number;
  /** Exit on any Jupiter quote error for the held amount. */
  exitOnNoRoute: boolean;
  /** Exit when the pool's SOL reserve is under this many SOL. */
  minReserveSol: number;
}

export interface RugproofRules {
  minPoolAgeMin: number;
  /** pump.fun migration or a verifiably burned / locked LP; anything else is refused. */
  requireSafePool: boolean;
  /** LP held by any one wallet above this % of the LP supply refuses (the creator: any share). */
  maxHolderLpPct: number;
  /** `Withdraw` instructions allowed among the pool's newest `withdrawScanTx` transactions (0 = none). */
  maxWithdraws: number;
  withdrawScanTx: number;
  liquidityRecheck: { afterSec: number; floorX: number; maxDropPct: number } | null;
  /** Jupiter token -> SOL must route this multiple of the position size; null = not checked. */
  routeX: number | null;
  /** Pools younger than underMin (or with a gate only partly verified) get at most maxSizePct of the strategy's size. */
  youngPool: { underMin: number; maxSizePct: number } | null;
  drainGuard: DrainGuardRules | null;
}

export const RUGPROOF_DEFAULTS: RugproofRules = {
  minPoolAgeMin: 10,
  requireSafePool: true,
  maxHolderLpPct: 10,
  maxWithdraws: 0,
  withdrawScanTx: 25,
  liquidityRecheck: { afterSec: 60, floorX: 2, maxDropPct: 15 },
  routeX: 2,
  youngPool: { underMin: 30, maxSizePct: 50 },
  drainGuard: { pollSec: 10, liqDropPct: 25, exitOnNoRoute: true, minReserveSol: 0.5 },
};

export type GateName = 'pool-age' | 'holders' | 'liquidity-recheck' | 'pool-structure' | 'lp-locked' | 'withdraw-history' | 'sell-route';
export const GATE_ORDER: readonly GateName[] = ['pool-age', 'holders', 'liquidity-recheck', 'pool-structure', 'lp-locked', 'withdraw-history', 'sell-route'];

export interface GateResult {
  gate: GateName;
  pass: boolean;
  /** The ledger rule: `rugproof:<gate>` or `rugproof:<gate>-<why>`. */
  rule: string;
  detail: string;
  /** A time gate that may pass later: look again after this many ms (otherwise the refusal is for good). */
  retryAfterMs?: number;
  /** Passed, but not fully verified (a size cap applies). */
  partial?: boolean;
}

const pass = (gate: GateName, detail: string, partial = false): GateResult => ({ gate, pass: true, rule: `rugproof:${gate}`, detail, ...(partial ? { partial: true } : {}) });
const fail = (gate: GateName, why: string | null, detail: string, retryAfterMs?: number): GateResult => ({ gate, pass: false, rule: `rugproof:${gate}${why ? `-${why}` : ''}`, detail, ...(retryAfterMs !== undefined ? { retryAfterMs: Math.max(1000, Math.round(retryAfterMs)) } : {}) });
const m = (ms: number) => `${(ms / 60e3).toFixed(1)} min`;
const usd = (x: number) => `$${Math.round(x).toLocaleString('en-US')}`;

/** A pump.fun mint (vanity suffix) or Jupiter's launchpad tag says pump.fun. */
export const isPumpMint = (mint: string, launchpad?: string | null): boolean => mint.endsWith('pump') || launchpad === 'pump' || launchpad === 'pump.fun';

// ───────────────────────────── free gates (tick + history) ─────────────────────────────

/** Token age is a lower bound on pool age; the pair's creation time (when known) decides. */
export function gatePoolAge(r: RugproofRules, k: MarketTick, pairCreatedAt: number | null | undefined, now = k.t): GateResult {
  const min = r.minPoolAgeMin * 60e3;
  if (k.createdAt !== null && now - k.createdAt < min) return fail('pool-age', null, `token age ${m(now - k.createdAt)} < ${r.minPoolAgeMin} min (no older pool can exist)`, min - (now - k.createdAt));
  if (pairCreatedAt === undefined) return pass('pool-age', 'token age ok; pool age not read yet', true);
  if (pairCreatedAt === null) return fail('pool-age', 'unknown', 'the pool has no creation time');
  const age = now - pairCreatedAt;
  if (age < min) return fail('pool-age', null, `pool age ${m(age)} < ${r.minPoolAgeMin} min`, min - age);
  return pass('pool-age', `pool age ${m(age)}`);
}

/**
 * The strategy's own holder values (entry.safety, the GUARDRAILS numbers), with its own unknown rules: an unknown top-10
 * share refuses unless unknownHolders is allow; an unknown dev share passes, as the engine's screen has always done (the
 * holder sources rarely report it: refusing it would refuse nearly every coin), and is marked partial.
 */
export function gateHolders(k: MarketTick, maxTop10Pct: number | null, maxDevPct: number | null, unknownHolders: 'reject' | 'allow' = 'reject'): GateResult {
  let partial = false;
  if (maxTop10Pct !== null) {
    if (k.top10 === null) { if (unknownHolders === 'reject') return fail('holders', 'unknown', 'top-10 share unknown'); partial = true; }
    else if (k.top10 > maxTop10Pct) return fail('holders', 'top10', `top 10 hold ${k.top10.toFixed(1)}% > ${maxTop10Pct}%`);
  }
  if (maxDevPct !== null && k.dev !== null && k.dev > maxDevPct) return fail('holders', 'dev', `dev holds ${k.dev.toFixed(1)}% > ${maxDevPct}%`);
  return pass('holders', `top10 ${k.top10 ?? '?'}%, dev ${k.dev ?? 'unknown'}%`, partial);
}

/**
 * Two liquidity reads at least afterSec apart (the newest and the newest one at or before now - afterSec, from the
 * coin's own tick history): both >= floorX x the exit floor, the newer not more than maxDropPct under the older.
 */
export function gateLiquidityRecheck(r: RugproofRules, history: readonly MarketTick[], k: MarketTick, exitFloorUsd: number): GateResult {
  const rc = r.liquidityRecheck;
  if (!rc) return pass('liquidity-recheck', 'not required');
  const floor = rc.floorX * exitFloorUsd;
  const liqNow = k.liq;
  if (liqNow === null) return fail('liquidity-recheck', 'unknown', 'no liquidity read');
  if (liqNow < floor) return fail('liquidity-recheck', 'floor', `liquidity ${usd(liqNow)} < ${rc.floorX}x the ${usd(exitFloorUsd)} exit floor`);
  const cutoff = k.t - rc.afterSec * 1000;
  let older: MarketTick | null = null;
  for (const h of history) if (h.mint === k.mint && h.t <= cutoff && h.liq !== null && (!older || h.t > older.t)) older = h;
  if (!older) {
    const first = history.find((h) => h.mint === k.mint && h.liq !== null);
    const wait = first ? first.t + rc.afterSec * 1000 - k.t : rc.afterSec * 1000;
    return fail('liquidity-recheck', 'pending', `no read ${rc.afterSec} s before this one yet`, wait > 0 ? wait : rc.afterSec * 1000);
  }
  if ((older.liq as number) < floor) return fail('liquidity-recheck', 'floor', `liquidity ${usd(older.liq as number)} ${Math.round((k.t - older.t) / 1000)} s ago < ${rc.floorX}x the exit floor`);
  const drop = ((older.liq as number) - liqNow) / (older.liq as number) * 100;
  if (drop > rc.maxDropPct) return fail('liquidity-recheck', 'falling', `liquidity ${usd(older.liq as number)} -> ${usd(liqNow)} in ${Math.round((k.t - older.t) / 1000)} s (-${drop.toFixed(1)}% > ${rc.maxDropPct}%)`);
  return pass('liquidity-recheck', `${usd(older.liq as number)} -> ${usd(liqNow)} over ${Math.round((k.t - older.t) / 1000)} s`);
}

// ───────────────────────────── structural gates (pair + chain) ─────────────────────────────

/** The pool as DexScreener lists it (the coin's deepest pair). */
export interface PoolPair { address: string; dex: string; baseMint: string; quoteMint: string; createdAt: number | null; liqUsd: number | null }

/** The PumpSwap pool account and its LP mint, as read from the chain. */
export interface PoolLp {
  creator: string;
  baseMint: string;
  quoteMint: string;
  lpMint: string;
  /** LP mint supply right now (raw units). 0 = every LP token burned: nobody can withdraw. */
  lpSupply: bigint;
  /** Largest LP holders (owner of the token account, raw amount), largest first. Empty when supply is 0. */
  holders: { owner: string; amount: bigint }[];
  quoteVault: string;
  baseVault: string;
}

/** Owners that hold LP tokens without being able to withdraw them (burn / incinerator). Locks are not trusted by name. */
export const BURN_OWNERS: ReadonlySet<string> = new Set(['1nc1nerator11111111111111111111111111111111', '11111111111111111111111111111111']);

export function gatePoolStructure(r: RugproofRules, mint: string, launchpad: string | null, pair: PoolPair | null): GateResult {
  if (!r.requireSafePool) return pass('pool-structure', 'not required');
  if (!pair) return fail('pool-structure', 'unknown', 'no pool listed for the coin');
  if (pair.baseMint === WSOL_MINT) return fail('pool-structure', 'wsol-base', `WSOL is the pool's base mint (${pair.dex} ${pair.address.slice(0, 8)}…): a hand-made pool, not a pump.fun migration`);
  if (pair.baseMint !== mint) return fail('pool-structure', 'not-base', `the coin is not the pool's base mint (${pair.dex})`);
  if (pair.quoteMint !== WSOL_MINT) return fail('pool-structure', 'quote', `the pool's quote is not WSOL (${pair.quoteMint.slice(0, 8)}…)`);
  const dex = pair.dex.toLowerCase();
  if (dex === 'pumpswap') {
    return isPumpMint(mint, launchpad)
      ? pass('pool-structure', 'pump.fun migration shape (PumpSwap, token = base, WSOL = quote)')
      : pass('pool-structure', `PumpSwap, token = base, WSOL = quote, launchpad ${launchpad ?? 'unknown'}: LP must be verified`, true);
  }
  // Other venues (Raydium, Meteora, …): the LP lock cannot be verified here, so it is refused (fail closed).
  return fail('pool-structure', 'unverifiable', `${pair.dex} pool: its LP lock cannot be verified by dexterm (only PumpSwap pools are read)`);
}

export function gateLpLocked(r: RugproofRules, pair: PoolPair, lp: PoolLp | null | 'error', mint: string): GateResult {
  if (!r.requireSafePool) return pass('lp-locked', 'not required');
  if (lp === 'error' || lp === null) return fail('lp-locked', 'unknown', `the PumpSwap pool account ${pair.address.slice(0, 8)}… could not be read`);
  if (lp.baseMint === WSOL_MINT) return fail('lp-locked', 'wsol-base', 'the pool account says WSOL is the base mint (hand-made pool)');
  if (lp.baseMint !== mint || lp.quoteMint !== WSOL_MINT) return fail('lp-locked', 'mismatch', 'the pool account does not match the listed pair');
  if (lp.lpSupply === 0n) return pass('lp-locked', 'LP supply 0: every LP token is burned, nobody can withdraw');
  const live = lp.holders.filter((h) => !BURN_OWNERS.has(h.owner) && h.amount > 0n);
  const share = (a: bigint) => Number((a * 1_000_000n) / lp.lpSupply) / 10_000;
  const byCreator = live.find((h) => h.owner === lp.creator);
  if (byCreator) return fail('lp-locked', 'creator', `the pool creator ${lp.creator.slice(0, 8)}… holds ${share(byCreator.amount).toFixed(2)}% of the LP: it can withdraw at any time`);
  const top = live[0];
  if (top && share(top.amount) > r.maxHolderLpPct) return fail('lp-locked', 'holder', `one wallet ${top.owner.slice(0, 8)}… holds ${share(top.amount).toFixed(2)}% of the LP (> ${r.maxHolderLpPct}%)`);
  if (!lp.holders.length) return fail('lp-locked', 'unknown', 'LP supply > 0 but the holder list could not be read');
  return pass('lp-locked', `LP supply > 0, largest live holder ${top ? share(top.amount).toFixed(2) : 0}%`, true);
}

export interface WithdrawScan { scanned: number; withdraws: number; byCreator: number }

export function gateWithdrawHistory(r: RugproofRules, scan: WithdrawScan | null | 'error', lp: PoolLp | null): GateResult {
  if (lp && lp.lpSupply === 0n && r.maxWithdraws === 0 && scan === null) return pass('withdraw-history', 'LP burned: a withdraw is impossible');
  if (scan === 'error' || scan === null) return fail('withdraw-history', 'unknown', 'the pool\'s transactions could not be read');
  if (scan.byCreator > 0) return fail('withdraw-history', 'creator', `${scan.byCreator} creator Withdraw among the pool's newest ${scan.scanned} transactions`);
  if (scan.withdraws > r.maxWithdraws) return fail('withdraw-history', null, `${scan.withdraws} Withdraw among the pool's newest ${scan.scanned} transactions (max ${r.maxWithdraws})`);
  return pass('withdraw-history', `no Withdraw among the newest ${scan.scanned} transactions`, scan.scanned < Math.min(5, r.withdrawScanTx));
}

/** A Jupiter quote for the token -> SOL sale. `rate-limited` / `network` are not quote errors. */
export type RouteRead = { ok: true; outLamports: bigint; impactPct: number | null } | { ok: false; kind: 'no-route' | 'rate-limited' | 'network'; error: string };

export function gateSellRoute(r: RugproofRules, route: RouteRead | null, sizeUsd: number): GateResult {
  if (r.routeX === null) return pass('sell-route', 'not required');
  if (!route) return fail('sell-route', 'unknown', 'no sell quote');
  if (!route.ok) return fail('sell-route', route.kind === 'no-route' ? 'none' : 'unknown', `Jupiter token -> SOL at ${r.routeX}x the ${usd(sizeUsd)} size: ${route.error}`);
  return pass('sell-route', `Jupiter routes ${r.routeX}x the size (impact ${route.impactPct ?? '?'}%)`);
}

// ───────────────────────────── verdict ─────────────────────────────

export interface RugproofVerdict {
  pass: boolean;
  results: GateResult[];
  /** The first refusal, or null. */
  refused: GateResult | null;
  /** A gate passed without full verification, or the pool is young: the size cap applies. */
  sizeCapPct: number | null;
}

export function verdictOf(r: RugproofRules, results: GateResult[], poolAgeMs: number | null): RugproofVerdict {
  const refused = results.find((x) => !x.pass) ?? null;
  const partial = results.some((x) => x.partial);
  const young = r.youngPool && (poolAgeMs === null || poolAgeMs < r.youngPool.underMin * 60e3);
  return { pass: !refused, results, refused, sizeCapPct: !refused && r.youngPool && (partial || young) ? r.youngPool.maxSizePct : null };
}

// ───────────────────────────── post-entry drain guard ─────────────────────────────

export interface DrainRead {
  t: number;
  /** The pool's SOL reserve now (on-chain vault), or null when not read. */
  reserveSol: number | null;
  /** Liquidity in USD from the feed (DexScreener), or null. */
  liqUsd: number | null;
  route: RouteRead | null;
}

export interface DrainBase { reserveSol: number | null; liqUsd: number | null }

export type DrainVerdict = { exit: true; reason: 'drain-reserve' | 'drain-liquidity' | 'drain-no-route'; detail: string; liqUsd: number | null } | { exit: false; note?: string };

/** Exit the whole position at once on a reserve near 0, a reserve / liquidity drop > liqDropPct, or a quote error. */
export function drainVerdict(g: DrainGuardRules, base: DrainBase, read: DrainRead): DrainVerdict {
  const ratio = base.reserveSol && read.reserveSol !== null ? read.reserveSol / base.reserveSol : null;
  const estLiq = ratio !== null && base.liqUsd !== null ? base.liqUsd * ratio : read.liqUsd;
  if (read.reserveSol !== null && read.reserveSol < g.minReserveSol) return { exit: true, reason: 'drain-reserve', detail: `pool SOL reserve ${read.reserveSol.toFixed(3)} < ${g.minReserveSol} SOL`, liqUsd: estLiq ?? 0 };
  if (ratio !== null && (1 - ratio) * 100 > g.liqDropPct) return { exit: true, reason: 'drain-liquidity', detail: `pool SOL reserve ${base.reserveSol!.toFixed(2)} -> ${read.reserveSol!.toFixed(2)} (-${((1 - ratio) * 100).toFixed(1)}% > ${g.liqDropPct}%)`, liqUsd: estLiq };
  if (base.liqUsd && read.liqUsd !== null && (1 - read.liqUsd / base.liqUsd) * 100 > g.liqDropPct) return { exit: true, reason: 'drain-liquidity', detail: `liquidity ${usd(base.liqUsd)} -> ${usd(read.liqUsd)} (-${((1 - read.liqUsd / base.liqUsd) * 100).toFixed(1)}% > ${g.liqDropPct}% since entry)`, liqUsd: read.liqUsd };
  if (g.exitOnNoRoute && read.route && !read.route.ok && read.route.kind === 'no-route') return { exit: true, reason: 'drain-no-route', detail: `Jupiter has no sell route: ${read.route.error}`, liqUsd: estLiq ?? 0 };
  if (read.route && !read.route.ok) return { exit: false, note: `quote ${read.route.kind}: ${read.route.error}` };
  return { exit: false };
}

/** The size a young or partly-verified pool may take: maxSizePct of what the strategy picked. */
export function youngPoolSizeCapUsd(v: RugproofVerdict, usdPicked: number): number | null {
  return v.sizeCapPct === null ? null : (usdPicked * v.sizeCapPct) / 100;
}

// ───────────────────────────── offline (replays, backtests) ─────────────────────────────

/**
 * The gates a recorded tape can evaluate: pool age (the tape's createdAt: the token's, else the pair's), holders, the
 * second liquidity read (the coin's own recorded rows; the recorder's ~2-min cadence makes afterSec at least one row
 * gap), and the pool-structure PROXY: a pump.fun mint (`…pump` / launchpad pump) passes, anything else is refused as
 * `rugproof:pool-structure-offline` (the tape has no pool account, LP mint or transactions). Used by backtest() for a
 * rug-proof strategy and by the control's replay.
 */
export function rugproofTapeVet(r: RugproofRules): VetFn {
  return async (k: MarketTick, ctx?: VetContext): Promise<VetResult> => {
    const res = [
      gatePoolAge(r, k, k.createdAt, k.t),
      gateHolders(k, ctx?.maxTop10Pct ?? null, ctx?.maxDevPct ?? null, ctx?.unknownHolders),
      // the structural proxy is free on a tape: it goes before the second read (a refusal for good beats a wait)
      !r.requireSafePool || isPumpMint(k.mint, k.launchpad) ? pass('pool-structure', 'pump.fun mint (offline proxy)') : fail('pool-structure', 'offline', `not a pump.fun mint (launchpad ${k.launchpad}): the tape cannot verify its LP`),
      gateLiquidityRecheck(r, ctx?.history ?? [], k, ctx?.exitFloorUsd ?? 2000),
    ];
    const bad = res.find((x) => !x.pass);
    if (bad) return { ok: false, rule: bad.rule, detail: bad.detail, ...(bad.retryAfterMs !== undefined ? { retryAfterMs: bad.retryAfterMs } : {}) };
    const v = verdictOf(r, res, k.createdAt !== null ? k.t - k.createdAt : null);
    return { ok: true, recheck: true, ...(v.sizeCapPct !== null ? { sizeCapPct: v.sizeCapPct } : {}) };
  };
}
