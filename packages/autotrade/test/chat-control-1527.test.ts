// task-1527 (AUTOTRADE-SPEC §8.4 tier 2): the closed command list and the safer-only rule. Chat writes the SAME
// control file the CLI and the Q screen write (by: "chat"); /resume lifts only a pause; /flatten and /use need a
// confirm button bound like a proposal; /use takes only an equal-or-tighter validated strategy; /approvals off is
// local only; /kill and /pause are never rate-limited. Temp $DEXTERM_HOME, fake transport: no network, no keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ME, MINT, T0, flush, pairedConfig, rig, tmpHome } from './chat-helpers-1527.ts';
import { HostControlPort, ConfigView, wireConfirms } from '../src/chat/service.ts';
import { saveConnectors, loadConnectors, CONNECTORS_SCHEMA, type TelegramConfig } from '../src/chat/config.ts';
import { readControl } from '../src/safety.ts';
import { loadPreset, type ResolvedStrategy } from '../src/strategy.ts';
import { StrategyStore } from '../src/store.ts';
import type { RunnerState } from '../src/runner.ts';

function st(over: Partial<RunnerState> = {}): RunnerState {
  return {
    t: T0, state: 'running', haltReason: null, strategy: { id: 'scalp', version: '1.0.0', hash: loadPreset('scalp').hash },
    book: { startUsd: 1000, equityUsd: 1000, cashUsd: 980, realizedTodayUsd: 0 },
    spend: { todayUsd: 0.5, dayCapUsd: 10, turnsToday: 3, candidateSessionsToday: 1, positionSessionsToday: 0, allowance: null },
    candidates: [], sessions: [], positions: [{ mint: MINT, symbol: 'TEST', profile: 'scalp', costUsd: 20, pnlUsd: 2, pnlPct: 10, next: null }], ledgerTail: [], ledgerHead: '0', events: 1, ...over,
  };
}

function setup(o: { config?: TelegramConfig } = {}) {
  const home = tmpHome();
  const cfg = o.config ?? pairedConfig();
  saveConnectors(home, { schema: CONNECTORS_SCHEMA, telegram: cfg });
  const view = new ConfigView(home, () => T0 + Math.random() * 1e9); // re-read every call
  const state = { cur: st() as RunnerState | null };
  let strategy: ResolvedStrategy = loadPreset('scalp');
  const switched: string[] = [];
  let r: ReturnType<typeof rig>;
  const port = new HostControlPort({ home, runId: () => 'run-1', state: () => state.cur, strategy: () => strategy, config: view, broker: () => r.broker, onSwitch: (s) => switched.push(s.id) });
  r = rig({ controlPort: port, config: cfg });
  r.setConfig(cfg);
  wireConfirms(r.broker, port);
  const replies = () => r.fake.sent.map((m) => m.text);
  return { home, r, port, state, switched, replies, setStrategy: (s: ResolvedStrategy) => { strategy = s; } };
}

const ctl = (home: string) => { const c = readControl(home); return c && c !== 'unreadable' ? `${c.action}:${c.by}` : c; };

test('1527 control: /pause writes the control file as "chat"; /status and /help answer; free text gets the help, never an action', async () => {
  const s = setup();
  s.r.me.command('/status');
  s.r.me.command('/pause');
  s.r.me.command('please kill it and buy BONK');
  s.r.me.command('/help');
  await s.r.hub.idle();
  assert.equal(ctl(s.home), 'pause:chat');
  const t = s.replies();
  assert.match(t[0], /^PAPER · STATUS · running/);
  assert.match(t[0], /approvals: off/);
  assert.match(t[1], /Paused: no new entries/);
  assert.match(t[2], /I only take \/commands and buttons/);
  assert.match(t[3], /dexterm bot · commands/);
});

