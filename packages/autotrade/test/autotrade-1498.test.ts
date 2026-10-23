// task-1498: the autotrade spike — strategy schema, the clamp, the position monitor, replay determinism,
// the decision protocol and the session loop (stub sessions only: no network, no keys, paper only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { builtinProfiles, loadPreset, presetPath, validateStrategy, type ResolvedStrategy } from '../src/strategy.ts';
import { EntryRules, SimBook, clampEntry, simBuy, simSell } from '../src/engine.ts';
import { monitorTick } from '../src/monitor.ts';
import { loadTape, type MarketTick, type Tape } from '../src/replay.ts';
import { parseDecision, stubSession, type AgentSession, type SessionFactory } from '../src/session.ts';
import { runAutotrade } from '../src/runner.ts';
import { backtest, splitTape, sweep, withParams } from '../src/backtest.ts';

const TAPE = fileURLToPath(new URL('./fixtures/autotrade-1498-tape.json', import.meta.url));
const T0 = 1_792_000_000_000;
const MIN = 60_000;

function tick(over: Partial<MarketTick> = {}): MarketTick {
  return {
    mint: 'Mint1111111111111111111111111111111111111111', t: T0, kind: 'live', symbol: 'TEST', launchpad: 'pump.fun', createdAt: T0 - 3 * 3600e3,
    price: 1, mcap: 1e6, mcapResolved: 1e6, mcapFlagged: false, liq: 100_000, vol5m: 10_000, vol1h: 50_000, vol24: 500_000,
    buys5m: 120, sells5m: 80, buys24: 5000, sells24: 4000, chg5m: 4, chg1h: 20, chg6h: 40, chg24h: 80,
    holders: 900, top10: 20, dev: 1, mintAuth: false, freezeAuth: false, org: 70, ...over,
  };
}

const rawPreset = (id: string) => JSON.parse(readFileSync(presetPath(id), 'utf8'));

// ───────────────────────────── schema ─────────────────────────────

test('1498 schema: the three shipped presets and the custom sample validate, with stable hashes', () => {
  for (const id of ['scalp', 'swing', 'runner', 'sample-dip-ladder']) {
    const r = validateStrategy(rawPreset(id));
    assert.ok(r.ok, `${id}: ${!r.ok ? JSON.stringify(r.errors) : ''}`);
    assert.equal(r.strategy.mode, 'paper');
    assert.match(r.strategy.hash, /^[0-9a-f]{16}$/);
    assert.equal(validateStrategy(rawPreset(id)).ok && (validateStrategy(rawPreset(id)) as { strategy: ResolvedStrategy }).strategy.hash, r.strategy.hash);
  }
  const lib = builtinProfiles();
  assert.deepEqual(Object.keys(lib).sort(), ['moonbag', 'runner', 'scalp', 'swing']);
  for (const p of Object.values(lib)) assert.equal(p.version, p.id === 'moonbag' ? '1.2.0' : '1.1.0'); // moonbag needs the 1.2.0 fields
});

test('1498 schema: closed objects refuse a key/signer section and unknown fields, with a path', () => {
  const doc = rawPreset('swing');
  doc.signer = { key: 'x' };
  doc.execution.walletPath = '/tmp/w';
  const r = validateStrategy(doc);
  assert.equal(r.ok, false);
  const paths = !r.ok ? r.errors.map((e) => `${e.path} ${e.msg}`) : [];
  assert.ok(paths.includes('/signer unknown key'), paths.join('\n'));
  assert.ok(paths.includes('/execution/walletPath unknown key'), paths.join('\n'));
});

