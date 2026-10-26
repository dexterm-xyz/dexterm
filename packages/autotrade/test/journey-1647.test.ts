// task-1647 (0.2.0 card C): the strategy journey and forward tests, library level. The ladder draft → backtested →
// forward-tested → always-on → real counts only evidence on the exact rules (rules hash), never skips a rung, and
// verdict rule 6 is the only path to gain wording. Forward tests: frozen paper strategy, own bankroll, window, stop
// marker, panic file, replay never counts. Fakes only: the fixture tape, no network, no model, no key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { presetPath, validateStrategy, type ResolvedStrategy, type Strategy } from '../src/strategy.ts';
import { loadTape, type MarketTick, type Tape } from '../src/replay.ts';
import {
  applyAlwaysOn, backtestEvidence, checkPromotion, compareForward, evidenceVerdict, journeyView, loadJourney, markRealApplied, proposePromotion, PromotionFiles,
  recordBacktestEvidence, rulesHash, EVIDENCE_MIN_N, type JourneyMetrics,
} from '../src/journey.ts';
import {
  FORWARD_LIMITS, createForwardTest, findForwardTest, forwardReport, forwardSummaryPath, hostForward, liveState, listForwardTests, loadForwardTest, requestForwardStop, saveForwardTest,
} from '../src/forward.ts';
import { fleetConfigPath, parseFleetConfig } from '../src/fleet-config.ts';
import { readLedgerFile, verifyChain } from '../src/ledger.ts';
import { emptyLimits, planLimitsSave, saveLimits } from '../src/limits.ts';

const TAPE = fileURLToPath(new URL('./fixtures/autotrade-1498-tape.json', import.meta.url));
const T0 = Date.UTC(2026, 9, 24, 12);

function home(): string { return mkdtempSync(join(tmpdir(), 'dexterm-1647-')); }
function raw(id = 'my-moon', over: Partial<Strategy> = {}): Strategy {
  return { ...JSON.parse(readFileSync(presetPath('moonbag'), 'utf8')), id, name: 'My moon', version: '1.0.0', ...over } as Strategy;
}
function resolved(r: Strategy): ResolvedStrategy { const v = validateStrategy(r); assert.ok(v.ok, JSON.stringify(!v.ok && v.errors)); return v.strategy; }
/** A live-shaped stream over the fixture tape (what the data layer hands a forward test, minus the network). */
function feed(tape: Tape, name = 'live keyless data layer (test feed)'): { name: string; ticks: AsyncIterable<MarketTick>; stop: () => void } {
  let stopped = false;
  return { name, stop: () => { stopped = true; }, ticks: (async function* () { for (const k of tape.ticks) { if (stopped) return; yield k; } })() };
}
const M = (o: Partial<JourneyMetrics>): JourneyMetrics => ({ trades: 0, wins: 0, losses: 0, winRate: null, netUsd: 0, netPct: 0, maxDrawdownPct: 0, rugs: 0, rugRatePct: null, openAtEnd: 0, fillCostBps: null, fills: 0, ...o });

test('rules hash: a rename, a version bump or arming (mode real) keeps the evidence; a rule change does not', () => {
  const a = resolved(raw());
  assert.equal(rulesHash(a), rulesHash(resolved(raw('my-moon', { name: 'Renamed', version: '1.0.7', description: 'other words' }))));
  assert.equal(rulesHash(a), rulesHash(resolved(raw('my-moon', { mode: 'real' }))));
  const r2 = raw(); r2.risk = { ...r2.risk, maxConcurrent: r2.risk.maxConcurrent + 1 };
  assert.notEqual(rulesHash(a), rulesHash(resolved(r2)));
});

test('verdict rule 6: >= 20 trades in BOTH halves and a held-out net above 0, nothing less', () => {
  assert.equal(evidenceVerdict({ trades: 19, netUsd: 50 }, { trades: 40, netUsd: 50 }).claim, false);
  assert.equal(evidenceVerdict({ trades: 40, netUsd: 50 }, { trades: 19, netUsd: 50 }).claim, false);
  assert.match(evidenceVerdict({ trades: 3, netUsd: 1 }, { trades: 3, netUsd: 1 }).verdict, /too few trades to claim anything/);
  const flat = evidenceVerdict({ trades: 30, netUsd: 80 }, { trades: 20, netUsd: 0 });
  assert.equal(flat.claim, false);
  assert.match(flat.verdict, /no edge/);
  assert.equal(evidenceVerdict({ trades: EVIDENCE_MIN_N, netUsd: -5 }, { trades: EVIDENCE_MIN_N, netUsd: 0.01 }).claim, true);
});

