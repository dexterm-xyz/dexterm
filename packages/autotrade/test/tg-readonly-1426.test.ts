// task-1426: the read-only Telegram commands /check <CA>, /top [N] and /signals [N]. Through the fake transport only
// (no network, no keys): each command, the clamps, a bad CA, a hostile token name, an unbound chat, the rate limit,
// data that is not there, and the proof that none of them can reach a write (a ControlPort whose writes throw, a
// broker that counts confirms, a tool layer that only answers the read tools).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firewall } from '@dexterm/mcp';
import { ME, T0, flush, pairedConfig, rig, tmpHome } from './chat-helpers-1527.ts';
import type { ControlPort } from '../src/chat/control.ts';
import { parseCommand } from '../src/chat/connector.ts';
import { HELP_LINES } from '../src/chat/control.ts';
import { HostReadPort, READ_TOOLS, ReadOnlyRouter, SignalLog, readOnlyCall, untrustedText, type ReadCall, type ReadOnlyPort, type ReadTool } from '../src/chat/readonly.ts';
import { TelegramService, ConfigView } from '../src/chat/service.ts';
import { CallbackStore } from '../src/chat/approvals.ts';
import { ChatAudit } from '../src/chat/audit.ts';
import { saveConnectors, CONNECTORS_SCHEMA } from '../src/chat/config.ts';
import { PaperPort } from '../src/execution-port.ts';
import { okExec } from './chat-helpers-1527.ts';
import type { RunnerState } from '../src/runner.ts';
import type { LedgerEvent } from '../src/ledger.ts';

const CA = 'Mint1111111111111111111111111111111111111111'; // 44, base58
const CA2 = `Bonk${'2'.repeat(40)}`;
const CA3 = `Wif${'3'.repeat(40)}`;
const HOSTILE = '[click](http://x) @admin /kill';

/** What the tool layer says (the MCP tools' shapes, token text firewalled as they return it). */
function tools(o: { symbol?: string; name?: string; fail?: Partial<Record<ReadTool, string>>; rows?: number; hang?: ReadTool } = {}) {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const sym = (s: string) => firewall(s, 'jupiter:symbol', 'symbol', { keepAddresses: false });
  const call: ReadCall = async (tool, args) => {
    calls.push({ tool, args });
    if (o.hang === tool) return new Promise(() => {});
    if (o.fail?.[tool]) throw new Error(o.fail[tool]);
    if (tool === 'get_token') {
      return {
        token: { mint: args.mint, symbol: sym(o.symbol ?? 'TEST'), name: firewall(o.name ?? 'Test Coin', 'jupiter:name', 'name'), createdAt: T0 - 3 * 3600e3 },
        pair: { priceUsd: 0.001, mcap: 1.2e6, liquidityUsd: 85_000, fetchedAt: T0 - 45_000, ageSec: 45 },
        stats: { holderCount: 900, fetchedAt: T0 - 60_000 },
        audit: { mintAuthority: false, freezeAuthority: true, top10Pct: 42.1, devPct: 3, lpLockedPct: 100, rugScore: 12, fetchedAt: T0 - 120_000 },
        now: T0,
      };
    }
    if (tool === 'larp_check') {
      return {
        score: 34, band: 'medium',
        larp_score: { score: 34, band: 'medium', range: { lo: 34, hi: 52 }, missing: [{ id: 'x:*' }, { id: 'github:*' }, { id: 'domain:*' }], top: [{ label: 'no Telegram advertised', points: 12 }, { label: 'no X account advertised', points: 10 }, { label: 'no website advertised', points: 9 }], flags: [] },
      };
    }
    const n = Math.min(Number(args.limit), o.rows ?? 50);
    return { preset: 'trending', now: T0, rows: Array.from({ length: n }, (_, i) => ({ mint: i === 0 ? CA2 : i === 1 ? CA3 : `Coin${String(i).padStart(2, '9')}${'4'.repeat(38)}`.replace(/0/g, '5'), symbol: sym(i === 0 ? (o.symbol ?? 'BONK') : `C${i}`), mcap: 2e6 - i * 1e5, liquidityUsd: 90_000, volH1: 300_000, priceChange: { h1: 12 - i }, tokenAgeSec: 3600, fetchedAt: T0 - 30_000 })), errors: [] };
  };
  return { call, calls };
}

