// dexterm autotrade — STRATEGY STATS for the performance dashboard (task-1749). Read-only over the run ledgers
// ($DEXTERM_HOME/autotrade/runs/*.jsonl): no network, no model, no key, never writes.
//
// The definitions are the challenge control's (launch/send-out/challenge-100x/control/report.mjs + mine.mjs, task-1697 /
// task-1733), so the dashboard and the control report count the same things the same way:
//   entries   each position once across restarts (its first fill or adoption), keyed per run FILE + engine id
//   closed    `trade_closed` (deduped) + WRITE-OFFS: a position the engine marked `stuck` (no pool to sell into) with no
//             sell for >= 30 min, or dropped stuck at a clean run end, closes at its REALIZABLE value: the sells it made
//             are kept, the unsold remainder counts 0. Derived here; the engine's ledgers are never edited.
//   abandoned still open when a run ended cleanly and not stuck: the engine does not carry it, its outcome never enters
//             the closed sample
//   rugs      a closed position at <= -80% on cost (a write-off is a rug only at <= -80%)
//   mean      mean % on cost with a 95% seeded percentile bootstrap (4000 resamples, seed 7); a difference of two
//             strategies is a bootstrap of independent groups (seed 11); rates use the Wilson 95% interval
//   sample    under 20 closed is EXPLORATORY; the ETA to 20 closed = (20 - closed) / entries per day since the first event
// One difference from report.mjs (a fix, test/strategy-stats-1749.test.ts): the engine's crash recovery names an adopted
// position `<runId>/pN` while that run's own fills said `pN`; report.mjs keys `pN` and so counted an adopted position
// two or three times. Here `<runId>/pN` maps onto the position `pN` of the file `<runId>.jsonl`.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const RUG_PCT = -80;
export const MIN_CLOSED = 20;
export const STUCK_WRITE_OFF_MIN = 30;
const DAY = 86_400_000;

/** mulberry32: the seeded generator of control/mine.mjs (same seed, same intervals). */
export function rng(seed = 7): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
const pctile = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * s.length)))]; };

export interface Ci { n?: number; mean: number | null; lo: number | null; hi: number | null }
/** Mean with a 95% percentile-bootstrap interval (control/mine.mjs meanCi). */
export function meanCi(xs: number[], { B = 4000, seed = 7 } = {}): Ci {
  if (!xs.length) return { n: 0, mean: null, lo: null, hi: null };
  const r = rng(seed); const ms: number[] = [];
  for (let b = 0; b < B; b++) { let s = 0; for (let i = 0; i < xs.length; i++) s += xs[Math.floor(r() * xs.length)]; ms.push(s / xs.length); }
  return { n: xs.length, mean: mean(xs), lo: pctile(ms, 0.025), hi: pctile(ms, 0.975) };
}
/** Difference of means (a - b), independent groups, bootstrap 95% (control/mine.mjs diffCi). */
export function diffCi(a: number[], b: number[], { B = 4000, seed = 11 } = {}): Ci {
  if (!a.length || !b.length) return { mean: null, lo: null, hi: null };
  const r = rng(seed); const ds: number[] = [];
  for (let k = 0; k < B; k++) { let sa = 0, sb = 0; for (let i = 0; i < a.length; i++) sa += a[Math.floor(r() * a.length)]; for (let i = 0; i < b.length; i++) sb += b[Math.floor(r() * b.length)]; ds.push(sa / a.length - sb / b.length); }
  return { mean: mean(a) - mean(b), lo: pctile(ds, 0.025), hi: pctile(ds, 0.975) };
}
/** Wilson 95% interval for k of n, as fractions (control/mine.mjs wilson). */
export function wilsonCi(k: number, n: number): [number | null, number | null] {
  if (!n) return [null, null];
  const z = 1.96, p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [Math.max(0, (c - h) / d), Math.min(1, (c + h) / d)];
}

export interface ClosedTrade {
  t: number; openedAt: number | null; mint: string | null; symbol: string | null; pnlPct: number | null; pnlUsd: number | null;
  costUsd: number | null; exitReason: string | null; stuck: boolean; writtenOff?: boolean; held?: boolean; reason?: string;
  realizedUsd?: number; stuckSince?: number | null; profile?: string | null; entryAgeMin?: number | null; entryLiqUsd?: number | null; entryMcap?: number | null;
}
export interface Abandoned { positionId: string; mint: string | null; openedT: number | null; stoppedT: number | null; notCarried?: boolean }
export interface MemberLedger {
  files: number; entries: number; closed: ClosedTrade[]; open: number; stuckOpen: { positionId: string; mint: string | null; stuckSince: number }[];
  openPositions: { positionId: string; mint: string | null; symbol: string | null; openedAt: number | null; costUsd: number; realizedUsd: number; stuckSince: number | null; profile: string | null }[];
  abandoned: Abandoned[]; writtenOff: ClosedTrade[]; adopted: number; lastClampT: number | null; firstT: number | null; lastT: number | null; candidates: number;
  entryTimes: number[]; startUsd: number | null; mode: string | null; basedOn: { id?: string; version?: string; hash?: string } | null;
}

