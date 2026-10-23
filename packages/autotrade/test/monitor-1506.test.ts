// task-1506 (AUTOTRADE AT-4) — the position monitor on the paper desk. Fixtures only: an in-memory paper wallet,
// a fixture quote with constant-product impact, fixture mints and ticks. No network, no real wallet, no signer.
//
//   §5 order (rug → thesis → max hold → hard stop → cost recovery → TP ladder → bag trail → trail → time → adds)
//   with every sell through the desk, journaled agent.paper.exit.<rule>; one wake message per tick after the
//   mechanical actions; sessions only reduce risk and never block an exit; noAnswer per profile; restart recovery
//   from the paper journal + ledgers; exits keep running with the runner down; entries refused on a stale monitor
//   heartbeat; the desk executor needs an armed paper-only mandate and stays inside its caps.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FakeClock, PaperExitDesk, PaperExecutor, PaperWallet, SOL_MINT, KillSwitch,
  type DeskControl, type QuoteRequest, type SwapQuote,
} from '@dexterm/data';
import { Journal, draftMandate, type Mandate } from '@dexterm/data/plans';
import { loadPreset, type ResolvedStrategy } from '../src/strategy.ts';
import { DeskExecutor, MAX_SIZING_QUOTES } from '../src/desk-executor.ts';
import {
  PositionMonitor, MailboxWakeSink, answerWake, bareTick, monitorAlive, monitorHeartbeatAge, readMonitorStatus, readWakeOutbox,
  recoverPositions, runMonitorProcess, syncFromJournal, writeMonitorStatus, acquireMonitorLock, releaseMonitorLock,
  MONITOR_STATUS_SCHEMA, type WakeBatch, type WakeSink,
} from '../src/monitor-daemon.ts';
import type { Decision } from '../src/session.ts';
import { runAutotrade, type Executor } from '../src/runner.ts';
import { loadTape } from '../src/replay.ts';
import type { MarketTick } from '../src/replay.ts';

const MINT_A = 'FixtureMintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1';
const MINT_B = 'FixtureMintBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB2';
const SOL_USD = 150;
const T0 = 1_760_000_000_000;

/** Fixture market: a USD mid per token per mint and a constant-product pool depth in USD. */
interface Market { price: Record<string, number>; poolUsd: number; quotes: number; fail: boolean }

function fixtureQuote(mk: Market) {
  return async (req: QuoteRequest): Promise<SwapQuote> => {
    mk.quotes++;
    if (mk.fail) throw Object.assign(new Error('fixture quote outage'), { name: 'HttpError', status: 500 });
    const buy = req.inputMint === SOL_MINT;
    const mint = buy ? req.outputMint : req.inputMint;
    const px = mk.price[mint];
    const R = mk.poolUsd / 2;
    let out: bigint;
    if (buy) {
      const usd = (Number(req.amount) / 1e9) * SOL_USD;
      out = BigInt(Math.floor(((usd * R) / (R + usd) / px) * 1e6));
    } else {
      const V = (Number(req.amount) / 1e6) * px;
      out = BigInt(Math.floor((((V * R) / (R + V)) / SOL_USD) * 1e9));
    }
    if (out <= 0n) out = 1n;
    return {
      inputMint: req.inputMint, outputMint: req.outputMint, inAmount: req.amount, outAmount: out, otherAmountThreshold: out,
      mode: 'ExactIn', slippageBps: req.slippageBps, priceImpactPct: 0.4, route: ['fixture'], platformFeeBps: null,
      platformFeeAmount: null, usdValue: null, contextSlot: null, source: 'jupiter-swap', fetchedAt: 0,
    };
  };
}

interface H {
  clock: FakeClock; wallet: PaperWallet; journal: Journal; desk: PaperExitDesk; exec: DeskExecutor; mk: Market;
  control: { v: DeskControl }; mandate: { v: Mandate | null }; alive: { monitor: boolean }; kill: KillSwitch; strategy: ResolvedStrategy;
}

function harness(preset = 'moonbag', mandateInput: Record<string, unknown> = {}): H {
  const clock = new FakeClock(T0);
  const dir = mkdtempSync(join(tmpdir(), 'monitor-1506-'));
  const wallet = new PaperWallet({ path: ':memory:', clock });
  const journal = new Journal({ clock });
  const mk: Market = { price: { [MINT_A]: 0.001, [MINT_B]: 0.002 }, poolUsd: 200_000, quotes: 0, fail: false };
  const control = { v: { state: 'running' } as DeskControl };
  const m = draftMandate({ paperOnly: true, perTradeUsd: 400, perCoinUsd: 400, totalUsd: 2000, dailyLossUsd: 1000, maxOpenPositions: 5, maxPriceImpactPct: 10, ttlMs: 24 * 3600_000, ...mandateInput }, { clock });
  m.status = 'armed'; m.armedAt = clock.now(); m.armedBy = { gesture: 'keypress', proofId: 'fixture-proof' };
  const mandate = { v: m as Mandate | null };
  const kill = new KillSwitch(join(dir, 'trading.panic'));
  const desk = new PaperExitDesk({
    mandate: () => mandate.v, wallet, executor: new PaperExecutor(wallet, { clock }), quote: fixtureQuote(mk),
    solUsd: () => SOL_USD, control: () => control.v, journal, killSwitch: kill, clock, agent: 'autotrade',
  });
  const strategy = loadPreset(preset);
  const alive = { monitor: true };
  const exec = new DeskExecutor({
    desk, mandate: () => mandate.v, solUsd: () => SOL_USD, decimals: () => 6, monitorAlive: () => alive.monitor,
    defaultProfile: strategy.exits.default, runId: 'fixture-run', strategy: { id: strategy.id, hash: strategy.hash }, now: () => clock.now(),
  });
  return { clock, wallet, journal, desk, exec, mk, control, mandate, alive, kill, strategy };
}

