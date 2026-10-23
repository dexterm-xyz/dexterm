// task-1529: `dexterm autotrade run --all --paper` (every strategy of autotrade.json at once on one feed), `status
// --all`, `start <strategy>`, `pause | stop --strategy ID`, and the refusals (live, no config, a strategy that does not
// resolve, a live member). A paced replay of the fixture tape with stub sessions in a temp $DEXTERM_HOME: no network,
// no model, no keys, paper only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KillSwitch } from '@dexterm/data';
import { activeRunner, fleetStatusPath, runLockPath, verifyChain } from '@dexterm/autotrade';
import { autotradeCommand } from '../src/autotrade-cmd.ts';
import { fleetRunCmd } from '../src/autotrade-cmd/fleet.ts';
import { pauseCmd, startCmd } from '../src/autotrade-cmd/strategy-control.ts';

const TAPE = fileURLToPath(new URL('../../autotrade/test/fixtures/autotrade-1498-tape.json', import.meta.url));

function io(config?: unknown) {
  const home = mkdtempSync(join(tmpdir(), 'dexterm-at-fleet-'));
  mkdirSync(join(home, 'autotrade'), { recursive: true });
  if (config !== undefined) writeFileSync(join(home, 'autotrade', 'autotrade.json'), JSON.stringify(config));
  const out: string[] = [], err: string[] = [];
  return { home, out, err, io: { stdout: { write: (s: string) => out.push(s) }, stderr: { write: (s: string) => err.push(s) }, env: { DEXTERM_HOME: home, DEXTERM_DB_PATH: join(home, 'none.db'), PATH: process.env.PATH ?? '' } } };
}
type X = ReturnType<typeof io>;
const at = async (x: X, ...argv: string[]) => {
  x.out.length = 0; x.err.length = 0;
  const code = await autotradeCommand(['autotrade', ...argv], x.io);
  return { code, out: x.out.join(''), err: x.err.join('') };
};
const noPanic = (home: string) => new KillSwitch(join(home, 'trading.panic'));
const CONFIG = {
  schema: 'dexterm-autotrade/1', solUsd: 150,
  strategies: [
    { id: 'moon-a', preset: 'moonbag', bankroll: { usd: 500 } },
    { id: 'scalp-b', preset: 'scalp', bankroll: { sol: 1 } },
    { id: 'dip-c', preset: 'scalp', bankroll: { usd: 100 }, enabled: false },
  ],
  global: { maxConcurrentSessions: 2, modelUsdPerDay: 5 },
};
const runs = (home: string) => readdirSync(join(home, 'autotrade', 'runs')).filter((n) => n.endsWith('.jsonl') && !n.includes('stream'));
const events = (home: string, name: string) => readFileSync(join(home, 'autotrade', 'runs', name), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);

test('1529 cli: run --all refuses live, a missing --paper, a named strategy, a missing config, a live member and a strategy that does not resolve', async () => {
  const x = io(CONFIG);
  const ks = noPanic(x.home);
  for (const [argv, re] of [
    [['--all', '--live'], /paper only/],
    [['--all'], /pass --paper/],
    [['--all', '--paper', 'scalp'], /name no strategy/],
  ] as const) {
    x.err.length = 0;
    assert.equal(await fleetRunCmd([...argv], x.io, { killSwitch: ks }), 2, argv.join(' '));
    assert.match(x.err.join(''), re);
  }
  const none = io();
  assert.equal(await fleetRunCmd(['--all', '--paper', '--replay', TAPE, '--stub'], none.io, { killSwitch: noPanic(none.home) }), 1);
  assert.match(none.err.join(''), /no .*autotrade\.json[\s\S]*example/);
  const live = io({ ...CONFIG, strategies: [{ id: 'yolo', preset: 'scalp', mode: 'live', bankroll: { sol: 1 } }] });
  assert.equal(await fleetRunCmd(['--all', '--paper', '--replay', TAPE, '--stub'], live.io, { killSwitch: noPanic(live.home) }), 1);
  assert.match(live.err.join(''), /live execution is not available/);
  const typo = io({ ...CONFIG, strategies: [...CONFIG.strategies, { id: 'oops', preset: 'no-such-preset' }] });
  assert.equal(await fleetRunCmd(['--all', '--paper', '--replay', TAPE, '--stub'], typo.io, { killSwitch: noPanic(typo.home) }), 1);
  assert.match(typo.err.join(''), /nothing started[\s\S]*oops/);
  assert.equal(existsSync(runLockPath(typo.home)), false, 'no lock taken when nothing starts');
  const panicked = io(CONFIG);
  const pk = noPanic(panicked.home);
  pk.engage('test panic');
  assert.equal(await fleetRunCmd(['--all', '--paper', '--replay', TAPE, '--stub'], panicked.io, { killSwitch: pk }), 1);
  assert.match(panicked.err.join(''), /panic switch is engaged/);
});

