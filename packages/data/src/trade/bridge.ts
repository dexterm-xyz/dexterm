// dexterm T1 — local loopback wallet bridge (SPEC §6.5 Phantom bridge; extends the proven task-1290
// connect/sign round trip in research/popup-host). Phantom is a browser extension, so dexterm links a
// wallet by opening a tiny page in the user's browser that talks to window.solana and POSTs a RESULT
// back to a one-shot loopback server. dexterm never sees a private key, seed, or signing material
// beyond the proof the user produced.
//
// Security posture (mirrors research/popup-host/server/server.mjs §5):
//   * listens on 127.0.0.1 only; never 0.0.0.0 / ::. task-1368 (g): on a FIXED preferred port
//     (`WALLET_BRIDGE_PORT`, random only when it is busy) — Phantom remembers trust PER ORIGIN, and a
//     random port made every page a brand-new origin, so Phantom asked to connect every time.
//   * a single-use, random 32-byte TOKEN in the URL; a second use is refused (replay-proof).
//   * strict Host check on every request; strict Origin + JSON content-type + 16 KB body cap on POST.
//   * remote address must be loopback; anything else gets an empty 404.
//   * all JS/CSS inlined under a CSP nonce; CSP forbids remote content, inline handlers, eval, images.
//   * the server auto-closes after the first valid result OR after `timeoutMs` (default 120 s).
//   * the bridge is opened through the small `openBridge` interface so a popup-host lane can later swap
//     the default browser for a chromeless window WITHOUT this module depending on wry/tao/Electron.
//
// Crypto: node:crypto Ed25519 verify of the link proof (raw 32-byte pubkey -> SPKI DER). No key is
// generated, stored or logged here; dexterm keeps only the PUBLIC key.

import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Clock } from '../clock.ts';
import { systemClock } from '../clock.ts';
import { base58 } from '../sources/solana-rpc.ts';
import { verifyEd25519 } from './tx-decode.ts';

const TOKEN_TTL_MS = 120_000;

const MAX_BODY = 16 * 1024;
const LOOPBACK = new Set(['127.0.0.1', '::ffff:127.0.0.1', '::1']);

/** How the bridge page is shown to the user. Default: the OS default browser. A popup-host lane can swap it. */
export interface BridgeOpener {
  (url: string): void | Promise<void>;
}

function spawnOpener(target: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', target] : [target];
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
  child.on('error', () => { /* a headless box has no browser; the link just times out */ });
  child.unref();
}

/**
 * Open the bridge URL in the user's default browser. No wry/Electron dependency; keeps the bridge
 * portable. Round 2 (re-verify LOW): the single-use token is NOT passed on the `open` command line
 * (argv is readable by every local process via `ps`). Instead a mode-600 launcher page in a mode-700
 * temp dir redirects the browser to the URL; the file is removed shortly after. Set
 * `DEXTERM_BRIDGE_OPEN=argv` to fall back to passing the URL directly if a platform's default handler
 * for `.html` is not the browser.
 */
export const systemBrowserOpener: BridgeOpener = (url: string) => {
  if (process.env.DEXTERM_BRIDGE_OPEN === 'argv') { spawnOpener(url); return; }
  let dir: string;
  try {
    dir = mkdtempSync(join(tmpdir(), 'dexterm-bridge-')); // mkdtemp creates the dir mode 700
    const page = `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${esc(url)}">` +
      `<title>dexterm</title><script>location.replace(${JSON.stringify(url)})</script>` +
      `<p>Opening dexterm… <a href="${esc(url)}">continue</a></p>`;
    writeFileSync(join(dir, 'open.html'), page, { mode: 0o600 });
  } catch {
    spawnOpener(url); // could not stage a launcher; the argv path still works
    return;
  }
  spawnOpener(join(dir, 'open.html'));
  const t = setTimeout(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }, 20_000);
  if (typeof (t as { unref?: () => void }).unref === 'function') (t as { unref: () => void }).unref();
};