test('backtest evidence runs the strategy on each half of the held-out split and binds to the rules hash', async () => {
  const h = home();
  const s = resolved(raw());
  const { evidence, report } = await backtestEvidence(s, loadTape(TAPE), { by: 'user', now: T0, days: 7 });
  assert.equal(evidence.full.trades, report.trades);
  assert.equal(evidence.heldOut.train.trades + evidence.heldOut.test.trades > 0, true);
  assert.equal(evidence.rulesHash, rulesHash(s));
  assert.equal(evidence.claim, false, 'the fixture tape is far below n = 20');
  assert.match(evidence.verdict, /too few trades/);
  assert.equal(journeyView(h, s).stage, 'draft');
  recordBacktestEvidence(h, evidence);
  const v = journeyView(h, s);
  assert.equal(v.stage, 'backtested');
  assert.equal(v.next?.stage, 'forward-tested');
  // a rule change starts the ladder again
  const r2 = raw(); r2.risk = { ...r2.risk, maxConcurrent: r2.risk.maxConcurrent + 1 };
  assert.equal(journeyView(h, resolved(r2)).stage, 'draft');
});

test('compareForward: no rate is compared below 20 forward trades, and gain wording needs rule 6 AND a forward net > 0 on >= 20', () => {
  const bt = { kind: 'backtest', t: T0, by: 'user', id: 'x', version: '1.0.0', hash: 'h', rulesHash: 'r', days: 7, tape: { source: 't', mints: 1, ticks: 1, from: null, to: null },
    full: M({ trades: 60, winRate: { value: 40, lo: 30, hi: 50 }, netUsd: 100, maxDrawdownPct: 10, rugRatePct: 5, rugs: 3, fillCostBps: 100 }),
    heldOut: { cutoff: null, train: M({ trades: 40, netUsd: 60 }), test: M({ trades: 20, netUsd: 40 }) }, verdict: 'v', claim: true } as const;
  const small = compareForward(bt, M({ trades: 4, netUsd: 30, winRate: { value: 100, lo: 51, hi: 100 } }));
  assert.equal(small.claim, false);
  assert.equal(small.sampleOk, false);
  assert.ok(small.verdict.some((l) => /too small a sample to claim anything/.test(l)));
  assert.equal(small.rows[1].note, '', 'a 4-trade win rate is never called a drift');
  const big = compareForward(bt, M({ trades: 25, netUsd: 12, winRate: { value: 20, lo: 9, hi: 39 }, maxDrawdownPct: 22, rugRatePct: 20, rugs: 5, fillCostBps: 160 }));
  assert.equal(big.claim, true);
  assert.match(big.rows[1].note, /outside the backtest interval/);
  assert.match(big.rows[3].note, /deeper/);
  assert.match(big.rows[5].note, /drift \+60 bps/);
  const lost = compareForward(bt, M({ trades: 25, netUsd: -1 }));
  assert.equal(lost.claim, false);
  assert.ok(lost.verdict.some((l) => /lost money on live data/.test(l)));
  assert.equal(compareForward(null, M({ trades: 30, netUsd: 5 })).claim, false, 'no backtest, no claim');
});

