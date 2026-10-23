// dexterm local engine: a minimal client for the user's own Ollama server (task-1543).
//
// Ollama runs models on the user's machine; dexterm talks to it over HTTP on the loopback interface
// (http://127.0.0.1:11434 by default). Nothing here ships a model, a key or a download: the user installs
// Ollama and pulls a model themselves. A host that is not on this machine is allowed only when the user
// configures it, and every surface that shows the host warns about it (data would leave the machine).
//
// Endpoints used: GET /api/version, GET /api/tags, POST /api/show, POST /api/chat (streamed NDJSON or one
// JSON object). No other host is ever contacted by this module.

export const DEFAULT_OLLAMA_HOST = 'http://127.0.0.1:11434';
export const DEFAULT_OLLAMA_PORT = 11434;

export interface OllamaHost {
  /** Base URL without a trailing slash, e.g. http://127.0.0.1:11434. */
  url: string;
  hostname: string;
  /** True for the loopback interface (127.0.0.0/8, ::1, localhost). */
  local: boolean;
}

/** True for a loopback host name or address. */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * Parse a user-supplied Ollama host ("127.0.0.1", "localhost:11434", "http://[::1]:11434"). Only http(s), no
 * credentials, no path or query. The default port is 11434. Returns an error string for anything else.
 */
export function parseOllamaHost(raw: string | null | undefined): OllamaHost | { error: string } {
  const s = String(raw ?? '').trim();
  if (!s) return parseOllamaHost(DEFAULT_OLLAMA_HOST);
  let u: URL;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`); } catch { return { error: `not a host: ${s.slice(0, 80)}` }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: `only http or https hosts (got ${u.protocol.replace(':', '')})` };
  if (u.username || u.password) return { error: 'a host with a user name or password is refused (it would be stored in plain text)' };
  if ((u.pathname && u.pathname !== '/') || u.search || u.hash) return { error: 'give the host only, without a path or query (e.g. http://127.0.0.1:11434)' };
  // The URL parser drops a scheme-default port (:80 / :443), so read an explicit port from the text itself.
  const explicit = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:\[[^\]]+\]|[^:/]+):(\d+)\/?$/i.exec(s);
  const port = explicit ? explicit[1] : /^https:\/\//i.test(s) ? '443' : String(DEFAULT_OLLAMA_PORT);
  const hostname = u.hostname; // IPv6 keeps its brackets here
  return { url: `${u.protocol}//${hostname}:${port}`, hostname, local: isLoopbackHost(hostname) };
}

/** The one warning every surface shows for a host that is not this machine. */
export function remoteHostWarning(h: OllamaHost): string | null {
  return h.local ? null : `the Ollama host ${h.hostname} is not this machine: prompts, screen context and tool results are sent to it over the network`;
}

// ───────────────────────────── API shapes ─────────────────────────────

export interface OllamaToolCall { function: { name: string; arguments: Record<string, unknown> } }

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: OllamaToolCall[];
  /** The tool a `tool` message answers (Ollama's field name). */
  tool_name?: string;
}

export interface OllamaTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatRequest {
  model: string;
  messages: OllamaMessage[];
  tools?: OllamaTool[];
  /** 'json' or a JSON Schema: constrained output (Ollama structured outputs). */
  format?: 'json' | Record<string, unknown>;
  options?: { num_ctx?: number; temperature?: number; seed?: number };
  keep_alive?: string;
  think?: boolean;
}

export interface ChatResult {
  content: string;
  toolCalls: OllamaToolCall[];
  doneReason: string | null;
  promptTokens: number;
  evalTokens: number;
  totalMs: number | null;
  model: string | null;
}

export interface ShowResult {
  capabilities: string[] | null;
  contextLength: number | null;
  parameterSize: string | null;
  family: string | null;
}

export class OllamaError extends Error {
  readonly kind: 'unreachable' | 'http' | 'model-missing' | 'timeout' | 'aborted' | 'bad-response';
  readonly status?: number;
  /** task-1551: the host answered with a redirect, which is never followed (kind is 'unreachable'). */
  readonly redirect?: boolean;
  constructor(kind: OllamaError['kind'], message: string, status?: number, redirect?: boolean) { super(message); this.kind = kind; this.status = status; if (redirect) this.redirect = true; }
}

