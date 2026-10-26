// dexterm autotrade — the strategy JOURNEY (0.2.0 card C): a strategy built through chat climbs a ladder, and every
// rung needs evidence measured on THAT strategy's rules:
//
//   draft  ->  backtested  ->  forward-tested  ->  always-on (paper)  ->  real
//
//   backtested      a backtest on recorded history WITH the held-out split (the newest 30 % of coins never tuned on)
//   forward-tested  a forward test that ran its whole window: the same rules on the LIVE tape, on paper, own bankroll
//   always-on       a member of autotrade.json (the always-on service runs it on paper, card B)
//   real            mode real AND armed at this exact hash on the user's own terminal (card A's typed confirmation)
//
// Evidence binds to the RULES hash (the strategy minus id, name, description, version and mode), so renaming a
// strategy or arming it for real keeps its evidence, and any change to a rule starts the ladder again.
//
// The model can PROPOSE a promotion (a `dexterm-promotion-proposal/1` file with an evidence card); it can never apply
// one. Applying is the user's: `dexterm autotrade promote apply` (y on a real terminal, or the Q screen) for
// always-on, and card A's `dexterm autotrade signal arm` (evidence panel + typed phrase with a one-time code) for
// real. A promotion can never skip a rung, and real-mode caps are only ever set by the user (`signal caps set`).
//
// task-1679 (the 0.2.0 product decision, 2026-10-25): the EVIDENCE FLOOR for real. Promoting or arming for real needs a COMPLETED forward
// test of these exact rules with at least `minForwardTrades` closed paper trades (the user's limit, placeholder 10)
// AND a backtest on record. Below it the ladder refuses with a plain explanation; only the user can override it, by
// typing the phrase `signal arm` shows on a real terminal (journaled). No model, MCP tool or proposal can skip it.
//
// Verdict rule 6 (spec §3a) is the only path to gain wording: >= 20 trades in BOTH halves of the held-out split and a
// held-out net above 0. A forward test says plainly when its own sample is too small to claim anything.
//
// Files (all under $DEXTERM_HOME/autotrade/journey, 0700/0600):
//   <id>.json             dexterm-strategy-journey/1: backtest evidence, forward results, promotions (bounded lists)
//   journal.jsonl         append-only: every promotion proposed, applied or dismissed, by whom, at which hash
//   .proposals/<pp>.json  promotion proposals
// Nothing here holds a key, signs, touches a wallet or the network.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { SKILL_MIN_N } from '@dexterm/packs';
import { backtest, splitTape, type BacktestReport } from './backtest.ts';
import type { Fill } from './engine.ts';
import { fleetConfigPath, parseFleetConfig, MAX_MEMBERS } from './fleet-config.ts';
import { writeJsonAtomic } from './ledger.ts';
import { DEFAULT_LIMITS, effectiveLimits, loadLimits, raises } from './limits.ts';
import type { RunResult } from './runner.ts';
import type { Tape } from './replay.ts';
import type { SessionFactory } from './session.ts';
import { STRATEGY_ID } from './store.ts';
import { round, strategyHash, type ResolvedStrategy } from './strategy.ts';

export const JOURNEY_SCHEMA = 'dexterm-strategy-journey/1';
export const PROMOTION_SCHEMA = 'dexterm-promotion-proposal/1';
export const JOURNEY_STAGES = ['draft', 'backtested', 'forward-tested', 'always-on', 'real'] as const;
export type JourneyStage = (typeof JOURNEY_STAGES)[number];
/** The rungs a promotion proposal can ask for (the first three are reached by doing the work, not by a proposal). */
export const PROMOTION_TARGETS = ['always-on', 'real'] as const;
export type PromotionTarget = (typeof PROMOTION_TARGETS)[number];
export const EVIDENCE_MIN_N = SKILL_MIN_N;

export const journeyDir = (home: string): string => join(home, 'autotrade', 'journey');
export const journeyPath = (home: string, id: string): string => {
  if (!STRATEGY_ID.test(id)) throw new Error(`bad strategy id ${JSON.stringify(id)}`);
  return join(journeyDir(home), `${id}.json`);
};
export const journeyJournalPath = (home: string): string => join(journeyDir(home), 'journal.jsonl');
export const promotionsDir = (home: string): string => join(journeyDir(home), '.proposals');

/** The rules a piece of evidence was measured on: the strategy minus its labels, its version and its mode. */
export function rulesHash(s: ResolvedStrategy): string {
  const { id: _i, name: _n, description: _d, version: _v, mode: _m, hash: _h, ...rules } = s;
  return strategyHash(rules);
}

// ───────────────────────────── metrics (one shape for backtest and forward) ─────────────────────────────

