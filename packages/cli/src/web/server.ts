// dexterm — the Strategy Builder web server (task-2170). A SEPARATE server from the spectator stream and the overlay
// (it never touches their sockets). stdlib http only:
//   * binds 127.0.0.1 on a free port; the remote must be loopback; Host must be exactly 127.0.0.1:<port>;
//   * GET /?t=<ticket> spends a single-use ticket (2 min) and answers with an HttpOnly SameSite=Strict session cookie and a
//     303 to / (the ticket leaves the address bar); one session at a time (a new ticket ends the old one);
//   * every POST needs the session cookie, Origin http://127.0.0.1:<port>, a JSON body (≤ 64 KB) and the session's CSRF
//     token in the x-dexterm-csrf header (compared in constant time); chat, launch, backtest and change routes are
//     rate-limited;
//   * the page is one document with its JS/CSS inlined under a per-response nonce CSP (no remote content, no eval, no
//     inline handlers); every JSON body and chat event passes webRedact; anything unknown is an empty 404.
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { CSRF_HEADER, RateLimiter, WEB_RATE_LIMITS, WebAuth, cookieValue, hostOk, isLoopbackRemote, originOk, sessionCookie, type WebSession } from './security.ts';
import { WebApi, findRoute, type WebApiOpts } from './api.ts';
import { WebChat, type RunTurn, type WebChatEvent } from './chat.ts';
import { webRedact } from './redact.ts';
import { renderWebPage } from './page.ts';

const BODY_MAX = 64 * 1024;

export type WebProbeReason = 'remote-not-loopback' | 'bad-host' | 'bad-origin' | 'bad-ticket' | 'no-session' | 'bad-csrf' | 'bad-body' | 'rate-limited' | 'unknown-route';
export interface WebServerEvent { ev: 'probe.rejected' | 'session.started' | 'route'; reason?: WebProbeReason; method?: string; path?: string }

export interface WebServerOptions extends Omit<WebApiOpts, 'env'> {
  env: NodeJS.ProcessEnv;
  port?: number;
  ticketTtlMs?: number;
  onEvent?: (ev: WebServerEvent) => void;
  /** Tests: the chat's analyst turn (a stub; no Claude spend). */
  runTurn?: RunTurn;
  version?: string;
}

export interface WebServer {
  readonly port: number;
  readonly origin: string;
  /** A fresh single-use URL (http://127.0.0.1:<port>/?t=<ticket>). */
  issueUrl(): string;
  readonly api: WebApi;
  close(): Promise<void>;
}

const SEC_HEADERS = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), clipboard-read=()',
} as const;

export const webCsp = (nonce: string): string => `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src data:; font-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'`;

