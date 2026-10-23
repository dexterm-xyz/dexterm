// task-1443 — the PAPER AGENT DESK: the one surface an untrusted agent (Claude Code, a custom bot) uses to
// open, size, confirm and close a PAPER position, and to read paper positions and paper PnL — strictly inside
// a user-armed mandate's caps (SPEC §6.13, ROADMAP Pillar 4: "agents are untrusted and can never arm, sign or
// raise caps").
//
// Hard boundaries this module keeps, which the public claim "no MCP tool can sign or send" rests on:
//   (a) PAPER LEDGER ONLY. The only trade op is `executor.execute`, a `TradeExecutor` whose `kind` MUST be
//       'paper' (asserted at construction). This file imports NOTHING from the signer, the live executor, the
//       swap BUILD adapter, the rpc sender or the bridge — only the paper ledger (./paper.ts), the mandate
//       SCHEMA (../plans/mandate.ts), the audit journal, the panic kill-switch and the keyless quote TYPE. It
//       is therefore structurally unable to reach any live / wallet / signer / send path (enforced by the
//       no-sign registry test, task-1443).
//   (b) CAPS COME FROM THE USER-SET MANDATE. Every limit is read from the armed `Mandate`, RE-READ on every
//       call (in production: replayed from the hash-chained plans journal the app arms it in, so a revoke or a
//       panic in the app halts the agent at once); there is NO method that changes a cap. An agent runs at the most-restricted confirmation tier (`AGENT_TIER`), so
//       its per-trade cap is the mandate's per-trade cap times that tier's multiplier — it can never meet or
//       exceed a human keypress tier.
//   (c) EVERY CALL IS VALIDATED, JOURNALED AND HALTABLE. Before any state change the desk re-reads the control
//       surface (pause / take-over / stop) and the panic file and re-checks the mandate is alive; a refusal is
//       journaled too, so the spectator view and the audit log see it. The user always wins.
//
// task-1506 (AUTOTRADE AT-4, additive): the autotrade position monitor sells through `PaperExitDesk`, a subclass
// at the end of this file, so the MCP desk's own surface is unchanged.
//   P1  desk-side EXIT PLANS: an entry registers its exit plan (`agent.paper.exit.plan`), and every monitor sell
//       is an `exit()` journaled as `agent.paper.exit.<rule>` (cost-recovery, bag-trail, tp1, stop, …) before
//       its fill; a plan is done (`agent.paper.exit.done`) once the position is empty.
//   P2  a `close-only` control state: sells (exits) still run, even on an expired or revoked mandate, while every
//       buy is refused. A panic still halts everything.
//   P4  a `note` on fills (who, which plan, the exit rule, the agent's own reason), journaled with the fill.
// None of these raises a cap or adds a buy path: a note and a plan are journal data, an exit is a sell.

import type { Clock } from '../../clock.ts';
import { systemClock } from '../../clock.ts';
import type { Mandate } from '../plans/mandate.ts';
import { mandateAlive, TIERS } from '../plans/mandate.ts';
import type { TierName } from '../plans/mandate.ts';
import { KillSwitch } from '../kill-switch.ts';
import type { Journal } from '../plans/journal.ts';
import { capsHash } from '../plans/mandate.ts';
import {
  SOL_MINT, buildQuoteRequest, lamportsToSol, solToLamports, rawToTokens,
  type PaperOrder, type Position, type TradeExecutor, type TradeRecord,
} from '../../paper.ts';
import type { PaperWallet } from '../../paper.ts';
import type { QuoteRequest, SwapQuote } from '../../sources/jupiter-swap.ts';
import type { Side } from '../plans/types.ts';
import { buildFillTag, buildLateTag, type TagInput } from '../ledger/tags.ts';
import type { FillTag } from '../ledger/schema.ts';

/** The confirmation tier an agent is pinned to: the weakest, so an agent can never match a human keypress. */
export const AGENT_TIER: TierName = 'hands-free';

/**
 * The desk is halted whenever the control surface is not `running`, except `close-only` (task-1506 P2): sells
 * (exits) run and every buy is refused, so a halt or an expired mandate never traps an open position.
 */
export type DeskControlState = 'running' | 'paused' | 'stopped' | 'takeover' | 'close-only';
export interface DeskControl {
  state: DeskControlState;
  reason?: string;
}

/** A refusal from the desk. `reason` is a stable code; `message` is human text (both are journaled). */
export class PaperDeskError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = 'PaperDeskError';
    this.reason = reason;
  }
}

/** A quote fetcher: the keyless Jupiter swap-QUOTE (never the build/sign/send path). */
export type QuoteFn = (req: QuoteRequest, signal?: AbortSignal) => Promise<SwapQuote>;

/**
 * Bounded re-quote on a rate limit (task-1443 capture round 3). In a live run, a +25% TP1 sell was refused on
 * a keyless Jupiter 429 ("retry in 58s") and only filled a minute later, after the dump. The desk now waits
 * out a short rate limit itself and asks again for a FRESH quote, inside a hard budget. When the budget is
 * spent it refuses exactly as before. Every retry is journaled and reported (`onQuoteRetry`), so the screen
 * shows it. A retry never reuses an old quote and never invents a price: every fill is still booked from a
 * quote fetched in this call, through the same price-impact check, re-gate and executor match.
 */
export interface QuoteRetryPolicy {
  /** Total quote attempts per confirm/close, including the first. */
  maxAttempts: number;
  /** The longest single wait between attempts. A longer stated wait is cut to this; the next attempt is still a real quote. */
  maxWaitMs: number;
  /** Hard budget for the whole pricing step (waits plus attempts). An attempt still in flight at the budget is aborted. */
  maxTotalMs: number;
}
export const DEFAULT_QUOTE_RETRY: QuoteRetryPolicy = { maxAttempts: 4, maxWaitMs: 6_000, maxTotalMs: 25_000 };

