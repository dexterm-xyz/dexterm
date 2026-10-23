// task-1310 T1 — `dexterm wallet` command + the link store. Proves link persists ONLY the pubkey,
// unlink clears it, and the store refuses a non-address value. task-1571: there are no trade caps, no cap ledger,
// no probe / fast / trading wallet: dexterm holds no key; `wallet trading|fast|probe` refuse with the reason.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WalletLinkStore, KillSwitch, type WalletBridge } from '@dexterm/data';
import { runWallet, ttyKeypress, type WalletIo, type KeyInput } from '../src/wallet-cmd.ts';

const PK = 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH';

function io(): WalletIo & { out: string; err: string } {
  const o = { out: '', err: '', env: {} as NodeJS.ProcessEnv, stdin: undefined as WalletIo['stdin'],
    stdout: { write(s: string) { (o as { out: string }).out += s; } },
    stderr: { write(s: string) { (o as { err: string }).err += s; } } };
  return o;
}
/** Hermetic store + panic switch + ledger under one tmp dir, so no test touches ~/.dexterm. */
function tmpStore(): { store: WalletLinkStore; dir: string; killSwitch: KillSwitch } {
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-wallet-'));
  return { store: new WalletLinkStore(join(dir, 'wallet-link.json')), dir, killSwitch: new KillSwitch(join(dir, 'trading.panic')) };
}

