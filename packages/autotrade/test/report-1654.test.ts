// task-1654 (0.2.0 card E): the paper-vs-real divergence report (receipts against dexterm's own paper fills) and the
// daily / weekly digest (per strategy and mode, the win rate with its interval, net, drawdown, refusals, limits hit,
// an honest sample note), plus the opt-in schedule. Temp homes and synthetic ledgers only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTradeSignal, type TradeSignal } from '../src/signal.ts';
import { Outbox } from '../src/outbox.ts';
import { RECEIPT_SCHEMA, appendReceipt, divergenceLines, divergenceOf, divergenceReport, type Receipt } from '../src/receipts.ts';
import { buildDigest, digestDue, digestLines, wilson, loadDigestState, saveDigestState } from '../src/report.ts';
import { fileLedger } from '../src/ledger.ts';
import { RealSignalExecutor, saveArming, realModeCheck } from '../src/real-mode.ts';
import { emptyLimits, saveLimits } from '../src/limits.ts';
import { presetPath, validateStrategy } from '../src/strategy.ts';
import { simExecutor } from '../src/runner.ts';
import { loadTape, type MarketTick } from '../src/replay.ts';
import { saveTyped } from './fixtures/typed-save.ts';

const MINT = 'So1aNaMint11111111111111111111111111111111';
const home = () => mkdtempSync(join(tmpdir(), 'dexterm-1654-rep-'));
const NOW = Date.parse('2026-10-20T12:00:00Z');

function sig(nonce: number, side: 'buy' | 'sell', model: { priceUsd: number; tokens: number }, t = NOW): TradeSignal {
  return buildTradeSignal({ side, mint: MINT, symbol: 'PEPE', sizeUsd: 50, solUsd: 200, bookUsd: 1000, sellFraction: side === 'sell' ? 1 : null, exitReason: side === 'sell' ? 'trail' : null, priceUsd: 1, mcap: 1e6, liqUsd: 5e4, slippageBps: 300, maxImpactPct: 3, model },
    { nonce, now: t, ttlSec: 60, runId: 'run-x', accountId: 'main', strategy: { id: 'my-scalp', version: '1.0.0', hash: 'ab'.repeat(8) } }) as TradeSignal;
}
const rec = (s: TradeSignal, status: Receipt['status'], fill: Partial<NonNullable<Receipt['fill']>> | null, atMs: number, reason: string | null = null): Receipt =>
  ({ schema: RECEIPT_SCHEMA, signalId: s.id, nonce: s.nonce, accountId: 'main', status, at: atMs, fill: fill ? { priceUsd: null, sizeSol: null, tokens: null, txSig: null, ...fill } : null, reason, executor: 'fake' });

test('divergence: adverse slippage vs the paper fill (both sides), latency, partial fills, rejections; an honest sample note', () => {
  const b = sig(1, 'buy', { priceUsd: 1.0, tokens: 50 });
  const s = sig(2, 'sell', { priceUsd: 1.0, tokens: 50 });
  const p = sig(3, 'buy', { priceUsd: 2.0, tokens: 25 });
  const r = sig(4, 'buy', { priceUsd: 1.0, tokens: 50 });
  const d1 = divergenceOf(b, rec(b, 'executed', { priceUsd: 1.05, sizeSol: 0.25, tokens: 47.6 }, NOW + 1500))!;
  assert.equal(d1.slippageVsPaperPct, 5, 'a buy filled 5% higher than paper is 5% worse');
  assert.equal(d1.latencyMs, 1500);
  assert.equal(d1.partial, false);
  const d2 = divergenceOf(s, rec(s, 'executed', { priceUsd: 0.95, tokens: 50 }, NOW + 800))!;
  assert.equal(d2.slippageVsPaperPct, 5, 'a sell filled 5% lower than paper is 5% worse');
  const d3 = divergenceOf(p, rec(p, 'executed', { sizeSol: 0.1, tokens: 10 }, NOW + 3000))!;
  assert.equal(d3.partial, true, '0.1 of 0.25 SOL filled');
  assert.equal(d3.fillRatio, 0.4);
  assert.equal(d3.slippageVsPaperPct, 0, 'price from size and tokens: 0.1 SOL × $200 / 10 = $2, same as paper');
  assert.equal(divergenceOf(undefined, rec(b, 'executed', null, NOW)), null);
  const rep = divergenceReport([b, s, p, r], [rec(b, 'executed', { priceUsd: 1.05, sizeSol: 0.25 }, NOW + 1500), rec(s, 'executed', { priceUsd: 0.95, tokens: 50 }, NOW + 800), rec(p, 'executed', { sizeSol: 0.1, tokens: 10 }, NOW + 3000), rec(r, 'rejected', null, NOW + 400, 'slippage too high')]);
  assert.equal(rep.trades, 4); assert.equal(rep.receipted, 4); assert.equal(rep.executed, 3); assert.equal(rep.rejected, 1); assert.equal(rep.partial, 1);
  assert.equal(rep.slippage.medianPct, 5); assert.equal(rep.latency.medianMs, 1500);
  assert.deepEqual(rep.reasons, { 'rejected: slippage too high': 1 });
  assert.match(rep.note, /only 3 executed fill\(s\): too few to calibrate paper fills with confidence/);
  const lines = divergenceLines(rep);
  assert.match(lines[0], /4\/4 trade signals have a receipt · executed 3 · rejected 1 · failed 0 · partial 1/);
  assert.match(lines[1], /median 5% .*positive = the real fill was worse than paper/);
});

