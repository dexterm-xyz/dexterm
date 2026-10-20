// @dexterm/agents — the spectator event model, redaction, hub and save/replay (task-1406, "watch the
// agent cook"). One normalized record per observable agent action is emitted by the tool-call path (the
// bus's onCall, and the MCP tools/call path via a file sink) into a SpectatorHub. The hub keeps the raw
// events in a ring buffer and fans them out; each consumer redacts for its audience:
//   * follow mode (local, the owner's own terminal) sees the RAW events;
//   * the spectator STREAM and the SAVED file redact wallet addresses, keys and sensitive-named fields.
// Nothing here can arm, sign, confirm or raise a cap — a spectator event only describes a call the gate
// already allowed; there is no control surface in this module (see spectator-server.ts: read-only).

import { appendFileSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Tier } from './tiers.ts';

export const SPECTATOR_PROTOCOL = 'dexterm-spectator/1';
export const SPECTATOR_SCHEMA = 1 as const;

export type SpectatorPhase =
  | 'connect' | 'disconnect' | 'call' | 'result' | 'proposal' | 'refused' | 'nav' | 'note' | 'subscribe' | 'control';

/** What the agent asked the screen to show (navigation tools). The FollowController folds this into a screen model. */
export interface SpectatorNav {
  screen?: string;
  mint?: string;
  feed?: string;
  filter?: string;
  highlight?: string;
  side?: string;
}

/**
 * task-1466: the app-computed numbers behind a call, so the follow view can SHOW the work (which rows a scan
 * returned, the verdict, the PAPER ticket / fill / position) instead of a tool name. Every figure is copied from
 * the tool's own result, never derived from agent text. Optional and local: the MCP wire is unchanged; this rides
 * only on the 0600 spectator channel and is redacted (addresses masked) like every other field when it leaves.
 */
export interface SpectatorDetail {
  /** Rows a screener/list call returned, in screen order (≤ 12). `chg` is the 1h change in percent. */
  rows?: Array<{ mint: string; symbol: string; chg?: number | null }>;
  /** The coin a read/nav call was about, with its price when the result carried one. */
  coin?: { mint: string; symbol?: string | null; priceUsd?: number | null };
  /** analyze_token: the deterministic verdict and the pre-registered rug heuristic (0..1). */
  verdict?: { label: string; rug?: number | null };
  /** larp_check: mechanical evidence flags found (not a verdict). */
  larp?: { flags: number; items: string[] };
  /** A PAPER ticket (open / size). `usd` for a buy, `fraction` for a sell. */
  ticket?: { side: 'buy' | 'sell'; symbol: string; mint: string; usd?: number | null; fraction?: number | null };
  /** A booked PAPER fill (confirm / close). `sol` is the signed SOL change; `qty` the token amount. */
  fill?: { side: 'buy' | 'sell'; symbol: string; mint: string; sol: number; qty: number; priceUsd: number | null; impactPct: number | null; realizedSol: number | null };
  /** The PAPER position after a fill (cost basis, realized; the mark is layered on by the viewer). */
  position?: { mint: string; symbol: string; qty: number; costSol: number; realizedSol: number };
  /** paper_pnl: the mandate caps in force (USD), as the desk replayed them. */
  caps?: { perTradeUsd: number; totalUsd: number; maxPriceImpactPct: number | null };
  /** A paper desk refusal's stable reason code (per-trade cap, paused, stopped, …). */
  refusal?: string;
}

/** One observable action. Stored raw in the hub; redacted on the way to any non-local audience. */
export interface SpectatorEvent {
  v: typeof SPECTATOR_SCHEMA;
  seq: number;
  t: number;
  phase: SpectatorPhase;
  agent: string;
  tier?: Tier | null;
  transport?: 'bus' | 'mcp' | 'test';
  tool?: string | null;
  summary?: string;
  ok: boolean;
  ms?: number | null;
  dataAgeSec?: number | null;
  refusal?: string | null;
  nav?: SpectatorNav | null;
  /** task-1466: app-computed numbers behind the call (see SpectatorDetail). */
  detail?: SpectatorDetail | null;
  /** Marked sensitive by the producer → the summary is fully redacted in spectator/saved output. */
  sensitive?: boolean;
  /** Set by redactSpectatorEvent once a copy has been produced for a non-local audience. */
  redacted?: boolean;
}

/** The fields a producer supplies; the hub assigns v/seq/t and defaults ok. */
export type SpectatorEventInput = Omit<SpectatorEvent, 'v' | 'seq' | 't' | 'ok'> & { t?: number; ok?: boolean };