/** What the desk reports before each re-quote (journaled as `agent.paper.quote-retry`, shown by the spectator). */
export interface QuoteRetryInfo {
  stage: string;
  mint: string;
  side: Side;
  /** The attempt about to run (2 = the first retry). */
  attempt: number;
  maxAttempts: number;
  waitMs: number;
  /** The failed attempt's rate-limit message, verbatim. */
  message: string;
}

/** A keyless rate limit (a 429, or the data layer's own 429 cool-down / bucket pause), which is worth a bounded re-quote. */
export function isRateLimitedQuoteError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if (e.name === 'JupiterRateLimitedError') return true;
  if (e.name === 'SourceUnavailableError') return /jupiter/.test(e.message);
  return e.name === 'HttpError' && (e as { status?: unknown }).status === 429;
}

export interface PaperAgentDeskDeps {
  /**
   * The armed mandate whose caps bound every agent paper trade. A function is re-read on EVERY call (null ⇒
   * refuse), so a revoke / expiry / panic in the app is seen at once; a plain object is for tests.
   */
  mandate: Mandate | (() => Mandate | null);
  /** The simulated paper wallet (node:sqlite), the single source of truth for positions and PnL. */
  wallet: PaperWallet;
  /** The paper executor. MUST be `kind: 'paper'` — a live executor is rejected at construction. */
  executor: TradeExecutor;
  /** Keyless swap-quote fetcher (quote only). */
  quote: QuoteFn;
  /** Current SOL/USD (USD per SOL) used to price the mandate's USD caps; null/≤0 ⇒ refuse (caps unpriceable). */
  solUsd: () => number | null;
  /** The control surface, re-read on every call: pause / take-over / stop halts the agent. */
  control: () => DeskControl;
  /** The hash-chained audit journal (every call and every refusal is appended). Only `append` is used. */
  journal: Pick<Journal, 'append'>;
  /** The global panic kill-switch (a `wallet panic` from any terminal halts the desk). */
  killSwitch?: KillSwitch;
  clock?: Clock;
  /** Label for the journal/spectator (never a real name). */
  agent?: string;
  /** Bounded re-quote on a rate limit (default `DEFAULT_QUOTE_RETRY`; `maxAttempts: 1` turns it off). */
  quoteRetry?: QuoteRetryPolicy;
  /** Called before each re-quote, so the spectator view can show the retry while the call is in flight. Its errors never reach the desk. */
  onQuoteRetry?: (info: QuoteRetryInfo) => void;
  /**
   * task-1530: the model session behind the calls, when the launcher names one (`DEXTERM_SESSION_ID`), journaled on
   * every fill so the trade ledger can join the session's cost. An id only; never a credential.
   */
  sessionId?: () => string | null;
}

/** task-1530: most `tag` calls per minute (a journal-only call, but still bounded). */
export const TAG_RATE_PER_MIN = 30;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,79}$/;

/** An in-flight ticket (ephemeral, in memory). A ticket is inert until `confirm`. */
export interface PaperTicket {
  id: string;
  mint: string;
  symbol: string;
  decimals: number;
  side: Side;
  /** For a buy: the intended size in USD. For a sell: the fraction of the held position in (0, 1]. */
  usd: number | null;
  fraction: number | null;
  openedAt: number;
}

/** A position row the read tools return (cost basis + realized; a live mark is layered on by the caller). */
export interface PaperPositionView {
  mint: string;
  symbol: string;
  decimals: number;
  tokens: number;
  costSol: number;
  realizedSol: number;
  avgEntrySol: number | null;
}

/** The paper PnL snapshot. All figures are SIMULATED; a caller must label them PAPER and never as a result. */
export interface PaperPnlView {
  paper: true;
  balanceSol: number;
  startSol: number;
  /** Lifetime realized PnL across all paper positions, SOL. */
  realizedSol: number;
  /** Cost basis currently deployed across open positions, SOL. */
  openCostSol: number;
  positions: PaperPositionView[];
  mandate: { id: string; capsHash: string; perTradeUsd: number; perCoinUsd: number; totalUsd: number; dailyLossUsd: number; maxOpenPositions: number; maxPriceImpactPct: number; expiresAt: number } | null;
}

const isFiniteNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/**
 * task-1506 P4: a short note carried on a fill (journal data only, never an instruction): a string, or a flat
 * object of strings / numbers / booleans / null. `sanitizeFillNote` caps it (16 keys, 200 chars per string, 400
 * for a bare string) and drops anything else, so a note can never smuggle a nested document into the journal.
 */
export type FillNote = string | Record<string, string | number | boolean | null>;
const NOTE_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,39}$/;
export function sanitizeFillNote(note: unknown): FillNote | undefined {
  if (typeof note === 'string') { const s = note.slice(0, 400); return s ? s : undefined; }
  if (!note || typeof note !== 'object' || Array.isArray(note)) return undefined;
  const out: Record<string, string | number | boolean | null> = {};
  let n = 0;
  for (const [k, v] of Object.entries(note as Record<string, unknown>)) {
    if (n >= 16) break;
    if (!NOTE_KEY.test(k)) continue;
    if (typeof v === 'string') out[k] = v.slice(0, 200);
    else if (isFiniteNum(v) || typeof v === 'boolean' || v === null) out[k] = v;
    else continue;
    n++;
  }
  return n ? out : undefined;
}

