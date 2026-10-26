// task-1654 (0.2.0 card E): the executor reference kit (examples/executor) against dexterm's own channel classes.
// Every kit executor verifies the HMAC, dedupes by nonce, honours the TTL, writes a receipt dexterm accepts and a
// heartbeat, and is DRY RUN (the receipt says what it would have done). Loopback only; no wallet code in the kit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTestSignal, buildTradeSignal, signBody, signalLine, type TradeFireSignal } from '../src/signal.ts';
import { CommandChannel, JsonlChannel, WebhookChannel } from '../src/signal-channels.ts';
import { readReceipts, validateReceipt } from '../src/receipts.ts';
import { lastHeartbeat, validateHeartbeat } from '../src/executor-health.ts';

const KIT = fileURLToPath(new URL('../examples/executor/', import.meta.url));
const MINT = 'So1aNaMint11111111111111111111111111111111';
const SECRET = 'kit-test-secret-0123456789abcdef';
const home = () => mkdtempSync(join(tmpdir(), 'dexterm-1654-kit-'));

function trade(nonce: number, o: { now?: number; ttlSec?: number; accountId?: string; side?: 'buy' | 'sell' } = {}): TradeFireSignal {
  return buildTradeSignal({ side: o.side ?? 'buy', mint: MINT, symbol: 'PEPE', sizeUsd: 50, solUsd: 200, bookUsd: 1000, sellFraction: o.side === 'sell' ? 1 : null, exitReason: o.side === 'sell' ? 'trail' : null, priceUsd: 0.001, mcap: 1e6, liqUsd: 5e4, slippageBps: 300, maxImpactPct: 3 },
    { nonce, now: o.now ?? Date.now(), ttlSec: o.ttlSec ?? 60, runId: 'run-kit', accountId: o.accountId ?? 'main', strategy: { id: 'my-scalp', version: '1.0.0', hash: 'ab'.repeat(8) } });
}

function startWebhook(h: string, extra: string[] = []): Promise<{ port: number; stop: () => Promise<void>; log: () => string }> {
  const secretFile = join(h, 'secret');
  writeFileSync(secretFile, `${SECRET}\n`, { mode: 0o600 });
  const child = spawn(process.execPath, [join(KIT, 'webhook-executor.mjs'), '--account', 'main', '--port', '0', '--secret-file', secretFile, '--home', h, ...extra], { stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '';
  child.stdout.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`webhook kit did not start: ${buf}`)), 10_000);
    child.stdout.on('data', (c: string) => {
      buf += c;
      const m = /listening on http:\/\/127\.0\.0\.1:(\d+)\/signal/.exec(buf);
      if (m) { clearTimeout(to); resolve({ port: Number(m[1]), log: () => buf, stop: () => new Promise((r) => { child.once('exit', () => r()); child.kill('SIGTERM'); }) }); }
    });
    child.once('exit', (c) => { clearTimeout(to); reject(new Error(`exited ${c}: ${buf}`)); });
  });
}

