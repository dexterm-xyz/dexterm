// dexterm autotrade — the LIVE TRADE FIRE signal, `dexterm-trade-fire/1` (task-1645, 0.2.0 card A).
//
// A strategy in mode "real" trades exactly like paper (same clamp, exits, monitor and ledger: the paper fill model is
// the monitor's own view), and every buy or sell it fills also becomes one of these signals for the user's OWN
// executor (a Telegram trading bot of their choice, or any script). dexterm holds no key, signs no transaction and
// builds none: a signal is a request the executor may act on, ignore, or reject.
//
//   type "trade"    side buy|sell, mint, sanitized symbol, size in SOL / USD / % of book (a sell also as the fraction
//                   of the position), price + mcap + liquidity context, exit reason for a sell, strategy id/version/
//                   hash, run id, account id, nonce, idempotency key, issued/expires, `paper: false`
//   type "halted"   the run stopped (end, halt, kill, a lost runner): every outstanding signal's nonce, a reason, and
//                   `open`: the mints dexterm still counts as held for the account (the next real run of the
//                   strategy takes them over and keeps their exits; they still count against the open-position cap)
//   type "test"     `dexterm autotrade signal test`: proves the channel; an executor must never trade on it
//
// Rules an executor follows (and SignalReceiver below implements, for scripts and the tests' fake executors):
//   1. verify the HMAC header when a secret is set (`x-dexterm-signature: t=<unix s>,v1=<hex>` over "<t>.<body>")
//   2. ignore anything past `expiresAt` (the TTL): a late signal is never acted on
//   3. dedupe by nonce (and the idempotency key `id`): delivery is at-least-once, so a repeat is normal
//   4. act only on the account id it was set up for
//
// Firewall: nothing token-authored rides along except the symbol, reduced to [A-Za-z0-9._$-] (16 chars). No name,
// no description, no links, no agent text, no paths, no keys. Every other field is an engine number or an id that
// dexterm validated itself.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const TRADE_FIRE_SCHEMA = 'dexterm-trade-fire/1';
export const SIGNAL_TTL_DEFAULT_SEC = 60;
export const SIGNAL_TTL_MIN_SEC = 10;
export const SIGNAL_TTL_MAX_SEC = 600;
/** How far a signature's timestamp may sit from the receiver's clock. */
export const SIGNATURE_TOLERANCE_SEC = 300;

export type SignalType = 'trade' | 'halted' | 'test';

interface SignalBase {
  schema: typeof TRADE_FIRE_SCHEMA;
  type: SignalType;
  /** The idempotency key: sha256(account, run, nonce), 32 hex. */
  id: string;
  /** Strictly increasing per dexterm home, across runs and restarts. */
  nonce: number;
  issuedAt: number;
  /** Unix ms after which the executor must ignore this signal. */
  expiresAt: number;
  ttlSec: number;
  runId: string;
  accountId: string;
  strategy: { id: string; version: string; hash: string };
  /** Always false: this is the real-mode signal. A paper run never emits one. */
  paper: false;
}

export interface TradeSignal extends SignalBase {
  type: 'trade';
  side: 'buy' | 'sell';
  mint: string;
  symbol: string;
  /** The order size in SOL (buy: SOL to spend; sell: the modelled SOL proceeds). */
  sizeSol: number;
  sizeUsd: number;
  /** Size as % of the strategy's book at the decision. */
  pctOfBook: number;
  /** Sell only: the fraction (0..1] of the position to sell. The executor applies it to what it really holds. */
  sellFraction: number | null;
  price: { usd: number | null; mcap: number | null; liqUsd: number | null; solUsd: number };
  /** Sell only: why (an engine rule: hard-stop, trail, tp-1, agent-exit, flatten, …). */
  exitReason: string | null;
  slippageBps: number;
  maxImpactPct: number;
  positionId: string | null;
  /**
   * task-1654: dexterm's own paper-model fill behind this signal (price per token in USD, tokens). Receipts are
   * compared with it to measure how optimistic paper fills are (the divergence report). Absent on older signals.
   */
  model?: { priceUsd: number | null; tokens: number | null };
}