export interface WalletBridgeOptions {
  /** How to show the page; default opens the system browser. */
  open?: BridgeOpener;
  /** Auto-close / reject after this long. Default 120 s. */
  timeoutMs?: number;
  clock?: Clock;
  /**
   * Preferred loopback port (task-1368 (g)). Default `WALLET_BRIDGE_PORT`; `0` = random. When the
   * preferred port is busy the bridge falls back to a random one (Phantom then asks to connect once
   * more — the page connects first, so that is a prompt, never a 4100).
   */
  port?: number;
}

/**
 * The wallet bridge's preferred loopback port: `http://127.0.0.1:41291` is the ORIGIN Phantom stores
 * its trust for. Unassigned by IANA; the X login callback is 41287.
 */
export const WALLET_BRIDGE_PORT = 41291;

export interface LinkResult {
  /** base58 Solana address — the only thing dexterm persists. */
  publicKey: string;
  publicKeyBase64: string;
  provider: string;
  roundTripMs: number;
}

function b64url(buf: Buffer): string { return buf.toString('base64url'); }
function safeEq(a: string, b: string): boolean {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
/** Only a STRING is ever read off the untrusted body; anything else is the empty string (round 2 MEDIUM #3). */
function str(v: unknown): string { return typeof v === 'string' ? v : ''; }
function sanitize(s: unknown, n = 80): string { return str(s).replace(/[^\x20-\x7e]/g, '?').slice(0, n); }

const CSP = (port: number, nonce: string) =>
  `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; ` +
  `connect-src http://127.0.0.1:${port}; img-src 'none'; font-src 'none'; base-uri 'none'; ` +
  `form-action 'none'; frame-ancestors 'none'; object-src 'none'`;

const SEC_HEADERS = (port: number, nonce: string): Record<string, string> => ({
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'content-security-policy': CSP(port, nonce),
});

/** Escape untrusted values interpolated into the page HTML. */
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

/**
 * A one-shot loopback exchange: serve ONE page at `GET /<route>?t=<token>` and accept ONE result at
 * `POST /<route>/result`, then resolve and close. The page HTML is built with the CSP nonce. The
 * POST handler returns `{ done, error }`: `done:true` resolves the outer promise.
 */
function oneShot<T>(args: {
  route: string;
  /** `portNote` is non-empty when the preferred port was busy and the page is on a one-off port (task-1368 (g)). */
  page: (ctx: { port: number; nonce: string; token: string; portNote: string }) => string;
  onResult: (body: Record<string, unknown>) => { value?: T; error?: string };
  open: BridgeOpener;
  timeoutMs: number;
  clock: Clock;
  /** Preferred port; 0 = random. Busy → random (see `WalletBridgeOptions.port`). */
  preferredPort: number;
}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const token = b64url(randomBytes(32));
    let port = 0;
    let fellBack = false;       // the preferred port was busy; listening on a random one instead
    let used = false;           // the page token is single-use
    let resultTaken = false;    // the POST result is single-use (replay-proof)
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // task-1368 (g): with a FIXED port the next exchange is the SAME origin, and a browser (or node's
      // fetch) happily reuses a keep-alive connection to THIS server for it — which would answer 404
      // (unknown token) for the next page. Close the listener AND every connection, so the next page
      // can only ever reach the next server. (Same lesson as the X login callback server, task-1357.)
      try { server.close(); server.closeAllConnections(); } catch { /* ignore */ }
      fn();
    };

    const reject404 = (res: http.ServerResponse) => { res.writeHead(404, { 'content-length': '0', 'cache-control': 'no-store' }); res.end(); };
    const hostOk = (req: http.IncomingMessage) => req.headers.host === `127.0.0.1:${port}`;
    const loopbackOk = (req: http.IncomingMessage) => LOOPBACK.has(req.socket.remoteAddress ?? '');
    const originOk = (req: http.IncomingMessage) => req.headers.origin === `http://127.0.0.1:${port}`;

    const readBody = (req: http.IncomingMessage) => new Promise<string>((res2, rej2) => {
      let size = 0; const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => { size += c.length; if (size > MAX_BODY) { rej2(new Error('body-too-large')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => res2(Buffer.concat(chunks).toString('utf8')));
      req.on('error', rej2);
    });

    const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
      if (!loopbackOk(req) || !hostOk(req)) return reject404(res);
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

      if (req.method === 'GET' && url.pathname === `/${args.route}`) {
        const t = url.searchParams.get('t') ?? '';
        if (!safeEq(t, token) || used) return reject404(res);
        used = true;
        const nonce = b64url(randomBytes(16));
        res.writeHead(200, SEC_HEADERS(port, nonce));
        // task-1368 (g): tell the user on the page when this is NOT the usual origin — Phantom will
        // ask to connect once more, and its stored trust for the fixed port is untouched.
        const portNote = fellBack ? `the usual dexterm port 127.0.0.1:${args.preferredPort} was busy, so this page is on a one-off port (${port}). Phantom may ask you to connect once; that is expected.` : '';
        res.end(args.page({ port, nonce, token, portNote }));
        return;
      }

      if (req.method === 'POST' && url.pathname === `/${args.route}/result`) {
        if (!originOk(req)) return reject404(res);
        if (!/^application\/json/.test(req.headers['content-type'] ?? '')) { res.writeHead(415, { 'content-length': '0' }); res.end(); return; }
        let parsed: unknown;
        try { parsed = JSON.parse(await readBody(req)); } catch { res.writeHead(400, { 'content-length': '0' }); res.end(); return; }
        // DEFECT 7: `JSON.parse('null')` (and `123`, `"x"`, `[]`) parse WITHOUT throwing; reading `.t` off
        // them crashed the handler before the token check. Require a plain object.
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) { res.writeHead(400, { 'content-length': '0' }); res.end(); return; }
        const body = parsed as Record<string, unknown>;
        // Round 2 MEDIUM #3: never coerce the token field — `String({toString:1})` throws. Only a string
        // can match; anything else is '' and fails the comparison.
        if (!safeEq(str(body.t), token) || resultTaken) { res.writeHead(403, { 'content-length': '0' }); res.end(); return; }
        // The exchange is single-use from here on: a malformed or badly-signed first result BURNS it
        // (documented, accepted for round 2) and the user re-runs `dexterm wallet link`. This is the
        // conservative choice — an attacker who knows the token gets exactly one attempt, never a retry.
        resultTaken = true;
        const out = args.onResult(body);
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        res.end(JSON.stringify({ ok: out.error === undefined, error: out.error ?? null }));
        // Resolve (and close every connection) only once the page has its answer: `finish` now tears
        // the socket down, and the page's "✓ linked" line reads this response.
        if (out.error === undefined) {
          const done = () => finish(() => resolve(out.value as T));
          res.once('finish', done); res.once('close', done);
        }
        return;
      }

      return reject404(res);
    };

    // Round 2 MEDIUM #3: NO request body (or header, or handler bug) may crash the process. Anything
    // the handler throws — sync or async — is a 400 (or a dropped socket if headers already went out).
    const server = http.createServer((req, res) => {
      // task-1368 (g): a one-shot server wants NO keep-alive. With the fixed port the next exchange is
      // the same origin, and a client that pooled this connection would race our close with its next
      // request (a stale socket → "fetch failed", the page never loads). `Connection: close` on every
      // response tells the browser (and node's fetch) up front: do not reuse this socket.
      res.setHeader('connection', 'close');
      handle(req, res).catch(() => {
        try {
          if (!res.headersSent) { res.writeHead(400, { 'content-length': '0' }); res.end(); }
          else res.destroy();
        } catch { /* socket already gone */ }
      });
    });
    server.on('clientError', (_err, socket) => { try { socket.destroy(); } catch { /* ignore */ } });

    server.headersTimeout = 5000; server.requestTimeout = 10_000; server.keepAliveTimeout = 5000; server.maxHeadersCount = 40;
    const onListening = () => {
      port = (server.address() as { port: number }).port;
      const url = `http://127.0.0.1:${port}/${args.route}?t=${token}`;
      void Promise.resolve(args.open(url)).catch(() => { /* opener failure surfaces as a timeout */ });
    };
    // Registered ONCE, not as a listen() callback: a callback given to a listen() that fails with
    // EADDRINUSE stays attached, and the retry would then fire it twice — the page URL opened twice,
    // the second open burning the single-use token (found by the concurrent test files).
    server.once('listening', onListening);
    // task-1368 (g): the preferred port busy (another dexterm, a leftover bridge, anything) is not an
    // error — listen again on a random port, exactly the pre-1368 behaviour. Any other error rejects.
    server.on('error', (e: NodeJS.ErrnoException) => {
      if (!fellBack && args.preferredPort > 0 && (e.code === 'EADDRINUSE' || e.code === 'EACCES')) {
        fellBack = true;
        server.listen(0, '127.0.0.1');
        return;
      }
      finish(() => reject(e));
    });

    const timer = setTimeout(() => finish(() => reject(new Error(`wallet bridge timed out after ${args.timeoutMs} ms`))), args.timeoutMs);
    if (typeof (timer as { unref?: () => void }).unref === 'function') (timer as { unref: () => void }).unref();

    server.listen(args.preferredPort, '127.0.0.1');
  });
}

