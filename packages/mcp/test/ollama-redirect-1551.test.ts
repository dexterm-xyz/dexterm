// task-1551: the local engine never follows a redirect. A configured Ollama host that answers 3xx must not make
// dexterm re-send the prompt (screen context, tool results) to another host: every call surfaces as an
// 'unreachable' OllamaError flagged `redirect`, and the other host gets nothing. Port of the verifier's A7.
// Servers on 127.0.0.1 only; no model, no external network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { OllamaClient, OllamaError, REDIRECT_REFUSED, parseOllamaHost, probeModel, runToolLoop, type OllamaHost } from '../src/engine/index.ts';

interface Hit { method: string; path: string; body: string }

async function listen(s: http.Server): Promise<string> {
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}
const shut = (s: http.Server): Promise<void> => new Promise<void>((r) => { s.closeAllConnections?.(); s.close(() => r()); });

/** The other host: answers like Ollama and records every hit. */
async function sink(): Promise<{ url: string; hits: Hit[]; close: () => Promise<void> }> {
  const hits: Hit[] = [];
  const s = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      hits.push({ method: req.method ?? '', path: req.url ?? '', body: b });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'qwen3:8b' }], version: 'x', capabilities: ['tools'], message: { role: 'assistant', content: 'from the other host' }, done: true }));
    });
  });
  return { url: await listen(s), hits, close: () => shut(s) };
}

/** The configured host: answers every request with `status` + Location on the other host. */
async function redirector(status: number, to: string): Promise<{ url: string; close: () => Promise<void> }> {
  const s = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(status, { location: `${to}${req.url}` }); res.end(); }); });
  return { url: await listen(s), close: () => shut(s) };
}

const host = (u: string): OllamaHost => parseOllamaHost(u) as OllamaHost;
const isRedirect = (e: unknown): boolean => e instanceof OllamaError && e.kind === 'unreachable' && e.redirect === true && e.message.includes(REDIRECT_REFUSED);

test('1551 A7: a 307 from the configured host never re-POSTs the prompt to another host (production fetch)', async () => {
  const other = await sink();
  const r = await redirector(307, other.url);
  try {
    const client = new OllamaClient({ host: host(r.url) }); // production default: global fetch
    await assert.rejects(client.chat({ model: 'qwen3:8b', messages: [{ role: 'user', content: 'SECRET SCREEN CONTEXT' }] }), isRedirect);
    await assert.rejects(client.chat({ model: 'qwen3:8b', messages: [{ role: 'user', content: 'SECRET SCREEN CONTEXT' }] }, { onDelta: () => {} }), isRedirect);
    assert.deepEqual(other.hits, [], 'the other host got nothing');
  } finally { await other.close(); await r.close(); }
});

test('1551: every redirect status on every endpoint is refused; nothing reaches the other host', async () => {
  const other = await sink();
  try {
    for (const status of [301, 302, 303, 307, 308]) {
      const r = await redirector(status, other.url);
      try {
        const client = new OllamaClient({ host: host(r.url) });
        await assert.rejects(client.version(), isRedirect, `${status} version`);
        await assert.rejects(client.tags(), isRedirect, `${status} tags`);
        await assert.rejects(client.show('qwen3:8b'), isRedirect, `${status} show`);
        await assert.rejects(client.chat({ model: 'qwen3:8b', messages: [{ role: 'user', content: 'SECRET' }] }), isRedirect, `${status} chat`);
        await assert.rejects(runToolLoop({ client, model: 'qwen3:8b', messages: [{ role: 'user', content: 'SECRET' }], tools: [], allowed: [], callTool: async () => '{}' }), isRedirect, `${status} loop`);
        const p = await probeModel(client, 'qwen3:8b', { numCtx: 8192, json: true });
        assert.equal(p.reachable, false);
        assert.equal(p.redirect, true, `${status} probe flags the redirect`);
        assert.match(p.error ?? '', /redirect/);
      } finally { await r.close(); }
    }
    assert.deepEqual(other.hits, [], 'the other host got nothing');
  } finally { await other.close(); }
});

test('1551: the client asks fetch for redirect "error"; a fetch that ignores it and returns a 3xx or a redirected answer is still refused', async () => {
  const other = await sink();
  const r = await redirector(307, other.url);
  try {
    const seen: Array<string | undefined> = [];
    const spy = new OllamaClient({ host: host(r.url), fetch: (u, init) => { seen.push(init?.redirect); return fetch(u, init); } });
    await assert.rejects(spy.version(), isRedirect);
    assert.deepEqual(seen, ['error']);

    const manual = new OllamaClient({ host: host(r.url), fetch: (u, init) => fetch(u, { ...init, redirect: 'manual' }) });
    await assert.rejects(manual.chat({ model: 'qwen3:8b', messages: [{ role: 'user', content: 'SECRET' }] }), isRedirect);
    assert.deepEqual(other.hits, []);

    // A fetch that followed anyway: the answer from the other host is never used.
    const follow = new OllamaClient({ host: host(r.url), fetch: (u, init) => fetch(u, { ...init, redirect: 'follow' }) });
    await assert.rejects(follow.version(), isRedirect);
  } finally { await other.close(); await r.close(); }
});

test('1551: a plain connection failure is still a normal unreachable (no redirect flag)', async () => {
  const s = http.createServer();
  const url = await listen(s);
  await shut(s);
  const client = new OllamaClient({ host: host(url), metaTimeoutMs: 2000 });
  await assert.rejects(client.version(), (e: unknown) => e instanceof OllamaError && e.kind === 'unreachable' && !e.redirect && /cannot reach Ollama/.test(e.message));
});
