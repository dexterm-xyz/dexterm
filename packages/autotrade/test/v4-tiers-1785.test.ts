// 0.2.1 / 0.2.2: confidence-tiered sizing (rules v4 research, task-1785), EXPERIMENTAL, PAPER ONLY, default off.
// The score on fixtures, the tier mapping, the cap on unproven tiers, the T0 skip, the stricter limit winning, the
// refusals outside paper (validation, runner and engine), default-off byte-identical runs of every shipped preset on
// the committed tape, and the verdict text on validation and on every TIER line. No network, no wallet, no key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPreset, loadStrategyFile, presetPath, validateStrategy, type ResolvedStrategy } from '../src/strategy.ts';
import { loadTape, type MarketTick, type Tape } from '../src/replay.ts';
import { runAutotrade, type ApprovalHook, type ApprovalOutcome, type RealRunHook } from '../src/runner.ts';
import { SimBook, clampEntry, tierHardCapUsd } from '../src/engine.ts';
import { StrategyStore } from '../src/store.ts';
import { backtest } from '../src/backtest.ts';
import { verifyChain } from '../src/ledger.ts';
import { stubSession } from '../src/session.ts';
import { RUGPROOF_DEFAULTS } from '../src/rugproof.ts';
import {
  CONFIDENCE_TIERS_V4, TIERS_HARD_CAP_PCT, TIERS_VERDICT, TIER_TICK_MAX_AGE_MS, confidenceTierLine, selectConfidenceTier, tierGateFailures, tierRunsAtPct, tierSignals, tierTableLines,
  type TierTable,
} from '../src/tiers.ts';

const T0 = 1_792_000_000_000;
const MIN = 60_000;
const TAPE = new URL('./fixtures/autotrade-1498-tape.json', import.meta.url);
const MINT_A = 'TierA1111111111111111111111111111111111pump';
const MINT_B = 'TierB1111111111111111111111111111111111pump';

/** turnover1h 0.5 (passes <= 9.878), bs5m 1.5 (fails >= 3.714): score 1. */
function tick(over: Partial<MarketTick> = {}): MarketTick {
  return {
    mint: MINT_A, t: T0, kind: 'live', symbol: 'TEST', launchpad: 'pump.fun', createdAt: T0 - 3 * 3600e3,
    price: 1, mcap: 1e6, mcapResolved: 1e6, mcapFlagged: false, liq: 100_000, vol5m: 10_000, vol1h: 50_000, vol24: 500_000,
    buys5m: 120, sells5m: 80, buys24: 5000, sells24: 4000, chg5m: 4, chg1h: 20, chg6h: 40, chg24h: 80,
    holders: 900, top10: 20, dev: 1, mintAuth: false, freezeAuth: false, org: 70, ...over,
  };
}
const SCORE0 = { vol1h: 2_000_000, buys5m: 120, sells5m: 80 };   // turnover 20, bs 1.5
const SCORE2 = { vol1h: 50_000, buys5m: 400, sells5m: 100 };     // turnover 0.5, bs 4
const tape = (ticks: MarketTick[]): Tape => ({ source: 'synthetic', ticks, mints: [...new Set(ticks.map((k) => k.mint))] });

/** The swing preset with the rug-proof block, mechanical entries, and limits loose enough that 25% of the book fits. */
function tierDoc(tiers: unknown = { table: 'v4-1785', experimental: 'paper-only' }, over: (d: Record<string, any>) => void = () => {}): Record<string, any> {
  const d = JSON.parse(readFileSync(presetPath('swing'), 'utf8'));
  const swing = JSON.parse(readFileSync(new URL('../assets/profiles/swing.json', import.meta.url), 'utf8'));
  swing.sizing.maxSizePctOfBankroll = 25;
  d.exits.profiles = [swing];
  d.entry.decide = 'auto';
  d.entry.ageHours = { min: 0, max: 168 };
  d.entry.safety.rugproof = { ...RUGPROOF_DEFAULTS };
  d.sizing.maxPctOfBankroll = 25;
  d.risk.perTrade.maxLossPctOfBankroll = 25;
  d.risk.maxExposurePct = 100;
  d.execution.latencyMs = 0;
  if (tiers !== undefined) d.sizing.tiers = tiers;
  over(d);
  return d;
}
function resolved(doc: Record<string, any>): ResolvedStrategy {
  const r = validateStrategy(doc);
  assert.ok(r.ok, r.ok ? '' : JSON.stringify(r.errors));
  return r.strategy;
}

// ───────────────────────────── the score ─────────────────────────────

test('v4 tiers: signals follow the research definitions (turnover1h = vol1h / liq, bs5m = buys / sells, 99 / 0 edges)', () => {
  const s = tierSignals(tick());
  assert.equal(s.turnover1h, 0.5);
  assert.equal(s.bs5m, 1.5);
  assert.equal(tierSignals(tick({ sells5m: 0, buys5m: 7 })).bs5m, 99, 'all buys');
  assert.equal(tierSignals(tick({ sells5m: 0, buys5m: 0 })).bs5m, 0, 'no trades');
  assert.equal(tierSignals(tick({ sells5m: null })).bs5m, null, 'a missing count is unknown (never 99)');
  assert.equal(tierSignals(tick({ buys5m: null })).bs5m, null);
  assert.equal(tierSignals(tick({ liq: 0 })).turnover1h, null, 'no liquidity: unknown');
  assert.equal(tierSignals(tick({ vol1h: null })).turnover1h, null);
});

test('v4 tiers: one point per rule that holds, boundaries inclusive, an unknown signal never scores', () => {
  assert.equal(selectConfidenceTier(tick()).score, 1);
  assert.equal(selectConfidenceTier(tick(SCORE0)).score, 0);
  assert.equal(selectConfidenceTier(tick(SCORE2)).score, 2);
  // exactly at the cut-offs: turnover 9.878 (<=) and bs5m 3.714 (>=) both pass
  const edge = selectConfidenceTier(tick({ liq: 100_000, vol1h: 987_800, buys5m: 3714, sells5m: 1000 }));
  assert.deepEqual(edge.points.map((p) => p.pass), [true, true]);
  const over = selectConfidenceTier(tick({ liq: 100_000, vol1h: 987_900, buys5m: 3713, sells5m: 1000 }));
  assert.deepEqual(over.points.map((p) => p.pass), [false, false]);
  const unknown = selectConfidenceTier(tick({ vol1h: null, buys5m: null }));
  assert.equal(unknown.score, 0);
  assert.deepEqual(unknown.points.map((p) => p.actual), [null, null]);
});

// ───────────────────────────── tier mapping, cap, gates ─────────────────────────────

