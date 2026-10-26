// task-1645 (0.2.0 card A): real mode end to end on a recorded tape, against FAKE executors only (the JSONL stream
// tailed by a SignalReceiver, the command-hook script fixtures/fake-executor.mjs). Same clamps, exits, monitor and
// ledger as paper; every fill becomes a LIVE TRADE FIRE signal first; hard caps, the kill switch, receipts, drift,
// the dead-man and the read-only wallet reconcile. No key, no wallet, no network, no transaction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPreset, presetPath, validateStrategy, type ResolvedStrategy } from '../src/strategy.ts';
import { loadTape } from '../src/replay.ts';
import { runAutotrade, simExecutor } from '../src/runner.ts';
import { Outbox } from '../src/outbox.ts';
import { CommandChannel, JsonlChannel } from '../src/signal-channels.ts';
import { SignalReceiver, validateSignal, type TradeFireSignal } from '../src/signal.ts';
import {
  DEFAULT_REAL_CAPS, RealSignalExecutor, deadManSweep, disarm, engageRealKill, loadCaps, openRealRun, paperTwinHash, realModeCheck, releaseRealKill, saveArming, saveCaps,
  newChallenge, phraseMatches, readRealJournal, type RealCaps,
} from '../src/real-mode.ts';
import { RECEIPT_SCHEMA, appendReceipt, driftReport, readReceipts, reconcileWallet } from '../src/receipts.ts';
import { saveCapsTyped } from './fixtures/typed-save.ts';

const FAKE_EXEC = fileURLToPath(new URL('./fixtures/fake-executor.mjs', import.meta.url));
const TAPE = loadTape(fileURLToPath(new URL('./fixtures/autotrade-1498-tape.json', import.meta.url)));
const home = () => mkdtempSync(join(tmpdir(), 'dexterm-1645-real-'));
const SOL_USD = 200;
const LOOSE: RealCaps = { perTradeSol: 1000, dailySol: 10_000, buysPerDay: 500, maxOpenPositions: 50 };

function realScalp(): ResolvedStrategy {
  const raw = JSON.parse(readFileSync(presetPath('scalp'), 'utf8'));
  const r = validateStrategy({ ...raw, mode: 'real' });
  assert.ok(r.ok);
  assert.ok(r.warnings.some((w) => w.path === '/mode' && /arm/.test(w.msg)));
  return r.strategy;
}

function arm(h: string, s: ResolvedStrategy, caps: RealCaps = LOOSE, accountId = 'main') {
  assert.ok(saveCapsTyped(h, caps).ok);
  saveArming(h, { strategyId: s.id, strategyHash: s.hash, version: s.version, accountId, armedAt: Date.now(), caps, channels: ['jsonl', 'cmd'], evidence: [], confirmation: { method: 'typed-tty', codeHash: 'x' } });
}

async function realRun(h: string, s: ResolvedStrategy, o: { caps?: RealCaps; streamPath?: string; execDir?: string; afterFill?: (n: number) => void } = {}) {
  const check = realModeCheck(h, s, ['jsonl', 'cmd']);
  assert.ok(check.ok, check.ok ? '' : check.why);
  const streamPath = o.streamPath ?? join(h, 'stream.jsonl');
  const chans = [new JsonlChannel(streamPath), ...(o.execDir ? [new CommandChannel({ argv: [process.execPath, FAKE_EXEC, o.execDir, 'ack', 'main'] })] : [])];
  const outbox = Outbox.open(h, { channels: chans });
  const runId = `run-${Math.random().toString(36).slice(2, 8)}`;
  openRealRun(outbox, runId, s, check.arming.accountId);
  let bookUsd = s.bankroll.startUsd;
  let fills = 0;
  const inner = simExecutor(s.execution);
  const real = new RealSignalExecutor({
    home: h, inner: { name: inner.name, buy: async (k, usd, ctx) => { const f = await inner.buy(k, usd, ctx); if (!('refused' in f)) o.afterFill?.(++fills); return f; }, sell: (k, t, r) => inner.sell(k, t, r) },
    outbox, strategy: s, arming: check.arming, caps: o.caps ?? check.caps, runId, ttlSec: 60, solUsd: () => SOL_USD, bookUsd: () => bookUsd,
  });
  const res = await runAutotrade({ strategy: s, tape: TAPE, sessions: null, executor: real, real, runId, onState: (st) => { bookUsd = st.book.equityUsd; } });
  await outbox.pump();
  return { res, outbox, real, runId, streamPath };
}

