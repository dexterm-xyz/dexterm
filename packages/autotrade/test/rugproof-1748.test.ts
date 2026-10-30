// task-1748: rug-proofing. The pre-entry gates (rugproof.ts), the read-only probes behind them (rugproof-probe.ts, a
// fake fetch: no network), the runner's vet retry / young-pool size cap / drain guard / stuck write-off, and the strategy
// schema. PAPER only: no wallet, no key, no send.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base58 } from '@dexterm/data';
import { loadPreset, validateStrategy, type ResolvedStrategy } from '../src/strategy.ts';
import type { MarketTick, Tape } from '../src/replay.ts';
import { runAutotrade, simExecutor, type DrainWatch, type DrainWatchPosition, type Executor, type RealRunHook, type VetFn } from '../src/runner.ts';
import type { Position } from '../src/engine.ts';
import type { RealStatus } from '../src/real-mode.ts';
import { backtest } from '../src/backtest.ts';
import {
  RUGPROOF_DEFAULTS, WSOL_MINT, PUMPSWAP_PROGRAM, drainVerdict, gateHolders, gateLiquidityRecheck, gateLpLocked, gatePoolAge, gatePoolStructure,
  gateSellRoute, gateWithdrawHistory, rugproofTapeVet, verdictOf, type PoolLp, type PoolPair, type RugproofRules,
} from '../src/rugproof.ts';
import { DrainPoller, RugProbe, chainVets, decodePumpSwapPool, rugproofVet, type FetchJson } from '../src/rugproof-probe.ts';

const T0 = 1_792_000_000_000;
const MIN = 60_000;
const keyBuf = (s: string) => { const b = Buffer.alloc(32); Buffer.from(s.padEnd(32, '.')).copy(b); return b; };
const PUMP = base58(keyBuf('pump-mint'));
const HAND = 'FXnd3GUP111111111111111111111111111353Le';
const POOL = 'RDNbfT2p11111111111111111111111111111FYG';
const CREATOR = '5KFjp4fG1111111111111111111111111111111111';
const R: RugproofRules = RUGPROOF_DEFAULTS;

function tick(over: Partial<MarketTick> = {}): MarketTick {
  return {
    mint: PUMP, t: T0, kind: 'live', symbol: 'TEST', launchpad: 'pump.fun', createdAt: T0 - 60 * MIN,
    price: 1, mcap: 1e6, mcapResolved: 1e6, mcapFlagged: false, liq: 100_000, vol5m: 10_000, vol1h: 50_000, vol24: 500_000,
    buys5m: 120, sells5m: 80, buys24: 5000, sells24: 4000, chg5m: 4, chg1h: 20, chg6h: 40, chg24h: 80,
    holders: 900, top10: 20, dev: 1, mintAuth: false, freezeAuth: false, org: 70, ...over,
  };
}
const tape = (ticks: MarketTick[]): Tape => ({ source: 'synthetic', ticks, mints: [...new Set(ticks.map((k) => k.mint))] });
const pairOf = (over: Partial<PoolPair> = {}): PoolPair => ({ address: POOL, dex: 'pumpswap', baseMint: PUMP, quoteMint: WSOL_MINT, createdAt: T0 - 60 * MIN, liqUsd: 100_000, ...over });
const lpOf = (over: Partial<PoolLp> = {}): PoolLp => ({ creator: CREATOR, baseMint: PUMP, quoteMint: WSOL_MINT, lpMint: 'LpMint1111111111111111111111111111111111111', lpSupply: 0n, holders: [], quoteVault: 'QVault11111111111111111111111111111111111111', baseVault: 'BVault11111111111111111111111111111111111111', ...over });

/** The moonbag preset, mechanical, one position at a time, with the rug-proof block (and the write-off). */
function rugStrategy(over: Partial<RugproofRules> | null = {}, writeOff: number | null = 30): ResolvedStrategy {
  const b = loadPreset('moonbag');
  return {
    ...b, entry: { ...b.entry, decide: 'auto', ageHours: { min: 0, max: 48 }, safety: { ...b.entry.safety, rugproof: over === null ? null : { ...R, ...over } } },
    risk: { ...b.risk, maxConcurrent: 1, perCoin: { maxEntries: 1, cooldownMin: 0 } },
    execution: { ...b.execution, latencyMs: 0, stuckWriteOffMin: writeOff },
  };
}

// ───────────────────────────── the gates (pure) ─────────────────────────────

test('1748 gate pool-age: a token younger than the minimum refuses for now (retry), the pool age decides, unknown refuses', () => {
  const young = gatePoolAge(R, tick({ createdAt: T0 - 4 * MIN }), undefined);
  assert.equal(young.pass, false); assert.equal(young.rule, 'rugproof:pool-age'); assert.equal(young.retryAfterMs, 6 * MIN);
  assert.equal(gatePoolAge(R, tick(), undefined).partial, true, 'token age alone is only a lower bound');
  // An old token in a fresh hand-made pool: the pool's own creation time decides.
  const fresh = gatePoolAge(R, tick({ createdAt: T0 - 72 * 60 * MIN }), T0 - 1 * MIN);
  assert.equal(fresh.pass, false); assert.equal(fresh.retryAfterMs, 9 * MIN);
  assert.equal(gatePoolAge(R, tick(), null).rule, 'rugproof:pool-age-unknown');
  assert.equal(gatePoolAge(R, tick(), T0 - 11 * MIN).pass, true);
});

