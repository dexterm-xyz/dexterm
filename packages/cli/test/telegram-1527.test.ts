// task-1527: `dexterm telegram setup|pair|status|approvals|revoke` and the bot inside `dexterm autotrade run --paper`.
// The token is read from a prompt (a test reader here), checked with getMe, kept in a secret store (memory here) and
// never written to connectors.json, stdout, stderr or the audit; pairing needs the code shown locally; an
// agent+approve strategy refuses to start without a paired chat, and with one every entry waits for a tap. Fake
// transport + temp $DEXTERM_HOME: no network, no Telegram, no keys, paper only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { telegramCommand } from '../src/telegram-cmd.ts';
import { runCmd } from '../src/autotrade-cmd/run.ts';
import { FakeConnector, MemoryStore, connectorsPath, loadConnectors, presetPath, readLedgerFile, saveConnectors, CONNECTORS_SCHEMA, defaultTelegram, chatDir, verifyChatAudit } from '@dexterm/autotrade';

const TOKEN = '7712345678:AAHk3X9vQ_pZr8T2mN4bW6yC1dE5fG7hJ0kL';
const ME = '424242';
const TAPE = fileURLToPath(new URL('../../autotrade/test/fixtures/autotrade-1498-tape.json', import.meta.url));

function io() {
  const home = mkdtempSync(join(tmpdir(), 'dexterm-tg-'));
  const out: string[] = []; const err: string[] = [];
  const listeners: ((s: string) => void)[] = [];
  return {
    home, out, err, onOut: (f: (s: string) => void) => listeners.push(f),
    io: { stdout: { write: (s: string) => { out.push(s); for (const f of listeners) f(s); } }, stderr: { write: (s: string) => err.push(s) }, env: { DEXTERM_HOME: home, DEXTERM_DB_PATH: join(home, 'none.db'), PATH: process.env.PATH ?? '' } },
  };
}

/** A fake connector that also answers getMe like the Bot API. */
function fakeBot() {
  const fake = new FakeConnector() as FakeConnector & { getMe: () => Promise<{ id: string; username: string }> };
  fake.getMe = async () => ({ id: '7712345678', username: 'my_test_bot' });
  return fake;
}

