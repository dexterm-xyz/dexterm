// task-1786: `dexterm record --focus-module PATH` / `--exit-probes` (winner-recall DATA-GAPS items 1-2). Offline: a fake
// engine, temp dirs for the module and the plist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { parseRun, plistPath, recordCommand, type CollectorEngine } from '../src/record-cmd.ts';

function io(env: NodeJS.ProcessEnv = {}) {
  const sink = () => { const c: string[] = []; return { w: new Writable({ write(x, _e, cb) { c.push(String(x)); cb(); } }), text: () => c.join('') }; };
  const out = sink(); const err = sink();
  return { io: { stdout: out.w, stderr: err.w, env }, out, err };
}
const engine = (): CollectorEngine => ({
  async observe() { return 0; }, async maintain() {}, prune() {}, dbBytes() { return 0; }, newPairs() { return 0; }, close() {},
  async pollTicks() { return { coins: 0, calls: 0, answered: 0, written: 0, overCap: 0, skipped: 'no-focus' }; },
});

test('parseRun: --focus-module resolves the path and implies --focus-ticks; --exit-probes implies it too', () => {
  const r = parseRun(['--focus-module', 'rel/focus.mjs']);
  assert.ok(!('error' in r));
  if ('error' in r) return;
  assert.equal(r.focusModule, resolve('rel/focus.mjs'));
  assert.equal(r.focusTicks, true);
  assert.equal(r.exitProbes, false);
  const p = parseRun(['--exit-probes']);
  assert.ok(!('error' in p) && p.exitProbes && p.focusTicks && p.focusModule === null);
  const d = parseRun([]);
  assert.ok(!('error' in d) && !d.focusTicks && !d.exitProbes && d.focusModule === null, 'off by default');
  assert.ok('error' in parseRun(['--focus-module']));
  assert.ok('error' in parseRun(['--focus-module', '--exit-probes']));
});

test('run: a focus module that does not load, or exports no focus(), is a startup error; a good one runs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rec-1786-'));
  try {
    writeFileSync(join(dir, 'none.mjs'), 'export const x = 1;\n');
    writeFileSync(join(dir, 'good.mjs'), 'export function focus(now) { return [{ mint: "So11111111111111111111111111111111111111112", role: "held" }]; }\n');
    const a = io();
    assert.equal(await recordCommand(['run', '--once', '--focus-module', join(dir, 'missing.mjs')], a.io as never, { engine: engine(), now: () => 0 }), 2);
    assert.match(a.err.text(), /--focus-module/);
    const b = io();
    assert.equal(await recordCommand(['run', '--once', '--focus-module', join(dir, 'none.mjs')], b.io as never, { engine: engine(), now: () => 0 }), 2);
    assert.match(b.err.text(), /no focus\(now\) function/);
    const c = io();
    assert.equal(await recordCommand(['run', '--once', '--focus-module', join(dir, 'good.mjs'), '--exit-probes'], c.io as never, { engine: engine(), now: () => 0 }), 0, c.err.text());
    assert.match(c.err.text(), /focus module .*good\.mjs · exit probes on/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('install: --focus-module (absolute) and --exit-probes reach the plist', async () => {
  const home = mkdtempSync(join(tmpdir(), 'rec-1786-'));
  try {
    const env = { HOME: home, DEXTERM_DB_PATH: join(home, 'd.db') };
    const ins = io(env);
    assert.equal(await recordCommand(['install', '--retention-mb', '4000', '--focus-module', join(home, 'f.mjs'), '--exit-probes'], ins.io as never), 0, ins.err.text());
    const xml = readFileSync(plistPath(env), 'utf8');
    assert.match(xml, /<string>--focus-ticks<\/string>\s*<string>--focus-module<\/string>\s*<string>[^<]*f\.mjs<\/string>\s*<string>--exit-probes<\/string>/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
