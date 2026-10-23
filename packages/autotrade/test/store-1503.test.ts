// task-1503: the strategy store — $DEXTERM_HOME/strategies/<id>.json CRUD with an append-only journal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StrategyStore, bumpPatch, semverGreater } from '../src/store.ts';
import { presetPath } from '../src/strategy.ts';

const home = () => mkdtempSync(join(tmpdir(), 'dexterm-at-store-'));
const preset = (id: string) => JSON.parse(readFileSync(presetPath(id), 'utf8'));
let clock = 1_792_000_000_000;
const now = () => (clock += 1000);

test('1503 store: $DEXTERM_HOME is honoured; list shows the presets until a user file exists', () => {
  const h = home();
  const s = new StrategyStore({ env: { DEXTERM_HOME: h } });
  assert.equal(s.dir, join(h, 'strategies'));
  const ids = s.list().map((e) => `${e.source}:${e.id}`);
  for (const id of ['moonbag', 'runner', 'sample-dip-ladder', 'scalp', 'swing']) assert.ok(ids.includes(`preset:${id}`), id);
  assert.ok(s.list().every((e) => e.ok && e.mode === 'paper'));
  assert.equal(existsSync(s.dir), false, 'listing writes nothing');
});

test('1503 store: create from a preset, patch, update, remove: every write journaled with actor + before/after hash', () => {
  const s = new StrategyStore({ home: home(), now });
  const c = s.createFrom('swing', 'my-swing', { actor: 'user', name: 'My swing' });
  assert.ok(c.ok, JSON.stringify(c));
  assert.equal(c.strategy.version, '1.0.0');
  const file = s.pathOf('my-swing');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(s.dir).mode & 0o777, 0o700);

  const p = s.patch('my-swing', [{ op: 'replace', path: '/exits/profiles/0', value: 'builtin:swing' }, { op: 'replace', path: '/sizing/pct', value: 8 }], { actor: 'user', why: 'smaller tickets' });
  assert.ok(p.ok, JSON.stringify(p));
  assert.equal(p.strategy.version, '1.0.1', 'a patch bumps the patch version');
  assert.equal(p.strategy.sizing.pct, 8);
  assert.equal(p.journal.beforeHash, c.strategy.hash);
  assert.equal(p.journal.afterHash, p.strategy.hash);
  assert.ok(p.journal.inverse?.some((x) => x.path === '/sizing/pct' && x.value === 10), 'the inverse restores the old value');

  const doc = { ...JSON.parse(readFileSync(file, 'utf8')), version: '1.1.0', description: 'rewritten' };
  const u = s.update('my-swing', doc, { actor: 'user' });
  assert.ok(u.ok, JSON.stringify(u));
  const same = s.update('my-swing', doc, { actor: 'user' });
  assert.ok(!same.ok && same.errors[0].path === '/version', 'an update must raise the version');

  const r = s.remove('my-swing', { actor: 'user' });
  assert.ok(r.ok);
  assert.equal(existsSync(file), false);
  assert.ok(existsSync(r.movedTo), 'removed means moved to .removed/, never deleted');
  assert.equal(s.get('my-swing'), null);

  const j = s.journal('my-swing');
  assert.deepEqual(j.map((x) => x.action), ['create', 'patch', 'update', 'remove']);
  for (const x of j) for (const k of ['actor', 'ops', 'beforeHash', 'afterHash', 't']) assert.ok(k in x, `${x.action} has ${k}`);
  assert.equal(j[0].beforeHash, null);
  assert.equal(j[3].afterHash, null);
  assert.equal(j[1].beforeHash, j[0].afterHash, 'the journal chains by hash');
  assert.equal(j[2].beforeHash, j[1].afterHash);
  // Append-only: the file only ever grew, one JSON object per line.
  const lines = readFileSync(s.journalPath, 'utf8').trim().split('\n');
  assert.equal(lines.length, 4);
});

