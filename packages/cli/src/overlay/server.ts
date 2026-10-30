// dexterm — STREAMER OVERLAY page server (task-1427). Serves the OBS browser-source scenes on loopback with the
// popup host's security model (packages/popup/src/server.ts):
//   * listens on 127.0.0.1 only (a random port unless --port), never 0.0.0.0 / ::; the remote must be loopback;
//   * a scene URL carries a single-use TICKET (32 random bytes). OBS needs time to be pasted into, so its TTL is
//     longer than a popup's (10 min by default) — but it still buys exactly one page load;
//   * the page embeds a single-use WS TOKEN (30 s) accepted once for the WebSocket upgrade;
//   * strict Host check on every request (DNS-rebind guard), strict Origin check on the upgrade; no CORS header is
//     ever set; anything unknown or unauthorised gets an empty 404 and is reported as a probe;
//   * the page's JS/CSS are inlined under a per-page nonce CSP: no remote content, no eval, no inline handlers;
//     the only images are the PnL card PNG the socket delivers as a data: URL;
//   * the socket is OUTBOUND ONLY: the server never parses what a page sends. Every inbound text frame is counted
//     as dropped and ignored (pings are answered by the framing layer). There is no inbound control path: the
//     server is constructed with nothing it could control, it only pushes view models it is handed.
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { WsConn } from '@dexterm/agents';
import { OVERLAY_SCENES, type OverlayScene } from './model.ts';
import { renderOverlayPage, OVERLAY_THEMES, type OverlayThemeName } from './page.ts';

export type OverlayPage = OverlayScene | 'all';
export const OVERLAY_PAGES: readonly OverlayPage[] = [...OVERLAY_SCENES, 'all'];
export const OVERLAY_TICKET_TTL_MS = 10 * 60_000;
const WS_TOKEN_TTL_MS = 30_000;
const LOOPBACK = new Set(['127.0.0.1', '::ffff:127.0.0.1', '::1']);
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export type OverlayProbeReason = 'remote-not-loopback' | 'bad-host' | 'bad-origin' | 'bad-ticket' | 'bad-ws-token' | 'bad-ws-handshake' | 'unknown-route';
export type OverlayServerEvent =
  | { ev: 'probe.rejected'; reason: OverlayProbeReason; method: string; path: string }
  | { ev: 'page.served'; page: OverlayPage }
  | { ev: 'viewer.connected'; page: OverlayPage }
  | { ev: 'viewer.closed'; page: OverlayPage }
  | { ev: 'viewer.dropped'; page: OverlayPage };

export interface OverlayServerOptions {
  /** Fixed port (loopback only); default random. */
  port?: number;
  ticketTtlMs?: number;
  onEvent?: (ev: OverlayServerEvent) => void;
  now?: () => number;
}

interface Ticket { page: OverlayPage; theme: OverlayThemeName; exp: number }
interface WsToken { page: OverlayPage; exp: number }
interface Viewer { page: OverlayPage; conn: WsConn }

export interface OverlayServer {
  readonly port: number;
  readonly origin: string;
  /** Mint a single-use ticket for one scene page; returns its loopback URL. */
  issueTicket(page: OverlayPage, theme?: OverlayThemeName): string;
  /** Push a scene's view model to every viewer showing it (its own page or 'all'). Keeps it for late joiners. */
  push(scene: OverlayScene, view: unknown): void;
  readonly viewers: number;
  /** Inbound frames ignored because the socket is outbound-only. */
  readonly dropped: number;
  close(): Promise<void>;
}

