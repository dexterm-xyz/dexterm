// task-2159: the strategy factory. Fakes only: the fixture tape, a stub analyst (no Claude, no spend), temp homes.
// Covers: the output-number cross-check, duplicate-hash rejection, cap enforcement, the stop-file halt,
// confirm-before-apply in chat, and that no chat change has a path to real mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTape, type Tape } from '../src/replay.ts';
import { presetPath, validateStrategy, type Strategy } from '../src/strategy.ts';
import { StrategyStore } from '../src/store.ts';
import { loadJourney, recordForwardResult, rulesHash } from '../src/journey.ts';
import { createForwardTest, saveForwardTest, loadForwardTest } from '../src/forward.ts';
import { fleetConfigPath } from '../src/fleet-config.ts';
import {
  appendSpend, buildCandidate, CHANGE_ACTIONS, claudeAnalyst, checkChange, confirmChange, crossCheck, DEFAULT_FACTORY_CONFIG, factoryInstallPlan, factoryLessonsPath, factoryStatus, gatherEvidence,
  housekeeping, lessonsForPrompt, listGenerated, loadFactoryConfig, loadGenerated, numbersIn, opsPolicyProblems, parseFactoryConfig, parseProposal, previewChange, REAL_REFUSAL,
  renderFactoryLaunchAgent, runFactory, factorySlots, describeFactorySchedule, heldOutLoses, heldOutVerdict, vmStatAvailableMb, memInfoAvailableMb, buildPrompt, wordingProblems, saveFactoryConfig, stubAnalyst, writeFactoryStop, clearFactoryStop, type ChatTurn, type FactoryAnalyst, type FactoryInstallSpec, type Proposal,
} from '../src/factory/index.ts';

const TAPE = loadTape(fileURLToPath(new URL('./fixtures/autotrade-1498-tape.json', import.meta.url)));
const T0 = Date.UTC(2026, 10, 5, 12);
const home = (): string => mkdtempSync(join(tmpdir(), 'dexterm-2159-'));
const tapeDep = (calls: { since: number; until: number }[] = []) => (w: { since: number; until: number }): Tape => { calls.push(w); return TAPE; };
const moon = (id: string, over: Partial<Strategy> = {}): Strategy => ({ ...JSON.parse(readFileSync(presetPath('moonbag'), 'utf8')), id, name: id, version: '1.0.0', ...over } as Strategy);
const turn = (t: string, userText: string, chatId = 'chat-abc123'): ChatTurn => ({ chatId, turn: t, userText });

const P = (over: Partial<Proposal> = {}): Proposal => ({
  base: 'moonbag', parents: ['moonbag'], name: 'older moon', ops: [{ op: 'replace', path: '/entry/ageHours/min', value: 2 }],
  rationale: { summary: 'S1 mean -3.2% per entry over 40 entries.', rules: [{ change: 'min age 2 h', why: 'young pairs rug (S1.rugRatePct 30)', cites: ['S1.rugRatePct'] }], expectedFailure: 'fails like its parent', versusParents: 'one rule' },
  citations: [{ ref: 'S1.meanPct', value: -3.2 }, { ref: 'S1.rugRatePct', value: 30 }], retire: [], ...over,
});
const EV = new Map([['S1.meanPct', -3.2], ['S1.n', 40], ['S1.rugRatePct', 30]]);

// ───────────────────────────── the number cross-check ─────────────────────────────

test('numbersIn reads percents, thousands, K suffixes; skips dates, refs and strategy ids', () => {
  assert.deepEqual(numbersIn('mean -3.2% (2,000 holders, 10K liq) on 2026-11-05 from S12 and ss-s2-old-holders, +1.7'), [-3.2, 2000, 10000, 1.7]);
});

test('cross-check: matching citations and evidence numbers in prose pass', () => {
  assert.deepEqual(crossCheck({ proposal: P(), evidence: EV, extra: [], rules: [2] }), []);
});

test('cross-check: a citation with the wrong value, an unknown ref, or an invented number is rejected', () => {
  const wrong = crossCheck({ proposal: P({ citations: [{ ref: 'S1.meanPct', value: -1.5 }] }), evidence: EV, extra: [], rules: [] });
  assert.ok(wrong.some((x) => /S1\.meanPct = -1\.5 but the evidence says -3\.2/.test(x)), wrong.join('|'));
  const unknown = crossCheck({ proposal: P({ citations: [{ ref: 'S9.meanPct', value: 4 }] }), evidence: EV, extra: [], rules: [] });
  assert.ok(unknown.some((x) => /S9\.meanPct is not in the evidence/.test(x)));
  const invented = crossCheck({ proposal: P({ rationale: { ...P().rationale, summary: 'This should make 37.5% per entry.' } }), evidence: EV, extra: [], rules: [] });
  assert.ok(invented.some((x) => /summary cites 37\.5/.test(x)), invented.join('|'));
  // rule values of the candidate / parents and small counts are fine
  assert.deepEqual(crossCheck({ proposal: P({ rationale: { ...P().rationale, summary: 'Raise holders to 2,000; drop the top 3.' } }), evidence: EV, extra: [], rules: [2000] }), []);
});

test('wording: claim words in the rationale reject the reply', () => {
  assert.deepEqual(wordingProblems(P()), []);
  assert.ok(wordingProblems(P({ rationale: { ...P().rationale, summary: 'This finds winners early.' } })).length);
  assert.ok(wordingProblems(P({ name: 'rug-proof moon' })).length);
});

