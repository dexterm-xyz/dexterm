// task-1530 — the UNIFIED TRADE LEDGER (`dexterm-ledger/1`): one schema for every trade dexterm books, whatever
// booked it (the paper wallet, the agent paper desk, an autotrade run, the live signer).
//
// The ledger is an append-only, hash-chained JSONL file of EVENTS. A trade is never stored as a mutable row: it is
// folded from its events (`fold.ts`), so a late PROFILE line, a rug found after the exit or a session's cost can
// be added later without rewriting anything.
//
//   header   line 1: the schema, when the file was made
//   import   provenance: which source journal was read, how many events, its own chain head and check
//   fill     one buy or sell (SOL, USD, tokens, price, supply, fees, impact, slippage, the book before it, tag, tx sig)
//   tag      a PROFILE / REPROFILE / EXIT declared apart from its fill (a late line, a reprofile)
//   close    the source closed the position (stuck or not), with the price extremes it saw (MFE / MAE)
//   cost     a model session's cost (joined to the trades that name the session)
//   annotate a fact found later about a trade (a rug)
//
// Every event carries `ref`, unique per source event, so importing the same journal twice adds nothing. Its hash
// covers the previous hash plus the canonical event, so an edited, dropped or reordered line breaks the chain from
// that line on (`verifyLedger`). Nothing in a ledger event can hold a key: there is no field for one, and every
// string is passed through `redactKeyShaped` on the way in.

import { createHash } from 'node:crypto';

export const LEDGER_SCHEMA = 'dexterm-ledger/1';
/** The event format this build writes and reads. A file from a newer build is refused (never half-read). */
export const LEDGER_VERSION = 1;
export const GENESIS = 'genesis';

export type LedgerSource = 'paper' | 'desk' | 'autotrade' | 'live';
// task-1655: `real` = a real-mode autotrade run (0.2.0): the fill is dexterm's model of the trade it signalled to the
// user's own executor (dexterm holds no key); the executor's fill is its receipt. Never paper, never a dexterm signer.
export type WalletMode = 'paper' | 'devnet' | 'live' | 'real';
export const LEDGER_SOURCES: readonly LedgerSource[] = ['paper', 'desk', 'autotrade', 'live'];
export const WALLET_MODES: readonly WalletMode[] = ['paper', 'devnet', 'live', 'real'];

/**
 * Where a PROFILE / EXIT came from, best first:
 *   structured  a typed field the agent set (an MCP tool argument, the autotrade DECISION JSON)
 *   rule        a mechanical exit rule fired (stop, trail, tp1, max-hold, thesis-…); no agent words needed
 *   tag-line    parsed from the agent's verbatim PROFILE / EXIT line passed as a tool argument
 *   late        declared after the fill (a later paper_tag call)
 *   default     the strategy's default profile (the agent named none)
 *   missing     nothing was declared
 */
export type TagSource = 'structured' | 'rule' | 'tag-line' | 'late' | 'default' | 'missing';

export interface StrategyRef { id: string; version: string | null; hash: string | null }
export interface SupplyRef { tokens: number; source: string }

/** The structured tag a fill (or a tag event) carries. Every text field is capped and redacted. */
export interface FillTag {
  profile?: string | null;
  /** The agent's own words for the entry (PROFILE line) or the exit (EXIT line). */
  reason?: string | null;
  /** The exit reason code (stop, trail, tp1, thesis-split, agent, …). */
  exitReason?: string | null;
  /** The verbatim PROFILE / EXIT line when one was passed. */
  line?: string | null;
  source: TagSource;
  /** Where `reason` came from when it differs from `source` (an agent's DECISION reason on a default profile). */
  reasonSource?: TagSource;
}

interface Base { seq: number; t: number; kind: string; v: number; prev: string; hash: string }

export interface HeaderEvent extends Base { kind: 'header'; schema: string; createdAt: number }

export interface ImportEvent extends Base {
  kind: 'import'; ref: string; source: LedgerSource; label: string;
  /** The source's own chain head and whether it verified (null: the source has no chain, e.g. a SQLite table). */
  sourceHead: string | null; sourceVerified: boolean | null; events: number; note?: string;
}

export interface FillEvent extends Base {
  kind: 'fill'; ref: string;
  /** Groups the fills of one round trip (one position from first buy to flat). */
  tradeKey: string;
  source: LedgerSource; walletMode: WalletMode;
  side: 'buy' | 'sell'; mint: string; symbol: string; decimals: number | null;
  /** SOL out (buy, fees in) or in (sell, fees out). null when the source books in USD and no SOL rate was recorded. */
  sol: number | null;
  /** USD out (buy) or in (sell), when known. */
  usd: number | null;
  /** Whole tokens bought or sold. */
  tokens: number | null;
  priceSol: number | null;
  priceUsd: number | null;
  supply: SupplyRef | null;
  feeSol: number | null;
  impactPct: number | null;
  slippageBps: number | null;
  /** Realized on this fill, as the source booked it (sells). */
  realizedSol: number | null;
  realizedUsd: number | null;
  /** The book just before this fill (cash + open cost), for % of book. */
  bookSol: number | null;
  bookUsd: number | null;
  /** The source says the position is flat after this fill. */
  closes: boolean | null;
  txSig: string | null;
  runId: string | null;
  agent: string | null;
  strategy: StrategyRef | null;
  /** The shared paper account a parallel-run strategy traded from (task-1538); absent otherwise. */
  account?: string | null;
  sessionId: string | null;
  model: string | null;
  tag: FillTag | null;
}

