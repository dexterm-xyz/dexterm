// `dexterm dash` (task-1749): the DATA behind the strategy performance dashboard. Read-only, local, no network:
//   - every autotrade home given (a DEXTERM_HOME): its run ledgers (autotrade/runs/*.jsonl) through the strategy-stats
//     definitions (@dexterm/autotrade strategy-stats.ts: the challenge control's math), its service heartbeat and the
//     fleet status (open positions with the engine's mark, spend, halts)
//   - the market cache DB (read-only) for the last pool liquidity of an open coin, so an open position shows its
//     REALIZABLE value next to the engine mark, with the age of that pool read; nothing is fetched
//   - optional "books" files (dexterm-dash-books/1): other books (e.g. a SOL challenge run by hand or by an agent),
//     labels, groups, a baseline and status cards, produced by the user's own scripts; their trades go through the
//     same definitions
// The output never carries an absolute path, a key, a wallet address or a token: homes are named by their label.

import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  readStrategyLedgers, strategyRow, equityCurve, compareToBase, decisionRule, realizableUsd,
  MIN_CLOSED, RUG_PCT, STUCK_WRITE_OFF_MIN, type ClosedTrade, type MemberLedger, type StrategyRow, type Comparison,
} from '@dexterm/autotrade/strategy-stats';

export const PAPER_LABEL = 'Paper trading, not financial advice.';
export const DASH_SCHEMA = 'dexterm-dash/1';
export const BOOKS_SCHEMA = 'dexterm-dash-books/1';

export interface DashHome { dir: string; label: string; db?: string | null }
export interface StatusCard { title: string; state: 'ok' | 'warn' | 'down' | 'idle'; items: [string, string][]; updatedAt?: number | null }
export interface OpenPos {
  symbol: string | null; mint: string | null; profile: string | null; costUsd: number | null; markUsd: number | null; markPct: number | null; stuck: boolean;
  liqUsd: number | null; liqAt: number | null; realizableUsd: number | null; realizablePct: number | null; openedAt: number | null;
}
export interface DashStrategy {
  id: string; label: string; group: string; source: 'autotrade' | 'book'; home: string; unit: 'USD' | 'SOL'; mode: string | null; version: string | null;
  baseline: boolean; row: StrategyRow; equity: ReturnType<typeof equityCurve>; trades: ClosedTrade[]; open: OpenPos[];
  rugs: ClosedTrade[]; lastEventAt: number | null; firstEventAt: number | null;
}
export interface DashData {
  schema: string; generatedAt: number; paper: string; definitions: { minClosed: number; rugPct: number; writeOffMin: number; text: string[] };
  baseline: string | null; decisionRule: string | null; strategies: DashStrategy[]; comparisons: Comparison[]; status: StatusCard[]; notes: string[];
}

export interface BookTrade { t: number; openedAt?: number | null; mint?: string | null; symbol?: string | null; pnlPct: number; pnlUsd?: number | null; pnl?: number | null; cost?: number | null; exitReason?: string | null; writtenOff?: boolean; reason?: string; profile?: string | null; entryAgeMin?: number | null }
export interface BookOpen { symbol?: string | null; mint?: string | null; profile?: string | null; cost?: number | null; mark?: number | null; markPct?: number | null; realizable?: number | null; stuck?: boolean; openedAt?: number | null }
export interface Book { id: string; label?: string; group?: string; unit?: 'USD' | 'SOL'; start?: number | null; entries?: number; firstT?: number | null; trades: BookTrade[]; open?: BookOpen[]; mode?: string | null; version?: string | null }
export interface BooksFile { schema: string; generatedAt?: number; books?: Book[]; labels?: Record<string, string>; groups?: Record<string, string>; order?: string[]; baseline?: string; status?: StatusCard[]; notes?: string[] }

const readJson = <T>(p: string): T | null => { try { return JSON.parse(readFileSync(p, 'utf8')) as T; } catch { return null; } };
const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const r2 = (x: number) => Math.round(x * 100) / 100;
const r1 = (x: number) => Math.round(x * 10) / 10;
const alive = (pid: unknown) => { if (!fin(pid)) return false; try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };

/** A home's label: the folder that holds `.dexterm` (e.g. c100-control), else the folder's own name. */
export function homeLabel(dir: string): string { const b = basename(dir); return b === '.dexterm' ? basename(dirname(dir)) || b : b; }

