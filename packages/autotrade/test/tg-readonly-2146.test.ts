// task-2146: security hardening of the read-only Telegram commands (/check /top /signals, task-1426). Fake transport
// only (no network, no keys): the per-chat data limit, what Telegram still makes tappable in plain text (bare
// domains, hashtags, cashtags), invisible characters and cut emoji, the answer cap, no key / path / machine name in
// any answer (errors included), the whole-answer time limit, and the module's imports (no write path to reach).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { firewall } from '@dexterm/mcp';
import { ME, T0, pairedConfig, rig } from './chat-helpers-1527.ts';
import type { InboundCommand } from '../src/chat/connector.ts';
import {
  HostReadPort, READS_PER_MIN, READ_REPLY_MAX_CHARS, READ_REPLY_MAX_LINES, ReadOnlyRouter, SignalLog, defuse, finalizeReply, localNames,
  type CoinCheckView, type ReadCall, type ReadOnlyPort,
} from '../src/chat/readonly.ts';
import type { LedgerEvent } from '../src/ledger.ts';

const CA = 'Mint1111111111111111111111111111111111111111';
const FAKE_HOST = 'build-box-7781';
const FAKE_USER = 'tester-account';
const SECRET_PATH = `/Users/${FAKE_USER}/.dexterm/secrets/telegram.key`;
const LEAKY = `ENOENT: open '${SECRET_PATH}' on ${FAKE_HOST}.local api_key=abcdef0123456789abcdef https://api.example.com/v1?token=sk-live-0123456789abcdef`;

const cmd = (text: string, o: Partial<InboundCommand> = {}): InboundCommand => {
  const [head, ...args] = text.split(/\s+/);
  return { transport: 'fake', updateId: String(Math.random()), chatId: ME, chatKind: 'private', senderId: ME, command: head.slice(1) as InboundCommand['command'], args, t: T0, ...o };
};

function view(over: Partial<CoinCheckView> = {}): CoinCheckView {
  return {
    mint: CA, at: T0, symbol: 'TEST', name: 'Test Coin',
    larp: { score: 20, band: 'low', hi: null, unread: 0, flags: [{ label: 'no website advertised', points: 9 }] }, larpError: null,
    market: { mcap: 1e6, liq: 5e4, holders: 10, tokenAgeSec: 60, fetchedAt: T0 }, audit: null, dataError: null, engine: null, ...over,
  };
}

const port = (o: Partial<ReadOnlyPort> = {}): ReadOnlyPort => ({
  check: async () => view(), top: async () => ({ source: 'test', at: T0, rows: [] }), signals: () => ({ at: T0, total: 0, rows: [] }), ...o,
});

test('2146 per-chat data limit: 5 reads a minute per chat, one notice then silence, usage answers free, /kill unaffected', async () => {
  let reads = 0;
  const p = port({ top: async () => { reads++; return { source: 'test', at: T0, rows: [] }; } });
  let killed = 0;
  const r = rig({ reads: p, controlPort: { status: () => null, positions: () => [], strategies: () => [], kill: () => { killed++; return { ok: true }; } } as never });
  for (let i = 0; i < READS_PER_MIN; i++) r.me.command('/top');
  r.me.command('/top nope'); // a usage answer reads nothing and does not count
  await r.hub.idle();
  assert.equal(reads, READS_PER_MIN);
  assert.equal(r.fake.sent.length, READS_PER_MIN + 1);
  r.me.command('/top');
  r.me.command('/signals');
  r.me.command(`/check ${CA}`);
  await r.hub.idle();
  assert.equal(reads, READS_PER_MIN, 'over the limit: nothing read');
  const told = r.fake.sent.filter((m) => /Too many data requests: up to 5 a minute in this chat/.test(m.text));
  assert.equal(told.length, 1, 'told once a minute, then silence');
  assert.equal(r.fake.sent.length, READS_PER_MIN + 2);
  assert.equal(r.audit.events.filter((e) => e.kind === 'rate_limited').length, 3, 'every limited read is audited');
  r.me.command('/kill');
  await r.hub.idle();
  assert.equal(killed, 1, '/kill is not held back by the data limit');
  r.clock.now += 61_000;
  r.me.command('/top');
  await r.hub.idle();
  assert.equal(reads, READS_PER_MIN + 1, 'a minute later it reads again');
});