test('webhook kit: HMAC checked, delivered = 200, a repeat = 409 (dexterm acks it), expired never acted on; dry-run receipts dexterm accepts; a heartbeat', async () => {
  const h = home();
  const w = await startWebhook(h);
  try {
    const ch = new WebhookChannel({ url: `http://127.0.0.1:${w.port}/signal`, secret: () => SECRET });
    const s1 = trade(1);
    assert.deepEqual(await ch.deliver(s1, signalLine(s1)), { ok: true });
    assert.deepEqual(await ch.deliver(s1, signalLine(s1)), { ok: true, duplicate: true }, 'at-least-once: the repeat is acked as a duplicate');
    const old = trade(2, { now: Date.now() - 120_000, ttlSec: 10 });
    assert.deepEqual(await ch.deliver(old, signalLine(old)), { ok: false, retry: false, why: 'http 410' }, 'past its TTL: never acted on, never retried');
    const bad = new WebhookChannel({ url: `http://127.0.0.1:${w.port}/signal`, secret: () => 'the-wrong-secret-xxxxxxxxxxxx' });
    const s3 = trade(3);
    assert.deepEqual(await bad.deliver(s3, signalLine(s3)), { ok: false, retry: false, why: 'http 401' });
    const other = trade(4, { accountId: 'other' });
    assert.equal((await ch.deliver(other, signalLine(other))).ok, false, 'another account is refused');
    const t = buildTestSignal({ nonce: 5, now: Date.now(), ttlSec: 60, runId: 'signal-test', accountId: 'main', strategy: { id: 'signal-test', version: '0.0.0', hash: '0'.repeat(16) } });
    assert.equal((await ch.deliver(t, signalLine(t))).ok, true);
    const rec = readReceipts(h);
    assert.equal(rec.invalid, 0);
    assert.deepEqual(rec.receipts.map((r) => [r.nonce, r.status]), [[1, 'rejected'], [5, 'rejected']], 'one receipt per acted signal; nothing for the repeat, the expired or the refused ones');
    assert.match(rec.receipts[0].reason ?? '', /^dry-run: would BUY 0\.25 SOL of PEPE/);
    assert.match(rec.receipts[1].reason ?? '', /test signal: received, never traded/);
    assert.equal(rec.receipts[0].executor, 'kit-webhook');
    const hb = lastHeartbeat(h);
    assert.ok(hb && hb.executor === 'kit-webhook' && hb.dryRun === true && hb.accountId === 'main');
  } finally { await w.stop(); }
});

test('webhook kit: the seen set survives a restart (no second act on a re-delivered signal)', async () => {
  const h = home();
  const s = trade(7);
  let w = await startWebhook(h);
  const ch = () => new WebhookChannel({ url: `http://127.0.0.1:${w.port}/signal`, secret: () => SECRET });
  try { assert.deepEqual(await ch().deliver(s, signalLine(s)), { ok: true }); } finally { await w.stop(); }
  w = await startWebhook(h);
  try { assert.deepEqual(await ch().deliver(s, signalLine(s)), { ok: true, duplicate: true }); } finally { await w.stop(); }
  assert.equal(readReceipts(h).receipts.length, 1);
});

