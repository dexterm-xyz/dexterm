// task-1506 (AUTOTRADE AT-4) — the paper desk additions the position monitor needs, all additive:
//   P1 exit plans + exits journaled as agent.paper.exit.<rule> (and .plan / .done),
//   P2 a close-only control state (exits run, buys refused, even on an expired mandate; panic still halts),
//   P4 a sanitized note on fills.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeClock } from '../src/clock.ts';
import { Journal } from '../src/trade/plans/journal.ts';
import { draftMandate, type Mandate } from '../src/trade/plans/mandate.ts';
import { KillSwitch } from '../src/trade/kill-switch.ts';
import { PaperWallet, PaperExecutor, SOL_MINT } from '../src/paper.ts';
import type { QuoteRequest, SwapQuote } from '../src/sources/jupiter-swap.ts';
import { PaperExitDesk, PaperDeskError, sanitizeFillNote, exitRuleSlug, type DeskControl } from '../src/trade/agent/paper-desk.ts';
import { readDeskControl, writeDeskControl } from '../src/trade/agent/rendezvous.ts';

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function quoteAt(state: { lamportsPerTokenRaw: number }, calls: { n: number }) {
  return async (req: QuoteRequest): Promise<SwapQuote> => {
    calls.n++;
    const buy = req.inputMint === SOL_MINT;
    const outAmount = buy
      ? BigInt(Math.max(1, Math.floor(Number(req.amount) / state.lamportsPerTokenRaw)))
      : BigInt(Math.max(1, Math.floor(Number(req.amount) * state.lamportsPerTokenRaw)));
    return {
      inputMint: req.inputMint, outputMint: req.outputMint, inAmount: req.amount, outAmount, otherAmountThreshold: outAmount,
      mode: 'ExactIn', slippageBps: req.slippageBps, priceImpactPct: 0.5, route: ['fixture'], platformFeeBps: null,
      platformFeeAmount: null, usdValue: null, contextSlot: null, source: 'jupiter-swap', fetchedAt: 0,
    };
  };
}

function harness() {
  const clock = new FakeClock(1_700_000_000_000);
  const dir = mkdtempSync(join(tmpdir(), 'paper-desk-1506-'));
  const wallet = new PaperWallet({ path: ':memory:', clock });
  const journal = new Journal({ clock });
  const control = { v: { state: 'running' } as DeskControl };
  const kill = new KillSwitch(join(dir, 'trading.panic'));
  const price = { lamportsPerTokenRaw: 1000 };
  const calls = { n: 0 };
  const m = draftMandate({ paperOnly: true, ttlMs: 3600_000 }, { clock });
  m.status = 'armed'; m.armedAt = clock.now();
  const mandate = { v: m as Mandate };
  const desk = new PaperExitDesk({
    mandate: () => mandate.v, wallet, executor: new PaperExecutor(wallet, { clock }), quote: quoteAt(price, calls),
    solUsd: () => 150, control: () => control.v, journal, killSwitch: kill, clock, agent: 'autotrade-monitor',
  });
  const buy = async (usd = 5, note?: unknown) => {
    const t = desk.open({ mint: MINT, symbol: 'SAMPLE', decimals: 6, side: 'buy' });
    desk.size(t.id, { usd });
    return desk.confirm(t.id, { note });
  };
  return { clock, wallet, journal, control, kill, price, calls, mandate, desk, buy };
}

const events = (j: Journal, type: string) => j.events.filter((e) => e.type === type);

test('close-only: a buy is refused, an exit and a close still run', async () => {
  const h = harness();
  await h.buy();
  h.desk.registerExitPlan({ mint: MINT, owner: 'autotrade-monitor', positionId: 'p1', profileId: 'moonbag' });
  h.control.v = { state: 'close-only', reason: 'autotrade stop' };
  assert.throws(() => h.desk.open({ mint: MINT, symbol: 'SAMPLE', decimals: 6, side: 'buy' }), (e: unknown) => e instanceof PaperDeskError && e.reason === 'close-only');
  const half = await h.desk.exit({ mint: MINT, fraction: 0.5, rule: 'tp1' });
  assert.equal(half.fill.side, 'sell');
  const rest = await h.desk.close({ mint: MINT });
  assert.equal(rest.position?.tokens ?? 0, 0);
  assert.ok(h.journal.verify().ok);
});

