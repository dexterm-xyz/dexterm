// task-1509: `dexterm autotrade stop | flatten | audit --verify`, the run's start refusals (panic engaged, an unreadable
// control file) and the Q screen's file-backed control (`!`, `p`, `f`). A paced replay of the fixture tape with stub
// sessions in a temp $DEXTERM_HOME: no network, no model, no keys, paper only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KillSwitch } from '@dexterm/data';
import { controlPath, readControl, runLockPath, runnerRendezvousPath } from '@dexterm/autotrade';
import { autotradeCommand } from '../src/autotrade-cmd.ts';
import { runCmd } from '../src/autotrade-cmd/run.ts';
import { stopCmd } from '../src/autotrade-cmd/stop.ts';
import { flattenCmd } from '../src/autotrade-cmd/flatten.ts';
import { fileControl } from '../src/screens/autotrade-ui.ts';

const TAPE = fileURLToPath(new URL('../../autotrade/test/fixtures/autotrade-1498-tape.json', import.meta.url));

function io() {
  const home = mkdtempSync(join(tmpdir(), 'dexterm-at-safety-'));
  const out: string[] = [], err: string[] = [];
  return { home, out, err, io: { stdout: { write: (s: string) => out.push(s) }, stderr: { write: (s: string) => err.push(s) }, env: { DEXTERM_HOME: home, DEXTERM_DB_PATH: join(home, 'none.db'), PATH: process.env.PATH ?? '' } } };
}
const at = async (x: ReturnType<typeof io>, ...argv: string[]) => {
  x.out.length = 0; x.err.length = 0;
  const code = await autotradeCommand(['autotrade', ...argv], x.io);
  return { code, out: x.out.join(''), err: x.err.join('') };
};
// Against a running in-process replay the subcommands are called directly: the paced stub replay is CPU-bound
// between its sleeps, so the dispatcher's lazy import() of a subcommand module could resolve only after it ended.
const direct = async (x: ReturnType<typeof io>, fn: typeof stopCmd, ...argv: string[]) => {
  const out: string[] = [], err: string[] = [];
  const code = await fn(argv, { ...x.io, stdout: { write: (q: string) => out.push(q) }, stderr: { write: (q: string) => err.push(q) } });
  return { code, out: out.join(''), err: err.join('') };
};
const noPanic = (home: string) => new KillSwitch(join(home, 'trading.panic'));
const ledgerFile = (home: string) => {
  const dir = join(home, 'autotrade', 'runs');
  return join(dir, readdirSync(dir).find((n) => n.endsWith('.jsonl') && !n.includes('stream'))!);
};
const events = (home: string) => readFileSync(ledgerFile(home), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);

/**
 * Run a paced stub replay in this process and call `act` from inside it, on the runner's first BUY line. A
 * subcommand's request is written synchronously before its first await, so it lands while the run is in progress
 * (polling from the test would not: the replay is CPU-bound between its rare paced sleeps).
 */
type Out = { code: number; out: string; err: string };
async function runWith(x: ReturnType<typeof io>, act: () => Promise<Out>) {
  const box: { fired: Promise<Out> | null } = { fired: null };
  const runIo = { ...x.io, stdout: { write: (s: string) => { if (!box.fired && /^BUY /m.test(s)) box.fired = act(); return true; } } };
  const code = await runCmd(['swing', '--paper', '--stub', '--replay', TAPE, '--ms-per-tick', '1'], runIo, { killSwitch: noPanic(x.home) });
  assert.ok(box.fired, 'the replay bought something, so the command ran mid-run');
  return { code, res: await box.fired };
}

test('1509 cli: stop and flatten with no runner say so and exit 0; audit with no runs too', async () => {
  const x = io();
  const s = await at(x, 'stop');
  assert.equal(s.code, 0);
  assert.match(s.out, /no autotrade runner is running/);
  assert.equal((await at(x, 'flatten', '--yes')).code, 0);
  const a = await at(x, 'audit', '--verify');
  assert.equal(a.code, 0);
  assert.match(a.out, /no autotrade runs yet/);
  assert.equal(existsSync(controlPath(x.home)), false, 'nothing was written');
});

test('1509 cli: a run refuses to start while the panic switch is engaged, and over an unreadable control file', async () => {
  const x = io();
  const ks = noPanic(x.home);
  ks.engage('test panic');
  const code = await runCmd(['swing', '--paper', '--stub', '--replay', TAPE], x.io, { killSwitch: ks });
  assert.equal(code, 1);
  assert.match(x.err.join(''), /panic switch is engaged \(test panic\).*dexterm wallet resume/);
  assert.equal(existsSync(runLockPath(x.home)), false, 'no lock taken');
  ks.release();
  mkdirSync(join(x.home, 'autotrade'), { recursive: true });
  writeFileSync(controlPath(x.home), 'garbage');
  x.err.length = 0;
  assert.equal(await runCmd(['swing', '--paper', '--stub', '--replay', TAPE], x.io, { killSwitch: ks }), 1);
  assert.match(x.err.join(''), /cannot be read/);
  assert.equal(existsSync(runLockPath(x.home)), false, 'the lock was released');
});

