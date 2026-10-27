// 0.2.0 card B: `dexterm autotrade service …` end to end on temp homes with the fixture tape and stub sessions (paper,
// no network, no model): the service runs the fleet with a heartbeat; a second start is refused; a stop halts new
// entries within a step while the exits keep running and leaves the service stopped; a reboot simulation (a real
// kill -9 of a child service, then ensure + a new run) carries the open paper positions over and never buys a taken
// coin again; ensure is a no-op on a fresh heartbeat and on a stop; install shows and writes exactly its files and
// uninstall removes exactly them (and refuses while positions are open).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KillSwitch } from '@dexterm/data';
import {
  RESUME_TAKEN_RULE, SERVICE_SCHEMA, acquireServiceLock, installManifestPath, readServiceHeartbeat, readStopMarker, releaseServiceLock, runLockPath, runnerRendezvousPath,
  serviceStopPath, writeServiceHeartbeat, type LedgerEvent,
} from '@dexterm/autotrade';
import { autotradeCommand } from '../src/autotrade-cmd.ts';
import { iniProblem, installSpec, serviceCmd, verifyPlan, xmlProblem, type ServiceDeps } from '../src/autotrade-cmd/service.ts';
import { installPlan } from '@dexterm/autotrade';

const TAPE = fileURLToPath(new URL('../../autotrade/test/fixtures/autotrade-1498-tape.json', import.meta.url));
const BIN = fileURLToPath(new URL('../bin/dexterm.mjs', import.meta.url));
const CONFIG = {
  schema: 'dexterm-autotrade/1', solUsd: 150,
  strategies: [{ id: 'moon-a', preset: 'moonbag', bankroll: { usd: 500 } }, { id: 'scalp-b', preset: 'scalp', bankroll: { usd: 300 } }],
  global: { maxConcurrentSessions: 2, modelUsdPerDay: 5 },
};

function io() {
  const home = mkdtempSync(join(tmpdir(), 'dexterm-svc-'));
  mkdirSync(join(home, 'autotrade'), { recursive: true });
  writeFileSync(join(home, 'autotrade', 'autotrade.json'), JSON.stringify(CONFIG));
  const out: string[] = [], err: string[] = [];
  return { home, out, err, io: { stdout: { write: (s: string) => out.push(s) }, stderr: { write: (s: string) => err.push(s) }, env: { DEXTERM_HOME: home, DEXTERM_DB_PATH: join(home, 'none.db'), HOME: home, PATH: process.env.PATH ?? '' } } };
}
type X = ReturnType<typeof io>;
const noPanic = (home: string) => new KillSwitch(join(home, 'trading.panic'));
const runsOf = (home: string) => readdirSync(join(home, 'autotrade', 'runs')).filter((n) => n.endsWith('.jsonl'));
const eventsOf = (home: string, name: string) => readFileSync(join(home, 'autotrade', 'runs', name), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as LedgerEvent);
const quietDeps = (x: X, over: ServiceDeps = {}): ServiceDeps => ({
  killSwitch: noPanic(x.home), notify: async () => {}, probe: { freeGb: 100, load1m: 1, busy: [], recorder: { installed: true, newestAgeMs: 0 } }, beatMs: 200,
  ...over, fleetOver: { killSwitch: noPanic(x.home), loadavg: () => 0, ...over.fleetOver },
});
const until = async (cond: () => boolean, ms: number, what: string) => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 25)); }
};

