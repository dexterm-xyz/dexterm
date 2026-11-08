// The factory's evidence (task-2159): the numbers the analyst gets, and the held-out numbers a candidate is judged on.
// Read-only: strategies, journeys, forward tests and run ledgers are read; the tape comes from the recorder read-only.
//
// Per-entry numbers use the every-candidate copy (backtest.ts everyCandidate: each candidate entered at a fixed unit,
// book caps lifted), the method of the task-2134 synthesis (research/strategy-synthesis-2026-11, appcheck2.mjs):
//   n            coins entered
//   meanPct      mean P/L per entry, net of the modelled costs (slippage, fee, network fee, impact)
//   lo, hi       seeded percentile-bootstrap 95% range of that mean (2,000 resamples)
//   mean2xPct    the same entries' mean with slippage, fee and network fee doubled
//   noTop3Pct    the mean without the three best entries
//   rugRatePct   entries closed at <= -80% or stuck unsellable

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { backtest, bootstrapMean, everyCandidate, RUG_PCT } from '../backtest.ts';
import { loadJourney, rulesHash } from '../journey.ts';
import type { RunResult } from '../runner.ts';
import { validateStrategy, type ResolvedStrategy, type Strategy } from '../strategy.ts';
import type { StrategyStore } from '../store.ts';
import { readStrategyLedgers, strategyRow } from '../strategy-stats.ts';
import type { Tape } from '../replay.ts';

export interface EntryStats {
  n: number;
  meanPct: number | null;
  lo: number | null;
  hi: number | null;
  mean2xPct: number | null;
  noTop3Pct: number | null;
  rugRatePct: number | null;
  wins: number;
}

const r1 = (x: number): number => Math.round(x * 10) / 10;
const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Per-coin P/L in % of the unit: closed trades plus anything open at the end at its liquidation mark. */
export function perCoinPct(run: Pick<RunResult, 'trades' | 'openAtEnd' | 'book'>, unitUsd: number): { pct: number[]; stuck: Set<string> } {
  const m = new Map<string, number>();
  const stuck = new Set<string>();
  for (const t of run.trades) { m.set(t.mint, (m.get(t.mint) ?? 0) + t.pnlUsd); if (t.stuck) stuck.add(t.mint); }
  const open = (run.book as unknown as { open?: Map<string, { realizedUsd?: number; costUsd?: number }> }).open;
  for (const p of run.openAtEnd) {
    const pos = open instanceof Map ? open.get(p.mint) : undefined;
    const pnl = pos ? p.markUsd + (pos.realizedUsd ?? 0) - (pos.costUsd ?? p.costUsd) : p.markUsd - p.costUsd;
    m.set(p.mint, (m.get(p.mint) ?? 0) + pnl);
    if (p.stuck) stuck.add(p.mint);
  }
  const pct: number[] = [];
  const stuckOut = new Set<string>();
  for (const [mint, usd] of m) { pct.push((usd / unitUsd) * 100); if (stuck.has(mint)) stuckOut.add(mint); }
  return { pct, stuck: stuckOut };
}

/** The same strategy with the cost model doubled (slippage, fee, network fee). Latency and impact cap unchanged. */
export function doubledCosts(s: ResolvedStrategy): ResolvedStrategy {
  const doc = JSON.parse(JSON.stringify({ ...s, hash: undefined, exits: { default: s.exits.default, profiles: Object.values(s.exits.profiles) } })) as Strategy;
  doc.execution = { ...doc.execution, slippageBps: doc.execution.slippageBps * 2, feeBps: doc.execution.feeBps * 2, networkFeeUsd: doc.execution.networkFeeUsd * 2 };
  const v = validateStrategy(doc);
  if (!v.ok) throw new Error(`2x-cost copy of ${s.id} is invalid: ${v.errors.map((e) => `${e.path} ${e.msg}`).join('; ')}`);
  return v.strategy;
}

/** The per-entry numbers of one strategy on one tape (two backtests: the costs as modelled, and doubled). */
export async function entryStats(s: ResolvedStrategy, tape: Tape, unitUsd = 20): Promise<EntryStats> {
  const base = await backtest(everyCandidate(s, unitUsd), tape);
  const { pct, stuck } = perCoinPct(base.run, unitUsd);
  const ci = bootstrapMean(pct, 2000, 7);
  let mean2x: number | null = null;
  if (pct.length) {
    const dbl = await backtest(everyCandidate(doubledCosts(s), unitUsd), tape);
    const m2 = mean(perCoinPct(dbl.run, unitUsd).pct);
    mean2x = m2 === null ? null : r1(m2);
  }
  const sorted = [...pct].sort((a, b) => b - a);
  const noTop3 = mean(sorted.slice(3));
  const rugs = pct.filter((x) => x <= RUG_PCT).length + [...stuck].length;
  return {
    n: pct.length,
    meanPct: ci ? r1(ci.meanPct) : null,
    lo: ci ? r1(ci.lo) : null,
    hi: ci ? r1(ci.hi) : null,
    mean2xPct: mean2x,
    noTop3Pct: noTop3 === null ? null : r1(noTop3),
    rugRatePct: pct.length ? r1((Math.min(rugs, pct.length) / pct.length) * 100) : null,
    wins: pct.filter((x) => x > 0).length,
  };
}