export interface HaltedSignal extends SignalBase {
  type: 'halted';
  reason: string;
  /** Nonces delivered or pending that had not expired when the run halted: the executor may cancel them. */
  outstanding: number[];
  /** task-1645 r2: mints still held for this account when the run stopped (absent on signals queued before r2). */
  open?: string[];
}

/** task-1654: `test: true` on every test signal, which never names a mint: nothing in it is tradable. */
export interface TestSignal extends SignalBase { type: 'test'; test?: true; note: string }

export type TradeFireSignal = TradeSignal | HaltedSignal | TestSignal;

const SOL_MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const ACCOUNT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const RUN_RE = /^[A-Za-z0-9._:-]{1,96}$/;
const HEX32 = /^[0-9a-f]{32}$/;

/** The only token text a signal carries: NFKC, then [A-Za-z0-9._$-] only, 16 chars, '?' when nothing is left. */
export function sanitizeSymbol(s: unknown): string {
  const t = String(s ?? '').normalize('NFKC').replace(/[^A-Za-z0-9._$-]/g, '').slice(0, 16);
  return t || '?';
}

/** An engine reason ("hard-stop", "time_review:no-answer") reduced to [a-z0-9:_-], 40 chars. */
export function sanitizeReason(s: unknown): string {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9:_-]/g, '-').replace(/-+/g, '-').slice(0, 40) || 'unknown';
}

export const signalIdOf = (accountId: string, runId: string, nonce: number): string =>
  createHash('sha256').update(`${TRADE_FIRE_SCHEMA}|${accountId}|${runId}|${nonce}`).digest('hex').slice(0, 32);

export const clampTtl = (sec: number | undefined): number =>
  Math.min(SIGNAL_TTL_MAX_SEC, Math.max(SIGNAL_TTL_MIN_SEC, Math.round(Number.isFinite(sec) ? sec! : SIGNAL_TTL_DEFAULT_SEC)));

const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
const r2 = (v: number) => Math.round(v * 100) / 100;
const fin = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export interface SignalHeader { nonce: number; now: number; ttlSec: number; runId: string; accountId: string; strategy: { id: string; version: string; hash: string } }

function base(type: SignalType, h: SignalHeader): SignalBase {
  const ttlSec = clampTtl(h.ttlSec);
  return {
    schema: TRADE_FIRE_SCHEMA, type, id: signalIdOf(h.accountId, h.runId, h.nonce), nonce: h.nonce, issuedAt: h.now, expiresAt: h.now + ttlSec * 1000, ttlSec,
    runId: h.runId, accountId: h.accountId, strategy: { id: h.strategy.id, version: h.strategy.version, hash: h.strategy.hash.slice(0, 64) }, paper: false,
  };
}

export interface TradeInput {
  side: 'buy' | 'sell'; mint: string; symbol: unknown; sizeUsd: number; solUsd: number; bookUsd: number; sellFraction?: number | null;
  priceUsd: number | null; mcap: number | null; liqUsd: number | null; exitReason?: string | null; slippageBps: number; maxImpactPct: number; positionId?: string | null;
  /** task-1654: the paper-model fill (see TradeSignal.model). */
  model?: { priceUsd: number | null; tokens: number | null } | null;
}