interface Pos {
  key: string; positionId: string; mint: string | null; symbol: string | null; firstT: number | null; costUsd: number; proceedsUsd: number;
  stuckSince: number | null; stuckWhy: string | null; lastSellT: number | null; profile: string | null;
}
interface MState { pos: Map<string, Pos>; openNow: Set<string>; closedKeys: Set<string>; local: Map<string, string>; file: string | null; carry: Set<string> }
type Ev = Record<string, any>;

/**
 * Every strategy (fleet member) in one runs directory, its positions tracked across run files (control/report.mjs
 * readMembers, rules in the header). `now` decides which stuck positions are already written off.
 */
export function readStrategyLedgers(runsDir: string, { now = Date.now(), writeOffMin = STUCK_WRITE_OFF_MIN } = {}): Record<string, MemberLedger> {
  const M: Record<string, MemberLedger> = {};
  if (!existsSync(runsDir)) return M;
  const symbols = new Map<string, string>(); // mint -> symbol, from the candidate lines (fills carry no symbol)
  const entryTick = new Map<string, Ev>(); // mint -> the candidate tick that preceded the entry (pool age, liquidity, mcap)
  const state: Record<string, MState> = {};
  const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
  for (const f of readdirSync(runsDir).filter((x) => x.endsWith('.jsonl') && !/-fleet-/.test(x)).sort()) {
    let member: string | null = null;
    let text: string; try { text = readFileSync(join(runsDir, f), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line) continue; let e: Ev; try { e = JSON.parse(line); } catch { continue; }
      if (e.kind === 'fleet_member' || e.kind === 'run_start') {
        member ??= e.member ?? e.strategy ?? null;
        if (member && !M[member]) {
          M[member] = { files: 0, entries: 0, closed: [], open: 0, stuckOpen: [], openPositions: [], abandoned: [], writtenOff: [], adopted: 0, lastClampT: null, firstT: null, lastT: null, candidates: 0, entryTimes: [], startUsd: null, mode: null, basedOn: null };
          state[member] = { pos: new Map(), openNow: new Set(), closedKeys: new Set(), local: new Map(), file: null, carry: new Set() };
        }
        if (member) {
          const m = M[member];
          if (fin(e.bankroll?.usd) && m.startUsd === null) m.startUsd = e.bankroll.usd;
          m.mode ??= e.mode ?? null; if (e.basedOn) m.basedOn = e.basedOn;
          if (state[member].file !== f) { state[member].file = f; state[member].local = new Map(); state[member].carry = new Set(state[member].openNow); m.files++; }
        }
        continue;
      }
      if (!member) continue;
      const m = M[member]; const s = state[member];
      if (typeof e.t === 'number') { m.firstT = m.firstT === null ? e.t : Math.min(m.firstT, e.t); m.lastT = m.lastT === null ? e.t : Math.max(m.lastT, e.t); }
      // a restart adopts what it carries at the head of its file; a position of the previous (crashed) file it did not
      // adopt is gone from the engine's book: "abandoned", not open forever
      if (s.carry.size && e.kind !== 'position_adopted') {
        for (const key of s.carry) { const p = s.pos.get(key)!; s.openNow.delete(key); m.abandoned.push({ positionId: p.positionId, mint: p.mint, openedT: p.firstT, stoppedT: e.t, notCarried: true, _p: p } as Abandoned); }
        s.carry.clear();
      }
      if (e.kind === 'clamp' && typeof e.t === 'number') m.lastClampT = Math.max(m.lastClampT ?? 0, e.t);
      if (e.kind === 'candidate') { m.candidates++; if (e.mint && e.symbol) symbols.set(e.mint, e.symbol); if (e.mint && e.tick) entryTick.set(e.mint, e.tick); continue; }
      // the open position of an earlier file this id + mint carries (an adoption), newest first; `<runId>/pN` names the
      // position pN of the file <runId>.jsonl exactly
      const carried = (id: string, mint?: string | null): string | null => {
        const slash = id.lastIndexOf('/');
        if (slash > 0) { const k = `${id.slice(0, slash)}.jsonl#${id.slice(slash + 1)}`; if (s.pos.has(k) && !s.closedKeys.has(k)) return k; }
        return [...s.openNow].reverse().find((k) => { const p = s.pos.get(k)!; return p.positionId === id && (!mint || !p.mint || p.mint === mint); }) ?? null;
      };
      const open = (id: string, mint: string | null | undefined, t: number | null, profile: string | null = null) => {
        const key = `${f}#${id}`;
        s.pos.set(key, { key, positionId: id, mint: mint ?? null, symbol: null, firstT: t, costUsd: 0, proceedsUsd: 0, stuckSince: null, stuckWhy: null, lastSellT: null, profile });
        s.openNow.add(key); s.local.set(id, key); m.entries++; if (t !== null) m.entryTimes.push(t); return key;
      };
      const keyOf = (id: string, mint: string | null | undefined, t: number | null, { create = true, profile = null as string | null } = {}) => {
        if (s.local.has(id)) return s.local.get(id)!;
        const c = carried(id, mint); if (c) { s.local.set(id, c); return c; }
        return create ? open(id, mint, t, profile) : null;
      };
      if (e.kind === 'position_adopted' && e.positionId) {
        const c = carried(e.positionId, e.mint);
        const key = c ?? open(e.positionId, e.mint, e.position?.openedAt ?? e.t); // its fills were in a file that is gone: it counts here
        s.carry.delete(key);
        s.local.set(e.positionId, key); m.adopted++;
        const p = s.pos.get(key)!; const snap = e.position ?? {};
        if (!c && fin(snap.costUsd)) p.costUsd = snap.costUsd;
        if (snap.stuck && p.stuckSince === null) p.stuckSince = e.t;
        p.symbol ??= e.symbol ?? null;
        continue;
      }
      if (e.kind === 'fill' && e.positionId) {
        const key = keyOf(e.positionId, e.mint, e.t, { profile: e.profile ?? null })!;
        if (s.closedKeys.has(key)) continue;
        const p = s.pos.get(key)!;
        p.profile ??= e.profile ?? null;
        if (e.side === 'sell') { p.proceedsUsd += fin(e.usd) ? e.usd : 0; p.lastSellT = e.t; p.stuckSince = null; p.stuckWhy = null; } // a sale ends a stuck spell
        else p.costUsd += fin(e.usd) ? e.usd : 0;
        continue;
      }
      if (e.kind === 'stuck' && e.positionId) {
        const key = keyOf(e.positionId, e.mint, e.t, { create: false }); const p = key && s.pos.get(key);
        if (p && p.stuckSince === null) { p.stuckSince = e.t; p.stuckWhy = `${e.reason ?? 'stuck'} (${e.why ?? 'cannot sell'})`; }
        continue;
      }
      if (e.kind === 'wake' && e.positionId && e.event === 'mechanical_exit') { // the engine's own words for the stuck exit
        const key = s.local.get(e.positionId); const p = key && s.pos.get(key);
        if (p && p.stuckSince === e.t && e.detail) p.stuckWhy = e.detail;
        continue;
      }
      if (e.kind === 'trade_closed' && e.trade) {
        const key = keyOf(e.trade.id, e.trade.mint, e.trade.openedAt ?? e.t)!;
        if (s.closedKeys.has(key)) continue;
        s.closedKeys.add(key); s.openNow.delete(key);
        const p = s.pos.get(key); const tick = e.trade.mint ? entryTick.get(e.trade.mint) : undefined;
        m.closed.push({ t: e.trade.closedAt ?? e.t, openedAt: e.trade.openedAt ?? null, mint: e.trade.mint ?? null, symbol: e.trade.symbol ?? null, pnlPct: e.trade.pnlPct, pnlUsd: e.trade.pnlUsd ?? null,
          costUsd: fin(e.trade.costUsd) ? e.trade.costUsd : p?.costUsd ?? null, exitReason: e.trade.exitReason ?? null, stuck: !!e.trade.stuck, profile: e.trade.profileId ?? p?.profile ?? null,
          entryAgeMin: fin(tick?.ageMin) ? tick!.ageMin : null, entryLiqUsd: fin(tick?.liq) ? tick!.liq : null, entryMcap: fin(tick?.mcap) ? tick!.mcap : null });
        continue;
      }
      if (e.kind === 'run_end') {
        for (const key of s.openNow) { const p = s.pos.get(key)!; m.abandoned.push({ positionId: p.positionId, mint: p.mint, openedT: p.firstT, stoppedT: e.t, _p: p } as Abandoned); }
        s.openNow.clear();
      }
    }
  }
  const writeOff = (m: MemberLedger, p: Pos, endT: number, how: string) => {
    const pnlUsd = Math.round((p.proceedsUsd - p.costUsd) * 1e4) / 1e4;
    const pnlPct = p.costUsd > 0 ? Math.round((pnlUsd / p.costUsd) * 1e4) / 100 : null;
    const tick = p.mint ? entryTick.get(p.mint) : undefined;
    const w: ClosedTrade = { t: p.stuckSince!, openedAt: p.firstT, mint: p.mint, symbol: p.symbol ?? (p.mint ? symbols.get(p.mint) ?? null : null), pnlPct, pnlUsd, costUsd: Math.round(p.costUsd * 1e4) / 1e4, realizedUsd: Math.round(p.proceedsUsd * 1e4) / 1e4,
      exitReason: 'written-off', stuck: true, writtenOff: true, held: how === 'still held', profile: p.profile,
      reason: `${how}: stuck ${Math.round((endT - p.stuckSince!) / 60_000)} min with no sell (${p.stuckWhy ?? 'illiquid'}); unsold remainder valued 0`, stuckSince: p.stuckSince,
      entryAgeMin: typeof tick?.ageMin === 'number' ? tick.ageMin : null, entryLiqUsd: typeof tick?.liq === 'number' ? tick.liq : null, entryMcap: typeof tick?.mcap === 'number' ? tick.mcap : null };
    m.writtenOff.push(w); if (pnlPct !== null) m.closed.push(w);
  };
  for (const [id, m] of Object.entries(M)) {
    const s = state[id];
    m.abandoned = m.abandoned.filter((a) => { const p = (a as any)._p as Pos; delete (a as any)._p; if (p.stuckSince === null) return true; writeOff(m, p, a.stoppedT ?? now, a.notCarried ? 'dropped stuck (not carried over by the restart)' : 'dropped stuck at a clean run end'); return false; });
    for (const key of s.openNow) {
      const p = s.pos.get(key)!;
      if (p.stuckSince !== null && now - p.stuckSince >= writeOffMin * 60_000) writeOff(m, p, now, 'still held');
      else {
        m.open++;
        m.openPositions.push({ positionId: p.positionId, mint: p.mint, symbol: p.symbol ?? (p.mint ? symbols.get(p.mint) ?? null : null), openedAt: p.firstT, costUsd: Math.round(p.costUsd * 1e4) / 1e4, realizedUsd: Math.round(p.proceedsUsd * 1e4) / 1e4, stuckSince: p.stuckSince, profile: p.profile });
        if (p.stuckSince !== null) m.stuckOpen.push({ positionId: p.positionId, mint: p.mint, stuckSince: p.stuckSince });
      }
    }
    for (const c of m.closed) c.symbol ??= c.mint ? symbols.get(c.mint) ?? null : null;
    m.closed.sort((a, b) => a.t - b.t);
  }
  return M;
}