/** The last cached pool read of each mint (ns ds:token) from the market cache DB, read-only. Missing DB: empty. */
export function cachedPools(dbPath: string | null | undefined, mints: string[]): Map<string, { liqUsd: number; at: number }> {
  const out = new Map<string, { liqUsd: number; at: number }>();
  if (!dbPath || !mints.length || !existsSync(dbPath)) return out;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const q = db.prepare('SELECT json, fetched_at FROM cache WHERE ns = ? AND key = ?');
    for (const m of new Set(mints)) {
      const r = q.get('ds:token', m) as { json: string; fetched_at: number } | undefined;
      if (!r) continue;
      try { const p = JSON.parse(r.json)?.pair; if (fin(p?.liquidityUsd)) out.set(m, { liqUsd: p.liquidityUsd, at: fin(p.fetchedAt) ? p.fetchedAt : r.fetched_at }); } catch { /* torn row */ }
    }
  } catch { /* locked or not a dexterm cache: no pool reads */ } finally { try { db?.close(); } catch { /* closed */ } }
  return out;
}

/** The service heartbeat + fleet status of one home as a status card (no paths, no pids beyond alive/dead). */
export function homeStatus(h: DashHome, now: number): StatusCard {
  const at = join(h.dir, 'autotrade');
  const hb = readJson<Record<string, any>>(join(at, 'service', 'heartbeat.json'));
  const fl = readJson<Record<string, any>>(join(at, 'fleet-status.json'));
  const items: [string, string][] = [];
  let state: StatusCard['state'] = 'idle';
  if (hb) {
    const age = fin(hb.heartbeatAt) ? Math.round((now - hb.heartbeatAt) / 1000) : null;
    const up = hb.state === 'running' && alive(hb.pid) && age !== null && age < 120;
    state = up ? 'ok' : hb.state === 'running' ? 'down' : 'idle';
    items.push(['Service', up ? 'running' : hb.state === 'running' ? 'NOT running (stale heartbeat)' : String(hb.state ?? 'unknown')]);
    if (age !== null) items.push(['Heartbeat', `${age < 120 ? `${age} s` : `${Math.round(age / 60)} min`} ago`]);
    if (fin(hb.dataAgeMs)) items.push(['Market data age', `${Math.round(hb.dataAgeMs / 1000)} s`]);
  } else items.push(['Service', 'no service heartbeat (not installed or never run)']);
  if (fl) {
    const ms: any[] = fl.members ?? [];
    if (fin(fl.startedAt)) items.push(['Fleet started', new Date(fl.startedAt).toISOString()]);
    if (fl.haltReason) { items.push(['Fleet halt', String(fl.haltReason)]); if (state === 'ok') state = 'warn'; }
    const running = ms.filter((m) => m.state === 'running').length;
    items.push(['Strategies running', `${running} of ${ms.length}`]);
    const halted = ms.filter((m) => m.haltReason).map((m) => `${m.id}: ${m.haltReason}`);
    if (halted.length) { items.push(['Halted', halted.join('; ')]); if (state === 'ok') state = 'warn'; }
    const spend = ms.reduce((s, m) => s + (fin(m.spend?.todayUsd) ? m.spend.todayUsd : 0), 0);
    items.push(['Model spend today', `$${spend.toFixed(2)}`]);
  }
  return { title: `Autotrade · ${h.label}`, state, items, updatedAt: fin(hb?.heartbeatAt) ? hb!.heartbeatAt : null };
}

function openFromFleet(h: DashHome, now: number): Map<string, OpenPos[]> {
  const fl = readJson<Record<string, any>>(join(h.dir, 'autotrade', 'fleet-status.json'));
  const out = new Map<string, OpenPos[]>();
  if (!fl?.members) return out;
  const mints = (fl.members as any[]).flatMap((m) => (m.open ?? []).map((o: any) => o.mint)).filter(Boolean);
  const pools = cachedPools(h.db, mints);
  for (const m of fl.members as any[]) {
    out.set(m.id, (m.open ?? []).map((o: any): OpenPos => {
      const cost = fin(o.costUsd) ? o.costUsd : null; const mark = cost !== null ? cost + (fin(o.pnlUsd) ? o.pnlUsd : 0) : null;
      const pool = o.mint ? pools.get(o.mint) : undefined;
      // a stuck position has no pool to sell into: realizable 0 whatever the last read said
      const rv = o.stuck ? 0 : mark !== null ? realizableUsd(mark, pool?.liqUsd) : null;
      return { symbol: o.symbol ?? null, mint: o.mint ?? null, profile: o.profile ?? null, costUsd: cost, markUsd: mark === null ? null : r2(mark), markPct: fin(o.pnlPct) ? o.pnlPct : null, stuck: !!o.stuck,
        liqUsd: pool ? Math.round(pool.liqUsd) : null, liqAt: pool?.at ?? null, realizableUsd: rv === null ? null : r2(rv), realizablePct: rv === null || !cost ? null : r1((rv / cost - 1) * 100), openedAt: null };
    }));
  }
  return out;
}

