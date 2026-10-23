// task-1527 (AUTOTRADE-SPEC §8.4 tier 3, §8.5, §8.7): approve-to-trade on PAPER. Only a button callback approves,
// bound to a one-time nonce + the proposal hash + the local-clock expiry + the paired sender in its private chat.
// Every row of the failure-mode table, replay, forgery, double tap, late tap, a 3.1 % move, kill while open, restart,
// no free-text path to an order, and the compromised-model chat cases. Fake transport: no network, no keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { MINT, ME, T0, fakeLive, flush, okExec, pairedConfig, proposal, proposalCard, rig, tick, tmpHome } from './chat-helpers-1527.ts';
import { LivePortStub, PaperPort, orderHash, type RemoteButtonEvidence } from '../src/execution-port.ts';
import { CallbackStore, ApprovalBroker, decodeCallback, encodeCallback } from '../src/chat/approvals.ts';
import { ChatAudit, verifyChatAudit } from '../src/chat/audit.ts';
import { FakeConnector } from '../src/chat/fake.ts';
import { loadPreset } from '../src/strategy.ts';
import { runAutotrade, type ApprovalHook, type RunSessionFactory } from '../src/runner.ts';
import { parseDecision, type AgentSession } from '../src/session.ts';
import type { MarketTick } from '../src/replay.ts';

test('1527 approve: a tap on [Approve] approves exactly the shown size with a single-use port proof; the card loses its buttons', async () => {
  const r = rig();
  const { live } = fakeLive();
  const out = r.broker.request(proposal(), live);
  await flush();
  const card = proposalCard(r.fake);
  assert.deepEqual(card.m.buttons.map((b) => b.label), ['Approve', 'Half size', 'Skip']);
  for (const b of card.m.buttons) assert.ok(Buffer.byteLength(b.data) <= 64, 'callback_data fits Telegram');
  assert.match(card.m.text, /^PAPER · PROPOSAL/);
  r.me.tap(card.ref, card.approve());
  const o = await out;
  assert.ok(o.approved);
  assert.equal(o.usd, 20);
  assert.ok(o.proofId);
  assert.equal(card.m.buttons.length, 0, 'a resolved proposal has no buttons');
  assert.match(card.m.text, /APPROVED/);
  assert.equal(r.fake.toasts.at(-1)!.toast, 'Approved ($20.00).');
  // The proof rides with the order: once, for this order (hash + proposal id), this mint and at most this size.
  assert.match(String(o.orderHash), /^[0-9a-f]{32}$/);
  const port = r.port as PaperPort;
  const ctx = { proofId: o.proofId, proposalId: o.proposalId, orderHash: o.orderHash };
  const f = await port.buy(tick(), 20, ctx);
  assert.ok(!('refused' in f));
  const again = await port.buy(tick(), 20, ctx);
  assert.deepEqual(again, { refused: 'proof-unknown-or-spent' }, 'a proof is single use');
});

test('1527 approve: the evidence a tap hands the port has the live signer remote shape (64-hex hash, digit ids)', async () => {
  const port = new PaperPort(okExec, { now: () => T0 });
  const seen: RemoteButtonEvidence[] = [];
  const confirm = port.confirmRemote.bind(port);
  port.confirmRemote = (order, ev) => { seen.push(ev); return confirm(order, ev); };
  const r = rig({ port });
  const { live } = fakeLive();
  const out = r.broker.request(proposal(), live);
  await flush();
  const card = proposalCard(r.fake);
  r.me.tap(card.ref, card.approve());
  assert.ok((await out).approved);
  assert.equal(seen.length, 1);
  // The same checks as the signer's parseOrderParams (scratch-1528 live/service.ts) on `remote`.
  assert.match(seen[0]!.proposalHash, /^[0-9a-f]{64}$/);
  assert.match(seen[0]!.senderId, /^[0-9]{1,20}$/);
  assert.match(seen[0]!.updateId, /^[0-9]{1,20}$/);
  for (const b of card.m.buttons) assert.ok(Buffer.byteLength(b.data) <= 64);
});

