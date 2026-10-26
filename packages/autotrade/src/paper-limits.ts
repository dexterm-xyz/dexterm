// dexterm autotrade — the limits on a PAPER run (task-1654, 0.2.0 card E): the `paper` scope of limits.json.
//
// Paper ignores the limits unless the user adds a `modes.paper` scope; then a paper run (a forward test) obeys the
// same guard a real run does (limits.ts checkBuy / checkSell / recordSell), so it shows what real mode would have
// refused or clamped. The state is the run's own (in memory): paper never touches real mode's risk.json, held.json
// or counters. No signal, no executor, no network: it only wraps the paper fill model.

import type { Fill } from './engine.ts';
import type { MarketTick } from './replay.ts';
import type { Executor, OrderContext } from './runner.ts';
import { checkBuy, checkSell, freshRiskState, recordBuy, recordSell, type EffectiveLimits, type RiskState } from './limits.ts';
import { localDay } from './chat/audit.ts';

interface PaperHolding { tokens: number; costUsd: number; costOutUsd: number; realizedUsd: number }

export class PaperLimitsExecutor implements Executor {
  readonly name: string;
  private readonly inner: Executor;
  private readonly L: EffectiveLimits['values'];
  private readonly solUsd: () => number | null;
  private readonly bookUsd: () => number;
  private readonly onTrip: (line: string) => void;
  private risk: RiskState | null = null;
  private readonly held = new Map<string, PaperHolding>();

  constructor(o: { inner: Executor; limits: EffectiveLimits['values']; solUsd: () => number | null; bookUsd: () => number; onTrip?: (line: string) => void }) {
    this.inner = o.inner;
    this.L = o.limits;
    this.solUsd = o.solUsd;
    this.bookUsd = o.bookUsd;
    this.onTrip = o.onTrip ?? (() => {});
    this.name = `paper-limits(${o.inner.name})`;
  }

  /** The run's own state, rolled at local midnight of the tick clock (a replay keeps its days). */
  private state(t: number): RiskState {
    const day = localDay(t);
    if (!this.risk) this.risk = freshRiskState(day);
    else if (this.risk.day !== day) this.risk = { ...this.risk, day, buys: 0, buySol: 0, perCoin: {}, dayPnlSol: 0 };
    this.risk.recentBuys = this.risk.recentBuys.filter((x) => t - x < 60_000);
    this.risk.recentSells = this.risk.recentSells.filter((x) => t - x < 60_000);
    return this.risk;
  }

  /** The maxHoldMinutes limit for the runner (RunOpts.maxHoldMinutes), or null. */
  maxHoldMinutes(): number | null { return this.L.maxHoldMinutes ?? null; }

  async buy(k: MarketTick, usd: number, ctx?: OrderContext): Promise<Fill | { refused: string }> {
    const solUsd = this.solUsd();
    if (!solUsd || !(solUsd > 0)) return { refused: 'paper-limits-sol-price-unknown' };
    const s = this.state(k.t);
    const prior = this.held.get(k.mint);
    if (!prior && this.L.maxOpenPositions !== undefined && this.held.size >= this.L.maxOpenPositions) return { refused: 'paper-limit-max-open' };
    const openCostUsd = [...this.held.values()].reduce((a, h) => a + Math.max(0, h.costUsd - h.costOutUsd), 0);
    const v = checkBuy(this.L, s, { now: k.t, solUsd, usd, bookUsd: this.bookUsd(), mint: k.mint, liqUsd: k.liq, mcapUsd: k.mcapResolved ?? k.mcap, positionCostUsd: prior ? Math.max(0, prior.costUsd - prior.costOutUsd) : 0, openCostUsd });
    if (!v.ok) return { refused: v.refused.replace(/^real-/, 'paper-limit-') };
    const f = await this.inner.buy(k, v.usd, ctx);
    if ('refused' in f) return f;
    recordBuy(s, k.mint, f.usd / solUsd, k.t);
    const h = this.held.get(k.mint) ?? { tokens: 0, costUsd: 0, costOutUsd: 0, realizedUsd: 0 };
    h.tokens += f.tokens; h.costUsd += f.usd;
    this.held.set(k.mint, h);
    return v.clamps.length ? ({ ...f, limitClamps: v.clamps } as Fill) : f;
  }

  async sell(k: MarketTick, tokens: number, reason: string): Promise<Fill | { refused: string }> {
    const s = this.state(k.t);
    const cs = checkSell(this.L, s, k.t);
    if (!cs.ok) return { refused: cs.refused.replace(/^real-/, 'paper-limit-') };
    const f = await this.inner.sell(k, tokens, reason);
    if ('refused' in f) return f;
    const solUsd = this.solUsd() ?? 0;
    const h = this.held.get(k.mint);
    if (h && solUsd > 0) {
      const frac = h.tokens > 0 ? Math.min(1, f.tokens / h.tokens) : 1;
      const portion = Math.max(0, h.costUsd - h.costOutUsd) * frac;
      h.tokens -= f.tokens; h.costOutUsd += portion; h.realizedUsd += Math.max(0, f.usd);
      const closed = h.tokens <= 1e-12 || frac >= 0.999;
      for (const line of recordSell(this.L, s, { pnlSol: (Math.max(0, f.usd) - portion) / solUsd, closedPnlSol: closed ? (h.realizedUsd - h.costUsd) / solUsd : null, now: k.t })) this.onTrip(`PAPER LIMIT: ${line}`);
      if (closed) this.held.delete(k.mint);
    } else if (h && (h.tokens - f.tokens <= 1e-12)) this.held.delete(k.mint);
    return f;
  }
}
