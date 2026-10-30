// @dexterm/mcp — spectator sink for the MCP tool-call path (task-1406, "watch the agent cook").
//
// The MCP server runs as a separate stdio process spawned by the user's agent. When the running dexterm
// launches it with DEXTERM_SPECTATOR_FILE (an append-only local channel, 0600, like the task-1313 action
// channel) it instruments every tools/call: one JSONL record in the @dexterm/agents SpectatorEvent v1
// shape is appended, which the TUI tails into its SpectatorHub (where redaction + the stream happen).
// The record carries NOTHING an agent could act on — it only describes a read/navigation call that
// already completed. The file is local and token-marked; raw addresses live only on this loopback channel
// and are redacted before anything leaves the machine.

import { appendFileSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
  /**
   * task-1466: the app-computed numbers behind the call (rows scanned, verdict, PAPER ticket / fill / position).
   * Mirrors @dexterm/agents SpectatorDetail; the viewer re-validates it with sanitizeDetail.
   */
  detail?: {
    rows?: Array<{ mint: string; symbol: string; chg?: number | null }>;
    coin?: { mint: string; symbol?: string | null; priceUsd?: number | null };
    verdict?: { label: string; rug?: number | null };
    larp?: { flags: number; items: string[] };
    ticket?: { side: 'buy' | 'sell'; symbol: string; mint: string; usd?: number | null; fraction?: number | null };
    fill?: { side: 'buy' | 'sell'; symbol: string; mint: string; sol: number; qty: number; priceUsd: number | null; impactPct: number | null; realizedSol: number | null };
    position?: { mint: string; symbol: string; qty: number; costSol: number; realizedSol: number };
    caps?: { perTradeUsd: number; totalUsd: number; maxPriceImpactPct: number | null };
    refusal?: string;
    /** task-1427: the top-10 holder share (percent) from the tool's own result; see SpectatorDetail.holders. */
    holders?: { top10Pct: number; count?: number | null; basis: 'ex-pools' | 'raw'; ageSec?: number | null };
  } | null;
  /** The channel token, so the TUI tailing the file can confirm the writer (never printed). */
  token?: string;
}

/** The UI-action tools that move the screen (so follow mode can visibly perform them). */
const NAV_TOOLS = new Set(['open_token', 'show_in_screener', 'switch_feed', 'switch_screen', 'add_to_watchlist', 'open_ticket']);

/**
 * task-1443: the view-only UI tools an EXTERNAL agent may use to move a terminal that follows it over MCP. Nothing
 * here changes user data or settings (no watchlist add, no ticket, no theme/workspace): the screen only moves.
 */
export const FOLLOW_NAV_ACTIONS = ['open_token', 'show_in_screener', 'switch_feed', 'switch_screen'] as const;

function navFor(tool: string, args: Record<string, unknown>): McpSpectatorRecord['nav'] {
  const s = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  if (tool === 'open_token') return { screen: 'token', mint: s(args.mint) };
  if (tool === 'switch_feed') return { screen: 'screener', feed: s(args.feed) };
  if (tool === 'show_in_screener') return { screen: 'screener', feed: s(args.preset), filter: s(args.filter), highlight: s(args.highlight) };
  // task-1443: the task-1413 view-only screen switch moves a following terminal too (e.g. to positions).
  if (tool === 'switch_screen') return s(args.screen) ? { screen: s(args.screen) } : null;
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

/**
 * task-1443: a readable, PAPER-labelled summary for an agent paper-trading call, so the activity panel says what
 * the agent did to the simulated ledger (side, size, symbol), not just the tool name. null for any other tool.
 */
export function paperSummary(tool: string, args: Record<string, unknown>, result: Record<string, unknown>): string | null {
  if (!tool.startsWith('paper_')) return null;
  const s = (v: unknown) => (typeof v === 'string' ? v.slice(0, 16) : '');
  const t = (result.ticket ?? {}) as Record<string, unknown>;
  const f = (result.fill ?? {}) as Record<string, unknown>;
  switch (tool) {
    case 'paper_open_ticket': return `PAPER open ${s(args.side)} ticket ${s(args.symbol)}`.trim();
    case 'paper_size_ticket': return typeof t.usd === 'number' ? `PAPER size ${s(t.symbol)} $${t.usd.toFixed(2)}` : typeof t.fraction === 'number' ? `PAPER size ${s(t.symbol)} ${Math.round(t.fraction * 100)}%` : 'PAPER size';
    case 'paper_confirm': case 'paper_close': {
      const sol = typeof f.solDelta === 'number' ? ` ${f.solDelta > 0 ? '+' : ''}${f.solDelta.toFixed(4)} SOL` : '';
      return `PAPER ${tool === 'paper_close' ? 'close' : s(f.side) || 'fill'} ${s(f.symbol)}${sol}`;
    }
    case 'paper_positions': return `PAPER positions (${Array.isArray(result.positions) ? result.positions.length : 0})`;
    case 'paper_pnl': return 'PAPER pnl';
    default: return null;
  }
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
    summary: isErr ? `error: ${String(opts.result.error).slice(0, 80)}` : paperSummary(opts.tool, opts.args, opts.result) ?? `${opts.tool}${shortMint(opts.args)}`,
    ms: opts.ms, dataAgeSec: isErr ? null : maxAgeSec(opts.result), nav, ok: !isErr,
    ...(() => { const d = detailFor(opts.tool, opts.args, opts.result); return d ? { detail: d } : {}; })(),
    ...(opts.token ? { token: opts.token } : {}),
  };
}