const rugsOf = (closed: ClosedTrade[]) => closed.filter((c) => c.writtenOff || (fin(c.pnlPct) && c.pnlPct <= RUG_PCT) || (c.stuck && !c.writtenOff));

function fromLedger(id: string, m: MemberLedger, h: DashHome, fleetOpen: OpenPos[] | undefined, now: number): DashStrategy {
  const row = strategyRow(id, m, { now });
  // the engine's book is the live truth for what is open; the ledger fold is the fallback when no fleet status exists
  // a stuck bag the engine still holds but the ledger fold already wrote off is CLOSED here (at its realizable value),
  // so it is not listed open a second time
  const heldOff = new Set(m.writtenOff.filter((w) => w.held).map((w) => w.mint));
  const open: OpenPos[] = fleetOpen ? fleetOpen.filter((o) => !(o.stuck && heldOff.has(o.mint))) : m.openPositions.map((p) => ({ symbol: p.symbol, mint: p.mint, profile: p.profile, costUsd: p.costUsd, markUsd: null, markPct: null, stuck: p.stuckSince !== null, liqUsd: null, liqAt: null, realizableUsd: p.stuckSince !== null ? r2(p.realizedUsd) : null, realizablePct: null, openedAt: p.openedAt }));
  return { id, label: m.basedOn?.version ? `v${m.basedOn.version}` : '', group: h.label, source: 'autotrade', home: h.label, unit: 'USD', mode: m.mode, version: m.basedOn?.version ?? null, baseline: false,
    row, equity: equityCurve(m.closed, m.startUsd), trades: m.closed, open, rugs: rugsOf(m.closed), lastEventAt: m.lastT, firstEventAt: m.firstT };
}

function fromBook(b: Book, now: number): DashStrategy {
  const closed: ClosedTrade[] = (b.trades ?? []).filter((t) => fin(t.t) && fin(t.pnlPct)).map((t) => ({ t: t.t, openedAt: t.openedAt ?? null, mint: t.mint ?? null, symbol: t.symbol ?? null, pnlPct: t.pnlPct, pnlUsd: fin(t.pnl) ? t.pnl : fin(t.pnlUsd) ? t.pnlUsd : null,
    costUsd: fin(t.cost) ? t.cost : null, exitReason: t.exitReason ?? null, stuck: !!t.writtenOff, writtenOff: !!t.writtenOff, reason: t.reason, profile: t.profile ?? null, entryAgeMin: fin(t.entryAgeMin) ? t.entryAgeMin : null }))
    .sort((a, b2) => a.t - b2.t);
  const ts = closed.map((c) => c.openedAt ?? c.t);
  const firstT = fin(b.firstT) ? b.firstT : ts.length ? Math.min(...ts) : null;
  const open = (b.open ?? []).map((o): OpenPos => ({ symbol: o.symbol ?? null, mint: o.mint ?? null, profile: o.profile ?? null, costUsd: fin(o.cost) ? o.cost : null, markUsd: fin(o.mark) ? o.mark : null, markPct: fin(o.markPct) ? o.markPct : null, stuck: !!o.stuck,
    liqUsd: null, liqAt: null, realizableUsd: fin(o.realizable) ? o.realizable : null, realizablePct: fin(o.realizable) && fin(o.cost) && o.cost ? r1((o.realizable / o.cost - 1) * 100) : null, openedAt: o.openedAt ?? null }));
  const m = { entries: fin(b.entries) ? b.entries : closed.length + open.length, closed, open: open.length, writtenOff: closed.filter((c) => c.writtenOff), stuckOpen: [], abandoned: [], adopted: 0, firstT };
  return { id: b.id, label: b.label ?? '', group: b.group ?? 'books', source: 'book', home: b.group ?? 'books', unit: b.unit ?? 'USD', mode: b.mode ?? 'paper', version: b.version ?? null, baseline: false,
    row: strategyRow(b.id, m, { now }), equity: equityCurve(closed, fin(b.start) ? b.start : null), trades: closed, open, rugs: rugsOf(closed),
    lastEventAt: closed.length ? closed[closed.length - 1].t : firstT, firstEventAt: firstT };
}