function safeEq(a: string, b: string): boolean {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
const sanitize = (s: unknown, n = 80): string => String(s ?? '').replace(/[^\x20-\x7e]/g, '?').slice(0, n);

export async function createOverlayServer(opts: OverlayServerOptions = {}): Promise<OverlayServer> {
  const onEvent = opts.onEvent ?? (() => {});
  const now = opts.now ?? (() => Date.now());
  const ttl = Math.max(1000, opts.ticketTtlMs ?? OVERLAY_TICKET_TTL_MS);
  const tickets = new Map<string, Ticket>();
  const wsTokens = new Map<string, WsToken>();
  const viewers = new Set<Viewer>();
  const latest = new Map<OverlayScene, unknown>();
  let dropped = 0;
  let port = 0;

  const probe = (req: IncomingMessage, reason: OverlayProbeReason): void => onEvent({ ev: 'probe.rejected', reason, method: req.method ?? '', path: sanitize((req.url ?? '').replace(/([?&](p|t)=)[^&]*/g, '$1…')) });
  const reject = (req: IncomingMessage, res: ServerResponse, reason: OverlayProbeReason): void => {
    probe(req, reason);
    res.writeHead(404, { 'content-length': '0', 'cache-control': 'no-store' });
    res.end();
  };
  const baseChecks = (req: IncomingMessage): OverlayProbeReason | null => {
    if (!LOOPBACK.has(req.socket.remoteAddress ?? '')) return 'remote-not-loopback';
    if (req.headers.host !== `127.0.0.1:${port}`) return 'bad-host';
    return null;
  };
  const sweep = (): void => {
    const t = now();
    for (const [k, v] of tickets) if (v.exp < t) tickets.delete(k);
    for (const [k, v] of wsTokens) if (v.exp < t) wsTokens.delete(k);
  };

  const server = http.createServer((req, res) => {
    const bad = baseChecks(req);
    if (bad) return reject(req, res, bad);
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (req.method === 'GET' && url.pathname.startsWith('/overlay/')) {
      sweep();
      const page = url.pathname.slice('/overlay/'.length) as OverlayPage;
      const p = url.searchParams.get('p') ?? '';
      const key = [...tickets.keys()].find((k) => safeEq(k, p));
      const t = key ? tickets.get(key) : undefined;
      if (!key || !t || t.exp < now() || t.page !== page || !OVERLAY_PAGES.includes(page)) return reject(req, res, 'bad-ticket');
      tickets.delete(key); // single use: a reload or a copied URL is refused
      const wsToken = randomBytes(32).toString('base64url');
      wsTokens.set(wsToken, { page, exp: now() + WS_TOKEN_TTL_MS });
      const nonce = randomBytes(16).toString('base64url');
      const html = renderOverlayPage({ page, theme: t.theme, nonce, wsUrl: `ws://127.0.0.1:${port}/ws?t=${wsToken}` });
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
        'cross-origin-opener-policy': 'same-origin',
        'cross-origin-resource-policy': 'same-origin',
        'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
        'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src ws://127.0.0.1:${port}; img-src data:; font-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'`,
      });
      onEvent({ ev: 'page.served', page });
      return res.end(html);
    }
    return reject(req, res, 'unknown-route');
  });

  server.on('upgrade', (req, socket) => {
    const fail = (reason: OverlayProbeReason): void => {
      probe(req, reason);
      try { socket.write('HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n'); } catch { /* gone */ }
      socket.destroy();
    };
    const bad = baseChecks(req);
    if (bad) return fail(bad);
    if (req.headers.origin !== `http://127.0.0.1:${port}`) return fail('bad-origin');
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (url.pathname !== '/ws') return fail('unknown-route');
    sweep();
    const tok = url.searchParams.get('t') ?? '';
    const key = [...wsTokens.keys()].find((k) => safeEq(k, tok));
    const entry = key ? wsTokens.get(key) : undefined;
    if (!key || !entry || entry.exp < now()) return fail('bad-ws-token');
    wsTokens.delete(key);
    if (String(req.headers['sec-websocket-version']) !== '13' || !req.headers['sec-websocket-key']) return fail('bad-ws-handshake');
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + WS_GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const viewer: Viewer = { page: entry.page, conn: new WsConn(socket, req.socket.remoteAddress ?? '') };
    // Outbound only: whatever a page sends is never parsed, never forwarded, never acted on.
    viewer.conn.onMessage = () => { dropped++; onEvent({ ev: 'viewer.dropped', page: viewer.page }); };
    viewer.conn.onClose = () => { viewers.delete(viewer); onEvent({ ev: 'viewer.closed', page: viewer.page }); };
    viewers.add(viewer);
    onEvent({ ev: 'viewer.connected', page: viewer.page });
    viewer.conn.send({ type: 'hello', protocol: 'dexterm-overlay/1', page: viewer.page });
    for (const [scene, view] of latest) if (viewer.page === 'all' || viewer.page === scene) viewer.conn.send({ type: 'view', scene, view });
  });

  server.headersTimeout = 5000; server.requestTimeout = 10_000; server.keepAliveTimeout = 5000; server.maxHeadersCount = 40;
  await new Promise<void>((resolve, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(opts.port ?? 0, '127.0.0.1', () => { server.off('error', rejectListen); resolve(); });
  });
  port = (server.address() as { port: number }).port;

  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    issueTicket(page, theme = 'cyberspace') {
      if (!OVERLAY_PAGES.includes(page)) throw new Error(`unknown overlay scene ${JSON.stringify(page)} (one of ${OVERLAY_PAGES.join(', ')})`);
      if (!(theme in OVERLAY_THEMES)) throw new Error(`unknown overlay theme ${JSON.stringify(theme)} (one of ${Object.keys(OVERLAY_THEMES).join(', ')})`);
      sweep();
      const ticket = randomBytes(32).toString('base64url');
      tickets.set(ticket, { page, theme, exp: now() + ttl });
      return `http://127.0.0.1:${port}/overlay/${page}?p=${ticket}`;
    },
    push(scene, view) {
      latest.set(scene, view);
      for (const v of viewers) if (v.page === 'all' || v.page === scene) v.conn.send({ type: 'view', scene, view });
    },
    get viewers() { return viewers.size; },
    get dropped() { return dropped; },
    close() {
      for (const v of [...viewers]) v.conn.close(1001);
      viewers.clear();
      return new Promise<void>((r) => server.close(() => r()));
    },
  };
}
