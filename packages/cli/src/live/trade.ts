// dexterm — live bindings for the PAPER trade ticket and the positions screen (task-1310 T0).
// The ticket binding fetches a warm keyless swap quote for the current order, previews the fill, and
// on confirm fetches a FRESH quote and asks the executor to book it (SPEC §6.1 step 6: book from the
// fill, not a stale on-screen quote). The positions binding marks held tokens from the keyless price
// feed. Both go through the data layer's rate limiter + budget meter; neither signs, holds a key, or
// sends a transaction — the only trade op is `executor.execute`, a TradeExecutor the UI holds behind
// an interface (acceptance (d)).
import {
  SOL_MINT, lamportsToSol, rawToTokens, positionPnl, withPriority,
  type DataLayer, type Fill, type PaperWallet, type Position, type SwapQuote, type TradeExecutor,
} from '@dexterm/data';
import type { SettledTx } from '@dexterm/tui';
import {
  openTicket, ticketKey, toOrder, orderValid, buyNotionalSol, DEFAULT_TYPEBACK_THRESHOLD_SOL,
  type TicketState, type TicketSeed, type TicketContext, type TicketKey, type TicketEffect, type TicketView, type PositionsView, type PositionRowView,
} from '../trade.ts';

/** task-1368: bounds on a rate-limit wait ("retry in Ns"). */
export const RETRY_MIN_MS = 1_000;
export const RETRY_MAX_MS = 120_000;
/** When a rate-limit error gave no wait, assume this. */
export const RETRY_DEFAULT_MS = 10_000;

/** A rate-limit error, if that is what `e` is: the honest wait and its own line. */
export function rateLimitOf(e: unknown): { ms: number; message: string } | null {
  if (!(e instanceof Error)) return null;
  const reason = (e as { reason?: unknown }).reason;
  const plain = e.message.replace(/^rate-limited:\s*/, '');
  if (reason !== 'rate-limited' && !/^rate-limited:/.test(e.message)) return null;
  const given = (e as { retryAfterMs?: unknown }).retryAfterMs;
  const parsed = /retry in (\d+)s/.exec(plain);
  const ms = typeof given === 'number' && Number.isFinite(given) && given > 0 ? given : parsed ? Number(parsed[1]) * 1000 : RETRY_DEFAULT_MS;
  return { ms: Math.min(RETRY_MAX_MS, Math.max(RETRY_MIN_MS, ms)), message: plain };
}

export interface TradeTicketOptions {
  now?: () => number;
  onChange?: () => void;
  typebackThresholdSol?: number;
  /** Hard ceiling on the confirm-time quote wait before it fails to an error (task-1310 MAJOR fix). */
  confirmQuoteTimeoutMs?: number;
  /**
   * task-1340 trade moments: called ONCE per settled outcome — a booked paper fill or a failure — with the
   * outcome itself. Never for a quote. The UI fires effects + sound from this and nowhere else.
   */
  onSettled?: (tx: SettledTx) => void;
}

/** Default bound on the confirm-time quote: after this the ticket errors instead of hanging. */
export const CONFIRM_QUOTE_TIMEOUT_MS = 8_000;

/** A live PAPER trade ticket over one mint. */
export class TradeTicketLive {
  readonly ticket: TicketState;
  private readonly dl: DataLayer;
  private readonly wallet: PaperWallet;
  private readonly exec: TradeExecutor;
  private readonly now: () => number;
  private readonly onChange: () => void;
  private readonly threshold: number;
  private readonly confirmTimeoutMs: number;
  private quote: SwapQuote | null = null;
  private quoteAt = 0;
  private loading = false;
  private error: string | null = null;
  private receipt: Fill | null = null;
  private decimalsKnown: boolean;
  private seq = 0;
  private quoteTimer: ReturnType<typeof setTimeout> | null = null;
  /** In-flight confirm quote; aborting it (timeout or esc) unblocks the `filling` phase. */
  private confirmAbort: AbortController | null = null;
  /** Set when the user cancels (esc) during `filling`, so confirm() leaves the ticket in editing. */
  private cancelled = false;
  private readonly onSettled: ((tx: SettledTx) => void) | null;