/** A compact, model-readable view of a strategy's rules (entry + exits; no caps, no agent, no execution). */
export function rulesView(s: ResolvedStrategy): Record<string, unknown> {
  return {
    screen: s.entry.screen,
    ageHours: s.entry.ageHours,
    safety: s.entry.safety,
    triggers: s.entry.triggers,
    triggerMode: s.entry.triggerMode,
    // An array, as in the inlined document the analyst's ops address (/exits/profiles/0/…).
    exits: { default: s.exits.default, profiles: Object.values(s.exits.profiles) },
  };
}

export interface ForwardEvidence { state: string; trades: number; netUsd: number | null; netPct: number | null; winRatePct: number | null; rugRatePct: number | null }
export interface LedgerEvidence { closed: number; meanPct: number | null; lo: number | null; hi: number | null; rugRatePct: number | null }

export interface EvidenceRow {
  /** A short reference the analyst cites numbers by (S1, S2, …). */
  ref: string;
  id: string;
  name: string;
  source: 'preset' | 'user' | 'generated';
  rulesHash: string;
  /** The every-candidate numbers on the evidence window. */
  backtest: EntryStats;
  forward: ForwardEvidence | null;
  /** Paper run ledgers of this strategy id under autotrade/runs (always-on / fleet runs), if any. */
  ledger: LedgerEvidence | null;
  rules: Record<string, unknown>;
  generated?: { parents: string[]; stage: string } | null;
}

export interface EvidenceTable {
  window: { from: string; to: string; days: number };
  heldOut: { from: string; to: string; days: number };
  tape: { mints: number; ticks: number };
  unitUsd: number;
  rows: EvidenceRow[];
}

export interface GatherOpts {
  store: StrategyStore;
  home: string;
  tape: Tape;
  window: { from: number; to: number };
  heldOut: { from: number; to: number };
  unitUsd: number;
  /** Ids of generated strategies (and their parents/stage), from the factory registry. */
  generated: Map<string, { parents: string[]; stage: string }>;
  /** Skip these ids (e.g. retired generated strategies). */
  skip?: Set<string>;
  now?: number;
  onProgress?: (id: string) => void;
}

/** Every strategy that validates (presets + the user's own), its evidence-window numbers, forward results and ledger. */
export async function gatherEvidence(o: GatherOpts): Promise<EvidenceTable> {
  const rows: EvidenceRow[] = [];
  const runsDir = join(o.home, 'autotrade', 'runs');
  let ledgers: ReturnType<typeof readStrategyLedgers> = {};
  // Paper ledgers and forward tests are read as they stood at the end of the evidence window: nothing from the held-out days.
  const until = o.window.to;
  if (existsSync(runsDir)) { try { ledgers = readStrategyLedgers(runsDir, { now: Math.min(o.now ?? Date.now(), until), until }); } catch { ledgers = {}; } }
  let i = 0;
  for (const e of o.store.list()) {
    if (!e.ok || o.skip?.has(e.id)) continue;
    if (e.mode && e.mode !== 'paper') continue;
    const got = o.store.get(e.id);
    if (!got || !got.ok) continue;
    const s = got.strategy;
    o.onProgress?.(s.id);
    const rh = rulesHash(s);
    const bt = await entryStats(s, o.tape, o.unitUsd);
    const j = loadJourney(o.home, s.id);
    const fw = j.forwards.find((f) => f.rulesHash === rh && f.endedAt <= until) ?? null; // newest first
    const lg = ledgers[s.id];
    const row = lg ? strategyRow(s.id, lg) : null;
    const gen = o.generated.get(s.id) ?? null;
    rows.push({
      ref: `S${++i}`,
      id: s.id,
      name: s.name,
      source: gen ? 'generated' : e.source,
      rulesHash: rh,
      backtest: bt,
      forward: fw ? { state: fw.state, trades: fw.metrics?.trades ?? 0, netUsd: fw.metrics?.netUsd ?? null, netPct: fw.metrics?.netPct ?? null, winRatePct: fw.metrics?.winRate?.value ?? null, rugRatePct: fw.metrics?.rugRatePct ?? null } : null,
      ledger: row && row.closed > 0 ? { closed: row.closed, meanPct: row.meanPct === null ? null : r1(row.meanPct), lo: row.lo === null ? null : r1(row.lo), hi: row.hi === null ? null : r1(row.hi), rugRatePct: row.rugRate === null ? null : r1(row.rugRate * 100) } : null,
      rules: rulesView(s),
      generated: gen,
    });
  }
  const iso = (t: number): string => new Date(t).toISOString().slice(0, 16) + 'Z';
  const days = (a: number, b: number): number => r1((b - a) / 86_400_000);
  return {
    window: { from: iso(o.window.from), to: iso(o.window.to), days: days(o.window.from, o.window.to) },
    heldOut: { from: iso(o.heldOut.from), to: iso(o.heldOut.to), days: days(o.heldOut.from, o.heldOut.to) },
    tape: { mints: o.tape.mints.length, ticks: o.tape.ticks.length },
    unitUsd: o.unitUsd,
    rows,
  };
}