export async function createWebServer(o: WebServerOptions): Promise<WebServer> {
  const onEvent = o.onEvent ?? (() => {});
  const auth = new WebAuth({ ...(o.now ? { now: o.now } : {}), ...(o.ticketTtlMs ? { ticketTtlMs: o.ticketTtlMs } : {}) });
  const limiter = new RateLimiter(WEB_RATE_LIMITS, o.now);
  const api = new WebApi(o);
  let port = 0;
  let chat: { session: WebSession; chat: WebChat } | null = null;
  let stream: ServerResponse | null = null;

  const pushEvent = (ev: WebChatEvent): void => { if (stream && !stream.writableEnded) stream.write(`data: ${JSON.stringify(ev)}\n\n`); };
  const chatFor = (s: WebSession): WebChat => {
    if (!chat || chat.session !== s) chat = { session: s, chat: new WebChat({ home: api.home, chatId: s.chatId, env: o.env, emit: pushEvent, ...(o.runTurn ? { run: o.runTurn } : {}) }) };
    return chat.chat;
  };

  const sanitize = (s: string): string => s.replace(/([?&]t=)[^&]*/g, '$1…').replace(/[^\x20-\x7e]/g, '?').slice(0, 80);
  const reject = (req: IncomingMessage, res: ServerResponse, reason: WebProbeReason, status = 404): void => {
    onEvent({ ev: 'probe.rejected', reason, method: req.method ?? '', path: sanitize(req.url ?? '') });
    res.writeHead(status, { ...SEC_HEADERS, 'content-length': '0' });
    res.end();
  };
  const json = (res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void => {
    const text = JSON.stringify(webRedact(body));
    res.writeHead(status, { ...SEC_HEADERS, 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), ...extra });
    res.end(text);
  };
  const readBody = (req: IncomingMessage): Promise<Record<string, unknown> | null> => new Promise((resolve) => {
    if (!/^application\/json(;|$)/i.test(String(req.headers['content-type'] ?? ''))) { resolve(null); req.resume(); return; }
    let n = 0; const chunks: Buffer[] = []; let done = false;
    req.on('data', (c: Buffer) => { n += c.length; if (n > BODY_MAX) { if (!done) { done = true; resolve(null); } req.destroy(); return; } chunks.push(c); });
    req.on('end', () => { if (done) return; done = true; try { const j = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); resolve(j && typeof j === 'object' && !Array.isArray(j) ? j : null); } catch { resolve(null); } });
    req.on('error', () => { if (!done) { done = true; resolve(null); } });
  });

  const server = http.createServer(async (req, res) => {
    if (!isLoopbackRemote(req.socket.remoteAddress)) return reject(req, res, 'remote-not-loopback');
    if (!hostOk(req.headers.host, port)) return reject(req, res, 'bad-host');
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const method = req.method ?? '';

    if (method === 'GET' && url.pathname === '/') {
      const t = url.searchParams.get('t');
      if (t !== null) {
        const s = auth.exchange(t);
        if (!s) return reject(req, res, 'bad-ticket', 403);
        chat = null;
        if (stream) { try { stream.end(); } catch { /* gone */ } stream = null; }
        onEvent({ ev: 'session.started' });
        res.writeHead(303, { ...SEC_HEADERS, location: '/', 'set-cookie': sessionCookie(s.token), 'content-length': '0' });
        return res.end();
      }
      const s = auth.check(cookieValue(req.headers.cookie));
      if (!s) {
        onEvent({ ev: 'probe.rejected', reason: 'no-session', method, path: '/' });
        const msg = 'This page opens from the one-time link `dexterm autotrade web` prints (press n there for a fresh one).';
        res.writeHead(403, { ...SEC_HEADERS, 'content-type': 'text/plain; charset=utf-8' });
        return res.end(msg);
      }
      const nonce = randomBytes(16).toString('base64url');
      const html = renderWebPage({ nonce, csrf: s.csrf, version: o.version ?? '' });
      res.writeHead(200, { ...SEC_HEADERS, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': webCsp(nonce) });
      return res.end(html);
    }

    if (!url.pathname.startsWith('/api/')) return reject(req, res, 'unknown-route');
    const s = auth.check(cookieValue(req.headers.cookie));
    if (!s) return reject(req, res, 'no-session', 401);

    if (method === 'GET' && url.pathname === '/api/chat/stream') {
      if (stream) { try { stream.end(); } catch { /* gone */ } }
      res.writeHead(200, { ...SEC_HEADERS, 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive' });
      res.write(': dexterm web chat\n\n');
      stream = res;
      const ping = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 20_000);
      ping.unref?.();
      req.on('close', () => { clearInterval(ping); if (stream === res) stream = null; });
      return;
    }

    const route = findRoute(method, url.pathname);
    if (!route) return reject(req, res, 'unknown-route');
    let body: Record<string, unknown> = {};
    if (method === 'POST') {
      if (!originOk(req.headers.origin as string | undefined, port)) return reject(req, res, 'bad-origin', 403);
      if (!auth.csrfOk(s, req.headers[CSRF_HEADER])) return reject(req, res, 'bad-csrf', 403);
      const b = await readBody(req);
      if (!b) return reject(req, res, 'bad-body', 400);
      body = b;
      if (route.limit && !limiter.take(route.limit)) { onEvent({ ev: 'probe.rejected', reason: 'rate-limited', method, path: url.pathname }); return json(res, 429, { error: 'too many requests: wait a minute' }); }
    }
    onEvent({ ev: 'route', method, path: url.pathname });
    try {
      const out = await route.run(api, { body, query: url.searchParams, chat: chatFor(s), chatId: s.chatId });
      return json(res, 200, out);
    } catch (e) {
      return json(res, 500, { error: String((e as Error).message ?? e).slice(0, 300) });
    }
  });

  server.headersTimeout = 5000; server.requestTimeout = 60_000; server.keepAliveTimeout = 5000; server.maxHeadersCount = 40;
  await new Promise<void>((resolve, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(o.port ?? 0, '127.0.0.1', () => { server.off('error', rejectListen); resolve(); });
  });
  port = (server.address() as { port: number }).port;

  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    api,
    issueUrl: () => `http://127.0.0.1:${port}/?t=${auth.issueTicket()}`,
    close: () => new Promise<void>((r) => { if (stream) { try { stream.end(); } catch { /* gone */ } } server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