test('1527 approve: a proof is bound to its order (order hash, proposal id, mint, size) and expires', async () => {
  let now = T0;
  const port = new PaperPort(okExec, { now: () => now });
  const order = { mint: MINT, side: 'buy' as const, usd: 10, slippageBps: 500, maxImpactPct: 3, strategyId: 'scalp', strategyVersion: '1.0.0', strategyHash: 'abc', profileId: 'scalp', runId: 'r', network: 'paper' as const };
  const ev = { tier: 'remote-button' as const, transport: 'fake', proposalId: 'p', proposalHash: 'a'.repeat(64), senderId: ME, chatId: ME, updateId: '1', at: now };
  const bound = { proposalId: 'p', orderHash: orderHash(order) };
  assert.deepEqual(await port.confirmRemote(order, { ...ev, proposalHash: 'h' }), { ok: false, refused: 'evidence-malformed' }, 'evidence without a 64-hex proposal hash');
  const p1 = await port.confirmRemote(order, ev);
  assert.ok(p1.ok);
  assert.deepEqual(await port.buy(tick(), 11, { proofId: p1.proofId, ...bound }), { refused: 'proof-order-mismatch' }, 'more than approved is refused');
  const p2 = await port.confirmRemote(order, ev);
  assert.ok(p2.ok);
  assert.deepEqual(await port.buy(tick({ mint: 'Other111111111111111111111111111111111111111' }), 10, { proofId: p2.proofId, ...bound }), { refused: 'proof-order-mismatch' }, 'another coin is refused');
  const p4 = await port.confirmRemote(order, ev);
  assert.ok(p4.ok);
  assert.deepEqual(await port.buy(tick(), 10, { proofId: p4.proofId, proposalId: 'p', orderHash: orderHash({ ...order, strategyHash: 'abd' }) }), { refused: 'proof-order-mismatch' }, 'a proof for another order is refused');
  const p5 = await port.confirmRemote(order, ev);
  assert.ok(p5.ok);
  assert.ok(!('refused' in await port.buy(tick(), 10, { proofId: p5.proofId, ...bound })), 'the bound order goes through');
  const p3 = await port.confirmRemote(order, ev);
  assert.ok(p3.ok);
  now += 31_000;
  assert.deepEqual(await port.buy(tick(), 10, { proofId: p3.proofId, ...bound }), { refused: 'proof-expired' });
  assert.deepEqual(await port.confirmRemote({ ...order, network: 'devnet' }, ev), { ok: false, refused: 'port-network-mismatch' });
  assert.notEqual(orderHash(order), orderHash({ ...order, strategyHash: 'abd' }), 'the strategy hash is covered by the order hash');
});

test('1527 approve: [Half size] only ever halves; [Skip] skips', async () => {
  const r = rig();
  const a = fakeLive();
  const out = r.broker.request(proposal({ usd: 30, firstTrancheUsd: 30 }), a.live);
  await flush();
  const c = proposalCard(r.fake);
  r.me.tap(c.ref, c.half());
  const o = await out;
  assert.ok(o.approved && o.usd === 15);
  assert.deepEqual(a.st.reclamps, [15]);
  const b = fakeLive();
  const out2 = r.broker.request(proposal(), b.live);
  await flush();
  const c2 = proposalCard(r.fake);
  r.me.tap(c2.ref, c2.skip());
  const o2 = await out2;
  assert.ok(!o2.approved && o2.state === 'SKIPPED');
  assert.equal(b.st.reclamps.length, 0, 'a skip never reaches the clamp or the port');
});

test('1527 replay: the same button twice, a double tap, a redelivered update and a second device all act once', async () => {
  const r = rig({ config: (() => { const c = pairedConfig(); c.allow.push({ senderId: ME, chatId: ME, tiers: ['approve'], pairedAt: T0 }); return c; })() });
  const { live } = fakeLive();
  const out = r.broker.request(proposal(), live);
  await flush();
  const c = proposalCard(r.fake);
  const data = c.approve();
  r.me.tap(c.ref, data);
  r.me.tap(c.ref, data); // double tap: a new update id, the same nonce
  r.fake.redeliver(); // the same update id again
  await r.hub.idle();
  const o = await out;
  assert.ok(o.approved);
  const toasts = r.fake.toasts.map((t) => t.toast);
  assert.equal(toasts.filter((t) => t.startsWith('Approved')).length, 1, 'approved exactly once');
  assert.ok(toasts.some((t) => /^Already (being )?handled\.$/.test(t)), 'the second tap was told it is handled');
  assert.ok(r.audit.events.some((e) => e.kind === 'in_duplicate'), 'the redelivered update was recorded and dropped');
  // The old data after the proposal ended: still refused (a replay hours later).
  r.clock.now += 3600_000;
  r.me.tap(c.ref, data);
  await r.hub.idle();
  assert.equal(r.fake.toasts.at(-1)!.toast, 'Already handled.');
});

