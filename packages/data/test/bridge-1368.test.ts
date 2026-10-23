// task-1368 (g) — the wallet bridge listens on a FIXED preferred loopback port (WALLET_BRIDGE_PORT), the origin
// Phantom stores its trust for; a busy port falls back to a random one, never an error. task-1571: the bridge only
// LINKS a wallet (a sign-a-message proof, public key only); the transaction sign page left with the live ticket.
// No real wallet, no network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import vm from 'node:vm';
import { WalletBridge, WALLET_BRIDGE_PORT } from '../src/trade/bridge.ts';

const originHeaders = (url: string) => ({ 'content-type': 'application/json', origin: new URL(url).origin });

function urlCapture(): { open: (url: string) => void; url: Promise<string> } {
  let resolve!: (u: string) => void;
  const url = new Promise<string>((r) => { resolve = r; });
  return { open: (u) => resolve(u), url };
}

/** A loopback port that is free right now (bind 0, read, close). */
async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
  });
}
/** Hold a loopback port so the bridge's preferred one is busy. */
async function hold(port: number): Promise<() => Promise<void>> {
  const s = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  await new Promise<void>((r) => s.listen(port, '127.0.0.1', r));
  return () => new Promise<void>((r) => s.close(() => r()));
}

const swallow = (p: Promise<unknown>) => p.catch(() => undefined);

test('the default bridge asks for WALLET_BRIDGE_PORT (a fixed origin for Phantom), and the port is a sane constant', () => {
  const b = new WalletBridge({ open: () => { /* never opened */ } });
  assert.equal(b.preferredPort, WALLET_BRIDGE_PORT);
  assert.ok(WALLET_BRIDGE_PORT > 1024 && WALLET_BRIDGE_PORT < 65536);
  assert.notEqual(WALLET_BRIDGE_PORT, 41287, 'not the X login callback port');
  // garbage port options fall back to the constant; 0 is honoured as "random".
  assert.equal(new WalletBridge({ port: -1 }).preferredPort, WALLET_BRIDGE_PORT);
  assert.equal(new WalletBridge({ port: 70000 }).preferredPort, WALLET_BRIDGE_PORT);
  assert.equal(new WalletBridge({ port: 1.5 }).preferredPort, WALLET_BRIDGE_PORT);
  assert.equal(new WalletBridge({ port: 0 }).preferredPort, 0);
});

test('a busy preferred port is not an error: the bridge falls back to a random port and still serves the page', async () => {
  const port = await freePort();
  const release = await hold(port);
  try {
    const cap = urlCapture();
    let opens = 0;
    const b = new WalletBridge({ timeoutMs: 400, port, open: (u) => { opens++; cap.open(u); } });
    const p = swallow(b.link());
    const u = new URL(await cap.url);
    assert.notEqual(u.port, String(port), 'fell back off the busy port');
    assert.notEqual(u.port, '0');
    const r = await fetch(u);
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, new RegExp(`PORT=${u.port}[,;]`), 'the page talks back to the port it was actually served from');
    assert.match(html, new RegExp(`<p class="warn">the usual dexterm port 127\\.0\\.0\\.1:${port} was busy, so this page is on a one-off port \\(${u.port}\\)\\. Phantom may ask you to connect once`), 'the page SAYS it fell back (task-1368 (g) spec)');
    await p;
    assert.equal(opens, 1, 'the page is opened exactly once after a fallback (a second open would burn the single-use token)');
  } finally { await release(); }
});

test('port 0 keeps the pre-1368 behaviour: a random port each time', async () => {
  const cap = urlCapture();
  const b = new WalletBridge({ timeoutMs: 200, port: 0, open: cap.open });
  const p = swallow(b.link());
  const u = new URL(await cap.url);
  assert.notEqual(u.port, String(WALLET_BRIDGE_PORT));
  assert.ok(Number(u.port) > 0);
  await p;
});