test('real mode refuses to run unless armed at this exact hash, with caps, kill off and an executor channel', () => {
  const h = home();
  const s = realScalp();
  assert.match((realModeCheck(h, loadPreset('scalp'), ['jsonl']) as { why: string }).why, /not "real"/);
  assert.match((realModeCheck(h, s, ['jsonl']) as { why: string }).why, /not armed/);
  arm(h, s);
  assert.equal(realModeCheck(h, s, ['jsonl']).ok, true);
  assert.match((realModeCheck(h, { ...s, hash: 'f'.repeat(16) }, ['jsonl']) as { why: string }).why, /changed since it was armed/);
  assert.match((realModeCheck(h, s, ['telegram']) as { why: string }).why, /bot cannot read another bot/);
  engageRealKill(h, 'test');
  assert.match((realModeCheck(h, s, ['jsonl']) as { why: string }).why, /kill switch is on/);
  assert.deepEqual(releaseRealKill(h, { confirmed: false }), { ok: false, why: 'lifting the real-mode kill switch needs the typed confirmation on a real terminal' });
  assert.equal(releaseRealKill(h, { confirmed: true }).ok, true);
  writeFileSync(join(h, 'autotrade', 'real', 'kill.json'), '{not json');
  assert.match((realModeCheck(h, s, ['jsonl']) as { why: string }).why, /unreadable/, 'an unreadable kill file counts as engaged');
  assert.equal(releaseRealKill(h, { confirmed: true }).ok, true);
  assert.equal(disarm(h, s.id, 'test'), true);
  assert.match((realModeCheck(h, s, ['jsonl']) as { why: string }).why, /not armed/);
  const j = readRealJournal(h).map((l) => l.action);
  assert.deepEqual(j, ['caps-set', 'arm', 'kill', 'unkill', 'unkill', 'disarm']);
  assert.notEqual(paperTwinHash(s), s.hash, 'the paper twin (its backtests) has its own hash');
  assert.equal(paperTwinHash(s), loadPreset('scalp').hash);
});

test('the runner never takes mode real without the hook, and never runs a paper strategy through it', async () => {
  const h = home();
  const s = realScalp();
  await assert.rejects(runAutotrade({ strategy: s, tape: TAPE, sessions: null }), /real-mode host/);
  arm(h, s);
  const outbox = Outbox.open(h, { channels: [new JsonlChannel(join(h, 'x.jsonl'))] });
  const check = realModeCheck(h, s, ['jsonl']);
  assert.ok(check.ok);
  const real = new RealSignalExecutor({ home: h, inner: simExecutor(s.execution), outbox, strategy: s, arming: check.arming, caps: check.caps, runId: 'r1', ttlSec: 60, solUsd: () => SOL_USD, bookUsd: () => 1000 });
  await assert.rejects(runAutotrade({ strategy: loadPreset('scalp'), tape: TAPE, sessions: null, executor: real, real }), /mode "real" only/);
  await assert.rejects(runAutotrade({ strategy: s, tape: TAPE, sessions: null, executor: simExecutor(s.execution), real }), /executor must be the real-mode signal executor/);
  outbox.close();
});