test('1527 forged callbacks: random nonce, malformed data, an unknown id, the wrong kind of button: refused, nothing approved', async () => {
  const r = rig();
  const { live } = fakeLive();
  const out = r.broker.request(proposal(), live);
  await flush();
  const c = proposalCard(r.fake);
  const real = decodeCallback(c.approve())!;
  const forged = [
    encodeCallback('p', real.id, randomBytes(16).toString('base64url'), 'A'),
    `p:${real.id}:${real.nonce}:X`,
    encodeCallback('c', real.id, real.nonce, 'Y'),
    'p:AAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA:A',
    'approve',
    `${c.approve()}x`,
  ];
  for (const d of forged) r.me.tap(c.ref, d);
  await r.hub.idle();
  const results = r.audit.events.filter((e) => e.kind === 'verify').map((e) => String(e.result));
  assert.deepEqual(results, ['refused:nonce', 'refused:action', 'refused:action', 'refused:unknown-id', 'refused:malformed', 'refused:malformed']);
  // The real button still works afterwards (a forged tap never burns the nonce).
  r.me.tap(c.ref, c.approve());
  const o = await out;
  assert.ok(o.approved);
});

test('1527 sender and chat binding: unpaired sender, a group chat, a forwarded card, the right person in another chat', async () => {
  const cfg = pairedConfig();
  cfg.allow.push({ senderId: '999', chatId: '999', tiers: ['notify', 'control'], pairedAt: T0 }); // paired, but no approve tier
  const r = rig({ config: cfg });
  const { live } = fakeLive();
  const out = r.broker.request(proposal(), live);
  await flush();
  const c = proposalCard(r.fake);
  const stranger = r.fake.user('31337');
  stranger.tap(c.ref, c.approve());
  r.fake.user(ME, '-100200300', 'group').tap(c.ref, c.approve()); // the card forwarded to a group, tapped there
  r.fake.user('999').tap(c.ref, c.approve()); // paired for control only
  r.fake.user(ME, '555').tap({ chatId: '555', messageId: c.ref.messageId }, c.approve()); // right person, other private chat
  await r.hub.idle();
  const results = r.audit.events.filter((e) => e.kind === 'verify').map((e) => String(e.result));
  assert.deepEqual(results, ['refused:group-chat', 'refused:sender-not-allowed', 'refused:sender-not-allowed']);
  assert.ok(r.audit.events.some((e) => e.kind === 'in_unknown_sender' && e.senderId === '31337'), 'the stranger was dropped before verification');
  assert.equal(r.fake.sent.filter((m) => m.ref.chatId !== ME).length, 0, 'nobody else got a message');
  r.me.tap(c.ref, c.approve());
  assert.ok((await out).approved, 'the paired owner in the private chat still can');
});

test('1527 expiry on the local clock: no answer → EXPIRED (= skip, never auto-approve); a late tap is refused', async () => {
  const r = rig();
  const a = fakeLive();
  const out = r.broker.request(proposal(), a.live);
  await flush();
  const c = proposalCard(r.fake);
  r.clock.now += 90_000; // the default expiry
  r.me.tap(c.ref, c.approve()); // a slow network: the tap lands after it
  await r.hub.idle();
  const o = await out;
  assert.ok(!o.approved && o.state === 'EXPIRED');
  assert.equal(r.fake.toasts.at(-1)!.toast, 'Expired: nothing happened.');
  assert.equal(a.st.reclamps.length, 0);
  // sweep() expires without a tap.
  const b = fakeLive();
  const out2 = r.broker.request(proposal(), b.live);
  await flush();
  r.clock.now += 90_001;
  await r.broker.sweep();
  const o2 = await out2;
  assert.ok(!o2.approved && o2.state === 'EXPIRED');
  assert.match(r.fake.last()!.text, /EXPIRED/);
});