/** task-1506 P1: an exit plan registered on the desk for one held position (journal data; it moves no money). */
export interface ExitPlan {
  planId: string;
  mint: string;
  symbol: string;
  /** Who runs the exits (e.g. `autotrade-monitor`). */
  owner: string;
  positionId: string;
  profileId: string;
  runId: string | null;
  registeredAt: number;
  note?: FillNote;
}
export interface ExitPlanInput { mint: string; owner: string; positionId: string; profileId: string; runId?: string | null; note?: unknown; restored?: boolean }

/** Exit rule → journal slug (`time_review:no-answer` → `time-review-no-answer`). `plan` and `done` are reserved. */
export function exitRuleSlug(rule: string): string | null {
  const s = String(rule).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return s && s !== 'plan' && s !== 'done' ? s : null;
}

/**
 * The paper agent desk. One instance per armed mandate + paper wallet. All four verbs (open / size / confirm /
 * close) and both reads (positions / pnl) run here; nothing else is exposed, and there is no cap setter.
 */
export class PaperAgentDesk {
  private readonly mandateSrc: () => Mandate | null;
  /** The mandate the current call runs under (set by `gate`, which every mutating call runs first). */
  private mandate!: Mandate;
  protected readonly wallet: PaperWallet;
  protected readonly executor: TradeExecutor;
  private readonly quote: QuoteFn;
  private readonly solUsd: () => number | null;
  private readonly control: () => DeskControl;
  private readonly journal: Pick<Journal, 'append'>;
  private readonly kill: KillSwitch;
  protected readonly clock: Clock;
  private readonly agent: string;
  private readonly quoteRetry: QuoteRetryPolicy;
  private readonly onQuoteRetry: ((info: QuoteRetryInfo) => void) | null;
  private readonly sessionSrc: () => string | null;
  private tagTimes: number[] = [];
  private readonly tickets = new Map<string, PaperTicket>();
  protected ticketSeq = 0;

  constructor(deps: PaperAgentDeskDeps) {
    if (deps.executor.kind !== 'paper') {
      // The one invariant that makes the "no MCP tool can sign or send" claim true: the desk refuses to hold a
      // live executor. There is no code path from here to a signer, so a live executor is a programming error.
      throw new PaperDeskError('not-paper', `the paper agent desk only accepts a paper executor, got "${deps.executor.kind}"`);
    }
    const m = deps.mandate;
    this.mandateSrc = typeof m === 'function' ? m : () => m;
    this.wallet = deps.wallet;
    this.executor = deps.executor;
    this.quote = deps.quote;
    this.solUsd = deps.solUsd;
    this.control = deps.control;
    this.journal = deps.journal;
    this.kill = deps.killSwitch ?? new KillSwitch();
    this.clock = deps.clock ?? systemClock;
    this.agent = deps.agent ?? 'mcp-agent';
    const r = deps.quoteRetry ?? DEFAULT_QUOTE_RETRY;
    this.quoteRetry = { maxAttempts: Math.max(1, Math.floor(r.maxAttempts)), maxWaitMs: Math.max(0, r.maxWaitMs), maxTotalMs: Math.max(0, r.maxTotalMs) };
    this.onQuoteRetry = deps.onQuoteRetry ?? null;
    this.sessionSrc = deps.sessionId ?? (() => null);
  }

  /** The agent's effective per-trade cap: the mandate cap times the weakest-tier multiplier. */
  private perTradeCapUsd(): number {
    return this.mandate.budget.perTradeUsd * TIERS[AGENT_TIER].perTradeMultiplier;
  }

  /** Journal one audit event (kept out of the hot path's failure mode: never throws). */
  protected note(type: string, data: Record<string, unknown>): void {
    try { this.journal.append(type, { mandateId: this.mandate?.id ?? null, data: { agent: this.agent, ...data } }); } catch { /* audit is best-effort */ }
  }

  /** Refuse (journaling the refusal) — the one place a PaperDeskError is raised for a gate failure. */
  protected refuse(stage: string, reason: string, message: string, extra: Record<string, unknown> = {}): never {
    this.note('agent.paper.refused', { stage, reason, message, ...extra });
    throw new PaperDeskError(reason, message);
  }

  /**
   * The gate every mutating call runs first: panic file → control surface → mandate alive. A failure here is
   * journaled and throws, so a paused / taken-over / stopped session (or a dead mandate) halts the agent.
   */
  protected gate(stage: string, extra: Record<string, unknown> = {}, side?: Side): void {
    const panic = this.kill.engaged();
    if (panic) this.refuse(stage, 'panic', `trading is halted (panic): ${panic.reason}`, extra);
    const c = this.control();
    // close-only (task-1506 P2): a sell passes the control surface and a dead mandate; a buy never does.
    const exitOnly = c.state === 'close-only' && side === 'sell';
    if (c.state !== 'running' && !exitOnly) {
      const msg = c.state === 'takeover' ? 'the user has taken over — agent paper trading is paused'
        : c.state === 'paused' ? `agent paper trading is paused${c.reason ? `: ${c.reason}` : ''}`
        : c.state === 'close-only' ? `agent paper trading is close-only${c.reason ? `: ${c.reason}` : ''}; exits run, new buys are refused`
        : `agent paper trading is stopped${c.reason ? `: ${c.reason}` : ''}`;
      this.refuse(stage, c.state, msg, extra);
    }
    const m = this.mandateSrc();
    if (!m) this.refuse(stage, 'no-mandate', 'no armed mandate is available for agent paper trading', extra);
    this.mandate = m!;
    const alive = mandateAlive(this.mandate, this.clock.now());
    if (!alive.ok && !exitOnly) this.refuse(stage, alive.reason, `the mandate is not usable (${alive.reason})`, extra);
  }

