// task-1530 — ledger EXPORTS: one row per trade (the folded TradeRow), in three formats.
//
//   csv           RFC 4180, a header row, one line per trade; a cell that starts with = + - @ is prefixed with '
//                 so a spreadsheet never runs it as a formula (CSV injection), and every text cell is one line.
//   json          {schema, exportedAt, unit, ledgerHead, trades: TradeRow[]} with the fills and the reprofiles.
//   parquet-lite  a COLUMNAR JSON document (not Apache Parquet; no dependency): {schema, columns: [{name, type}],
//                 rows, data: {column: values[]}}. pandas: pd.DataFrame(doc["data"]); polars: pl.DataFrame(doc["data"]).
//
// No export holds a key or a balance beyond what the trades themselves imply.

import type { TradeRow } from './fold.ts';

export const EXPORT_FORMATS = ['csv', 'json', 'parquet-lite'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
export const EXPORT_SCHEMA = 'dexterm-ledger-export/1';
export const PARQUET_LITE_SCHEMA = 'dexterm-parquet-lite/1';

type ColType = 'string' | 'number' | 'boolean' | 'timestamp';
interface Col { name: string; type: ColType; get: (t: TradeRow) => string | number | boolean | null }

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/** The flat columns, in order. Shared by csv and parquet-lite so the two never disagree. */
export const EXPORT_COLUMNS: readonly Col[] = [
  { name: 'trade_id', type: 'string', get: (t) => t.tradeId },
  { name: 'source', type: 'string', get: (t) => t.source },
  { name: 'wallet_mode', type: 'string', get: (t) => t.walletMode },
  { name: 'status', type: 'string', get: (t) => t.status },
  { name: 'mint', type: 'string', get: (t) => t.mint },
  { name: 'symbol', type: 'string', get: (t) => t.symbol },
  { name: 'strategy_id', type: 'string', get: (t) => t.strategy?.id ?? null },
  { name: 'strategy_version', type: 'string', get: (t) => t.strategy?.version ?? null },
  { name: 'strategy_hash', type: 'string', get: (t) => t.strategy?.hash ?? null },
  { name: 'run_id', type: 'string', get: (t) => t.runId },
  { name: 'account', type: 'string', get: (t) => t.account ?? null },
  { name: 'profile', type: 'string', get: (t) => t.profile.id },
  { name: 'profile_source', type: 'string', get: (t) => t.profile.source },
  { name: 'reprofiles', type: 'number', get: (t) => t.reprofiles.length },
  { name: 'entry_reason', type: 'string', get: (t) => t.entryReason.text },
  { name: 'entry_reason_source', type: 'string', get: (t) => t.entryReason.source },
  { name: 'exit_reason', type: 'string', get: (t) => t.exitReason.code },
  { name: 'exit_reason_text', type: 'string', get: (t) => t.exitReason.text },
  { name: 'exit_reason_source', type: 'string', get: (t) => t.exitReason.source },
  { name: 'opened_at', type: 'timestamp', get: (t) => iso(t.openedAt) },
  { name: 'closed_at', type: 'timestamp', get: (t) => iso(t.closedAt) },
  { name: 'hold_sec', type: 'number', get: (t) => t.holdSec },
  { name: 'buys', type: 'number', get: (t) => t.buys },
  { name: 'sells', type: 'number', get: (t) => t.sells },
  { name: 'size_sol', type: 'number', get: (t) => t.sizeSol },
  { name: 'size_usd', type: 'number', get: (t) => t.sizeUsd },
  { name: 'pct_of_book', type: 'number', get: (t) => t.pctOfBook },
  { name: 'entry_price_sol', type: 'number', get: (t) => t.entryPriceSol },
  { name: 'entry_price_usd', type: 'number', get: (t) => t.entryPriceUsd },
  { name: 'entry_mcap_usd', type: 'number', get: (t) => t.entryMcapUsd },
  { name: 'exit_price_sol', type: 'number', get: (t) => t.exitPriceSol },
  { name: 'exit_price_usd', type: 'number', get: (t) => t.exitPriceUsd },
  { name: 'exit_mcap_usd', type: 'number', get: (t) => t.exitMcapUsd },
  { name: 'supply_tokens', type: 'number', get: (t) => t.supply?.tokens ?? null },
  { name: 'supply_source', type: 'string', get: (t) => t.supply?.source ?? null },
  { name: 'proceeds_sol', type: 'number', get: (t) => t.proceedsSol },
  { name: 'proceeds_usd', type: 'number', get: (t) => t.proceedsUsd },
  { name: 'pnl_sol', type: 'number', get: (t) => t.pnlSol },
  { name: 'pnl_usd', type: 'number', get: (t) => t.pnlUsd },
  { name: 'pnl_pct', type: 'number', get: (t) => t.pnlPct },
  { name: 'fees_sol', type: 'number', get: (t) => t.feesSol },
  { name: 'impact_pct_entry', type: 'number', get: (t) => t.impactPctEntry },
  { name: 'impact_pct_exit', type: 'number', get: (t) => t.impactPctExit },
  { name: 'slippage_bps', type: 'number', get: (t) => t.slippageBps },
  { name: 'mfe_pct', type: 'number', get: (t) => t.mfePct },
  { name: 'mae_pct', type: 'number', get: (t) => t.maePct },
  { name: 'excursion_basis', type: 'string', get: (t) => t.excursionBasis },
  { name: 'rug', type: 'boolean', get: (t) => t.rug },
  { name: 'rug_why', type: 'string', get: (t) => t.rugWhy },
  { name: 'stuck', type: 'boolean', get: (t) => t.stuck },
  { name: 'tx_sigs', type: 'string', get: (t) => (t.txSigs.length ? t.txSigs.join(' ') : null) },
  { name: 'session_ids', type: 'string', get: (t) => (t.model.sessionIds.length ? t.model.sessionIds.join(' ') : null) },
  { name: 'models', type: 'string', get: (t) => (t.model.models.length ? t.model.models.join(' ') : null) },
  { name: 'model_cost_usd', type: 'number', get: (t) => t.model.costUsd },
];

/** One CSV cell: quoted when needed, one line, never a formula. */
export function csvCell(v: string | number | boolean | null): string {
  if (v === null) return '';
  if (typeof v !== 'string') return String(v);
  let s = v.replace(/[\r\n\t]+/g, ' ');
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return /[",]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: readonly TradeRow[]): string {
  const head = EXPORT_COLUMNS.map((c) => c.name).join(',');
  return `${[head, ...rows.map((t) => EXPORT_COLUMNS.map((c) => csvCell(c.get(t))).join(','))].join('\n')}\n`;
}

export interface ExportMeta { exportedAt: number; ledgerHead: string | null; unit: string; filters?: Record<string, unknown> }

export function toJson(rows: readonly TradeRow[], m: ExportMeta): string {
  return `${JSON.stringify({ schema: EXPORT_SCHEMA, exportedAt: iso(m.exportedAt), unit: m.unit, ledgerHead: m.ledgerHead, filters: m.filters ?? {}, count: rows.length, trades: rows }, null, 2)}\n`;
}

export function toParquetLite(rows: readonly TradeRow[], m: ExportMeta): string {
  const data: Record<string, (string | number | boolean | null)[]> = {};
  for (const c of EXPORT_COLUMNS) data[c.name] = rows.map((t) => c.get(t));
  return `${JSON.stringify({ schema: PARQUET_LITE_SCHEMA, exportedAt: iso(m.exportedAt), ledgerHead: m.ledgerHead, unit: m.unit, rows: rows.length, columns: EXPORT_COLUMNS.map((c) => ({ name: c.name, type: c.type })), data })}\n`;
}

export function exportTrades(rows: readonly TradeRow[], format: ExportFormat, m: ExportMeta): string {
  if (format === 'csv') return toCsv(rows);
  if (format === 'json') return toJson(rows, m);
  return toParquetLite(rows, m);
}