test('v4 tiers: score -> tier (highest met wins: 0 = T0, 1 = T3, 2 = T4; T1 and T2 are never selected)', () => {
  assert.equal(selectConfidenceTier(tick(SCORE0)).tier, 'T0');
  assert.equal(selectConfidenceTier(tick()).tier, 'T3');
  assert.equal(selectConfidenceTier(tick(SCORE2)).tier, 'T4');
  const lines = tierTableLines();
  assert.match(lines.find((l) => l.startsWith('T1'))!, /never selected/);
  assert.match(lines.find((l) => l.startsWith('T2'))!, /never selected/);
  assert.doesNotMatch(lines.find((l) => l.startsWith('T3'))!, /never selected/);
});

test('v4 tiers: every unproven tier above 25% runs at 25%; there is no override; T0 runs at 0', () => {
  const t3 = selectConfidenceTier(tick());
  assert.equal(t3.configuredPct, 75); assert.equal(t3.effectivePct, 25); assert.equal(t3.capped, true); assert.equal(t3.evidence, 'unproven');
  const t4 = selectConfidenceTier(tick(SCORE2));
  assert.equal(t4.configuredPct, 100); assert.equal(t4.effectivePct, 25); assert.equal(t4.capped, true);
  for (const t of CONFIDENCE_TIERS_V4.tiers) {
    const run = tierRunsAtPct(t, CONFIDENCE_TIERS_V4);
    if (t.id !== 'T0') assert.ok(run.pct <= 25, `${t.id} runs at ${run.pct}%`);
    assert.ok(t.evidence !== 'proven', 'no tier in the frozen table is proven');
    assert.ok(!('override' in t) && !Object.keys(t).some((k) => /override/i.test(k)), 'no override field in the table');
  }
  assert.equal(selectConfidenceTier(tick(SCORE0)).effectivePct, 0);
  // 0.2.2: "proven" evidence does not lift the cap either (no path in this release lifts it).
  const proven: TierTable = { ...CONFIDENCE_TIERS_V4, tiers: CONFIDENCE_TIERS_V4.tiers.map((t) => (t.id === 'T4' ? { ...t, evidence: 'proven' as const } : t)) };
  assert.deepEqual(tierRunsAtPct(proven.tiers[4], proven), { pct: 25, capped: true });
  assert.ok(Object.isFrozen(CONFIDENCE_TIERS_V4) && Object.isFrozen(CONFIDENCE_TIERS_V4.tiers[3]), 'the shipped table is frozen');
  // The block itself has no override knob: an extra key is refused by the schema.
  const r = validateStrategy(tierDoc({ table: 'v4-1785', experimental: 'paper-only', override: true }));
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.errors.some((e) => e.path.startsWith('/sizing/tiers') && /unknown key/.test(e.msg)));
});

test('v4 tiers: a failed gate is T0 whatever the score (liquidity, pool age, young and vertical)', () => {
  const g = CONFIDENCE_TIERS_V4.gates;
  assert.deepEqual(tierGateFailures(tick(), g), []);
  assert.equal(selectConfidenceTier(tick({ ...SCORE2, liq: 29_000, vol1h: 20_000 })).tier, 'T0');
  assert.match(tierGateFailures(tick({ liq: 29_000 }), g)[0], /liquidity \$29000 < \$30000/);
  assert.match(tierGateFailures(tick({ liq: null }), g)[0], /liquidity unknown/);
  assert.match(tierGateFailures(tick({ createdAt: T0 - 5 * MIN }), g)[0], /pool age < 10 min/);
  assert.match(tierGateFailures(tick({ createdAt: null }), g)[0], /pool age unknown/);
  assert.match(tierGateFailures(tick({ createdAt: T0 - 90 * MIN, chg1h: 150 }), g)[0], /young and vertical/);
  assert.deepEqual(tierGateFailures(tick({ createdAt: T0 - 3 * 3600e3, chg1h: 400 }), g), [], 'vertical but not young');
  const p = selectConfidenceTier(tick({ ...SCORE2, createdAt: T0 - 5 * MIN }));
  assert.equal(p.tier, 'T0'); assert.equal(p.score, 2, 'the score is still reported');
});

// ───────────────────────────── the engine (clampEntry) ─────────────────────────────

test('v4 tiers: the engine sizes at the tier, records the unproven cap, and T0 is refused (skip)', () => {
  const s = resolved(tierDoc());
  const book = new SimBook(s, T0);
  const r = clampEntry(book, tick(), {});
  assert.ok(r.ok);
  assert.equal(r.usd, 250, '25% of the $1000 book');
  assert.equal(r.tier?.tier, 'T3');
  assert.deepEqual(r.clamps, [{ rule: 'tier-unproven-cap', fromUsd: 750, toUsd: 250 }]);
  assert.match(r.basis, /^tier T3 \(score 1\/2\) 25% of \$1000/);
  const skip = clampEntry(new SimBook(s, T0), tick(SCORE0), {});
  assert.equal(skip.ok, false);
  assert.ok(!skip.ok && skip.refused === 'tier-T0' && skip.tier?.tier === 'T0');
  // The agent may ask for less, never more.
  const less = clampEntry(new SimBook(s, T0), tick(), { sizeUsd: 40 });
  assert.ok(less.ok && less.usd === 40);
  const more = clampEntry(new SimBook(s, T0), tick(), { sizePct: 90 });
  assert.ok(more.ok && more.usd === 250);
});

test('v4 tiers: the stricter limit wins (strategy max %, max $, profile max %, drawdown size-down, cash)', () => {
  const at = (over: (d: Record<string, any>) => void) => clampEntry(new SimBook(resolved(tierDoc(undefined, over)), T0), tick(SCORE2), {});
  const pct = at((d) => { d.sizing.maxPctOfBankroll = 10; });
  assert.ok(pct.ok && pct.usd === 100 && pct.clamps.some((c) => c.rule === 'strategy-max-pct'));
  const usd = at((d) => { d.sizing.maxUsd = 60; });
  assert.ok(usd.ok && usd.usd === 60 && usd.clamps.some((c) => c.rule === 'strategy-max-usd'));
  const prof = at((d) => { d.exits.profiles[0].sizing.maxSizePctOfBankroll = 5; });
  assert.ok(prof.ok && prof.usd === 50 && prof.clamps.some((c) => c.rule === 'profile-max-pct'));
  const s = resolved(tierDoc());
  const book = new SimBook(s, T0);
  book.state.sizeDown = true;
  const dd = clampEntry(book, tick(SCORE2), {});
  assert.ok(dd.ok && dd.usd === 125 && dd.clamps.some((c) => c.rule === 'drawdown-size-down'));
  // $900 of the $1000 book already in another coin (oneOpen off): only $100 of cash / exposure is left
  const busy = new SimBook(resolved(tierDoc({ table: 'v4-1785', experimental: 'paper-only', oneOpen: false })), T0);
  const held = tick({ mint: MINT_B });
  busy.openPosition(held, { t: T0, side: 'buy', usd: 900, tokens: 900, price: 1, avgPrice: 1, impactPct: 0, partial: false, reason: 'entry' }, busy.strategy.exits.profiles.swing, null, [], []);
  const cash = clampEntry(busy, tick(SCORE2), {});
  assert.ok(cash.ok && cash.usd === 100 && cash.clamps.some((c) => c.rule === 'max-exposure' || c.rule === 'cash'), JSON.stringify(cash));
});