test('parseProposal: a fenced JSON reply parses; missing rationale is refused', () => {
  const ok = parseProposal('here:\n```json\n' + JSON.stringify({ base: 'moonbag', ops: [{ op: 'replace', path: '/entry/screen', value: 'liq >= 20K' }], rationale: { summary: 's', rules: [{ change: 'c', why: 'w' }], expectedFailure: 'f', versusParents: 'v' } }) + '\n```');
  assert.ok(ok.ok);
  assert.deepEqual(ok.ok && ok.proposal.parents, ['moonbag']);
  const bad = parseProposal(JSON.stringify({ base: 'moonbag', ops: [{ op: 'replace', path: '/entry/screen', value: 'x' }] }));
  assert.ok(!bad.ok && bad.problems.some((x) => /summary/.test(x)));
});

test('ops policy: only /entry and /exits; no decide, no safety switches, no gate removal, no caps', () => {
  assert.deepEqual(opsPolicyProblems([{ op: 'replace', path: '/entry/screen', value: 'liq >= 20K' }]), []);
  for (const path of ['/risk/maxConcurrent', '/sizing/maxUsd', '/mode', '/bankroll/startUsd', '/agent/budgetUsdPerDay', '/execution/slippageBps', '/entry/decide', '/entry/safety/rugproof', '/entry/safety/unknownHolders']) {
    assert.ok(opsPolicyProblems([{ op: 'replace', path, value: 1 }]).length, path);
  }
  assert.ok(opsPolicyProblems([{ op: 'replace', path: '/entry/safety/maxTop10Pct', value: null }]).length);
});

test('buildCandidate forces paper, decide auto, the base caps; and validates', () => {
  const base = validateStrategy(moon('base-x'));
  assert.ok(base.ok);
  const b = buildCandidate(base.strategy, P({ base: 'base-x', parents: ['base-x'] }), { id: 'gen-1105-abcd', summary: 's' });
  assert.ok(b.ok, JSON.stringify(!b.ok && b.problems));
  assert.equal(b.strategy.mode, 'paper');
  assert.equal(b.strategy.entry.decide, 'auto');
  assert.deepEqual(b.strategy.risk, base.strategy.risk);
  assert.match(b.strategy.name, /^GEN /);
  // a long name never fails validation: the prefix + NAME_MAX fit the validator's 40 characters
  const long = buildCandidate(base.strategy, P({ base: 'base-x', parents: ['base-x'], name: 'x'.repeat(36) }), { id: 'gen-1105-abce', summary: 's' });
  assert.ok(long.ok, JSON.stringify(!long.ok && long.problems));
  const parsed = parseProposal(JSON.stringify({ base: 'base-x', name: 'y'.repeat(80), ops: [{ op: 'replace', path: '/entry/screen', value: 'liq >= 20K' }], rationale: { summary: 's', rules: [{ change: 'c', why: 'w' }], expectedFailure: 'f', versusParents: 'v' } }));
  assert.ok(parsed.ok && parsed.proposal.name.length <= 36);
});

// ───────────────────────────── a run, end to end (stub analyst) ─────────────────────────────

test('end to end with the stub analyst: one candidate, held-out tested on days it never saw, backtested, queued, then forward-testing', async () => {
  const h = home();
  const calls: { since: number; until: number }[] = [];
  const logs: string[] = [];
  const r = await runFactory({ home: h, analyst: stubAnalyst(), tape: tapeDep(calls), now: () => T0, log: (l) => logs.push(l) });
  assert.ok(r.ok, r.verdict);
  assert.equal(r.candidates.length, 1);
  assert.equal(r.calls, 1);
  assert.equal(r.spendUsd, 0);
  // evidence window ends exactly where the held-out window starts; the held-out window ends at now
  const [ev, ho] = calls;
  assert.equal(ev.until, ho.since - 1);
  assert.equal(ho.until, T0);
  assert.equal(ho.since, T0 - DEFAULT_FACTORY_CONFIG.heldOutDays * 86_400_000);
  const g = loadGenerated(h, r.candidates[0].id)!;
  assert.equal(g.stage, 'queued-forward'); // no spawner: queued
  assert.ok(g.heldOut && typeof g.heldOut.n === 'number' && g.heldOut.verdict.length > 0);
  assert.equal(g.paper, true);
  assert.match(g.label, /GENERATED · PAPER · SIMULATED/);
  assert.ok(existsSync(join(h, 'autotrade', 'factory', 'generated', g.id, 'rationale.md')));
  // its journey has the held-out backtest on these rules (the backtested rung)
  assert.equal(loadJourney(h, g.id).backtests.at(-1)?.rulesHash, g.rulesHash);
  assert.match(readFileSync(factoryLessonsPath(h), 'utf8'), new RegExp(g.id));
  const s = new StrategyStore({ home: h }).get(g.id);
  assert.ok(s?.ok && s.strategy.mode === 'paper' && s.strategy.entry.decide === 'auto');
  // the next run's housekeeping starts the forward test when a spawner is given (paper, live, its own bankroll)
  writeFactoryStop(h, 'test', 'only housekeeping');
  clearFactoryStop(h);
  const hk = housekeeping(h, DEFAULT_FACTORY_CONFIG, { now: T0 + 1000, by: 'test', spawner: () => 4242, store: new StrategyStore({ home: h }) });
  assert.ok(hk.some((x) => /forward test fw_/.test(x)), hk.join('|'));
  const g2 = loadGenerated(h, g.id)!;
  assert.equal(g2.stage, 'forward-testing');
  const ft = loadForwardTest(h, g2.forward.forwardId!)!;
  assert.equal(ft.doc.mode, 'paper');
  assert.equal(ft.window.hours, 72);
  assert.equal(ft.window.trades, 200);
  // never promoted: no always-on member was written
  assert.equal(existsSync(fleetConfigPath(h)), false);
  assert.equal(factoryStatus(h, T0).counts['forward-testing'], 1);
});