export interface JourneyMetrics {
  trades: number;
  wins: number;
  losses: number;
  /** Percent, with the Wilson 95 % interval. */
  winRate: { value: number; lo: number; hi: number } | null;
  netUsd: number;
  netPct: number;
  maxDrawdownPct: number;
  /** Closed at <= -80 % or unsellable (the backtest's rug count). */
  rugs: number;
  rugRatePct: number | null;
  openAtEnd: number;
  /** Mean distance of the effective fill price from the mid price, in basis points (fees, slippage, impact). */
  fillCostBps: number | null;
  fills: number;
}

/** Every fill of a run: closed trades and positions still open at the end. */
export function runFills(run: Pick<RunResult, 'trades' | 'book'>): Fill[] {
  return [...run.trades.flatMap((t) => t.fills), ...[...run.book.open.values()].flatMap((p) => p.fills)];
}

export function fillCostBps(fills: readonly Fill[]): number | null {
  const xs = fills.filter((f) => f.price > 0 && f.avgPrice > 0).map((f) => Math.abs(f.avgPrice / f.price - 1) * 10_000);
  return xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length, 1) : null;
}

export function metricsOf(r: BacktestReport, fills: readonly Fill[]): JourneyMetrics {
  return {
    trades: r.trades, wins: r.wins, losses: r.losses, winRate: r.winRate, netUsd: r.netUsd, netPct: r.netPct, maxDrawdownPct: r.maxDrawdownPct,
    rugs: r.tail.rugs, rugRatePct: r.trades ? round((r.tail.rugs / r.trades) * 100, 1) : null, openAtEnd: r.openAtEnd,
    fillCostBps: fillCostBps(fills), fills: fills.length,
  };
}

export const usd = (x: number): string => `${x >= 0 ? '+' : '-'}$${Math.abs(x).toFixed(2)}`;
export const winText = (m: Pick<JourneyMetrics, 'winRate'>): string => (m.winRate ? `${m.winRate.value}% (95% ${m.winRate.lo}–${m.winRate.hi}%)` : '—');
export function metricsLine(m: JourneyMetrics): string {
  return `${m.trades} trades · win ${winText(m)} · net ${usd(m.netUsd)} (${m.netPct}%) · max drawdown ${m.maxDrawdownPct}% · rugs ${m.rugs}${m.rugRatePct === null ? '' : ` (${m.rugRatePct}%)`} · fill cost ${m.fillCostBps ?? '—'} bps`;
}

// ───────────────────────────── backtest evidence (held-out split) ─────────────────────────────

export interface BacktestEvidence {
  kind: 'backtest';
  t: number;
  /** Who ran it: `user`, `user:tui`, `analyst`, `mcp-agent` (the numbers are the engine's either way). */
  by: string;
  id: string;
  version: string;
  hash: string;
  rulesHash: string;
  days: number | null;
  tape: { source: string; mints: number; ticks: number; from: string | null; to: string | null };
  full: JourneyMetrics;
  heldOut: { cutoff: string | null; train: JourneyMetrics; test: JourneyMetrics };
  verdict: string;
  /** Verdict rule 6 passed: the only state in which gain wording is allowed. */
  claim: boolean;
}

/** Verdict rule 6 on one strategy's own split (no tuning involved). */
export function evidenceVerdict(train: Pick<JourneyMetrics, 'trades' | 'netUsd'>, test: Pick<JourneyMetrics, 'trades' | 'netUsd'>): { claim: boolean; verdict: string } {
  if (train.trades < EVIDENCE_MIN_N || test.trades < EVIDENCE_MIN_N) return { claim: false, verdict: `too few trades to claim anything (train ${train.trades}, held-out ${test.trades}; both need >= ${EVIDENCE_MIN_N})` };
  if (test.netUsd <= 0) return { claim: false, verdict: `no edge: the held-out net is ${usd(test.netUsd)} on ${test.trades} trades (train ${usd(train.netUsd)}); no gain claim` };
  return { claim: true, verdict: `held-out net ${usd(test.netUsd)} on ${test.trades} trades (train ${usd(train.netUsd)} on ${train.trades}): passes the evidence rule; a backtest is still not a prediction` };
}

/** The full backtest, then the strategy alone on each half of the chronological held-out split. */
export async function backtestEvidence(s: ResolvedStrategy, tape: Tape, o: { by: string; now?: number; days?: number | null; sessions?: SessionFactory | null; testFrac?: number; full?: { report: BacktestReport; run: RunResult } } = { by: 'user' }): Promise<{ evidence: BacktestEvidence; report: BacktestReport }> {
  const full = o.full ?? await backtest(s, tape, o.sessions ?? null);
  const { train, test, cutoff } = splitTape(tape, o.testFrac ?? 0.3);
  const tr = await backtest(s, train, o.sessions ?? null);
  const te = await backtest(s, test, o.sessions ?? null);
  const trainM = metricsOf(tr.report, runFills(tr.run));
  const testM = metricsOf(te.report, runFills(te.run));
  const v = evidenceVerdict(trainM, testM);
  return {
    report: full.report,
    evidence: {
      kind: 'backtest', t: o.now ?? Date.now(), by: o.by, id: s.id, version: s.version, hash: s.hash, rulesHash: rulesHash(s), days: o.days ?? null,
      tape: full.report.tape, full: metricsOf(full.report, runFills(full.run)),
      heldOut: { cutoff: cutoff ? new Date(cutoff).toISOString() : null, train: trainM, test: testM },
      verdict: v.verdict, claim: v.claim,
    },
  };
}

