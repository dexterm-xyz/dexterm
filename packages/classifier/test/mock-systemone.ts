// A mock System One server for the adapter contract tests (task-1822). Speaks POST /v1/systemone (llama.cpp / TypeSafe
// shape), GET /health, GET /v1/models and the vLLM POST /v1/completions shape jev-open uses. Answers are deterministic
// (a hash of the state + question) unless a recorded fixture matches the request exactly. Modes simulate failures.
// The hosted provider is ONLY ever tested against this server.

import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type MockMode = 'ok' | 'unauthorized' | 'rate_limited' | 'loading' | 'garbage' | 'missing_answer' | 'slow';

export interface MockServer {
  url: string;
  requests: Array<{ path: string; headers: http.IncomingHttpHeaders; body: any }>;
  mode: MockMode;
  close(): Promise<void>;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

function answer(state: string, id: string, q: any): any {
  const u = hash(state + '|' + id);
  if (q.type === 'noul') return { type: 'noul', noul: Math.round((0.05 + 0.9 * u) * 1e6) / 1e6 };
  const labels: string[] = q.type === 'score' ? q.criteria.map((_: unknown, i: number) => String(i)) : Object.keys(q.criteria);
  const w = labels.map((l) => 0.1 + hash(state + id + l));
  const s = w.reduce((a, b) => a + b, 0);
  const probabilities = Object.fromEntries(labels.map((l, i) => [l, w[i] / s]));
  const top = labels[w.indexOf(Math.max(...w))];
  return q.type === 'score'
    ? { type: 'score', score: labels.reduce((m, l) => m + Number(l) * probabilities[l], 0), legend: Object.fromEntries(q.criteria.map((d: string, i: number) => [String(i), d])), probabilities, confidence: 0.3 }
    : { type: 'choice', choice: top, probabilities, confidence: 0.3 };
}

export async function startMock(o: { fixtures?: Array<{ request: any; response: any }>; requireKey?: string } = {}): Promise<MockServer> {
  const requests: MockServer['requests'] = [];
  const m: MockServer = { url: '', requests, mode: 'ok', close: async () => {} };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body: any = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
      requests.push({ path: req.url ?? '', headers: req.headers, body });
      const send = (status: number, obj: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
      };
      if (req.url === '/health') return send(200, { status: m.mode === 'loading' ? 'loading model' : 'ok' });
      if (req.url === '/v1/models') return send(200, { data: [{ id: 'mock' }] });
      if (o.requireKey && req.headers.authorization !== `Bearer ${o.requireKey}`) return send(401, { error: { message: 'invalid key' } });
      if (m.mode === 'unauthorized') return send(401, { error: { message: 'invalid key' } });
      if (m.mode === 'rate_limited') return send(429, { error: { message: 'slow down' } }, { 'retry-after': '7' });
      if (m.mode === 'loading') return send(503, { error: { message: 'Loading model', code: 503 } });
      if (m.mode === 'garbage') return send(200, '<html>not json</html>');
      if (req.url === '/v1/systemone' && req.method === 'POST') {
        if (!body || typeof body !== 'object' || !body.questions || body.state === undefined) return send(400, { error: { message: 'bad request' } });
        const fx = o.fixtures?.find((f) => JSON.stringify(f.request.questions) === JSON.stringify(body.questions) && JSON.stringify(f.request.state) === JSON.stringify(body.state));
        if (fx) return send(200, fx.response);
        const st = JSON.stringify(body.state);
        const answers: Record<string, unknown> = {};
        for (const [id, q] of Object.entries(body.questions as Record<string, any>)) answers[id] = answer(st, id, q);
        if (m.mode === 'missing_answer') delete answers[Object.keys(answers)[0]];
        const reply = () => send(200, { model: body.model ?? 'mock-kev', answers, usage: { input_tokens: Math.ceil(st.length / 4), output_tokens: 0 } });
        return m.mode === 'slow' ? setTimeout(reply, 400) : reply();
      }
      if (req.url === '/v1/completions' && req.method === 'POST') {
        const ids: number[] = body.allowed_token_ids;
        const lp: Record<string, number> = {};
        ids.forEach((t, i) => { lp[`token_id:${t}`] = Math.log(0.1 + hash(body.prompt + i)); });
        return send(200, { choices: [{ logprobs: { top_logprobs: [lp] } }], usage: { prompt_tokens: Math.ceil(body.prompt.length / 4) } });
      }
      send(404, { error: { message: 'not found' } });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  m.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  m.close = () => new Promise<void>((r) => server.close(() => r()));
  return m;
}
