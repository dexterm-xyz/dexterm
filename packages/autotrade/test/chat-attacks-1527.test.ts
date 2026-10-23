// task-1527 fix round: the independent verifier's attack tests (verify-1527-1528, /tmp/verify-1527-1528/A/a2, a3, a5,
// a6), kept as regression tests. The cases that reproduced a bug (EXPECTED-BUG) now assert the fix:
//   A-B2  /use: a strategy with bankroll.startUsd x10,000 (a field riskDelta had no rule for) was "equal"; now any
//         changed field without a rule, or a value a rule cannot compare, counts as LOOSER (fail closed).
//   A-F3  a PaperPort proof is bound to the order hash and the proposal id, and needs a 64-hex proposal hash.
//   A-F4  a forwarded or via-bot "/kill" from the paired user is never a command; commands need a private chat.
//   A-F6  notify text hides file paths, API-key-shaped strings, 0x/long hex and keypair arrays.
// The holds (replay, forgery, double tap, kill mid-confirm, Half, tiers, free text) stay as they were.
// Fake transports and fake fetch only: no network, no Telegram, no keys. Paper only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { riskDelta } from '@dexterm/mcp';
import * as H from './chat-helpers-1527.ts';
import { TelegramConnector } from '../src/chat/telegram.ts';
import { ChatHub } from '../src/chat/hub.ts';
import { ApprovalBroker, CallbackStore, decodeCallback, encodeCallback } from '../src/chat/approvals.ts';
import { ChatAudit, chatDir, verifyChatAudit } from '../src/chat/audit.ts';
import { HostControlPort, ConfigView, wireConfirms } from '../src/chat/service.ts';
import { CONNECTORS_SCHEMA, saveConnectors } from '../src/chat/config.ts';
import { NotifyBus } from '../src/chat/notify.ts';
import { inert } from '../src/chat/format.ts';
import { PaperPort, orderHash } from '../src/execution-port.ts';
import { loadPreset, presetPath, type ResolvedStrategy } from '../src/strategy.ts';
import { StrategyStore } from '../src/store.ts';
import { readControl } from '../src/safety.ts';
import type { ControlPort } from '../src/chat/control.ts';
import { chainHash, fileLedger, newRunId, type LedgerEvent } from '../src/ledger.ts';
import type { RunnerState } from '../src/runner.ts';

// ───────────────────────────── A2: only the paired sender, in the paired private chat ─────────────────────────────

const ME_N = 424242;
function senderRig() {
  const sent: { method: string; body: Record<string, unknown> }[] = [];
  let mid = 100;
  const fetchFake = async (url: string, init?: RequestInit) => {
    const method = url.split('/').pop()!;
    const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
    sent.push({ method, body });
    return new Response(JSON.stringify({ ok: true, result: method === 'sendMessage' ? { message_id: ++mid, chat: { id: Number(body.chat_id), type: 'private' }, date: 0 } : true }));
  };
  const conn = new TelegramConnector({ token: () => '7712345678:AAHk3X9vQ_pZr8T2mN4bW6yC1dE5fG7hJ0kL', fetch: fetchFake as never, sleep: async () => {} });
  const calls: string[] = [];
  const ok = (name: string) => () => { calls.push(name); return { ok: true, message: name }; };
  const cport: ControlPort = {
    status: () => ({ runId: 'r', state: 'running', haltReason: null, strategy: { id: 's', version: '1', hash: 'abcdef12' }, open: 1, candidates: 0, dayPnlPct: 0, spend: { todayUsd: 0, dayCapUsd: 5 }, allowance: null, approvals: 'off' }),
    positions: () => [], pause: ok('pause'), resume: ok('resume'), kill: ok('kill'), flatten: ok('flatten'),
    strategies: () => [], use: ok('use'), approvalsOn: ok('approvalsOn'), sell: () => ({ ok: true, message: '' }),
  };
  const cfg = H.pairedConfig({ senderId: String(ME_N) });
  const audit = new ChatAudit(null);
  const store = new CallbackStore(':memory:');
  const port = new PaperPort(H.okExec, {});
  const broker = new ApprovalBroker({ connector: conn, store, audit, port, config: () => cfg, timers: false });
  const hub = new ChatHub({ connector: conn, config: () => cfg, audit, badge: 'PAPER', broker, port: cport });
  let uid = 1;
  const msg = (m: Record<string, unknown>) => conn.handle({ update_id: uid++, message: { message_id: uid, date: Math.floor(Date.now() / 1000), ...m } } as never);
  return { conn, hub, calls, sent, msg, audit, broker };
}

