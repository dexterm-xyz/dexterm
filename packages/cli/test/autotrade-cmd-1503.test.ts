// task-1503: `dexterm autotrade validate|list|new|import|remove|journal|backtest|sweep` and the
// `dexterm backtest --subject strategy` route. Recorded fixture tape + a temp $DEXTERM_HOME: no network, no keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUBCOMMANDS, autotradeCommand, handles } from '../src/autotrade-cmd.ts';
import { presetPath } from '@dexterm/autotrade';

const TAPE = fileURLToPath(new URL('../../autotrade/test/fixtures/autotrade-1498-tape.json', import.meta.url));

function io(home = mkdtempSync(join(tmpdir(), 'dexterm-at-cli-'))) {
  const out: string[] = [], err: string[] = [];
  return { home, out, err, io: { stdout: { write: (s: string) => out.push(s) }, stderr: { write: (s: string) => err.push(s) }, env: { DEXTERM_HOME: home, DEXTERM_DB_PATH: join(home, 'none.db') } } };
}
const run = async (x: ReturnType<typeof io>, ...argv: string[]) => {
  x.out.length = 0; x.err.length = 0;
  const code = await autotradeCommand(argv, x.io);
  return { code, out: x.out.join(''), err: x.err.join('') };
};

test('1503 cli: routing: `dexterm autotrade …` and only the strategy subject of `dexterm backtest`', () => {
  assert.ok(handles(['autotrade']));
  assert.ok(handles(['backtest', '--subject', 'strategy']));
  assert.ok(handles(['backtest', '--subject=strategy', '--strategy', 'scalp']));
  assert.ok(!handles(['backtest']));
  assert.ok(!handles(['backtest', '--subject', 'heuristic']));
  assert.ok(!handles(['backtests']));
  for (const k of ['validate', 'list', 'backtest', 'sweep']) assert.ok(k in SUBCOMMANDS, k);
});

test('1503 cli: help, unknown subcommand, list shows the presets', async () => {
  const x = io();
  const h = await run(x, 'autotrade');
  assert.equal(h.code, 0);
  assert.match(h.out, /PAPER ONLY, not financial advice/);
  const u = await run(x, 'autotrade', 'constructor');
  assert.equal(u.code, 2, 'an inherited name is not a subcommand');
  const l = await run(x, 'autotrade', 'list');
  for (const id of ['scalp', 'swing', 'runner', 'moonbag', 'sample-dip-ladder']) assert.match(l.out, new RegExp(`\\b${id}\\b.*preset.*paper`));
  const j = JSON.parse((await run(x, 'autotrade', 'list', '--json')).out);
  assert.equal(j.dir, join(x.home, 'strategies'));
});

test('1503 cli: validate refuses a signer/wallet section with its path and exits 2; live validates with the runner-refusal note', async () => {
  const x = io();
  const bad = JSON.parse(readFileSync(presetPath('swing'), 'utf8'));
  bad.wallet = { secret: 'x' };
  const f = join(x.home, 'bad.json');
  writeFileSync(f, JSON.stringify(bad));
  const r = await run(x, 'autotrade', 'validate', f);
  assert.equal(r.code, 2);
  assert.match(r.out, /error \/wallet: /);
  const live = { ...JSON.parse(readFileSync(presetPath('swing'), 'utf8')), mode: 'live' };
  const lf = join(x.home, 'live.json');
  writeFileSync(lf, JSON.stringify(live));
  const v = await run(x, 'autotrade', 'validate', lf);
  assert.equal(v.code, 0);
  assert.match(v.out, /warning \/mode: mode live does not run: dexterm runs strategies on paper only \(it holds no key and places no live order\)/);
  assert.match(v.out, /mode live \(does not run: dexterm runs strategies on paper only\)/);
  const b = await run(x, 'autotrade', 'backtest', lf, '--tape', TAPE);
  assert.equal(b.code, 2, 'a live strategy is never backtested as if it could run');
  assert.match(b.err, /paper only/);
  assert.equal((await run(x, 'autotrade', 'validate', 'no-such-strategy')).code, 2);
});

test('1503 cli: new → backtest → list carries the last backtest; import forces paper; remove; journal names the actor', async () => {
  const x = io();
  assert.equal((await run(x, 'autotrade', 'new', 'my-moon', '--from', 'moonbag')).code, 0);
  assert.ok(existsSync(join(x.home, 'strategies', 'my-moon.json')));
  const b = await run(x, 'autotrade', 'backtest', 'my-moon', '--tape', TAPE);
  assert.equal(b.code, 0, b.err);
  assert.match(b.out, /BACKTEST my-moon v1\.0\.0 .* PAPER · recorded data/);
  assert.match(b.out, /per entry .*bootstrap 95%/);
  assert.match(b.out, /limits of this data:/);
  assert.match(b.out, /not financial advice/);
  assert.match((await run(x, 'autotrade', 'list')).out, /my-moon\s+user .* last backtest \d+ trades/);

  const imp = JSON.parse(readFileSync(presetPath('runner'), 'utf8'));
  Object.assign(imp, { id: 'shared-runner', mode: 'live' });
  const f = join(x.home, 'shared.json');
  writeFileSync(f, JSON.stringify(imp));
  const i = await run(x, 'autotrade', 'import', f);
  assert.equal(i.code, 0, i.err);
  assert.match(i.out, /mode forced to paper/);
  assert.equal(JSON.parse(readFileSync(join(x.home, 'strategies', 'shared-runner.json'), 'utf8')).mode, 'paper');
  assert.equal((await run(x, 'autotrade', 'import', f)).code, 2, 'an existing id needs --replace');

  assert.equal((await run(x, 'autotrade', 'remove', 'my-moon')).code, 0);
  assert.equal((await run(x, 'autotrade', 'remove', 'swing')).code, 2, 'presets cannot be removed');
  const j = JSON.parse((await run(x, 'autotrade', 'journal', '--json')).out) as { action: string; actor: string; id: string }[];
  assert.deepEqual(j.map((e) => `${e.action}:${e.id}:${e.actor}`), ['create:my-moon:user', 'create:shared-runner:import', 'remove:my-moon:user']);
});

test('1503 cli: `dexterm backtest --subject strategy` runs the engine; every-candidate + recall; sweep prints the held-out verdict', async () => {
  const x = io();
  const r = await run(x, 'backtest', '--subject', 'strategy', '--strategy', 'moonbag', '--tape', TAPE, '--every-candidate', '--recall', '2,5', '--json');
  assert.equal(r.code, 0, r.err);
  const rep = JSON.parse(r.out);
  assert.equal(rep.strategy.id, 'moonbag-every');
  assert.equal(rep.recall.length, 2);
  assert.ok(rep.tail.perEntry && rep.tail.multiples);
  const s = await run(x, 'autotrade', 'sweep', 'swing', '--tape', TAPE, '--grid', '{"profile.trailingStop.trailPct":[15,30]}');
  assert.equal(s.code, 0, s.err);
  assert.match(s.out, /VERDICT: too few trades/);
  assert.match(s.out, /held-out \d+ coins/);
  assert.equal((await run(x, 'autotrade', 'sweep', 'swing', '--tape', TAPE, '--grid', '{"x":"y"}')).code, 2);
  const none = await run(x, 'autotrade', 'backtest', 'swing');
  assert.equal(none.code, 2);
  assert.match(none.err, /no recorded history/);
});
