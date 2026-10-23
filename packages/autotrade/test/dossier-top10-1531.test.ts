// task-1531: the candidate dossier's holder concentration agrees with the tick and names its source. A live dossier
// carries two top-10 figures: the tick's `top10` (Jupiter's top-holders %, what the strategy's top-10 gate reads) and
// get_dossier's concentration (`top10PctExLp`, the RPC's 20 largest accounts). Before task-1518 the second counted a
// graduated pump.fun coin's PumpSwap pool (the vault owner is the pool account) as one 80 %+ holder, so a paper run's
// agent read 98 %+ next to the tick's 13.7 % and skipped every candidate on it. The fixture below is that coin's
// decision-time shape (a PumpSwap pool on 81.7 %, then wallets); every address is synthetic.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDataLayer, FakeClock, base58, TOKEN_PROGRAM, type HttpRequest, type Transport } from '@dexterm/data';
import { McpTools } from '@dexterm/mcp';
import { SYSTEM_PROGRAM } from '../../data/src/trade/tx-decode.ts';
import { drive, json } from '../../data/test/helpers.ts';
import { concentrationLine, renderDossierRecord, tapeDossierRecord } from '../src/sessions.ts';
import type { MarketTick } from '../src/replay.ts';

const PUMPSWAP = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const SUPPLY = 1_000_000_000_000_000n; // pump.fun: 1e9 tokens, 6 decimals
const WALLETS = [3.1, 2.4, 2.0, 1.9, 1.7, 1.6, 1.5, 1.3, 1.0, 0.9, 0.6]; // the top 10 of these = 17.4 %

