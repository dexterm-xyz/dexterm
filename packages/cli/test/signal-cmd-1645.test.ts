// task-1645 (0.2.0 card A): `dexterm autotrade signal …`, `dexterm autotrade receipt …` and `run --real`'s refusals.
// A temp $DEXTERM_HOME, the file secret store, fake terminals (a typed line through the test seam), a JSONL stream as
// the fake executor's input. No network, no key, no wallet, no transaction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { autotradeCommand, autotradeHelp } from '../src/autotrade-cmd.ts';
import { signalCmd, type SignalDeps } from '../src/autotrade-cmd/signal.ts';
import { Outbox, buildTradeSignal, loadArmings, loadConnectors, readRealJournal, SignalReceiver, type TradeFireSignal } from '@dexterm/autotrade';
import { posixPermissions } from '../../../scripts/test-support.ts';

const TAPE = fileURLToPath(new URL('../../autotrade/test/fixtures/autotrade-1498-tape.json', import.meta.url));
const MINT = 'So1aNaMint11111111111111111111111111111111';

function io(home = mkdtempSync(join(tmpdir(), 'dexterm-1645-cli-'))) {
  const out: string[] = [], err: string[] = [];
  return { home, out, err, io: { stdout: { write: (s: string) => out.push(s) }, stderr: { write: (s: string) => err.push(s) }, env: { DEXTERM_HOME: home, DEXTERM_DB_PATH: join(home, 'none.db'), DEXTERM_SECRET_STORE: 'file' } } };
}
const run = async (x: ReturnType<typeof io>, ...argv: string[]) => {
  x.out.length = 0; x.err.length = 0;
  const code = await autotradeCommand(argv, x.io);
  return { code, out: x.out.join(''), err: x.err.join('') };
};
const sig = async (x: ReturnType<typeof io>, deps: SignalDeps, ...argv: string[]) => {
  x.out.length = 0; x.err.length = 0;
  const code = await signalCmd(argv, x.io, deps);
  return { code, out: x.out.join(''), err: x.err.join('') };
};
/** A real terminal where the user types `line` (with the one-time code fixed to ABCD). */
// task-1654: the first arming asks for your limits (prompts end in "[placeholder]: "); Enter keeps the placeholder.
/** task-1679: a test that is not about the evidence floor types the OVERRIDE phrase the arming shows. */
const override = (p: string): string | null => /"(OVERRIDE [^"]+)"/.exec(p)?.[1] ?? null;
const tty = (line: (prompt: string) => string | null): SignalDeps => ({ tty: true, code: () => 'ABCD', typed: async (p) => (/\]: $/.test(p) ? '' : override(p) ?? line(p)) });

async function setup() {
  const x = io();
  assert.equal((await run(x, 'autotrade', 'new', 'my-scalp', '--from', 'scalp')).code, 0);
  assert.equal((await run(x, 'autotrade', 'signal', 'channels', '--jsonl', 'on')).code, 0);
  return x;
}

test('the dispatcher has the signal and receipt rows; help says paper by default and no key', () => {
  const h = autotradeHelp();
  assert.match(h, /dexterm autotrade signal status\|channels/);
  assert.match(h, /dexterm autotrade receipt <nonce\|id> executed\|rejected\|failed/);
  assert.match(h, /PAPER by default/);
});