test('1527 attack A2a: another user, the paired user in a group / supergroup / another private chat: no reply, no action', async () => {
  const s = senderRig();
  s.msg({ chat: { id: 555, type: 'private' }, from: { id: 555 }, text: '/kill' });
  s.msg({ chat: { id: -100123, type: 'supergroup' }, from: { id: ME_N }, text: '/kill' });
  s.msg({ chat: { id: -424242, type: 'group' }, from: { id: ME_N }, text: '/flatten' });
  s.msg({ chat: { id: 424243, type: 'private' }, from: { id: ME_N }, text: '/pause' });
  await s.hub.idle();
  assert.deepEqual(s.calls, []);
  assert.equal(s.sent.filter((x) => x.method === 'sendMessage').length, 0);
});

test('1527 attack A2a2 (A-F4): a command from a non-private chat is refused even when its id equals the paired chat id', async () => {
  const s = senderRig();
  s.msg({ chat: { id: ME_N, type: 'channel' }, from: { id: ME_N }, text: '/pause' });
  await s.hub.idle();
  assert.deepEqual(s.calls, []);
  assert.ok(s.audit.events.some((e) => e.kind === 'in_unknown_sender' && String(e.what).endsWith(':group')));
});

test('1527 attack A2b: channel_post, edited_message, inline_query and an anonymous group admin are ignored', async () => {
  const s = senderRig();
  s.conn.handle({ update_id: 50, channel_post: { message_id: 1, chat: { id: ME_N, type: 'channel' }, date: 0, text: '/kill' } } as never);
  s.conn.handle({ update_id: 51, edited_message: { message_id: 1, chat: { id: ME_N, type: 'private' }, from: { id: ME_N }, date: 0, text: '/kill' } } as never);
  s.conn.handle({ update_id: 52, inline_query: { id: 'q', from: { id: ME_N }, query: '/kill' } } as never);
  s.msg({ chat: { id: -100999, type: 'supergroup' }, from: { id: 1087968824, is_bot: true }, sender_chat: { id: -100999, type: 'supergroup' }, text: '/kill' });
  await s.hub.idle();
  assert.deepEqual(s.calls, []);
});

test('1527 attack A2c (A-F4): a forwarded or via-bot "/pause" or "/kill" from the paired user is text, never a command', async () => {
  const s = senderRig();
  s.msg({ chat: { id: ME_N, type: 'private' }, from: { id: ME_N }, forward_origin: { type: 'user', sender_user: { id: 777 } }, forward_from: { id: 777 }, text: '/pause' });
  s.msg({ chat: { id: ME_N, type: 'private' }, from: { id: ME_N }, via_bot: { id: 999, is_bot: true }, text: '/kill' });
  s.msg({ chat: { id: ME_N, type: 'private' }, from: { id: ME_N }, forward_date: 1, text: '/flatten' });
  s.msg({ chat: { id: ME_N, type: 'private' }, from: { id: ME_N }, is_automatic_forward: true, text: '/kill' });
  await s.hub.idle();
  assert.deepEqual(s.calls, []);
  assert.equal(s.audit.events.filter((e) => e.kind === 'in_text').length, 4, 'each arrives as text (length + hash only)');
  assert.equal(s.audit.events.filter((e) => e.kind === 'in_command').length, 0);
});

test('1527 attack A2d: the paired user works; ids compared as strings (424242 == "424242")', async () => {
  const s = senderRig();
  s.msg({ chat: { id: ME_N, type: 'private' }, from: { id: ME_N }, text: '/pause' });
  await s.hub.idle();
  assert.deepEqual(s.calls, ['pause']);
});