test('1748 gate holders: the strategy values and its unknown rules (top-10 unknown refuses on reject; dev unknown passes, as the screen)', () => {
  assert.equal(gateHolders(tick({ top10: null }), 30, 5).rule, 'rugproof:holders-unknown');
  assert.equal(gateHolders(tick({ top10: null }), 30, 5, 'allow').partial, true);
  assert.equal(gateHolders(tick({ top10: 41 }), 30, 5).rule, 'rugproof:holders-top10');
  assert.equal(gateHolders(tick({ dev: 9 }), 30, 5).rule, 'rugproof:holders-dev');
  assert.equal(gateHolders(tick({ dev: null }), 30, 5).pass, true);
  assert.equal(gateHolders(tick(), 30, 5).pass, true);
});

test('1748 gate liquidity-recheck: two reads 60 s apart, both >= 2x the exit floor, not falling > 15%', () => {
  const now = tick({ t: T0 + 2 * MIN, liq: 90_000 });
  const pending = gateLiquidityRecheck(R, [tick({ t: T0 + 90_000 })], now, 2000);
  assert.equal(pending.rule, 'rugproof:liquidity-recheck-pending'); assert.ok((pending.retryAfterMs ?? 0) > 0);
  assert.equal(gateLiquidityRecheck(R, [tick({ t: T0 })], tick({ t: T0 + MIN, liq: 3000 }), 2000).rule, 'rugproof:liquidity-recheck-floor');
  const falling = gateLiquidityRecheck(R, [tick({ t: T0, liq: 120_000 })], tick({ t: T0 + MIN, liq: 100_000 }), 2000);
  assert.equal(falling.rule, 'rugproof:liquidity-recheck-falling');
  assert.match(falling.detail, /-16\.7%/);
  assert.equal(gateLiquidityRecheck(R, [tick({ t: T0, liq: 100_000 }), tick({ t: T0 + 30_000, liq: 50 })], tick({ t: T0 + MIN, liq: 95_000 }), 2000).pass, true, 'compares against the read >= 60 s back');
});

test('1748 gate pool-structure: WSOL as the BASE mint = hand-made pool ($NOTHING / $AMERICA shape) refuses; other venues are unverifiable', () => {
  const nothing = gatePoolStructure(R, HAND, 'unknown', pairOf({ baseMint: WSOL_MINT, quoteMint: HAND }));
  assert.equal(nothing.pass, false); assert.equal(nothing.rule, 'rugproof:pool-structure-wsol-base'); assert.equal(nothing.retryAfterMs, undefined, 'structural: refused for good');
  assert.equal(gatePoolStructure(R, PUMP, 'pump.fun', pairOf()).pass, true);
  assert.equal(gatePoolStructure(R, PUMP, 'pump.fun', pairOf({ dex: 'raydium' })).rule, 'rugproof:pool-structure-unverifiable');
  const handTokenBase = gatePoolStructure(R, HAND, 'unknown', pairOf({ baseMint: HAND }));
  assert.equal(handTokenBase.pass, true); assert.equal(handTokenBase.partial, true, 'token = base on PumpSwap but not a pump mint: the LP read must decide');
  assert.equal(gatePoolStructure(R, PUMP, null, null).rule, 'rugproof:pool-structure-unknown');
  assert.equal(gatePoolStructure(R, PUMP, null, pairOf({ quoteMint: 'USDC111111111111111111111111111111111111111' })).rule, 'rugproof:pool-structure-quote');
});

test('1748 gate lp-locked: LP supply 0 passes; LP held by the pool creator refuses; burn address ok; a read error refuses', () => {
  assert.equal(gateLpLocked(R, pairOf(), lpOf(), PUMP).pass, true);
  const creator = gateLpLocked(R, pairOf(), lpOf({ lpSupply: 1000n, holders: [{ owner: CREATOR, amount: 999n }] }), PUMP);
  assert.equal(creator.rule, 'rugproof:lp-locked-creator'); assert.match(creator.detail, /99\.90%/);
  assert.equal(gateLpLocked(R, pairOf(), lpOf({ lpSupply: 1000n, holders: [{ owner: 'Whale11111111111111111111111111111111111111', amount: 400n }] }), PUMP).rule, 'rugproof:lp-locked-holder');
  const burned = gateLpLocked(R, pairOf(), lpOf({ lpSupply: 1000n, holders: [{ owner: '1nc1nerator11111111111111111111111111111111', amount: 1000n }] }), PUMP);
  assert.equal(burned.pass, true); assert.equal(burned.partial, true);
  assert.equal(gateLpLocked(R, pairOf(), 'error', PUMP).rule, 'rugproof:lp-locked-unknown');
  assert.equal(gateLpLocked(R, pairOf(), lpOf({ baseMint: WSOL_MINT }), PUMP).rule, 'rugproof:lp-locked-wsol-base');
});