test('channels live in connectors.json next to the Telegram setup; bad URLs and shell strings are refused', async (t) => {
  const x = io();
  writeFileSync(join(x.home, 'connectors.json'), JSON.stringify({ schema: 'dexterm-connectors/1', telegram: { enabled: true, approvals: 'on', allow: [{ senderId: '1', chatId: '1', tiers: ['notify'] }] } }));
  let r = await run(x, 'autotrade', 'signal', 'channels', '--webhook', 'http://10.0.0.5/fire');
  assert.equal(r.code, 2);
  assert.match(r.err, /https/);
  r = await run(x, 'autotrade', 'signal', 'channels', '--signal-cmd', 'sh -c "curl evil"');
  assert.equal(r.code, 2);
  assert.match(r.err, /no shell/);
  r = await run(x, 'autotrade', 'signal', 'channels', '--webhook', 'http://127.0.0.1:8787/fire', '--signal-cmd', '["/usr/local/bin/my-exec","--fast"]', '--mcp', 'on', '--ttl', '45');
  assert.equal(r.code, 0, r.err);
  const c = loadConnectors(x.home);
  assert.ok(c.ok);
  assert.equal(c.config.telegram.approvals, 'on', 'the Telegram block is kept as it was');
  assert.equal(c.config.telegram.allow.length, 1);
  const s = c.config.signals as { webhook: { url: string }; cmd: { argv: string[] }; mcp: { enabled: boolean }; ttlSec: number };
  assert.equal(s.webhook.url, 'http://127.0.0.1:8787/fire');
  assert.deepEqual(s.cmd.argv, ['/usr/local/bin/my-exec', '--fast']);
  assert.equal(s.ttlSec, 45);
  assert.ok(!readFileSync(join(x.home, 'connectors.json'), 'utf8').match(/secret"\s*:\s*"/), 'no secret in the file');
  // The webhook secret: generated into a 0600 file for the executor, never printed.
  const f = join(x.home, 'exec.secret');
  r = await run(x, 'autotrade', 'signal', 'secret', 'generate', '--out', f);
  assert.equal(r.code, 0, r.err);
  const secret = readFileSync(f, 'utf8').trim();
  assert.ok(secret.length >= 40);
  await posixPermissions(t, () => { assert.equal(statSync(f).mode & 0o777, 0o600); });
  assert.ok(!r.out.includes(secret) && !r.err.includes(secret), 'the secret is never printed');
  assert.equal(readFileSync(join(x.home, 'secrets', 'signal-webhook.secret'), 'utf8').trim(), secret);
  // task-1712: absolute means the host's absolute path (C:\… on Windows), never a relative one
  r = await run(x, 'autotrade', 'signal', 'secret', 'generate', '--out', 'exec.secret');
  assert.equal(r.code, 2, 'a relative --out is refused');
});

test('arming needs a real terminal and the exact typed phrase; presets and pipes never arm; the panel shows the evidence', async () => {
  const x = await setup();
  assert.equal((await run(x, 'autotrade', 'backtest', 'my-scalp', '--tape', TAPE)).code, 0);
  let r = await run(x, 'autotrade', 'signal', 'arm', 'my-scalp');
  assert.equal(r.code, 2, 'no TTY (a pipe, an agent, MCP): refused before anything is shown');
  assert.match(r.err, /real terminal/);
  r = await sig(x, tty(() => 'REAL scalp ABCD'), 'arm', 'scalp');
  assert.equal(r.code, 1);
  assert.match(r.err, /shipped preset/);
  r = await sig(x, tty(() => 'yes'), 'arm', 'my-scalp');
  assert.equal(r.code, 1);
  assert.match(r.err, /not confirmed/);
  assert.deepEqual(loadArmings(x.home), {});
  let prompt = '';
  r = await sig(x, tty((p) => { prompt = p; return 'REAL my-scalp ABCD'; }), 'arm', 'my-scalp', '--account', 'desk-1');
  assert.equal(r.code, 0, r.err);
  assert.match(prompt, /type exactly "REAL my-scalp ABCD"/);
  assert.match(r.out, /LIVE TRADE FIRE signal for YOUR executor/);
  assert.match(r.out, /backtest {2}\d+ trades · net/, 'the backtest of the paper twin is on the panel');
  assert.match(r.out, /forward {3}no forward-test report on record/);
  // task-1654: the placeholder defaults (0.25 SOL/trade, 1 SOL/day, 20 buys, 3 open), kept through the wizard, and the
  // effective limits the typed phrase confirms.
  assert.match(r.out, /caps {6}per trade 0\.25 SOL · per day 1 SOL · 20 buys\/day · 3 open/);
  assert.match(r.out, /FIRST REAL RUN: set your own limits/);
  assert.match(r.out, /limits {4}in force for my-scalp on account desk-1/);
  assert.match(r.out, /typing the phrase confirms these limits/);
  const a = loadArmings(x.home)['my-scalp'];
  assert.equal(a.accountId, 'desk-1');
  assert.notEqual(a.confirmation.codeHash, 'ABCD', 'the code itself is not stored');
  const list = JSON.parse((await run(x, 'autotrade', 'list', '--json')).out) as { strategies: { id: string; mode: string; hash: string }[] };
  const mine = list.strategies.find((s) => s.id === 'my-scalp')!;
  assert.equal(mine.mode, 'real');
  assert.equal(mine.hash, a.strategyHash);
  // task-1679: my-scalp has no forward test, so each arming above typed the OVERRIDE phrase first (journaled even when
  // the arming phrase was then wrong).
  assert.deepEqual(readRealJournal(x.home).map((l) => l.action), ['evidence-override', 'evidence-override', 'limits-set', 'arm']);
  assert.equal(loadArmings(x.home)['my-scalp'].limits?.perTradeSol, 0.25, 'the arming records the limits it confirmed');
  const j = (await run(x, 'autotrade', 'journal', 'my-scalp', '--json')).out;
  assert.match(j, /user:signal-arm/);
  // Disarm: back to paper, journaled, no confirmation needed (it lowers risk).
  r = await run(x, 'autotrade', 'signal', 'disarm', 'my-scalp');
  assert.equal(r.code, 0);
  assert.equal(JSON.parse((await run(x, 'autotrade', 'list', '--json')).out).strategies.find((s: { id: string }) => s.id === 'my-scalp').mode, 'paper');
});

