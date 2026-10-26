// task-1679 (the 0.2.0 product decisions 2 and 3): the evidence floor for real, and a direct `signal arm` that skips the ladder.
// Promote/arm for real needs a COMPLETED forward test of these exact rules with at least minForwardTrades closed paper
// trades (placeholder 10) AND a backtest on record. Below it the ladder refuses with a plain explanation; only the user
// overrides, by typing the OVERRIDE phrase on a real terminal, and the override is journaled. A model, a flag, an env
// var, a pipe, a pending proposal or a hand edit of limits.json cannot skip it.
// A temp $DEXTERM_HOME, fake terminals through the test seam, recorded evidence written through the library. No
// network, no key, no wallet, no transaction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { autotradeCommand } from '../src/autotrade-cmd.ts';
import { signalCmd, type SignalDeps } from '../src/autotrade-cmd/signal.ts';
import { promoteCmd } from '../src/autotrade-cmd/journey.ts';
import {
  DEFAULT_MIN_FORWARD_TRADES, PromotionFiles, StrategyStore, emptyLimits, evidenceFloor, fleetConfigPath, limitsPath, loadArmings, minForwardTradesFor, planLimitsSave, proposePromotion,
  buildHaltedSignal, readRealJournal, recordBacktestEvidence, recordForwardResult, rulesHash, saveLimits, telegramLines, type BacktestEvidence, type JourneyMetrics, type ResolvedStrategy,
} from '@dexterm/autotrade';

const T0 = Date.UTC(2026, 9, 25, 12);
const M = (trades: number): JourneyMetrics => ({ trades, wins: 0, losses: trades, winRate: null, netUsd: -1, netPct: -1, maxDrawdownPct: 2, rugs: 0, rugRatePct: 0, openAtEnd: 0, fillCostBps: null, fills: trades * 2 });

function io(home = mkdtempSync(join(tmpdir(), 'dexterm-1679-'))) {
  const out: string[] = [], err: string[] = [];
  return { home, out, err, io: { stdout: { write: (s: string) => out.push(s) }, stderr: { write: (s: string) => err.push(s) }, env: { DEXTERM_HOME: home, DEXTERM_DB_PATH: join(home, 'none.db'), DEXTERM_SECRET_STORE: 'file' } } };
}
type X = ReturnType<typeof io>;
const sig = async (x: X, deps: SignalDeps, ...argv: string[]) => {
  x.out.length = 0; x.err.length = 0;
  const code = await signalCmd(argv, x.io, deps);
  return { code, out: x.out.join(''), err: x.err.join('') };
};
/** A real terminal (one-time code fixed to ABCD); the wizard's "[placeholder]: " prompts get Enter. Records every prompt. */
function tty(answer: (prompt: string) => string | null, prompts: string[] = []): SignalDeps {
  return { tty: true, code: () => 'ABCD', typed: async (p) => { prompts.push(p); return /\]: $/.test(p) ? '' : answer(p); } };
}
/** Types whatever exact phrase the prompt asks for. */
const obey = (p: string): string | null => /"([^"]+)"/.exec(p)?.[1] ?? null;

async function setup(id = 'my-scalp'): Promise<{ x: X; s: ResolvedStrategy }> {
  const x = io();
  x.out.length = 0;
  assert.equal(await autotradeCommand(['autotrade', 'new', id, '--from', 'scalp'], x.io), 0, x.err.join(''));
  assert.equal(await autotradeCommand(['autotrade', 'signal', 'channels', '--jsonl', 'on'], x.io), 0, x.err.join(''));
  const got = new StrategyStore({ home: x.home }).get(id);
  assert.ok(got && got.ok);
  return { x, s: got.strategy };
}

function backtest(home: string, s: ResolvedStrategy): void {
  const ev: BacktestEvidence = {
    kind: 'backtest', t: T0, by: 'user', id: s.id, version: s.version, hash: s.hash, rulesHash: rulesHash(s), days: 7,
    tape: { source: 'fixture', mints: 4, ticks: 100, from: null, to: null }, full: M(30),
    heldOut: { cutoff: null, train: M(20), test: M(10) }, verdict: 'too few trades to claim anything (test fixture)', claim: false,
  };
  recordBacktestEvidence(home, ev);
}
function forward(home: string, s: ResolvedStrategy, trades: number, state: 'done' | 'stopped' = 'done', forwardId = `fw_${trades}_${state}`): void {
  recordForwardResult(home, { kind: 'forward', forwardId, id: s.id, version: s.version, rulesHash: rulesHash(s), startedAt: T0, endedAt: T0 + 3_600_000, state, endReason: state === 'done' ? 'window' : 'stopped by the user', window: { hours: 24, trades: null }, source: 'live keyless data layer', metrics: M(trades) });
}
function alwaysOn(home: string, id: string): void {
  mkdirSync(join(home, 'autotrade'), { recursive: true });
  writeFileSync(fleetConfigPath(home), JSON.stringify({ schema: 'dexterm-autotrade/1', strategies: [{ id, preset: id }] }));
}
function lowerFloor(home: string, n: number | null): void {
  const doc = { ...emptyLimits(), global: { minForwardTrades: n } };
  const plan = planLimitsSave(home, doc);
  const r = saveLimits(home, doc, { confirmed: plan.raised, baseline: plan.baseline });
  assert.ok(r.ok, JSON.stringify(r));
}

