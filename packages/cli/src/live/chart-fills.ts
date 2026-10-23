// dexterm — task-1483: the fills behind the chart BUY / SELL markers, read from the paper wallet's trades (the user's
// and an agent's PAPER fills). No fetch, no write: the paper wallet is only read. Display only. task-1571: there is no
// live ledger (dexterm holds no key and places no live trade).
import type { ChartTradeFill } from '@dexterm/tui';
import type { TradeRecord } from '@dexterm/data';

const abs = (n: bigint): bigint => (n < 0n ? -n : n);
const fin = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

/** A paper ledger row → a chart fill (its own USD price when the paper engine recorded one). */
export function paperChartFill(r: Pick<TradeRecord, 't' | 'side' | 'decimals' | 'tokenDelta' | 'grossLamports' | 'priceUsd'>): ChartTradeFill {
  return {
    t: r.t, side: r.side, source: 'paper',
    priceUsd: fin(r.priceUsd) ? r.priceUsd : null,
    tokens: Number(abs(r.tokenDelta)) / 10 ** r.decimals,
    sol: Number(abs(r.grossLamports)) / 1e9,
  };
}

/** Where the chart fills are read from (LiveContext in the app; plain functions in tests). */
export interface ChartFillReaders {
  /** The paper wallet's newest trades (any mint). */
  paper?: (limit: number) => readonly TradeRecord[];
}

/** How many paper rows are scanned for one mint (the wallet has no per-mint read; older history drops off first). */
export const CHART_FILLS_PAPER_SCAN = 2000;
/** How long one mint's fills are reused (the render loop asks every frame; the popup up to ~20×/s). */
export const CHART_FILLS_MEMO_MS = 1000;

/** Every paper fill for one mint, oldest first. A ledger that cannot be read contributes nothing. */
export function chartFillsFor(mint: string, rd: ChartFillReaders): ChartTradeFill[] {
  const out: ChartTradeFill[] = [];
  try { for (const r of rd.paper?.(CHART_FILLS_PAPER_SCAN) ?? []) if (r.mint === mint) out.push(paperChartFill(r)); } catch { /* unreadable paper ledger: no paper marks */ }
  return out.sort((a, b) => a.t - b.t);
}

/** chartFillsFor memoised per mint for CHART_FILLS_MEMO_MS (a fill shows on the chart within a second). */
export class ChartFills {
  private memo = new Map<string, { at: number; v: ChartTradeFill[] }>();
  private readonly rd: ChartFillReaders;
  private readonly now: () => number;
  constructor(rd: ChartFillReaders, now: () => number = Date.now) { this.rd = rd; this.now = now; }
  for(mint: string): ChartTradeFill[] {
    const now = this.now();
    const m = this.memo.get(mint);
    if (m && now - m.at >= 0 && now - m.at < CHART_FILLS_MEMO_MS) return m.v;
    const v = chartFillsFor(mint, this.rd);
    if (this.memo.size > 32) this.memo.clear();
    this.memo.set(mint, { at: now, v });
    return v;
  }
  /** Forget every memo (after a fill this run booked). */
  invalidate(): void { this.memo.clear(); }
}
