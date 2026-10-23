// task-1537 — market cap is the default price basis: the chat assistant's system prompt and per-turn context follow
// the basis at run time (both bases asserted), the `/display` chat command, the one-run flags, and the tui/data
// formatter parity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fmtPrice } from '@dexterm/tui';
import { fmtUsdPrice, PRICE_BASIS_ENV } from '@dexterm/data/basis';
import { analystBasis, analystContextBlock, analystSystemPrompt, buildArgv, selectedSnapshotLines, writeAnalystSystemPrompt } from '../src/analyst/backend.ts';
import { configPriceMode, parseDisplayCommand, priceModeNotice, setPriceMode, takeBasisFlags } from '../src/display.ts';
import { makeFixtureState } from '../src/state.ts';

const DETAIL = {
  source: 'live feed', mint: 'GiGa111111111111111111111111111111111pump', symbol: 'GIGA', priceUsd: 0.0000697, chg: { m5: 1, h1: 2, h6: 3, h24: 4 },
  mcap: 69_700, fdv: 69_700, liq: 20_000, vol24: 90_000, holders: 812, holdersChgPct24h: null, top10Pct: 22.5, ageMin: 300,
  interval: '1h', candles: [[0, 0.00005, 0.00008, 0.00004, 0.00006, 1], [3_600_000, 0.00006, 0.00009, 0.00005, 0.0000697, 1]], spark: null, asOf: 0,
};

