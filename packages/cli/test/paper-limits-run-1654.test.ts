// task-1654 (0.2.0 card E): `dexterm autotrade run --paper` and the `paper` scope of limits.json. Without the scope a
// paper run is exactly as before; with it, the run says so, sizes are clamped and the limits refuse, on the run's own
// state (real mode's files are never written). A replay needs --sol-usd (sizes are in SOL). A temp $DEXTERM_HOME,
// the recorded tape, stub sessions. No network, no key, no signal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { autotradeCommand } from '../src/autotrade-cmd.ts';
import { emptyLimits, limitsPath, readLedgerFile, saveLimits } from '@dexterm/autotrade';
import { saveTyped } from '../../autotrade/test/fixtures/typed-save.ts';

const TAPE = fileURLToPath(new URL('../../autotrade/test/fixtures/autotrade-1498-tape.json', import.meta.url));

function io() {
  const home = mkdtempSync(join(tmpdir(), 'dexterm-1654-paper-'));
  const out: string[] = [], err: string[] = [];
  return { home, out, err, io: { stdout: { write: (s: string) => out.push(s) }, stderr: { write: (s: string) => err.push(s) }, env: { DEXTERM_HOME: home, DEXTERM_DB_PATH: join(home, 'none.db'), PATH: process.env.PATH ?? '' } } };
}
type X = ReturnType<typeof io>;
const run = async (x: X, ...argv: string[]) => {
  x.out.length = 0; x.err.length = 0;
  const code = await autotradeCommand(['autotrade', 'run', ...argv], x.io);
  return { code, out: x.out.join(''), err: x.err.join('') };
};
const ledgerOf = (home: string) => {
  const dir = join(home, 'autotrade', 'runs');
  // task-1679: the newest run file by mtime. Run ids are second-resolution timestamps + a random suffix, so runs
  // started within one second (a fast CI runner) do not sort by name in start order.
  const f = readdirSync(dir).filter((n) => n.endsWith('.jsonl') && !n.includes('stream')).map((n) => ({ n, t: statSync(join(dir, n)).mtimeMs })).sort((a, b) => a.t - b.t).at(-1)!.n;
  return readLedgerFile(join(dir, f));
};
const args = ['scalp', '--paper', '--stub', '--replay', TAPE, '--ms-per-tick', '1', '--no-telegram'];

test('paper run: no paper scope = the limits do not apply; a paper scope clamps and refuses on the run\'s own state', async () => {
  const x = io();
  // Real limits only (no modes.paper): a paper run ignores them.
  assert.equal(saveTyped(x.home, { ...emptyLimits(), global: { perTradeSol: 0.01 } }).ok, true);
  let r = await run(x, ...args);
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.out, /PAPER LIMITS/);
  const free = ledgerOf(x.home).filter((e) => e.kind === 'fill' && e.side === 'buy');
  assert.ok(free.some((b) => Number(b.usd) > 0.01 * 200 + 1e-9), 'without a paper scope the 0.01 SOL cap is not applied to paper');

  // A paper scope: perTradeSol 0.1 at $200/SOL = $20 a buy, one open position.
  assert.equal(saveTyped(x.home, { ...emptyLimits(), global: { perTradeSol: 0.1, maxBuysPerMinute: null, executorSilenceMin: null }, modes: { paper: { maxOpenPositions: 1 } } }).ok, true);
  r = await run(x, ...args);
  assert.equal(r.code, 1, 'a replay with a paper scope needs --sol-usd');
  assert.match(r.err, /a replay needs the SOL price of its day, --sol-usd N/);

  const realDir = join(x.home, 'autotrade', 'real');
  const before = existsSync(realDir) ? readdirSync(realDir).sort() : [];
  r = await run(x, ...args, '--sol-usd', '200');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /PAPER LIMITS · the paper scope of limits\.json applies · .*0\.1 SOL/);
  const ev = ledgerOf(x.home);
  const buys = ev.filter((e) => e.kind === 'fill' && e.side === 'buy');
  assert.ok(buys.length >= 1);
  assert.ok(buys.every((b) => Number(b.usd) <= 20 + 1e-9), 'perTradeSol 0.1 clamps every paper buy');
  assert.ok(JSON.stringify(ev).includes('fill-paper-limit-max-open'), 'one open position at a time');
  assert.deepEqual(existsSync(realDir) ? readdirSync(realDir).sort() : [], before, 'paper writes nothing of real mode (no risk.json, held.json, signals)');
});

test('paper run: an invalid limits file is a warning, never a silent paper scope', async () => {
  const x = io();
  saveTyped(x.home, { ...emptyLimits(), global: { perTradeSol: 0.1 } });
  writeFileSync(limitsPath(x.home), JSON.stringify({ schema: 'dexterm-limits/1', global: { perTradeSol: 'lots' }, modes: { paper: {} } }));
  const r = await run(x, ...args, '--quiet');
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /warning: paper limits NOT applied: limits: \/global\/perTradeSol/);
});