test('1498 schema: cross-field rules (ladder order, sell fractions, sizing params, drawdown order, filter grammar)', () => {
  const bad = (mut: (d: Record<string, any>) => void) => { const d = rawPreset('sample-dip-ladder'); mut(d); const r = validateStrategy(d); assert.equal(r.ok, false); return !r.ok ? r.errors.map((e) => `${e.path}: ${e.msg}`).join('\n') : ''; };
  assert.match(bad((d) => { d.exits.profiles[0].tpLadder = [{ atPct: 90, sellFrac: 0.3 }, { atPct: 40, sellFrac: 0.3 }]; }), /strictly ascending/);
  assert.match(bad((d) => { d.exits.profiles[0].tpLadder = [{ atPct: 40, sellFrac: 0.7 }, { atPct: 90, sellFrac: 0.6 }]; }), /more than the whole position/);
  assert.match(bad((d) => { delete d.sizing.riskPct; }), /sizing mode risk needs riskPct/);
  assert.match(bad((d) => { d.sizing.ladder[1].frac = 0.9; }), /add up to 1/);
  assert.match(bad((d) => { d.risk.drawdown.sizeDownAtPct = 50; }), /must not exceed haltAtPct/);
  assert.match(bad((d) => { d.entry.screen = 'liq >= banana'; }), /\/entry\/screen: bad number/);
  assert.match(bad((d) => { d.exits.default = 'nope'; }), /default profile nope/);
  assert.match(bad((d) => { d.exits.profiles[1] = 'builtin:moonshot'; }), /unknown builtin profile/);
  assert.match(bad((d) => { d.sizing.maxPctOfBankroll = 80; }), /\/sizing\/maxPctOfBankroll: above 25/);
});

test('1498 schema: live mode validates with a warning, and the runner refuses it', async () => {
  const d = rawPreset('swing');
  d.mode = 'live';
  const r = validateStrategy(d);
  assert.ok(r.ok);
  assert.ok(r.warnings.some((w) => w.path === '/mode'));
  await assert.rejects(runAutotrade({ strategy: r.ok ? r.strategy : (null as never), tape: { source: 't', ticks: [tick()], mints: [] }, sessions: null }), /paper only/);
});

// ───────────────────────────── clamp ─────────────────────────────

test('1498 clamp: an agent asking for more than the strategy allows gets the strategy size, every cut named', () => {
  const s = loadPreset('swing'); // pct 10, max 15 % (profile swing 15 %), maxUsd 500, bankroll 1000
  const book = new SimBook(s, T0);
  const r = clampEntry(book, tick(), { sizePct: 60, confidence: 1 });
  assert.ok(r.ok);
  assert.equal(r.usd, 100);
  assert.deepEqual(r.clamps.map((c) => c.rule), ['strategy-size']);
  assert.deepEqual(r.clamps[0], { rule: 'strategy-size', fromUsd: 600, toUsd: 100 });
  const huge = clampEntry(book, tick(), { sizeUsd: 1e9 });
  assert.ok(huge.ok && huge.usd === 100);
  const less = clampEntry(book, tick(), { sizeUsd: 40 });
  assert.ok(less.ok && less.usd === 40 && less.clamps.length === 0, 'asking for less is honoured');
});