// ───────────────────────────── the journey file ─────────────────────────────

/** What a finished (or stopped) forward test leaves in the journey file. */
export interface ForwardResult {
  kind: 'forward';
  forwardId: string;
  id: string;
  version: string;
  rulesHash: string;
  startedAt: number;
  endedAt: number;
  /** done = its whole window ran; stopped = ended early (does not count as the rung); failed = the host died. */
  state: 'done' | 'stopped' | 'failed';
  endReason: string;
  window: { hours: number | null; trades: number | null };
  source: string;
  metrics: JourneyMetrics | null;
}

export interface PromotionLine { t: number; to: PromotionTarget; action: 'proposed' | 'applied' | 'dismissed'; by: string; proposalId: string; version: string; rulesHash: string; hash: string }

export interface JourneyFile {
  schema: typeof JOURNEY_SCHEMA;
  id: string;
  backtests: BacktestEvidence[];
  forwards: ForwardResult[];
  promotions: PromotionLine[];
}

const KEEP = { backtests: 12, forwards: 12, promotions: 60 } as const;

export function loadJourney(home: string, id: string): JourneyFile {
  const empty: JourneyFile = { schema: JOURNEY_SCHEMA, id, backtests: [], forwards: [], promotions: [] };
  const p = journeyPath(home, id);
  if (!existsSync(p)) return empty;
  try {
    const d = JSON.parse(readFileSync(p, 'utf8')) as Partial<JourneyFile>;
    if (d.schema !== JOURNEY_SCHEMA || d.id !== id) return empty;
    return { ...empty, backtests: Array.isArray(d.backtests) ? d.backtests : [], forwards: Array.isArray(d.forwards) ? d.forwards : [], promotions: Array.isArray(d.promotions) ? d.promotions : [] };
  } catch { return empty; }
}

function saveJourney(home: string, j: JourneyFile): void {
  mkdirSync(journeyDir(home), { recursive: true, mode: 0o700 });
  writeJsonAtomic(journeyPath(home, j.id), j);
}

export function recordBacktestEvidence(home: string, ev: BacktestEvidence): void {
  const j = loadJourney(home, ev.id);
  j.backtests = [ev, ...j.backtests].slice(0, KEEP.backtests);
  saveJourney(home, j);
}

export function recordForwardResult(home: string, r: ForwardResult): void {
  const j = loadJourney(home, r.id);
  j.forwards = [r, ...j.forwards.filter((x) => x.forwardId !== r.forwardId)].slice(0, KEEP.forwards);
  saveJourney(home, j);
}

function recordPromotion(home: string, id: string, line: PromotionLine): void {
  const j = loadJourney(home, id);
  j.promotions = [line, ...j.promotions].slice(0, KEEP.promotions);
  saveJourney(home, j);
  mkdirSync(journeyDir(home), { recursive: true, mode: 0o700 });
  appendFileSync(journeyJournalPath(home), `${JSON.stringify({ id, ...line })}\n`, { mode: 0o600 });
}

/** The newest backtest with the held-out split on exactly these rules. */
export function latestBacktest(j: JourneyFile, rules: string): BacktestEvidence | null {
  return j.backtests.find((b) => b.rulesHash === rules && b.heldOut) ?? null;
}

/** The newest forward test on these rules that ran its whole window. */
export function latestForward(j: JourneyFile, rules: string, o: { doneOnly?: boolean } = {}): ForwardResult | null {
  return j.forwards.find((f) => f.rulesHash === rules && (!o.doneOnly || f.state === 'done')) ?? null;
}

// ───────────────────────────── forward vs backtest ─────────────────────────────

export interface ComparisonRow { metric: string; backtest: string; heldOut: string; forward: string; note: string }
export interface Comparison { rows: ComparisonRow[]; verdict: string[]; claim: boolean; sampleOk: boolean }

/**
 * The forward test next to the backtest of the same rules. Plain words when a sample is too small: no rate is
 * compared below EVIDENCE_MIN_N forward trades, and gain wording needs rule 6 on the backtest AND a forward net > 0
 * on >= EVIDENCE_MIN_N trades.
 */
