// task-1538 (paper accounts) from the terminal: `dexterm autotrade run --all --paper` on a tape with shared paper
// accounts in autotrade.json (one strategy on two accounts, two strategies on one), the account table, `status --all`,
// a bad account refused before anything starts, and `dexterm ledger trades --account`. A paced replay of the fixture
// tape with stub sessions in a temp $DEXTERM_HOME: no network, no model, no keys, paper only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KillSwitch } from '@dexterm/data';
import { readFleetStatus, runLockPath } from '@dexterm/autotrade';
import { autotradeCommand } from '../src/autotrade-cmd.ts';
import { fleetRunCmd } from '../src/autotrade-cmd/fleet.ts';

const TAPE = fileURLToPath(new URL('../../autotrade/test/fixtures/autotrade-1498-tape.json', import.meta.url));

function io(config?: unknown) {
  const home = mkdtempSync(join(tmpdir(), 'dexterm-at-acct-'));
  mkdirSync(join(home, 'autotrade'), { recursive: true });
  if (config !== undefined) writeFileSync(join(home, 'autotrade', 'autotrade.json'), JSON.stringify(config));
  const out: string[] = [], err: string[] = [];
  return { home, out, err, io: { stdout: { write: (s: string) => { out.push(s); return true; } }, stderr: { write: (s: string) => { err.push(s); return true; } }, env: { DEXTERM_HOME: home, DEXTERM_DB_PATH: join(home, 'none.db'), PATH: process.env.PATH ?? '' } } };
}
const noPanic = (home: string) => new KillSwitch(join(home, 'trading.panic'));
const CONFIG = {
  schema: 'dexterm-autotrade/1', solUsd: 150,
  accounts: [{ id: 'main', bankroll: { usd: 1000 } }, { id: 'yolo', bankroll: { sol: 1 } }],
  strategies: [
    { id: 'moon', preset: 'moonbag', account: 'main' },
    { id: 'scalp', preset: 'scalp', account: ['main', 'yolo'] },
    { id: 'own', preset: 'scalp', bankroll: { usd: 200 } },
  ],
  global: { maxConcurrentSessions: 2, modelUsdPerDay: 5 },
};

test('1538 cli: run --all with paper accounts: members per account, the account table, status --all, totals count each account once', async () => {
  const x = io(CONFIG);
  const code = await fleetRunCmd(['--all', '--paper', '--replay', TAPE, '--ms-per-tick', '1', '--stub'], x.io, { killSwitch: noPanic(x.home) });
  const out = x.out.join('');
  assert.equal(code, 0, x.err.join(''));
  assert.match(out, /PAPER · 4 strategies at once \(4 enabled\)/);
  assert.match(out, /paper accounts: main \$1000 ← moon, scalp-main · yolo \$150 \(1 SOL\) ← scalp-yolo/);
  assert.match(out, /STRATEGY\s+ACCOUNT\s+STATE\s+BANKROLL/);
  assert.match(out, /scalp-yolo\s+yolo\s+stopped\s+\$150/);
  assert.match(out, /own\s+—\s+stopped\s+\$200/);
  assert.match(out, /ACCOUNT\s+START\s+EQUITY\s+CASH/);
  assert.match(out, /main\s+\$1000 .*moon scalp-main/);
  assert.match(out, /yolo\s+\$150 \(1 SOL\).*scalp-yolo/);
  assert.match(out, /together .* on \$1350\.00 \(paper\)/, 'main $1000 + yolo $150 + own $200, each counted once');
  assert.equal(existsSync(runLockPath(x.home)), false);
  const st = readFleetStatus(x.home);
  assert.ok(st.ok);
  assert.deepEqual(st.status.accounts!.map((a) => [a.id, a.startUsd, a.strategies]), [['main', 1000, ['moon', 'scalp-main']], ['yolo', 150, ['scalp-yolo']]]);
  x.out.length = 0;
  assert.equal(await autotradeCommand(['autotrade', 'status', '--all'], x.io), 0);
  assert.match(x.out.join(''), /paper accounts \(shared simulated wallets\):\nACCOUNT/);
  x.out.length = 0;
  assert.equal(await autotradeCommand(['autotrade', 'status', '--all', '--json'], x.io), 0);
  const j = JSON.parse(x.out.join('')) as { fleet: { accounts: { id: string }[]; strategies: { id: string; account: string | null }[]; totals: { startUsd: number } } };
  assert.deepEqual(j.fleet.accounts.map((a) => a.id), ['main', 'yolo']);
  assert.deepEqual(j.fleet.strategies.map((r) => [r.id, r.account]), [['moon', 'main'], ['scalp-main', 'main'], ['scalp-yolo', 'yolo'], ['own', null]]);
  assert.equal(j.fleet.totals.startUsd, 1350);
  // The trade ledger: the account's trades by --account (only strategies that traded show up).
  const { ledgerCommand } = await import('../src/ledger-cmd.ts');
  const lo: string[] = [];
  const lio = { ...x.io, stdout: { write: (s: string) => { lo.push(s); return true; } } };
  assert.equal(await ledgerCommand(['trades', '--account', 'main', '--json'], lio as never), 0);
  const rows = JSON.parse(lo.join('')) as { trades?: { account: string | null }[] } | { account: string | null }[];
  const list = Array.isArray(rows) ? rows : rows.trades ?? [];
  assert.ok(list.length >= 1, `the account's strategies traded on the tape: ${lo.join('').slice(0, 300)}`);
  assert.ok(list.every((t) => t.account === 'main'), JSON.stringify(list).slice(0, 300));
  lo.length = 0;
  assert.notEqual(await ledgerCommand(['trades', '--account', 'Not An Id'], lio as never), 0, 'a bad account id is refused');
});

test('1538 cli: a bad account in autotrade.json starts nothing', async () => {
  const x = io({ ...CONFIG, strategies: [{ id: 'moon', preset: 'moonbag', account: 'nope' }] });
  assert.equal(await fleetRunCmd(['--all', '--paper', '--replay', TAPE, '--stub'], x.io, { killSwitch: noPanic(x.home) }), 1);
  assert.match(x.err.join(''), /account nope is not a paper account/);
  assert.equal(existsSync(runLockPath(x.home)), false);
  const y = io({ ...CONFIG, solUsd: undefined });
  const ys = { ...y.io, env: { ...y.io.env } };
  // A SOL account on a replay needs the SOL price (no network here): refused, nothing started.
  assert.equal(await fleetRunCmd(['--all', '--paper', '--replay', TAPE, '--stub'], ys, { killSwitch: noPanic(y.home) }), 1);
  assert.match(y.err.join(''), /paper account yolo: a SOL bankroll needs the SOL price/);
  const none = io({ schema: 'dexterm-autotrade/1' });
  assert.equal(await fleetRunCmd(['--all', '--paper', '--replay', TAPE, '--stub'], none.io, { killSwitch: noPanic(none.home) }), 1);
  const miss = io();
  assert.equal(await fleetRunCmd(['--all', '--paper', '--replay', TAPE, '--stub'], miss.io, { killSwitch: noPanic(miss.home) }), 1);
  assert.match(miss.err.join(''), /shared paper accounts[\s\S]*"account": \["main", "yolo"\]/, 'the example shows accounts');
});
