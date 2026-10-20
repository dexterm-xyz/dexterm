// task-1463: the token screen's ON-CHAIN rows on a short panel. Before, rows past the panel's bottom were dropped
// silently, so with a wallet-intel scan open the DEV rows (a serial-rugger `Dev rugs 2/3`, the red `Linked dev rugs`)
// vanished at common terminal sizes and the panel read as if there were nothing to flag. Now red, then amber rows are
// kept first and the last line says how many rows are hidden. Offline, fixtures only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Recorder } from '@dexterm/recorder';
import { Cache, analyze, type DataLayer } from '@dexterm/data';
import { Canvas, THEMES } from '@dexterm/tui';
import { makeFixtureState } from '../src/index.ts';
import { emptyView } from '../src/live/token.ts';
import { renderTokenLive, fitRows } from '../src/live/screens/token-live.ts';
import type { LiveContext } from '../src/live/index.ts';

const DEV = 'DevW1111111111111111111111111111111111111111';
const PAL = 'PaLW1111111111111111111111111111111111111111';
const FUNDER = 'FundW111111111111111111111111111111111111111';
const MINT = 'MintJudged111111111111111111111111111111111';
const m = (i: number): string => `Mint${'abcdefghijk'[i]}${'1'.repeat(40)}`.slice(0, 44);

test('fitRows: unchanged when everything fits; otherwise bad, then warn rows survive in order and the rest are counted', () => {
  const rows: Array<[string, string, 'ok' | 'warn' | 'bad' | 'na']> = [
    ['a', '1', 'ok'], ['b', '2', 'na'], ['c', '3', 'warn'], ['d', '4', 'na'], ['e', '5', 'bad'], ['f', '6', 'ok'],
  ];
  assert.equal(fitRows(rows, 6), rows);
  assert.equal(fitRows(rows, 9), rows);
  assert.deepEqual(fitRows(rows, 4), [['a', '1', 'ok'], ['c', '3', 'warn'], ['e', '5', 'bad'], ['+3 rows hidden', 'taller window', 'na']]);
  assert.deepEqual(fitRows(rows, 2), [['e', '5', 'bad'], ['+5 rows hidden', 'taller window', 'na']], 'the red row wins the only slot');
});

function seeded(): Recorder {
  const rec = new Recorder({ path: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-fit1463-')), 'h.db') });
  const out = rec.database.prepare("INSERT INTO outcomes (mint, t0, horizon_sec, t1, label, label_tier, evidence, labeler_version) VALUES (?, ?, 259200, ?, ?, 'keyless-proxy', '{}', '0.2.0')");
  const snap = rec.database.prepare("INSERT INTO token_snapshots (mint, t, kind, hash, src_market, sources, dev_pct) VALUES (?, ?, 'live', 'h', 'dexscreener', '[]', ?)");
  const t0 = Date.now() - 10 * 86_400_000;
  ['rug', 'rug', 'runner'].forEach((label, i) => {
    const t = t0 + i * 3_600_000;
    rec.recordCreator(m(i), DEV, 'jupiter-tokens', t, t);
    out.run(m(i), t, t + 259_200_000, label);
    snap.run(m(i), t, 6); snap.run(m(i), t + 20 * 60_000, 0);
  });
  rec.recordCreator(m(5), PAL, 'pumpportal', t0, t0);
  out.run(m(5), t0, t0 + 259_200_000, 'rug');
  rec.recordCreator(MINT, DEV, 'jupiter-tokens', Date.now(), null);
  return rec;
}

function render(w: number, h: number): string[] {
  const rec = seeded();
  const base = analyze({ mint: MINT, supply: '1000000000', decimals: 6, largest: [], owners: {}, ownerMeta: {}, funding: {}, launch: [] } as never);
  // the creator sits in a funder cluster with another wallet that launched a coin that rugged
  const analysis = { ...base, holders: [{ owner: DEV, funder: { address: FUNDER, label: null, blockTime: null, sig: null } }], clusters: [{ name: 'C1', kind: 'funder', members: [DEV, PAL, 'Some1111111111111111111111111111111111111111'], pct: 12.5, labels: [], evidence: [] }] };
  const intel = { analysis: () => analysis, entry: () => ({ at: Date.now() - 4 * 60_000, state: 'done', result: null }), historyAvailable: () => ({ ok: false, why: 'Helius key' }) };
  const dl = { cache: new Cache({ path: ':memory:' }) } as unknown as DataLayer;
  const v = emptyView({ mint: MINT, symbol: 'JDG', name: 'Judged', launchpad: 'pump.fun', price: 0.001 });
  const live = { dl, intel, recorder: { database: rec.database }, token: { dl, view: v }, rpc: { provider: 'helius', basis: 'test' }, fastLane: null, badgeFor: () => 'POLL', livePrice: () => null, watch: { has: () => false }, creditsStatus: () => undefined, signals: null } as unknown as LiveContext;
  const state = makeFixtureState({ screen: 'token', theme: THEMES.midnight, calm: true });
  state.screener.source = 'live';
  state.live = live;
  state.now = new Date();
  const c = new Canvas(w, h, THEMES.midnight);
  c.fill(0, 0, w, h, ' ', { bg: THEMES.midnight.bg });
  renderTokenLive(c, state, v);
  return c.toPlain().split('\n');
}

test('token screen with a wallet-intel scan: the red DEV rows stay on a short panel and the hidden rows are counted', () => {
  for (const [w, h] of [[176, 48], [160, 44], [140, 40]]) {
    const out = render(w, h);
    const at = (re: RegExp): string => out.find((l) => re.test(l)) ?? '';
    assert.match(at(/2\/3 · n=3 · rec 7d/), /○ Dev rugs/, `${w}x${h}: the serial-rugger row is drawn red`);
    assert.match(at(/1 · n=1 devs · rec 7d/), /○ Linked/, `${w}x${h}: the linked-rugs row is drawn red`);
    assert.match(at(/rows hidden/), /\+\d+ rows hidden/, `${w}x${h}: the panel says rows are hidden`);
  }
});
