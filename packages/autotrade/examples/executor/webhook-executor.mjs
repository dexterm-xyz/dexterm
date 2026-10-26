#!/usr/bin/env node
// dexterm executor reference kit: the WEBHOOK receiver (task-1654). DRY RUN: logs what it would do; no wallet code.
//
//   node webhook-executor.mjs --account main [--port 8787] [--secret-file FILE] [--home DIR] [--heartbeat-sec 60]
//
// Then point dexterm at it:  dexterm autotrade signal channels --webhook http://127.0.0.1:8787/signal
// and prove the wiring:      dexterm autotrade signal test
//
// Answers: 200 acted (dry run) · 409 duplicate (dexterm counts it delivered) · 410 expired · 401 bad signature ·
// 400 anything else it will not act on. It binds 127.0.0.1 only. Ctrl-C stops it.

import { createServer } from 'node:http';
import { join } from 'node:path';
import { SeenStore, args, dextermHome, handle, heartbeat, readSecret, realDir } from './kit.mjs';

const a = args();
if (!a.account) { console.error('usage: node webhook-executor.mjs --account ID [--port 8787] [--secret-file FILE] [--home DIR]'); process.exit(2); }
const home = a.home || dextermHome();
const secret = readSecret(a['secret-file']);
const seen = new SeenStore(a.state || join(realDir(home), 'kit-webhook-seen.json'));
const name = String(a.name || 'kit-webhook').slice(0, 32);
const log = (s) => console.log(`[${new Date().toISOString()}] ${s}`);
const o = { accountId: a.account, secret, requireHmac: !!a['require-hmac'], seen, home, executor: name, log };

const server = createServer((req, res) => {
  if (req.method !== 'POST') { res.writeHead(405); res.end('POST only'); return; }
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (c) => { body += c; if (body.length > 64 * 1024) req.destroy(); });
  req.on('end', () => {
    const c = handle(body, { ...o, signature: req.headers['x-dexterm-signature'] ?? null, now: Date.now() });
    const code = c.verdict === 'act' ? 200 : c.verdict === 'duplicate' ? 409 : c.verdict === 'expired' ? 410 : /^signature/.test(c.why ?? '') ? 401 : 400;
    res.writeHead(code, { 'content-type': 'text/plain' });
    res.end(c.verdict);
  });
});

const beat = () => { try { heartbeat(home, { executor: name, accountId: a.account, lastNonce: seen.maxNonce || null }); } catch (e) { log(`heartbeat failed: ${e.message}`); } };
server.listen(Number(a.port ?? 8787), '127.0.0.1', () => {
  const port = server.address().port;
  log(`dexterm kit webhook executor (DRY RUN) listening on http://127.0.0.1:${port}/signal · account ${a.account} · HMAC ${secret ? 'checked' : 'NOT checked (no --secret-file)'}`);
  beat();
});
const timer = setInterval(beat, Math.max(5, Number(a['heartbeat-sec'] ?? 60)) * 1000);
const stop = () => { clearInterval(timer); server.close(() => process.exit(0)); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