test('1748 gate withdraw-history: a creator Withdraw refuses; LP burned skips the scan; an unreadable history refuses', () => {
  assert.equal(gateWithdrawHistory(R, { scanned: 25, withdraws: 1, byCreator: 1 }, lpOf({ lpSupply: 5n })).rule, 'rugproof:withdraw-history-creator');
  assert.equal(gateWithdrawHistory(R, { scanned: 25, withdraws: 2, byCreator: 0 }, lpOf({ lpSupply: 5n })).rule, 'rugproof:withdraw-history');
  assert.equal(gateWithdrawHistory(R, null, lpOf()).pass, true);
  assert.equal(gateWithdrawHistory(R, 'error', lpOf({ lpSupply: 5n })).rule, 'rugproof:withdraw-history-unknown');
  assert.equal(gateWithdrawHistory(R, { scanned: 25, withdraws: 0, byCreator: 0 }, lpOf({ lpSupply: 5n })).pass, true);
});

test('1748 gate sell-route: NO_ROUTES refuses (none), a rate limit refuses as unknown (fail closed), a route passes', () => {
  assert.equal(gateSellRoute(R, { ok: false, kind: 'no-route', error: 'NO_ROUTES_FOUND' }, 25).rule, 'rugproof:sell-route-none');
  assert.equal(gateSellRoute(R, { ok: false, kind: 'rate-limited', error: 'HTTP 429' }, 25).rule, 'rugproof:sell-route-unknown');
  assert.equal(gateSellRoute(R, { ok: true, outLamports: 1n, impactPct: 0.4 }, 25).pass, true);
  assert.equal(gateSellRoute({ ...R, routeX: null }, null, 25).pass, true);
});

test('1748 verdict: young or partly verified pools get the size cap; a clean old pool does not', () => {
  const ok = [gatePoolAge(R, tick(), T0 - 60 * MIN)];
  assert.equal(verdictOf(R, ok, 60 * MIN).sizeCapPct, null);
  assert.equal(verdictOf(R, ok, 20 * MIN).sizeCapPct, 50, 'pool younger than 30 min');
  assert.equal(verdictOf(R, [...ok, gatePoolStructure(R, HAND, 'unknown', pairOf({ baseMint: HAND }))], 60 * MIN).sizeCapPct, 50, 'partly verified');
});

test('1748 drain verdict: reserve near 0, reserve or liquidity down > 25%, any quote error exits; a rate limit does not', () => {
  const g = R.drainGuard!;
  const base = { reserveSol: 900, liqUsd: 118_700 };
  assert.equal((drainVerdict(g, base, { t: 0, reserveSol: 0.000001, liqUsd: null, route: null }) as { reason: string }).reason, 'drain-reserve');
  const d = drainVerdict(g, base, { t: 0, reserveSol: 600, liqUsd: null, route: null });
  assert.equal(d.exit, true); assert.equal((d as { reason: string }).reason, 'drain-liquidity'); assert.equal(Math.round((d as { liqUsd: number }).liqUsd), 79_133);
  assert.equal(drainVerdict(g, base, { t: 0, reserveSol: 800, liqUsd: null, route: null }).exit, false);
  assert.equal((drainVerdict(g, base, { t: 0, reserveSol: null, liqUsd: 80_000, route: null }) as { reason: string }).reason, 'drain-liquidity');
  assert.equal((drainVerdict(g, base, { t: 0, reserveSol: null, liqUsd: null, route: { ok: false, kind: 'no-route', error: 'CANNOT_COMPUTE_OTHER_AMOUNT_THRESHOLD' } }) as { reason: string }).reason, 'drain-no-route');
  assert.equal(drainVerdict(g, base, { t: 0, reserveSol: null, liqUsd: null, route: { ok: false, kind: 'rate-limited', error: 'HTTP 429' } }).exit, false);
});

test('1748 decodePumpSwapPool reads creator / base / quote / lp mint / vaults at the PumpSwap Pool offsets', () => {
  const keys = Array.from({ length: 6 }, (_, i) => Buffer.alloc(32, i + 1));
  const d = Buffer.concat([Buffer.alloc(8), Buffer.from([255]), Buffer.from([0, 0]), ...keys, Buffer.alloc(8), Buffer.alloc(32)]);
  const p = decodePumpSwapPool(d);
  assert.deepEqual([p.creator, p.baseMint, p.quoteMint, p.lpMint, p.baseVault, p.quoteVault], keys.map((k) => base58(k)));
  assert.throws(() => decodePumpSwapPool(Buffer.alloc(100)), /too short/);
});