  protected requireAction(stage: string, side: Side, extra: Record<string, unknown> = {}): void {
    if (!this.mandate.allowed.actions.includes(side)) {
      this.refuse(stage, 'action-not-allowed', `${side} is not permitted by the mandate`, extra);
    }
  }

  protected requireMintAllowed(stage: string, mint: string, extra: Record<string, unknown> = {}): void {
    if (this.mandate.allowed.mints && !this.mandate.allowed.mints.includes(mint)) {
      this.refuse(stage, 'mint-not-allowed', 'this mint is not on the mandate allow-list', extra);
    }
  }

  private price(stage: string, extra: Record<string, unknown> = {}): number {
    const p = this.solUsd();
    if (!isFiniteNum(p) || p <= 0) this.refuse(stage, 'no-usd-price', 'no fresh SOL/USD price — cannot price the mandate caps', extra);
    return p as number;
  }

  // ── USD exposure derived from the paper wallet (source of truth), so caps survive a restart ──
  private costUsd(pos: Position | undefined, solUsd: number): number {
    return pos ? lamportsToSol(pos.costLamports) * solUsd : 0;
  }
  private openCostUsd(solUsd: number): number {
    return this.wallet.positions().reduce((s, p) => s + lamportsToSol(p.costLamports) * solUsd, 0);
  }
  /** Realized LOSS (USD, positive) booked since the mandate was armed. Over the whole paper wallet. */
  private realizedLossUsd(solUsd: number): number {
    const since = this.mandate.armedAt ?? this.mandate.createdAt;
    let lamports = 0n;
    for (const t of this.wallet.trades(1000)) {
      if (t.t < since) continue;
      if (t.realizedLamports < 0n) lamports += -t.realizedLamports;
    }
    return lamportsToSol(lamports) * solUsd;
  }

  /** Check the buy caps for `usd`, throwing a cap-named refusal on any breach. */
  private admitBuy(stage: string, mint: string, usd: number, solUsd: number, extra: Record<string, unknown>): void {
    const perTrade = this.perTradeCapUsd();
    if (usd > perTrade + 1e-9) this.refuse(stage, 'per-trade-cap', `$${usd.toFixed(2)} exceeds the agent per-trade cap $${perTrade.toFixed(2)}`, extra);
    const coin = this.costUsd(this.wallet.position(mint), solUsd);
    if (coin + usd > this.mandate.budget.perCoinUsd + 1e-9) {
      this.refuse(stage, 'per-coin-cap', `$${(coin + usd).toFixed(2)} on this coin exceeds the per-coin cap $${this.mandate.budget.perCoinUsd.toFixed(2)}`, extra);
    }
    const total = this.openCostUsd(solUsd);
    if (total + usd > this.mandate.budget.totalUsd + 1e-9) {
      this.refuse(stage, 'total-cap', `$${(total + usd).toFixed(2)} deployed exceeds the total budget $${this.mandate.budget.totalUsd.toFixed(2)}`, extra);
    }
    const held = this.wallet.positions().filter((p) => p.tokensRaw > 0n);
    if (!held.some((p) => p.mint === mint) && held.length >= this.mandate.limits.maxOpenPositions) {
      this.refuse(stage, 'open-positions-cap', `${held.length} open paper positions reached the mandate limit ${this.mandate.limits.maxOpenPositions}`, extra);
    }
    const loss = this.realizedLossUsd(solUsd);
    if (loss >= this.mandate.budget.dailyLossUsd - 1e-9) {
      this.refuse(stage, 'daily-loss-limit', `realized loss $${loss.toFixed(2)} has reached the daily loss limit $${this.mandate.budget.dailyLossUsd.toFixed(2)}; no new buys`, extra);
    }
  }

  // ───────────────────────────── the four verbs ─────────────────────────────

  /** Open an inert PAPER ticket for a mint + side. Validates the gate, the action and the allow-list only. */
  open(input: { mint: string; symbol: string; decimals: number; side: Side }): PaperTicket {
    const side = input.side;
    this.gate('open', { mint: input.mint, side }, side);
    if (typeof input.mint !== 'string' || input.mint.length < 32) this.refuse('open', 'bad-request', 'a base58 mint is required');
    if (!isFiniteNum(input.decimals) || input.decimals < 0 || input.decimals > 18) this.refuse('open', 'bad-request', 'token decimals (0..18) are required');
    this.requireAction('open', side, { mint: input.mint });
    this.requireMintAllowed('open', input.mint, { side });
    const t: PaperTicket = {
      id: `pt_${++this.ticketSeq}_${this.clock.now().toString(36)}`,
      mint: input.mint, symbol: input.symbol, decimals: input.decimals, side, usd: null, fraction: null, openedAt: this.clock.now(),
    };
    this.tickets.set(t.id, t);
    this.note('agent.paper.open', { ticketId: t.id, mint: t.mint, symbol: t.symbol, side });
    return { ...t };
  }

  /** Size a ticket. Buy: `usd` (checked against the caps, never raised). Sell: `fraction` in (0, 1]. */
  size(ticketId: string, input: { usd?: number; fraction?: number }): PaperTicket {
    const t = this.tickets.get(ticketId);
    if (!t) this.refuse('size', 'unknown-ticket', 'no such open ticket');
    this.gate('size', { ticketId }, t!.side);
    if (t!.side === 'buy') {
      const usd = input.usd;
      if (!isFiniteNum(usd) || usd <= 0) this.refuse('size', 'bad-request', 'a positive USD size is required for a buy', { ticketId });
      const solUsd = this.price('size', { ticketId });
      this.admitBuy('size', t!.mint, usd as number, solUsd, { ticketId });
      t!.usd = usd as number;
      t!.fraction = null;
    } else {
      const frac = input.fraction;
      if (!isFiniteNum(frac) || !(frac > 0 && frac <= 1)) this.refuse('size', 'bad-request', 'a sell fraction in (0, 1] is required', { ticketId });
      t!.fraction = frac as number;
      t!.usd = null;
    }
    this.note('agent.paper.size', { ticketId, side: t!.side, usd: t!.usd, fraction: t!.fraction });
    return { ...t! };
  }

