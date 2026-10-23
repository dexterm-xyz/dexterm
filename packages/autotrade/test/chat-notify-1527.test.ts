// task-1527 (AUTOTRADE-SPEC §8.2, §8.3, §8.4 tier 1, §8.6): the Telegram transport against a fake Bot API (no
// network), the redactor, 429 retry_after, webhook / 409 conflict detection, pairing by a local code, the notify
// bus (badge first, inert token text, digests, the daily summary, the PnL card), and the chat audit chain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ME, MINT, T0, flush, pairedConfig, proposal, fakeLive, rig, tmpHome } from './chat-helpers-1527.ts';
import { TelegramConnector, STALE_COMMAND_MS } from '../src/chat/telegram.ts';
import { redact, looksLikeBotToken } from '../src/chat/redact.ts';
import { inert } from '../src/chat/format.ts';
import { PairingWindow } from '../src/chat/pairing.ts';
import { ChatAudit, chatDir, verifyChatAudit } from '../src/chat/audit.ts';
import { NotifyBus } from '../src/chat/notify.ts';
import { loadConnectors, saveConnectors, connectorsPath, CONNECTORS_SCHEMA, defaultTelegram } from '../src/chat/config.ts';
import { MemoryStore, accountFor, secretStore } from '../src/chat/secrets.ts';
import type { OutMessage } from '../src/chat/connector.ts';
import type { RunnerState } from '../src/runner.ts';

const TOKEN = '7712345678:AAHk3X9vQ_pZr8T2mN4bW6yC1dE5fG7hJ0kL';

/** A fake Bot API: answers by method, records every request body (never a real network call). */
function fakeApi(handlers: Record<string, (body: Record<string, unknown>, n: number) => unknown>) {
  const calls: { method: string; url: string; body: Record<string, unknown> }[] = [];
  const count: Record<string, number> = {};
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = url.split('/').pop()!;
    const body = init?.body instanceof FormData ? Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : '<blob>'])) : JSON.parse(String(init?.body ?? '{}'));
    calls.push({ method, url, body });
    count[method] = (count[method] ?? 0) + 1;
    const h = handlers[method];
    const out = h ? h(body, count[method]) : { ok: true, result: true };
    if (out instanceof Error) throw out;
    return new Response(JSON.stringify(out), { status: (out as { error_code?: number }).error_code ?? 200 });
  };
  return { calls, fetch };
}

test('1527 redactor: a fetch error carrying the bot URL never reaches an error, the health line, the log or the audit', async () => {
  assert.ok(looksLikeBotToken(TOKEN));
  assert.equal(redact(`GET https://api.telegram.org/bot${TOKEN}/getUpdates failed`), 'GET https://api.telegram.org/bot<redacted>/getUpdates failed');
  assert.ok(!redact(`token ${TOKEN}`).includes(TOKEN));
  const logs: string[] = [];
  const api = fakeApi({ sendMessage: (_b) => new Error(`request to https://api.telegram.org/bot${TOKEN}/sendMessage failed, reason: ECONNRESET`), getWebhookInfo: () => ({ ok: true, result: { url: '' } }) });
  const c = new TelegramConnector({ token: () => TOKEN, fetch: api.fetch, onLog: (l) => logs.push(l), sleep: async () => {} });
  let err: Error | null = null;
  try { await c.send({ chatId: ME }, { kind: 'text', badge: 'PAPER', lines: ['x'] }); } catch (e) { err = e as Error; }
  assert.ok(err, 'the send failed');
  assert.ok(!String(err!.message).includes(TOKEN) && !String(err!.stack).includes(TOKEN), 'the thrown error is redacted');
  assert.match(err!.message, /bot<redacted>/);
  // The poll loop's own error path: health + log.
  const ac = new AbortController();
  const api2 = fakeApi({ getWebhookInfo: () => ({ ok: true, result: {} }), getUpdates: (_b, n) => { if (n > 1) ac.abort(); return new Error(`fetch failed: https://api.telegram.org/bot${TOKEN}/getUpdates`); } });
  const c2 = new TelegramConnector({ token: () => TOKEN, fetch: api2.fetch, onLog: (l) => logs.push(l), sleep: async () => {} });
  await c2.start(ac.signal);
  assert.ok(c2.health().errors >= 1);
  assert.ok(!JSON.stringify(c2.health()).includes(TOKEN));
  assert.ok(logs.length && logs.every((l) => !l.includes(TOKEN)), 'no log line carries the token');
  // The audit's last net: a field that somehow carries the token is stored redacted, and known secrets keys are dropped.
  const h = tmpHome();
  const a = new ChatAudit(h, { knownToken: () => TOKEN });
  a.add(T0, 'test', { error: `boom /bot${TOKEN}/x`, token: TOKEN, nonce: 'raw-nonce', note: TOKEN.split(':')[1] });
  const raw = readFileSync(join(chatDir(h), readdirSync(chatDir(h))[0]), 'utf8');
  assert.ok(!raw.includes(TOKEN) && !raw.includes(TOKEN.split(':')[1]) && !raw.includes('raw-nonce'));
  assert.ok(verifyChatAudit(h)[0].check.ok);
});

