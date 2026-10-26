// task-1654 (0.2.0 card E): `dexterm autotrade limits …`, the arming wizard with the user's own numbers,
// `signal test`'s per-channel report (the kit's command-hook executor as the fake executor), `executor status |
// heartbeat | kit` and `report`. A temp $DEXTERM_HOME, fake terminals (typed lines through the test seam), the
// file secret store, a fake Telegram connector. No network, no key, no wallet, no transaction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { autotradeCommand, autotradeHelp } from '../src/autotrade-cmd.ts';
import { limitsCmd } from '../src/autotrade-cmd/limits.ts';
import { signalCmd, type SignalDeps } from '../src/autotrade-cmd/signal.ts';
import { reportCmd } from '../src/autotrade-cmd/report.ts';
import { fileLedger, limitsPath, loadArmings, loadLimits, readRealJournal, saveConnectors, CONNECTORS_SCHEMA, defaultTelegram, saveRiskState, freshRiskState, type ChatConnector } from '@dexterm/autotrade';

const KIT = fileURLToPath(new URL('../../autotrade/examples/executor/', import.meta.url));

function io(home = mkdtempSync(join(tmpdir(), 'dexterm-1654-cli-'))) {
  const out: string[] = [], err: string[] = [];
  return { home, out, err, io: { stdout: { write: (s: string) => out.push(s) }, stderr: { write: (s: string) => err.push(s) }, env: { DEXTERM_HOME: home, DEXTERM_DB_PATH: join(home, 'none.db'), DEXTERM_SECRET_STORE: 'file' } } };
}
type X = ReturnType<typeof io>;
const wrap = async (x: X, f: () => Promise<number>) => { x.out.length = 0; x.err.length = 0; const code = await f(); return { code, out: x.out.join(''), err: x.err.join('') }; };
const run = (x: X, ...argv: string[]) => wrap(x, () => autotradeCommand(argv, x.io));
const lim = (x: X, deps: SignalDeps, ...argv: string[]) => wrap(x, () => limitsCmd(argv, x.io, deps));
const sig = (x: X, deps: SignalDeps, ...argv: string[]) => wrap(x, () => signalCmd(argv, x.io, deps));
/** task-1679: a test that is not about the evidence floor types the OVERRIDE phrase the arming shows. */
const override = (p: string): string | null => /"(OVERRIDE [^"]+)"/.exec(p)?.[1] ?? null;
const tty = (answer: (prompt: string) => string | null): SignalDeps => ({ tty: true, code: () => 'ABCD', typed: async (p) => override(p) ?? answer(p) });

test('the dispatcher has the limits, executor and report rows', () => {
  const h = autotradeHelp();
  assert.match(h, /dexterm autotrade limits show\|set\|diff\|reset\|accept/);
  assert.match(h, /dexterm autotrade executor status/);
  assert.match(h, /dexterm autotrade report \[--period day\|week\]/);
});

test('limits show / explain / schema: placeholders are labelled as such until you save your own numbers', async () => {
  const x = io();
  let r = await run(x, 'autotrade', 'limits', 'show');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /these are the placeholder defaults, NOT your numbers/);
  assert.match(r.out, /perTradeSol +0\.25 SOL +\(placeholder default\)/);
  assert.match(r.out, /maxOpenPositions +3 open/);
  r = await run(x, 'autotrade', 'limits', 'show', '--all');
  assert.match(r.out, /maxSellsPerMinute +off/);
  r = await run(x, 'autotrade', 'limits', 'explain', 'per-trade-pct');
  assert.match(r.out, /^perTradePct \(sizing, % of book, a cap: smaller is stricter; placeholder off\)/);
  r = await run(x, 'autotrade', 'limits', 'schema');
  assert.equal(JSON.parse(r.out).title, 'dexterm-limits/1');
  const j = JSON.parse((await run(x, 'autotrade', 'limits', 'show', '--strategy', 'scalp', '--json')).out);
  assert.equal(j.effective.perTradeSol, 0.25);
  assert.equal(j.from.perTradeSol, 'default');
});