// ───────────────────────────── the probes + the vet (fake fetch) ─────────────────────────────

/** A fake network: DexScreener pairs, the RPC (pool account / LP supply / holders / signatures), Jupiter. */
function fakeNet(o: { pair: object | null; poolBase64?: string; owner?: string; lpSupply?: string; holders?: { address: string; amount: string; owner: string }[]; sigs?: { signature: string; logs: string[]; signer: string }[]; jup?: { status: number; json: unknown } }) {
  const calls: string[] = [];
  const f: FetchJson = async (url, init) => {
    if (url.includes('dexscreener')) { calls.push('dexscreener'); return { status: 200, json: o.pair ? [o.pair] : [] }; }
    if (url.includes('jup.ag')) { calls.push('jupiter'); return o.jup ?? { status: 200, json: { outAmount: '123456789', priceImpactPct: '0.004' } }; }
    const b = JSON.parse(init!.body!) as { method: string; params: unknown[] };
    calls.push(`rpc:${b.method}`);
    const result = (() => {
      switch (b.method) {
        case 'getAccountInfo': return { value: { owner: o.owner ?? PUMPSWAP_PROGRAM, data: [o.poolBase64 ?? '', 'base64'] } };
        case 'getTokenSupply': return b.params[0] === PUMP ? { value: { amount: '1000000000000000', decimals: 6 } } : { value: { amount: o.lpSupply ?? '0', decimals: 9 } };
        case 'getTokenLargestAccounts': return { value: (o.holders ?? []).map((h) => ({ address: h.address, amount: h.amount })) };
        case 'getMultipleAccounts': return { value: (o.holders ?? []).map((h) => ({ data: { parsed: { info: { owner: h.owner } } } })) };
        case 'getSignaturesForAddress': return (o.sigs ?? []).map((s) => ({ signature: s.signature, err: null }));
        case 'getTransaction': { const s = (o.sigs ?? []).find((x) => x.signature === b.params[0]); return s ? { meta: { logMessages: s.logs }, transaction: { message: { accountKeys: [{ pubkey: s.signer }] } } } : null; }
        case 'getTokenAccountBalance': return { value: { uiAmount: 900 } };
      }
      return null;
    })();
    return { status: 200, json: { jsonrpc: '2.0', id: 1, result } };
  };
  return { f, calls };
}
const poolData = (creator: Buffer, baseMint: Buffer, quoteMint: Buffer) => Buffer.concat([Buffer.alloc(11), creator, baseMint, quoteMint, keyBuf('lp'), keyBuf('bv'), keyBuf('qv'), Buffer.alloc(8), Buffer.alloc(32)]).toString('base64');
const dsPair = (base: string, quote: string, over: object = {}) => ({ pairAddress: POOL, dexId: 'pumpswap', baseToken: { address: base }, quoteToken: { address: quote }, pairCreatedAt: T0 - 60 * MIN, liquidity: { usd: 100_000 }, ...over });
const ctx = (k: MarketTick) => ({ history: [tick({ t: k.t - 70_000, liq: 100_000, mint: k.mint })], sizeUsd: 25, exitFloorUsd: 2000, maxTop10Pct: 30, maxDevPct: 5 });

test('1748 vet: the $NOTHING shape (WSOL base, hand-made) is refused after ONE DexScreener read, no RPC call', async () => {
  const net = fakeNet({ pair: dsPair(WSOL_MINT, HAND) });
  const vet = rugproofVet(R, { probe: new RugProbe({ fetchJson: net.f, rpcUrl: 'https://rpc.test/?api-key=SECRET' }) });
  const k = tick({ mint: HAND, launchpad: 'unknown' });
  const r = await vet(k, ctx(k));
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.rule, 'rugproof:pool-structure-wsol-base');
  assert.deepEqual(net.calls, ['dexscreener']);
});

test('1748 vet: a free gate refuses before any network read (cheapest first)', async () => {
  const net = fakeNet({ pair: dsPair(PUMP, WSOL_MINT) });
  const vet = rugproofVet(R, { probe: new RugProbe({ fetchJson: net.f, rpcUrl: null }) });
  const k = tick({ createdAt: T0 - 2 * MIN });
  const r = await vet(k, ctx(k));
  assert.equal(!r.ok && r.rule, 'rugproof:pool-age');
  assert.ok(!r.ok && (r.retryAfterMs ?? 0) > 0);
  assert.deepEqual(net.calls, []);
});

test('1748 vet: a pump.fun migration with LP supply 0 and a Jupiter route passes (recheck, no size cap on an old pool)', async () => {
  const pumpKey = keyBuf('pump-mint');
  const net = fakeNet({ pair: dsPair(PUMP, WSOL_MINT), poolBase64: poolData(keyBuf('creator'), pumpKey, Buffer.from(bs58decode(WSOL_MINT))) });
  const vet = rugproofVet(R, { probe: new RugProbe({ fetchJson: net.f, rpcUrl: 'https://rpc.test' }) });
  const r = await vet(tick(), ctx(tick()));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.ok && r.recheck);
  assert.equal(r.ok && r.sizeCapPct, undefined);
  assert.ok(!net.calls.includes('rpc:getSignaturesForAddress'), 'LP burned: no withdraw scan');
  assert.ok(net.calls.includes('jupiter'));
});