test('1527 re-quote: a 3.1 % move re-prices once (new numbers, new nonce, new expiry); the old button is dead; a second move expires', async () => {
  const r = rig();
  const a = fakeLive();
  const out = r.broker.request(proposal(), a.live);
  await flush();
  const c = proposalCard(r.fake);
  const old = c.approve();
  a.st.tick = tick({ price: 1.031 });
  r.me.tap(c.ref, old);
  await r.hub.idle();
  assert.equal(r.fake.toasts.at(-1)!.toast, 'The price moved: check the new numbers and tap again.');
  const c2 = proposalCard(r.fake);
  assert.match(c2.m.text, /re-quoted/);
  assert.match(c2.m.text, /@ 1\.031/);
  assert.notEqual(c2.approve(), old, 'a fresh nonce');
  r.me.tap(c.ref, old);
  await r.hub.idle();
  assert.equal(r.fake.toasts.at(-1)!.toast, 'Old or forged button: nothing happened.');
  r.me.tap(c2.ref, c2.approve());
  const o = await out;
  assert.ok(o.approved, 'the re-quoted proposal approves');
  // A second move after the re-quote: expired (skip).
  const b = fakeLive();
  const out2 = r.broker.request(proposal(), b.live);
  await flush();
  const d = proposalCard(r.fake);
  b.st.tick = tick({ price: 0.95 });
  r.me.tap(d.ref, d.approve());
  await r.hub.idle();
  const d2 = proposalCard(r.fake);
  b.st.tick = tick({ price: 0.9 });
  r.me.tap(d2.ref, d2.approve());
  const o2 = await out2;
  assert.ok(!o2.approved && o2.state === 'EXPIRED');
  // A 2.9 % move is inside the 3 % tolerance.
  const e = fakeLive();
  const out3 = r.broker.request(proposal(), e.live);
  await flush();
  const e1 = proposalCard(r.fake);
  e.st.tick = tick({ price: 1.029 });
  r.me.tap(e1.ref, e1.approve());
  assert.ok((await out3).approved);
});

test('1527 re-quote: liquidity down more than 10 %, or impact over the cap, re-prices too; the tolerance never exceeds the strategy slippage', async () => {
  const r = rig();
  const a = fakeLive();
  const out = r.broker.request(proposal(), a.live);
  await flush();
  const c = proposalCard(r.fake);
  a.st.tick = tick({ liq: 89_000 });
  r.me.tap(c.ref, c.approve());
  await r.hub.idle();
  assert.match(proposalCard(r.fake).m.text, /re-quoted/);
  r.broker.cancelAll('test');
  await out;
  const b = fakeLive();
  const out2 = r.broker.request(proposal({ usd: 2000, firstTrancheUsd: 2000, maxImpactPct: 3 }), b.live); // 2000 / 50 000 = 4 % impact
  await flush();
  const c2 = proposalCard(r.fake);
  r.me.tap(c2.ref, c2.approve());
  await r.hub.idle();
  assert.match(proposalCard(r.fake).m.text, /re-quoted/);
  r.broker.cancelAll('test');
  await out2;
  const e = fakeLive();
  const out3 = r.broker.request(proposal({ slippageBps: 100 }), e.live); // 1 % slippage: tolerance 1 %
  await flush();
  const c3 = proposalCard(r.fake);
  e.st.tick = tick({ price: 1.015 });
  r.me.tap(c3.ref, c3.approve());
  await r.hub.idle();
  assert.match(proposalCard(r.fake).m.text, /re-quoted/, '1.5 % is over a 1 % slippage');
  r.broker.cancelAll('test');
  await out3;
});

test('1527 re-clamp and the port: the book as it is now can shrink or refuse; a port that refuses (the live stub) refuses', async () => {
  const r = rig();
  const a = fakeLive();
  a.st.cap = 12;
  const out = r.broker.request(proposal(), a.live);
  await flush();
  let c = proposalCard(r.fake);
  r.me.tap(c.ref, c.approve());
  const o = await out;
  assert.ok(o.approved && o.usd === 12, 'shrunk by the re-clamp');
  const b = fakeLive();
  b.st.refuse = 'max-concurrent';
  const out2 = r.broker.request(proposal(), b.live);
  await flush();
  c = proposalCard(r.fake);
  r.me.tap(c.ref, c.approve());
  const o2 = await out2;
  assert.ok(!o2.approved && o2.state === 'REFUSED' && /max-concurrent/.test(o2.why));
  const s = rig({ port: new LivePortStub('devnet') });
  const e = fakeLive();
  const out3 = s.broker.request(proposal(), e.live);
  await flush();
  c = proposalCard(s.fake);
  assert.match(c.m.text, /^DEVNET · /, 'the badge is the port network');
  s.me.tap(c.ref, c.approve());
  const o3 = await out3;
  assert.ok(!o3.approved && o3.state === 'REFUSED' && /live-port-not-installed/.test(o3.why));
});