test('1498 clamp: hard ceilings (max usd, per-trade loss, impact on a thin pool, cash) and refusals', () => {
  const doc = rawPreset('runner'); // confidence 5..20 % of bankroll
  doc.bankroll.startUsd = 10_000;
  const s = (validateStrategy(doc) as { strategy: ResolvedStrategy }).strategy;
  const book = new SimBook(s, T0);
  const r = clampEntry(book, tick({ createdAt: T0 - 10 * 3600e3 }), { confidence: 1 });
  assert.ok(r.ok);
  assert.equal(r.usd, 500, 'maxUsd 500 caps a 20 % ($2000) confidence pick');
  assert.ok(r.clamps.some((c) => c.rule === 'strategy-max-usd'));
  // A big bankroll on a thin pool: the price-impact ceiling binds before the size rules do.
  doc.bankroll.startUsd = 50_000;
  doc.sizing.maxUsd = 100_000;
  const big = (validateStrategy(doc) as { strategy: ResolvedStrategy }).strategy;
  const thin = clampEntry(new SimBook(big, T0), tick({ liq: 60_000 }), { confidence: 1 });
  assert.ok(thin.ok);
  assert.deepEqual(thin.clamps.map((c) => c.rule), ['price-impact']);
  const fill = simBuy(tick({ liq: 60_000 }), thin.ok ? thin.usd : 0, s.execution);
  assert.ok(!('refused' in fill) && fill.impactPct <= s.execution.maxPriceImpactPct + 0.01, 'a clamped size fills inside the impact cap');

  const sw = loadPreset('swing');
  const b2 = new SimBook(sw, T0);
  assert.deepEqual(clampEntry(b2, tick(), {}, true), { ok: false, refused: 'kill-switch', clamps: [] });
  b2.state.halted = 'drawdown';
  assert.equal((clampEntry(b2, tick(), {}) as { refused: string }).refused, 'halted:drawdown');
  b2.state.halted = null;
  b2.state.cooldownUntil = T0 + MIN;
  assert.equal((clampEntry(b2, tick(), {}) as { refused: string }).refused, 'loss-streak-cooldown');
  b2.state.cooldownUntil = 0;
  b2.state.sizeDown = true;
  const half = clampEntry(b2, tick(), {});
  assert.ok(half.ok && half.usd === 50 && half.clamps[0].rule === 'drawdown-size-down');
  assert.equal((clampEntry(b2, tick({ liq: 20_000 }), {}) as { refused: string }).refused, 'profile-min-liquidity');
});

test('1498 clamp: max concurrent + per-coin re-entry rules', () => {
  const s = loadPreset('swing'); // maxConcurrent 2, perCoin maxEntries 1
  const book = new SimBook(s, T0);
  for (const m of ['A', 'B']) {
    const k = tick({ mint: m.repeat(44) });
    const r = clampEntry(book, k, {});
    assert.ok(r.ok);
    const f = simBuy(k, r.usd, s.execution);
    assert.ok(!('refused' in f));
    book.openPosition(k, f, s.exits.profiles.swing, null, [], []);
  }
  assert.equal((clampEntry(book, tick({ mint: 'C'.repeat(44) }), {}) as { refused: string }).refused, 'max-concurrent');
  const pa = book.open.get('A'.repeat(44))!;
  const sold = simSell(tick({ mint: pa.mint }), pa.tokens, s.execution, 'test');
  assert.ok(!('refused' in sold));
  book.sell(pa, sold);
  assert.equal((clampEntry(book, tick({ mint: pa.mint, t: T0 + 2 * 3600e3 }), {}) as { refused: string }).refused, 'per-coin-max-entries');
});

// ───────────────────────────── monitor ─────────────────────────────

function held(id: 'scalp' | 'swing' | 'runner' = 'swing') {
  const s = loadPreset(id === 'scalp' ? 'scalp' : 'swing');
  const book = new SimBook(s, T0);
  const k = tick();
  const f = simBuy(k, 100, s.execution);
  assert.ok(!('refused' in f));
  const p = book.openPosition(k, f, s.exits.profiles[id], 's1', ['trigger:screen'], []);
  return { s, book, p, prof: s.exits.profiles[id], o: { minExitLiquidityUsd: s.execution.minExitLiquidityUsd } };
}

test('1498 monitor: TP ladder sells fractions of the original size, then the trail closes the rest; wakes the session', () => {
  const { p, prof, o } = held('swing'); // +50 → 0.33, +100 → 0.33, trail arms +40, 25 % off peak
  const a1 = monitorTick(p, prof, tick({ t: T0 + 2 * MIN, price: 1.55 }), o);
  const sells1 = a1.filter((a) => a.kind === 'sell');
  assert.equal(sells1.length, 1);
  assert.equal(sells1[0].kind === 'sell' && sells1[0].reason, 'tp1');
  assert.ok(sells1[0].kind === 'sell' && Math.abs(sells1[0].tokens - p.origTokens * 0.33) < 1e-9);
  assert.ok(a1.some((a) => a.kind === 'wake' && a.wake.event === 'tp_filled'));
  p.tokens -= sells1[0].kind === 'sell' ? sells1[0].tokens : 0;
  // A gap straight through TP2 and back down 30 % from the new peak: TP2 on the spike tick, trail on the next.
  const a2 = monitorTick(p, prof, tick({ t: T0 + 4 * MIN, price: 2.4 }), o);
  assert.ok(a2.some((a) => a.kind === 'sell' && a.reason === 'tp2'));
  for (const a of a2) if (a.kind === 'sell') p.tokens -= a.tokens;
  const a3 = monitorTick(p, prof, tick({ t: T0 + 6 * MIN, price: 1.7 }), o);
  const trail = a3.find((a) => a.kind === 'sell');
  assert.ok(trail && trail.kind === 'sell' && trail.reason === 'trail' && trail.all);
  assert.ok(a3.some((a) => a.kind === 'wake' && a.wake.event === 'mechanical_exit'));
});

