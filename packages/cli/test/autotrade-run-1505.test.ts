// task-1505: `dexterm autotrade run --paper`: refusals (no --paper, --live, a live strategy, a second runner, a bad
// runner.json), a paced replay with stub sessions and with a fake `claude` CLI (the init proof, an account mismatch),
// the run ledger + summary, the rendezvous and the released lock. Fixture tape + temp $DEXTERM_HOME: no network,
// no model, no keys, paper only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { autotradeCommand } from '../src/autotrade-cmd.ts';
import { acquireRunLock, presetPath, readLedgerFile, releaseRunLock, runLockPath, runnerRendezvousPath, verifyChain } from '@dexterm/autotrade';

const TAPE = fileURLToPath(new URL('../../autotrade/test/fixtures/autotrade-1498-tape.json', import.meta.url));
const FAKE = fileURLToPath(new URL('../../autotrade/test/fixtures/fake-claude.mjs', import.meta.url));

function io(extra: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dexterm-at-run-'));
  const out: string[] = [], err: string[] = [];
  return { home, out, err, io: { stdout: { write: (s: string) => out.push(s) }, stderr: { write: (s: string) => err.push(s) }, env: { DEXTERM_HOME: home, DEXTERM_DB_PATH: join(home, 'none.db'), PATH: process.env.PATH ?? '', ...extra } } };
}
const run = async (x: ReturnType<typeof io>, ...argv: string[]) => {
  x.out.length = 0; x.err.length = 0;
  const code = await autotradeCommand(['autotrade', 'run', ...argv], x.io);
  return { code, out: x.out.join(''), err: x.err.join('') };
};
const ledgerOf = (home: string) => {
  const dir = join(home, 'autotrade', 'runs');
  const f = readdirSync(dir).find((n) => n.endsWith('.jsonl') && !n.includes('stream'))!;
  return { events: readLedgerFile(join(dir, f)), summary: JSON.parse(readFileSync(join(dir, f.replace('.jsonl', '.summary.json')), 'utf8')) as Record<string, unknown> };
};

test('1505 run: paper only — no --paper, --live, or a strategy in mode live are refused before anything starts', async () => {
  const x = io();
  assert.equal((await run(x, 'swing')).code, 2);
  const live = await run(x, 'swing', '--paper', '--live');
  assert.equal(live.code, 2);
  assert.match(live.err, /there is no --live: dexterm runs strategies on paper only and never holds a key or signs/);
  const doc = JSON.parse(readFileSync(presetPath('swing'), 'utf8'));
  const file = join(x.home, 'live.json');
  writeFileSync(file, JSON.stringify({ ...doc, id: 'live-copy', mode: 'live' }));
  const r = await run(x, file, '--paper', '--stub', '--replay', TAPE);
  assert.equal(r.code, 1);
  assert.match(r.err, /is mode "live": the runner runs paper only \(dexterm holds no key and places no live order\)/);
  assert.ok(!existsSync(join(x.home, 'autotrade', 'runs')), 'no run started');
});

test('1505 run: --replay with stub sessions writes a verified ledger + summary, a stopped rendezvous, the focus file, and releases the lock', async () => {
  const x = io();
  const r = await run(x, 'swing', '--paper', '--stub', '--replay', TAPE, '--ms-per-tick', '1', '--quiet');
  assert.equal(r.code, 0, r.err);
  const { events, summary } = ledgerOf(x.home);
  assert.ok(verifyChain(events).ok);
  assert.equal(events[0].kind, 'run_start');
  assert.equal(events[0].mode, 'paper');
  assert.equal(events.at(-1)!.kind, 'run_end');
  assert.ok(events.some((e) => e.kind === 'session_start'));
  assert.equal(summary.schema, 'dexterm-autotrade-run-summary/1');
  const rdv = JSON.parse(readFileSync(runnerRendezvousPath(x.home), 'utf8')) as Record<string, unknown>;
  assert.equal(rdv.schema, 'dexterm-autotrade-runner/1');
  assert.equal(rdv.state, 'stopped');
  assert.equal(rdv.mode, 'paper');
  assert.ok(existsSync(join(x.home, 'autotrade', 'focus.json')));
  assert.ok(!existsSync(runLockPath(x.home)), 'lock released');
  // The Q screen's runner view reads exactly this file.
  const ui = await import('../src/screens/autotrade-ui.ts');
  assert.equal(ui.runnerRendezvousPath(x.home), runnerRendezvousPath(x.home));
  const read = ui.readRunnerRendezvous(ui.runnerRendezvousPath(x.home));
  assert.equal(read.kind, 'ok', JSON.stringify(read));
});

test('1505 run: a second runner on the machine is refused while the first holds the lock', async () => {
  const x = io();
  const held = acquireRunLock(x.home, 'other-run');
  assert.ok(held.ok);
  const r = await run(x, 'swing', '--paper', '--stub', '--replay', TAPE);
  assert.equal(r.code, 1);
  assert.match(r.err, /another runner is active/);
  releaseRunLock(x.home, 'other-run');
});

test('1505 run: an invalid runner.json is an error, never a silent default account', async () => {
  const x = io();
  mkdirSync(join(x.home, 'autotrade'), { recursive: true });
  writeFileSync(join(x.home, 'autotrade', 'runner.json'), JSON.stringify({ schema: 'dexterm-runner/1', account: { kind: 'oauth-token', token: 'inline' } }));
  const r = await run(x, 'swing', '--paper', '--replay', TAPE);
  assert.equal(r.code, 1);
  assert.match(r.err, /runner\.json is invalid/);
});

test('1505 run: claude sessions on a fake CLI — init proof logged; an apiKeySource the account does not expect ends every session', async () => {
  const ok = io({ FAKE_REPLIES: JSON.stringify(['DECISION {"action":"skip","reason":"not now"}']) });
  const a = await run(ok, 'swing', '--paper', '--replay', TAPE, '--ms-per-tick', '1', '--quiet', '--claude-bin', FAKE, '--model', 'haiku');
  assert.equal(a.code, 0, a.err);
  const ea = ledgerOf(ok.home).events;
  assert.ok(ea.some((e) => e.kind === 'session_init' && e.ok === true && e.apiKeySource === 'none'));
  assert.ok(ea.some((e) => e.kind === 'session_end' && e.reason === 'agent-skip'));
  assert.ok(ea.some((e) => e.kind === 'allowance' && e.fiveHour === 0.1));

  const bad = io({ FAKE_API_KEY_SOURCE: 'ANTHROPIC_API_KEY' });
  const b = await run(bad, 'swing', '--paper', '--replay', TAPE, '--ms-per-tick', '1', '--quiet', '--claude-bin', FAKE);
  assert.equal(b.code, 0, b.err);
  const eb = ledgerOf(bad.home).events;
  const ends = eb.filter((e) => e.kind === 'session_end');
  assert.ok(ends.length >= 1);
  assert.equal(ends.filter((e) => e.reason === 'account-mismatch').length, 1, 'the first mismatch ends its session ...');
  assert.ok(eb.some((e) => e.kind === 'guard' && e.state === 'account-mismatch'), '... and blocks new sessions for the run');
  assert.ok(ends.every((e) => e.reason === 'account-mismatch' || e.reason === 'candidate-ttl'), JSON.stringify(ends.map((e) => e.reason)));
  assert.equal(eb.filter((e) => e.kind === 'clamp').length, 0, 'nothing a mismatched session said was executed');
});
