// dexterm autotrade — the trade-fire delivery channels and their config (task-1645, 0.2.0 card A).
//
// The user enables any of these, in ONE place: the `signals` block of $DEXTERM_HOME/connectors.json, next to the
// Telegram setup (`dexterm autotrade signal channels …`, shown by `dexterm telegram status` too). No secret is in
// the file: the webhook's HMAC secret lives in the OS keychain store, like the bot token.
//
//   webhook    POST the signal line to a loopback URL (http://127.0.0.1|localhost|[::1]) or a user https URL.
//              Headers: x-dexterm-signature (HMAC, signal.ts), x-dexterm-nonce, idempotency-key. Redirects are an
//              error. 2xx = ack, 409 = duplicate (ack), 408/425/429 and 5xx/network = retry, other 4xx = rejected.
//   cmd        `--signal-cmd`: an argv (absolute program path, no shell, no PATH lookup); the signal line on stdin;
//              a minimal environment (no dexterm secret, DEXTERM_SIGNAL_SIGNATURE when an HMAC secret is set).
//              Exit 0 = ack, 2 = rejected, 3 = duplicate (ack), anything else or a 10 s timeout = retry.
//   jsonl      append the line to a stream file (default autotrade/real/signals.jsonl, 0600); an executor tails it.
//              task-1654: `signed` (opt-in, needs the HMAC secret) writes each line as an envelope instead,
//              {"schema":"dexterm-trade-fire-envelope/1","signature":"t=…,v1=…","signal":"<the exact signal line>"},
//              so a tailing executor can verify the HMAC like the webhook's.
//   mcp        append to autotrade/real/mcp-feed.jsonl, which the MCP tool `trade_fire_feed` reads (status only).
//   telegram   the human-visible copy to the paired chat (the bot cannot be the executor's input: a bot cannot read
//              another bot's messages). Never sufficient on its own for real mode.

import { spawn } from 'node:child_process';
import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { chooseSecretStore, secretStore, SIGNAL_HMAC_ITEM, type SecretStore, type SecretStoreKind } from './chat/secrets.ts';
import { loadConnectors, saveConnectors, CONNECTORS_SCHEMA, defaultTelegram } from './chat/config.ts';
import { inert, shortMint, usdShort } from './chat/format.ts';
import { realDir, type ChannelName, type DeliveryResult, type SignalChannel } from './outbox.ts';
import { clampTtl, signBody, SIGNAL_TTL_DEFAULT_SEC, type TradeFireSignal } from './signal.ts';

export interface SignalsConfig {
  webhook: { enabled: boolean; url: string | null; secretStore: SecretStoreKind | null };
  cmd: { enabled: boolean; argv: string[] };
  jsonl: { enabled: boolean; path: string | null; /** task-1654: HMAC envelope lines (see above). */ signed: boolean };
  mcp: { enabled: boolean };
  telegram: { enabled: boolean };
  /** How long an executor may act on a signal. */
  ttlSec: number;
  /** task-1654: the loopback listener a real run opens for heartbeats and receipts (executor-health.ts); null = off. */
  executor: { listenPort: number | null };
}

export const defaultSignalsConfig = (): SignalsConfig => ({
  webhook: { enabled: false, url: null, secretStore: null }, cmd: { enabled: false, argv: [] }, jsonl: { enabled: false, path: null, signed: false },
  mcp: { enabled: false }, telegram: { enabled: true }, ttlSec: SIGNAL_TTL_DEFAULT_SEC, executor: { listenPort: null },
});

export const streamPathDefault = (home: string): string => join(realDir(home), 'signals.jsonl');
export const mcpFeedPath = (home: string): string => join(realDir(home), 'mcp-feed.jsonl');

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** null when the URL may receive signals: loopback http(s), or https anywhere. No credentials in the URL. */
export function webhookUrlProblem(u: string): string | null {
  let url: URL;
  try { url = new URL(u); } catch { return 'not a URL'; }
  if (url.username || url.password) return 'credentials in a URL are refused (the HMAC secret lives in the keychain)';
  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:' && LOOPBACK.has(url.hostname)) return null;
  return 'use https://, or http:// to 127.0.0.1 / localhost / [::1] only';
}

export function argvProblem(argv: unknown): string | null {
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > 16) return 'the command is an argv array of 1 to 16 strings';
  if (!argv.every((a) => typeof a === 'string' && a.length > 0 && a.length <= 512 && !a.includes('\0'))) return 'every argv item is a non-empty string (512 chars max)';
  if (!isAbsolute(argv[0] as string)) return 'the program is an absolute path (no shell, no PATH lookup)';
  return null;
}

