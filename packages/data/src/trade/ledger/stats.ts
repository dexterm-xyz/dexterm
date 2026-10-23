// task-1530 — ledger statistics: filters, the summary (win rate, P/L, drawdown, rug rate, breakdowns by profile,
// exit reason, strategy, source and wallet mode), the equity curve and the per-strategy comparison.
//
// Money is summed in ONE unit per report: SOL when every closed trade has a SOL figure, else USD (an autotrade run
// books in USD). The report names its unit. Paper, devnet and live are never blended silently: `modes` lists what
// is in the set, and the CLI says so when there is more than one.

import type { TradeRow } from './fold.ts';
import type { LedgerSource, WalletMode } from './schema.ts';

export interface TradeFilter {
  source?: LedgerSource; mode?: WalletMode; strategy?: string; profile?: string; exitReason?: string; mint?: string;
  status?: 'open' | 'closed'; since?: number; until?: number; runId?: string;
  /** A shared paper account id (task-1538). */
  account?: string;
}

/** `strategy` matches `id`, `id@version` or `id@hash-prefix`. */
export function matchStrategy(t: TradeRow, q: string): boolean {
  const s = t.strategy;
  if (!s) return q === 'none' || q === 'manual';
  const [id, at] = q.split('@');
  if (s.id !== id) return false;
  return !at || s.version === at || (s.hash ?? '').startsWith(at);
}

export function filterTrades(rows: readonly TradeRow[], f: TradeFilter = {}): TradeRow[] {
  return rows.filter((t) =>
    (!f.source || t.source === f.source) && (!f.mode || t.walletMode === f.mode) && (!f.status || t.status === f.status)
    && (!f.strategy || matchStrategy(t, f.strategy)) && (!f.profile || (t.profile.id ?? 'undeclared') === f.profile)
    && (!f.exitReason || (t.exitReason.code ?? 'untagged') === f.exitReason) && (!f.mint || t.mint === f.mint)
    && (!f.runId || t.runId === f.runId) && (!f.account || t.account === f.account) && (f.since === undefined || t.openedAt >= f.since) && (f.until === undefined || t.openedAt < f.until));
}

export type Unit = 'SOL' | 'USD';

export function unitFor(rows: readonly TradeRow[]): Unit {
  const closed = rows.filter((t) => t.status === 'closed');
  return closed.length && closed.every((t) => t.pnlSol !== null) ? 'SOL' : closed.some((t) => t.pnlUsd !== null) ? 'USD' : 'SOL';
}
const pnlIn = (t: TradeRow, u: Unit): number | null => (u === 'SOL' ? t.pnlSol : t.pnlUsd);
const r = (x: number | null, p = 6): number | null => (x === null || !Number.isFinite(x) ? null : Number(x.toPrecision(p)));

/** Wilson 95 % interval for k wins in n trades. */
export function wilson(k: number, n: number): { value: number; lo: number; hi: number } | null {
  if (!n) return null;
  const z = 1.96, p = k / n, d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d, h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { value: r(p, 4)!, lo: r(Math.max(0, c - h), 4)!, hi: r(Math.min(1, c + h), 4)! };
}

export interface EquityPoint { t: number; tradeId: string; symbol: string; pnl: number; cum: number; peak: number; drawdown: number }
export interface EquityCurve { unit: Unit; start: number | null; points: EquityPoint[]; maxDrawdown: number; maxDrawdownPct: number | null; final: number }