test('the analyst system prompt carries the basis paragraph for the basis in effect (mcap default, price when set)', () => {
  const m = analystSystemPrompt('mcap');
  assert.match(m, /You are the dexterm analyst/);
  assert.match(m, /## Price basis\nPRICE BASIS: MARKET CAP/);
  assert.match(m, /cap at entry and the cap now/);
  assert.doesNotMatch(m, /PRICE BASIS: USD PRICE/);
  const p = analystSystemPrompt('price');
  assert.match(p, /## Price basis\nPRICE BASIS: USD PRICE/);
  assert.doesNotMatch(p, /PRICE BASIS: MARKET CAP/);
  // the per-turn copy is private (0600) and is what the CLI flag points at
  const tmp = mkdtempSync(join(tmpdir(), 'dexterm-1537-'));
  const f = writeAnalystSystemPrompt(tmp, 'price');
  assert.equal(statSync(f).mode & 0o777, 0o600);
  assert.equal(readFileSync(f, 'utf8'), p);
  const argv = buildArgv({ prompt: 'hi', screenState: {} }, join(tmp, 'mcp.json'), undefined, f);
  assert.equal(argv[argv.indexOf('--append-system-prompt-file') + 1], f);
});

test('analystBasis: the app\'s live mode (follows $ and /display) wins, then the one-run env override, then market cap', () => {
  assert.equal(analystBasis({ app: { priceMode: 'price' } }, {}), 'price');
  assert.equal(analystBasis({ app: { priceMode: 'mcap' } }, { [PRICE_BASIS_ENV]: 'price' }), 'mcap');
  assert.equal(analystBasis({}, { [PRICE_BASIS_ENV]: 'price' }), 'price');
  assert.equal(analystBasis({}, {}), 'mcap');
  assert.equal(analystBasis(null, {}), 'mcap');
});

test('the LIVE SNAPSHOT leads with the market cap and reads the history as caps by default; price basis keeps prices', () => {
  const m = selectedSnapshotLines(DETAIL, 'mcap').join('\n');
  assert.match(m, /^ {2}mcap \$69\.7K \(price \$0\.00006970?\)/m);
  assert.match(m, /market caps at the current supply \(market cap ÷ price\)/);
  assert.match(m, /open \$50K → last \$69\.7K/);
  const p = selectedSnapshotLines(DETAIL, 'price').join('\n');
  assert.match(p, /^ {2}price \$0\.00006970? {2}move/m);
  assert.doesNotMatch(p, /market caps at the current supply/);
  // no supply: the price, and why
  const none = selectedSnapshotLines({ ...DETAIL, mint: 'So11111111111111111111111111111111111111112', mcap: null, fdv: null }, 'mcap').join('\n');
  assert.match(none, /price \$0\.00006970? \(market cap unknown: no supply recorded, showing price\)/);
});

test('the per-turn CONTEXT block names the basis and lists the visible pool cap-first by default', () => {
  const ss = { screen: 'screener', selected: null, visible: [{ mint: 'M1', symbol: 'AAA', priceUsd: 0.002, mcap: 2_000_000, chg1h: 1, chg24h: 2, liq: 1, vol24: 1 }] };
  const m = analystContextBlock({ ...ss, app: { priceMode: 'mcap' } });
  assert.match(m, /price basis: MARKET CAP/);
  assert.match(m, /AAA<\/untrusted> {2}mcap \$2\.00M \(px \$0\.00200\)/);
  const p = analystContextBlock({ ...ss, app: { priceMode: 'price' } });
  assert.match(p, /price basis: USD PRICE/);
  assert.match(p, /AAA<\/untrusted> {2}px \$0\.00200 {2}1h/);
});

test('/display in the chat box: show, set (journaled like $), refuse junk; /basis and /set basis are aliases; markers is not ours', () => {
  assert.deepEqual(parseDisplayCommand('/display'), { show: true });
  assert.deepEqual(parseDisplayCommand('/display price'), { mode: 'price' });
  assert.deepEqual(parseDisplayCommand('/basis MCAP'), { mode: 'mcap' });
  assert.deepEqual(parseDisplayCommand('/set basis price'), { mode: 'price' });
  assert.deepEqual(parseDisplayCommand('/set priceMode mcap'), { mode: 'mcap' });
  assert.ok('error' in (parseDisplayCommand('/display fdv') as object));
  assert.equal(parseDisplayCommand('/display markers off'), null);
  assert.equal(parseDisplayCommand('/scan on'), null);
  const s = makeFixtureState();
  assert.match(priceModeNotice(s), /MARKET CAP \(default\)/);
  assert.match(setPriceMode(s, 'price', '/display'), /USD PRICE .*not saved/);
  assert.equal(s.priceMode, 'price');
  assert.match(priceModeNotice(s), /USD PRICE/);
});

test('one-run override: --price / --mcap anywhere set DEXTERM_PRICE_BASIS and leave the rest of argv; the env beats the config', () => {
  const env: Record<string, string | undefined> = {};
  assert.deepEqual(takeBasisFlags(['autotrade', 'list', '--price', '--json'], env), ['autotrade', 'list', '--json']);
  assert.equal(env[PRICE_BASIS_ENV], 'price');
  assert.equal(configPriceMode({ display: { priceMode: 'mcap' } }, env), 'price');
  assert.equal(configPriceMode({ display: { priceMode: 'price' } }, { [PRICE_BASIS_ENV]: 'mcap' }), 'mcap');
  assert.equal(configPriceMode({}, {}), 'mcap');
  assert.equal(configPriceMode({ display: { priceMode: 'price' } }), 'price');
});

test('the data-layer price formatter matches the TUI one (one price form on every surface)', () => {
  for (const p of [0.0000697, 0.000123456, 0.00265, 0.0123, 0.5, 1.2345, 42.1, 142.5, 1234.5, 98_765.4]) assert.equal(fmtUsdPrice(p), fmtPrice(p), String(p));
});

test('row levels (stops, targets, fills, the tape): a cap at the known supply by default, a marked price without one', async () => {
  const { levelCell, supplyForMint } = await import('../src/display.ts');
  assert.equal(levelCell('mcap', 1e9, 0.0000697), '$69.7K');
  assert.equal(levelCell('mcap', null, 0.0000697), '$0.0₄697ᵖ');
  assert.equal(levelCell('price', 1e9, 0.0000697), '$0.0₄697');
  assert.equal(levelCell('mcap', 1e9, null), '—');
  // the supply: the screener row's (mcap ÷ price), else pump.fun's fixed 1B by mint suffix, else none
  const s = makeFixtureState();
  const row = s.screener.rows[0];
  assert.ok(Math.abs(supplyForMint(s, row.mint)! - row.mcap! / row.price!) < 1e-3);
  assert.equal(supplyForMint(s, 'Unlisted11111111111111111111111111111pump'), 1e9);
  assert.equal(supplyForMint(s, 'So11111111111111111111111111111111111111112'), null);
});

test('the PnL chip reads entry / mark / TP as caps by default and as prices with basis price', async () => {
  const { OwnPnlTracker, CHIP_PRICE_LEVEL } = await import('../src/screens/pnl-chip.ts');
  const tr = new OwnPnlTracker();
  tr.update({ mint: 'Chip111111111111111111111111111111111pump', symbol: 'CHIP', kind: 'paper', entryUsd: 0.0000697, markUsd: 0.0002649, pnlPct: 2.8, pnlUsd: 28, openedAt: 0, targetUsd: 0.0005 }, 1);
  const cap = tr.vm(2, (u) => `$${Math.round(u * 1e9 / 100) / 10}K`)!;
  assert.equal(cap.entry, '$69.7K');
  assert.equal(cap.mark, '$264.9K');
  assert.equal(cap.tp, '$500K');
  const px = tr.vm(2)!;
  assert.equal(px.entry, CHIP_PRICE_LEVEL(0.0000697, ''));
});