const addr = (i: number, salt: number): string => { const b = new Uint8Array(32); for (let j = 0; j < 32; j++) b[j] = (i * 37 + j * 11 + salt * 17 + 3) & 0xff; return base58(b); };
const b58 = (s: string): Uint8Array => { const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'; let n = 0n; for (const c of s) n = n * 58n + BigInt(A.indexOf(c)); const out = new Uint8Array(32); for (let i = 31; i >= 0; i--) { out[i] = Number(n & 0xffn); n >>= 8n; } return out; };

function mintAccount(): string {
  const b = Buffer.alloc(82);
  b.writeUInt32LE(0, 0); // no mint authority
  b.writeBigUInt64LE(SUPPLY, 36);
  b.writeUInt8(6, 44);
  b.writeUInt8(1, 45);
  b.writeUInt32LE(0, 46); // no freeze authority
  return b.toString('base64');
}
function tokenAccount(mint: string, owner: string, amount: bigint): string {
  const b = Buffer.alloc(165);
  b.set(b58(mint), 0); b.set(b58(owner), 32); b.writeBigUInt64LE(amount, 64);
  return b.toString('base64');
}

/** A fake RPC (mint, 20 largest accounts, their owners, each owner's program); every other source answers 404. */
function world(mint: string, poolProgram: string) {
  const ranks = [{ pct: 81.7, owner: addr(1, 4), program: poolProgram }, ...WALLETS.map((pct, i) => ({ pct, owner: addr(i + 2, 5), program: SYSTEM_PROGRAM }))];
  const accounts = ranks.map((r, i) => ({ address: addr(i, 9), amount: (SUPPLY * BigInt(Math.round(r.pct * 1e4))) / 1_000_000n, ...r }));
  const t: Transport = async (req: HttpRequest) => {
    let body: { method?: string; params?: [unknown, { dataSlice?: unknown }?] } = {};
    try { body = JSON.parse(req.body ?? '{}'); } catch { /* not an RPC call */ }
    const ok = (result: unknown) => json(200, { jsonrpc: '2.0', id: 1, result });
    if (body.method === 'getAccountInfo') return ok({ context: { slot: 1 }, value: { data: [mintAccount(), 'base64'], owner: TOKEN_PROGRAM, lamports: 1_461_600, executable: false } });
    if (body.method === 'getTokenLargestAccounts') return ok({ context: { slot: 1 }, value: accounts.map((a) => ({ address: a.address, amount: a.amount.toString(), decimals: 6, uiAmount: Number(a.amount) / 1e6, uiAmountString: '' })) });
    if (body.method === 'getMultipleAccounts') {
      const asked = body.params![0] as string[];
      if (body.params![1]?.dataSlice) return ok({ context: { slot: 1 }, value: asked.map((o) => { const r = accounts.find((a) => a.owner === o); return r ? { data: ['', 'base64'], owner: r.program, lamports: 2_039_280, executable: false } : null; }) });
      return ok({ context: { slot: 1 }, value: asked.map((ta) => { const a = accounts.find((x) => x.address === ta); return a ? { data: [tokenAccount(mint, a.owner, a.amount), 'base64'], owner: TOKEN_PROGRAM, lamports: 2_039_280, executable: false } : null; }) });
    }
    return json(404, {});
  };
  const clock = new FakeClock(Date.parse('2026-10-21T12:00:00Z'));
  const dl = createDataLayer({ clock, transport: t });
  return { dl, clock, mcp: new McpTools(dl, () => ({ screen: 'autotrade-runner', actions: { mints: [], feeds: [], sortKeys: [] } })) };
}

const T0 = Date.parse('2026-10-21T12:00:00Z');
const tick = (mint: string, o: Partial<MarketTick> = {}): MarketTick => ({
  mint, t: T0, kind: 'live', symbol: 'NI', launchpad: 'pump.fun', createdAt: T0 - 40 * 60_000, price: 0.0001, mcap: 100_000, mcapResolved: 100_000, mcapFlagged: false, liq: 60_000,
  vol5m: 5_000, vol1h: 20_000, vol24: 50_000, buys5m: 50, sells5m: 30, buys24: 500, sells24: 300, chg5m: 3, chg1h: 10, chg6h: null, chg24h: null,
  holders: 812, top10: 13.73, dev: 0.4, mintAuth: false, freezeAuth: false, org: null, ...o,
});
const BOUNDS = { profiles: ['moonbag'], defaultProfile: 'moonbag', maxSizePct: 10, sizeMode: 'pct' as const, bankrollUsd: 1000, cashUsd: 1000, openPositions: 0, maxConcurrent: 3 };
const concentrationOf = (text: string) => text.split('\n').find((l) => l.startsWith('concentration: ')) ?? '';

test('a graduated pump.fun coin (PumpSwap pool on 81.7 %): the live dossier reads the tick top-10 and an ex-pool top-10 near it, each with its source', async () => {
  const mint = addr(500, 1);
  const w = world(mint, PUMPSWAP);
  const h = await drive(w.clock, w.mcp.call('get_holders', { mint, top: 20 }));
  const rows = h.holders as { pct: number; poolSide: string | null }[];
  assert.equal(rows[0].poolSide, 'POOL', 'the PumpSwap pool account is marked pool-side in get_holders');
  assert.ok(rows.slice(1).every((x) => x.poolSide === null), 'no wallet is marked');
  assert.ok(Math.abs((h.top10PctExLp as number) - 17.4) < 0.01, `ex-pool top-10 ${h.top10PctExLp} (98.2 before task-1518)`);
  assert.ok((h.top10PctRaw as number) > 98, `raw top-10 ${h.top10PctRaw} keeps what an explorer shows`);
  assert.match(String(h.top10Note), /pool, bonding-curve, launch-vault, lock and burn/);

  // The paper runner's live dossier path (autotrade run: get_dossier, then renderDossierRecord).
  const rec = await drive(w.clock, w.mcp.call('get_dossier', { mint, interval: '5m' }));
  const k = tick(mint);
  const line = concentrationOf(renderDossierRecord(rec, { mint, symbol: 'NI', matched: ['trigger:screen'] }, k, [], BOUNDS));
  assert.equal(line, 'concentration: top10 13.7% (tick, Jupiter: the figure the top-10 gate reads) · top10 ex-pool 17.4% (RPC, 12 largest accounts; 1 pool-side left out: POOL 81.7%; raw 98.2%) · holders 812 (Jupiter total) · dev 0.4%');
  assert.doesNotMatch(line, /disagree/);
  assert.doesNotMatch(line, /top10PctExLp|9[0-9]\.\d% \(RPC/, 'no unlabelled or pool-inflated figure');
  w.dl.close();
});

test('a pool program the classifier does not know: the dossier says the two top-10 figures disagree instead of leaving the model to pick', async () => {
  const mint = addr(600, 2);
  const w = world(mint, addr(601, 2)); // an AMM program id no holder class knows: its pool account stays counted
  const rec = await drive(w.clock, w.mcp.call('get_dossier', { mint, interval: '5m' }));
  const line = concentrationOf(renderDossierRecord(rec, { mint, symbol: 'NI', matched: [] }, tick(mint), [], BOUNDS));
  assert.match(line, /top10 13\.7% \(tick, Jupiter/);
  assert.match(line, /top10 ex-pool 98\.2% \(RPC, 12 largest accounts; none pool-side\)/);
  assert.match(line, /the two top-10 figures disagree: one source may count a pool or exchange account as a holder/);
  w.dl.close();
});

test('a replay dossier has only the tape row: one top-10, the tick\'s, with its source; no RPC figure is invented', () => {
  const k = tick(addr(700, 3));
  const line = concentrationOf(renderDossierRecord(tapeDossierRecord(k), { mint: k.mint, symbol: k.symbol, matched: [] }, k, [], BOUNDS));
  assert.equal(line, 'concentration: top10 13.7% (tick, Jupiter: the figure the top-10 gate reads) · holders 812 (Jupiter total) · dev 0.4%');
  assert.equal(concentrationLine({ error: 'no holder data on this row' }, tick(k.mint, { top10: null, holders: null, dev: null })), 'top10 — on the tick');
});

test('the keyless holder fallback (Jupiter aggregate, no ranked list) is named as Jupiter, not as an RPC ex-pool figure', () => {
  const k = tick(addr(800, 4));
  const line = concentrationLine({ mint: k.mint, holders: [], top10PctExLp: 13.73, top10PctRaw: 13.73, holderCount: 812, listedHolders: 0, source: 'jupiter-tokens' }, k);
  assert.equal(line, 'top10 13.7% (tick, Jupiter: the figure the top-10 gate reads) · top10 13.7% (Jupiter aggregate: no RPC holder list) · holders 812 (Jupiter total) · dev 0.4%');
});