test('1748 vet: LP held by the pool creator refuses (lp-locked-creator); a creator Withdraw in history refuses; NO_ROUTES refuses', async () => {
  const creator = keyBuf('creator');
  const pool = poolData(creator, keyBuf('pump-mint'), Buffer.from(bs58decode(WSOL_MINT)));
  const held = fakeNet({ pair: dsPair(PUMP, WSOL_MINT), poolBase64: pool, lpSupply: '1000', holders: [{ address: 'acct', amount: '990', owner: base58(creator) }] });
  let r = await rugproofVet(R, { probe: new RugProbe({ fetchJson: held.f, rpcUrl: 'https://rpc.test' }) })(tick(), ctx(tick()));
  assert.equal(!r.ok && r.rule, 'rugproof:lp-locked-creator');
  const pulled = fakeNet({ pair: dsPair(PUMP, WSOL_MINT), poolBase64: pool, lpSupply: '1000', holders: [{ address: 'acct', amount: '50', owner: 'Someone1111111111111111111111111111111111' }], sigs: [{ signature: 's1', logs: ['Program log: Instruction: Withdraw'], signer: base58(creator) }] });
  r = await rugproofVet(R, { probe: new RugProbe({ fetchJson: pulled.f, rpcUrl: 'https://rpc.test' }) })(tick(), ctx(tick()));
  assert.equal(!r.ok && r.rule, 'rugproof:withdraw-history-creator');
  const noRoute = fakeNet({ pair: dsPair(PUMP, WSOL_MINT), poolBase64: pool, jup: { status: 400, json: { errorCode: 'NO_ROUTES_FOUND' } } });
  r = await rugproofVet(R, { probe: new RugProbe({ fetchJson: noRoute.f, rpcUrl: 'https://rpc.test' }) })(tick(), ctx(tick()));
  assert.equal(!r.ok && r.rule, 'rugproof:sell-route-none');
});

test('1748 vet: no RPC endpoint = the chain gate cannot run = refused (fail closed)', async () => {
  const net = fakeNet({ pair: dsPair(PUMP, WSOL_MINT) });
  const r = await rugproofVet(R, { probe: new RugProbe({ fetchJson: net.f, rpcUrl: null }) })(tick(), ctx(tick()));
  assert.equal(!r.ok && r.rule, 'rugproof:lp-locked-unknown');
  assert.equal(!r.ok && r.retryAfterMs, 5 * MIN, 'a read that failed looks again in 5 min (refused meanwhile)');
  const wsol = await rugproofVet(R, { probe: new RugProbe({ fetchJson: fakeNet({ pair: dsPair(WSOL_MINT, HAND) }).f, rpcUrl: null }) })(tick({ mint: HAND }), ctx(tick({ mint: HAND })));
  assert.equal(!wsol.ok && wsol.retryAfterMs, undefined, 'a structural refusal is for good');
});

test('1748 probe: an RPC error never prints the api key', async () => {
  const p = new RugProbe({ fetchJson: async () => { throw new Error('fetch failed https://rpc.test/?api-key=SECRET123'); }, rpcUrl: 'https://rpc.test/?api-key=SECRET123' });
  await assert.rejects(p.rpc('getAccountInfo', []), (e: Error) => !e.message.includes('SECRET123'));
});

test('1748 chainVets: the first refusal wins, the lowest size cap is kept', async () => {
  const a: VetFn = async () => ({ ok: true, recheck: true, sizeCapPct: 50, note: 'a' });
  const b: VetFn = async () => ({ ok: true, note: 'b', sizeCapPct: 80 });
  const no: VetFn = async () => ({ ok: false, rule: 'larp-score', detail: 'x' });
  const r = await chainVets(a, b)!(tick());
  assert.deepEqual(r, { ok: true, recheck: true, sizeCapPct: 50, note: 'a; b' });
  assert.equal((await chainVets(a, no)!(tick())).ok, false);
  assert.equal(chainVets(undefined, b), b);
});

