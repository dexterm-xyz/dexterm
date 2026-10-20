// dexterm — the ANALYST panel's BRAIN VIEW (task-1473). While the app runs in an auto mode, i.e. it follows an agent
// driving dexterm (`--spectate-mcp`, the task-1466 HUD) or AI scan mode is on, the analyst panel on the token screen
// shows what the auto mode is thinking instead of the "press a for a dossier" help. Top to bottom:
//   1. REASONING: the agent's thoughts (thoughts feed) typing in with a clock and the phase tag, newest at the bottom,
//      older lines dimmed. Without a thoughts feed, dexterm's own narration of each call, labelled as such. In scan
//      mode: the scan's own log plus the scan analyst's answer.
//   2. VETTING $SYM: the checklist for the coin in focus, each box with the number the app computed and pass / warn /
//      fail / pending (pending = the number is not in yet). A ◆ marks the checks the agent itself ran.
//   3. DATA: mcap, price, liquidity, 5m / 1h, buy/sell flow, holders, and a candle trace.
//   4. PLAN · POSITION (only while a PAPER ticket / position exists): entry, size, TP / stop, mark PnL, peak, time held,
//      what it is waiting for.
//   5. DECISIONS: the session log (passed X because…, rejected Y, entered Z) and the scoreboard (PAPER, simulated).
// Every number comes from data the app already holds (the story folded from spectator records, the token view on
// screen, the scan engine). Nothing here fetches, and nothing here can arm, sign, size, confirm or raise a cap: the
// panel has no input. Agent text arrives scrubbed and clipped (story.ribbonText) with addresses shortened.
// Smaller panels drop blocks in priority order (decisions, then data, then the vetting list folds to two columns);
// calm mode shows the same information with no typing; NO_COLOR keeps meaning in glyphs (✓ ! ✗ · ◆ ❯ ›).

import { mix, clock, decryptText, fmtUsd, fmtPrice, fmtNum, wrap, type Canvas, type Hex, type Style, type ColorDepth } from '@dexterm/tui';
import type { FixtureToken } from '../fixtures.ts';
import type { TokenView } from '../live/token.ts';
import { ribbonText, ribbonLines, fmtPx, type StoryView, type StoryPhase, type Thought, type TradeArc, type Decision, type SessionScore } from '@dexterm/agents';

export type Level = 'ok' | 'warn' | 'bad' | 'na';
export type BrainMode = 'agent' | 'scan';
export type CheckState = 'pass' | 'warn' | 'fail' | 'pending';

/** The coin numbers the brain view reads (adapted from a fixture token or the live token view; never fetched). */
export interface CoinFacts {
  mint: string;
  symbol: string;
  price: number | null;
  mcap: number | null;
  liq: number | null;
  chg5m: number | null;
  chg1h: number | null;
  buys: number | null;
  sells: number | null;
  /** Distinct wallets on the tape the app holds. */
  wallets: number | null;
  holders: number | null;
  top10: number | null;
  mintAuth: boolean | null;
  freezeAuth: boolean | null;
  lpLocked: number | null;
  /** The dev-history row the ON-CHAIN panel shows ([value, level]). */
  dev: [string, Level] | null;
  /** RugCheck score 0..100 (the screen's), used when no rug heuristic ran. */
  rugScore: number | null;
  /** An existing LARP-detector verdict for the mint (task-1315), when one exists. */
  larpVerdict: string | null;
  /** Candle closes, oldest first (the trace). */
  closes: number[];
}

export interface StreamLine {
  t: number;
  clock: string;
  tag: string;
  text: string;
  /** agent = the agent's own words · narration = dexterm's line about a call · scan = the scan's own log. */
  kind: 'agent' | 'narration' | 'scan';
  demo: boolean;
}

export interface VetRow { key: string; label: string; value: string; state: CheckState; byAgent: boolean }
export interface DataCell { k: string; v: string; dir?: 1 | -1 | 0 }
export interface PlanVM {
  symbol: string;
  stage: TradeArc['stage'];
  entry: string;
  size: string;
  tp: string;
  stop: string;
  pnlPct: number | null;
  pnlUsd: number | null;
  peakPct: number | null;
  ddPct: number | null;
  heldMs: number | null;
  mark: string;
  waiting: string;
  trace: number[];
  /** A fresh desk refusal on the open position (stamped for 3.5 s, like the HUD's position card). */
  refused: string | null;
}
export interface LogLine { t: number; clock: string; glyph: string; level: Level; symbol: string; text: string; said: string | null }

export interface BrainModel {
  mode: BrainMode;
  title: string;
  /** Who is talking: 'thoughts feed', 'dexterm narration · no thoughts feed', 'scan log + analyst'. */
  streamLabel: string;
  demo: boolean;
  stream: StreamLine[];
  /** The live status line under the stream (scan engine note, agent control state). */
  status: string | null;
  coin: { symbol: string; mint: string } | null;
  vet: VetRow[];
  data: DataCell[];
  closes: number[];
  plan: PlanVM | null;
  log: LogLine[];
  score: string | null;
}

// ---------------------------------------------------------------------------------------------------------------
// formatting (deterministic, no locale)

const sgnPct = (p: number, d = 1): string => `${p >= 0 ? '+' : '−'}${Math.abs(p).toFixed(d)}%`;
const sgnRatio = (r: number, d = 1): string => sgnPct(r * 100, d);
const sgnSol = (s: number): string => `${s >= 0 ? '+' : '−'}${Math.abs(s).toFixed(4)} SOL`;
const sgnUsd = (n: number): string => `${n >= 0 ? '+' : '−'}$${Math.abs(n).toFixed(2)}`;
export function fmtDur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}
const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s);

export const PHASE_TAG: Record<StoryPhase, string> = {
  idle: 'IDLE', scanning: 'SCANNING', vetting: 'VETTING', sizing: 'SIZING', executing: 'EXECUTING', holding: 'HOLDING', exiting: 'EXITING',
};

