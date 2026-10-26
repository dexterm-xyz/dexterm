// dexterm autotrade — the daily / weekly digest (task-1654, 0.2.0 card E). Read-only over the run ledgers.
//
// Per strategy and mode (paper | real) over a period: closed trades, the win rate with its 95% interval (Wilson),
// net PnL, the max drawdown of the closed-trade curve, refusals, the limits that were hit, and for real mode the
// executor's health and the paper-vs-real fill divergence from receipts. Every digest ends with an honest sample
// note: a handful of trades says almost nothing, and the interval shows how little.
//
// `dexterm autotrade report` prints it (or --json, or --telegram through the user's own bot). A run with the
// Telegram bot on sends it by itself when the user turned a schedule on (`report --schedule daily|weekly|off`,
// saved in $DEXTERM_HOME/autotrade/digest.json; off by default).

import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readLedgerFile, runsDir, writeJsonAtomic, type LedgerEvent } from './ledger.ts';
import { localDay } from './chat/audit.ts';
import { allOutboxSignals } from './outbox.ts';
import { divergenceReport, readReceipts, type DivergenceSummary } from './receipts.ts';
import type { ExecutorHealth } from './executor-health.ts';

export type DigestPeriod = 'day' | 'week';

export interface StrategyDigest {
  strategyId: string;
  mode: 'paper' | 'real';
  runs: number;
  trades: number;
  wins: number;
  /** Win rate in % with its 95% Wilson interval (null with no trades). */
  winRatePct: number | null;
  winRateCi: [number, number] | null;
  netUsd: number;
  maxDrawdownUsd: number;
  refusals: number;
  /** Refusals by a real-mode limit (rule -> count), e.g. real-daily-cap. */
  limitsHit: Record<string, number>;
  /** Buys a limit clamped down (rule -> count). */
  clamped: Record<string, number>;
  receipts: number;
}

export interface Digest {
  period: DigestPeriod;
  from: number;
  to: number;
  strategies: StrategyDigest[];
  /** Real mode: receipts vs signals (all real strategies). */
  divergence: DivergenceSummary | null;
  executor: ExecutorHealth | null;
  note: string;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/** The 95% Wilson score interval of k wins in n, in %. */
export function wilson(k: number, n: number, z = 1.96): [number, number] | null {
  if (n <= 0) return null;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.round(Math.max(0, c - h) * 1000) / 10, Math.round(Math.min(1, c + h) * 1000) / 10];
}

export function periodBounds(period: DigestPeriod, now: number): { from: number; to: number } {
  return { from: now - (period === 'day' ? 1 : 7) * 86_400_000, to: now };
}

