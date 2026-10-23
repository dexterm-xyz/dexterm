// task-1529 (parallel strategies): N strategies on one feed, each with its own book, ledger, run id, breaker, caps and
// sessions; the global guard across them; per-strategy stop / pause that never reaches another strategy; a global
// halt that reaches all; a deterministic two-strategy replay; autotrade.json; one execution port per trading wallet.
// Synthetic ticks + a temp $DEXTERM_HOME: no network, no model, no keys, paper only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPreset, type ResolvedStrategy } from '../src/strategy.ts';
import type { MarketTick, Tape } from '../src/replay.ts';
import { parseDecision, type AgentSession } from '../src/session.ts';
import { Ledger, writeJsonAtomic, verifyChain, type LedgerEvent } from '../src/ledger.ts';
import { DEFAULT_RUNNER_CONFIG, type RunnerConfig } from '../src/runner-config.ts';
import type { Executor, RunSessionFactory } from '../src/runner.ts';
import type { SafetyVerdict } from '../src/safety.ts';
import { DEFAULT_GLOBAL_CAPS, bankrollUsd, memberStrategy, parseFleetConfig, type GlobalCaps, type MemberConfig } from '../src/fleet-config.ts';
import {
  FleetGuard, MemberGate, TickHub, bindExecutors, memberCaps, runFleet, sharedDossier, strategyTaggedHooks, type FleetMemberSpec, type FleetOpts,
} from '../src/fleet.ts';
import {
  compareRows, compareTable, fleetStatusPath, fleetTotals, mergeVerdicts, readFleetStatus, readMemberControl, requestMemberControl, memberControlPath,
  type FleetStatus,
} from '../src/fleet-control.ts';

const T0 = 1_792_000_000_000;
const MIN = 60_000;
const A = 'Aaaa1111111111111111111111111111111111111111';
const B = 'Bbbb1111111111111111111111111111111111111111';
const C = 'Cccc1111111111111111111111111111111111111111';
const home = () => { const h = mkdtempSync(join(tmpdir(), 'at1529-')); mkdirSync(join(h, 'autotrade', 'fleet'), { recursive: true }); return h; };
const why = (g: { ok: boolean; reason?: string }): string | null => (g.ok ? null : g.reason ?? null);
const OK: SafetyVerdict = { halt: null, flatten: false, pauseEntries: null, endWhenFlat: false };

function tick(over: Partial<MarketTick> = {}): MarketTick {
  return {
    mint: A, t: T0, kind: 'live', symbol: 'TEST', launchpad: 'pump.fun', createdAt: T0 - 3 * 3600e3,
    price: 1, mcap: 1e6, mcapResolved: 1e6, mcapFlagged: false, liq: 100_000, vol5m: 10_000, vol1h: 50_000, vol24: 500_000,
    buys5m: 120, sells5m: 80, buys24: 5000, sells24: 4000, chg5m: 4, chg1h: 20, chg6h: 40, chg24h: 80,
    holders: 900, top10: 20, dev: 1, mintAuth: false, freezeAuth: false, org: 70, ...over,
  };
}
const at = (min: number, over: Partial<MarketTick> = {}) => tick({ t: T0 + min * MIN, ...over });

/** Enters on the dossier, holds on every event. */
const goer: RunSessionFactory = (id): AgentSession => {
  let n = 0;
  return {
    id, kind: 'stub', costUsd: () => n * 0.01,
    async send(text) { n++; const t = text.startsWith('EVENT') ? 'DECISION {"action":"hold","reason":"ok"}' : 'DECISION {"action":"enter","reason":"go"}'; return { text: t, decision: parseDecision(t), costUsd: n * 0.01, ms: 0 }; },
    async close(reason) { return { turns: n, costUsd: n * 0.01, reason }; },
  };
};

function member(id: string, base: ResolvedStrategy, usd: number, over: Partial<MemberConfig> = {}): FleetMemberSpec {
  const config: MemberConfig = { id, preset: base.id, bankroll: { usd }, mode: 'paper', enabled: true, caps: {}, ...over };
  const { strategy, basedOn } = memberStrategy(base, config, usd);
  return { config, strategy, basedOn, bankroll: { usd } };
}

interface Harness { opts: FleetOpts; ledgers: Map<string, Ledger>; fleetLedger: Ledger; events: { member: string; runId: string; e: LedgerEvent }[] }