/** The evidence table as the lines the analyst reads (numbers exactly as stored; the cross-check compares to these). */
export function evidenceText(t: EvidenceTable): string {
  const f = (x: number | null | undefined): string => (x === null || x === undefined ? 'n/a' : String(x));
  const out: string[] = [
    `Evidence window ${t.window.from} to ${t.window.to} (${t.window.days} days), ${t.tape.mints} coins on the tape. Every-candidate mode: each candidate entered at $${t.unitUsd}, book caps lifted, modelled fills (slippage, fee, network fee, impact).`,
    `The newest ${t.heldOut.days} days are held back (not shown to you) and the candidate is tested on them afterwards.`,
    '',
    'Cite a number as {"ref": "<row>.<key>", "value": <the number as shown>}. Keys: n, meanPct, lo, hi (the 95% range), mean2xPct (mean at 2x costs), noTop3Pct (mean without the top 3), rugRatePct, wins; forward.trades, forward.netPct, forward.netUsd, forward.winRatePct, forward.rugRatePct; ledger.closed, ledger.meanPct, ledger.lo, ledger.hi, ledger.rugRatePct. Example: S2.mean2xPct. Also citable: window.days, heldOut.days, tape.mints, unitUsd.',
    '',
    'ref | id | source | entries n | mean %/entry | 95% range | mean at 2x costs | mean without top 3 | rug rate % | forward test | paper ledger',
  ];
  for (const r of t.rows) {
    const b = r.backtest;
    const fw = r.forward ? `${r.forward.state}, ${r.forward.trades} trades, net ${f(r.forward.netPct)}%, win ${f(r.forward.winRatePct)}%, rug ${f(r.forward.rugRatePct)}%` : 'none';
    const lg = r.ledger ? `${r.ledger.closed} closed, mean ${f(r.ledger.meanPct)}% (${f(r.ledger.lo)} to ${f(r.ledger.hi)}), rug ${f(r.ledger.rugRatePct)}%` : 'none';
    out.push(`${r.ref} | ${r.id} | ${r.source}${r.generated ? ` (parents ${r.generated.parents.join('+') || '-'}, ${r.generated.stage})` : ''} | ${b.n} | ${f(b.meanPct)} | ${f(b.lo)} to ${f(b.hi)} | ${f(b.mean2xPct)} | ${f(b.noTop3Pct)} | ${f(b.rugRatePct)} | ${fw} | ${lg}`);
  }
  out.push('', 'Rules of each strategy (entry + exits; caps, sizing, agent and the fill model are not yours to change):');
  for (const r of t.rows) out.push(`${r.ref} ${r.id}: ${JSON.stringify(r.rules)}`);
  return out.join('\n');
}

/** Every number in the evidence (the cross-check's allow-list), keyed `S1.meanPct` etc. */
export function evidenceNumbers(t: EvidenceTable): Map<string, number> {
  const m = new Map<string, number>();
  const put = (k: string, v: number | null | undefined): void => { if (typeof v === 'number' && Number.isFinite(v)) m.set(k, v); };
  put('window.days', t.window.days); put('heldOut.days', t.heldOut.days); put('tape.mints', t.tape.mints); put('unitUsd', t.unitUsd);
  for (const r of t.rows) {
    for (const [k, v] of Object.entries(r.backtest)) put(`${r.ref}.${k}`, v as number | null);
    if (r.forward) for (const [k, v] of Object.entries(r.forward)) if (typeof v === 'number') put(`${r.ref}.forward.${k}`, v);
    if (r.ledger) for (const [k, v] of Object.entries(r.ledger)) put(`${r.ref}.ledger.${k}`, v);
  }
  return m;
}
