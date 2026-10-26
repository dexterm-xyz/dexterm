// task-1647 (0.2.0 card C): the Q screen's JOURNEY view. J on a strategy shows its ladder; b backtests it (the held-out
// split becomes evidence); F starts a paper forward test (here the real forward host in-process on a live-shaped feed
// of the fixture tape), X stops one; A opens a pending always-on promotion and y applies it. Real is never applied
// from a key. Fixtures only: a temp home, the committed tape, no network. Golden: snapshots/autotrade-journey-*.txt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { THEMES, parseKeys } from '@dexterm/tui';
import { StrategyStore, fleetConfigPath, hostForward, loadForwardTest, loadJourney, loadTape, proposePromotion, recordForwardResult, type MarketTick, type Tape } from '@dexterm/autotrade';

/** task-1679: the completed forward test on record, re-recorded with 12 closed trades (above the evidence floor of 10). */
function seedFloor(home: string, id: string): void {
  const f = loadJourney(home, id).forwards.find((x) => x.state === 'done');
  assert.ok(f && f.metrics, 'a completed forward test to seed');
  recordForwardResult(home, { ...f, metrics: { ...f.metrics, trades: 12 } });
}
import { makeFixtureState, renderFrame, FIXTURE_NOW } from '../src/state.ts';
import { applyAction, applyKey } from '../src/main.ts';
import { STUB_CONTROL, newAutotradeUi, type AutotradeDeps } from '../src/screens/autotrade-ui.ts';
import { inlineJobs } from '../src/screens/autotrade-worker.ts';

const here = dirname(fileURLToPath(import.meta.url));
const UPDATE = process.env.UPDATE_SNAPSHOTS === '1';
const tape = loadTape(new URL('../../autotrade/test/fixtures/autotrade-1498-tape.json', import.meta.url));
const NOW = FIXTURE_NOW.getTime();

function feed(t: Tape): { name: string; ticks: AsyncIterable<MarketTick>; stop: () => void } {
  let stopped = false;
  return { name: 'live (test feed)', stop: () => { stopped = true; }, ticks: (async function* () { for (const k of t.ticks) { if (stopped) return; yield k; } })() };
}