export function compareForward(bt: BacktestEvidence | null, fw: JourneyMetrics | null): Comparison {
  const verdict: string[] = [];
  const f = fw;
  const b = bt?.full ?? null;
  const h = bt?.heldOut.test ?? null;
  const cell = (m: JourneyMetrics | null, k: (m: JourneyMetrics) => string) => (m ? k(m) : '—');
  const rows: ComparisonRow[] = [
    { metric: 'trades', backtest: cell(b, (m) => String(m.trades)), heldOut: cell(h, (m) => String(m.trades)), forward: cell(f, (m) => String(m.trades)), note: '' },
    { metric: 'win rate (95% interval)', backtest: cell(b, winText), heldOut: cell(h, winText), forward: cell(f, winText), note: '' },
    { metric: 'net', backtest: cell(b, (m) => `${usd(m.netUsd)} (${m.netPct}%)`), heldOut: cell(h, (m) => `${usd(m.netUsd)} (${m.netPct}%)`), forward: cell(f, (m) => `${usd(m.netUsd)} (${m.netPct}%)`), note: '' },
    { metric: 'max drawdown', backtest: cell(b, (m) => `${m.maxDrawdownPct}%`), heldOut: cell(h, (m) => `${m.maxDrawdownPct}%`), forward: cell(f, (m) => `${m.maxDrawdownPct}%`), note: '' },
    { metric: 'rug rate', backtest: cell(b, (m) => (m.rugRatePct === null ? '—' : `${m.rugRatePct}% (${m.rugs})`)), heldOut: cell(h, (m) => (m.rugRatePct === null ? '—' : `${m.rugRatePct}% (${m.rugs})`)), forward: cell(f, (m) => (m.rugRatePct === null ? '—' : `${m.rugRatePct}% (${m.rugs})`)), note: '' },
    { metric: 'fill cost vs mid', backtest: cell(b, (m) => (m.fillCostBps === null ? '—' : `${m.fillCostBps} bps`)), heldOut: cell(h, (m) => (m.fillCostBps === null ? '—' : `${m.fillCostBps} bps`)), forward: cell(f, (m) => (m.fillCostBps === null ? '—' : `${m.fillCostBps} bps`)), note: '' },
  ];
  if (!bt) verdict.push('no backtest with the held-out split on these rules: nothing to compare against (backtest it first)');
  else verdict.push(`backtest: ${bt.verdict}`);
  const sampleOk = !!f && f.trades >= EVIDENCE_MIN_N;
  if (!f) verdict.push('no forward result yet');
  else if (!sampleOk) verdict.push(`forward: ${f.trades} closed trade${f.trades === 1 ? '' : 's'} is too small a sample to claim anything (it needs >= ${EVIDENCE_MIN_N}); read the counts, not the rates`);
  if (f && b && sampleOk) {
    // Win rate drift: the forward point estimate outside the backtest's interval (and the other way round).
    if (f.winRate && b.winRate && (f.winRate.value < b.winRate.lo || f.winRate.value > b.winRate.hi)) rows[1].note = 'outside the backtest interval';
    const dd = f.maxDrawdownPct - b.maxDrawdownPct;
    if (dd > 5) rows[3].note = `${round(dd, 1)} pts deeper than the backtest`;
    if (f.rugRatePct !== null && b.rugRatePct !== null && f.rugRatePct - b.rugRatePct > 10) rows[4].note = 'more rugs live than in the recorded history (the recorded rug rate is a floor)';
  }
  if (f && b && f.fillCostBps !== null && b.fillCostBps !== null) {
    const d = round(f.fillCostBps - b.fillCostBps, 1);
    rows[5].note = `drift ${d >= 0 ? '+' : ''}${d} bps${Math.abs(d) >= 25 ? ' (large)' : ''}`;
  }
  if (f && sampleOk) verdict.push(f.netUsd > 0 ? `forward net ${usd(f.netUsd)} on ${f.trades} trades (paper, live data, modelled fills)` : `forward net ${usd(f.netUsd)} on ${f.trades} trades: it lost money on live data`);
  const claim = !!bt?.claim && sampleOk && !!f && f.netUsd > 0;
  verdict.push(claim ? 'both halves of the evidence agree: gain wording is allowed, still with the trade counts next to it' : 'no performance claim: say the numbers and the trade counts, nothing more');
  return { rows, verdict, claim, sampleOk };
}

export function renderComparison(c: Comparison): string[] {
  const w = [24, 22, 22, 22];
  const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));
  return [
    `  ${pad('', w[0])} ${pad('backtest', w[1])} ${pad('held-out', w[2])} ${pad('forward', w[3])}`,
    ...c.rows.map((r) => `  ${pad(r.metric, w[0])} ${pad(r.backtest, w[1])} ${pad(r.heldOut, w[2])} ${pad(r.forward, w[3])}${r.note ? ` ${r.note}` : ''}`),
    ...c.verdict.map((v) => `  · ${v}`),
  ];
}

// ───────────────────────────── the ladder ─────────────────────────────

export interface FleetMemberRef { id: string; preset?: string; enabled: boolean; mode: string }
export interface Rung { stage: JourneyStage; ok: boolean; detail: string }
export interface JourneyView {
  id: string;
  version: string;
  hash: string;
  rulesHash: string;
  mode: string;
  /** The highest rung reached with every rung below it reached too. */
  stage: JourneyStage;
  rungs: Rung[];
  next: { stage: JourneyStage; how: string } | null;
  backtest: BacktestEvidence | null;
  forward: ForwardResult | null;
  /** The forward test running now on these rules, if any (filled in by the caller that can see the host). */
  member: FleetMemberRef | null;
  armed: boolean;
  notes: string[];
}