function state(over: Partial<RunnerState> = {}): RunnerState {
  return {
    t: T0, state: 'running', haltReason: null, strategy: { id: 'scalp', version: '1.0.0', hash: 'abcdef0123456789' },
    book: { startUsd: 1000, equityUsd: 1000, cashUsd: 980, realizedTodayUsd: 0 },
    spend: { todayUsd: 0, dayCapUsd: 10, turnsToday: 0, candidateSessionsToday: 0, positionSessionsToday: 0, allowance: null },
    candidates: [{ mint: CA3, symbol: 'WIF', ageSec: 30, matched: ['push'], session: null }], sessions: [],
    positions: [{ mint: CA2, symbol: 'BONK', profile: 'scalp', costUsd: 20, pnlUsd: 1, pnlPct: 5, next: null }], ledgerTail: [], ledgerHead: '0', events: 1, ...over,
  };
}

/** A ControlPort whose every write throws (and is counted): a read-only command must never reach one. */
function trapPort() {
  const writes: string[] = [];
  const trap = (name: string) => () => { writes.push(name); throw new Error(`write ${name} reached from a read-only command`); };
  const port: ControlPort = {
    status: () => null, positions: () => [], strategies: () => [],
    pause: trap('pause'), resume: trap('resume'), kill: trap('kill'), flatten: trap('flatten'), use: trap('use'), approvalsOn: trap('approvalsOn'), sell: trap('sell'),
  };
  return { port, writes };
}

function setup(o: { tools?: ReturnType<typeof tools> | null; st?: RunnerState | null; signals?: SignalLog } = {}) {
  const t = o.tools === undefined ? tools() : o.tools;
  const signals = o.signals ?? new SignalLog();
  let cur: RunnerState | null = o.st === undefined ? state() : o.st;
  const trap = trapPort();
  let r!: ReturnType<typeof rig>;
  const reads = new HostReadPort({ call: () => t?.call ?? null, state: () => cur, signals, now: () => r.clock.now, timeoutMs: { token: 200, larp: 200, top: 200 } });
  r = rig({ controlPort: trap.port, reads });
  const confirms: string[] = [];
  const orig = r.broker.confirm.bind(r.broker);
  r.broker.confirm = (async (...a: Parameters<typeof orig>) => { confirms.push(String(a[0])); return orig(...a); }) as typeof r.broker.confirm;
  const say = async (text: string) => { r.me.command(text); await r.hub.idle(); return r.fake.sent.at(-1)!.text; };
  return { r, t, signals, trap, confirms, say, setState: (s: RunnerState | null) => { cur = s; } };
}

test('1426 /check <CA>: the LARP score and the risk facts with their ages, the engine mark, "data, not advice"', async () => {
  const s = setup();
  const txt = await s.say(`/check ${CA}`);
  assert.match(txt, /^PAPER · CHECK "TEST" Mint…1111 · "Test Coin" · data, not advice/);
  assert.match(txt, /LARP score 34\/100 \(medium\) · up to 52 with 3 checks unread · checked 0s ago/);
  assert.match(txt, /· no Telegram advertised \(\+12\)/);
  assert.match(txt, /risk: mint authority revoked · freeze authority ON · top-10 holders 42\.1% · dev 3\.0% · LP locked 100\.0% · rug score 12 \(2m old\)/);
  assert.match(txt, /market: mcap \$1\.20M · liquidity \$85\.0K · 900 holders · coin age 3h \(45s old\)/);
  assert.match(txt, /evidence, not a verdict, and not a safety check\. Data, not advice\./);
  assert.ok(!txt.includes(CA), 'the full CA is never printed, only shortened');
  assert.deepEqual(s.t!.calls.map((c) => c.tool).sort(), ['get_token', 'larp_check']);
  // A coin the runner holds / has as a candidate says so.
  assert.match(await s.say(`/check ${CA2}`), /the runner holds this coin now/);
  assert.match(await s.say(`/check ${CA3}`), /a candidate of the runner now/);
});