function harness(h: string, members: FleetMemberSpec[], tape: Tape, over: Partial<FleetOpts> = {}, caps: GlobalCaps = DEFAULT_GLOBAL_CAPS, runner: RunnerConfig = DEFAULT_RUNNER_CONFIG): Harness {
  const ledgers = new Map<string, Ledger>();
  const fleetLedger = new Ledger();
  const events: Harness['events'] = [];
  let n = 0;
  const opts: FleetOpts = {
    fleetId: 'fleet-test', home: h, members, tape, runner,
    guard: new FleetGuard(caps, runner, { clock: () => T0, loadavg: () => 0 }),
    sessions: () => goer,
    ledgerFor: (m, runId, tap) => { const l = new Ledger((e) => tap(e)); ledgers.set(m, l); return { ledger: l, files: null }; },
    newRunId: (m) => `run-${m}-${++n}`,
    fleetLedger, globalSafety: () => OK, memberControl: false, verbose: false,
    hooks: { onMemberEvent: (member, runId, e) => events.push({ member, runId, e }) },
    clock: () => T0,
    ...over,
  };
  return { opts, ledgers, fleetLedger, events };
}

const buys = (l: Ledger) => l.events.filter((e) => e.kind === 'fill' && e.side === 'buy');
const buyMints = (l: Ledger) => buys(l).map((e) => String(e.mint));

test('1529 tick hub: every subscriber gets every tick as its own copy; a barrier hub keeps them in lockstep', async () => {
  const hub = new TickHub({ barrier: true });
  const seen: Record<string, number[]> = { a: [], b: [] };
  const read = async (id: string, mutate: boolean) => { for await (const k of hub.subscribe(id)) { seen[id].push(k.t); if (mutate) (k as { price: number }).price = -1; await new Promise((r) => setTimeout(r, id === 'a' ? 2 : 0)); } };
  const ra = read('a', true);
  const rb = read('b', false);
  const prices: number[] = [];
  const hub2 = new TickHub({ barrier: true });
  const rc = (async () => { for await (const k of hub2.subscribe('c')) prices.push(k.price!); })();
  for (let i = 0; i < 5; i++) { const k = at(i); await hub.publish(k); await hub2.publish(k); }
  await hub.drain(); hub.end(); await hub2.drain(); hub2.end();
  await Promise.all([ra, rb, rc]);
  assert.deepEqual(seen.a, seen.b, 'the slow and the fast strategy saw the same ticks in the same order');
  assert.equal(seen.a.length, 5);
  assert.deepEqual(prices, [1, 1, 1, 1, 1], 'a strategy that edits its tick never changes another one\'s');
  assert.throws(() => hub.subscribe('a-again') && hub.subscribe('a-again'), /already subscribed/);
});

test('1529 two strategies, one tape: own books, ledgers and run ids; the replay is deterministic', async () => {
  const ticks = [at(0), at(1), at(2), at(3, { mint: B }), at(4, { mint: B }), at(5, { mint: B }), at(6, { price: 1.6 }), at(7, { mint: B, price: 0.6 }), at(8), at(9, { mint: B })];
  const tape: Tape = { source: 'synthetic', ticks, mints: [A, B] };
  const run = async () => {
    const s = loadPreset('scalp');
    const hx = harness(home(), [member('alpha', s, 500), member('beta', s, 200)], tape);
    const r = await runFleet(hx.opts);
    return { hx, r };
  };
  const one = await run();
  const two = await run();
  const { hx, r } = one;
  assert.deepEqual(r.members.map((m) => m.id), ['alpha', 'beta']);
  const [ra, rb] = r.members;
  assert.ok(ra.runId && rb.runId && ra.runId !== rb.runId, 'every strategy has its own run id');
  const la = hx.ledgers.get('alpha')!, lb = hx.ledgers.get('beta')!;
  assert.notEqual(la, lb);
  assert.ok(verifyChain(la.events).ok && verifyChain(lb.events).ok && verifyChain(hx.fleetLedger.events).ok, 'every ledger is its own hash chain');
  assert.equal(la.events[0].kind, 'fleet_member');
  assert.equal(la.events[0].member, 'alpha');
  assert.ok(buys(la).length >= 1 && buys(lb).length >= 1, 'both strategies traded the shared feed');
  assert.equal(ra.result!.book.strategy.bankroll.startUsd, 500);
  assert.equal(rb.result!.book.strategy.bankroll.startUsd, 200);
  const sizeA = Number(buys(la)[0].usd), sizeB = Number(buys(lb)[0].usd);
  assert.ok(sizeA > sizeB, `each book sizes from its own bankroll (${sizeA} vs ${sizeB})`);
  assert.ok(hx.events.every((x) => (x.member === 'alpha' ? x.runId === ra.runId : x.runId === rb.runId)), 'every event is tagged with its own strategy and run');
  // Deterministic: the same tape gives the same trades, fills and stats twice.
  const strip = (l: Ledger) => l.events.filter((e) => e.kind === 'fill' || e.kind === 'trade_closed').map((e) => ({ kind: e.kind, t: e.t, mint: e.mint, side: e.side, usd: e.usd }));
  assert.deepEqual(strip(two.hx.ledgers.get('alpha')!), strip(la));
  assert.deepEqual(strip(two.hx.ledgers.get('beta')!), strip(lb));
  assert.deepEqual(compareRows(two.r.status), compareRows(r.status));
  const ends = hx.fleetLedger.events.filter((e) => e.kind === 'member_end').map((e) => e.member);
  assert.deepEqual(ends.sort(), ['alpha', 'beta']);
  assert.equal(hx.fleetLedger.events.at(-1)!.kind, 'fleet_end');
});

