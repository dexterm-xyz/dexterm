// task-1518: `TokenDetail.holders` (MCP get_holders / get_dossier concentration, the autotrade dossier) applies the
// HOLDERS panel's ex-pool rule (task-1367 classifyHolder). Before this, `top10PctExLp` only left out the two Raydium
// authorities, so on a young PumpSwap pool (vault owner = the pool account) or a Meteora DAMM v2 pool (vault owner =
// the global pool authority) one pool-side account read as an 80-95 % "holder", and the dossier contradicted
// Jupiter's top-10 (~5 %) on every fresh candidate of a paper autotrade run. Shapes below are the decision-time
// holder lists of two such candidates (the share of each rank as recorded); every wallet address is synthetic.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDataLayer, FakeClock, base58, AUTHORITY_CLASS, TOKEN_PROGRAM, type HttpRequest, type Transport } from '../src/index.ts';
import { SYSTEM_PROGRAM } from '../src/trade/tx-decode.ts';
import { pumpBondingCurve } from '../src/sources/pda.ts';
import { drive, json } from './helpers.ts';

const PUMPSWAP = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const DAMM_V2_AUTHORITY = 'HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC';
const SUPPLY = 1_000_000_000_000_000n; // 1e9 tokens, 6 decimals

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

/** A fake RPC: the mint, the 20 largest accounts (shares in % of supply), their owners, and each owner's program. */
function world(mint: string, ranks: { pct: number; owner: string; program: string | null; lamports?: number }[]) {
  const accounts = ranks.map((r, i) => ({ address: addr(i, 9), amount: (SUPPLY * BigInt(Math.round(r.pct * 1e4))) / 1_000_000n, ...r }));
  const calls: string[] = [];
  const t: Transport = async (req: HttpRequest) => {
    const body = JSON.parse(req.body ?? '{}') as { method: string; params: [unknown, { dataSlice?: unknown }?] };
    calls.push(body.method + (body.params?.[1]?.dataSlice ? ':meta' : ''));
    const ok = (result: unknown) => json(200, { jsonrpc: '2.0', id: 1, result });
    if (body.method === 'getAccountInfo') return ok({ context: { slot: 1 }, value: { data: [mintAccount(), 'base64'], owner: TOKEN_PROGRAM, lamports: 1_461_600, executable: false } });
    if (body.method === 'getTokenLargestAccounts') return ok({ context: { slot: 1 }, value: accounts.map((a) => ({ address: a.address, amount: a.amount.toString(), decimals: 6, uiAmount: Number(a.amount) / 1e6, uiAmountString: '' })) });
    if (body.method === 'getMultipleAccounts') {
      const asked = body.params[0] as string[];
      if (body.params[1]?.dataSlice) {
        return ok({ context: { slot: 1 }, value: asked.map((o) => { const r = accounts.find((a) => a.owner === o); return r && r.program ? { data: ['', 'base64'], owner: r.program, lamports: r.lamports ?? 2_039_280, executable: false } : null; }) });
      }
      return ok({ context: { slot: 1 }, value: asked.map((ta) => { const a = accounts.find((x) => x.address === ta); return a ? { data: [tokenAccount(mint, a.owner, a.amount), 'base64'], owner: TOKEN_PROGRAM, lamports: 2_039_280, executable: false } : null; }) });
    }
    return json(404, {});
  };
  const clock = new FakeClock(Date.parse('2026-10-21T12:00:00Z'));
  return { dl: createDataLayer({ clock, transport: t }), clock, calls };
}

const wallets = (pcts: number[], salt: number) => pcts.map((pct, i) => ({ pct, owner: addr(i + 1, salt), program: SYSTEM_PROGRAM }));

test('a Meteora DAMM v2 pool: the global pool authority (a System-owned PDA) is pool-side, not a 78.8 % holder', async () => {
  assert.ok(AUTHORITY_CLASS[DAMM_V2_AUTHORITY], 'the authority is the task-1367 derived constant');
  const mint = addr(100, 1);
  const w = world(mint, [{ pct: 78.81252, owner: DAMM_V2_AUTHORITY, program: SYSTEM_PROGRAM, lamports: 178_128_000_000 }, ...wallets([2.20563, 2.02781, 1.8944, 1.71804, 1.45271, 1.33007, 1.2987, 1.1, 0.8, 0.6, 0.5], 2)]);
  const h = (await drive(w.clock, w.dl.detail.holders(mint))).value;
  const expected = [2.20563, 2.02781, 1.8944, 1.71804, 1.45271, 1.33007, 1.2987, 1.1, 0.8, 0.6].reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(h.top10Pct! - expected) < 0.01, `ex-pool top-10 ${h.top10Pct} (was 92.5 before the fix), expected ${expected}`);
  assert.equal(h.holders[0].label, 'LP');
  assert.equal(h.holders[0].poolSide?.tag, 'POOL');
  assert.match(h.holders[0].poolSide!.reason, /Meteora DAMM v2 pool authority/);
  assert.ok(h.top10PctRaw! > 92, `raw top-10 ${h.top10PctRaw} keeps what an explorer shows`);
  w.dl.close();
});

test('a young PumpSwap pool: the vault owner is the pool account (owned by the PumpSwap program) and is left out', async () => {
  const mint = addr(200, 3);
  const pool = addr(201, 3);
  const w = world(mint, [{ pct: 95.1, owner: pool, program: PUMPSWAP }, ...wallets([0.8, 0.7, 0.6, 0.55, 0.5, 0.45, 0.4, 0.35, 0.3, 0.2], 4)]);
  const h = (await drive(w.clock, w.dl.detail.holders(mint))).value;
  assert.ok(h.top10Pct! < 5, `ex-pool top-10 ${h.top10Pct} (was 99.6 before the fix)`);
  assert.equal(h.holders[0].poolSide?.tag, 'POOL');
  assert.equal(h.holders[0].poolSide?.program, 'PumpSwap');
  assert.deepEqual(w.calls, ['getAccountInfo', 'getTokenLargestAccounts', 'getMultipleAccounts', 'getMultipleAccounts:meta']);
  w.dl.close();
});

test('the pump.fun bonding curve of the mint is pool-side even when the owner lookup fails; an unknown big wallet stays counted', async () => {
  const mint = addr(300, 5);
  const curve = pumpBondingCurve(mint);
  const whale = addr(301, 5);
  const w = world(mint, [{ pct: 70, owner: curve, program: null }, { pct: 12, owner: whale, program: SYSTEM_PROGRAM }, ...wallets([1, 1, 1, 1, 1, 1, 1, 1, 1], 6)]);
  const h = (await drive(w.clock, w.dl.detail.holders(mint))).value;
  assert.ok(Math.abs(h.top10Pct! - 21) < 0.01, `ex-pool top-10 ${h.top10Pct} (a curve holding 70% read as a holder before the fix)`);
  assert.equal(h.holders[0].poolSide?.tag, 'CURVE');
  assert.equal(h.holders[1].poolSide, undefined, 'a plain wallet is never hidden');
  w.dl.close();
});

test('the get_holders shape is unchanged for coins with no pool-side holder (top10 = raw top10)', async () => {
  const mint = addr(400, 7);
  const w = world(mint, wallets([20, 10, 5, 5, 5, 5, 5, 5, 5, 5, 3], 8));
  const h = (await drive(w.clock, w.dl.detail.holders(mint))).value;
  assert.ok(h.holders.every((x) => x.poolSide === undefined && x.label === undefined));
  assert.equal(h.top10Pct, h.top10PctRaw);
  assert.ok(Math.abs(h.top10Pct! - 70) < 0.01);
  w.dl.close();
});