function tick(mint: string, t: number, price: number, liq = 100_000, extra: Partial<MarketTick> = {}): MarketTick {
  return { ...bareTick(mint, mint === MINT_A ? 'FIXA' : 'FIXB', t, price, liq), buys5m: 40, sells5m: 30, ...extra };
}

/** A recording wake sink: every batch, and a scripted decision (or a promise that never settles). */
function scriptedSink(answer: (b: WakeBatch) => Decision | null | 'never' | 'none'): WakeSink & { batches: WakeBatch[] } {
  const batches: WakeBatch[] = [];
  return {
    batches,
    deliver(b) {
      batches.push(b);
      const a = answer(b);
      if (a === 'none') return null;
      if (a === 'never') return new Promise<Decision | null>(() => {});
      return Promise.resolve(a);
    },
  };
}

async function enter(h: H, mint = MINT_A, usd = 20, profile?: string) {
  const k = tick(mint, h.clock.now(), h.mk.price[mint]);
  const f = await h.exec.buy(k, usd, profile ? { profile } : {});
  assert.ok(!('refused' in f), `entry refused: ${JSON.stringify(f)}`);
  return f;
}

function monitorFor(h: H, wakes?: WakeSink, opts: { runnerAlive?: () => boolean; decideWithinMs?: number } = {}) {
  const m = new PositionMonitor({ strategy: h.strategy, executor: h.exec, wakes, now: () => h.clock.now(), ...opts });
  const sync = () => syncFromJournal(m, { journal: h.journal.events, held: h.desk.positions(), solUsd: SOL_USD, now: h.clock.now() });
  return { m, sync };
}

const types = (h: H) => h.journal.events.map((e) => e.type);
const kinds = (m: PositionMonitor) => m.ledger.events.map((e) => e.kind);
const step = async (h: H, m: PositionMonitor, k: MarketTick) => { if (k.t > h.clock.now()) await h.clock.advance(k.t - h.clock.now()); await m.tick(k); await m.idle(); };

test('1506 desk executor: an entry fills through the desk with a note and registers its exit plan', async () => {
  const h = harness();
  const f = await enter(h);
  assert.equal(f.side, 'buy');
  assert.ok(f.usd > 19.9 && f.usd < 20.1, `cash spent ≈ $20, got ${f.usd}`);
  const fill = h.journal.events.find((e) => e.type === 'agent.paper.fill')!;
  const note = (fill.data as { note: Record<string, unknown> }).note;
  assert.equal(note.by, 'autotrade');
  assert.equal(note.profile, 'moonbag');
  assert.equal(note.strategy, 'moonbag');
  assert.equal(h.desk.exitPlans().length, 1);
  assert.equal(h.desk.exitPlans()[0].positionId, note.positionId);
});

test('1506 desk executor: entries need an armed paper-only mandate and a fresh monitor heartbeat; the desk caps still apply', async () => {
  const h = harness();
  h.alive.monitor = false;
  assert.deepEqual(await h.exec.buy(tick(MINT_A, T0, 0.001), 20), { refused: 'monitor-heartbeat-stale' });
  h.alive.monitor = true;
  const live = draftMandate({ perTradeUsd: 20 }, { clock: h.clock });
  live.status = 'armed'; live.armedAt = T0; live.armedBy = { gesture: 'keypress', proofId: 'p' };
  h.mandate.v = live;
  assert.deepEqual(await h.exec.buy(tick(MINT_A, T0, 0.001), 5), { refused: 'mandate-not-paper-only' });
  const unarmed = draftMandate({ paperOnly: true }, { clock: h.clock });
  h.mandate.v = unarmed;
  assert.deepEqual(await h.exec.buy(tick(MINT_A, T0, 0.001), 5), { refused: 'mandate-not-armed' });
  h.mandate.v = null;
  assert.deepEqual(await h.exec.buy(tick(MINT_A, T0, 0.001), 5), { refused: 'no-mandate' });
  // The strategy clamp sits INSIDE the mandate: the agent tier is × 0.25 of $400 = $100 per trade.
  const h2 = harness();
  assert.deepEqual(await h2.exec.buy(tick(MINT_A, T0, 0.001), 150), { refused: 'desk-per-trade-cap' });
  assert.equal(h2.desk.exitPlans().length, 0);
  // close-only refuses entries at the desk too
  h2.control.v = { state: 'close-only' };
  assert.deepEqual(await h2.exec.buy(tick(MINT_A, T0, 0.001), 20), { refused: 'desk-close-only' });
});