const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
/** A firewalled field's inner text (`<untrusted …>X</untrusted>` → X; the inner text is already scrubbed upstream). */
const unwrap = (x: string): string => x.replace(/^<untrusted\b[^>]*>([\s\S]*?)<\/untrusted>$/, '$1');
const str = (x: unknown, max = 16): string | null => (typeof x === 'string' && x ? unwrap(x).slice(0, max) || null : null);
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const mintOf = (x: unknown): string | null => (typeof x === 'string' && MINT_RE.test(x) ? x : null);

/**
 * task-1466: the app-computed numbers behind one call, for the follow view (SpectatorDetail in @dexterm/agents).
 * Copied from the tool's OWN result (a screener page, a verdict, a PAPER ticket / fill / position, the caps the
 * desk replayed); agent-supplied args only name the coin. null when the call has nothing worth showing.
 */
export function detailFor(tool: string, args: Record<string, unknown>, result: Record<string, unknown>): McpSpectatorRecord['detail'] {
  const d: NonNullable<McpSpectatorRecord['detail']> = {};
  if (typeof result.error === 'string') {
    if (tool.startsWith('paper_') && typeof result.reason === 'string') d.refusal = result.reason.slice(0, 40);
    return Object.keys(d).length ? d : null;
  }
  if (tool === 'screener_query' && Array.isArray(result.rows)) {
    d.rows = (result.rows as Array<Record<string, unknown>>).slice(0, 12).flatMap((r) => {
      const mint = mintOf(r.mint); if (!mint) return [];
      const pc = (r.priceChange ?? {}) as Record<string, unknown>;
      return [{ mint, symbol: str(r.symbol) ?? '?', chg: num(pc.h1) }];
    });
  }
  if (tool === 'screen_state' && Array.isArray(result.visible)) {
    d.rows = (result.visible as Array<Record<string, unknown>>).slice(0, 12).flatMap((r) => {
      const mint = mintOf(r.mint); return mint ? [{ mint, symbol: str(r.symbol) ?? '?', chg: num(r.chg1h) }] : [];
    });
  }
  if (tool === 'get_token') {
    const tk = (result.token ?? {}) as Record<string, unknown>;
    const pair = (result.pair ?? {}) as Record<string, unknown>;
    const mint = mintOf(tk.mint) ?? mintOf(args.mint);
    if (mint) d.coin = { mint, symbol: str(tk.symbol), priceUsd: num(pair.priceUsd) };
  } else if (tool === 'analyze_token') {
    const mint = mintOf(result.mint) ?? mintOf(args.mint);
    if (mint) d.coin = { mint, symbol: str(result.symbol) };
    const label = str(result.deterministic_verdict, 18);
    if (label) d.verdict = { label, rug: num(result.rug_probability) };
  } else if (tool === 'larp_check') {
    const mint = mintOf(result.mint) ?? mintOf(args.mint);
    if (mint) d.coin = { mint, symbol: str(result.symbol) };
    const flags = Array.isArray(result.flags) ? (result.flags as unknown[]).filter((f): f is string => typeof f === 'string') : [];
    d.larp = { flags: flags.length, items: flags.slice(0, 6).map((f) => f.slice(0, 60)) };
  } else if (['open_token', 'get_trades', 'get_candles', 'get_holders', 'rugcheck', 'get_dev_history', 'dev_history', 'get_dossier'].includes(tool)) {
    const mint = mintOf(args.mint);
    if (mint) d.coin = { mint, symbol: str(args.symbol) };
  }
  // task-1427: the holder concentration a streamer overlay draws as a bar, copied from the result (never computed here)
  const hold = holdersOf(tool, result);
  if (hold) d.holders = hold;
  if (tool === 'get_dossier') {
    const mint = mintOf(result.mint) ?? mintOf(args.mint);
    if (mint && !d.coin) d.coin = { mint, symbol: str(args.symbol) };
  }
  if (tool === 'paper_open_ticket' || tool === 'paper_size_ticket') {
    const t = (result.ticket ?? {}) as Record<string, unknown>;
    const mint = mintOf(t.mint);
    if (mint && (t.side === 'buy' || t.side === 'sell')) d.ticket = { side: t.side, symbol: str(t.symbol) ?? '?', mint, usd: num(t.usd), fraction: num(t.fraction) };
  }
  if (tool === 'paper_confirm' || tool === 'paper_close') {
    const f = (result.fill ?? {}) as Record<string, unknown>;
    const mint = mintOf(f.mint);
    if (mint && (f.side === 'buy' || f.side === 'sell') && num(f.solDelta) !== null && num(f.tokens) !== null) {
      d.fill = { side: f.side, symbol: str(f.symbol) ?? '?', mint, sol: num(f.solDelta)!, qty: num(f.tokens)!, priceUsd: num(f.priceUsd), impactPct: num(f.priceImpactPct), realizedSol: num(f.realizedSol) };
    }
    const p = (result.position ?? null) as Record<string, unknown> | null;
    const pm = p ? mintOf(p.mint) : null;
    if (p && pm && num(p.tokens) !== null && num(p.costSol) !== null) d.position = { mint: pm, symbol: str(p.symbol) ?? '?', qty: num(p.tokens)!, costSol: num(p.costSol)!, realizedSol: num(p.realizedSol) ?? 0 };
  }
  if (tool === 'paper_pnl') {
    const m = (result.mandate ?? null) as Record<string, unknown> | null;
    if (m && num(m.perTradeUsd) !== null && num(m.totalUsd) !== null) d.caps = { perTradeUsd: num(m.perTradeUsd)!, totalUsd: num(m.totalUsd)!, maxPriceImpactPct: num(m.maxPriceImpactPct) };
  }
  return Object.keys(d).length ? d : null;
}