// ---------------------------------------------------------------------------------------------------
// Redaction. Addresses are truncated (still watchable); keys are removed entirely; sensitive-named
// fields are blanked. A full wallet address never appears verbatim in a redacted string.

/** base58 alphabet (Bitcoin / Solana): no 0 O I l. */
const BASE58 = '[1-9A-HJ-NP-Za-km-z]';
/** A base58 run of 32–44 chars is a Solana pubkey (wallet or mint); ≥45 is key material. */
const ADDR_RE = new RegExp(`${BASE58}{32,44}`, 'g');
const LONG_B58_RE = new RegExp(`${BASE58}{45,}`, 'g');
/** A hex run of ≥64 chars is a 32-byte key / signature. */
const HEX_KEY_RE = /\b[0-9a-fA-F]{64,}\b/g;

export const SENSITIVE_KEY_RE =
  /(secret|private|privkey|mnemonic|seed|passphrase|password|signature|sig|apikey|api[_-]?key|keypair|token)/i;

/** Mask one address the way the product's shortAddr does (head4…tail4). */
export function maskAddress(s: string): string {
  return s.length <= 10 ? s : `${s.slice(0, 4)}…${s.slice(-4)}`;
}

/** Redact every address / key in a string. Keys (long runs) first so a 45-char run is not truncated as a 44. */
export function redactString(s: string): string {
  return s
    .replace(LONG_B58_RE, '[key]')
    .replace(HEX_KEY_RE, '[key]')
    .replace(ADDR_RE, (m) => maskAddress(m));
}

/** Deep-redact a JSON value: sensitive-named keys → "[redacted]", strings scrubbed of addresses/keys. */
export function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > 8) return value;
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY_RE.test(k) ? '[redacted]' : redactDeep(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** A redacted COPY of an event, safe for a shared stream or a saved file. The original is never mutated.
 *  EVERY string field is scrubbed — not just the summary — because the producer (bus.ts onCall) copies
 *  the agent-supplied tool name straight into `tool`/`refusal` on a refused call, so an untrusted agent
 *  can put a wallet address or key there; `agent` and the nav strings are redacted too so no path can
 *  leak a full address / key verbatim into a shared stream or a saved file. */
export function redactSpectatorEvent(ev: SpectatorEvent): SpectatorEvent {
  const out: SpectatorEvent = { ...ev, redacted: true };
  if (ev.sensitive) {
    out.summary = '[sensitive]';
  } else if (typeof ev.summary === 'string') {
    out.summary = redactString(ev.summary);
  }
  // Scrub the remaining string fields. Addresses are masked (still watchable), key material → "[key]".
  if (typeof ev.tool === 'string') out.tool = redactString(ev.tool);
  if (typeof ev.refusal === 'string') out.refusal = redactString(ev.refusal);
  if (typeof ev.agent === 'string') out.agent = redactString(ev.agent);
  if (ev.nav) {
    out.nav = { ...ev.nav };
    if (out.nav.screen) out.nav.screen = redactString(out.nav.screen);
    if (out.nav.mint) out.nav.mint = maskAddress(out.nav.mint);
    if (out.nav.feed) out.nav.feed = redactString(out.nav.feed);
    if (out.nav.filter) out.nav.filter = redactString(out.nav.filter);
    if (out.nav.highlight) out.nav.highlight = maskAddress(out.nav.highlight);
    if (out.nav.side) out.nav.side = redactString(out.nav.side);
  }
  // task-1466: the detail carries mints and symbols; every string in it is scrubbed (addresses masked).
  if (ev.detail) out.detail = redactDeep(ev.detail) as SpectatorDetail;
  return out;
}

const finiteOr = (x: unknown, d: number | null = null): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : d);
// eslint-disable-next-line no-control-regex
const UNSAFE_RE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;
const shortStr = (x: unknown, max: number): string => (typeof x === 'string' ? x.replace(UNSAFE_RE, '').slice(0, max) : '');
const isMintish = (x: unknown): x is string => typeof x === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(x);

/**
 * task-1466: re-validate a detail read off the local channel (shape, types, lengths). The channel is our own
 * server's 0600 file and token-checked, but the viewer still treats it as data: anything malformed is dropped,
 * strings are stripped of control/bidi characters and capped, numbers must be finite. Returns null when empty.
 */