/**
 * REALIZABLE value of an open position (agent-v4/scoreboard.mjs): the engine's mark sold into the pool with the
 * engine's cost model (constant-product impact on half the liquidity, fee + slippage bps, network fee). null = the
 * pool's liquidity is unknown.
 */
export function realizableUsd(markUsd: number, liqUsd: number | null | undefined, ex = { feeBps: 30, slippageBps: 200, networkFeeUsd: 0.02 }): number | null {
  if (!Number.isFinite(markUsd) || typeof liqUsd !== 'number' || !Number.isFinite(liqUsd) || liqUsd <= 0) return null;
  const side = liqUsd / 2; const impact = markUsd / (side + markUsd);
  return Math.max(0, markUsd * (1 - impact) * (1 - (ex.feeBps + ex.slippageBps) / 10_000) - ex.networkFeeUsd);
}

export interface EquityPoint { t: number; usd: number; drawdownPct: number }
/** The realized equity curve over the closed sample (start + cumulative P/L in close order) and its drawdown from the running peak. */
export function equityCurve(closed: ClosedTrade[], startUsd: number | null): { points: EquityPoint[]; maxDrawdownPct: number; start: number; end: number } {
  const start = startUsd ?? 100; let eq = start; let peak = start; let maxDd = 0;
  const points: EquityPoint[] = [];
  for (const c of [...closed].sort((a, b) => a.t - b.t)) {
    eq += typeof c.pnlUsd === 'number' && Number.isFinite(c.pnlUsd) ? c.pnlUsd : 0;
    peak = Math.max(peak, eq); const dd = peak > 0 ? (1 - eq / peak) * 100 : 0; maxDd = Math.max(maxDd, dd);
    points.push({ t: c.t, usd: Math.round(eq * 100) / 100, drawdownPct: Math.round(dd * 10) / 10 });
  }
  return { points, maxDrawdownPct: Math.round(maxDd * 10) / 10, start, end: Math.round(eq * 100) / 100 };
}

