// task-1537 — the autotrade agents and lines speak the price basis: market cap by default, price when the user set it.
// The engine, exits and sizes still read prices; only the text and the ledger's extra `mcap` fields change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPreset } from '../src/strategy.ts';
import { fileURLToPath } from 'node:url';
import { loadTape, type MarketTick } from '../src/replay.ts';
import { renderDossierRecord, renderPositionDossier, runnerSystemPrompt, tapeDossierRecord } from '../src/sessions.ts';
import { renderDossier, renderEvent, systemPrompt } from '../src/session.ts';
import { fillMcaps, levelText, levelsText } from '../src/basis-text.ts';
import { runAutotrade } from '../src/runner.ts';
import type { Position } from '../src/engine.ts';

const T0 = 1_792_000_000_000;
const MIN = 60_000;
function tick(over: Partial<MarketTick> = {}): MarketTick {
  return {
    mint: 'Mint1111111111111111111111111111111111111pump', t: T0, kind: 'live', symbol: 'TEST', launchpad: 'pump.fun', createdAt: T0 - 3 * 3600e3,
    price: 0.0000697, mcap: 69_700, mcapResolved: 69_700, mcapFlagged: false, liq: 100_000, vol5m: 10_000, vol1h: 50_000, vol24: 500_000,
    buys5m: 120, sells5m: 80, buys24: 5000, sells24: 4000, chg5m: 4, chg1h: 20, chg6h: 40, chg24h: 80,
    holders: 900, top10: 20, dev: 1, mintAuth: false, freezeAuth: false, org: 70, ...over,
  };
}
const BOUNDS = { profiles: ['swing'], defaultProfile: 'swing', maxSizePct: 10, sizeMode: 'pct' as const, bankrollUsd: 1000, cashUsd: 1000, openPositions: 0, maxConcurrent: 3 };

test('the runner and replay system prompts carry the basis paragraph (mcap default; price when set)', () => {
  const s = loadPreset('moonbag');
  const m = runnerSystemPrompt(s, { live: true });
  assert.match(m, /PRICE BASIS: MARKET CAP/);
  assert.match(m, /take profit at \$500K, stop at \$40K/);
  assert.match(runnerSystemPrompt(s, { live: true, basis: 'mcap' }), /PRICE BASIS: MARKET CAP/);
  const p = runnerSystemPrompt(s, { live: true, basis: 'price' });
  assert.match(p, /PRICE BASIS: USD PRICE/);
  assert.doesNotMatch(p, /PRICE BASIS: MARKET CAP/);
  assert.match(systemPrompt(s), /PRICE BASIS: MARKET CAP/);
  assert.match(systemPrompt(s, 'price'), /PRICE BASIS: USD PRICE/);
});

test('the candidate DOSSIER leads with the cap and reads history as caps by default; price basis is unchanged', () => {
  const k = tick();
  const hist = [tick({ t: T0 - 2 * MIN, price: 0.00005 }), tick({ t: T0 - MIN, price: 0.00006 })];
  const m = renderDossierRecord(tapeDossierRecord(k), { mint: k.mint, symbol: k.symbol, matched: ['x'] }, k, hist, BOUNDS);
  assert.match(m, /\nnow: \$69\.7K mcap · price 0\.0000697 · liq/);
  assert.match(m, /history \(oldest→newest, caps at the current supply\): \$50K@\$100\.0K {2}\$60K@\$100\.0K/);
  const p = renderDossierRecord(tapeDossierRecord(k), { mint: k.mint, symbol: k.symbol, matched: ['x'] }, k, hist, BOUNDS, 'price');
  assert.match(p, /\nnow: price 0\.0000697 · liq/);
  assert.match(p, /history \(oldest→newest\): 0\.00005@\$100\.0K {2}0\.00006@\$100\.0K/);
  // a coin with no known supply (no cap, not pump.fun) says so instead of inventing one
  const u = tick({ mint: 'So11111111111111111111111111111111111111112', launchpad: 'unknown' as MarketTick['launchpad'], mcap: null, mcapResolved: null });
  assert.match(renderDossierRecord(tapeDossierRecord(u), { mint: u.mint, symbol: 'U', matched: [] }, u, [], BOUNDS), /now: \$0\.0₄697 \(price; supply unknown\) · price/);
  // the legacy replay dossier follows the same rule
  const legacy = { candidate: { mint: k.mint, symbol: 'TEST', matched: ['x'] }, market: { price: 0.0000697, mcap: 69_700, liq: 1, vol5m: 1, vol1h: 1, buys5m: 1, sells5m: 1, chg5m: 1, chg1h: 1, holders: 1, top10: 1, ageMin: 1 }, history: [{ price: 0.00005, liq: 1 }], bounds: BOUNDS, unavailable: [] };
  assert.match(renderDossier(legacy as never), /now: \$69\.7K mcap/);
  assert.match(renderDossier(legacy as never, 'price'), /now: price 0\.0000697/);
});