export function sanitizeDetail(raw: unknown): SpectatorDetail | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out: SpectatorDetail = {};
  if (Array.isArray(r.rows)) {
    const rows = r.rows.slice(0, 12).flatMap((x) => {
      const o = x as Record<string, unknown> | null;
      return o && isMintish(o.mint) ? [{ mint: o.mint, symbol: shortStr(o.symbol, 16) || '?', chg: finiteOr(o.chg) }] : [];
    });
    if (rows.length) out.rows = rows;
  }
  const c = r.coin as Record<string, unknown> | undefined;
  if (c && isMintish(c.mint)) out.coin = { mint: c.mint, symbol: shortStr(c.symbol, 16) || null, priceUsd: finiteOr(c.priceUsd) };
  const v = r.verdict as Record<string, unknown> | undefined;
  if (v && typeof v.label === 'string' && v.label) out.verdict = { label: shortStr(v.label, 18), rug: finiteOr(v.rug) };
  const l = r.larp as Record<string, unknown> | undefined;
  if (l && finiteOr(l.flags) !== null) out.larp = { flags: Math.max(0, Math.min(99, Math.round(l.flags as number))), items: Array.isArray(l.items) ? l.items.slice(0, 6).map((s) => shortStr(s, 60)).filter(Boolean) : [] };
  const side = (s: unknown): 'buy' | 'sell' | null => (s === 'buy' || s === 'sell' ? s : null);
  const tk = r.ticket as Record<string, unknown> | undefined;
  if (tk && side(tk.side) && isMintish(tk.mint)) out.ticket = { side: side(tk.side)!, symbol: shortStr(tk.symbol, 16) || '?', mint: tk.mint, usd: finiteOr(tk.usd), fraction: finiteOr(tk.fraction) };
  const f = r.fill as Record<string, unknown> | undefined;
  if (f && side(f.side) && isMintish(f.mint) && finiteOr(f.sol) !== null && finiteOr(f.qty) !== null) {
    out.fill = { side: side(f.side)!, symbol: shortStr(f.symbol, 16) || '?', mint: f.mint, sol: f.sol as number, qty: f.qty as number, priceUsd: finiteOr(f.priceUsd), impactPct: finiteOr(f.impactPct), realizedSol: finiteOr(f.realizedSol) };
  }
  const p = r.position as Record<string, unknown> | undefined;
  if (p && isMintish(p.mint) && finiteOr(p.qty) !== null && finiteOr(p.costSol) !== null) {
    out.position = { mint: p.mint, symbol: shortStr(p.symbol, 16) || '?', qty: p.qty as number, costSol: p.costSol as number, realizedSol: finiteOr(p.realizedSol, 0) as number };
  }
  const cp = r.caps as Record<string, unknown> | undefined;
  if (cp && finiteOr(cp.perTradeUsd) !== null && finiteOr(cp.totalUsd) !== null) out.caps = { perTradeUsd: cp.perTradeUsd as number, totalUsd: cp.totalUsd as number, maxPriceImpactPct: finiteOr(cp.maxPriceImpactPct) };
  if (typeof r.refusal === 'string' && r.refusal) out.refusal = shortStr(r.refusal, 40);
  return Object.keys(out).length ? out : null;
}

// ---------------------------------------------------------------------------------------------------
// Freshness: the oldest/largest `ageSec` anywhere in a tool result, so the activity panel can show a
// "data age" like the terminal does. Deterministic, bounded depth; returns null when nothing is dated.

export function maxDataAgeSec(result: unknown, depth = 0): number | null {
  if (depth > 6 || !result || typeof result !== 'object') return null;
  let max: number | null = null;
  const take = (n: unknown): void => { if (typeof n === 'number' && Number.isFinite(n) && n >= 0) max = max === null ? n : Math.max(max, n); };
  for (const [k, v] of Object.entries(result as Record<string, unknown>)) {
    if (k === 'ageSec') take(v);
    else { const inner = maxDataAgeSec(v, depth + 1); if (inner !== null) take(inner); }
  }
  return max;
}

// ---------------------------------------------------------------------------------------------------
// The hub: a ring buffer + fan-out. Producers call emit(); consumers subscribe with on().

export interface SpectatorHubOptions {
  now?: () => number;
  /** Ring-buffer cap (events kept for replay-on-connect). Default 500. */
  cap?: number;
}

export class SpectatorHub {
  private readonly listeners = new Set<(ev: SpectatorEvent) => void>();
  private readonly ring: SpectatorEvent[] = [];
  private readonly now: () => number;
  private readonly cap: number;
  private seq = 0;

  constructor(opts: SpectatorHubOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.cap = Math.max(1, opts.cap ?? 500);
  }