test('1506 §5 order: moonbag cost recovery on desk quotes (≤ 3), then the bag trail; both journaled agent.paper.exit.*', async () => {
  const h = harness();
  await enter(h);
  const sink = scriptedSink(() => ({ action: 'hold', reason: 'let it ride' }));
  const { m, sync } = monitorFor(h, sink);
  sync();
  assert.equal(m.positions.size, 1);
  const p = m.positions.get(MINT_A)!;
  h.mk.price[MINT_A] = 0.0021; // +110%
  const q0 = h.mk.quotes;
  await step(h, m, tick(MINT_A, T0 + 60_000, 0.0021));
  const sizing = m.ledger.events.find((e) => e.kind === 'cost_recovery_sized')!;
  assert.ok((sizing.quotes as number) >= 2 && (sizing.quotes as number) <= MAX_SIZING_QUOTES, `sizing quotes ${sizing.quotes}`);
  assert.equal(h.mk.quotes - q0, (sizing.quotes as number) + 1, 'the sizing quotes plus the fill’s own quote, nothing else');
  assert.ok(types(h).includes('agent.paper.exit.cost-recovery'));
  assert.ok(p.costRecovered);
  // The slice repaid the cost (after impact and fees, by the desk's own quotes): realized ≥ cost, within a cent.
  assert.ok(p.realizedUsd >= p.costUsd - 0.05, `realized ${p.realizedUsd} vs cost ${p.costUsd}`);
  assert.ok(p.tokens > 0 && p.tokens < p.origTokens);
  assert.equal(sink.batches.length, 1);
  assert.deepEqual(sink.batches[0].events.map((w) => w.event), ['cost_recovered']);
  // Peak +200%, then 56% off the peak: the 55% bag trail sells the rest.
  h.mk.price[MINT_A] = 0.003;
  await step(h, m, tick(MINT_A, T0 + 120_000, 0.003));
  h.mk.price[MINT_A] = 0.00132;
  await step(h, m, tick(MINT_A, T0 + 180_000, 0.00132));
  assert.ok(types(h).includes('agent.paper.exit.bag-trail'));
  assert.ok(types(h).includes('agent.paper.exit.done'));
  assert.equal(m.positions.size, 0);
  assert.equal(h.wallet.position(MINT_A)?.tokensRaw ?? 0n, 0n);
  assert.ok(h.journal.verify().ok);
});

test('1506 §5 order: a rug ends the tick before anything else; thesis beats max hold beats the hard stop', async () => {
  // Rug: liquidity under the floor at +150% → one full rug-liquidity exit, no cost recovery.
  const h = harness();
  await enter(h);
  const { m, sync } = monitorFor(h);
  sync();
  h.mk.price[MINT_A] = 0.0025;
  await step(h, m, tick(MINT_A, T0 + 60_000, 0.0025, 1_500));
  const exits = types(h).filter((t) => t.startsWith('agent.paper.exit.') && !['agent.paper.exit.plan', 'agent.paper.exit.done'].includes(t));
  assert.deepEqual(exits, ['agent.paper.exit.rug-liquidity']);
  // scalp: thesis-liquidity (−20% in 5 min) and the −25% hard stop on the same tick → thesis.
  const s = harness('scalp');
  await enter(s);
  const ms = monitorFor(s);
  ms.sync();
  await step(s, ms.m, tick(MINT_A, T0 + 30_000, 0.001, 100_000));
  s.mk.price[MINT_A] = 0.0007;
  await step(s, ms.m, tick(MINT_A, T0 + 60_000, 0.0007, 70_000));
  assert.ok(types(s).includes('agent.paper.exit.thesis-liquidity'));
  assert.ok(!types(s).includes('agent.paper.exit.stop'));
  // scalp: max hold (60 min) and the hard stop on the same tick → max-hold.
  const t = harness('scalp');
  await enter(t);
  const mt = monitorFor(t);
  mt.sync();
  t.mk.price[MINT_A] = 0.0007;
  await step(t, mt.m, tick(MINT_A, T0 + 61 * 60_000, 0.0007));
  assert.ok(types(t).includes('agent.paper.exit.max-hold'));
  assert.ok(!types(t).includes('agent.paper.exit.stop'));
});