export class WalletBridge {
  private readonly open: BridgeOpener;
  private readonly timeoutMs: number;
  private readonly clock: Clock;
  private readonly port: number;

  constructor(opts: WalletBridgeOptions = {}) {
    this.open = opts.open ?? systemBrowserOpener;
    this.timeoutMs = opts.timeoutMs ?? TOKEN_TTL_MS;
    this.clock = opts.clock ?? systemClock;
    const p = opts.port ?? WALLET_BRIDGE_PORT;
    this.port = Number.isInteger(p) && p >= 0 && p <= 65535 ? p : WALLET_BRIDGE_PORT;
  }

  /** The port the bridge asks for (the origin Phantom remembers); 0 means a random port every time. */
  get preferredPort(): number { return this.port; }

  /** The challenge a wallet signs to prove ownership. Human-readable, never a transaction. */
  static challenge(nonce: string, port: number): string {
    return [
      'dexterm wants to link your Solana wallet.',
      '',
      'This signs a message only. It does NOT approve a transaction, move funds, or cost any fees.',
      '',
      `URI: http://127.0.0.1:${port}`,
      `Nonce: ${nonce}`,
      `Issued At: ${new Date().toISOString()}`,
    ].join('\n');
  }

  /**
   * Link a wallet: open the browser to a page that connects window.solana and signs a dexterm nonce,
   * verify the Ed25519 proof, and resolve with the PUBLIC key only. Never receives a private key.
   */
  link(): Promise<LinkResult> {
    const nonce = b64url(randomBytes(18));
    const started = this.clock.now();
    let servedChallenge = ''; // the exact text dexterm served; the signature must be over THIS.
    return oneShot<LinkResult>({
      route: 'link',
      open: this.open,
      timeoutMs: this.timeoutMs,
      clock: this.clock,
      preferredPort: this.port,
      page: ({ port, nonce: cspNonce, portNote }) => { servedChallenge = WalletBridge.challenge(nonce, port); return linkPage(port, cspNonce, servedChallenge, portNote); },
      onResult: (body) => {
        try {
          const pk = Buffer.from(str(body.publicKey), 'base64');
          const sig = Buffer.from(str(body.signature), 'base64');
          // Verify against the server-held challenge, never the value the page echoed back.
          const challenge = Buffer.from(servedChallenge, 'utf8');
          if (servedChallenge === '' || !verifyEd25519(pk, challenge, sig)) return { error: 'signature did not verify' };
          return {
            value: {
              publicKey: base58(pk),
              publicKeyBase64: pk.toString('base64'),
              provider: sanitize(body.provider ?? 'unknown', 24),
              roundTripMs: this.clock.now() - started,
            },
          };
        } catch (e) {
          return { error: `bad link result: ${sanitize(e instanceof Error ? e.message : e, 60)}` };
        }
      },
    });
  }

}