/** Read the `signals` block; anything invalid is turned off (fail closed), with the reasons. */
export function parseSignalsConfig(raw: unknown): { config: SignalsConfig; problems: string[] } {
  const c = defaultSignalsConfig();
  const problems: string[] = [];
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, Record<string, unknown> | number | undefined>;
  const w = (r.webhook ?? {}) as Record<string, unknown>;
  if (typeof w.url === 'string') { const p = webhookUrlProblem(w.url); if (p) problems.push(`webhook: ${p}`); else c.webhook.url = w.url; }
  c.webhook.enabled = w.enabled === true && c.webhook.url !== null;
  c.webhook.secretStore = w.secretStore === 'keychain' || w.secretStore === 'libsecret' || w.secretStore === 'file' ? w.secretStore : null;
  const m = (r.cmd ?? {}) as Record<string, unknown>;
  if (m.argv !== undefined) { const p = argvProblem(m.argv); if (p) problems.push(`cmd: ${p}`); else c.cmd.argv = [...(m.argv as string[])]; }
  c.cmd.enabled = m.enabled === true && c.cmd.argv.length > 0;
  const j = (r.jsonl ?? {}) as Record<string, unknown>;
  if (typeof j.path === 'string') { if (isAbsolute(j.path)) c.jsonl.path = j.path; else problems.push('jsonl: the stream path must be absolute'); }
  c.jsonl.enabled = j.enabled === true;
  c.jsonl.signed = j.signed === true;
  const ex = (r.executor ?? {}) as Record<string, unknown>;
  if (ex.listenPort !== undefined && ex.listenPort !== null) { const n = Number(ex.listenPort); if (Number.isInteger(n) && n >= 1024 && n <= 65535) c.executor.listenPort = n; else problems.push('executor: listenPort must be a whole number from 1024 to 65535'); }
  c.mcp.enabled = ((r.mcp ?? {}) as Record<string, unknown>).enabled === true;
  c.telegram.enabled = ((r.telegram ?? {}) as Record<string, unknown>).enabled !== false;
  c.ttlSec = clampTtl(typeof r.ttlSec === 'number' ? r.ttlSec : SIGNAL_TTL_DEFAULT_SEC);
  return { config: c, problems };
}

/** The `signals` block of connectors.json (a missing file or block = the defaults: only the Telegram copy). */
export function loadSignalsConfig(home: string): { config: SignalsConfig; problems: string[] } {
  const c = loadConnectors(home);
  if (!c.ok) return { config: { ...defaultSignalsConfig(), telegram: { enabled: false } }, problems: [c.error] };
  return parseSignalsConfig(c.config.signals);
}

/** Write the `signals` block back, keeping the Telegram setup as it is. */
export function saveSignalsConfig(home: string, sc: SignalsConfig): void {
  const c = loadConnectors(home);
  if (!c.ok) throw new Error(c.error);
  saveConnectors(home, { ...(c.ok ? c.config : { schema: CONNECTORS_SCHEMA, telegram: defaultTelegram() }), signals: sc });
}

export function enabledChannels(c: SignalsConfig): ChannelName[] {
  return [c.webhook.enabled ? 'webhook' : null, c.cmd.enabled ? 'cmd' : null, c.jsonl.enabled ? 'jsonl' : null, c.mcp.enabled ? 'mcp' : null, c.telegram.enabled ? 'telegram' : null].filter((x): x is ChannelName => !!x);
}

// ───────────────────────────── webhook ─────────────────────────────

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; redirect: 'error'; signal: AbortSignal }) => Promise<{ status: number }>;

export class WebhookChannel implements SignalChannel {
  readonly name = 'webhook' as const;
  private readonly o: { url: string; secret: () => string | null; fetch?: FetchLike; timeoutMs?: number; now?: () => number };
  constructor(o: { url: string; secret: () => string | null; fetch?: FetchLike; timeoutMs?: number; now?: () => number }) {
    const p = webhookUrlProblem(o.url);
    if (p) throw new Error(`webhook: ${p}`);
    this.o = o;
  }
  async deliver(s: TradeFireSignal, line: string): Promise<DeliveryResult> {
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-dexterm-nonce': String(s.nonce), 'idempotency-key': s.id, 'user-agent': 'dexterm-trade-fire/1' };
    const secret = this.o.secret();
    if (secret) headers['x-dexterm-signature'] = signBody(secret, line, (this.o.now ?? Date.now)());
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.o.timeoutMs ?? 5000);
    try {
      const f = this.o.fetch ?? (globalThis.fetch as unknown as FetchLike);
      const res = await f(this.o.url, { method: 'POST', headers, body: line, redirect: 'error', signal: ac.signal });
      if (res.status >= 200 && res.status < 300) return { ok: true };
      if (res.status === 409) return { ok: true, duplicate: true };
      if (res.status === 408 || res.status === 425 || res.status === 429 || res.status >= 500) return { ok: false, retry: true, why: `http ${res.status}` };
      return { ok: false, retry: false, why: `http ${res.status}` };
    } catch (e) {
      return { ok: false, retry: true, why: ac.signal.aborted ? 'timeout' : (e as Error).message.slice(0, 120) };
    } finally { clearTimeout(timer); }
  }
}

