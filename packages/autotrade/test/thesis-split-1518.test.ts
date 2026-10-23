// task-1518: the thesis-split exit and the mcap-split entry gate read the data layer's market-cap flag. That flag
// compared DexScreener's fresh cap with a Jupiter cap the live runner serves from the cache (enrich jup: 'cache'), so on
// a coin that ran 5x+ since Jupiter's last list read, a pure price move looked like a ">5x source split". A paper run's
// free bag was sold that way at +506% with the detail "market-cap sources 1.0x apart" (the resolved cap of a flagged row
// IS DexScreener's, so the computed ratio is 1.0). Numbers below are that exit's: DexScreener $412K at 0.000412, the
// cached Jupiter record $67.9K at 0.0000696 (fetched 17 s before the entry, never refreshed during the hold).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveMcap, MCAP_AGREE_RATIO, type HttpRequest, type HttpResponse, type Transport } from '@dexterm/data';
import { replayTransport } from '../../data/src/fixtures.ts';
import { drive, loadSample, sampleLayer } from '../../data/test/helpers.ts';
import { monitorTick, splitDetail, SOURCES_AGREE_X } from '../src/monitor.ts';
import { loadPreset } from '../src/strategy.ts';
import { SimBook, simBuy } from '../src/engine.ts';
import type { MarketTick } from '../src/replay.ts';

test('resolveMcap: a stale Jupiter cap on a coin that ran 6x agrees (same supply); a real supply split is still flagged', () => {
  const runner = resolveMcap({ mcap: 412_000, fdv: null }, 67_926, { dexscreener: 0.000412, jupiter: 0.00006961 });
  assert.equal(runner.flagged, false, 'both sources count ~1e9 tokens: not a split');
  assert.equal(runner.basis, 'dexscreener');
  assert.equal(runner.value, 412_000);
  // Without prices (old callers) the rule is the old one, so this pair is flagged exactly as before the fix.
  assert.equal(resolveMcap({ mcap: 412_000, fdv: null }, 67_926).flagged, true);
  // A bridged token: DexScreener counts 1M tokens on Solana, Jupiter 50M: flagged at any price.
  const bridged = resolveMcap({ mcap: 1_000_000, fdv: null }, 50_000_000, { dexscreener: 1, jupiter: 1 });
  assert.deepEqual([bridged.flagged, bridged.value, bridged.basis], [true, 1_000_000, 'dexscreener']);
  // A coin that DUMPED 10x since the Jupiter read: the stale, larger cap is not shown (it is moved to the new price).
  const dumped = resolveMcap({ mcap: 100_000, fdv: null }, 1_000_000, { dexscreener: 0.0001, jupiter: 0.001 });
  assert.deepEqual([dumped.flagged, dumped.value], [false, 100_000]);
  // Jupiter counting a larger supply (within 5x) still wins, at today's price.
  const bigger = resolveMcap({ mcap: 1_000_000, fdv: null }, 4_000_000, { dexscreener: 1, jupiter: 2 });
  assert.deepEqual([bigger.flagged, bigger.basis, bigger.value], [false, 'jupiter', 2_000_000]);
  assert.equal(SOURCES_AGREE_X, MCAP_AGREE_RATIO);
});

test('Store.enrich with the Jupiter record served from the cache: a 6x price move is not flagged as a source split', async () => {
  const fixtures = loadSample();
  let mult = 1;
  const base = replayTransport(fixtures);
  const t: Transport = async (req: HttpRequest): Promise<HttpResponse> => {
    const res = await base(req);
    if (mult === 1 || !req.url.includes('api.dexscreener.com/tokens/v1/')) return res;
    const pairs = JSON.parse(res.body) as { priceUsd?: string; marketCap?: number; fdv?: number }[];
    for (const p of pairs) { if (p.priceUsd) p.priceUsd = String(Number(p.priceUsd) * mult); if (p.marketCap) p.marketCap *= mult; if (p.fdv) p.fdv *= mult; }
    return { ...res, body: JSON.stringify(pairs) };
  };
  const { dl, clock } = sampleLayer({ transport: t });
  const disc = await drive(clock, dl.store.discover('trending', 30));
  const first = await drive(clock, dl.store.enrich(disc.mints));
  const both = first.rows.filter((r) => r.mcap && r.mcap.dexscreener && r.mcap.jupiter && !r.mcap.flagged);
  assert.ok(both.length >= 10, `${both.length} rows with two agreeing sources`);
  await clock.advance(11_000);
  mult = 6;
  // Same mint list as the recording (the replay transport answers recorded URLs only); only `both` is judged.
  const later = await drive(clock, dl.store.enrich(disc.mints, { jup: 'cache' }));
  const judged = later.rows.filter((r) => both.some((b) => b.mint === r.mint));
  assert.equal(judged.length, both.length);
  assert.ok(judged.every((r) => Math.abs(r.mcap!.dexscreener! / both.find((b) => b.mint === r.mint)!.mcap!.dexscreener! - 6) < 0.01), 'DexScreener moved 6x');
  const flagged = judged.filter((r) => r.mcap?.flagged);
  assert.equal(flagged.length, 0, `flagged after a pure price move: ${flagged.map((r) => r.token.symbol).join(', ')}`);
  for (const r of judged) assert.ok(r.mcap!.value! >= r.mcap!.dexscreener! * 0.999, 'the shown cap is never the stale smaller one');
  dl.close();
});

const tick = (o: Partial<MarketTick>): MarketTick => ({
  mint: 'M'.repeat(44), t: 0, kind: 'live', symbol: 'X', launchpad: 'pump.fun', createdAt: 0, price: 0.0001, mcap: 100_000, mcapResolved: 100_000, mcapFlagged: false, liq: 40_000,
  vol5m: 5_000, vol1h: 20_000, vol24: 50_000, buys5m: 50, sells5m: 30, buys24: 500, sells24: 300, chg5m: 3, chg1h: 10, chg6h: null, chg24h: null,
  holders: 500, top10: 10, dev: 1, mintAuth: false, freezeAuth: false, org: null, ...o,
});

test('thesis-split detail names the trigger that fired, never "1.0x apart"', () => {
  const flagged = tick({ mcap: 412_000, mcapResolved: 412_000, mcapFlagged: true });
  assert.equal(splitDetail(flagged, 5), 'the data layer flagged the two market-cap sources: their supplies are more than 5x apart');
  assert.equal(splitDetail(tick({ mcap: 100_000, mcapResolved: 700_000 }), 5), 'market-cap sources 7.0x apart (limit 5x)');
  const s = loadPreset('moonbag');
  const prof = s.exits.profiles.moonbag;
  const book = new SimBook(s, 0);
  const k0 = tick({ t: 1 });
  const f = simBuy(k0, 20, s.execution);
  assert.ok(!('refused' in f));
  const p = book.openPosition(k0, f, prof, null, [], []);
  const acts = monitorTick(p, prof, flagged, { minExitLiquidityUsd: s.execution.minExitLiquidityUsd });
  const sell = acts.find((a) => a.kind === 'sell');
  assert.ok(sell && sell.kind === 'sell' && sell.reason === 'thesis-split');
  assert.doesNotMatch(sell.detail, /1\.0x apart/);
});
