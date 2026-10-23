// dexterm autotrade — the strategy engine (task-1498 spike, AUTOTRADE-SPEC §1, §4, §6).
//
// Pure, deterministic, no I/O. Three jobs:
//   screen()     does this tick make the coin a candidate under the strategy's entry rules?
//   clampEntry() turn an agent's (or the auto rule's) entry request into the size the strategy allows,
//                with every reduction named. The agent can ask for anything; it gets at most this.
//   SimBook      the paper book + the fill model shared by replays and backtests (constant-product impact
//                on the recorded liquidity, fee, slippage, partial fills at the impact cap, unsellable exits).
//
// In a live paper run the fills come from the app's paper desk instead (real Jupiter quotes, the mandate
// caps, the journal). The clamp is the first of
// three independent fences, never the only one.

import { parseFilter } from '../../cli/src/screener/filter.ts';
import { tickRow, type MarketTick } from './replay.ts';
import type { ExitProfile, ResolvedStrategy } from './strategy.ts';
import type { PaperAccount } from './paper-accounts.ts';

export const DAY_MS = 86_400_000;
const r2 = (x: number) => Math.round(x * 100) / 100;
const r6 = (x: number) => Number(x.toPrecision(6));

// ───────────────────────────── screen ─────────────────────────────

export interface ScreenResult { pass: boolean; matched: string[]; failed: string[] }

/** Compiled entry rules (the filter is parsed once per strategy). */
export class EntryRules {
  readonly strategy: ResolvedStrategy;
  private readonly predicate: (k: MarketTick) => boolean;
  constructor(strategy: ResolvedStrategy) {
    this.strategy = strategy;
    const f = parseFilter(strategy.entry.screen);
    if (!f.ok) throw new Error(`entry.screen: ${f.error}`);
    this.predicate = (k) => f.filter.predicate(tickRow(k));
  }

  screen(k: MarketTick): ScreenResult {
    const e = this.strategy.entry;
    const failed: string[] = [];
    const matched: string[] = [];
    if (k.kind !== 'live') failed.push('not-listed');
    if (k.price === null || k.price <= 0) failed.push('no-price');
    if (!this.predicate(k)) failed.push('screen');
    const ageH = k.createdAt ? (k.t - k.createdAt) / 3600e3 : null;
    if (ageH === null) failed.push('age-unknown');
    else if (ageH < e.ageHours.min || (e.ageHours.max !== null && ageH > e.ageHours.max)) failed.push('age');
    const s = e.safety;
    if (s.requireNoMintAuthority && k.mintAuth !== false) failed.push(k.mintAuth === null ? 'mint-authority-unknown' : 'mint-authority');
    if (s.requireNoFreezeAuthority && k.freezeAuth !== false) failed.push(k.freezeAuth === null ? 'freeze-authority-unknown' : 'freeze-authority');
    if (s.maxTop10Pct !== null) {
      if (k.top10 === null) { if (s.unknownHolders === 'reject') failed.push('holders-unknown'); }
      else if (k.top10 > s.maxTop10Pct) failed.push('top10');
    }
    if (s.maxDevPct !== null && k.dev !== null && k.dev > s.maxDevPct) failed.push('dev-share');
    if (s.maxMcapSplitX !== null && (k.mcapFlagged || splitX(k) > s.maxMcapSplitX)) failed.push('mcap-split');
    if (s.youngVertical && ageH !== null && ageH < s.youngVertical.maxAgeHours && (k.chg1h ?? 0) >= s.youngVertical.maxH1Pct) failed.push('young-vertical');
    const fired = e.triggers.map((t) => {
      switch (t.kind) {
        case 'screen': return true;
        case 'momentum': return (k.chg5m ?? -Infinity) >= t.m5MinPct && ratio(k.buys5m, k.sells5m) >= t.buySellMin;
        // Live feeds only: a replay has no narrative heat or followed-wallet stream, so these never fire here.
        case 'narrative': return false;
        case 'wallet': return false;
      }
    });
    e.triggers.forEach((t, i) => { if (fired[i]) matched.push(`trigger:${t.kind}`); });
    const trig = e.triggerMode === 'all' ? fired.every(Boolean) : fired.some(Boolean);
    if (!trig) failed.push('trigger');
    return { pass: failed.length === 0, matched, failed };
  }
}

