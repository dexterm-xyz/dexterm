// task-1654 (0.2.0 card E): the limits at signal time, on the recorded tape with FAKE executors only (a JSONL stream).
// The run's clock is the tape's, so minutes of silence and a day's counters mean what they say. Per-scope limits,
// a lower mid-run applies at once and a raise mid-run does not, max hold, TTL / slippage / impact in the signal, the
// executor-silence pause (and its resume), the loss limits with their notifications, persistence across runs, and
// verifier R7 (a state file that fails after the signal went out no longer refuses the fill).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { presetPath, validateStrategy, type ResolvedStrategy } from '../src/strategy.ts';
import { loadTape } from '../src/replay.ts';
import { runAutotrade, simExecutor } from '../src/runner.ts';
import { Outbox } from '../src/outbox.ts';
import { JsonlChannel } from '../src/signal-channels.ts';
import type { TradeFireSignal, TradeSignal } from '../src/signal.ts';
import { RealSignalExecutor, heldPath, openRealRun, readRealJournal, realModeCheck, saveArming } from '../src/real-mode.ts';
import { emptyLimits, limitsPath, loadRiskState, saveLimits, type LimitsDoc } from '../src/limits.ts';
import { appendHeartbeat } from '../src/executor-health.ts';
import { localDay } from '../src/chat/audit.ts';
import type { MarketTick } from '../src/replay.ts';
import { saveTyped } from './fixtures/typed-save.ts';

// task-1679 (hosted CI, UTC runners): the fixture tape runs across 2026-10-17 00:00 UTC, and real mode's daily
// counters are per LOCAL day by design. These tests assert one day's counters, so they run in the zone the fixture
// was recorded in (America/New_York: the whole tape is one local day there). Node re-reads TZ when it is assigned.
process.env.TZ = 'America/New_York';
const TAPE = loadTape(fileURLToPath(new URL('./fixtures/autotrade-1498-tape.json', import.meta.url)));
const T0 = Math.min(...(TAPE as unknown as { ticks: { t: number }[] }).ticks.map((k) => k.t));
const SOL_USD = 200;
const home = () => mkdtempSync(join(tmpdir(), 'dexterm-1654-enf-'));
/** Loose everywhere unless a test sets a number: what each test checks is its own limit. */
const LOOSE = { perTradeSol: 1000, dailySol: 1e6, buysPerDay: 1e5, maxOpenPositions: 50, dailyLossSol: null, lossStreak: null, maxBuysPerMinute: null, executorSilenceMin: null };

function realScalp(): ResolvedStrategy {
  const r = validateStrategy({ ...JSON.parse(readFileSync(presetPath('scalp'), 'utf8')), mode: 'real' });
  assert.ok(r.ok);
  return r.strategy;
}

function setup(h: string, s: ResolvedStrategy, d: Partial<LimitsDoc>, accountId = 'main') {
  const doc: LimitsDoc = { ...emptyLimits(), ...d, global: { ...LOOSE, ...(d.global ?? {}) } as LimitsDoc['global'] };
  assert.ok(saveTyped(h, doc).ok);
  saveArming(h, { strategyId: s.id, strategyHash: s.hash, version: s.version, accountId, armedAt: T0, caps: { perTradeSol: 1, dailySol: 1, buysPerDay: 1, maxOpenPositions: 1 }, channels: ['jsonl'], evidence: [], confirmation: { method: 'typed-tty', codeHash: 'x' } });
}

interface RunO { afterFill?: (n: number, side: 'buy' | 'sell', t: number) => void; onTick?: (t: number) => void; runId?: string }