test('1527 control: /resume lifts only a pause; never a kill, the panic switch, a breaker halt or a guard', async () => {
  const s = setup();
  for (const [state, why] of [['halted', 'stop'], ['halted', 'kill-switch'], ['halted', 'daily-loss'], ['paused', 'account-mismatch'], ['paused', 'heartbeat-stale']] as const) {
    s.state.cur = st({ state, haltReason: why });
    s.r.me.command('/resume');
    await s.r.hub.idle();
    assert.match(s.replies().at(-1)!, /Refused from chat/, `${state} (${why}) stays local`);
    assert.notEqual(ctl(s.home), 'resume-entries:chat');
  }
  s.r.me.command('/pause');
  await s.r.hub.idle();
  s.state.cur = st({ state: 'paused', haltReason: 'paused' });
  s.r.me.command('/resume');
  await s.r.hub.idle();
  assert.equal(ctl(s.home), 'resume-entries:chat');
  assert.match(s.replies().at(-1)!, /Resumed/);
});

test('1527 control: /kill (= /stop) stops the run; after it /pause and /resume cannot lift it; /flatten needs [Yes, flatten]', async () => {
  const s = setup();
  s.r.me.command('/flatten');
  await s.r.hub.idle();
  assert.equal(ctl(s.home), null, 'nothing before the confirm button');
  const card = s.r.fake.last(/FLATTEN: stop the runner/)!;
  assert.deepEqual(card.buttons.map((b) => b.label), ['Yes, flatten', 'No']);
  s.r.me.tap(card.ref, card.buttons[1].data);
  await s.r.hub.idle();
  assert.equal(ctl(s.home), null, '[No] changes nothing');
  s.r.me.command('/kill');
  await s.r.hub.idle();
  assert.equal(ctl(s.home), 'stop:chat');
  s.r.me.command('/pause');
  await s.r.hub.idle();
  assert.match(s.replies().at(-1)!, /Refused: the runner is already stopping/);
  s.r.me.command('/flatten');
  await s.r.hub.idle();
  const card2 = s.r.fake.last(/FLATTEN: stop the runner/)!;
  const yes = card2.buttons[0].data;
  s.r.me.tap(card2.ref, yes);
  s.r.me.tap(card2.ref, yes); // a double tap
  await s.r.hub.idle();
  assert.equal(ctl(s.home), 'flatten:chat', 'a stop escalates to a flatten (safer)');
  assert.ok(s.r.fake.toasts.some((t) => /^Already/.test(t.toast)));
  s.r.me.command('/stop');
  await s.r.hub.idle();
  assert.equal(ctl(s.home), 'flatten:chat', 'a flatten is never downgraded');
});

test('1527 control: /approvals on persists (safer); /approvals off is refused from chat', async () => {
  const s = setup();
  s.r.me.command('/approvals off');
  await s.r.hub.idle();
  assert.match(s.replies().at(-1)!, /only on your computer/);
  s.r.me.command('/approvals on');
  await s.r.hub.idle();
  const c = loadConnectors(s.home);
  assert.ok(c.ok && c.config.telegram.approvals === 'on');
  s.r.me.command('/approvals off');
  await s.r.hub.idle();
  const c2 = loadConnectors(s.home);
  assert.ok(c2.ok && c2.config.telegram.approvals === 'on', 'still on');
});