test('run --real refuses: a paper strategy, a replay, the kill switch, chat approvals; --paper on a real strategy is its paper twin', async () => {
  const x = await setup();
  let r = await run(x, 'autotrade', 'run', 'my-scalp', '--real', '--no-telegram');
  assert.equal(r.code, 1);
  assert.match(r.err, /needs a strategy armed for real mode/);
  assert.equal((await sig(x, tty(() => 'REAL my-scalp ABCD'), 'arm', 'my-scalp')).code, 0);
  r = await run(x, 'autotrade', 'run', 'my-scalp', '--real', '--replay', TAPE, '--no-telegram');
  assert.equal(r.code, 2);
  assert.match(r.err, /live data only/);
  r = await run(x, 'autotrade', 'run', 'my-scalp', '--real', '--paper');
  assert.equal(r.code, 2);
  assert.equal((await run(x, 'autotrade', 'signal', 'kill', '--reason', 'test')).code, 0);
  r = await run(x, 'autotrade', 'run', 'my-scalp', '--real', '--no-telegram', '--sol-usd', '200');
  assert.equal(r.code, 1);
  assert.match(r.err, /kill switch is on/);
  r = await run(x, 'autotrade', 'signal', 'unkill');
  assert.equal(r.code, 1, 'unkill from a pipe is refused');
  assert.equal((await sig(x, tty(() => 'UNKILL real ABCD'), 'unkill')).code, 0);
  // An edit after arming voids it.
  const p = join(x.home, 'strategies', 'my-scalp.json');
  const doc = JSON.parse(readFileSync(p, 'utf8'));
  writeFileSync(p, JSON.stringify({ ...doc, description: 'edited by hand' }));
  r = await run(x, 'autotrade', 'run', 'my-scalp', '--real', '--no-telegram', '--sol-usd', '200');
  assert.equal(r.code, 1);
  assert.match(r.err, /changed since it was armed/);
  // --paper on the real strategy replays its paper twin: no signal at all.
  r = await run(x, 'autotrade', 'run', 'my-scalp', '--paper', '--replay', TAPE, '--ms-per-tick', '1', '--stub', '--no-telegram', '--quiet');
  assert.equal(r.code, 0, r.err);
  assert.ok(!existsSync(join(x.home, 'autotrade', 'real', 'signals.jsonl')), 'a paper run never emits a signal');
});