  constructor(dl: DataLayer, wallet: PaperWallet, exec: TradeExecutor, seed: TicketSeed, opts: TradeTicketOptions = {}) {
    this.dl = dl;
    this.wallet = wallet;
    this.exec = exec;
    this.now = opts.now ?? (() => Date.now());
    this.onChange = opts.onChange ?? (() => {});
    this.threshold = opts.typebackThresholdSol ?? DEFAULT_TYPEBACK_THRESHOLD_SOL;
    this.confirmTimeoutMs = opts.confirmQuoteTimeoutMs ?? CONFIRM_QUOTE_TIMEOUT_MS;
    this.onSettled = opts.onSettled ?? null;
    this.decimalsKnown = typeof seed.decimals === 'number' && Number.isFinite(seed.decimals) && seed.decimals > 0;
    this.ticket = openTicket(seed);
    void this.ensureDecimals();
    this.refreshQuote();
  }

  private positionTokensRaw(): bigint {
    return this.wallet.position(this.ticket.mint)?.tokensRaw ?? 0n;
  }

  private notionalSol(): number {
    if (this.ticket.side === 'buy') return buyNotionalSol(this.ticket, this.wallet.balance());
    // sell: SOL the warm quote would return, else mark the held slice of the position
    if (this.quote && this.quote.inputMint === this.ticket.mint) return lamportsToSol(this.quote.outAmount);
    return 0;
  }

  private ctx(): TicketContext {
    return {
      balanceLamports: this.wallet.balance(),
      positionTokensRaw: this.positionTokensRaw(),
      notionalSol: this.notionalSol(),
      typebackThresholdSol: this.threshold,
    };
  }

  /** Apply a key; refetch the warm quote on a change. Returns 'confirm'/'close' for the loop. */
  key(k: TicketKey): TicketEffect {
    const eff = ticketKey(this.ticket, k, this.ctx());
    if (eff === 'confirm' || eff === 'close') this.clearQuoteTimer();
    if (eff === 'changed') { this.receipt = null; this.scheduleQuote(); }
    return eff;
  }

  private clearQuoteTimer(): void {
    if (this.quoteTimer) { clearTimeout(this.quoteTimer); this.quoteTimer = null; }
  }

  /**
   * Debounce the warm quote so a size typed digit-by-digit fires ONE request, not one per key — the
   * keyless `jupiter` bucket is shared with token enrichment and must not be flooded (SPEC §6.3 warm
   * quote stream, free-forever limiter). The timer is unref'd so a pending fetch never blocks quit.
   */
  private scheduleQuote(delayMs = 300): void {
    this.clearQuoteTimer();
    const h = setTimeout(() => { this.quoteTimer = null; this.refreshQuote(); }, delayMs);
    if (typeof (h as { unref?: () => void }).unref === 'function') (h as { unref: () => void }).unref();
    this.quoteTimer = h;
  }

  /** Token decimals drive display + SOL/token price. Pull from the enrichment cache (usually a hit). */
  private async ensureDecimals(): Promise<void> {
    if (this.decimalsKnown) return;
    try {
      const r = await this.dl.store.enrich([this.ticket.mint]);
      const d = r.rows[0]?.token.decimals;
      if (typeof d === 'number' && d > 0) { this.ticket.decimals = d; this.decimalsKnown = true; this.refreshQuote(); this.onChange(); }
    } catch { /* keep the default; display may be approximate until known */ }
  }

