// `dexterm dash` (task-1749): the loopback server and the static export of the strategy performance dashboard.
// Binds 127.0.0.1 only. GET/HEAD only. Serves four files from assets/dash plus /api/dash.json (recomputed at most every
// few seconds). A Host header outside the allow list is refused (DNS-rebinding guard: a web page cannot read the
// dashboard through a hostname that resolves to 127.0.0.1); a private proxy in front (e.g. `tailscale serve`) is
// allowed by naming its host with --allow-host. No external request is made or referenced: the page has no CDN, font
// or analytics URL, and the CSP forbids any.

import { createServer, type Server } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectDash, type DashData, type DashHome } from './data.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ASSET_DIR = resolve(HERE, '..', '..', 'assets', 'dash');
export const ASSETS: Record<string, string> = { '/': 'index.html', '/index.html': 'index.html', '/dash.css': 'dash.css', '/dash.js': 'dash.js', '/icon.svg': 'icon.svg' };
const TYPES: Record<string, string> = { html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', svg: 'image/svg+xml', json: 'application/json; charset=utf-8' };
export const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export interface DashOptions { homes: DashHome[]; books: string[]; baseline: string | null; allowHosts: string[]; cacheMs?: number }

/** Is this Host header one we serve? Loopback names on any port, plus the hosts allowed explicitly (with or without a port). */
export function hostAllowed(host: string | undefined, allow: string[]): boolean {
  if (!host) return false;
  const h = host.toLowerCase();
  const name = h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.replace(/:\d+$/, '');
  if (name === '127.0.0.1' || name === 'localhost' || name === '[::1]') return true;
  return allow.some((a) => { const x = a.toLowerCase(); return x === h || x === name; });
}

export function startDashServer(opts: DashOptions, port: number): Promise<Server> {
  let cache: { at: number; body: string } | null = null;
  const data = () => {
    const now = Date.now();
    if (!cache || now - cache.at > (opts.cacheMs ?? 5000)) cache = { at: now, body: JSON.stringify(collectDash({ homes: opts.homes, books: opts.books, baseline: opts.baseline, now })) };
    return cache.body;
  };
  const server = createServer((req, res) => {
    const base = { 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' };
    if (!hostAllowed(req.headers.host, opts.allowHosts)) { res.writeHead(421, { ...base, 'Content-Type': 'text/plain' }); res.end('misdirected request: this host name is not allowed (dexterm dash --allow-host NAME)\n'); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { ...base, Allow: 'GET, HEAD' }); res.end(); return; }
    const path = (req.url ?? '/').split('?')[0];
    try {
      if (path === '/api/dash.json') { const body = data(); res.writeHead(200, { ...base, 'Content-Type': TYPES.json }); res.end(req.method === 'HEAD' ? undefined : body); return; }
      const file = ASSETS[path];
      if (!file) { res.writeHead(404, { ...base, 'Content-Type': 'text/plain' }); res.end('not found\n'); return; }
      const body = readFileSync(join(ASSET_DIR, file));
      res.writeHead(200, { ...base, 'Content-Type': TYPES[file.split('.').pop()!] ?? 'application/octet-stream' }); res.end(req.method === 'HEAD' ? undefined : body);
    } catch (e) {
      res.writeHead(500, { ...base, 'Content-Type': 'text/plain' }); res.end(`dashboard error: ${String((e as Error)?.message ?? e).slice(0, 200)}\n`);
    }
  });
  return new Promise((ok, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', () => { server.off('error', fail); ok(server); }); });
}

/**
 * A static, read-only SNAPSHOT: the same page + the data as data.json (the page reads it instead of /api/dash.json and
 * shows "snapshot" with its time, no auto-refresh). `redactMints` drops the mints (coin symbols stay).
 */
export function exportSnapshot(d: DashData, outDir: string, { redactMints = false } = {}): string[] {
  mkdirSync(outDir, { recursive: true });
  const data = redactMints ? JSON.parse(JSON.stringify(d, (k, v) => (k === 'mint' ? null : v))) : d;
  const written: string[] = [];
  for (const f of new Set(Object.values(ASSETS))) {
    let body = readFileSync(join(ASSET_DIR, f), 'utf8');
    if (f === 'index.html') body = body.replace('content="api/dash.json"', 'content="data.json"').replace('data-mode="live"', 'data-mode="snapshot"');
    writeFileSync(join(outDir, f), body); written.push(f);
  }
  writeFileSync(join(outDir, 'data.json'), JSON.stringify({ ...data, snapshot: true })); written.push('data.json');
  writeFileSync(join(outDir, '_headers'), `/*\n  Content-Security-Policy: ${CSP}\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n`); written.push('_headers');
  return written;
}
