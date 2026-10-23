// dexterm autotrade — the position monitor (task-1498 spike, AUTOTRADE-SPEC §5).
//
// No LLM in this loop. On every tick of a held coin it applies the exit profile's mechanical rules at once
// (rug / liquidity pull, thesis breaks, hard stop, take-profit ladder, trailing stop, time stop, ladder adds)
// and only then raises WAKE events for the judgement calls the profile hands to the position's agent session
// (a TP filled, a time review, a drawdown alert, an early thesis warning, a mechanical exit that already
// happened). The session can answer within bounds (hold / exit / tighten / re-profile); it can never block
// or undo a mechanical exit, and if it does not answer the mechanical rules simply keep running.

import { splitX, type Position } from './engine.ts';
import type { MarketTick } from './replay.ts';
import type { ExitProfile } from './strategy.ts';

export type WakeKind = 'tp_filled' | 'cost_recovered' | 'time_review' | 'time_tighten' | 'drawdown' | 'thesis_warning' | 'mechanical_exit' | 'stuck';

export interface WakeEvent {
  event: WakeKind;
  positionId: string;
  mint: string;
  t: number;
  detail: string;
  /** What the session may answer with for this event (the clamp refuses anything else). */
  allowed: ('hold' | 'exit' | 'tighten' | 'reprofile')[];
}

export type MonitorAction =
  | { kind: 'sell'; tokens: number; all: boolean; reason: string; detail: string }
  | { kind: 'add'; index: number; usd: number; detail: string }
  | { kind: 'wake'; wake: WakeEvent };

export const pnlPct = (p: Position, price: number) => ((price - p.entryPrice) / p.entryPrice) * 100;

/** The data layer's agreement ratio (@dexterm/data MCAP_AGREE_RATIO; equal by test, kept local so the engine stays pure). */
export const SOURCES_AGREE_X = 5;

/**
 * Why a thesis-split fired, naming the trigger that did fire (task-1518). On a row the data layer flagged, the resolved
 * cap IS DexScreener's (resolveMcap keeps it when the sources disagree), so the two numbers on the tick are equal and
 * the computed ratio reads 1.0x: say that the sources' supplies were flagged instead of printing "1.0x apart".
 */