test('limits set: lowering is immediate, raising shows old -> new and needs the typed phrase; scopes; validation names the field', async () => {
  const x = io();
  let r = await run(x, 'autotrade', 'limits', 'set', 'perTradeSol=0.1', 'dailyLossSol=0.2');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /lower global\.perTradeSol: 0\.25 SOL -> 0\.1 SOL/);
  assert.match(r.out, /saved \(journaled, [0-9a-f]{16}\)/);
  r = await run(x, 'autotrade', 'limits', 'set', 'perTradeSol=0.5');
  assert.equal(r.code, 1, 'a raise from a pipe');
  assert.match(r.out, /RAISE global\.perTradeSol: 0\.1 SOL -> 0\.5 SOL/);
  assert.match(r.err, /real terminal/);
  r = await lim(x, tty(() => 'RAISE limits WRONG'), 'set', 'perTradeSol=0.5');
  assert.equal(r.code, 1);
  assert.equal((loadLimits(x.home) as { doc: { global: { perTradeSol: number } } }).doc.global.perTradeSol, 0.1);
  let prompt = '';
  r = await lim(x, tty((p) => { prompt = p; return 'RAISE limits ABCD'; }), 'set', 'perTradeSol=0.5');
  assert.equal(r.code, 0, r.err);
  assert.match(prompt, /type exactly "RAISE limits ABCD"/);
  r = await run(x, 'autotrade', 'limits', 'set', '--scope', 'strategy:my-scalp', 'perTradeSol=0.05', 'max-open-positions=1');
  assert.equal(r.code, 0, r.err);
  r = await run(x, 'autotrade', 'limits', 'set', '--scope', 'account:main', 'buysPerDay=4');
  assert.equal(r.code, 0, r.err);
  const j = JSON.parse((await run(x, 'autotrade', 'limits', 'show', '--strategy', 'my-scalp', '--account', 'main', '--json')).out);
  assert.deepEqual([j.effective.perTradeSol, j.from.perTradeSol, j.effective.maxOpenPositions, j.effective.buysPerDay, j.from.buysPerDay], [0.05, 'strategies.my-scalp', 1, 4, 'accounts.main']);
  r = await run(x, 'autotrade', 'limits', 'set', '--scope', 'strategy:my-scalp', 'perTradeSol=off');
  assert.equal(r.code, 1, 'removing a tighter scope\'s number is a raise');
  assert.match(r.out, /RAISE strategies\.my-scalp\.perTradeSol: 0\.05 SOL -> off/);
  r = await run(x, 'autotrade', 'limits', 'set', 'perTradeSol=-1');
  assert.equal(r.code, 2);
  assert.match(r.err, /\/global\/perTradeSol: perTradeSol must be from/);
  assert.equal((await run(x, 'autotrade', 'limits', 'set', 'nonsense=1')).code, 2);
  assert.equal((await run(x, 'autotrade', 'limits', 'set', '--scope', 'galaxy', 'perTradeSol=1')).code, 2);
  assert.ok(readRealJournal(x.home).filter((l) => l.action === 'limits-set').length >= 4);
});

