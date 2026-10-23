// task-1538 (paper accounts): several strategies trading from one shared simulated wallet, and one strategy running on
// several accounts. The account's cash is shared (fills spend from it, sales pay into it, the fill re-checks it), each
// strategy keeps its own positions and P/L, the totals count an account once, autotrade.json validates and expands
// account lists. Synthetic ticks + a temp $DEXTERM_HOME: no network, no model, no keys, paper only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPreset, type ResolvedStrategy } from '../src/strategy.ts';
import type { MarketTick, Tape } from '../src/replay.ts';
import { parseDecision, type AgentSession } from '../src/session.ts';
import { Ledger, verifyChain, type LedgerEvent } from '../src/ledger.ts';
import { DEFAULT_RUNNER_CONFIG } from '../src/runner-config.ts';
import { runAutotrade, type RunSessionFactory } from '../src/runner.ts';
import type { SafetyVerdict } from '../src/safety.ts';
import { SimBook, simBuy, simSell } from '../src/engine.ts';
import { PaperAccount } from '../src/paper-accounts.ts';
import { DEFAULT_GLOBAL_CAPS, MAX_MEMBERS, memberStrategy, parseFleetConfig, type MemberConfig } from '../src/fleet-config.ts';
import { FleetGuard, runFleet, type FleetMemberSpec, type FleetOpts } from '../src/fleet.ts';
import { accountTable, compareRows, compareTable, fleetTotals } from '../src/fleet-control.ts';
import { newRunId } from '../src/ledger.ts';
import { importRunLedgers } from '../src/trade-ledger.ts';
import { EXPORT_COLUMNS, buildLedgerView, filterTrades } from '@dexterm/data/ledger';

const T0 = 1_792_000_000_000;
const MIN = 60_000;
const A = 'Aaaa1111111111111111111111111111111111111111';
const B = 'Bbbb1111111111111111111111111111111111111111';
const OK: SafetyVerdict = { halt: null, flatten: false, pauseEntries: null, endWhenFlat: false };
const home = () => { const h = mkdtempSync(join(tmpdir(), 'at1538-')); mkdirSync(join(h, 'autotrade', 'fleet'), { recursive: true }); return h; };

function tick(over: Partial<MarketTick> = {}): MarketTick {
  return {
    mint: A, t: T0, kind: 'live', symbol: 'TEST', launchpad: 'pump.fun', createdAt: T0 - 3 * 3600e3,
    price: 1, mcap: 1e6, mcapResolved: 1e6, mcapFlagged: false, liq: 100_000, vol5m: 10_000, vol1h: 50_000, vol24: 500_000,
    buys5m: 120, sells5m: 80, buys24: 5000, sells24: 4000, chg5m: 4, chg1h: 20, chg6h: 40, chg24h: 80,
    holders: 900, top10: 20, dev: 1, mintAuth: false, freezeAuth: false, org: 70, ...over,
  };
}
const at = (min: number, over: Partial<MarketTick> = {}) => tick({ t: T0 + min * MIN, ...over });
const TAPE: Tape = { source: 'synthetic', ticks: [at(0), at(1), at(2), at(3, { mint: B }), at(4, { mint: B }), at(5, { mint: B }), at(6, { price: 1.6 }), at(7, { mint: B, price: 0.6 }), at(8), at(9, { mint: B })], mints: [A, B] };

/** Enters on the dossier, holds on every event. */
const goer: RunSessionFactory = (id): AgentSession => {
  let n = 0;
  return {
    id, kind: 'stub', costUsd: () => n * 0.01,
    async send(text) { n++; const t = text.startsWith('EVENT') ? 'DECISION {"action":"hold","reason":"ok"}' : 'DECISION {"action":"enter","reason":"go"}'; return { text: t, decision: parseDecision(t), costUsd: n * 0.01, ms: 0 }; },
    async close(reason) { return { turns: n, costUsd: n * 0.01, reason }; },
  };
};

