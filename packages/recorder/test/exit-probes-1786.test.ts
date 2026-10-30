// task-1786 (winner-recall DATA-GAPS item 2): the exit-probe lane. Fakes only: the quote and the decimals are injected,
// the DB is ':memory:' or a temp file, nothing touches the network.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Recorder } from '../src/recorder.ts';
import { WSOL_MINT, type ExitProbeDeps } from '../src/exit-probes.ts';
import type { FocusEntry } from '../src/ticks.ts';
import { pruneTicksByAge } from '../src/retention.ts';

const A = 'AAAAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxpump';
const B = 'BBBBxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxpump';
const C = 'CCCCxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxpump';
const clock = (t0: number) => { let t = t0; return { now: () => t, set: (x: number) => { t = x; } }; };

function deps(over: { paused?: number; fail?: Set<string> } = {}) {
  const calls: { mint: string; amount: bigint; out: string; prio?: string }[] = [];
  const d: ExitProbeDeps = {
    async quote(req) {
      calls.push({ mint: req.inputMint, amount: req.amount, out: req.outputMint });
      if (over.fail?.has(req.inputMint)) throw new Error('no route found');
      return { outAmount: 250_000_000n, priceImpactPct: 1.5, routeHops: 2 };
    },
    async decimals() { return 6; },
    limiter: { bucket: () => ({ stats: () => ({ pausedUntil: over.paused ?? 0 }) }) } as never,
  };
  return { d, calls };
}
function tick(rec: Recorder, mint: string, t: number, price: number | null): void {
  rec.database.prepare("INSERT INTO autotrade_ticks (mint, t, role, price_usd, liquidity_usd) VALUES (?, ?, 'held', ?, 40000)").run(mint, t, price);
}
const rows = (rec: Recorder) => rec.database.prepare('SELECT * FROM exit_probes ORDER BY t, mint').all() as Record<string, unknown>[];

test('held coins get one $50 sell quote into SOL per minute, one per poll; candidates are never probed', async () => {
  const c = clock(1_000_000);
  let focus: FocusEntry[] = [{ mint: A, role: 'held' }, { mint: B, role: 'held' }, { mint: C, role: 'candidate' }];
  const rec = new Recorder({ path: ':memory:', clock: c as never, ticks: { focus: () => focus }, exitProbes: {} });
  try {
    tick(rec, A, 999_000, 0.001); tick(rec, B, 999_000, 0.002); tick(rec, C, 999_000, 0.5);
    const { d, calls } = deps();
    const r1 = await rec.probeExits(d);
    assert.deepEqual(r1, { probed: 1, ok: 1, failed: 0, skipped: null });
    const r2 = await rec.probeExits(d);
    assert.equal(r2?.probed, 1, 'the second held coin on the next poll');
    assert.equal((await rec.probeExits(d))?.skipped, 'not-due', 'both probed within the minute');
    assert.deepEqual(calls.map((x) => x.mint).sort(), [A, B]);
    assert.ok(calls.every((x) => x.out === WSOL_MINT));
    assert.equal(calls.find((x) => x.mint === A)!.amount, 50_000_000_000n, '$50 / $0.001 = 50,000 tokens at 6 decimals');
    const w = rows(rec);
    assert.equal(w.length, 2);
    assert.equal(w[0].sol_out, 0.25);
    assert.equal(w[0].price_impact_pct, 1.5);
    assert.equal(w[0].route_hops, 2);
    assert.equal(w[0].usd_in, 50);
    assert.equal(w[0].error, null);
    c.set(1_000_000 + 60_000);
    assert.equal((await rec.probeExits(d))?.probed, 1, 'due again after a minute');
    focus = [{ mint: C, role: 'candidate' }];
    c.set(1_000_000 + 10 * 60_000);
    assert.equal((await rec.probeExits(d))?.skipped, 'no-held');
  } finally { rec.close(); }
});