test('1527 transport: plain text (no parse_mode), link previews off, buttons as inline keyboard, the token only in the URL', async () => {
  const api = fakeApi({ sendMessage: () => ({ ok: true, result: { message_id: 7, chat: { id: 1, type: 'private' }, date: 0 } }), editMessageText: () => ({ ok: true, result: true }) });
  const c = new TelegramConnector({ token: () => TOKEN, fetch: api.fetch, sleep: async () => {} });
  const ref = await c.send({ chatId: ME }, { kind: 'proposal', badge: 'PAPER', lines: ['PROPOSAL', '<b>x</b> [y](https://e.x)'], buttons: [{ label: 'Approve', data: 'p:AAAAAAAA:BBBBBBBBBBBBBBBBBBBBBB:A' }], expiresAt: T0 });
  assert.deepEqual(ref, { chatId: ME, messageId: '7' });
  const b = api.calls[0].body;
  assert.equal(b.parse_mode, undefined, 'no markup mode, ever');
  assert.deepEqual(b.link_preview_options, { is_disabled: true });
  assert.equal(b.text, 'PAPER · PROPOSAL\n<b>x</b> [y](https://e.x)', 'sent as literal text');
  assert.deepEqual(b.reply_markup, { inline_keyboard: [[{ text: 'Approve', callback_data: 'p:AAAAAAAA:BBBBBBBBBBBBBBBBBBBBBB:A' }]] });
  assert.ok(!JSON.stringify(b).includes(TOKEN), 'the token is never in a body');
  await c.edit(ref, { kind: 'text', badge: 'PAPER', lines: ['done'] });
  assert.deepEqual(api.calls[1].body.reply_markup, { inline_keyboard: [] }, 'an edit removes the buttons');
});

