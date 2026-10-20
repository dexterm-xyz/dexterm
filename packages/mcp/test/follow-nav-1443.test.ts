// task-1443 capture-lane bug: an EXTERNAL `dexterm mcp` server (the user's own agent) had no screen context, so every
// nav call failed and a terminal following it over MCP never moved. A following terminal now publishes a reduced
// snapshot; the server reads it (fresh only), accepts the four VIEW-ONLY nav calls against it (plus mints its own
// screener reads surfaced), and still refuses anything that changes user data or has no following terminal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpTools, readFollowScreen, writeFollowScreen, clearFollowScreen, followScreenPath, FOLLOW_NAV_ACTIONS, recordForToolCall } from '../src/index.ts';
import type { DataLayer } from '@dexterm/data';

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const OTHER = 'So11111111111111111111111111111111111111112';

const snap = (mints: string[] = [MINT]) => ({
  screen: 'screener', actions: { enabled: true, mints, feeds: ['trending', 'new'], sortKeys: ['vol'], screens: ['positions', 'token'], workspaces: [], themes: [], types: [...FOLLOW_NAV_ACTIONS] },
});

test('readFollowScreen: fresh snapshot is read; stale, absent or malformed reads as null', () => {
  const home = mkdtempSync(join(tmpdir(), 'follow-1443-'));
  const env = { DEXTERM_HOME: home } as NodeJS.ProcessEnv;
  try {
    assert.equal(readFollowScreen(env), null);
    writeFollowScreen(env, snap());
    assert.equal((readFollowScreen(env) as { screen: string }).screen, 'screener');
    const old = (Date.now() - 60_000) / 1000;
    utimesSync(followScreenPath(env), old, old);
    assert.equal(readFollowScreen(env), null, 'a frozen/quit terminal fails closed');
    clearFollowScreen(env);
    assert.equal(existsSync(followScreenPath(env)), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('follow mode: view-only nav calls validate against the snapshot and produce a nav record', async () => {
  const tools = new McpTools({} as DataLayer, () => ({ ...snap(), source: 'follow' }));
  const r = await tools.call('open_token', { mint: MINT });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(recordForToolCall({ seq: 1, agent: 'a', tool: 'open_token', args: { mint: MINT }, result: r, ms: 1 }).phase, 'nav');
  assert.equal((await tools.call('switch_screen', { screen: 'positions' })).ok, true);
  const rec = recordForToolCall({ seq: 2, agent: 'a', tool: 'switch_screen', args: { screen: 'positions' }, result: { ok: true }, ms: 1 });
  assert.deepEqual(rec.nav, { screen: 'positions' });
  assert.ok((await tools.call('open_token', { mint: OTHER })).error, 'a mint neither on screen nor surfaced is refused');
});

test('follow mode never allows data-changing UI actions, and without a follower nothing is allowed', async () => {
  const wide = { ...snap(), source: 'follow', actions: { ...snap().actions, types: ['open_token', 'add_to_watchlist', 'open_ticket'] } };
  const tools = new McpTools({} as DataLayer, () => wide);
  assert.ok((await tools.call('add_to_watchlist', { mint: MINT })).error);
  assert.ok((await tools.call('open_ticket', { mint: MINT, side: 'buy' })).error);
  const noFollower = new McpTools({} as DataLayer, () => ({ ...snap() }));
  assert.ok((await noFollower.call('open_token', { mint: MINT })).error);
});

// task-1443 capture round 4 (run25): the agent vetted a coin it had seen on the screener, bought it on PAPER, and
// open_token then refused it ("mint not among the tokens currently on screen") because the list had moved on, so the
// terminal never showed the held coin. Mints the agent read on the following terminal (screen_state), from the
// narrative board, or holds a paper position in are now follow-mode VIEW-ONLY targets too.
test('follow mode: a mint seen via screen_state stays a nav target after the screen moves on', async () => {
  let mints = [MINT];
  const tools = new McpTools({} as DataLayer, () => ({ ...snap(mints), source: 'follow' }));
  await tools.call('screen_state', {});
  mints = [OTHER];
  assert.equal((await tools.call('open_token', { mint: MINT })).ok, true, 'seen on screen earlier');
  const notFollow = new McpTools({} as DataLayer, () => ({ ...snap(mints) }));
  await notFollow.call('screen_state', {});
  assert.ok((await notFollow.call('open_token', { mint: MINT })).error, 'outside follow mode nothing is widened');
});

test('follow mode: the mint of a PAPER fill (and of listed paper positions) is a nav target', async () => {
  const HELD = '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R';
  const fill = { id: 1, t: 1, mint: HELD, symbol: 'H', side: 'buy', paper: true, solDelta: -1n, tokenDelta: 10n, decimals: 6, priceSol: 1, priceUsd: 1, priceImpactPct: 0, slippageBps: 0, feeLamports: 0n, realizedLamports: 0n, route: 'x' };
  const desk = { confirm: async () => ({ fill, position: null, quoteAttempts: 1 }), positions: () => [{ mint: OTHER, symbol: 'O', decimals: 9, tokens: 1, costSol: 1, realizedSol: 0, avgEntrySol: 1 }] };
  const tools = new McpTools({} as DataLayer, () => ({ ...snap([]), source: 'follow' }), null, null, { desk: async () => desk as never, watched: () => true });
  assert.ok((await tools.call('open_token', { mint: HELD })).error, 'not a target before the fill');
  assert.equal((await tools.call('paper_confirm', { ticketId: 't' })).paper, true);
  assert.equal((await tools.call('open_token', { mint: HELD })).ok, true, 'the held coin can be put on screen');
  await tools.call('paper_positions', {});
  assert.equal((await tools.call('open_token', { mint: OTHER })).ok, true, 'a listed paper position can be put on screen');
});
