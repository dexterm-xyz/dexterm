// task-1503 (AT-1 addendum, AUTOTRADE-SPEC §1/§3a): the exit-profile JSON Schema 1.2.0 file, the every-candidate
// copy, the bootstrap interval + exit-multiple quantiles, runner recall, verdict rule 6, bankroll.source and
// agent.respawnOnWake. Recorded fixture tape only: no network, no keys, paper only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  SCHEMAS, backtest, bootstrapMean, builtinProfiles, everyCandidate, loadPreset, loadTape, presetPath, quantile, runAutotrade,
  runnerRecall, sweepVerdict, validateStrategy, type SweepRow,
} from '../src/index.ts';

const TAPE = fileURLToPath(new URL('./fixtures/autotrade-1498-tape.json', import.meta.url));
const SCHEMA_FILE = new URL('../assets/exit-profile.schema.json', import.meta.url);
const raw = (id: string) => JSON.parse(readFileSync(presetPath(id), 'utf8'));

type JNode = { properties?: Record<string, JNode>; required?: string[]; oneOf?: JNode[]; minimum?: number; maximum?: number };
const objOf = (n: JNode): JNode => n.oneOf?.find((x) => x.properties) ?? n;

test('1503 schema file: exit-profile.schema.json is 1.2.0 and names exactly the fields the engine validates', () => {
  const js = JSON.parse(readFileSync(SCHEMA_FILE, 'utf8')) as JNode & { title: string };
  assert.match(js.title, /1\.2\.0/);
  const engine = SCHEMAS.exitProfile as unknown as { props: Record<string, { props?: Record<string, unknown>; oneOf?: { props?: Record<string, unknown> }[] }>; required: string[] };
  assert.deepEqual(Object.keys(js.properties!).sort(), Object.keys(engine.props).sort());
  assert.deepEqual([...js.required!].sort(), [...engine.required].sort(), 'required is unchanged from 1.0.0, so older profiles stay valid');
  for (const k of ['costRecovery', 'bagTrail', 'wake']) {
    const e = engine.props[k];
    const eKeys = Object.keys(e.props ?? e.oneOf?.find((x) => x.props)?.props ?? {}).sort();
    assert.deepEqual(Object.keys(objOf(js.properties![k]).properties!).sort(), eKeys, k);
  }
  assert.equal(objOf(js.properties!.bagTrail).properties!.trailPct.maximum, 90);
  assert.equal(objOf(js.properties!.costRecovery).properties!.maxSellFrac.maximum, 0.9);
  // Every shipped profile uses only schema fields, and a 1.0.0-shaped profile (no 1.1/1.2 keys) still validates.
  for (const p of Object.values(builtinProfiles())) for (const k of Object.keys(p)) assert.ok(k in js.properties!, `${p.id}.${k}`);
  const old = { ...builtinProfiles().scalp } as Record<string, unknown>;
  for (const k of ['wake', 'maxHoldMinutes', 'costRecovery', 'bagTrail']) delete old[k];
  const doc = raw('scalp');
  doc.exits.profiles[0] = { ...old, id: 'scalp-v1', version: '1.0.0' };
  doc.exits.default = 'scalp-v1';
  const r = validateStrategy(doc);
  assert.ok(r.ok, JSON.stringify(!r.ok && r.errors));
});

test('1503 schema: bankroll.source and agent.respawnOnWake are in dexterm-strategy/1; unknown keys still refused', () => {
  const d = raw('moonbag');
  d.bankroll.source = 'desk';
  d.agent.respawnOnWake = true;
  const r = validateStrategy(d);
  assert.ok(r.ok, JSON.stringify(!r.ok && r.errors));
  assert.ok(r.warnings.some((w) => w.path === '/bankroll/source'));
  assert.equal(r.strategy.agent.respawnOnWake, true);
  d.bankroll.source = 'wallet';
  assert.ok(!validateStrategy(d).ok);
  const k = raw('moonbag');
  k.agent.apiKey = 'x';
  const rk = validateStrategy(k);
  assert.ok(!rk.ok && rk.errors.some((e) => e.path === '/agent/apiKey'));
  // Hashes of the shipped presets do not move when the optional fields are absent.
  assert.equal(loadPreset('moonbag').hash, validateStrategy(raw('moonbag')).ok && (validateStrategy(raw('moonbag')) as { strategy: { hash: string } }).strategy.hash);
});