export function splitX(k: MarketTick): number {
  if (!k.mcap || !k.mcapResolved) return 1;
  return Math.max(k.mcap, k.mcapResolved) / Math.max(1e-9, Math.min(k.mcap, k.mcapResolved));
}
const ratio = (a: number | null, b: number | null) => (a === null || b === null ? 0 : b === 0 ? (a > 0 ? Infinity : 0) : a / b);

// ───────────────────────────── book + fills ─────────────────────────────

export interface Fill {
  t: number;
  side: 'buy' | 'sell';
  usd: number;          // cash spent (buy) or received (sell), fees included
  tokens: number;
  price: number;        // the recorded mid price at the fill
  avgPrice: number;     // effective price paid / received
  impactPct: number;
  partial: boolean;
  reason: string;
}

export interface Position {
  id: string;
  mint: string;
  symbol: string;
  profileId: string;
  openedAt: number;
  sessionId: string | null;
  tokens: number;
  origTokens: number;
  costUsd: number;          // cash in, all tranches
  realizedUsd: number;      // cash out so far
  entryPrice: number;       // average mid price paid
  peakPrice: number;
  /** task-1530: the lowest mid price seen while held (the trade ledger's MAE); absent on a restored older position. */
  troughPrice?: number;
  tpFilled: number;
  trailArmed: boolean;
  /** Exit profile 1.2.0: the cost-recovery sell has filled; what is left is a free bag. */
  costRecovered?: boolean;
  /** A tightened bag trail (an agent `tighten` on a free bag); otherwise the profile's bagTrail.trailPct. */
  bagTrailPct?: number;
  ladder: { frac: number; atPct: number; deadline: number; usd: number }[];
  fills: Fill[];
  status: 'open' | 'closed';
  stuck: boolean;
  closedAt: number | null;
  exitReason: string | null;
  /** Rolling liquidity reads for the thesis-break window. */
  liqWindow: { t: number; liq: number }[];
  lowTapeSince: number | null;
  lastTick: MarketTick;
  wakeSent: Record<string, boolean>;
}

export interface ClosedTrade {
  id: string; mint: string; symbol: string; profileId: string; openedAt: number; closedAt: number;
  costUsd: number; proceedsUsd: number; pnlUsd: number; pnlPct: number; exitReason: string; stuck: boolean;
  entryTrigger: string[]; sessionId: string | null; fills: Fill[];
}

export interface Exec { slippageBps: number; feeBps: number; networkFeeUsd: number; maxPriceImpactPct: number; minExitLiquidityUsd: number }

/** Buy `usd` against the recorded pool. Constant product on half the liquidity; a partial fill at the impact cap. */
export function simBuy(k: MarketTick, usd: number, x: Exec): Fill | { refused: string } {
  if (!k.price || k.price <= 0) return { refused: 'no-price' };
  if (!k.liq || k.liq <= 0) return { refused: 'no-liquidity' };
  const R = k.liq / 2;
  const net = usd - x.networkFeeUsd;
  if (net <= 0) return { refused: 'below-network-fee' };
  let input = net * (1 - x.feeBps / 1e4);
  // Constant product: the average price paid is mid × (1 + input / R), so the impact is input / R.
  const capIn = R * (x.maxPriceImpactPct / 100);
  const partial = input > capIn;
  if (partial) input = capIn;
  const tokens = ((R / k.price) * input) / (R + input) / (1 + x.slippageBps / 1e4);
  const spent = partial ? input / (1 - x.feeBps / 1e4) + x.networkFeeUsd : usd;
  return { t: k.t, side: 'buy', usd: r6(spent), tokens, price: k.price, avgPrice: r6(spent / tokens), impactPct: r2((input / R) * 100), partial, reason: 'entry' };
}