test('limits diff / accept / reset / breaker reset', async () => {
  const x = io();
  assert.equal((await run(x, 'autotrade', 'limits', 'set', 'perTradeSol=0.2')).code, 0);
  assert.match((await run(x, 'autotrade', 'limits', 'diff')).out, /matches dexterm's last save/);
  const doc = JSON.parse(readFileSync(limitsPath(x.home), 'utf8'));
  writeFileSync(limitsPath(x.home), JSON.stringify({ ...doc, global: { perTradeSol: 2, dailySol: 5 } }));
  let r = await run(x, 'autotrade', 'limits', 'diff');
  assert.match(r.out, /RAISE global\.perTradeSol: 0\.2 SOL -> 2 SOL/);
  assert.match(r.out, /a real run refuses it until you accept it/);
  assert.match((await run(x, 'autotrade', 'limits', 'show')).out, /limits\.json differs from dexterm's last save/);
  assert.equal((await run(x, 'autotrade', 'limits', 'accept')).code, 1, 'a raise needs the phrase');
  assert.equal((await lim(x, tty(() => 'RAISE limits ABCD'), 'accept')).code, 0);
  assert.equal(readRealJournal(x.home).at(-1)!.action, 'limits-accept');
  const proposal = join(x.home, 'p.json');
  writeFileSync(proposal, JSON.stringify({ schema: 'dexterm-limits/1', global: { perTradeSol: 1, dailySol: 5 } }));
  assert.match((await run(x, 'autotrade', 'limits', 'diff', '--file', proposal)).out, /lower global\.perTradeSol: 2 SOL -> 1 SOL/);
  r = await run(x, 'autotrade', 'limits', 'reset');
  assert.equal(r.code, 0, `back to 0.25 / 1 SOL lowers: ${r.err}`);
  assert.match(r.out, /lower global\.perTradeSol: 2 SOL -> 0\.25 SOL/);
  assert.match((await run(x, 'autotrade', 'limits', 'breaker', 'reset')).out, /not tripped/);
  saveRiskState(x.home, { ...freshRiskState('2000-01-01'), breaker: { at: 1, drawdownSol: 1.5 } });
  assert.equal((await run(x, 'autotrade', 'limits', 'breaker', 'reset')).code, 1, 'from a pipe');
  r = await lim(x, tty(() => 'RESET breaker ABCD'), 'breaker', 'reset');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /drawdown breaker reset \(journaled\)/);
});

test('arming: the first-run wizard takes YOUR numbers, shows the effective limits, and the phrase confirms them', async () => {
  const x = io();
  assert.equal((await run(x, 'autotrade', 'new', 'my-scalp', '--from', 'scalp')).code, 0);
  assert.equal((await run(x, 'autotrade', 'signal', 'channels', '--jsonl', 'on')).code, 0);
  const answers: Record<string, string> = { perTradeSol: '0.1', dailySol: 'lots', buysPerDay: '5', maxOpenPositions: '', dailyLossSol: 'off', executorSilenceMin: '30' };
  const asked: string[] = [];
  let tries = 0;
  const deps = tty((p) => {
    const k = /^\s+(\w+):/.exec(p)?.[1];
    if (k && k in answers) { asked.push(k); if (k === 'dailySol' && tries++ === 0) return answers.dailySol; return k === 'dailySol' ? '0.4' : answers[k]; }
    return 'REAL my-scalp ABCD';
  });
  const r = await sig(x, deps, 'arm', 'my-scalp');
  assert.equal(r.code, 0, r.err);
  assert.deepEqual([...new Set(asked)], ['perTradeSol', 'dailySol', 'buysPerDay', 'maxOpenPositions', 'dailyLossSol', 'executorSilenceMin']);
  assert.match(r.err, /dailySol: "lots" is not a number/, 'a bad answer is asked again');
  assert.match(r.out, /perTradeSol +0\.1 SOL +\(global\)/);
  assert.match(r.out, /maxOpenPositions +3 open +\(global\)/, 'Enter kept the placeholder, now saved as your number');
  assert.ok(!/dailyLossSol/.test(r.out.split('limits    in force')[1].split('typing the phrase')[0]), 'turned off: not in force');
  assert.match(r.out, /executor  never heard from: start your executor/);
  const a = loadArmings(x.home)['my-scalp'];
  assert.deepEqual([a.limits?.perTradeSol, a.limits?.dailySol, a.limits?.buysPerDay, a.limits?.executorSilenceMin, a.limits?.dailyLossSol], [0.1, 0.4, 5, 30, undefined]);
  assert.equal(a.caps.perTradeSol, 0.1);
  const g = (loadLimits(x.home) as { doc: { global: Record<string, number | null> } }).doc.global;
  assert.equal(g.dailyLossSol, null);
  // Cancelled at the phrase: nothing saved (no silent defaults).
  const y = io();
  assert.equal((await run(y, 'autotrade', 'new', 'my-scalp', '--from', 'scalp')).code, 0);
  assert.equal((await run(y, 'autotrade', 'signal', 'channels', '--jsonl', 'on')).code, 0);
  assert.equal((await sig(y, tty((p) => (/\]: $/.test(p) ? '' : 'no')), 'arm', 'my-scalp')).code, 1);
  assert.equal(existsSync(limitsPath(y.home)), false, 'the wizard\'s numbers are saved only with the arming');
  assert.deepEqual(loadArmings(y.home), {});
});