test('v4 tiers: one open position at a time (oneOpen default true); oneOpen false leaves maxConcurrent to decide', async () => {
  const s = resolved(tierDoc());
  const r1 = await runAutotrade({ strategy: s, tape: tape([tick({ t: T0 }), tick({ mint: MINT_B, symbol: 'BEE', t: T0 + 1000 }), tick({ t: T0 + 2 * MIN }), tick({ mint: MINT_B, symbol: 'BEE', t: T0 + 2 * MIN + 1000 })]), sessions: null });
  assert.equal(r1.book.open.size, 1);
  assert.ok((r1.refusals['precheck:tier-one-open'] ?? 0) >= 1);
  const s2 = resolved(tierDoc({ table: 'v4-1785', experimental: 'paper-only', oneOpen: false }));
  const r2 = await runAutotrade({ strategy: s2, tape: tape([tick({ t: T0 }), tick({ mint: MINT_B, symbol: 'BEE', t: T0 + 1000 }), tick({ t: T0 + 2 * MIN })]), sessions: null });
  assert.equal(r2.book.open.size, 2);
});

// ───────────────────────────── paper only ─────────────────────────────

test('v4 tiers: validateStrategy refuses the block in mode real and live, and needs the rug-proof pool age', () => {
  for (const mode of ['real', 'live']) {
    const r = validateStrategy(tierDoc(undefined, (d) => { d.mode = mode; }));
    assert.equal(r.ok, false, mode);
    assert.ok(!r.ok && r.errors.some((e) => e.path === '/sizing/tiers' && /PAPER ONLY/.test(e.msg) && e.msg.includes(mode)), mode);
  }
  assert.equal(validateStrategy(tierDoc(undefined, (d) => { d.mode = 'real'; d.sizing.tiers = null; })).ok, true, 'a real strategy without tiers still validates');
  const noRug = validateStrategy(tierDoc(undefined, (d) => { d.entry.safety.rugproof = null; }));
  assert.ok(!noRug.ok && noRug.errors.some((e) => e.path === '/entry/safety/rugproof'));
  const short = validateStrategy(tierDoc(undefined, (d) => { d.entry.safety.rugproof.minPoolAgeMin = 5; }));
  assert.ok(!short.ok && short.errors.some((e) => e.path === '/entry/safety/rugproof'));
  for (const bad of [{ table: 'v9', experimental: 'paper-only' }, { table: 'v4-1785' }, { table: 'v4-1785', experimental: 'yes' }]) assert.equal(validateStrategy(tierDoc(bad)).ok, false, JSON.stringify(bad));
});

test('v4 tiers: the runner refuses the block outside paper (a real-signal hook, mode real) even when validation was bypassed', async () => {
  const s = resolved(tierDoc());
  const t = tape([tick()]);
  const fakeReal = {} as unknown as RealRunHook;
  await assert.rejects(runAutotrade({ strategy: s, tape: t, sessions: null, real: fakeReal }), /confidence tiers .*PAPER ONLY: refused in a real-signal run/);
  await assert.rejects(runAutotrade({ strategy: { ...s, mode: 'real' }, tape: t, sessions: null, real: fakeReal }), /PAPER ONLY: refused in a real-signal run/);
  await assert.rejects(runAutotrade({ strategy: { ...s, mode: 'real' }, tape: t, sessions: null }), /PAPER ONLY: refused in mode "real"/);
  await assert.rejects(runAutotrade({ strategy: { ...s, mode: 'live' }, tape: t, sessions: null }), /PAPER ONLY: refused in mode "live"/);
  // and the engine itself, for a document that reached it another way
  const eng = clampEntry(new SimBook({ ...s, mode: 'real' }, T0), tick(), {});
  assert.ok(!eng.ok && eng.refused === 'tiers-paper-only');
  // the same strategy on paper runs and enters
  const ok = await runAutotrade({ strategy: s, tape: tape([tick(), tick({ t: T0 + MIN })]), sessions: null });
  assert.equal(ok.book.open.size, 1);
});

// ───────────────────────────── honest text ─────────────────────────────

const BANNED = /\bproven\b|win[- ]?rate|\bwin \d|\bpicks\b|\b\d+(\.\d+)?x\b|profit|guarantee|moon|win fast|full port/i;

test('v4 tiers: validation prints the verdict, every tier with its evidence, and the provenance (no names, no paths)', () => {
  assert.equal(TIERS_VERDICT, 'EXPERIMENTAL, UNPROVEN, PAPER ONLY: on our held-out data no tier made money and no dexterm strategy has shown an edge; every tier runs at 25% of the book at most.');
  const r = validateStrategy(tierDoc());
  assert.ok(r.ok);
  const w = r.warnings.filter((x) => x.path === '/sizing/tiers').map((x) => x.msg);
  assert.equal(w[0], TIERS_VERDICT);
  assert.ok(w.some((m) => m.startsWith('T3') && m.includes('configured 75%, runs at 25% (unproven: capped)') && m.includes('unproven: held-out n 17, mean -7.6% per entry, lower bound -31.8%')));
  assert.ok(w.some((m) => m.startsWith('T4') && m.includes('unproven: held-out n 0 (too small to say)')));
  assert.ok(w.some((m) => m.startsWith('T0') && m.includes('skip: held-out n 19, mean -17.0% per entry, lower bound -35.7%')));
  assert.ok(w.some((m) => /task-1785.*frozen 2026-10-28.*held-out scored once/.test(m)));
  for (const m of [...w, ...tierTableLines()]) {
    assert.doesNotMatch(m, BANNED, m);
    assert.doesNotMatch(m, /\/Users\/|\/home\/|[A-Z]:\\|override/i, m);
  }
});

