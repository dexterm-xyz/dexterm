// task-1498 addendum: the moonbag preset and exit profile 1.2.0 (cost recovery, bag trail, free bags).
// Paper only, synthetic ticks, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { builtinProfiles, loadPreset, presetPath, validateStrategy } from '../src/strategy.ts';
import { SimBook, clampEntry, simBuy, simSell } from '../src/engine.ts';
import { monitorTick, type MonitorAction } from '../src/monitor.ts';
import { backtest } from '../src/backtest.ts';
import type { MarketTick } from '../src/replay.ts';

const T0 = 1_792_000_000_000;
const MIN = 60_000;
const M = 'Moon111111111111111111111111111111111111111';

function tick(over: Partial<MarketTick> = {}): MarketTick {
  return {
    mint: M, t: T0, kind: 'live', symbol: 'MOON', launchpad: 'pump.fun', createdAt: T0 - 30 * MIN,
    price: 1, mcap: 4e5, mcapResolved: 4e5, mcapFlagged: false, liq: 40_000, vol5m: 8_000, vol1h: 30_000, vol24: 30_000,
    buys5m: 140, sells5m: 90, buys24: 900, sells24: 600, chg5m: 5, chg1h: 40, chg6h: 40, chg24h: 40,
    holders: 400, top10: 22, dev: 2, mintAuth: false, freezeAuth: false, org: 60, ...over,
  };
}

function bag() {
  const s = loadPreset('moonbag');
  const book = new SimBook(s, T0);
  const k = tick();
  const f = simBuy(k, 20, s.execution);
  assert.ok(!('refused' in f));
  const prof = s.exits.profiles.moonbag;
  const p = book.openPosition(k, f, prof, 's1', ['trigger:momentum'], []);
  const o = (at: MarketTick) => ({ minExitLiquidityUsd: s.execution.minExitLiquidityUsd, sellUsd: (tok: number) => { const r = simSell(at, tok, s.execution, 'estimate'); return 'refused' in r ? 0 : r.usd; } });
  // Apply the monitor's sells to the book, the way the runner does.
  const step = (at: MarketTick): MonitorAction[] => {
    const acts = monitorTick(p, prof, at, o(at));
    for (const a of acts) if (a.kind === 'sell' && p.status === 'open') { const r = simSell(at, Math.min(a.tokens, p.tokens), s.execution, a.reason); if (!('refused' in r)) book.sell(p, r); }
    return acts;
  };
  return { s, book, p, prof, step };
}

test('1498 moonbag: the preset validates as paper; exit profile 1.2.0 cross-field rules', () => {
  const raw = JSON.parse(readFileSync(presetPath('moonbag'), 'utf8'));
  const r = validateStrategy(raw);
  assert.ok(r.ok, !r.ok ? JSON.stringify(r.errors) : '');
  assert.equal(r.strategy.mode, 'paper');
  const p = builtinProfiles().moonbag;
  assert.equal(p.version, '1.2.0');
  assert.equal(p.hardStop.enabled, false);
  assert.equal(p.trailingStop, null);
  assert.deepEqual(p.costRecovery, { atPct: 100, maxSellFrac: 0.6 });
  const bad = (mut: (d: Record<string, any>) => void) => { const d = JSON.parse(JSON.stringify(raw)); d.exits.profiles = [JSON.parse(JSON.stringify(p))]; mut(d.exits.profiles[0]); const v = validateStrategy(d); assert.equal(v.ok, false); return !v.ok ? v.errors.map((e) => `${e.path}: ${e.msg}`).join('\n') : ''; };
  assert.match(bad((x) => { x.costRecovery = null; }), /bag trail is armed by the cost-recovery sell/);
  assert.match(bad((x) => { x.tpLadder = [{ atPct: 50, sellFrac: 0.2 }]; }), /above costRecovery.atPct/);
  // (the profile sits in a oneOf, so a range error is reported on the profile, not the field)
  assert.match(bad((x) => { x.bagTrail.trailPct = 95; }), /above 90/);
  assert.match(bad((x) => { x.costRecovery.maxSellFrac = 1; }), /above 0\.9/);
});

test('1498 moonbag: no hard stop before the cost comes back: a -60% dip only wakes; no trail is armed yet', () => {
  const { p, step } = bag();
  const a = step(tick({ t: T0 + 5 * MIN, price: 0.4 }));
  assert.ok(!a.some((x) => x.kind === 'sell'), 'nothing sells on a dip');
  assert.ok(a.some((x) => x.kind === 'wake' && x.wake.event === 'drawdown'));
  assert.equal(p.costRecovered, undefined);
});

test('1498 moonbag: at 2x it sells exactly the slice that pays the cost back, then the rest is a free bag', () => {
  const { p, step } = bag();
  const cost = p.costUsd;
  const before = p.tokens;
  const a = step(tick({ t: T0 + 20 * MIN, price: 2.1 }));
  const sell = a.find((x) => x.kind === 'sell');
  assert.ok(sell && sell.kind === 'sell' && sell.reason === 'cost-recovery' && !sell.all);
  assert.ok(p.costRecovered);
  assert.ok(p.realizedUsd >= cost - 1e-6, `proceeds ${p.realizedUsd} cover the cost ${cost}`);
  assert.ok(p.realizedUsd < cost * 1.01, `and not much more: ${p.realizedUsd}`);
  const frac = 1 - p.tokens / before;
  assert.ok(frac > 0.45 && frac < 0.6, `about half the bag at 2.1x after costs: ${frac}`);
  assert.ok(a.some((x) => x.kind === 'wake' && x.wake.event === 'cost_recovered'));
  // Fires once.
  assert.ok(!step(tick({ t: T0 + 22 * MIN, price: 2.3 })).some((x) => x.kind === 'sell'));
});