test('caps: lowering is free, raising needs the typed phrase on a real terminal', async () => {
  const x = io();
  // task-1654: caps are four of the limits; the placeholder defaults are the baseline, so a first set BELOW them is a
  // lowering (free) and one above them is a raise (typed).
  let r = await run(x, 'autotrade', 'signal', 'caps', 'set', '--per-trade-sol', '0.5');
  assert.equal(r.code, 1, 'above the 0.25 placeholder: a raise');
  assert.match(r.err, /real terminal/);
  assert.equal((await sig(x, tty(() => 'RAISE caps ABCD'), 'caps', 'set', '--per-trade-sol', '0.5')).code, 0);
  r = await run(x, 'autotrade', 'signal', 'caps', 'set', '--per-trade-sol', '0.01');
  assert.equal(r.code, 0, r.err);
  r = await run(x, 'autotrade', 'signal', 'caps', 'set', '--daily-sol', '100');
  assert.equal(r.code, 1);
  assert.match(r.err, /real terminal/);
  assert.match((await run(x, 'autotrade', 'signal', 'caps')).out, /per trade 0\.01 SOL · per day 1 SOL/);
  assert.equal((await run(x, 'autotrade', 'signal', 'caps', 'set', '--buys-per-day', '0')).code, 0, 'task-1654: 0 buys a day is a valid (strict) number');
  assert.equal((await run(x, 'autotrade', 'signal', 'caps', 'set', '--buys-per-day', '1.5')).code, 2);
});

test('test + tail + status + receipt: a test signal through the stream, a receipt recorded as data, drift listed', async () => {
  const x = await setup();
  let r = await run(x, 'autotrade', 'signal', 'test', '--account', 'main', '--wait', '0');
  assert.equal(r.code, 0, r.err + r.out);
  const stream = join(x.home, 'autotrade', 'real', 'signals.jsonl');
  const line = readFileSync(stream, 'utf8').trim().split('\n')[0];
  const got = new SignalReceiver({ accountId: 'main' }).receive(line);
  assert.ok(got.ok && got.signal.type === 'test');
  // A trade signal as the runner would have written it.
  const ob = Outbox.open(x.home, { channels: [] });
  const s = buildTradeSignal({ side: 'buy', mint: MINT, symbol: 'PEPE', sizeUsd: 20, solUsd: 200, bookUsd: 1000, priceUsd: 0.001, mcap: 1e6, liqUsd: 5e4, slippageBps: 300, maxImpactPct: 3 }, { nonce: ob.allocateNonce(), now: Date.now(), ttlSec: 60, runId: 'run-x', accountId: 'main', strategy: { id: 'my-scalp', version: '1.0.0', hash: 'ab'.repeat(8) } }) as TradeFireSignal;
  ob.enqueue(s);
  ob.close();
  r = await run(x, 'autotrade', 'receipt', String(s.nonce), 'executed', '--size-sol', '0.11', '--tx', '4'.repeat(88), '--executor', 'my-bot');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /data only/);
  r = await run(x, 'autotrade', 'receipt', '999', 'executed');
  assert.equal(r.code, 1);
  r = await run(x, 'autotrade', 'receipt', String(s.nonce), 'executed', '--tx', 'not-a-signature');
  assert.equal(r.code, 2);
  const d = JSON.parse((await run(x, 'autotrade', 'receipt', 'list', '--json')).out) as { rows: { nonce: number; state: string; sizeDriftPct: number }[] };
  assert.deepEqual(d.rows.map((q) => [q.nonce, q.state, q.sizeDriftPct]), [[s.nonce, 'executed', 10]]);
  const t = (await run(x, 'autotrade', 'signal', 'tail')).out;
  assert.match(t, /#1 .* TEST · delivery delivered/);
  assert.match(t, /#2 .* BUY PEPE 0\.1 SOL · delivery pending · executed · size drift 10%/, 'no channel was set up when it was queued: pending until its TTL');
  const st = (await run(x, 'autotrade', 'signal', 'status')).out;
  assert.match(st, /dexterm holds no key and signs nothing/);
  assert.match(st, /receipts {2}1 · executed 1/);
});

test('reconcile: read-only, a public address only', async () => {
  const x = io();
  const calls: string[] = [];
  const rpc = async (m: string) => { calls.push(m); return m === 'getBalance' ? { value: 1e9 } : { value: [] }; };
  let r = await sig(x, { rpc }, 'reconcile', '--wallet', 'Wa11et1111111111111111111111111111111111111');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /\(read-only\) · wallet Wa11…1111 · SOL 1 ·/);
  assert.deepEqual([...new Set(calls)].sort(), ['getBalance', 'getTokenAccountsByOwner']);
  r = await sig(x, { rpc }, 'reconcile', '--wallet', '5'.repeat(88));
  assert.equal(r.code, 2, 'a 64-byte secret-key-shaped string is not an address');
});