test('1646 service run: the fleet runs under a heartbeat; a second start is refused; the end of every strategy leaves it stopped', async () => {
  const x = io();
  const beats: string[] = [];
  const p = serviceCmd(['run', '--stub', '--replay', TAPE, '--ms-per-tick', '2'], x.io, quietDeps(x, { fleetOver: { hooks: { onFleetState: () => { const hb = readServiceHeartbeat(x.home); if (hb) beats.push(hb.state); } } } }));
  await until(() => readServiceHeartbeat(x.home)?.state === 'running', 10_000, 'the heartbeat');
  const second = await serviceCmd(['run', '--stub'], x.io, quietDeps(x));
  assert.equal(second, 1);
  assert.match(x.err.join(''), /already running .*never runs twice/);
  assert.equal(await p, 0);
  const hb = readServiceHeartbeat(x.home)!;
  assert.equal(hb.state, 'stopped');
  assert.match(String(hb.endReason), /every strategy ended|stopped/);
  assert.ok(readStopMarker(x.home), 'a fleet that ended by itself leaves the service stopped');
  assert.ok(beats.includes('running'));
  const fleet = runsOf(x.home).find((n) => n.includes('-fleet-'))!;
  assert.deepEqual(eventsOf(x.home, fleet).slice(0, 1).map((e) => e.kind), ['service_start']);
});

test('1646 service stop: new entries halt within a step (well under a second), exits keep running, the service stays stopped', async () => {
  const x = io();
  let asked = 0;
  let haltAt = 0;
  const after: LedgerEvent[] = [];
  let halted = false;
  const deps = quietDeps(x, {
    fleetOver: {
      hooks: {
        onMemberEvent: (_m, _r, e) => {
          if (halted) after.push(e);
          if (!asked && e.kind === 'fill' && e.side === 'buy') { asked = Date.now(); void serviceCmd(['stop'], x.io, deps); }
          if (e.kind === 'halt' && !haltAt) { haltAt = Date.now(); halted = true; }
        },
      },
    },
  });
  const code = await serviceCmd(['run', '--stub', '--replay', TAPE, '--ms-per-tick', '3'], x.io, deps);
  assert.equal(code, 0);
  assert.ok(asked && haltAt, 'a buy happened and the stop halted the run');
  assert.ok(haltAt - asked < 1000, `stop latency ${haltAt - asked} ms`);
  assert.equal(after.filter((e) => e.kind === 'fill' && e.side === 'buy').length, 0, 'no buy after the halt');
  assert.equal(readStopMarker(x.home)?.by, 'cli');
  assert.equal(readServiceHeartbeat(x.home)?.state, 'stopped');
  // ensure keeps it down; start lifts it.
  let spawned = 0;
  await serviceCmd(['ensure'], x.io, quietDeps(x, { spawnRun: () => { spawned++; return 1; } }));
  assert.equal(spawned, 0);
  await serviceCmd(['start'], x.io, quietDeps(x, { spawnRun: () => { spawned++; return 1; } }));
  assert.equal(spawned, 1);
  assert.equal(existsSync(serviceStopPath(x.home)), false);
});

test('1646 reboot simulation: kill -9 the service, ensure restarts it, open paper positions are adopted and taken coins are never bought again', async () => {
  const x = io();
  writeFileSync(join(x.home, 'autotrade', 'service.json'), JSON.stringify({ schema: 'dexterm-autotrade-service-config/1', runArgs: ['--stub', '--replay', TAPE, '--ms-per-tick', '15'] }));
  const child = spawn(process.execPath, [BIN, 'autotrade', 'service', 'run', '--home', x.home], { env: { ...x.io.env }, stdio: 'ignore' });
  const openBuys = () => {
    try {
      return runsOf(x.home).filter((n) => !n.includes('-fleet-')).some((n) => {
        const ev = eventsOf(x.home, n);
        const closed = new Set(ev.filter((e) => e.kind === 'trade_closed').map((e) => (e.trade as { id: string }).id));
        return ev.some((e) => e.kind === 'fill' && e.side === 'buy' && !closed.has(String(e.positionId)));
      });
    } catch { return false; }
  };
  await until(openBuys, 30_000, 'an open paper position in the child service');
  child.kill('SIGKILL');
  await new Promise((r) => child.once('exit', r));
  const before = runsOf(x.home);
  // The next scheduler tick: a crash restart.
  let spawned = 0;
  const e = await serviceCmd(['ensure', '--json'], x.io, quietDeps(x, { spawnRun: () => { spawned++; return null; } }));
  assert.equal(e, 0);
  assert.equal(spawned, 1);
  assert.match(x.out.join(''), /"crashed":true/);
  // ... which starts `service run` (here in process, with the flags from service.json).
  const code = await serviceCmd(['run'], x.io, quietDeps(x));
  assert.equal(code, 0);
  const fresh = runsOf(x.home).filter((n) => !before.includes(n));
  const fleet = fresh.find((n) => n.includes('-fleet-'))!;
  const fev = eventsOf(x.home, fleet);
  const resume = fev.find((e) => e.kind === 'service_resume');
  assert.ok(resume, 'service_resume in the new fleet ledger');
  const taken = new Set(Object.values(resume!.members as Record<string, { taken: string[] }>).flatMap((m) => m.taken));
  assert.ok(taken.size > 0);
  const memberEv = fresh.filter((n) => !n.includes('-fleet-')).flatMap((n) => eventsOf(x.home, n));
  assert.ok(memberEv.some((e) => e.kind === 'position_adopted'), 'the open position was adopted');
  const rebought = memberEv.filter((e) => e.kind === 'fill' && e.side === 'buy' && taken.has(String(e.mint)));
  assert.equal(rebought.length, 0, 'no taken coin was bought again');
  assert.ok(memberEv.some((e) => e.kind === 'refused' && e.rule === RESUME_TAKEN_RULE) || memberEv.every((e) => !(e.kind === 'candidate' && taken.has(String(e.mint)))));
  assert.ok((readServiceHeartbeat(x.home)?.resumed?.positions ?? 0) >= 1, 'the heartbeat reports the carried-over positions');
});