test('v4 tiers: `dexterm autotrade validate` shows the verdict and the tiers', async () => {
  const { validateCmd } = await import('../../cli/src/autotrade-cmd/strategies.ts');
  const dir = mkdtempSync(join(tmpdir(), 'v4-tiers-'));
  try {
    const f = join(dir, 'tiers.json');
    writeFileSync(f, JSON.stringify(tierDoc()));
    let out = ''; let err = '';
    const code = validateCmd([f], { stdout: { write: (s: string) => { out += s; } }, stderr: { write: (s: string) => { err += s; } }, env: { ...process.env, DEXTERM_HOME: dir } });
    assert.equal(code, 0, err);
    assert.ok(out.includes(`warning /sizing/tiers: ${TIERS_VERDICT}`));
    assert.match(out, /warning \/sizing\/tiers: T3 score >= 1: configured 75%, runs at 25% \(unproven: capped\)/);
    writeFileSync(f, JSON.stringify(tierDoc(undefined, (d) => { d.mode = 'real'; })));
    out = '';
    assert.equal(validateCmd([f], { stdout: { write: (s: string) => { out += s; } }, stderr: { write: () => {} }, env: { ...process.env, DEXTERM_HOME: dir } }), 2);
    assert.match(out, /error \/sizing\/tiers: confidence tiers are EXPERIMENTAL and PAPER ONLY: refused in mode real/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v4 tiers: every entry writes a TIER line with tier, evidence and verdict; a T0 coin writes a SKIP line and never enters', async () => {
  const s = resolved(tierDoc());
  const lines: string[] = [];
  const r = await runAutotrade({
    strategy: s, sessions: null, onLine: (l) => lines.push(l),
    tape: tape([tick({ mint: MINT_B, symbol: 'ZERO', ...SCORE0, t: T0 }), tick({ t: T0 + 1000 }), tick({ mint: MINT_B, symbol: 'ZERO', ...SCORE0, t: T0 + MIN }), tick({ t: T0 + 2 * MIN, price: 1.01 })]),
  });
  const tiers = lines.filter((l) => l.startsWith('TIER '));
  const skip = tiers.filter((l) => l.startsWith('TIER T0 for ZERO'));
  assert.equal(skip.length, 1, 'one SKIP line per coin');
  assert.match(skip[0], /SKIP \(size 0\) · skip: held-out n 19, mean -17\.0% per entry, lower bound -35\.7%/);
  const entry = tiers.find((l) => l.startsWith('TIER T3 for TEST'));
  assert.ok(entry, lines.join('\n'));
  assert.match(entry!, /score 1\/2 \(turnover1h-max\) · configured 75%, runs at 25% of the book \(unproven: capped\) · \$250 after the strategy's limits · unproven: held-out n 17, mean -7\.6% per entry, lower bound -31\.8%/);
  for (const l of tiers) { assert.ok(l.endsWith(TIERS_VERDICT), l); assert.doesNotMatch(l, BANNED, l); }
  assert.equal(r.book.open.size, 1);
  assert.ok(r.book.open.has(MINT_A) && !r.book.open.has(MINT_B));
  assert.ok((r.refusals['precheck:tier-T0'] ?? 0) >= 1);
  const clamp = r.ledger.events.find((e) => e.kind === 'clamp') as Record<string, any>;
  assert.equal(clamp.tier.tier, 'T3'); assert.equal(clamp.tier.runsAtPct, 25); assert.equal(clamp.tier.capped, true);
  assert.match(clamp.tier.evidence, /^unproven: held-out n 17/);
  assert.equal(verifyChain(r.ledger.events).ok, true);
  assert.match(confidenceTierLine(selectConfidenceTier(tick(SCORE2)), tick()), /TIER T4 .* · unproven: held-out n 0 \(too small to say\) · EXPERIMENTAL/);
});

// ───────────────────────────── default off ─────────────────────────────

/**
 * Every shipped preset on the committed tape: the stub-agent run (ledger chain head + every log line) and the
 * mechanical backtest report, hashed. The digests were taken on the code BEFORE this feature (integration-0.2.1
 * fcc3916) by this exact procedure; a preset without sizing.tiers must reproduce them byte for byte.
 */
const GOLDEN: Record<string, { hash: string; digest: string }> = {
  swing: { hash: 'be171962d0568f46', digest: '4fa381ae18e0e1ce' },
  moonbag: { hash: '67fc4c95f08620eb', digest: 'a456c6f82e5baf99' },
  scalp: { hash: '70d65ef11ab72be0', digest: '0bb62a98a96e504c' },
  runner: { hash: '82b98b1cd31f6699', digest: '31ebcc6cc3be0a74' },
  'sample-dip-ladder': { hash: '607ba6bf86cf82a9', digest: 'abbb7569b8354df0' },
  yolo: { hash: 'f7857ca3bacffb77', digest: 'c02c6e77fabb1d23' },
};
async function presetDigest(s: ResolvedStrategy): Promise<{ digest: string; trades: number }> {
  const lines: string[] = [];
  const r = await runAutotrade({ strategy: s, tape: loadTape(TAPE), sessions: stubSession({ askPct: 50 }), pacing: { mode: 'lockstep' }, verbose: true, onLine: (l) => lines.push(l) });
  const ch = verifyChain(r.ledger.events);
  const { report } = await backtest(s, loadTape(TAPE));
  return { digest: createHash('sha256').update(JSON.stringify({ head: ch.ok ? ch.head : null, lines, report })).digest('hex').slice(0, 16), trades: r.trades.length };
}

test('v4 tiers: default off: every shipped preset is byte-identical to the pre-feature run on the fixture tape', async () => {
  for (const [id, g] of Object.entries(GOLDEN)) {
    const s = loadPreset(id);
    assert.equal(s.sizing.tiers, undefined, `${id} does not opt in`);
    assert.equal(s.hash, g.hash, `${id}: strategy hash unchanged`);
    const d = await presetDigest(s);
    assert.equal(d.digest, g.digest, `${id}: run + backtest digest unchanged`);
  }
});

test('v4 tiers: tiers null behaves like no block; opting in changes the run (the block is live, not inert)', async () => {
  const off = loadPreset('swing');
  const nul = resolved({ ...JSON.parse(readFileSync(presetPath('swing'), 'utf8')), sizing: { ...off.sizing, tiers: null } });
  const a = await backtest(off, loadTape(TAPE));
  const b = await backtest(nul, loadTape(TAPE));
  assert.deepEqual(b.run.trades, a.run.trades);
  assert.deepEqual(b.run.refusals, a.run.refusals);
  const on = resolved({ ...JSON.parse(readFileSync(presetPath('swing'), 'utf8')), entry: { ...off.entry, safety: { ...off.entry.safety, rugproof: { ...RUGPROOF_DEFAULTS } } }, sizing: { ...off.sizing, tiers: { table: 'v4-1785', experimental: 'paper-only' } } });
  const c = await backtest(on, loadTape(TAPE));
  assert.ok(Object.keys(c.run.refusals).some((k) => k.startsWith('precheck:tier-')), JSON.stringify(c.run.refusals));
  assert.ok((c.run.clamps['tier-unproven-cap'] ?? 0) > 0);
});

test('v4 tiers: an analyst proposal that adds the block is LOOSER (two keypresses), as any field with no risk rule', async () => {
  const { riskDelta } = await import('../../mcp/src/autotrade-tools.ts');
  const before = resolved(tierDoc(null));
  const after = resolved(tierDoc());
  const d = riskDelta(before, after);
  assert.equal(d.delta, 'looser');
  assert.ok(d.reasons.some((x) => x.path.startsWith('/sizing/tiers')));
});

// ───────────────────────────── 0.2.2: try to break it ─────────────────────────────
// task-2148: every way a strategy file, the agent, the tape or the clock could push a tiered entry above 25% of the
// book, into real mode, or onto a tick it should not trust.

/** A strategy object that skipped validation, every limit opened wide (only the tier logic and the engine cap remain). */
function wide(over: (s: any) => void = () => {}): ResolvedStrategy {
  const s = structuredClone(resolved(tierDoc())) as any;
  s.sizing.maxPctOfBankroll = 100; s.sizing.maxUsd = 1e9;
  for (const p of Object.values(s.exits.profiles) as any[]) p.sizing.maxSizePctOfBankroll = 100;
  s.risk.perTrade.maxLossPctOfBankroll = 100; s.risk.maxExposurePct = 100; s.execution.maxPriceImpactPct = 100;
  over(s);
  return s;
}
const bigLiq = { liq: 10_000_000, vol1h: 1_000_000 };   // price impact never binds

test('break it (0.2.2): the strategy file cannot lift the cap (unknown keys refused, limits above 25% refused by the schema)', () => {
  for (const extra of [{ capPct: 100 }, { unprovenCapPct: 100 }, { sizePct: 100 }, { evidence: 'proven' }, { tiers: [{ id: 'T4', sizePct: 100 }] }, { hardCapPct: 50 }]) {
    const r = validateStrategy(tierDoc({ table: 'v4-1785', experimental: 'paper-only', ...extra }));
    assert.equal(r.ok, false, JSON.stringify(extra));
  }
  const pct = validateStrategy(tierDoc(undefined, (d) => { d.sizing.maxPctOfBankroll = 100; }));
  assert.equal(pct.ok, false, 'sizing.maxPctOfBankroll above 25 is refused');
  const prof = validateStrategy(tierDoc(undefined, (d) => { d.exits.profiles[0].sizing.maxSizePctOfBankroll = 100; }));
  assert.equal(prof.ok, false, 'a profile max above 25 is refused');
});

test('break it (0.2.2): with every limit opened wide (validation bypassed) the engine still sizes a tier at 25% at most', () => {
  const s = wide();
  for (const [name, k] of [['T3', tick({ ...bigLiq })], ['T4', tick({ ...bigLiq, buys5m: 400, sells5m: 100 })]] as const) {
    const r = clampEntry(new SimBook(s, T0), k, {});
    assert.ok(r.ok, name);
    assert.equal(r.tier?.tier, name);
    assert.equal(r.usd, 250, `${name}: 25% of the $1000 book`);
    assert.ok(r.usd <= tierHardCapUsd(1000) + 1e-9);
  }
  assert.equal(TIERS_HARD_CAP_PCT, 25);
  assert.equal(tierHardCapUsd(1000), 250);
  for (const bad of [NaN, Infinity, -1, 0]) assert.equal(tierHardCapUsd(bad), 0, String(bad));
  // A table that claims a higher cap (or proof) still runs at the code's 25%.
  const loose: TierTable = { ...CONFIDENCE_TIERS_V4, unprovenCapPct: 100, tiers: CONFIDENCE_TIERS_V4.tiers.map((t) => ({ ...t, evidence: 'proven' as const })) };
  for (const t of loose.tiers.slice(1)) assert.ok(tierRunsAtPct(t, loose).pct <= 25, t.id);
  const nan: TierTable = { ...CONFIDENCE_TIERS_V4, unprovenCapPct: NaN, tiers: CONFIDENCE_TIERS_V4.tiers.map((t) => ({ ...t, sizePct: NaN })) };
  for (const t of nan.tiers.slice(1)) assert.deepEqual(tierRunsAtPct(t, nan), { pct: 0, capped: false }, `${t.id} NaN runs at 0`);
});

test('break it (0.2.2): the agent and the sizing mode cannot raise a tier (size from the tick only, never from a model)', () => {
  const s = wide();
  const k = tick({ ...bigLiq });
  for (const req of [{ sizePct: 100 }, { sizeUsd: 1e9 }, { sizeUsd: Infinity }, { sizePct: NaN }, { confidence: 1 }, { confidence: 99, sizePct: 100 }]) {
    const r = clampEntry(new SimBook(s, T0), k, req);
    assert.ok(r.ok && r.usd === 250, `${JSON.stringify(req)} -> ${JSON.stringify(r)}`);
  }
  // The agent's confidence does not move the tier: the tick decides.
  assert.equal(clampEntry(new SimBook(s, T0), tick({ ...bigLiq, vol1h: 1e9 }), { confidence: 1 }).ok, false);
  for (const mode of [{ mode: 'fixed', fixedUsd: 1e6 }, { mode: 'pct', pct: 100 }, { mode: 'risk', riskPct: 100 }, { mode: 'confidence', confidence: { minPct: 100, maxPct: 100, default: 1 } }]) {
    const r = clampEntry(new SimBook(wide((x) => { Object.assign(x.sizing, mode); }), T0), k, { confidence: 1 });
    assert.ok(r.ok && r.usd === 250, `${mode.mode}: ${JSON.stringify(r)}`);
  }
});

test('break it (0.2.2): a ladder cannot stack a tiered position above 25% (tranche fractions above 1, validation bypassed)', async () => {
  const run = async (fracs: number[]) => {
    const s = wide((x) => { x.sizing.ladder = fracs.map((frac, i) => ({ frac, atPct: i === 0 ? 0 : -5, withinMin: 60 })); });
    const r = await runAutotrade({ strategy: s, sessions: null, tape: tape([tick({ ...bigLiq, t: T0 }), tick({ ...bigLiq, t: T0 + MIN }), tick({ ...bigLiq, t: T0 + 2 * MIN, price: 0.94 }), tick({ ...bigLiq, t: T0 + 3 * MIN, price: 0.94 }), tick({ ...bigLiq, t: T0 + 4 * MIN, price: 0.94 })]) });
    const p = [...r.book.open.values()][0];
    return { r, p };
  };
  const a = await run([0.5, 1.5]);   // 125 at entry, then an add of 375 asked
  assert.ok(a.p, 'entered');
  assert.ok(a.p.costUsd <= 250 + 0.01, `position cost ${a.p.costUsd} stays within 25% of the book`);
  assert.ok(a.p.costUsd > 125 + 1, 'the add still filled up to the ceiling');
  const b = await run([1, 1]);       // 250 at entry: no room for any add
  assert.ok(b.p && b.p.costUsd <= 250 + 0.01, `position cost ${b.p?.costUsd}`);
  assert.ok((b.r.refusals['ladder-add-tier-hard-cap'] ?? 0) >= 1, JSON.stringify(b.r.refusals));
});

test('break it (0.2.2): oneOpen false still sizes each tiered position at 25% at most', async () => {
  const s = wide((x) => { x.sizing.tiers = { table: 'v4-1785', experimental: 'paper-only', oneOpen: false }; x.risk.maxConcurrent = 4; });
  const r = await runAutotrade({ strategy: s, sessions: null, tape: tape([tick({ ...bigLiq, t: T0 }), tick({ ...bigLiq, mint: MINT_B, symbol: 'BEE', t: T0 + 1000 }), tick({ ...bigLiq, t: T0 + MIN }), tick({ ...bigLiq, mint: MINT_B, symbol: 'BEE', t: T0 + MIN + 1000 })]) });
  assert.equal(r.book.open.size, 2);
  for (const p of r.book.open.values()) assert.ok(p.costUsd <= 250 + 0.01, `${p.symbol} ${p.costUsd}`);
});

test('break it (0.2.2): real mode cannot load or run it (file load, store list, validation, runner, engine)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v4-tiers-real-'));
  try {
    for (const mode of ['real', 'live']) {
      const f = join(dir, `${mode}.json`);
      writeFileSync(f, JSON.stringify(tierDoc(undefined, (d) => { d.mode = mode; d.id = `tiers-${mode}`; })));
      const r = loadStrategyFile(f);
      assert.ok(!r.ok && r.errors.some((e) => e.path === '/sizing/tiers' && /PAPER ONLY/.test(e.msg)), mode);
    }
    // A real-mode tiers file dropped into the store lists as INVALID (it never resolves to a runnable strategy).
    const store = new StrategyStore({ home: dir });
    mkdirSync(store.dir, { recursive: true });
    writeFileSync(join(store.dir, 'tiers-real.json'), JSON.stringify(tierDoc(undefined, (d) => { d.mode = 'real'; d.id = 'tiers-real'; })));
    const row = store.list().find((x) => x.id === 'tiers-real');
    assert.ok(row && row.ok === false, JSON.stringify(row));
    // and a paper one is marked EXPERIMENTAL in the list
    writeFileSync(join(store.dir, 'tiers-paper.json'), JSON.stringify(tierDoc(undefined, (d) => { d.id = 'tiers-paper'; })));
    assert.equal(store.list().find((x) => x.id === 'tiers-paper')?.experimentalTiers, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const s = resolved(tierDoc());
  for (const mode of ['real', 'live'] as const) {
    await assert.rejects(runAutotrade({ strategy: { ...s, mode }, tape: tape([tick()]), sessions: null }), /PAPER ONLY/);
    const eng = clampEntry(new SimBook({ ...s, mode }, T0), tick(), {});
    assert.ok(!eng.ok && (eng.refused === 'tiers-paper-only' || eng.refused === 'mode-not-paper'), `${mode}: ${JSON.stringify(eng)}`);
    assert.equal(eng.ok ? null : eng.tier, undefined, `${mode}: refused before any tier is scored`);
  }
});

test('break it (0.2.2): missing tick fields never score a point and never pass a gate', () => {
  const g = CONFIDENCE_TIERS_V4.gates;
  for (const f of ['liq', 'vol1h', 'buys5m', 'sells5m'] as const) {
    for (const v of [null, undefined]) {
      const k = tick({ ...SCORE2, [f]: v } as Partial<MarketTick>);
      const p = selectConfidenceTier(k);
      assert.ok(p.score < 2, `${f}=${v}: score ${p.score}`);
    }
  }
  // a JSON row with the fields absent altogether
  const bare = tick(SCORE2) as any; delete bare.vol1h; delete bare.buys5m; delete bare.sells5m;
  assert.equal(selectConfidenceTier(bare).score, 0);
  assert.equal(selectConfidenceTier(bare).tier, 'T0');
  const noLiq = tick({ ...SCORE2, liq: null }); assert.equal(selectConfidenceTier(noLiq).tier, 'T0');
  const noAge = tick({ ...SCORE2, createdAt: null }); assert.equal(selectConfidenceTier(noAge).tier, 'T0');
  // a young coin (1 h old) without a 1 h change cannot be cleared of "vertical"
  assert.match(tierGateFailures(tick({ createdAt: T0 - 60 * MIN, chg1h: null }), g).join(), /young and h1 unknown/);
  assert.deepEqual(tierGateFailures(tick({ createdAt: T0 - 3 * 3600e3, chg1h: null }), g), [], 'not young: h1 is not needed');
});

test('break it (0.2.2): NaN, Infinity and negative figures fail closed', () => {
  const g = CONFIDENCE_TIERS_V4.gates;
  for (const bad of [NaN, Infinity, -Infinity, -1]) {
    const s = tierSignals(tick({ liq: bad, vol1h: bad, buys5m: bad, sells5m: bad }));
    assert.deepEqual([s.liq, s.vol1h, s.turnover1h, s.buys5m, s.sells5m, s.bs5m], [null, null, null, null, null, null], String(bad));
    assert.equal(selectConfidenceTier(tick({ ...SCORE2, vol1h: bad })).points[0].pass, false, `vol1h ${bad}`);
    assert.equal(selectConfidenceTier(tick({ ...SCORE2, sells5m: bad })).points[1].pass, false, `sells5m ${bad} (never "all buys")`);
    assert.equal(selectConfidenceTier(tick({ ...SCORE2, liq: bad })).tier, 'T0', `liq ${bad}`);
    assert.equal(selectConfidenceTier(tick({ ...SCORE2, createdAt: bad })).tier, 'T0', `createdAt ${bad}`);   // -1: epoch nonsense, unknown
    if (!Number.isFinite(bad)) assert.equal(selectConfidenceTier(tick({ ...SCORE2, chg1h: bad, createdAt: T0 - 60 * MIN })).tier, 'T0', `young, chg1h ${bad}`);   // -1% is a real figure
  }
  // A NaN tick time used to slip past the pool-age gate ((NaN - createdAt) < 10 is false): now it fails.
  assert.ok(tierGateFailures(tick({ t: NaN }), g, T0).some((x) => /tick time unknown/.test(x)));
  assert.equal(selectConfidenceTier(tick({ ...SCORE2, t: NaN }), CONFIDENCE_TIERS_V4, T0).tier, 'T0');
  assert.equal(selectConfidenceTier(tick(SCORE2), CONFIDENCE_TIERS_V4, NaN).tier, 'T0', 'a NaN decision time');
  // a future token creation time (negative age) is not an old pool
  assert.equal(selectConfidenceTier(tick({ ...SCORE2, createdAt: T0 + 3600e3 })).tier, 'T0');
  // the engine on an all-NaN tick refuses
  const all = tick({ liq: NaN, vol1h: NaN, buys5m: NaN, sells5m: NaN, createdAt: NaN, chg1h: NaN, price: NaN });
  const r = clampEntry(new SimBook(wide(), T0), all, {});
  assert.equal(r.ok, false);
  // a NaN book (corrupted state) never sizes above 0
  const book = new SimBook(wide(), T0);
  (book as any).bookEquity = () => NaN;
  const nb = clampEntry(book, tick({ ...bigLiq }), {});
  assert.ok(!nb.ok, JSON.stringify(nb));
});

test('break it (0.2.2): a stale, future or swept tick is T0 (bs5m is a 5 min window)', () => {
  const s = resolved(tierDoc());
  const k = tick(SCORE2);
  const at = (now: number, kk: MarketTick = k) => clampEntry(new SimBook(s, T0), kk, {}, false, now);
  assert.equal(TIER_TICK_MAX_AGE_MS, 5 * MIN);
  assert.ok(at(T0).ok, 'fresh');
  assert.ok(at(T0 + 5 * MIN).ok, 'exactly 5 min old still counts');
  const stale = at(T0 + 5 * MIN + 1);
  assert.ok(!stale.ok && stale.refused === 'tier-T0' && stale.tier?.gates.some((x) => /tick stale/.test(x)), JSON.stringify(stale));
  const future = at(T0 - 1);
  assert.ok(!future.ok && future.tier?.gates.some((x) => /after the decision time/.test(x)), JSON.stringify(future));
  const swept = at(T0, tick({ ...SCORE2, kind: 'sweep' }));
  assert.ok(!swept.ok && swept.tier?.gates.some((x) => /tick not live/.test(x)), JSON.stringify(swept));
  // the line says why
  assert.match(confidenceTierLine(stale.ok ? (null as never) : stale.tier!, k), /SKIP \(size 0\) · gate: tick stale \(301 s old > 300 s\)/);
  // without tiers the clock argument changes nothing
  const plain = resolved(tierDoc(null));
  assert.deepEqual(clampEntry(new SimBook(plain, T0), k, {}, false, T0 + 3600e3), clampEntry(new SimBook(plain, T0), k, {}));
});

test('break it (0.2.2): the runner hands its own clock to every clampEntry call (the stale-tick gate is live in runs)', async () => {
  // Every entry clamp in the runner (pre-check, the agent's decision on the coin's latest tick, an approval re-clamp,
  // the tiered re-clamp when an approval lands)
  // passes the runner's virtual now, so a decision that lands after the coin's last tick went stale is T0.
  const src = readFileSync(new URL('../src/runner.ts', import.meta.url), 'utf8');
  const calls = [...src.matchAll(/clampEntry\(book, [^;]*?, killed[^;]*?\)\)?(?=[,;])/g)].map((m) => m[0]);
  assert.equal(calls.length, 4, calls.join('\n'));
  for (const c of calls) assert.match(c, /, killed, now, inFlight\((c|k)\.mint\)\)/, c);
  // and a run on fresh ticks still enters
  const lines: string[] = [];
  const r = await runAutotrade({ strategy: resolved(tierDoc()), sessions: null, onLine: (l) => lines.push(l), tape: tape([tick({ t: T0 }), tick({ mint: MINT_B, symbol: 'BEE', ...SCORE0, t: T0 + 10 * MIN })]) });
  assert.equal(r.book.open.size, 1);
  assert.ok(lines.some((l) => l.startsWith('TIER T3 for TEST')));
});