test('the floor (library): a backtest AND a completed forward test of these rules with >= minForwardTrades closed trades', async () => {
  const { x, s } = await setup();
  const h = x.home;
  assert.equal(DEFAULT_MIN_FORWARD_TRADES, 10);
  assert.equal(minForwardTradesFor(h, s.id), 10, 'no limits saved: the placeholder');
  let f = evidenceFloor(h, s, 10);
  assert.equal(f.ok, false);
  assert.equal(f.problems.length, 2);
  assert.match(f.problems[0], /no backtest on record for these rules/);
  assert.match(f.problems[1], /no COMPLETED forward test of these rules/);
  backtest(h, s);
  forward(h, s, 50, 'stopped');
  f = evidenceFloor(h, s, 10);
  assert.deepEqual(f.problems.map((p) => /COMPLETED/.test(p)), [true], 'a forward test stopped early never counts, whatever its trades');
  forward(h, s, 3);
  f = evidenceFloor(h, s, 10);
  assert.equal(f.ok, false);
  assert.match(f.problems[0], /the completed forward test closed 3 paper trades; real needs at least 10 \(your limit minForwardTrades\)/);
  // a forward test of OTHER rules (an edit) does not count for these
  const other = { ...s, exits: { ...s.exits, hardStopPct: (s.exits as { hardStopPct?: number }).hardStopPct === 20 ? 21 : 20 } } as ResolvedStrategy;
  forward(h, other, 40, 'done', 'fw_other');
  assert.equal(evidenceFloor(h, s, 10).ok, false);
  forward(h, s, 12, 'done', 'fw_12');
  f = evidenceFloor(h, s, 10);
  assert.equal(f.ok, true, f.problems.join('; '));
  assert.equal(f.forward?.metrics?.trades, 12);
  assert.equal(evidenceFloor(h, s, 20).ok, false, 'the user\'s higher floor is honoured');
});

test('minForwardTrades is the user\'s limit: a journaled save sets it (off = no trade minimum); a hand edit that lowers it fails closed', async () => {
  const { x, s } = await setup();
  const h = x.home;
  lowerFloor(h, 4);
  assert.equal(minForwardTradesFor(h, s.id), 4);
  lowerFloor(h, null);
  assert.equal(minForwardTradesFor(h, s.id), 0, 'off: no trade minimum');
  backtest(h, s);
  assert.equal(evidenceFloor(h, s, 0).ok, false, 'off still needs the completed forward test');
  // a hand edit (or anything else writing the file) that lowers the floor is not the user's journaled save
  lowerFloor(h, 30);
  writeFileSync(limitsPath(h), JSON.stringify({ ...emptyLimits(), global: { minForwardTrades: 0 } }));
  assert.equal(minForwardTradesFor(h, s.id), 10, 'an unjournaled lowering counts at least the placeholder');
  // a strategy scope can only tighten
  lowerFloor(h, 5);
  const doc = { ...emptyLimits(), global: { minForwardTrades: 5 }, strategies: { [s.id]: { minForwardTrades: 25 } } };
  const plan = planLimitsSave(h, doc);
  assert.ok(saveLimits(h, doc, { confirmed: plan.raised, baseline: plan.baseline }).ok);
  assert.equal(minForwardTradesFor(h, s.id), 25);
  assert.equal(minForwardTradesFor(h, 'someone-else'), 5);
});

test('promote --to real below the floor: refused with a plain explanation, no proposal written; the same for a model proposal', async () => {
  const { x, s } = await setup();
  const h = x.home;
  backtest(h, s);
  forward(h, s, 3);
  alwaysOn(h, s.id);
  x.out.length = 0; x.err.length = 0;
  assert.equal(await promoteCmd([s.id, '--to', 'real'], x.io, tty(obey)), 1);
  const err = x.err.join('');
  assert.match(err, /below the evidence floor for real: the completed forward test closed 3 paper trades; real needs at least 10/);
  assert.match(err, /To arm below it anyway, your call alone: dexterm autotrade signal arm my-scalp on your own terminal asks for a typed OVERRIDE phrase/);
  assert.equal(new PromotionFiles(h).list().length, 0, 'nothing proposed');
  const m = proposePromotion(h, s, 'real', { actor: 'analyst', why: 'it is ready, trust me' });
  assert.equal(!m.ok && m.reason, 'evidence-floor');
  assert.equal(new PromotionFiles(h).list().length, 0);
  assert.ok(!existsSync(join(h, 'autotrade', 'real', 'arming.json')));
  forward(h, s, 11, 'done', 'fw_11');
  const ok = proposePromotion(h, s, 'real', { actor: 'analyst', why: 'floor met' });
  assert.ok(ok.ok, 'above the floor the ladder proposes as before');
});