  /** Confirm a sized ticket: re-check the gate and the caps, fetch a FRESH quote, book the PAPER fill. */
  async confirm(ticketId: string, opts: { note?: unknown; tag?: TagInput | null } = {}): Promise<{ fill: TradeRecord; position: PaperPositionView | null; quoteAttempts: number; tag: FillTag | null }> {
    const t = this.tickets.get(ticketId);
    if (!t) this.refuse('confirm', 'unknown-ticket', 'no such open ticket');
    this.gate('confirm', { ticketId }, t!.side);
    this.requireAction('confirm', t!.side, { ticketId });
    this.requireMintAllowed('confirm', t!.mint, { ticketId });
    const order = await this.buildOrder('confirm', t!);
    const tag = buildFillTag(t!.side, opts.tag);
    const { rec, quoteAttempts } = await this.book('confirm', order, { ticketId }, sanitizeFillNote(opts.note), tag);
    this.tickets.delete(ticketId);
    return { fill: rec, position: this.positionView(this.wallet.position(t!.mint)), quoteAttempts, tag };
  }

  /** Close a fraction of a held PAPER position in one call (open sell → size fraction → confirm). */
  async close(input: { mint: string; fraction?: number; note?: unknown; tag?: TagInput | null }): Promise<{ fill: TradeRecord; position: PaperPositionView | null; quoteAttempts: number; tag: FillTag | null }> {
    this.gate('close', { mint: input.mint }, 'sell');
    this.requireAction('close', 'sell', { mint: input.mint });
    this.requireMintAllowed('close', input.mint, {});
    const pos = this.wallet.position(input.mint);
    if (!pos || pos.tokensRaw <= 0n) this.refuse('close', 'no-position', 'no open paper position in this mint to close', { mint: input.mint });
    const fraction = input.fraction ?? 1;
    if (!isFiniteNum(fraction) || !(fraction > 0 && fraction <= 1)) this.refuse('close', 'bad-request', 'fraction must be in (0, 1]', { mint: input.mint });
    const t: PaperTicket = { id: `pt_close_${++this.ticketSeq}`, mint: input.mint, symbol: pos!.symbol, decimals: pos!.decimals, side: 'sell', usd: null, fraction, openedAt: this.clock.now() };
    this.note('agent.paper.close', { mint: input.mint, fraction });
    const order = await this.buildOrder('close', t);
    const tag = buildFillTag('sell', input.tag);
    const { rec, quoteAttempts } = await this.book('close', order, { mint: input.mint }, sanitizeFillNote(input.note), tag);
    return { fill: rec, position: this.positionView(this.wallet.position(input.mint)), quoteAttempts, tag };
  }

  /** Build the paper order from a ticket, re-checking the buy caps against the live wallet at execute time. */
  protected async buildOrder(stage: string, t: PaperTicket): Promise<PaperOrder> {
    if (t.side === 'buy') {
      if (!isFiniteNum(t.usd) || t.usd <= 0) this.refuse(stage, 'not-sized', 'the ticket has no size — call size first', { ticketId: t.id });
      const solUsd = this.price(stage, { ticketId: t.id });
      this.admitBuy(stage, t.mint, t.usd as number, solUsd, { ticketId: t.id });
      const amountRaw = solToLamports((t.usd as number) / solUsd);
      if (amountRaw <= 0n) this.refuse(stage, 'bad-request', 'the sized amount rounds to zero lamports', { ticketId: t.id });
      return { mint: t.mint, symbol: t.symbol, side: 'buy', decimals: t.decimals, amountRaw, slippageBps: this.mandate.limits.maxSlippageBps };
    }
    const pos = this.wallet.position(t.mint);
    if (!pos || pos.tokensRaw <= 0n) this.refuse(stage, 'no-position', 'no paper tokens to sell', { ticketId: t.id });
    const frac = t.fraction ?? 1;
    let amountRaw = BigInt(Math.round(Number(pos!.tokensRaw) * frac));
    if (amountRaw > pos!.tokensRaw) amountRaw = pos!.tokensRaw;
    if (amountRaw <= 0n) this.refuse(stage, 'bad-request', 'the sell fraction rounds to zero tokens', { ticketId: t.id });
    return { mint: t.mint, symbol: pos!.symbol, side: 'sell', decimals: pos!.decimals, amountRaw, slippageBps: this.mandate.limits.maxSlippageBps };
  }