test('the Q screen reads a real-mode rendezvous (status only) and still refuses any other mode; shared views redact signals and receipts', async () => {
  const { readRunnerRendezvous, RUNNER_SCHEMA } = await import('../src/screens/autotrade-ui.ts');
  const { redactDeep } = await import('@dexterm/agents');
  const x = io();
  const p = join(x.home, 'rv.json');
  const base = { schema: RUNNER_SCHEMA, pid: 1, state: 'running', startedAt: 1, heartbeatAt: 1, haltReason: null, strategy: { id: 'a', version: '1.0.0', hash: 'h' }, book: { startUsd: 1, equityUsd: 1, cashUsd: 1, realizedTodayUsd: 0 }, spend: { todayUsd: 0, dayCapUsd: 1 }, candidates: [], sessions: [], positions: [{ mint: MINT, symbol: 'X', profile: 'p', costUsd: 1, pnlUsd: 0, pnlPct: 0, next: null, confirm: 'unconfirmed' }], ledgerTail: [] };
  writeFileSync(p, JSON.stringify({ ...base, mode: 'real', real: { accountId: 'main', killed: null, outboxDepth: 2, lastNonce: 7, caps: { perTradeSol: 0.05, dailySol: 0.25, buysPerDay: 10, maxOpenPositions: 1 }, day: { buySol: 0.05, buys: 1 }, channels: [{ name: 'webhook', pending: 2, failing: 3, lastErr: 'http 500' }], positions: [{ mint: MINT, symbol: 'X', state: 'unconfirmed', nonce: 7 }] } }));
  const r = readRunnerRendezvous(p);
  assert.equal(r.kind, 'ok');
  assert.equal(r.kind === 'ok' && r.snap.real?.outboxDepth, 2);
  writeFileSync(p, JSON.stringify({ ...base, mode: 'live' }));
  assert.equal(readRunnerRendezvous(p).kind, 'bad', 'live is never shown as a running runner');
  const red = redactDeep({ signal: { nonce: 3 }, receipt: { status: 'executed' }, nonce: 3, signalId: 'a'.repeat(32), trade_fire: 1, txSig: '5'.repeat(88), symbol: 'X' }) as Record<string, unknown>;
  for (const k of ['signal', 'receipt', 'nonce', 'signalId', 'trade_fire', 'txSig']) assert.equal(red[k], '[redacted]', k);
  assert.equal(red.symbol, 'X');
});

test('r2: signal held lists the real holdings; release needs the typed phrase on a real terminal', async () => {
  const x = await setup();
  const { saveHoldings, loadHoldings: held } = await import('@dexterm/autotrade');
  saveHoldings(x.home, { [MINT]: { mint: MINT, symbol: 'PEPE', strategyId: 'my-scalp', accountId: 'main', runId: 'run-1', nonce: 1, tokens: 1000, costUsd: 10, realizedUsd: 0, entryPrice: 0.01, openedAt: 1, at: 1 } });
  let r = await run(x, 'autotrade', 'signal', 'held');
  assert.equal(r.code, 0);
  assert.match(r.out, /PEPE .* my-scalp .* account main/);
  r = await run(x, 'autotrade', 'signal', 'status');
  assert.match(r.out, /held {6}1 of \? open: PEPE \(my-scalp\)/, 'no caps set yet: the cap shows as ?');
  r = await run(x, 'autotrade', 'signal', 'release', MINT);
  assert.equal(r.code, 1, 'release from a pipe is refused');
  assert.ok(held(x.home).holdings[MINT]);
  assert.equal((await sig(x, tty(() => 'RELEASE real ABCD'), 'release', MINT)).code, 1, 'the wrong phrase changes nothing');
  assert.ok(held(x.home).holdings[MINT]);
  assert.equal((await sig(x, tty(() => `RELEASE ${MINT} ABCD`), 'release', MINT)).code, 0);
  assert.deepEqual(held(x.home).holdings, {});
  assert.equal((await run(x, 'autotrade', 'signal', 'release', MINT)).code, 1, 'nothing left to release');
});