function harness() {
  const home = mkdtempSync(join(tmpdir(), 'autotrade-journey-1647-'));
  const store = new StrategyStore({ home, now: () => NOW });
  assert.ok(store.createFrom('moonbag', 'my-moon', { actor: 'user' }).ok);
  const hosts: Promise<unknown>[] = [];
  const deps: AutotradeDeps = {
    store, jobs: inlineJobs(() => tape), readRunner: () => ({ kind: 'none', path: '' }), control: STUB_CONTROL, proposals: () => [], exportDir: join(home, 'exports'), now: () => NOW,
    forwardSpawn: (h, t) => { hosts.push(hostForward({ home: h, forwardId: t.forwardId, source: feed(loadTape(new URL('../../autotrade/test/fixtures/autotrade-1498-tape.json', import.meta.url))), sessions: null, pacing: { mode: 'lockstep' } })); return process.pid; },
  };
  const state = makeFixtureState({ theme: THEMES.midnight, calm: true });
  state.autotradeUi = newAutotradeUi(deps);
  const stack: never[] = [];
  applyAction(state, 'screen.autotrade', stack);
  const i = state.autotradeUi.entries.findIndex((e) => e.id === 'my-moon');
  state.autotradeUi.selected = i;
  return { home, store, state, stack, hosts };
}
type H = ReturnType<typeof harness>;
const act = (h: H, a: Parameters<typeof applyAction>[1]) => applyAction(h.state, a, h.stack);
const ui = (h: H) => h.state.autotradeUi!;
const frame = (h: H) => renderFrame(h.state, 120, 40).toPlain();
async function until(pred: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 600 && !pred(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(pred(), `timed out: ${label}`);
}

test('Q journey view: J shows the ladder; b records held-out evidence; F starts a paper forward test; A + y applies always-on; real is terminal-only', async () => {
  const h = harness();
  act(h, 'autotrade.journey');
  assert.equal(ui(h).view, 'journey');
  let f = frame(h);
  assert.match(f, /JOURNEY · my-moon/);
  assert.match(f, /stage DRAFT/);
  assert.match(f, /\[ \] backtested/);
  // F before a backtest is allowed for the user (the ladder still counts only consecutive rungs); A has nothing pending
  act(h, 'autotrade.promote');
  assert.match(ui(h).notice ?? '', /nothing pending|no promotion pending/);
  // b: the backtest (inline jobs) records the held-out split
  act(h, 'autotrade.backtest');
  await until(() => loadJourney(h.home, 'my-moon').backtests.length === 1, 'evidence recorded');
  assert.ok(loadJourney(h.home, 'my-moon').backtests[0].heldOut);
  assert.equal(loadJourney(h.home, 'my-moon').backtests[0].by, 'user:tui');
  act(h, 'autotrade.journey'); // back to the journey from the backtest view
  assert.equal(ui(h).view, 'journey');
  act(h, 'autotrade.journey'); // refresh
  assert.match(frame(h), /stage BACKTESTED/);
  // F: a 24 h paper forward test, own bankroll; X asks it to stop; it flattens and reports (an early stop does not count)
  act(h, 'autotrade.forward');
  assert.match(ui(h).notice ?? '', /forward test fw_\S+ started · 24 h · paper, live data, own bankroll/);
  const fid = /fw_[a-z0-9]+_[a-f0-9]+/.exec(ui(h).notice ?? '')![0];
  act(h, 'autotrade.forwardstop');
  await Promise.all(h.hosts);
  assert.equal(loadForwardTest(h.home, fid)!.state, 'stopped');
  act(h, 'autotrade.journey');
  f = frame(h);
  assert.match(f, /forward test fw_\S+ · STOPPED/);
  assert.match(f, /stage BACKTESTED/, 'a stopped test is not the rung');
  // a finished forward test (trade window) makes it forward-tested; then a pending always-on promotion: A, y applies
  const s = h.store.get('my-moon');
  assert.ok(s && s.ok);
  const { createForwardTest } = await import('@dexterm/autotrade');
  const c = createForwardTest(h.home, s.strategy, h.store.raw('my-moon')!, { by: 'user', trades: 1 });
  assert.ok(c.ok);
  await hostForward({ home: h.home, forwardId: c.test.forwardId, source: feed(tape), sessions: null, pacing: { mode: 'lockstep' } });
  const p = proposePromotion(h.home, s.strategy, 'always-on', { actor: 'analyst', why: 'window done', now: NOW });
  assert.ok(p.ok);
  act(h, 'autotrade.journey');
  f = frame(h);
  assert.match(f, /stage FORWARD-TESTED/);
  assert.match(f, /pending promotion pp_\S+ → always-on \(proposed by analyst\) · A to review/);
  snapshot('journey', f);
  act(h, 'autotrade.promote');
  assert.equal(ui(h).confirm?.kind, 'promote');
  assert.match(frame(h), /APPLY PROMOTION\?/);
  for (const k of parseKeys('y')) applyKey(h.state, k, h.stack);
  assert.match(ui(h).notice ?? '', /applied: my-moon is an always-on paper member/);
  assert.ok(JSON.parse(readFileSync(fleetConfigPath(h.home), 'utf8')).strategies.some((m: { preset: string }) => m.preset === 'my-moon'));
  // real: below the evidence floor nothing is proposed (task-1679); above it, A only points at the terminal
  const below = proposePromotion(h.home, s.strategy, 'real', { actor: 'analyst', why: 'next' });
  assert.equal(!below.ok && below.reason, 'evidence-floor');
  seedFloor(h.home, 'my-moon');
  const pr = proposePromotion(h.home, s.strategy, 'real', { actor: 'analyst', why: 'next' });
  assert.ok(pr.ok);
  act(h, 'autotrade.promote');
  assert.match(ui(h).notice ?? '', /only on your own terminal with your caps and a typed phrase: dexterm autotrade promote apply pp_/);
  assert.equal(ui(h).confirm, null);
  assert.ok(!existsSync(join(h.home, 'autotrade', 'real')));
});

function snapshot(name: string, got: string, w = 120, ht = 40): void {
  const rows = got.split('\n');
  assert.equal(rows.length, ht);
  // the frame names temp paths, ids and times that change per run: mask them before comparing
  const masked = got.replace(/fw_[a-z0-9]+_[a-f0-9]{8}/g, 'fw_XXXXXXXX_XXXXXXXX').replace(/pp_[a-z0-9]+_[a-f0-9]{8}/g, 'pp_XXXXXXXX_XXXXXXXX').replace(/\b[0-9a-f]{8}\b/g, 'HHHHHHHH').replace(/\d{4}-\d\d-\d\d \d\d:\d\d/g, 'YYYY-MM-DD HH:MM').replace(/ran \d+ min/g, 'ran N min');
  const path = resolve(here, 'snapshots', `autotrade-${name}-${w}x${ht}.txt`);
  if (UPDATE || !existsSync(path)) { writeFileSync(path, masked + '\n'); if (!UPDATE) assert.fail(`wrote missing golden ${path}: re-run`); return; }
  assert.equal(masked, readFileSync(path, 'utf8').replace(/\n$/, ''), `${name} differs from its golden (UPDATE_SNAPSHOTS=1 to accept an intended change)`);
}