  /**
   * Fetch a FRESH quote for this call. A short rate limit is re-quoted inside the bounded `quoteRetry` budget:
   * each retry is journaled and reported first, waits min(stated wait, maxWaitMs), then re-runs the gate, so a
   * pause during the wait still halts the agent. Any other error, the last allowed attempt, or the spent budget
   * (an attempt still in flight is aborted) refuses with the verbatim message. No quote outlives the call.
   */
  protected async freshQuote(stage: string, order: PaperOrder, extra: Record<string, unknown>): Promise<{ quote: SwapQuote; attempts: number }> {
    const { maxAttempts, maxWaitMs, maxTotalMs } = this.quoteRetry;
    const started = this.clock.now();
    let lastRateLimit: string | null = null;
    for (let attempt = 1; ; attempt++) {
      const budget = new AbortController();
      const disarm = new AbortController();
      void this.clock.sleep(Math.max(1, maxTotalMs - (this.clock.now() - started)), disarm.signal)
        .then(() => { if (!disarm.signal.aborted) budget.abort(); });
      let quote: SwapQuote | null = null;
      let failure: unknown = null;
      try { quote = await this.quote(buildQuoteRequest(order), budget.signal); } catch (e) { failure = e; } finally { disarm.abort(); }
      if (quote && !budget.signal.aborted) return { quote, attempts: attempt };
      const msg = failure instanceof Error ? failure.message : failure === null ? 'no quote' : String(failure);
      const elapsed = this.clock.now() - started;
      const tried = attempt > 1 ? ` (${attempt} quote attempts in ${Math.round(elapsed / 1000)}s)` : '';
      if (budget.signal.aborted) {
        this.refuse(stage, 'quote-failed', `could not price the trade within ${Math.round(maxTotalMs / 1000)}s${lastRateLimit ? `: ${lastRateLimit}` : ''}${tried}`, { ...extra, quoteAttempts: attempt });
      }
      if (!isRateLimitedQuoteError(failure)) this.refuse(stage, 'quote-failed', `could not price the trade: ${msg}${tried}`, { ...extra, quoteAttempts: attempt });
      lastRateLimit = msg;
      const stated = (failure as { retryAfterMs?: unknown }).retryAfterMs;
      const wait = Math.min(maxWaitMs, Math.max(1_000, typeof stated === 'number' && Number.isFinite(stated) ? stated : 2_000 * attempt));
      if (attempt >= maxAttempts || elapsed + wait >= maxTotalMs) {
        this.refuse(stage, 'quote-failed', `could not price the trade: ${msg}${tried}`, { ...extra, quoteAttempts: attempt });
      }
      const info: QuoteRetryInfo = { stage, mint: order.mint, side: order.side, attempt: attempt + 1, maxAttempts, waitMs: wait, message: msg };
      this.note('agent.paper.quote-retry', { ...extra, ...info });
      try { this.onQuoteRetry?.(info); } catch { /* the spectator is best-effort */ }
      await this.clock.sleep(wait);
      this.gate(stage, extra, order.side);
    }
  }

  /** Fetch a fresh quote and book the fill through the PAPER executor; journal the booked fill. */
  protected async book(stage: string, order: PaperOrder, extra: Record<string, unknown>, note?: FillNote, tag?: FillTag | null): Promise<{ rec: TradeRecord; quoteAttempts: number }> {
    const { quote, attempts } = await this.freshQuote(stage, order, extra);
    if (attempts > 1) extra = { ...extra, quoteAttempts: attempts };
    // Buys honour the mandate's price-impact ceiling (SwapQuote.priceImpactPct is already a PERCENT — the source
    // converts Jupiter's 0..1 fraction once). Exits are never trapped by it, like the plan engine's stop leg.
    if (order.side === 'buy' && isFiniteNum(quote!.priceImpactPct) && quote!.priceImpactPct > this.mandate.limits.maxPriceImpactPct + 1e-9) {
      this.refuse(stage, 'price-impact', `price impact ${quote!.priceImpactPct.toFixed(2)}% exceeds the mandate max ${this.mandate.limits.maxPriceImpactPct}%`, extra);
    }
    // The control surface may have flipped while the quote was in flight: re-check right before booking.
    this.gate(stage, extra, order.side);
    // task-1530: the book (cash + open cost) just before this fill, for the trade ledger's % of book
    const bookLamports = this.bookLamports();
    let rec: TradeRecord;
    try { rec = await this.executor.execute(order, quote!); }
    catch (e) { this.refuse(stage, 'fill-failed', e instanceof Error ? e.message : String(e), extra); }
    this.note('agent.paper.fill', {
      ...extra, mint: rec!.mint, symbol: rec!.symbol, side: rec!.side, paper: true,
      solDelta: rec!.solDelta.toString(), tokenDelta: rec!.tokenDelta.toString(),
      priceSol: rec!.priceSol, priceUsd: rec!.priceUsd, realizedLamports: rec!.realizedLamports.toString(), fillId: rec!.id,
      ...(note !== undefined ? { note } : {}),
      // task-1530: the facts the unified trade ledger needs, journaled with the fill (older journals lack them; the
      // ledger then joins them from the paper wallet's own table)
      decimals: rec!.decimals, feeLamports: rec!.feeLamports.toString(), impactPct: rec!.priceImpactPct, slippageBps: rec!.slippageBps,
      ...(bookLamports !== null ? { bookLamports: bookLamports.toString() } : {}),
      ...(tag ? { tag } : {}),
      ...(this.sessionId() ? { sessionId: this.sessionId() } : {}),
    });
    return { rec: rec!, quoteAttempts: attempts };
  }

  /** The model session id the launcher named, if it is a plain id. */
  private sessionId(): string | null {
    let s: string | null = null;
    try { s = this.sessionSrc(); } catch { s = null; }
    return typeof s === 'string' && SESSION_ID.test(s) ? s : null;
  }

  /** Paper cash + the cost basis of every open position, lamports (null when the wallet cannot be read). */
  private bookLamports(): bigint | null {
    try { return this.wallet.balance() + this.wallet.positions().reduce((a, p) => a + (p.tokensRaw > 0n ? p.costLamports : 0n), 0n); } catch { return null; }
  }