/** A strategy that wants a fixed $`usd` per entry and lets nothing but the cash stop it. */
function greedy(s: ResolvedStrategy, usd: number): ResolvedStrategy {
  const profiles = Object.fromEntries(Object.entries(s.exits.profiles).map(([k, p]) => [k, { ...p, sizing: { ...p.sizing, maxSizePctOfBankroll: 100 } }]));
  return {
    ...s,
    sizing: { ...s.sizing, mode: 'fixed', fixedUsd: usd, maxUsd: 1e6, maxPctOfBankroll: 100, minUsd: 1, ladder: undefined },
    risk: { ...s.risk, maxExposurePct: 100, perTrade: { ...s.risk.perTrade, maxLossPctOfBankroll: 100 } },
    exits: { ...s.exits, profiles },
  } as ResolvedStrategy;
}

function member(id: string, base: ResolvedStrategy, startUsd: number, over: Partial<MemberConfig> = {}): FleetMemberSpec {
  const config: MemberConfig = { id, preset: base.id, mode: 'paper', enabled: true, caps: {}, ...over };
  const { strategy, basedOn } = memberStrategy(base, config, startUsd);
  return { config, strategy, basedOn, bankroll: { usd: startUsd } };
}

function harness(members: FleetMemberSpec[], tape: Tape, over: Partial<FleetOpts> = {}) {
  const ledgers = new Map<string, Ledger>();
  const fleetLedger = new Ledger();
  const events: { member: string; e: LedgerEvent }[] = [];
  let n = 0;
  const opts: FleetOpts = {
    fleetId: 'fleet-1538', home: home(), members, tape, runner: DEFAULT_RUNNER_CONFIG,
    guard: new FleetGuard(DEFAULT_GLOBAL_CAPS, DEFAULT_RUNNER_CONFIG, { clock: () => T0, loadavg: () => 0 }),
    sessions: () => goer,
    ledgerFor: (m, _runId, tap) => { const l = new Ledger((e) => tap(e)); ledgers.set(m, l); return { ledger: l, files: null }; },
    newRunId: (m) => `run-${m}-${++n}`,
    fleetLedger, globalSafety: () => OK, memberControl: false, verbose: false,
    hooks: { onMemberEvent: (m, _r, e) => events.push({ member: m, e }) },
    clock: () => T0,
    ...over,
  };
  return { opts, ledgers, fleetLedger, events };
}

const fills = (l: Ledger, side: 'buy' | 'sell') => l.events.filter((e) => e.kind === 'fill' && e.side === side);
const sum = (es: LedgerEvent[]) => es.reduce((a, e) => a + Number(e.usd), 0);

test('1538 SimBook on a paper account: the cash is the account\'s, equity is the account\'s, exposure and P/L stay per strategy', () => {
  const s = loadPreset('scalp');
  const acct = new PaperAccount('main', 1000);
  const one = new SimBook(s, T0, acct, 'one');
  const two = new SimBook(s, T0, acct, 'two');
  const k = tick();
  const f = simBuy(k, 100, s.execution);
  assert.ok(!('refused' in f));
  const p = one.openPosition(k, f, s.exits.profiles[s.exits.default], null, [], []);
  assert.equal(acct.cashUsd, 1000 - f.usd, 'the fill spent the account\'s cash');
  assert.equal(two.state.cashUsd, acct.cashUsd, 'the other strategy on the account sees the same cash');
  assert.equal(JSON.parse(JSON.stringify(two.state)).cashUsd, acct.cashUsd, 'the cash serializes with the book state');
  assert.equal(two.bookEquity(), one.bookEquity(), 'both size from the account (cash + every open cost)');
  assert.ok(Math.abs(two.bookEquity() - 1000) < 1e-9);
  assert.equal(two.exposureUsd(), 0, 'exposure is each strategy\'s own footprint');
  assert.ok(one.exposureUsd() > 0);
  const out = simSell(tick({ t: T0 + MIN, price: 2 }), p.tokens, s.execution, 'tp');
  assert.ok(!('refused' in out));
  one.sell(p, out);
  assert.ok(Math.abs(acct.cashUsd - (1000 - f.usd + out.usd)) < 1e-9, 'the sale paid into the account');
  assert.ok(Math.abs(one.ownPnlUsd() - (out.usd - f.usd)) < 1e-6, 'the strategy\'s own P/L');
  assert.equal(two.ownPnlUsd(), 0);
  assert.deepEqual(acct.view().strategies, ['one', 'two']);
  assert.ok(Math.abs(acct.view().pnlUsd - Math.round((out.usd - f.usd) * 100) / 100) < 0.011);
  // Without an account nothing changed: the book owns its bankroll.
  const solo = new SimBook(s, T0);
  assert.equal(solo.account, null);
  assert.equal(solo.bookEquity(), s.bankroll.startUsd);
  assert.throws(() => new PaperAccount('zero', 0), /positive/);
});