/** autotrade.json members that run this strategy (as written by the user or a promotion). */
export function fleetMembersFor(home: string, id: string): FleetMemberRef[] {
  const p = fleetConfigPath(home);
  if (!existsSync(p)) return [];
  let doc: unknown;
  try { doc = JSON.parse(readFileSync(p, 'utf8')); } catch { return []; }
  const c = parseFleetConfig(doc, p);
  if (!c.ok) return [];
  return c.config.strategies.filter((m) => m.preset === id).map((m) => ({ id: m.id, preset: m.preset, enabled: m.enabled, mode: m.mode }));
}

export function journeyView(home: string, s: ResolvedStrategy, o: { armedHash?: string | null; members?: FleetMemberRef[] } = {}): JourneyView {
  const rules = rulesHash(s);
  const j = loadJourney(home, s.id);
  const bt = latestBacktest(j, rules);
  const fwDone = latestForward(j, rules, { doneOnly: true });
  const fwAny = latestForward(j, rules);
  const members = o.members ?? fleetMembersFor(home, s.id);
  const member = members.find((m) => m.enabled && m.mode === 'paper') ?? null;
  const armed = s.mode === 'real' && !!o.armedHash && o.armedHash === s.hash;
  const notes: string[] = [];
  const rungs: Rung[] = [
    { stage: 'draft', ok: true, detail: `v${s.version} validates (mode ${s.mode})` },
    { stage: 'backtested', ok: !!bt, detail: bt ? `${new Date(bt.t).toISOString().slice(0, 16).replace('T', ' ')} UTC · ${metricsLine(bt.full)} · ${bt.verdict}` : 'no backtest with the held-out split on these rules' },
    { stage: 'forward-tested', ok: !!fwDone, detail: fwDone ? `${fwDone.forwardId} · ${fwDone.metrics ? metricsLine(fwDone.metrics) : 'no numbers'} · ${fwDone.endReason}` : fwAny ? `${fwAny.forwardId} ${fwAny.state} early (${fwAny.endReason}); only a forward test that runs its whole window counts` : 'no finished forward test on these rules' },
    { stage: 'always-on', ok: !!member, detail: member ? `autotrade.json member ${member.id} (paper; the always-on service runs it)` : 'not in autotrade.json' },
    { stage: 'real', ok: armed, detail: armed ? `armed at ${s.hash.slice(0, 8)} on the local terminal` : s.mode === 'real' ? 'mode real but NOT armed at this hash (any edit disarms)' : 'paper' },
  ];
  let reached = 0;
  for (let i = 1; i < rungs.length && rungs[i].ok; i++) reached = i;
  const stage = JOURNEY_STAGES[reached];
  // A rung above a missing one (e.g. armed without a forward test) is shown, never counted.
  for (let i = reached + 2; i < rungs.length; i++) if (rungs[i].ok) notes.push(`${rungs[i].stage} is set but ${JOURNEY_STAGES[reached + 1]} is missing: the ladder counts ${stage}`);
  if (s.mode === 'real' && member) notes.push(`real strategies do not run in the always-on paper service (one runner per machine): stop the service and run dexterm autotrade run ${s.id} --real`);
  const HOW: Record<JourneyStage, string> = {
    draft: '',
    backtested: `dexterm autotrade backtest ${s.id} (records the held-out split), or ask the analyst for strategy_backtest`,
    'forward-tested': `dexterm autotrade forward start ${s.id} --hours 24 (paper, live data, own bankroll), or ask the analyst to start one`,
    'always-on': `a promotion: dexterm autotrade promote ${s.id} --to always-on (the analyst can propose it; you apply it)`,
    real: `a promotion to real: set your limits (dexterm autotrade limits set), then dexterm autotrade signal arm ${s.id} on your own terminal (typed phrase)`,
  };
  const nextStage = reached + 1 < JOURNEY_STAGES.length ? JOURNEY_STAGES[reached + 1] : null;
  return { id: s.id, version: s.version, hash: s.hash, rulesHash: rules, mode: s.mode, stage, rungs, next: nextStage ? { stage: nextStage, how: HOW[nextStage] } : null, backtest: bt, forward: fwAny, member, armed, notes };
}

/** The held-out lines a backtest prints under its report. */
export function renderHeldOut(ev: BacktestEvidence): string[] {
  return [
    `  held-out split (newest 30% of coins, never tuned on; cutoff ${ev.heldOut.cutoff ?? '—'}):`,
    `    train     ${metricsLine(ev.heldOut.train)}`,
    `    held-out  ${metricsLine(ev.heldOut.test)}`,
    `  evidence: ${ev.verdict}`,
  ];
}