test('1748 DrainPoller: a reserve pulled to ~0 between two polls yields drain-reserve for the position', async () => {
  let sol = 900;
  const f: FetchJson = async (url, init) => {
    if (url.includes('jup.ag')) return { status: 200, json: { outAmount: '1', priceImpactPct: '0' } };
    const b = JSON.parse(init!.body!) as { method: string };
    if (b.method === 'getTokenAccountBalance') return { status: 200, json: { result: { value: { uiAmount: sol } } } };
    if (b.method === 'getTokenSupply') return { status: 200, json: { result: { value: { amount: '1', decimals: 6 } } } };
    return { status: 200, json: { result: null } };
  };
  const poller = new DrainPoller(R.drainGuard!, new RugProbe({ fetchJson: f, rpcUrl: 'https://rpc.test' }));
  const pos: DrainWatchPosition = { positionId: 'p1', mint: PUMP, entryLiqUsd: 118_700, poolAddress: null, quoteVault: 'QV', tokens: () => 1000 };
  poller.watch(pos);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(poller.verdict('p1'), null);
  sol = 0.000001;
  const w = (poller as unknown as { w: Map<string, Parameters<DrainPoller['poll']>[0]> }).w.get('p1')!;
  await poller.poll(w, false);
  assert.equal(poller.verdict('p1')?.reason, 'drain-reserve');
  poller.stop();
});

// ───────────────────────────── the runner ─────────────────────────────

/** A pump coin seen from 4 min old every 30 s for 20 min: refused (pool-age, retry) until 10 min, then entered. */
function youngCoinTape(mint = PUMP, launchpad: MarketTick['launchpad'] = 'pump.fun'): MarketTick[] {
  const out: MarketTick[] = [];
  for (let i = 0; i <= 40; i++) out.push(tick({ mint, launchpad, t: T0 + i * 30_000, createdAt: T0 - 4 * MIN }));
  return out;
}

test('1748 runner: a time gate retries instead of skipping the coin for good; the coin enters once the pool is 10 min old', async () => {
  const s = rugStrategy();
  const r = await runAutotrade({ strategy: s, tape: tape(youngCoinTape()), sessions: null, vet: rugproofTapeVet(s.entry.safety.rugproof!) });
  const refused = r.ledger.events.filter((e) => e.kind === 'refused' && e.rule === 'rugproof:pool-age');
  assert.equal(refused.length, 1, 'refused once, with a retry time');
  assert.ok((refused[0] as { retryAfterMs?: number }).retryAfterMs! > 0);
  const fill = r.ledger.events.find((e) => e.kind === 'fill');
  assert.ok(fill, 'entered after the retry');
  assert.ok(fill!.t >= T0 + 6 * MIN, 'not before the pool was 10 min old');
  // A young pool (< 30 min) is sized at 50% of the strategy's pick.
  const clamp = r.ledger.events.find((e) => e.kind === 'clamp') as { result: { clamps: { rule: string }[] } } | undefined;
  assert.ok(clamp?.result.clamps.some((c) => c.rule === 'rugproof-young-pool'));
});

test('1748 runner (tape): a non-pump.fun mint is refused for good by the offline pool-structure proxy', async () => {
  const s = rugStrategy();
  const ticks = youngCoinTape(HAND, 'unknown').map((k) => ({ ...k, createdAt: T0 - 60 * MIN }));
  const r = await runAutotrade({ strategy: s, tape: tape(ticks), sessions: null, vet: rugproofTapeVet(s.entry.safety.rugproof!) });
  const refused = r.ledger.events.filter((e) => e.kind === 'refused' && String(e.rule).startsWith('rugproof:'));
  assert.equal(refused.length, 1);
  assert.equal(refused[0].rule, 'rugproof:pool-structure-offline');
  assert.equal(r.trades.length + r.openAtEnd.length, 0);
});

/** Coin A enters at liq 100K, its pool is pulled to $300 at +5 min; coin B shows up later. */
function pulledTape(): MarketTick[] {
  const A = PUMP; const B = base58(keyBuf('other-mint'));
  const out: MarketTick[] = [];
  for (let i = 0; i <= 120; i++) {
    const t = T0 + i * 30_000;
    out.push(tick({ mint: A, t, liq: i < 10 ? 100_000 : 300 }));
    if (i >= 100) out.push(tick({ mint: B, t: t + 1, symbol: 'B' }));
  }
  return out;
}

test('1748 runner: execution.stuckWriteOffMin closes a drained bag as written off and frees the slot for the next coin', async () => {
  const s = rugStrategy(null, 30);
  const r = await runAutotrade({ strategy: s, tape: tape(pulledTape()), sessions: null });
  const kinds = r.ledger.events.map((e) => e.kind);
  assert.ok(kinds.includes('stuck'));
  const w = r.ledger.events.find((e) => e.kind === 'written_off') as { t: number; stuckMin: number } | undefined;
  assert.ok(w, 'written off');
  assert.ok(w!.stuckMin >= 30);
  const a = r.trades.find((t) => t.mint === PUMP)!;
  assert.equal(a.exitReason, 'written-off'); assert.equal(a.stuck, true); assert.equal(a.pnlPct, -100);
  assert.ok(r.ledger.events.some((e) => e.kind === 'trade_closed' && (e as { writtenOff?: boolean }).writtenOff));
  assert.ok(r.ledger.events.some((e) => e.kind === 'fill' && e.mint !== PUMP), 'the freed slot took coin B');
  // Without the option the bag stays open forever and blocks coin B (the old behaviour, FINDINGS §3).
  const old = await runAutotrade({ strategy: rugStrategy(null, null), tape: tape(pulledTape()), sessions: null });
  assert.equal(old.ledger.events.filter((e) => e.kind === 'fill').length, 1);
  assert.ok(old.openAtEnd.some((p) => p.stuck));
});