test('duplicate rules hash is rejected; attempts are bounded (no retry forever)', async () => {
  const h = home();
  // ops that leave the rules unchanged: same rules hash as the base (moonbag)
  const dup: FactoryAnalyst = stubAnalyst({ reply: () => JSON.stringify({ base: 'moonbag', parents: ['moonbag'], name: 'same', ops: [{ op: 'replace', path: '/entry/triggerMode', value: JSON.parse(readFileSync(presetPath('moonbag'), 'utf8')).entry.triggerMode }], rationale: { summary: 'same rules', rules: [{ change: 'none', why: 'none' }], expectedFailure: 'everything', versusParents: 'nothing' }, citations: [] }) });
  let n = 0;
  const counted: FactoryAnalyst = async (c) => { n++; return dup(c); };
  // the moonbag preset decides "agent"; the candidate is forced to "auto", so make the base auto to get the same rules
  new StrategyStore({ home: h }).create(moon('moon-auto', { entry: { ...moon('x').entry, decide: 'auto' } }), { actor: 'test' });
  const dupAuto: FactoryAnalyst = async (c) => { n++; return { costUsd: 0, text: (await dup(c)).text.replace(/"moonbag"/g, '"moon-auto"') }; };
  const r = await runFactory({ home: h, analyst: dupAuto, tape: tapeDep(), now: () => T0 });
  assert.equal(r.candidates.length, 0);
  assert.equal(n, DEFAULT_FACTORY_CONFIG.maxCallsPerRun);
  assert.ok(r.rejects.every((x) => x.reasons.some((y) => /duplicate|near duplicate/.test(y))), JSON.stringify(r.rejects));
  assert.equal(r.stop, 'attempts');
  assert.match(r.verdict, /no candidate: 3 replies rejected/);
  void counted;
});

test('caps: calls per day, USD per run, active generated and disk each stop the run and say why', async () => {
  // per-day calls already used
  const h1 = home();
  for (let i = 0; i < 3; i++) appendSpend(h1, { t: T0 - 1000, runId: 'x', costUsd: 0.1, ok: true });
  let called = 0;
  const spy: FactoryAnalyst = async (c) => { called++; return stubAnalyst()(c); };
  const r1 = await runFactory({ home: h1, analyst: spy, tape: tapeDep(), now: () => T0 });
  assert.equal(r1.stop, 'cap:maxCallsPerDay');
  assert.equal(called, 0);
  // USD per run: each reply is rejected and costs $0.9; the second call could pass the $1.5 run cap
  const h2 = home();
  saveFactoryConfig(h2, { maxUsdPerCall: 1, maxUsdPerRun: 1.5, maxUsdPerDay: 5, maxCallsPerDay: 5, maxCallsPerRun: 5, maxAttemptsPerRun: 5 });
  const pricey = stubAnalyst({ reply: () => 'not json', costUsd: 0.9 });
  const r2 = await runFactory({ home: h2, analyst: pricey, tape: tapeDep(), now: () => T0 });
  assert.equal(r2.stop, 'cap:maxUsdPerRun');
  assert.equal(r2.calls, 1);
  assert.equal(r2.spendUsd, 0.9);
  // active generated at the cap
  const h3 = home();
  saveFactoryConfig(h3, { maxActiveGenerated: 1 });
  assert.ok((await runFactory({ home: h3, analyst: stubAnalyst(), tape: tapeDep(), now: () => T0 })).ok);
  const r3 = await runFactory({ home: h3, analyst: stubAnalyst(), tape: tapeDep(), now: () => T0 + 1 });
  assert.equal(r3.stop, 'cap:maxActiveGenerated');
  // disk
  const h4 = home();
  saveFactoryConfig(h4, { maxDiskMb: 1 });
  mkdirSync(join(h4, 'autotrade', 'factory', 'generated', 'filler'), { recursive: true });
  writeFileSync(join(h4, 'autotrade', 'factory', 'generated', 'filler', 'big.bin'), Buffer.alloc(1_200_000));
  assert.equal((await runFactory({ home: h4, analyst: stubAnalyst(), tape: tapeDep(), now: () => T0 })).stop, 'cap:maxDiskMb');
  // a scheduled run that is not due skips
  // a scheduled run that is not due skips; only scheduled runs set the cadence (task-2179: a run by hand does not push it back)
  const h5 = home();
  saveFactoryConfig(h5, { maxCallsPerDay: 6, intervalHours: 4 });
  assert.equal((await runFactory({ home: h5, analyst: stubAnalyst(), tape: tapeDep(), now: () => T0 })).stop, null);
  const r5a = await runFactory({ home: h5, analyst: stubAnalyst(), tape: tapeDep(), now: () => T0 + 60_000, scheduled: true, freeMemMb: () => 64_000 });
  assert.notEqual(r5a.stop, 'not-due', 'a run by hand does not make the next slot skip');
  const r5 = await runFactory({ home: h5, analyst: stubAnalyst(), tape: tapeDep(), now: () => T0 + 120_000, scheduled: true, freeMemMb: () => 64_000 });
  assert.equal(r5.stop, 'not-due');
  assert.match(r5.verdict, /last scheduled run was 0\.0 h ago/);
  const r5b = await runFactory({ home: h5, analyst: stubAnalyst(), tape: tapeDep(), now: () => T0 + 60_000 + 3.6 * 3600e3, scheduled: true, freeMemMb: () => 64_000 });
  assert.notEqual(r5b.stop, 'not-due', 'a skip does not move the cadence: due again one interval after the last scheduled run');
});