/** Sell `tokens` into the recorded pool. Below minExitLiquidityUsd (or no pool) nothing sells: the bag is stuck. */
export function simSell(k: MarketTick, tokens: number, x: Exec, reason: string): Fill | { refused: string } {
  if (!k.price || k.price <= 0) return { refused: 'no-price' };
  if (!k.liq || k.liq < x.minExitLiquidityUsd) return { refused: 'illiquid' };
  const R = k.liq / 2;
  const V = tokens * k.price;
  const gross = (V * R) / (R + V);
  const usd = gross * (1 - x.feeBps / 1e4) * (1 - x.slippageBps / 1e4) - x.networkFeeUsd;
  if (usd <= 0) return { refused: 'dust' };
  return { t: k.t, side: 'sell', usd: r6(usd), tokens, price: k.price, avgPrice: r6(usd / tokens), impactPct: r2((V / (R + V)) * 100), partial: false, reason };
}

/** Value of a position if sold now through the same model (0 when it cannot be sold). */
export function liquidationValue(p: Position, k: MarketTick, x: Exec): number {
  if (p.tokens <= 0) return 0;
  const f = simSell(k, p.tokens, x, 'mark');
  return 'refused' in f ? 0 : f.usd;
}

export interface BookState {
  cashUsd: number;
  peakEquityUsd: number;
  dayStart: number;
  dayStartEquityUsd: number;
  dayRealizedUsd: number;
  entriesToday: number;
  lossStreak: number;
  cooldownUntil: number;
  halted: string | null;      // 'drawdown' | 'daily-loss' | 'kill-switch' | null
  sizeDown: boolean;
  perCoin: Record<string, { entries: number; lastExit: number }>;
}

export class SimBook {
  readonly strategy: ResolvedStrategy;
  readonly state: BookState;
  readonly open = new Map<string, Position>();
  readonly closed: ClosedTrade[] = [];
  private seq = 0;
  private readonly triggers = new Map<string, string[]>();
  /** The shared paper account this book trades from (task-1538), or null: the book owns its bankroll. */
  readonly account: PaperAccount | null;

  constructor(strategy: ResolvedStrategy, now: number, account?: PaperAccount, member?: string) {
    this.strategy = strategy;
    this.account = account ?? null;
    const start = account ? account.bookEquity() : strategy.bankroll.startUsd;
    this.state = { cashUsd: start, peakEquityUsd: start, dayStart: dayOf(now), dayStartEquityUsd: start, dayRealizedUsd: 0, entriesToday: 0, lossStreak: 0, cooldownUntil: 0, halted: null, sizeDown: false, perCoin: {} };
    if (account) {
      // On a shared account the cash IS the account's: every fill and sale below moves the wallet's cash.
      Object.defineProperty(this.state, 'cashUsd', { get: () => account.cashUsd, set: (v: number) => { account.cashUsd = v; }, enumerable: true });
      account.join(this, member);
    }
  }

