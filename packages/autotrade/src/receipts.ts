// dexterm autotrade — trade-fire receipts, drift and the read-only wallet reconcile (task-1645, 0.2.0 card A).
//
// The user's executor reports what it did with a signal, as DATA only: `dexterm autotrade receipt …`, or by
// appending a `dexterm-trade-receipt/1` line to $DEXTERM_HOME/autotrade/real/receipts.jsonl itself.
//   status executed | rejected | failed, optional fill {priceUsd, sizeSol, tokens, txSig}, a short reason
// A receipt never makes dexterm do anything: it only moves a real-mode position from `unconfirmed` to
// executed / rejected / failed in the ledger, the Q screen and `autotrade audit`, and measures the drift between
// what was signalled and what was filled. Exits keep firing on the monitor's own (paper-model) view regardless.
//
// The wallet reconcile reads a PUBLIC address the user supplies (SOL balance and token holdings, two read-only RPC
// methods on an allowlist) and lists the mints dexterm thinks are held that the wallet does not show, and back.

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { realDir } from './outbox.ts';
import { ACCOUNT_ID_RE, type TradeFireSignal, type TradeSignal } from './signal.ts';

export const RECEIPT_SCHEMA = 'dexterm-trade-receipt/1';
export type ReceiptStatus = 'executed' | 'rejected' | 'failed';
export const RECEIPT_STATUSES: readonly ReceiptStatus[] = ['executed', 'rejected', 'failed'];

export interface Receipt {
  schema: typeof RECEIPT_SCHEMA;
  signalId: string;
  nonce: number;
  accountId: string;
  status: ReceiptStatus;
  at: number;
  fill: { priceUsd: number | null; sizeSol: number | null; tokens: number | null; txSig: string | null } | null;
  reason: string | null;
  executor: string | null;
}

export const receiptsPath = (home: string): string => join(realDir(home), 'receipts.jsonl');

const TX_SIG = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const pos = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
/** Free text from an executor is data: printable ASCII only, 120 chars. */
const text = (v: unknown, max: number): string | null => { if (typeof v !== 'string') return null; const t = v.replace(/[^\x20-\x7e]/g, '').trim().slice(0, max); return t || null; };

export function validateReceipt(x: unknown): { ok: true; receipt: Receipt } | { ok: false; error: string } {
  const r = x as Record<string, unknown>;
  if (!r || typeof r !== 'object') return { ok: false, error: 'not an object' };
  if (r.schema !== RECEIPT_SCHEMA) return { ok: false, error: 'schema' };
  if (typeof r.signalId !== 'string' || !HEX32.test(r.signalId)) return { ok: false, error: 'signalId' };
  if (!Number.isSafeInteger(r.nonce) || (r.nonce as number) < 1) return { ok: false, error: 'nonce' };
  if (typeof r.accountId !== 'string' || !ACCOUNT_ID_RE.test(r.accountId)) return { ok: false, error: 'accountId' };
  if (!RECEIPT_STATUSES.includes(r.status as ReceiptStatus)) return { ok: false, error: 'status' };
  if (typeof r.at !== 'number' || !Number.isFinite(r.at)) return { ok: false, error: 'at' };
  let fill: Receipt['fill'] = null;
  if (r.fill !== undefined && r.fill !== null) {
    const f = r.fill as Record<string, unknown>;
    if (typeof f !== 'object') return { ok: false, error: 'fill' };
    if (f.txSig !== undefined && f.txSig !== null && (typeof f.txSig !== 'string' || !TX_SIG.test(f.txSig))) return { ok: false, error: 'fill.txSig is not a base58 signature' };
    for (const k of ['priceUsd', 'sizeSol', 'tokens']) if (f[k] !== undefined && f[k] !== null && pos(f[k]) === null) return { ok: false, error: `fill.${k}` };
    fill = { priceUsd: pos(f.priceUsd), sizeSol: pos(f.sizeSol), tokens: pos(f.tokens), txSig: typeof f.txSig === 'string' ? f.txSig : null };
  }
  if (r.status !== 'executed' && fill && (fill.sizeSol || fill.tokens)) return { ok: false, error: 'only an executed receipt carries a fill size' };
  return { ok: true, receipt: { schema: RECEIPT_SCHEMA, signalId: r.signalId, nonce: r.nonce as number, accountId: r.accountId, status: r.status as ReceiptStatus, at: r.at, fill, reason: text(r.reason, 120), executor: text(r.executor, 32) } };
}