test('signal-cmd kit: exit 0 acted, 3 duplicate, 2 expired or bad signature; receipts + a heartbeat', async () => {
  const h = home();
  const secretFile = join(h, 'secret');
  writeFileSync(secretFile, SECRET, { mode: 0o600 });
  const argv = [process.execPath, join(KIT, 'signal-cmd-executor.mjs'), '--account', 'main', '--secret-file', secretFile, '--home', h];
  const ch = new CommandChannel({ argv, secret: () => SECRET });
  const s = trade(1, { side: 'sell' });
  assert.deepEqual(await ch.deliver(s, signalLine(s)), { ok: true });
  assert.deepEqual(await ch.deliver(s, signalLine(s)), { ok: true, duplicate: true });
  const old = trade(2, { now: Date.now() - 120_000, ttlSec: 10 });
  assert.deepEqual(await ch.deliver(old, signalLine(old)), { ok: false, retry: false, why: 'rejected (exit 2)' });
  const unsigned = new CommandChannel({ argv, secret: () => null });
  const s3 = trade(3);
  assert.deepEqual(await unsigned.deliver(s3, signalLine(s3)), { ok: false, retry: false, why: 'rejected (exit 2)' }, 'with a secret file the kit refuses an unsigned signal');
  const r = readReceipts(h).receipts;
  assert.deepEqual(r.map((x) => x.nonce), [1]);
  assert.match(r[0].reason ?? '', /dry-run: would SELL 100% of PEPE .*trail/);
  assert.ok(validateReceipt(r[0]).ok);
  assert.equal(lastHeartbeat(h)?.executor, 'kit-signal-cmd');
  assert.match(readFileSync(join(h, 'autotrade', 'real', 'kit-cmd.log'), 'utf8'), /#2 expired: expired/);
});

test('JSONL tail kit: reads the stream (bare or signed envelopes), resumes from its offset, --require-hmac refuses bare lines', async () => {
  const h = home();
  const secretFile = join(h, 'secret');
  writeFileSync(secretFile, SECRET, { mode: 0o600 });
  const stream = join(h, 'autotrade', 'real', 'signals.jsonl');
  const signed = new JsonlChannel(stream, 'jsonl', { secret: () => SECRET });
  const run = (extra: string[] = []) => new Promise<string>((resolve) => {
    const c = spawn(process.execPath, [join(KIT, 'jsonl-tail-executor.mjs'), '--account', 'main', '--home', h, '--secret-file', secretFile, '--once', ...extra], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; c.stdout.setEncoding('utf8'); c.stdout.on('data', (d: string) => { out += d; }); c.once('exit', () => resolve(out));
  });
  const s1 = trade(1); const s2 = trade(2, { side: 'sell' });
  assert.deepEqual(await signed.deliver(s1, signalLine(s1)), { ok: true });
  const env = JSON.parse(readFileSync(stream, 'utf8').trim()) as { schema: string; signature: string; signal: string };
  assert.equal(env.schema, 'dexterm-trade-fire-envelope/1');
  assert.equal(env.signal, signalLine(s1), 'the envelope carries the exact signal line');
  assert.match(env.signature, /^t=\d+,v1=[0-9a-f]{64}$/);
  let out = await run(['--require-hmac']);
  assert.match(out, /#1 trade buy: dry-run: would BUY/);
  await signed.deliver(s2, signalLine(s2));
  // A bare (unsigned) line appended by anything else: refused under --require-hmac.
  const forged = trade(3);
  writeFileSync(stream, `${readFileSync(stream, 'utf8')}${signalLine(forged)}\n`);
  out = await run(['--require-hmac']);
  assert.ok(!/#1 /.test(out), 'resumed from its offset: #1 is not read again');
  assert.match(out, /#2 trade sell: dry-run: would SELL/);
  assert.match(out, /rejected: signature-missing/);
  assert.deepEqual(readReceipts(h).receipts.map((r) => r.nonce), [1, 2]);
  assert.equal(lastHeartbeat(h)?.executor, 'kit-jsonl-tail');
  // A signed stream with no secret yet: dexterm retries rather than writing an unsigned line.
  const noSecret = new JsonlChannel(join(h, 'x.jsonl'), 'jsonl', { secret: () => null });
  assert.equal((await noSecret.deliver(s1, signalLine(s1))).ok, false);
  assert.ok(!existsSync(join(h, 'x.jsonl')));
});

test('the kit holds no wallet code: no key, no signing, no chain call, no network beyond its own loopback listener', () => {
  const files = readdirSync(KIT);
  assert.deepEqual(files.filter((f) => f.endsWith('.mjs')).sort(), ['jsonl-tail-executor.mjs', 'kit.mjs', 'signal-cmd-executor.mjs', 'webhook-executor.mjs']);
  assert.ok(files.includes('README.md') && files.includes('telegram-bot-recipe.md'));
  for (const f of files.filter((x) => x.endsWith('.mjs'))) {
    const src = readFileSync(join(KIT, f), 'utf8');
    const code = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    assert.ok(!/@solana|tweetnacl|bs58|Keypair|secretKey|signTransaction|sendTransaction|sendRawTransaction|createSign|createPrivateKey|privateKey|mnemonic/i.test(code), `${f}: wallet-shaped code`);
    assert.ok(!/\bfetch\(|https?\.request|require\(|node:https|node:net\b|WebSocket/.test(code), `${f}: no outbound network`);
    const imports = [...code.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    assert.ok(imports.every((m) => m.startsWith('node:') || m === './kit.mjs'), `${f}: no dependencies (${imports.join(', ')})`);
  }
  assert.match(readFileSync(join(KIT, 'kit.mjs'), 'utf8'), /DRY RUN, always/);
  // The kit's HMAC check matches dexterm's signer byte for byte.
  return import(join(KIT, 'kit.mjs')).then((k: { verify: (s: string, h: string, b: string, n: number) => { ok: boolean } }) => {
    const now = Date.now();
    assert.equal(k.verify(SECRET, signBody(SECRET, 'body', now), 'body', now).ok, true);
    assert.equal(k.verify(SECRET, signBody(SECRET, 'body', now), 'b0dy', now).ok, false);
    assert.equal(k.verify(SECRET, signBody(SECRET, 'body', now - 400_000), 'body', now).ok, false, 'a stale signature');
    assert.ok(validateHeartbeat({ schema: 'dexterm-executor-heartbeat/1', at: now, executor: 'kit' }).ok);
  });
});