  /** Book equity: cash + the cost basis still open (unrealized gains do not count for sizing). On an account: the account's. */
  bookEquity(): number {
    if (this.account) return this.account.bookEquity();
    let e = this.state.cashUsd;
    for (const p of this.open.values()) e += Math.max(0, p.costUsd - p.realizedUsd);
    return e;
  }
  /** Marked equity: cash + what every open bag would sell for now (stuck bags count 0). On an account: the account's. */
  markedEquity(): number {
    if (this.account) return this.account.markedEquity();
    let e = this.state.cashUsd;
    for (const p of this.open.values()) e += liquidationValue(p, p.lastTick, this.strategy.execution);
    return e;
  }
  /** This book's own open cost basis (its exposure, also on a shared account). */
  exposureUsd(): number { return this.openCostUsd(); }
  openCostUsd(): number {
    let e = 0;
    for (const p of this.open.values()) e += Math.max(0, p.costUsd - p.realizedUsd);
    return e;
  }
  /** What this book's open bags would sell for now. */
  openMarkUsd(): number {
    let e = 0;
    for (const p of this.open.values()) e += liquidationValue(p, p.lastTick, this.strategy.execution);
    return e;
  }
  /** This book's own P/L: closed trades + the open bags marked now (on a shared account, the strategy's share). */
  ownPnlUsd(): number {
    let e = 0;
    for (const t of this.closed) e += t.pnlUsd;
    for (const p of this.open.values()) e += liquidationValue(p, p.lastTick, this.strategy.execution) + p.realizedUsd - p.costUsd;
    return e;
  }

  /** Day roll, drawdown size-down / halt. Called by the runner on every step. */
  roll(now: number): void {
    const s = this.state;
    const d = dayOf(now);
    if (d !== s.dayStart) {
      s.dayStart = d; s.dayRealizedUsd = 0; s.entriesToday = 0; s.dayStartEquityUsd = this.bookEquity();
      if (s.halted === 'daily-loss') s.halted = null;
    }
    const eq = this.markedEquity();
    s.peakEquityUsd = Math.max(s.peakEquityUsd, eq);
    const dd = ((s.peakEquityUsd - eq) / s.peakEquityUsd) * 100;
    const r = this.strategy.risk.drawdown;
    if (dd >= r.haltAtPct && !s.halted) s.halted = 'drawdown';
    if (dd >= r.sizeDownAtPct) s.sizeDown = true;
    else if (dd < r.recoverBelowPct) s.sizeDown = false;
  }

  openPosition(k: MarketTick, fill: Fill, profile: ExitProfile, sessionId: string | null, trigger: string[], ladder: Position['ladder']): Position {
    const id = `p${++this.seq}`;
    const p: Position = {
      id, mint: k.mint, symbol: k.symbol, profileId: profile.id, openedAt: k.t, sessionId,
      tokens: fill.tokens, origTokens: fill.tokens, costUsd: fill.usd, realizedUsd: 0, entryPrice: fill.price, peakPrice: fill.price, troughPrice: fill.price,
      tpFilled: 0, trailArmed: false, ladder, fills: [fill], status: 'open', stuck: false, closedAt: null, exitReason: null,
      liqWindow: [{ t: k.t, liq: k.liq ?? 0 }], lowTapeSince: null, lastTick: k, wakeSent: {},
    };
    this.state.cashUsd -= fill.usd;
    this.state.entriesToday++;
    const c = (this.state.perCoin[k.mint] ??= { entries: 0, lastExit: 0 });
    c.entries++;
    this.open.set(k.mint, p);
    this.triggers.set(id, trigger);
    return p;
  }

  addTranche(p: Position, fill: Fill): void {
    this.state.cashUsd -= fill.usd;
    const tokens = p.tokens + fill.tokens;
    p.entryPrice = (p.entryPrice * p.tokens + fill.price * fill.tokens) / tokens;
    p.tokens = tokens; p.origTokens += fill.tokens; p.costUsd += fill.usd;
    p.fills.push(fill);
  }

  /** Book a sell; closes the position when nothing is left. */
  sell(p: Position, fill: Fill): ClosedTrade | null {
    p.tokens = Math.max(0, p.tokens - fill.tokens);
    if (p.tokens < p.origTokens * 1e-6) p.tokens = 0;
    p.realizedUsd += fill.usd;
    this.state.cashUsd += fill.usd;
    p.fills.push(fill);
    if (p.tokens > 0) return null;
    return this.close(p, fill.t, fill.reason, false);
  }