test('1527 transport: a 429 honours retry_after; getUpdates long-polls with the offset; duplicates, bots and stale commands are dropped', async () => {
  const slept: number[] = [];
  let n = 0;
  const api = fakeApi({ sendMessage: () => (++n === 1 ? { ok: false, error_code: 429, description: 'Too Many Requests: retry after 7', parameters: { retry_after: 7 } } : { ok: true, result: { message_id: 1, chat: { id: 1, type: 'private' }, date: 0 } }) });
  const c = new TelegramConnector({ token: () => TOKEN, fetch: api.fetch, sleep: async (ms) => { slept.push(ms); } });
  await c.send({ chatId: ME }, { kind: 'text', badge: null, lines: ['hi'] });
  assert.ok(slept.includes(7000), 'waited retry_after seconds');
  assert.equal(c.health().rateLimited, 1);

  const now = T0;
  const ac = new AbortController();
  const date = Math.floor(now / 1000);
  const updates = [
    { update_id: 10, message: { message_id: 1, chat: { id: 424242, type: 'private' }, from: { id: 424242 }, date, text: '/status' } },
    { update_id: 10, message: { message_id: 1, chat: { id: 424242, type: 'private' }, from: { id: 424242 }, date, text: '/status' } },
    { update_id: 11, message: { message_id: 2, chat: { id: -100, type: 'supergroup' }, from: { id: 5, is_bot: true }, date, text: '/kill' } },
    { update_id: 12, message: { message_id: 3, chat: { id: 424242, type: 'private' }, from: { id: 424242 }, date: date - Math.ceil(STALE_COMMAND_MS / 1000) - 60, text: '/kill' } },
    { update_id: 13, callback_query: { id: 'cb1', from: { id: 424242 }, message: { message_id: 9, chat: { id: -100, type: 'group' }, date }, data: 'p:AAAAAAAA:BBBBBBBBBBBBBBBBBBBBBB:A' } },
    { update_id: 14, message: { message_id: 4, chat: { id: 424242, type: 'private' }, from: { id: 424242 }, date, text: 'buy everything now' } },
  ];
  const api2 = fakeApi({ getWebhookInfo: () => ({ ok: true, result: { url: '' } }), getUpdates: (_b, k) => { if (k === 1) return { ok: true, result: updates }; ac.abort(); return { ok: true, result: [] }; } });
  const c2 = new TelegramConnector({ token: () => TOKEN, fetch: api2.fetch, now: () => now, sleep: async () => {} });
  const cmds: string[] = []; const acts: string[] = []; const texts: number[] = [];
  c2.onCommand((x) => cmds.push(`${x.command}:${x.chatKind}`));
  c2.onAction((x) => acts.push(`${x.chatKind}:${x.data}`));
  c2.onText((x) => texts.push(x.length));
  await c2.start(ac.signal);
  assert.deepEqual(cmds, ['status:private'], 'one /status: the duplicate, the bot and the stale /kill were dropped');
  assert.deepEqual(acts, ['group:p:AAAAAAAA:BBBBBBBBBBBBBBBBBBBBBB:A'], 'a group tap arrives marked as a group (the broker refuses it)');
  assert.deepEqual(texts, ['buy everything now'.length], 'free text arrives as a length, never parsed');
  const polls = api2.calls.filter((x) => x.method === 'getUpdates');
  assert.equal(polls[0].body.timeout, 50);
  assert.deepEqual(polls[0].body.allowed_updates, ['message', 'callback_query']);
  assert.equal(polls[1].body.offset, 15, 'offset = last update_id + 1');
  assert.equal(c2.health().staleSkipped, 1);
});

