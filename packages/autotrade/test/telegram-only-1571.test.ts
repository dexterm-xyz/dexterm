// task-1571 — 0.1.7 is Telegram-bot-only for live trading and dexterm holds no key. The Telegram connector is the
// user's OWN bot (notify / control / approve on PAPER). These tests drive the REAL TelegramConnector over a fake
// fetch (no network) and prove: every request goes to api.telegram.org for the configured token only, and only to
// the paired chat; a blocked bot (403) or a revoked token (401) fails CLOSED with a clear reason (no approval, no
// order) and the token never appears in an error, a log line or the chat audit; the only port is the paper port.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TelegramConnector, TELEGRAM_API } from '../src/chat/telegram.ts';
import { ApprovalBroker, CallbackStore } from '../src/chat/approvals.ts';
import { ChatAudit } from '../src/chat/audit.ts';
import { PaperPort } from '../src/execution-port.ts';
import { ME, T0, fakeLive, okExec, pairedConfig, proposal, tmpHome } from './chat-helpers-1527.ts';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const TOKEN = '7000000001:AAFakeTokenForTests_x9QxZ1571abcdefghijk';

type Answer = { status: number; body: unknown };
function fakeTelegram(answer: (method: string, body: Record<string, unknown>) => Answer) {
  const calls: { url: string; method: string; body: Record<string, unknown> }[] = [];
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = url.split('/').pop() ?? '';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
    calls.push({ url, method, body });
    const a = answer(method, body);
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, calls };
}

test('1571 a blocked bot (403 on sendMessage) fails CLOSED: the approval is UNDELIVERED with the reason, no paper order, no token anywhere', async () => {
  const home = tmpHome();
  try {
    const tg = fakeTelegram((m) => m === 'sendMessage'
      ? { status: 403, body: { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' } }
      : { status: 200, body: { ok: true, result: [] } });
    const logs: string[] = [];
    const connector = new TelegramConnector({ token: () => TOKEN, fetch: tg.fetch, now: () => T0, sleep: async () => {}, onLog: (l) => logs.push(l) });
    const audit = new ChatAudit(home);
    const port = new PaperPort(okExec, { now: () => T0 });
    const broker = new ApprovalBroker({ connector, store: new CallbackStore(':memory:'), audit, port, config: () => pairedConfig({ approvals: 'on' }), now: () => T0, maxOpen: 2, timers: false });
    const buysBefore = okExec.buys.length;
    const out = await broker.request(proposal(), fakeLive().live);
    assert.equal(out.approved, false);
    assert.equal(out.state, 'UNDELIVERED');
    assert.match(String(out.why), /the proposal could not be sent \(telegram 403: Forbidden: bot was blocked by the user\)/);
    assert.equal(okExec.buys.length, buysBefore, 'no order reached the executor');
    assert.equal(port.network, 'paper', 'the only port is the paper port');
    // exactly one Bot API call, to the configured bot, for the paired chat only
    assert.deepEqual(tg.calls.map((c) => c.method), ['sendMessage']);
    for (const c of tg.calls) {
      assert.equal(c.url, `${TELEGRAM_API}/bot${TOKEN}/${c.method}`);
      assert.equal(String(c.body.chat_id), ME);
    }
    const auditText = readdirSync(join(home)).flatMap((d) => { try { return readdirSync(join(home, d)).map((f) => readFileSync(join(home, d, f), 'utf8')); } catch { return []; } }).join('\n');
    for (const s of [String(out.why), ...logs, auditText]) assert.ok(!s.includes(TOKEN) && !s.includes('AAFakeToken'), `the token leaked: ${s.slice(0, 120)}`);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('1571 a revoked token (401 on getUpdates) is reported redacted in health and the log; the poll backs off and stops on abort', async () => {
  const tg = fakeTelegram((m) => m === 'getUpdates'
    ? { status: 401, body: { ok: false, error_code: 401, description: 'Unauthorized' } }
    : { status: 200, body: { ok: true, result: { url: '' } } });
  const logs: string[] = [];
  const ac = new AbortController();
  let sleeps = 0;
  const connector = new TelegramConnector({
    token: () => TOKEN, fetch: tg.fetch, now: () => T0, onLog: (l) => logs.push(l),
    sleep: async () => { if (++sleeps >= 2) ac.abort(); },
  });
  await connector.start(ac.signal);
  const h = connector.health();
  assert.ok(h.errors >= 1);
  assert.equal(h.lastError, 'telegram 401: Unauthorized');
  assert.ok(logs.some((l) => /error: telegram 401: Unauthorized/.test(l)), logs.join('\n'));
  for (const l of [...logs, String(h.lastError)]) assert.ok(!l.includes(TOKEN), 'no token in a log line');
  for (const c of tg.calls) assert.equal(c.url, `${TELEGRAM_API}/bot${TOKEN}/${c.method}`, 'only the configured bot is ever called');
  assert.ok(tg.calls.every((c) => ['getWebhookInfo', 'getUpdates'].includes(c.method)), 'nothing but the poll was called');
});

test('1571 no bot token: the connector refuses before any request, with the setup command in the message', async () => {
  const tg = fakeTelegram(() => ({ status: 200, body: { ok: true, result: {} } }));
  const connector = new TelegramConnector({ token: () => null, fetch: tg.fetch, now: () => T0 });
  await assert.rejects(connector.send({ chatId: ME }, { kind: 'text', badge: 'PAPER', lines: ['x'] }), /no bot token: run `dexterm telegram setup`/);
  assert.equal(tg.calls.length, 0);
});
