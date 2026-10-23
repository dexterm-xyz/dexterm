// task-1518 PNL CARDS IN MARKET CAP: ENTRY / EXIT as the coin's market cap (fill price × supply) when the supply is
// known, the SOL price view still one option away. Every cap is derived from the fills; the card names the supply
// source and the USD conversion; exit is the blended average of every sell and the last sell is its own row.
// Offline: fixture fills only (made-up tickers and addresses), no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeCard, renderCard, cardPixels, cardPng, cardText, mcapView, cardSupply, autotradeCardInput, fmtMcap, provenance,
  PUMP_FUN_SUPPLY, type CardInput, type AutotradeFillEvent,
} from '../src/pnl-card.ts';
import { pnlKey, type PnlUi } from '../src/pnl-app.ts';
import { canvasText } from '../src/export.ts';
import { NOW, MIN, HOUR, profitInput, lossInput, longHoldInput } from './fixtures/pnl-1407.ts';

const near = (a: number | null, b: number, eps = 1e-6) => assert.ok(a !== null && Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} ≈ ${b}`);
const PUMP = { tokens: PUMP_FUN_SUPPLY, source: 'pump.fun fixed supply' };
const USD = { usd: 150, source: '$150.00/SOL now (display conversion)' };
const withMcap = (i: CardInput, usd: CardInput['usdPerSol'] = USD): CardInput => ({ ...i, supply: PUMP, usdPerSol: usd });

test('basis: market cap by default when the supply is known, the SOL price view otherwise; price stays byte-identical', () => {
  const plain = computeCard(profitInput(), NOW), sup = computeCard(withMcap(profitInput()), NOW);
  assert.equal(mcapView(plain).basis, 'price');
  assert.equal(mcapView(sup).basis, 'mcap');
  assert.equal(mcapView(sup, { basis: 'price' }).basis, 'price');
  // price basis (asked for, or the no-supply default) draws exactly the pre-task-1518 card: same PNG bytes, same text
  for (const aspect of ['wide', 'square'] as const) {
    assert.ok(cardPng(sup, { aspect, basis: 'price' }).equals(cardPng(plain, { aspect })), `${aspect}: price basis PNG unchanged`);
  }
  assert.equal(cardText(sup, { basis: 'price' }), cardText(plain));
  assert.match(cardText(plain), /entry avg [\d.₀-₉]+ SOL · exit avg/);
  assert.doesNotMatch(cardText(plain), /mcap/);
});

test('mcap rows: entry = avg fill × supply, exit = blended over all sells, the last sell its own labelled row', () => {
  const s = computeCard(withMcap(profitInput()), NOW);
  const v = mcapView(s);
  assert.equal(v.unit, 'USD');
  // fixture: 0.8 SOL + 2 sim fees for 3M tokens; sells 0.62 / 0.71 SOL less fees for 1.5M each
  const fee = 5000 / 1e9;
  near(v.entry, ((0.5 + fee) + (0.3 + fee)) / 3_000_000 * PUMP_FUN_SUPPLY * 150);
  near(v.exitBlended, ((0.62 - fee) + (0.71 - fee)) / 3_000_000 * PUMP_FUN_SUPPLY * 150);
  near(v.lastSell, (0.71 - fee) / 1_500_000 * PUMP_FUN_SUPPLY * 150);
  assert.notEqual(fmtMcap(v.exitBlended, 'USD'), fmtMcap(v.lastSell, 'USD'));
  const text = cardText(s);
  assert.ok(text.includes(`entry mcap ${fmtMcap(v.entry, 'USD')} (avg fill) · exit mcap ${fmtMcap(v.exitBlended, 'USD')} (blended) · last sell ${fmtMcap(v.lastSell, 'USD')} mcap`), text);
  for (const aspect of ['wide', 'square'] as const) {
    const c = canvasText(renderCard(s, { aspect }).canvas).join('\n');
    assert.match(c, /ENTRY mcap[^\n]*\$40\.0K \(avg fill\)/);
    assert.match(c, /EXIT mcap[^\n]*\$66\.5K \(blended\)/);
    assert.match(c, /LAST SELL[^\n]*\$71\.0K mcap/);
    assert.doesNotMatch(c, /ENTRY avg|EXIT avg/);
  }
  // one sell: blended = that sell, so no LAST SELL row and no "blended" label
  const one = computeCard(withMcap(lossInput()), NOW);
  assert.match(cardText(one), /exit mcap \$[\d.]+[KMB]? · hold/);
  assert.doesNotMatch(cardText(one), /last sell|blended/);
  // without a USD rate the caps are in SOL, and the card says so
  const sol = computeCard(withMcap(profitInput(), null), NOW);
  assert.equal(mcapView(sol).unit, 'SOL');
  assert.match(cardText(sol), /entry mcap 267 SOL \(avg fill\)/);
  assert.match(cardText(sol), /mcap = fill price × 1B supply \(pump\.fun fixed supply\) · in SOL/);
});

test('the card names the supply source and the USD conversion; asking for mcap without a supply falls back and says so', () => {
  const s = computeCard(withMcap(profitInput()), NOW);
  const line = provenance(s, {}).find((l) => l.startsWith('mcap = '));
  assert.equal(line, 'mcap = fill price × 1B supply (pump.fun fixed supply) · USD: $150.00/SOL now (display conversion)');
  for (const aspect of ['wide', 'square'] as const) {
    const c = canvasText(renderCard(s, { aspect }).canvas).join('\n');
    assert.match(c, /SUPPLY[^\n]*1B · pump\.fun fixed/, `${aspect}: supply source on the card`);
    assert.match(c, /MCAP IN[^\n]*USD at \$150\.00\/SOL/, `${aspect}: USD conversion on the card`);
    assert.doesNotMatch(c, /OPENED|CLOSED/, 'the window line carries the times');
  }
  assert.match(canvasText(renderCard(computeCard(withMcap(profitInput(), null), NOW)).canvas).join('\n'), /MCAP IN[^\n]*SOL \(no USD rate\)/);
  const fdv = computeCard({ ...withMcap(profitInput()), supply: { tokens: 998_800_000, source: 'recorded FDV ÷ price (market data)' } }, NOW);
  assert.match(cardText(fdv), /998\.80M supply \(recorded FDV ÷ price \(market data\)\)/);
  const fb = computeCard(profitInput(), NOW);
  assert.equal(mcapView(fb, { basis: 'mcap' }).basis, 'price');
  const t = cardText(fb, { basis: 'mcap' });
  assert.match(t, /entry avg .* SOL · exit avg/);
  assert.match(t, /market cap not shown: no token supply recorded, so prices are in SOL/);
  for (const aspect of ['wide', 'square'] as const) {
    const r = renderCard(fb, { aspect, basis: 'mcap' });
    assert.match(canvasText(r.canvas).join('\n'), /MCAP [^\n]*n\/a: no supply known/); assert.deepEqual(r.clipped, []);
  }
  const nodec = computeCard({ ...withMcap(longHoldInput()), decimals: null, mark: null, fills: profitInput().fills }, NOW);
  assert.match(mcapView(nodec).fallback!, /decimals unknown/);
});

test('an open position shows MARK mcap from the price mark; nothing clips on either aspect, even with every opt-in shown', () => {
  const s = computeCard(withMcap(longHoldInput()), NOW);
  const v = mcapView(s);
  near(v.mark, 0.000_000_31 * PUMP_FUN_SUPPLY * 150);
  assert.match(cardText(s), /mark mcap \$46\.5K · last sell \$[\d.]+K mcap · hold/);
  for (const input of [profitInput(), lossInput(), longHoldInput(), lossInput('devnet')]) {
    for (const o of [{}, { showWallet: true, exactSize: true }, { basis: 'price' as const }]) {
      for (const aspect of ['wide', 'square'] as const) {
        const r = renderCard(computeCard(withMcap(input), NOW), { ...o, aspect });
        const px = cardPixels(r);
        // the market-cap view never clips more than the price card of the same fills. That one is clean except with
        // the wallet shown on a TRACKED or a devnet LIVE card, whose stamp note already overflows on main 0486a1a
        // (pre-existing, not the market-cap rows)
        const before = renderCard(computeCard(input, NOW), { ...o, aspect, basis: 'price' }).clipped;
        assert.deepEqual(r.clipped, before, `${input.source} ${aspect} ${JSON.stringify(o)}: no new clipping`);
        if (!('showWallet' in o)) assert.deepEqual(r.clipped, [], `${input.source} ${aspect} ${JSON.stringify(o)}: nothing clipped`);
        assert.ok(px.scales.every((k) => k >= 4));
      }
    }
  }
});

test('cardSupply: recorded FDV ÷ price first, pump.fun 1B by launchpad or a …pump mint, else none (never guessed)', () => {
  assert.deepEqual(cardSupply({ mint: 'Xpump', fdv: 50_000, price: 0.00005, via: 'dexscreener' }), { tokens: 1_000_000_000, source: 'recorded FDV ÷ price (dexscreener)' });
  assert.deepEqual(cardSupply({ mint: 'X', launchpad: 'pump.fun' }), PUMP);
  assert.deepEqual(cardSupply({ mint: 'NEWCOINxxxxpump' }), PUMP);
  assert.deepEqual(cardSupply({ mint: 'NEWCOINxxxxpump', launchpad: 'raydium' }), null, 'a migrated-elsewhere launchpad does not inherit the suffix rule');
  assert.equal(cardSupply({ mint: 'GLYPHa8sKq', launchpad: 'raydium', fdv: null, price: 1 }), null);
  assert.equal(cardSupply({ mint: 'GLYPHa8sKq', fdv: 0, price: 0 }), null);
});

test('autotrade ledger adapter: the USD desk fills give the return and the caps exactly, whatever the SOL rate', () => {
  // the AT-8 shape (entry, cost-recovery sell, final sell) on a made-up coin
  const t0 = NOW - HOUR;
  const ev: AutotradeFillEvent[] = [
    { kind: 'clamp', t: t0 - 1000 },
    { kind: 'fill', t: t0, positionId: 'p1', mint: 'SAMPLExxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxpump', side: 'buy', usd: 15, tokens: 215184.55, price: 0.00006795, avgPrice: 0.0000697076, reason: 'entry' },
    { kind: 'fill', t: t0 + 9 * MIN, positionId: 'p1', mint: 'SAMPLExxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxpump', side: 'sell', usd: 15, tokens: 110621.28, price: 0.0001391, avgPrice: 0.000135597, reason: 'cost-recovery' },
    { kind: 'fill', t: t0 + 27 * MIN, positionId: 'p2', mint: 'OTHER', side: 'buy', usd: 5, tokens: 10 },
    { kind: 'fill', t: t0 + 27 * MIN, positionId: 'p1', mint: 'SAMPLExxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxpump', side: 'sell', usd: 42.0088, tokens: 104563.27, price: 0.000412, avgPrice: 0.000401755, reason: 'thesis-split' },
    { kind: 'trade_closed', t: t0 + 27 * MIN, trade: { id: 'p1', symbol: 'SAMPLE' } },
  ];
  for (const rate of [80, 106.34, 250]) {
    const input = autotradeCardInput(ev, { positionId: 'p1', solUsd: { usd: rate, source: 'test rate' }, runId: 'RUN1' });
    assert.equal(input.symbol, 'SAMPLE'); assert.equal(input.fills.length, 3); assert.equal(input.source, 'paper');
    assert.deepEqual(input.supply, PUMP);
    const s = computeCard(input, NOW);
    near(s.pnlPct * 100, 280.0587, 1e-4);
    near(s.costInSol * rate, 15);
    const v = mcapView(s);
    near(v.entry, 15 / 215184.55 * 1e9);
    near(v.exitBlended, 57.0088 / (110621.28 + 104563.27) * 1e9);
    near(v.lastSell, 42.0088 / 104563.27 * 1e9);
    assert.match(cardText(s), /entry mcap \$69\.7K \(avg fill\) · exit mcap \$264\.9K \(blended\) · last sell \$401\.8K mcap/);
    assert.match(cardText(s), /autotrade paper run RUN1/);
    assert.match(canvasText(renderCard(s).canvas).join('\n'), /MCAP IN[^\n]*USD \(desk fills\)/);
    assert.match(cardText(s), new RegExp(`SOL \\$${rate.toFixed(2)} \\(test rate\\)`));
    for (const aspect of ['wide', 'square'] as const) assert.deepEqual(renderCard(s, { aspect }).clipped, []);
  }
  assert.throws(() => autotradeCardInput(ev, { positionId: 'p1', solUsd: { usd: 0, source: 'x' } }), /SOL\/USD rate/);
});

test('the preview: m flips market cap ⇄ SOL price and says which; the default follows the supply', () => {
  const ui: PnlUi = {
    origin: 'positions', choices: [{ mint: 'm', symbol: 'S' }], idx: 0, wallet: null,
    opts: { aspect: 'wide', showWallet: false, exactSize: false }, stats: computeCard(withMcap(profitInput()), NOW), error: null, busy: false, notice: null,
  };
  assert.deepEqual(pnlKey(ui, { name: 'char', ch: 'm' }), { kind: 'none' });
  assert.equal(ui.opts.basis, 'price'); assert.match(ui.notice!, /SOL price/);
  pnlKey(ui, { name: 'char', ch: 'm' });
  assert.equal(ui.opts.basis, 'mcap'); assert.match(ui.notice!, /market cap/);
  ui.stats = computeCard(profitInput(), NOW); ui.opts.basis = undefined;
  pnlKey(ui, { name: 'char', ch: 'm' });
  assert.equal(ui.opts.basis, 'mcap'); assert.match(ui.notice!, /no token supply recorded/);
});