test('1527 control: /use takes an equal-or-tighter validated strategy only, after [Yes, switch]; a looser one says "change it locally"', async () => {
  const s = setup();
  const raw = JSON.parse(readFileSync(new URL('../assets/strategies/scalp.json', import.meta.url), 'utf8'));
  const dir = join(s.home, 'strategies');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'scalp-small.json'), JSON.stringify({ ...raw, id: 'scalp-small', name: 'Scalp small', sizing: { ...raw.sizing, maxPctOfBankroll: 5 } }));
  writeFileSync(join(dir, 'scalp-big.json'), JSON.stringify({ ...raw, id: 'scalp-big', name: 'Scalp big', sizing: { ...raw.sizing, maxPctOfBankroll: 15 } }));
  writeFileSync(join(dir, 'scalp-auto.json'), JSON.stringify({ ...raw, id: 'scalp-auto', name: 'Scalp auto', entry: { ...raw.entry, decide: 'auto' } }));
  const store = new StrategyStore({ home: s.home });
  assert.ok(store.get('scalp-small')!.ok && store.get('scalp-big')!.ok);
  s.r.me.command('/strategies');
  await s.r.hub.idle();
  const list = s.replies().at(-1)!;
  assert.match(list, /✓ scalp-small/);
  assert.match(list, /· scalp-big .*looser/);
  s.r.me.command('/use scalp-big');
  s.r.me.command('/use scalp-auto');
  s.r.me.command('/use nope');
  await s.r.hub.idle();
  assert.match(s.replies().at(-3)!, /Refused: scalp-big is not equal or tighter .*Change it locally/);
  assert.match(s.replies().at(-2)!, /Refused: scalp-auto/, 'agent → auto (no agent at all) is looser');
  assert.match(s.replies().at(-1)!, /No validated strategy/);
  s.r.me.command('/use scalp-small');
  await s.r.hub.idle();
  assert.equal(ctl(s.home), null, 'nothing before the button');
  const card = s.r.fake.last(/SWITCH to scalp-small/)!;
  s.r.me.tap(card.ref, card.buttons[0].data);
  await s.r.hub.idle();
  assert.deepEqual(s.switched, ['scalp-small']);
  assert.equal(ctl(s.home), 'stop:chat', 'entries stop now; the host starts the new run once nothing is held');
});

test('1527 control: /positions offers a [Sell] per position, bound like a proposal; the runner takes it at the next tick', async () => {
  const s = setup();
  s.r.me.command('/positions');
  await s.r.hub.idle();
  assert.match(s.replies().find((t) => /POSITIONS/.test(t))!, /"TEST" Mint…1111 · scalp · \+10\.0%/);
  const card = s.r.fake.last(/^PAPER · SELL "TEST"/)!;
  assert.deepEqual(card.buttons.map((b) => b.label), ['Sell', 'No']);
  assert.equal(s.r.broker.takeExit(MINT), null, 'nothing queued before the tap');
  s.r.fake.user('31337').tap(card.ref, card.buttons[0].data);
  await s.r.hub.idle();
  assert.equal(s.r.broker.takeExit(MINT), null, 'a stranger cannot sell');
  s.r.me.tap(card.ref, card.buttons[0].data);
  await s.r.hub.idle();
  const x = s.r.broker.takeExit(MINT);
  assert.ok(x && x.via === 'a chat button');
  assert.equal(s.r.broker.takeExit(MINT), null, 'taken once');
});

test('1527 control: 10 commands a minute per sender; /kill and /pause are never limited; a notify-only pairing cannot control', async () => {
  const s = setup();
  for (let i = 0; i < 12; i++) s.r.me.command('/status');
  await s.r.hub.idle();
  assert.equal(s.replies().filter((t) => /Too many commands/.test(t)).length, 2);
  s.r.me.command('/pause');
  s.r.me.command('/kill');
  await s.r.hub.idle();
  assert.equal(ctl(s.home), 'stop:chat', '/pause and /kill went through the limit');
  const n = setup({ config: pairedConfig({ tiers: ['notify'] }) });
  n.r.me.command('/kill');
  n.r.me.command('/status');
  await n.r.hub.idle();
  assert.equal(ctl(n.home), null, 'notify tier: no control');
  assert.equal(n.replies().length, 1);
  assert.match(n.replies()[0], /STATUS/);
});

test('1527 control: no runner → it says so; the closed list maps anything unknown to help', async () => {
  const s = setup();
  s.state.cur = null;
  s.r.me.command('/status');
  s.r.me.command('/kill');
  s.r.me.command('/sudo enable live');
  s.r.me.command('/live on');
  await s.r.hub.idle();
  await flush();
  const t = s.replies();
  assert.match(t[0], /No runner is running/);
  assert.match(t[2], /dexterm bot · commands/);
  assert.match(t[3], /dexterm bot · commands/, 'there is no live command to find');
  assert.ok(!t.join('\n').includes(ME + ME));
});