test('1538 two strategies on one paper account: one shared cash pool, own ledgers, the account counted once', async () => {
  const s = loadPreset('scalp');
  const run = async () => {
    const hx = harness([member('alpha', s, 700, { account: 'main' }), member('beta', s, 700, { account: 'main' })], TAPE, { accounts: [{ id: 'main', startUsd: 700 }] });
    return { hx, r: await runFleet(hx.opts) };
  };
  const { hx, r } = await run();
  const la = hx.ledgers.get('alpha')!, lb = hx.ledgers.get('beta')!;
  assert.ok(verifyChain(la.events).ok && verifyChain(lb.events).ok && verifyChain(hx.fleetLedger.events).ok);
  assert.ok(fills(la, 'buy').length >= 1 && fills(lb, 'buy').length >= 1, 'both strategies traded from the account');
  assert.equal(la.events[0].kind, 'fleet_member');
  assert.equal(la.events[0].account, 'main', 'the member ledger names its account');
  assert.equal(la.events.find((e) => e.kind === 'run_start')!.account, 'main');
  const acct = r.status.accounts!.find((a) => a.id === 'main')!;
  const expectCash = 700 - sum(fills(la, 'buy')) - sum(fills(lb, 'buy')) + sum(fills(la, 'sell')) + sum(fills(lb, 'sell'));
  assert.ok(Math.abs(acct.cashUsd - expectCash) < 0.011, `account cash ${acct.cashUsd} = start - buys + sells of BOTH strategies (${expectCash})`);
  assert.deepEqual(acct.strategies, ['alpha', 'beta']);
  // The account's P/L is exactly its strategies' P/L together (cash moves only through their fills).
  const own = r.status.members.map((m) => m.pnlUsd ?? 0);
  assert.ok(Math.abs(acct.pnlUsd - own.reduce((a, b) => a + b, 0)) < 0.03, `account P/L ${acct.pnlUsd} vs strategies ${own.join(' + ')}`);
  const tot = fleetTotals(r.status);
  assert.equal(tot.startUsd, 700, 'the shared account is counted once, not once per strategy');
  assert.equal(tot.equityUsd, acct.equityUsd);
  assert.equal(tot.cashUsd, acct.cashUsd);
  const rows = compareRows(r.status);
  assert.deepEqual(rows.map((x) => [x.id, x.account]), [['alpha', 'main'], ['beta', 'main']]);
  assert.deepEqual(rows.map((x) => x.pnlUsd), own.map((v) => Math.round(v * 100) / 100), 'a row\'s P/L is the strategy\'s own');
  assert.equal(rows[0].equityUsd, null, 'no per-strategy equity on a shared account');
  const table = compareTable(rows);
  assert.match(table[0], /^STRATEGY\s+ACCOUNT\s+STATE\s+BANKROLL/);
  assert.match(table[1], /^alpha\s+main\s+stopped/);
  const at2 = accountTable(r.status);
  assert.match(at2[0], /^ACCOUNT\s+START\s+EQUITY\s+CASH/);
  assert.match(at2[1], /^main\s+\$700 .*alpha beta$/);
  const start = hx.fleetLedger.events[0];
  assert.deepEqual(start.accounts, [{ id: 'main', startUsd: 700 }]);
  assert.ok(hx.fleetLedger.events.at(-1)!.accounts, 'fleet_end records the accounts');
  // Deterministic, like every tape run.
  const two = await run();
  const strip = (l: Ledger) => l.events.filter((e) => e.kind === 'fill' || e.kind === 'trade_closed').map((e) => ({ kind: e.kind, t: e.t, mint: e.mint, side: e.side, usd: e.usd }));
  assert.deepEqual(strip(two.hx.ledgers.get('alpha')!), strip(la));
  assert.deepEqual(strip(two.hx.ledgers.get('beta')!), strip(lb));
  assert.deepEqual(two.r.status.accounts, r.status.accounts);
});

