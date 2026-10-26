// task-1645 r2 (verify-1652 F1): real holdings survive a run boundary. The open-position cap counts what an earlier
// run still holds, a run that ends holding a position hands it to the next real run of the strategy (whose exits keep
// firing on it), `halted` lists the open mints, a crash or a lost held.json is rebuilt from the outbox, and a
// compacted outbox keeps its nonce floor. FAKE executors only (the JSONL stream); no key, no network, no transaction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { presetPath, validateStrategy, type ResolvedStrategy } from '../src/strategy.ts';
import { loadTape, type MarketTick } from '../src/replay.ts';
import { runAutotrade, simExecutor } from '../src/runner.ts';
import { Outbox, noncePath, outboxPath, realDir } from '../src/outbox.ts';
import { JsonlChannel } from '../src/signal-channels.ts';
import { buildTestSignal, validateSignal, type TradeFireSignal } from '../src/signal.ts';
import {
  RealSignalExecutor, deadManSweep, heldPath, loadHoldings, openRealRun, readRealJournal, realModeCheck, releaseHolding, saveArming, saveCaps, type RealCaps,
} from '../src/real-mode.ts';
import { saveCapsTyped } from './fixtures/typed-save.ts';

const TAPE = loadTape(fileURLToPath(new URL('./fixtures/autotrade-1498-tape.json', import.meta.url)));
const home = () => mkdtempSync(join(tmpdir(), 'dexterm-1645-carry-'));
const MINT_A = 'So11111111111111111111111111111111111111112';
const MINT_B = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';
const ONE_OPEN: RealCaps = { perTradeSol: 0.05, dailySol: 10, buysPerDay: 100, maxOpenPositions: 1 };

function realScalp(id = 'my-scalp'): ResolvedStrategy {
  const raw = JSON.parse(readFileSync(presetPath('scalp'), 'utf8'));
  const r = validateStrategy({ ...raw, id, mode: 'real' });
  assert.ok(r.ok);
  return r.strategy;
}

function arm(h: string, s: ResolvedStrategy, caps: RealCaps = ONE_OPEN, accountId = 'main') {
  assert.ok(saveCapsTyped(h, caps).ok);
  saveArming(h, { strategyId: s.id, strategyHash: s.hash, version: s.version, accountId, armedAt: Date.now(), caps, channels: ['jsonl'], evidence: [], confirmation: { method: 'typed-tty', codeHash: 'x' } });
}

const stream = (h: string) => join(h, 's.jsonl');
const openOutbox = (h: string) => Outbox.open(h, { channels: [new JsonlChannel(stream(h))] });
const signals = (h: string): TradeFireSignal[] => readFileSync(stream(h), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as TradeFireSignal);

function executor(h: string, s: ResolvedStrategy, ob: Outbox, runId: string) {
  const c = realModeCheck(h, s, ['jsonl']);
  assert.ok(c.ok, c.ok ? '' : c.why);
  return new RealSignalExecutor({ home: h, inner: simExecutor(s.execution), outbox: ob, strategy: s, arming: c.arming, caps: c.caps, runId, ttlSec: 60, solUsd: () => 200, bookUsd: () => 500 });
}

const tick = (mint: string, price = 0.001): MarketTick => ({ t: Date.now(), mint, symbol: 'TKN', kind: 'live', price, mcap: 1e6, mcapResolved: 1e6, liq: 5e4 } as unknown as MarketTick);

async function tapeRun(h: string, s: ResolvedStrategy, ticks: MarketTick[], runId: string) {
  const ob = openOutbox(h);
  openRealRun(ob, runId, s, 'main');
  let bookUsd = s.bankroll.startUsd;
  const c = realModeCheck(h, s, ['jsonl']);
  assert.ok(c.ok, c.ok ? '' : c.why);
  const real = new RealSignalExecutor({ home: h, inner: simExecutor(s.execution), outbox: ob, strategy: s, arming: c.arming, caps: c.caps, runId, ttlSec: 60, solUsd: () => 200, bookUsd: () => bookUsd });
  const res = await runAutotrade({ strategy: s, tape: { ...TAPE, ticks }, sessions: null, executor: real, real, runId, onState: (st) => { bookUsd = st.book.equityUsd; } });
  await ob.pump();
  ob.close();
  return res;
}