test('break it (0.2.2): the verdict is on every surface (validate CLI, list, MCP strategy_get) and claims nothing', async () => {
  const { AutotradeTools } = await import('../../mcp/src/autotrade-tools.ts');
  const { listCmd } = await import('../../cli/src/autotrade-cmd/strategies.ts');
  const home = mkdtempSync(join(tmpdir(), 'v4-tiers-mcp-'));
  try {
    const store = new StrategyStore({ home });
    const c = store.create(tierDoc(undefined, (d) => { d.id = 'my-tiers'; d.name = 'tiers test'; }), { actor: 'user' });
    assert.ok(c.ok, c.ok ? '' : JSON.stringify(c.errors));
    const t = new AutotradeTools({ env: { ...process.env, DEXTERM_HOME: home }, actor: 'analyst' });
    for (const tool of ['strategy_get']) {
      const g = await t.call(tool, { id: 'my-tiers' });
      const text = JSON.stringify(g);
      assert.ok(text.includes(TIERS_VERDICT), `${tool}: ${text.slice(0, 400)}`);
      assert.match(text, /runs at 25% \(unproven: capped\)/, tool);
    }
    let out = '';
    assert.equal(listCmd([], { stdout: { write: (x: string) => { out += x; } }, stderr: { write: () => {} }, env: { ...process.env, DEXTERM_HOME: home } }), 0);
    assert.match(out.split('\n').find((l) => l.includes('my-tiers'))!, /EXPERIMENTAL tiers \(unproven, paper only\)/);
    assert.doesNotMatch(out.split('\n').find((l) => l.includes(' swing '))!, /EXPERIMENTAL tiers/, 'presets are not marked');
  } finally { rmSync(home, { recursive: true, force: true }); }
  for (const l of [TIERS_VERDICT, ...tierTableLines()]) {
    assert.doesNotMatch(l, BANNED, l);
    assert.doesNotMatch(l, /loses money more slowly|shown to win|\bbetter\b|\bbeats?\b|\bgains?\b/i, l);
  }
  assert.match(TIERS_VERDICT, /UNPROVEN/);
  assert.match(TIERS_VERDICT, /no dexterm strategy has shown an edge/);
});