test('close-only: exits run on an expired or revoked mandate; running keeps refusing them (unchanged)', async () => {
  const h = harness();
  await h.buy();
  h.desk.registerExitPlan({ mint: MINT, owner: 'autotrade-monitor', positionId: 'p1', profileId: 'moonbag' });
  await h.clock.advance(2 * 3600_000); // past the 1 h TTL
  await assert.rejects(h.desk.exit({ mint: MINT, fraction: 0.25, rule: 'stop' }), (e: unknown) => e instanceof PaperDeskError && e.reason === 'mandate-expired');
  h.control.v = { state: 'close-only' };
  const r = await h.desk.exit({ mint: MINT, fraction: 0.25, rule: 'stop' });
  assert.equal(r.rule, 'stop');
  h.mandate.v = { ...h.mandate.v, status: 'revoked' };
  await h.desk.exit({ mint: MINT, fraction: 0.5, rule: 'trail' });
  // a buy under close-only is refused at every stage, whatever the mandate says
  h.mandate.v = { ...h.mandate.v, status: 'armed', expiresAt: h.clock.now() + 3600_000 };
  assert.throws(() => h.desk.open({ mint: MINT, symbol: 'SAMPLE', decimals: 6, side: 'buy' }), (e: unknown) => e instanceof PaperDeskError && e.reason === 'close-only');
});

test('close-only: a buy ticket opened while running is refused at confirm; panic halts exits too', async () => {
  const h = harness();
  await h.buy();
  h.desk.registerExitPlan({ mint: MINT, owner: 'autotrade-monitor', positionId: 'p1', profileId: 'moonbag' });
  const t = h.desk.open({ mint: MINT, symbol: 'SAMPLE', decimals: 6, side: 'buy' });
  h.desk.size(t.id, { usd: 1 });
  h.control.v = { state: 'close-only' };
  await assert.rejects(h.desk.confirm(t.id), (e: unknown) => e instanceof PaperDeskError && e.reason === 'close-only');
  h.kill.engage('test');
  await assert.rejects(h.desk.exit({ mint: MINT, rule: 'rug-liquidity' }), (e: unknown) => e instanceof PaperDeskError && e.reason === 'panic');
});

test('the control file accepts close-only (and still fails closed on junk)', () => {
  const env = { DEXTERM_HOME: mkdtempSync(join(tmpdir(), 'desk-ctl-1506-')) } as NodeJS.ProcessEnv;
  writeDeskControl({ state: 'close-only', reason: 'mandate expired' }, env);
  assert.deepEqual(readDeskControl(env), { state: 'close-only', reason: 'mandate expired' });
  writeDeskControl({ state: 'bogus' as never }, env);
  assert.equal(readDeskControl(env).state, 'stopped');
});

test('P1: exit plans are journaled, exits are agent.paper.exit.<rule> before the fill, done when empty', async () => {
  const h = harness();
  await h.buy();
  const plan = h.desk.registerExitPlan({ mint: MINT, owner: 'autotrade-monitor', positionId: 'p1', profileId: 'moonbag', runId: 'run-a' });
  assert.equal(h.desk.registerExitPlan({ mint: MINT, owner: 'autotrade-monitor', positionId: 'p1', profileId: 'moonbag' }).planId, plan.planId, 'same position → same plan');
  assert.equal(events(h.journal, 'agent.paper.exit.plan').length, 1);
  await h.desk.exit({ mint: MINT, fraction: 0.4, rule: 'cost-recovery', detail: '+100%: take the cost back', note: { profile: 'moonbag' } });
  await h.desk.exit({ mint: MINT, rule: 'bag-trail' });
  const types = h.journal.types();
  const ix = (t: string) => types.indexOf(t);
  assert.ok(ix('agent.paper.exit.cost-recovery') >= 0 && ix('agent.paper.exit.bag-trail') > ix('agent.paper.exit.cost-recovery'));
  assert.ok(ix('agent.paper.exit.done') > ix('agent.paper.exit.bag-trail'));
  const fills = events(h.journal, 'agent.paper.fill').filter((e) => (e.data as { side: string }).side === 'sell');
  assert.equal(fills.length, 2);
  const note = (fills[0].data as { note: Record<string, unknown> }).note;
  assert.deepEqual(note, { profile: 'moonbag', exit: 'cost-recovery', planId: plan.planId, positionId: 'p1' });
  assert.deepEqual(h.desk.exitPlans(), []);
  assert.ok(h.journal.verify().ok);
});