test('config: ceilings are refused, never half-applied', () => {
  assert.ok(!parseFactoryConfig({ maxUsdPerDay: 500 }).ok);
  assert.ok(!parseFactoryConfig({ maxCandidatesPerRun: 50 }).ok);
  assert.ok(!parseFactoryConfig({ nope: 1 }).ok);
  assert.ok(!parseFactoryConfig({ maxUsdPerCall: 3, maxUsdPerRun: 2 }).ok);
  const h = home();
  assert.ok(!saveFactoryConfig(h, { maxUsdPerDay: 500 }).ok);
  assert.ok(loadFactoryConfig(h).ok && (loadFactoryConfig(h) as { config: { maxUsdPerDay: number } }).config.maxUsdPerDay === DEFAULT_FACTORY_CONFIG.maxUsdPerDay);
});

test('FACTORY-STOP halts a run before anything is read or called', async () => {
  const h = home();
  writeFactoryStop(h, 'user', 'testing');
  let called = 0;
  let taped = 0;
  const r = await runFactory({ home: h, analyst: async (c) => { called++; return stubAnalyst()(c); }, tape: (w) => { taped++; return TAPE; }, now: () => T0 });
  assert.equal(r.stop, 'FACTORY-STOP');
  assert.equal(called, 0);
  assert.equal(taped, 0);
  assert.match(r.verdict, /factory resume/);
});

test('a failed forward test retires the candidate (kept on disk, with the reason); a positive one is forward-passed, never promoted', async () => {
  const h = home();
  const r = await runFactory({ home: h, analyst: stubAnalyst(), tape: tapeDep(), now: () => T0 });
  const id = r.candidates[0].id;
  const store = new StrategyStore({ home: h });
  housekeeping(h, DEFAULT_FACTORY_CONFIG, { now: T0 + 1, by: 'test', spawner: () => 4242, store });
  const g = loadGenerated(h, id)!;
  const t = loadForwardTest(h, g.forward.forwardId!)!;
  saveForwardTest(h, { ...t, state: 'done', endedAt: T0 + 2, endReason: 'window', metrics: { trades: 30, wins: 10, losses: 20, winRate: null, netUsd: -42, netPct: -0.8, maxDrawdownPct: 3, rugs: 2, rugRatePct: 6.7, openAtEnd: 0, fillCostBps: null, fills: 60 } });
  housekeeping(h, DEFAULT_FACTORY_CONFIG, { now: T0 + 3, by: 'test', spawner: null, store });
  const g2 = loadGenerated(h, id)!;
  assert.equal(g2.stage, 'retired');
  assert.match(g2.retired!.why, /forward test lost/);
  assert.ok(store.get(id)?.ok, 'the strategy file is kept');
  // a second candidate (another base: the first one's rules are taken, even retired) that ends positive
  const r2 = await runFactory({ home: h, analyst: stubAnalyst({ base: 'scalp' }), tape: tapeDep(), now: () => T0 + 10 });
  assert.equal(r2.candidates.length, 1, r2.verdict);
  const id2 = r2.candidates[0].id;
  housekeeping(h, DEFAULT_FACTORY_CONFIG, { now: T0 + 11, by: 'test', spawner: () => 4243, store });
  const t2 = loadForwardTest(h, loadGenerated(h, id2)!.forward.forwardId!)!;
  saveForwardTest(h, { ...t2, state: 'done', endedAt: T0 + 12, endReason: 'window', metrics: { trades: 25, wins: 15, losses: 10, winRate: null, netUsd: 12, netPct: 0.2, maxDrawdownPct: 3, rugs: 1, rugRatePct: 4, openAtEnd: 0, fillCostBps: null, fills: 50 } });
  housekeeping(h, DEFAULT_FACTORY_CONFIG, { now: T0 + 13, by: 'test', spawner: null, store });
  assert.equal(loadGenerated(h, id2)!.stage, 'forward-passed');
  assert.equal(existsSync(fleetConfigPath(h)), false, 'nothing is promoted to always-on');
  assert.equal(listGenerated(h).length, 2);
});