// ---------------------------------------------------------------------------------------------------------------
// auto-mode detection

/** How long after the agent's last call the brain view stays up (a holding agent polls far more often). */
export const AGENT_QUIET_MS = 180_000;

/**
 * Whether the agent-follow brain view applies: following, not killed, and the agent has acted recently (or holds a
 * position). Before the first call, after a kill, or once the agent has gone quiet, the normal analyst panel returns.
 */
export function agentBrainActive(v: StoryView | null | undefined, now: number): boolean {
  if (!v || v.control === 'killed') return false;
  if (v.arc && (v.arc.stage === 'open' || v.arc.stage === 'ticket' || v.arc.stage === 'sized')) return true;
  return v.lastCallAt !== null && now - v.lastCallAt < AGENT_QUIET_MS;
}

// ---------------------------------------------------------------------------------------------------------------
// facts adapters (the numbers the token screen already holds)

const distinct = (xs: readonly string[]): number => new Set(xs).size;

export function factsFromFixture(tk: FixtureToken, larpVerdict: string | null = null): CoinFacts {
  const buys = tk.trades.filter((x) => x.side === 'buy').length;
  return {
    mint: tk.mint, symbol: tk.symbol, price: tk.price, mcap: tk.mcap, liq: tk.liq, chg5m: tk.chg.m5, chg1h: tk.chg.h1,
    buys: tk.trades.length ? buys : null, sells: tk.trades.length ? tk.trades.length - buys : null,
    wallets: tk.trades.length ? distinct(tk.trades.map((x) => x.addr)) : null, holders: tk.holders, top10: tk.top10,
    mintAuth: tk.mintAuth, freezeAuth: tk.freezeAuth, lpLocked: tk.lpLocked,
    dev: [`${tk.devHistory.launches} launches · ${tk.devHistory.rugged} rugs`, tk.devHistory.rugged ? 'warn' : 'ok'],
    rugScore: tk.rug.score, larpVerdict, closes: tk.candles.map((k) => k.c),
  };
}