export function renderJourney(v: JourneyView): string[] {
  return [
    `JOURNEY ${v.id} v${v.version} (${v.hash.slice(0, 8)}, rules ${v.rulesHash.slice(0, 8)}) · stage ${v.stage.toUpperCase()}`,
    ...v.rungs.map((r) => `  ${r.ok ? '[x]' : '[ ]'} ${r.stage.padEnd(15)} ${r.detail}`),
    ...v.notes.map((n) => `  ! ${n}`),
    v.next ? `  next: ${v.next.stage} — ${v.next.how}` : '  top of the ladder (real). Caps, kill switch and receipts: dexterm autotrade signal status',
  ];
}

// ───────────────────────────── promotion proposals ─────────────────────────────

export type PromotionStatus = 'pending' | 'applied' | 'dismissed';
export interface PromotionProposal {
  schema: typeof PROMOTION_SCHEMA;
  proposalId: string;
  id: string;
  to: PromotionTarget;
  actor: string;
  createdAt: number;
  /** Model-authored (cleaned by the caller), display only. */
  why: string;
  version: string;
  hash: string;
  rulesHash: string;
  /** The evidence card: what the user sees before the keypress. */
  card: string[];
  status: PromotionStatus;
  resolvedAt?: number;
  resolvedBy?: string;
}

const PROMOTION_ID = /^pp_[a-z0-9]{6,12}_[a-f0-9]{8}$/;
export const isPromotionId = (x: unknown): x is string => typeof x === 'string' && PROMOTION_ID.test(x);
export const newPromotionId = (now = Date.now()): string => `pp_${now.toString(36)}_${randomBytes(4).toString('hex')}`;
export const MAX_PENDING_PROMOTIONS = 10;

export class PromotionFiles {
  readonly dir: string;
  constructor(home: string) { this.dir = promotionsDir(home); }
  private path(id: string): string { if (!isPromotionId(id)) throw new Error(`bad promotion id ${JSON.stringify(id)}`); return join(this.dir, `${id}.json`); }
  get(id: string): PromotionProposal | null {
    if (!isPromotionId(id) || !existsSync(this.path(id))) return null;
    try { const r = JSON.parse(readFileSync(this.path(id), 'utf8')) as PromotionProposal; return r.schema === PROMOTION_SCHEMA && r.proposalId === id ? r : null; } catch { return null; }
  }
  list(f: { status?: PromotionStatus; id?: string } = {}): PromotionProposal[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir).filter((x) => x.endsWith('.json')).map((x) => this.get(x.slice(0, -5))).filter((r): r is PromotionProposal => !!r && (!f.status || r.status === f.status) && (!f.id || r.id === f.id))
      .sort((a, b) => b.createdAt - a.createdAt);
  }
  write(r: PromotionProposal): void { mkdirSync(this.dir, { recursive: true, mode: 0o700 }); writeJsonAtomic(this.path(r.proposalId), r); }
}

/** The evidence card a promotion shows: the ladder, the backtest, the forward test and the comparison. */
export function evidenceCard(v: JourneyView, to: PromotionTarget): string[] {
  const fwM = v.forward?.metrics ?? null;
  const c = compareForward(v.backtest, v.forward?.state === 'done' ? fwM : null);
  return [
    `PROMOTE ${v.id} v${v.version} → ${to.toUpperCase()}${to === 'real' ? ' (LIVE TRADE FIRE signals to YOUR executor, which may spend real money)' : ' (paper, the always-on service)'}`,
    ...renderJourney(v).slice(1),
    '  evidence (paper; modelled fills; not a prediction, not financial advice):',
    ...renderComparison(c),
  ];
}

// ───────────────────────────── the evidence floor for real (task-1679) ─────────────────────────────

export const DEFAULT_MIN_FORWARD_TRADES = DEFAULT_LIMITS.minForwardTrades ?? 10;

/**
 * The user's floor for this strategy + account (limits.json `minForwardTrades`, the stricter scope wins; `off` = no
 * trade minimum, the completed forward test and the backtest are still required). Fails closed: a limits.json that
 * does not load, or one changed outside dexterm in a way that lowers a floor, counts at least the placeholder.
 */
export function minForwardTradesFor(home: string, strategyId: string, accountId = '-'): number {
  const lim = loadLimits(home);
  if (!lim.ok) return DEFAULT_MIN_FORWARD_TRADES;
  const v = effectiveLimits(lim.doc, { strategyId, accountId, mode: 'real' }).values.minForwardTrades ?? 0;
  return lim.unjournaled && raises(lim.unjournaled).length ? Math.max(v, DEFAULT_MIN_FORWARD_TRADES) : v;
}

export interface EvidenceFloor {
  ok: boolean;
  minTrades: number;
  /** The completed forward test with the most closed trades on these rules, if any. */
  forward: ForwardResult | null;
  backtest: BacktestEvidence | null;
  /** Plain sentences, one per thing that is missing. */
  problems: string[];
}