test('1527 attack A2e: a tap from another user, from the paired user in a group, on another message, from a bot or inline is refused', async () => {
  const s = senderRig();
  const { live } = H.fakeLive();
  const out = s.broker.request(H.proposal(), live);
  await H.flush();
  const sm = s.sent.find((x) => x.method === 'sendMessage')!;
  const kb = (sm.body.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard[0];
  const approve = kb.find((b) => b.text === 'Approve')!.callback_data;
  const msgId = 101;
  s.conn.handle({ update_id: 200, callback_query: { id: 'c1', from: { id: 555 }, message: { message_id: msgId, chat: { id: ME_N, type: 'private' }, date: 0 }, data: approve } } as never);
  s.conn.handle({ update_id: 201, callback_query: { id: 'c2', from: { id: ME_N }, message: { message_id: msgId, chat: { id: -100, type: 'supergroup' }, date: 0 }, data: approve } } as never);
  s.conn.handle({ update_id: 202, callback_query: { id: 'c3', from: { id: ME_N }, message: { message_id: 999, chat: { id: ME_N, type: 'private' }, date: 0 }, data: approve } } as never);
  s.conn.handle({ update_id: 203, callback_query: { id: 'c4', from: { id: ME_N, is_bot: true }, message: { message_id: msgId, chat: { id: ME_N, type: 'private' }, date: 0 }, data: approve } } as never);
  s.conn.handle({ update_id: 204, callback_query: { id: 'c5', from: { id: ME_N }, inline_message_id: 'x', data: approve } } as never);
  await s.hub.idle();
  const verdicts = s.audit.events.filter((e) => e.kind === 'verify' || e.kind === 'in_unknown_sender').map((e) => `${e.kind}:${String(e.result ?? e.what)}`);
  // still open: the real user approves
  s.conn.handle({ update_id: 205, callback_query: { id: 'c6', from: { id: ME_N }, message: { message_id: msgId, chat: { id: ME_N, type: 'private' }, date: 0 }, data: approve } } as never);
  const o = await out;
  assert.equal(o.approved, true);
  assert.ok(!verdicts.some((v) => v.includes('nonce-consumed')));
});

// ───────────────────────────── A3: approve buttons ─────────────────────────────

async function open(r: ReturnType<typeof H.rig>, over: Partial<ReturnType<typeof H.proposal>> = {}) {
  const fl = H.fakeLive();
  const out = r.broker.request(H.proposal(over), fl.live);
  await H.flush();
  return { out, card: H.proposalCard(r.fake), ...fl };
}

test('1527 attack A3a: replay of a used callback, an expired one, a cross-proposal nonce, a tap after kill', async () => {
  const r = H.rig({ maxOpen: 5 });
  const a = await open(r, { mint: 'MintA111111111111111111111111111111111111111' });
  const b = await open(r, { mint: 'MintB111111111111111111111111111111111111111' });
  const da = decodeCallback(a.card.approve())!; const db = decodeCallback(b.card.approve())!;
  r.me.tap(a.card.ref, encodeCallback('p', da.id, db.nonce, 'A'));
  await r.hub.idle();
  assert.match(r.fake.toasts.at(-1)!.toast, /forged/);
  r.me.tap(a.card.ref, b.card.approve());
  await r.hub.idle();
  assert.match(r.fake.toasts.at(-1)!.toast, /another chat or message/);
  const dataA = a.card.approve();
  r.me.tap(a.card.ref, dataA);
  assert.equal((await a.out).approved, true);
  r.me.tap(a.card.ref, dataA);
  await r.hub.idle();
  assert.match(r.fake.toasts.at(-1)!.toast, /Already handled/);
  r.me.tap(a.card.ref, dataA.replace(/:A$/, ':H'));
  await r.hub.idle();
  assert.match(r.fake.toasts.at(-1)!.toast, /Already handled/);
  const dataB = b.card.approve();
  r.broker.cancelAll('kill');
  await H.flush();
  r.me.tap(b.card.ref, dataB);
  await r.hub.idle();
  assert.equal((await b.out).approved, false);
  assert.match(r.fake.toasts.at(-1)!.toast, /Already handled/);
  const c = await open(r, { mint: 'MintC111111111111111111111111111111111111111' });
  const dataC = c.card.approve();
  r.clock.now += 91_000;
  r.me.tap(c.card.ref, dataC);
  await r.hub.idle();
  assert.equal((await c.out).approved, false);
  assert.match(r.fake.toasts.at(-1)!.toast, /Expired/);
});

test('1527 attack A3b: two concurrent identical taps plus a Half make exactly one port confirm', async () => {
  const port = new PaperPort(H.okExec, {});
  let confirms = 0;
  const orig = port.confirmRemote.bind(port);
  port.confirmRemote = async (o, e) => { confirms++; await new Promise((x) => setTimeout(x, 10)); return orig(o, e); };
  const r = H.rig({ port });
  const a = await open(r);
  const d = a.card.approve();
  r.me.tap(a.card.ref, d); r.me.tap(a.card.ref, d); r.me.tap(a.card.ref, a.card.half());
  await r.hub.idle();
  const o = await a.out;
  assert.equal(confirms, 1);
  assert.equal(o.approved, true);
});

test('1527 attack A3c: a kill that lands while the port confirms: no approval reaches the runner', async () => {
  const port = new PaperPort(H.okExec, {});
  let release!: () => void;
  const orig = port.confirmRemote.bind(port);
  port.confirmRemote = async (o, e) => { await new Promise<void>((x) => { release = x; }); return orig(o, e); };
  const r = H.rig({ port });
  const a = await open(r);
  r.me.tap(a.card.ref, a.card.approve());
  await H.flush();
  r.broker.cancelAll('kill');
  await H.flush();
  release();
  await r.hub.idle();
  assert.equal((await a.out).approved, false);
});

test('1527 attack A3d: Half and Approve never exceed the shown size; a re-quote keeps it and kills the old nonce', async () => {
  const r = H.rig({ maxOpen: 5 });
  const a = await open(r, { usd: 20, firstTrancheUsd: 20 });
  a.st.cap = 1e9;
  r.me.tap(a.card.ref, a.card.half());
  const o = await a.out;
  assert.equal(o.approved && o.usd, 10);
  const b = await open(r, { mint: 'MintB111111111111111111111111111111111111111', usd: 20, firstTrancheUsd: 20 });
  b.st.tick = H.tick({ price: 1.05 });
  const oldB = b.card.approve();
  r.me.tap(b.card.ref, oldB);
  await r.hub.idle();
  const re = H.proposalCard(r.fake);
  assert.match(re.m.text, /re-quoted/);
  r.me.tap(b.card.ref, oldB);
  await r.hub.idle();
  assert.match(r.fake.toasts.at(-1)!.toast, /forged|Already/);
  r.me.tap(re.ref, re.approve());
  const ob = await b.out;
  assert.equal(ob.approved && ob.usd <= 20, true);
});

test('1527 attack A3e: malformed, lowercase and wrong-kind callback data leave the record OPEN', async () => {
  const r = H.rig();
  const a = await open(r);
  for (const b of a.card.m.buttons) assert.ok(Buffer.byteLength(b.data) <= 64);
  for (const d of [a.card.approve() + 'x', a.card.approve().replace(/:A$/, ':a'), a.card.approve().replace(/:A$/, ':B'), a.card.approve().replace(/^p:/, 'c:')]) r.me.tap(a.card.ref, d);
  await r.hub.idle();
  assert.equal(r.store.get(decodeCallback(a.card.approve())!.id)!.state, 'OPEN');
  r.broker.cancelAll('t'); await a.out;
});

test('1527 attack A3f: a tier removed mid-proposal is enforced', async () => {
  const r = H.rig();
  const a = await open(r);
  r.setConfig(H.pairedConfig({ tiers: ['notify', 'control'] }));
  r.me.tap(a.card.ref, a.card.approve());
  await r.hub.idle();
  assert.match(r.fake.toasts.at(-1)!.toast, /not paired for that/);
  r.broker.cancelAll('t'); await a.out;
});

test('1527 attack A3g (A-F3): a PaperPort proof is bound to its order hash and proposal id, and needs a 64-hex proposal hash', async () => {
  const port = new PaperPort(H.okExec, {});
  const order = { mint: H.MINT, side: 'buy' as const, usd: 20, slippageBps: 100, maxImpactPct: 1, strategyId: 's', strategyVersion: '1', strategyHash: 'h', profileId: 'scalp', runId: 'r', network: 'paper' as const };
  const ev = { tier: 'remote-button' as const, transport: 'x', proposalId: 'p', proposalHash: 'not-a-hash', senderId: '1', chatId: '1', updateId: '1', at: 0 };
  assert.deepEqual(await port.confirmRemote(order, ev), { ok: false, refused: 'evidence-malformed' }, 'the evidence hash is checked');
  const pr = await port.confirmRemote(order, { ...ev, proposalHash: 'b'.repeat(64) });
  assert.ok(pr.ok);
  assert.deepEqual(await port.buy(H.tick(), 20, { proofId: pr.proofId }), { refused: 'proof-order-mismatch' }, 'a bare proof id no longer spends');
  const pr2 = await port.confirmRemote(order, { ...ev, proposalHash: 'b'.repeat(64) });
  assert.ok(pr2.ok);
  assert.deepEqual(await port.buy(H.tick(), 20, { proofId: pr2.proofId, proposalId: 'other', orderHash: orderHash(order) }), { refused: 'proof-order-mismatch' }, 'another proposal');
  const pr3 = await port.confirmRemote(order, { ...ev, proposalHash: 'b'.repeat(64) });
  assert.ok(pr3.ok);
  assert.ok(!('refused' in await port.buy(H.tick(), 20, { proofId: pr3.proofId, proposalId: 'p', orderHash: orderHash(order) })));
});

// ───────────────────────────── A5: chat can never loosen ─────────────────────────────

function hostRig(cur: ResolvedStrategy, state: Partial<RunnerState> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'chat1527-ctl-'));
  const cfg = H.pairedConfig();
  saveConnectors(home, { schema: CONNECTORS_SCHEMA, telegram: cfg });
  const st = { state: 'running', haltReason: null, strategy: { id: cur.id, version: cur.version, hash: cur.hash }, positions: [], candidates: [], book: { startUsd: 1000, equityUsd: 1000, cashUsd: 1000, realizedTodayUsd: 0 }, spend: { todayUsd: 0, dayCapUsd: 5, allowance: null }, ...state };
  const switched: string[] = [];
  const r = H.rig({ config: cfg });
  const port = new HostControlPort({ home, runId: () => 'run-1', state: () => st as never, strategy: () => cur, config: new ConfigView(home), broker: () => r.broker, onSwitch: (s) => switched.push(s.id) });
  r.hub.setPort(port);
  wireConfirms(r.broker, port);
  return { home, r, port, st, switched };
}