test('P1: an exit needs a registered plan and a rule; reserved rule names are refused', async () => {
  const h = harness();
  await h.buy();
  await assert.rejects(h.desk.exit({ mint: MINT, rule: 'stop' }), (e: unknown) => e instanceof PaperDeskError && e.reason === 'no-exit-plan');
  assert.throws(() => h.desk.registerExitPlan({ mint: 'So11111111111111111111111111111111111111112xx', owner: 'm', positionId: 'p9', profileId: 'x' }), (e: unknown) => e instanceof PaperDeskError && e.reason === 'no-position');
  h.desk.registerExitPlan({ mint: MINT, owner: 'autotrade-monitor', positionId: 'p1', profileId: 'moonbag' });
  for (const rule of ['plan', 'done', '', ':::']) {
    await assert.rejects(h.desk.exit({ mint: MINT, rule }), (e: unknown) => e instanceof PaperDeskError && e.reason === 'bad-request');
  }
  assert.equal(exitRuleSlug('time_review:no-answer'), 'time-review-no-answer');
  assert.equal(exitRuleSlug('TP1'), 'tp1');
});

test('P1: an exit plan moves no money and a sell close by any path finishes the plan', async () => {
  const h = harness();
  await h.buy();
  const before = h.wallet.summary().balanceLamports;
  h.desk.registerExitPlan({ mint: MINT, owner: 'autotrade-monitor', positionId: 'p1', profileId: 'moonbag', restored: true });
  assert.equal(h.wallet.summary().balanceLamports, before);
  assert.equal((events(h.journal, 'agent.paper.exit.plan')[0].data as { restored?: boolean }).restored, true);
  await h.desk.close({ mint: MINT });
  assert.equal((events(h.journal, 'agent.paper.exit.done')[0].data as { by: string }).by, 'close');
});

test('P4: a note rides on the fill, sanitized (flat, capped, no nested documents)', async () => {
  const h = harness();
  await h.buy(5, { positionId: 'p1', profile: 'moonbag', reason: 'x'.repeat(500), nested: { signTx: true }, list: [1], 'bad key': 1, ok: true, n: 3 });
  const fill = events(h.journal, 'agent.paper.fill')[0].data as { note: Record<string, unknown> };
  assert.deepEqual(Object.keys(fill.note).sort(), ['n', 'ok', 'positionId', 'profile', 'reason']);
  assert.equal((fill.note.reason as string).length, 200);
  assert.equal(sanitizeFillNote('y'.repeat(900))!.length, 400);
  assert.equal(sanitizeFillNote({}), undefined);
  assert.equal(sanitizeFillNote([1, 2]), undefined);
  const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i]));
  assert.equal(Object.keys(sanitizeFillNote(many) as object).length, 16);
  // no note → the fill line is exactly as before (no note key)
  const h2 = harness();
  await h2.buy();
  assert.equal('note' in (events(h2.journal, 'agent.paper.fill')[0].data as object), false);
});

test('previewSell quotes a slice without booking anything', async () => {
  const h = harness();
  await h.buy();
  const pos = h.wallet.position(MINT)!;
  const q0 = h.calls.n;
  const p = await h.desk.previewSell({ mint: MINT, fraction: 0.5 });
  assert.equal(h.calls.n, q0 + 1);
  assert.ok(p.solOut > 0);
  assert.equal(h.wallet.position(MINT)!.tokensRaw, pos.tokensRaw);
  assert.equal(events(h.journal, 'agent.paper.fill').length, 1);
});