test('1527 telegram setup: the token is checked and kept in the secret store only; a token on the command line is refused; pairing needs the local code and a local y for the account shown', async () => {
  const x = io();
  const store = new MemoryStore();
  const bot = fakeBot();
  // The person sends /pair <code> once the code is on the screen (and a stranger tries a guess first).
  x.onOut((s) => {
    const m = /\/pair (\d{6})/.exec(s);
    if (m) setImmediate(() => { bot.user('31337').command('/pair 000000'); bot.user(ME, '-100', 'group').command(`/pair ${m[1]}`); bot.user(ME, ME, 'private', { username: 'me_on_tg', name: 'Me\u202e\u0007 Myself' }).command(`/pair ${m[1]}`); });
  });
  const refused = await telegramCommand(['setup', TOKEN], x.io, { store, connector: () => bot, readToken: async () => TOKEN });
  assert.equal(refused, 2);
  assert.match(x.err.join(''), /never pass the token as an argument/);
  const asked: string[] = [];
  const code = await telegramCommand(['setup'], x.io, { store, connector: () => bot, readToken: async () => TOKEN, pairTimeoutMs: 5000, confirm: async (q) => { asked.push(q); return true; } });
  assert.equal(code, 0, x.err.join(''));
  assert.equal(store.get(), TOKEN);
  const out = x.out.join('');
  assert.match(out, /bot @my_test_bot checked/);
  assert.equal(asked.length, 1, 'one local y/N');
  assert.match(asked[0], /^Is @me_on_tg \(id 424242, name "Me Myself"\) YOUR Telegram account\? It gets notify, control, approve\. \[y\/N\] $/, 'handle + id shown; the display name loses control and bidi characters');
  assert.match(out, /✓ paired: @me_on_tg \(id 424242/);
  assert.match(bot.sent.filter((m) => m.ref.chatId === ME).map((m) => m.text).join('\n'), /Code accepted[\s\S]*Paired with dexterm/, 'the chat hears "paired" only after the local y');
  const cfgRaw = readFileSync(connectorsPath(x.home), 'utf8');
  const cfg = loadConnectors(x.home);
  assert.ok(cfg.ok);
  assert.deepEqual(cfg.config.telegram.allow.map((a) => [a.senderId, a.chatId]), [[ME, ME]], 'only the owner in the private chat; the stranger and the group were refused');
  assert.equal(cfg.config.telegram.enabled, true);
  for (const blob of [cfgRaw, out, x.err.join(''), ...readdirSync(chatDir(x.home)).map((f) => readFileSync(join(chatDir(x.home), f), 'utf8'))]) {
    assert.ok(!blob.includes(TOKEN) && !blob.includes(TOKEN.split(':')[1]), 'the token appears nowhere');
  }
  assert.equal(bot.sent.filter((m) => m.ref.chatId !== ME).length, 1, 'the group got only the "pair privately" note');
  assert.match(bot.sent.find((m) => m.ref.chatId === '-100')!.text, /private chat/);

  x.out.length = 0;
  assert.equal(await telegramCommand(['status', '--json'], x.io, { store }), 0);
  const st = JSON.parse(x.out.join(''));
  assert.equal(st.tokenStored, true);
  assert.equal(st.bot, '@my_test_bot');
  assert.ok(!x.out.join('').includes(TOKEN));

  assert.equal(await telegramCommand(['approvals', 'on'], x.io, { store }), 0);
  assert.ok((loadConnectors(x.home) as { ok: true; config: { telegram: { approvals: string } } }).config.telegram.approvals === 'on');
  assert.equal(await telegramCommand(['revoke'], x.io, { store }), 0);
  assert.equal(store.get(), null);
  const after = loadConnectors(x.home);
  assert.ok(after.ok && after.config.telegram.allow.length === 0 && !after.config.telegram.enabled);
});

test('1527 telegram setup: a bad token is refused before anything is stored; a wrong pairing code times out unpaired', async () => {
  const x = io();
  const store = new MemoryStore();
  assert.equal(await telegramCommand(['setup', '--no-pair'], x.io, { store, connector: () => fakeBot(), readToken: async () => 'not-a-token' }), 2);
  assert.equal(store.get(), null);
  assert.equal(await telegramCommand(['setup', '--no-pair'], x.io, { store, connector: () => fakeBot(), readToken: async () => TOKEN }), 0);
  const bot = fakeBot();
  x.onOut((s) => { if (/\/pair \d{6}/.test(s)) setImmediate(() => bot.user(ME).command('/pair 999999')); });
  assert.equal(await telegramCommand(['pair'], x.io, { store, connector: () => bot, pairTimeoutMs: 300 }), 1);
  const c = loadConnectors(x.home);
  assert.ok(c.ok && c.config.telegram.allow.length === 0);
});

function pairedHome(x: ReturnType<typeof io>, approvals: 'on' | 'off' = 'off') {
  const t = defaultTelegram();
  t.enabled = true; t.secretStore = 'file'; t.bot = { id: '1', username: 'b' }; t.approvals = approvals;
  t.allow = [{ senderId: ME, chatId: ME, tiers: ['notify', 'control', 'approve'], pairedAt: 1 }];
  saveConnectors(x.home, { schema: CONNECTORS_SCHEMA, telegram: t });
}

function approveStrategyFile(x: ReturnType<typeof io>) {
  const doc = JSON.parse(readFileSync(presetPath('swing'), 'utf8'));
  const file = join(x.home, 'swing-approve.json');
  writeFileSync(file, JSON.stringify({ ...doc, id: 'swing-approve', entry: { ...doc.entry, decide: 'agent+approve' } }));
  return file;
}

test('1527 run: an agent+approve strategy refuses to start without a paired chat (no entry could ever be approved)', async () => {
  const x = io();
  const code = await runCmd([approveStrategyFile(x), '--paper', '--stub', '--replay', TAPE, '--ms-per-tick', '1', '--quiet'], x.io);
  assert.equal(code, 1);
  assert.match(x.err.join(''), /needs a one-tap approval for every entry/);
  assert.ok(!existsSync(join(x.home, 'autotrade', 'runs')) || readdirSync(join(x.home, 'autotrade', 'runs')).length === 0, 'no run started');
});

test('1527 run: with a paired bot, the run announces itself, entries become proposals, an [Approve] tap fills on paper; /status answers', async () => {
  const x = io();
  pairedHome(x);
  const bot = new FakeConnector();
  let taps = 0;
  bot.send = ((orig) => async (to, msg) => {
    const ref = await orig(to, msg);
    if (msg.kind === 'proposal' && msg.lines[0].startsWith('PROPOSAL')) { taps++; setImmediate(() => bot.user(ME).tap(ref, msg.buttons[0].data)); }
    if (msg.kind === 'text' && msg.lines[0].startsWith('RUNNER STARTED')) setImmediate(() => bot.user(ME).command('/status'));
    return ref;
  })(bot.send.bind(bot));
  const code = await runCmd([approveStrategyFile(x), '--paper', '--stub', '--replay', TAPE, '--ms-per-tick', '1'], x.io, { telegram: { connector: bot, timers: false } });
  assert.equal(code, 0, x.err.join(''));
  const texts = bot.sent.map((m) => m.text);
  assert.ok(texts.some((t) => /^PAPER · RUNNER STARTED · swing-approve/.test(t)));
  assert.ok(texts.some((t) => /^PAPER · STATUS · /.test(t)), '/status answered from the running engine');
  assert.match(x.out.join(''), /telegram: on \(your own bot, PAPER\) · approvals required by the strategy/);
  const dir = join(x.home, 'autotrade', 'runs');
  const ev = readLedgerFile(join(dir, readdirSync(dir).find((f) => f.endsWith('.jsonl') && !f.includes('stream'))!));
  const requested = ev.filter((e) => e.kind === 'approval_requested').length;
  const granted = ev.filter((e) => e.kind === 'approval_granted');
  const buys = ev.filter((e) => e.kind === 'fill' && e.side === 'buy' && e.reason === 'entry');
  assert.ok(requested >= 1 && taps >= 1, 'at least one entry became a proposal');
  assert.equal(buys.length, granted.length, 'every entry fill is an approved proposal');
  for (const b of buys) assert.ok(granted.some((g) => g.proposalId === b.proposalId), 'each fill names its proposal');
  assert.ok(texts.some((t) => /^PAPER · RUNNER ENDED/.test(t)), 'the end of the run was announced');
  assert.ok(bot.sent.every((m) => !m.text.includes(x.home)), 'no file path in any message');
  // A-F5: the run ledger anchors the chat audit at start and end; cutting the chat audit back past the end anchor
  // (or deleting the day file) no longer verifies.
  const anchors = ev.filter((e) => e.kind === 'chat_audit');
  assert.deepEqual(anchors.map((a) => a.when), ['start', 'end']);
  assert.ok(Number(anchors[1].events) > Number(anchors[0].events));
  assert.ok(verifyChatAudit(x.home).every((c) => c.check.ok), JSON.stringify(verifyChatAudit(x.home)));
  const dayFile = join(chatDir(x.home), String(anchors[1].file));
  const lines = readFileSync(dayFile, 'utf8').split('\n').filter(Boolean);
  writeFileSync(dayFile, `${lines.slice(0, Number(anchors[1].events) - 1).join('\n')}\n`);
  assert.match(JSON.stringify(verifyChatAudit(x.home)), /truncated: run .* anchored/);
  rmSync(dayFile);
  assert.match(JSON.stringify(verifyChatAudit(x.home)), /missing: run .* anchored/);
});

test('1527 PnL card: a closed paper trade renders through the app card renderer (PAPER stamp, PNG); no SOL quote means text only', async () => {
  const { autotradeCardPng } = await import('../src/autotrade-cmd/telegram-host.ts');
  const t = { id: 'p1', mint: 'Mint1111111111111111111111111111111111111111', symbol: 'TEST', profileId: 'scalp', openedAt: 1_792_000_000_000, closedAt: 1_792_000_600_000, costUsd: 20, proceedsUsd: 32, pnlUsd: 12, pnlPct: 60, exitReason: 'tp',
    fills: [{ t: 1_792_000_000_000, side: 'buy' as const, usd: 20, tokens: 20_000 }, { t: 1_792_000_600_000, side: 'sell' as const, usd: 32, tokens: 20_000 }] };
  const png = await autotradeCardPng(t, async () => 150);
  assert.ok(png && png.length > 1000);
  assert.deepEqual([...png!.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'a PNG');
  assert.equal(await autotradeCardPng(t, async () => null), null);
  assert.equal(await autotradeCardPng({ ...t, fills: [] }, async () => 150), null);
});