test('1538 a small account: two greedy strategies can never spend more than its cash between them', async () => {
  const s = greedy(loadPreset('scalp'), 50);
  const hx = harness([member('alpha', s, 60, { account: 'tiny' }), member('beta', s, 60, { account: 'tiny' })], TAPE, { accounts: [{ id: 'tiny', startUsd: 60 }] });
  let low = Infinity;
  hx.opts.hooks = { onMemberState: (_m, _r, st) => { low = Math.min(low, st.book.cashUsd); } };
  const r = await runFleet(hx.opts);
  const la = hx.ledgers.get('alpha')!, lb = hx.ledgers.get('beta')!;
  assert.ok(low >= -0.01, `the account's cash never went below zero (lowest ${low})`);
  const acct = r.status.accounts![0];
  assert.ok(acct.cashUsd >= -0.01);
  // Open cost at any moment is bounded by the account: what both strategies bought minus what they got back.
  const bought = sum(fills(la, 'buy')) + sum(fills(lb, 'buy'));
  const back = sum(fills(la, 'sell')) + sum(fills(lb, 'sell'));
  assert.ok(bought - back <= 60 + 0.01, `net spend ${bought - back} within the $60 account`);
  // Somebody was told no because the other had the cash: at the clamp ('cash') or at the fill ('fill-account-cash').
  const text = JSON.stringify([...la.events, ...lb.events].filter((e) => e.kind === 'refused' || e.kind === 'clamp'));
  assert.match(text, /cash/, 'the shared cash limited an entry');
  // The same strategies on their own bankrolls would both have bought the first coin.
  const solo = harness([member('alpha', s, 60), member('beta', s, 60)], TAPE);
  await runFleet(solo.opts);
  assert.ok(fills(solo.ledgers.get('alpha')!, 'buy').length >= 1 && fills(solo.ledgers.get('beta')!, 'buy').length >= 1);
});

test('1538 one strategy on two accounts: one member per account, each sized from its own account', async () => {
  const cfg = parseFleetConfig({
    schema: 'dexterm-autotrade/1',
    accounts: [{ id: 'main', bankroll: { usd: 1000 } }, { id: 'yolo', bankroll: { usd: 100 } }],
    strategies: [{ id: 'scalp', preset: 'scalp', account: ['main', 'yolo'] }],
  });
  assert.ok(cfg.ok, JSON.stringify(cfg));
  assert.deepEqual(cfg.config.strategies.map((m) => [m.id, m.account, m.entry]), [['scalp-main', 'main', 'scalp'], ['scalp-yolo', 'yolo', 'scalp']]);
  const s = loadPreset('scalp');
  const hx = harness(cfg.config.strategies.map((m) => member(m.id, s, m.account === 'main' ? 1000 : 100, m)), TAPE, { accounts: [{ id: 'main', startUsd: 1000 }, { id: 'yolo', startUsd: 100 }] });
  const r = await runFleet(hx.opts);
  const main = fills(hx.ledgers.get('scalp-main')!, 'buy'), yolo = fills(hx.ledgers.get('scalp-yolo')!, 'buy');
  assert.ok(main.length >= 1 && yolo.length >= 1);
  assert.ok(Number(main[0].usd) > Number(yolo[0].usd), `each run sizes from its own account (${main[0].usd} vs ${yolo[0].usd})`);
  assert.deepEqual(r.status.accounts!.map((a) => [a.id, a.strategies]), [['main', ['scalp-main']], ['yolo', ['scalp-yolo']]]);
  assert.equal(fleetTotals(r.status).startUsd, 1100);
});