test('1503 store: an invalid document is never written; unknown keys (signer/wallet/key) are refused with a path', () => {
  const s = new StrategyStore({ home: home(), now });
  for (const [key, where] of [['signer', ''], ['wallet', ''], ['key', '/execution']] as const) {
    const doc = preset('scalp');
    doc.id = `bad-${key}`;
    if (where) doc.execution[key] = 'x'; else doc[key] = { anything: true };
    const r = s.create(doc, { actor: 'user' });
    assert.ok(!r.ok);
    assert.ok(r.errors.some((e) => e.path === `${where}/${key}`), `${key}: ${JSON.stringify(r.errors)}`);
    assert.equal(existsSync(s.pathOf(`bad-${key}`)), false);
  }
  const ok = s.createFrom('scalp', 'mine', { actor: 'user' });
  assert.ok(ok.ok);
  const bad = s.patch('mine', [{ op: 'add', path: '/signer', value: { caps: 1 } }], { actor: 'user' });
  assert.ok(!bad.ok && bad.errors.some((e) => e.path === '/signer'));
  const badRange = s.patch('mine', [{ op: 'replace', path: '/sizing/maxPctOfBankroll', value: 90 }], { actor: 'user' });
  assert.ok(!badRange.ok && badRange.errors.some((e) => e.path === '/sizing/maxPctOfBankroll'));
  assert.equal(s.journal('mine').length, 1, 'refused writes are not journaled');
});

test('1503 store: ids cannot walk out of the directory; presets are read-only; duplicates refused; actor checked', () => {
  const s = new StrategyStore({ home: home(), now });
  for (const id of ['../x', 'a/b', 'UP', 'x', '.journal']) assert.throws(() => s.pathOf(id), /bad strategy id/);
  assert.ok(!s.patch('swing', [{ op: 'replace', path: '/sizing/pct', value: 5 }], { actor: 'user' }).ok, 'a preset is not patched in place');
  assert.ok(s.createFrom('swing', 'dup', { actor: 'user' }).ok);
  assert.ok(!s.createFrom('swing', 'dup', { actor: 'user' }).ok);
  assert.ok(!s.createFrom('swing', 'other', { actor: 'Not An Actor' }).ok);
  assert.ok(!s.patch('dup', [{ op: 'replace', path: '/id', value: 'renamed' }], { actor: 'user' }).ok);
  assert.ok(!s.patch('dup', Array.from({ length: 21 }, () => ({ op: 'replace' as const, path: '/sizing/pct', value: 5 })), { actor: 'user' }).ok, 'at most 20 ops');
});

test('1503 store: a user file shadows the preset of the same id; get prefers it; mode live is stored with a warning', () => {
  const s = new StrategyStore({ home: home(), now });
  const doc = { ...preset('scalp'), description: 'my scalp', mode: 'live' };
  const c = s.create(doc, { actor: 'user' });
  assert.ok(c.ok);
  assert.ok(c.warnings.some((w) => w.path === '/mode'), 'live validates with a warning (the runner refuses it)');
  const g = s.get('scalp');
  assert.equal(g?.source, 'user');
  const e = s.list().filter((x) => x.id === 'scalp');
  assert.equal(e.length, 1);
  assert.equal(e[0].shadowsPreset, true);
});

test('1503 store: the last backtest line is kept per strategy hash; a torn journal line is skipped', () => {
  const s = new StrategyStore({ home: home(), now });
  assert.ok(s.createFrom('runner', 'r1', { actor: 'user' }).ok);
  const h = s.list().find((x) => x.id === 'r1')!.hash!;
  s.recordBacktest({ hash: h, t: now(), trades: 9, netUsd: -304.49, netPct: -30.45, maxDrawdownPct: 30.8, tape: 'fixture' });
  assert.equal(s.list().find((x) => x.id === 'r1')!.lastBacktest?.trades, 9);
  writeFileSync(s.journalPath, readFileSync(s.journalPath, 'utf8') + '{"torn":');
  assert.equal(s.journal().length, 1);
  assert.ok(readdirSync(s.dir).includes('.backtests.json'));
});

test('1503 store: version helpers', () => {
  assert.equal(bumpPatch('1.2.9'), '1.2.10');
  assert.ok(semverGreater('1.10.0', '1.9.9'));
  assert.ok(!semverGreater('1.0.0', '1.0.0'));
});