// --------------------------------------------------------------------------- inlined browser pages
// These run in the user's browser (real Phantom). The fake-Phantom e2e POSTs the result directly, so
// the page JS is exercised only in the manual run (scripts/). Untrusted values are escaped; the CSP
// blocks everything remote.

function linkPage(port: number, nonce: string, challenge: string, portNote = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dexterm · link wallet</title>
<style nonce="${nonce}">body{font:14px/1.5 -apple-system,system-ui,sans-serif;background:#07090d;color:#d7dbe0;margin:0;padding:2rem}
.card{max-width:640px;margin:auto;background:#0d1016;border:1px solid #1d2430;border-radius:12px;padding:1.5rem}
h1{font-size:1.1rem;color:#7fd1ff}pre{white-space:pre-wrap;background:#06080c;border:1px solid #1d2430;border-radius:8px;padding:.75rem;font-size:12px}
button{font:inherit;background:#153;border:1px solid #2a6;color:#cfe;border-radius:8px;padding:.5rem 1rem;cursor:pointer}
.ok{color:#5de28a}.bad{color:#ff6b6b}.warn{color:#e2b85d}.muted{color:#7a828e}</style></head><body><div class="card">
<h1>✦ dexterm · link wallet</h1>
<p>Your <b>dexterm</b> terminal opened this page on <code>127.0.0.1</code>. It asks your wallet to <b>sign a message</b> to prove ownership — no transaction, no funds, no approvals.</p>
<pre id="c">${esc(challenge)}</pre>${portNote ? `\n<p class="warn">${esc(portNote)}</p>` : ''}
<p id="p" class="warn">looking for a wallet…</p>
<p><button id="go" disabled>Connect &amp; sign</button> <span id="s"></span></p>
<p id="r"></p><p class="muted">Close this tab once the terminal shows <b>linked</b>.</p></div>
<script nonce="${nonce}">(()=>{'use strict';const $=i=>document.getElementById(i),PORT=${port},challenge=$('c').textContent;
const b64=u=>btoa(String.fromCharCode.apply(null,u));let prov=null,name='none';
function find(){if(window.phantom&&window.phantom.solana&&window.phantom.solana.isPhantom)return[window.phantom.solana,'phantom'];
if(window.solana&&window.solana.isPhantom)return[window.solana,'phantom'];if(window.solana&&window.solana.signMessage)return[window.solana,window.solana.isStubWallet?'stub':'solana'];return[null,'none'];}
function poll(n){[prov,name]=find();if(prov){$('p').textContent='wallet: '+name;$('p').className='ok';$('go').disabled=false;if(name==='stub')run();return;}
if(n>40){$('p').textContent='No Solana wallet found. Install Phantom or open this page in the browser that has it.';$('p').className='bad';return;}setTimeout(()=>poll(n+1),100);}
async function run(){$('go').disabled=true;$('s').textContent='connecting…';try{const res=await prov.connect();const pk=(res&&res.publicKey)||prov.publicKey;
const pkb=pk&&pk.toBytes?pk.toBytes():null;if(!pkb||pkb.length!==32)throw new Error('no 32-byte public key');
$('s').textContent='sign the message in your wallet';const sg=await prov.signMessage(new TextEncoder().encode(challenge),'utf8');const sig=(sg&&sg.signature)||sg;
if(!(sig instanceof Uint8Array)||sig.length!==64)throw new Error('no 64-byte signature');
const rp=await fetch('http://127.0.0.1:'+PORT+'/link/result',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({t:${JSON.stringify('__T__')},publicKey:b64(pkb),signature:b64(sig),challenge:challenge,provider:name})});
const j=await rp.json();if(j.ok){$('r').textContent='✓ linked. Return to dexterm.';$('r').className='ok';$('s').textContent='done';}else{$('r').textContent='✗ '+(j.error||'rejected');$('r').className='bad';$('go').disabled=false;}}
catch(e){$('r').textContent='✗ '+(e&&e.message||e);$('r').className='bad';$('s').textContent='';$('go').disabled=false;}}
$('go').addEventListener('click',run);poll(0);})();</script></body></html>`.replace('"__T__"', `new URLSearchParams(location.search).get('t')`);
}