test('nothing from the held-out days reaches the analyst: forward results, paper ledgers and lessons are cut at the evidence window end (task-2168)', async () => {
  const h = home();
  const store = new StrategyStore({ home: h });
  const got = store.get('moonbag');
  assert.ok(got?.ok);
  const rh = rulesHash(got.strategy);
  const until = T0 - 3 * 86_400_000;
  const fwd = (forwardId: string, endedAt: number, netUsd: number) => recordForwardResult(h, {
    kind: 'forward', forwardId, id: 'moonbag', version: got.strategy.version, rulesHash: rh, startedAt: endedAt - 3_600_000, endedAt, state: 'done', endReason: 'window',
    window: { hours: 72, trades: 200 }, source: 'test', metrics: { trades: 30, wins: 10, losses: 20, winRate: null, netUsd, netPct: 0.1, maxDrawdownPct: 3, rugs: 0, rugRatePct: 0, openAtEnd: 0, fillCostBps: null, fills: 60 },
  });
  fwd('fw_old', until - 1000, 5);
  fwd('fw_new', until + 1000, 99); // recorded last = newest first; it ended inside the held-out days
  const runsDir = join(h, 'autotrade', 'runs');
  mkdirSync(runsDir, { recursive: true });
  const trade = (id: string, cost: number, pnlUsd: number, t: number) => ({ kind: 'trade_closed', trade: { id, mint: id, symbol: id.toUpperCase(), openedAt: t - 60_000, closedAt: t, costUsd: cost, pnlUsd, pnlPct: (pnlUsd / cost) * 100, exitReason: 'tp', stuck: false }, t });
  const lines = [
    { kind: 'fleet_member', member: 'moonbag', bankroll: { usd: 100, sol: 1 }, mode: 'paper', basedOn: { id: 'moonbag', version: '1.0.0' }, t: until - 90_000 },
    { kind: 'run_start', strategy: 'moonbag', mode: 'paper', t: until - 90_000 },
    { kind: 'fill', positionId: 'p1', mint: 'p1', side: 'buy', usd: 25, reason: 'entry', t: until - 60_000 }, { kind: 'fill', positionId: 'p1', mint: 'p1', side: 'sell', usd: 30, t: until - 1000 }, trade('p1', 25, 5, until - 1000),
    { kind: 'fill', positionId: 'p2', mint: 'p2', side: 'buy', usd: 25, reason: 'entry', t: until + 1000 }, { kind: 'fill', positionId: 'p2', mint: 'p2', side: 'sell', usd: 75, t: until + 60_000 }, trade('p2', 25, 50, until + 60_000),
  ];
  writeFileSync(join(runsDir, '20261101T000000Z-moonbag-0001.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const ev = await gatherEvidence({ store, home: h, tape: TAPE, window: { from: until - 7 * 86_400_000, to: until }, heldOut: { from: until + 1, to: T0 }, unitUsd: 25, generated: new Map(), now: T0 });
  const row = ev.rows.find((r) => r.id === 'moonbag')!;
  assert.equal(row.forward?.netUsd, 5, 'the forward test that ended in the held-out days is not shown');
  assert.equal(row.ledger?.closed, 1, 'the paper trade closed in the held-out days is not shown');
  // lessons: a line stamped on a held-out day (a candidate's held-out numbers, a forward result) is hidden; older lines stay
  const day = (t: number): string => new Date(t).toISOString().slice(0, 10);
  const text = ['# Strategy factory lessons', `- ${day(until - 2 * 86_400_000)} gen-a from moonbag: held out mean -4.4%`, `- ${day(T0)} gen-b from moonbag: held out mean 12.5%`].join('\n');
  const shown = lessonsForPrompt(text, until + 1);
  assert.match(shown, /gen-a/);
  assert.doesNotMatch(shown, /gen-b|12\.5/);
  assert.match(shown, /1 newer lines hidden/);
});

// ───────────────────────────── chat control ─────────────────────────────

function withMember(h: string, id: string, extra: Record<string, unknown> = {}): StrategyStore {
  const store = new StrategyStore({ home: h });
  store.create(moon(id), { actor: 'test' });
  mkdirSync(join(h, 'autotrade'), { recursive: true });
  writeFileSync(fleetConfigPath(h), JSON.stringify({ schema: 'dexterm-autotrade/1', strategies: [{ id, preset: id, ...extra }] }));
  return store;
}
const enabledOf = (h: string): unknown => JSON.parse(readFileSync(fleetConfigPath(h), 'utf8')).strategies[0].enabled;

test('confirm before apply: preview writes nothing; the same turn cannot confirm; the user\'s "yes" next turn applies and says what changed', () => {
  const h = home();
  const store = withMember(h, 'ss-s2');
  const p = previewChange(h, store, 'off', 'ss-s2', { chat: turn('t1', 'turn ss-s2 off'), now: T0 });
  assert.ok(p.ok);
  assert.match(p.change.preview, /turn ss-s2 off: .*PAPER/);
  assert.equal(enabledOf(h), undefined, 'a preview changes nothing');
  // the model trying to confirm in the same turn
  const same = confirmChange(h, store, p.change.code, { chat: turn('t1', 'turn ss-s2 off'), now: T0 + 1 });
  assert.ok(!same.ok && /same turn/.test(same.why));
  // the next turn, but the user did not say yes
  const vague = confirmChange(h, store, p.change.code, { chat: turn('t2', 'how is it doing?'), now: T0 + 2 });
  assert.ok(!vague.ok && /does not confirm/.test(vague.why));
  assert.equal(enabledOf(h), undefined);
  // another chat cannot confirm it
  assert.ok(!confirmChange(h, store, p.change.code, { chat: turn('t3', 'yes', 'chat-other99'), now: T0 + 3 }).ok);
  // outside the in-app chat (no chat turn) nothing is confirmed
  assert.ok(!confirmChange(h, store, p.change.code, { chat: null, now: T0 + 3 }).ok);
  const yes = confirmChange(h, store, p.change.code, { chat: turn('t3', 'yes'), now: T0 + 4 });
  assert.ok(yes.ok, !yes.ok ? yes.why : '');
  assert.match(yes.result, /ss-s2 is off/);
  assert.equal(enabledOf(h), false);
  // and back on, confirmed by the code
  const on = previewChange(h, store, 'on', 'ss-s2', { chat: turn('t4', 'turn it back on'), now: T0 + 5 });
  assert.ok(on.ok);
  assert.ok(confirmChange(h, store, on.change.code, { chat: turn('t5', `confirm ${on.change.code}`), now: T0 + 6 }).ok);
  assert.equal(enabledOf(h), true);
});

test('a "no" cancels; a stale preview expires', () => {
  const h = home();
  const store = withMember(h, 'ss-s3');
  const p = previewChange(h, store, 'off', 'ss-s3', { chat: turn('t1', 'off'), now: T0 });
  assert.ok(p.ok);
  const no = confirmChange(h, store, p.change.code, { chat: turn('t2', 'no, cancel that'), now: T0 + 1 });
  assert.ok(!no.ok && /declined/.test(no.why));
  const p2 = previewChange(h, store, 'off', 'ss-s3', { chat: turn('t3', 'off'), now: T0 + 2 });
  assert.ok(p2.ok);
  assert.ok(!confirmChange(h, store, p2.change.code, { chat: turn('t4', 'yes'), now: T0 + 2 + 11 * 60_000 }).ok);
  assert.equal(enabledOf(h), undefined);
});

test('a decline that names the code still cancels; the code with other instructions does not confirm (task-2168)', () => {
  const declines = (c: string): string[] => [`cancel ${c}`, `no, do not apply ${c}`, `don't do ${c}`, `don’t do ${c}`, `stop ${c}, never mind`, `wait ${c}`];
  for (const mk of [declines, (c: string) => [`${c} and arm it for real`, `apply ${c} then raise its caps`]]) {
    for (let i = 0; i < 6; i++) {
      const h = home();
      const store = withMember(h, 'ss-s2');
      const p = previewChange(h, store, 'off', 'ss-s2', { chat: turn('t1', 'turn ss-s2 off'), now: T0 });
      assert.ok(p.ok);
      const text = mk(p.change.code)[i];
      if (!text) break;
      const r = confirmChange(h, store, p.change.code, { chat: turn('t2', text), now: T0 + 1 });
      assert.ok(!r.ok && !r.applied, `"${text}" must not apply`);
      assert.equal(enabledOf(h), undefined, `"${text}" changed autotrade.json`);
      if (mk === declines) assert.equal(r.change?.status, 'cancelled', `"${text}" should cancel`);
    }
  }
  // still confirms: the code alone, lower-case, or with a yes-word
  for (const mk of [(c: string) => c, (c: string) => c.toLowerCase(), (c: string) => `yes ${c}`, (c: string) => `${c}.`]) {
    const h = home();
    const store = withMember(h, 'ss-s2');
    const p = previewChange(h, store, 'off', 'ss-s2', { chat: turn('t1', 'turn ss-s2 off'), now: T0 });
    assert.ok(p.ok);
    const r = confirmChange(h, store, p.change.code, { chat: turn('t2', mk(p.change.code)), now: T0 + 1 });
    assert.ok(r.ok, `"${mk(p.change.code)}" should confirm${!r.ok ? `: ${r.why}` : ''}`);
    assert.equal(enabledOf(h), false);
  }
});

test('factory pause / resume / run from chat, each confirmed first', () => {
  const h = home();
  const store = new StrategyStore({ home: h });
  const p = previewChange(h, store, 'factory-pause', null, { chat: turn('a', 'pause the factory'), now: T0 });
  assert.ok(p.ok);
  assert.ok(confirmChange(h, store, p.change.code, { chat: turn('b', 'yes'), now: T0 + 1 }).ok);
  assert.ok(existsSync(join(h, 'autotrade', 'factory', 'FACTORY-STOP')));
  assert.ok(!checkChange(h, store, 'factory-run', null).ok, 'no run while paused');
  const r = previewChange(h, store, 'factory-resume', null, { chat: turn('c', 'resume'), now: T0 + 2 });
  assert.ok(r.ok && confirmChange(h, store, r.change.code, { chat: turn('d', 'ok'), now: T0 + 3 }).ok);
  let started = 0;
  const run = previewChange(h, store, 'factory-run', null, { chat: turn('e', 'run the factory now'), now: T0 + 4 });
  assert.ok(run.ok);
  const done = confirmChange(h, store, run.change.code, { chat: turn('f', 'go ahead'), now: T0 + 5, deps: { runFactory: () => { started++; return true; } } });
  assert.ok(done.ok);
  assert.equal(started, 1);
});

test('no path to real mode from the chat tools', () => {
  const h = home();
  const store = withMember(h, 'paper-one');
  // the action set has nothing for real, arming, caps or signing
  for (const a of CHANGE_ACTIONS) assert.ok(!/real|arm|cap|limit|sign|send|live|bankroll/.test(a), a);
  for (const a of ['real', 'arm', 'live', 'caps', 'limits', 'raise', 'bankroll', 'signal']) {
    const c = checkChange(h, store, a, 'paper-one');
    assert.ok(!c.ok && c.why === REAL_REFUSAL, a);
    const p = previewChange(h, store, a, 'paper-one', { chat: turn('t1', a), now: T0 });
    assert.ok(!p.ok);
  }
  // a strategy whose file says real, or an always-on entry that is not paper, is refused for on/off too
  store.create(moon('real-one', { mode: 'real' }), { actor: 'test' });
  const realS = checkChange(h, store, 'on', 'real-one');
  assert.ok(!realS.ok && realS.real === true);
  writeFileSync(fleetConfigPath(h), JSON.stringify({ schema: 'dexterm-autotrade/1', strategies: [{ id: 'paper-one', preset: 'paper-one', mode: 'live' }] }));
  const liveM = checkChange(h, store, 'off', 'paper-one');
  assert.ok(!liveM.ok && liveM.real === true);
  // a strategy not on the always-on list is never added by the chat (the promotion flow is the way on)
  const s2 = new StrategyStore({ home: home() });
  s2.create(moon('fresh-one'), { actor: 'test' });
  const notMember = checkChange(join(tmpdir(), 'nonexistent-2159'), s2, 'on', 'fresh-one');
  assert.ok(!notMember.ok && /promotion flow/.test(notMember.why));
  // the control module imports nothing from real mode, signals, limits or the outbox
  const src = readFileSync(fileURLToPath(new URL('../src/factory/control.ts', import.meta.url)), 'utf8');
  for (const mod of ['real-mode', 'signal', 'limits', 'outbox', 'receipts', 'signal-channels']) assert.ok(!new RegExp(`from '\\.\\./${mod}\\.ts'`).test(src), mod);
});

test('retire from chat: generated only; kept on disk', async () => {
  const h = home();
  const r = await runFactory({ home: h, analyst: stubAnalyst(), tape: tapeDep(), now: () => T0 });
  const id = r.candidates[0].id;
  const store = new StrategyStore({ home: h });
  assert.ok(!checkChange(h, store, 'retire', 'moonbag').ok, 'a preset is not retired');
  const p = previewChange(h, store, 'retire', id, { chat: turn('t1', `retire ${id}`), now: T0 + 1 });
  assert.ok(p.ok);
  assert.ok(confirmChange(h, store, p.change.code, { chat: turn('t2', 'yes'), now: T0 + 2 }).ok);
  assert.equal(loadGenerated(h, id)!.stage, 'retired');
  assert.ok(store.get(id)?.ok);
});

// ───────────────────────────── schedule ─────────────────────────────

test('schedule: a generated LaunchAgent runs `factory run --scheduled` at the daily slot; Windows is refused with a pointer', () => {
  const spec: FactoryInstallSpec = { platform: 'darwin', label: 'xyz.dexterm.factory', nodePath: '/usr/bin/node', binPath: '/opt/dexterm/bin/dexterm.mjs', workingDir: '/tmp', userHome: '/Users/u', dexHome: null, log: '/tmp/f.log', path: null, uid: 501, at: '04:10', intervalHours: 24 };
  const plist = renderFactoryLaunchAgent(spec);
  assert.match(plist, /<string>factory<\/string>\n {4}<string>run<\/string>\n {4}<string>--scheduled<\/string>/);
  assert.match(plist, /<key>Hour<\/key>\n {4}<integer>4<\/integer>\n {4}<key>Minute<\/key>\n {4}<integer>10<\/integer>/);
  assert.doesNotMatch(plist, /KeepAlive/);
  assert.match(renderFactoryLaunchAgent({ ...spec, intervalHours: 5 }), /<key>StartInterval<\/key>\n {2}<integer>18000<\/integer>/, 'an interval that does not divide the day stays a plain interval');
  const plan = factoryInstallPlan(spec);
  assert.ok(plan.ok && plan.plan.files[0].path === '/Users/u/Library/LaunchAgents/xyz.dexterm.factory.plist');
  assert.ok(!factoryInstallPlan({ ...spec, platform: 'win32' }).ok);
  const linux = factoryInstallPlan({ ...spec, platform: 'linux' });
  assert.ok(linux.ok && /OnCalendar=\*-\*-\* 04:10:00/.test(linux.plan.files[1].content));
});

test('status lists candidates with their stage, held-out line and spend', async () => {
  const h = home();
  await runFactory({ home: h, analyst: stubAnalyst({ costUsd: 0.12 }), tape: tapeDep(), now: () => T0 });
  const v = factoryStatus(h, T0 + 1);
  assert.equal(v.candidates.length, 1);
  assert.equal(v.spendToday.calls, 1);
  assert.equal(v.spendToday.usd, 0.12);
  assert.match(v.candidates[0].heldOut, /^n \d+, mean/);
  void createForwardTest;
});

test('a timed-out or garbled analyst call is counted at its per-call budget, not $0; a reported cost is used as is', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-2159-bin-'));
  const bin = (name: string, body: string): string => { const p = join(dir, name); writeFileSync(p, `#!/bin/sh\ncat > /dev/null\n${body}\n`); chmodSync(p, 0o755); return p; };
  const call = { system: 's', prompt: 'p', model: 'm', budgetUsd: 0.25, timeoutMs: 300 };
  const slow = await claudeAnalyst({ bin: bin('slow', 'exec sleep 20') })(call);
  assert.equal(slow.costUsd, 0.25); assert.match(slow.error ?? '', /timed out/);
  const garbled = await claudeAnalyst({ bin: bin('garbled', 'echo not-json; exit 1') })({ ...call, timeoutMs: 10_000 });
  assert.equal(garbled.costUsd, 0.25); assert.ok(garbled.error);
  const ok = await claudeAnalyst({ bin: bin('ok', `echo '{"result":"hi","total_cost_usd":0.12}'`) })({ ...call, timeoutMs: 10_000 });
  assert.deepEqual(ok, { text: 'hi', costUsd: 0.12 });
  const missing = await claudeAnalyst({ bin: join(dir, 'no-such-claude') })({ ...call, timeoutMs: 10_000 });
  assert.equal(missing.costUsd, 0, 'a call that never started cost nothing'); assert.match(missing.error ?? '', /could not start/);
});

// ───────────────────────────── task-2179: 4 h slots, memory guard, run focus ─────────────────────────────

test('task-2179: a 4 h schedule runs at fixed wall-clock slots from `at` (never drifting onto the 02:40 tuner)', () => {
  assert.deepEqual(factorySlots('04:10', 4), [0, 4, 8, 12, 16, 20].map((h) => ({ h, m: 10 })));
  assert.deepEqual(factorySlots('04:10', 24), [{ h: 4, m: 10 }]);
  assert.deepEqual(factorySlots('04:10', 48), [{ h: 4, m: 10 }]);
  assert.equal(factorySlots('04:10', 5), null);
  assert.equal(factorySlots('04:10', 1.5), null);
  assert.equal(describeFactorySchedule('04:10', 4), 'every 4 h at 00:10, 04:10, 08:10, 12:10, 16:10, 20:10');
  const spec: FactoryInstallSpec = { platform: 'darwin', label: 'xyz.dexterm.factory', nodePath: '/usr/bin/node', binPath: '/opt/dexterm/bin/dexterm.mjs', workingDir: '/tmp', userHome: '/Users/u', dexHome: null, log: '/tmp/f.log', path: null, uid: 501, at: '04:10', intervalHours: 4 };
  const plist = renderFactoryLaunchAgent(spec);
  assert.doesNotMatch(plist, /StartInterval<\/key>/);
  assert.match(plist, /<key>AbandonProcessGroup<\/key>\n {2}<true\/>/, 'a forward-test host the run starts outlives the job');
  assert.match(plist, /<key>ProcessType<\/key>\n {2}<string>Standard<\/string>\n {2}<key>Nice<\/key>\n {2}<integer>15<\/integer>\n {2}<key>LowPriorityIO<\/key>\n {2}<true\/>/, 'low priority, not the Background QoS band');
  assert.match(plist, /<key>StartCalendarInterval<\/key>\n {2}<array>\n/);
  assert.equal((plist.match(/<key>Hour<\/key>/g) ?? []).length, 6);
  assert.match(plist, /<key>Hour<\/key>\n {6}<integer>0<\/integer>\n {6}<key>Minute<\/key>\n {6}<integer>10<\/integer>/);
  assert.doesNotMatch(plist, /<integer>2<\/integer>\n {6}<key>Minute/, 'no slot in the tuner hour');
  const linux = factoryInstallPlan({ ...spec, platform: 'linux' });
  assert.ok(linux.ok && /OnCalendar=\*-\*-\* 00,04,08,12,16,20:10:00/.test(linux.plan.files[1].content));
});

test('task-2179: available memory is read from vm_stat (free + inactive + speculative) and /proc/meminfo', () => {
  const vm = 'Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages free:                              226840.\nPages active:                           6751017.\nPages inactive:                         6361515.\nPages speculative:                       682617.\nPages wired down:                       2206007.\nPages purgeable:                          25181.\n';
  assert.equal(vmStatAvailableMb(vm), Math.round(((226840 + 6361515 + 682617) * 4096) / 1048576));
  assert.equal(vmStatAvailableMb('garbage'), null);
  assert.equal(memInfoAvailableMb('MemTotal:       16000000 kB\nMemAvailable:    4194304 kB\n'), 4096);
  assert.equal(memInfoAvailableMb('MemTotal: 1 kB\n'), null);
});

test('task-2179: a scheduled run skips under minFreeMemMb before any analyst call; a run by hand does not check', async () => {
  const h = home();
  let calls = 0;
  const counting: FactoryAnalyst = async (c) => { calls++; return stubAnalyst()(c); };
  const low = await runFactory({ home: h, analyst: counting, tape: tapeDep(), now: () => T0, scheduled: true, freeMemMb: () => 3000 });
  assert.equal(low.stop, 'low-memory');
  assert.ok(low.ok);
  assert.match(low.verdict, /3000 MB of memory available, under minFreeMemMb 4096/);
  assert.equal(calls, 0);
  assert.equal(low.candidates.length, 0);
  const h2 = home();
  const byHand = await runFactory({ home: h2, analyst: counting, tape: tapeDep(), now: () => T0, freeMemMb: () => 3000 });
  assert.equal(byHand.stop, null);
  assert.equal(byHand.candidates.length, 1);
  const h3 = home();
  saveFactoryConfig(h3, { minFreeMemMb: 0 });
  assert.equal((await runFactory({ home: h3, analyst: stubAnalyst(), tape: tapeDep(), now: () => T0, scheduled: true, freeMemMb: () => 10 })).stop, null, '0 turns the check off');
  const h4 = home();
  assert.equal((await runFactory({ home: h4, analyst: stubAnalyst(), tape: tapeDep(), now: () => T0, scheduled: true, freeMemMb: () => null })).stop, null, 'unknown memory does not block');
});

test('task-2179: a run focus reaches the analyst prompt (one clean line) and the run log; no focus = no section', async () => {
  assert.doesNotMatch(buildPrompt('E', 'L', []), /Focus for this run/);
  const h = home();
  const prompts: string[] = [];
  const spy: FactoryAnalyst = async (c) => { prompts.push(c.prompt); return stubAnalyst()(c); };
  await runFactory({ home: h, analyst: spy, tape: tapeDep(), now: () => T0, focus: 'mutate ss-s2\n\u0007 keep the holder gates' });
  assert.match(prompts[0], /## Focus for this run \(from the user\)\nmutate ss-s2 keep the holder gates \(The rules above still hold/);
  const line = JSON.parse(readFileSync(join(h, 'autotrade', 'factory', 'runs.jsonl'), 'utf8').trim().split('\n').at(-1)!);
  assert.equal(line.focus, 'mutate ss-s2 keep the holder gates');
  assert.ok(!('focus' in JSON.parse(readFileSync(join((await (async () => { const h2 = home(); await runFactory({ home: h2, analyst: stubAnalyst(), tape: tapeDep(), now: () => T0 }); return h2; })()), 'autotrade', 'factory', 'runs.jsonl'), 'utf8').trim())));
});

test('task-2179: a held-out loser (n >= 20, whole 95% range below zero) is not queued for a forward slot unless the config says so', () => {
  assert.equal(heldOutLoses({ n: 225, hi: -0.9 }), true);
  assert.equal(heldOutLoses({ n: 225, hi: 0.4 }), false, 'a range that reaches zero still gets a forward test');
  assert.equal(heldOutLoses({ n: 12, hi: -5 }), false, 'too few entries to say it loses');
  assert.equal(heldOutLoses({ n: 50, hi: null }), false);
  assert.match(heldOutVerdict({ n: 225, meanPct: -3.2, lo: -5.1, hi: -0.9, mean2xPct: -7.7, noTop3Pct: -4.6 }), /^loses on the held-out days/);
  assert.equal(DEFAULT_FACTORY_CONFIG.forward.skipHeldOutLosers, true);
  const off = parseFactoryConfig({ forward: { skipHeldOutLosers: false } });
  assert.ok(off.ok && off.config.forward.skipHeldOutLosers === false && off.config.forward.autoStart === true);
  assert.ok(!parseFactoryConfig({ forward: { skipHeldOutLosers: 'no' } }).ok);
});