test('1506 TP ladder: several steps fill on one gap, and every wake of the tick goes out in ONE message after the sells', async () => {
  const h = harness('swing');
  await enter(h, MINT_A, 20, 'swing');
  const sink = scriptedSink(() => ({ action: 'hold', reason: 'ok' }));
  const { m, sync } = monitorFor(h, sink);
  sync();
  h.mk.price[MINT_A] = 0.0022; // +120%: TP1 (+50%) and TP2 (+100%) on one gap
  await step(h, m, tick(MINT_A, T0 + 60_000, 0.0022));
  const t = types(h);
  assert.ok(t.includes('agent.paper.exit.tp1') && t.includes('agent.paper.exit.tp2'));
  assert.equal(sink.batches.length, 1, 'one message');
  assert.deepEqual(sink.batches[0].events.map((w) => w.event), ['tp_filled', 'tp_filled']);
  assert.match(sink.batches[0].text, /EVENT tp_filled: TP1[\s\S]*EVENT tp_filled: TP2/);
  // the message went out after both fills were booked
  const k = kinds(m);
  assert.ok(k.lastIndexOf('fill') < k.indexOf('message'));
  assert.equal(m.positions.get(MINT_A)!.tpFilled, 2);
});

test('1506 sessions only reduce risk: no size can be added, trims and tightens work, a hold never blocks a mechanical exit', async () => {
  const h = harness('swing');
  await enter(h, MINT_A, 20, 'swing');
  let next: Decision = { action: 'enter', sizeUsd: 500, reason: 'double down' };
  const sink = scriptedSink(() => next);
  const { m, sync } = monitorFor(h, sink);
  sync();
  const p = m.positions.get(MINT_A)!;
  const buys = () => h.journal.events.filter((e) => e.type === 'agent.paper.fill' && (e.data as { side: string }).side === 'buy').length;
  h.mk.price[MINT_A] = 0.0016; // +60%: TP1, wake
  await step(h, m, tick(MINT_A, T0 + 60_000, 0.0016));
  assert.equal(buys(), 1, 'an enter reply never buys');
  assert.ok(m.ledger.events.some((e) => e.kind === 'refused' && e.rule === 'session-cannot-add-size'));
  // A trim through the desk (agent-trim), only from what is held.
  next = { action: 'exit', fraction: 0.5, reason: 'take some' };
  h.mk.price[MINT_A] = 0.0021;
  const before = p.tokens;
  await step(h, m, tick(MINT_A, T0 + 120_000, 0.0021)); // TP2 + wake → trim
  assert.ok(types(h).includes('agent.paper.exit.agent-trim'));
  assert.ok(p.tokens < before);
  // Hold answers to every wake, then a liquidity drain: the thesis exit fires anyway.
  next = { action: 'hold', reason: 'hold forever' };
  h.mk.price[MINT_A] = 0.0018;
  await step(h, m, tick(MINT_A, T0 + 7 * 60_000, 0.0018, 60_000));
  assert.ok(types(h).includes('agent.paper.exit.thesis-liquidity'));
  assert.equal(m.positions.size, 0);
  assert.equal(buys(), 1);
});

test('1506 re-profile only along an allowed edge (an upgrade needs TP1); a tighten arms the trail', async () => {
  const h = harness('swing');
  await enter(h, MINT_A, 20, 'swing');
  const answers: Decision[] = [{ action: 'reprofile', profile: 'moonbag', reason: 'off-edge' }, { action: 'reprofile', profile: 'runner', reason: 'it is running' }, { action: 'tighten', reason: 'lock' }];
  const { m, sync } = monitorFor(h, scriptedSink(() => answers.shift() ?? { action: 'hold', reason: 'ok' }));
  sync();
  const p = m.positions.get(MINT_A)!;
  h.mk.price[MINT_A] = 0.0016; // TP1 → wake → off-edge reprofile refused
  await step(h, m, tick(MINT_A, T0 + 60_000, 0.0016));
  assert.ok(m.ledger.events.some((e) => e.kind === 'refused' && e.rule === 'reprofile-edge'));
  assert.equal(p.profileId, 'swing');
  h.mk.price[MINT_A] = 0.0021; // TP2 → wake → swing → runner (an upgrade, TP1 is filled)
  await step(h, m, tick(MINT_A, T0 + 120_000, 0.0021));
  assert.equal(p.profileId, 'runner');
  // tighten on a thesis warning (liquidity −20% of a 30% exit, below the trail's +40% arm) arms the trail early.
  const t = harness('swing');
  await enter(t, MINT_A, 20, 'swing');
  const tm = monitorFor(t, scriptedSink(() => ({ action: 'tighten', reason: 'lock' })));
  tm.sync();
  const q = tm.m.positions.get(MINT_A)!;
  t.mk.price[MINT_A] = 0.0011;
  await step(t, tm.m, tick(MINT_A, T0 + 30_000, 0.0011, 100_000));
  assert.equal(q.trailArmed, false);
  await step(t, tm.m, tick(MINT_A, T0 + 60_000, 0.0011, 80_000));
  assert.ok(tm.m.ledger.events.some((e) => e.kind === 'wake' && e.event === 'thesis_warning'));
  assert.equal(q.trailArmed, true);
  assert.ok(tm.m.ledger.events.some((e) => e.kind === 'tighten' && e.armed === 'trail'));
});