test('forward test limits: a window is required and bounded, one per strategy, three at once, never agent+approve or live', () => {
  const h = home();
  const r = raw();
  const s = resolved(r);
  assert.match((createForwardTest(h, s, r, { by: 'user' }) as { why: string }).why, /needs a window/);
  assert.match((createForwardTest(h, s, r, { by: 'user', hours: 0.1 }) as { why: string }).why, /hours must be/);
  assert.match((createForwardTest(h, s, r, { by: 'user', hours: FORWARD_LIMITS.maxHours + 1 }) as { why: string }).why, /hours must be/);
  assert.match((createForwardTest(h, s, r, { by: 'user', trades: 0 }) as { why: string }).why, /trades must be/);
  assert.match((createForwardTest(h, s, r, { by: 'user', trades: 2.5 }) as { why: string }).why, /trades must be/);
  assert.match((createForwardTest(h, s, r, { by: 'user', hours: 1, bankrollUsd: 5 }) as { why: string }).why, /bankroll/);
  const ap = raw('my-ap'); ap.entry = { ...ap.entry, decide: 'agent+approve' };
  assert.match((createForwardTest(h, resolved(ap), ap, { by: 'user', hours: 1 }) as { why: string }).why, /approval/);
  const live = raw('my-live', { mode: 'live' });
  assert.match((createForwardTest(h, resolved(live), live, { by: 'user', hours: 1 }) as { why: string }).why, /mode live/);
  const a = createForwardTest(h, s, r, { by: 'user', hours: 2, now: Date.now() });
  assert.ok(a.ok);
  saveForwardTest(h, { ...a.test, state: 'running', pid: process.pid, heartbeatAt: Date.now() });
  assert.match((createForwardTest(h, s, r, { by: 'user', hours: 1 }) as { why: string }).why, /already has a forward test running/);
  for (const id of ['my-b', 'my-c']) { const x = raw(id); const c = createForwardTest(h, resolved(x), x, { by: 'user', hours: 1 }); assert.ok(c.ok); }
  const d = raw('my-d');
  assert.match((createForwardTest(h, resolved(d), d, { by: 'user', hours: 1 }) as { why: string }).why, /at most 3 at once/);
  // a host that died is `lost`, not running
  const t = loadForwardTest(h, a.test.forwardId)!;
  assert.equal(liveState({ ...t, pid: 999_999_999 }, Date.now(), () => false), 'lost');
  assert.equal(liveState({ ...t, heartbeatAt: Date.now() - 10 * 60_000 }, Date.now(), () => true), 'lost');
});

test('a forward test runs the frozen PAPER twin with its own bankroll, own ledger, ends at its trade window, flattens, records the rung and the arm-panel summary', async () => {
  const h = home();
  const r = raw('my-moon', { mode: 'real' }); // a real strategy forward-tests as its paper twin: no signal ever
  const s = resolved(r);
  recordBacktestEvidence(h, (await backtestEvidence(s, loadTape(TAPE), { by: 'user', now: T0 })).evidence);
  const c = createForwardTest(h, s, r, { by: 'analyst', trades: 2, bankrollUsd: 400 });
  assert.ok(c.ok);
  assert.equal(c.test.doc.mode, 'paper');
  assert.equal(c.test.doc.bankroll.startUsd, 400);
  const res = await hostForward({ home: h, forwardId: c.test.forwardId, source: feed(loadTape(TAPE)), sessions: null, pacing: { mode: 'lockstep' } });
  assert.ok(res.ok);
  const t = res.test;
  assert.equal(t.state, 'done', t.endReason ?? '');
  assert.match(t.endReason ?? '', /window reached \(\d+ closed trades\)/);
  assert.ok(t.metrics && t.metrics.trades >= 2);
  assert.equal(t.metrics!.openAtEnd, 0, 'the window end flattens: closed numbers only');
  assert.ok(!existsSync(join(h, 'autotrade', 'real')), 'a forward test never touches real mode');
  const ev = readLedgerFile(join(h, 'autotrade', 'runs', `${t.runId}.jsonl`));
  assert.ok(verifyChain(ev).ok);
  assert.equal(ev[0].kind, 'forward_start');
  assert.ok(ev.some((e) => e.kind === 'run_start' && e.mode === 'paper'));
  assert.equal(ev[ev.length - 1].kind, 'forward_end');
  const j = loadJourney(h, s.id);
  assert.equal(j.forwards[0].state, 'done');
  assert.equal(journeyView(h, s).rungs.find((x) => x.stage === 'forward-tested')!.ok, true);
  const sum = JSON.parse(readFileSync(forwardSummaryPath(h, s.id), 'utf8'));
  assert.equal(sum.counted, true);
  assert.match(sum.summary, /too few trades to claim anything/);
  const rep = forwardReport(h, t);
  assert.ok(rep.lines.some((l) => /forward vs backtest of the same rules/.test(l)));
  assert.ok(rep.lines.some((l) => /too small a sample/.test(l)));
  assert.equal(findForwardTest(h, s.id)!.forwardId, t.forwardId);
  // runs once
  assert.equal((await hostForward({ home: h, forwardId: t.forwardId, source: feed(loadTape(TAPE)), sessions: null })).ok, false);
});