test('1529 isolation: one strategy\'s breaker halts that strategy only', async () => {
  const s = loadPreset('scalp');
  const touchy: ResolvedStrategy = { ...s, risk: { ...s.risk, dailyLossHaltPct: 0.5 } };
  const calm: ResolvedStrategy = { ...s, risk: { ...s.risk, dailyLossHaltPct: 99 } };
  const ticks = [at(0), at(1), at(2), at(5, { price: 0.5 }), at(6, { price: 0.5 }), at(8, { mint: B }), at(9, { mint: B }), at(10, { mint: B }), at(11, { mint: B })];
  const hx = harness(home(), [member('touchy', touchy, 500), member('calm', calm, 500)], { source: 'synthetic', ticks, mints: [A, B] });
  const r = await runFleet(hx.opts);
  const lt = hx.ledgers.get('touchy')!, lc = hx.ledgers.get('calm')!;
  assert.ok(lt.events.some((e) => e.kind === 'trade_closed'), 'touchy lost on coin A');
  assert.ok(!buyMints(lt).includes(B), 'touchy\'s daily-loss breaker refused coin B');
  assert.ok(buyMints(lc).includes(B), 'calm took the same loss on coin A and still entered coin B');
  const st = r.status.members.find((m) => m.id === 'touchy')!;
  assert.ok(st.haltReason === 'daily-loss' || lt.events.some((e) => e.kind === 'halt' || String(e.reason ?? '').includes('daily-loss')), 'touchy names its breaker');
});

test('1529 per-strategy stop: only that strategy stops; the others keep entering; a global halt reaches every one', async () => {
  const h = home();
  const s = loadPreset('scalp');
  const ticks = [at(0), at(1), at(2), at(3), at(4, { mint: B }), at(5, { mint: B }), at(6, { mint: B }), at(7, { mint: B }), at(8, { mint: C }), at(9, { mint: C }), at(10, { mint: C }), at(11, { mint: C })];
  let asked = false;
  let globalStop = false;
  const hx = harness(h, [member('one', s, 300), member('two', s, 300)], { source: 'synthetic', ticks, mints: [A, B, C] }, {
    memberControl: true,
    onStatus: (st) => writeJsonAtomic(fleetStatusPath(h), st),
    globalSafety: () => (globalStop ? { halt: 'stop', detail: 'every strategy', flatten: false, pauseEntries: null, endWhenFlat: true } : OK),
  });
  hx.opts.hooks!.onMemberState = (m, _runId, st) => {
    if (m === 'one' && !asked && st.positions.length) { asked = true; const w = requestMemberControl(h, 'one', 'stop', 'cli'); assert.ok(w.ok, JSON.stringify(w)); }
    if (m === 'two' && st.t >= T0 + 8 * MIN) globalStop = true;
  };
  const r = await runFleet(hx.opts);
  const l1 = hx.ledgers.get('one')!, l2 = hx.ledgers.get('two')!;
  const h1 = l1.events.find((e) => e.kind === 'halt');
  assert.equal(h1?.reason, 'stop', 'one stopped');
  assert.equal(buys(l1).filter((e) => e.seq > h1!.seq).length, 0, 'no buy after its own stop');
  assert.ok(buyMints(l2).includes(B), 'two kept entering after one was stopped');
  assert.ok(hx.fleetLedger.events.some((e) => e.kind === 'fleet_halt' && e.reason === 'stop'), 'the global stop is in the fleet ledger');
  const h2 = l2.events.find((e) => e.kind === 'halt');
  assert.equal(h2?.reason, 'stop', 'the global stop reached two as well');
  assert.ok(!buyMints(l2).includes(C), 'no entry after the global stop');
  assert.equal(r.status.state, 'stopped');
  // A request for a stopped fleet, an unknown strategy, or a strategy that is not running is refused with a reason.
  writeJsonAtomic(fleetStatusPath(h), { ...r.status, state: 'running', heartbeatAt: Date.now() });
  const unknown = requestMemberControl(h, 'nope', 'stop', 'cli');
  assert.ok(!unknown.ok && /not one of the running strategies/.test(unknown.why));
  assert.ok(!requestMemberControl(h, 'one', 'pause', 'cli').ok, 'one is not running any more');
  const bad = requestMemberControl(h, '../etc', 'stop', 'cli');
  assert.ok(!bad.ok && /not a strategy id/.test(bad.why), 'a path is never a strategy id');
});