test('POSITION DOSSIER and EVENT name the entry cap, the cap now and the multiple by default', () => {
  const k = tick({ price: 0.0002649, mcap: 264_900, mcapResolved: 264_900 });
  const pd = renderPositionDossier({ symbol: 'TEST', mint: k.mint, profile: 'swing', costUsd: 50, entryPrice: 0.0000697, tpFilled: 0, leftPct: 100, costRecovered: false, history: [k], tick: k });
  assert.match(pd, /entry \$69\.7K mcap, now \$264\.9K mcap \(3\.8x\)/);
  assert.match(pd, /ticks since entry \(≤ 40, oldest→newest, caps at the current supply\): \$264\.9K/);
  const pp = renderPositionDossier({ symbol: 'TEST', mint: k.mint, profile: 'swing', costUsd: 50, entryPrice: 0.0000697, tpFilled: 0, leftPct: 100, costRecovered: false, history: [k], tick: k, basis: 'price' });
  assert.match(pp, /entry 0\.0000697, now 0\.0002649 \(3\.8x\)/);
  const p = { id: 'P1', profileId: 'swing', costUsd: 50, entryPrice: 0.0000697, tpFilled: 0, tokens: 1, origTokens: 1 } as Position;
  const ev = { event: 'review', detail: 'x', allowed: ['hold'] } as never;
  assert.match(renderEvent(ev, p, k), /on the mid price \(entry \$69\.7K mcap, now \$264\.9K mcap, 3\.8x\)/);
  assert.doesNotMatch(renderEvent(ev, p, k, 'price'), /mcap/);
});

test('levels and the ledger fill JSON: both price and mcap fields, mcap null when the supply is unknown', () => {
  const k = tick();
  assert.equal(levelText('mcap', 0.0000697, k), '$69.7K mcap');
  assert.equal(levelText('price', 0.0000697, k), '0.0000697');
  assert.equal(levelsText('mcap', [0.00005, null], k), '$50K —');
  const f = fillMcaps({ side: 'buy', usd: 10, price: 0.0000697, avgPrice: 0.00005 }, k);
  assert.equal(f.price, 0.0000697);
  assert.equal(Math.round(f.mcap!), 69_700);
  assert.equal(Math.round(f.avgMcap!), 50_000);
  const none = fillMcaps({ price: 0.5, avgPrice: 0.5 }, { mint: 'So11111111111111111111111111111111111111112', price: 0.5, mcap: null });
  assert.equal(none.mcap, null);
  assert.equal(none.price, 0.5);
});

test('a paper run on a tape: BUY/SELL lines read as market caps by default, prices with basis price; the ledger has both', async () => {
  const s = loadPreset('scalp');
  const tape = loadTape(fileURLToPath(new URL('./fixtures/autotrade-1498-tape.json', import.meta.url)));
  const run = async (basis?: 'mcap' | 'price') => {
    const lines: string[] = [];
    const res = await runAutotrade({ strategy: s, basis, tape, sessions: null, onLine: (l) => lines.push(l) });
    return { lines, res };
  };
  const m = await run();
  const buy = m.lines.find((l) => l.startsWith('BUY '));
  assert.ok(buy, `the tape opened a position: ${m.lines.slice(0, 4).join(' | ')}`);
  assert.match(buy!, / at \$[\d.]+[KMB] mcap/);
  const sell = m.lines.find((l) => l.startsWith('SELL '));
  if (sell) assert.match(sell, / at \$[\d.]+[KMB] mcap/);
  const fill = m.res.ledger.events.find((e) => e.kind === 'fill')!;
  assert.equal(typeof fill.price, 'number');
  assert.equal(typeof fill.mcap, 'number');
  assert.ok('avgMcap' in fill);
  const p = await run('price');
  const pbuy = p.lines.find((l) => l.startsWith('BUY '))!;
  assert.doesNotMatch(pbuy, /mcap/);
  assert.match(pbuy, / at \d/);
  // the same trades either way: the basis is wording only
  assert.equal(p.res.trades.length, m.res.trades.length);
  assert.deepEqual(p.res.trades.map((t) => t.pnlUsd), m.res.trades.map((t) => t.pnlUsd));
});
