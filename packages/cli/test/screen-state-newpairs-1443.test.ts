// task-1443 capture round 2: an agent watching the PumpPortal NEW PAIRS screen over MCP must read what that
// screen shows. `screen_state` used to report the screener pool there, so `visible`/`selected` named coins
// that were not on screen and the launch fields (age, bonding, 5m change, buys/sells) were missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildScreenState } from '../src/main.ts';
import { makeFeedState, type AppState } from '../src/state.ts';
import { createReplayFeed } from '../src/feed.ts';
import { LiveContext, type NewPairRow } from '../src/live/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLE = resolve(here, '..', '..', 'data', 'fixtures', 'live-sample.json');

async function liveState(): Promise<AppState> {
  const feed = createReplayFeed(SAMPLE);
  await feed.refresh();
  const state = makeFeedState(feed, 'replay', { screen: 'newpairs' });
  state.live = new LiveContext(feed.dl, { mode: 'replay' });
  return state;
}

function pair(mint: string, symbol: string, createdAt: number, extra: Partial<NewPairRow> = {}): NewPairRow {
  return {
    mint, symbol, name: symbol, launchpad: 'pump' as NewPairRow['launchpad'], creator: null, createdAt, rowAt: createdAt, receivedAt: createdAt,
    latencyMs: 0, drawnAt: null, bonding: 42, migrated: false, marketCapSol: 300, mcap: 61_000, price: 0.000061, liq: 18_000, vol: 90_000,
    chg: { m5: 12.5, h1: 80 }, holders: null, buys: 140, sells: 60, dev: null, org: null, mintAuth: false, freezeAuth: false,
    initialBuySol: null, spark: undefined, flags: [], ...extra,
  } as NewPairRow;
}

test('screen_state on the new-pairs screen lists the PumpPortal rows with their launch fields', async () => {
  const s = await liveState();
  const now = Date.now();
  const older = pair('NewPairOlder11111111111111111111111111111111', 'OLDR', now - 300_000);
  const newer = pair('NewPairNewer11111111111111111111111111111111', 'NEWR', now - 60_000, { chg: { m5: 33, h1: null }, bonding: 71 });
  s.live!.newpairs.rows.set(older.mint, older);
  s.live!.newpairs.rows.set(newer.mint, newer);
  try {
    const ss = buildScreenState(s) as { visible: Array<Record<string, unknown>>; selected: { mint: string; symbol: string }; actions: { mints: string[] } };
    assert.deepEqual(ss.visible.map((r) => r.symbol), ['NEWR', 'OLDR'], 'the new-pairs list, newest first, not the screener pool');
    const v = ss.visible[0];
    assert.equal(v.chg5m, 33);
    assert.equal(v.bonding, 71);
    assert.equal(v.buys, 140);
    assert.equal(v.mcap, 61_000);
    assert.ok(typeof v.ageSec === 'number' && v.ageSec >= 59 && v.ageSec <= 70, `ageSec ${v.ageSec}`);
    assert.equal(ss.selected.mint, newer.mint, 'the cursor row of the new-pairs screen');
    s.selectedMint = older.mint;
    assert.equal((buildScreenState(s) as { selected: { mint: string } }).selected.mint, older.mint, 'selectedMint wins, like the screen highlight');
    assert.ok(ss.actions.mints.includes(newer.mint) && ss.actions.mints.includes(older.mint), 'both are open_token targets');
    s.screen = 'screener';
    const sc = buildScreenState(s) as { visible: Array<Record<string, unknown>> };
    assert.ok(!sc.visible.some((r) => r.symbol === 'NEWR'), 'the screener still reports its own view');
    assert.ok(!('chg5m' in sc.visible[0]), 'screener rows keep their old shape');
  } finally {
    try { s.live?.close(); } catch { /* */ }
    try { s.feed?.close(); } catch { /* */ }
  }
});
