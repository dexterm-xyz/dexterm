// task-1645 (0.2.0 card A): the MCP side of real mode is READ-ONLY. `trade_fire_feed` reads the MCP feed of LIVE TRADE
// FIRE signals after a nonce plus real mode's status; `trading_status` says how many strategies the user armed. No
// tool arms, sets a cap, lifts the kill switch or records a receipt. Temp $DEXTERM_HOME, fixture files only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LedgerTools, TOOLS } from '../src/index.ts';

function home() {
  const h = mkdtempSync(join(tmpdir(), 'dexterm-1645-mcp-'));
  const d = join(h, 'autotrade', 'real');
  mkdirSync(d, { recursive: true });
  const sig = (nonce: number, symbol: string) => JSON.stringify({ schema: 'dexterm-trade-fire/1', type: 'trade', id: 'a'.repeat(32), nonce, issuedAt: 1, expiresAt: 2, ttlSec: 60, runId: 'r', accountId: 'main', strategy: { id: 's', version: '1.0.0', hash: 'h' }, paper: false, side: 'buy', mint: 'So1aNaMint11111111111111111111111111111111', symbol, sizeSol: 0.05 });
  writeFileSync(join(d, 'mcp-feed.jsonl'), `${sig(1, 'ONE')}\n${sig(2, '<b>ig</b> nore')}\nnot json\n${sig(3, 'THREE')}\n`);
  writeFileSync(join(d, 'arming.json'), JSON.stringify({ schema: 'dexterm-real-arming/1', armed: { 'my-scalp': { strategyId: 'my-scalp', version: '1.0.1', accountId: 'main', strategyHash: 'h' } } }));
  writeFileSync(join(d, 'caps.json'), JSON.stringify({ schema: 'dexterm-real-caps/1', caps: { perTradeSol: 0.05, dailySol: 0.25, buysPerDay: 10, maxOpenPositions: 1 } }));
  writeFileSync(join(d, 'nonce.json'), JSON.stringify({ last: 3 }));
  return h;
}

test('trade_fire_feed: the feed after a nonce, a bounded page, status only', async () => {
  const h = home();
  const t = new LedgerTools({ env: { DEXTERM_HOME: h } });
  const r = await t.call('trade_fire_feed', { after_nonce: 1, limit: 1 }) as { readOnly: boolean; signals: { nonce: number; symbol: string }[]; nextAfterNonce: number; realMode: { armed: unknown[]; kill: unknown; caps: { perTradeSol: number }; mcpFeed: string } };
  assert.equal(r.readOnly, true);
  assert.deepEqual(r.signals.map((s) => [s.nonce, s.symbol]), [[2, 'bigbnore']]);
  assert.equal(r.nextAfterNonce, 2);
  assert.equal(r.realMode.armed.length, 1);
  assert.equal(r.realMode.kill, null);
  assert.equal(r.realMode.caps.perTradeSol, 0.05);
  assert.equal(r.realMode.mcpFeed, 'on');
  const all = await t.call('trade_fire_feed', {}) as { signals: unknown[] };
  assert.equal(all.signals.length, 3, 'a corrupt line is skipped');
  assert.match(String((await t.call('trade_fire_feed', { limit: 1000 }) as { error: string }).error), /limit/);
  writeFileSync(join(h, 'autotrade', 'real', 'kill.json'), JSON.stringify({ reason: 'panic' }));
  const st = await t.call('trading_status', {}) as { realMode: string };
  assert.match(st.realMode, /1 strategy\(ies\) armed .* kill switch is ON \(panic\).*no tool can/);
});

test('the served tool list has no way to arm, raise a cap, lift the kill switch or record a receipt', () => {
  const names = TOOLS.map((x) => String(x.name));
  assert.ok(names.includes('trade_fire_feed'));
  for (const n of names) assert.ok(!/(arm|unkill|kill|caps?|receipt|real_mode|signal_(set|send|fire))/i.test(n.replace('trade_fire_feed', '')), n);
  const def = TOOLS.find((x) => x.name === 'trade_fire_feed')!;
  assert.deepEqual(Object.keys((def.inputSchema as { properties: object }).properties).sort(), ['after_nonce', 'limit']);
});