export function appendReceipt(home: string, r: Receipt): void {
  const v = validateReceipt(r);
  if (!v.ok) throw new Error(`receipt: ${v.error}`);
  mkdirSync(realDir(home), { recursive: true, mode: 0o700 });
  const fd = openSync(receiptsPath(home), 'a', 0o600);
  try { writeSync(fd, `${JSON.stringify(v.receipt)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
}

/** Why a receipt does not belong to a known signal (or null): unknown nonce, another account, an id mismatch. */
export function receiptMismatch(r: Receipt, s: TradeFireSignal | undefined): string | null {
  if (!s) return 'unknown-signal';
  if (s.id !== r.signalId) return 'signal-id-mismatch';
  if (s.accountId !== r.accountId) return 'wrong-account';
  // task-1654: a receipt for a `signal test` proves the round trip (signal test reports it); it is not an orphan.
  if (s.type === 'test') return 'test-signal';
  if (s.type !== 'trade') return 'not-a-trade-signal';
  return null;
}

/**
 * Reads receipts.jsonl incrementally (byte offset). Every valid receipt for a known signal is returned once; the
 * rest are counted (`invalid`, `orphan`) and never acted on. A partial last line waits for its newline.
 */
export class ReceiptsTail {
  private offset = 0;
  private carry = '';
  invalid = 0;
  orphan = 0;
  private readonly path: string;
  private readonly lookup: (nonce: number) => TradeFireSignal | undefined;
  constructor(home: string, lookup: (nonce: number) => TradeFireSignal | undefined) { this.path = receiptsPath(home); this.lookup = lookup; }
  poll(): Receipt[] {
    if (!existsSync(this.path)) return [];
    const size = statSync(this.path).size;
    if (size < this.offset) { this.offset = 0; this.carry = ''; } // truncated: read again
    if (size === this.offset) return [];
    const fd = openSync(this.path, 'r');
    const buf = Buffer.alloc(Math.min(size - this.offset, 4 << 20));
    let n = 0;
    try { n = readSync(fd, buf, 0, buf.length, this.offset); } finally { closeSync(fd); }
    this.offset += n;
    const chunk = this.carry + buf.subarray(0, n).toString('utf8');
    const lines = chunk.split('\n');
    this.carry = lines.pop() ?? '';
    const out: Receipt[] = [];
    for (const l of lines) {
      if (!l.trim()) continue;
      let raw: unknown;
      try { raw = JSON.parse(l); } catch { this.invalid++; continue; }
      const v = validateReceipt(raw);
      if (!v.ok) { this.invalid++; continue; }
      const mm = receiptMismatch(v.receipt, this.lookup(v.receipt.nonce));
      if (mm === 'test-signal') continue;
      if (mm) { this.orphan++; continue; }
      out.push(v.receipt);
    }
    return out;
  }
}

export function readReceipts(home: string): { receipts: Receipt[]; invalid: number } {
  const p = receiptsPath(home);
  if (!existsSync(p)) return { receipts: [], invalid: 0 };
  const out: Receipt[] = [];
  let invalid = 0;
  for (const l of readFileSync(p, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    try { const v = validateReceipt(JSON.parse(l)); if (v.ok) out.push(v.receipt); else invalid++; } catch { invalid++; }
  }
  return { receipts: out, invalid };
}

// ───────────────────────────── drift ─────────────────────────────

export type ConfirmState = 'unconfirmed' | 'executed' | 'rejected' | 'failed' | 'expired-unconfirmed';

export interface DriftRow {
  nonce: number; id: string; runId: string; side: 'buy' | 'sell'; mint: string; symbol: string; issuedAt: number;
  state: ConfirmState; signalSol: number; filledSol: number | null; sizeDriftPct: number | null; priceDriftPct: number | null; txSig: string | null;
  /** Several receipts with different statuses for one signal: the newest wins, this says it happened. */
  conflict: boolean; reason: string | null;
}

export interface DriftReport {
  rows: DriftRow[];
  counts: Record<ConfirmState, number>;
  /** Signals with no receipt yet and still inside their TTL, plus expired ones never confirmed. */
  unconfirmed: number;
  /** Executed receipts whose size differs from the signal by more than `tolPct`. */
  sizeDrift: number;
  orphanReceipts: number;
}

const r1 = (v: number) => Math.round(v * 10) / 10;

/** Signals vs receipts: one row per trade signal. */
export function driftReport(signals: TradeFireSignal[], receipts: Receipt[], now: number, tolPct = 5): DriftReport {
  const trades = signals.filter((s): s is TradeSignal => s.type === 'trade');
  const byNonce = new Map<number, Receipt[]>();
  let orphanReceipts = 0;
  const known = new Map(trades.map((s) => [s.nonce, s]));
  const tests = new Set(signals.filter((s) => s.type === 'test').map((s) => s.nonce));
  for (const r of receipts) {
    if (tests.has(r.nonce)) continue;
    if (receiptMismatch(r, known.get(r.nonce))) { orphanReceipts++; continue; }
    const l = byNonce.get(r.nonce) ?? [];
    l.push(r); byNonce.set(r.nonce, l);
  }
  const counts: Record<ConfirmState, number> = { unconfirmed: 0, executed: 0, rejected: 0, failed: 0, 'expired-unconfirmed': 0 };
  let sizeDrift = 0;
  const rows = trades.map((s): DriftRow => {
    const rs = (byNonce.get(s.nonce) ?? []).sort((a, b) => a.at - b.at);
    const last = rs[rs.length - 1];
    const state: ConfirmState = last ? last.status : now > s.expiresAt ? 'expired-unconfirmed' : 'unconfirmed';
    counts[state]++;
    const filled = last?.status === 'executed' ? last.fill?.sizeSol ?? null : null;
    const sizeDriftPct = filled !== null && s.sizeSol > 0 ? r1(((filled - s.sizeSol) / s.sizeSol) * 100) : null;
    const px = last?.status === 'executed' ? last.fill?.priceUsd ?? null : null;
    const priceDriftPct = px !== null && s.price.usd ? r1(((px - s.price.usd) / s.price.usd) * 100) : null;
    if (sizeDriftPct !== null && Math.abs(sizeDriftPct) > tolPct) sizeDrift++;
    return {
      nonce: s.nonce, id: s.id, runId: s.runId, side: s.side, mint: s.mint, symbol: s.symbol, issuedAt: s.issuedAt, state, signalSol: s.sizeSol, filledSol: filled, sizeDriftPct, priceDriftPct,
      txSig: last?.fill?.txSig ?? null, conflict: new Set(rs.map((r) => r.status)).size > 1, reason: last?.reason ?? null,
    };
  });
  return { rows, counts, unconfirmed: counts.unconfirmed + counts['expired-unconfirmed'], sizeDrift, orphanReceipts };
}

// ───────────────────────────── paper vs real: the divergence report (task-1654) ─────────────────────────────
//
// A receipt with a fill says what the executor really got. Against dexterm's own paper-model fill (the signal's
// `model`, else its quoted price) that is the measure of how optimistic paper fills are: adverse slippage (positive
// = worse than paper), latency from the signal's issue to the receipt, partial fills, rejections and failures.

export interface Divergence {
  nonce: number;
  side: 'buy' | 'sell';
  status: ReceiptStatus;
  /** Adverse % of the executor's fill price vs dexterm's paper-model fill (positive = worse than paper). */
  slippageVsPaperPct: number | null;
  /** Adverse % vs the price the signal quoted (the tick price). */
  slippageVsQuotePct: number | null;
  latencyMs: number;
  /** What was filled / what was signalled (SOL for a buy, tokens for a sell). */
  fillRatio: number | null;
  partial: boolean;
  reason: string | null;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/** One receipt against its trade signal (null for anything that is not a known trade signal). */
export function divergenceOf(s: TradeFireSignal | undefined, r: Receipt): Divergence | null {
  if (!s || s.type !== 'trade' || receiptMismatch(r, s)) return null;
  const f = r.status === 'executed' ? r.fill : null;
  const px = f?.priceUsd ?? (f?.sizeSol && f.tokens ? (f.sizeSol * s.price.solUsd) / f.tokens : null);
  const adverse = (ref: number | null | undefined): number | null => (px && ref && ref > 0 ? r2(((s.side === 'buy' ? px - ref : ref - px) / ref) * 100) : null);
  const modelTokens = s.model?.tokens ?? null;
  const fillRatio = !f ? null : s.side === 'buy' ? (f.sizeSol && s.sizeSol > 0 ? Math.round((f.sizeSol / s.sizeSol) * 1000) / 1000 : null) : (f.tokens && modelTokens ? Math.round((f.tokens / modelTokens) * 1000) / 1000 : null);
  return {
    nonce: s.nonce, side: s.side, status: r.status, slippageVsPaperPct: adverse(s.model?.priceUsd ?? null), slippageVsQuotePct: adverse(s.price.usd),
    latencyMs: Math.max(0, r.at - s.issuedAt), fillRatio, partial: fillRatio !== null && fillRatio < 0.95, reason: r.reason,
  };
}

export interface DivergenceSummary {
  trades: number;
  receipted: number;
  executed: number;
  rejected: number;
  failed: number;
  partial: number;
  /** Adverse slippage vs paper over executed fills that state a price. */
  slippage: { n: number; medianPct: number | null; p90Pct: number | null; meanPct: number | null };
  latency: { n: number; medianMs: number | null; p90Ms: number | null };
  reasons: Record<string, number>;
  /** An honest line about the sample size. */
  note: string;
}

const quantile = (xs: number[], q: number): number | null => { if (!xs.length) return null; const a = [...xs].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(q * a.length))]; };

/** Every trade signal's newest receipt, summarized. */
export function divergenceReport(signals: TradeFireSignal[], receipts: Receipt[]): DivergenceSummary & { rows: Divergence[] } {
  const bySig = new Map(signals.filter((s) => s.type === 'trade').map((s) => [s.nonce, s]));
  const newest = new Map<number, Receipt>();
  for (const r of receipts) { const s = bySig.get(r.nonce); if (!s || receiptMismatch(r, s)) continue; const p = newest.get(r.nonce); if (!p || r.at >= p.at) newest.set(r.nonce, r); }
  const rows = [...newest.values()].map((r) => divergenceOf(bySig.get(r.nonce), r)).filter((d): d is Divergence => !!d).sort((a, b) => a.nonce - b.nonce);
  const ex = rows.filter((d) => d.status === 'executed');
  const sl = ex.map((d) => d.slippageVsPaperPct ?? d.slippageVsQuotePct).filter((v): v is number => v !== null);
  const lat = rows.map((d) => d.latencyMs);
  const reasons: Record<string, number> = {};
  for (const d of rows) if (d.status !== 'executed') { const k = `${d.status}: ${(d.reason ?? 'no reason').slice(0, 40)}`; reasons[k] = (reasons[k] ?? 0) + 1; }
  const n = ex.length;
  return {
    rows, trades: bySig.size, receipted: rows.length, executed: n, rejected: rows.filter((d) => d.status === 'rejected').length, failed: rows.filter((d) => d.status === 'failed').length, partial: rows.filter((d) => d.partial).length,
    slippage: { n: sl.length, medianPct: quantile(sl, 0.5), p90Pct: quantile(sl, 0.9), meanPct: sl.length ? r2(sl.reduce((a, b) => a + b, 0) / sl.length) : null },
    latency: { n: lat.length, medianMs: quantile(lat, 0.5), p90Ms: quantile(lat, 0.9) },
    reasons,
    note: n === 0 ? 'no executed receipt yet: nothing to compare paper with' : n < 30 ? `only ${n} executed fill(s): too few to calibrate paper fills with confidence` : `${n} executed fills`,
  };
}

export function divergenceLines(d: DivergenceSummary): string[] {
  const out = [`paper vs real: ${d.receipted}/${d.trades} trade signals have a receipt · executed ${d.executed} · rejected ${d.rejected} · failed ${d.failed} · partial ${d.partial}`];
  if (d.slippage.n) out.push(`  slippage vs paper fill: median ${d.slippage.medianPct}% · p90 ${d.slippage.p90Pct}% · mean ${d.slippage.meanPct}% (positive = the real fill was worse than paper)`);
  if (d.latency.n) out.push(`  latency signal -> receipt: median ${Math.round((d.latency.medianMs ?? 0) / 100) / 10} s · p90 ${Math.round((d.latency.p90Ms ?? 0) / 100) / 10} s`);
  for (const [k, v] of Object.entries(d.reasons).slice(0, 5)) out.push(`  ${v}× ${k}`);
  out.push(`  ${d.note}`);
  return out;
}

// ───────────────────────────── read-only wallet reconcile ─────────────────────────────

/** The only RPC methods the reconcile may call. Anything else is refused before it leaves the process. */
export const RECONCILE_RPC_METHODS: readonly string[] = ['getBalance', 'getTokenAccountsByOwner'];
const TOKEN_PROGRAMS = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'];
const PUBKEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export type RpcCall = (method: string, params: unknown[]) => Promise<unknown>;

export interface WalletReconcile {
  wallet: string;
  sol: number | null;
  holdings: Record<string, number>;
  /** Mints the real-mode book holds that the wallet shows 0 of. */
  missing: string[];
  /** Mints the wallet holds that came from a signal but the book has closed. */
  stillHeld: string[];
  errors: string[];
}

/** Read a public wallet (balance + token holdings) and compare with the mints the real-mode book holds / closed. */
export async function reconcileWallet(wallet: string, rpc: RpcCall, book: { held: string[]; closed: string[] }): Promise<WalletReconcile> {
  if (!PUBKEY.test(wallet)) throw new Error('reconcile: the wallet is a public base58 address (never a key)');
  const call: RpcCall = (m, p) => { if (!RECONCILE_RPC_METHODS.includes(m)) return Promise.reject(new Error(`rpc method ${m} is not on the read-only allowlist`)); return rpc(m, p); };
  const errors: string[] = [];
  let sol: number | null = null;
  try { const b = (await call('getBalance', [wallet, { commitment: 'confirmed' }])) as { value?: number }; sol = typeof b?.value === 'number' ? b.value / 1e9 : null; } catch (e) { errors.push(`getBalance: ${(e as Error).message.slice(0, 120)}`); }
  const holdings: Record<string, number> = {};
  for (const programId of TOKEN_PROGRAMS) {
    try {
      const r = (await call('getTokenAccountsByOwner', [wallet, { programId }, { encoding: 'jsonParsed', commitment: 'confirmed' }])) as { value?: { account?: { data?: { parsed?: { info?: { mint?: string; tokenAmount?: { uiAmount?: number } } } } } }[] };
      for (const a of r?.value ?? []) {
        const info = a.account?.data?.parsed?.info;
        if (!info?.mint || !PUBKEY.test(info.mint)) continue;
        holdings[info.mint] = (holdings[info.mint] ?? 0) + (Number(info.tokenAmount?.uiAmount) || 0);
      }
    } catch (e) { errors.push(`getTokenAccountsByOwner: ${(e as Error).message.slice(0, 120)}`); }
  }
  const ok = errors.length === 0;
  return {
    wallet, sol, holdings,
    missing: ok ? book.held.filter((m) => !(holdings[m] > 0)) : [],
    stillHeld: ok ? book.closed.filter((m) => holdings[m] > 0 && !book.held.includes(m)) : [],
    errors,
  };
}

/** From the trade signals alone (nonce order): the mints a real-mode book holds, and those it closed. */
export function heldFromSignals(signals: TradeFireSignal[]): { held: string[]; closed: string[] } {
  const held = new Set<string>();
  const closed = new Set<string>();
  for (const s of [...signals].sort((a, b) => a.nonce - b.nonce)) {
    if (s.type !== 'trade') continue;
    if (s.side === 'buy') { held.add(s.mint); closed.delete(s.mint); } else if ((s.sellFraction ?? 1) >= 0.999) { held.delete(s.mint); closed.add(s.mint); }
  }
  return { held: [...held], closed: [...closed] };
}