test('1506 a session that never answers cannot delay an exit; the deadline applies the profile noAnswer and a late reply is ignored', async () => {
  // swing: the 90-min review, unanswered → exit (profile noAnswer: exit).
  const h = harness('swing');
  await enter(h, MINT_A, 20, 'swing');
  const sink = scriptedSink(() => 'never');
  const { m, sync } = monitorFor(h, sink, { decideWithinMs: 60_000 });
  sync();
  await step(h, m, tick(MINT_A, T0 + 91 * 60_000, 0.00105));
  assert.equal(sink.batches.length, 1);
  assert.deepEqual(sink.batches[0].events.map((w) => w.event), ['time_review']);
  assert.equal(m.positions.size, 1, 'nothing happens before the deadline');
  await step(h, m, tick(MINT_A, T0 + 92 * 60_000 + 1, 0.00105));
  assert.ok(types(h).includes('agent.paper.exit.time-review-no-answer'));
  assert.equal(m.positions.size, 0);
  // runner: unanswered review → hold (mechanical rules keep running).
  const r = harness('runner');
  await enter(r, MINT_A, 20, 'runner');
  const rs = monitorFor(r, scriptedSink(() => 'never'), { decideWithinMs: 60_000 });
  rs.sync();
  await step(r, rs.m, tick(MINT_A, T0 + 241 * 60_000, 0.00105));
  await step(r, rs.m, tick(MINT_A, T0 + 243 * 60_000, 0.00105));
  assert.ok(rs.m.ledger.events.some((e) => e.kind === 'no_answer' && e.rule === 'hold'));
  assert.equal(rs.m.positions.size, 1);
  // While a reply is pending, a mechanical exit still runs on the next tick.
  const x = harness('swing');
  await enter(x, MINT_A, 20, 'swing');
  const xs = monitorFor(x, scriptedSink(() => 'never'), { decideWithinMs: 3600_000 });
  xs.sync();
  x.mk.price[MINT_A] = 0.0016;
  await step(x, xs.m, tick(MINT_A, T0 + 60_000, 0.0016)); // TP1 wake, pending
  await step(x, xs.m, tick(MINT_A, T0 + 120_000, 0.0016, 1_000)); // rug
  assert.ok(types(x).includes('agent.paper.exit.rug-liquidity'));
  // A reply that lands after the position closed is ignored, never executed.
  let resolveLate!: (d: Decision) => void;
  const late = harness('swing');
  await enter(late, MINT_A, 20, 'swing');
  const ls = monitorFor(late, { deliver: () => new Promise<Decision | null>((res) => { resolveLate = res; }) });
  ls.sync();
  late.mk.price[MINT_A] = 0.0016;
  await step(late, ls.m, tick(MINT_A, T0 + 60_000, 0.0016));
  await step(late, ls.m, tick(MINT_A, T0 + 120_000, 0.0016, 1_000));
  resolveLate({ action: 'exit', reason: 'too late' });
  await ls.m.idle();
  assert.ok(ls.m.ledger.events.some((e) => e.kind === 'late_reply_ignored'));
  assert.ok(!types(late).includes('agent.paper.exit.agent-exit'));
});

test('1506 no session: a review applies noAnswer at once; a tighten on a free bag halves its trail and never loosens', async () => {
  const h = harness('swing');
  await enter(h, MINT_A, 20, 'swing');
  const { m, sync } = monitorFor(h); // no sink at all
  sync();
  await step(h, m, tick(MINT_A, T0 + 91 * 60_000, 0.00105));
  assert.ok(types(h).includes('agent.paper.exit.time-review-no-answer'));
  const b = harness();
  await enter(b);
  let answer: Decision = { action: 'tighten', reason: 'lock it' };
  const bm = monitorFor(b, scriptedSink(() => answer));
  bm.sync();
  b.mk.price[MINT_A] = 0.0021;
  await step(b, bm.m, tick(MINT_A, T0 + 60_000, 0.0021));
  const p = bm.m.positions.get(MINT_A)!;
  assert.equal(p.bagTrailPct, 28, '55% halves to 28%');
  answer = { action: 'tighten', reason: 'again' };
  b.mk.price[MINT_A] = 0.0012; // a drawdown wake? no: −43% off a +110% peak is past the 28% trail → exit
  await step(b, bm.m, tick(MINT_A, T0 + 120_000, 0.0012));
  assert.ok(types(b).includes('agent.paper.exit.bag-trail'));
});