/** From the live token view. `extra` carries what the screen derived this frame (top-10 ex-pool, the dev row). */
export function factsFromView(v: TokenView, extra: { top10?: number | null; dev?: [string, Level] | null; larpVerdict?: string | null; price?: number | null } = {}): CoinFacts {
  const tr = v.trades;
  const buys = tr.filter((x) => x.side === 'buy').length;
  return {
    mint: v.mint, symbol: v.symbol, price: extra.price ?? v.price, mcap: v.mcap, liq: v.liq, chg5m: v.chg.m5, chg1h: v.chg.h1,
    buys: tr.length ? buys : null, sells: tr.length ? tr.length - buys : null, wallets: tr.length ? distinct(tr.map((x) => x.wallet)) : null,
    holders: v.holders, top10: extra.top10 ?? v.top10, mintAuth: v.mintAuth, freezeAuth: v.freezeAuth, lpLocked: v.lpLocked,
    dev: extra.dev ?? (v.devMints === null ? null : [`${v.devMints} mints by dev (jup)`, v.devMints > 3 ? 'warn' : 'ok']),
    rugScore: v.rug?.score ?? null, larpVerdict: extra.larpVerdict ?? null, closes: v.candles.map((k) => k.c),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// 1) reasoning stream

/** Agent thoughts and dexterm narration, newest last (≤ max). */
export function agentStream(v: StoryView, tz: string | undefined, max = 24): { lines: StreamLine[]; label: string; demo: boolean } {
  const hasAgent = v.thoughts.some((x) => x.source === 'agent');
  const lines = v.thoughts.slice(-max).map((x: Thought): StreamLine => ({
    t: x.t, clock: clock(new Date(x.t), tz), tag: PHASE_TAG[x.phase ?? 'idle'], text: x.text,
    kind: x.source === 'agent' ? 'agent' : 'narration', demo: !!x.demo,
  }));
  const demo = lines.some((l) => l.demo);
  return { lines, label: hasAgent ? 'agent thoughts + dexterm narration' : 'dexterm narration · no thoughts feed', demo };
}

/** One entry of the AI scan's own log (scan/ui.ts ScanUi.log). */
export interface ScanLogEntry { t: number; kind: 'start' | 'lock' | 'refresh' | 'release' | 'stop' | 'cancel' | 'blocked'; symbol: string; text: string }
/** The slice of the scan analyst's session the stream reads (an AnalystSession satisfies it). */
export interface ScanAnswer { status: string; text: string; toolLines: string[]; verdict: string | null; startedAt: number; doneAt: number | null }

const SCAN_TAG: Record<ScanLogEntry['kind'], string> = { start: 'SCANNING', lock: 'LOCKED', refresh: 'READING', release: 'SCANNING', stop: 'OFF', cancel: 'PAUSED', blocked: 'BLOCKED' };

/** The scan's log lines plus the analyst's current answer (tool lines, then its sentences), newest last. */
export function scanStream(log: readonly ScanLogEntry[], answer: ScanAnswer | null, tz: string | undefined, max = 24): StreamLine[] {
  const out: StreamLine[] = log.map((e) => ({ t: e.t, clock: clock(new Date(e.t), tz), tag: SCAN_TAG[e.kind], text: ribbonText(`${e.symbol ? `$${e.symbol} · ` : ''}${e.text}`, 140), kind: 'scan', demo: false }));
  if (answer) {
    const t0 = answer.startedAt;
    answer.toolLines.slice(-4).forEach((tl, i) => out.push({ t: t0 + i, clock: clock(new Date(t0), tz), tag: 'READING', text: ribbonText(`↳ ${tl}`, 120), kind: 'narration', demo: false }));
    const tEnd = answer.doneAt ?? t0 + 5;
    for (const s of ribbonLines(answer.text, 140, 6)) out.push({ t: tEnd, clock: clock(new Date(tEnd), tz), tag: answer.status === 'done' ? 'READ' : 'READING', text: s, kind: 'agent', demo: false });
    if (answer.verdict) out.push({ t: tEnd + 1, clock: clock(new Date(tEnd), tz), tag: 'VERDICT', text: ribbonText(`verdict ${answer.verdict}`, 60), kind: 'agent', demo: false });
  }
  out.sort((a, b) => a.t - b.t);
  return out.slice(-max);
}

// ---------------------------------------------------------------------------------------------------------------
// 2) vetting checklist

/** The app's liquidity floor (the AI scan's minimum liquidity, DEFAULT_SCAN_CONFIG.minLiqUsd). */
export const LIQ_FLOOR_USD = 10_000;

const st = (l: Level): CheckState => (l === 'ok' ? 'pass' : l === 'warn' ? 'warn' : l === 'bad' ? 'fail' : 'pending');

/**
 * The checklist for the coin in focus. Values and thresholds are the token screen's (ON-CHAIN panel); a box is
 * `pending` until its number exists. `focus` adds what the agent's own checks returned (verdict, rug heuristic,
 * LARP flags) and which checks it ran (◆).
 */
export function vetRows(f: CoinFacts, focus: StoryView['focus'] | null, floorUsd = LIQ_FLOOR_USD): VetRow[] {
  const ran = new Set(focus && focus.mint === f.mint ? focus.checks : []);
  const fc = focus && focus.mint === f.mint ? focus : null;
  const rows: VetRow[] = [];
  // momentum
  {
    const a = f.chg5m, b = f.chg1h;
    const lvl: Level = a === null && b === null ? 'na' : (a ?? 0) > 0 && (b ?? 0) > 0 ? 'ok' : (a ?? 0) < 0 && (b ?? 0) < 0 ? 'bad' : 'warn';
    rows.push({ key: 'momentum', label: 'momentum', value: a === null && b === null ? '—' : `5m ${a === null ? '—' : sgnPct(a)} · 1h ${b === null ? '—' : sgnPct(b)}`, state: st(lvl), byAgent: ran.has('chart') || ran.has('price') });
  }
  // liquidity vs floor
  rows.push({ key: 'liquidity', label: 'liquidity', value: f.liq === null ? '—' : `${fmtUsd(f.liq, { digits: 1 })} ${f.liq >= floorUsd ? '≥' : '<'} ${fmtUsd(floorUsd, { digits: 0 })} floor`, state: f.liq === null ? 'pending' : f.liq >= floorUsd ? 'pass' : 'fail', byAgent: ran.has('price') });
  // tape
  {
    const b = f.buys, s = f.sells;
    const lvl: Level = b === null || s === null ? 'na' : b >= s ? 'ok' : s > b * 2 ? 'bad' : 'warn';
    rows.push({ key: 'tape', label: 'tape b/s', value: b === null || s === null ? '—' : `${b} buys / ${s} sells${f.wallets !== null ? ` · ${f.wallets} wallets` : ''}`, state: st(lvl), byAgent: ran.has('tape') });
  }
  // holders
  rows.push({ key: 'holders', label: 'top-10 hold', value: f.top10 === null ? '—' : `${f.top10.toFixed(1)}%`, state: f.top10 === null ? 'pending' : f.top10 < 25 ? 'pass' : f.top10 < 35 ? 'warn' : 'fail', byAgent: ran.has('holders') });
  // authorities
  {
    const m = f.mintAuth, z = f.freezeAuth;
    const lvl: Level = m === null && z === null ? 'na' : m || z ? 'bad' : m === null || z === null ? 'warn' : 'ok';
    rows.push({ key: 'auth', label: 'mint/freeze', value: m === null && z === null ? '—' : `mint ${m === null ? '—' : m ? 'ENABLED' : 'revoked'} · freeze ${z === null ? '—' : z ? 'ENABLED' : 'revoked'}`, state: st(lvl), byAgent: ran.has('rug') });
  }
  // LP lock
  rows.push({ key: 'lp', label: 'LP lock', value: f.lpLocked === null ? '—' : `${Math.round(f.lpLocked)}% locked/burned`, state: f.lpLocked === null ? 'pending' : f.lpLocked >= 90 ? 'pass' : 'fail', byAgent: ran.has('rug') });
  // dev history
  rows.push({ key: 'dev', label: 'dev history', value: f.dev ? f.dev[0] : '—', state: f.dev ? st(f.dev[1]) : 'pending', byAgent: ran.has('dev') });
  // LARP flags: the agent's larp_check evidence first, else an existing detector verdict
  if (fc?.larp) {
    const n = fc.larp.flags;
    rows.push({ key: 'larp', label: 'LARP flags', value: `${n} flag${n === 1 ? '' : 's'}${fc.larp.items[0] ? ` · ${fc.larp.items[0]}` : ''}`, state: n === 0 ? 'pass' : n <= 2 ? 'warn' : 'fail', byAgent: true });
  } else {
    const v = f.larpVerdict;
    const lvl: Level = !v ? 'na' : v === 'LARP' ? 'bad' : v === 'REAL_PRODUCT' || v === 'EARLY_BUT_REAL' ? 'ok' : 'warn';
    rows.push({ key: 'larp', label: 'LARP flags', value: v ? `detector: ${v.replace(/_/g, ' ').toLowerCase()}` : '—', state: st(lvl), byAgent: ran.has('larp') });
  }
  // rug heuristic (the analyze_token pre-registered heuristic) or the RugCheck score
  if (fc?.verdict?.rug != null) {
    const r = fc.verdict.rug;
    rows.push({ key: 'rug', label: 'rug heuristic', value: `${(r * 100).toFixed(0)}%`, state: r < 0.3 ? 'pass' : r < 0.6 ? 'warn' : 'fail', byAgent: true });
  } else {
    const r = f.rugScore;
    rows.push({ key: 'rug', label: 'rug score', value: r === null ? '—' : `RugCheck ${Math.round(r)}/100`, state: r === null ? 'pending' : r < 30 ? 'pass' : r < 60 ? 'warn' : 'fail', byAgent: ran.has('rug') });
  }
  // verdict
  {
    const v = fc?.verdict?.label ?? null;
    rows.push({ key: 'verdict', label: 'verdict', value: v ?? (fc ? 'not yet' : '—'), state: !v ? 'pending' : /WATCH|BUY|ENTER/i.test(v) ? 'pass' : /AVOID|RUG|SKIP/i.test(v) ? 'fail' : 'warn', byAgent: !!v });
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------------------------
// 3) data strip

export function dataCells(f: CoinFacts): DataCell[] {
  const dir = (n: number | null): 1 | -1 | 0 => (n === null || n === 0 ? 0 : n > 0 ? 1 : -1);
  const flow = f.buys !== null && f.sells !== null ? `${f.buys}/${f.sells}` : '—';
  return [
    { k: 'mcap', v: f.mcap === null ? '—' : fmtUsd(f.mcap, { digits: 1 }) },
    { k: 'price', v: f.price === null ? '—' : fmtPrice(f.price) },
    { k: 'liq', v: f.liq === null ? '—' : fmtUsd(f.liq, { digits: 1 }) },
    { k: '5m', v: f.chg5m === null ? '—' : sgnPct(f.chg5m), dir: dir(f.chg5m) },
    { k: '1h', v: f.chg1h === null ? '—' : sgnPct(f.chg1h), dir: dir(f.chg1h) },
    { k: 'b/s', v: flow, dir: f.buys !== null && f.sells !== null ? dir(f.buys - f.sells) : 0 },
    { k: 'holders', v: f.holders === null ? '—' : fmtNum(f.holders) },
  ];
}

// ---------------------------------------------------------------------------------------------------------------
// 4) plan + position

const TP_RE = /\b(?:TP ?1|TP|take[- ]profit|target)\b[^.;!?]{0,24}?([+]?\d{1,4}(?:\.\d+)?%|\$\d+(?:[.,]\d+)*|\d+(?:\.\d+)?x)/i;
const STOP_RE = /\b(?:stop(?:[- ]loss)?|SL)\b[^.;!?]{0,20}?([−-]\d{1,3}(?:\.\d+)?%|\$\d+(?:[.,]\d+)*)/i;
const NO_STOP_RE = /\bno (?:hard )?stop\b/i;

/** The take-profit / stop the agent SAID (its words, newest first): display text only, never an order. */
export function planFromThoughts(thoughts: readonly Thought[], since: number): { tp: string | null; stop: string | null } {
  let tp: string | null = null, stop: string | null = null;
  for (let i = thoughts.length - 1; i >= 0; i--) {
    const x = thoughts[i];
    if (x.source !== 'agent' || x.t < since - 60_000) continue;
    if (!tp) { const m = TP_RE.exec(x.text); if (m) tp = m[1].replace('-', '−'); }
    if (!stop) { if (NO_STOP_RE.test(x.text)) stop = 'no stop'; else { const m = STOP_RE.exec(x.text); if (m) stop = m[1].replace('-', '−'); } }
    if (tp && stop) break;
  }
  return { tp, stop };
}

/** The PLAN / POSITION block for the agent's PAPER arc (null when there is no ticket or position). */
export function planVM(v: StoryView, now: number): PlanVM | null {
  const a = v.arc;
  if (!a || a.stage === 'closed' || a.stage === 'refused') return null;
  const said = planFromThoughts(v.thoughts, a.openedAt);
  const open = a.stage === 'open';
  const pnlUsd = open && a.pnlPct !== null && a.sizeUsd !== null ? a.sizeUsd * a.pnlPct : null;
  const dd = open && a.pnlPct !== null && a.peakPct !== null ? (1 + a.pnlPct) / (1 + a.peakPct) - 1 : null;
  const tp = said.tp ? `TP ${said.tp} (agent's plan)` : 'TP agent-managed';
  const stop = said.stop === 'no stop' || !said.stop ? 'no stop' : `stop ${said.stop} (agent's plan)`;
  const waiting = !open
    ? (a.sizeUsd !== null ? 'the agent to confirm the sized ticket' : 'the agent to size the ticket')
    : said.tp ? `TP ${said.tp} · agent-managed exit, no resting order on PAPER` : 'the agent\'s exit call · no resting orders on PAPER';
  return {
    symbol: a.symbol, stage: a.stage,
    entry: a.entryUsd !== null ? `$${fmtPx(a.entryUsd)}` : '—',
    size: a.sizeUsd !== null ? `$${a.sizeUsd.toFixed(2)}${a.spentSol > 0 ? ` (${a.spentSol.toFixed(4)} SOL)` : ''}` : a.spentSol > 0 ? `${a.spentSol.toFixed(4)} SOL` : 'sizing…',
    tp, stop,
    pnlPct: open ? a.pnlPct : null, pnlUsd, peakPct: open ? a.peakPct : null, ddPct: dd,
    heldMs: open && a.filledAt !== null ? now - a.filledAt : null,
    mark: a.mark ? `$${fmtPx(a.mark.priceUsd)}` : '—',
    waiting, trace: a.trace.map((s) => s.pct),
    refused: open && a.refusal && v.beats.refusedAt !== null && now - v.beats.refusedAt < 3500 ? a.refusal : null,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// 5) decision log + scoreboard

const DEC_GLYPH: Record<Decision['kind'], [string, Level]> = { pass: ['·', 'na'], reject: ['✗', 'bad'], enter: ['▲', 'ok'], exit: ['▼', 'warn'], refused: ['⊘', 'bad'] };
const DEC_VERB: Record<Decision['kind'], string> = { pass: 'passed', reject: 'rejected', enter: '', exit: '', refused: '' };

export function decisionLog(v: StoryView, tz: string | undefined): LogLine[] {
  return v.decisions.map((d) => {
    const [glyph, level] = DEC_GLYPH[d.kind];
    const verb = DEC_VERB[d.kind];
    return { t: d.t, clock: clock(new Date(d.t), tz).slice(0, 5), glyph, level, symbol: d.symbol, text: verb ? `${verb} · ${d.text}` : d.text, said: d.said };
  });
}

export function scoreLine(s: SessionScore): string {
  return `PAPER simulated · vetted ${s.attempts} · entries ${s.entries} · closed ${s.closed}${s.closed ? ` (${s.wins}W)` : ''} · ${sgnSol(s.realizedSol)}`;
}

export function scanLogLines(log: readonly ScanLogEntry[], tz: string | undefined): LogLine[] {
  const lv: Record<ScanLogEntry['kind'], [string, Level]> = { start: ['◉', 'na'], lock: ['▲', 'ok'], refresh: ['↻', 'na'], release: ['·', 'na'], stop: ['■', 'warn'], cancel: ['❚', 'warn'], blocked: ['⊘', 'bad'] };
  return log.map((e) => ({ t: e.t, clock: clock(new Date(e.t), tz).slice(0, 5), glyph: lv[e.kind][0], level: lv[e.kind][1], symbol: e.symbol, text: e.text, said: null }));
}

// ---------------------------------------------------------------------------------------------------------------
// the whole model

export function agentBrainModel(v: StoryView, facts: CoinFacts | null, now: number, tz?: string): BrainModel {
  const s = agentStream(v, tz);
  const status = v.control === 'paused' ? '❚❚ paused by you · its next call is held' : v.control === 'takeover' ? 'you are driving · the agent is frozen' : null;
  return {
    mode: 'agent', title: `✦ BRAIN · ${v.agent}`, streamLabel: s.label, demo: s.demo, stream: s.lines, status,
    coin: facts ? { symbol: facts.symbol, mint: facts.mint } : v.focus ? { symbol: v.focus.symbol, mint: v.focus.mint } : null,
    vet: facts ? vetRows(facts, v.focus) : [],
    data: facts ? dataCells(facts) : [], closes: facts?.closes ?? [],
    plan: planVM(v, now), log: decisionLog(v, tz), score: scoreLine(v.score),
  };
}

export interface ScanBrainInput {
  mode: string;
  lock: { mint: string; symbol: string; score: number; reads: number } | null;
  note: string | null;
  scanned: number;
  floorUsd: number;
  log: readonly ScanLogEntry[];
  answer: ScanAnswer | null;
  usage: string;
}

export function scanBrainModel(s: ScanBrainInput, facts: CoinFacts | null, tz?: string): BrainModel {
  const locks = s.log.filter((e) => e.kind === 'lock').length;
  const reads = s.log.filter((e) => e.kind === 'lock' || e.kind === 'refresh').length;
  return {
    mode: 'scan', title: '✦ BRAIN · AI scan', streamLabel: 'scan log + the scan analyst (observe-only)', demo: false,
    stream: scanStream(s.log, s.answer, tz), status: `◉ ${s.mode}${s.lock ? ` $${s.lock.symbol} · score ${s.lock.score} · read ${s.lock.reads}` : ''} · ${s.scanned} coins${s.note ? ` · ${s.note}` : ''}`,
    coin: facts ? { symbol: facts.symbol, mint: facts.mint } : null,
    vet: facts ? vetRows(facts, null, s.floorUsd) : [], data: facts ? dataCells(facts) : [], closes: facts?.closes ?? [],
    plan: null, log: scanLogLines(s.log, tz), score: `locks ${locks} · reads ${reads} · ${s.usage || 'ai cap'} · observe-only · never trades`,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// layout: which blocks fit (pure, so the degrade order is testable)

export type BlockId = 'stream' | 'vet' | 'data' | 'plan' | 'log';
export interface BlockPlan { id: BlockId; rows: number; compact?: boolean }

/** Rows each block wants. */
const VET_FULL = (n: number): number => 1 + n;
const VET_COMPACT = (n: number): number => 1 + Math.ceil(n / 2);
const DATA_ROWS = 3;
const PLAN_ROWS = 6;
const LOG_ROWS = (n: number): number => 2 + Math.min(6, Math.max(1, n));
const STREAM_MIN = 4;

/**
 * Fit the blocks into `h` rows (inside the border) of a panel `w` wide. Priority to keep: plan > stream > vetting >
 * data > decisions; the vetting list folds to two columns before it goes. The stream takes what is left. Returned in
 * draw order (top to bottom: stream, vetting, data, plan, decisions).
 */
export function layoutBlocks(m: Pick<BrainModel, 'vet' | 'plan' | 'log' | 'data'>, w: number, h: number): BlockPlan[] {
  const wants: BlockPlan[] = [];
  const nVet = m.vet.length;
  let vet: BlockPlan | null = nVet ? { id: 'vet', rows: VET_FULL(nVet) } : null;
  let data: BlockPlan | null = m.data.length ? { id: 'data', rows: DATA_ROWS } : null;
  let log: BlockPlan | null = { id: 'log', rows: LOG_ROWS(m.log.length) };
  const plan: BlockPlan | null = m.plan ? { id: 'plan', rows: PLAN_ROWS } : null;
  const used = (): number => (vet?.rows ?? 0) + (data?.rows ?? 0) + (log?.rows ?? 0) + (plan?.rows ?? 0);
  const room = (): number => h - used();
  // the stream wants a third of the panel when it can have it
  const want = Math.max(STREAM_MIN, Math.floor(h / 3));
  if (room() < want && log) log = log.rows > 4 && room() + (log.rows - 4) >= want ? { id: 'log', rows: 4 } : null;
  if (room() < want && data) data = null;
  if (room() < want && vet && w >= 44 && nVet > 2) vet = { id: 'vet', rows: VET_COMPACT(nVet), compact: true };
  if (room() < STREAM_MIN && vet) vet = null;
  if (room() < STREAM_MIN && log) log = null;
  const streamRows = Math.max(0, room());
  wants.push({ id: 'stream', rows: streamRows });
  if (vet) wants.push(vet);
  if (data) wants.push(data);
  if (plan) wants.push(plan);
  if (log) wants.push(log);
  return wants.filter((b) => b.rows > 0);
}

// ---------------------------------------------------------------------------------------------------------------
// rendering

export interface BrainOpts { now: number; calm: boolean; depth: ColorDepth; frame: number }

const STATE_GLYPH: Record<CheckState, string> = { pass: '✓', warn: '!', fail: '✗', pending: '·' };

function levelColor(c: Canvas, l: Level | CheckState): Hex {
  const t = c.theme;
  return l === 'ok' || l === 'pass' ? t.up : l === 'warn' ? t.warn : l === 'bad' || l === 'fail' ? t.down : t.dim;
}

function section(c: Canvas, x: number, y: number, w: number, title: string, right: string, bg: Hex, col: Hex): void {
  const t = c.theme;
  c.hline(x, y, w, { fg: mix(bg, t.border, 0.9), bg, soft: true });
  const tx = c.text(x + 1, y, ` ${title} `, { fg: col, bg, b: true });
  if (right) { const r = clip(right, Math.max(0, x + w - tx - 3)); if (r) c.text(x + w - r.length - 2, y, ` ${r}`, { fg: t.dim, bg }); }
}

/** Draw the brain view into the analyst panel rectangle. */
export function renderBrainPanel(c: Canvas, x: number, y: number, w: number, h: number, m: BrainModel, o: BrainOpts): void {
  const t = c.theme;
  const bc = mix(t.border, t.ai, 0.55);
  const cap = m.mode === 'agent' ? 'display only · cannot trade' : 'observe-only · never trades';
  const box = c.box(x, y, w, h, { title: m.title, titleFg: t.ai, caption: cap, captionFg: t.dim, border: bc });
  const bg = box.bg;
  const iw = box.w;
  c.noRain(box.x, box.y, box.w, box.h);
  const blocks = layoutBlocks(m, iw, box.h);
  let cy = box.y;
  for (const b of blocks) {
    const y0 = cy;
    if (b.id === 'stream') drawStream(c, box.x, y0, iw, b.rows, m, o, bg);
    else if (b.id === 'vet') drawVet(c, box.x, y0, iw, b.rows, m, b.compact === true, bg);
    else if (b.id === 'data') drawData(c, box.x, y0, iw, m, bg);
    else if (b.id === 'plan' && m.plan) drawPlan(c, box.x, y0, iw, m.plan, o, bg);
    else if (b.id === 'log') drawLog(c, box.x, y0, iw, b.rows, m, bg);
    cy += b.rows;
  }
}

function drawStream(c: Canvas, x: number, y: number, w: number, rows: number, m: BrainModel, o: BrainOpts, bg: Hex): void {
  const t = c.theme;
  if (rows <= 0) return;
  // header: what is talking, plus the coral demo-text tag when a stand-in feed wrote the lines
  let hx = c.text(x + 1, y, 'REASONING', { fg: t.ai, bg, b: true });
  hx = c.text(hx + 1, y, `· ${m.streamLabel}`, { fg: t.dim, bg }, x + w - hx - 2);
  if (m.demo) { const tag = ' ✦ claude lines: demo text '; c.text(x + w - tag.length - 1, y, tag, { fg: t.bg, bg: t.ai, b: true }); }
  const statusRows = m.status ? 1 : 0;
  const area = rows - 1 - statusRows;
  const bottom = y + 1 + area; // exclusive
  if (m.status) c.text(x + 1, bottom, clip(m.status, w - 2), { fg: t.warn, bg, b: true });
  if (area <= 0) return;
  if (!m.stream.length) { c.text(x + 2, y + 1, m.mode === 'agent' ? '› waiting for the agent\'s first move' : '› watching… nothing has locked yet', { fg: t.dim, bg, i: true }, w - 3); return; }
  // "HH:MM:SS " + "EXECUTING " + a space; a narrow panel drops the clock and keeps the phase tag
  const narrow = w < 56;
  const gutter = narrow ? 11 : 9 + 11;
  const tw = Math.max(8, w - gutter - 3);
  // build visual rows from newest upward: the newest line wraps (≤ 3 rows), older lines take one row, clipped
  type VRow = { line: StreamLine; text: string; first: boolean; newest: boolean; rank: number };
  const vrows: VRow[] = [];
  for (let i = m.stream.length - 1, rank = 0; i >= 0 && vrows.length < area; i--, rank++) {
    const ln = m.stream[i];
    const lead = ln.kind === 'agent' ? '❯ ' : ln.kind === 'scan' ? '◉ ' : '› ';
    const body = lead + ln.text;
    const parts = rank === 0 ? wrap(body, tw).slice(0, 3) : [clip(body, tw)];
    if (rank === 0 && wrap(body, tw).length > 3) parts[2] = clip(parts[2] + ' …', tw);
    for (let k = parts.length - 1; k >= 0 && vrows.length < area; k--) vrows.push({ line: ln, text: parts[k], first: k === 0, newest: rank === 0, rank });
  }
  vrows.reverse();
  let yy = bottom - vrows.length;
  // typing budget for the newest line (calm mode: shown at once)
  const newest = m.stream[m.stream.length - 1];
  let budget = o.calm ? Infinity : Math.max(0, Math.floor((o.now - newest.t) / 14));
  for (const r of vrows) {
    const fade = r.newest ? 0 : Math.min(0.62, 0.12 + r.rank * 0.07);
    const base = r.line.kind === 'agent' ? mix(t.text, t.ai, 0.3) : r.line.kind === 'scan' ? t.text : t.muted;
    const fg = mix(base, bg, fade);
    if (r.first) {
      if (!narrow) c.text(x + 1, yy, r.line.clock, { fg: mix(t.dim, bg, fade * 0.6), bg });
      c.text(x + (narrow ? 1 : 10), yy, r.line.tag.slice(0, 9), { fg: mix(tagColor(c, r.line.tag), bg, fade), bg, b: r.newest });
    }
    const st: Style = { fg, bg, i: r.line.kind === 'narration' };
    if (r.newest && budget < r.text.length) {
      const end = decryptText(c, x + gutter, yy, r.text, Math.max(0, budget), Math.floor(o.now / 33), st, tw);
      if (budget >= 0) c.put(Math.min(end, x + w - 2), yy, '▌', { fg: t.ai, bg, soft: true });
      budget = -1;
    } else if (r.newest && budget < 0) {
      // the rest of a line still typing: nothing yet
    } else {
      c.text(x + gutter, yy, r.text, st, tw);
      if (r.newest) budget -= r.text.length + 1;
    }
    yy += 1;
  }
}

function tagColor(c: Canvas, tag: string): Hex {
  const t = c.theme;
  switch (tag) {
    case 'SCANNING': return t.accent;
    case 'VETTING': case 'READING': case 'READ': return t.borderFocus;
    case 'SIZING': return t.meteora;
    case 'EXECUTING': case 'LOCKED': return t.up;
    case 'HOLDING': return t.magenta;
    case 'EXITING': case 'VERDICT': return t.ai;
    case 'BLOCKED': case 'OFF': return t.down;
    case 'PAUSED': return t.warn;
    default: return t.dim;
  }
}

function drawVet(c: Canvas, x: number, y: number, w: number, rows: number, m: BrainModel, compact: boolean, bg: Hex): void {
  const t = c.theme;
  const done = m.vet.filter((r) => r.state !== 'pending').length;
  section(c, x, y, w, `VETTING${m.coin ? ` $${m.coin.symbol}` : ''}`, `${done}/${m.vet.length} evaluated${m.mode === 'agent' ? ' · ◆ agent ran it' : ''}`, bg, t.borderFocus);
  const rowsAvail = rows - 1;
  if (!compact) {
    m.vet.slice(0, rowsAvail).forEach((r, i) => {
      const yy = y + 1 + i;
      const col = levelColor(c, r.state);
      c.text(x + 1, yy, STATE_GLYPH[r.state], { fg: col, bg, b: r.state !== 'pending' });
      c.text(x + 3, yy, r.byAgent ? '◆' : ' ', { fg: t.ai, bg });
      c.text(x + 5, yy, r.label, { fg: t.muted, bg }, 13);
      const val = clip(r.value, Math.max(4, w - 26));
      c.text(x + 19, yy, val, { fg: r.state === 'pending' ? t.dim : r.state === 'pass' ? t.text : col, bg, b: r.state === 'fail', i: r.state === 'pending' });
      const word = r.state === 'pending' ? 'pending' : r.state;
      c.textR(x + 1, yy, w - 2, word, { fg: col, bg, b: r.state === 'fail' });
    });
    return;
  }
  // two columns: glyph + label + short value
  const colW = Math.floor((w - 2) / 2);
  m.vet.forEach((r, i) => {
    const row = Math.floor(i / 2);
    if (row >= rowsAvail) return;
    const cx = x + 1 + (i % 2) * colW;
    const yy = y + 1 + row;
    const col = levelColor(c, r.state);
    c.text(cx, yy, STATE_GLYPH[r.state], { fg: col, bg, b: true });
    c.text(cx + 2, yy, clip(`${r.label} ${r.value === '—' ? '' : r.value.split(' · ')[0]}`, colW - 3), { fg: r.state === 'pending' ? t.dim : t.text, bg });
  });
}

function drawData(c: Canvas, x: number, y: number, w: number, m: BrainModel, bg: Hex): void {
  const t = c.theme;
  section(c, x, y, w, 'DATA', 'app numbers · no extra fetch', bg, t.accent);
  let cx = x + 1;
  for (const d of m.data) {
    const need = d.k.length + 1 + d.v.length + 2;
    if (cx + need > x + w - 1) break;
    cx = c.text(cx, y + 1, d.k, { fg: t.dim, bg });
    const fg = d.dir === 1 ? t.up : d.dir === -1 ? t.down : t.text;
    cx = c.text(cx + 1, y + 1, d.v, { fg, bg, b: d.dir !== undefined && d.dir !== 0 }) + 2;
  }
  // the candle trace: one cell per close (most recent at the right)
  const LV = '▁▂▃▄▅▆▇█';
  const tw = w - 4;
  const cl = m.closes.slice(-tw);
  if (cl.length > 1) {
    const lo = Math.min(...cl), hi = Math.max(...cl), span = hi - lo || 1;
    const up = cl[cl.length - 1] >= cl[0];
    c.text(x + 1, y + 2, up ? '▲' : '▼', { fg: up ? t.up : t.down, bg, b: true });
    cl.forEach((v, i) => c.put(x + 3 + i, y + 2, LV[Math.round(((v - lo) / span) * 7)], { fg: mix(bg, up ? t.up : t.down, 0.45 + 0.55 * (i / Math.max(1, cl.length - 1))), bg, soft: true }));
  } else c.text(x + 1, y + 2, '· no candles yet', { fg: t.dim, bg, i: true });
}

function drawPlan(c: Canvas, x: number, y: number, w: number, p: PlanVM, o: BrainOpts, bg: Hex): void {
  const t = c.theme;
  const open = p.stage === 'open';
  section(c, x, y, w, open ? `POSITION · PAPER $${p.symbol}` : `PLAN · PAPER $${p.symbol}`, open ? `held ${p.heldMs !== null ? fmtDur(p.heldMs) : '—'}` : p.stage === 'sized' ? 'sized · not filled' : 'ticket open', bg, t.magenta);
  const pc = p.pnlPct === null ? t.muted : p.pnlPct >= 0 ? t.up : t.down;
  let yy = y + 1;
  if (open) {
    let cx = c.text(x + 1, yy, 'MARK PnL ', { fg: t.dim, bg });
    cx = c.text(cx, yy, p.pnlPct === null ? '—' : sgnRatio(p.pnlPct), { fg: pc, bg, b: true });
    if (p.pnlUsd !== null) cx = c.text(cx + 1, yy, `(${sgnUsd(p.pnlUsd)} paper)`, { fg: pc, bg });
    if (p.peakPct !== null) cx = c.text(cx + 2, yy, `peak ${sgnRatio(p.peakPct)}`, { fg: p.peakPct >= 0 ? t.up : t.down, bg });
    if (p.ddPct !== null && p.ddPct < -0.0005) c.text(cx + 2, yy, `dd ${sgnRatio(p.ddPct)}`, { fg: t.warn, bg }, x + w - cx - 3);
    // trace at the right of the next row
  } else c.text(x + 1, yy, `size ${p.size}`, { fg: t.text, bg, b: true }, w - 2);
  yy++;
  c.text(x + 1, yy, clip(`entry ${p.entry} · mark ${p.mark} · size ${p.size}`, w - 2), { fg: t.muted, bg });
  yy++;
  c.text(x + 1, yy, clip(`${p.tp} · ${p.stop}`, w - 2), { fg: t.text, bg });
  yy++;
  if (p.refused) c.text(x + 1, yy, clip(` ✗ REFUSED BY THE DESK · ${p.refused} `, w - 2), { fg: t.bg, bg: t.down, b: true });
  else c.text(x + 1, yy, clip(`waiting for ${p.waiting}`, w - 2), { fg: t.ai, bg, i: true });
  yy++;
  const tr = p.trace.slice(-(w - 4));
  if (tr.length > 1) {
    const lo = Math.min(0, ...tr), hi = Math.max(0, ...tr), span = hi - lo || 1;
    const LV = '▁▂▃▄▅▆▇█';
    tr.forEach((v, i) => c.put(x + 2 + i, yy, LV[Math.round(((v - lo) / span) * 7)], { fg: v >= 0 ? t.up : t.down, bg, soft: true }));
  } else c.text(x + 1, yy, open ? '· waiting for the first mark tick' : '· PAPER · simulated ledger', { fg: t.dim, bg, i: true });
  void o;
}

function drawLog(c: Canvas, x: number, y: number, w: number, rows: number, m: BrainModel, bg: Hex): void {
  const t = c.theme;
  section(c, x, y, w, m.mode === 'agent' ? 'DECISIONS' : 'SCAN LOG', 'this session', bg, t.ai);
  const area = rows - 2;
  const lines = m.log.slice(-Math.max(0, area));
  if (!lines.length) c.text(x + 2, y + 1, m.mode === 'agent' ? '· no decisions yet' : '· nothing locked yet', { fg: t.dim, bg, i: true });
  lines.forEach((l, i) => {
    const yy = y + 1 + i;
    const col = levelColor(c, l.level);
    let cx = c.text(x + 1, yy, l.clock, { fg: t.dim, bg });
    cx = c.text(cx + 1, yy, l.glyph, { fg: col, bg, b: true });
    if (l.symbol) cx = c.text(cx + 1, yy, `$${l.symbol}`, { fg: t.text, bg, b: true });
    cx = c.text(cx + 1, yy, l.text, { fg: l.level === 'na' ? t.muted : col, bg }, x + w - cx - 2);
    if (l.said && cx + 8 < x + w - 1) c.text(cx + 1, yy, `❯ ${l.said}`, { fg: mix(t.ai, bg, 0.35), bg, i: true }, x + w - cx - 2);
  });
  if (m.score) c.text(x + 1, y + rows - 1, clip(m.score, w - 2), { fg: t.warn, bg, b: true });
}

// ---------------------------------------------------------------------------------------------------------------
// the app wiring: which auto mode (if any) owns the analyst panel right now

/** The AppState slice the brain view reads (structural, so this module needs no runtime import of state.ts). */
export interface BrainHost {
  agentHud?: { story: { view(now: number): StoryView }; clock: () => number; reduced?: boolean } | null;
  scan?: { engine: { on: boolean; mode: string; lock: { mint: string; symbol: string; score: number; reads: number } | null; note: string | null; scanned: number; cfg: { minLiqUsd: number } }; log?: ScanLogEntry[] } | null;
  analystByMint?: Map<string, unknown>;
  aiFocused?: boolean;
  now: Date;
  timeZone?: string;
  colorDepth: ColorDepth;
  vfx: { frame: number };
}

/**
 * The brain view for the coin on screen, or null when the normal analyst panel should draw: no auto mode, the agent
 * was killed / went quiet / has not acted yet, the scan is off, or the user is typing into the analyst.
 */
export function brainFor(h: BrainHost, facts: CoinFacts | null, calm: boolean, scanUsage = ''): { model: BrainModel; opts: BrainOpts } | null {
  if (h.aiFocused) return null;
  const hud = h.agentHud;
  if (hud) {
    const now = hud.clock();
    const v = hud.story.view(now);
    if (agentBrainActive(v, now)) return { model: agentBrainModel(v, facts, now, h.timeZone), opts: { now, calm: calm || !!hud.reduced, depth: h.colorDepth, frame: h.vfx.frame } };
  }
  const scan = h.scan;
  if (scan?.engine.on) {
    const e = scan.engine;
    const now = h.now.getTime();
    // the scan's brain shows on the locked coin (or any coin while it is still scanning)
    if (e.lock && facts && e.lock.mint !== facts.mint) return null;
    const sess = e.lock ? h.analystByMint?.get(e.lock.mint) : null;
    const answer = isScanAnswer(sess) ? sess : null;
    const model = scanBrainModel({ mode: e.mode.toUpperCase(), lock: e.lock, note: e.note, scanned: e.scanned, floorUsd: e.cfg.minLiqUsd, log: scan.log ?? [], answer, usage: scanUsage }, facts, h.timeZone);
    return { model, opts: { now, calm, depth: h.colorDepth, frame: h.vfx.frame } };
  }
  return null;
}

function isScanAnswer(x: unknown): x is ScanAnswer {
  const o = x as ScanAnswer | null;
  return !!o && typeof o === 'object' && typeof o.text === 'string' && Array.isArray(o.toolLines) && typeof o.startedAt === 'number';
}