test('a real run trades exactly like paper, and every fill went out first as a signal (fake executors ack all of it)', async () => {
  const paper = await runAutotrade({ strategy: loadPreset('scalp'), tape: TAPE, sessions: null });
  assert.ok(paper.trades.length > 0, 'the fixture tape has trades');
  const h = home();
  const s = realScalp();
  arm(h, s);
  const execDir = mkdtempSync(join(tmpdir(), 'dexterm-1645-exec-'));
  const { res, outbox, runId, streamPath } = await realRun(h, s, { execDir });
  // Same engine: the same trades, the same exits.
  assert.deepEqual(res.trades.map((t) => [t.mint, t.exitReason, Math.round(t.pnlUsd * 100)]), paper.trades.map((t) => [t.mint, t.exitReason, Math.round(t.pnlUsd * 100)]));
  const fills = res.ledger.events.filter((e) => e.kind === 'fill');
  assert.ok(fills.length >= 2);
  assert.ok(fills.every((e) => e.tag === 'real-signal' && typeof e.nonce === 'number'), 'every fill row is tagged real-signal and names its signal');
  assert.equal(res.ledger.events[0].mode, 'real');
  assert.equal(res.ledger.events[0].tag, 'real-signal');
  // The executor's view: the stream (tailed) and the command hook both saw every signal once, in nonce order.
  const lines = readFileSync(streamPath, 'utf8').trim().split('\n');
  const rx = new SignalReceiver({ accountId: 'main' });
  const sigs = lines.map((l) => { const r = rx.receive(l); assert.ok(r.ok || (r as { why: string }).why === 'expired', JSON.stringify(r)); return (validateSignal(JSON.parse(l)) as { signal: TradeFireSignal }).signal; });
  const trades = sigs.filter((x) => x.type === 'trade');
  assert.equal(trades.length, fills.length);
  assert.deepEqual(trades.map((x) => x.nonce), fills.map((e) => e.nonce));
  assert.deepEqual(sigs.map((x) => x.nonce), [...sigs.map((x) => x.nonce)].sort((a, b) => a - b));
  assert.ok(trades.every((x) => x.paper === false && x.runId === runId && x.accountId === 'main' && x.strategy.id === s.id && x.strategy.hash === s.hash));
  const sells = trades.filter((x) => x.type === 'trade' && x.side === 'sell');
  assert.ok(sells.length > 0 && sells.every((x) => x.type === 'trade' && x.sellFraction! > 0 && x.sellFraction! <= 1 && x.exitReason));
  // The run's last signal is `halted`.
  const last = sigs[sigs.length - 1];
  assert.equal(last.type, 'halted');
  assert.equal(res.ledger.events.some((e) => e.kind === 'real_halted'), true);
  const got = readFileSync(join(execDir, 'got.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).verdict);
  assert.ok(got.every((v: string) => v === 'ack' || v === 'expired'), got.join(','));
  assert.equal(got.length, sigs.length);
  assert.equal(outbox.depth(), 0);
  outbox.close();
});

test('hard caps outside the model: the per-trade cap clamps, the daily and open-position caps refuse; lowering is free, raising is confirmed', async () => {
  const h = home();
  const s = realScalp();
  const tight: RealCaps = { perTradeSol: 0.01, dailySol: 0.015, buysPerDay: 500, maxOpenPositions: 50 };
  arm(h, s, tight);
  const { res, outbox } = await realRun(h, s, { caps: tight });
  const buys = res.ledger.events.filter((e) => e.kind === 'fill' && e.side === 'buy');
  assert.ok(buys.length >= 1);
  assert.ok(buys.every((e) => Number(e.usd) <= 0.01 * SOL_USD + 1e-9), 'every buy is at most the per-trade cap');
  assert.ok(res.refusals['fill-real-daily-cap'] >= 1 || buys.length === 1, 'the daily cap refuses what the per-trade cap left');
  outbox.close();
  // Caps file rules: lowering any cap needs nothing; raising one needs the typed confirmation.
  assert.equal(saveCaps(h, { ...tight, perTradeSol: 0.005 }, { confirmed: [] }).ok, true);
  assert.match((saveCaps(h, { ...tight, perTradeSol: 5, dailySol: 50 }, { confirmed: [] }) as { why: string }).why, /raising perTradeSol, dailySol needs the typed confirmation/);
  assert.equal((loadCaps(h) as { caps: RealCaps }).caps.perTradeSol, 0.005);
  assert.match((saveCapsTyped(h, { ...tight, dailySol: 0.001 }) as { why: string }).why, /at least perTradeSol/);
  assert.match((saveCapsTyped(h, { ...DEFAULT_REAL_CAPS, buysPerDay: 1.5 }) as { why: string }).why, /whole number/);
});

test('the real-mode kill switch mid-run: the run halts, exactly one halted signal, no trade signal after it', async () => {
  const h = home();
  const s = realScalp();
  arm(h, s);
  const { res, streamPath } = await realRun(h, s, { afterFill: (n) => { if (n === 1) engageRealKill(h, 'panic button'); } });
  const halt = res.ledger.events.find((e) => e.kind === 'halt');
  assert.equal(halt?.reason, 'real-kill');
  const sigs = readFileSync(streamPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as TradeFireSignal);
  const haltedAt = sigs.findIndex((x) => x.type === 'halted');
  assert.ok(haltedAt > 0);
  assert.equal(sigs.filter((x) => x.type === 'halted').length, 1);
  assert.equal(sigs.slice(haltedAt).filter((x) => x.type === 'trade').length, 0, 'nothing after halted');
  assert.match((sigs[haltedAt] as { reason: string }).reason, /^kill:panic-button/);
  assert.ok(Object.keys(res.refusals).every((k) => !k.startsWith('fill-') || k === 'fill-real-kill'));
});

test('receipts are data: they confirm positions, drift is measured, orphans and other accounts are ignored', async () => {
  const h = home();
  const s = realScalp();
  arm(h, s);
  const { outbox } = await realRun(h, s);
  const sigs = outbox.signals().filter((x) => x.type === 'trade');
  const [b1, s1, b2] = sigs;
  const at = Date.now();
  appendReceipt(h, { schema: RECEIPT_SCHEMA, signalId: b1.id, nonce: b1.nonce, accountId: 'main', status: 'executed', at, fill: { priceUsd: null, sizeSol: (b1 as { sizeSol: number }).sizeSol * 0.9, tokens: 1000, txSig: '5'.repeat(88) }, reason: null, executor: 'fake' });
  appendReceipt(h, { schema: RECEIPT_SCHEMA, signalId: s1.id, nonce: s1.nonce, accountId: 'main', status: 'rejected', at, fill: null, reason: 'slippage <script>\u0007', executor: null });
  // another account's receipt and an unknown nonce are orphans, never applied
  writeFileSync(join(h, 'autotrade', 'real', 'receipts.jsonl'), `${JSON.stringify({ schema: RECEIPT_SCHEMA, signalId: b2.id, nonce: b2.nonce, accountId: 'other', status: 'executed', at, fill: null })}\n${JSON.stringify({ schema: RECEIPT_SCHEMA, signalId: 'a'.repeat(32), nonce: 99999, accountId: 'main', status: 'executed', at, fill: null })}\nnot json\n`, { flag: 'a' });
  assert.throws(() => appendReceipt(h, { schema: RECEIPT_SCHEMA, signalId: b1.id, nonce: b1.nonce, accountId: 'main', status: 'executed', at, fill: { priceUsd: null, sizeSol: 1, tokens: null, txSig: 'not-a-sig' }, reason: null, executor: null }), /txSig/);
  const { receipts, invalid } = readReceipts(h);
  assert.equal(invalid, 1);
  const d = driftReport(outbox.signals(), receipts, Date.now());
  const row1 = d.rows.find((r) => r.nonce === b1.nonce)!;
  assert.equal(row1.state, 'executed');
  assert.equal(row1.sizeDriftPct, -10);
  assert.equal(d.rows.find((r) => r.nonce === s1.nonce)!.state, 'rejected');
  assert.equal(d.rows.find((r) => r.nonce === s1.nonce)!.reason, 'slippage <script>');
  assert.equal(d.rows.find((r) => r.nonce === b2.nonce)!.state === 'executed', false);
  assert.equal(d.orphanReceipts, 2);
  assert.equal(d.sizeDrift, 1);
  outbox.close();
});

test('a receipt that lands during the run is a ledger row and confirms the position on the status', async () => {
  const h = home();
  const s = realScalp();
  arm(h, s);
  // The executor answers the first buy (nonce 1) through the receipts file while the run is going.
  const r = await realRun(h, s, {
    afterFill: (n) => {
      if (n !== 2) return; // by the second buy, signal 1 is in the outbox file
      const ob = Outbox.open(h, { channels: [], noLock: true });
      appendReceipt(h, { schema: RECEIPT_SCHEMA, signalId: ob.get(1)!.id, nonce: 1, accountId: 'main', status: 'executed', at: Date.now(), fill: { priceUsd: 1, sizeSol: 0.1, tokens: 10, txSig: null }, reason: null, executor: 'fake' });
    },
  });
  const rec = r.res.ledger.events.find((e) => e.kind === 'receipt');
  assert.ok(rec, 'the receipt became a ledger row');
  assert.equal(rec!.tag, 'real-signal');
  assert.equal(rec!.status, 'executed');
  assert.equal(rec!.nonce, 1);
  assert.equal(r.real.status().receipts.total, 1);
  r.outbox.close();
});

test('dead-man: a runner that died without halted gets it on the next outbox open (runner-lost, its outstanding nonces)', async () => {
  const h = home();
  const s = realScalp();
  arm(h, s);
  const stream = join(h, 'stream.jsonl');
  const ob = Outbox.open(h, { channels: [new JsonlChannel(stream)] });
  const check = realModeCheck(h, s, ['jsonl']);
  assert.ok(check.ok);
  openRealRun(ob, 'run-crashed', s, 'main');
  const real = new RealSignalExecutor({ home: h, inner: simExecutor(s.execution), outbox: ob, strategy: s, arming: check.arming, caps: check.caps, runId: 'run-crashed', ttlSec: 60, solUsd: () => SOL_USD, bookUsd: () => 1000 });
  const k = TAPE.ticks.find((t) => (t.liq ?? 0) > 20_000 && t.price)!;
  const f = await real.buy(k, 20);
  assert.ok(!('refused' in f), JSON.stringify(f));
  await ob.pump();
  ob.close(); // "kill -9": no halted, the run is still marked open
  const ob2 = Outbox.open(h, { channels: [new JsonlChannel(stream)] });
  const swept = deadManSweep(ob2);
  assert.deepEqual(swept, ['run-crashed']);
  await ob2.pump();
  const sigs = readFileSync(stream, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as TradeFireSignal);
  const h1 = sigs.find((x) => x.type === 'halted') as { reason: string; outstanding: number[]; runId: string } | undefined;
  assert.equal(h1?.reason, 'runner-lost');
  assert.equal(h1?.runId, 'run-crashed');
  assert.deepEqual(h1?.outstanding, [1]);
  assert.deepEqual(deadManSweep(ob2), [], 'swept once');
  ob2.close();
});

test('typed confirmation: one-time code, exact phrase only', () => {
  const code = newChallenge();
  assert.match(code, /^[A-Z2-9]{4}$/);
  assert.equal(phraseMatches(`REAL scalp ${code}`, 'REAL', 'scalp', code), true);
  assert.equal(phraseMatches(`real scalp ${code}`, 'REAL', 'scalp', code), false);
  assert.equal(phraseMatches('REAL scalp', 'REAL', 'scalp', code), false);
  assert.notEqual(newChallenge(), newChallenge() + 'x');
});

test('wallet reconcile is read-only: two allowlisted RPC methods on a PUBLIC address, mismatches listed', async () => {
  const calls: string[] = [];
  const HELD = 'Heap111111111111111111111111111111111111111';
  const GONE = 'Gone111111111111111111111111111111111111111';
  const rpc = async (m: string, p: unknown[]) => {
    calls.push(m);
    if (m === 'getBalance') return { value: 2_500_000_000 };
    const prog = (p[1] as { programId: string }).programId;
    return { value: prog.startsWith('Tokenkeg') ? [{ account: { data: { parsed: { info: { mint: HELD, tokenAmount: { uiAmount: 12 } } } } } }] : [] };
  };
  const r = await reconcileWallet('Wa11et1111111111111111111111111111111111111', rpc, { held: [HELD, GONE], closed: [] });
  assert.equal(r.sol, 2.5);
  assert.deepEqual(r.missing, [GONE]);
  assert.deepEqual([...new Set(calls)].sort(), ['getBalance', 'getTokenAccountsByOwner']);
  await assert.rejects(reconcileWallet('[1,2,3]', rpc, { held: [], closed: [] }), /public base58 address/);
});