/** task-1551: why a redirect is refused, for doctor / ask / ai probe. */
export const REDIRECT_REFUSED = 'answered with a redirect, which dexterm never follows for the local engine (it would send your prompt to another host); set the Ollama host to the Ollama server itself';

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal; redirect?: 'error' | 'follow' | 'manual' }) => Promise<Response>;

export interface OllamaClientOpts {
  host: OllamaHost;
  fetch?: FetchLike;
  /** Per-request timeout for the small metadata calls (version/tags/show). */
  metaTimeoutMs?: number;
}

/** Strip a <think>…</think> block some models put in the content. */
export const stripThink = (s: string): string => s.replace(/<think>[\s\S]*?(<\/think>|$)/g, '');

function normaliseToolCalls(raw: unknown): OllamaToolCall[] {
  if (!Array.isArray(raw)) return [];
  const out: OllamaToolCall[] = [];
  for (const c of raw) {
    const f = (c as { function?: { name?: unknown; arguments?: unknown } })?.function;
    if (!f || typeof f.name !== 'string' || !f.name) continue;
    let args: unknown = f.arguments;
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
    out.push({ function: { name: f.name, arguments: args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {} } });
  }
  return out;
}

export class OllamaClient {
  readonly host: OllamaHost;
  private readonly f: FetchLike;
  private readonly metaTimeoutMs: number;

  constructor(o: OllamaClientOpts) {
    this.host = o.host;
    this.f = o.fetch ?? ((url, init) => fetch(url, init));
    this.metaTimeoutMs = o.metaTimeoutMs ?? 4000;
  }