  /** Close the books on a position (also used at the end of a run: stuck bags close at 0). */
  close(p: Position, t: number, reason: string, stuck: boolean): ClosedTrade {
    p.status = 'closed'; p.closedAt = t; p.exitReason = reason; p.stuck = stuck;
    this.open.delete(p.mint);
    const pnl = p.realizedUsd - p.costUsd;
    const s = this.state;
    s.dayRealizedUsd += pnl;
    if (pnl < 0) {
      s.lossStreak++;
      if (s.lossStreak >= this.strategy.risk.lossStreak.losses) { s.cooldownUntil = t + this.strategy.risk.lossStreak.cooldownMin * 60e3; s.lossStreak = 0; }
    } else s.lossStreak = 0;
    const lossPct = (-s.dayRealizedUsd / s.dayStartEquityUsd) * 100;
    if (lossPct >= this.strategy.risk.dailyLossHaltPct && !s.halted) s.halted = 'daily-loss';
    (s.perCoin[p.mint] ??= { entries: 0, lastExit: 0 }).lastExit = t;
    const ct: ClosedTrade = {
      id: p.id, mint: p.mint, symbol: p.symbol, profileId: p.profileId, openedAt: p.openedAt, closedAt: t,
      costUsd: r6(p.costUsd), proceedsUsd: r6(p.realizedUsd), pnlUsd: r6(pnl), pnlPct: r2((pnl / p.costUsd) * 100),
      exitReason: reason, stuck, entryTrigger: this.triggers.get(p.id) ?? [], sessionId: p.sessionId, fills: p.fills,
    };
    this.closed.push(ct);
    return ct;
  }
}

export const dayOf = (t: number) => Math.floor(t / DAY_MS);

// ───────────────────────────── sizing + clamp ─────────────────────────────

/** What a session (or the auto rule) asks for. Every field is optional: the clamp fills in the strategy size. */
export interface EntryRequest { profile?: string; sizeUsd?: number; sizePct?: number; confidence?: number }

export interface Clamp { rule: string; fromUsd: number; toUsd: number }
export type ClampResult =
  | { ok: true; usd: number; firstTrancheUsd: number; profile: ExitProfile; clamps: Clamp[]; basis: string }
  | { ok: false; refused: string; clamps: Clamp[] };

/**
 * The strategy's answer to "may I enter, and with how much?". Order: refusals (kill switch, halts,
 * cooldowns, counts), then the size the strategy itself picks, then every ceiling, each reduction recorded.
 * An agent request can only LOWER the size below the strategy's own pick, never raise it above a ceiling.
 */