  /**
   * task-1530: declare a PROFILE, REPROFILE or EXIT for a coin this desk traded, apart from its fill (a REPROFILE,
   * or a line that was not passed with the fill: journaled `agent.paper.tag`, which the trade ledger reads as a
   * late declaration). Journal-only: it books nothing, moves no money and works while trading is paused or stopped
   * (a reason can always be recorded). The coin must be one the paper wallet holds or has held.
   */
  tag(input: { mint: string; kind?: unknown; profile?: unknown; from?: unknown; to?: unknown; exitReason?: unknown; reason?: unknown; line?: unknown }): { recorded: true; mint: string; tagKind: string; declared: Record<string, string | null> } {
    const now = this.clock.now();
    this.tagTimes = this.tagTimes.filter((t) => now - t < 60_000);
    if (this.tagTimes.length >= TAG_RATE_PER_MIN) throw new PaperDeskError('rate-limited', `at most ${TAG_RATE_PER_MIN} tags a minute`);
    if (typeof input.mint !== 'string' || !this.wallet.position(input.mint)) throw new PaperDeskError('no-position', 'tag a coin the paper wallet holds or has traded (pass its mint)');
    const g = buildLateTag(input);
    if (!g.ok) throw new PaperDeskError('bad-request', g.why);
    if (g.tagKind === 'reprofile') {
      const pos = this.wallet.position(input.mint);
      if (!pos || pos.tokensRaw <= 0n) throw new PaperDeskError('no-position', 'a REPROFILE needs a position that is still held');
    }
    this.tagTimes.push(now);
    const declared: Record<string, string | null> = g.tagKind === 'profile' ? { profile: g.profile, reason: g.reason }
      : g.tagKind === 'reprofile' ? { from: g.from, to: g.to, reason: g.reason } : { exitReason: g.exitReason, reason: g.reason };
    this.note('agent.paper.tag', { mint: input.mint, tagKind: g.tagKind, ...declared, ...(g.line ? { line: g.line } : {}), ...(this.sessionId() ? { sessionId: this.sessionId() } : {}) });
    return { recorded: true, mint: input.mint, tagKind: g.tagKind, declared };
  }

  // ───────────────────────────── the two reads ─────────────────────────────

  protected positionView(pos: Position | undefined): PaperPositionView | null {
    if (!pos) return null;
    const tokens = rawToTokens(pos.tokensRaw, pos.decimals);
    const costSol = lamportsToSol(pos.costLamports);
    return {
      mint: pos.mint, symbol: pos.symbol, decimals: pos.decimals, tokens,
      costSol, realizedSol: lamportsToSol(pos.realizedLamports),
      avgEntrySol: tokens > 0 ? costSol / tokens : null,
    };
  }

  /** Read paper positions (cost basis + realized; the caller may layer a live mark). Read-only. */
  positions(): PaperPositionView[] {
    return this.wallet.positions().map((p) => this.positionView(p)!).filter(Boolean);
  }

  /** Read the paper PnL snapshot (balance, realized, open cost, per-position). Read-only, always PAPER. */
  pnl(): PaperPnlView {
    const s = this.wallet.summary();
    const m = this.mandateSrc();
    const positions = this.positions();
    const realizedSol = positions.reduce((a, p) => a + p.realizedSol, 0);
    const openCostSol = positions.reduce((a, p) => a + p.costSol, 0);
    return {
      paper: true,
      balanceSol: lamportsToSol(s.balanceLamports),
      startSol: lamportsToSol(s.startLamports),
      realizedSol,
      openCostSol,
      positions,
      mandate: m ? {
        id: m.id, capsHash: capsHash(m), perTradeUsd: m.budget.perTradeUsd * TIERS[AGENT_TIER].perTradeMultiplier, perCoinUsd: m.budget.perCoinUsd,
        totalUsd: m.budget.totalUsd, dailyLossUsd: m.budget.dailyLossUsd, maxOpenPositions: m.limits.maxOpenPositions,
        maxPriceImpactPct: m.limits.maxPriceImpactPct, expiresAt: m.expiresAt,
      } : null,
    };
  }
}

/**
 * task-1506 P1: the paper desk the autotrade monitor sells through. It is the same desk (every gate, cap, quote,
 * journal and the paper executor), plus exit plans and rule-named exits. It is a separate class on purpose: the
 * MCP paper tools hold a plain PaperAgentDesk, whose surface stays exactly the six reviewed verbs.
 */
export class PaperExitDesk extends PaperAgentDesk {
  /** Exit plans by mint (one held position per mint in the paper wallet). */
  private readonly plans = new Map<string, ExitPlan>();

  override async confirm(ticketId: string, opts: { note?: unknown; tag?: TagInput | null } = {}): Promise<{ fill: TradeRecord; position: PaperPositionView | null; quoteAttempts: number; tag: FillTag | null }> {
    const r = await super.confirm(ticketId, opts);
    if (r.fill.side === 'sell') this.planDoneIfEmpty(r.fill.mint, 'confirm');
    return r;
  }

  override async close(input: { mint: string; fraction?: number; note?: unknown; tag?: TagInput | null }): Promise<{ fill: TradeRecord; position: PaperPositionView | null; quoteAttempts: number; tag: FillTag | null }> {
    const r = await super.close(input);
    this.planDoneIfEmpty(input.mint, 'close');
    return r;
  }