test('a receipt that lands during a real run carries its divergence into the ledger row (RealSignalExecutor.step)', async () => {
  const h = home();
  const r = validateStrategy({ ...JSON.parse(readFileSync(presetPath('scalp'), 'utf8')), mode: 'real' });
  assert.ok(r.ok);
  const s = r.strategy;
  assert.ok(saveTyped(h, { ...emptyLimits(), global: {} }).ok);
  saveArming(h, { strategyId: s.id, strategyHash: s.hash, version: s.version, accountId: 'main', armedAt: 1, caps: { perTradeSol: 1, dailySol: 1, buysPerDay: 1, maxOpenPositions: 1 }, channels: ['jsonl'], evidence: [], confirmation: { method: 'typed-tty', codeHash: 'x' } });
  const check = realModeCheck(h, s, ['jsonl']);
  assert.ok(check.ok);
  const tape = loadTape(fileURLToPath(new URL('./fixtures/autotrade-1498-tape.json', import.meta.url))) as unknown as { ticks: MarketTick[] };
  const k = tape.ticks.find((x) => x.liq && x.liq > 20_000 && x.price)!;
  const ob = Outbox.open(h, { channels: [], now: () => k.t });
  const ex = new RealSignalExecutor({ home: h, inner: simExecutor(s.execution), outbox: ob, strategy: s, arming: check.arming, caps: check.caps, limits: check.limits.values, runId: 'run-div', ttlSec: 60, solUsd: () => 200, bookUsd: () => 1000, now: () => k.t });
  const f = await ex.buy(k, 40);
  assert.ok(!('refused' in f), JSON.stringify(f));
  const out = ob.get(f.signal!.nonce) as TradeSignal;
  assert.ok(out.model && out.model.priceUsd === f.price && out.model.tokens === f.tokens, 'the signal carries the paper fill it was booked at');
  appendReceipt(h, rec(out, 'executed', { priceUsd: f.price * 1.1, sizeSol: out.sizeSol, tokens: f.tokens / 1.1 }, k.t + 2000));
  const st = ex.step();
  ob.close();
  assert.equal(st.receipts.length, 1);
  assert.equal(st.receipts[0].divergence!.slippageVsPaperPct, 10);
  assert.equal(st.receipts[0].divergence!.latencyMs, 2000);
  assert.equal(ex.status().executor.lastReceipt?.status, 'executed', 'a receipt is a sign of life');
});

