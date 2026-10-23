// task-1504 (AUTOTRADE-SPEC §3): the autotrade tick lane and retention under a DB cap. Fixtures only: DexScreener
// tokens/v1 answers are synthesised from one pair of the data layer's offline sample; mints are synthetic; every
// DB is ':memory:' or a temp file. No network (any other URL throws).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, test } from 'node:test';
import { Cache, currentPriority, PaperWallet, WatchlistStore, type DsRawPair, type EnrichedRow, type HttpRequest, type HttpResponse, type Transport } from '@dexterm/data';
import { drive, json, loadSample, sampleLayer } from '../../data/test/helpers.ts';
import { Recorder } from '../src/recorder.ts';
import { candlesFromDb, dbFocus, focusFilePath, mergeFocus, readFocusFile, writeFocusFile, FOCUS_FILE_SCHEMA, FOCUS_FILE_STALE_MS, type FocusEntry } from '../src/ticks.ts';
import { dbSize, enforceCap } from '../src/retention.ts';

const MIN = 60_000;
const H1 = 3_600_000;
const DAY = 86_400_000;
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** A synthetic, valid-looking base58 mint (44 chars). */
const mintN = (i: number): string => `${B58[i % 58]}${B58[Math.floor(i / 58) % 58]}${'x'.repeat(38)}pump`;

let template: DsRawPair;
let rows: EnrichedRow[] = [];
before(async () => {
  for (const e of loadSample().list()) {
    if (!e.url.includes('/tokens/v1/')) continue;
    const list = (Array.isArray(e.body) ? e.body : []) as DsRawPair[];
    if (list.length) { template = list[0]; break; }
  }
  assert.ok(template, 'the sample has a DexScreener tokens/v1 answer');
  const { dl, clock } = sampleLayer();
  const disc = await drive(clock, dl.store.discover('trending', 30));
  rows = (await drive(clock, dl.store.enrich(disc.mints, { price: true }))).rows.filter((r) => r.mint && r.pair);
  dl.close();
  assert.ok(rows.length >= 28);
});

interface Log { urls: string[]; priorities: (string | undefined)[]; batches: string[][] }
/** DexScreener tokens/v1 for any mint list; `price(mint, call)` null = no pair for that mint. Anything else throws. */
function dsSynth(price: (mint: string, call: number) => number | null, log: Log): Transport {
  let call = 0;
  return async (req: HttpRequest): Promise<HttpResponse> => {
    log.urls.push(req.url);
    log.priorities.push(currentPriority()?.level);
    const m = /\/tokens\/v1\/solana\/([^?]+)/.exec(req.url);
    if (!m) throw new Error(`unexpected request ${req.url}`);
    call++;
    const mints = decodeURIComponent(m[1]).split(',');
    log.batches.push(mints);
    const out: DsRawPair[] = [];
    for (const mint of mints) {
      const p = price(mint, call);
      if (p === null) continue;
      out.push({ ...template, baseToken: { ...template.baseToken, address: mint }, priceUsd: String(p), liquidity: { ...template.liquidity, usd: 40_000 }, marketCap: p * 1e9, fdv: p * 1e9 });
    }
    return json(200, out);
  };
}
const newLog = (): Log => ({ urls: [], priorities: [], batches: [] });
/** Settle a poll with 1 ms fake-time steps, so the 5 s / 10 s cadence in the tests stays exact. */
const settle = <T>(clock: { advance(ms: number): Promise<void> }, p: Promise<T>): Promise<T> => drive(clock as never, p, 1);
const count = (rec: Recorder, sql: string, ...args: (string | number)[]): number => Number((rec.database.prepare(sql).get(...args) as { n: number }).n);

test('mergeFocus: one role per mint (held > open > candidate > watch), invalid mints and roles dropped, priority order', () => {
  const a = mintN(1), b = mintN(2), c = mintN(3);
  const out = mergeFocus([
    { mint: a, role: 'watch' }, { mint: b, role: 'candidate' }, { mint: a, role: 'held' }, { mint: c, role: 'open' },
    { mint: 'not-a-mint', role: 'held' }, { mint: b, role: 'bogus' as never }, { mint: b, role: 'watch' },
  ]);
  assert.deepEqual(out, [{ mint: a, role: 'held' }, { mint: c, role: 'open' }, { mint: b, role: 'candidate' }]);
});

