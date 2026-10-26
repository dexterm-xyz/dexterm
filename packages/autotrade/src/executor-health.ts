// dexterm autotrade — executor health: heartbeats, the silence pause, the loopback listener (task-1654, 0.2.0 card E).
//
// Your executor (or the reference kit, examples/executor/) says it is alive by appending a
// `dexterm-executor-heartbeat/1` line to $DEXTERM_HOME/autotrade/real/executor.jsonl, by running
// `dexterm autotrade executor heartbeat`, or by POSTing it to the optional loopback listener a real run opens
// (`dexterm autotrade signal channels --executor-port N`: 127.0.0.1 only, the same HMAC as the webhook when a secret
// is set, /heartbeat and /receipt, 4 KB bodies). A receipt, and an ack on the webhook or command hook, count as
// signs of life too (the JSONL stream and the MCP feed prove nothing: dexterm writes those itself).
//
// When nothing has been heard for longer than the user's `executorSilenceMin` (limits.json; placeholder 15 min) a real
// run PAUSES new buy signals and says so (run log, Telegram). Exits still go out, and the kill switch and the TTL are
// unchanged. When the executor is heard again, buys resume and that is said too. Heartbeats are data: they never make
// dexterm do anything except pause or resume.

import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, renameSync, statSync, writeSync, fsyncSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { realDir } from './outbox.ts';
import { appendReceipt, readReceipts, validateReceipt, type Receipt } from './receipts.ts';
import { ACCOUNT_ID_RE, verifyBody, type TradeFireSignal } from './signal.ts';

export const HEARTBEAT_SCHEMA = 'dexterm-executor-heartbeat/1';
export const heartbeatPath = (home: string): string => join(realDir(home), 'executor.jsonl');
const ROTATE_ABOVE = 1 << 20;
const TAIL_BYTES = 64 << 10;

export interface Heartbeat {
  schema: typeof HEARTBEAT_SCHEMA;
  at: number;
  /** A short name for the executor (printable ASCII, 32 max). */
  executor: string;
  accountId: string | null;
  /** True when the executor only logs what it would do. */
  dryRun: boolean | null;
  /** The newest nonce it has seen. */
  lastNonce: number | null;
  note: string | null;
}

const text = (v: unknown, max: number): string | null => { if (typeof v !== 'string') return null; const t = v.replace(/[^\x20-\x7e]/g, '').trim().slice(0, max); return t || null; };

export function validateHeartbeat(x: unknown): { ok: true; heartbeat: Heartbeat } | { ok: false; error: string } {
  const h = x as Record<string, unknown>;
  if (!h || typeof h !== 'object') return { ok: false, error: 'not an object' };
  if (h.schema !== HEARTBEAT_SCHEMA) return { ok: false, error: 'schema' };
  if (typeof h.at !== 'number' || !Number.isFinite(h.at) || h.at <= 0) return { ok: false, error: 'at' };
  const executor = text(h.executor, 32);
  if (!executor) return { ok: false, error: 'executor' };
  if (h.accountId !== undefined && h.accountId !== null && (typeof h.accountId !== 'string' || !ACCOUNT_ID_RE.test(h.accountId))) return { ok: false, error: 'accountId' };
  if (h.lastNonce !== undefined && h.lastNonce !== null && (!Number.isSafeInteger(h.lastNonce) || (h.lastNonce as number) < 0)) return { ok: false, error: 'lastNonce' };
  return { ok: true, heartbeat: { schema: HEARTBEAT_SCHEMA, at: h.at, executor, accountId: typeof h.accountId === 'string' ? h.accountId : null, dryRun: typeof h.dryRun === 'boolean' ? h.dryRun : null, lastNonce: typeof h.lastNonce === 'number' ? h.lastNonce : null, note: text(h.note, 120) } };
}

