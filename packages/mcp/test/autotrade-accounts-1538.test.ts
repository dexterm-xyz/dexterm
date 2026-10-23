// task-1538: paper accounts on the MCP surface. autotrade_parallel_list shows each strategy's account and the configured
// accounts; autotrade_parallel_compare shows each account once (start, equity, cash, P/L, its strategies) and a
// strategy's own P/L on it; the ledger tools take an `account` filter and refuse anything that is not an account id.
// A temp $DEXTERM_HOME with a hand-written fleet status: no runner, no network, no keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireRunLock, fleetStatusPath, releaseRunLock, writeJsonAtomic } from '@dexterm/autotrade';
import { AutotradeTools } from '../src/autotrade-tools.ts';
import { filterFromArgs } from '../src/ledger-tools.ts';
import { TOOLS } from '../src/server.ts';

const FLEET = '20261022T000000Z-fleet-acct';
const stats = { candidates: 1, entries: 1, closed: 1, wins: 1, losses: 0, realizedUsd: 6, rugExits: 0, rugCostUsd: 0, enteredUsd: 50, missedRunners: 0, missedSample: [], spendUsd: 0.1 };
const member = (id: string, account: string | null, pnlUsd: number) => ({
  id, runId: `run-${id}`, state: 'running', haltReason: null, mode: 'paper', basedOn: { id: 'scalp', version: '1.0.0', hash: 'h' }, strategyHash: 'x', bankroll: { usd: account ? 1000 : 200 },
  book: account ? { startUsd: 1000, equityUsd: 1010, cashUsd: 960, realizedTodayUsd: 6 } : { startUsd: 200, equityUsd: 203, cashUsd: 203, realizedTodayUsd: 3 },
  spend: null, open: [], candidates: 0, sessions: 0, stats, ledgerPath: null, startedAt: null, endedAt: null,
  ...(account ? { account, pnlUsd } : {}),
});

test('1538 mcp: list and compare show the paper accounts; a strategy row on an account carries its own P/L', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dexterm-1538-mcp-'));
  mkdirSync(join(home, 'autotrade'), { recursive: true });
  writeFileSync(join(home, 'autotrade', 'autotrade.json'), JSON.stringify({
    schema: 'dexterm-autotrade/1', accounts: [{ id: 'main', bankroll: { usd: 1000 } }],
    strategies: [{ id: 'alpha', preset: 'scalp', account: 'main' }, { id: 'beta', preset: 'scalp', account: 'main' }, { id: 'own', preset: 'scalp', bankroll: { usd: 200 } }],
  }));
  writeJsonAtomic(fleetStatusPath(home), {
    schema: 'dexterm-autotrade-fleet/1', fleetId: FLEET, pid: process.pid, mode: 'paper', state: 'running', haltReason: null, startedAt: Date.now(), heartbeatAt: Date.now(), source: 'live',
    global: { caps: { maxConcurrentSessions: 3, modelUsdPerDay: 20, candidateSessionsPerDay: 96, positionSessionsPerDay: 96, turnsPerDay: 4000 }, today: { modelUsd: 0.2, turns: 4, candidateSessions: 2, positionSessions: 0 }, liveSessions: 0, load: { load1m: 1, paused: false, pauseAbove: 25, resumeBelow: 20 }, allowance: null, blocked: null },
    members: [member('alpha', 'main', 6), member('beta', 'main', 4), member('own', null, 0)],
    accounts: [{ id: 'main', startUsd: 1000, cashUsd: 960, equityUsd: 1010, pnlUsd: 10, pnlPct: 1, openCostUsd: 40, positions: 1, strategies: ['alpha', 'beta'] }],
    ledgerPath: '',
  });
  assert.ok(acquireRunLock(home, FLEET).ok);
  const tools = new AutotradeTools({ env: { ...process.env, DEXTERM_HOME: home }, actor: 'mcp-agent' });
  const l = await tools.call('autotrade_parallel_list', {}) as { config: { accounts: { id: string }[]; strategies: { id: string; account: string | null }[] }; running: { strategies: { id: string; account: string | null }[] } };
  assert.deepEqual(l.config.accounts.map((a) => a.id), ['main']);
  assert.deepEqual(l.config.strategies.map((s) => [s.id, s.account]), [['alpha', 'main'], ['beta', 'main'], ['own', null]]);
  assert.deepEqual(l.running.strategies.map((s) => [s.id, s.account]), [['alpha', 'main'], ['beta', 'main'], ['own', null]]);
  const c = await tools.call('autotrade_parallel_compare', {}) as { strategies: { id: string; account: string | null; pnlUsd: number | null }[]; totals: { startUsd: number; equityUsd: number }; accounts: { id: string; strategies: string[] }[]; table: string[] };
  assert.deepEqual(c.strategies.map((r) => [r.id, r.account, r.pnlUsd]), [['alpha', 'main', 6], ['beta', 'main', 4], ['own', null, 3]]);
  assert.deepEqual(c.totals.startUsd, 1200, 'the account once ($1000) + own ($200)');
  assert.deepEqual(c.totals.equityUsd, 1213);
  assert.deepEqual(c.accounts.map((a) => [a.id, a.strategies]), [['main', ['alpha', 'beta']]]);
  assert.match(c.table[0], /^STRATEGY\s+ACCOUNT\s+STATE/);
  releaseRunLock(home, FLEET);
});

test('1538 mcp: the ledger tools filter by paper account; anything else is refused', () => {
  const ok = filterFromArgs({ account: 'main' }, Date.now());
  assert.ok(ok.ok && ok.filter.account === 'main');
  for (const bad of ['Main', '../x', '', 'a', 5]) assert.equal(filterFromArgs({ account: bad }, Date.now()).ok, false, String(bad));
  for (const name of ['ledger_trades', 'ledger_positions', 'ledger_equity', 'ledger_summary', 'ledger_compare']) {
    const t = TOOLS.find((x) => x.name === name)!;
    assert.ok((t.inputSchema as { properties: Record<string, unknown> }).properties.account, `${name} takes account`);
  }
});