/** Cumulative realized P/L by close time. Drawdown is from the running peak; its % is of (starting book + peak). */
export function equityCurve(rows: readonly TradeRow[], unit: Unit = unitFor(rows)): EquityCurve {
  const closed = rows.filter((t) => t.status === 'closed' && pnlIn(t, unit) !== null).sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0) || a.tradeId.localeCompare(b.tradeId));
  const firstBook = rows.map((t) => (unit === 'SOL' ? t.bookSol : t.bookUsd)).find((x) => x !== null && x > 0) ?? null;
  let cum = 0, peak = 0, maxDd = 0, maxDdPct: number | null = firstBook ? 0 : null;
  const points: EquityPoint[] = [];
  for (const t of closed) {
    const p = pnlIn(t, unit)!;
    cum += p; peak = Math.max(peak, cum);
    const dd = peak - cum;
    maxDd = Math.max(maxDd, dd);
    if (firstBook) maxDdPct = Math.max(maxDdPct ?? 0, (dd / (firstBook + peak)) * 100);
    points.push({ t: t.closedAt ?? t.openedAt, tradeId: t.tradeId, symbol: t.symbol, pnl: r(p)!, cum: r(cum)!, peak: r(peak)!, drawdown: r(dd)! });
  }
  return { unit, start: firstBook, points, maxDrawdown: r(maxDd)!, maxDrawdownPct: maxDdPct === null ? null : r(maxDdPct, 4), final: r(cum)! };
}

export interface GroupStats { key: string; trades: number; open: number; wins: number; losses: number; winRate: number | null; pnl: number; avgPnlPct: number | null; rugs: number; rugRate: number | null }

function group(rows: readonly TradeRow[], key: (t: TradeRow) => string, unit: Unit): GroupStats[] {
  const m = new Map<string, TradeRow[]>();
  for (const t of rows) { const k = key(t); m.set(k, [...(m.get(k) ?? []), t]); }
  return [...m.entries()].map(([k, ts]) => {
    const c = ts.filter((t) => t.status === 'closed');
    const wins = c.filter((t) => (pnlIn(t, unit) ?? 0) > 0).length;
    const pcts = c.map((t) => t.pnlPct).filter((x): x is number => x !== null);
    const rugs = c.filter((t) => t.rug).length;
    return {
      key: k, trades: c.length, open: ts.length - c.length, wins, losses: c.length - wins, winRate: c.length ? r(wins / c.length, 4) : null,
      pnl: r(c.reduce((s, t) => s + (pnlIn(t, unit) ?? 0), 0))!, avgPnlPct: pcts.length ? r(pcts.reduce((a, b) => a + b, 0) / pcts.length, 4) : null,
      rugs, rugRate: c.length ? r(rugs / c.length, 4) : null,
    };
  }).sort((a, b) => b.trades - a.trades || a.key.localeCompare(b.key));
}

export const strategyKey = (t: TradeRow): string => (t.strategy ? `${t.strategy.id}@${t.strategy.version ?? (t.strategy.hash ?? '').slice(0, 8)}` : 'manual');

export interface LedgerSummary {
  unit: Unit;
  modes: WalletMode[];
  trades: number; open: number; wins: number; losses: number;
  winRate: { value: number; lo: number; hi: number } | null;
  pnl: number; pnlSol: number | null; pnlUsd: number | null;
  avgPnlPct: number | null; medianPnlPct: number | null; bestPct: number | null; worstPct: number | null;
  profitFactor: number | null;
  maxDrawdown: number; maxDrawdownPct: number | null;
  rugs: number; rugRate: number | null;
  avgHoldSec: number | null; avgMfePct: number | null; avgMaePct: number | null;
  feesSol: number | null; modelCostUsd: number | null;
  tagCoverage: { profileDeclared: number | null; exitDeclared: number | null };
  byProfile: GroupStats[]; byExitReason: GroupStats[]; byStrategy: GroupStats[]; bySource: GroupStats[]; byMode: GroupStats[];
}