  /** Emit one event. Assigns v/seq/t and defaults ok:true. Returns the stored (raw) event. */
  emit(input: SpectatorEventInput): SpectatorEvent {
    const ev: SpectatorEvent = { v: SPECTATOR_SCHEMA, seq: ++this.seq, t: input.t ?? this.now(), ok: input.ok ?? true, ...stripUndef(input) };
    ev.v = SPECTATOR_SCHEMA; ev.seq = this.seq; // keep after spread in case input carried stray keys
    this.ring.push(ev);
    if (this.ring.length > this.cap) this.ring.splice(0, this.ring.length - this.cap);
    for (const l of this.listeners) { try { l(ev); } catch { /* one bad listener never stops the fan-out */ } }
    return ev;
  }

  /** Subscribe; returns an unsubscribe fn. */
  on(listener: (ev: SpectatorEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  /** The most recent events, oldest-first (for replay-on-connect / the activity panel). */
  recent(limit = this.cap): SpectatorEvent[] { return this.ring.slice(Math.max(0, this.ring.length - limit)); }

  clear(): void { this.ring.length = 0; }
  get size(): number { return this.ring.length; }
}

function stripUndef<T extends Record<string, unknown>>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as T;
}

// ---------------------------------------------------------------------------------------------------
// Save / replay. A recording is a JSONL file: a header line then one event per line. Saved REDACTED by
// default (safe to share for a demo or a bug report); pass { redact: false } for a full local capture.

export interface SpectatorMeta {
  protocol: typeof SPECTATOR_PROTOCOL;
  schema: typeof SPECTATOR_SCHEMA;
  savedAt: number;
  redacted: boolean;
  note?: string;
}
export interface SpectatorRecording { meta: SpectatorMeta; events: SpectatorEvent[] }

/** Attach to a hub and append each event to a sink (default: a file, 0600). Redacts unless redact:false. */
export class SpectatorRecorder {
  private off: (() => void) | null = null;
  private readonly redact: boolean;
  private readonly write: (line: string) => void;
  private count = 0;
  constructor(opts: { path?: string; write?: (line: string) => void; redact?: boolean; now?: () => number; note?: string }) {
    this.redact = opts.redact ?? true;
    const now = opts.now ?? (() => Date.now());
    if (opts.write) {
      this.write = opts.write;
    } else if (opts.path) {
      const p = opts.path;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, '', { mode: 0o600 });
      this.write = (line) => appendFileSync(p, line + '\n', { mode: 0o600 });
    } else {
      throw new Error('SpectatorRecorder needs a path or a write sink');
    }
    const meta: SpectatorMeta = { protocol: SPECTATOR_PROTOCOL, schema: SPECTATOR_SCHEMA, savedAt: now(), redacted: this.redact, note: opts.note };
    this.write(JSON.stringify({ meta }));
  }
  /** Record one event (redacting a copy when redact is on). */
  record(ev: SpectatorEvent): void { this.write(JSON.stringify(this.redact ? redactSpectatorEvent(ev) : ev)); this.count++; }
  /** Start recording every event a hub emits from now on. */
  attach(hub: SpectatorHub): this { this.off = hub.on((ev) => this.record(ev)); return this; }
  stop(): number { this.off?.(); this.off = null; return this.count; }
  get written(): number { return this.count; }
}

/** Parse a JSONL recording (header line + events). Tolerant: bad lines are skipped. */
export function parseSpectatorRecording(text: string): SpectatorRecording {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  let meta: SpectatorMeta | null = null;
  const events: SpectatorEvent[] = [];
  for (const line of lines) {
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (!meta && obj.meta && typeof obj.meta === 'object') { meta = obj.meta as SpectatorMeta; continue; }
    if (typeof obj.seq === 'number' && typeof obj.phase === 'string') events.push(obj as unknown as SpectatorEvent);
  }
  events.sort((a, b) => a.seq - b.seq);
  return { meta: meta ?? { protocol: SPECTATOR_PROTOCOL, schema: SPECTATOR_SCHEMA, savedAt: 0, redacted: false }, events };
}

/** Load a recording from a file. */
export function loadSpectatorRecording(path: string): SpectatorRecording {
  return parseSpectatorRecording(readFileSync(path, 'utf8'));
}

/** Replay a recording's events into a handler (a FollowController.apply, a hub.emit, or a sink), in order. */
export function replaySpectator(recording: SpectatorRecording, handle: (ev: SpectatorEvent) => void): number {
  for (const ev of recording.events) handle(ev);
  return recording.events.length;
}
