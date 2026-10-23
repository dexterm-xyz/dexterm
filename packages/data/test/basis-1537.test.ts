// task-1537 — @dexterm/data/basis: the price-basis resolver, the formatters, the supply rule and the agent language.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PRICE_BASIS, PRICE_BASIS_ENV, pickBasis, envPriceBasis, fmtCap, fmtUsdPrice, fmtX, knownSupply, resolveBasis,
  fmtLevel, entryExitLine, withMcap, basisLanguage, MCAP_FIELD_HINT, NO_SUPPLY_REASON, PUMP_FUN_SUPPLY,
} from '../src/basis.ts';

test('default basis is mcap; a flag/env override wins for one run, then the config value', () => {
  assert.equal(DEFAULT_PRICE_BASIS, 'mcap');
  assert.equal(pickBasis(undefined), 'mcap');
  assert.equal(pickBasis('nope'), 'mcap');
  assert.equal(pickBasis('price'), 'price');
  assert.equal(pickBasis('mcap', { [PRICE_BASIS_ENV]: 'price' }), 'price');
  assert.equal(pickBasis('price', { [PRICE_BASIS_ENV]: ' MCAP ' }), 'mcap');
  assert.equal(pickBasis('price', { [PRICE_BASIS_ENV]: 'fdv' }), 'price');
  assert.equal(envPriceBasis(null), null);
});

test('fmtCap: K with one decimal, M/B/T with two, trailing zeros dropped, the unit promoted after rounding', () => {
  assert.equal(fmtCap(69_700), '$69.7K');
  assert.equal(fmtCap(264_940), '$264.9K');
  assert.equal(fmtCap(1_200_000), '$1.2M');
  assert.equal(fmtCap(1_234_567), '$1.23M');
  assert.equal(fmtCap(4_500_000_000), '$4.5B');
  assert.equal(fmtCap(950), '$950');
  assert.equal(fmtCap(1000), '$1K');
  assert.equal(fmtCap(999_960), '$1M');
  assert.equal(fmtCap(999_999_999), '$1B');
  assert.equal(fmtCap(0.42), '$0.42');
  assert.equal(fmtCap(-69_700), '-$69.7K');
  assert.equal(fmtCap(null), '—');
  assert.equal(fmtCap(Number.NaN), '—');
});

test('fmtUsdPrice: the usual small-number form with subscript zeros (parity with the TUI fmtPrice: cli price-basis-1537)', () => {
  assert.equal(fmtUsdPrice(0.0000697), '$0.0₄697');
  assert.equal(fmtUsdPrice(0.00265), '$0.00265');
  assert.equal(fmtUsdPrice(0.0123), '$0.0123');
  assert.equal(fmtUsdPrice(1.2345), '$1.234');
  assert.equal(fmtUsdPrice(142.5), '$142.50');
  assert.equal(fmtUsdPrice(98_765.4), '$98,765');
  assert.equal(fmtUsdPrice(null), '—');
});

test('fmtX: multiples between two levels', () => {
  assert.equal(fmtX(69_700, 264_900), '3.8x');
  assert.equal(fmtX(100, 42), '0.42x');
  assert.equal(fmtX(1, 12.4), '12x');
  assert.equal(fmtX(0, 5), null);
  assert.equal(fmtX(null, 5), null);
});

test('knownSupply: explicit, then source mcap ÷ price, then FDV ÷ price, then pump.fun 1B; never guessed', () => {
  assert.deepEqual(knownSupply({ supply: 5e8, via: 'ledger' }), { tokens: 5e8, source: 'recorded supply (ledger)' });
  assert.equal(Math.round(knownSupply({ mcap: 70_000, price: 0.00007 })!.tokens), 1e9);
  assert.equal(knownSupply({ fdv: 2e6, price: 0.002 })?.tokens, 1e9);
  assert.equal(knownSupply({ mint: 'AbcPump111pump' })?.tokens, PUMP_FUN_SUPPLY);
  assert.equal(knownSupply({ launchpad: 'pump.fun' })?.source, 'pump.fun fixed supply');
  // a pump-suffixed mint that a different launchpad reports is not assumed to be pump.fun
  assert.equal(knownSupply({ mint: 'AbcPump111pump', launchpad: 'bonk' }), null);
  assert.equal(knownSupply({ mint: 'So11111111111111111111111111111111111111112' }), null);
  assert.equal(knownSupply({ price: 0.5 }), null);
});