// ───────────────────────────── command hook ─────────────────────────────

export class CommandChannel implements SignalChannel {
  readonly name = 'cmd' as const;
  private readonly o: { argv: string[]; secret?: () => string | null; timeoutMs?: number; now?: () => number };
  constructor(o: { argv: string[]; secret?: () => string | null; timeoutMs?: number; now?: () => number }) {
    const p = argvProblem(o.argv);
    if (p) throw new Error(`signal-cmd: ${p}`);
    this.o = o;
  }
  deliver(s: TradeFireSignal, line: string): Promise<DeliveryResult> {
    const secret = this.o.secret?.() ?? null;
    // A minimal environment: no token, no RPC URL, no DEXTERM_* setting leaks into the user's executor.
    const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: process.env.LANG ?? 'C.UTF-8', DEXTERM_SIGNAL_NONCE: String(s.nonce), DEXTERM_SIGNAL_ID: s.id };
    if (process.env.HOME) env.HOME = process.env.HOME;
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    if (secret) env.DEXTERM_SIGNAL_SIGNATURE = signBody(secret, line, (this.o.now ?? Date.now)());
    return new Promise((done) => {
      let settled = false;
      const finish = (r: DeliveryResult) => { if (!settled) { settled = true; clearTimeout(timer); done(r); } };
      let child: ReturnType<typeof spawn>;
      try { child = spawn(this.o.argv[0], this.o.argv.slice(1), { shell: false, env, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true }); } catch (e) { done({ ok: false, retry: true, why: `spawn: ${(e as Error).message.slice(0, 100)}` }); return; }
      const timer = setTimeout(() => { child.kill('SIGKILL'); finish({ ok: false, retry: true, why: 'timeout' }); }, this.o.timeoutMs ?? 10_000);
      child.on('error', (e) => finish({ ok: false, retry: true, why: `spawn: ${e.message.slice(0, 100)}` }));
      child.on('close', (code) => finish(code === 0 ? { ok: true } : code === 3 ? { ok: true, duplicate: true } : code === 2 ? { ok: false, retry: false, why: 'rejected (exit 2)' } : { ok: false, retry: true, why: `exit ${code}` }));
      child.stdin!.on('error', () => { /* a hook that does not read stdin still decides by its exit code */ });
      child.stdin!.end(`${line}\n`);
    });
  }
}

// ───────────────────────────── JSONL stream / MCP feed ─────────────────────────────

export const ENVELOPE_SCHEMA = 'dexterm-trade-fire-envelope/1';

export class JsonlChannel implements SignalChannel {
  readonly name: 'jsonl' | 'mcp';
  readonly path: string;
  private readonly signer: { secret: () => string | null; now: () => number } | null;
  /** task-1654: `signed` = HMAC envelope lines (a secret must be set, else the line is retried until one is). */
  constructor(path: string, name: 'jsonl' | 'mcp' = 'jsonl', signed?: { secret: () => string | null; now?: () => number }) { this.path = path; this.name = name; this.signer = signed ? { secret: signed.secret, now: signed.now ?? Date.now } : null; }
  async deliver(_s: TradeFireSignal, line: string): Promise<DeliveryResult> {
    let out = line;
    if (this.signer) {
      const secret = this.signer.secret();
      if (!secret) return { ok: false, retry: true, why: 'signed stream: no HMAC secret set (dexterm autotrade signal secret generate --out FILE)' };
      out = JSON.stringify({ schema: ENVELOPE_SCHEMA, signature: signBody(secret, line, this.signer.now()), signal: line });
    }
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      const fd = openSync(this.path, 'a', 0o600);
      try { writeSync(fd, `${out}\n`); fsyncSync(fd); } finally { closeSync(fd); }
      return { ok: true };
    } catch (e) { return { ok: false, retry: true, why: (e as NodeJS.ErrnoException).code ?? (e as Error).message.slice(0, 80) }; }
  }
}

// ───────────────────────────── Telegram copy ─────────────────────────────

