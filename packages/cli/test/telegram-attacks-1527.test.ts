// task-1527 fix round: the independent verifier's pairing and token attack tests (verify-1527-1528,
// /tmp/verify-1527-1528/A/a1, a4), kept as regression tests. The cases that reproduced a bug now assert the fix:
//   A-B1  a bot-token holder swallowed the user's `/pair <code>` with a competing getUpdates poll and re-sent the
//         code from their own account; dexterm saw the 409 and paired them anyway. Now: a webhook (or an unanswered
//         getWebhookInfo) refuses before a code exists, a 409 at any point ends the window, and the account that
//         sent the code (@username + id) needs a local y/N before anything is saved.
//   A-F7  the redactor caught the token only in its plain form when the caller did not pass it: TelegramApiError
//         and the runner's chat audit now get the known token, and the URL-encoded / JSON-escaped / truncated
//         forms are caught too.
// Fake fetch and fake transports only: no network, no Telegram. Paper only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatAudit, MemoryStore, PAIR_MAX_TRIES, PairingWindow, TelegramConnector, loadConnectors, redact, secretStore, chatDir } from '@dexterm/autotrade';
import { telegramCommand, type TelegramDeps } from '../src/telegram-cmd.ts';
import { LIVE_APPROVALS_REFUSED, TelegramHost } from '../src/autotrade-cmd/telegram-host.ts';
import { FakeConnector, loadPreset, type Executor, type PortOrder, type RemoteButtonEvidence } from '@dexterm/autotrade';

const TOKEN = '7712345678:AAHk3X9vQ_pZr8T2mN4bW6yC1dE5fG7hJ0kL';
const SECRET = TOKEN.split(':')[1];
const leaks = (s: string) => s.includes(SECRET) || s.includes(SECRET.slice(0, 20)) || s.includes(encodeURIComponent(TOKEN));
const J = (x: unknown) => new Response(JSON.stringify(x), { headers: { 'content-type': 'application/json' } });

function cliIo() {
  const home = mkdtempSync(join(tmpdir(), 'tg1527-atk-'));
  const out: string[] = []; const err: string[] = [];
  let code = '';
  return {
    home, out, err, code: () => code,
    io: { stdout: { write: (s: string) => { out.push(s); const m = /\/pair (\d{6})/.exec(s); if (m) code = m[1]; } }, stderr: { write: (s: string) => err.push(s) }, env: { DEXTERM_HOME: home, PATH: process.env.PATH ?? '' } },
  };
}

// ───────────────────────────── A1: pairing ─────────────────────────────

test('1527 attack A1a: the lockout is per window: rotating senders and chats still gets 5 tries in total', () => {
  const w = new PairingWindow({ code: '123456' });
  const results: string[] = [];
  for (let i = 0; i < 20; i++) { const r = w.attempt(String(1000 + i), String(1000 + i), 'private', [String(i).padStart(6, '9')]); results.push(r.ok ? 'ok' : r.why); }
  assert.equal(results.filter((x) => x === 'wrong-code' || x === 'locked').length, 20);
  assert.equal(w.attempt('5', '5', 'private', ['123456']).ok, false, 'the right code after lockout fails');
  assert.equal(PAIR_MAX_TRIES, 5);
});

test('1527 attack A1b: group attempts and empty codes burn no tries; separators are tolerated; one-time use', () => {
  const w = new PairingWindow({ code: '123456' });
  for (let i = 0; i < 50; i++) w.attempt('9', '-100', 'group', ['000000']);
  for (let i = 0; i < 50; i++) w.attempt('9', '9', 'private', ['abc']);
  assert.equal(w.open, true);
  assert.equal(w.attempt('9', '9', 'private', ['1234567']).ok, false);
  assert.equal(w.attempt('1', '1', 'private', ['12-34-56']).ok, true);
  assert.deepEqual(w.attempt('2', '2', 'private', ['123456']), { ok: false, why: 'used' });
});

test('1527 attack A1c: expiry on the local clock; abort() closes the window for good', () => {
  let t = 0;
  const w = new PairingWindow({ code: '123456', now: () => t });
  t = 5 * 60_000;
  assert.deepEqual(w.attempt('1', '1', 'private', ['123456']), { ok: false, why: 'expired' });
  const w2 = new PairingWindow({ code: '123456' });
  assert.deepEqual(w2.abort(), { ok: false, why: 'conflict' });
  assert.deepEqual(w2.attempt('1', '1', 'private', ['123456']), { ok: false, why: 'used' });
});

