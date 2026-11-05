// task-2180: a computer name that is also one of the bot's own words. GitHub's hosted runners log in as `runner`, and
// finalizeReply() used to hide that name everywhere, so the bot's own sentence became "the [host] holds this coin
// now". Both directions: (a) the host and login stay hidden in token, source and engine text, errors and paths, in
// every case variant and glued to host/path characters; (b) a login like `runner`, `trader`, `data` or `check` no
// longer changes the bot's own wording. Fake ports only (no network, no keys).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { T0 } from './chat-helpers-1527.ts';
import type { InboundCommand } from '../src/chat/connector.ts';
import { OWN_WORDING, ReadOnlyRouter, finalizeReply, type CoinCheckView, type ReadOnlyPort } from '../src/chat/readonly.ts';

const CA = 'Mint1111111111111111111111111111111111111111';
const ME = '1001';
const HOST = 'runnervm-x7.local';
const NAMES = [HOST, 'runnervm-x7', 'runner'];   // what localNames() gives on a hosted runner
const OWN_RUNNER = ['the runner holds this coin now (/positions)', 'a candidate of the runner now', "the runner's own coins instead"];

const cmd = (text: string, chatId = ME): InboundCommand => {
  const [head, ...args] = text.split(/\s+/);
  return { transport: 'fake', updateId: String(Math.random()), chatId, chatKind: 'private', senderId: ME, command: head.slice(1) as InboundCommand['command'], args, t: T0 };
};

function view(over: Partial<CoinCheckView> = {}): CoinCheckView {
  return {
    mint: CA, at: T0, symbol: 'TEST', name: 'Test Coin',
    larp: { score: 34, band: 'medium', hi: 52, unread: 3, flags: [{ label: 'no website advertised', points: 9 }] }, larpError: null,
    market: { mcap: 1.2e6, liq: 8.5e4, holders: 900, tokenAgeSec: 3 * 3600, fetchedAt: T0 },
    audit: { mintAuth: false, freezeAuth: true, top10Pct: 42.1, devPct: 3, lpLockedPct: 100, rugScore: 12, fetchedAt: T0 },
    dataError: null, engine: 'held', ...over,
  };
}

const port = (o: Partial<ReadOnlyPort> = {}): ReadOnlyPort => ({
  check: async () => view(),
  top: async () => ({
    source: "no live screener here; the runner's own coins instead", at: T0,
    rows: [{ mint: CA, symbol: 'BONK', mcap: null, liq: null, volH1: null, chgH1: null, tokenAgeSec: null, fetchedAt: T0, engine: 'held' }],
  }),
  signals: () => ({ at: T0, total: 2, rows: [
    { at: T0, level: 'info', title: 'SCREEN', text: 'matched the screen: fresh', mint: CA, symbol: 'BONK', strategy: 'yolo' },
    { at: T0, level: 'warn', title: 'SAFETY', text: 'refused by lp_lock', mint: CA, symbol: 'BONK', strategy: 'yolo' },
  ] }),
  ...o,
});

async function answers(p: ReadOnlyPort, hideNames: readonly string[]): Promise<string[]> {
  const router = new ReadOnlyRouter(p, () => T0, { hideNames });
  const out: string[] = [];
  for (const c of [`/check ${CA}`, '/top', '/signals', '/top x', '/check nope']) out.push(...(await router.handle(cmd(c, c))).lines);
  return out;
}

test('2180 (b) a login that is one of the bot\'s words leaves the bot\'s own wording exactly as it is', async () => {
  const plain = await answers(port(), []);
  assert.ok(plain.includes('the runner holds this coin now (/positions)'));
  assert.ok(plain.some((l) => l.includes("the runner's own coins instead")));
  for (const login of ['runner', 'trader', 'data', 'check', 'Runner', 'DATA', 'screen', 'candidate', 'holders', 'signals']) {
    assert.deepEqual(await answers(port(), [login]), plain, `login ${login} changed the bot's wording`);
  }
  assert.deepEqual(await answers(port(), NAMES), plain, 'hosted-runner names changed the bot\'s wording');
});

test('2180 (b) every fragment of the bot\'s wording survives every one of its own words as a login', () => {
  for (const w of OWN_WORDING) {
    const plain = finalizeReply([w], []);
    for (const word of new Set(w.split(/[^A-Za-z]+/).filter((x) => x.length >= 4))) {
      assert.deepEqual(finalizeReply([w], [word]), plain, `"${word}" changed "${w}"`);
      assert.deepEqual(finalizeReply([w], [word.toUpperCase()]), plain, `"${word.toUpperCase()}" changed "${w}"`);
    }
  }
});

test('2180 (a) the hosted-runner login and host stay hidden in token, source and engine text, errors and paths', async () => {
  const p = port({
    check: async () => view({
      symbol: 'RUNNER', name: 'Runner coin by runnervm-x7',
      larp: null, larpError: `ENOENT: open '/home/runner/.dexterm/secrets/telegram.key' on ${HOST} (user runner)`,
      market: null, dataError: 'login runner denied; the runner holds this coin now.local',
    }),
    top: async () => ({ unavailable: `No ranking right now: C:\\Users\\runner\\AppData failed for rUnNeR@${HOST}.` }),
    signals: () => ({ at: T0, total: 1, rows: [{ at: T0, level: 'alert', title: 'RUNNER', text: 'refused by runner: xthe runner holds this coin now', mint: CA, symbol: 'runner', strategy: 'runner-strat' }] }),
  });
  const txt = (await answers(p, NAMES)).join('\n');
  let rest = txt;
  for (const w of OWN_RUNNER) rest = rest.split(w).join('');
  assert.doesNotMatch(rest, /runner/i, `a name showed:\n${txt}`);
  assert.doesNotMatch(txt, /runnervm/i);
  assert.ok((txt.match(/\[host\]/g) ?? []).length >= 8, txt);
  assert.ok(txt.includes('the runner holds this coin now (/positions)'), 'the bot\'s own line stays');
});

test('2180 (a) the bot\'s wording is kept only as an exact fragment between prose boundaries', () => {
  const glued = [
    'the runner holds this coin now.local', 'xthe runner holds this coin now', 'the runner holds this coin now-x',
    '∕the runner holds this coin now∕', 'the runner holds this coin now＠box', 'the runner holds this coin', 'The Runner holds this coin now (/positions)',
    "runner's own coins instead", "the runner's own coins instead_2", 'data, not advice.lan', 'Xdata, not advice',
  ];
  for (const line of glued) {
    const [out] = finalizeReply([line], ['runner', 'data']);
    assert.doesNotMatch(out, /runner|data/i, `${line} -> ${out}`);
  }
  const [ok] = finalizeReply(['PAPER · TOP 1 · no live screener here; the runner\'s own coins instead (0s old) · data, not advice'], ['runner', 'data']);
  assert.equal(ok, 'PAPER · TOP 1 · no live screener here; the runner\'s own coins instead (0s old) · data, not advice');
});

test('2180 a name that is not one of the bot\'s words is hidden everywhere, as before (no change for real host names)', () => {
  const names = ['build-box-7781.local', 'build-box-7781', 'tester-account', 'trader'];
  const [a] = finalizeReply(['BUILD-BOX-7781 · tester-account · Trader · the runner holds this coin now (/positions)'], names);
  assert.equal(a, '[host] · [host] · [host] · the runner holds this coin now (/positions)');
  const [b] = finalizeReply(['xbuild-box-7781y trader-x Tester-Accounts'], names);
  assert.equal(b, 'x[host]y [host]-x [host]s');
});