export interface TagEvent extends Base {
  kind: 'tag'; ref: string; tradeKey: string | null; source: LedgerSource; mint: string;
  tagKind: 'profile' | 'exit' | 'reprofile';
  profile?: string | null; from?: string | null; to?: string | null; exitReason?: string | null; reason?: string | null; line?: string | null;
  tagSource: TagSource;
}

export interface CloseEvent extends Base {
  /** tradeKey null: the source knows the coin, not the trade (a run that traded on the desk); matched like a tag. */
  kind: 'close'; ref: string; tradeKey: string | null; source: LedgerSource; mint: string;
  reason: string | null; stuck: boolean;
  /** Extremes the source saw while it held the position (mid prices, the source's unit). */
  peakPrice: number | null; troughPrice: number | null; entryPrice: number | null; priceUnit: 'usd' | 'sol' | null;
  sessionId: string | null;
}

export interface CostEvent extends Base { kind: 'cost'; ref: string; source: LedgerSource; sessionId: string; costUsd: number; model: string | null; runId: string | null }

export interface AnnotateEvent extends Base { kind: 'annotate'; ref: string; tradeKey: string; rug: boolean | null; why: string }

export type LedgerEvent = HeaderEvent | ImportEvent | FillEvent | TagEvent | CloseEvent | CostEvent | AnnotateEvent;

/** An event before the ledger numbers and chains it. */
export type Draft<E extends LedgerEvent = LedgerEvent> = E extends LedgerEvent ? Omit<E, 'seq' | 'v' | 'prev' | 'hash'> : never;

// ───────────────────────────── hygiene ─────────────────────────────

/** A base58 secret key (64 bytes ≈ 87-88 chars) or a 64-number byte array: never stored, whatever field it is in. */
const KEY_SHAPED = /(?:[1-9A-HJ-NP-Za-km-z]{85,90})|(?:\[(?:\s*\d{1,3}\s*,){63}\s*\d{1,3}\s*\])/g;
export const redactKeyShaped = (s: string): string => s.replace(KEY_SHAPED, '[REDACTED]');

/** Text from a journal or an agent: one line, control characters out, capped, key-shaped runs redacted. */
export function cleanLedgerText(s: unknown, max = 200): string | null {
  if (typeof s !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const t = redactKeyShaped(s.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim());
  return t ? t.slice(0, max) : null;
}

/** Ids, codes and refs: a strict alphabet, so nothing odd ever lands in an id column. */
export function cleanCode(s: unknown, max = 64): string | null {
  if (typeof s !== 'string') return null;
  const t = s.trim().toLowerCase().replace(/[^a-z0-9:_.@-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max);
  return t || null;
}

export const finite = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

// ───────────────────────────── the chain ─────────────────────────────

/** Sorted keys, undefined dropped, so a stored line re-hashes to the same value. (No key is special.) */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

/** sha256(prev + canonical(event without prev/hash)), full hex. */
export function ledgerHash(prev: string, e: Record<string, unknown>): string {
  const { prev: _p, hash: _h, ...body } = e;
  return createHash('sha256').update(prev + canonicalJson(body)).digest('hex');
}

export type LedgerCheck = { ok: true; events: number; head: string } | { ok: false; events: number; at: number; error: string };

/** Recompute the chain: seq 1..n, every prev is the previous hash, every hash matches its content, line 1 is the header. */
export function verifyLedger(events: readonly Record<string, unknown>[]): LedgerCheck {
  let prev = GENESIS;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.seq !== i + 1) return { ok: false, events: events.length, at: i + 1, error: `seq ${String(e.seq)} where ${i + 1} was expected` };
    if (i === 0 && e.kind !== 'header') return { ok: false, events: events.length, at: 1, error: 'line 1 is not the ledger header' };
    if (i > 0 && e.kind === 'header') return { ok: false, events: events.length, at: i + 1, error: 'a second header' };
    if (typeof e.v !== 'number' || e.v > LEDGER_VERSION) return { ok: false, events: events.length, at: i + 1, error: `event version ${String(e.v)} is newer than this build reads (${LEDGER_VERSION}); update dexterm` };
    if (e.prev !== prev) return { ok: false, events: events.length, at: i + 1, error: 'prev does not match the previous hash (a line was removed, added or reordered)' };
    const want = ledgerHash(prev, e);
    if (e.hash !== want) return { ok: false, events: events.length, at: i + 1, error: 'hash does not match the content (the line was edited)' };
    prev = want;
  }
  return { ok: true, events: events.length, head: prev };
}