  /**
   * Register the exit plan for a held position (P1). Journal data only: it needs a held paper position and moves
   * no money, so it runs in every control state (a restart re-registers its plans, journaled `restored: true`).
   * Registering the same position again returns the existing plan.
   */
  registerExitPlan(input: ExitPlanInput): ExitPlan {
    const pos = this.wallet.position(input.mint);
    if (!pos || pos.tokensRaw <= 0n) this.refuse('exit-plan', 'no-position', 'no open paper position in this mint to plan exits for', { mint: input.mint });
    const ok = (v: unknown, n: number) => typeof v === 'string' && v.length > 0 && v.length <= n;
    if (!ok(input.owner, 40) || !ok(input.positionId, 80) || !ok(input.profileId, 64)) this.refuse('exit-plan', 'bad-request', 'an exit plan needs an owner, a position id and a profile id', { mint: input.mint });
    const have = this.plans.get(input.mint);
    if (have && have.positionId === input.positionId) return { ...have };
    const note = sanitizeFillNote(input.note);
    const plan: ExitPlan = {
      planId: `xp_${++this.ticketSeq}_${this.clock.now().toString(36)}`, mint: input.mint, symbol: pos!.symbol, owner: input.owner,
      positionId: input.positionId, profileId: input.profileId, runId: input.runId ?? null, registeredAt: this.clock.now(), ...(note ? { note } : {}),
    };
    this.plans.set(input.mint, plan);
    this.note('agent.paper.exit.plan', { ...plan, ...(input.restored === true ? { restored: true } : {}) });
    return { ...plan };
  }

  /** The registered exit plans (read-only copies). */
  exitPlans(): ExitPlan[] { return [...this.plans.values()].map((p) => ({ ...p })); }

  /**
   * Sell a fraction of a planned position as one exit rule (P1): journaled `agent.paper.exit.<rule>` before the
   * fill, the fill carries the note, and the plan is done once the position is empty. Runs in `close-only`.
   */
  async exit(input: { mint: string; fraction?: number; rule: string; detail?: string; note?: unknown }): Promise<{ fill: TradeRecord; position: PaperPositionView | null; quoteAttempts: number; plan: ExitPlan; rule: string }> {
    const rule = exitRuleSlug(input.rule);
    this.gate('exit', { mint: input.mint }, 'sell');
    if (!rule) this.refuse('exit', 'bad-request', 'an exit needs a rule name', { mint: input.mint });
    const plan = this.plans.get(input.mint);
    if (!plan) this.refuse('exit', 'no-exit-plan', 'no exit plan is registered for this mint', { mint: input.mint, rule });
    this.requireAction('exit', 'sell', { mint: input.mint });
    this.requireMintAllowed('exit', input.mint, {});
    const pos = this.wallet.position(input.mint);
    if (!pos || pos.tokensRaw <= 0n) this.refuse('exit', 'no-position', 'no open paper position in this mint to exit', { mint: input.mint, rule });
    const fraction = input.fraction ?? 1;
    if (!isFiniteNum(fraction) || !(fraction > 0 && fraction <= 1)) this.refuse('exit', 'bad-request', 'fraction must be in (0, 1]', { mint: input.mint, rule });
    const t: PaperTicket = { id: `pt_exit_${++this.ticketSeq}`, mint: input.mint, symbol: pos!.symbol, decimals: pos!.decimals, side: 'sell', usd: null, fraction, openedAt: this.clock.now() };
    this.note(`agent.paper.exit.${rule!}`, { planId: plan!.planId, positionId: plan!.positionId, mint: input.mint, fraction, ...(input.detail ? { detail: String(input.detail).slice(0, 200) } : {}) });
    const order = await this.buildOrder('exit', t);
    const base = sanitizeFillNote(input.note);
    const note = { ...(typeof base === 'object' ? base : base ? { text: base } : {}), exit: rule!, planId: plan!.planId, positionId: plan!.positionId };
    const { rec, quoteAttempts } = await this.book('exit', order, { mint: input.mint, rule }, sanitizeFillNote(note));
    this.planDoneIfEmpty(input.mint, rule!);
    return { fill: rec, position: this.positionView(this.wallet.position(input.mint)), quoteAttempts, plan: { ...plan! }, rule: rule! };
  }

  /**
   * A read-only sell QUOTE for a fraction of a held position (what an exit would net, after the simulated fee),
   * for sizing a cost-recovery slice (task-1506). It books nothing and journals only a refusal.
   */
  async previewSell(input: { mint: string; fraction: number }): Promise<{ amountRaw: bigint; solOut: number; priceImpactPct: number | null }> {
    this.gate('preview', { mint: input.mint }, 'sell');
    const pos = this.wallet.position(input.mint);
    if (!pos || pos.tokensRaw <= 0n) this.refuse('preview', 'no-position', 'no open paper position in this mint', { mint: input.mint });
    const fraction = input.fraction;
    if (!isFiniteNum(fraction) || !(fraction > 0 && fraction <= 1)) this.refuse('preview', 'bad-request', 'fraction must be in (0, 1]', { mint: input.mint });
    const t: PaperTicket = { id: `pt_preview_${++this.ticketSeq}`, mint: input.mint, symbol: pos!.symbol, decimals: pos!.decimals, side: 'sell', usd: null, fraction, openedAt: this.clock.now() };
    const order = await this.buildOrder('preview', t);
    const { quote } = await this.freshQuote('preview', order, { mint: input.mint });
    const f = this.executor.previewFill(order, quote);
    return { amountRaw: order.amountRaw, solOut: lamportsToSol(f.solDelta > 0n ? f.solDelta : 0n), priceImpactPct: f.priceImpactPct };
  }

  /** Once a planned position is empty its plan is done (journaled once). */
  private planDoneIfEmpty(mint: string, by: string): void {
    const plan = this.plans.get(mint);
    if (!plan) return;
    const pos = this.wallet.position(mint);
    if (pos && pos.tokensRaw > 0n) return;
    this.plans.delete(mint);
    this.note('agent.paper.exit.done', { planId: plan.planId, positionId: plan.positionId, mint, by });
  }
}

export { SOL_MINT };