/** A user strategy file: a copy of a preset with `edit` applied, validated through the store. */
function variant(home: string, from: string, id: string, edit: (doc: Record<string, unknown>) => void): ResolvedStrategy {
  const doc = JSON.parse(readFileSync(presetPath(from), 'utf8')) as Record<string, unknown>;
  doc.id = id; doc.name = id;
  edit(doc);
  const dir = new StrategyStore({ home }).dir;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(doc, null, 2));
  const g = new StrategyStore({ home }).get(id);
  assert.ok(g && g.ok, `validates: ${JSON.stringify(g && !g.ok && g.errors)}`);
  return g.strategy;
}

test('1527 attack A5a: /approvals off refused; /resume refused after /kill even with a stale paused snapshot', async () => {
  const x = hostRig(loadPreset('scalp'), { state: 'paused', haltReason: 'paused' });
  x.r.me.command('/approvals off');
  x.r.me.command('/kill');
  x.r.me.command('/resume');
  await x.r.hub.idle();
  assert.equal((readControl(x.home) as { action: string }).action, 'stop');
});

test('1527 attack A5b: no preset is equal-or-tighter than another (every pair has a looser reason)', () => {
  const ids = ['scalp', 'swing', 'runner', 'moonbag', 'sample-dip-ladder'];
  for (const a of ids) for (const b of ids) {
    if (a === b) continue;
    assert.ok(riskDelta(loadPreset(a), loadPreset(b)).reasons.some((r) => r.dir === 'looser'), `${a} -> ${b}`);
  }
});