/** task-1427: the top-10 share a holder read reported: get_holders / get_dossier (pools left out), get_token (Jupiter audit, raw). */
function holdersOf(tool: string, result: Record<string, unknown>): NonNullable<McpSpectatorRecord['detail']>['holders'] | null {
  const pct = (x: unknown): number | null => { const n = num(x); return n !== null && n >= 0 && n <= 100 ? n : null; };
  if (tool === 'get_holders' || tool === 'get_dossier') {
    const h = (tool === 'get_holders' ? result : result.concentration) as Record<string, unknown> | null | undefined;
    if (!h || typeof h !== 'object' || typeof h.error === 'string') return null;
    const p = pct(h.top10PctExLp);
    return p === null ? null : { top10Pct: p, count: num(h.holderCount), basis: 'ex-pools', ageSec: num(h.ageSec) };
  }
  if (tool === 'get_token') {
    const a = (result.audit ?? null) as Record<string, unknown> | null;
    const p = a ? pct(a.top10Pct) : null;
    const stats = (result.stats ?? null) as Record<string, unknown> | null;
    return p === null ? null : { top10Pct: p, count: stats ? num(stats.holderCount) : null, basis: 'raw', ageSec: num(a!.ageSec) };
  }
  return null;
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

// task-1443: an EXTERNAL `dexterm mcp` server has no DEXTERM_SCREEN_STATE (the running app did not spawn it), so it
// could never validate a navigation call against "the tokens currently on screen" and every nav tool failed — the
// following terminal never moved. While a terminal follows over MCP it publishes a reduced snapshot of its screen
// (screen, visible rows, selection, the action allow-list; no wallet, positions, tickets or app settings) here,
// refreshed about once a second; the server validates nav calls against it exactly as it does for the in-app analyst.

/** The follow-mode screen snapshot file name under ~/.dexterm. */
export const MCP_FOLLOW_SCREEN = 'mcp-screen.json';
/** A snapshot older than this is ignored (the terminal quit or froze): nav calls then fail closed. */
export const FOLLOW_SCREEN_MAX_AGE_MS = 10_000;

export function followScreenPath(env: NodeJS.ProcessEnv): string { return join(spectatorHome(env), MCP_FOLLOW_SCREEN); }

/** Write the follow-mode snapshot (0600). Best-effort: a write failure only means nav calls fail closed. */
export function writeFollowScreen(env: NodeJS.ProcessEnv, snapshot: Record<string, unknown>): void {
  try { writeFileSync(followScreenPath(env), JSON.stringify(snapshot) + '\n', { mode: 0o600 }); } catch { /* fail closed */ }
}

/** Remove the follow-mode snapshot (the terminal quit or stopped following). */
export function clearFollowScreen(env: NodeJS.ProcessEnv): void {
  try { rmSync(followScreenPath(env), { force: true }); } catch { /* ignore */ }
}

/** Read the follow-mode screen snapshot, or null when absent, malformed or stale. Never throws. */
export function readFollowScreen(env: NodeJS.ProcessEnv, now: number = Date.now()): Record<string, unknown> | null {
  const path = followScreenPath(env);
  try {
    const st = statSync(path);
    if (now - st.mtimeMs > FOLLOW_SCREEN_MAX_AGE_MS) return null;
    const o = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return o && typeof o === 'object' && !Array.isArray(o) ? o as Record<string, unknown> : null;
  } catch { return null; }
}

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