test('1529 per-strategy start: an idle strategy of the config starts at the next tick, paper, under its own run id', async () => {
  const h = home();
  const s = loadPreset('scalp');
  const ticks = [at(0), at(1), at(2), at(3, { mint: B }), at(4, { mint: B }), at(5, { mint: B }), at(6, { mint: B })];
  let asked = false;
  const hx = harness(h, [member('on', s, 300), member('later', s, 300, { enabled: false })], { source: 'synthetic', ticks, mints: [A, B] }, {
    memberControl: true,
    onStatus: (st) => writeJsonAtomic(fleetStatusPath(h), st),
  });
  hx.opts.hooks!.onMemberState = (m, _r, st) => {
    if (m === 'on' && !asked && st.t >= T0 + 2 * MIN) { asked = true; const w = requestMemberControl(h, 'later', 'start', 'mcp'); assert.ok(w.ok, JSON.stringify(w)); }
  };
  const r = await runFleet(hx.opts);
  const later = r.members.find((m) => m.id === 'later')!;
  assert.ok(later.runId, 'later started');
  assert.equal(readMemberControl(h, 'later'), null, 'the start request is consumed');
  assert.ok(hx.fleetLedger.events.some((e) => e.kind === 'member_control' && e.member === 'later' && e.by === 'mcp'));
  assert.ok(!buyMints(hx.ledgers.get('later')!).includes(A), 'it never saw the ticks before it started');
});

test('1529 an unreadable control file halts that strategy only (fail closed)', async () => {
  const h = home();
  const s = loadPreset('scalp');
  const ticks = [at(0), at(1), at(2), at(3), at(4)];
  const hx = harness(h, [member('xx', s, 300), member('yy', s, 300)], { source: 'synthetic', ticks, mints: [A] }, { memberControl: true });
  let done = false;
  hx.opts.hooks!.onMemberState = () => { if (!done) { done = true; writeFileSync(memberControlPath(h, 'xx'), '{garbage'); } };
  const r = await runFleet(hx.opts);
  assert.equal(r.status.members.find((m) => m.id === 'xx')!.haltReason, 'control-unreadable');
  assert.notEqual(r.status.members.find((m) => m.id === 'yy')!.haltReason, 'control-unreadable');
  assert.ok(buys(hx.ledgers.get('yy')!).length >= 1, 'yy traded on');
});