test('1748 runner: the feed drain guard sells the whole position when liquidity is > 25% under the entry read (above the floor)', async () => {
  const s = rugStrategy({ minPoolAgeMin: 0, liquidityRecheck: null, youngPool: null });
  const ticks: MarketTick[] = [];
  for (let i = 0; i <= 20; i++) ticks.push(tick({ t: T0 + i * 30_000, liq: i < 5 ? 100_000 : 70_000 }));
  const r = await runAutotrade({ strategy: s, tape: tape(ticks), sessions: null, vet: rugproofTapeVet(s.entry.safety.rugproof!) });
  const g = r.ledger.events.find((e) => e.kind === 'drain_guard') as { reason: string; source: string } | undefined;
  assert.equal(g?.reason, 'drain-liquidity'); assert.equal(g?.source, 'feed');
  assert.equal(r.trades[0]?.exitReason, 'drain-liquidity');
});

test('1748 runner: a pool-probe exit verdict sells at the probed liquidity (0 = stuck, then written off), not at the lagging feed', async () => {
  const s = rugStrategy({ minPoolAgeMin: 0, liquidityRecheck: null, youngPool: null }, 1);
  const watched: string[] = []; let pulled = false;
  const drain: DrainWatch = { watch: (p) => watched.push(p.positionId), unwatch: () => {}, verdict: () => (pulled ? { exit: true, reason: 'drain-no-route', detail: 'Jupiter has no sell route: NO_ROUTES_FOUND', liqUsd: 0 } : null) };
  const ticks: MarketTick[] = [];
  for (let i = 0; i <= 20; i++) ticks.push(tick({ t: T0 + i * 30_000 }));
  const vet = rugproofTapeVet(s.entry.safety.rugproof!);
  const r = await runAutotrade({ strategy: s, tape: tape(ticks), sessions: null, vet, drain, onState: (st) => { if (st.t >= T0 + 3 * MIN) pulled = true; } });
  assert.deepEqual(watched, ['p1']);
  assert.ok(r.ledger.events.some((e) => e.kind === 'drain_guard' && (e as { source?: string }).source === 'pool-probe'));
  assert.ok(r.ledger.events.some((e) => e.kind === 'stuck'), 'feed still shows 100K, but the probe says the route is gone: nothing sells');
  assert.equal(r.trades[0]?.exitReason, 'written-off');
});

test('1748 strategy: rugproof + stuckWriteOffMin validate (with the live-data warning); a drain poll slower than 10 s is refused', () => {
  const b = JSON.parse(JSON.stringify(loadPreset('moonbag'))) as Record<string, any>;
  delete b.hash; b.exits.profiles = Object.values(b.exits.profiles);
  b.entry.safety.rugproof = R; b.execution.stuckWriteOffMin = 30;
  const ok = validateStrategy(b);
  assert.equal(ok.ok, true, JSON.stringify(!ok.ok && ok.errors));
  assert.ok(ok.warnings.some((w) => w.path === '/entry/safety/rugproof'));
  b.entry.safety.rugproof = { ...R, drainGuard: { ...R.drainGuard, pollSec: 30 } };
  assert.equal(validateStrategy(b).ok, false);
});

test('1748 fix r1 strategy: stuckWriteOffMin is refused outside mode paper (null still validates)', () => {
  const b = JSON.parse(JSON.stringify(loadPreset('moonbag'))) as Record<string, any>;
  delete b.hash; b.exits.profiles = Object.values(b.exits.profiles);
  b.mode = 'real'; b.execution.stuckWriteOffMin = 30;
  const bad = validateStrategy(b);
  assert.equal(bad.ok, false);
  assert.ok(!bad.ok && bad.errors.some((e) => e.path === '/execution/stuckWriteOffMin'));
  b.execution.stuckWriteOffMin = null;
  const ok = validateStrategy(b);
  assert.equal(ok.ok, true, JSON.stringify(!ok.ok && ok.errors));
});