test('1527 attack A5c (A-B2): /use cannot switch to a copy with bankroll.startUsd x10,000; it is LOOSER, listed with the reason, and refused', async () => {
  const cur = loadPreset('scalp');
  const x = hostRig(cur);
  const big = variant(x.home, 'scalp', 'scalp-big', (doc) => { const b = (doc.bankroll ?? {}) as { startUsd?: number }; doc.bankroll = { ...b, startUsd: (b.startUsd ?? 1000) * 10_000 }; });
  const d = riskDelta(cur, big);
  assert.equal(d.delta, 'looser');
  assert.ok(d.reasons.some((r) => r.path === '/bankroll/startUsd' && r.dir === 'looser'));
  x.r.me.command('/strategies');
  x.r.me.command('/use scalp-big');
  await x.r.hub.idle();
  assert.match(x.r.fake.last(/STRATEGIES/)!.text, /· scalp-big .*looser: ∕bankroll∕startUsd/, 'the reason names the field (a JSON pointer is not hidden as a path)');
  assert.equal(x.r.fake.last(/SWITCH/), undefined, 'no switch confirm is offered');
  assert.match(x.r.fake.last(/Refused/)!.text, /not equal or tighter/);
  assert.deepEqual(x.switched, []);
  // the confirm path refuses too, even if a [Yes, switch] were forged for it
  assert.equal(x.port.use('scalp-big').ok, false);
});