test('1529 global guard: $/day and sessions/day are shared across strategies; each strategy\'s own cap holds too', () => {
  let now = T0;
  const runner = DEFAULT_RUNNER_CONFIG;
  const fleet = new FleetGuard({ ...DEFAULT_GLOBAL_CAPS, modelUsdPerDay: 1, candidateSessionsPerDay: 3 }, runner, { clock: () => now, loadavg: () => 0 });
  const s = loadPreset('scalp');
  const a = new MemberGate('a', memberCaps(s, runner, { modelUsdPerDay: 0.5 }), runner, fleet, { clock: () => now });
  const b = new MemberGate('b', memberCaps(s, runner, {}), runner, fleet, { clock: () => now });
  a.turn(0.5);
  assert.equal(a.canOpen('candidate', 0).ok, false, 'a reached its own $0.50');
  assert.equal(why(a.canOpen('candidate', 0)), 'day-model-usd');
  assert.equal(b.canOpen('candidate', 0).ok, true, 'b is under both caps');
  b.turn(0.5);
  const c = b.canOpen('candidate', 0);
  assert.equal(c.ok, false, 'together they reached the fleet\'s $1');
  assert.equal(why(c), 'fleet-day-model-usd');
  assert.equal(b.overDay(), 'fleet-day-model-usd');
  // sessions/day across strategies
  const f2 = new FleetGuard({ ...DEFAULT_GLOBAL_CAPS, candidateSessionsPerDay: 3 }, runner, { clock: () => now, loadavg: () => 0 });
  const x = new MemberGate('x', memberCaps(s, runner, {}), runner, f2, { clock: () => now });
  const y = new MemberGate('y', memberCaps(s, runner, {}), runner, f2, { clock: () => now });
  x.opened('candidate'); x.opened('candidate'); y.opened('candidate');
  assert.equal(why(y.canOpen('candidate', 0)), 'fleet-day-candidate-sessions');
  assert.equal(why(x.canOpen('candidate', 0)), 'fleet-day-candidate-sessions');
  now += 86_400_000;
  assert.equal(x.canOpen('candidate', 0).ok, true, 'a new wall-clock day resets the fleet counters');
  // the stricter of runner.json and autotrade.json global wins
  const tight = new FleetGuard({ ...DEFAULT_GLOBAL_CAPS, modelUsdPerDay: 500 }, { ...runner, caps: { ...runner.caps, modelUsdPerDay: 3 } }, { loadavg: () => 0 });
  assert.equal(tight.caps.modelUsdPerDay, 3);
  // a member cap can only tighten
  assert.equal(memberCaps(s, runner, { modelUsdPerDay: 10_000 }).modelUsdPerDay, memberCaps(s, runner, {}).modelUsdPerDay);
});

test('1529 global guard: model sessions open at once across strategies, one rate-limit reading applies to all, one load check', async () => {
  const runner = DEFAULT_RUNNER_CONFIG;
  let load = 0;
  let now = T0;
  const fleet = new FleetGuard({ ...DEFAULT_GLOBAL_CAPS, maxConcurrentSessions: 2 }, runner, { clock: () => now, loadavg: () => load, load: { pauseAboveLoad1m: 10, resumeBelowLoad1m: 8, sustainSec: 60 } });
  const s = loadPreset('scalp');
  const a = new MemberGate('a', memberCaps(s, runner, {}), runner, fleet, { clock: () => now });
  const b = new MemberGate('b', memberCaps(s, runner, {}), runner, fleet, { clock: () => now });
  const fa = fleet.track('a', goer), fb = fleet.track('b', goer);
  const s1 = fa('s1', {} as never, {} as never), s2 = fb('s2', {} as never, {} as never);
  assert.equal(fleet.live, 2);
  assert.equal(why(b.canOpen('candidate', 0)), 'fleet-max-sessions', 'two sessions open: a third waits, whichever strategy asks');
  await s1.close('done'); await s1.close('again');
  assert.equal(fleet.live, 1, 'a double close counts once');
  assert.equal(b.canOpen('candidate', 0).ok, true);
  await s2.close('done');
  a.rateLimit({ fiveHour: 0.95, sevenDay: 0.1, resetsAt: null } as never);
  assert.equal(b.canOpen('candidate', 0).ok, false, 'a reading from a\'s session pauses b (one account)');
  const f3 = new FleetGuard(DEFAULT_GLOBAL_CAPS, runner, { clock: () => now, loadavg: () => load, load: { pauseAboveLoad1m: 10, resumeBelowLoad1m: 8, sustainSec: 60 } });
  const m = new MemberGate('m', memberCaps(s, runner, {}), runner, f3, { clock: () => now });
  load = 30;
  m.canOpen('candidate', 0);
  now += 61_000;
  assert.equal(why(m.canOpen('candidate', 0)), 'fleet-load-high', 'a sustained high load pauses new sessions for every strategy');
  load = 5; now += 6000;
  assert.equal(m.canOpen('candidate', 0).ok, true, 'and lifts below the resume mark');
});