/** Does `s` have the evidence real needs? Measured on its RULES (any rule change starts again), from the journey file. */
export function evidenceFloor(home: string, s: ResolvedStrategy, minTrades: number): EvidenceFloor {
  const rules = rulesHash(s);
  const j = loadJourney(home, s.id);
  const bt = latestBacktest(j, rules);
  const done = j.forwards.filter((f) => f.rulesHash === rules && f.state === 'done');
  const best = done.reduce<ForwardResult | null>((a, f) => (!a || (f.metrics?.trades ?? 0) > (a.metrics?.trades ?? 0) ? f : a), null);
  const problems: string[] = [];
  if (!bt) problems.push(`no backtest on record for these rules: run dexterm autotrade backtest ${s.id} first`);
  if (!best) problems.push(`no COMPLETED forward test of these rules (one that ran its whole window on live data, on paper): dexterm autotrade forward start ${s.id} --hours 24`);
  else if ((best.metrics?.trades ?? 0) < minTrades) problems.push(`the completed forward test closed ${best.metrics?.trades ?? 0} paper trade${(best.metrics?.trades ?? 0) === 1 ? '' : 's'}; real needs at least ${minTrades} (your limit minForwardTrades): run a longer forward test`);
  return { ok: problems.length === 0, minTrades, forward: best, backtest: bt, problems };
}

export function renderFloor(f: EvidenceFloor): string[] {
  return f.ok
    ? [`  evidence  floor met: a completed forward test with ${f.forward?.metrics?.trades ?? 0} closed paper trades (at least ${f.minTrades}) and a backtest on record`]
    : [`  EVIDENCE FLOOR NOT MET (real needs a completed forward test with at least ${f.minTrades} closed paper trades and a backtest, on these exact rules):`, ...f.problems.map((p) => `    - ${p}`)];
}

export type PromotionCheck = { ok: true; view: JourneyView } | { ok: false; reason: 'skip-refused' | 'already' | 'bad-target' | 'mode' | 'evidence-floor'; why: string; view?: JourneyView; floor?: EvidenceFloor };

/** Can `s` be promoted to `to` now? Every rung below `to` must be reached; nothing is skipped. */
export function checkPromotion(home: string, s: ResolvedStrategy, to: string, o: { armedHash?: string | null; members?: FleetMemberRef[] } = {}): PromotionCheck {
  if (!(PROMOTION_TARGETS as readonly string[]).includes(to)) return { ok: false, reason: 'bad-target', why: `to must be one of ${PROMOTION_TARGETS.join(', ')} (backtested and forward-tested are reached by running them, not by a promotion)` };
  if (s.mode === 'live') return { ok: false, reason: 'mode', why: `${s.id} is mode live, which does not run (dexterm holds no key)` };
  const v = journeyView(home, s, o);
  const need = JOURNEY_STAGES.indexOf(to as JourneyStage);
  const have = JOURNEY_STAGES.indexOf(v.stage);
  if (have >= need) return { ok: false, reason: 'already', why: `${s.id} is already ${v.stage}`, view: v };
  if (have < need - 1) return { ok: false, reason: 'skip-refused', why: `${s.id} is ${v.stage}; ${to} needs ${JOURNEY_STAGES[need - 1]} first (no rung can be skipped): ${v.next?.how ?? ''}`.trim(), view: v };
  if (to === 'real') {
    const floor = evidenceFloor(home, s, minForwardTradesFor(home, s.id));
    if (!floor.ok) return { ok: false, reason: 'evidence-floor', why: `${s.id} is below the evidence floor for real: ${floor.problems.join('; ')}`, view: v, floor };
  }
  return { ok: true, view: v };
}

/** Write a pending promotion proposal (the model's path and the user's own `promote <id> --to`). Never applies. */
export function proposePromotion(home: string, s: ResolvedStrategy, to: string, o: { actor: string; why: string; now?: number; armedHash?: string | null; members?: FleetMemberRef[] }): { ok: true; proposal: PromotionProposal; duplicate: boolean } | { ok: false; reason: string; why: string } {
  const c = checkPromotion(home, s, to, o);
  if (!c.ok) return { ok: false, reason: c.reason, why: c.why };
  const files = new PromotionFiles(home);
  const pending = files.list({ status: 'pending' });
  const twin = pending.find((p) => p.id === s.id && p.to === to && p.hash === s.hash);
  if (twin) return { ok: true, proposal: twin, duplicate: true };
  if (pending.length >= MAX_PENDING_PROMOTIONS) return { ok: false, reason: 'too-many-pending', why: `${pending.length} promotions are already waiting for the user` };
  const t = o.now ?? Date.now();
  const p: PromotionProposal = {
    schema: PROMOTION_SCHEMA, proposalId: newPromotionId(t), id: s.id, to: to as PromotionTarget, actor: o.actor, createdAt: t, why: o.why.slice(0, 200) || '(no reason given)',
    version: s.version, hash: s.hash, rulesHash: c.view.rulesHash, card: evidenceCard(c.view, to as PromotionTarget), status: 'pending',
  };
  files.write(p);
  recordPromotion(home, s.id, { t, to: p.to, action: 'proposed', by: o.actor, proposalId: p.proposalId, version: s.version, rulesHash: p.rulesHash, hash: s.hash });
  return { ok: true, proposal: p, duplicate: false };
}