test('1527 transport: a webhook on the token, or a 409 on getUpdates, is a conflict; the broker then refuses every approval', async () => {
  const ac = new AbortController();
  const api = fakeApi({ getWebhookInfo: () => ({ ok: true, result: { url: 'https://someone-else.example/hook' } }), getUpdates: () => { ac.abort(); return { ok: true, result: [] }; } });
  const c = new TelegramConnector({ token: () => TOKEN, fetch: api.fetch, sleep: async () => {} });
  await c.start(ac.signal);
  assert.match(c.health().conflict ?? '', /webhook/);
  const ac2 = new AbortController();
  const api2 = fakeApi({ getWebhookInfo: () => ({ ok: true, result: {} }), getUpdates: (_b, k) => { if (k > 1) ac2.abort(); return { ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request' }; } });
  const c2 = new TelegramConnector({ token: () => TOKEN, fetch: api2.fetch, sleep: async () => {} });
  await c2.start(ac2.signal);
  assert.match(c2.health().conflict ?? '', /409/);
  // The broker side: with a conflict, a proposal is never delivered and a tap is refused.
  const r = rig();
  const out = r.broker.request(proposal(), fakeLive().live);
  await flush();
  const card = r.fake.last(/PROPOSAL/)!;
  r.fake.conflict = 'a webhook is set';
  r.me.tap(card.ref, card.buttons[0].data);
  await r.hub.idle();
  assert.equal(r.fake.toasts.at(-1)!.toast, 'Approvals are stopped on this bot (a token conflict). Use dexterm locally.');
  r.broker.cancelAll('test');
  await out;
  const o = await r.broker.request(proposal(), fakeLive().live);
  assert.ok(!o.approved && o.state === 'UNDELIVERED');
});

test('1527 pairing: a wrong or expired code, a group chat and five wrong tries are refused; the right code pairs once', () => {
  let now = T0;
  const w = new PairingWindow({ now: () => now, code: '123456' });
  assert.deepEqual(w.attempt(ME, ME, 'private', ['654321']), { ok: false, why: 'wrong-code' });
  assert.deepEqual(w.attempt(ME, '-1', 'group', ['123456']), { ok: false, why: 'group-chat' });
  assert.deepEqual(w.attempt(ME, ME, 'private', []), { ok: false, why: 'no-code' });
  assert.deepEqual(w.attempt(ME, ME, 'private', ['123 456']), { ok: true, senderId: ME, chatId: ME });
  assert.deepEqual(w.attempt('2', '2', 'private', ['123456']), { ok: false, why: 'used' }, 'single use');
  const w2 = new PairingWindow({ now: () => now, code: '000001' });
  for (let i = 0; i < 4; i++) assert.equal((w2.attempt('9', '9', 'private', ['999999']) as { why: string }).why, 'wrong-code');
  assert.equal((w2.attempt('9', '9', 'private', ['999999']) as { why: string }).why, 'locked');
  assert.equal((w2.attempt(ME, ME, 'private', ['000001']) as { why: string }).why, 'locked', 'locked even for the right code');
  const w3 = new PairingWindow({ now: () => now, code: '111111' });
  now += 5 * 60_000;
  assert.equal((w3.attempt(ME, ME, 'private', ['111111']) as { why: string }).why, 'expired');
  assert.match(new PairingWindow().code, /^\d{6}$/);
});

test('1527 unknown sender: ignored (no reply, nothing happens); five in an hour raise a local "possible token leak" alert', async () => {
  const alerts: string[] = [];
  const r = rig();
  (r.hub as unknown as { o: { alert: (s: string) => void } }).o.alert = (s) => alerts.push(s);
  const stranger = r.fake.user('31337');
  for (const t of ['/status', '/kill', '/flatten', 'hello', '/pair 123456']) stranger.command(t);
  await r.hub.idle();
  assert.equal(r.fake.sent.length, 0, 'the bot replied to nobody');
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /possible bot token leak/);
});

test('1527 token-name injection renders as inert text; the absolute book is hidden; every message leads with its badge', async () => {
  const evil = '✅ APPROVE NOW /kill @phish https://evil.example <b>x</b>‮\u0007 So11111111111111111111111111111111111111112';
  const s = inert(evil, 200);
  assert.ok(!s.includes('/kill') && !s.includes('@phish') && !s.includes('https://') && !s.includes('‮') && !s.includes('\u0007') && !s.includes('So1111111111'));
  assert.ok(s.includes('[url]') && s.includes('[addr]'));
  const sent: OutMessage[] = [];
  const cfg = pairedConfig();
  const bus = new NotifyBus({ badge: 'PAPER', config: () => cfg, now: () => T0, send: async (m) => { sent.push(m); } });
  bus.onState(state({ equityUsd: 1000 }));
  bus.onEvent({ seq: 1, t: T0, kind: 'candidate', mint: MINT, symbol: evil, matched: ['m5>3'] });
  bus.onEvent({ seq: 2, t: T0, kind: 'reply', mint: MINT, decision: { ok: true, decision: { action: 'enter', reason: `${evil} buy` } } });
  bus.onEvent({ seq: 3, t: T0, kind: 'fill', mint: MINT, positionId: 'p1', side: 'buy', usd: 20, price: 0.00012, impactPct: 0.4, reason: 'entry', profile: 'scalp', tokens: 1 });
  await bus.flush();
  const entry = sent.find((m) => m.kind === 'text' && m.lines[0].startsWith('ENTRY'))!;
  assert.equal(entry.kind === 'text' && entry.badge, 'PAPER');
  const text = entry.kind === 'text' ? entry.lines.join('\n') : '';
  assert.ok(!text.includes('/kill') && !text.includes('https://') && !text.includes('@phish'));
  assert.match(text, /\$20\.00 \(2\.0% of book\)/);
  assert.ok(!/book \$1/.test(text), 'the absolute book is hidden by default');
});

function state(o: { equityUsd?: number; realizedTodayUsd?: number; todayUsd?: number; dayCapUsd?: number } = {}): RunnerState {
  return {
    t: T0, state: 'running', haltReason: null, strategy: { id: 'scalp', version: '1.0.0', hash: 'abcdef0123456789' },
    book: { startUsd: 1000, equityUsd: o.equityUsd ?? 1000, cashUsd: 1000, realizedTodayUsd: o.realizedTodayUsd ?? 0 },
    spend: { todayUsd: o.todayUsd ?? 0, dayCapUsd: o.dayCapUsd ?? 10, turnsToday: 0, candidateSessionsToday: 0, positionSessionsToday: 0, allowance: null },
    candidates: [], sessions: [], positions: [], ledgerTail: [], ledgerHead: '0', events: 0,
  };
}

test('1527 notify: candidates in a 15-minute digest; above 20 messages a minute it switches to digests; halts always go', async () => {
  let now = T0;
  const sent: { m: OutMessage; urgent: boolean }[] = [];
  const cfg = pairedConfig();
  const bus = new NotifyBus({ badge: 'PAPER', config: () => cfg, now: () => now, send: async (m, x) => { sent.push({ m, urgent: x.urgent }); } });
  bus.onState(state());
  for (let i = 0; i < 3; i++) bus.onEvent({ seq: i + 1, t: now, kind: 'candidate', mint: `M${i}11111111111111111111111111111111111111111`, symbol: `C${i}`, matched: ['x'] });
  await bus.tick();
  assert.equal(sent.length, 0, 'no message per candidate');
  now += 15 * 60_000;
  await bus.tick();
  const dg = sent.find((s) => s.m.kind === 'text' && s.m.lines[0].startsWith('CANDIDATES'))!;
  assert.ok(dg && dg.m.kind === 'text' && dg.m.lines.length === 4);
  sent.length = 0;
  now += 61_000; // a fresh minute (the digest above counted in the last one)
  for (let i = 0; i < 30; i++) bus.onEvent({ seq: 100 + i, t: now, kind: 'fill', mint: MINT, positionId: `p${i}`, side: 'sell', usd: 1, price: 1, reason: 'tp', tokens: 1 });
  bus.onEvent({ seq: 200, t: now, kind: 'halt', reason: 'daily-loss', openPositions: 2 });
  await bus.flush();
  assert.equal(sent.filter((s) => !s.urgent).length, 20, 'twenty a minute, then digests');
  const halt = sent.find((s) => s.m.kind === 'text' && s.m.lines[0].startsWith('HALT'))!;
  assert.ok(halt && halt.m.kind === 'text' && /daily loss limit/.test(halt.m.lines[1]), 'a halt says what clears it, and is never digested');
  now += 61_000;
  await bus.tick();
  assert.ok(sent.some((s) => s.m.kind === 'text' && /^DIGEST · 10 updates/.test(s.m.lines[0])), 'the held lines arrive as one digest');
});

test('1527 notify: a closed trade sends the PnL card image with one line; the daily summary goes once at its time', async () => {
  const d = new Date(T0); d.setHours(20, 59, 0, 0);
  let now = d.getTime();
  const sent: OutMessage[] = [];
  const cfg = pairedConfig();
  const cards: string[] = [];
  const bus = new NotifyBus({
    badge: 'PAPER', config: () => cfg, now: () => now, send: async (m) => { sent.push(m); },
    card: async (t) => { cards.push(`${t.id}:${t.fills!.length}`); return new Uint8Array([137, 80, 78, 71]); },
    approvalCounts: () => ({ FILLED: 2, SKIPPED: 1 }),
  });
  bus.onState(state({ equityUsd: 1012, realizedTodayUsd: 12, todayUsd: 9, dayCapUsd: 10 }));
  bus.onEvent({ seq: 1, t: now, kind: 'fill', mint: MINT, positionId: 'pos1', side: 'buy', usd: 20, price: 1, tokens: 20, reason: 'entry', profile: 'scalp' });
  bus.onEvent({ seq: 2, t: now, kind: 'fill', mint: MINT, positionId: 'pos1', side: 'sell', usd: 32, price: 1.6, tokens: 20, reason: 'tp' });
  bus.onEvent({ seq: 3, t: now, kind: 'trade_closed', trade: { id: 'pos1', mint: MINT, symbol: 'TEST', profileId: 'scalp', openedAt: now - 600_000, closedAt: now, costUsd: 20, proceedsUsd: 32, pnlUsd: 12, pnlPct: 60, exitReason: 'tp' } });
  await flush(); await bus.flush();
  assert.deepEqual(cards, ['pos1:2'], 'the card renderer got the position fills from the ledger');
  const card = sent.find((m) => m.kind === 'card')!;
  assert.ok(card && card.kind === 'card' && /^CLOSED · "TEST" .* \+60\.0% \(\+\$12\.00\) by tp/.test(card.caption));
  assert.ok(sent.some((m) => m.kind === 'text' && /^SPEND/.test(m.lines[0])), 'spend at 90 % of the day cap warns once');
  await bus.tick();
  assert.ok(!sent.some((m) => m.kind === 'text' && /^DAILY/.test(m.lines[0])));
  now += 60_000;
  await bus.tick(); await bus.tick();
  const daily = sent.filter((m) => m.kind === 'text' && /^DAILY SUMMARY/.test(m.lines[0]));
  assert.equal(daily.length, 1, 'once');
  const lines = daily[0].kind === 'text' ? daily[0].lines.join('\n') : '';
  assert.match(lines, /trades closed 1 \(1 won, 0 lost\) · day P\/L \+1\.2%/);
  assert.match(lines, /approvals: 2 filled, 1 skipped/);
});

test('1527 config + secrets: connectors.json never holds the token; the expiry is clamped to 60..120 s; stores are per home', () => {
  const h = tmpHome();
  const r0 = loadConnectors(h);
  assert.ok(r0.ok && !r0.exists && !r0.config.telegram.enabled);
  const c = { schema: CONNECTORS_SCHEMA, telegram: { ...defaultTelegram(), approvalExpirySec: 5 } } as const;
  saveConnectors(h, c as never);
  const r1 = loadConnectors(h);
  assert.ok(r1.ok && r1.config.telegram.approvalExpirySec === 60);
  writeFileSync(connectorsPath(h), JSON.stringify({ schema: CONNECTORS_SCHEMA, telegram: { approvalExpirySec: 999, approvals: 'yes', allow: [{ senderId: 'x' }, { senderId: '1', chatId: '1', tiers: ['approve', 'root'] }] } }));
  const r2 = loadConnectors(h);
  assert.ok(r2.ok);
  assert.equal(r2.config.telegram.approvalExpirySec, 120);
  assert.equal(r2.config.telegram.approvals, 'off', 'anything but "on" is off');
  assert.deepEqual(r2.config.telegram.allow.map((a) => a.tiers), [['approve']], 'bad entries and unknown tiers are dropped');
  writeFileSync(connectorsPath(h), '{oops');
  assert.ok(!loadConnectors(h).ok, 'a broken file is an error: the bot stays off');
  const fileStore = secretStore('file', h);
  fileStore.set(TOKEN);
  assert.equal(fileStore.get(), TOKEN);
  assert.ok(!readFileSync(connectorsPath(h), 'utf8').includes(TOKEN));
  fileStore.remove();
  assert.equal(fileStore.get(), null);
  assert.notEqual(accountFor('/tmp/a'), accountFor('/tmp/b'), 'a test home never touches the real keychain item');
  const m = new MemoryStore(); m.set('x'); assert.equal(m.get(), 'x');
});
