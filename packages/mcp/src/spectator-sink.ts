// @dexterm/mcp — spectator sink for the MCP tool-call path (task-1406, "watch the agent cook").
//
// The MCP server runs as a separate stdio process spawned by the user's agent. When the running dexterm
// launches it with DEXTERM_SPECTATOR_FILE (an append-only local channel, 0600, like the task-1313 action
// channel) it instruments every tools/call: one JSONL record in the @dexterm/agents SpectatorEvent v1
// shape is appended, which the TUI tails into its SpectatorHub (where redaction + the stream happen).
// The record carries NOTHING an agent could act on — it only describes a read/navigation call that
// already completed. The file is local and token-marked; raw addresses live only on this loopback channel
// and are redacted before anything leaves the machine.

import { appendFileSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The subset of fields the MCP side fills (mirrors @dexterm/agents SpectatorEvent v1; the hub re-seqs on ingest). */
export interface McpSpectatorRecord {
  v: 1;
  seq: number;
  t: number;
  phase: 'result' | 'nav' | 'refused';
  agent: string;
  transport: 'mcp';
  tool: string;
  summary: string;
  ms: number;
  dataAgeSec: number | null;
  nav: { screen?: string; mint?: string; feed?: string; filter?: string; highlight?: string; side?: string } | null;
  ok: boolean;
  /** The channel token, so the TUI tailing the file can confirm the writer (never printed). */
  token?: string;
}

/** The UI-action tools that move the screen (so follow mode can visibly perform them). */
const NAV_TOOLS = new Set(['open_token', 'show_in_screener', 'switch_feed', 'add_to_watchlist', 'open_ticket']);

function navFor(tool: string, args: Record<string, unknown>): McpSpectatorRecord['nav'] {
  const s = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  if (tool === 'open_token') return { screen: 'token', mint: s(args.mint) };
  if (tool === 'switch_feed') return { screen: 'screener', feed: s(args.feed) };
  if (tool === 'show_in_screener') return { screen: 'screener', filter: s(args.filter), highlight: s(args.highlight) };
  if (tool === 'add_to_watchlist') return { screen: 'watchlist', mint: s(args.mint) };
  if (tool === 'open_ticket') return { screen: 'ticket', mint: s(args.mint), side: s(args.side) };
  return null;
}

/** Largest `ageSec` anywhere in a tool result (the data freshness the activity panel shows). */
export function maxAgeSec(result: unknown, depth = 0): number | null {
  if (depth > 6 || !result || typeof result !== 'object') return null;
  let max: number | null = null;
  for (const [k, v] of Object.entries(result as Record<string, unknown>)) {
    if (k === 'ageSec' && typeof v === 'number' && Number.isFinite(v) && v >= 0) max = max === null ? v : Math.max(max, v);
    else { const inner = maxAgeSec(v, depth + 1); if (inner !== null) max = max === null ? inner : Math.max(max, inner); }
  }
  return max;
}

function shortMint(args: Record<string, unknown>): string {
  const m = typeof args.mint === 'string' ? args.mint : typeof args.symbol === 'string' ? args.symbol : '';
  return m ? ` ${m.length > 10 ? m.slice(0, 6) + '…' : m}` : '';
}

/** Build one spectator record for a completed MCP tool call. */
export function recordForToolCall(opts: { seq: number; agent: string; tool: string; args: Record<string, unknown>; result: Record<string, unknown>; ms: number; token?: string; now?: () => number }): McpSpectatorRecord {
  const isErr = typeof opts.result.error === 'string';
  const nav = navFor(opts.tool, opts.args);
  return {
    // A refused/failed UI tool is observable activity, but it is not navigation.  Keeping it out of the
    // `nav` phase is the enforcement boundary that prevents a denied MCP call from moving the owner's TUI.
    v: 1, seq: opts.seq, t: (opts.now ?? Date.now)(), phase: isErr ? 'refused' : nav ? 'nav' : 'result',
    agent: opts.agent, transport: 'mcp', tool: opts.tool,
    summary: isErr ? `error: ${String(opts.result.error).slice(0, 80)}` : `${opts.tool}${shortMint(opts.args)}`,
    ms: opts.ms, dataAgeSec: isErr ? null : maxAgeSec(opts.result), nav, ok: !isErr,
    ...(opts.token ? { token: opts.token } : {}),
  };
}

/** A sink that appends records to a file (0600). Returns null when no spectator file is configured. */
export interface McpSpectatorSink { record(rec: McpSpectatorRecord): void }

export function fileSpectatorSinkFromEnv(env: NodeJS.ProcessEnv): { sink: McpSpectatorSink; agent: string; token: string | undefined } | null {
  const file = env.DEXTERM_SPECTATOR_FILE;
  if (!file) return null;
  const token = env.DEXTERM_SPECTATOR_TOKEN || undefined;
  const agent = env.DEXTERM_SPECTATOR_AGENT || 'mcp-agent';
  const sink: McpSpectatorSink = {
    record(rec) { try { appendFileSync(file, JSON.stringify(rec) + '\n', { mode: 0o600 }); } catch { /* best-effort local channel */ } },
  };
  return { sink, agent, token };
}

// ---------------------------------------------------------------------------------------------------
// task-1421: the rendezvous for a `dexterm mcp` server an EXTERNAL client (Claude Code, Cursor, Codex, …)
// spawned. That server's env is set by the client, not by the running dexterm, so DEXTERM_SPECTATOR_FILE is
// never set on it. Instead, a running dexterm that has a spectator surface open writes a small rendezvous
// file under ~/.dexterm naming the JSONL channel + its token; the server reads it (mtime-cached) on each
// tool call and appends there. When no surface is open the file is absent and the server writes NOTHING — so
// there is no cost when nobody is watching. The channel is local (0600) and the record describes a completed
// read / navigation call; it carries nothing an agent could act on, exactly like the env-file sink.

/** The well-known rendezvous file name under ~/.dexterm. */
export const MCP_SPECTATOR_RENDEZVOUS = 'mcp-spectator.json';

/** The rendezvous a running dexterm writes so an external `dexterm mcp` server knows where to append. */
export interface McpSpectatorRendezvous { file: string; token?: string; agent?: string }

function spectatorHome(env: NodeJS.ProcessEnv): string {
  return env.DEXTERM_HOME && env.DEXTERM_HOME.trim() ? env.DEXTERM_HOME : join(homedir(), '.dexterm');
}

export function rendezvousPath(env: NodeJS.ProcessEnv): string { return join(spectatorHome(env), MCP_SPECTATOR_RENDEZVOUS); }

/** A sink the MCP server calls for EVERY tool call. `active()` is a cheap check of whether any spectator
 *  surface is listening right now; when it is false the server builds no record and nothing is written. */
export interface LiveSpectatorSink {
  active(): boolean;
  record(opts: { tool: string; args: Record<string, unknown>; result: Record<string, unknown>; ms: number }): void;
}

/**
 * Resolve the spectator sink for a `dexterm mcp` server. DEXTERM_SPECTATOR_FILE (the running app spawned us,
 * e.g. the in-app analyst) wins and is always active; otherwise the sink watches the rendezvous file under
 * ~/.dexterm and is active only while it exists, re-reading it (mtime-cached) each call. Never throws.
 */
export function resolveSpectatorSink(env: NodeJS.ProcessEnv): LiveSpectatorSink {
  let seq = 0;
  const fromEnv = fileSpectatorSinkFromEnv(env);
  if (fromEnv) {
    return {
      active: () => true,
      record: (o) => fromEnv.sink.record(recordForToolCall({ seq: ++seq, agent: fromEnv.agent, token: fromEnv.token, ...o })),
    };
  }
  const path = rendezvousPath(env);
  let cache: { mtimeMs: number; rv: McpSpectatorRendezvous | null } | null = null;
  const read = (): McpSpectatorRendezvous | null => {
    let st: ReturnType<typeof statSync>;
    try { st = statSync(path); } catch { cache = null; return null; }
    if (cache && cache.mtimeMs === st.mtimeMs) return cache.rv;
    let rv: McpSpectatorRendezvous | null = null;
    try {
      const o = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      if (o && typeof o.file === 'string' && o.file) {
        rv = { file: o.file, token: typeof o.token === 'string' ? o.token : undefined, agent: typeof o.agent === 'string' ? o.agent : undefined };
      }
    } catch { rv = null; }
    cache = { mtimeMs: st.mtimeMs, rv };
    return rv;
  };
  return {
    active: () => read() !== null,
    record: (o) => {
      const rv = read();
      if (!rv) return;
      const rec = recordForToolCall({ seq: ++seq, agent: rv.agent || 'mcp-agent', token: rv.token, ...o });
      try { appendFileSync(rv.file, JSON.stringify(rec) + '\n', { mode: 0o600 }); } catch { /* best-effort local channel */ }
    },
  };
}