test('1527 kill, pause or halt while open: CANCELLED, buttons removed; a tap after it does nothing; blocked entries are refused at the tap', async () => {
  const r = rig();
  const a = fakeLive();
  const out = r.broker.request(proposal(), a.live);
  await flush();
  const c = proposalCard(r.fake);
  const data = c.approve();
  r.broker.cancelAll('kill-switch');
  const o = await out;
  assert.ok(!o.approved && o.state === 'CANCELLED');
  await flush();
  assert.equal(c.m.buttons.length, 0);
  r.me.tap(c.ref, data);
  await r.hub.idle();
  assert.equal(r.fake.toasts.at(-1)!.toast, 'Already handled.');
  const b = fakeLive();
  const out2 = r.broker.request(proposal(), b.live);
  await flush();
  const c2 = proposalCard(r.fake);
  b.st.blocked = 'paused:paused';
  r.me.tap(c2.ref, c2.approve());
  const o2 = await out2;
  assert.ok(!o2.approved && o2.state === 'CANCELLED');
});

test('1527 restart: open proposals are expired at start and never resurrected', async () => {
  const h = tmpHome();
  const path = `${h}/callbacks.db`;
  const fake = new FakeConnector({ now: () => T0 });
  const cfg = pairedConfig();
  const mk = () => new ApprovalBroker({ connector: fake, store: new CallbackStore(path), audit: new ChatAudit(h), port: new PaperPort(okExec), config: () => cfg, now: () => T0, timers: false });
  const b1 = mk();
  void b1.request(proposal(), fakeLive().live);
  await flush();
  const c = proposalCard(fake);
  const data = c.approve();
  // the process dies here; a new one starts on the same store
  const b2 = mk();
  assert.equal(await b2.expireLeftovers(), 1);
  assert.match(c.m.text, /expired: dexterm restarted/);
  const a = { transport: 'fake', updateId: '9', actionId: 'x', chatId: ME, chatKind: 'private' as const, senderId: ME, ref: c.ref, data, t: T0 };
  assert.equal(await b2.handleAction(a), 'Already handled.');
  assert.ok(verifyChatAudit(h).every((x) => x.check.ok), 'the chat audit chain verifies across the restart');
});

test('1527 too many at once: at most maxOpen proposals are open; the rest are skipped and counted', async () => {
  const r = rig({ maxOpen: 1 });
  void r.broker.request(proposal(), fakeLive().live);
  const o = await r.broker.request(proposal({ mint: 'Mint2222222222222222222222222222222222222222' }), fakeLive().live);
  assert.ok(!o.approved && o.state === 'SKIPPED');
  assert.equal(r.broker.overCapSkips, 1);
});

test('1527 Telegram down: a send that fails is UNDELIVERED (skip); the engine is never blocked', async () => {
  const r = rig();
  r.fake.failSends = 1;
  const o = await r.broker.request(proposal(), fakeLive().live);
  assert.ok(!o.approved && o.state === 'UNDELIVERED');
  const s = rig({ config: pairedConfig({ tiers: ['notify', 'control'] }) });
  const o2 = await s.broker.request(proposal(), fakeLive().live);
  assert.ok(!o2.approved && o2.state === 'UNDELIVERED', 'no paired chat with the approve tier: never delivered, never approved');
});