  private async req(path: string, init: { method?: string; body?: unknown } = {}, timeoutMs = this.metaTimeoutMs, outer?: AbortSignal): Promise<Response> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new OllamaError('timeout', `Ollama did not answer within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
    timer.unref?.();
    const onOuter = (): void => ac.abort(new OllamaError('aborted', 'cancelled'));
    if (outer) { if (outer.aborted) onOuter(); else outer.addEventListener('abort', onOuter, { once: true }); }
    let res: Response;
    try {
      // task-1551: redirect 'error' so a 3xx from the configured host never re-sends the prompt to another host.
      res = await this.f(`${this.host.url}${path}`, {
        method: init.method ?? 'GET',
        headers: init.body !== undefined ? { 'content-type': 'application/json' } : undefined,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: ac.signal,
        redirect: 'error',
      });
    } catch (e) {
      const reason = ac.signal.reason;
      if (reason instanceof OllamaError) throw reason;
      const cause = (e as { cause?: { message?: unknown } })?.cause?.message;
      if (/redirect/i.test(String(cause ?? '')) || /redirect/i.test((e as Error)?.message ?? '')) throw new OllamaError('unreachable', `Ollama at ${this.host.url} ${REDIRECT_REFUSED}`, undefined, true);
      throw new OllamaError('unreachable', `cannot reach Ollama at ${this.host.url} (${(e as Error).message})`);
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onOuter);
    }
    // A fetch that ignored the init (or answered 'manual'): never use a redirect or a redirected answer.
    if (res.redirected || (res.status >= 300 && res.status < 400)) {
      try { await res.body?.cancel(); } catch { /* ignore */ }
      throw new OllamaError('unreachable', `Ollama at ${this.host.url} ${REDIRECT_REFUSED}`, res.status, true);
    }
    return res;
  }

  private static async fail(res: Response, model?: string): Promise<never> {
    let msg = '';
    try { const j = await res.json() as { error?: unknown }; msg = String(j?.error ?? ''); } catch { /* not json */ }
    if (res.status === 404 && model && /not found|pull/i.test(msg || 'not found')) throw new OllamaError('model-missing', `model ${model} is not pulled on this Ollama (run: ollama pull ${model})`, 404);
    throw new OllamaError('http', `Ollama answered HTTP ${res.status}${msg ? `: ${msg.slice(0, 200)}` : ''}`, res.status);
  }

  async version(): Promise<string> {
    const res = await this.req('/api/version');
    if (!res.ok) return OllamaClient.fail(res);
    const j = await res.json() as { version?: unknown };
    return typeof j.version === 'string' ? j.version : 'unknown';
  }

  /** Pulled model names (e.g. "qwen3:8b"). */
  async tags(): Promise<string[]> {
    const res = await this.req('/api/tags');
    if (!res.ok) return OllamaClient.fail(res);
    const j = await res.json() as { models?: Array<{ name?: unknown; model?: unknown }> };
    return (j.models ?? []).map((m) => String(m.name ?? m.model ?? '')).filter(Boolean);
  }

  /** Model metadata: capabilities (tools, thinking, …) and the trained context length. */
  async show(model: string): Promise<ShowResult> {
    const res = await this.req('/api/show', { method: 'POST', body: { model } });
    if (!res.ok) return OllamaClient.fail(res, model);
    const j = await res.json() as { capabilities?: unknown; model_info?: Record<string, unknown>; details?: { parameter_size?: unknown; family?: unknown } };
    let ctx: number | null = null;
    for (const [k, v] of Object.entries(j.model_info ?? {})) if (/\.context_length$/.test(k) && typeof v === 'number') ctx = v;
    return {
      capabilities: Array.isArray(j.capabilities) ? j.capabilities.map(String) : null,
      contextLength: ctx,
      parameterSize: typeof j.details?.parameter_size === 'string' ? j.details.parameter_size : null,
      family: typeof j.details?.family === 'string' ? j.details.family : null,
    };
  }

  /**
   * One /api/chat call. With `onDelta` the response is streamed (NDJSON) and content deltas arrive as they
   * are generated; tool calls and the final counters are returned either way.
   */
  async chat(r: ChatRequest, o: { onDelta?: (text: string) => void; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<ChatResult> {
    const stream = !!o.onDelta;
    const res = await this.req('/api/chat', { method: 'POST', body: { ...r, stream } }, o.timeoutMs ?? 600_000, o.signal);
    if (!res.ok) return OllamaClient.fail(res, r.model);
    const out: ChatResult = { content: '', toolCalls: [], doneReason: null, promptTokens: 0, evalTokens: 0, totalMs: null, model: null };
    const take = (j: Record<string, unknown>): void => {
      if (typeof j.error === 'string') throw new OllamaError('http', `Ollama: ${j.error.slice(0, 200)}`);
      const m = (j.message ?? {}) as { content?: unknown; tool_calls?: unknown };
      if (typeof m.content === 'string' && m.content) { out.content += m.content; o.onDelta?.(m.content); }
      out.toolCalls.push(...normaliseToolCalls(m.tool_calls));
      if (typeof j.model === 'string') out.model = j.model;
      if (j.done) {
        out.doneReason = typeof j.done_reason === 'string' ? j.done_reason : 'stop';
        out.promptTokens = Number(j.prompt_eval_count) || 0;
        out.evalTokens = Number(j.eval_count) || 0;
        out.totalMs = typeof j.total_duration === 'number' ? Math.round(j.total_duration / 1e6) : null;
      }
    };
    if (!stream || !res.body) {
      let j: Record<string, unknown>;
      try { j = await res.json() as Record<string, unknown>; } catch { throw new OllamaError('bad-response', 'Ollama sent a response that is not JSON'); }
      take(j);
      return out;
    }
    const dec = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += dec.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line) continue;
          let j: Record<string, unknown>;
          try { j = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
          take(j);
        }
      }
    } catch (e) {
      if (e instanceof OllamaError) throw e;
      if (o.signal?.aborted) throw new OllamaError('aborted', 'cancelled');
      throw new OllamaError('unreachable', `the Ollama stream broke (${(e as Error).message})`);
    }
    if (buf.trim()) { try { take(JSON.parse(buf) as Record<string, unknown>); } catch { /* trailing garbage */ } }
    return out;
  }
}