test('a forward test stopped early, on a replay, or under the panic switch is shown but never the forward-tested rung', async () => {
  const h = home();
  const r = raw();
  const s = resolved(r);
  recordBacktestEvidence(h, (await backtestEvidence(s, loadTape(TAPE), { by: 'user', now: T0 })).evidence);
  // stop marker
  const a = createForwardTest(h, s, r, { by: 'user', hours: 48 });
  assert.ok(a.ok);
  saveForwardTest(h, { ...a.test, state: 'running', pid: process.pid, heartbeatAt: Date.now() });
  assert.ok(requestForwardStop(h, a.test.forwardId, 'cli').ok);
  saveForwardTest(h, { ...loadForwardTest(h, a.test.forwardId)!, state: 'starting' });
  const ra = await hostForward({ home: h, forwardId: a.test.forwardId, source: feed(loadTape(TAPE)), sessions: null, pacing: { mode: 'lockstep' } });
  assert.ok(ra.ok);
  assert.equal(ra.test.state, 'stopped');
  assert.match(ra.test.endReason ?? '', /stopped early by cli/);
  // replay: done in the file, never counted
  const b = createForwardTest(h, s, r, { by: 'user', trades: 1, source: 'replay fixture' });
  assert.ok(b.ok);
  const rb = await hostForward({ home: h, forwardId: b.test.forwardId, tape: loadTape(TAPE), sessions: null, pacing: { mode: 'lockstep' } });
  assert.ok(rb.ok);
  assert.equal(rb.test.state, 'done');
  assert.equal(loadJourney(h, s.id).forwards[0].state, 'stopped', 'a replay is a backtest in disguise');
  assert.equal(JSON.parse(readFileSync(forwardSummaryPath(h, s.id), 'utf8')).counted, false);
  // panic
  const c = createForwardTest(h, s, r, { by: 'user', hours: 48 });
  assert.ok(c.ok);
  const rc = await hostForward({ home: h, forwardId: c.test.forwardId, source: feed(loadTape(TAPE)), sessions: null, pacing: { mode: 'lockstep' }, killSwitch: { engaged: () => ({ reason: 'test panic' }) } });
  assert.ok(rc.ok);
  assert.equal(rc.test.state, 'stopped');
  assert.match(rc.test.endReason ?? '', /panic/);
  // a live stream that ends before the window is an early end
  const d = createForwardTest(h, s, r, { by: 'user', trades: 200 });
  assert.ok(d.ok);
  const rd = await hostForward({ home: h, forwardId: d.test.forwardId, source: feed(loadTape(TAPE)), sessions: null, pacing: { mode: 'lockstep' } });
  assert.equal(rd.ok && rd.test.state, 'stopped');
  assert.equal(journeyView(h, s).stage, 'backtested');
  assert.equal(listForwardTests(h).length, 4);
});