test('1646 ensure: starts once, then a no-op on a fresh heartbeat; a hung pid is ended', async () => {
  const x = io();
  let spawned = 0;
  const deps = quietDeps(x, { spawnRun: () => { spawned++; return 4242; } });
  await serviceCmd(['ensure'], x.io, deps);
  assert.equal(spawned, 1);
  const lock = acquireServiceLock(x.home);
  assert.ok(lock.ok);
  writeServiceHeartbeat(x.home, { schema: SERVICE_SCHEMA, pid: process.pid, startedAt: Date.now(), heartbeatAt: Date.now(), state: 'running', fleetId: null, guard: [] });
  await serviceCmd(['ensure'], x.io, deps);
  assert.equal(spawned, 1);
  const killed: number[] = [];
  await serviceCmd(['ensure'], x.io, quietDeps(x, { now: () => Date.now() + 10 * 60_000, kill: (pid) => { killed.push(pid); } }));
  assert.deepEqual(killed, [process.pid]);
  releaseServiceLock(x.home);
});

test('1646 install: dry-run writes nothing; install writes exactly its files and a manifest; uninstall removes exactly them', async () => {
  const x = io();
  const user = mkdtempSync(join(tmpdir(), 'dexterm-svc-user-'));
  const ran: string[][] = [];
  const deps = quietDeps(x, { platform: 'linux', userHome: user, exec: (c) => { ran.push(c); return { status: 0, out: '' }; } });
  assert.equal(await serviceCmd(['install', '--dry-run'], x.io, deps), 0);
  const shown = x.out.join('');
  assert.match(shown, /dry-run \(nothing is written\)/);
  assert.match(shown, /\[Timer\][\s\S]*OnUnitActiveSec=60/);
  assert.match(shown, /✓ .*\.service: parses/);
  assert.equal(existsSync(join(user, '.config')), false);
  x.out.length = 0;
  assert.equal(await serviceCmd(['install', '--load'], x.io, deps), 0);
  const unitDir = join(user, '.config', 'systemd', 'user');
  const files = readdirSync(unitDir).sort();
  assert.equal(files.length, 2);
  assert.match(files[0], /^dexterm-autotrade-h[0-9a-f]{8}\.service$/);
  assert.deepEqual(ran.map((c) => c.slice(0, 3).join(' ')), ['systemctl --user daemon-reload', 'systemctl --user enable']);
  const manifest = JSON.parse(readFileSync(installManifestPath(x.home), 'utf8')) as { files: { path: string }[]; loaded: boolean };
  assert.equal(manifest.loaded, true);
  // The plan joins systemd paths the Linux way whatever the host (task-1712); on a Windows CI host userHome is `C:\…`.
  assert.deepEqual(manifest.files.map((f) => f.path).sort(), files.map((f) => posix.join(user, '.config', 'systemd', 'user', f)).sort());
  // A file the user changed is kept (exit 1) unless --force.
  writeFileSync(join(unitDir, files[1]), '# edited\n');
  assert.equal(await serviceCmd(['uninstall'], x.io, deps), 1);
  assert.equal(existsSync(join(unitDir, files[1])), true);
  assert.equal(await serviceCmd(['uninstall', '--force'], x.io, deps), 0);
  assert.deepEqual(readdirSync(unitDir), []);
  assert.equal(existsSync(installManifestPath(x.home)), false);
  assert.ok(ran.some((c) => c.join(' ').startsWith('systemctl --user disable --now')));
  assert.ok(readStopMarker(x.home), 'uninstall stops the service first');
});