test('1503 every-candidate: fixed unit size, book caps lifted, entry rules and exits unchanged; more independent entries than the book', async () => {
  const s = loadPreset('moonbag');
  const ev = everyCandidate(s, 20);
  assert.equal(ev.mode, 'paper');
  assert.equal(ev.sizing.mode, 'fixed');
  assert.equal(ev.sizing.fixedUsd, 20);
  assert.equal(ev.entry.screen, s.entry.screen);
  assert.deepEqual(ev.exits.profiles, s.exits.profiles);
  assert.deepEqual(ev.risk.perCoin, s.risk.perCoin, 'one entry per coin is a strategy rule, not a book cap');
  const tape = loadTape(TAPE);
  const book = await backtest(s, tape);
  const each = await backtest(ev, tape);
  assert.ok(each.report.trades >= book.report.trades);
  for (const t of each.run.trades) assert.ok(t.costUsd <= 20.0001, `cost ${t.costUsd}`);
  for (const rule of ['max-concurrent', 'exposure', 'max-per-day', 'halted', 'daily-loss-halt']) assert.ok(!Object.keys(each.report.refusals).some((k) => k.includes(rule)), rule);
  await assert.rejects(runAutotrade({ strategy: { ...ev, mode: 'live' }, tape, sessions: null }), /paper only/, 'the copy is still refused if it is not paper');
});

test('1503 tail: bootstrap interval is seeded and brackets the mean; exit-multiple quantiles; deterministic report', async () => {
  const a = bootstrapMean([10, -50, 30, -100, 200, 5]);
  assert.deepEqual(a, bootstrapMean([10, -50, 30, -100, 200, 5]));
  assert.ok(a!.lo <= a!.meanPct && a!.meanPct <= a!.hi);
  assert.equal(bootstrapMean([]), null);
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  const tape = loadTape(TAPE);
  const r1 = (await backtest(everyCandidate(loadPreset('moonbag')), tape)).report;
  const r2 = (await backtest(everyCandidate(loadPreset('moonbag')), tape)).report;
  assert.deepEqual(r1.tail, r2.tail);
  assert.ok(r1.tail.perEntry && r1.tail.multiples);
  assert.ok(r1.tail.multiples.p50 <= r1.tail.multiples.p90 && r1.tail.multiples.p90 <= r1.tail.multiples.max);
  assert.equal(r1.tail.multiples.max, r1.tail.bestMultiple);
});

test('1503 runner recall: of the coins that later ran >= Nx, how many the entry rules passed, what refused the rest, how the entered closed', async () => {
  const s = everyCandidate(loadPreset('moonbag'));
  const tape = loadTape(TAPE);
  const { run } = await backtest(s, tape);
  const [r2, r5] = runnerRecall(s, tape, run, [2, 5]);
  assert.equal(r2.minX, 2);
  assert.ok(r5.runners <= r2.runners, 'a higher bar never has more runners');
  for (const r of [r2, r5]) {
    assert.ok(r.passed <= r.runners);
    assert.ok(r.entered <= r.passed);
    assert.equal(r.coins.length, r.runners);
    for (const c of r.coins) {
      assert.ok(c.peakX >= r.minX);
      if (!c.passed) assert.ok(Object.keys(c.refusedBy).length > 0, 'a refused runner names its rule');
      if (c.trade) assert.ok(c.passed, 'only a coin the rules passed was entered');
    }
    assert.equal(Object.values(r.exits).reduce((a, b) => a + b, 0), r.entered);
  }
});

test('1503 verdict rule 6: no gain wording without >= 20 trades in both halves AND a held-out net above 0', () => {
  const row = (trainN: number, trainNet: number, testN: number, testNet: number): SweepRow => ({
    params: {}, train: { trades: trainN, netUsd: trainNet, maxDrawdownPct: 1, winRate: null }, test: { trades: testN, netUsd: testNet, maxDrawdownPct: 1, winRate: null },
  });
  // The spike's moonbag sweep: the train winner lost less on the held-out coins (-98 vs -170) on 8 train trades.
  assert.match(sweepVerdict(row(8, 50, 22, -98), row(30, -20, 22, -170)), /too few trades \(train 8, held-out 22/);
  const lessBad = sweepVerdict(row(25, 50, 22, -98), row(30, -20, 22, -170));
  assert.match(lessBad, /no edge: the tuned strategy still loses/);
  assert.doesNotMatch(lessBad, /gain/);
  assert.match(sweepVerdict(row(25, 50, 22, 40), row(30, -20, 22, -10)), /^held-out gain 50\.00 USD/);
  assert.match(sweepVerdict(row(25, 50, 22, 40), row(30, -20, 22, 60)), /no held-out gain/);
  assert.match(sweepVerdict(row(25, -50, 22, 40), row(30, 20, 22, 10)), /no held-out gain/, 'train must agree');
});