/** A fake Bot API for `dexterm telegram pair`: getWebhookInfo, getUpdates by a script, sendMessage recorded. */
function botApi(o: { webhook?: string | 'error'; updates: (poll: number, code: string) => unknown }) {
  let polls = 0;
  const sends: Record<string, unknown>[] = [];
  let codeRef = () => '';
  const fetchFake = async (url: string, init?: RequestInit) => {
    const method = url.split('/').pop()!;
    const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
    if (method === 'getWebhookInfo') return o.webhook === 'error' ? J({ ok: false, error_code: 502, description: 'Bad Gateway' }) : J({ ok: true, result: { url: o.webhook ?? '' } });
    if (method === 'sendMessage') { sends.push(body); return J({ ok: true, result: { message_id: 77, chat: { id: body.chat_id, type: 'private' }, date: 0 } }); }
    if (method === 'getUpdates') {
      if (body.timeout === 0) return J({ ok: true, result: [] });
      polls++;
      const r = o.updates(polls, codeRef());
      if (r) return J(r);
      await new Promise((x) => setTimeout(x, 20));
      return J({ ok: true, result: [] });
    }
    return J({ ok: true, result: {} });
  };
  let conn: TelegramConnector | null = null;
  const deps = (more: Partial<TelegramDeps> = {}): TelegramDeps => ({
    store: new MemoryStore(TOKEN),
    connector: (token) => (conn = new TelegramConnector({ token, fetch: fetchFake as never, sleep: async () => {}, pollTimeoutSec: 1 })),
    pairTimeoutMs: 3000,
    ...more,
  });
  return { sends, deps, conn: () => conn, setCode: (f: () => string) => { codeRef = f; }, polls: () => polls };
}

const pairMsg = (id: number, from: number, code: string, username?: string) => ({ update_id: id, message: { message_id: 5, chat: { id: from, type: 'private' }, from: { id: from, is_bot: false, ...(username ? { username } : {}) }, date: Math.floor(Date.now() / 1000), text: `/pair ${code}` } });
const ATTACKER = 666000111;
const ME = 424242;