test('1748 fix r1 runner: a real-signal run never writes off a stuck bag; it keeps its exit signals and carries to the next run', async () => {
  const s: ResolvedStrategy = { ...rugStrategy(null, 30), mode: 'real' };
  const sim = simExecutor(s.execution);
  const sells: string[] = [];
  let carried: Position[] = [];
  const real: RealRunHook & Executor = {
    name: 'real-signal', accountId: 'acct',
    buy: (k, usd) => sim.buy(k, usd),
    sell: (k, tokens, why) => { sells.push(why); return sim.sell(k, tokens, why); },
    step: () => ({ receipts: [], halt: null }), sendHalted: () => {}, confirmOf: () => null,
    status: () => ({}) as RealStatus, inherited: () => [], carry: (open) => { carried = open; },
  };
  const r = await runAutotrade({ strategy: s, tape: tape(pulledTape()), sessions: null, real, executor: real });
  const kinds = r.ledger.events.map((e) => e.kind);
  assert.ok(kinds.includes('stuck'), 'the drained bag went stuck');
  assert.ok(!kinds.includes('written_off'), 'no write-off in a real-signal run');
  assert.ok(!r.trades.some((t) => t.exitReason === 'written-off'));
  assert.deepEqual(carried.map((p) => p.mint), [PUMP], 'the real bag carries to the next real run');
  // A pool that refills after 40 min stuck (past the 30 min write-off): the real bag still gets its exit signal.
  const refill = Array.from({ length: 121 }, (_, i) => tick({ t: T0 + i * 30_000, liq: i < 10 || i >= 90 ? 100_000 : 300 }));
  sells.length = 0; carried = [];
  const r2 = await runAutotrade({ strategy: s, tape: tape(refill), sessions: null, real, executor: real });
  assert.ok(!r2.ledger.events.some((e) => e.kind === 'written_off'));
  assert.ok(sells.length >= 2, `a stuck attempt, then the sale on refill (${sells.length})`);
  assert.equal(r2.trades.length, 1); assert.notEqual(r2.trades[0]!.exitReason, 'written-off');
  assert.deepEqual(carried, [], 'sold, nothing to carry');
  // The same tape on paper writes it off at 30 min, before the refill (the paper-only behaviour, unchanged).
  const paper = await runAutotrade({ strategy: rugStrategy(null, 30), tape: tape(refill), sessions: null });
  assert.equal(paper.trades[0]?.exitReason, 'written-off');
});

test('1748 fix r1 probe: one unreadable transaction makes the Withdraw scan fail closed (refuse, retry), not a partial pass', async () => {
  const sigs = Array.from({ length: 25 }, (_, i) => ({ signature: `sig${i}`, err: null }));
  const clean = { meta: { logMessages: ['Program log: Instruction: Buy'] }, transaction: { message: { accountKeys: ['x'] } } };
  const net = (bad: (i: number) => 'error' | 'null' | null): FetchJson => async (_u, init) => {
    const b = JSON.parse(String(init?.body));
    if (b.method === 'getSignaturesForAddress') return { status: 200, json: { result: sigs } };
    if (b.method === 'getTransaction') {
      const kind = bad(Number(String(b.params[0]).slice(3)));
      if (kind === 'error') return { status: 200, json: { error: { code: -32000, message: 'boom' } } };
      return { status: 200, json: { result: kind === 'null' ? null : clean } };
    }
    return { status: 500, json: null };
  };
  const lp = lpOf({ lpSupply: 5n });
  // The verifier's case (task-1754): 20 of 25 reads fail and the 5 that read are clean.
  const most = await new RugProbe({ fetchJson: net((i) => (i < 20 ? 'error' : null)), rpcUrl: 'http://rpc', backoffMs: 0 }).withdraws(POOL, CREATOR, 25);
  assert.equal(most, 'error');
  assert.equal(gateWithdrawHistory(R, most, lp).rule, 'rugproof:withdraw-history-unknown');
  // A single unread one (an error or a null result) is enough: it could be the creator's Withdraw.
  for (const kind of ['error', 'null'] as const) {
    const one = await new RugProbe({ fetchJson: net((i) => (i === 7 ? kind : null)), rpcUrl: 'http://rpc', backoffMs: 0 }).withdraws(POOL, CREATOR, 25);
    assert.equal(one, 'error', kind);
  }
  // Every read clean: a full scan that passes.
  const all = await new RugProbe({ fetchJson: net(() => null), rpcUrl: 'http://rpc', backoffMs: 0 }).withdraws(POOL, CREATOR, 25);
  assert.deepEqual(all, { scanned: 25, withdraws: 0, byCreator: 0 });
  assert.equal(gateWithdrawHistory(R, all, lp).pass, true);
});

test('1748 backtest: a rug-proof strategy replays its tape gates by default (opts.vet null turns them off)', async () => {
  const s = rugStrategy();
  const t = tape(youngCoinTape(HAND, 'unknown'));
  const on = await backtest(s, t);
  assert.equal(on.run.trades.length + on.run.openAtEnd.length, 0);
  const off = await backtest(s, t, null, { vet: null });
  assert.equal(off.run.trades.length + off.run.openAtEnd.length, 1);
});

// base58 decode for the fixtures (the app only ships the encoder).
function bs58decode(s: string): Uint8Array {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n; for (const c of s) n = n * 58n + BigInt(A.indexOf(c));
  const bytes: number[] = []; while (n > 0n) { bytes.unshift(Number(n % 256n)); n /= 256n; }
  for (const c of s) { if (c === '1') bytes.unshift(0); else break; }
  const out = new Uint8Array(32); out.set(bytes.slice(-32), 32 - Math.min(32, bytes.length));
  return out;
}
