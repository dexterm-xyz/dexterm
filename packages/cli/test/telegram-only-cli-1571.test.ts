// task-1571 — the CLI side of "0.1.7 is Telegram-bot-only for live trading; dexterm holds no key". The removed
// commands say why and do nothing; `--help` tells the truth; the Telegram host is the user's OWN bot, starts only from
// explicit local config (a paired chat + a stored token) and always trades through the PAPER port; with no config it
// says what to run instead of guessing a bot.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Writable } from 'node:stream';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, HELP } from '../src/index.ts';
import { CONNECTORS_SCHEMA, FakeConnector, defaultTelegram, saveConnectors, simExecutor, validateStrategy, presetPath } from '@dexterm/autotrade';
import { startTelegramHost } from '../src/autotrade-cmd/telegram-host.ts';
import { readFileSync } from 'node:fs';

function fakeIo(env: NodeJS.ProcessEnv) {
  let out = '', err = '';
  const stdout = new Writable({ write(c, _e, cb) { out += c.toString(); cb(); } }) as unknown as NodeJS.WriteStream & { fd: 1 };
  const stderr = new Writable({ write(c, _e, cb) { err += c.toString(); cb(); } }) as unknown as NodeJS.WriteStream & { fd: 2 };
  Object.assign(stdout, { isTTY: false, columns: 120, rows: 40 });
  return { io: { stdout, stderr, stdin: { isTTY: false } as unknown as NodeJS.ReadStream & { fd: 0 }, env }, out: () => out, err: () => err };
}

test('1571 `dexterm live …` is gone: exit 2, it says dexterm holds no key and live trading is a Telegram bot of your choice, and writes nothing', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dexterm-1571-'));
  try {
    for (const argv of [['live'], ['live', 'signer'], ['live', 'caps', 'set'], ['live', 'buy', 'So11111111111111111111111111111111111111112', '--sol', '1'], ['live', 'yolo-check', 'yolo']]) {
      const h = fakeIo({ DEXTERM_HOME: home, HOME: home, DEXTERM_OFFLINE: '1', DEXTERM_NO_UPDATE_CHECK: '1' });
      assert.equal(await main(argv, h.io), 2, argv.join(' '));
      assert.match(h.err(), /dexterm live: not available\. dexterm never holds a key and never signs; live trading happens in the Telegram trading bot of your choice/);
    }
    for (const f of ['trading-wallet.json', 'fast-wallet.json', 'signer-caps.json', 'live.json']) assert.equal(existsSync(join(home, f)), false, f);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('1571 --help: no signer, no mainnet flags, the truth about keys and live trading', () => {
  assert.match(HELP, /dexterm never holds a key and never signs a transaction/);
  assert.match(HELP, /live trading happens in the Telegram trading bot of your choice/);
  assert.match(HELP, /--no-live/);
  for (const gone of [/live signer/i, /--mainnet/, /--max-usd/, /--trade-rpc/, /wallet trading/, /wallet fast/, /L on the ticket/, /Phantom signs/]) assert.doesNotMatch(HELP, gone, String(gone));
});

test('1571 the Telegram host starts only from explicit local config and always on the PAPER port', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dexterm-1571-tg-'));
  try {
    const exec = simExecutor(JSON.parse(readFileSync(presetPath('yolo'), 'utf8')).execution);
    const say = () => {};
    // nothing configured: off, quietly, and no bot is guessed
    const none = await startTelegramHost({ home, exec, say });
    assert.deepEqual(none, { ok: false, why: 'telegram is not set up (dexterm telegram setup)', quiet: true });
    // enabled but no paired chat: still off, and it says what to run
    const t = defaultTelegram(); t.enabled = true; t.secretStore = 'file';
    saveConnectors(home, { schema: CONNECTORS_SCHEMA, telegram: t } as never);
    const unpaired = await startTelegramHost({ home, exec, say });
    assert.equal(unpaired.ok, false);
    assert.match((unpaired as { why: string }).why, /dexterm telegram setup/);
    // paired but the token is missing from the secret store: refused with the reason
    t.allow = [{ senderId: '424242', chatId: '424242', tiers: ['notify', 'control', 'approve'], pairedAt: 1 }];
    saveConnectors(home, { schema: CONNECTORS_SCHEMA, telegram: t } as never);
    const noToken = await startTelegramHost({ home, exec, say, store: { get: () => null, set: () => {}, remove: () => {}, kind: 'file' } as never });
    assert.deepEqual(noToken, { ok: false, why: 'the bot token is missing from the secret store (dexterm telegram setup)', quiet: false });
    // configured: the host's port is the paper port, whatever the strategy
    const fake = new FakeConnector({ now: () => Date.now() });
    const up = await startTelegramHost({ home, exec, say, connector: fake, timers: false });
    assert.ok(up.ok);
    if (up.ok) {
      assert.equal(up.host.port.network, 'paper');
      const live = validateStrategy({ ...JSON.parse(readFileSync(presetPath('yolo'), 'utf8')), id: 'my-yolo', mode: 'live' });
      assert.ok(live.ok);
      if (live.ok) {
        up.host.attach('run-1571', live.strategy, exec);
        assert.equal(up.host.port.entryBlock(), 'live-approval-port-not-installed', 'a chat approval never releases anything for a non-paper strategy');
      }
      await up.host.stop();
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});