/** The digest of every run ledger with events in [from, to]. */
export function buildDigest(home: string, o: { period: DigestPeriod; now: number; from?: number; to?: number; strategyId?: string; executor?: ExecutorHealth | null }): Digest {
  const b = periodBounds(o.period, o.now);
  const from = o.from ?? b.from;
  const to = o.to ?? b.to;
  const by = new Map<string, StrategyDigest & { closes: { t: number; pnl: number }[] }>();
  const dir = runsDir(home);
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.jsonl')) : [];
  let anyReal = false;
  for (const f of files) {
    let ev: LedgerEvent[];
    try { ev = readLedgerFile(join(dir, f)); } catch { continue; }
    const start = ev.find((e) => e.kind === 'run_start');
    if (!start || typeof start.strategy !== 'string') continue;
    if (o.strategyId && start.strategy !== o.strategyId) continue;
    const inPeriod = ev.filter((e) => e.t >= from && e.t <= to);
    if (!inPeriod.length) continue;
    const mode: 'paper' | 'real' = start.mode === 'real' || start.tag === 'real-signal' ? 'real' : 'paper';
    if (mode === 'real') anyReal = true;
    const key = `${start.strategy}|${mode}`;
    let d = by.get(key);
    if (!d) { d = { strategyId: start.strategy, mode, runs: 0, trades: 0, wins: 0, winRatePct: null, winRateCi: null, netUsd: 0, maxDrawdownUsd: 0, refusals: 0, limitsHit: {}, clamped: {}, receipts: 0, closes: [] }; by.set(key, d); }
    d.runs++;
    for (const e of inPeriod) {
      if (e.kind === 'trade_closed') {
        const pnl = Number((e.trade as { pnlUsd?: unknown } | undefined)?.pnlUsd);
        if (Number.isFinite(pnl)) { d.trades++; if (pnl > 0) d.wins++; d.netUsd += pnl; d.closes.push({ t: e.t, pnl }); }
      } else if (e.kind === 'refused') {
        d.refusals++;
        const rule = String(e.rule ?? '');
        const m = /^(?:fill-)?(real-[a-z-]+)/.exec(rule);
        if (m) d.limitsHit[m[1]] = (d.limitsHit[m[1]] ?? 0) + 1;
      } else if (e.kind === 'fill' && Array.isArray(e.limitClamps)) {
        for (const c of e.limitClamps as string[]) d.clamped[c] = (d.clamped[c] ?? 0) + 1;
      } else if (e.kind === 'receipt') d.receipts++;
    }
  }
  const strategies = [...by.values()].map(({ closes, ...d }) => {
    closes.sort((a, b2) => a.t - b2.t);
    let cum = 0; let peak = 0; let dd = 0;
    for (const c of closes) { cum += c.pnl; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
    return { ...d, netUsd: r2(d.netUsd), maxDrawdownUsd: r2(dd), winRatePct: d.trades ? Math.round((d.wins / d.trades) * 1000) / 10 : null, winRateCi: wilson(d.wins, d.trades) };
  }).sort((a, b2) => a.strategyId.localeCompare(b2.strategyId) || a.mode.localeCompare(b2.mode));
  let divergence: DivergenceSummary | null = null;
  if (anyReal) {
    const sig = allOutboxSignals(home).filter((s) => s.issuedAt >= from && s.issuedAt <= to);
    const d = divergenceReport(sig, readReceipts(home).receipts);
    const { rows: _rows, ...rest } = d;
    divergence = rest;
  }
  const n = strategies.reduce((a, s) => a + s.trades, 0);
  const note = n === 0 ? 'no closed trades in this period'
    : n < 30 ? `${n} closed trade(s) in total: a small sample. The win-rate intervals show how wide the truth may be; read no trend into it.`
      : `${n} closed trades: still check the interval before trusting a win rate, and past results do not predict future ones`;
  return { period: o.period, from, to, strategies, divergence, executor: o.executor ?? null, note };
}

const usd = (v: number) => `${v < 0 ? '-' : '+'}$${Math.abs(v).toFixed(2)}`;

/** Plain lines (CLI and Telegram; no token text: strategy ids and engine numbers only). */
export function digestLines(d: Digest): string[] {
  const out = [`dexterm ${d.period === 'day' ? 'daily' : 'weekly'} digest · ${new Date(d.from).toISOString().slice(0, 16).replace('T', ' ')} to ${new Date(d.to).toISOString().slice(0, 16).replace('T', ' ')} UTC · not financial advice`];
  if (!d.strategies.length) out.push('  no runs in this period');
  for (const s of d.strategies) {
    out.push(`${s.mode === 'real' ? 'REAL' : 'paper'} ${s.strategyId} · ${s.runs} run(s) · ${s.trades} trade(s)${s.trades ? ` · win ${s.winRatePct}% (95% interval ${s.winRateCi![0]}-${s.winRateCi![1]}%)` : ''} · net ${usd(s.netUsd)} · max drawdown $${s.maxDrawdownUsd.toFixed(2)}`);
    const hit = Object.entries(s.limitsHit).map(([k, v]) => `${k} ×${v}`).join(', ');
    const cl = Object.entries(s.clamped).map(([k, v]) => `${k} ×${v}`).join(', ');
    out.push(`  refusals ${s.refusals}${hit ? ` · limits hit: ${hit}` : ''}${cl ? ` · clamped by: ${cl}` : ''}${s.mode === 'real' ? ` · receipts ${s.receipts}` : ''}`);
  }
  if (d.divergence) {
    const v = d.divergence;
    out.push(`paper vs real fills: ${v.receipted}/${v.trades} receipted · executed ${v.executed} · rejected ${v.rejected} · failed ${v.failed} · partial ${v.partial}${v.slippage.n ? ` · slippage vs paper median ${v.slippage.medianPct}% (p90 ${v.slippage.p90Pct}%)` : ''}${v.latency.n ? ` · latency median ${Math.round((v.latency.medianMs ?? 0) / 100) / 10} s` : ''}`);
    out.push(`  ${v.note}`);
  }
  if (d.executor) out.push(`executor: ${d.executor.alive === false ? 'SILENT' : d.executor.alive ? 'alive' : d.executor.lastSeenAt ? 'seen' : 'never seen'}${d.executor.silentSec !== null ? ` · last heard ${Math.round(d.executor.silentSec / 60)} min ago` : ''}${d.executor.lastReceipt ? ` · last receipt #${d.executor.lastReceipt.nonce} ${d.executor.lastReceipt.status}` : ''}`);
  out.push(d.note);
  return out;
}

// ───────────────────────────── the schedule (opt-in) ─────────────────────────────

export const DIGEST_SCHEMA = 'dexterm-digest/1';
export const digestStatePath = (home: string): string => join(home, 'autotrade', 'digest.json');

export interface DigestState { schema: typeof DIGEST_SCHEMA; schedule: 'off' | 'daily' | 'weekly'; lastSentDay: string | null; lastSentAt: number | null }

export function loadDigestState(home: string): DigestState {
  try { const d = JSON.parse(readFileSync(digestStatePath(home), 'utf8')) as DigestState; if (d.schema === DIGEST_SCHEMA && ['off', 'daily', 'weekly'].includes(d.schedule)) return d; } catch { /* none */ }
  return { schema: DIGEST_SCHEMA, schedule: 'off', lastSentDay: null, lastSentAt: null };
}

export function saveDigestState(home: string, s: DigestState): void {
  mkdirSync(join(home, 'autotrade'), { recursive: true, mode: 0o700 });
  writeJsonAtomic(digestStatePath(home), s);
}

/**
 * Is a scheduled digest due? Daily: once per local day, for the day before (first check after midnight). Weekly: on
 * a Monday, for the week before. Never twice for the same day.
 */
export function digestDue(s: DigestState, now: number): DigestPeriod | null {
  if (s.schedule === 'off') return null;
  const today = localDay(now);
  if (s.lastSentDay === today) return null;
  if (s.schedule === 'weekly' && new Date(now).getDay() !== 1) return null;
  return s.schedule === 'daily' ? 'day' : 'week';
}