async function realRun(h: string, s: ResolvedStrategy, o: RunO = {}) {
  const check = realModeCheck(h, s, ['jsonl']);
  assert.ok(check.ok, check.ok ? '' : check.why);
  let clock = T0;
  const now = () => clock;
  const stream = join(h, 'stream.jsonl');
  const outbox = Outbox.open(h, { channels: [new JsonlChannel(stream)], now });
  const runId = o.runId ?? `run-${Math.random().toString(36).slice(2, 8)}`;
  openRealRun(outbox, runId, s, check.arming.accountId, clock);
  const inner = simExecutor(s.execution);
  let fills = 0;
  let bookUsd = s.bankroll.startUsd;
  const notes: string[] = [];
  const real = new RealSignalExecutor({
    home: h, outbox, strategy: s, arming: check.arming, caps: check.caps, limits: check.limits.values, notify: (l) => notes.push(l), runId, ttlSec: 60, solUsd: () => SOL_USD, bookUsd: () => bookUsd, now,
    inner: {
      name: inner.name,
      buy: async (k, usd, ctx) => { clock = k.t; const f = await inner.buy(k, usd, ctx); if (!('refused' in f)) o.afterFill?.(++fills, 'buy', k.t); return f; },
      sell: async (k, t, r) => { clock = k.t; const f = await inner.sell(k, t, r); if (!('refused' in f)) o.afterFill?.(++fills, 'sell', k.t); return f; },
    },
  });
  const res = await runAutotrade({ strategy: s, tape: TAPE, sessions: null, executor: real, real, runId, onState: (st) => { clock = st.t; bookUsd = st.book.equityUsd; o.onTick?.(st.t); } });
  await outbox.pump();
  outbox.close();
  const sigs = readFileSync(stream, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as TradeFireSignal);
  return { res, real, notes, sigs, trades: sigs.filter((x): x is TradeSignal => x.type === 'trade'), fills: res.ledger.events.filter((e) => e.kind === 'fill') };
}

test('per-scope limits at signal time: the strategy and account scopes tighten the global one; clamps are on the ledger rows', async () => {
  const h = home();
  const s = realScalp();
  setup(h, s, { global: { perTradeSol: 0.2 }, strategies: { [s.id]: { perTradeSol: 0.1 } }, accounts: { main: { buysPerDay: 3 } } });
  const check = realModeCheck(h, s, ['jsonl']);
  assert.ok(check.ok);
  assert.equal(check.limits.values.perTradeSol, 0.1); assert.equal(check.limits.from.perTradeSol, `strategies.${s.id}`);
  assert.equal(check.limits.values.buysPerDay, 3); assert.equal(check.limits.from.buysPerDay, 'accounts.main');
  const r = await realRun(h, s);
  const buys = r.trades.filter((x) => x.side === 'buy');
  // The tape spans two local days: at most 3 buys on each (the counter resets at local midnight).
  const perDay = new Map<string, number>();
  for (const b of buys) { const k = localDay(b.issuedAt); perDay.set(k, (perDay.get(k) ?? 0) + 1); }
  assert.ok([...perDay.values()].every((n) => n <= 3) && [...perDay.values()].includes(3), JSON.stringify([...perDay]));
  assert.ok(buys.every((b) => b.sizeSol <= 0.1 + 1e-9), 'perTradeSol 0.1 from the strategy scope');
  assert.ok(r.res.refusals['fill-real-buys-per-day'] >= 1);
  const buyRows = r.fills.filter((e) => e.side === 'buy');
  assert.ok(buyRows.every((e) => Array.isArray(e.limitClamps) && (e.limitClamps as string[]).includes('perTradeSol')), 'each clamped buy says which limit clamped it');
  // The other account of the same strategy is not held to main's buys-per-day.
  setup(h, s, { global: { perTradeSol: 0.2 }, strategies: { [s.id]: { perTradeSol: 0.1 } }, accounts: { main: { buysPerDay: 3 } } }, 'desk-2');
  const c2 = realModeCheck(h, s, ['jsonl']);
  assert.ok(c2.ok && c2.limits.values.buysPerDay === 1e5);
});