  /** Fetch a warm quote for the current order (debounced by a sequence guard). */
  refreshQuote(): void {
    const ctx = this.ctx();
    if (!orderValid(this.ticket, ctx) || this.ticket.phase === 'filling') { this.quote = null; return; }
    const order = toOrder(this.ticket, ctx);
    const my = ++this.seq;
    this.loading = true;
    this.error = null;
    const req = { inputMint: order.side === 'buy' ? SOL_MINT : order.mint, outputMint: order.side === 'buy' ? order.mint : SOL_MINT, amount: order.amountRaw, slippageBps: order.slippageBps, mode: 'ExactIn' as const };
    // task-1387: the quote runs at `high` priority so a user-initiated trade quote preempts the background
    // screener/token enrichment on the shared 0.5 rps keyless `jupiter` bucket — otherwise the warm quote queues for seconds.
    withPriority('high', () => this.dl.jupiterSwap.quote(req))
      .then((q) => { if (my !== this.seq) return; this.quote = q; this.quoteAt = this.now(); this.loading = false; this.onChange(); })
      .catch((e: unknown) => { if (my !== this.seq) return; this.quote = null; this.loading = false; this.error = rateLimitOf(e)?.message ?? msg(e); this.onChange(); });
  }

  /** True while Jupiter's shared keyless bucket is paused (429 backoff) — drives the 'rate limited' UI. */
  private jupiterPaused(): boolean {
    try { return this.dl.limiter.bucket('jupiter').stats().pausedUntil > this.now(); } catch { return false; }
  }

  /**
   * Cancel an in-flight confirm (esc during `filling`). Aborts the bounded quote wait so the booking
   * can never trap the user, and returns the ticket to editing. No-op outside `filling`.
   */
  cancel(): void {
    if (this.ticket.phase !== 'filling') return;
    this.cancelled = true;
    this.confirmAbort?.abort(abortError('confirm cancelled'));
    this.ticket.phase = 'editing';
    this.ticket.message = 'confirm cancelled';
    this.loading = false;
    this.onChange();
  }

  /**
   * Execute the armed order against a FRESH quote fetched at confirm time, then book the fill.
   * The ticket is already in `filling`; moves to `filled` (receipt), `error`, or (on esc) back to
   * `editing`. The quote is bounded by `confirmTimeoutMs` (task-1310 MAJOR fix): if the shared
   * keyless `jupiter` bucket is paused after a 429, the wait is aborted and the ticket errors
   * instead of hanging and swallowing esc/P/q.
   */
  async confirm(): Promise<void> {
    const ctx = this.ctx();
    const order = toOrder(this.ticket, ctx);
    this.clearQuoteTimer();
    this.seq++; // cancel any in-flight warm quote
    this.cancelled = false;
    this.loading = true;
    const ac = new AbortController();
    this.confirmAbort = ac;
    const timer = setTimeout(() => ac.abort(abortError('confirm quote timed out')), this.confirmTimeoutMs);
    if (typeof (timer as { unref?: () => void }).unref === 'function') (timer as { unref: () => void }).unref();
    // Visible 'rate limited, retrying' state when the fresh quote is queued behind a 429 pause.
    if (this.jupiterPaused()) this.ticket.message = 'rate limited by Jupiter — retrying…';
    this.onChange();
    try {
      if (!orderValid(this.ticket, ctx)) throw new Error('order is no longer valid');
      const req = { inputMint: order.side === 'buy' ? SOL_MINT : order.mint, outputMint: order.side === 'buy' ? order.mint : SOL_MINT, amount: order.amountRaw, slippageBps: order.slippageBps, mode: 'ExactIn' as const };
      // task-1387: the confirm-time re-quote is the user's committed action — at `high` priority it
      // jumps the shared keyless `jupiter` bucket ahead of background enrichment and drains within
      // the `confirmTimeoutMs` abort, so a PAPER fill no longer errors with "quote timed out".
      const fresh = await withPriority('high', () => this.dl.jupiterSwap.quote(req, ac.signal));
      const costBefore = this.wallet.position(this.ticket.mint)?.costLamports ?? null; // PnL % basis for a sell
      const rec = await this.exec.execute(order, fresh);
      this.receipt = rec;
      this.quote = fresh;
      this.quoteAt = this.now();
      this.ticket.phase = 'filled';
      this.ticket.message = null;
      this.settle(settledFromFill(rec, costBefore));
    } catch (e) {
      if (this.cancelled) {
        // esc already returned the ticket to editing; leave it there.
      } else {
        const aborted = isAbortError(e);
        this.ticket.phase = 'error';
        this.ticket.message = aborted
          ? (this.jupiterPaused()
            ? 'rate limited by Jupiter — quote timed out. Press any key to retry, esc to cancel.'
            : 'quote timed out. Press any key to retry, esc to cancel.')
          : msg(e);
        this.error = this.ticket.message;
        this.settle({ status: 'failed', side: this.ticket.side, symbol: this.ticket.symbol, mint: this.ticket.mint, sig: null, solDelta: null, pnlSol: null, pnlPct: null, ledger: 'paper', reason: this.ticket.message });
      }
    } finally {
      clearTimeout(timer);
      this.confirmAbort = null;
      this.loading = false;
      this.onChange();
    }
  }

