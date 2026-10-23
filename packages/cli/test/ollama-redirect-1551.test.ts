// task-1551: what the user sees when the configured Ollama host answers with a redirect. Doctor (end to end through
// ollamaFacts against a 307 server) and the ask/analyst failure line both say it was refused and how to fix it, and
// the other host gets nothing. Servers on 127.0.0.1 only; no model, no external network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { OllamaError, REDIRECT_REFUSED } from '@dexterm/mcp/engine';
import { ollamaCheck, ollamaFacts } from '../src/doctor.ts';
import { ollamaFailure } from '../src/analyst/ollama.ts';

async function listen(s: http.Server): Promise<string> {
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}
const shut = (s: http.Server): Promise<void> => new Promise<void>((r) => { s.closeAllConnections?.(); s.close(() => r()); });

test('1551 doctor: a redirecting Ollama host is a clear warning (refused, nothing sent on, how to fix); the other host gets nothing', async () => {
  let otherHits = 0;
  const other = http.createServer((req, res) => { otherHits++; req.resume(); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"version":"x","models":[]}'); });
  const otherUrl = await listen(other);
  const redir = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(307, { location: `${otherUrl}${req.url}` }); res.end(); }); });
  const url = await listen(redir);
  try {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dexterm-home-1551-'));
    const env = { ...process.env, DEXTERM_HOME: home, DEXTERM_OLLAMA_HOST: url, DEXTERM_OLLAMA_MODEL: 'qwen3:8b' };
    const f = await ollamaFacts(env);
    assert.equal(f.probe.reachable, false);
    assert.equal(f.probe.redirect, true);
    for (const otherEngine of [true, false]) {
      const c = ollamaCheck(f, otherEngine);
      assert.equal(c.status, 'warn');
      assert.match(c.detail, /answered with a redirect: refused, nothing was sent on/);
      assert.match(c.fix ?? '', /never follows a redirect.*dexterm ai host/);
    }
    assert.equal(otherHits, 0, 'the other host got nothing');
  } finally { await shut(redir); await shut(other); }
});

test('1551 ask: the analyst failure line names the redirect, not "stopped answering"', () => {
  const [title, hint] = ollamaFailure(new OllamaError('unreachable', `Ollama at http://127.0.0.1:11434 ${REDIRECT_REFUSED}`, 307, true), 'qwen3:8b', 'http://127.0.0.1:11434');
  assert.equal(title, 'ollama host answered with a redirect');
  assert.match(hint, /refused, nothing was sent on.*dexterm ai host/);
  const [plain] = ollamaFailure(new OllamaError('unreachable', 'cannot reach Ollama'), 'qwen3:8b', 'http://127.0.0.1:11434');
  assert.equal(plain, 'ollama stopped answering');
});