test('signal arm below the floor: refused unless the OVERRIDE phrase is typed; the override is journaled and recorded on the arming', async () => {
  const { x, s } = await setup();
  const h = x.home;
  backtest(h, s);
  forward(h, s, 3);
  alwaysOn(h, s.id);
  // anything but the exact OVERRIDE phrase cancels before the arming phrase is even asked
  const prompts: string[] = [];
  let r = await sig(x, tty((p) => (/OVERRIDE/.test(p) ? 'REAL my-scalp ABCD' : obey(p)), prompts), 'arm', s.id);
  assert.equal(r.code, 1);
  assert.match(r.out, /EVIDENCE FLOOR NOT MET \(real needs a completed forward test with at least 10 closed paper trades and a backtest, on these exact rules\)/);
  assert.match(r.out, /- the completed forward test closed 3 paper trades; real needs at least 10/);
  assert.match(r.out, /REFUSED unless you override: the evidence floor is not met\./);
  assert.doesNotMatch(r.out, /SKIPS THE LADDER/, 'the ladder is climbed (always-on): only the floor is short');
  assert.match(r.err, /not confirmed; nothing changed/);
  assert.match(r.err, /not armed: do the missing step first \(dexterm autotrade journey my-scalp\)/);
  assert.ok(prompts.some((p) => /type exactly "OVERRIDE my-scalp ABCD"/.test(p)));
  assert.ok(!prompts.some((p) => /"REAL my-scalp/.test(p)), 'the arming phrase is not reached');
  assert.deepEqual(loadArmings(h), {});
  assert.ok(!readRealJournal(h).some((l) => l.action === 'evidence-override' || l.action === 'arm'));
  // the override, then the arming phrase
  prompts.length = 0;
  r = await sig(x, tty(obey, prompts), 'arm', s.id);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /override typed \(journaled\); now the arming phrase/);
  assert.deepEqual(prompts.filter((p) => /type exactly/.test(p)).map((p) => /"(\w+) /.exec(p)![1]), ['OVERRIDE', 'REAL']);
  const j = readRealJournal(h);
  const ov = j.find((l) => l.action === 'evidence-override');
  assert.ok(ov, 'journaled');
  assert.equal(ov.by, 'local-terminal');
  assert.equal(ov.data.strategyId, s.id);
  assert.equal(ov.data.skipsLadder, null);
  assert.equal(ov.data.minTrades, 10);
  assert.match(String((ov.data.floor as string[])[0]), /closed 3 paper trades/);
  assert.notEqual(ov.data.codeHash, 'ABCD', 'the code itself is not stored');
  assert.deepEqual(j.map((l) => l.action).slice(-3), ['evidence-override', 'limits-set', 'arm']);
  const a = loadArmings(h)[s.id];
  assert.ok(a?.override);
  assert.equal(a.override.minTrades, 10);
  assert.ok(a.evidence.some((l) => /EVIDENCE FLOOR NOT MET/.test(l)), 'the arming keeps the panel it was confirmed on');
});

test('above the floor and on the ladder: no override is asked; a direct signal arm that SKIPS THE LADDER needs the same typed OVERRIDE', async () => {
  const { x, s } = await setup();
  const h = x.home;
  backtest(h, s);
  forward(h, s, 12);
  alwaysOn(h, s.id);
  const prompts: string[] = [];
  let r = await sig(x, tty(obey, prompts), 'arm', s.id);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /evidence {2}floor met: a completed forward test with 12 closed paper trades \(at least 10\) and a backtest on record/);
  assert.doesNotMatch(r.out, /OVERRIDE|REFUSED/);
  assert.deepEqual(prompts.filter((p) => /type exactly/.test(p)).map((p) => /"(\w+) /.exec(p)![1]), ['REAL']);
  assert.equal(loadArmings(h)[s.id].override, undefined);
  assert.ok(!readRealJournal(h).some((l) => l.action === 'evidence-override'));

  // a fresh strategy with nothing on record: arming directly skips the ladder (and the floor)
  const y = await setup('my-fresh');
  r = await sig(y.x, tty((p) => (/OVERRIDE/.test(p) ? 'yes' : obey(p))), 'arm', 'my-fresh');
  assert.equal(r.code, 1, 'no longer a warning only');
  assert.match(r.out, /journey {3}stage draft .* SKIPS THE LADDER: backtested is missing/);
  assert.match(r.out, /REFUSED unless you override: arming now SKIPS THE LADDER \(backtested is missing\) and the evidence floor is not met\./);
  assert.deepEqual(loadArmings(y.x.home), {});
  r = await sig(y.x, tty(obey), 'arm', 'my-fresh');
  assert.equal(r.code, 0, r.err);
  const ov = readRealJournal(y.x.home).find((l) => l.action === 'evidence-override');
  assert.equal(ov?.data.skipsLadder, 'backtested');
  assert.equal((ov?.data.floor as string[]).length, 2);
});

test('compromised model: no flag, env var, pipe, pending proposal or hand edit gets past the floor', async () => {
  const { x, s } = await setup();
  const h = x.home;
  backtest(h, s);
  forward(h, s, 0);
  alwaysOn(h, s.id);
  // a pipe or an agent: refused before any panel
  let r = await sig(x, { tty: false, typed: async () => 'OVERRIDE my-scalp ABCD', code: () => 'ABCD' }, 'arm', s.id, '--override', '--yes');
  assert.equal(r.code, 2);
  assert.match(r.err, /real terminal/);
  // flags and env vars are not an override: the phrase is still asked
  const env = { ...x.io.env, DEXTERM_OVERRIDE: '1', DEXTERM_EVIDENCE_FLOOR: '0', DEXTERM_MIN_FORWARD_TRADES: '0' };
  const prompts: string[] = [];
  x.out.length = 0; x.err.length = 0;
  let code = await signalCmd(['arm', s.id, '--override', '--min-forward-trades', '0', '--force'], { ...x.io, env }, tty(() => null, prompts));
  assert.equal(code, 1);
  assert.ok(prompts.some((p) => /"OVERRIDE my-scalp ABCD"/.test(p)));
  assert.deepEqual(loadArmings(h), {});
  // a stale code (a recording of an earlier override) does not match a fresh one
  code = await signalCmd(['arm', s.id], x.io, { tty: true, code: () => 'WXYZ', typed: async (p) => (/\]: $/.test(p) ? '' : 'OVERRIDE my-scalp ABCD') });
  assert.equal(code, 1);
  assert.deepEqual(loadArmings(h), {});
  // a pending real proposal (as a compromised model might have left) still meets the floor at the arm
  const files = new PromotionFiles(h);
  files.write({ schema: 'dexterm-promotion-proposal/1', proposalId: 'pp_abcdef_0123abcd', id: s.id, to: 'real', actor: 'mcp-agent', createdAt: T0, why: 'skip the floor', version: s.version, hash: s.hash, rulesHash: rulesHash(s), card: [], status: 'pending' });
  lowerFloor(h, 10); // the user's caps, so the hand-over reaches signal arm
  x.out.length = 0; x.err.length = 0;
  code = await promoteCmd(['apply', 'pp_abcdef_0123abcd'], x.io, tty((p) => (/OVERRIDE/.test(p) ? '' : obey(p))));
  assert.equal(code, 1);
  assert.match(x.out.join(''), /EVIDENCE FLOOR NOT MET/);
  assert.deepEqual(loadArmings(h), {});
  // a hand edit of limits.json that lowers the floor: arming refuses it (an outside raise) before any phrase
  writeFileSync(limitsPath(h), JSON.stringify({ ...emptyLimits(), global: { minForwardTrades: 0 } }));
  r = await sig(x, tty(obey), 'arm', s.id);
  assert.equal(r.code, 1);
  assert.match(r.err, /limits\.json was changed outside dexterm and raises limits/);
  assert.deepEqual(loadArmings(h), {});
  assert.ok(!readRealJournal(h).some((l) => l.action === 'evidence-override' || l.action === 'arm'), 'nothing was overridden or armed');
});

test('call 4: the halted Telegram copy names the positions still open and says to manage them in the executor', () => {
  const hdr = { nonce: 9, now: T0, ttlSec: 600, runId: 'run-1679-abc', accountId: 'main', strategy: { id: 'my-scalp', version: '1.0.1', hash: 'h'.repeat(64) } };
  const open = buildHaltedSignal('runner-stopped', [7, 8], hdr, ['So1aNaMint11111111111111111111111111111111']);
  const lines = telegramLines(open, T0);
  assert.match(lines[0], /HALTED · runner-stopped/);
  assert.ok(lines.some((l) => /^1 position\(s\): /.test(l)));
  assert.ok(lines.includes('these positions are still open: manage them in your executor'));
  assert.ok(lines.some((l) => /NO signal for them, sells included/.test(l)));
  const none = telegramLines(buildHaltedSignal('runner-stopped', [], hdr, []), T0);
  assert.ok(!none.some((l) => /still open/.test(l)), 'nothing open: no such line');
});
