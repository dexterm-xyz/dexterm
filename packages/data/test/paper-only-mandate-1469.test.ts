// task-1469 — a PAPER-ONLY mandate (`dexterm mandate draft --paper`): its own paper ceilings, so the agent paper
// desk can book a $500 simulated entry at the hands-free tier, while the plan engine refuses to arm, fire or copy
// into it, and every normal mandate keeps the HARD ceilings and the exact caps hash it had before.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeClock } from '../src/clock.ts';
import { Journal } from '../src/trade/plans/journal.ts';
import { draftMandate, capsHash, HARD, PAPER_HARD } from '../src/trade/plans/mandate.ts';
import type { Mandate } from '../src/trade/plans/mandate.ts';
import { PaperWallet, PaperExecutor, SOL_MINT } from '../src/paper.ts';
import type { QuoteRequest, SwapQuote } from '../src/sources/jupiter-swap.ts';
import { PaperAgentDesk, PaperDeskError } from '../src/trade/agent/paper-desk.ts';
import { loadMandateFromJournal } from '../src/trade/agent/rendezvous.ts';
import { PlanService } from '../src/trade/plans/service.ts';
import { PolicyRefusal } from '../src/trade/plans/engine.ts';
import { SimClock, SUPPLY, NORTH_STAR_PLAN, DEFAULT_MANDATE } from './plans-helpers.ts';

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BIG = { totalUsd: 4000, perTradeUsd: 2000, perCoinUsd: 500, dailyLossUsd: 10_000, maxOpenPositions: 2, maxPriceImpactPct: 8 };

test('a paper-only draft clamps to PAPER_HARD; anything but `paperOnly: true` stays a normal HARD-clamped mandate', () => {
  const clock = new FakeClock(1_700_000_000_000);
  const paper = draftMandate({ ...BIG, paperOnly: true, perCoinUsd: 99_999, maxPriceImpactPct: 50 }, { clock });
  assert.equal(paper.paperOnly, true);
  assert.equal(paper.budget.perTradeUsd, 2000);
  assert.equal(paper.budget.perCoinUsd, PAPER_HARD.perCoinUsd);
  assert.equal(paper.limits.maxPriceImpactPct, PAPER_HARD.maxPriceImpactPct);
  assert.equal(paper.limits.maxOpenPositions, 2);
  for (const flag of ['true', 1, 'yes', {}, null, undefined]) {
    const m = draftMandate({ ...BIG, paperOnly: flag }, { clock });
    assert.equal('paperOnly' in m, false, `paperOnly ${JSON.stringify(flag)} is not a paper mandate`);
    assert.equal(m.budget.perTradeUsd, HARD.perTradeUsd);
    assert.equal(m.limits.maxPriceImpactPct, HARD.maxPriceImpactPct);
  }
  // The live ceilings themselves did not move.
  assert.deepEqual({ ...HARD }, {
    totalUsd: 2000, perTradeUsd: 500, perCoinUsd: 1000, dailyLossUsd: 2000, maxArmedPlans: 200, maxInFlight: 25, maxOpenPositions: 100,
    maxSlippageBps: 1000, maxPriceImpactPct: 3, tipBudgetLamports: 500_000_000, maxTipLamportsPerTx: 10_000_000,
    maxPriorityFeeLamportsPerTx: 10_000_000, ttlMs: 24 * 3600_000, maxSendsPerSec: 20,
  });
});

test('a normal mandate hashes exactly as before; the paper flag is part of what a gesture arms', () => {
  const clock = new FakeClock(1_700_000_000_000);
  const m = draftMandate({ ...DEFAULT_MANDATE }, { clock, id: 'mandate_x' });
  const legacy = createHash('sha256').update(JSON.stringify({ b: m.budget, l: m.limits, f: m.fees, a: m.allowed, t: m.maxTier, e: m.expiresAt, w: m.wallet })).digest('hex').slice(0, 16);
  assert.equal(capsHash(m), legacy);
  const p = draftMandate({ ...DEFAULT_MANDATE, paperOnly: true }, { clock, id: 'mandate_x' });
  assert.deepEqual(p.budget, m.budget, 'same caps (all under HARD)');
  assert.notEqual(capsHash(p), capsHash(m), 'a proof for the normal mandate cannot arm the paper one, or the reverse');
});