export function dismissPromotion(home: string, proposalId: string, by: string, now = Date.now()): PromotionProposal | null {
  const files = new PromotionFiles(home);
  const p = files.get(proposalId);
  if (!p || p.status !== 'pending') return null;
  const next: PromotionProposal = { ...p, status: 'dismissed', resolvedAt: now, resolvedBy: by };
  files.write(next);
  recordPromotion(home, p.id, { t: now, to: p.to, action: 'dismissed', by, proposalId, version: p.version, rulesHash: p.rulesHash, hash: p.hash });
  return next;
}

/**
 * Apply an ALWAYS-ON promotion: the strategy joins autotrade.json as a paper member (the always-on service runs it
 * from its next start). The caller is the user's keypress path only (`promote apply` on a real terminal, the Q
 * screen). The ladder is re-checked against the strategy as it is NOW (an edit since the proposal voids it).
 * A promotion to REAL is never applied here: it is card A's `signal arm` (typed phrase), which `markApplied` records.
 */
export function applyAlwaysOn(home: string, proposalId: string, s: ResolvedStrategy, o: { by: string; now?: number; members?: FleetMemberRef[] }): { ok: true; memberId: string; created: boolean } | { ok: false; why: string } {
  const files = new PromotionFiles(home);
  const p = files.get(proposalId);
  if (!p) return { ok: false, why: `no promotion ${proposalId}` };
  if (p.status !== 'pending') return { ok: false, why: `promotion ${proposalId} is ${p.status}` };
  if (p.to !== 'always-on') return { ok: false, why: `promotion ${proposalId} is to ${p.to}: real mode is armed only with dexterm autotrade signal arm ${p.id} on your own terminal` };
  if (s.id !== p.id || s.hash !== p.hash) return { ok: false, why: `${p.id} changed since the proposal (v${p.version} → v${s.version}); ask for a new one` };
  const c = checkPromotion(home, s, 'always-on', { members: o.members });
  if (!c.ok) return { ok: false, why: c.why };
  const path = fleetConfigPath(home);
  let doc: { schema: string; strategies: Record<string, unknown>[]; [k: string]: unknown };
  if (existsSync(path)) {
    try { doc = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { return { ok: false, why: `${path} is not JSON (${(e as Error).message}); fix it first` }; }
    if (!doc || !Array.isArray(doc.strategies)) return { ok: false, why: `${path} has no strategies list; fix it first` };
  } else doc = { schema: 'dexterm-autotrade/1', strategies: [] };
  const existing = doc.strategies.find((m) => m.preset === s.id);
  let memberId = s.id;
  let created = false;
  if (existing) { existing.enabled = true; memberId = String(existing.id); }
  else {
    if (doc.strategies.some((m) => m.id === s.id)) return { ok: false, why: `autotrade.json already has a member called ${s.id} running something else; rename it first` };
    if (doc.strategies.length >= MAX_MEMBERS) return { ok: false, why: `autotrade.json already lists ${doc.strategies.length} strategies (at most ${MAX_MEMBERS} run at once); remove one first` };
    doc.strategies.push({ id: s.id, preset: s.id });
    created = true;
  }
  const check = parseFleetConfig(doc, path);
  if (!check.ok) return { ok: false, why: `autotrade.json would not validate: ${check.errors.join('; ')}` };
  mkdirSync(join(home, 'autotrade'), { recursive: true, mode: 0o700 });
  writeJsonAtomic(path, doc);
  const now = o.now ?? Date.now();
  files.write({ ...p, status: 'applied', resolvedAt: now, resolvedBy: o.by });
  recordPromotion(home, s.id, { t: now, to: 'always-on', action: 'applied', by: o.by, proposalId, version: s.version, rulesHash: p.rulesHash, hash: s.hash });
  return { ok: true, memberId, created };
}

/** Record that a pending REAL promotion was carried out by card A's arm flow (the typed phrase already happened). */
export function markRealApplied(home: string, id: string, armedHash: string, version: string, by: string, now = Date.now()): string[] {
  const files = new PromotionFiles(home);
  const done: string[] = [];
  for (const p of files.list({ status: 'pending', id })) {
    if (p.to !== 'real') continue;
    files.write({ ...p, status: 'applied', resolvedAt: now, resolvedBy: by });
    recordPromotion(home, id, { t: now, to: 'real', action: 'applied', by, proposalId: p.proposalId, version, rulesHash: p.rulesHash, hash: armedHash });
    done.push(p.proposalId);
  }
  return done;
}