test('1529 the global $/day holds across strategies in a replay', async () => {
  const s = loadPreset('scalp');
  const ticks: MarketTick[] = [];
  const mints = ['D', 'E', 'F', 'G', 'H', 'I'].map((c) => `${c.repeat(4)}1111111111111111111111111111111111111111`);
  mints.forEach((m, i) => { for (let j = 0; j < 3; j++) ticks.push(at(i * 3 + j, { mint: m })); });
  const caps = { ...DEFAULT_GLOBAL_CAPS, candidateSessionsPerDay: 3 };
  const hx = harness(home(), [member('p', s, 300), member('q', s, 300)], { source: 'synthetic', ticks, mints }, {}, caps);
  const r = await runFleet(hx.opts);
  const opened = (l: Ledger) => l.events.filter((e) => e.kind === 'session_start').length;
  const total = opened(hx.ledgers.get('p')!) + opened(hx.ledgers.get('q')!);
  assert.ok(total <= 3, `three candidate sessions a day across both strategies, opened ${total}`);
  assert.ok(total >= 2, 'both strategies could use the shared allowance');
  assert.equal(r.status.global.today.candidateSessions, total);
});

test('1529 autotrade.json: ids unique, preset XOR file, absolute files, live refused in this build, defaults filled', () => {
  const ok = parseFleetConfig({ schema: 'dexterm-autotrade/1', strategies: [{ id: 'moon-a', preset: 'moonbag', bankroll: { usd: 500 } }, { id: 'yolo', preset: 'scalp', bankroll: { sol: 1 }, caps: { maxSessions: 1 } }] });
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.equal(ok.config.strategies[0].mode, 'paper');
    assert.equal(ok.config.strategies[1].enabled, true);
    assert.deepEqual(ok.config.global, DEFAULT_GLOBAL_CAPS);
  }
  const bad = (doc: unknown, re: RegExp) => { const r = parseFleetConfig(doc); assert.ok(!r.ok, JSON.stringify(doc)); assert.match((r as { errors: string[] }).errors.join('\n'), re); };
  bad({ schema: 'dexterm-autotrade/1', strategies: [{ id: 'aa', preset: 'scalp' }, { id: 'aa', preset: 'moonbag' }] }, /used twice/);
  bad({ schema: 'dexterm-autotrade/1', strategies: [{ id: 'aa', preset: 'scalp', file: '/x.json' }] }, /exactly one of preset or file/);
  bad({ schema: 'dexterm-autotrade/1', strategies: [{ id: 'aa', file: 'rel.json' }] }, /absolute/);
  bad({ schema: 'dexterm-autotrade/1', strategies: [{ id: 'aa', preset: 'scalp', mode: 'live' }] }, /live execution is not available/);
  bad({ schema: 'dexterm-autotrade/1', strategies: [] }, /no strategy/);
  bad({ schema: 'dexterm-autotrade/1', strategies: [{ id: 'aa', preset: 'scalp', privateKey: 'x' }] }, /./);
  bad({ schema: 'dexterm-autotrade/1', strategies: Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, preset: 'scalp' })) }, /./);
  assert.deepEqual(bankrollUsd({ sol: 1 }, 150), { usd: 150 });
  assert.ok(bankrollUsd({ sol: 1 }, null).error);
  const base = loadPreset('scalp');
  const m1 = memberStrategy(base, { id: 'a', preset: 'scalp', mode: 'paper', enabled: true, caps: {} }, 500);
  const m2 = memberStrategy(base, { id: 'b', preset: 'scalp', mode: 'paper', enabled: true, caps: {} }, 200);
  assert.notEqual(m1.strategy.hash, m2.strategy.hash, 'two members on one preset hash differently');
  assert.equal(m1.basedOn.hash, base.hash);
});