export function readBooksFile(p: string): BooksFile | null {
  const j = readJson<BooksFile>(p);
  return j && j.schema === BOOKS_SCHEMA ? j : null;
}

/** Everything the dashboard shows, from the homes and books files given. */
export function collectDash({ homes, books = [], baseline = null, now = Date.now() }: { homes: DashHome[]; books?: string[]; baseline?: string | null; now?: number }): DashData {
  const strategies: DashStrategy[] = []; const status: StatusCard[] = []; const notes: string[] = [];
  const labels: Record<string, string> = {}; const groups: Record<string, string> = {}; let order: string[] = []; let base = baseline;
  for (const h of homes) {
    const runs = join(h.dir, 'autotrade', 'runs');
    if (!existsSync(runs)) { notes.push(`${h.label}: no autotrade run ledgers yet`); continue; }
    const M = readStrategyLedgers(runs, { now }); const fo = openFromFleet(h, now);
    for (const [id, m] of Object.entries(M)) strategies.push(fromLedger(id, m, h, fo.get(id), now));
    status.push(homeStatus(h, now));
  }
  for (const f of books) {
    const b = readBooksFile(f);
    if (!b) { notes.push(`books file ${basename(f)}: missing or not ${BOOKS_SCHEMA}`); continue; }
    for (const x of b.books ?? []) strategies.push(fromBook(x, now));
    Object.assign(labels, b.labels ?? {}); Object.assign(groups, b.groups ?? {}); if (b.order) order = [...order, ...b.order];
    base ??= b.baseline ?? null;
    status.unshift(...(b.status ?? [])); // the books' own cards first (what the user runs by hand)
    notes.push(...(b.notes ?? []));
  }
  for (const s of strategies) { if (labels[s.id]) s.label = labels[s.id]; if (groups[s.id]) s.group = groups[s.id]; s.baseline = s.id === base; }
  const rank = (id: string) => { const i = order.indexOf(id); return i < 0 ? 1e6 : i; };
  strategies.sort((a, b) => Number(b.baseline) - Number(a.baseline) || rank(a.id) - rank(b.id) || a.group.localeCompare(b.group) || a.id.localeCompare(b.id));
  const baseS = strategies.find((s) => s.baseline) ?? null;
  const pcts = (s: DashStrategy) => s.trades.map((c) => c.pnlPct).filter(fin);
  const comparisons = baseS ? strategies.filter((s) => s !== baseS).map((s) => compareToBase(s.id, pcts(s), baseS.id, pcts(baseS))) : [];
  return {
    schema: DASH_SCHEMA, generatedAt: now, paper: PAPER_LABEL,
    definitions: { minClosed: MIN_CLOSED, rugPct: RUG_PCT, writeOffMin: STUCK_WRITE_OFF_MIN, text: [
      `Closed = trades the engine closed plus stuck positions written off: no sell for >= ${STUCK_WRITE_OFF_MIN} min (or dropped stuck at a run end) closes at what was actually sold; the unsold rest counts 0.`,
      `Mean % on cost = the average return per closed trade, with a 95% bootstrap interval (4000 resamples). Wide interval = the data cannot tell yet.`,
      `Rug = a closed trade at ${RUG_PCT}% or worse on cost. Rug rate interval: Wilson 95%.`,
      `Under ${MIN_CLOSED} closed trades a strategy is EXPLORATORY: read nothing into it. ETA to ${MIN_CLOSED} = the closed trades still needed / entries per day so far.`,
      `Realizable = the engine's mark sold into the last pool read from the local cache (impact on half the liquidity, 2.3% fees and slippage); a stuck position is 0.`,
      `Equity = the starting book plus realized P/L in close order; drawdown is from the running peak.`,
    ] },
    baseline: baseS?.id ?? null, decisionRule: baseS ? decisionRule(baseS.id) : null, strategies, comparisons, status, notes,
  };
}