test('1538 a strategy on its own bankroll and one on an account run side by side; the totals add both once', async () => {
  const s = loadPreset('scalp');
  const hx = harness([member('solo', s, 300), member('shared', s, 500, { account: 'main' })], TAPE, { accounts: [{ id: 'main', startUsd: 500 }] });
  const r = await runFleet(hx.opts);
  const solo = r.status.members.find((m) => m.id === 'solo')!;
  assert.equal(solo.account, undefined);
  const tot = fleetTotals(r.status);
  assert.equal(tot.startUsd, 800);
  assert.ok(Math.abs(tot.equityUsd - (solo.book!.equityUsd + r.status.accounts![0].equityUsd)) < 0.011);
  const rows = compareRows(r.status);
  assert.deepEqual(rows.map((x) => x.account), [null, 'main']);
  assert.match(compareTable(rows)[1], /^solo\s+—\s+/);
});

test('1538 the fleet and the runner refuse what an account is not: an undefined account, a live strategy on one', async () => {
  const s = loadPreset('scalp');
  const hx = harness([member('alpha', s, 100, { account: 'nope' })], TAPE, { accounts: [{ id: 'main', startUsd: 100 }] });
  await assert.rejects(runFleet(hx.opts), /paper account nope is not defined/);
  const dup = harness([member('alpha', s, 100)], TAPE, { accounts: [{ id: 'main', startUsd: 100 }, { id: 'main', startUsd: 5 }] });
  await assert.rejects(runFleet(dup.opts), /listed twice/);
  const live = { ...s, mode: 'live' } as ResolvedStrategy;
  await assert.rejects(runAutotrade({ strategy: live, tape: TAPE, sessions: null, account: new PaperAccount('main', 100), executor: { name: 'x', live: true, buy: async () => ({ refused: 'no' }), sell: async () => ({ refused: 'no' }) } } as unknown as Parameters<typeof runAutotrade>[0]), /never backs a live run|live/);
  // task-1571: there is no live executor in the build; a mode:live copy is refused before it can reach an account
});

