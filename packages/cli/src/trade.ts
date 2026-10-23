// dexterm — PAPER trade ticket state machine (task-1310 T0, SPEC §6.1). Pure and TTY-free so the
// ticket maths and the keypress confirm gate are unit-testable. The interactive loop and the live
// binding drive this reducer and perform the side effects (quote fetch, executor.execute).
//
// Safety: this file builds an *order* and reads a *quote*. It never signs, holds a key, or sends a
// transaction, and it imports no wallet/signing library (SPEC §6.0). Every ticket is labelled PAPER
// and the confirm gate is ON by default: arming needs a deliberate keypress, and sizes above a
// configurable threshold must be typed back (SPEC §6.1 step 3).

import { solToLamports, LAMPORTS_PER_SOL, type PaperOrder, type Side, type Fill, type SwapQuote, type TradeRecord } from '@dexterm/data';

/**
 * Phases: editing → confirm → filling → filled | error. task-1571: the ticket is PAPER only. dexterm holds no
 * key and signs nothing; live trading happens in the Telegram trading bot of the user's choice.
 */
export type TicketPhase = 'editing' | 'confirm' | 'filling' | 'filled' | 'error';
/** PAPER = the simulated wallet (the only mode). */
export type TicketMode = 'paper';
/** Buy sizes in SOL or % of the free SOL balance; sell sizes in % of the held position. */
export type SizeUnit = 'sol' | 'pct';
export type TicketField = 'size' | 'slippage';

/** Default slippage and the SOL notional above which the confirm requires a typed-back amount. */
export const DEFAULT_SLIPPAGE_BPS = 50;
export const DEFAULT_TYPEBACK_THRESHOLD_SOL = 1;
export const MAX_SLIPPAGE_BPS = 5000;

export interface TicketState {
  mint: string;
  symbol: string;
  decimals: number;
  side: Side;
  sizeUnit: SizeUnit;
  /** Raw text the user typed for the size, e.g. "0.5" (SOL) or "50" (%). */
  sizeInput: string;
  /** Slippage in bps as text; defaults to DEFAULT_SLIPPAGE_BPS. */
  slippageInput: string;
  field: TicketField;
  phase: TicketPhase;
  /** Always PAPER. */
  mode: TicketMode;
  /** Keypress confirm gate; ON by default (SPEC §6.0 invariant 2). */
  gateOn: boolean;
  /** True once armed when the SOL notional is above the typed-back threshold. */
  typebackRequired: boolean;
  /** The amount typed back during confirm (when required). */
  typeback: string;
  /** Status / error line. */
  message: string | null;
}

/** Context the reducer needs from the live wallet/quote to size and gate an order. */
export interface TicketContext {
  /** Free SOL balance, lamports (for buy % sizing and funds checks). */
  balanceLamports: bigint;
  /** Held tokens of this mint, raw base units (for sell % sizing). */
  positionTokensRaw: bigint;
  /** SOL notional of the current order (from the warm quote / balance); gates the typed-back step. */
  notionalSol: number;
  typebackThresholdSol: number;
}

export interface TicketSeed {
  mint: string;
  symbol: string;
  /** Token decimals; omit when unknown (the live binding resolves it, defaulting to 9 until then). */
  decimals?: number;
  side: Side;
  slippageBps?: number;
  gateOn?: boolean;
  mode?: TicketMode;
}

export function openTicket(seed: TicketSeed): TicketState {
  return {
    mint: seed.mint,
    symbol: seed.symbol,
    decimals: typeof seed.decimals === 'number' && Number.isFinite(seed.decimals) && seed.decimals > 0 ? seed.decimals : 9,
    side: seed.side,
    sizeUnit: seed.side === 'buy' ? 'sol' : 'pct',
    sizeInput: '',
    slippageInput: String(seed.slippageBps ?? DEFAULT_SLIPPAGE_BPS),
    field: 'size',
    phase: 'editing',
    mode: seed.mode ?? 'paper',
    gateOn: seed.gateOn ?? true,
    typebackRequired: false,
    typeback: '',
    message: null,
  };
}