test('resolveBasis: mcap headline when the supply is known; price with the reason when it is not; price basis keeps both', () => {
  const m = resolveBasis('mcap', { price: 0.0000697, mcap: 69_700 });
  assert.equal(m.basis, 'mcap');
  assert.equal(m.text, '$69.7K');
  assert.equal(m.both, '$69.7K mcap ($0.0₄697)');
  assert.equal(m.fallback, null);
  const fromSupply = resolveBasis('mcap', { price: 0.000265, mint: 'Xpump' });
  assert.equal(fromSupply.text, '$265K');
  const none = resolveBasis('mcap', { price: 0.5, mint: 'So11111111111111111111111111111111111111112' });
  assert.equal(none.basis, 'price');
  assert.equal(none.text, '$0.5000');
  assert.equal(none.fallback, NO_SUPPLY_REASON);
  assert.match(none.both, /market cap unknown: no supply recorded, showing price/);
  const p = resolveBasis('price', { price: 0.0000697, mcap: 69_700 });
  assert.equal(p.basis, 'price');
  assert.equal(p.text, '$0.0₄697');
  assert.equal(p.both, '$0.0₄697 (mcap $69.7K)');
  assert.equal(p.fallback, null);
  assert.equal(resolveBasis('mcap', {}).text, '—');
  assert.equal(fmtLevel('mcap', { price: 0.5 }), '$0.5000 (price; supply unknown)');
  assert.equal(fmtLevel('mcap', { price: 0.0000697, mint: 'Xpump' }), '$69.7K');
});

test('entryExitLine: entries and exits read as market caps by default, prices in price basis, same multiple', () => {
  assert.equal(entryExitLine('mcap', { mint: 'Xpump', entry: 0.0000697, exit: 0.0002649 }), 'entered at $69.7K, exited at $264.9K (3.8x)');
  assert.equal(entryExitLine('price', { mint: 'Xpump', entry: 0.0000697, exit: 0.0002649 }), 'entered at $0.0₄697, exited at $0.0₃2649 (3.8x)');
  assert.equal(entryExitLine('mcap', { mint: 'Xpump', entry: 0.0000697, now: 0.00012 }), 'entered at $69.7K, now $120K (1.7x)');
  assert.equal(entryExitLine('mcap', { entry: 0.5, exit: 0.6 }), 'entered at $0.5000, exited at $0.6000 (1.2x) (prices: supply unknown)');
});

test('withMcap: JSON keeps BOTH fields, a cap twin per price key, null when the supply is unknown, never edits a price', () => {
  const row = { price: 0.0000697, entryPrice: 0.00005, mcap: 71_000 };
  const out = withMcap(row, { price: 'mcap', entryPrice: 'entryMcap' }, { mint: 'Xpump' });
  assert.equal(out.price, 0.0000697);
  assert.equal(out.entryPrice, 0.00005);
  assert.equal(out.mcap, 71_000); // a source-reported cap is kept
  assert.equal(Math.round(out.entryMcap as number), 50_000);
  const none = withMcap({ price: 0.5 }, { price: 'mcap' }, {});
  assert.deepEqual(none, { price: 0.5, mcap: null });
});

test('basisLanguage follows the basis at run time; the field hint names mcap twins and the basis', () => {
  const m = basisLanguage('mcap');
  assert.match(m, /PRICE BASIS: MARKET CAP/);
  assert.match(m, /cap at entry and the cap now/);
  assert.match(m, /market-cap levels/);
  assert.match(m, /x-multiples/);
  assert.match(m, /Never invent a supply/);
  assert.doesNotMatch(m, /USD PRICE/);
  const p = basisLanguage('price');
  assert.match(p, /PRICE BASIS: USD PRICE/);
  assert.match(p, /price levels/);
  assert.doesNotMatch(p, /MARKET CAP \(the default/);
  assert.match(MCAP_FIELD_HINT, /mcap/);
  assert.match(MCAP_FIELD_HINT, /basis/);
});