test('the digest: per strategy and mode, the win rate with its Wilson interval, net, drawdown, refusals, limits hit, clamps, a sample note', () => {
  assert.equal(wilson(0, 0), null);
  assert.deepEqual(wilson(7, 10), [39.7, 89.2]);
  assert.deepEqual(wilson(0, 5), [0, 43.4]);
  const h = home();
  const closed = (t: number, pnlUsd: number) => ({ t, kind: 'trade_closed', data: { trade: { pnlUsd, mint: MINT } } });
  const write = (runId: string, strategy: string, mode: 'paper' | 'real', rows: { t: number; kind: string; data: Record<string, unknown> }[]) => {
    const { ledger } = fileLedger(h, runId);
    ledger.add(rows[0]?.t ?? NOW, 'run_start', { strategy, mode, ...(mode === 'real' ? { tag: 'real-signal' } : {}) });
    for (const r of rows) ledger.add(r.t, r.kind, r.data);
  };
  const H = 3_600_000;
  write('20261020T000000Z-my-scalp-aaaa', 'my-scalp', 'real', [
    closed(NOW - 5 * H, 10), closed(NOW - 4 * H, -30), closed(NOW - 3 * H, 5), closed(NOW - 2 * H, -10),
    { t: NOW - 2 * H, kind: 'refused', data: { rule: 'fill-real-daily-cap' } }, { t: NOW - 2 * H, kind: 'refused', data: { rule: 'fill-real-daily-cap' } }, { t: NOW - H, kind: 'refused', data: { rule: 'entries-paused' } },
    { t: NOW - 5 * H, kind: 'fill', data: { side: 'buy', limitClamps: ['perTradeSol'] } }, { t: NOW - 3 * H, kind: 'receipt', data: { status: 'executed' } },
  ]);
  write('20261020T000000Z-swing-bbbb', 'swing', 'paper', [closed(NOW - 6 * H, 4), closed(NOW - 30 * H, 99)]);
  write('20261010T000000Z-old-cccc', 'old', 'paper', [closed(NOW - 10 * 24 * H, 1)]);
  const d = buildDigest(h, { period: 'day', now: NOW });
  assert.deepEqual(d.strategies.map((s) => [s.strategyId, s.mode]), [['my-scalp', 'real'], ['swing', 'paper']], 'the 10-day-old run is outside the day');
  const r = d.strategies[0];
  assert.deepEqual([r.trades, r.wins, r.winRatePct, r.netUsd, r.maxDrawdownUsd, r.refusals, r.receipts], [4, 2, 50, -25, 35, 3, 1]);
  assert.deepEqual(r.winRateCi, wilson(2, 4));
  assert.deepEqual(r.limitsHit, { 'real-daily-cap': 2 });
  assert.deepEqual(r.clamped, { perTradeSol: 1 });
  assert.equal(d.strategies[1].trades, 1, 'the swing close 30 h ago is outside a day');
  assert.match(d.note, /5 closed trade\(s\) in total: a small sample/);
  const lines = digestLines(d);
  assert.match(lines[0], /^dexterm daily digest · .* UTC · not financial advice$/);
  assert.ok(lines.some((l) => /^REAL my-scalp · 1 run\(s\) · 4 trade\(s\) · win 50% \(95% interval 15-85%\) · net -\$25\.00 · max drawdown \$35\.00$/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /limits hit: real-daily-cap ×2 · clamped by: perTradeSol ×1 · receipts 1/.test(l)));
  assert.ok(lines.some((l) => l.startsWith('paper vs real fills:')), 'a real strategy brings the divergence line');
  const w = buildDigest(h, { period: 'week', now: NOW });
  assert.equal(w.strategies.find((s) => s.strategyId === 'swing')!.trades, 2);
  assert.equal(buildDigest(h, { period: 'week', now: NOW, strategyId: 'swing' }).strategies.length, 1);
  assert.equal(buildDigest(home(), { period: 'day', now: NOW }).note, 'no closed trades in this period');
});

test('the scheduled digest is opt-in: off by default, once a local day (daily) or on Mondays (weekly)', () => {
  const h = home();
  const s = loadDigestState(h);
  assert.equal(s.schedule, 'off');
  assert.equal(digestDue(s, NOW), null);
  saveDigestState(h, { ...s, schedule: 'daily' });
  const d = loadDigestState(h);
  assert.equal(digestDue(d, NOW), 'day');
  const day = (t: number) => { const x = new Date(t); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
  assert.equal(digestDue({ ...d, lastSentDay: day(NOW) }, NOW), null, 'not twice a day');
  const monday = Date.parse('2026-10-19T15:00:00Z');
  assert.equal(digestDue({ ...d, schedule: 'weekly' }, NOW), null, 'Tuesday');
  assert.equal(digestDue({ ...d, schedule: 'weekly' }, monday), 'week');
});