test('a lower mid-run applies at the next signal; a raise mid-run waits for the next run (the stricter wins)', async () => {
  const h = home();
  const s = realScalp();
  setup(h, s, { global: { perTradeSol: 0.25 } });
  const lowered = await realRun(h, s, { afterFill: (n, side) => { if (n === 1 && side === 'buy') assert.ok(saveLimits(h, { ...emptyLimits(), global: { ...LOOSE, perTradeSol: 0.05 } } as LimitsDoc, { confirmed: [] }).ok); } });
  const b1 = lowered.trades.filter((x) => x.side === 'buy');
  assert.ok(b1[0].sizeSol > 0.2, 'the first buy at the start limit');
  assert.ok(b1.slice(1).length >= 2 && b1.slice(1).every((b) => b.sizeSol <= 0.05 + 1e-9), 'every later buy at the lowered limit');
  const h2 = home();
  setup(h2, s, { global: { perTradeSol: 0.05 } });
  const raised = await realRun(h2, s, { afterFill: (n, side) => { if (n === 1 && side === 'buy') assert.ok(saveTyped(h2, { ...emptyLimits(), global: { ...LOOSE, perTradeSol: 5 } } as LimitsDoc).ok); } });
  assert.ok(raised.trades.filter((x) => x.side === 'buy').every((b) => b.sizeSol <= 0.05 + 1e-9), 'a typed raise does not loosen a run in progress');
  // A file broken mid-run: buys refused (fail closed), exits still go out.
  const h3 = home();
  setup(h3, s, {});
  const broken = await realRun(h3, s, { afterFill: (n, side) => { if (n === 1 && side === 'buy') writeFileSync(limitsPath(h3), '{oops'); } });
  assert.ok(broken.res.refusals['fill-real-limits-unreadable'] >= 1);
  assert.ok(broken.trades.some((x) => x.side === 'sell'), 'the open position still exits');
});

test('max hold, TTL, slippage and price impact: the stricter of the limit and the strategy rides in every signal', async () => {
  const h = home();
  const s = realScalp();
  setup(h, s, { global: { maxHoldMinutes: 3, signalTtlSec: 20, maxSlippageBps: 100, maxPriceImpactPct: 0.5 } });
  const r = await realRun(h, s);
  assert.ok(r.trades.length >= 4);
  assert.ok(r.trades.every((x) => x.ttlSec === 20 && x.expiresAt - x.issuedAt === 20_000), 'TTL 20 s');
  assert.ok(r.trades.every((x) => x.slippageBps === Math.min(100, s.execution.slippageBps) && x.maxImpactPct === Math.min(0.5, s.execution.maxPriceImpactPct)));
  const closes = r.res.ledger.events.filter((e) => e.kind === 'trade_closed').map((e) => e.trade as { exitReason: string; openedAt: number; closedAt: number });
  assert.ok(closes.some((c) => c.exitReason === 'max-hold'), 'the limit tightened the profile\'s holding cap');
  // Out at the first tick past 3 min (a coin's ticks come ~every 1-2 min; one tape gap is longer).
  assert.ok(closes.filter((c) => c.closedAt - c.openedAt > 6 * 60_000).length <= 1, JSON.stringify(closes.map((c) => Math.round((c.closedAt - c.openedAt) / 1000))));
});

test('executor silence: no sign of life for executorSilenceMin pauses new buys (said once, exits still go out); a heartbeat resumes them', async () => {
  const s = realScalp();
  // The fake executor's heartbeat: once a minute of tape time (like the kit's --heartbeat-sec 60).
  const lastBeat = new Map<string, number>();
  const beat = (h: string, t: number) => { if (t - (lastBeat.get(h) ?? -Infinity) < 60_000) return; lastBeat.set(h, t); appendHeartbeat(h, { at: t, executor: 'fake', accountId: 'main', dryRun: true, lastNonce: null, note: null }); };
  // Heartbeats until 19:35Z, then nothing: buys before, a pause after (said once), and the open positions still exit.
  const STOP = Date.parse('2026-10-16T19:35:00Z');
  const h = home();
  setup(h, s, { global: { executorSilenceMin: 5 } });
  const quiet = await realRun(h, s, { onTick: (t) => { if (t < STOP) beat(h, t); } });
  const buys = quiet.trades.filter((x) => x.side === 'buy');
  assert.ok(buys.length >= 1 && buys.every((b) => b.issuedAt <= STOP + 5 * 60_000), 'no buy after the window passed');
  assert.ok(quiet.res.refusals['fill-real-executor-silent'] >= 1, 'buys refused while silent');
  assert.equal(quiet.notes.filter((l) => l.startsWith('EXECUTOR SILENT')).length, 1, 'said once');
  assert.match(quiet.notes[0], /new real BUY signals are paused; exits still go out/);
  assert.ok(quiet.trades.some((x) => x.side === 'sell' && x.issuedAt > STOP + 5 * 60_000), 'exits kept going out');
  assert.equal(readRealJournal(h).filter((l) => l.action === 'executor-silent').length, 1);
  // Heartbeats every tick: never paused.
  const h2 = home();
  setup(h2, s, { global: { executorSilenceMin: 5 } });
  const alive = await realRun(h2, s, { onTick: (t) => beat(h2, t) });
  assert.equal(alive.res.refusals['fill-real-executor-silent'] ?? 0, 0);
  assert.equal(alive.notes.length, 0);
  // Heartbeats that start late: paused first, then "EXECUTOR BACK" and buys again.
  const BACK = Date.parse('2026-10-17T00:00:00Z');
  const h3 = home();
  setup(h3, s, { global: { executorSilenceMin: 5 } });
  const late = await realRun(h3, s, { onTick: (t) => { if (t > BACK) beat(h3, t); } });
  assert.ok(late.notes.some((l) => l.startsWith('EXECUTOR SILENT')));
  assert.ok(late.notes.some((l) => l.startsWith('EXECUTOR BACK (heartbeat)')));
  assert.ok(late.trades.filter((x) => x.side === 'buy').every((x) => x.issuedAt > BACK), 'no buy while silent');
  assert.ok(late.trades.some((x) => x.side === 'buy'), 'buys resumed');
});

