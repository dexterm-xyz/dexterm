// task-1504 (AT-2, AUTOTRADE-SPEC §3): `tapeFromDb` reads token_snapshots + autotrade_ticks in tape order. Synthetic
// rows in an in-memory DB with the recorder's own schema; no network, no keys, paper only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL } from '../../recorder/src/schema.ts';
import { tapeFromDb, tapeFromDoc, TAPE_COLUMNS } from '../src/replay.ts';

const A = `A${'x'.repeat(39)}pump`;
const B = `B${'x'.repeat(39)}pump`;
const T0 = Date.parse('2026-10-21T00:00:00Z');
const S = 1000;

function db(): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec(SCHEMA_SQL);
  return d;
}
const snap = (d: DatabaseSync, mint: string, t: number, price: number, extra: { holders?: number; top10?: number; resolved?: number; kind?: string } = {}): void => {
  d.prepare(`INSERT INTO token_snapshots (mint, t, kind, hash, src_market, sources, symbol, launchpad, created_at, price_usd, mcap, mcap_resolved, liquidity_usd, holder_count, top_holders_pct, vol_h24, mint_auth_enabled)
    VALUES (?, ?, ?, 'h', 'dexscreener', '[]', 'AAA', 'pump.fun', ?, ?, ?, ?, 50000, ?, ?, 1000, 0)`)
    .run(mint, t, extra.kind ?? 'live', T0 - 3600 * S, price, price * 1e9, extra.resolved ?? null, extra.holders ?? 100, extra.top10 ?? 20);
};
const tick = (d: DatabaseSync, mint: string, t: number, price: number | null, liq = 48_000): void => {
  d.prepare("INSERT INTO autotrade_ticks (mint, t, role, price_usd, liquidity_usd, mcap, vol_m5, chg_m5, pair_created_at) VALUES (?, ?, 'held', ?, ?, ?, 12, 1.5, ?)")
    .run(mint, t, price, price === null ? null : liq, price === null ? null : price * 1e9, T0 - 3600 * S);
};
const col = (name: (typeof TAPE_COLUMNS)[number]): number => TAPE_COLUMNS.indexOf(name);

test('no ticks: the pre-1504 tape (source, rows and order unchanged)', () => {
  const d = db();
  for (let i = 0; i < 3; i++) snap(d, A, T0 + i * 120 * S, 1 + i / 10);
  const doc = tapeFromDb(d, { minLiveRows: 2, minPeakLiqUsd: 1 });
  assert.equal(doc.source, 'recorder token_snapshots (read-only)');
  assert.equal(doc.mints.length, 1);
  assert.deepEqual(doc.mints[0].rows.map((r) => r[col('t')]), [T0, T0 + 120 * S, T0 + 240 * S]);
});

test('ticks merge in tape order: snapshot first at a tie, slow fields carried forward from earlier snapshots only, resolved mcap scaled, NULL-price ticks dropped', () => {
  const d = db();
  tick(d, A, T0 - 10 * S, 0.9);                              // before any snapshot: no base to carry
  snap(d, A, T0, 1, { holders: 100, top10: 20, resolved: 1e9 });
  tick(d, A, T0, 1.05);                                      // same t as the snapshot: after it
  tick(d, A, T0 + 5 * S, 1.2);
  tick(d, A, T0 + 10 * S, null);                             // pool gone this poll: not a price row
  snap(d, A, T0 + 120 * S, 2, { holders: 140, top10: 25, resolved: 2e9 });
  tick(d, A, T0 + 125 * S, 3);
  const doc = tapeFromDb(d, { minLiveRows: 2, minPeakLiqUsd: 1, since: T0 - 60 * S });
  assert.equal(doc.source, 'recorder token_snapshots + autotrade_ticks (read-only)');
  assert.match(doc.note, /5-10 s tick samples/);
  const rows = doc.mints[0].rows;
  assert.deepEqual(rows.map((r) => [r[col('t')], r[col('price')]]), [
    [T0 - 10 * S, 0.9], [T0, 1], [T0, 1.05], [T0 + 5 * S, 1.2], [T0 + 120 * S, 2], [T0 + 125 * S, 3],
  ]);
  const at = (t: number, i = 0) => rows.filter((r) => r[col('t')] === t)[i];
  assert.equal(at(T0 - 10 * S)[col('holders')], null, 'nothing to carry before the first snapshot (no look-ahead)');
  assert.equal(at(T0 + 5 * S)[col('holders')], 100, 'carried from the snapshot before it');
  assert.equal(at(T0 + 125 * S)[col('holders')], 140, 'and from the newer one once it exists');
  assert.equal(at(T0 + 5 * S)[col('top10')], 20);
  assert.equal(at(T0 + 5 * S)[col('mcapResolved')], 1.2e9, 'resolved mcap scaled by the price move');
  assert.equal(at(T0 + 5 * S)[col('liq')], 48_000, 'the tick’s own liquidity');
  assert.equal(at(T0 + 5 * S)[col('vol5m')], 12);
  assert.equal(at(T0 + 5 * S)[col('vol24')], 1000, '24 h volume carried');
  assert.equal(at(T0 + 5 * S)[col('mintAuth')], 0);
  assert.equal(at(T0 + 5 * S)[col('kind')], 'live');
  assert.equal(doc.mints[0].symbol, 'AAA', 'identity from the first row that has one');
  // the expanded tape is in deterministic time order and every tick is a MarketTick
  const tape = tapeFromDoc(doc);
  assert.equal(tape.ticks.length, 6);
  assert.ok(tape.ticks.every((k, i) => i === 0 || k.t >= tape.ticks[i - 1].t));
  // ticks: false reads snapshots only
  assert.equal(tapeFromDb(d, { minLiveRows: 2, minPeakLiqUsd: 1, since: T0 - 60 * S, ticks: false }).mints[0].rows.length, 2);
});

test('a coin seen only by the tick lane qualifies on its ticks; the carry-forward base may sit before the window', () => {
  const d = db();
  for (let i = 0; i < 4; i++) tick(d, B, T0 + i * 5 * S, 0.5 + i / 100, 30_000);
  snap(d, A, T0 - 600 * S, 1, { holders: 77 });
  tick(d, A, T0 + 1 * S, 1.1);
  tick(d, A, T0 + 6 * S, 1.2);
  const doc = tapeFromDb(d, { minLiveRows: 2, minPeakLiqUsd: 20_000, since: T0 });
  const b = doc.mints.find((m) => m.mint === B)!;
  assert.ok(b, 'tick-only coin picked');
  assert.equal(b.symbol, '?');
  assert.equal(b.createdAt, T0 - 3600 * S, 'created time from the pair');
  assert.equal(b.rows.length, 4);
  const a = doc.mints.find((m) => m.mint === A)!;
  assert.deepEqual(a.rows.map((r) => r[col('t')]), [T0 + 1 * S, T0 + 6 * S], 'the pre-window snapshot is a base, not a row');
  assert.ok(a.rows.every((r) => r[col('holders')] === 77));
  assert.equal(tapeFromDb(d, { minLiveRows: 5, minPeakLiqUsd: 1, since: T0 }).mints.length, 0, 'min live rows still applies');
});