/** Append one heartbeat (fsync); the file is rotated to executor.1.jsonl past 1 MB. */
export function appendHeartbeat(home: string, hb: Omit<Heartbeat, 'schema'> & { schema?: string }): Heartbeat {
  const v = validateHeartbeat({ ...hb, schema: HEARTBEAT_SCHEMA });
  if (!v.ok) throw new Error(`heartbeat: ${v.error}`);
  mkdirSync(realDir(home), { recursive: true, mode: 0o700 });
  const p = heartbeatPath(home);
  try { if (statSync(p).size > ROTATE_ABOVE) renameSync(p, join(realDir(home), 'executor.1.jsonl')); } catch { /* no file yet */ }
  const fd = openSync(p, 'a', 0o600);
  try { writeSync(fd, `${JSON.stringify(v.heartbeat)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  return v.heartbeat;
}

const hbCache = new Map<string, { size: number; mtimeMs: number; hb: Heartbeat | null }>();

/** The newest valid heartbeat (reads only the last 64 KB, and only when the file changed since the last read). */
export function lastHeartbeat(home: string): Heartbeat | null {
  const p = heartbeatPath(home);
  if (!existsSync(p)) return null;
  const fd = openSync(p, 'r');
  try {
    const st = fstatSync(fd);
    const size = st.size;
    const c = hbCache.get(p);
    if (c && c.size === size && c.mtimeMs === st.mtimeMs) return c.hb;
    const n = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(n);
    readSync(fd, buf, 0, n, size - n);
    const lines = buf.toString('utf8').split('\n');
    let best: Heartbeat | null = null;
    for (const l of lines) {
      if (!l.trim()) continue;
      try { const v = validateHeartbeat(JSON.parse(l)); if (v.ok && (!best || v.heartbeat.at > best.at)) best = v.heartbeat; } catch { /* torn or partial line */ }
    }
    hbCache.set(p, { size, mtimeMs: st.mtimeMs, hb: best });
    return best;
  } finally { closeSync(fd); }
}

export interface ExecutorHealth {
  /** null = nothing set up to judge it (no window). */
  alive: boolean | null;
  windowMin: number | null;
  lastSeenAt: number | null;
  /** What the last sign of life was. */
  lastSeenBy: 'heartbeat' | 'receipt' | 'ack' | 'run-start' | null;
  silentSec: number | null;
  heartbeat: { at: number; executor: string; dryRun: boolean | null; lastNonce: number | null } | null;
  lastReceipt: { at: number; nonce: number; status: string } | null;
  /** Median seconds from a signal's issue to its receipt (the last 20 receipts with a known signal). */
  receiptLagSec: number | null;
}

/**
 * How the executor looks now. `ackAt` = the newest ack on the webhook or command hook (the outbox's channel health,
 * this process); `since` = a floor for "last seen" (the run's start: a run is not paused in its first window).
 */
export function executorHealth(home: string, o: { now: number; windowMin?: number | null; ackAt?: number | null; since?: number | null; signal?: (nonce: number) => TradeFireSignal | undefined; receipts?: Receipt[] }): ExecutorHealth {
  const hb = lastHeartbeat(home);
  const receipts = o.receipts ?? readReceipts(home).receipts;
  const last = receipts.reduce<Receipt | null>((a, r) => (!a || r.at > a.at ? r : a), null);
  const cands: [number, ExecutorHealth['lastSeenBy']][] = [];
  if (hb) cands.push([hb.at, 'heartbeat']);
  if (last) cands.push([last.at, 'receipt']);
  if (o.ackAt) cands.push([o.ackAt, 'ack']);
  if (o.since) cands.push([o.since, 'run-start']);
  const best = cands.reduce<[number, ExecutorHealth['lastSeenBy']] | null>((a, c) => (!a || c[0] > a[0] ? c : a), null);
  const lags: number[] = [];
  if (o.signal) for (const r of receipts.slice(-20)) { const s = o.signal(r.nonce); if (s && s.id === r.signalId) lags.push(Math.max(0, (r.at - s.issuedAt) / 1000)); }
  lags.sort((a, b) => a - b);
  const silentSec = best ? Math.max(0, Math.round((o.now - best[0]) / 1000)) : null;
  const windowMin = o.windowMin ?? null;
  return {
    alive: windowMin === null ? null : silentSec !== null && silentSec <= windowMin * 60,
    windowMin, lastSeenAt: best?.[0] ?? null, lastSeenBy: best?.[1] ?? null, silentSec,
    heartbeat: hb ? { at: hb.at, executor: hb.executor, dryRun: hb.dryRun, lastNonce: hb.lastNonce } : null,
    lastReceipt: last ? { at: last.at, nonce: last.nonce, status: last.status } : null,
    receiptLagSec: lags.length ? Math.round(lags[Math.floor(lags.length / 2)] * 10) / 10 : null,
  };
}

const ago = (sec: number): string => (sec < 90 ? `${sec} s` : sec < 5400 ? `${Math.round(sec / 60)} min` : `${Math.round(sec / 3600)} h`);

export function healthLine(h: ExecutorHealth): string {
  const state = h.alive === null ? (h.lastSeenAt ? 'seen' : 'never seen') : h.alive ? 'ALIVE' : 'SILENT';
  const parts = [state];
  if (h.silentSec !== null && h.lastSeenBy && h.lastSeenBy !== 'run-start') parts.push(`last ${h.lastSeenBy} ${ago(h.silentSec)} ago`);
  else if (h.lastSeenBy === 'run-start') parts.push('nothing heard since the run started');
  if (h.heartbeat) parts.push(`${h.heartbeat.executor}${h.heartbeat.dryRun ? ' (dry run)' : ''}`);
  if (h.lastReceipt) parts.push(`last receipt #${h.lastReceipt.nonce} ${h.lastReceipt.status}`);
  if (h.receiptLagSec !== null) parts.push(`receipt lag ${h.receiptLagSec} s`);
  if (h.windowMin !== null) parts.push(`pause after ${h.windowMin} min silent`);
  return parts.join(' · ');
}

// ───────────────────────────── the loopback listener ─────────────────────────────

export interface ExecutorListener { port: number; close(): Promise<void> }

/**
 * A loopback-only HTTP listener for executors that prefer to POST: /heartbeat (a heartbeat body) and /receipt (a
 * receipt body). With a secret, the `x-dexterm-signature` header (the webhook's scheme) is required. Writes the same
 * files the CLI and the kit append to. Never acts on anything.
 */
export function startExecutorListener(o: { home: string; port: number; secret?: () => string | null; now?: () => number; host?: string }): Promise<ExecutorListener> {
  const host = o.host ?? '127.0.0.1';
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) return Promise.reject(new Error('the executor listener binds to loopback only'));
  const now = o.now ?? Date.now;
  const server: Server = createServer((req, res) => {
    const reply = (code: number, body: string) => { res.writeHead(code, { 'content-type': 'text/plain' }); res.end(body); };
    if (req.method !== 'POST' || (req.url !== '/heartbeat' && req.url !== '/receipt')) return reply(404, 'POST /heartbeat or /receipt');
    let body = '';
    let tooBig = false;
    req.setEncoding('utf8');
    req.on('data', (c: string) => { body += c; if (body.length > 4096) { tooBig = true; req.destroy(); } });
    req.on('end', () => {
      if (tooBig) return;
      const secret = o.secret?.() ?? null;
      if (secret) { const v = verifyBody(secret, req.headers['x-dexterm-signature'] as string | undefined, body, now()); if (!v.ok) return reply(401, v.why); }
      let raw: unknown;
      try { raw = JSON.parse(body); } catch { return reply(400, 'not json'); }
      try {
        if (req.url === '/heartbeat') { const v = validateHeartbeat({ ...(raw as object), schema: HEARTBEAT_SCHEMA }); if (!v.ok) return reply(400, v.error); appendHeartbeat(o.home, v.heartbeat); return reply(204, ''); }
        const v = validateReceipt(raw);
        if (!v.ok) return reply(400, v.error);
        appendReceipt(o.home, v.receipt);
        return reply(204, '');
      } catch (e) { return reply(500, (e as Error).message.slice(0, 80)); }
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port, host, () => {
      const a = server.address();
      resolve({ port: typeof a === 'object' && a ? a.port : o.port, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}