/** Replay a signal stream: the most real positions open at once, and what is open at the end. */
function exposure(sigs: TradeFireSignal[]): { maxOpen: number; open: Set<string> } {
  const open = new Set<string>();
  let maxOpen = 0;
  for (const x of [...sigs].sort((a, b) => a.nonce - b.nonce)) {
    if (x.type !== 'trade') continue;
    if (x.side === 'buy') open.add(x.mint); else if ((x.sellFraction ?? 1) >= 0.999) open.delete(x.mint);
    maxOpen = Math.max(maxOpen, open.size);
  }
  return { maxOpen, open };
}

test('r2 F1 repro 1: the open-position cap holds across two real runs, and halted lists the open mint', async () => {
  const h = home();
  const s = realScalp();
  arm(h, s);
  let ob = openOutbox(h);
  openRealRun(ob, 'run-1', s, 'main');
  const e1 = executor(h, s, ob, 'run-1');
  const b1 = await e1.buy(tick(MINT_A), 10);
  assert.ok(!('refused' in b1));
  assert.deepEqual(await e1.buy(tick(MINT_B), 10), { refused: 'real-max-open' });
  e1.sendHalted('runner-stopped'); // a --max-minutes / SIGINT end, still holding A
  await ob.pump(); ob.close();
  assert.ok(existsSync(heldPath(h)));

  ob = openOutbox(h);
  openRealRun(ob, 'run-2', s, 'main');
  const e2 = executor(h, s, ob, 'run-2');
  assert.deepEqual(e2.inherited().map((p) => p.mint), [MINT_A]);
  assert.deepEqual(await e2.buy(tick(MINT_B), 10), { refused: 'real-max-open' }, 'before r2 this was filled (nonce 3): 2 positions under a cap of 1');
  assert.equal(e2.status().positions.length, 1);
  // The carried position can still be sold (its exit), and then the cap has room again.
  const sold = await e2.sell(tick(MINT_A, 0.0012), e2.inherited()[0].tokens, 'tp');
  assert.ok(!('refused' in sold));
  assert.ok(!('refused' in (await e2.buy(tick(MINT_B), 10))));
  await ob.pump(); ob.close();

  const sig = signals(h);
  const halted1 = sig.find((x) => x.type === 'halted' && x.runId === 'run-1');
  assert.ok(halted1 && halted1.type === 'halted');
  assert.deepEqual(halted1.open, [MINT_A]);
  assert.ok(validateSignal(halted1).ok);
  const sellA = sig.find((x) => x.type === 'trade' && x.side === 'sell' && x.mint === MINT_A);
  assert.ok(sellA && sellA.type === 'trade' && sellA.sellFraction === 1 && sellA.runId === 'run-2');
  assert.equal(exposure(sig).maxOpen, 1);
});