  /** The single exit for a settled outcome (paper fill or failure). Never called with a quote. */
  private settle(tx: SettledTx): void {
    if (!this.onSettled) return;
    try { this.onSettled(tx); } catch { /* effects never break the ticket */ }
  }

  view(): TicketView {
    const ctx = this.ctx();
    const pos = this.wallet.position(this.ticket.mint);
    const preview = this.quote && orderValid(this.ticket, ctx) ? safePreview(this.exec, toOrder(this.ticket, ctx), this.quote) : null;
    const positionTokens = pos ? rawToTokens(pos.tokensRaw, pos.decimals) : 0;
    return {
      ticket: this.ticket,
      balanceSol: lamportsToSol(this.wallet.balance()),
      positionTokens,
      positionValueSol: null,
      quote: this.quote,
      preview,
      quoteAgeMs: this.quote ? this.now() - this.quoteAt : null,
      loading: this.loading,
      error: this.error,
      receipt: this.ticket.phase === 'filled' ? this.receipt : null,
      rateLimited: this.ticket.phase === 'filling' && this.jupiterPaused(),
      decimalsKnown: this.decimalsKnown,
    };
  }
}

/** A booked PAPER fill → the settled outcome the effects read. PnL fraction uses the position's cost before the sell. */
export function settledFromFill(f: Fill, costBeforeLamports: bigint | null): SettledTx {
  const pnlSol = f.side === 'sell' ? lamportsToSol(f.realizedLamports) : 0;
  const basis = f.side === 'sell' && costBeforeLamports !== null && costBeforeLamports > 0n ? lamportsToSol(costBeforeLamports) : null;
  return { status: 'confirmed', side: f.side, symbol: f.symbol, mint: f.mint, sig: null, solDelta: lamportsToSol(f.solDelta), pnlSol, pnlPct: basis ? pnlSol / basis : null, ledger: 'paper' };
}

function safePreview(exec: TradeExecutor, order: ReturnType<typeof toOrder>, q: SwapQuote): Fill | null {
  try {
    return exec.previewFill(order, q);
  } catch {
    return null;
  }
}

export const POSITIONS_REFRESH_MS = 10_000;

// ---------------------------------------------------------------------------------------------
// task-1323 item 5: the token screen's POSITION row. The screen asks a PositionSource whether the coin
// on screen is held; the paper ledger (PositionsLive) implements it. Read-only: nothing here trades.

/** A held position as the token screen needs it. SOL-quoted (Solana swaps settle in SOL). */
export interface HeldPosition {
  mint: string;
  symbol: string;
  /** Spot holdings are `long`; the field exists so a future ledger can report `short`. */
  side: 'long' | 'short';
  /** Whole tokens held (raw base units ÷ 10^decimals). > 0 for a held position. */
  tokens: number;
  /** Cost basis of the tokens held, SOL. */
  costSol: number;
  /** Average entry, SOL per whole token. */
  avgEntrySol: number | null;
  /** Lifetime realized PnL on this mint, SOL (0 = none). */
  realizedSol: number;
  /** The source's own last mark, SOL per token — used only when the screen has no live tick. */
  markSol: number | null;
  /** Protective levels, USD per token; null = not set (the paper ledger has none yet). */
  stopUsd: number | null;
  targetUsd: number | null;
  /** Which ledger this came from: always the paper ledger (task-1571: there is no live ledger). */
  kind?: 'paper';
}