export interface StrategyRow {
  id: string; entries: number; closed: number; open: number; writtenOff: number; stuckOpen: number; abandoned: number; adopted: number;
  wins: number; losses: number; rugs: number; rugRate: number | null; rugCi: [number | null, number | null];
  meanPct: number | null; lo: number | null; hi: number | null; days: number; entriesPerDay: number | null; etaDays: number | null;
  sample: 'none' | 'exploratory' | 'minimum'; sampleText: string; realizedUsd: number;
  exits: { reason: string; n: number; meanPct: number | null; wins: number }[];
}

/** One strategy's row (control/report.mjs summarize: rugs, means, ETA), plus the exits breakdown and the sample badge. */
export function strategyRow(id: string, m: Pick<MemberLedger, 'entries' | 'closed' | 'open' | 'writtenOff' | 'stuckOpen' | 'abandoned' | 'adopted' | 'firstT'>, { now = Date.now(), minClosed = MIN_CLOSED } = {}): StrategyRow {
  const xs = m.closed.map((c) => c.pnlPct).filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  const rugs = m.closed.filter((c) => (c.pnlPct ?? 0) <= RUG_PCT || (c.stuck && !c.writtenOff)).length;
  const days = m.firstT === null ? 0 : (now - m.firstT) / DAY; const perDay = days > 0 ? m.entries / days : null;
  const ci = meanCi(xs);
  const by = new Map<string, number[]>();
  for (const c of m.closed) { const r = c.writtenOff ? 'written-off' : c.exitReason ?? 'unknown'; if (!by.has(r)) by.set(r, []); if (typeof c.pnlPct === 'number') by.get(r)!.push(c.pnlPct); }
  const exits = [...by].map(([reason, v]) => ({ reason, n: v.length, meanPct: v.length ? Math.round(mean(v) * 10) / 10 : null, wins: v.filter((x) => x > 0).length })).sort((a, b) => b.n - a.n);
  const sample = xs.length === 0 ? 'none' : xs.length < minClosed ? 'exploratory' : 'minimum';
  return {
    id, entries: m.entries, closed: xs.length, open: m.open, writtenOff: m.writtenOff.length, stuckOpen: m.stuckOpen.length, abandoned: m.abandoned.length, adopted: m.adopted,
    wins: xs.filter((x) => x > 0).length, losses: xs.filter((x) => x <= 0).length, rugs, rugRate: xs.length ? rugs / xs.length : null, rugCi: wilsonCi(rugs, xs.length),
    meanPct: ci.mean, lo: ci.lo, hi: ci.hi, days, entriesPerDay: perDay, etaDays: perDay ? Math.max(0, (minClosed - xs.length) / perDay) : null,
    sample, sampleText: sample === 'none' ? 'no closed trades yet' : sample === 'exploratory' ? `exploratory: ${xs.length} closed, < ${minClosed}` : `${xs.length} closed (>= ${minClosed})`,
    realizedUsd: Math.round(m.closed.reduce((s, c) => s + (typeof c.pnlUsd === 'number' ? c.pnlUsd : 0), 0) * 100) / 100, exits,
  };
}

/** The decision rule the control applies to a variant (control/report.mjs DECISION_RULE, baseline named). */
export const decisionRule = (base: string, minClosed = MIN_CLOSED) => `A filter or exit change is adopted only if it beats ${base} over >= ${minClosed} closed entries in BOTH strategies with the 95% interval of the difference in mean % per entry clear of zero (above 0). Until then nothing changes.`;

export interface Comparison { id: string; base: string; n: number; baseN: number; diff: Ci; enough: boolean; verdict: string }
/** A variant against the baseline (control/report.mjs verdicts). */
export function compareToBase(id: string, a: number[], base: string, b: number[], minClosed = MIN_CLOSED): Comparison {
  const d = diffCi(a, b); const enough = a.length >= minClosed && b.length >= minClosed;
  const verdict = !enough ? `not yet: ${a.length} / ${b.length} closed (needs ${minClosed} each)` : (d.lo ?? 0) > 0 ? 'passes the rule: beats the baseline' : (d.hi ?? 0) < 0 ? 'worse than the baseline' : 'no clear difference: keep running';
  return { id, base, n: a.length, baseN: b.length, diff: d, enough, verdict };
}