test('r2 F1 repro 2: a position open at a run end is adopted by the next run (exits keep firing, never re-bought, cap holds)', async () => {
  const h = home();
  const s = realScalp();
  arm(h, s);
  // The shortest tape prefix whose run ends holding a position (the verifier's cut: 70 ticks).
  let cut = 0;
  for (let n = 20; n < TAPE.ticks.length && !cut; n += 10) {
    const hh = home();
    arm(hh, s);
    if ((await tapeRun(hh, s, TAPE.ticks.slice(0, n), 'probe')).openAtEnd.length) cut = n;
  }
  assert.ok(cut, 'no tape prefix ends with an open position');
  const r1 = await tapeRun(h, s, TAPE.ticks.slice(0, cut), 'run-1');
  assert.equal(r1.openAtEnd.length, 1);
  const orphan = r1.openAtEnd[0].mint;
  const saved = loadHoldings(h).holdings[orphan];
  assert.ok(saved?.position, 'the run end saved the book view of the open position');
  assert.equal(saved.position!.ladder.length, 0);

  const r2 = await tapeRun(h, s, TAPE.ticks.slice(cut), 'run-2');
  assert.ok(r2.ledger.events.some((e) => e.kind === 'position_adopted' && (e as { mint?: string }).mint === orphan), 'run 2 adopted the open position');

  const sig = signals(h);
  const run2 = sig.filter((x) => x.runId === 'run-2' && x.type === 'trade');
  const firstSell = run2.findIndex((x) => x.type === 'trade' && x.side === 'sell' && x.mint === orphan);
  const firstBuy = run2.findIndex((x) => x.type === 'trade' && x.side === 'buy' && x.mint === orphan);
  const halted2 = sig.find((x) => x.type === 'halted' && x.runId === 'run-2');
  assert.ok(halted2 && halted2.type === 'halted');
  // Either run 2 exited it, or it is still held and listed open again; never bought a second time while held.
  assert.ok(firstSell >= 0 || halted2.open?.includes(orphan), 'the carried position got an exit or is carried again');
  if (firstBuy >= 0) assert.ok(firstSell >= 0 && firstSell < firstBuy, 'a re-entry only after its exit (before r2: bought again at nonce 3)');
  assert.ok(exposure(sig).maxOpen <= ONE_OPEN.maxOpenPositions, `never more than ${ONE_OPEN.maxOpenPositions} real position open across both runs`);
  // held.json agrees with the signal stream at the end.
  assert.deepEqual(Object.keys(loadHoldings(h).holdings).sort(), [...exposure(sig).open].sort());
});

test('r2: a crashed run (no carry, no halted) still counts, the dead-man halted lists it, the next run rebuilds its position', async () => {
  const h = home();
  const s = realScalp();
  arm(h, s);
  let ob = openOutbox(h);
  openRealRun(ob, 'run-1', s, 'main');
  const e1 = executor(h, s, ob, 'run-1');
  const b = await e1.buy(tick(MINT_A), 10);
  assert.ok(!('refused' in b));
  await ob.pump(); ob.close(); // kill -9: no carry(), no sendHalted()

  ob = openOutbox(h);
  assert.deepEqual(deadManSweep(ob, Date.now(), 'run-2'), ['run-1']);
  openRealRun(ob, 'run-2', s, 'main');
  const e2 = executor(h, s, ob, 'run-2');
  const [p] = e2.inherited();
  assert.equal(p.mint, MINT_A);
  assert.equal(p.profileId, s.exits.default, 'no saved view: the default exit profile');
  assert.ok(Math.abs(p.tokens - b.tokens) < 1e-9 && p.entryPrice > 0);
  assert.deepEqual(await e2.buy(tick(MINT_B), 10), { refused: 'real-max-open' });
  await ob.pump(); ob.close();
  const lost = signals(h).find((x) => x.type === 'halted' && x.runId === 'run-1');
  assert.ok(lost && lost.type === 'halted' && lost.reason === 'runner-lost');
  assert.deepEqual(lost.open, [MINT_A]);
});

test('r2: a missing held.json is rebuilt from every outbox file, including a compacted archive', async () => {
  const h = home();
  const s = realScalp();
  arm(h, s);
  const ob = openOutbox(h);
  openRealRun(ob, 'run-1', s, 'main');
  const e1 = executor(h, s, ob, 'run-1');
  assert.ok(!('refused' in (await e1.buy(tick(MINT_A), 10))));
  e1.sendHalted('runner-stopped');
  await ob.pump(); ob.close();
  // What compaction does to the live file, then the holdings file is lost.
  renameSync(outboxPath(h), join(realDir(h), 'outbox.1700000000000.done.jsonl'));
  rmSync(heldPath(h));

  const l = loadHoldings(h);
  assert.equal(l.source, 'rebuilt');
  assert.deepEqual(Object.keys(l.holdings), [MINT_A]);
  const ob2 = openOutbox(h);
  openRealRun(ob2, 'run-2', s, 'main');
  const e2 = executor(h, s, ob2, 'run-2');
  assert.equal(e2.holdingsSource, 'rebuilt');
  assert.deepEqual(await e2.buy(tick(MINT_B), 10), { refused: 'real-max-open' });
  ob2.close();
  assert.ok(existsSync(heldPath(h)), 'the rebuilt holdings are saved again');
  assert.ok(readRealJournal(h).some((j) => j.action === 'holdings-rebuilt'));
});