test('1498 monitor: scalp hard stop and time exit fire mechanically; a swing time review only wakes', () => {
  const sc = held('scalp');
  const stop = monitorTick(sc.p, sc.prof, tick({ t: T0 + MIN, price: 0.7 }), sc.o);
  assert.ok(stop[0].kind === 'sell' && stop[0].reason === 'stop' && stop[0].all);

  const sc2 = held('scalp');
  const time = monitorTick(sc2.p, sc2.prof, tick({ t: T0 + 21 * MIN, price: 1.02 }), sc2.o);
  assert.ok(time[0].kind === 'sell' && time[0].reason === 'time');

  const sw = held('swing');
  const rev = monitorTick(sw.p, sw.prof, tick({ t: T0 + 91 * MIN, price: 1.03 }), sw.o);
  assert.ok(!rev.some((a) => a.kind === 'sell'), 'a review never sells by itself');
  assert.ok(rev.some((a) => a.kind === 'wake' && a.wake.event === 'time_review'));
  assert.equal(monitorTick(sw.p, sw.prof, tick({ t: T0 + 95 * MIN, price: 1.03 }), sw.o).filter((a) => a.kind === 'wake').length, 0, 'once');
});

test('1498 monitor: liquidity pull = rug exit; an unsellable bag is stuck and valued at 0', async () => {
  const sw = held('swing');
  const drain = monitorTick(sw.p, sw.prof, tick({ t: T0 + 2 * MIN, price: 0.9, liq: 60_000 }), sw.o);
  assert.ok(drain[0].kind === 'sell' && drain[0].reason === 'thesis-liquidity');
  const rug = held('swing');
  const gone = monitorTick(rug.p, rug.prof, tick({ t: T0 + 2 * MIN, price: 0.01, liq: 500 }), rug.o);
  assert.ok(gone[0].kind === 'sell' && gone[0].reason === 'rug-liquidity');
  assert.deepEqual(simSell(tick({ price: 0.01, liq: 500 }), rug.p.tokens, rug.s.execution, 'rug'), { refused: 'illiquid' });

  // End to end through the runner: the bag cannot be sold, the trade stays open as stuck, the report counts it at 0.
  const s = loadPreset('swing');
  const mint = 'R'.repeat(44);
  const ticks = [tick({ mint, t: T0 }), tick({ mint, t: T0 + MIN }), tick({ mint, t: T0 + 2 * MIN, price: 0.02, liq: 400 }), tick({ mint, t: T0 + 4 * MIN, price: 0.02, liq: 400 })];
  const { report } = await backtest(s, { source: 'synthetic', ticks, mints: [mint] });
  assert.equal(report.trades, 1);
  assert.equal(report.stuck, 1);
  assert.ok(report.netUsd <= -99, `a rugged $100 entry loses it all: ${report.netUsd}`);
});