test('1529 cli: run --all on a tape: one ledger per strategy plus the fleet\'s, the comparison table, status --all, the aggregate rendezvous', async () => {
  const x = io(CONFIG);
  let rendezvousSeen = false;
  const runIo = { ...x.io, stdout: { write: (s: string) => { x.out.push(s); if (!rendezvousSeen && existsSync(fleetStatusPath(x.home))) { const r = activeRunner(x.home); if (r && r.runId.includes('fleet') && r.state) rendezvousSeen = true; } return true; } } };
  const code = await fleetRunCmd(['--all', '--paper', '--replay', TAPE, '--ms-per-tick', '1', '--stub'], runIo, { killSwitch: noPanic(x.home) });
  const out = x.out.join('');
  assert.equal(code, 0, x.err.join(''));
  assert.match(out, /PAPER · 3 strategies at once \(2 enabled\)/);
  assert.match(out, /STRATEGY\s+STATE\s+BANKROLL\s+P\/L/);
  assert.match(out, /scalp-b .*\$150/, 'a 1 SOL bankroll at $150');
  const files = runs(x.home);
  assert.equal(files.length, 3, `fleet + two enabled strategies: ${files.join(', ')}`);
  for (const f of files) assert.ok(verifyChain(events(x.home, f)).ok, `${f} verifies`);
  const fleet = events(x.home, files.find((f) => f.includes('-fleet-'))!);
  assert.equal(fleet[0].kind, 'fleet_start');
  assert.equal(fleet.at(-1)!.kind, 'fleet_end');
  assert.deepEqual(fleet.filter((e) => e.kind === 'member_start').map((e) => e.member).sort(), ['moon-a', 'scalp-b']);
  assert.ok(rendezvousSeen, 'the runner rendezvous carried the fleet while it ran (the Q screen and stop/flatten read it)');
  assert.equal(existsSync(runLockPath(x.home)), false, 'the lock was released');
  const s = await at(x, 'status', '--all', '--json');
  assert.equal(s.code, 0);
  const j = JSON.parse(s.out) as { paper: boolean; fleet: { state: string; strategies: { id: string; state: string }[] } };
  assert.equal(j.paper, true);
  assert.equal(j.fleet.state, 'stopped');
  assert.deepEqual(j.fleet.strategies.map((r) => [r.id, r.state]), [['moon-a', 'stopped'], ['scalp-b', 'stopped'], ['dip-c', 'idle']]);
  const txt = await at(x, 'status', '--all');
  assert.match(txt.out, /PARALLEL STRATEGIES · PAPER/);
  assert.match(txt.out, /not financial advice/);
  const st = await at(x, 'start', 'dip-c');
  assert.equal(st.code, 1, 'a start for a stopped fleet is refused');
  assert.match(st.err, /has stopped/);
});

test('1529 cli: mid-run, `pause --strategy` and `start` touch one strategy only', async () => {
  const x = io(CONFIG);
  const box: { p: Promise<number> | null; s: Promise<number> | null } = { p: null, s: null };
  const quiet = { ...x.io, stdout: { write: () => true }, stderr: { write: () => true } };
  const runIo = { ...x.io, stdout: { write: (s: string) => {
    x.out.push(s);
    if (!box.p && /^\[scalp-b\] BUY /m.test(s)) { box.p = pauseCmd(['--strategy', 'scalp-b', '--json'], quiet); box.s = startCmd(['dip-c', '--wait', '0'], quiet); }
    return true;
  } } };
  const code = await fleetRunCmd(['--all', '--paper', '--replay', TAPE, '--ms-per-tick', '1', '--stub'], runIo, { killSwitch: noPanic(x.home) });
  assert.equal(code, 0, x.err.join(''));
  assert.ok(box.p && box.s, 'scalp-b bought something, so the commands ran mid-run');
  assert.equal(await box.p, 0);
  assert.equal(await box.s, 0);
  const files = runs(x.home);
  const ev = (id: string) => events(x.home, files.find((f) => f.includes(`-${id}-`))!);
  assert.ok(ev('scalp-b').some((e) => e.kind === 'entries_paused'), 'scalp-b paused its entries');
  assert.ok(!ev('moon-a').some((e) => e.kind === 'entries_paused'), 'moon-a never saw the pause');
  assert.ok(files.some((f) => f.includes('-dip-c-')), 'dip-c started with its own ledger');
  const fleet = events(x.home, files.find((f) => f.includes('-fleet-'))!);
  assert.ok(fleet.some((e) => e.kind === 'member_control' && e.member === 'dip-c' && e.action === 'start'));
});