function parseNum(s: string): number {
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

export function slippageBps(ts: TicketState): number {
  if (ts.slippageInput.trim() === '') return DEFAULT_SLIPPAGE_BPS;
  const n = parseNum(ts.slippageInput);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_SLIPPAGE_BPS;
  return Math.min(MAX_SLIPPAGE_BPS, Math.round(n));
}

/** The raw amount an order would spend, given the live context; 0n when the size is empty/invalid. */
export function orderAmountRaw(ts: TicketState, ctx: Pick<TicketContext, 'balanceLamports' | 'positionTokensRaw'>): bigint {
  const n = parseNum(ts.sizeInput);
  if (!Number.isFinite(n) || n <= 0) return 0n;
  if (ts.side === 'buy') {
    if (ts.sizeUnit === 'sol') return solToLamports(n);
    // % of free SOL balance
    const pct = Math.min(100, n);
    return (ctx.balanceLamports * BigInt(Math.round(pct * 100))) / 10000n;
  }
  // sell: % of the held position
  const pct = Math.min(100, n);
  return (ctx.positionTokensRaw * BigInt(Math.round(pct * 100))) / 10000n;
}

/** Build the order the ticket represents (amount already in raw base units). */
export function toOrder(ts: TicketState, ctx: Pick<TicketContext, 'balanceLamports' | 'positionTokensRaw'>): PaperOrder {
  return { mint: ts.mint, symbol: ts.symbol, side: ts.side, decimals: ts.decimals, amountRaw: orderAmountRaw(ts, ctx), slippageBps: slippageBps(ts) };
}

/** Is the current size a fillable order (positive amount, and for a sell there are tokens to sell)? */
export function orderValid(ts: TicketState, ctx: Pick<TicketContext, 'balanceLamports' | 'positionTokensRaw'>): boolean {
  const amt = orderAmountRaw(ts, ctx);
  if (amt <= 0n) return false;
  if (ts.side === 'sell' && ctx.positionTokensRaw <= 0n) return false;
  return true;
}

export type TicketEffect = 'none' | 'changed' | 'confirm' | 'close';

export interface TicketKey {
  name: string;
  /** Printable char for name==='char'/'space'. */
  ch?: string;
  ctrl?: boolean;
  alt?: boolean;
}

const DIGIT = /[0-9.]/;

function editField(ts: TicketState, key: TicketKey): boolean {
  const cur = ts.field === 'size' ? ts.sizeInput : ts.slippageInput;
  if (key.name === 'backspace') {
    const next = cur.slice(0, -1);
    if (ts.field === 'size') ts.sizeInput = next; else ts.slippageInput = next;
    return true;
  }
  if ((key.name === 'char') && key.ch && DIGIT.test(key.ch) && !key.ctrl && !key.alt) {
    // one decimal point only; slippage is integer bps
    if (key.ch === '.' && (ts.field === 'slippage' || cur.includes('.'))) return true;
    const next = (cur + key.ch).slice(0, 12);
    if (ts.field === 'size') ts.sizeInput = next; else ts.slippageInput = next;
    return true;
  }
  return false;
}

/**
 * Advance the ticket by one key. Returns the effect the caller performs:
 *  - 'changed' : the order inputs changed → re-fetch the warm quote;
 *  - 'confirm' : the gate was satisfied → the caller must execute the order now;
 *  - 'close'   : leave the ticket (back to the token screen);
 *  - 'none'    : nothing to do.
 * A stray key during the confirm step can NEVER confirm — it cancels back to editing.
 */
export function ticketKey(ts: TicketState, key: TicketKey, ctx: TicketContext): TicketEffect {
  ts.message = null;

  if (ts.phase === 'filling') return 'none'; // in-flight: ignore input

  if (ts.phase === 'filled' || ts.phase === 'error') {
    // a receipt is showing: esc closes, any other key starts a fresh ticket for the same mint
    if (key.name === 'esc') return 'close';
    const side = ts.side;
    Object.assign(ts, openTicket({ mint: ts.mint, symbol: ts.symbol, decimals: ts.decimals, side, gateOn: ts.gateOn, slippageBps: slippageBps(ts), mode: ts.mode }));
    return 'changed';
  }

  if (ts.phase === 'confirm') {
    if (key.name === 'esc') { ts.phase = 'editing'; ts.typeback = ''; return 'none'; }
    if (ts.typebackRequired && key.name === 'char' && key.ch && DIGIT.test(key.ch)) {
      if (key.ch === '.' && ts.typeback.includes('.')) return 'none';
      ts.typeback = (ts.typeback + key.ch).slice(0, 12);
      return 'none';
    }
    if (ts.typebackRequired && key.name === 'backspace') { ts.typeback = ts.typeback.slice(0, -1); return 'none'; }
    const confirmKey = (key.name === 'char' && (key.ch === 'y' || key.ch === 'Y')) || key.name === 'enter';
    if (confirmKey) {
      if (ts.typebackRequired) {
        const want = parseNum(ts.sizeInput);
        const got = parseNum(ts.typeback);
        if (!(Number.isFinite(got) && Math.abs(got - want) < 1e-9)) {
          ts.message = `type the size (${ts.sizeInput}) to confirm this PAPER ${ts.side}`;
          return 'none';
        }
      }
      ts.phase = 'filling';
      return 'confirm';
    }
    // any other key cancels the arm (a stray key never confirms, and never navigates mid-confirm)
    ts.phase = 'editing';
    ts.typeback = '';
    ts.message = 'confirm cancelled';
    return 'none';
  }

  // ---- editing
  if (key.name === 'esc') return 'close';
  if (key.name === 'tab') { ts.field = ts.field === 'size' ? 'slippage' : 'size'; return 'none'; }
  if (key.name === 'left' || key.name === 'right') {
    ts.side = ts.side === 'buy' ? 'sell' : 'buy';
    ts.sizeUnit = ts.side === 'buy' ? ts.sizeUnit : 'pct';
    ts.typeback = '';
    return 'changed';
  }
  if (key.name === 'char' && key.ch === 'u' && !key.ctrl) {
    if (ts.side === 'buy') { ts.sizeUnit = ts.sizeUnit === 'sol' ? 'pct' : 'sol'; return 'changed'; }
    return 'none'; // sell is always % of the position
  }
  if (key.name === 'enter') {
    if (!orderValid(ts, ctx)) { ts.message = ts.side === 'sell' && ctx.positionTokensRaw <= 0n ? `no ${ts.symbol} position to sell` : 'enter a size first'; return 'none'; }
    ts.typebackRequired = ts.gateOn && ctx.notionalSol > ctx.typebackThresholdSol;
    ts.typeback = '';
    ts.phase = 'confirm';
    return 'none';
  }
  if (editField(ts, key)) return 'changed';
  return 'none';
}

// --------------------------------------------------------------------------- view models

/** Everything the ticket screen renders (built by the live binding, or seeded for a demo frame). */
export interface TicketView {
  ticket: TicketState;
  balanceSol: number;
  /** Human token balance of this mint (for sell sizing + the receipt). */
  positionTokens: number;
  /** Mark value of the held position in SOL, null when no price. */
  positionValueSol: number | null;
  /** The warm quote behind the preview fill (route, min-received, usd); null while loading/invalid. */
  quote: SwapQuote | null;
  /** The fill the current order would produce from `quote` (preview). */
  preview: Fill | null;
  /** Age of the warm quote in ms (freshness countdown). */
  quoteAgeMs: number | null;
  loading: boolean;
  error: string | null;
  /** The booked fill once the ticket reaches the `filled` phase. */
  receipt: Fill | null;
  /** True while a confirm-time quote is queued behind a Jupiter 429 pause (drives the retrying UI). */
  rateLimited: boolean;
  /**
   * task-1368: false while the token's decimals are still unknown (the binding is resolving them; `ticket.decimals`
   * is a placeholder 9). The screen must then say so instead of printing a token amount computed from a guess.
   * Absent = known (seeded demo views).
   */
  decimalsKnown?: boolean;
}

export interface PositionRowView {
  mint: string;
  symbol: string;
  tokens: number;
  costSol: number;
  avgEntrySol: number | null;
  priceSol: number | null;
  valueSol: number | null;
  unrealizedSol: number | null;
  unrealizedPct: number | null;
  realizedSol: number;
}

/** Everything the positions screen renders. */
export interface PositionsView {
  balanceSol: number;
  startSol: number;
  /** balance + marked value of all open positions. */
  equitySol: number;
  totalUnrealizedSol: number;
  totalRealizedSol: number;
  /** equity − start, as a fraction of start. */
  totalPct: number | null;
  solPriceUsd: number | null;
  rows: PositionRowView[];
  history: TradeRecord[];
  loading: boolean;
}

/** SOL notional of a buy order sized in SOL/%, used to gate the typed-back step without a quote. */
export function buyNotionalSol(ts: TicketState, balanceLamports: bigint): number {
  const n = parseNum(ts.sizeInput);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (ts.sizeUnit === 'sol') return n;
  return (Number(balanceLamports) / 1e9) * Math.min(100, n) / 100;
}