test('tick lane: held/open every 5 s, watch/candidate every 10 s, free top-up, 30 per tokens/v1 call, priorities, NULL rows for a vanished pair, sampled 1m candles', async () => {
  const log = newLog();
  const held = mintN(10), watch = mintN(11), gone = mintN(12);
  let p = 1;
  const { dl, clock } = sampleLayer({ transport: dsSynth((m) => (m === gone ? null : p), log) });
  const focus: FocusEntry[] = [{ mint: watch, role: 'watch' }, { mint: held, role: 'held' }, { mint: gone, role: 'candidate' }];
  const rec = new Recorder({ path: ':memory:', clock, ticks: { focus: () => focus } });
  await clock.advance(Math.floor(clock.now() / MIN) * MIN + MIN - clock.now()); // start on a minute boundary
  const t0 = clock.now();
  const r1 = await settle(clock, rec.pollTicks(dl, clock.now()));
  assert.equal(r1.skipped, null);
  assert.equal(r1.calls, 1);
  assert.equal(r1.coins, 3);
  assert.equal(r1.answered, 2, 'no pair came back for one coin');
  assert.equal(r1.written, 3);
  assert.deepEqual(log.priorities, ['normal'], 'a held coin in the call: normal priority');
  // 5 s later only the held coin is due, but the call is topped up with the others for free
  p = 1.2;
  await clock.advance(5_000);
  const r2 = await settle(clock, rec.pollTicks(dl, clock.now()));
  assert.equal(r2.calls, 1);
  assert.equal(r2.coins, 3, 'the batch has room: watch + candidate ride along');
  // nothing due 2 s later
  await clock.advance(2_000);
  assert.equal((await rec.pollTicks(dl, clock.now())).skipped, 'not-due');
  await clock.advance(3_000);
  // the rest of the minute, polling every 5 s
  for (let s = 10; s <= 55; s += 5) {
    p = 1 + (s % 20) / 100; // 1.10, 1.15, 1.00, 1.05, ...
    await settle(clock, rec.pollTicks(dl, clock.now()));
    if (s < 55) await clock.advance(5_000);
  }
  assert.ok(clock.now() < t0 + MIN, 'all inside one minute');
  assert.ok(log.urls.every((u) => /api\.dexscreener\.com\/tokens\/v1\/solana\//.test(u)), 'DexScreener tokens/v1 only; no Jupiter or per-coin call');
  assert.equal(count(rec, 'SELECT COUNT(*) AS n FROM autotrade_ticks WHERE mint = ?', held), 12, 'held: one tick per 5 s');
  const nullRows = rec.database.prepare('SELECT price_usd, role FROM autotrade_ticks WHERE mint = ?').all(gone) as { price_usd: number | null; role: string }[];
  assert.ok(nullRows.length > 0 && nullRows.every((r) => r.price_usd === null && r.role === 'candidate'));
  const role = rec.database.prepare('SELECT DISTINCT role FROM autotrade_ticks WHERE mint = ?').all(held) as { role: string }[];
  assert.deepEqual(role.map((r) => r.role), ['held']);
  // the candle for the first minute: o = first, c = last, h/l = sample extremes, n = samples
  const prices = (rec.database.prepare('SELECT price_usd FROM autotrade_ticks WHERE mint = ? AND t < ? ORDER BY t').all(held, t0 + MIN) as { price_usd: number }[]).map((r) => r.price_usd);
  const [c1] = candlesFromDb(rec.database, held, t0, t0);
  assert.equal(c1.t, t0);
  assert.equal(c1.o, prices[0]);
  assert.equal(c1.c, prices[prices.length - 1]);
  assert.equal(c1.h, Math.max(...prices));
  assert.equal(c1.l, Math.min(...prices));
  assert.equal(c1.n, prices.length);
  assert.equal(c1.liq, 40_000);
  assert.equal(candlesFromDb(rec.database, gone).length, 0, 'no price, no candle');
  const st = rec.stats(clock.now());
  assert.equal(st.ticks, count(rec, 'SELECT COUNT(*) AS n FROM autotrade_ticks'));
  assert.equal(st.candles, 2, 'held + watch, one minute each');
  assert.equal(st.tickCallsToday, log.urls.length);
  dl.close(); rec.close();
});

test('tick lane budget: maxCoins cap (overCap counted), low priority without held/open coins, paused bucket skipped, per-day ceiling survives a restart', async () => {
  const log = newLog();
  const { dl, clock } = sampleLayer({ transport: dsSynth(() => 0.5, log) });
  const focus: FocusEntry[] = Array.from({ length: 70 }, (_, i) => ({ mint: mintN(100 + i), role: 'watch' as const }));
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-1504-'));
  const db = join(dir, 'ticks.db');
  try {
    let rec = new Recorder({ path: db, clock, ticks: { focus: () => focus, policy: { maxCallsPerDay: 3 } } });
    const r1 = await settle(clock, rec.pollTicks(dl, clock.now()));
    assert.equal(r1.calls, 2, '60 coins = two batches of 30');
    assert.equal(r1.coins, 60);
    assert.equal(r1.overCap, 10);
    assert.deepEqual(log.batches.map((b) => b.length), [30, 30]);
    assert.deepEqual(log.priorities, ['low', 'low'], 'watch-only calls queue at low priority');
    // a 429 paused the bucket: wait for the next poll
    await clock.advance(10_000);
    dl.limiter.pause('dexscreener', 5_000);
    assert.equal((await rec.pollTicks(dl, clock.now())).skipped, 'paused');
    await clock.advance(6_000);
    const r2 = await settle(clock, rec.pollTicks(dl, clock.now()));
    assert.equal(r2.calls, 1, 'one call left in the day');
    rec.close();
    // restart: the day's count is read back, so the ceiling holds
    rec = new Recorder({ path: db, clock, ticks: { focus: () => focus, policy: { maxCallsPerDay: 3 } } });
    await clock.advance(10_000);
    assert.equal((await rec.pollTicks(dl, clock.now())).skipped, 'day-cap');
    assert.equal(log.urls.length, 3);
    assert.equal(rec.stats(clock.now()).tickCallsToday, 3);
    rec.close();
    // no lane configured / recorder off: disabled, no request
    const off = new Recorder({ path: ':memory:', clock });
    assert.equal((await off.pollTicks(dl)).skipped, 'disabled');
    off.close();
    const empty = new Recorder({ path: ':memory:', clock, ticks: { focus: () => [] } });
    assert.equal((await empty.pollTicks(dl)).skipped, 'no-focus');
    empty.close();
    assert.equal(log.urls.length, 3);
  } finally {
    dl.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('focus sources: watchlist + paper positions from the DB; the focus file (atomic 0600, stale and expired entries ignored)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-1504-'));
  try {
    const db = join(dir, 'app.db');
    const wl = new WatchlistStore({ path: db });
    wl.add({ mint: mintN(1), symbol: 'AAA', name: 'a', launchpad: 'pump.fun', entryPrice: null });
    const wallet = new PaperWallet({ path: db });
    void wallet;
    const rec = new Recorder({ path: db });
    rec.database.prepare("INSERT INTO paper_positions (mint, symbol, decimals, tokens_raw, cost_lamports, updated_at) VALUES (?, 'BBB', 6, '1000', '5', 0), (?, 'CCC', 6, '0', '5', 0)").run(mintN(2), mintN(3));
    assert.deepEqual(mergeFocus(dbFocus(rec.database)), [{ mint: mintN(2), role: 'held' }, { mint: mintN(1), role: 'watch' }], 'a closed position (0 tokens) is not held');
    assert.deepEqual(dbFocus(new Recorder({ path: ':memory:' }).database), [], 'fresh DB: no tables, no focus');
    rec.close();

    const path = focusFilePath(join(dir, 'home'));
    const now = Date.parse('2026-10-21T00:00:00Z');
    assert.deepEqual(readFocusFile(path, now), [], 'missing file');
    writeFocusFile(path, [{ mint: mintN(4), role: 'candidate', until: now + MIN }, { mint: mintN(5), role: 'held' }, { mint: mintN(6), role: 'open', until: now - 1 }], now);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(readFocusFile(path, now), [{ mint: mintN(5), role: 'held' }, { mint: mintN(4), role: 'candidate' }], 'expired entry dropped');
    assert.deepEqual(readFocusFile(path, now + 2 * MIN), [{ mint: mintN(5), role: 'held' }]);
    assert.deepEqual(readFocusFile(path, now + FOCUS_FILE_STALE_MS + 1), [], 'a stale file (dead writer) pins nothing');
    writeFileSync(path, '{ not json');
    assert.deepEqual(readFocusFile(path, now), []);
    writeFileSync(path, JSON.stringify({ schema: 'other/1', updatedAt: now, entries: [{ mint: mintN(5), role: 'held' }] }));
    assert.deepEqual(readFocusFile(path, now), []);
    writeFileSync(path, JSON.stringify({ schema: FOCUS_FILE_SCHEMA, updatedAt: now, entries: [{ mint: mintN(5), role: 'held' }] }));
    assert.deepEqual(readFocusFile(path, now), [{ mint: mintN(5), role: 'held' }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Rows re-timestamped to `t`, price scaled by `f` (a material change every time it moves ≥ 5 %). */
function at(t: number, f: number): EnrichedRow[] {
  return rows.map((r) => ({
    ...r, token: { ...r.token, fetchedAt: t }, pair: { ...r.pair, fetchedAt: t, priceUsd: r.pair.priceUsd * f, mcap: r.pair.mcap === null ? null : r.pair.mcap * f },
    stats: r.stats ? { ...r.stats, fetchedAt: t } : undefined, audit: r.audit ? { ...r.audit, fetchedAt: t } : undefined,
  }));
}

test('retention under a small cap on a temp DB: the file stays under the cap, observation and ticks never pause, the oldest history goes first, outcomes stay', async () => {
  const log = newLog();
  const { dl, clock } = sampleLayer({ transport: dsSynth(() => 0.25, log) });
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-1504-'));
  const path = join(dir, 'cap.db');
  const CAP = 1_500_000;
  try {
    const focus: FocusEntry[] = rows.slice(0, 20).map((r) => ({ mint: r.mint, role: 'watch' as const }));
    const rec = new Recorder({ path, clock, ticks: { focus: () => focus }, cap: { maxBytes: CAP }, retention: { everyMs: 10 * DAY } });
    rec.database.prepare("INSERT INTO outcomes (mint, t0, horizon_sec, t1, label, label_tier, evidence, labeler_version) VALUES (?, 1, 3600, NULL, 'unobserved', 'keyless-proxy', '{}', 'test')").run(rows[0].mint);
    const start = clock.now();
    let maxFile = 0, evictedPasses = 0;
    for (let i = 0; i < 360; i++) {
      if (i) await clock.advance(2 * MIN);
      const now = clock.now();
      const cap = rec.enforceCap(now);
      if (cap?.evicted) evictedPasses++;
      const obs = rec.observe(at(now, i % 2 ? 1.1 : 1), now);
      assert.equal(obs.written, rows.length, `pass ${i}: every row observed (never paused)`);
      const tk = await settle(clock, rec.pollTicks(dl, clock.now()));
      assert.equal(tk.written, focus.length, `pass ${i}: ticks keep landing`);
      maxFile = Math.max(maxFile, dbSize(rec.database).fileBytes, statSync(path).size);
    }
    const end = clock.now();
    assert.ok(evictedPasses > 0, 'the cap was reached and enforced');
    assert.ok(maxFile <= CAP, `the DB file never passed the cap (max ${maxFile} B vs ${CAP} B)`);
    const oldest = Number((rec.database.prepare('SELECT MIN(t) AS m FROM token_snapshots').get() as { m: number }).m);
    assert.ok(oldest > start + H1, 'the oldest history was evicted');
    assert.ok(count(rec, 'SELECT COUNT(*) AS n FROM token_snapshots WHERE t >= ?', end - H1 + 1) >= 30 * rows.length - rows.length, 'the newest hour is all there');
    assert.ok(count(rec, 'SELECT COUNT(*) AS n FROM autotrade_ticks WHERE t >= ?', end - H1 + 1) >= 29 * focus.length, 'and its ticks');
    assert.equal(count(rec, 'SELECT COUNT(*) AS n FROM outcomes'), 1, 'outcomes are never evicted');
    assert.equal(count(rec, 'SELECT COUNT(*) AS n FROM mints WHERE last_any_t < ?', oldest), 0, 'evicted mints left the sweep summary');
    rec.close();
  } finally {
    dl.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('retention: no cap is a no-op; keepMs is a floor; age rules expire ticks at 14 d and candles at 90 d', () => {
  const rec = new Recorder({ path: ':memory:' });
  const db = rec.database;
  const now = Date.parse('2026-10-21T00:00:00Z');
  const ins = db.prepare("INSERT INTO autotrade_ticks (mint, t, role, price_usd) VALUES (?, ?, 'held', 1)");
  const cdl = db.prepare('INSERT INTO autotrade_candles_1m (mint, t, o, h, l, c, n) VALUES (?, ?, 1, 1, 1, 1, 1)');
  for (const d of [1, 13, 15, 89, 91]) { ins.run(mintN(1), now - d * DAY); cdl.run(mintN(1), now - d * DAY); }
  assert.equal(enforceCap(db, { maxBytes: null }, now).evicted, false);
  const tiny = enforceCap(db, { maxBytes: 1, keepMs: 100 * DAY }, now);
  assert.equal(tiny.evicted, true);
  assert.equal(tiny.slices, 0, 'everything is newer than keepMs: nothing to evict');
  assert.equal(tiny.over, true, 'reported, not hidden');
  const p = rec.prune(now);
  assert.equal(p.ticksExpired, 3, '15, 89 and 91 days old');
  assert.equal(p.candlesExpired, 1, 'only the 91-day candle');
  assert.equal(count(rec, 'SELECT COUNT(*) AS n FROM autotrade_ticks'), 2);
  const q4 = new Recorder({ path: ':memory:', retention: { columnsDays: 14 } });
  q4.database.prepare("INSERT INTO token_snapshots (mint, t, kind, hash, src_market, sources) VALUES (?, ?, 'sweep', 'h', 'none', '[]'), (?, ?, 'live', 'h', 'none', '[]')").run(mintN(2), now - 15 * DAY, mintN(2), now - 13 * DAY);
  assert.equal(q4.prune(now).expired, 1, 'Q4 age option: rows (sweep rows too) older than 14 days go');
  q4.close(); rec.close();
});

test('retention: the reclaim hook (the expired data-layer cache) goes before any history; history is evicted only if that is not enough', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-1504-'));
  try {
    const path = join(dir, 'reclaim.db');
    const cache = new Cache({ path });
    const rec = new Recorder({ path });
    const now = Date.now();
    const blob = 'x'.repeat(4000);
    for (let i = 0; i < 400; i++) cache.set('jup:token', `k${i}`, { blob }, { ttlMs: 60_000, fetchedAt: now - 3 * DAY });
    for (let i = 0; i < 50; i++) cache.set('ds:token', `fresh${i}`, { blob }, { ttlMs: 60_000, fetchedAt: now });
    const ins = rec.database.prepare("INSERT INTO autotrade_ticks (mint, t, role, price_usd) VALUES (?, ?, 'watch', 1)");
    for (let i = 0; i < 2000; i++) ins.run(mintN(i % 50), now - 2 * DAY + i * 1000);
    const used = dbSize(rec.database).usedBytes;
    // a cap the expired cache alone can satisfy: no history goes
    const r1 = enforceCap(rec.database, { maxBytes: used, reclaim: () => cache.prune() }, now);
    assert.equal(r1.reclaimed, 400, 'every entry a day past its TTL, none of the fresh ones');
    assert.equal(r1.slices, 0);
    assert.equal(count(rec, 'SELECT COUNT(*) AS n FROM autotrade_ticks'), 2000, 'no history evicted');
    assert.equal(cache.count(), 50);
    // a cap below what reclaim can free: then the oldest history goes
    const r2 = enforceCap(rec.database, { maxBytes: Math.round(dbSize(rec.database).usedBytes * 0.6), reclaim: () => cache.prune() }, now);
    assert.equal(r2.reclaimed, 0);
    assert.ok(r2.slices > 0 && (r2.deleted.autotrade_ticks ?? 0) > 0);
    assert.equal(cache.count(), 50, 'fresh cache entries are never touched');
    rec.close(); cache.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
