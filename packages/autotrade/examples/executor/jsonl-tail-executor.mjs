#!/usr/bin/env node
// dexterm executor reference kit: the JSONL stream tail (task-1654). DRY RUN: logs what it would do; no wallet code.
//
//   node jsonl-tail-executor.mjs --account main [--stream FILE] [--secret-file FILE --require-hmac] [--once] [--poll-ms 1000]
//
// Turn the stream on in dexterm (`dexterm autotrade signal channels --jsonl on`, default file
// autotrade/real/signals.jsonl). With `--jsonl-signed on` each line is an HMAC envelope this tail verifies; a bare
// line has no signature, so --require-hmac refuses it. The read offset is saved, so a restart resumes where it was.
// --once reads what is there and exits (handy for a test).

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SeenStore, args, dextermHome, handle, heartbeat, readSecret, realDir, unwrapLine } from './kit.mjs';

const a = args();
if (!a.account) { console.error('usage: node jsonl-tail-executor.mjs --account ID [--stream FILE] [--secret-file FILE] [--once]'); process.exit(2); }
const home = a.home || dextermHome();
const stream = a.stream || join(realDir(home), 'signals.jsonl');
const offFile = a['offset-file'] || join(realDir(home), 'kit-tail-offset.json');
const seen = new SeenStore(a.state || join(realDir(home), 'kit-tail-seen.json'));
const secret = readSecret(a['secret-file']);
const name = String(a.name || 'kit-jsonl-tail').slice(0, 32);
const log = (s) => console.log(`[${new Date().toISOString()}] ${s}`);
let offset = 0;
try { offset = Number(JSON.parse(readFileSync(offFile, 'utf8')).offset) || 0; } catch { /* from the start */ }
let carry = '';

function poll() {
  if (!existsSync(stream)) return;
  const size = statSync(stream).size;
  if (size < offset) { offset = 0; carry = ''; }
  if (size === offset) return;
  const fd = openSync(stream, 'r');
  const buf = Buffer.alloc(size - offset);
  try { readSync(fd, buf, 0, buf.length, offset); } finally { closeSync(fd); }
  offset = size;
  const lines = (carry + buf.toString('utf8')).split('\n');
  carry = lines.pop() ?? '';
  for (const l of lines) {
    if (!l.trim()) continue;
    const { body, signature } = unwrapLine(l);
    handle(body, { accountId: a.account, secret, requireHmac: !!a['require-hmac'], signature, seen, home, executor: name, log, now: Date.now() });
  }
  writeFileSync(offFile, JSON.stringify({ offset: offset - Buffer.byteLength(carry) }));
}

const beat = () => { try { heartbeat(home, { executor: name, accountId: a.account, lastNonce: seen.maxNonce || null }); } catch (e) { log(`heartbeat failed: ${e.message}`); } };
poll();
beat();
if (!a.once) {
  log(`dexterm kit JSONL tail executor (DRY RUN) on ${stream} · account ${a.account}`);
  const t1 = setInterval(poll, Math.max(100, Number(a['poll-ms'] ?? 1000)));
  const t2 = setInterval(beat, Math.max(5, Number(a['heartbeat-sec'] ?? 60)) * 1000);
  const stop = () => { clearInterval(t1); clearInterval(t2); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
