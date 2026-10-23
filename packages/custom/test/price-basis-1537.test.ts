// task-1537 — market cap is the default price basis: the v4 → v5 migration moves a `price` that was only the old
// default, and keeps a `price` the user chose (the config journal recorded it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, migrate, CONFIG_VERSION, DEFAULT_PRICE_MODE } from '../src/schema.ts';
import { applyAndJournal, configPath, journaledPriceMode, loadConfig } from '../src/config.ts';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'dexterm-1537-'));
const v4 = (priceMode?: string): Record<string, unknown> => ({ ...defaultConfig(), version: 4, display: priceMode ? { priceMode } : {} });

test('v4 → v5: the old default `price` becomes mcap; mcap stays; a missing mode gets the default', () => {
  assert.equal(CONFIG_VERSION, 5);
  assert.equal(DEFAULT_PRICE_MODE, 'mcap');
  const m = migrate(v4('price'));
  assert.deepEqual(m.errors, []);
  assert.equal(m.config.version, 5);
  assert.equal(m.config.display?.priceMode, 'mcap');
  assert.ok(m.notes.some((n) => /market cap is now the default basis/.test(n) && /dexterm display price/.test(n)));
  assert.equal(migrate(v4('mcap')).config.display?.priceMode, 'mcap');
  assert.equal(migrate(v4()).config.display?.priceMode, 'mcap');
});

test('v4 → v5: a `price` the user chose (journaled) is kept and the note says how to switch', () => {
  const m = migrate(v4('price'), { journaledPriceMode: 'price' });
  assert.equal(m.config.display?.priceMode, 'price');
  assert.ok(m.notes.some((n) => /kept \(you chose it\)/.test(n)));
  // a journal that last recorded mcap does not protect a price
  assert.equal(migrate(v4('price'), { journaledPriceMode: 'mcap' }).config.display?.priceMode, 'mcap');
});

test('journaledPriceMode reads the last value the journal set (whole-display adds too); null when never set', () => {
  const home = tmp();
  assert.equal(journaledPriceMode(home), null);
  writeFileSync(configPath(home), JSON.stringify(defaultConfig()));
  applyAndJournal(home, [{ op: 'add', path: '/display/priceMode', value: 'price' }], { actor: 'user', why: '$', now: 1 });
  assert.equal(journaledPriceMode(home), 'price');
  applyAndJournal(home, [{ op: 'add', path: '/display', value: { priceMode: 'mcap' } }], { actor: 'user', why: '$', now: 2 });
  assert.equal(journaledPriceMode(home), 'mcap');
});

test('loader: a v4 file on disk migrates to v5 with a backup; the journaled price choice survives it', () => {
  const plain = tmp();
  writeFileSync(configPath(plain), JSON.stringify(v4('price')));
  const a = loadConfig(plain);
  assert.equal(a.ok, true, a.errors.join('; '));
  assert.equal(a.config.display?.priceMode, 'mcap');
  assert.ok(existsSync(`${configPath(plain)}.bak-v4`));
  assert.equal(JSON.parse(readFileSync(configPath(plain), 'utf8')).version, 5);

  const chose = tmp();
  writeFileSync(configPath(chose), JSON.stringify(defaultConfig()));
  applyAndJournal(chose, [{ op: 'add', path: '/display/priceMode', value: 'price' }], { actor: 'user', why: 'dexterm display price', now: 1 });
  writeFileSync(configPath(chose), JSON.stringify(v4('price'))); // the same choice as a pre-1537 v4 file
  const b = loadConfig(chose);
  assert.equal(b.ok, true, b.errors.join('; '));
  assert.equal(b.config.display?.priceMode, 'price');
});