test('1506 restart recovery: a new monitor rebuilds the position from the paper journal + ledger and carries on', async () => {
  const h = harness();
  await enter(h);
  const a = monitorFor(h, scriptedSink(() => ({ action: 'tighten', reason: 'lock' })));
  a.sync();
  h.mk.price[MINT_A] = 0.0021;
  await step(h, a.m, tick(MINT_A, T0 + 60_000, 0.0021));
  h.mk.price[MINT_A] = 0.0026;
  await step(h, a.m, tick(MINT_A, T0 + 90_000, 0.0026));
  const before = a.m.positions.get(MINT_A)!;
  const checkpoint = { positions: a.m.status() };
  // "crash": a fresh monitor from the journal, the old monitor's ledger and the last checkpoint.
  const r = recoverPositions({ strategy: h.strategy, journal: h.journal.events, held: h.desk.positions(), solUsd: SOL_USD, ledgers: [a.m.ledger.events], checkpoint, now: h.clock.now() });
  assert.equal(r.positions.length, 1);
  const p = r.positions[0];
  assert.equal(p.id, before.id);
  assert.equal(p.costRecovered, true);
  assert.equal(p.bagTrailPct, 28);
  assert.ok(Math.abs(p.tokens - before.tokens) / before.tokens < 1e-6);
  assert.ok(Math.abs(p.costUsd - before.costUsd) < 0.01 && Math.abs(p.realizedUsd - before.realizedUsd) < 0.01);
  assert.equal(p.peakPrice, 0.0026, 'the peak comes back from the checkpoint');
  assert.equal(p.entryPrice, before.entryPrice, 'the entry mid comes back from the fill note');
  // Without the checkpoint the cost-recovery state still comes from the journal's fills alone.
  const bare = recoverPositions({ strategy: h.strategy, journal: h.journal.events, held: h.desk.positions(), solUsd: SOL_USD });
  assert.equal(bare.positions[0].costRecovered, true);
  const b = new PositionMonitor({ strategy: h.strategy, executor: h.exec, now: () => h.clock.now() });
  b.adopt(p, 'restart');
  h.mk.price[MINT_A] = 0.0018; // 31% off the 0.0026 peak: past the tightened 28% trail
  await step(h, b, tick(MINT_A, T0 + 120_000, 0.0018));
  assert.ok(types(h).includes('agent.paper.exit.bag-trail'));
  assert.equal(b.positions.size, 0);
});

test('1506 restart recovery: an exit journaled without a fill is reported, never re-sent; foreign and closed positions are left alone', async () => {
  const h = harness();
  await enter(h, MINT_A);
  // MINT_B is somebody else's paper position (no autotrade plan).
  const t = h.desk.open({ mint: MINT_B, symbol: 'FIXB', decimals: 6, side: 'buy' });
  h.desk.size(t.id, { usd: 10 });
  await h.desk.confirm(t.id);
  // A crash between the exit line and the booking: the quote fails after the journal line.
  h.mk.fail = true;
  await assert.rejects(h.desk.exit({ mint: MINT_A, fraction: 0.5, rule: 'cost-recovery' }));
  h.mk.fail = false;
  const sellsBefore = h.journal.events.filter((e) => e.type === 'agent.paper.fill' && (e.data as { side: string }).side === 'sell').length;
  const r = recoverPositions({ strategy: h.strategy, journal: h.journal.events, held: h.desk.positions(), solUsd: SOL_USD });
  assert.deepEqual(r.unresolvedExits.map((x) => x.rule), ['cost-recovery']);
  assert.deepEqual(r.notOurs, [MINT_B]);
  assert.equal(r.positions[0].costRecovered, false, 'it did not fill, so the next tick decides afresh');
  assert.equal(h.journal.events.filter((e) => e.type === 'agent.paper.fill' && (e.data as { side: string }).side === 'sell').length, sellsBefore, 'recovery sends nothing');
  // The user closes MINT_A by hand while the monitor is down → closedWhileDown, and a live monitor forgets it.
  const { m, sync } = monitorFor(h);
  sync();
  await h.desk.close({ mint: MINT_A });
  const r2 = sync();
  assert.equal(r2.positions.length, 0);
  assert.equal(m.positions.size, 0);
  assert.ok(m.ledger.events.some((e) => e.kind === 'position_gone'));
});

test('1506 runner down: mechanical exits keep running; ladder adds are refused', async () => {
  const h = harness('sample-dip-ladder');
  await enter(h, MINT_A, 20, 'dip-trail');
  const { m, sync } = monitorFor(h, undefined, { runnerAlive: () => false });
  sync();
  const p = m.positions.get(MINT_A)!;
  p.ladder = [{ frac: 0.5, atPct: -15, deadline: T0 + 30 * 60_000, usd: 20 }];
  h.mk.price[MINT_A] = 0.00084; // −16%: the dip add triggers, refused with the runner down
  await step(h, m, tick(MINT_A, T0 + 60_000, 0.00084));
  assert.ok(m.ledger.events.some((e) => e.kind === 'refused' && e.rule === 'ladder-add-runner-down'));
  h.mk.price[MINT_A] = 0.0006; // −40%: the dip-trail hard stop
  await step(h, m, tick(MINT_A, T0 + 120_000, 0.0006));
  assert.equal(m.positions.size, 0, 'the stop ran with no runner');
  const buys = h.journal.events.filter((e) => e.type === 'agent.paper.fill' && (e.data as { side: string }).side === 'buy').length;
  assert.equal(buys, 1);
});