test('1498 monitor: thesis split, volume death and the holding cap', () => {
  const a = held('swing');
  const split = monitorTick(a.p, a.prof, tick({ t: T0 + MIN, mcap: 1e6, mcapResolved: 7e6 }), a.o);
  assert.ok(split[0].kind === 'sell' && split[0].reason === 'thesis-split');
  const b = held('swing'); // volumeDeath: < 10 trades per 5 min for 15 min
  monitorTick(b.p, b.prof, tick({ t: T0 + MIN, buys5m: 3, sells5m: 2 }), b.o);
  assert.equal(monitorTick(b.p, b.prof, tick({ t: T0 + 10 * MIN, buys5m: 3, sells5m: 2 }), b.o).filter((x) => x.kind === 'sell').length, 0);
  const dead = monitorTick(b.p, b.prof, tick({ t: T0 + 17 * MIN, buys5m: 3, sells5m: 2 }), b.o);
  assert.ok(dead[0].kind === 'sell' && dead[0].reason === 'thesis-volume');
  const c = held('swing'); // maxHoldMinutes 720
  const cap = monitorTick(c.p, c.prof, tick({ t: T0 + 721 * MIN, price: 1.2 }), c.o);
  assert.ok(cap[0].kind === 'sell' && cap[0].reason === 'max-hold');
});

// ───────────────────────────── screen ─────────────────────────────

test('1498 screen: the screener grammar plus safety gates decide candidates, with the failed rules named', () => {
  const rules = new EntryRules(loadPreset('swing'));
  assert.deepEqual(rules.screen(tick()), { pass: true, matched: ['trigger:screen'], failed: [] });
  assert.deepEqual(rules.screen(tick({ mintAuth: true })).failed, ['screen', 'mint-authority']);
  assert.deepEqual(rules.screen(tick({ top10: null })).failed, ['holders-unknown']);
  assert.deepEqual(rules.screen(tick({ createdAt: T0 - 30 * MIN, chg1h: 300 })).failed, ['age', 'young-vertical']);
  assert.deepEqual(rules.screen(tick({ liq: 10_000 })).failed, ['screen']);
  const scalp = new EntryRules(loadPreset('scalp'));
  assert.deepEqual(scalp.screen(tick({ chg5m: 1 })).failed, ['trigger']);
});

// ───────────────────────────── decisions ─────────────────────────────

test('1498 decision protocol: the last DECISION line wins, closed schema, junk refused', () => {
  const ok = parseDecision('looks good\nDECISION {"action":"wait","reason":"a"}\nmore thoughts\n`DECISION {"action":"enter","sizePct":12,"confidence":0.8,"reason":"b"}`');
  assert.deepEqual(ok, { ok: true, decision: { action: 'enter', sizePct: 12, confidence: 0.8, reason: 'b' } });
  assert.equal(parseDecision('no decision here').ok, false);
  assert.match((parseDecision('DECISION {"action":"enter"') as { error: string }).error, /not JSON/);
  assert.match((parseDecision('DECISION {"action":"buy_all","reason":"x"}') as { error: string }).error, /action/);
  assert.match((parseDecision('DECISION {"action":"enter","reason":"x","signTx":"..."}') as { error: string }).error, /signTx unknown key/);
  assert.match((parseDecision('DECISION {"action":"exit","fraction":7,"reason":"x"}') as { error: string }).error, /fraction above 1/);
});

// ───────────────────────────── replay + loop ─────────────────────────────

test('1498 replay: the recorded tape loads in a deterministic order', () => {
  const a = loadTape(TAPE), b = loadTape(TAPE);
  assert.equal(a.ticks.length, 2509);
  assert.equal(a.mints.length, 12);
  for (let i = 1; i < a.ticks.length; i++) assert.ok(a.ticks[i].t > a.ticks[i - 1].t || (a.ticks[i].t === a.ticks[i - 1].t && a.ticks[i].mint >= a.ticks[i - 1].mint));
  assert.deepEqual(a.ticks.map((k) => `${k.t}${k.mint}${k.price}`), b.ticks.map((k) => `${k.t}${k.mint}${k.price}`));
});