export function clampEntry(book: SimBook, k: MarketTick, req: EntryRequest, killSwitch = false): ClampResult {
  const s = book.strategy;
  const st = book.state;
  const clamps: Clamp[] = [];
  const no = (refused: string): ClampResult => ({ ok: false, refused, clamps });
  // task-1571: paper only (dexterm holds no key and places no live order).
  if (s.mode !== 'paper') return no('mode-not-paper');
  if (killSwitch) return no('kill-switch');
  if (st.halted) return no(`halted:${st.halted}`);
  if (k.t < st.cooldownUntil) return no('loss-streak-cooldown');
  if (book.open.has(k.mint)) return no('already-open');
  // Free bags (cost recovered) can stop counting as open positions, up to their own cap (exit profile 1.2.0).
  const rb = s.risk.recoveredBags;
  const bags = rb && !rb.countAsOpen ? [...book.open.values()].filter((p) => p.costRecovered).length : 0;
  if (book.open.size - bags >= s.risk.maxConcurrent) return no('max-concurrent');
  if (rb && !rb.countAsOpen && book.open.size >= s.risk.maxConcurrent + rb.maxBags) return no('max-open-with-bags');
  if (st.entriesToday >= s.risk.maxEntriesPerDay) return no('max-entries-per-day');
  const coin = st.perCoin[k.mint];
  const profileId = req.profile ?? s.exits.default;
  const profile = s.exits.profiles[profileId];
  if (!profile) return no(`unknown-profile:${profileId}`);
  if (coin) {
    if (coin.entries >= s.risk.perCoin.maxEntries) return no('per-coin-max-entries');
    if (!profile.reentry.allowed) return no('profile-no-reentry');
    const cool = Math.max(s.risk.perCoin.cooldownMin, profile.reentry.cooldownMinutes) * 60e3;
    if (k.t - coin.lastExit < cool) return no('per-coin-cooldown');
  }
  if ((k.liq ?? 0) < profile.fit.minLiquidityUsd) return no('profile-min-liquidity');

  const bank = book.bookEquity();
  const z = s.sizing;
  let usd: number;
  let basis: string;
  switch (z.mode) {
    case 'fixed': usd = z.fixedUsd ?? 0; basis = `fixed $${z.fixedUsd}`; break;
    case 'pct': usd = (bank * (z.pct ?? 0)) / 100; basis = `${z.pct}% of $${r2(bank)}`; break;
    case 'risk': {
      const stop = profile.hardStop.enabled && profile.hardStop.atPct !== null ? Math.abs(profile.hardStop.atPct) : s.risk.perTrade.assumedLossPctNoStop;
      usd = (bank * (z.riskPct ?? 0)) / stop; basis = `${z.riskPct}% risk / ${stop}% stop of $${r2(bank)}`; break;
    }
    case 'confidence': {
      const c = z.confidence ?? { minPct: 1, maxPct: 1, default: 0.5 };
      const conf = clamp01(req.confidence ?? c.default);
      const pct = c.minPct + (c.maxPct - c.minPct) * conf;
      usd = (bank * pct) / 100; basis = `confidence ${r2(conf)} → ${r2(pct)}% of $${r2(bank)}`; break;
    }
  }
  // The agent may ask for LESS than the strategy's pick (never more).
  const asked = req.sizeUsd ?? (req.sizePct !== undefined ? (bank * req.sizePct) / 100 : undefined);
  if (asked !== undefined && Number.isFinite(asked)) {
    if (asked < usd) { basis += `, agent asked $${r2(asked)}`; usd = Math.max(0, asked); }
    else if (asked > usd) clamps.push({ rule: 'strategy-size', fromUsd: r2(asked), toUsd: r2(usd) });
  }
  const cap = (rule: string, limit: number) => { if (usd > limit + 1e-9) { clamps.push({ rule, fromUsd: r2(usd), toUsd: r2(Math.max(0, limit)) }); usd = Math.max(0, limit); } };
  if (st.sizeDown) cap('drawdown-size-down', usd * s.risk.drawdown.sizeDownMult);
  cap('strategy-max-pct', (bank * s.sizing.maxPctOfBankroll) / 100);
  cap('profile-max-pct', (bank * profile.sizing.maxSizePctOfBankroll) / 100);
  cap('strategy-max-usd', s.sizing.maxUsd);
  const lossPct = profile.hardStop.enabled && profile.hardStop.atPct !== null ? Math.abs(profile.hardStop.atPct) : s.risk.perTrade.assumedLossPctNoStop;
  cap('per-trade-max-loss', (bank * s.risk.perTrade.maxLossPctOfBankroll) / lossPct);
  cap('max-exposure', (bank * s.risk.maxExposurePct) / 100 - book.exposureUsd());
  cap('cash', st.cashUsd);
  const R = (k.liq ?? 0) / 2;
  const imp = s.execution.maxPriceImpactPct / 100;
  cap('price-impact', (R * imp) / (1 - s.execution.feeBps / 1e4) + s.execution.networkFeeUsd);
  if (usd < s.sizing.minUsd) return no(clamps.length ? `below-min-after-${clamps[clamps.length - 1].rule}` : 'below-min-size');
  const first = z.ladder ? usd * z.ladder[0].frac : usd;
  return { ok: true, usd: r2(usd), firstTrancheUsd: r2(first), profile, clamps, basis };
}

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0.5);
