// task-1543: a fake Ollama server on 127.0.0.1 for the local-engine tests. It speaks the real API shapes
// (/api/version, /api/tags, /api/show, /api/chat streamed as NDJSON or one JSON object) and records every
// request body, so tests can assert exactly what dexterm sent (tools, format, messages). No model, no network.

import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeReply { content?: string; tool_calls?: Array<{ function: { name: string; arguments: unknown } }>; delayMs?: number; status?: number; error?: string }
export type ChatHandler = (body: Record<string, unknown>, n: number) => FakeReply | Promise<FakeReply>;

export interface FakeOllama {
  url: string;
  requests: Array<{ path: string; body: Record<string, unknown> | null }>;
  chats: () => Array<Record<string, unknown>>;
  close: () => Promise<void>;
}

export interface FakeOpts {
  models?: string[];
  capabilities?: string[] | null;
  contextLength?: number;
  version?: string;
  chat?: ChatHandler;
}

export async function startFakeOllama(o: FakeOpts = {}): Promise<FakeOllama> {
  const models = o.models ?? ['qwen3:8b'];
  const requests: FakeOllama['requests'] = [];
  let n = 0;
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', async () => {
      let body: Record<string, unknown> | null = null;
      try { body = data ? JSON.parse(data) as Record<string, unknown> : null; } catch { body = null; }
      requests.push({ path: req.url ?? '', body });
      const json = (status: number, v: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
      if (req.url === '/api/version') return json(200, { version: o.version ?? '0.12.0' });
      if (req.url === '/api/tags') return json(200, { models: models.map((m) => ({ name: m, model: m })) });
      if (req.url === '/api/show') {
        const m = String(body?.model ?? '');
        if (!models.includes(m)) return json(404, { error: `model '${m}' not found` });
        return json(200, { capabilities: o.capabilities === undefined ? ['completion', 'tools'] : o.capabilities, model_info: { 'qwen3.context_length': o.contextLength ?? 40960 }, details: { parameter_size: '8.2B', family: 'qwen3' } });
      }
      if (req.url === '/api/chat') {
        const m = String(body?.model ?? '');
        if (!models.includes(m)) return json(404, { error: `model "${m}" not found, try pulling it first` });
        const r: FakeReply = await (o.chat ?? ((): FakeReply => ({ content: 'ok' })))(body ?? {}, n++);
        if (r.delayMs) await new Promise((x) => setTimeout(x, r.delayMs));
        if (r.status) return json(r.status, { error: r.error ?? 'error' });
        const message = { role: 'assistant', content: r.content ?? '', ...(r.tool_calls ? { tool_calls: r.tool_calls } : {}) };
        const done = { model: m, created_at: new Date().toISOString(), done: true, done_reason: 'stop', total_duration: 1_500_000_000, prompt_eval_count: 321, eval_count: 45 };
        if (body?.stream) {
          res.writeHead(200, { 'content-type': 'application/x-ndjson' });
          const text = message.content;
          const parts = text ? text.match(/.{1,7}/gs) ?? [text] : [];
          for (const p of parts) res.write(JSON.stringify({ model: m, message: { role: 'assistant', content: p }, done: false }) + '\n');
          if (r.tool_calls) res.write(JSON.stringify({ model: m, message: { role: 'assistant', content: '', tool_calls: r.tool_calls }, done: false }) + '\n');
          res.end(JSON.stringify({ ...done, message: { role: 'assistant', content: '' } }) + '\n');
          return;
        }
        return json(200, { ...done, message });
      }
      json(404, { error: 'not found' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    chats: () => requests.filter((r) => r.path === '/api/chat').map((r) => r.body ?? {}),
    close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}