test('1506 the ladder add goes through the desk when the runner is up (re-capped by the desk book)', async () => {
  const h = harness('sample-dip-ladder');
  await enter(h, MINT_A, 20, 'dip-trail');
  const { m, sync } = monitorFor(h, undefined, { runnerAlive: () => true });
  sync();
  const p = m.positions.get(MINT_A)!;
  p.ladder = [{ frac: 0.5, atPct: -15, deadline: T0 + 30 * 60_000, usd: 20 }];
  h.mk.price[MINT_A] = 0.00084;
  await step(h, m, tick(MINT_A, T0 + 60_000, 0.00084));
  const buys = h.journal.events.filter((e) => e.type === 'agent.paper.fill' && (e.data as { side: string }).side === 'buy');
  assert.equal(buys.length, 2);
  assert.equal((buys[1].data as { note: { kind: string } }).note.kind, 'add');
  assert.ok(p.costUsd > 39);
});

test('1506 close-only: the monitor keeps exiting on an expired mandate while entries are refused', async () => {
  const h = harness('scalp');
  await enter(h);
  const { m, sync } = monitorFor(h);
  sync();
  h.mandate.v = { ...h.mandate.v!, expiresAt: T0 + 1 };
  h.control.v = { state: 'close-only', reason: 'mandate expired' };
  assert.deepEqual(await h.exec.buy(tick(MINT_B, T0 + 2, 0.002), 10), { refused: 'desk-close-only' });
  h.mk.price[MINT_A] = 0.0007; // −30%: scalp hard stop
  await step(h, m, tick(MINT_A, T0 + 60_000, 0.0007));
  assert.ok(types(h).includes('agent.paper.exit.stop'));
  assert.equal(m.positions.size, 0);
});

test('1506 a refused exit is retried, not lost: a quote outage on a TP leaves the step to fill on the next tick', async () => {
  const h = harness('swing');
  await enter(h, MINT_A, 20, 'swing');
  const { m, sync } = monitorFor(h);
  sync();
  const p = m.positions.get(MINT_A)!;
  h.mk.price[MINT_A] = 0.0016;
  h.mk.fail = true;
  await step(h, m, tick(MINT_A, T0 + 60_000, 0.0016));
  assert.equal(p.tpFilled, 0);
  assert.ok(m.ledger.events.some((e) => e.kind === 'refused' && e.rule === 'desk-quote-failed'));
  h.mk.fail = false;
  await step(h, m, tick(MINT_A, T0 + 120_000, 0.0016));
  assert.equal(p.tpFilled, 1);
  assert.ok(types(h).includes('agent.paper.exit.tp1'));
});

test('1506 heartbeat: the status file is the dead-man; the desk executor refuses entries once it is stale', async () => {
  const home = mkdtempSync(join(tmpdir(), 'monitor-home-1506-'));
  assert.equal(monitorHeartbeatAge(home), Infinity);
  assert.equal(monitorAlive(home), false);
  const h = harness();
  await enter(h);
  const { m, sync } = monitorFor(h);
  let now = T0;
  const ticks = [tick(MINT_A, T0 + 5_000, 0.001), tick(MINT_A, T0 + 10_000, 0.001)];
  let i = 0;
  await runMonitorProcess({ home, monitor: m, sync, ticks: async () => [ticks[i++] ?? ticks[1]], maxCycles: 2, sleep: async (ms) => { now += ms; }, now: () => now });
  const st = readMonitorStatus(home)!;
  assert.equal(st.schema, MONITOR_STATUS_SCHEMA);
  assert.equal(st.mode, 'paper');
  assert.equal(st.state, 'stopped', 'a clean stop says so, so entries stop at once');
  assert.equal(st.positions.length, 1);
  assert.equal(monitorAlive(home, now), false);
  writeMonitorStatus(home, { ...st, state: 'running', heartbeatAt: now });
  assert.equal(monitorAlive(home, now + 10_000), true);
  assert.equal(monitorAlive(home, now + 31_000), false);
  // wired as the desk executor's dead-man
  const e = new DeskExecutor({ desk: h.desk, mandate: () => h.mandate.v, solUsd: () => SOL_USD, decimals: () => 6, monitorAlive: () => monitorAlive(home, now + 31_000), defaultProfile: 'moonbag' });
  assert.deepEqual(await e.buy(tick(MINT_B, T0, 0.002), 10), { refused: 'monitor-heartbeat-stale' });
  // one monitor per machine
  const l1 = acquireMonitorLock(home);
  assert.ok(l1.ok);
  writeFileSync(join(home, 'autotrade', 'monitor.lock'), JSON.stringify({ pid: 999_999_999, startedAt: 1 }));
  const l2 = acquireMonitorLock(home);
  assert.ok(l2.ok && l2.reclaimed?.pid === 999_999_999, 'a dead pid’s lock is reclaimed');
  releaseMonitorLock(home);
});