test('1538 autotrade.json: accounts validate, lists expand, mistakes are named, files without accounts are unchanged', () => {
  const base = { schema: 'dexterm-autotrade/1', accounts: [{ id: 'main', bankroll: { usd: 1000 } }, { id: 'yolo', bankroll: { sol: 1 } }] };
  const ok = parseFleetConfig({ ...base, strategies: [{ id: 'moon', preset: 'moonbag', account: 'main' }, { id: 'own', preset: 'scalp', bankroll: { usd: 50 } }] });
  assert.ok(ok.ok);
  assert.deepEqual(ok.config.accounts, base.accounts);
  assert.equal(ok.config.strategies[0].account, 'main');
  assert.equal(ok.config.strategies[0].entry, undefined, 'a single account keeps the strategy id as it is');
  assert.equal(ok.config.strategies[1].account, undefined);
  const plain = parseFleetConfig({ schema: 'dexterm-autotrade/1', strategies: [{ id: 'own', preset: 'scalp' }] });
  assert.ok(plain.ok);
  assert.equal('accounts' in plain.config, false, 'no accounts: the parsed config is what it was before');
  const bad = (doc: Record<string, unknown>, re: RegExp) => { const r = parseFleetConfig({ ...base, ...doc }); assert.ok(!r.ok, JSON.stringify(doc)); assert.match(r.errors.join('\n'), re); };
  bad({ strategies: [{ id: 'moon', preset: 'moonbag', account: 'nope' }] }, /account nope is not a paper account/);
  bad({ strategies: [{ id: 'moon', preset: 'moonbag', account: 'main', bankroll: { usd: 5 } }] }, /drop its own bankroll/);
  bad({ strategies: [{ id: 'moon', preset: 'moonbag', account: [] }] }, /lists no paper account/);
  bad({ strategies: [{ id: 'moon', preset: 'moonbag', account: ['main', 'main'] }] }, /names an account twice/);
  bad({ accounts: [{ id: 'main', bankroll: { usd: 1 } }, { id: 'main', bankroll: { usd: 2 } }], strategies: [{ id: 'moon', preset: 'moonbag' }] }, /main is used twice/);
  bad({ strategies: [{ id: 'moon', preset: 'moonbag', account: ['main'] }, { id: 'moon-main', preset: 'scalp' }] }, /moon-main is used twice/);
  bad({ strategies: [{ id: 'a-very-long-strategy-name-here', preset: 'scalp', account: ['main'] }] }, /not a valid member id/);
  bad({ strategies: [{ id: 'moon', preset: 'moonbag', account: 'main', mode: 'live' }] }, /simulated cash only|live execution is not available/);
  bad({ accounts: [{ id: 'main' }], strategies: [{ id: 'moon', preset: 'moonbag' }] }, /bankroll/);
  bad({ accounts: [{ id: 'Main', bankroll: { usd: 1 } }], strategies: [{ id: 'moon', preset: 'moonbag' }] }, /accounts/);
  const many = Array.from({ length: 5 }, (_, i) => ({ id: `s${i}x`, preset: 'scalp', account: ['main', 'yolo'] }));
  bad({ strategies: many }, new RegExp(`at most ${MAX_MEMBERS} run at once`));
});

test('1538 the trade ledger: a strategy\'s trades on a paper account carry the account; --account filters them', async () => {
  const s = loadPreset('scalp');
  const hx = harness([member('alpha', s, 700, { account: 'main' }), member('solo', s, 300)], TAPE, { accounts: [{ id: 'main', startUsd: 700 }] });
  const h = hx.opts.home;
  delete (hx.opts as Partial<FleetOpts>).ledgerFor; // real run files under $DEXTERM_HOME/autotrade/runs
  hx.opts.newRunId = (m) => newRunId(m, T0);
  await runFleet(hx.opts);
  const imp = importRunLedgers(h);
  assert.equal(imp.results.length, 2);
  assert.ok(imp.results.every((r) => !r.problem), JSON.stringify(imp.results.map((r) => r.problem)));
  const view = buildLedgerView(join(h, 'ledger', 'trades.jsonl'), imp.results, T0 + 60 * MIN);
  const alpha = view.trades.filter((t) => t.strategy?.id === 'alpha');
  const solo = view.trades.filter((t) => t.strategy?.id === 'solo');
  assert.ok(alpha.length >= 1 && solo.length >= 1);
  assert.ok(alpha.every((t) => t.account === 'main'), 'every trade of the account strategy names the account');
  assert.ok(solo.every((t) => t.account === null), 'a strategy on its own bankroll has no account');
  assert.deepEqual(filterTrades(view.trades, { account: 'main' }).map((t) => t.tradeId), alpha.map((t) => t.tradeId));
  assert.equal(EXPORT_COLUMNS.find((c) => c.name === 'account')!.get(alpha[0]), 'main');
  const fill = view.pending.find((d) => d.kind === 'fill' && (d as { strategy?: { id: string } }).strategy?.id === 'solo') as Record<string, unknown>;
  assert.equal('account' in fill, false, 'no account key at all on other fills (their hash input is unchanged)');
});