test('no route is written as an error row (the drain signal); no tick price = no probe; a paused bucket waits', async () => {
  const c = clock(5_000_000);
  const rec = new Recorder({ path: ':memory:', clock: c as never, ticks: { focus: () => [{ mint: A, role: 'held' }, { mint: B, role: 'held' }] }, exitProbes: { policy: { maxPerPoll: 5 } } });
  try {
    tick(rec, A, 4_999_000, 0.001); tick(rec, B, 4_999_000, null);
    assert.equal((await rec.probeExits(deps({ paused: 9_000_000 }).d))?.skipped, 'paused');
    const r = await rec.probeExits(deps({ fail: new Set([A]) }).d);
    assert.deepEqual(r, { probed: 1, ok: 0, failed: 1, skipped: null }, 'B has no priced tick: skipped, not written');
    const w = rows(rec);
    assert.equal(w.length, 1);
    assert.equal(w[0].mint, A);
    assert.equal(w[0].sol_out, null);
    assert.match(String(w[0].error), /no route/);
    // our own limiter / a timeout says nothing about the coin: deferred, never written as an error row
    c.set(5_000_000 + 60_000);
    const slow = deps();
    slow.d.quote = async () => { throw new Error('rate-limit wait aborted'); };
    const r3 = await rec.probeExits(slow.d);
    assert.equal(r3?.deferred, 1);
    assert.equal(r3?.probed, 0);
    assert.equal(rows(rec).length, 1, 'no row for a transient miss');
  } finally { rec.close(); }
});

test('at most maxPerMinute quotes in any minute, all held coins together', async () => {
  const c = clock(9_000_000);
  const many = ['A', 'B', 'C', 'D', 'E', 'F'].map((x) => `${x.repeat(4)}${'x'.repeat(36)}pump`);
  const rec = new Recorder({ path: ':memory:', clock: c as never, ticks: { focus: () => many.map((mint) => ({ mint, role: 'held' as const })) }, exitProbes: { policy: { maxPerPoll: 3 } } });
  try {
    for (const m of many) tick(rec, m, 8_999_000, 0.01);
    const { d, calls } = deps();
    assert.equal((await rec.probeExits(d))?.probed, 3);
    c.set(9_005_000);
    assert.equal((await rec.probeExits(d))?.probed, 1, 'capped at 4 in the minute');
    c.set(9_010_000);
    assert.equal((await rec.probeExits(d))?.skipped, 'minute-cap');
    c.set(9_060_000);
    assert.equal((await rec.probeExits(d))?.probed, 3, 'the window rolls: 3 slots free (the +5 s quote still counts)');
    assert.deepEqual(calls.slice(4, 6).map((x) => x.mint).sort(), many.slice(4).sort(), 'the 2 never probed go first');
    assert.equal(calls.length, 7);
  } finally { rec.close(); }
});

test('off unless configured; exit probes age out with the ticks; an older file gains the table on open', async () => {
  const plain = new Recorder({ path: ':memory:', ticks: { focus: () => [{ mint: A, role: 'held' }] } });
  try { assert.equal(await plain.probeExits(deps().d), null); } finally { plain.close(); }
  const dir = mkdtempSync(join(tmpdir(), 'rec-1786-'));
  try {
    const path = join(dir, 'd.db');
    new Recorder({ path }).close();
    const raw = new DatabaseSync(path);
    raw.exec('DROP TABLE exit_probes');
    raw.close();
    const rec = new Recorder({ path });
    try {
      const has = rec.database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'exit_probes'").get();
      assert.ok(has, 'additive table re-created');
      const day = 86_400_000;
      rec.database.prepare("INSERT INTO exit_probes (mint, t, role, usd_in) VALUES (?, ?, 'held', 50)").run(A, 1);
      rec.database.prepare("INSERT INTO exit_probes (mint, t, role, usd_in) VALUES (?, ?, 'held', 50)").run(A, 20 * day);
      pruneTicksByAge(rec.database, { ticksDays: 14 }, 20 * day);
      assert.equal(rows(rec).length, 1, 'the 20-day-old probe went');
    } finally { rec.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