/** Where the token screen looks up "do I hold this coin?". Implemented by the paper ledger. */
export interface PositionSource {
  readonly kind: 'paper';
  /** The open position for a mint, or null when flat / never held. Synchronous and cheap (per frame). */
  held(mint: string): HeldPosition | null;
  /** SOL/USD the source last saw (to price a SOL ledger in USD); null when unknown. */
  solUsd(): number | null;
}

/** A paper ledger row → HeldPosition (bigint → number happens here). Null when nothing is held. */
export function heldFromPaper(p: Position, markSol: number | null = null): HeldPosition | null {
  if (p.tokensRaw <= 0n) return null;
  const pnl = positionPnl(p, null);
  return {
    mint: p.mint,
    symbol: p.symbol,
    side: 'long',
    tokens: rawToTokens(p.tokensRaw, p.decimals),
    costSol: pnl.costSol,
    avgEntrySol: pnl.avgEntrySol,
    realizedSol: pnl.realizedSol,
    markSol,
    stopUsd: null,
    targetUsd: null,
  };
}

/** Everything the position row draws. USD fields are null when SOL/USD (or a price) is unknown. */
export interface HeldRow {
  side: 'long' | 'short';
  symbol: string;
  tokens: number;
  priceSol: number | null;
  priceUsd: number | null;
  valueSol: number | null;
  valueUsd: number | null;
  avgEntrySol: number | null;
  avgEntryUsd: number | null;
  unrealizedSol: number | null;
  unrealizedUsd: number | null;
  /** Fraction of cost (0.28 = +28 %). */
  unrealizedPct: number | null;
  realizedSol: number;
  realizedUsd: number | null;
  stopUsd: number | null;
  /** (stop − price) ÷ price, fraction; negative = stop below the price. */
  stopDistPct: number | null;
  targetUsd: number | null;
  targetDistPct: number | null;
  /** What priced the row: the screen's live tick, the source's own mark, or nothing yet. */
  basis: 'tick' | 'mark' | 'none';
  solUsd: number | null;
}

const finitePos = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

/**
 * Price a held position at the screen's live tick. `tickUsd` is the same USD price the header shows;
 * `solUsd` converts the SOL ledger. The SOL ledger is the truth: USD figures are SOL figures × the
 * current SOL/USD, so value − cost = unrealized holds in both units.
 */
export function positionRow(h: HeldPosition, tickUsd: number | null, solUsd: number | null): HeldRow {
  const sol = finitePos(solUsd) ? solUsd : null;
  const tick = finitePos(tickUsd) ? tickUsd : null;
  const mark = finitePos(h.markSol) ? h.markSol : null;
  const priceSol = tick !== null && sol !== null ? tick / sol : mark;
  const priceUsd = tick ?? (mark !== null && sol !== null ? mark * sol : null);
  const valueSol = priceSol !== null ? h.tokens * priceSol : null;
  const dir = h.side === 'long' ? 1 : -1;
  const unrealizedSol = valueSol !== null ? dir * (valueSol - h.costSol) : null;
  const toUsd = (n: number | null) => (n !== null && sol !== null ? n * sol : null);
  const dist = (lvl: number | null) => (finitePos(lvl) && priceUsd !== null ? (lvl - priceUsd) / priceUsd : null);
  return {
    side: h.side,
    symbol: h.symbol,
    tokens: h.tokens,
    priceSol,
    priceUsd,
    valueSol,
    valueUsd: priceUsd !== null ? h.tokens * priceUsd : null,
    avgEntrySol: h.avgEntrySol,
    avgEntryUsd: toUsd(h.avgEntrySol),
    unrealizedSol,
    unrealizedUsd: toUsd(unrealizedSol),
    unrealizedPct: unrealizedSol !== null && h.costSol > 0 ? unrealizedSol / h.costSol : null,
    realizedSol: h.realizedSol,
    realizedUsd: toUsd(h.realizedSol),
    stopUsd: finitePos(h.stopUsd) ? h.stopUsd : null,
    stopDistPct: dist(h.stopUsd),
    targetUsd: finitePos(h.targetUsd) ? h.targetUsd : null,
    targetDistPct: dist(h.targetUsd),
    basis: tick !== null ? 'tick' : mark !== null ? 'mark' : 'none',
    solUsd: sol,
  };
}