test('signal test: per channel delivered + latency, the executor\'s receipt; executor status / heartbeat / kit', async () => {
  const x = io();
  const argv = JSON.stringify([process.execPath, join(KIT, 'signal-cmd-executor.mjs'), '--account', 'main', '--home', x.home]);
  assert.equal((await run(x, 'autotrade', 'signal', 'channels', '--jsonl', 'on', '--signal-cmd', argv)).code, 0);
  const r = await sig(x, { receiptWaitMs: 2000, sleep: (ms) => new Promise((res) => setTimeout(res, Math.min(ms, 50))) }, 'test', '--json');
  assert.equal(r.code, 0, r.err + r.out);
  const j = JSON.parse(r.out) as { test: boolean; channels: { channel: string; delivered: boolean; state: string; latencyMs: number | null; executorReadable: boolean }[]; receipts: { status: string; executor: string; reason: string }[] };
  assert.equal(j.test, true);
  const by = Object.fromEntries(j.channels.map((c) => [c.channel, c]));
  assert.equal(by.jsonl.delivered, true); assert.equal(typeof by.jsonl.latencyMs, 'number');
  assert.equal(by.cmd.delivered, true); assert.equal(by.cmd.state, 'acked');
  assert.match(by.telegram.state, /deferred/); assert.equal(by.telegram.executorReadable, false);
  assert.deepEqual(j.receipts.map((x2) => [x2.status, x2.executor]), [['rejected', 'kit-signal-cmd']]);
  assert.match(j.receipts[0].reason, /test signal: received, never traded/);
  let s = await run(x, 'autotrade', 'executor', 'status');
  assert.match(s.out, /executor {2}ALIVE · last (heartbeat|receipt) /);
  assert.match(s.out, /kit-signal-cmd/);
  assert.match((await run(x, 'autotrade', 'signal', 'status')).out, /executor {2}ALIVE/);
  assert.equal((await run(x, 'autotrade', 'executor', 'heartbeat', '--name', 'my-bot', '--account', 'main', '--dry-run')).code, 0);
  s = await run(x, 'autotrade', 'executor', 'status', '--json');
  assert.equal(JSON.parse(s.out).heartbeat.executor, 'my-bot');
  assert.equal((await run(x, 'autotrade', 'executor', 'heartbeat', '--account', 'Not Valid')).code, 2);
  const kit = join(x.home, 'kit');
  s = await run(x, 'autotrade', 'executor', 'kit', '--out', kit);
  assert.equal(s.code, 0, s.err);
  assert.deepEqual(readdirSync(kit).sort(), ['README.md', 'jsonl-tail-executor.mjs', 'kit.mjs', 'signal-cmd-executor.mjs', 'telegram-bot-recipe.md', 'webhook-executor.mjs']);
  assert.match(s.out, /DRY RUN/);
  assert.equal((await run(x, 'autotrade', 'executor', 'kit', '--out', kit)).code, 1, 'never over a folder with files');
});

test('report: the digest as text and JSON, sent through your own bot with --telegram, and the opt-in schedule', async () => {
  const x = io();
  const NOW = Date.now();
  const { ledger } = fileLedger(x.home, '20261020T000000Z-my-scalp-aaaa');
  ledger.add(NOW - 3_600_000, 'run_start', { strategy: 'my-scalp', mode: 'real', tag: 'real-signal' });
  ledger.add(NOW - 3_000_000, 'trade_closed', { trade: { pnlUsd: 12.5 } });
  ledger.add(NOW - 2_000_000, 'refused', { rule: 'fill-real-max-open' });
  let r = await run(x, 'autotrade', 'report');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /dexterm daily digest/);
  assert.match(r.out, /REAL my-scalp · 1 run\(s\) · 1 trade\(s\) · win 100% \(95% interval 20\.7-100%\) · net \+\$12\.50/);
  assert.match(r.out, /limits hit: real-max-open ×1/);
  assert.match(r.out, /1 closed trade\(s\) in total: a small sample/);
  assert.equal(JSON.parse((await run(x, 'autotrade', 'report', '--period', 'week', '--json')).out).period, 'week');
  assert.equal((await run(x, 'autotrade', 'report', '--period', 'month')).code, 2);
  // --telegram through a fake connector of the user's own bot.
  saveConnectors(x.home, { schema: CONNECTORS_SCHEMA, telegram: { ...defaultTelegram(), enabled: true, allow: [{ senderId: '1', chatId: '1', tiers: ['notify', 'control'], label: 'me', pairedAt: 1 }] as never } });
  const sent: string[][] = [];
  const connector = { transport: 'fake', start: async () => {}, send: async (_t: unknown, m: { kind: string; lines?: string[] }) => { sent.push(m.lines ?? []); return { chatId: '1', messageId: String(sent.length) }; }, edit: async () => {}, onCommand: () => {}, onAction: () => {}, onText: () => {}, ackAction: async () => {}, health: () => ({ ok: true }) } as unknown as ChatConnector;
  x.out.length = 0; x.err.length = 0;
  const code = await reportCmd(['--telegram'], x.io, { telegram: { connector, timers: false } });
  assert.equal(code, 0, x.err.join(''));
  assert.ok(sent.some((l) => l[0]?.startsWith('dexterm daily digest')), JSON.stringify(sent));
  r = await run(x, 'autotrade', 'report', '--schedule', 'weekly');
  assert.match(r.out, /scheduled digest: weekly .*on Mondays/);
  assert.equal(JSON.parse(readFileSync(join(x.home, 'autotrade', 'digest.json'), 'utf8')).schedule, 'weekly');
});