test('the plan engine refuses to arm a plan into a paper-only mandate (and policy refuses a fire under one)', () => {
  const svc = new PlanService({ clock: new SimClock(), journalPath: null });
  const m = svc.draftMandate({ ...DEFAULT_MANDATE, paperOnly: true });
  svc.armMandateByKeypress(m.id);
  assert.equal(svc.listMandates().find((r) => r.id === m.id)?.paperOnly, true);
  const plan = svc.propose({ ...NORTH_STAR_PLAN }, { supply: SUPPLY, by: 'user' });
  assert.throws(() => svc.armPlanByKeypress(plan.id, m.id), (e: unknown) => e instanceof PolicyRefusal && e.reason === 'paper-only-mandate');
  assert.equal(svc.summary(plan.id).status, 'proposed', 'the plan stays a proposal');
  // A normal mandate on the same service still arms the same plan.
  const n = svc.draftMandate({ ...DEFAULT_MANDATE });
  svc.armMandateByKeypress(n.id);
  assert.equal(svc.listMandates().find((r) => r.id === n.id)?.paperOnly, false);
  svc.armPlanByKeypress(plan.id, n.id);
  assert.equal(svc.summary(plan.id).status, 'armed');
});

test('copy automation refuses a paper-only mandate before consuming its proof', () => {
  const svc = new PlanService({ clock: new SimClock(), journalPath: null });
  const m = svc.draftMandate({ ...DEFAULT_MANDATE, paperOnly: true });
  const engine = svc.engine as unknown as { gate: { handsFreeAllowed(): boolean }; authorizeCopy(id: string, p: unknown, w: string): unknown; issueMandateProof(id: string, g: string): { consumed: boolean } };
  engine.gate = { ...engine.gate, handsFreeAllowed: () => true };
  const proof = engine.issueMandateProof(m.id, 'keypress');
  assert.throws(() => engine.authorizeCopy(m.id, proof, 'wallet'), (e: unknown) => e instanceof PolicyRefusal && e.reason === 'paper-only-mandate');
  assert.equal(proof.consumed, false);
  assert.equal(svc.listMandates().find((r) => r.id === m.id)?.status, 'draft');
});

test('the paper-only mandate replays from the plans journal and lets the agent desk book a $500 hands-free entry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'paper-only-'));
  const journalPath = join(dir, 'plans.journal');
  const clock = new FakeClock(1_700_000_000_000);
  const svc = new PlanService({ journalPath, clock });
  const drafted = svc.draftMandate({ ...BIG, paperOnly: true, maxTier: 'hands-free' });
  svc.armMandateByKeypress(drafted.id, 'keypress');
  const loaded = loadMandateFromJournal(journalPath, drafted.id, clock);
  const mandate = loaded.mandate as Mandate;
  assert.equal(mandate.status, 'armed');
  assert.equal(mandate.paperOnly, true);

  const wallet = new PaperWallet({ path: ':memory:', clock });
  const quote = async (req: QuoteRequest): Promise<SwapQuote> => {
    const outAmount = req.inputMint === SOL_MINT ? req.amount / 1000n : req.amount * 1000n;
    return {
      inputMint: req.inputMint, outputMint: req.outputMint, inAmount: req.amount, outAmount, otherAmountThreshold: outAmount,
      mode: 'ExactIn', slippageBps: req.slippageBps, priceImpactPct: 6, route: ['Pump.fun Amm'], platformFeeBps: null,
      platformFeeAmount: null, usdValue: null, contextSlot: null, source: 'jupiter-swap', fetchedAt: Date.now(),
    };
  };
  const desk = new PaperAgentDesk({
    mandate, wallet, executor: new PaperExecutor(wallet, { clock }), quote,
    solUsd: () => 100, control: () => ({ state: 'running' }), journal: new Journal({ clock }), clock, agent: 'test-agent',
  });
  assert.equal(desk.pnl().mandate?.perTradeUsd, 500, 'hands-free x0.25 of the $2000 paper per-trade cap');
  const open = () => desk.open({ mint: MINT, symbol: 'SAMPLE', decimals: 6, side: 'buy' });
  const t = open();
  assert.throws(() => desk.size(t.id, { usd: 500.01 }), (e: unknown) => e instanceof PaperDeskError && e.reason === 'per-trade-cap');
  desk.size(t.id, { usd: 500 });
  const { fill } = await desk.confirm(t.id); // 6 % impact is inside the paper mandate's 8 %
  assert.equal(fill.paper, true);
  // The per-coin cap ($500) makes it one entry per coin.
  const again = open();
  assert.throws(() => desk.size(again.id, { usd: 10 }), (e: unknown) => e instanceof PaperDeskError && e.reason === 'per-coin-cap');
});
