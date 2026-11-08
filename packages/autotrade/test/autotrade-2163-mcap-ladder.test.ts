// task-2163: market-cap take-profit steps (`tpLadder[].atMcapUsd`), up to 10 per ladder.
// Paper only, synthetic ticks, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { builtinProfiles, loadPreset, presetPath, validateStrategy, type ExitProfile } from '../src/strategy.ts';
import { SimBook, simBuy, simSell } from '../src/engine.ts';
import { monitorTick } from '../src/monitor.ts';
import { exitPlanLine } from '../src/runner.ts';
import type { MarketTick } from '../src/replay.ts';

const T0 = 1_792_000_000_000;
const MIN = 60_000;
const M = 'Cap1111111111111111111111111111111111111111';
const RUNGS = [[40e3, 0.35], [100e3, 0.15], [150e3, 0.1], [250e3, 0.08], [500e3, 0.06], [800e3, 0.05], [1.2e6, 0.04], [1.5e6, 0.04], [2.2e6, 0.03]];

function tick(over: Partial<MarketTick> = {}): MarketTick {
  return {
    mint: M, t: T0, kind: 'live', symbol: 'CAP', launchpad: 'pump.fun', createdAt: T0 - 30 * MIN,
    price: 1, mcap: 15_000, mcapResolved: 15_000, mcapFlagged: false, liq: 1_000_000, vol5m: 8_000, vol1h: 30_000, vol24: 30_000,
    buys5m: 140, sells5m: 90, buys24: 900, sells24: 600, chg5m: 5, chg1h: 40, chg6h: 40, chg24h: 40,
    holders: 400, top10: 22, dev: 2, mintAuth: false, freezeAuth: false, org: 60, ...over,
  };
}

function capProfile(): ExitProfile {
  const p = JSON.parse(JSON.stringify(builtinProfiles().moonbag)) as ExitProfile;
  p.id = 'cap-ladder';
  p.costRecovery = null; p.bagTrail = null; p.timeStop = null; p.maxHoldMinutes = null;
  p.tpLadder = RUNGS.map(([atMcapUsd, sellFrac]) => ({ atMcapUsd, sellFrac }));
  return p;
}

function withProfile(mut: (p: Record<string, any>) => void) {
  const raw = JSON.parse(readFileSync(presetPath('moonbag'), 'utf8'));
  const p = JSON.parse(JSON.stringify(capProfile()));
  mut(p);
  raw.exits.profiles = [p]; raw.exits.default = p.id;
  return validateStrategy(raw);
}
const errs = (r: ReturnType<typeof validateStrategy>) => (!r.ok ? r.errors.map((e) => `${e.path}: ${e.msg}`).join('\n') : '');

test('2163 validation: a 9-step market-cap ladder is valid; one kind per ladder, ascending, exactly one key per step', () => {
  const ok = withProfile(() => {});
  assert.ok(ok.ok, errs(ok));
  assert.equal(ok.ok && ok.strategy.exits.profiles['cap-ladder'].tpLadder.length, 9);
  assert.match(errs(withProfile((p) => { p.tpLadder[3] = { atPct: 500, sellFrac: 0.08 }; })), /one kind per ladder/);
  assert.match(errs(withProfile((p) => { p.tpLadder[0].atPct = 100; })), /exactly one of atPct or atMcapUsd/);
  assert.match(errs(withProfile((p) => { delete p.tpLadder[0].atMcapUsd; })), /exactly one of atPct or atMcapUsd/);
  assert.match(errs(withProfile((p) => { p.tpLadder[2].atMcapUsd = 90e3; })), /atMcapUsd must be strictly ascending/);
  assert.equal(withProfile((p) => { p.tpLadder.push({ atMcapUsd: 3e6, sellFrac: 0.01 }, { atMcapUsd: 4e6, sellFrac: 0.01 }); }).ok, false); // 11 steps
  // percent ladders keep their old limit of 6 steps
  assert.match(errs(withProfile((p) => { p.tpLadder = [50, 100, 150, 200, 250, 300, 350].map((atPct) => ({ atPct, sellFrac: 0.1 })); })), /at most 6 atPct steps/);
});