test('1527 attack A5c2 (A-B2): bankroll.source, a sizing ladder, an unruled field and a non-comparable value all count as LOOSER', () => {
  const home = mkdtempSync(join(tmpdir(), 'chat1527-rd-'));
  const cur = loadPreset('scalp');
  const looserAt = (s: ResolvedStrategy): string[] => riskDelta(cur, s).reasons.filter((r) => r.dir === 'looser').map((r) => r.path);
  assert.ok(looserAt(variant(home, 'scalp', 'v-src', (doc) => { doc.bankroll = { ...(doc.bankroll as object), source: 'desk' }; })).includes('/bankroll/source'));
  const ladder = variant(home, 'scalp', 'v-ladder', (doc) => { doc.sizing = { ...(doc.sizing as object), ladder: [{ frac: 0.5, atPct: 0, withinMin: 30 }, { frac: 0.5, atPct: -80, withinMin: 600 }] }; });
  assert.ok(looserAt(ladder).includes('/sizing/ladder'), 'a ladder that appears (averaging down)');
  const deeper = variant(home, 'scalp', 'v-ladder2', (doc) => { doc.sizing = { ...(doc.sizing as object), ladder: [{ frac: 0.5, atPct: 0, withinMin: 30 }, { frac: 0.5, atPct: -90, withinMin: 600 }] }; });
  assert.ok(riskDelta(ladder, deeper).reasons.some((r) => r.path === '/sizing/ladder/1/atPct' && r.dir === 'looser'), 'any change inside a ladder');
  assert.ok(!riskDelta(ladder, cur).reasons.some((r) => r.dir === 'looser'), 'dropping the ladder is not looser');
  assert.ok(looserAt(variant(home, 'scalp', 'v-ttl', (doc) => { (doc.entry as { candidateTtlSec: number }).candidateTtlSec += 60; })).includes('/entry/candidateTtlSec'), 'a field with no rule fails closed');
  // a value a rule cannot compare (a resolved strategy is validated, so this is built in memory)
  const weird = structuredClone(cur);
  (weird.sizing as unknown as Record<string, unknown>).maxUsd = Number.NaN;
  assert.ok(looserAt(weird).includes('/sizing/maxUsd'), 'NaN fails closed');
  const gone = structuredClone(cur);
  (gone.risk as unknown as Record<string, unknown>).dailyLossHaltPct = null;
  assert.ok(looserAt(gone).includes('/risk/dailyLossHaltPct'), 'null fails closed');
  // prose stays neutral
  assert.equal(riskDelta(cur, { ...structuredClone(cur), name: 'renamed', description: 'new words' }).delta, 'neutral');
});

test('1527 attack A5c3 (A-B2): two triggers of one kind are compared fail-closed (a looser duplicate cannot hide behind a stricter one)', () => {
  const cur = loadPreset('scalp');
  const mom = cur.entry.triggers.find((t) => t.kind === 'momentum');
  assert.ok(mom, 'scalp has a momentum trigger');
  const dup = structuredClone(cur);
  // a weaker momentum trigger first, the original last: keyed by kind, only the last one would be compared
  dup.entry.triggers = [{ ...mom, m5MinPct: 0.1 }, ...cur.entry.triggers];
  const r = riskDelta(cur, dup);
  assert.equal(r.delta, 'looser');
  assert.ok(r.reasons.some((x) => x.path === '/entry/triggers' && x.dir === 'looser' && /two triggers of one kind/.test(x.note ?? '')));
  assert.equal(riskDelta(dup, structuredClone(dup)).delta, 'neutral', 'no change, no reason');
});