test('2146 unknown or unbound chats get no reply and nothing is read, even with a valid CA', async () => {
  let reads = 0;
  const p = port({ check: async () => { reads++; return view(); }, top: async () => { reads++; return { source: 't', at: T0, rows: [] }; }, signals: () => { reads++; return { at: T0, total: 0, rows: [] }; } });
  const r = rig({ reads: p });
  const users = [r.fake.user('999'), r.fake.user(ME, '-1001', 'group'), r.fake.user(ME, '7777'), r.fake.user('999', ME)];
  for (const u of users) for (const c of [`/check ${CA}`, '/top 10', '/signals 20']) u.command(c);
  await r.hub.idle();
  assert.equal(r.fake.sent.length, 0);
  assert.equal(reads, 0);
  // A pairing with only the approve tier has no read tier either.
  const a = rig({ reads: p, config: pairedConfig({ tiers: ['approve'] }) });
  a.me.command('/top');
  await a.hub.idle();
  assert.equal(a.fake.sent.length, 0);
  assert.equal(reads, 0);
});

test('2146 hostile token text: bare domains, hashtags, cashtags, invisible and bidi characters, line breaks, cut emoji', async () => {
  const hostile = 'CLAIM\u00AD claim-now.xyz #airdrop $FREE t.me\u2060/x \u202Eevil\u202C\nline2 \u{E0041}\u061C \u3164';
  const out = (await new ReadOnlyRouter(port({ check: async () => view({ symbol: hostile, name: hostile.slice(7) }) }), () => T0, { hideNames: [] }).handle(cmd(`/check ${CA}`))).lines.join('\n');
  for (const bad of ['claim-now.xyz', 't.me', '#airdrop', '$FREE', '\u00AD', '\u2060', '\u202E', '\u{E0041}', '\u061C', '\u3164', '/x']) assert.ok(!out.includes(bad), `no ${JSON.stringify(bad)}`);
  assert.match(out, /claim-now․xyz/, 'the domain is shown with a one-dot leader');
  assert.match(out, /＃airdrop/);
  assert.match(out, /＄FREE/);
  assert.equal(out.split('\n').filter((l) => l.startsWith('line2')).length, 0, 'a line break in a name never starts a new line');
  // A name cut in the middle of an emoji never leaves half a surrogate pair (Telegram refuses such a message).
  const emoji = '😀'.repeat(40);
  const cut = (await new ReadOnlyRouter(port({ check: async () => view({ symbol: emoji, name: emoji }) }), () => T0, { hideNames: [] }).handle(cmd(`/check ${CA}`))).lines.join('\n');
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(cut), 'no lone surrogate');
  assert.doesNotThrow(() => encodeURIComponent(cut));
  // Numbers keep their dots; only a dot before letters is a link risk.
  assert.equal(defuse('v1.5 mcap 2.3M'), 'v1.5 mcap 2.3M');
});

test('2146 answer cap: an oversized answer is cut to one short message and says so', () => {
  const lines = Array.from({ length: 200 }, (_, i) => `row ${i} ${'x'.repeat(300)}`);
  const out = finalizeReply(lines, []);
  assert.ok(out.length <= READ_REPLY_MAX_LINES);
  assert.ok(out.join('\n').length <= READ_REPLY_MAX_CHARS, `${out.join('\n').length}`);
  assert.match(out.at(-1)!, /^\(cut: the answer was too long for one message\)$/);
  const one = finalizeReply(['y'.repeat(5000)], []);
  assert.ok(one[0].length <= 400 && one[0].endsWith('…'));
});

