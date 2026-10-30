// task-1818: fixture replay test. A small recorder DB (the recorder's own schema) replayed through replayRecorder:
// point-in-time capture (the afterCoins hook never sees a row after the interval start), stable ids across a full
// replay and a live-style 26 h rebuild, and RecorderNarratives' incremental refresh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL } from '@dexterm/recorder';
import { replayRecorder, trackerFromRecorder, RecorderNarratives, NarrativeTracker } from '../src/index.ts';

const M = 60_000, H = 3_600_000;
const T0 = Date.UTC(2026, 9, 25, 0, 0, 0);

function fixture(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA_SQL);
  const ins = db.prepare(`INSERT INTO token_snapshots (mint, t, kind, hash, symbol, name, price_usd, liquidity_usd, vol_m5, vol_h1, vol_h6, vol_h24, num_traders_h1, src_market, sources)
    VALUES (?, ?, 'live', ?, ?, ?, ?, 30000, ?, ?, ?, ?, ?, 'dexscreener', '[]')`);
  // a frog meme that spawns a copy every 20 min from hour 1 to hour 4, its volume growing, plus two unrelated coins
  const coins: Array<[string, number, string, string]> = [['bg1', 0, 'BTCW', 'Bitcoin Wrapped'], ['bg2', 0, 'USDX', 'Dollar Stable']];
  for (let i = 0; i < 10; i++) coins.push([`frog${i}`, H + i * 20 * M, i % 2 ? 'FROGGO' : 'BABYFROGGO', i % 2 ? `Froggo ${i}` : 'Baby Froggo']);
  let k = 0;
  for (const [mint, first, sym, name] of coins) {
    for (let t = T0 + first; t <= T0 + 8 * H; t += 10 * M) {
      const h = (t - T0) / H;
      const vol = mint.startsWith('bg') ? 50_000 : 2_000 * Math.min(h, 4) ** 2;
      ins.run(mint, t, `h${k++}`, sym, name, 1 + h / 10, vol / 12, vol, vol * 3, vol * 6, 50 + Math.round(10 * h));
    }
  }
  return db;
}

test('replay: point-in-time capture, one narrative for the copy-cats, lifecycle on the way', async () => {
  const db = fixture();
  const seen: Array<{ t: number; lastTick: number | null; maxSampleT: number }> = [];
  const tr = await replayRecorder(db, { from: T0 - M, to: T0 + 8 * H, tickMs: 5 * M }, {
    afterCoins(t, _end, tracker) {
      let maxT = 0; for (const c of tracker.coins.values()) if (c.last) maxT = Math.max(maxT, c.last.t);
      seen.push({ t, lastTick: tracker.lastTickAt, maxSampleT: maxT });
    },
  });
  for (const s of seen) {
    assert.ok(s.maxSampleT <= s.t, `no sample after the interval start (${s.maxSampleT} > ${s.t})`);
    if (s.lastTick != null) assert.ok(s.lastTick <= s.t, 'metrics are as of the previous tick');
  }
  const frog = tr.narrativeOf('frog9')!;
  assert.equal(frog.members, 10, 'every BABY FROGGO / FROGGO n joined one narrative');
  assert.equal(frog.spawn, 10);
  assert.notEqual(tr.narrativeOf('bg1')!.narrative, frog.narrative);
  const d = tr.detail(frog.narrative)!;
  assert.ok(['ignition', 'peak', 'fading'].includes(d.lifecycle), d.lifecycle);
});

test('replay: ids are stable between a full replay and a 26 h rebuild when the seed is inside the window; incremental refresh keeps them', async () => {
  const db = fixture();
  const full = await replayRecorder(db, { from: T0 - M, to: T0 + 6 * H, tickMs: 5 * M });
  const live = await trackerFromRecorder(db, { now: T0 + 6 * H });
  assert.equal(live.narrativeOf('frog3')!.narrative, full.narrativeOf('frog3')!.narrative);
  const svc = new RecorderNarratives(db, { minRefreshMs: 0, lookbackMs: 26 * H });
  const a = await svc.refresh(T0 + 5 * H);
  const id = a.narrativeOf('frog0')!.narrative;
  const b = await svc.refresh(T0 + 8 * H);
  assert.equal(b, a, 'same tracker object, replayed forward');
  assert.equal(b.narrativeOf('frog0')!.narrative, id);
  assert.equal(b.narrativeOf('frog9')!.members, 10);
  assert.ok(b.lastTickAt! >= T0 + 8 * H - 5 * M);
  assert.ok(new NarrativeTracker().top().length === 0);
});