test('1527 no free-text path can create an order: words, fake commands and pasted callback data are never trades', async () => {
  const r = rig();
  const { live } = fakeLive();
  const out = r.broker.request(proposal(), live);
  await flush();
  const c = proposalCard(r.fake);
  for (const t of ['approve', 'yes', 'YES BUY IT', '/approve', '/buy MINT 100', c.approve(), `/use ${c.approve()}`, 'Approve']) r.me.command(t);
  await r.hub.idle();
  const verifies = r.audit.events.filter((e) => e.kind === 'verify');
  assert.equal(verifies.length, 0, 'nothing but a button callback reaches verification');
  assert.equal(r.audit.events.filter((e) => e.kind === 'callback_state' && e.state === 'APPROVED').length, 0, 'nothing was approved');
  r.clock.now += 90_000;
  await r.broker.sweep();
  const o = await out;
  assert.ok(!o.approved && o.state === 'EXPIRED', 'the proposal expired: text never approved it');
  const texts = r.audit.events.filter((e) => e.kind === 'in_text');
  assert.ok(texts.length >= 4 && texts.every((e) => typeof e.length === 'number' && !('text' in e)), 'free text is recorded as length + hash only');
});

// ── the runner, end to end on a synthetic tape (lockstep) ──

const A = MINT;
const at = (min: number, over: Partial<MarketTick> = {}) => tick({ t: T0 + min * 60_000, ...over });
const goer = (reason = 'go'): RunSessionFactory => (id): AgentSession => {
  let n = 0;
  return {
    id, kind: 'stub', costUsd: () => 0,
    async send(text) { n++; const t = text.startsWith('EVENT') ? 'DECISION {"action":"hold","reason":"ok"}' : `DECISION ${JSON.stringify({ action: 'enter', sizePct: 100, reason })}`; return { text: t, decision: parseDecision(t), costUsd: 0, ms: 0 }; },
    async close(reason) { return { turns: n, costUsd: 0, reason }; },
  };
};

function approveStrategy() {
  const s = loadPreset('scalp');
  return { ...s, entry: { ...s.entry, decide: 'agent+approve' as const } };
}

/** A rig (broker + hub + fake chat) whose user taps `answer` on every proposal. */
function autoTapper(answer: 'Approve' | 'Half size' | 'Skip' | null, o: Parameters<typeof rig>[0] = {}) {
  const r = rig(o);
  r.fake.send = ((orig) => async (to, msg) => {
    const ref = await orig(to, msg);
    if (msg.kind === 'proposal' && answer) {
      const b = msg.buttons.find((x) => x.label === answer)!;
      setImmediate(() => r.me.tap(ref, b.data));
    }
    return ref;
  })(r.fake.send.bind(r.fake));
  return r;
}

test('1527 runner: agent+approve turns the clamped entry into a proposal; [Approve] fills it through the port with its proof', async () => {
  const port = new PaperPort({ name: 'sim-in-test', buy: (k, usd, ctx) => okExec.buy(k, usd, ctx), sell: okExec.sell });
  const r = autoTapper('Approve', { port });
  const broker = r.broker;
  const before = okExec.buys.length;
  const res = await runAutotrade({ strategy: approveStrategy(), tape: { source: 'synthetic', ticks: [at(0), at(1), at(2), at(3)], mints: [A] }, sessions: goer(), approvals: broker, executor: port, runId: 'run-x' });
  const ev = res.ledger.events;
  const req = ev.find((e) => e.kind === 'approval_requested')!;
  const granted = ev.find((e) => e.kind === 'approval_granted')!;
  const fill = ev.find((e) => e.kind === 'fill' && e.side === 'buy')!;
  assert.ok(req && granted && fill, 'requested → granted → filled');
  assert.ok(req.seq < granted.seq && granted.seq < fill.seq);
  assert.equal(fill.proposalId, granted.proposalId, 'the fill names its proposal');
  const buy = okExec.buys.slice(before).at(-1)!;
  assert.ok(buy.proofId, 'the order carried its single-use proof to the executor');
  assert.ok(buy.usd <= Number(req.usd) + 1e-9, 'never more than the proposal showed');
  assert.ok(res.ledger.events.every((e) => !JSON.stringify(e).includes(String(buy.proofId))), 'the full proof id is not in the run ledger');
});