/** A trade signal; throws on anything that is not a plain engine value (fail closed: no signal rather than a bad one). */
export function buildTradeSignal(t: TradeInput, h: SignalHeader): TradeSignal {
  if (!SOL_MINT_RE.test(t.mint)) throw new Error('signal: mint is not a base58 address');
  if (!(t.solUsd > 0)) throw new Error('signal: no SOL/USD price');
  // A buy states a positive size; a sell's size is the modelled proceeds and can be ~0 (a rug exit must still go out).
  if (t.side === 'buy' ? !(t.sizeUsd > 0) : !(t.sizeUsd >= 0)) throw new Error('signal: size must be positive');
  const s: TradeSignal = {
    ...base('trade', h), type: 'trade', side: t.side, mint: t.mint, symbol: sanitizeSymbol(t.symbol),
    sizeSol: r6(t.sizeUsd / t.solUsd), sizeUsd: r2(t.sizeUsd), pctOfBook: t.bookUsd > 0 ? Math.round((t.sizeUsd / t.bookUsd) * 1000) / 10 : 0,
    sellFraction: t.side === 'sell' ? Math.min(1, Math.max(0, r6(t.sellFraction ?? 1))) : null,
    price: { usd: fin(t.priceUsd), mcap: fin(t.mcap), liqUsd: fin(t.liqUsd), solUsd: r2(t.solUsd) },
    exitReason: t.side === 'sell' ? sanitizeReason(t.exitReason) : null,
    slippageBps: Math.round(t.slippageBps), maxImpactPct: t.maxImpactPct, positionId: t.positionId && /^[A-Za-z0-9._-]{1,48}$/.test(t.positionId) ? t.positionId : null,
    ...(t.model ? { model: { priceUsd: fin(t.model.priceUsd), tokens: fin(t.model.tokens) } } : {}),
  };
  const v = validateSignal(s);
  if (!v.ok) throw new Error(`signal: ${v.error}`);
  return s;
}

export function buildHaltedSignal(reason: string, outstanding: number[], h: SignalHeader, open: string[] = []): HaltedSignal {
  return { ...base('halted', h), type: 'halted', reason: sanitizeReason(reason), outstanding: [...new Set(outstanding)].filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => a - b).slice(0, 500), open: [...new Set(open)].filter((m) => SOL_MINT_RE.test(m)).sort().slice(0, 100) };
}

export function buildTestSignal(h: SignalHeader): TestSignal {
  return { ...base('test', h), type: 'test', test: true, note: 'channel test: never trade on this' };
}

/** One line of JSON, fixed key order (the webhook body, the hook's stdin, the stream line: byte-identical). */
export const signalLine = (s: TradeFireSignal): string => JSON.stringify(s);

/** Strict shape check: used on replay of the outbox and by receivers. */
export function validateSignal(x: unknown): { ok: true; signal: TradeFireSignal } | { ok: false; error: string } {
  const s = x as Record<string, unknown>;
  if (!s || typeof s !== 'object') return { ok: false, error: 'not an object' };
  if (s.schema !== TRADE_FIRE_SCHEMA) return { ok: false, error: 'schema' };
  if (s.type !== 'trade' && s.type !== 'halted' && s.type !== 'test') return { ok: false, error: 'type' };
  if (!Number.isSafeInteger(s.nonce) || (s.nonce as number) < 1) return { ok: false, error: 'nonce' };
  if (typeof s.id !== 'string' || !HEX32.test(s.id)) return { ok: false, error: 'id' };
  if (typeof s.accountId !== 'string' || !ACCOUNT_ID_RE.test(s.accountId)) return { ok: false, error: 'accountId' };
  if (typeof s.runId !== 'string' || !RUN_RE.test(s.runId)) return { ok: false, error: 'runId' };
  if (s.id !== signalIdOf(s.accountId, s.runId, s.nonce as number)) return { ok: false, error: 'id does not match account/run/nonce' };
  if (s.paper !== false) return { ok: false, error: 'paper must be false' };
  if (!fin(s.issuedAt) || !fin(s.expiresAt) || (s.expiresAt as number) <= (s.issuedAt as number)) return { ok: false, error: 'times' };
  const st = s.strategy as Record<string, unknown> | undefined;
  if (!st || typeof st.id !== 'string' || !ID_RE.test(st.id) || typeof st.version !== 'string' || typeof st.hash !== 'string') return { ok: false, error: 'strategy' };
  if (s.type === 'trade') {
    if (s.side !== 'buy' && s.side !== 'sell') return { ok: false, error: 'side' };
    if (typeof s.mint !== 'string' || !SOL_MINT_RE.test(s.mint)) return { ok: false, error: 'mint' };
    if (typeof s.symbol !== 'string' || s.symbol !== sanitizeSymbol(s.symbol)) return { ok: false, error: 'symbol' };
    if (s.side === 'buy' ? !(fin(s.sizeSol)! > 0) || !(fin(s.sizeUsd)! > 0) : !(fin(s.sizeSol)! >= 0) || !(fin(s.sizeUsd)! >= 0)) return { ok: false, error: 'size' };
    if (s.side === 'sell' && !(fin(s.sellFraction)! > 0 && (s.sellFraction as number) <= 1)) return { ok: false, error: 'sellFraction' };
  }
  if (s.type === 'test' && s.test !== undefined && s.test !== true) return { ok: false, error: 'test' };
  if (s.type === 'test' && 'mint' in s) return { ok: false, error: 'a test signal names no mint' };
  if (s.type === 'trade' && s.model !== undefined && (typeof s.model !== 'object' || s.model === null)) return { ok: false, error: 'model' };
  if (s.type === 'halted' && s.open !== undefined && (!Array.isArray(s.open) || s.open.length > 100 || !s.open.every((m) => typeof m === 'string' && SOL_MINT_RE.test(m)))) return { ok: false, error: 'open' };
  return { ok: true, signal: s as unknown as TradeFireSignal };
}