test('promotions: no rung is skipped; always-on joins autotrade.json (other members kept); real is only ever marked by the arm flow', async () => {
  const h = home();
  const r = raw();
  const s = resolved(r);
  assert.equal(checkPromotion(h, s, 'always-on').ok, false);
  assert.match((proposePromotion(h, s, 'real', { actor: 'analyst', why: 'go' }) as { why: string }).why, /needs always-on first/);
  assert.equal((proposePromotion(h, s, 'live', { actor: 'analyst', why: 'go' }) as { reason: string }).reason, 'bad-target');
  assert.equal((proposePromotion(h, s, 'backtested', { actor: 'analyst', why: 'go' }) as { reason: string }).reason, 'bad-target');
  recordBacktestEvidence(h, (await backtestEvidence(s, loadTape(TAPE), { by: 'user', now: T0 })).evidence);
  assert.match((proposePromotion(h, s, 'always-on', { actor: 'analyst', why: 'go' }) as { why: string }).why, /needs forward-tested first/);
  const f = createForwardTest(h, s, r, { by: 'user', trades: 1 });
  assert.ok(f.ok);
  await hostForward({ home: h, forwardId: f.test.forwardId, source: feed(loadTape(TAPE)), sessions: null, pacing: { mode: 'lockstep' } });
  assert.equal(journeyView(h, s).stage, 'forward-tested');
  // the user's existing autotrade.json keeps its members
  mkdirSync(join(h, 'autotrade'), { recursive: true });
  writeFileSync(fleetConfigPath(h), JSON.stringify({ schema: 'dexterm-autotrade/1', strategies: [{ id: 'theirs', preset: 'scalp', bankroll: { usd: 300 } }], global: { modelUsdPerDay: 4 } }));
  const p = proposePromotion(h, s, 'always-on', { actor: 'analyst', why: 'forward test done', now: T0 });
  assert.ok(p.ok);
  assert.ok(p.proposal.card.some((l) => /PROMOTE my-moon v1\.0\.0 → ALWAYS-ON/.test(l)));
  assert.ok(p.proposal.card.some((l) => /no performance claim/.test(l)));
  const twin = proposePromotion(h, s, 'always-on', { actor: 'analyst', why: 'again' });
  assert.ok(twin.ok && twin.duplicate);
  // an edit since the proposal voids it
  const edited = resolved(raw('my-moon', { version: '1.0.1', name: 'changed' }));
  assert.match((applyAlwaysOn(h, p.proposal.proposalId, edited, { by: 'user' }) as { why: string }).why, /changed since the proposal/);
  const a = applyAlwaysOn(h, p.proposal.proposalId, s, { by: 'user' });
  assert.ok(a.ok, JSON.stringify(a));
  const doc = JSON.parse(readFileSync(fleetConfigPath(h), 'utf8'));
  assert.deepEqual(doc.strategies.map((m: { id: string }) => m.id), ['theirs', 'my-moon']);
  assert.equal(doc.global.modelUsdPerDay, 4);
  assert.ok(parseFleetConfig(doc).ok);
  assert.equal(new PromotionFiles(h).get(p.proposal.proposalId)!.status, 'applied');
  assert.equal(journeyView(h, s).stage, 'always-on');
  assert.equal(applyAlwaysOn(h, p.proposal.proposalId, s, { by: 'user' }).ok, false, 'applies once');
  // task-1679: the evidence floor. A 1-trade forward test is below the placeholder minForwardTrades 10: refused.
  const below = proposePromotion(h, s, 'real', { actor: 'analyst', why: 'next' });
  assert.equal(!below.ok && below.reason, 'evidence-floor');
  assert.match((below as { why: string }).why, /closed \d+ paper trades?; real needs at least 10/);
  // The user lowers the floor themselves (a raise: in the CLI, their typed phrase).
  const lowered = { ...emptyLimits(), global: { minForwardTrades: 0 } };
  const plan = planLimitsSave(h, lowered);
  assert.ok(saveLimits(h, lowered, { confirmed: plan.raised, baseline: plan.baseline }).ok);
  // real: proposable now, never applied by the library; the arm flow marks it
  const pr = proposePromotion(h, s, 'real', { actor: 'analyst', why: 'next' });
  assert.ok(pr.ok);
  assert.match((applyAlwaysOn(h, pr.proposal.proposalId, s, { by: 'user' }) as { why: string }).why, /signal arm/);
  const real = resolved(raw('my-moon', { mode: 'real', version: '1.0.1' }));
  assert.equal(journeyView(h, real, { armedHash: null }).stage, 'always-on', 'mode real without an arming at this hash is not the real rung');
  assert.deepEqual(markRealApplied(h, s.id, real.hash, real.version, 'user:signal-arm'), [pr.proposal.proposalId]);
  const v = journeyView(h, real, { armedHash: real.hash });
  assert.equal(v.stage, 'real');
  assert.ok(v.notes.some((n) => /do not run in the always-on paper service/.test(n)));
  const lines = readFileSync(join(h, 'autotrade', 'journey', 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => `${l.to}:${l.action}:${l.by}`), ['always-on:proposed:analyst', 'always-on:applied:user', 'real:proposed:analyst', 'real:applied:user:signal-arm']);
});

test('live data: the hours window runs on the wall clock, so a feed whose tick time stalls (cached rows) still ends', async () => {
  const h = home();
  const r = raw();
  const s = resolved(r);
  const c = createForwardTest(h, s, r, { by: 'user', hours: 1 });
  assert.ok(c.ok);
  const tape = loadTape(TAPE);
  const frozen = tape.ticks[0].t;
  let wall = 1_800_000_000_000;
  let n = 0;
  // every tick carries the SAME time (what the live source does with cached rows); the wall clock moves on
  const stalled = { name: 'live (stalled test feed)', stop: () => {}, ticks: (async function* () { for (; n < 4000; n++) { if (n === 50) wall += 2 * 3_600_000; yield { ...tape.ticks[n % tape.ticks.length], t: frozen }; } })() };
  const res = await hostForward({ home: h, forwardId: c.test.forwardId, source: stalled, sessions: null, pacing: { mode: 'live' }, now: () => wall });
  assert.ok(res.ok);
  assert.equal(res.test.state, 'done', res.test.endReason ?? '');
  assert.match(res.test.endReason ?? '', /window reached \(1 h\)/);
  assert.ok(n < 4000, 'it ended on the wall clock, not at the end of the feed');
});