test('1527 runner: [Skip], no answer, and no approval channel all mean no order', async () => {
  for (const answer of ['Skip', null] as const) {
    const r = autoTapper(answer);
    if (answer === null) {
      // nobody answers: the proposal expires (the broker's sweep with a moved clock)
      const broker = r.broker;
      const hook: ApprovalHook = { required: (s) => broker.required(s), request: (p, l) => { const o = broker.request(p, l); setImmediate(async () => { r.clock.now += 120_000; await broker.sweep(); }); return o; }, cancelAll: (x) => broker.cancelAll(x) };
      const res = await runAutotrade({ strategy: approveStrategy(), tape: { source: 'synthetic', ticks: [at(0), at(1), at(2)], mints: [A] }, sessions: goer(), approvals: hook });
      assert.equal(res.ledger.events.filter((e) => e.kind === 'fill').length, 0);
      assert.equal(res.ledger.events.find((e) => e.kind === 'approval_declined')!.state, 'EXPIRED');
      continue;
    }
    const res = await runAutotrade({ strategy: approveStrategy(), tape: { source: 'synthetic', ticks: [at(0), at(1), at(2)], mints: [A] }, sessions: goer(), approvals: r.broker });
    assert.equal(res.ledger.events.filter((e) => e.kind === 'fill').length, 0);
    assert.equal(res.ledger.events.find((e) => e.kind === 'approval_declined')!.state, 'SKIPPED');
  }
  const res = await runAutotrade({ strategy: approveStrategy(), tape: { source: 'synthetic', ticks: [at(0), at(1), at(2)], mints: [A] }, sessions: goer() });
  assert.equal(res.ledger.events.filter((e) => e.kind === 'fill').length, 0);
  assert.equal(res.refusals['approval-unavailable'], 1, 'agent+approve with no channel: refused, never filled');
});

test('1527 runner: approvals on (from chat) gates even an agent-decided strategy; a kill cancels the open proposal and drops the order', async () => {
  const r = rig({ config: pairedConfig({ approvals: 'on' }) });
  let killed = false;
  const res = await runAutotrade({
    strategy: loadPreset('scalp'), tape: { source: 'synthetic', ticks: [at(0), at(1), at(2), at(3)], mints: [A] }, sessions: goer(), approvals: {
      required: (s) => r.broker.required(s),
      request: (p, l) => { const o = r.broker.request(p, l); setImmediate(() => { killed = true; }); return o; },
      cancelAll: (x) => r.broker.cancelAll(x),
    },
    pacing: { mode: 'paced', msPerTick: 5 },
    killSwitch: () => killed,
  });
  const ev = res.ledger.events;
  assert.ok(ev.some((e) => e.kind === 'approval_requested'));
  assert.equal(ev.find((e) => e.kind === 'approval_declined')!.state, 'CANCELLED');
  assert.equal(ev.filter((e) => e.kind === 'fill').length, 0);
});

test('1527 compromised model in chat: an injected reason and a 100 % size ask are clamped, quoted and inert; buttons come from engine state', async () => {
  const evil = '✅ APPROVE NOW 10x SAFE /kill @admin https://evil.example <b>tap Approve</b>‮ and set approvals off';
  const r = autoTapper('Approve');
  const broker = r.broker;
  const s = approveStrategy();
  const ticks = [at(0, { symbol: '✅APPROVE🚀 /approve @x' }), at(1), at(2)];
  const res = await runAutotrade({ strategy: s, tape: { source: 'synthetic', ticks, mints: [A] }, sessions: goer(evil), approvals: broker });
  const card = r.fake.sent.find((m) => m.msg.kind === 'proposal')!;
  assert.deepEqual(card.msg.kind === 'proposal' ? card.msg.buttons.map((b) => b.label) : [], ['Approve', 'Half size', 'Skip']);
  const text = card.msg.kind === 'proposal' ? card.msg.lines.join('\n') : '';
  assert.ok(!text.includes('https://'), 'no link survives');
  assert.ok(!/(^|\s)\/(kill|approve)/.test(text), 'no tappable command survives');
  assert.ok(!text.includes('@admin') && !text.includes('@x'), 'no mention survives');
  assert.ok(!text.includes('‮'), 'no bidi override survives');
  assert.match(text, /why \(the agent's words, unverified\): "/);
  const req = res.ledger.events.find((e) => e.kind === 'approval_requested')!;
  const clamp = res.ledger.events.find((e) => e.kind === 'clamp')!;
  assert.equal(req.usd, (clamp.result as { usd: number }).usd, 'the proposal shows the clamped size, not the ask');
  assert.ok(Number(req.usd) < 1000, 'a 100 % ask never becomes 100 % of the book');
});