const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function summarize(rows: readonly TradeRow[], unit: Unit = unitFor(rows)): LedgerSummary {
  const closed = rows.filter((t) => t.status === 'closed');
  const pnls = closed.map((t) => pnlIn(t, unit) ?? 0);
  const wins = pnls.filter((p) => p > 0).length;
  const pcts = closed.map((t) => t.pnlPct).filter((x): x is number => x !== null).sort((a, b) => a - b);
  const gain = pnls.filter((p) => p > 0).reduce((a, b) => a + b, 0);
  const loss = -pnls.filter((p) => p < 0).reduce((a, b) => a + b, 0);
  const curve = equityCurve(rows, unit);
  const rugs = closed.filter((t) => t.rug).length;
  const sumOf = (f: (t: TradeRow) => number | null): number | null => { const xs = closed.map(f).filter((x): x is number => x !== null); return xs.length ? r(xs.reduce((a, b) => a + b, 0)) : null; };
  const declared = (f: (t: TradeRow) => boolean, set: readonly TradeRow[]) => (set.length ? r(set.filter(f).length / set.length, 4) : null);
  const good = (s: string) => s !== 'missing' && s !== 'default';
  return {
    unit, modes: [...new Set(rows.map((t) => t.walletMode))],
    trades: closed.length, open: rows.length - closed.length, wins, losses: closed.length - wins,
    winRate: wilson(wins, closed.length),
    pnl: r(pnls.reduce((a, b) => a + b, 0))!, pnlSol: sumOf((t) => t.pnlSol), pnlUsd: sumOf((t) => t.pnlUsd),
    avgPnlPct: r(mean(pcts), 4), medianPnlPct: pcts.length ? r(pcts.length % 2 ? pcts[(pcts.length - 1) / 2] : (pcts[pcts.length / 2 - 1] + pcts[pcts.length / 2]) / 2, 4) : null,
    bestPct: pcts.length ? r(pcts[pcts.length - 1], 4) : null, worstPct: pcts.length ? r(pcts[0], 4) : null,
    profitFactor: loss > 0 ? r(gain / loss, 4) : null,
    maxDrawdown: curve.maxDrawdown, maxDrawdownPct: curve.maxDrawdownPct,
    rugs, rugRate: closed.length ? r(rugs / closed.length, 4) : null,
    avgHoldSec: closed.length ? Math.round(mean(closed.map((t) => t.holdSec))!) : null,
    avgMfePct: r(mean(closed.map((t) => t.mfePct).filter((x): x is number => x !== null)), 4),
    avgMaePct: r(mean(closed.map((t) => t.maePct).filter((x): x is number => x !== null)), 4),
    feesSol: sumOf((t) => t.feesSol), modelCostUsd: (() => { const xs = rows.map((t) => t.model.costUsd).filter((x): x is number => x !== null); return xs.length ? r(xs.reduce((a, b) => a + b, 0)) : null; })(),
    tagCoverage: { profileDeclared: declared((t) => good(t.profile.source), rows), exitDeclared: declared((t) => good(t.exitReason.source), closed) },
    byProfile: group(rows, (t) => t.profile.id ?? 'undeclared', unit),
    byExitReason: group(closed, (t) => t.exitReason.code ?? 'untagged', unit),
    byStrategy: group(rows, strategyKey, unit),
    bySource: group(rows, (t) => t.source, unit),
    byMode: group(rows, (t) => t.walletMode, unit),
  };
}

export interface StrategyComparison {
  key: string; strategy: { id: string; version: string | null; hash: string | null } | null; modes: WalletMode[];
  trades: number; open: number; winRate: { value: number; lo: number; hi: number } | null; pnl: number; avgPnlPct: number | null;
  maxDrawdown: number; rugRate: number | null; avgHoldSec: number | null; avgMfePct: number | null; avgMaePct: number | null; modelCostUsd: number | null;
}

/** One row per strategy version (a run of the same id at another version is another row): the forward-test table. */
export function compareStrategies(rows: readonly TradeRow[], unit: Unit = unitFor(rows)): { unit: Unit; rows: StrategyComparison[] } {
  const m = new Map<string, TradeRow[]>();
  for (const t of rows) { const k = strategyKey(t); m.set(k, [...(m.get(k) ?? []), t]); }
  return {
    unit,
    rows: [...m.entries()].map(([key, ts]) => {
      const s = summarize(ts, unit);
      return { key, strategy: ts[0].strategy, modes: s.modes, trades: s.trades, open: s.open, winRate: s.winRate, pnl: s.pnl, avgPnlPct: s.avgPnlPct, maxDrawdown: s.maxDrawdown, rugRate: s.rugRate, avgHoldSec: s.avgHoldSec, avgMfePct: s.avgMfePct, avgMaePct: s.avgMaePct, modelCostUsd: s.modelCostUsd };
    }).sort((a, b) => b.pnl - a.pnl || a.key.localeCompare(b.key)),
  };
}