export function splitDetail(k: MarketTick, maxX: number): string {
  const x = splitX(k);
  if (x > maxX) return `market-cap sources ${x.toFixed(1)}x apart (limit ${maxX}x)`;
  return `the data layer flagged the two market-cap sources: their supplies are more than ${SOURCES_AGREE_X}x apart`;
}
const pct = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`;

export interface MonitorOpts {
  minExitLiquidityUsd: number;
  /** What selling `tokens` now would net in USD (the runner passes its fill model), so a cost-recovery sell
   *  takes back the cost after fee, slippage, impact and the network fee. Default: the mid price, no costs. */
  sellUsd?: (tokens: number) => number;
}

/**
 * One tick for one open position. Mutates the position's tracking fields (peak, windows, TP count, armed
 * trail, wake flags) and returns the actions in the order they must be executed. A full exit ends the list.
 */
export function monitorTick(p: Position, prof: ExitProfile, k: MarketTick, o: MonitorOpts): MonitorAction[] {
  const out: MonitorAction[] = [];
  p.lastTick = k;
  const wake = (event: WakeKind, detail: string, allowed: WakeEvent['allowed'] = ['hold', 'exit', 'tighten']) => {
    out.push({ kind: 'wake', wake: { event, positionId: p.id, mint: p.mint, t: k.t, detail, allowed } });
  };
  const exitAll = (reason: string, detail: string) => {
    out.push({ kind: 'sell', tokens: p.tokens, all: true, reason, detail });
    out.push({ kind: 'wake', wake: { event: 'mechanical_exit', positionId: p.id, mint: p.mint, t: k.t, detail: `${reason}: ${detail}`, allowed: ['hold'] } });
    return out;
  };

  // A stuck bag (no pool to sell into) is retried on every tick; nothing else applies until it sells.
  if (p.stuck) {
    if ((k.liq ?? 0) >= o.minExitLiquidityUsd && k.price) return exitAll('rug-liquidity', 'liquidity came back, selling the stuck bag');
    return out;
  }
  if (k.price === null || k.price <= 0) return out;
  const liq = k.liq ?? 0;

  // 1. Rug / liquidity pull: the pool is gone or below the exit floor.
  if (liq < o.minExitLiquidityUsd) return exitAll('rug-liquidity', `liquidity $${Math.round(liq)} is below the $${o.minExitLiquidityUsd} exit floor`);

  // 2. Thesis breaks on the coin's own reads.
  const tb = prof.thesisBreak;
  const winMs = tb.liquidityWindowMin * 60e3;
  p.liqWindow.push({ t: k.t, liq });
  // Keep the window plus the newest read before it: on a ~2-minute tape a 5-minute window still has a reference.
  while (p.liqWindow.length > 2 && p.liqWindow[1].t < k.t - winMs) p.liqWindow.shift();
  const liqHigh = Math.max(...p.liqWindow.map((w) => w.liq));
  const liqDrop = liqHigh > 0 ? ((liqHigh - liq) / liqHigh) * 100 : 0;
  if (liqDrop >= tb.liquidityDropPct) return exitAll('thesis-liquidity', `liquidity down ${liqDrop.toFixed(0)}% from its ${tb.liquidityWindowMin}-min high`);
  if (tb.mcapDivergenceX !== null && (k.mcapFlagged || splitX(k) > tb.mcapDivergenceX)) return exitAll('thesis-split', splitDetail(k, tb.mcapDivergenceX));
  if (tb.volumeDeath) {
    const trades = (k.buys5m ?? 0) + (k.sells5m ?? 0);
    if (k.buys5m !== null && trades < tb.volumeDeath.m5TradesBelow) p.lowTapeSince ??= k.t;
    else p.lowTapeSince = null;
    if (p.lowTapeSince !== null && k.t - p.lowTapeSince >= tb.volumeDeath.forMinutes * 60e3) return exitAll('thesis-volume', `under ${tb.volumeDeath.m5TradesBelow} trades per 5 min for ${tb.volumeDeath.forMinutes} min`);
  }
  // (devSell needs chain events; the recorded history has none, so a replay cannot fire it.)

  const gain = pnlPct(p, k.price);
  p.peakPrice = Math.max(p.peakPrice, k.price);
  p.troughPrice = Math.min(p.troughPrice ?? p.entryPrice, k.price);
  const peakGain = pnlPct(p, p.peakPrice);

  // 3. Hard stop (opt-in per profile), then the holding cap (the position's own dead-man).
  if (prof.maxHoldMinutes != null && k.t - p.openedAt >= prof.maxHoldMinutes * 60e3) return exitAll('max-hold', `held ${prof.maxHoldMinutes} min (the profile's holding cap) at ${pct(gain)}`);
  if (prof.hardStop.enabled && prof.hardStop.atPct !== null && gain <= prof.hardStop.atPct) return exitAll('stop', `${pct(gain)} hit the ${prof.hardStop.atPct}% hard stop`);

  // 3b. Cost recovery (exit profile 1.2.0): sell what pays back the net cost, once; the rest rides as a free bag.
  // Proceeds come from the runner's own fill model (every cost a sell pays), and the sell is capped at
  // maxSellFrac of the bag, so a thin pool recovers less rather than selling everything.
  const cr = prof.costRecovery;
  if (cr && !p.costRecovered && gain >= cr.atPct) {
    const owed = p.costUsd - p.realizedUsd;
    const price = k.price;
    const sellUsd = o.sellUsd ?? ((tok: number) => tok * price);
    const cap = p.tokens * cr.maxSellFrac;
    let tokens = cap;
    if (sellUsd(cap) > owed) { // smallest bag slice that nets the cost (proceeds rise with size)
      let lo = 0, hi = cap;
      for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (sellUsd(mid) >= owed) hi = mid; else lo = mid; }
      tokens = hi;
    }
    p.costRecovered = true;
    if (owed > 0 && tokens > 0) {
      out.push({ kind: 'sell', tokens, all: false, reason: 'cost-recovery', detail: `${pct(gain)} ≥ +${cr.atPct}%: sell ${Math.round((tokens / p.tokens) * 100)}% of the bag to take the $${owed.toFixed(2)} cost back` });
      if (prof.wake?.onCostRecovered) wake('cost_recovered', `cost taken back at ${pct(gain)}; ${Math.round(((p.tokens - tokens) / p.origTokens) * 100)}% of the original size rides as a free bag`, ['hold', 'exit', 'tighten']);
    }
  }
  const held = p.tokens - out.reduce((a, x) => a + (x.kind === 'sell' ? x.tokens : 0), 0);

  // 4. Take-profit ladder (fractions of the ORIGINAL size; several steps may fill on one gap).
  let left = held;
  while (p.tpFilled < prof.tpLadder.length && gain >= prof.tpLadder[p.tpFilled].atPct) {
    const step = prof.tpLadder[p.tpFilled];
    const tokens = Math.min(left, p.origTokens * step.sellFrac);
    p.tpFilled++;
    if (tokens <= 0) continue;
    left -= tokens;
    out.push({ kind: 'sell', tokens, all: left <= p.origTokens * 1e-6, reason: `tp${p.tpFilled}`, detail: `${pct(gain)} ≥ +${step.atPct}%: sell ${Math.round(step.sellFrac * 100)}% of the original size` });
    if (prof.wake?.onTpFilled) wake('tp_filled', `TP${p.tpFilled} filled at ${pct(gain)}; ${Math.round((left / p.origTokens) * 100)}% of the original size left`, ['hold', 'exit', 'tighten', 'reprofile']);
  }
  if (left <= p.origTokens * 1e-6) return out;

  // 5a. Bag trail (exit profile 1.2.0): armed by the cost-recovery sell (and, with armAtPct, a higher peak),
  // measured off the peak since entry.
  if (prof.bagTrail && p.costRecovered && peakGain >= (prof.bagTrail.armAtPct ?? 0)) {
    const off = ((p.peakPrice - k.price) / p.peakPrice) * 100;
    const trail = p.bagTrailPct ?? prof.bagTrail.trailPct;
    if (off >= trail) {
      out.push({ kind: 'sell', tokens: left, all: true, reason: 'bag-trail', detail: `the bag is ${off.toFixed(0)}% off its peak (${pct(peakGain)}), bag trail ${trail}%` });
      out.push({ kind: 'wake', wake: { event: 'mechanical_exit', positionId: p.id, mint: p.mint, t: k.t, detail: `bag-trail: ${off.toFixed(0)}% off the peak`, allowed: ['hold'] } });
      return out;
    }
  }

  // 5. Trailing stop.
  const ts = prof.trailingStop;
  if (ts) {
    if (!p.trailArmed && peakGain >= ts.armAtPct) p.trailArmed = true;
    const off = ((p.peakPrice - k.price) / p.peakPrice) * 100;
    if (p.trailArmed && off >= ts.trailPct) {
      out.push({ kind: 'sell', tokens: left, all: true, reason: 'trail', detail: `${off.toFixed(0)}% off the peak (${pct(peakGain)}), trail ${ts.trailPct}%` });
      out.push({ kind: 'wake', wake: { event: 'mechanical_exit', positionId: p.id, mint: p.mint, t: k.t, detail: `trail: ${off.toFixed(0)}% off the peak`, allowed: ['hold'] } });
      return out;
    }
  }

  // 6. Time stop.
  const tm = prof.timeStop;
  if (tm && k.t - p.openedAt >= tm.minutes * 60e3 && gain < tm.ifBelowPct) {
    if (tm.action === 'exit') {
      out.push({ kind: 'sell', tokens: left, all: true, reason: 'time', detail: `${tm.minutes} min in at ${pct(gain)} (needed +${tm.ifBelowPct}%)` });
      out.push({ kind: 'wake', wake: { event: 'mechanical_exit', positionId: p.id, mint: p.mint, t: k.t, detail: `time: ${tm.minutes} min at ${pct(gain)}`, allowed: ['hold'] } });
      return out;
    }
    if (!p.wakeSent.time && (prof.wake?.onTimeReview ?? true)) {
      p.wakeSent.time = true;
      wake(tm.action === 'review' ? 'time_review' : 'time_tighten', `${tm.minutes} min in at ${pct(gain)}, below the +${tm.ifBelowPct}% the profile wanted by now`);
    }
  }

  // 7. Judgement wakes (once each).
  const w = prof.wake;
  if (w?.drawdownPct != null && gain <= w.drawdownPct && !p.wakeSent.drawdown) { p.wakeSent.drawdown = true; wake('drawdown', `position at ${pct(gain)}; no hard stop in this profile`); }
  if (w?.thesisWarnFrac != null && liqDrop >= tb.liquidityDropPct * w.thesisWarnFrac && !p.wakeSent.thesis) { p.wakeSent.thesis = true; wake('thesis_warning', `liquidity down ${liqDrop.toFixed(0)}% from its window high (exit at ${tb.liquidityDropPct}%)`); }

  // 8. Ladder adds (scale-in tranches), each still clamped by the runner.
  p.ladder.forEach((tr, i) => {
    if (tr.usd <= 0) return;
    if (k.t > tr.deadline) { tr.usd = 0; return; }
    const first = p.fills[0].price;
    const move = ((k.price! - first) / first) * 100;
    if (tr.atPct < 0 ? move <= tr.atPct : move >= tr.atPct) {
      out.push({ kind: 'add', index: i, usd: tr.usd, detail: `tranche ${i + 1}: ${pct(move)} from the first fill (trigger ${tr.atPct}%)` });
      tr.usd = 0;
    }
  });
  return out;
}