test('1506 wake mailbox: a runner in another process answers with a DECISION line; anything else is no answer', async () => {
  const home = mkdtempSync(join(tmpdir(), 'monitor-mail-1506-'));
  const h = harness('swing');
  await enter(h, MINT_A, 20, 'swing');
  const mail = new MailboxWakeSink(home, () => true);
  const { m, sync } = monitorFor(h, mail, { decideWithinMs: 600_000 });
  sync();
  h.mk.price[MINT_A] = 0.0016;
  await step(h, m, tick(MINT_A, T0 + 60_000, 0.0016));
  const out = readWakeOutbox(home, h.clock.now());
  assert.equal(out.length, 1);
  assert.match(out[0].text, /EVENT tp_filled/);
  answerWake(home, out[0].id, 'Taking profit.\nDECISION {"action":"exit","reason":"done","signTx":true}');
  mail.poll();
  await m.idle();
  // the closed schema refuses the unknown key → the decision is invalid → no answer, hold
  assert.ok(m.ledger.events.some((e) => e.kind === 'no_answer'));
  assert.equal(m.positions.size, 1);
  h.mk.price[MINT_A] = 0.0021;
  await step(h, m, tick(MINT_A, T0 + 120_000, 0.0021));
  const out2 = readWakeOutbox(home, h.clock.now());
  assert.equal(out2.length, 1);
  answerWake(home, out2[0].id, 'DECISION {"action":"exit","reason":"done"}');
  mail.poll();
  await m.idle();
  assert.ok(types(h).includes('agent.paper.exit.agent-exit'));
  assert.equal(m.positions.size, 0);
});

test('1506 book: the desk book in USD for bankroll.source desk', async () => {
  const h = harness();
  const b0 = h.exec.book()!;
  assert.equal(b0.paper, true);
  assert.equal(b0.openCostUsd, 0);
  await enter(h);
  const b1 = h.exec.book()!;
  assert.ok(b1.openCostUsd > 19 && b1.openCostUsd < 21);
  assert.ok(Math.abs(b1.equityUsd - b0.equityUsd) < 0.1, 'equity at cost is unchanged by an entry (fees aside)');
});

test('1506 the monitor refuses a strategy that is not paper', () => {
  const h = harness();
  const live = { ...h.strategy, mode: 'live' as const };
  assert.throws(() => new PositionMonitor({ strategy: live as unknown as ResolvedStrategy, executor: h.exec }), /paper only/);
});

test('1506 the runner fills through the paper desk: DeskExecutor is a runner Executor, every buy inside the mandate caps', async () => {
  const h = harness('scalp');
  const asRunnerExecutor: Executor = h.exec; // the runner's interface, checked by the type checker
  // The fixture quote prices each order at the tick the runner hands the executor.
  const wrapped: Executor = {
    name: asRunnerExecutor.name,
    buy: (k, usd) => { h.mk.price[k.mint] = k.price ?? h.mk.price[k.mint]; h.mk.poolUsd = k.liq ?? h.mk.poolUsd; return asRunnerExecutor.buy(k, usd); },
    sell: (k, tokens, reason) => { h.mk.price[k.mint] = k.price ?? h.mk.price[k.mint]; h.mk.poolUsd = Math.max(1, k.liq ?? h.mk.poolUsd); return asRunnerExecutor.sell(k, tokens, reason); },
  };
  const tape = loadTape(fileURLToPath(new URL('./fixtures/autotrade-1498-tape.json', import.meta.url)));
  const r = await runAutotrade({ strategy: h.strategy, tape, sessions: null, executor: wrapped });
  const buys = h.journal.events.filter((e) => e.type === 'agent.paper.fill' && (e.data as { side: string }).side === 'buy');
  assert.ok(buys.length > 0, 'the tape produced at least one entry');
  for (const b of buys) assert.equal((b.data as { note: { by: string } }).note.by, 'autotrade');
  assert.ok(r.ledger.events.some((e) => e.kind === 'run_start' && e.executor === 'paper-desk'));
  // every desk buy stayed inside the agent-tier per-trade cap ($400 × 0.25) and the strategy's own clamp
  for (const e of r.ledger.events.filter((x) => x.kind === 'fill' && x.side === 'buy')) assert.ok((e.usd as number) <= 100 + 1e-6, `buy $${e.usd}`);
  const exits = h.journal.events.filter((e) => e.type.startsWith('agent.paper.exit.') && !['agent.paper.exit.plan', 'agent.paper.exit.done'].includes(e.type));
  assert.ok(exits.length > 0 || r.openAtEnd.length > 0);
  assert.ok(h.journal.verify().ok);
});