/** How long a `held()` lookup is reused before re-reading the ledger (the render loop calls it per frame). */
export const HELD_MEMO_MS = 250;
/** task-1473 r2: how long the open-mints list is reused (a ledger read; the chip samples it every tick). */
export const OPEN_MINTS_MEMO_MS = 1000;
/** Minimum spacing of the token screen's automatic mark pass for a held coin missing SOL/USD or a mark. */
export const HELD_AUTOMARK_MS = 30_000;

/** Live PAPER positions + PnL: marks held tokens from the keyless price feed. */
export class PositionsLive implements PositionSource {
  readonly kind = 'paper' as const;
  private readonly dl: DataLayer;
  private readonly wallet: PaperWallet;
  private readonly onChange: () => void;
  private readonly now: () => number;
  /** mint → current price in SOL per whole token. */
  private marks = new Map<string, number>();
  /** task-1407: when each mark was taken (ms), so a PnL card can print the mark's age. */
  private markTimes = new Map<string, number>();
  private solPriceUsd: number | null = null;
  private loading = false;
  private heldMemo = new Map<string, { at: number; v: HeldPosition | null }>();
  private lastAutoMark = -Infinity;
  errors: Record<string, string> = {};

  constructor(dl: DataLayer, wallet: PaperWallet, opts: { onChange?: () => void; now?: () => number } = {}) {
    this.dl = dl;
    this.wallet = wallet;
    this.onChange = opts.onChange ?? (() => {});
    this.now = opts.now ?? (() => Date.now());
  }

  setSolPrice(p: number | undefined | null): void {
    if (typeof p === 'number' && Number.isFinite(p) && p > 0) this.solPriceUsd = p;
  }

  /** PositionSource: SOL/USD from the last mark pass (or setSolPrice). */
  solUsd(): number | null {
    return this.solPriceUsd;
  }

  /** The last DexScreener mark for a mint (SOL per token). */
  markOf(mint: string): number | null {
    return this.marks.get(mint) ?? null;
  }

  /** task-1407: when the mark for a mint was taken (ms), or null when there is none. */
  markAt(mint: string): number | null {
    return this.marks.has(mint) ? this.markTimes.get(mint) ?? null : null;
  }

  /**
   * PositionSource: the open paper position for a mint, or null. One indexed SQLite read, reused for
   * HELD_MEMO_MS so a 30 fps render loop does not hit the ledger every frame. A closed wallet reads as flat.
   */
  held(mint: string): HeldPosition | null {
    const now = this.now();
    const memo = this.heldMemo.get(mint);
    if (memo && now - memo.at >= 0 && now - memo.at < HELD_MEMO_MS) return memo.v;
    let v: HeldPosition | null = null;
    try {
      const p = this.wallet.position(mint);
      v = p ? heldFromPaper(p, this.marks.get(mint) ?? null) : null;
    } catch { v = null; }
    if (this.heldMemo.size > 64) this.heldMemo.clear();
    this.heldMemo.set(mint, { at: now, v });
    // A held coin with no SOL/USD (presets whose rows carry no SOL) or no mark yet: run the same
    // DexScreener mark pass the positions screen uses, at most once per HELD_AUTOMARK_MS — so the
    // token screen gets USD PnL without visiting positions. Held coins only; never on a flat mint.
    if (v && (this.solPriceUsd === null || v.markSol === null) && now - this.lastAutoMark >= HELD_AUTOMARK_MS) {
      this.lastAutoMark = now;
      void this.refresh().catch(() => {});
    }
    return v;
  }

  /** task-1473 r2: mints of the open paper positions (the AI-scan PnL chip), memoised OPEN_MINTS_MEMO_MS. */
  openMints(): string[] {
    const now = this.now();
    if (this.openMemo && now - this.openMemo.at >= 0 && now - this.openMemo.at < OPEN_MINTS_MEMO_MS) return this.openMemo.v;
    let v: string[] = [];
    try { v = this.wallet.positions().filter((p) => p.tokensRaw > 0n).map((p) => p.mint); } catch { v = []; }
    this.openMemo = { at: now, v };
    return v;
  }
  private openMemo: { at: number; v: string[] } | null = null;