/** The human-visible copy (plain text lines, the LIVE badge). The symbol is already sanitized; it still goes through inert(). */
export function telegramLines(s: TradeFireSignal, now = Date.now()): string[] {
  const left = Math.max(0, Math.round((s.expiresAt - now) / 1000));
  const strat = `${inert(s.strategy.id, 32)} v${inert(s.strategy.version, 12)}`;
  if (s.type === 'halted') {
    // task-1679 (0.2.0 decision): open positions at the end of a real run must be impossible to miss.
    const open = s.open ?? [];
    return [
      `LIVE TRADE FIRE · HALTED · ${inert(s.reason, 40)}`,
      `${s.outstanding.length} outstanding signal(s) · run ${inert(s.runId.slice(-12), 16)} · account ${inert(s.accountId, 32)} · nonce ${s.nonce}`,
      ...(open.length ? [`${open.length} position(s): ${open.slice(0, 10).map(shortMint).join(', ')}${open.length > 10 ? ` +${open.length - 10} more` : ''}`, 'these positions are still open: manage them in your executor', 'until the next real run of this strategy, dexterm sends NO signal for them, sells included'] : []),
      'no more signals from this run',
    ];
  }
  if (s.type === 'test') return ['LIVE TRADE FIRE · TEST', `nonce ${s.nonce} · account ${inert(s.accountId, 32)} · never trade on this`];
  const size = s.side === 'buy' ? `${s.sizeSol} SOL (${usdShort(s.sizeUsd)}, ${s.pctOfBook}% of book)` : `${Math.round((s.sellFraction ?? 1) * 1000) / 10}% of the position (~${s.sizeSol} SOL)`;
  return [
    `LIVE TRADE FIRE · ${s.side.toUpperCase()} "${inert(s.symbol, 16)}" ${shortMint(s.mint)}`,
    `${size}${s.exitReason ? ` · ${inert(s.exitReason, 40)}` : ''}`,
    `${strat} · account ${inert(s.accountId, 32)} · nonce ${s.nonce} · ignore after ${left} s`,
    'your executor acts on it, not this chat',
  ];
}

export class TelegramCopyChannel implements SignalChannel {
  readonly name = 'telegram' as const;
  private readonly send: (lines: string[]) => Promise<void>;
  private readonly now: () => number;
  constructor(send: (lines: string[]) => Promise<void>, now: () => number = Date.now) { this.send = send; this.now = now; }
  async deliver(s: TradeFireSignal): Promise<DeliveryResult> {
    try { await this.send(telegramLines(s, this.now())); return { ok: true }; } catch (e) { return { ok: false, retry: true, why: (e as Error).message.slice(0, 120) }; }
  }
}

// ───────────────────────────── from the config ─────────────────────────────

/** Where the webhook's HMAC secret is (the store setup recorded, else the best on this machine). */
export function hmacStore(home: string, sc: SignalsConfig, env: NodeJS.ProcessEnv = process.env): SecretStore {
  return sc.webhook.secretStore ? secretStore(sc.webhook.secretStore, home, SIGNAL_HMAC_ITEM) : chooseSecretStore(home, env, process.platform, SIGNAL_HMAC_ITEM);
}

export interface ChannelSeams { telegram?: (lines: string[]) => Promise<void>; fetch?: FetchLike; secret?: SecretStore; env?: NodeJS.ProcessEnv; now?: () => number }

/**
 * The channel objects for a config. Without a Telegram sender (outside a run) the copy is deferred: it stays pending
 * in the outbox for the next run instead of being dropped. The secret is read once, on first use.
 */
export function channelsFromConfig(home: string, sc: SignalsConfig, o: ChannelSeams = {}): { channels: SignalChannel[]; defer: ChannelName[] } {
  let cached: string | null | undefined;
  const store = o.secret ?? hmacStore(home, sc, o.env);
  const secret = () => { if (cached === undefined) { try { cached = store.get(); } catch { cached = null; } } return cached; };
  const out: SignalChannel[] = [];
  const defer: ChannelName[] = [];
  if (sc.webhook.enabled && sc.webhook.url) out.push(new WebhookChannel({ url: sc.webhook.url, secret, fetch: o.fetch, now: o.now }));
  if (sc.cmd.enabled && sc.cmd.argv.length) out.push(new CommandChannel({ argv: sc.cmd.argv, secret, now: o.now }));
  if (sc.jsonl.enabled) out.push(new JsonlChannel(sc.jsonl.path ?? streamPathDefault(home), 'jsonl', sc.jsonl.signed ? { secret, now: o.now } : undefined));
  if (sc.mcp.enabled) out.push(new JsonlChannel(mcpFeedPath(home), 'mcp'));
  if (sc.telegram.enabled) { if (o.telegram) out.push(new TelegramCopyChannel(o.telegram, o.now)); else defer.push('telegram'); }
  return { channels: out, defer };
}
