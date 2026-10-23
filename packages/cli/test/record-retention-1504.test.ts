// task-1504: the collector's opt-in retention + focus-tick flags. 'evict' mode never pauses observation (the
// task-1414 'pause' default is unchanged), the tick loop polls until the main loop ends, install passes the flags
// into the plist only when given. No network: fake engines only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { parseRun, plistPath, recordCommand, renderCollectorPlist, runCollectorLoop, runTickLoop, COLLECTOR_LABEL, type CollectorEngine } from '../src/record-cmd.ts';

function io(env: NodeJS.ProcessEnv = {}) {
  const sink = () => { const c: string[] = []; return { w: new Writable({ write(x, _e, cb) { c.push(String(x)); cb(); } }), text: () => c.join('') }; };
  const out = sink(); const err = sink();
  return { io: { stdout: out.w, stderr: err.w, env }, out, err };
}

function engine(over: { dbBytes: number; evictTo?: number }) {
  const calls = { observe: 0, prune: 0, cap: 0, ticks: 0 };
  let size = over.dbBytes;
  const e: CollectorEngine = {
    async observe() { calls.observe++; return 1; },
    async maintain() {},
    prune() { calls.prune++; },
    dbBytes() { return size; },
    newPairs() { return 0; },
    close() {},
    enforceCap() { calls.cap++; const evicted = over.evictTo !== undefined && size > over.evictTo; if (evicted) size = over.evictTo!; return { evicted, usedAfter: size, over: over.evictTo === undefined }; },
    async pollTicks() { calls.ticks++; return { coins: 2, calls: 1, answered: 2, written: 2, overCap: 0, skipped: null }; },
  };
  return { e, calls };
}

test('evict mode: observation runs every tick even far above the old pause cap; the cap is enforced each tick', async () => {
  const { e, calls } = engine({ dbBytes: 5_000_000, evictTo: 900_000 });
  let t = 0;
  const r = await runCollectorLoop(e, { intervalMs: 1000, ticks: 4, maintainEveryMs: 60_000, maxDbBytes: 1_000_000, capMode: 'evict', now: () => t, sleep: async (ms) => { t += ms; }, aborted: () => false });
  assert.equal(r.observePasses, 4, 'never paused');
  assert.equal(r.cappedTicks, 0);
  assert.equal(calls.cap, 4);
  assert.equal(r.evictions, 1, 'evicted once, then under the cap');
  assert.equal(calls.prune, 0, 'the pause path (forced prune) is not used');
  // even when eviction cannot get under (only the newest hour left): log, keep observing
  const stuck = engine({ dbBytes: 5_000_000 });
  const logs: string[] = [];
  const r2 = await runCollectorLoop(stuck.e, { intervalMs: 1000, ticks: 2, maintainEveryMs: 60_000, maxDbBytes: 1_000_000, capMode: 'evict', now: () => t, sleep: async (ms) => { t += ms; }, aborted: () => false, onLog: (s) => logs.push(s) });
  assert.equal(r2.observePasses, 2);
  assert.match(logs.join(''), /observation continues/);
});

test('pause mode stays the default (task-1414 behaviour unchanged)', async () => {
  const { e } = engine({ dbBytes: 5_000_000 });
  let t = 0;
  const r = await runCollectorLoop(e, { intervalMs: 1000, ticks: 2, maintainEveryMs: 60_000, maxDbBytes: 1_000_000, now: () => t, sleep: async (ms) => { t += ms; }, aborted: () => false });
  assert.equal(r.observePasses, 0);
  assert.equal(r.cappedTicks, 2);
  const d = parseRun([]);
  assert.ok(!('error' in d) && d.retentionBytes === null && d.retentionDays === null && !d.focusTicks, 'no retention cap, no ticks unless asked');
});

test('parseRun: --retention-mb, --retention-days, --focus-ticks and bad values', () => {
  const r = parseRun(['--retention-mb', '3000', '--retention-days', '14', '--focus-ticks']);
  assert.ok(!('error' in r));
  assert.equal(r.retentionBytes, 3_000_000_000);
  assert.equal(r.retentionDays, 14);
  assert.equal(r.focusTicks, true);
  assert.ok('error' in parseRun(['--retention-mb', '0']));
  assert.ok('error' in parseRun(['--retention-days', 'x']));
});

test('tick loop: polls every interval until aborted; an engine without a lane is a no-op', async () => {
  const { e, calls } = engine({ dbBytes: 0 });
  let n = 0;
  const r = await runTickLoop(e, { everyMs: 5000, sleep: async () => { n++; }, aborted: () => n >= 3 });
  assert.equal(r.polls, 3);
  assert.equal(r.written, 6);
  assert.equal(calls.ticks, 3);
  const bare: CollectorEngine = { ...e, pollTicks: undefined };
  assert.deepEqual(await runTickLoop(bare, { everyMs: 5000, sleep: async () => {}, aborted: () => false }), { polls: 0, calls: 0, written: 0 });
});

test('run --once --focus-ticks --retention-mb: both loops run and stop, the summary names them', async () => {
  const { e, calls } = engine({ dbBytes: 0 });
  const r = io({ DEXTERM_DB_PATH: '/tmp/never-opened.db' });
  const code = await recordCommand(['run', '--once', '--focus-ticks', '--retention-mb', '500'], r.io as never, { engine: e, now: () => 0 });
  assert.equal(code, 0, r.err.text());
  assert.equal(calls.observe, 1);
  assert.ok(calls.ticks >= 1, 'the tick lane polled');
  assert.equal(calls.cap, 1);
  assert.match(r.err.text(), /retention 500 MB \(evict, never pause\)/);
  assert.match(r.out.text(), /focus-tick poll/);
});

test('install: the plist carries the new flags only when given', async () => {
  const plain = renderCollectorPlist({ label: COLLECTOR_LABEL, nodePath: '/n', binPath: '/b', intervalMs: 60_000, maxDbMb: 1024, logPath: '/tmp/l', workingDir: '/w' });
  assert.doesNotMatch(plain, /retention|focus-ticks/);
  const home = mkdtempSync(join(tmpdir(), 'rec-1504-'));
  try {
    const env = { HOME: home, DEXTERM_DB_PATH: join(home, 'd.db') };
    const ins = io(env);
    assert.equal(await recordCommand(['install', '--retention-mb', '3000', '--retention-days', '14', '--focus-ticks'], ins.io as never), 0, ins.err.text());
    const xml = readFileSync(plistPath(env), 'utf8');
    assert.match(xml, /<string>--retention-mb<\/string>\s*<string>3000<\/string>/);
    assert.match(xml, /<string>--retention-days<\/string>\s*<string>14<\/string>/);
    assert.match(xml, /<string>--focus-ticks<\/string>/);
    assert.match(ins.err.text(), /NOT loaded/, 'never loads launchctl without --load');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