test('1646 uninstall refuses while paper positions are open (unless --flatten --yes)', async () => {
  const x = io();
  const user = mkdtempSync(join(tmpdir(), 'dexterm-svc-user-'));
  const deps = quietDeps(x, { platform: 'linux', userHome: user, exec: () => ({ status: 0, out: '' }) });
  assert.equal(await serviceCmd(['install'], x.io, deps), 0);
  const runId = '20261024T120000Z-fleet-abcd';
  writeFileSync(runLockPath(x.home), JSON.stringify({ pid: process.pid, bootAt: 0, runId, startedAt: Date.now() }));
  writeFileSync(runnerRendezvousPath(x.home), JSON.stringify({ runId, state: 'running', positions: [{ mint: 'M' }], sessions: [], heartbeatAt: Date.now(), haltReason: null }));
  x.err.length = 0;
  assert.equal(await serviceCmd(['uninstall'], x.io, deps), 1);
  assert.match(x.err.join(''), /1 position is open/);
  assert.equal(existsSync(installManifestPath(x.home)), true);
  assert.equal(await serviceCmd(['uninstall', '--flatten'], x.io, deps), 2);
});

test('1646 plan checks: generated files parse; broken XML, a KeepAlive plist and a stray systemd line are caught', () => {
  const x = io();
  for (const platform of ['darwin', 'linux', 'win32'] as const) {
    const spec = installSpec(x.io, platform, '/home/tester');
    const v = verifyPlan(installPlan(spec, x.home), () => ({ status: 0, out: '' }));
    assert.equal(v.ok, true, `${platform}: ${v.lines.join('; ')}`);
  }
  assert.match(String(xmlProblem('<a><b></a>')), /closes/);
  assert.match(String(xmlProblem('<a>x & y</a>')), /bare &/);
  assert.match(String(iniProblem('Key=1\n')), /before any/);
  const plan = installPlan(installSpec(x.io, 'darwin', '/home/tester'), x.home);
  plan.files[0].content = plan.files[0].content.replace('<key>RunAtLoad</key>', '<key>KeepAlive</key>\n  <true/>\n  <key>RunAtLoad</key>');
  assert.equal(verifyPlan(plan, () => ({ status: 0, out: '' })).ok, false);
});

test('1646 status and the command table', async () => {
  const x = io();
  const out = async (...argv: string[]) => { x.out.length = 0; await autotradeCommand(['autotrade', ...argv], x.io); return x.out.join(''); };
  assert.match(await out('service', 'status'), /service +not running[\s\S]*installed +no/);
  writeServiceHeartbeat(x.home, { schema: SERVICE_SCHEMA, pid: 999_999, startedAt: 1, heartbeatAt: 1, state: 'running', fleetId: 'f', guard: [] });
  assert.match(await out('service', 'status'), /DOWN: the last run crashed/);
  const j = JSON.parse(await out('service', 'status', '--json')) as { running: boolean; installed: unknown };
  assert.deepEqual([j.running, j.installed], [false, null]);
  assert.match(await out('help'), /autotrade service install\|uninstall\|ensure/);
});