// ───────────────────────────── HMAC ─────────────────────────────

/** `t=<unix s>,v1=<hex sha256 hmac of "<t>.<body>">`. */
export function signBody(secret: string, body: string, nowMs: number): string {
  const t = Math.floor(nowMs / 1000);
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

export function verifyBody(secret: string, header: string | null | undefined, body: string, nowMs: number, toleranceSec = SIGNATURE_TOLERANCE_SEC): { ok: true } | { ok: false; why: string } {
  const m = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(String(header ?? ''));
  if (!m) return { ok: false, why: 'signature-missing' };
  const t = Number(m[1]);
  if (Math.abs(nowMs / 1000 - t) > toleranceSec) return { ok: false, why: 'signature-stale' };
  const want = createHmac('sha256', secret).update(`${t}.${body}`).digest();
  const got = Buffer.from(m[2], 'hex');
  return got.length === want.length && timingSafeEqual(got, want) ? { ok: true } : { ok: false, why: 'signature-bad' };
}

// ───────────────────────────── the executor side ─────────────────────────────

export type ReceiveResult =
  | { ok: true; signal: TradeFireSignal }
  | { ok: false; why: 'duplicate'; signal: TradeFireSignal }
  | { ok: false; why: string; signal?: TradeFireSignal };

/**
 * What a well-behaved executor does with an incoming signal: signature (when a secret is set), shape, account, TTL,
 * replay (nonce and id). A duplicate is reported as such so a transport can ack it (at-least-once delivery).
 * Exported for users' scripts and for the fake executors of the tests; dexterm itself never executes anything.
 */
export class SignalReceiver {
  private readonly seen = new Set<string>();
  private maxNonce = 0;
  private readonly o: { accountId: string; secret?: string | null; now?: () => number };
  constructor(o: { accountId: string; secret?: string | null; now?: () => number }) { this.o = o; }

  receive(body: string, signature?: string | null): ReceiveResult {
    const now = (this.o.now ?? Date.now)();
    if (this.o.secret) { const v = verifyBody(this.o.secret, signature, body, now); if (!v.ok) return { ok: false, why: v.why }; }
    let raw: unknown;
    try { raw = JSON.parse(body); } catch { return { ok: false, why: 'not-json' }; }
    const v = validateSignal(raw);
    if (!v.ok) return { ok: false, why: `invalid:${v.error}` };
    const s = v.signal;
    if (s.accountId !== this.o.accountId) return { ok: false, why: 'wrong-account', signal: s };
    if (this.seen.has(s.id) || this.seen.has(`n${s.nonce}`)) return { ok: false, why: 'duplicate', signal: s };
    if (now > s.expiresAt) return { ok: false, why: 'expired', signal: s };
    // A nonce at or below one already acted on (that is not a duplicate of it) is a replay of an old signal.
    if (s.nonce <= this.maxNonce && s.type !== 'halted') return { ok: false, why: 'nonce-replay', signal: s };
    this.seen.add(s.id); this.seen.add(`n${s.nonce}`);
    this.maxNonce = Math.max(this.maxNonce, s.nonce);
    return { ok: true, signal: s };
  }
}