// ───────────────────────────── task-2156: in-flight entries (the latency window) ─────────────────────────────
// The verifier's FAIL: with execution.latencyMs > 0 (every preset ships 3000) an entry decided but not filled was
// not counted, so four coins on one tick opened four tiered positions. These run at the preset latency.

const MINTS = ['TierC1111111111111111111111111111111111pump', 'TierD1111111111111111111111111111111111pump', 'TierE1111111111111111111111111111111111pump', 'TierF1111111111111111111111111111111111pump'];
/** Four score-2 coins printing on the same tick, every minute for 6 minutes. */
const burst = (): Tape => tape(Array.from({ length: 6 }, (_, m) => MINTS.map((mint, i) => tick({ ...SCORE2, mint, symbol: `C${i}`, t: T0 + m * MIN }))).flat());
function presetTiers(id: string, over: (d: Record<string, any>) => void = () => {}): ResolvedStrategy {
  const d = JSON.parse(readFileSync(presetPath(id), 'utf8'));
  d.entry.decide = 'auto';
  d.entry.ageHours = { min: 0, max: 168 };
  d.entry.safety.rugproof = { ...RUGPROOF_DEFAULTS };
  d.sizing.tiers = { table: 'v4-1785', experimental: 'paper-only' };
  over(d);
  return resolved(d);
}
const costs = (r: { book: SimBook }) => [...r.book.open.values()].map((p) => p.costUsd);