test('1498 replay determinism: two stub-agent runs over the recorded tape produce the same ledger, byte for byte', async () => {
  const s = { ...loadPreset('scalp') };
  const run = () => runAutotrade({ strategy: s, tape: loadTape(TAPE), sessions: stubSession({ askPct: 50 }), pacing: { mode: 'lockstep' }, verbose: true });
  const [a, b] = [await run(), await run()];
  assert.ok(a.trades.length > 0, 'the stub enters on the tape');
  assert.ok(a.sessions > 0);
  assert.equal(a.ledger.head(), b.ledger.head());
  assert.deepEqual(a.ledger.events, b.ledger.events);
  // The agent asked for 50 % every time; the clamp cut every entry to the strategy size.
  const clamps = a.ledger.events.filter((e) => e.kind === 'clamp');
  assert.ok(clamps.length > 0);
  for (const c of clamps) {
    const r = c.result as { ok: boolean; usd?: number; clamps: { rule: string }[] };
    if (r.ok) { assert.ok(r.usd! <= 1000 * 0.1 + 1e-6, `≤ 10 % of the bankroll: ${r.usd}`); assert.equal(r.clamps[0].rule, 'strategy-size'); }
  }
  // Every session got a dossier first, and every closed trade has a mechanical or agent exit reason.
  const firstMsg = new Map<string, string>();
  for (const e of a.ledger.events) if (e.kind === 'message' && !firstMsg.has(e.sessionId as string)) firstMsg.set(e.sessionId as string, e.text as string);
  for (const t of firstMsg.values()) assert.match(t, /^DOSSIER /);
  for (const t of a.trades) assert.match(t.exitReason, /^(tp\d|trail|stop|time|thesis-\w+|rug-liquidity|max-hold|agent-exit|time_review:no-answer)$/);
  assert.ok(a.ledger.events.some((e) => e.kind === 'session_start' && e.agent === 'stub'), 'event kinds are never overwritten by data fields');
  // The hash chain links every event to the previous one.
  for (let i = 1; i < a.ledger.events.length; i++) assert.equal(a.ledger.events[i].prev, a.ledger.events[i - 1].hash);
});

test('1498 backtest: report + held-out split + sweep are deterministic and keep TEST out of tuning', async () => {
  const s = loadPreset('swing');
  const tape = loadTape(TAPE);
  const [r1, r2] = [(await backtest(s, tape)).report, (await backtest(s, tape)).report];
  assert.deepEqual(r1, r2);
  assert.equal(r1.trades, r1.wins + r1.losses);
  assert.ok(Object.values(r1.byExit).reduce((a, b) => a + b.n, 0) === r1.trades);
  assert.ok(r1.limits.length >= 4);
  const { train, test: held } = splitTape(tape, 0.3);
  assert.equal(train.mints.length + held.mints.length, 12);
  assert.ok(!train.mints.some((m) => held.mints.includes(m)), 'no coin in both halves');
  const sw = await sweep(s, tape, { 'profile.trailingStop.trailPct': [15, 30], 'sizing.pct': [5, 10] }, { max: 4 });
  assert.equal(sw.combos, 4);
  assert.match(sw.verdict, /too few trades \(train \d+, held-out \d+; both need >= 20\): no tuning claim/);
  assert.equal(withParams(s, { 'profile.trailingStop.trailPct': 30 }).exits.profiles.swing.trailingStop!.trailPct, 30);
  assert.throws(() => withParams(s, { 'profile.trailingStop.trailPct': 99 }), /invalid/);
});

// A session with a real delay, to prove deltas coalesce while the agent thinks and late replies never execute.
function slowSession(delayMs: number, script: (n: number, text: string) => string, log: string[]): SessionFactory {
  return (id): AgentSession => {
    let n = 0;
    return {
      id, kind: 'stub', costUsd: () => 0,
      async send(text) {
        log.push(text);
        n++;
        await new Promise((r) => setTimeout(r, delayMs));
        const t = script(n, text);
        return { text: t, decision: parseDecision(t), costUsd: 0, ms: delayMs };
      },
      async close(reason) { return { turns: n, costUsd: 0, reason }; },
    };
  };
}

function trendTape(n: number, mint = 'T'.repeat(44)): Tape {
  const ticks = Array.from({ length: n }, (_, i) => tick({ mint, t: T0 + i * 2 * MIN, price: 1 + i * 0.01, chg5m: 2 }));
  return { source: 'synthetic', ticks, mints: [mint] };
}