  /**
   * Mark held tokens in SOL. Prices come from DexScreener (its own fast 300 rpm bucket), not the
   * keyless `jupiter` bucket the screener feed and quotes share — so a mark never queues behind them.
   * SOL is priced in the same call so a SOL-per-token mark is derivable without the feed's quote.
   */
  async refresh(): Promise<void> {
    const held = this.wallet.positions().filter((p) => p.tokensRaw > 0n).map((p) => p.mint);
    if (held.length === 0) { this.marks.clear(); return; }
    const mints = held.includes(SOL_MINT) ? held : [...held, SOL_MINT];
    this.loading = true;
    this.errors = {};
    try {
      const byMint = await this.dl.dexscreener.tokens(mints);
      const solUsd = byMint.get(SOL_MINT)?.pair.priceUsd ?? null;
      if (solUsd && solUsd > 0) this.solPriceUsd = solUsd;
      if (this.solPriceUsd && this.solPriceUsd > 0) {
        for (const m of held) {
          if (m === SOL_MINT) { this.marks.set(m, 1); continue; }
          const usd = byMint.get(m)?.pair.priceUsd ?? null;
          if (usd && usd > 0) { this.marks.set(m, usd / this.solPriceUsd); this.markTimes.set(m, this.now()); }
        }
      }
    } catch (e) {
      this.errors.positions = msg(e);
    } finally {
      this.loading = false;
      this.heldMemo.clear(); // a fill or a new mark: the token screen re-reads on its next frame
      this.onChange();
    }
  }

  view(): PositionsView {
    const summary = this.wallet.summary();
    const positions = this.wallet.positions();
    const rows: PositionRowView[] = [];
    let equity = lamportsToSol(summary.balanceLamports);
    let totalUnrealized = 0;
    let totalRealized = 0;
    for (const p of positions) {
      const mark = this.marks.get(p.mint) ?? null;
      const pnl = positionPnl(p, mark);
      totalRealized += pnl.realizedSol;
      if (p.tokensRaw <= 0n && p.realizedLamports === 0n) continue; // fully flat, no history interest
      if (pnl.valueSol) equity += pnl.valueSol;
      if (pnl.unrealizedSol !== null) totalUnrealized += pnl.unrealizedSol;
      rows.push({
        mint: p.mint,
        symbol: p.symbol,
        tokens: rawToTokens(p.tokensRaw, p.decimals),
        costSol: pnl.costSol,
        avgEntrySol: pnl.avgEntrySol,
        priceSol: mark,
        valueSol: mark !== null ? pnl.valueSol : null,
        unrealizedSol: pnl.unrealizedSol,
        unrealizedPct: pnl.unrealizedPct,
        realizedSol: pnl.realizedSol,
      });
    }
    rows.sort((a, b) => (b.valueSol ?? 0) - (a.valueSol ?? 0) || b.tokens - a.tokens);
    const startSol = lamportsToSol(summary.startLamports);
    return {
      balanceSol: lamportsToSol(summary.balanceLamports),
      startSol,
      equitySol: equity,
      totalUnrealizedSol: totalUnrealized,
      totalRealizedSol: totalRealized,
      totalPct: startSol > 0 ? (equity - startSol) / startSol : null,
      solPriceUsd: this.solPriceUsd,
      rows,
      history: this.wallet.trades(100),
      loading: this.loading,
    };
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function abortError(reason: string): Error {
  const e = new Error(reason);
  e.name = 'AbortError';
  return e;
}

/** An AbortError from either our bounded confirm timeout/cancel or fetch's own abort. */
function isAbortError(e: unknown): boolean {
  return (e instanceof Error && e.name === 'AbortError')
    || (typeof DOMException !== 'undefined' && e instanceof DOMException && (e.name === 'AbortError' || e.name === 'TimeoutError'));
}