test('1426 /check: a bad CA gets the usage line, never an echo, and no data call', async () => {
  const s = setup();
  const bad = ['/check', '/check abc', `/check ${'0OIl'.repeat(11)}`, `/check ${CA}X`, `/check ${'1'.repeat(31)}`, `/check ${CA} extra`, '/check [x](http://y)', '/check @admin', `/check ${CA.slice(0, 30)}/kill`];
  for (const b of bad) {
    const txt = await s.say(b);
    assert.match(txt, /^PAPER · Usage: \/check <CA> \(the coin's mint address: 32 to 44 base58 characters\)/, b);
    assert.ok(!/http|@admin|abc|extra|0OIl/.test(txt), `no echo: ${b}`);
  }
  assert.equal(s.t!.calls.length, 0);
  // parseCommand keeps a whole 44-character mint (and leaves a longer one too long to pass).
  assert.deepEqual(parseCommand(`/check ${CA}`)?.args, [CA]);
  assert.equal(parseCommand(`/check ${CA}${'1'.repeat(20)}`)?.args[0].length, 48);
});

test('1426 hostile token text: markdown, links, mentions and commands in a name or symbol stay inert plain text', async () => {
  const s = setup({ tools: tools({ symbol: HOSTILE, name: `@admin /kill ${CA} https://evil.example/x` }) });
  const sig = s.signals;
  sig.onLedger({ seq: 1, t: T0 - 5000, kind: 'candidate', mint: CA2, symbol: HOSTILE, matched: ['push'] } as LedgerEvent);
  for (const cmd of [`/check ${CA}`, '/top 3', '/signals']) {
    const txt = await s.say(cmd);
    assert.ok(!/https?:\/\//.test(txt), `${cmd}: no link survives`);
    assert.ok(!txt.includes('@admin'), `${cmd}: no tappable mention`);
    assert.ok(!txt.includes('/kill'), `${cmd}: no tappable command`);
    assert.ok(!txt.includes('](http'), `${cmd}: no markdown link`);
    assert.match(txt, /"\[click\]\(\[url\] ＠/, `${cmd}: shown as quoted text, the mention swapped for a look-alike`);
  }
  assert.match(s.r.fake.sent[0].text, /· "＠admin ∕kill \[addr\] \[url\]" ·/, 'the name: address and link replaced, mention and command inert');
  // Replies are plain text messages: no buttons, no markup kind.
  for (const m of s.r.fake.sent) { assert.equal(m.msg.kind, 'text'); assert.equal(m.buttons.length, 0); }
  // The tool layer's <untrusted> wrapper is taken off before inert() (no wrapper text in chat).
  assert.equal(untrustedText(firewall('A&B <x>', 'src', 'symbol')), 'A&B <x>');
  assert.ok(!s.r.fake.sent.some((m) => m.text.includes('untrusted')));
});

test('1426 /top [N]: the screener ranking, default 5, clamped 1..10, the runner\'s coins marked; bad args get the usage', async () => {
  const s = setup();
  let txt = await s.say('/top');
  assert.match(txt, /^PAPER · TOP 5 · the screener's trending list \(30s old\) · data, not advice/);
  assert.equal(txt.split('\n').filter((l) => /^\d+\. /.test(l)).length, 5);
  assert.match(txt, /^1\. "BONK" Bonk…2222 · mcap \$2\.00M · liq \$90\.0K · 1h vol \$300\.0K · 1h \+12\.0% · age 1h · HELD$/m);
  assert.match(txt, /^2\. "C1" Wif3…3333 .* · candidate$/m);
  assert.equal(s.t!.calls.at(-1)!.args.limit, 5);
  txt = await s.say('/top 0');
  assert.equal(txt.split('\n').filter((l) => /^\d+\. /.test(l)).length, 1);
  assert.equal(s.t!.calls.at(-1)!.args.limit, 1);
  txt = await s.say('/top 99');
  assert.equal(txt.split('\n').filter((l) => /^\d+\. /.test(l)).length, 10);
  assert.equal(s.t!.calls.at(-1)!.args.limit, 10);
  const before = s.t!.calls.length;
  for (const b of ['/top abc', '/top 3 4', '/top -1', '/top 2.5', '/top 1e3']) assert.match(await s.say(b), /^PAPER · Usage: \/top \[N\] \(N from 1 to 10, default 5\)/, b);
  assert.equal(s.t!.calls.length, before, 'a usage line reads nothing');
});

test('1426 /signals [N]: the runner\'s signals newest first with their ages, default 5, clamped 1..20', async () => {
  const sig = new SignalLog();
  const ev = (t: number, kind: string, d: Record<string, unknown>) => sig.onLedger({ seq: t, t, kind, ...d } as LedgerEvent);
  ev(T0 - 600_000, 'candidate', { mint: CA2, symbol: 'BONK', matched: ['push', 'vol'] });
  ev(T0 - 500_000, 'refused', { rule: 'larp-score', mint: CA3, symbol: 'WIF', stage: 'vet', detail: 'LARP score 62 (high) is above 49' });
  ev(T0 - 450_000, 'refused', { rule: 'entries-paused', mint: CA3 }); // not a signal (no vet stage)
  ev(T0 - 400_000, 'reply', { sessionId: 's1' }); // not a signal
  ev(T0 - 300_000, 'fill', { mint: CA2, side: 'buy', usd: 20, reason: 'entry' });
  ev(T0 - 120_000, 'drain_guard', { mint: CA2, reason: 'liquidity-pull', detail: 'liq fell 60% in 1 tick' });
  ev(T0 - 60_000, 'halt', { reason: 'daily-loss' });
  for (let i = 0; i < 25; i++) ev(T0 - 1000 * (30 - i), 'candidate', { mint: CA, symbol: `S${i}`, matched: ['push'] });
  const s = setup({ signals: sig });
  let txt = await s.say('/signals');
  assert.match(txt, /^PAPER · SIGNALS · last 5 of 30 · newest first · data, not advice/);
  assert.match(txt.split('\n')[1], /^6s ago · SCREEN · "S24" Mint…1111 matched the screen: push$/);
  txt = await s.say('/signals 20');
  assert.equal(txt.split('\n').length, 21);
  txt = await s.say('/signals 50');
  assert.equal(txt.split('\n').length, 21, 'clamped to 20');
  assert.match(await s.say('/signals 0'), /last 1 of 30/);
  const all = new SignalLog();
  for (const [t, k, d] of [[T0 - 600_000, 'candidate', { mint: CA2, symbol: 'BONK', matched: ['push', 'vol'] }], [T0 - 500_000, 'refused', { rule: 'larp-score', mint: CA3, symbol: 'WIF', stage: 'vet', detail: 'LARP score 62 (high) is above 49' }], [T0 - 300_000, 'fill', { mint: CA2, side: 'buy', usd: 20, reason: 'entry' }], [T0 - 120_000, 'drain_guard', { mint: CA2, reason: 'liquidity-pull', detail: 'liq fell 60% in 1 tick' }], [T0 - 60_000, 'halt', { reason: 'daily-loss' }]] as const) all.onLedger({ seq: t, t, kind: k, ...d } as LedgerEvent);
  const s2 = setup({ signals: all });
  txt = await s2.say('/signals 10');
  assert.deepEqual(txt.split('\n').slice(1), [
    '1m ago · HALT · daily-loss',
    '2m ago · DRAIN · "BONK" Bonk…2222 liquidity-pull: liq fell 60% in 1 tick',
    '5m ago · BUY · "BONK" Bonk…2222 buy $20.00 · entry (paper book)',
    '8m ago · SAFETY · "WIF" Wif3…3333 refused by larp-score: LARP score 62 (high) is above 49',
    '10m ago · SCREEN · "BONK" Bonk…2222 matched the screen: push, vol',
  ]);
  for (const b of ['/signals x', '/signals 1 2']) assert.match(await s2.say(b), /^PAPER · Usage: \/signals \[N\] \(N from 1 to 20, default 5\)/);
});

test('1426 no write path: every read-only command, with every argument shape, never calls a ControlPort write, a confirm or a non-read tool', async () => {
  const s = setup({ signals: (() => { const l = new SignalLog(); l.onLedger({ seq: 1, t: T0, kind: 'halt', reason: 'stop' } as LedgerEvent); return l; })() });
  const cmds = [`/check ${CA}`, `/check ${CA2}`, '/check', '/check /kill', `/check ${CA} /flatten`, '/top', '/top 10', '/top flatten', '/signals', '/signals 20', '/signals kill'];
  for (const c of cmds) { s.r.me.command(c); await s.r.hub.idle(); s.r.clock.now += 7000; }
  await flush();
  assert.deepEqual(s.trap.writes, [], 'no ControlPort write');
  assert.deepEqual(s.confirms, [], 'no confirm card');
  assert.ok(s.r.fake.sent.every((m) => m.buttons.length === 0 && m.msg.kind === 'text'), 'lines only, no buttons');
  assert.ok(s.t!.calls.every((c) => (READ_TOOLS as readonly string[]).includes(c.tool)), 'read tools only');
  assert.equal(s.r.audit.events.filter((e) => e.kind === 'hub_error').length, 0);
  assert.equal(s.r.fake.sent.length, cmds.length, 'one answer each');
  // The router is built from a ReadOnlyPort alone; its surface is the three reads.
  const surface = Object.getOwnPropertyNames(HostReadPort.prototype).filter((k) => k !== 'constructor' && !k.startsWith('mark')).sort();
  assert.deepEqual(surface, ['check', 'signals', 'top']);
  assert.equal(ReadOnlyRouter.length, 1, 'ReadOnlyRouter takes the read port (and an optional clock), never a ControlPort');
  // The tool narrowing refuses anything but the read tools, even if a caller casts its way there.
  const seen: string[] = [];
  const narrowed = readOnlyCall({ call: async (n) => { seen.push(n); return {}; } });
  for (const t of ['paper_confirm', 'paper_open_ticket', 'add_to_watchlist', 'strategy_forward_start', 'autotrade_parallel_stop', 'set_theme']) {
    await assert.rejects(narrowed(t as ReadTool, {}), /not a read tool/);
  }
  await narrowed('get_token', { mint: CA });
  assert.deepEqual(seen, ['get_token']);
});

test('1426 unbound chats are refused: another account, the paired account in a group or another private chat', async () => {
  const s = setup();
  const other = s.r.fake.user('555');
  const group = s.r.fake.user(ME, '-100123', 'group');
  const otherDm = s.r.fake.user(ME, '424243');
  for (const u of [other, group, otherDm]) for (const c of [`/check ${CA}`, '/top', '/signals']) u.command(c);
  await s.r.hub.idle();
  assert.equal(s.r.fake.sent.length, 0, 'no reply at all');
  assert.equal(s.t!.calls.length, 0, 'nothing read');
  assert.ok(s.r.audit.events.filter((e) => e.kind === 'in_unknown_sender').length >= 9);
  // A notify-only pairing may read (like /status).
  const n = rig({ config: pairedConfig({ tiers: ['notify'] }), reads: { check: async () => ({ unavailable: 'x' }), top: async () => ({ unavailable: 'y' }), signals: () => ({ unavailable: 'z' }) } });
  n.me.command('/signals');
  await n.hub.idle();
  assert.match(n.fake.sent.at(-1)!.text, /z$/);
});

test('1426 rate limit: read-only commands count like /status (10 a minute per sender); /kill still works', async () => {
  const s = setup();
  // Usage answers read nothing, so only the hub's per-sender limit applies to them (task-2146 counts data reads per chat).
  for (let i = 0; i < 10; i++) s.r.me.command(i % 2 ? '/top x' : '/signals x');
  s.r.me.command(`/check ${CA}`);
  await s.r.hub.idle();
  assert.equal(s.r.fake.sent.filter((m) => /Too many commands: wait a minute/.test(m.text)).length, 1, 'the 11th is limited');
  assert.equal(s.r.fake.sent.length, 11);
  assert.equal(s.t!.calls.length, 0, 'the limited /check read nothing');
  s.r.me.command('/kill');
  await s.r.hub.idle();
  assert.deepEqual(s.trap.writes, ['kill'], '/kill is never limited (and is a write, from /kill only)');
  s.r.clock.now += 61_000;
  s.r.me.command(`/check ${CA}`);
  await s.r.hub.idle();
  assert.match(s.r.fake.sent.at(-1)!.text, /CHECK/);
  assert.ok(s.t!.calls.length > 0);
});

test('1426 one /check at a time per account: a second one while the first is running is told to wait', async () => {
  const t = tools({ hang: 'larp_check' });
  const s = setup({ tools: t });
  s.r.me.command(`/check ${CA}`);
  await flush();
  s.r.me.command(`/check ${CA2}`);
  await flush();
  assert.match(s.r.fake.sent.at(-1)!.text, /A \/check is still running/);
  await s.r.hub.idle(); // the hung LARP check times out (200 ms here)
  assert.match(s.r.fake.sent.at(-1)!.text, /LARP score: could not be read \(LARP check: no answer in 0 s\)/);
  assert.match(s.r.fake.sent.at(-1)!.text, /risk: mint authority revoked/, 'the other facts still answer');
});

test('1426 no data: no run / a replay (no read tools), sources down, an empty screener; the hub without a read port', async () => {
  let s = setup({ tools: null, st: null });
  assert.match(await s.say(`/check ${CA}`), /No live data here: the bot is not attached to a run on live data/);
  assert.match(await s.say('/top'), /No live data here/);
  assert.match(await s.say('/signals'), /No signals: no run has started since the bot came on/);
  // A replay run: no read tools, but the runner's own coins answer /top, and /signals has nothing yet.
  s = setup({ tools: null });
  let txt = await s.say('/top');
  assert.match(txt, /TOP 2 · no live screener here; the runner's own coins instead/);
  assert.match(txt, /1\. "BONK" Bonk…2222 · mcap \? · liq \? · HELD/);
  assert.match(await s.say('/signals'), /No signals yet: nothing matched the screen or tripped a check since the bot came on/);
  // Sources down.
  s = setup({ tools: tools({ fail: { get_token: 'dexscreener 503', larp_check: 'offline', screener_query: 'fetch failed' } }), st: null });
  txt = await s.say(`/check ${CA}`);
  assert.match(txt, /LARP score: could not be read \(offline\)/);
  assert.match(txt, /risk: could not be read \(dexscreener 503\)/, 'a failed read says so; it never reads as "this coin has no data"');
  assert.match(txt, /market: could not be read \(dexscreener 503\)/);
  assert.match(await s.say('/top'), /No ranking right now: the screener did not answer \(fetch failed\)\./);
  s = setup({ tools: tools({ rows: 0 }), st: null });
  assert.match(await s.say('/top'), /the screener returned nothing: offline, or the sources did not answer/);
  // A hub with no read port at all.
  const r = rig({ controlPort: trapPort().port });
  r.me.command('/top');
  await r.hub.idle();
  assert.match(r.fake.sent.at(-1)!.text, /Read-only data is not available here/);
  // A read port that throws: a plain line, audited, no crash.
  const boom: ReadOnlyPort = { check: async () => { throw new Error('boom'); }, top: async () => { throw new Error('boom'); }, signals: () => { throw new Error('boom'); } };
  const r2 = rig({ reads: boom });
  r2.me.command('/signals');
  await r2.hub.idle();
  assert.match(r2.fake.sent.at(-1)!.text, /Could not read the signals right now \(boom\)\. Nothing was guessed/);
  assert.equal(r2.audit.events.filter((e) => e.kind === 'read_failed').length, 1);
});

test('1426 help lists the read-only commands; the service feeds /signals from the ledger tap and /check from setReadTools', async () => {
  assert.ok(HELP_LINES.some((l) => l.includes('/check <CA> · /top [N] · /signals [N]') && l.includes('data, not advice')));
  const home = tmpHome();
  const cfg = pairedConfig();
  saveConnectors(home, { schema: CONNECTORS_SCHEMA, telegram: cfg });
  const now = () => T0;
  const { FakeConnector } = await import('../src/chat/fake.ts');
  const fake = new FakeConnector({ now });
  const st = state();
  const svc = new TelegramService({ home, connector: fake, port: new PaperPort(okExec, { now }), config: new ConfigView(home, now, cfg), audit: new ChatAudit(null), store: new CallbackStore(':memory:'), now, timers: false, runId: () => 'run-1', state: () => st, strategy: () => null });
  const me = fake.user(ME);
  me.command(`/check ${CA}`);
  await svc.hub.idle();
  assert.match(fake.sent.at(-1)!.text, /No live data here/);
  const t = tools();
  svc.setReadTools(t.call);
  svc.onLedger({ seq: 1, t: T0 - 2000, kind: 'drain_guard', mint: CA2, reason: 'liquidity-pull', detail: 'x', strategyId: 'yolo' } as LedgerEvent);
  me.command(`/check ${CA}`);
  me.command('/signals');
  await svc.hub.idle();
  const texts = fake.sent.map((m) => m.text);
  assert.ok(texts.some((x) => /CHECK "TEST"/.test(x)));
  assert.match(texts.find((x) => /SIGNALS ·/.test(x)) ?? '', /2s ago · DRAIN · yolo · Bonk…2222 liquidity-pull: x/);
  svc.setReadTools(null);
  me.command('/top');
  await svc.hub.idle();
  assert.match(fake.sent.map((m) => m.text).find((x) => /TOP \d/.test(x)) ?? '', /no live screener here; the runner's own coins instead/);
  await svc.stop();
});