test('2146 no key, path or machine name in any answer: token text, source errors and unavailable lines', async () => {
  const keypair = `[${Array.from({ length: 64 }, (_, i) => i).join(',')}]`;
  const p = port({
    check: async () => view({ symbol: `${FAKE_HOST} ${SECRET_PATH}`, name: keypair, larp: null, larpError: LEAKY, market: null, dataError: LEAKY }),
    top: async () => ({ unavailable: `No ranking right now: ${LEAKY}` }),
    signals: () => { throw new Error(LEAKY); },
  });
  const router = new ReadOnlyRouter(p, () => T0, { hideNames: [FAKE_HOST, FAKE_USER] });
  const all: string[] = [];
  for (const c of [`/check ${CA}`, '/top', '/signals']) all.push(...(await router.handle(cmd(c, { chatId: c }))).lines);
  const txt = all.join('\n');
  for (const bad of [FAKE_HOST, FAKE_USER, '/Users', '.dexterm', 'telegram.key', 'abcdef0123456789abcdef', 'sk-live', 'token=', 'https://', '0,1,2,3']) {
    assert.ok(!txt.toLowerCase().includes(bad.toLowerCase()), `leaked ${bad}:\n${txt}`);
  }
  assert.match(txt, /Could not read the signals right now/, 'a thrown read says what could not be read');
  // The host side: an error from the tool layer is cleaned before it is quoted.
  const call: ReadCall = async () => { throw new Error(LEAKY); };
  const host = new HostReadPort({ call: () => call, state: () => null, signals: new SignalLog(), now: () => T0, timeoutMs: { token: 50, larp: 50, top: 50 } });
  const v = await host.check(CA) as CoinCheckView;
  assert.ok(!JSON.stringify(v).includes('/Users') && !JSON.stringify(v).includes('sk-live'), JSON.stringify(v));
  const t = await host.top(3) as { unavailable: string };
  assert.ok(!t.unavailable.includes('/Users') && !t.unavailable.includes('https://'), t.unavailable);
  // The default names are this computer's own (none shorter than 4 characters).
  assert.ok(localNames().every((n) => n.length >= 4));
});

test('2146 upstream timeout: a source that never answers gives a plain "could not read" line, and the chat can /check again', async () => {
  let n = 0;
  const p = port({ check: () => { n++; return new Promise(() => {}); }, top: () => new Promise(() => {}) });
  const router = new ReadOnlyRouter(p, () => T0, { hideNames: [], timeoutMs: 30 });
  assert.match((await router.handle(cmd(`/check ${CA}`))).lines[0], /^Could not read this coin right now \(this coin: no answer in 0 s\)\. Nothing was guessed/);
  assert.match((await router.handle(cmd('/top'))).lines[0], /^Could not read the ranking right now/);
  await router.handle(cmd(`/check ${CA}`));
  assert.equal(n, 2, 'the /check lock is released after a timeout');
  // Through HostReadPort: one hung source, the other facts still answer, each failure named.
  const hang: ReadCall = (tool) => (tool === 'get_token' ? new Promise(() => {}) : Promise.resolve({ score: 5, band: 'low', larp_score: { top: [] } }));
  const host = new HostReadPort({ call: () => hang, state: () => null, signals: new SignalLog(), now: () => T0, timeoutMs: { token: 20, larp: 20 } });
  const txt = (await new ReadOnlyRouter(host, () => T0, { hideNames: [] }).handle(cmd(`/check ${CA}`))).lines.join('\n');
  assert.match(txt, /LARP score 5\/100 \(low\)/);
  assert.match(txt, /risk: could not be read \(token data: no answer in 0 s\)/);
  assert.match(txt, /market: could not be read \(token data: no answer in 0 s\)/);
});

test('2146 /signals text from the ledger is engine text: paths and keys in a halt reason never reach chat', async () => {
  const log = new SignalLog();
  log.onLedger({ seq: 1, t: T0, kind: 'halt', reason: `stop file at ${SECRET_PATH}` } as LedgerEvent);
  log.onLedger({ seq: 2, t: T0, kind: 'candidate', mint: CA, symbol: firewall('x', 's', 'symbol'), matched: ['claim.xyz'] } as unknown as LedgerEvent);
  const host = new HostReadPort({ call: () => null, state: () => null, signals: log, now: () => T0 });
  const txt = (await new ReadOnlyRouter(host, () => T0, { hideNames: [FAKE_USER] }).handle(cmd('/signals'))).lines.join('\n');
  assert.ok(!txt.includes('/Users') && !txt.includes(FAKE_USER), txt);
  assert.match(txt, /\[path\]/);
  assert.ok(!txt.includes('claim.xyz'));
});

test('2146 no write path in the module: readonly.ts imports only types, the text helpers and node:os', () => {
  const src = readFileSync(new URL('../src/chat/readonly.ts', import.meta.url), 'utf8');
  const imports = [...src.matchAll(/^import\s+(type\s+)?[^;]*?from\s+'([^']+)';/gm)].map((m) => ({ typeOnly: !!m[1], from: m[2] }));
  const value = imports.filter((i) => !i.typeOnly).map((i) => i.from).sort();
  assert.deepEqual(value, ['./format.ts', 'node:os']);
  for (const word of ['ControlPort', 'ApprovalBroker', 'paper_confirm', 'signal arm', 'execute']) {
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join('\n');
    assert.ok(!code.includes(word), `no ${word} in code`);
  }
});