test('loss limits trip with a notification and persist: the daily loss stop, the loss streak, and the next run of the day sees the counters', async () => {
  const h = home();
  const s = realScalp();
  setup(h, s, { global: { dailyLossSol: 0.05, buysPerDay: 6 } });
  const r = await realRun(h, s);
  assert.ok(r.notes.some((l) => /^REAL LIMIT: daily loss limit reached/.test(l)), r.notes.join('\n'));
  assert.ok(r.res.refusals['fill-real-daily-loss'] >= 1);
  const risk = loadRiskState(h, r.trades.at(-1)!.issuedAt);
  assert.ok(risk.dayPnlSol <= -0.05);
  assert.ok(risk.buys >= 1);
  // A restart later the same day (a new executor, a new outbox): the day's loss carried over, so a buy is refused.
  const last = r.trades.at(-1)!.issuedAt + 60_000;
  const check = realModeCheck(h, s, ['jsonl']);
  assert.ok(check.ok);
  const ob = Outbox.open(h, { channels: [], now: () => last });
  const again = new RealSignalExecutor({ home: h, inner: simExecutor(s.execution), outbox: ob, strategy: s, arming: check.arming, caps: check.caps, limits: check.limits.values, runId: 'run-restart', ttlSec: 60, solUsd: () => SOL_USD, bookUsd: () => 1000, now: () => last });
  const k = { ...(TAPE as unknown as { ticks: MarketTick[] }).ticks.find((x) => x.liq && x.price)!, t: last };
  const v = await again.buy(k, 50);
  ob.close();
  assert.ok('refused' in v && (v.refused === 'real-daily-loss' || v.refused === 'real-buys-per-day'), JSON.stringify(v));
  if (localDay(last) === risk.day) assert.equal((v as { refused: string }).refused, 'real-daily-loss');
  const h2 = home();
  setup(h2, s, { global: { lossStreak: 2, lossStreakPauseMin: 45 } });
  const st = await realRun(h2, s);
  assert.ok(st.notes.some((l) => /2 losing closes in a row: new buys paused 45 min/.test(l)), st.notes.join('\n'));
});

test('verifier R7: a state file that cannot be written AFTER the signal went out does not refuse the fill (journaled instead)', async () => {
  const h = home();
  const s = realScalp();
  setup(h, s, {});
  mkdirSync(heldPath(h)); // held.json is a directory: every save of it fails
  const r = await realRun(h, s);
  const buys = r.fills.filter((e) => e.side === 'buy');
  assert.ok(buys.length >= 1 && buys.every((e) => e.tag === 'real-signal' && typeof e.nonce === 'number'), 'the buys stand, each with its signal');
  assert.equal(r.res.refusals['fill-real-outbox-unwritable'] ?? 0, 0);
  assert.ok(readRealJournal(h).some((l) => l.action === 'state-write-failed' && l.data.what === 'held.json'));
});