test('1527 attack A1d (A-B1): a token holder swallows the /pair message with a competing poll and re-sends the code: the 409 refuses the pairing', async () => {
  const x = cliIo();
  const api = botApi({ updates: (n, code) => (n === 1 ? { ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running' } : n === 2 ? { ok: true, result: [pairMsg(900, ATTACKER, code, 'evil')] } : null) });
  api.setCode(x.code);
  let asked = 0;
  const rc = await telegramCommand(['pair'], x.io, api.deps({ confirm: async () => { asked++; return true; } }));
  const cfg = loadConnectors(x.home);
  assert.equal(rc, 1);
  assert.ok(api.conn()!.health().conflict, 'the connector saw the other poller');
  assert.ok(cfg.ok && cfg.config.telegram.allow.length === 0, 'nobody was paired');
  assert.equal(asked, 0, 'not even asked: the window closed on the 409');
  assert.match(x.err.join(''), /NOT paired: another getUpdates poll[\s\S]*Revoke it in @BotFather/);
  assert.ok(!api.sends.some((s) => /Paired with dexterm/.test(String(s.text))), 'the attacker is never told "paired"');
});

test('1527 attack A1d2 (A-B1): a conflict that shows up while the y/N is open still refuses, even after a y', async () => {
  const x = cliIo();
  const api = botApi({ updates: (n, code) => (n === 1 ? { ok: true, result: [pairMsg(901, ATTACKER, code, 'evil')] } : null) });
  api.setCode(x.code);
  const realConnector = api.deps().connector!;
  let late = false;
  const rc = await telegramCommand(['pair'], x.io, api.deps({
    connector: (token) => { const c = realConnector(token) as TelegramConnector; const h = c.health.bind(c); c.health = () => ({ ...h(), conflict: late ? 'another getUpdates poll or a webhook holds this bot (409)' : h().conflict }); return c; },
    confirm: async () => { late = true; return true; },
  }));
  assert.equal(rc, 1);
  const cfg = loadConnectors(x.home);
  assert.ok(cfg.ok && cfg.config.telegram.allow.length === 0);
  assert.match(x.err.join(''), /NOT paired: another getUpdates poll/);
});

test('1527 attack A1e (A-B1): a webhook on the bot, or a getWebhookInfo that does not answer, refuses before any code is shown', async () => {
  for (const webhook of ['https://evil.example/hook', 'error'] as const) {
    const x = cliIo();
    const api = botApi({ webhook, updates: () => null });
    const rc = await telegramCommand(['pair'], x.io, api.deps({ confirm: async () => true }));
    assert.equal(rc, 1, webhook);
    assert.equal(x.code(), '', 'no code was shown');
    assert.equal(api.polls(), 0, 'no poll started');
    assert.match(x.err.join(''), webhook === 'error' ? /could not check the bot/ : /NOT pairing: a webhook is set/);
  }
});

test('1527 attack A1f (A-B1): the right code from an account the user does not recognise: the local y/N shows @username + id; N saves nothing', async () => {
  const x = cliIo();
  const api = botApi({ updates: (n, code) => (n === 1 ? { ok: true, result: [pairMsg(902, ATTACKER, code, 'evil')] } : null) });
  api.setCode(x.code);
  const asked: string[] = [];
  const rc = await telegramCommand(['pair'], x.io, api.deps({ confirm: async (q) => { asked.push(q); return false; } }));
  assert.equal(rc, 1);
  assert.equal(asked.length, 1);
  assert.match(asked[0], /^Is @evil \(id 666000111\) YOUR Telegram account\?/);
  assert.match(x.out.join(''), /The code came from @evil \(id 666000111\)/);
  const cfg = loadConnectors(x.home);
  assert.ok(cfg.ok && cfg.config.telegram.allow.length === 0);
  assert.ok(!api.sends.some((s) => /Paired with dexterm/.test(String(s.text))));
  assert.ok(api.sends.some((s) => /Code accepted\. Confirm this account on your computer/.test(String(s.text))));
});

test('1527 attack A1g (A-B1): the owner with y pairs; the default answer (a pipe with no y, or nothing) is no', async () => {
  const x = cliIo();
  const api = botApi({ updates: (n, code) => (n === 1 ? { ok: true, result: [pairMsg(903, ME, code, 'me_on_tg')] } : null) });
  api.setCode(x.code);
  assert.equal(await telegramCommand(['pair'], x.io, api.deps({ confirm: async () => true })), 0, x.err.join(''));
  const cfg = loadConnectors(x.home);
  assert.ok(cfg.ok);
  assert.deepEqual(cfg.config.telegram.allow.map((a) => a.senderId), [String(ME)]);
  assert.ok(api.sends.some((s) => /Paired with dexterm/.test(String(s.text)) && String(s.chat_id) === String(ME)));
  // No confirm seam and no terminal input: the question has no answer, so nothing is paired.
  const y = cliIo();
  const api2 = botApi({ updates: (n, code) => (n === 1 ? { ok: true, result: [pairMsg(904, ME, code, 'me_on_tg')] } : null) });
  api2.setCode(y.code);
  assert.equal(await telegramCommand(['pair'], y.io, api2.deps()), 1);
  const cfg2 = loadConnectors(y.home);
  assert.ok(cfg2.ok && cfg2.config.telegram.allow.length === 0);
});

// ───────────────────────────── A4: the token ─────────────────────────────

test('1527 attack A4a (A-F7): the redactor catches the plain, URL, URL-encoded, JSON-escaped, short-id and (with the known token) partial forms', () => {
  const cases: Record<string, string> = {
    url: `https://api.telegram.org/bot${TOKEN}/getUpdates`,
    urlenc: `https://x/?u=${encodeURIComponent(`https://api.telegram.org/bot${TOKEN}/getMe`)}`,
    bare: `token ${TOKEN} here`,
    json: JSON.stringify({ u: `bot${TOKEN}` }),
    jsonEscapedColon: `bot7712345678\\u003a${SECRET}`,
    shortId: `12345:${SECRET}`,
    dashEnd: 'bot7712345678:AAHk3X9vQ_pZr8T2mN4bW6yC1dE5fG7hJ0k-/x',
  };
  for (const [k, v] of Object.entries(cases)) {
    assert.ok(!leaks(redact(v)), `regex only: ${k}`);
    assert.ok(!leaks(redact(v, TOKEN)), `with the known token: ${k}`);
  }
  // Only the known token catches these: the secret alone, and a truncated echo after the bot id.
  assert.ok(!leaks(redact(`secret=${SECRET}`, TOKEN)));
  assert.ok(!redact(`…/bot7712345678:${SECRET.slice(0, 14)}`, TOKEN).includes(SECRET.slice(0, 14)), 'a truncated echo');
  assert.ok(!redact(`split ${SECRET.slice(0, 18)}\n${SECRET.slice(18)}`, TOKEN).includes(SECRET.slice(0, 18)), 'the first part of a split secret');
});

test('1527 attack A4b (A-F7): fetch errors with the URL (message + cause), a non-JSON body, and an API description echoing the URL-encoded token never leak', async () => {
  const logs: string[] = [];
  let n = 0;
  const fetchFake = async (url: string) => {
    n++;
    if (n === 1) { const e = new TypeError(`fetch failed for ${url}`); (e as Error & { cause?: unknown }).cause = new Error(`connect ECONNREFUSED ${url}`); throw e; }
    if (n === 2) return new Response(`<html>${url}</html>`, { status: 502 });
    return new Response(JSON.stringify({ ok: false, error_code: 400, description: `Bad Request: ${url} ${encodeURIComponent(url)}` }));
  };
  const c = new TelegramConnector({ token: () => TOKEN, fetch: fetchFake as never, onLog: (l) => logs.push(l), sleep: async () => {} });
  const errs: string[] = [];
  for (let i = 0; i < 3; i++) { try { await c.call('getMe'); } catch (e) { errs.push(`${(e as Error).name}: ${(e as Error).message} ${(e as Error).stack}`); } }
  await c.checkWebhook();
  const all = [...errs, ...logs, JSON.stringify(c.health())].join('\n');
  assert.equal(errs.length, 3);
  assert.ok(!leaks(all), 'token leaked in an error/log/health');
});

test('1527 attack A4c (A-F7): the chat audit with the known token strips a URL-encoded token and drops token keys', () => {
  const a = new ChatAudit(null, { knownToken: () => TOKEN });
  const e = a.add(1, 'hub_error', { error: `x ${encodeURIComponent(`bot${TOKEN}`)}`, nested: { token: TOKEN }, token: TOKEN });
  const s = JSON.stringify(e);
  assert.ok(!s.includes('"token":"7712'), 'top-level token key dropped');
  assert.ok(!leaks(s), s);
});

test('1527 attack A4d: setup with the file store: the token is only in secrets/telegram-bot.token (0600 in 0700); an argv token is refused', async () => {
  const home = mkdtempSync(join(tmpdir(), 'tg1527-tok-'));
  const out: string[] = []; const err: string[] = [];
  const io = { stdout: { write: (s: string) => out.push(s) }, stderr: { write: (s: string) => err.push(s) }, env: { DEXTERM_HOME: home, DEXTERM_SECRET_STORE: 'file', PATH: process.env.PATH ?? '' } };
  assert.equal(await telegramCommand(['setup', TOKEN], io, {}), 2);
  const conn = { transport: 'x', getMe: async () => ({ id: '7712345678', username: 'b' }), start: async () => {}, send: async () => ({ chatId: '1', messageId: '1' }), edit: async () => {}, onCommand() {}, onAction() {}, onText() {}, ackAction: async () => {}, health: () => ({ transport: 'x', lastPollAt: 0, conflict: null, rateLimited: 0, errors: 0, lastError: null }) };
  assert.equal(await telegramCommand(['setup', '--no-pair'], io, { readToken: async () => TOKEN, connector: () => conn }), 0);
  const files: string[] = [];
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else files.push(p); } };
  walk(home);
  const tf = join(home, 'secrets', 'telegram-bot.token');
  assert.deepEqual(files.filter((f) => readFileSync(f, 'utf8').includes(SECRET)), [tf]);
  assert.equal(statSync(tf).mode & 0o777, 0o600);
  assert.equal(statSync(join(home, 'secrets')).mode & 0o777, 0o700);
  assert.ok(!leaks(out.join('') + err.join('')));
  assert.equal(secretStore('file', home).get(), TOKEN);
  assert.ok(!readdirSync(home).includes('autotrade') || !readdirSync(chatDir(home)).some((f) => leaks(readFileSync(join(chatDir(home), f), 'utf8'))));
});

// ───────────────────────────── X1: merge with the live signer ─────────────────────────────

test('1527 X1: the Telegram host refuses every approval while the attached strategy is not paper (the live approval port is not installed)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'tg1527-x1-'));
  const exec: Executor = { name: 'spy', buy: () => ({ refused: 'never-called' }), sell: () => ({ refused: 'never-called' }) };
  const host = new TelegramHost({ home, exec, say: () => {}, timers: false }, new FakeConnector());
  const paper = loadPreset('scalp');
  const order = (s: typeof paper): PortOrder => ({ mint: 'M1nt1111111111111111111111111111', side: 'buy', usd: 10, slippageBps: 100, maxImpactPct: 2, strategyId: s.id, strategyVersion: s.version, strategyHash: s.hash, profileId: 'p', runId: 'r1', network: 'paper' });
  const ev: RemoteButtonEvidence = { tier: 'remote-button', transport: 'fake', proposalId: 'abc123', proposalHash: 'a'.repeat(64), senderId: '1', chatId: '1', updateId: '1', at: 0 } as RemoteButtonEvidence;
  host.attach('r1', paper, exec);
  assert.equal(host.port.entryBlock(), null);
  assert.equal((await host.port.confirmRemote(order(paper), ev)).ok, true, 'paper approvals work');
  const live = { ...structuredClone(paper), mode: 'live' } as typeof paper;
  host.attach('r2', live, exec);
  assert.equal(host.port.entryBlock(), LIVE_APPROVALS_REFUSED);
  const r = await host.port.confirmRemote(order(live), ev);
  assert.deepEqual(r, { ok: false, refused: LIVE_APPROVALS_REFUSED });
  await host.stop();
});