test('1498 moonbag: when the cost cannot come back within maxSellFrac, it sells maxSellFrac and keeps the rest', () => {
  const { p, prof, step } = bag();
  prof.costRecovery = { atPct: 10, maxSellFrac: 0.6 }; // at +15% paying back the cost would take ~90% of the bag
  const before = p.tokens;
  step(tick({ t: T0 + 20 * MIN, price: 1.15 }));
  assert.ok(p.costRecovered);
  assert.ok(Math.abs(p.tokens - before * 0.4) / before < 1e-9, `kept 40%: ${p.tokens / before}`);
});

test('1498 moonbag: the bag trail rides out a 50% pullback, exits at 55% off the peak; a tightened bag trail is honoured', () => {
  const { p, step } = bag();
  step(tick({ t: T0 + 20 * MIN, price: 2.1 }));
  step(tick({ t: T0 + 40 * MIN, price: 8 }));
  assert.ok(!step(tick({ t: T0 + 60 * MIN, price: 4.2 })).some((x) => x.kind === 'sell'), '-47.5% off the peak: hold');
  const out = step(tick({ t: T0 + 80 * MIN, price: 3.5 }));
  const s = out.find((x) => x.kind === 'sell');
  assert.ok(s && s.kind === 'sell' && s.reason === 'bag-trail' && s.all);
  assert.equal(p.status, 'closed');

  const b = bag();
  b.step(tick({ t: T0 + 20 * MIN, price: 2.1 }));
  b.step(tick({ t: T0 + 40 * MIN, price: 8 }));
  b.p.bagTrailPct = 28; // what an agent `tighten` sets on a free bag (55 → 28)
  const t = b.step(tick({ t: T0 + 50 * MIN, price: 5.6 }));
  assert.ok(t.some((x) => x.kind === 'sell' && x.reason === 'bag-trail'), '30% off the peak exits a tightened bag');
});

test('1498 moonbag: bagTrail.armAtPct keeps a free bag through the post-recovery dump until the higher peak', () => {
  const { p, prof, step } = bag();
  prof.bagTrail = { trailPct: 55, armAtPct: 300 };
  step(tick({ t: T0 + 20 * MIN, price: 2.1 }));
  assert.ok(!step(tick({ t: T0 + 40 * MIN, price: 0.8 })).some((x) => x.kind === 'sell'), 'peak +110% < +300%: not armed');
  step(tick({ t: T0 + 60 * MIN, price: 4.5 }));
  assert.ok(step(tick({ t: T0 + 80 * MIN, price: 2 })).some((x) => x.kind === 'sell' && x.reason === 'bag-trail'));
  assert.equal(p.status, 'closed');
});

test('1498 moonbag: free bags stop counting toward maxConcurrent, up to maxBags', () => {
  const s = loadPreset('moonbag'); // maxConcurrent 3, recoveredBags {countAsOpen: false, maxBags: 6}
  const book = new SimBook(s, T0);
  const open = (i: number) => {
    const k = tick({ mint: String.fromCharCode(65 + i).repeat(44) });
    const r = clampEntry(book, k, {});
    assert.ok(r.ok, `entry ${i}: ${!r.ok ? r.refused : ''}`);
    const f = simBuy(k, r.usd, s.execution);
    assert.ok(!('refused' in f));
    return book.openPosition(k, f, s.exits.profiles.moonbag, null, [], []);
  };
  const ps = [0, 1, 2].map(open);
  assert.equal((clampEntry(book, tick({ mint: 'Z'.repeat(44) }), {}) as { refused: string }).refused, 'max-concurrent');
  ps[0].costRecovered = true;
  open(3);
  const strict = loadPreset('moonbag');
  strict.risk.recoveredBags = { countAsOpen: true, maxBags: 6 };
  const b2 = new SimBook(strict, T0);
  for (const [m, p] of book.open) b2.open.set(m, p);
  assert.equal((clampEntry(b2, tick({ mint: 'Y'.repeat(44) }), {}) as { refused: string }).refused, 'max-concurrent', 'countAsOpen: true keeps today\'s rule');
});

test('1498 moonbag: the backtest report carries the rug-adjusted tail (rugs, cost recovered, net without the best trade)', async () => {
  const s = loadPreset('moonbag');
  s.entry.decide = 'auto';
  const run = (mint: string, path: [number, number, number][]) => path.map(([m, price, liq]) => tick({ mint, t: T0 + m * MIN, price, liq, createdAt: T0 - 20 * MIN }));
  const winner = run('W'.repeat(44), [[0, 1, 40e3], [1, 1, 40e3], [6, 2.2, 60e3], [12, 6, 90e3], [18, 2.5, 80e3]]);
  const rug = run('R'.repeat(44), [[0, 1, 40e3], [1, 1, 40e3], [6, 0.01, 300], [8, 0.01, 300]]);
  const ticks = [...winner, ...rug].sort((a, b) => a.t - b.t || (a.mint < b.mint ? -1 : 1));
  const { report } = await backtest(s, { source: 'synthetic', ticks, mints: ['W'.repeat(44), 'R'.repeat(44)] });
  assert.equal(report.trades, 2);
  assert.equal(report.tail.costRecovered, 1);
  assert.equal(report.tail.rugs, 1);
  assert.ok(report.tail.bestMultiple! > 1.5, `best ${report.tail.bestMultiple}`);
  assert.ok(report.tail.netWithoutBestUsd < 0, 'without the winner the book is down');
});