test('task-2156: one open position holds at the preset latency (3000 ms) with four coins on one tick (swing, yolo, runner)', async () => {
  for (const id of ['swing', 'yolo', 'runner']) {
    const s = presetTiers(id);
    assert.ok(s.execution.latencyMs > 0, `${id} ships a latency`);
    const r = await runAutotrade({ strategy: s, tape: burst(), sessions: null });
    assert.equal(r.book.open.size, 1, `${id}: ${r.book.open.size} open, refusals ${JSON.stringify(r.refusals)}`);
    for (const c of costs(r)) assert.ok(c <= tierHardCapUsd(s.bankroll.startUsd) + 0.01, `${id}: cost ${c}`);
    assert.ok((r.refusals['precheck:tier-one-open'] ?? 0) + (r.refusals['tier-one-open'] ?? 0) >= 3, `${id}: ${JSON.stringify(r.refusals)}`);
  }
});

test('task-2156: an agent-decided tiered entry counts while it waits for its fill (decide agent, latency 3000)', async () => {
  for (const id of ['swing', 'runner']) {
    const s = presetTiers(id, (d) => { d.entry.decide = 'agent'; });
    const r = await runAutotrade({ strategy: s, tape: burst(), sessions: stubSession({ askPct: 50 }), pacing: { mode: 'lockstep' } });
    assert.ok(r.book.open.size <= 1, `${id}: ${r.book.open.size} open`);
  }
});