test('1529 executors: paper members get their own books; live members share ONE port per trading wallet; live refused without a port', async () => {
  const s = loadPreset('scalp');
  const made: string[] = [];
  const fake = (name: string) => ({ name } as unknown as Executor);
  const r = bindExecutors([
    { id: 'p1', mode: 'paper', strategy: s }, { id: 'p2', mode: 'paper', strategy: s },
    { id: 'l1', mode: 'live', wallet: 'w', strategy: s }, { id: 'l2', mode: 'live', wallet: 'w', strategy: s },
  ], { paper: (m) => { made.push(m.id); return fake(`paper-${m.id}`); }, live: (w) => { made.push(`live-${w}`); return fake(`live-${w}`); } });
  assert.ok(r.ok);
  if (r.ok) {
    assert.notEqual(r.executors.get('p1'), r.executors.get('p2'));
    assert.equal(r.executors.get('l1'), r.executors.get('l2'), 'both live strategies meet the same signer port, so its caps hold for both together');
    assert.equal(r.livePorts, 1);
  }
  assert.deepEqual(made, ['p1', 'p2', 'live-w']);
  const no = bindExecutors([{ id: 'l1', mode: 'live', strategy: s }], { paper: () => fake('x') });
  assert.ok(!no.ok);
  const s2 = loadPreset('scalp');
  await assert.rejects(runFleet(harness(home(), [member('l', s2, 100, { mode: 'live' })], { source: 'synthetic', ticks: [at(0)], mints: [A] }).opts), /live execution is not available/);
});

test('1529 shared dossier: two strategies asking for one coin cost one fetch', async () => {
  let n = 0;
  let now = T0;
  const d = sharedDossier(async (m) => { n++; return { m }; }, 30_000, () => now);
  await Promise.all([d.get(A), d.get(A), d.get(B)]);
  assert.equal(n, 2);
  now += 31_000;
  await d.get(A);
  assert.equal(d.fetches(), 3);
});

test('1529 verdicts, tagged events, the comparison table', () => {
  const g: SafetyVerdict = { halt: 'kill-switch', detail: 'panic', flatten: false, pauseEntries: null, endWhenFlat: false };
  const m: SafetyVerdict = { halt: 'stop', detail: 'mine', flatten: true, pauseEntries: 'paused', endWhenFlat: true };
  assert.deepEqual(mergeVerdicts(g, m), { halt: 'kill-switch', detail: 'panic', flatten: true, pauseEntries: 'paused', endWhenFlat: true });
  assert.deepEqual(mergeVerdicts(OK, OK), OK);
  const got: LedgerEvent[] = [];
  const hooks = strategyTaggedHooks({ onEvent: (e) => got.push(e) });
  hooks.onMemberEvent!('yolo', 'run-1', { seq: 1, t: 0, kind: 'fill' } as LedgerEvent);
  assert.equal(got[0].strategyId, 'yolo');
  assert.equal(got[0].runId, 'run-1');
  const st = {
    members: [
      { id: 'a', state: 'running', basedOn: { id: 'scalp', version: '1' }, bankroll: { usd: 500 }, book: { startUsd: 500, equityUsd: 550, cashUsd: 0, realizedTodayUsd: 0 }, open: [{}], stats: { closed: 4, wins: 3, losses: 1, entries: 5, enteredUsd: 400, rugExits: 1, rugCostUsd: 40, missedRunners: 2, spendUsd: 0.5 } },
      { id: 'b', state: 'idle', basedOn: { id: 'moonbag', version: '2' }, bankroll: { usd: 200 }, book: null, open: [], stats: { closed: 0, wins: 0, losses: 0, entries: 0, enteredUsd: 0, rugExits: 0, rugCostUsd: 0, missedRunners: 0, spendUsd: 0 } },
    ],
  } as unknown as FleetStatus;
  const rows = compareRows(st);
  assert.deepEqual([rows[0].pnlUsd, rows[0].pnlPct, rows[0].winRatePct, rows[0].rugExposurePct, rows[0].spendPerEntryUsd], [50, 10, 75, 10, 0.1]);
  assert.deepEqual([rows[1].pnlUsd, rows[1].winRatePct, rows[1].spendPerEntryUsd], [null, null, null]);
  const t = compareTable(rows);
  assert.match(t[0], /^STRATEGY/);
  assert.equal(new Set(t.map((l) => l.length)).size, 1, 'the columns line up');
  assert.equal(fleetTotals(st).pnlUsd, 50);
  // A status file that claims anything but paper is never shown.
  const h = home();
  writeJsonAtomic(fleetStatusPath(h), { schema: 'dexterm-autotrade-fleet/1', mode: 'live', fleetId: 'f', heartbeatAt: 0, members: [], global: {} });
  assert.ok(!readFleetStatus(h).ok);
});