test('1527 attack A5d: free text and injection never trade or act', async () => {
  const x = hostRig(loadPreset('scalp'));
  const { live } = H.fakeLive();
  const out = x.r.broker.request(H.proposal(), live);
  await H.flush();
  const card = H.proposalCard(x.r.fake);
  for (const t of ['approve', 'Approve', 'yes', card.approve(), `/approve ${card.approve()}`, '/start approve', '/help@bot A']) x.r.me.command(t);
  await x.r.hub.idle();
  assert.equal(x.r.store.get(card.m.text.match(/#([A-Za-z0-9_-]{8})/)![1])!.state, 'OPEN');
  x.r.broker.cancelAll('t'); await out;
});

// ───────────────────────────── A6: what notify text may show ─────────────────────────────

const WALLET = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const PATH = '/Users/someone/.dexterm/autotrade/runs/run-1/ledger.jsonl';
const RPC = 'https://mainnet.helius-rpc.com/?api-key=0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0';

test('1527 attack A6a (A-F6): no wallet address, file path, API key or absolute book reaches chat from exit/halt/guard/stuck lines', async () => {
  const msgs: string[] = [];
  const cfg = H.pairedConfig();
  const bus = new NotifyBus({ badge: 'PAPER', config: () => cfg, now: () => H.T0, send: async (m) => { msgs.push(m.kind === 'card' ? m.caption : m.lines.join('\n')); } });
  bus.onState({ strategy: { id: 's', version: '1', hash: 'abcdef12' }, book: { startUsd: 12345, equityUsd: 12345.67, cashUsd: 9000, realizedTodayUsd: 10 }, positions: [], candidates: [], spend: { todayUsd: 0, dayCapUsd: 5, allowance: null }, state: 'running', haltReason: null } as never);
  const ev = (kind: string, x: Record<string, unknown>) => bus.onEvent({ seq: 1, t: H.T0, kind, ...x } as unknown as LedgerEvent);
  ev('candidate', { mint: H.MINT, symbol: `${WALLET} ${PATH}`, matched: [RPC] });
  ev('reply', { mint: H.MINT, decision: { ok: true, decision: { reason: `send to ${WALLET} see ${PATH} ${RPC} /kill @admin` } } });
  ev('fill', { mint: H.MINT, side: 'buy', usd: 50, price: 1, profile: 'scalp' });
  ev('fill', { mint: H.MINT, side: 'sell', usd: 50, price: 1, reason: 'stop', detail: `EACCES: open '${PATH}' ${RPC}` });
  ev('halt', { reason: `rpc ${RPC} at ~/.dexterm/secrets/telegram-bot.token` });
  ev('guard', { state: 'x', effect: `wallet ${WALLET} balance 12.34 SOL at ${PATH}` });
  ev('stuck', { mint: H.MINT, why: `${RPC} 429 C:\\Users\\x\\key.json` });
  await bus.tick();
  const all = msgs.join('\n---\n');
  assert.ok(all.length > 0);
  assert.ok(!all.includes(WALLET), 'wallet address');
  assert.ok(!/Users.someone|\.dexterm|key\.json/.test(all), `file path: ${all}`);
  assert.ok(!all.includes('0b1c2d3e'), 'api key');
  assert.ok(!/12,?345|12\.3K/.test(all), 'absolute book');
  assert.match(all, /\[path\]/);
});

test('1527 attack A6b (A-F6): inert() hides paths, API-key-shaped strings, 0x hex and keypair arrays; plain words survive', () => {
  const cases: [string, RegExp][] = [
    [PATH, /\[path\]/], ['~/.dexterm/secrets/telegram-bot.token', /\[path\]/], ['C:\\Users\\x\\key.json', /\[path\]/], ['./keys/id.json', /\[path\]/],
    [RPC, /\[url\]/], ['sk-ant-api03-AAAABBBBCCCCDDDD', /\[key\]/], ['api_key=abc123def456', /api_key=\[key\]/], [`0x${'a'.repeat(64)}`, /\[hex\]/], ['b'.repeat(64), /\[hex\]/],
    [`[${'1,'.repeat(63)}1]`, /\[key\]/], ['0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0', /\[key\]/], ['7712345678:AAHk3X9vQ_pZr8T2mN4bW6yC1dE5fG7hJ0kL', /redacted/],
  ];
  for (const [s, want] of cases) assert.match(inert(s, 200), want, s.slice(0, 40));
  assert.equal(inert('BONK/SOL 1/2 dip, stop -10%', 80), "BONK∕SOL 1∕2 dip, stop -10%", 'a pair name, a fraction and a slash command stay text');
  assert.equal(inert('/kill @admin', 40), '∕kill ＠admin');
  assert.equal(inert('looser: /bankroll/startUsd, /sizing/ladder', 80), 'looser: ∕bankroll∕startUsd, ∕sizing∕ladder');
});

// ───────────────────────────── A7: the chat audit chain ─────────────────────────────

function audited(n = 6) {
  const home = mkdtempSync(join(tmpdir(), 'chat1527-aud-'));
  const a = new ChatAudit(home);
  for (let i = 0; i < n; i++) a.add(H.T0 + i, 'in_command', { i });
  const f = join(chatDir(home), readdirSync(chatDir(home))[0]);
  return { home, f, lines: readFileSync(f, 'utf8').split('\n').filter(Boolean) };
}

test('1527 attack A7: an edit, a deleted middle line and a reorder break the chain', () => {
  { const x = audited(); const l = [...x.lines]; l[2] = l[2].replace('"i":2', '"i":9'); writeFileSync(x.f, l.join('\n') + '\n'); assert.equal(verifyChatAudit(x.home)[0].check.ok, false); }
  { const x = audited(); const l = [...x.lines]; l.splice(2, 1); writeFileSync(x.f, l.join('\n') + '\n'); assert.equal(verifyChatAudit(x.home)[0].check.ok, false); }
  { const x = audited(); const l = [...x.lines]; [l[1], l[2]] = [l[2], l[1]]; writeFileSync(x.f, l.join('\n') + '\n'); assert.equal(verifyChatAudit(x.home)[0].check.ok, false); }
  { const x = audited(); rmSync(x.f); assert.equal(verifyChatAudit(x.home).length, 0); }
});

test('1527 attack A7b (A-F5): with a run-ledger anchor, tail truncation, a deleted day file and a full re-chain no longer verify', () => {
  const anchored = () => {
    const x = audited(6);
    const { ledger } = fileLedger(x.home, newRunId('scalp', H.T0, 'a1b2'));
    const e4 = JSON.parse(x.lines[3]) as { seq: number; hash: string };
    ledger.add(H.T0, 'chat_audit', { when: 'end', day: readdirSync(chatDir(x.home))[0].slice(0, 10), file: readdirSync(chatDir(x.home))[0], head: e4.hash, events: e4.seq });
    return x;
  };
  { const x = anchored(); assert.ok(verifyChatAudit(x.home).every((c) => c.check.ok), 'untouched verifies'); }
  { const x = anchored(); writeFileSync(x.f, x.lines.slice(0, 3).join('\n') + '\n'); assert.match(JSON.stringify(verifyChatAudit(x.home)[0].check), /truncated/); }
  { const x = anchored(); writeFileSync(x.f, x.lines.slice(0, 5).join('\n') + '\n'); assert.equal(verifyChatAudit(x.home)[0].check.ok, true, 'lines after the last anchor are not covered (documented)'); }
  { const x = anchored(); rmSync(x.f); const c = verifyChatAudit(x.home); assert.equal(c.length, 1); assert.match(JSON.stringify(c[0].check), /missing/); }
  {
    const x = anchored();
    const evs = x.lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    evs[1].i = 'forged';
    let prev = evs[0].hash as string;
    for (let i = 1; i < evs.length; i++) { const e = { ...evs[i] }; delete e.prev; delete e.hash; const h = chainHash(prev, e); evs[i] = { ...e, prev, hash: h }; prev = h; }
    writeFileSync(x.f, evs.map((e) => JSON.stringify(e)).join('\n') + '\n');
    assert.match(JSON.stringify(verifyChatAudit(x.home)[0].check), /rewritten/, 'a re-chained file no longer matches the anchor');
  }
});
