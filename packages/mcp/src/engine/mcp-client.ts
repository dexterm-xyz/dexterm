// dexterm local engine: a small MCP client over stdio (task-1543).
//
// A local engine has no MCP client of its own, so dexterm is the client: it starts the SAME read-only dexterm
// MCP server the claude path starts (same binary, same env: screen state, the authenticated UI-action channel,
// the user's DEXTERM_HOME), lists its tools and calls them on the model's behalf. The server's own checks (the
// prompt firewall on every token/social string, the UI-action validator, the paper desk gate) therefore apply
// to both engines byte for byte.

import { spawn, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';

export interface McpToolDef { name: string; description: string; inputSchema: Record<string, unknown> }

export interface McpStartOpts {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
  /** How long the handshake may take. */
  timeoutMs?: number;
  spawnImpl?: typeof spawn;
}

export class McpStdioClient {
  private readonly child: ChildProcess;
  private readonly pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  private seq = 0;
  private closed = false;
  private stderr = '';

  private constructor(child: ChildProcess) {
    this.child = child;
    const rl = readline.createInterface({ input: child.stdout! });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let msg: { id?: unknown; result?: Record<string, unknown>; error?: { message?: unknown } };
      try { msg = JSON.parse(line); } catch { return; }
      if (typeof msg.id !== 'number') return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(String(msg.error.message ?? 'MCP error')));
      else p.resolve(msg.result ?? {});
    });
    child.stderr?.on('data', (d: Buffer) => { this.stderr = (this.stderr + d.toString()).slice(-4000); });
    child.stdin?.on('error', () => { /* a dead server must not crash the app on EPIPE */ });
    const die = (why: string): void => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error(`${why}${this.stderr ? ` · ${this.stderr.trim().split('\n').slice(-2).join(' ').slice(0, 200)}` : ''}`));
      this.pending.clear();
    };
    child.on('exit', (code) => die(`the dexterm MCP server exited (${code})`));
    child.on('error', (e) => die(`could not start the dexterm MCP server (${e.message})`));
  }

  static async start(o: McpStartOpts): Promise<McpStdioClient> {
    const child = (o.spawnImpl ?? spawn)(o.command, o.args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const c = new McpStdioClient(child);
    const timer = setTimeout(() => c.close(), o.timeoutMs ?? 30_000);
    timer.unref?.();
    try {
      await c.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dexterm-local-engine', version: '1' } });
      c.notify('notifications/initialized');
      return c;
    } catch (e) {
      c.close();
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  private request(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new Error('the dexterm MCP server is not running'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }) + '\n');
    });
  }

  private notify(method: string): void {
    if (!this.closed) this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
  }

  async listTools(): Promise<McpToolDef[]> {
    const r = await this.request('tools/list');
    const tools = Array.isArray(r.tools) ? r.tools as Array<Record<string, unknown>> : [];
    return tools.map((t) => ({ name: String(t.name), description: String(t.description ?? ''), inputSchema: (t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} }) as Record<string, unknown> }));
  }

  /** Call a tool; returns its text content (the dexterm server answers with one JSON text block). */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const r = await this.request('tools/call', { name, arguments: args });
    const content = Array.isArray(r.content) ? r.content as Array<{ type?: string; text?: unknown }> : [];
    return content.filter((c) => c.type === 'text').map((c) => String(c.text ?? '')).join('');
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.child.stdin?.end(); } catch { /* ignore */ }
    try { this.child.kill('SIGTERM'); } catch { /* ignore */ }
    try { this.child.stdout?.destroy(); } catch { /* ignore */ }
    try { this.child.stderr?.destroy(); } catch { /* ignore */ }
    try { this.child.unref(); } catch { /* ignore */ }
  }
}

/** MCP tool definitions as Ollama function tools, limited to the allowlist (order kept). */
export function toOllamaTools(defs: readonly McpToolDef[], allowed: readonly string[]): Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
  const ok = new Set(allowed);
  return defs.filter((d) => ok.has(d.name)).map((d) => ({ type: 'function' as const, function: { name: d.name, description: d.description.slice(0, 400), parameters: d.inputSchema } }));
}