test('task-2156: oneOpen false: in-flight entries count toward maxConcurrent and come off the exposure room', async () => {
  const s = wide((x) => { x.sizing.tiers = { table: 'v4-1785', experimental: 'paper-only', oneOpen: false }; x.risk.maxConcurrent = 2; x.risk.maxExposurePct = 30; x.execution.latencyMs = 3000; });
  const t = tape(Array.from({ length: 6 }, (_, m) => MINTS.map((mint, i) => tick({ ...SCORE2, ...bigLiq, buys5m: 400, sells5m: 100, mint, symbol: `C${i}`, t: T0 + m * MIN }))).flat());
  const r = await runAutotrade({ strategy: s, tape: t, sessions: null });
  assert.ok(r.book.open.size <= 2, `${r.book.open.size} open`);
  const total = costs(r).reduce((a, b) => a + b, 0);
  assert.ok(total <= 300 + 0.05, `total cost ${total} within 30% exposure of the $1000 book`);
  for (const c of costs(r)) assert.ok(c <= 250 + 0.01, `cost ${c}`);
});

test('task-2156: an open approval counts as in flight (no second proposal while the first waits)', async () => {
  const s = presetTiers('swing');
  const asked: string[] = [];
  const open: ((o: ApprovalOutcome) => void)[] = [];
  const hook: ApprovalHook = {
    required: () => true,
    request: (p) => { asked.push(p.mint); return new Promise((res) => { open.push(res); }); },   // unanswered until the run ends
    cancelAll: (why) => { for (const res of open.splice(0)) res({ approved: false, state: 'CANCELLED', why }); },
  };
  const r = await runAutotrade({ strategy: s, tape: burst(), sessions: null, approvals: hook, pacing: { mode: 'paced', msPerTick: 0 } });
  assert.equal(asked.length, 1, `proposals: ${asked.join(', ')}`);
  assert.equal(r.book.open.size, 0);
  assert.ok((r.refusals['precheck:tier-one-open'] ?? 0) >= 3, JSON.stringify(r.refusals));
});

test('task-2156: the clamp counts in-flight entries only with tiers on, and fails closed on a bad figure', () => {
  const s = resolved(tierDoc());
  const k = tick(SCORE2);
  assert.ok(clampEntry(new SimBook(s, T0), k, {}, false, T0, { opens: 0, usd: 0 }).ok);
  const busy = clampEntry(new SimBook(s, T0), k, {}, false, T0, { opens: 1, usd: 100 });
  assert.ok(!busy.ok && busy.refused === 'tier-one-open', JSON.stringify(busy));
  for (const bad of [{ opens: NaN, usd: 0 }, { opens: -1, usd: 0 }, { opens: Infinity, usd: 0 }]) {
    const r = clampEntry(new SimBook(s, T0), k, {}, false, T0, bad);
    assert.ok(!r.ok && r.refused === 'tier-one-open', JSON.stringify(bad));
  }
  const many = resolved(tierDoc({ table: 'v4-1785', experimental: 'paper-only', oneOpen: false }));
  const conc = clampEntry(new SimBook(many, T0), k, {}, false, T0, { opens: many.risk.maxConcurrent, usd: 0 });
  assert.ok(!conc.ok && conc.refused === 'max-concurrent', JSON.stringify(conc));
  const room = clampEntry(new SimBook(many, T0), k, {}, false, T0, { opens: 0, usd: NaN });
  assert.ok(!room.ok, 'NaN in-flight dollars take the whole room');
  const part = clampEntry(new SimBook(many, T0), k, {}, false, T0, { opens: 0, usd: 900 });
  assert.ok(part.ok && part.usd === 100 && part.clamps.some((c) => c.rule === 'max-exposure' || c.rule === 'cash'), JSON.stringify(part));
  // without tiers the argument changes nothing (presets keep their behaviour; the pre-existing gap is out of scope)
  const plain = resolved(tierDoc(null));
  assert.deepEqual(clampEntry(new SimBook(plain, T0), k, {}, false, T0, { opens: 9, usd: 1e9 }), clampEntry(new SimBook(plain, T0), k, {}));
});

test('task-2156: an approved tiered entry still opens through the re-clamp at the approval, at the tier size', async () => {
  const s = presetTiers('swing');
  const asked: number[] = [];
  const hook: ApprovalHook = {
    required: () => true,
    request: async (p) => { asked.push(p.usd); return { approved: true, proposalId: `p${asked.length}`, usd: p.usd * 10, via: 'test' }; },
    cancelAll: () => {},
  };
  const r = await runAutotrade({ strategy: s, tape: burst(), sessions: null, approvals: hook });
  assert.equal(r.book.open.size, 1, JSON.stringify(r.refusals));
  assert.equal(asked.length, 1, 'one proposal: the others wait behind the first');
  const [c] = costs(r);
  assert.ok(c <= asked[0] + 0.01 && c <= tierHardCapUsd(s.bankroll.startUsd) + 0.01, `cost ${c} vs proposed ${asked[0]} (an approval asking 10x cannot grow it)`);
});
