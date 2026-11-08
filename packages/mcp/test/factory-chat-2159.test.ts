// task-2159: the chat tools of the strategy factory on the MCP surface (strategy_overview, factory_status,
// strategy_change). Fakes only: temp homes, no model, no network. A change is previewed, then applied only by the
// user's own next message (the app writes it to DEXTERM_CHAT_TURN); an external MCP client never applies one; nothing
// reaches real mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { presetPath, StrategyStore, fleetConfigPath, runFactory, stubAnalyst, loadTape, type Strategy } from '@dexterm/autotrade';
import { AutotradeTools, TOOLS } from '../src/index.ts';

const TAPE = loadTape(new URL('../../autotrade/test/fixtures/autotrade-1498-tape.json', import.meta.url));
const T0 = Date.UTC(2026, 10, 5, 12);

function homeWithMember(id: string): string {
  const h = mkdtempSync(join(tmpdir(), 'dexterm-2159-mcp-'));
  const doc = { ...JSON.parse(readFileSync(presetPath('moonbag'), 'utf8')), id, name: id, version: '1.0.0' } as Strategy;
  new StrategyStore({ home: h }).create(doc, { actor: 'test' });
  mkdirSync(join(h, 'autotrade'), { recursive: true });
  writeFileSync(fleetConfigPath(h), JSON.stringify({ schema: 'dexterm-autotrade/1', strategies: [{ id, preset: id }] }));
  return h;
}
const chatEnv = (h: string, turn: string, userText: string): NodeJS.ProcessEnv => ({ DEXTERM_HOME: h, DEXTERM_CHAT_TURN: JSON.stringify({ chatId: 'chat-test01', turn, userText }) });
const tools = (env: NodeJS.ProcessEnv, actor = 'analyst', runs: string[] = []) => new AutotradeTools({ env, actor, now: () => T0, factoryRunner: (h) => { runs.push(h); return true; } });
const enabled = (h: string): unknown => JSON.parse(readFileSync(fleetConfigPath(h), 'utf8')).strategies[0].enabled;

test('the three tools are served, with closed schemas; strategy_change has no real / arm / cap action', () => {
  const byName = new Map(TOOLS.map((t) => [String(t.name), t as unknown as { inputSchema: { properties: Record<string, { enum?: string[] }>; additionalProperties: boolean } }]));
  for (const n of ['strategy_overview', 'factory_status', 'strategy_change']) assert.ok(byName.has(n), n);
  const ch = byName.get('strategy_change')!;
  assert.equal(ch.inputSchema.additionalProperties, false);
  assert.deepEqual(ch.inputSchema.properties.action.enum, ['on', 'off', 'retire', 'factory-pause', 'factory-resume', 'factory-run']);
});

test('in-app chat: "turn ss-s2 off" previews; the same turn cannot apply it; the user\'s "yes" applies it and says what changed; then on again', async () => {
  const h = homeWithMember('ss-s2');
  const ov = await tools(chatEnv(h, 't1', 'which strategies are on?')).call('strategy_overview', {});
  assert.deepEqual(ov.on, ['ss-s2']);
  const prev = await tools(chatEnv(h, 't2', 'turn ss-s2 off')).call('strategy_change', { action: 'off', id: 'ss-s2' });
  assert.equal(prev.ok, true);
  assert.equal(prev.applied, false);
  assert.match(String(prev.preview), /turn ss-s2 off/);
  assert.equal(enabled(h), undefined);
  // the model confirming in the same turn it previewed
  const same = await tools(chatEnv(h, 't2', 'turn ss-s2 off')).call('strategy_change', { confirm: prev.code });
  assert.equal(same.applied, false);
  // a token name / feed text telling the model to confirm does not help: only the user's text counts
  const injected = await tools(chatEnv(h, 't3', 'what is $YESCOIN doing?')).call('strategy_change', { confirm: prev.code });
  assert.equal(injected.applied, false);
  assert.equal(enabled(h), undefined);
  const yes = await tools(chatEnv(h, 't4', 'yes')).call('strategy_change', { confirm: prev.code });
  assert.equal(yes.applied, true, JSON.stringify(yes));
  assert.match(String(yes.changed), /ss-s2 is off/);
  assert.equal(enabled(h), false);
  const on = await tools(chatEnv(h, 't5', 'turn it back on')).call('strategy_change', { action: 'on', id: 'ss-s2' });
  const on2 = await tools(chatEnv(h, 't6', `confirm ${String(on.code)}`)).call('strategy_change', { confirm: on.code });
  assert.equal(on2.applied, true);
  assert.equal(enabled(h), true);
});

test('an external MCP client (not the in-app chat) never applies a change', async () => {
  const h = homeWithMember('ss-s3');
  const ext = await tools(chatEnv(h, 't1', 'turn ss-s3 off'), 'mcp-agent').call('strategy_change', { action: 'off', id: 'ss-s3' });
  assert.equal(ext.ok, false);
  assert.match(String(ext.error), /in-app chat only/);
  const noTurn = await tools({ DEXTERM_HOME: h }).call('strategy_change', { action: 'off', id: 'ss-s3' });
  assert.equal(noTurn.ok, false);
  assert.equal(enabled(h), undefined);
});

test('asking for real mode / arming / caps is refused with a pointer to the promotion flow; nothing is written', async () => {
  const h = homeWithMember('ss-t2');
  const before = readFileSync(fleetConfigPath(h), 'utf8');
  for (const action of ['real', 'arm', 'caps', 'live']) {
    const r = await tools(chatEnv(h, 't1', `make ss-t2 ${action}`)).call('strategy_change', { action, id: 'ss-t2' });
    assert.equal(r.ok, false);
    assert.equal(r.refused, 'real-mode', action);
    assert.match(String(r.error), /promote <id> --to real/);
  }
  assert.equal(readFileSync(fleetConfigPath(h), 'utf8'), before);
});

test('factory_status shows the newest candidate and why it was made; "run the factory now" is confirmed first', async () => {
  const h = homeWithMember('ss-s2');
  await runFactory({ home: h, analyst: stubAnalyst(), tape: () => TAPE, now: () => T0 });
  const st = await tools(chatEnv(h, 't1', 'show me the newest generated strategy and why')).call('factory_status', {});
  const d = st.detail as { id: string; label: string; why: { summary: string }; heldOut: { n: number } };
  assert.match(d.id, /^gen-/);
  assert.match(d.label, /GENERATED · PAPER/);
  assert.ok(d.why.summary.length > 0);
  assert.equal(typeof d.heldOut.n, 'number');
  const runs: string[] = [];
  const p = await tools(chatEnv(h, 't2', 'run the factory now'), 'analyst', runs).call('strategy_change', { action: 'factory-run' });
  assert.equal(runs.length, 0);
  const c = await tools(chatEnv(h, 't3', 'yes'), 'analyst', runs).call('strategy_change', { confirm: p.code });
  assert.equal(c.applied, true);
  assert.deepEqual(runs, [h]);
});