test('link store: set/get/clear round trip, pubkey only', () => {
  const { store, dir } = tmpStore();
  try {
    assert.equal(store.get(), null);
    const rec = store.set(PK, { network: 'devnet', now: 123 });
    assert.equal(rec.publicKey, PK);
    assert.equal(store.get()?.publicKey, PK);
    assert.equal(store.get()?.network, 'devnet');
    assert.equal(store.clear(), true);
    assert.equal(store.get(), null);
    assert.equal(store.clear(), false, 'clearing twice is a no-op');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('link store: refuses to store a non-base58 value (never a key/seed by mistake)', () => {
  const { store, dir } = tmpStore();
  try {
    assert.throws(() => store.set('not a pubkey'), /base58/);
    assert.throws(() => store.set('0'.repeat(300)), /base58/);
    assert.equal(existsSync(store.path), false, 'nothing was written');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('wallet status: none linked; says dexterm holds no key and live trading is a Telegram bot of your choice', async () => {
  const { store, dir, killSwitch } = tmpStore();
  try {
    const o = io();
    const code = await runWallet(['status'], o, { store, killSwitch });
    assert.equal(code, 0);
    assert.match(o.out, /linked: \(none\)/);
    assert.match(o.out, /dexterm holds no key and signs nothing\. Live trading happens in the Telegram trading bot of your choice/);
    assert.doesNotMatch(o.out, /caps|per-trade|DRY-RUN|mainnet/i);
    store.set(PK);
    const l = io();
    await runWallet(['status'], l, { store, killSwitch });
    assert.match(l.out, /linked: HN7c…YWrH .* public key only, read-only/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('task-1571: wallet trading | fast | probe are gone and say why; the old caps flags change nothing', async () => {
  const { store, dir, killSwitch } = tmpStore();
  try {
    for (const sub of ['trading', 'fast', 'probe']) {
      const o = io();
      assert.equal(await runWallet([sub, 'create'], o, { store, killSwitch }), 2, sub);
      assert.match(o.err, new RegExp(`dexterm wallet ${sub}: removed in 0\\.1\\.7\\. dexterm holds no key and has no trading wallet`));
    }
    assert.equal(existsSync(join(dir, 'trading-wallet.json')) || existsSync(join(dir, 'fast-wallet.json')), false, 'no key file');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('wallet link: stores the bridge pubkey and reports the short form', async () => {
  const { store, dir } = tmpStore();
  try {
    const fakeBridge = { link: async () => ({ publicKey: PK, publicKeyBase64: 'x', provider: 'stub', roundTripMs: 1 }) } as unknown as WalletBridge;
    const o = io();
    const code = await runWallet(['link'], o, { store, bridge: fakeBridge });
    assert.equal(code, 0);
    assert.match(o.out, /linked: HN7c…YWrH/);
    assert.equal(store.get()?.publicKey, PK, 'the pubkey was persisted');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('wallet link: a bridge failure is a non-zero exit, nothing stored', async () => {
  const { store, dir } = tmpStore();
  try {
    const fakeBridge = { link: async () => { throw new Error('timed out'); } } as unknown as WalletBridge;
    const o = io();
    const code = await runWallet(['link'], o, { store, bridge: fakeBridge });
    assert.equal(code, 1);
    assert.match(o.err, /link failed: timed out/);
    assert.equal(store.get(), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('wallet unlink: clears a link', async () => {
  const { store, dir } = tmpStore();
  try {
    store.set(PK);
    const o = io();
    assert.equal(await runWallet(['unlink'], o, { store }), 0);
    assert.match(o.out, /unlinked/);
    assert.equal(store.get(), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('wallet: an unknown subcommand is a usage error', async () => {
  const o = io();
  const { store, dir } = tmpStore();
  try { assert.equal(await runWallet(['frobnicate'], o, { store }), 2); } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.match(o.err, /unknown subcommand/);
});

// ----------------------------------------------------------------- task-1310 round 2: panic / resume

/** A stand-in for process.stdin: `tty` true mimics a real terminal; `keys` are delivered on resume(). */
function fakeStdin(tty: boolean, keys: string[] = []): KeyInput & { raw: boolean | null } {
  let handler: ((c: Buffer | string) => void) | null = null;
  const s: KeyInput & { raw: boolean | null } = {
    isTTY: tty, raw: null,
    setRawMode(v: boolean) { s.raw = v; return s; },
    once(_e: 'data', cb: (c: Buffer | string) => void) { handler = cb; return s; },
    off() { handler = null; return s; },
    resume() { const k = keys.shift(); if (k !== undefined && handler) setImmediate(() => handler?.(Buffer.from(k))); return s; },
    pause() { return s; },
  };
  return s;
}
function panicSetup(): { dir: string; ks: KillSwitch } {
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-panic-'));
  return { dir, ks: new KillSwitch(join(dir, 'trading.panic')) };
}

test('wallet panic: engages the kill switch; status reports PANIC ENGAGED; no TTY needed', async () => {
  const { dir, ks } = panicSetup();
  const { store } = tmpStore();
  try {
    const o = io();
    assert.equal(await runWallet(['panic', '--reason', 'tests'], o, { store, killSwitch: ks }), 0);
    assert.match(o.out, /PANIC: autotrade and the paper agent desk halted \(tests\)/);
    assert.ok(ks.engaged(), 'kill-switch file written');
    const s = io();
    await runWallet(['status'], s, { store, killSwitch: ks });
    assert.match(s.out, /PANIC ENGAGED/);
    // panic twice is idempotent
    assert.equal(await runWallet(['panic'], io(), { store, killSwitch: ks }), 0);
    assert.equal(ks.engaged()?.reason, 'tests', 'the first reason is kept');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('wallet resume: refused without a real TTY (piped/scripted input cannot re-arm); still panicked', async () => {
  const { dir, ks } = panicSetup();
  const { store } = tmpStore();
  try {
    ks.engage('x');
    for (const stdin of [undefined, fakeStdin(false, ['y']), { isTTY: undefined, once() { return this; } } as unknown as KeyInput]) {
      const o = io(); o.stdin = stdin;
      assert.equal(await runWallet(['resume'], o, { store, killSwitch: ks }), 2);
      assert.match(o.err, /needs a real terminal keypress/);
      assert.ok(ks.engaged(), 'still panicked');
    }
    assert.equal(await ttyKeypress(fakeStdin(false, ['y']), 50), null, 'ttyKeypress itself refuses a non-TTY');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('wallet resume: a TTY keypress of Y clears the panic switch; any other key (or no key) aborts', async () => {
  const { dir, ks } = panicSetup();
  const { store } = tmpStore();
  try {
    ks.engage('x');
    const no = io(); no.stdin = fakeStdin(true, ['n']);
    assert.equal(await runWallet(['resume'], no, { store, killSwitch: ks }), 1);
    assert.match(no.out, /aborted; still panicked/);
    assert.ok(ks.engaged());
    const none = io(); none.stdin = fakeStdin(true, []);
    assert.equal(await runWallet(['resume'], none, { store, killSwitch: ks, keypressTimeoutMs: 30 }), 2);
    assert.match(none.err, /no keypress/);
    const yes = io(); const stdin = fakeStdin(true, ['y']); yes.stdin = stdin;
    assert.equal(await runWallet(['resume'], yes, { store, killSwitch: ks }), 0);
    assert.match(yes.out, /panic switch cleared/);
    assert.equal(ks.engaged(), null, 'kill switch released');
    assert.equal(stdin.raw, false, 'raw mode was turned on for the keypress and restored');
    const again = io(); again.stdin = fakeStdin(true, ['y']);
    assert.equal(await runWallet(['resume'], again, { store, killSwitch: ks }), 0);
    assert.match(again.out, /not engaged/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