test('1509 cli: `stop` against a running replay halts it (sessions closed, no entries after), the run ends once flat, and audit --verify passes', async () => {
  const x = io();
  const { code, res: s } = await runWith(x, () => direct(x, stopCmd, '--wait', '10'));
  assert.equal(code, 0);
  assert.equal(s.code, 0, s.err);
  assert.match(s.out, /stop requested for run/);
  assert.match(s.out, /✓ (halted|the runner stopped)/);
  const ev = events(x.home);
  const halt = ev.find((e) => e.kind === 'halt')!;
  assert.equal(halt.reason, 'stop');
  assert.equal(ev.filter((e) => e.kind === 'fill' && e.side === 'buy' && (e.seq as number) > (halt.seq as number)).length, 0);
  assert.equal(ev.filter((e) => e.kind === 'session_start' && (e.seq as number) > (halt.seq as number)).length, 0);
  assert.equal(ev[ev.length - 1].kind, 'run_end');
  assert.equal(readControl(x.home), null, 'the run removed its own request at the end');
  assert.equal(existsSync(runLockPath(x.home)), false);

  const v = await at(x, 'audit', '--verify');
  assert.equal(v.code, 0, v.out);
  assert.match(v.out, /✓ .*events.*ended/);
  assert.match(v.out, /every chain verifies/);
  // Edit one line: audit names it and exits 1.
  const f = ledgerFile(x.home);
  const lines = readFileSync(f, 'utf8').trim().split('\n');
  const i = lines.findIndex((l) => l.includes('"kind":"halt"'));
  writeFileSync(f, `${lines.map((l, j) => (j === i ? l.replace('"reason":"stop"', '"reason":"none"') : l)).join('\n')}\n`);
  const bad = await at(x, 'audit', '--last', '--verify');
  assert.equal(bad.code, 1);
  assert.match(bad.out, new RegExp(`✗ .*broken at event ${i + 1}: hash does not match`));
});

test('1509 cli: `flatten` needs y on a terminal (or --yes); with --yes the runner sells what it holds and stops', async () => {
  const x = io();
  const seen: { piped: Out | null } = { piped: null };
  let control: unknown = 'unset';
  const { code, res: f } = await runWith(x, () => {
    // Synchronous prefix: the piped attempt is refused before anything is written, then --yes goes through.
    const p = direct(x, flattenCmd).then((r) => { seen.piped = r; });
    control = readControl(x.home);
    const yes = direct(x, flattenCmd, '--yes', '--wait', '10');
    return p.then(() => yes);
  });
  assert.equal(code, 0);
  assert.equal(seen.piped?.code, 2);
  assert.match(seen.piped!.err, /confirm with y on a real terminal, or pass --yes/);
  assert.equal(control, null, 'a refused flatten writes nothing');
  assert.equal(f.code, 0, f.err);
  const ev = events(x.home);
  assert.equal(ev.find((e) => e.kind === 'halt')!.reason, 'flatten');
  assert.ok(ev.some((e) => e.kind === 'flatten'));
  const end = ev[ev.length - 1] as { kind: string; openAtEnd: number };
  assert.equal(end.kind, 'run_end');
  assert.equal(end.openAtEnd, 0, 'nothing is held at the end');
});

test('1509 Q screen: `!` writes a stop for the running run, `p` toggles a pause, and a stop cannot be paused or lifted', () => {
  const x = io();
  const ctl = fileControl(x.home);
  assert.equal(ctl.wired, true);
  assert.equal(ctl.kill(), 'no autotrade runner is running');
  mkdirSync(join(x.home, 'autotrade'), { recursive: true });
  writeFileSync(runLockPath(x.home), JSON.stringify({ pid: process.pid, bootAt: 0, runId: 'r-q', startedAt: Date.now() }));
  assert.match(ctl.pause(), /paused/);
  assert.equal((readControl(x.home) as { action: string }).action, 'pause');
  assert.match(ctl.pause(), /resumed/);
  assert.equal((readControl(x.home) as { action: string }).action, 'resume-entries');
  assert.match(ctl.kill(), /stop requested/);
  const c = readControl(x.home) as { action: string; by: string; runId: string };
  assert.deepEqual([c.action, c.by, c.runId], ['stop', 'tui', 'r-q']);
  assert.match(ctl.pause(), /already stopping/);
  assert.equal((readControl(x.home) as { action: string }).action, 'stop');
  assert.match(ctl.flatten(), /flatten requested/);
  assert.equal((readControl(x.home) as { action: string }).action, 'flatten');
});