test('1498 session loop: deltas coalesce while the agent thinks (paced), the decision is clamped, wakes reach the session', async () => {
  const log: string[] = [];
  const s = loadPreset('swing');
  const tape = trendTape(40);
  tape.ticks.push(tick({ mint: tape.mints[0], t: T0 + 41 * 2 * MIN, price: 0.1, liq: 30_000 })); // a drain: mechanical exit
  const r = await runAutotrade({
    strategy: { ...s, agent: { ...s.agent, deltaEverySec: 1 } }, tape, pacing: { mode: 'paced', msPerTick: 5 },
    sessions: slowSession(40, (n, text) => (text.startsWith('EVENT') ? 'DECISION {"action":"hold","reason":"ok"}' : n < 3 ? 'DECISION {"action":"wait","reason":"watch"}' : 'DECISION {"action":"enter","sizePct":90,"reason":"go"}'), log),
  });
  assert.ok(log[0].startsWith('DOSSIER'));
  assert.ok(log.some((m) => (m.match(/^DELTA #/gm) ?? []).length >= 2), `some message carries several deltas:\n${log.slice(0, 3).join('\n---\n')}`);
  const clamp = r.ledger.events.find((e) => e.kind === 'clamp')!;
  assert.deepEqual((clamp.result as { clamps: unknown[] }).clamps[0], { rule: 'strategy-size', fromUsd: 900, toUsd: 100 });
  assert.equal(r.trades.length, 1);
  assert.equal(r.trades[0].exitReason, 'thesis-liquidity');
  assert.ok(log.some((m) => m.startsWith('EVENT mechanical_exit')), 'the session is woken after the mechanical exit');
});

test('1498 session loop: a reply that lands after its candidate expired is ignored, never executed', async () => {
  const s = loadPreset('swing');
  const mint = 'L'.repeat(44);
  // The coin stops matching (liquidity under the screen) right after the dossier: the candidate expires.
  const ticks = [tick({ mint, t: T0 }), ...Array.from({ length: 6 }, (_, i) => tick({ mint, t: T0 + (i + 1) * 4 * MIN, liq: 20_000 }))];
  const r = await runAutotrade({
    strategy: { ...s, entry: { ...s.entry, candidateTtlSec: 60 } }, tape: { source: 'synthetic', ticks, mints: [mint] }, pacing: { mode: 'paced', msPerTick: 5 },
    sessions: slowSession(60, () => 'DECISION {"action":"enter","reason":"late"}', []),
  });
  assert.equal(r.trades.length + r.openAtEnd.length, 0, 'nothing was bought');
  assert.ok(r.ledger.events.some((e) => e.kind === 'session_end'));
  assert.equal(r.ledger.events.filter((e) => e.kind === 'clamp').length, 0);
});

test('1498 kill switch: engaging it stops new entries and closes sessions; mechanical exits still run', async () => {
  const s = loadPreset('scalp');
  let engaged = false;
  let n = 0;
  const r = await runAutotrade({ strategy: s, tape: loadTape(TAPE), sessions: stubSession(), killSwitch: () => { n++; if (n === 1200) engaged = true; return engaged; } });
  const halt = r.ledger.events.find((e) => e.kind === 'halt' && e.reason === 'kill-switch');
  assert.ok(halt);
  assert.equal(r.ledger.events.filter((e) => e.kind === 'candidate' && e.seq > halt.seq).length, 0);
  assert.equal(r.ledger.events.filter((e) => e.kind === 'fill' && e.side === 'buy' && e.seq > halt.seq).length, 0);
});

test('1498 session loop: an agent exit on a drawdown wake closes the trade AND ends the session at once', async () => {
  const s = loadPreset('swing'); // wake.drawdownPct -30, no hard stop
  const mint = 'D'.repeat(44);
  const ticks = [tick({ mint, t: T0 }), tick({ mint, t: T0 + MIN }), tick({ mint, t: T0 + 3 * MIN, price: 0.66 }), ...Array.from({ length: 5 }, (_, i) => tick({ mint, t: T0 + (5 + i) * MIN, price: 0.66 }))];
  const log: string[] = [];
  const r = await runAutotrade({
    strategy: s, tape: { source: 'synthetic', ticks, mints: [mint] }, pacing: { mode: 'lockstep' },
    sessions: slowSession(0, (_n, text) => (text.startsWith('EVENT drawdown') ? 'DECISION {"action":"exit","fraction":1,"reason":"thesis broken"}' : 'DECISION {"action":"enter","reason":"go"}'), log),
  });
  assert.equal(r.trades.length, 1);
  assert.equal(r.trades[0].exitReason, 'agent-exit');
  const closedAt = r.ledger.events.find((e) => e.kind === 'trade_closed')!;
  const end = r.ledger.events.find((e) => e.kind === 'session_end')!;
  assert.equal(end.reason, 'position-closed');
  assert.equal(end.t, closedAt.t, 'the session ends on the same step as the trade, not at the end of the tape');
});

test('1498 fills: an order fills at the price as of its fill time; a price that ran past the slippage tolerance refuses it', async () => {
  const s = loadPreset('swing'); // latencyMs 3000, slippageBps 100
  const mint = 'F'.repeat(44);
  const enter = () => slowSession(0, (_n, text) => (text.startsWith('DOSSIER') ? 'DECISION {"action":"enter","reason":"go"}' : 'DECISION {"action":"hold","reason":"ok"}'), []);
  // No new row before the fill: it fills at the decision row's price (+ the modelled slippage), not 2 min later.
  const calm = await runAutotrade({ strategy: s, tape: { source: 'synthetic', ticks: [tick({ mint, t: T0 }), tick({ mint, t: T0 + 2 * MIN, price: 1.3 })], mints: [mint] }, sessions: enter() });
  const buy = calm.ledger.events.find((e) => e.kind === 'fill' && e.side === 'buy')!;
  assert.equal(buy.price, 1);
  // A row inside the latency window shows the price ran 5 %: refused, the candidate closes, nothing is held.
  const ran = await runAutotrade({ strategy: s, tape: { source: 'synthetic', ticks: [tick({ mint, t: T0 }), tick({ mint, t: T0 + 2000, price: 1.05 }), tick({ mint, t: T0 + MIN, price: 1.05 })], mints: [mint] }, sessions: enter() });
  assert.equal(ran.trades.length + ran.openAtEnd.length, 0);
  assert.equal(ran.refusals['fill-slippage'], 1);
  assert.equal(ran.ledger.events.find((e) => e.kind === 'session_end')!.reason, 'refused:fill-slippage');
});

test('1498 wakes: several judgement calls on one tick reach the session as ONE message, with the fill note', async () => {
  const s = loadPreset('swing'); // wake.drawdownPct -30, thesisWarnFrac 0.6 of a 30 % liquidity drop
  const mint = 'W'.repeat(44);
  const log: string[] = [];
  const ticks = [tick({ mint, t: T0 }), tick({ mint, t: T0 + MIN }), tick({ mint, t: T0 + 2 * MIN, price: 0.68, liq: 79_000 }), tick({ mint, t: T0 + 3 * MIN, price: 0.68, liq: 79_000 })];
  await runAutotrade({ strategy: s, tape: { source: 'synthetic', ticks, mints: [mint] }, sessions: slowSession(0, (_n, t) => (t.startsWith('DOSSIER') ? 'DECISION {"action":"enter","reason":"go"}' : 'DECISION {"action":"hold","reason":"ok"}'), log) });
  const ev = log.filter((m) => m.startsWith('EVENT'));
  assert.equal(ev.length, 1, ev.join('\n---\n'));
  assert.match(ev[0], /EVENT drawdown/);
  assert.match(ev[0], /EVENT thesis_warning/);
  assert.match(ev[0], /ENGINE: your entry filled/);
});