test('r2: a mint held by another strategy is not bought, and counts against the cap', async () => {
  const h = home();
  const a = realScalp('scalp-a');
  const b = realScalp('scalp-b');
  arm(h, a, { ...ONE_OPEN, maxOpenPositions: 2 });
  arm(h, b, { ...ONE_OPEN, maxOpenPositions: 2 });
  let ob = openOutbox(h);
  openRealRun(ob, 'run-a', a, 'main');
  const ea = executor(h, a, ob, 'run-a');
  assert.ok(!('refused' in (await ea.buy(tick(MINT_A), 10))));
  ea.sendHalted('runner-stopped');
  ob.close();

  ob = openOutbox(h);
  openRealRun(ob, 'run-b', b, 'main');
  const eb = executor(h, b, ob, 'run-b');
  assert.deepEqual(eb.inherited(), [], 'another strategy\'s holding is not adopted');
  assert.deepEqual(eb.heldElsewhere().map((x) => x.strategyId), ['scalp-a']);
  assert.deepEqual(await eb.buy(tick(MINT_A), 10), { refused: 'real-held-elsewhere' });
  assert.ok(!('refused' in (await eb.buy(tick(MINT_B), 10))));
  assert.equal(eb.status().positions.find((p) => p.mint === MINT_A)?.heldBy, 'scalp-a');
  ob.close();
});

test('r2: releasing a holding needs the typed confirmation and is journaled', () => {
  const h = home();
  const s = realScalp();
  arm(h, s);
  const ob = openOutbox(h);
  openRealRun(ob, 'run-1', s, 'main');
  const e = executor(h, s, ob, 'run-1');
  return e.buy(tick(MINT_A), 10).then((f) => {
    assert.ok(!('refused' in f));
    ob.close();
    assert.equal(releaseHolding(h, MINT_A, { confirmed: false }).ok, false);
    assert.ok(loadHoldings(h).holdings[MINT_A]);
    assert.equal(releaseHolding(h, MINT_A, { confirmed: true }).ok, true);
    assert.deepEqual(loadHoldings(h).holdings, {});
    assert.ok(readRealJournal(h).some((j) => j.action === 'release-holding' && j.data.mint === MINT_A));
  });
});

test('r2 R1: a compacted outbox keeps its nonce floor even with nonce.json lost', async () => {
  const h = home();
  const hdr = (nonce: number, now: number) => ({ nonce, now, ttlSec: 10, runId: 'r1', accountId: 'main', strategy: { id: 'x', version: '1.0.0', hash: '0'.repeat(16) } });
  const t = Date.now();
  let ob = Outbox.open(h, { channels: [new JsonlChannel(stream(h))], now: () => t });
  for (let i = 0; i < 5; i++) ob.enqueue(buildTestSignal(hdr(ob.allocateNonce(), t)));
  while (ob.depth()) await ob.pump();
  const last = ob.lastNonceIssued;
  ob.close();
  appendFileSync(outboxPath(h), '\n'.repeat((1 << 20) + 16)); // over the compaction size; blank lines replay as nothing

  ob = Outbox.open(h, { channels: [], noLock: true }); ob.close();
  assert.ok(!readdirSync(realDir(h)).some((f) => f.endsWith('.done.jsonl')), 'a read-only view never compacts');
  ob = Outbox.open(h, { channels: [] }); ob.close(); // the lock holder compacts
  assert.ok(readdirSync(realDir(h)).some((f) => f.endsWith('.done.jsonl')));
  rmSync(noncePath(h));
  ob = Outbox.open(h, { channels: [] });
  assert.equal(ob.allocateNonce(), last + 1, 'before r2 the count restarted at 1');
  ob.close();
});