test('2163 monitor: a rung fires when price x the supply read at entry reaches it, several on one gap; stale tick caps are ignored', () => {
  const s = loadPreset('moonbag');
  const book = new SimBook(s, T0);
  const prof = capProfile();
  const k0 = tick();
  const f = simBuy(k0, 20, s.execution);
  assert.ok(!('refused' in f));
  const p = book.openPosition(k0, f, prof, null, ['trigger:screen'], []);
  assert.equal(p.capSupply, 15_000);
  const o = { minExitLiquidityUsd: s.execution.minExitLiquidityUsd };
  const sells = (k: MarketTick) => monitorTick(p, prof, k, o).filter((a) => a.kind === 'sell') as { tokens: number; reason: string; detail: string }[];
  const apply = (k: MarketTick, xs: { tokens: number; reason: string }[]) => { for (const a of xs) { const r = simSell(k, Math.min(a.tokens, p.tokens), s.execution, a.reason); if (!('refused' in r)) book.sell(p, r); } };

  // 39.0K: below the first rung (the tick's own cap is stale at 15K and must not matter)
  let k = tick({ t: T0 + MIN, price: 2.6 });
  assert.deepEqual(sells(k), []);
  // 40.5K: rung 1 sells 35% of the original size
  k = tick({ t: T0 + 2 * MIN, price: 2.7 });
  let xs = sells(k);
  assert.deepEqual(xs.map((a) => a.reason), ['tp1']);
  assert.ok(Math.abs(xs[0].tokens - p.origTokens * 0.35) < 1e-6);
  assert.match(xs[0].detail, /\$40\.5K mcap ≥ \$40K/);
  apply(k, xs);
  // a gap to 165K fills rungs 2 and 3 on one tick
  k = tick({ t: T0 + 3 * MIN, price: 11 });
  xs = sells(k);
  assert.deepEqual(xs.map((a) => a.reason), ['tp2', 'tp3']);
  apply(k, xs);
  assert.equal(p.tpFilled, 3);
  // all nine rungs: 90% sold, the 10% moonbag is left open
  k = tick({ t: T0 + 4 * MIN, price: 200 });
  xs = sells(k);
  assert.equal(xs.length, 6);
  apply(k, xs);
  assert.equal(p.tpFilled, 9);
  assert.equal(p.status, 'open');
  assert.ok(Math.abs(p.tokens / p.origTokens - 0.1) < 1e-6, `left ${p.tokens / p.origTokens}`);
});

test('2163 monitor: a restored position without a supply falls back to the tick cap; a percent ladder is unchanged', () => {
  const s = loadPreset('moonbag');
  const book = new SimBook(s, T0);
  const prof = capProfile();
  const k0 = tick();
  const f = simBuy(k0, 20, s.execution);
  assert.ok(!('refused' in f));
  const p = book.openPosition(k0, f, prof, null, ['resumed'], []);
  delete p.capSupply;
  const o = { minExitLiquidityUsd: s.execution.minExitLiquidityUsd };
  // price says 45K, the tick's cap says 39K: the tick cap decides
  assert.deepEqual(monitorTick(p, prof, tick({ t: T0 + MIN, price: 3, mcap: 39_000, mcapResolved: 39_000 }), o).filter((a) => a.kind === 'sell'), []);
  assert.deepEqual(monitorTick(p, prof, tick({ t: T0 + 2 * MIN, price: 3, mcap: 41_000, mcapResolved: null }), o).filter((a) => a.kind === 'sell').map((a) => (a as { reason: string }).reason), ['tp1']);
  // no cap anywhere at entry: capSupply is null and a cap step cannot fire without a tick cap
  const q = book.openPosition(tick({ mint: 'Nocap11111111111111111111111111111111111111', mcap: null, mcapResolved: null }), f, prof, null, [], []);
  assert.equal(q.capSupply, null);
  assert.deepEqual(monitorTick(q, prof, tick({ mint: q.mint, t: T0 + MIN, price: 1000, mcap: null, mcapResolved: null }), o).filter((a) => a.kind === 'sell'), []);
  assert.match(exitPlanLine(prof), /take profit \$40K mcap, \$100K mcap, .*\$2\.2M mcap/);
});
