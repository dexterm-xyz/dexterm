// @dexterm/agents — the agent STORY (task-1466, spectator v2). Folds the spectator event stream into what a
// person watching an agent drive dexterm should FEEL: a phase state machine (SCANNING > VETTING > SIZING >
// EXECUTING > HOLDING > EXITING), a heartbeat that speeds up with the call rate, a timeline of calls with result
// chips, a short thought ribbon, the rows the agent touched, the coin in focus (verdict, LARP evidence) and the
// PAPER trade arc (ticket → fill → hold with a live mark → exit → result card).
//
// Pure and deterministic: every method takes the time it should use, nothing reads a clock or does I/O, so the
// terminal HUD, the popup and tests all see the same story. Every number is copied from an app-computed detail
// (SpectatorDetail) or from the app's own mark price; agent text only ever reaches the thought ribbon, scrubbed.
// Like follow.ts it has no action path: it cannot arm, sign, size, confirm or raise a cap.

import type { SpectatorEvent, SpectatorDetail } from './spectator.ts';
import { maskAddress } from './spectator.ts';

export type StoryPhase = 'idle' | 'scanning' | 'vetting' | 'sizing' | 'executing' | 'holding' | 'exiting';
/** The rail, in the order a trade moves through it (idle is not on the rail). */
export const STORY_RAIL: readonly StoryPhase[] = ['scanning', 'vetting', 'sizing', 'executing', 'holding', 'exiting'];
export type StoryControl = 'running' | 'paused' | 'takeover' | 'killed';

export type NodeStatus = 'ok' | 'slow' | 'fail' | 'refused';
export interface TimelineNode {
  seq: number;
  t: number;
  tool: string;
  /** A short label for the node (≤ 10 chars), e.g. `scan`, `larp`, `FILL`. */
  label: string;
  ms: number | null;
  status: NodeStatus;
  phase: StoryPhase;
  paper: boolean;
  /** Consecutive ok calls of the same read tool fold into one node (a holding agent polling its price). */
  count: number;
}

/** A line of reasoning: the agent's own words (a thoughts feed) or dexterm's narration of a call. `phase` is the
 *  story phase when it was said; `demo` marks lines a demo/stand-in feed flagged as scripted text (task-1473). */
export interface Thought { t: number; text: string; source: 'agent' | 'dexterm'; phase?: StoryPhase; demo?: boolean }

/** task-1473: one line of the session's decision log (what the agent did with each coin it looked at). */
export type DecisionKind = 'pass' | 'reject' | 'enter' | 'exit' | 'refused';
export interface Decision {
  t: number;
  kind: DecisionKind;
  symbol: string;
  /** App-computed reason (verdict, LARP flags, fill numbers, the desk's refusal code). */
  text: string;
  /** The agent's last words about this coin while it was in focus (scrubbed, clipped), if any. */
  said: string | null;
}
/** task-1473: the session scoreboard (PAPER, simulated). */
export interface SessionScore { attempts: number; entries: number; closed: number; wins: number; realizedSol: number }

export type TouchKind = 'scan' | 'vet' | 'open' | 'trade';
export interface TouchedRow { mint: string; symbol: string; at: number; kind: TouchKind }

export interface FocusCoin {
  mint: string;
  symbol: string;
  since: number;
  verdict: { label: string; rug: number | null; at: number } | null;
  larp: { flags: number; items: string[]; at: number } | null;
  /** Which vetting checks ran on this coin (tape, chart, holders, rug, dev, larp, verdict). */
  checks: string[];
}

export type ArcStage = 'ticket' | 'sized' | 'open' | 'closed' | 'refused';
export interface TradeFill { t: number; side: 'buy' | 'sell'; sol: number; qty: number; priceUsd: number | null; impactPct: number | null; realizedSol: number | null }
export interface TradeArc {
  id: number;
  mint: string;
  symbol: string;
  stage: ArcStage;
  openedAt: number;
  sizeUsd: number | null;
  sellFraction: number | null;
  fills: TradeFill[];
  /** Position after the last fill (from the desk). */
  position: { qty: number; costSol: number; realizedSol: number } | null;
  /** Average entry price in USD over the buys (null when a fill had no USD price). */
  entryUsd: number | null;
  /** SOL spent on buys (positive). */
  spentSol: number;
  mark: { priceUsd: number; at: number } | null;
  /** (mark / entry − 1), the unrealized move of the open size. */
  pnlPct: number | null;
  peakPct: number | null;
  /** When the peak was last raised (the PnL chip flashes on a new peak). */
  peakAt: number | null;
  /** Recent (t, pnlPct) samples for the PnL trace (≤ 240). */
  trace: Array<{ t: number; pct: number }>;
  filledAt: number | null;
  closedAt: number | null;
  refusal: string | null;
  result: { realizedSol: number; pct: number | null; holdMs: number; exits: number } | null;
}

export interface StoryView {
  agent: string;
  phase: StoryPhase;
  /** When the current phase began (for the rail's sweep-in). */
  phaseSince: number;
  /** A sub-activity while holding (e.g. `scanning`), so the rail can show it dimly. */
  sub: StoryPhase | null;
  control: StoryControl;
  controlAt: number;
  bpm: number;
  lastCallAt: number | null;
  calls: number;
  nodes: TimelineNode[];
  thoughts: Thought[];
  touched: TouchedRow[];
  /** The last coin the agent opened (the screen cursor jumps to it). */
  cursor: { mint: string; symbol: string; at: number } | null;
  focus: FocusCoin | null;
  arc: TradeArc | null;
  /** The previous, closed arc (its result card lingers). */
  lastResult: TradeArc | null;
  caps: { perTradeUsd: number; totalUsd: number; maxPriceImpactPct: number | null } | null;
  /** task-1473: the session's decisions, oldest first (≤ 24), and the scoreboard. */
  decisions: Decision[];
  score: SessionScore;
  /** Effect triggers the renderer animates from (each is the time it fired). */
  beats: { scanAt: number | null; openAt: number | null; fillAt: number | null; exitAt: number | null; refusedAt: number | null; larpAt: number | null };
}

/** How long EXECUTING / EXITING stay lit after the fill lands (the execution moment). */
export const EXEC_HOLD_MS = 2400;
/** A call slower than this gets an amber chip. */
export const SLOW_MS = 2500;
const TOUCH_TTL_MS = 30_000;
const MAX_NODES = 48;
const MAX_THOUGHTS = 32;
const MAX_DECISIONS = 24;
const MAX_TRACE = 240;

const SCAN_TOOLS = new Set(['screener_query', 'show_in_screener', 'switch_feed', 'switch_screen', 'screen_state', 'narrative_board', 'app_state', 'set_scan']);
const VET_TOOLS = new Set(['open_token', 'get_token', 'get_dossier', 'analyze_token', 'get_holders', 'get_trades', 'get_candles', 'rugcheck', 'get_dev_history', 'dev_history', 'larp_check', 'get_links', 'fetch_page', 'check_domain', 'check_github', 'check_x', 'chart_popup', 'rug_backtest', 'kb_lookup', 'kb_search', 'case_lookup']);
const SIZE_TOOLS = new Set(['paper_open_ticket', 'paper_size_ticket', 'open_ticket']);
const CHECK_OF: Record<string, string> = { get_trades: 'tape', get_candles: 'chart', get_holders: 'holders', rugcheck: 'rug', get_dev_history: 'dev', dev_history: 'dev', larp_check: 'larp', analyze_token: 'verdict', get_dossier: 'dossier', get_token: 'price' };
const LABEL_OF: Record<string, string> = {
  screener_query: 'scan', show_in_screener: 'screen', switch_feed: 'feed', switch_screen: 'switch', screen_state: 'look', narrative_board: 'narrative',
  open_token: 'open', get_token: 'price', get_dossier: 'dossier', analyze_token: 'verdict', get_holders: 'holders', get_trades: 'tape', get_candles: 'chart',
  rugcheck: 'rug', get_dev_history: 'dev', dev_history: 'dev', larp_check: 'larp', get_links: 'links', fetch_page: 'site', check_domain: 'domain', check_github: 'github', check_x: 'x',
  paper_open_ticket: 'TICKET', paper_size_ticket: 'SIZE', paper_confirm: 'FILL', paper_close: 'CLOSE', paper_positions: 'pos', paper_pnl: 'pnl',
};

// eslint-disable-next-line no-control-regex
const UNSAFE_RE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;
const ADDR_RE = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;

/**
 * Make one line of agent text fit to SHOW: strip control / bidi / zero-width characters, mask addresses, drop
 * markdown noise, collapse whitespace and clip at a word boundary (≤ max). Returns '' for nothing worth showing.
 * Display only: the result is never parsed, executed or fed back to anything.
 */
export function ribbonText(raw: string, max = 120): string {
  let s = String(raw ?? '').replace(UNSAFE_RE, ' ').replace(/[`*_#>|]+/g, '').replace(/\s+/g, ' ').trim();
  s = s.replace(/[1-9A-HJ-NP-Za-km-z]{45,}/g, '[key]').replace(ADDR_RE, (m) => maskAddress(m));
  if (!s) return '';
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[,;:.\s]+$/, '') + '…';
}

/** Split agent prose into short, punchy ribbon lines (first sentences first). */
export function ribbonLines(raw: string, max = 120, limit = 2): string[] {
  const flat = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return [];
  const parts = flat.split(/(?<=[.!?])\s+(?=[A-Z$0-9])/).map((p) => ribbonText(p, max)).filter((p) => p.length >= 3);
  return parts.slice(0, limit);
}

/** One ribbon line for a whole agent message: as many leading sentences as fit in `max`, else the first clipped. */
export function ribbonSummary(raw: string, max = 170): string {
  const parts = ribbonLines(raw, max, 8);
  if (!parts.length) return '';
  let out = parts[0];
  for (const p of parts.slice(1)) { if (out.length + 1 + p.length > max) break; out += ' ' + p; }
  return out;
}

const fmtUsd = (n: number): string => (n >= 100 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`);
const fmtSol = (n: number): string => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(4)} SOL`;
const pct = (n: number): string => `${n >= 0 ? '+' : '−'}${Math.abs(n * 100).toFixed(1)}%`;

export class AgentStory {
  private agent: string;
  private phase: StoryPhase = 'idle';
  private phaseSince = 0;
  private sub: StoryPhase | null = null;
  private control: StoryControl = 'running';
  private controlAt = 0;
  private lastCallAt: number | null = null;
  private calls = 0;
  private callTimes: number[] = [];
  private nodes: TimelineNode[] = [];
  private thoughts: Thought[] = [];
  private touched = new Map<string, TouchedRow>();
  private cursor: StoryView['cursor'] = null;
  private focus: FocusCoin | null = null;
  private arc: TradeArc | null = null;
  private lastResult: TradeArc | null = null;
  private arcSeq = 0;
  private caps: StoryView['caps'] = null;
  private holdUntil = 0; // executing / exiting stay lit until this time
  private beats: StoryView['beats'] = { scanAt: null, openAt: null, fillAt: null, exitAt: null, refusedAt: null, larpAt: null };
  private symbols = new Map<string, string>();
  private decisions: Decision[] = [];
  private score: SessionScore = { attempts: 0, entries: 0, closed: 0, wins: 0, realizedSol: 0 };
  /** The agent's last words while the current focus coin was in focus. */
  private focusSaid: string | null = null;

  constructor(agent = 'agent') { this.agent = agent; }

  /** Fold one spectator event (raw, local). Unknown tools still land on the timeline. */
  apply(ev: SpectatorEvent): void {
    if (ev.agent) this.agent = ev.agent;
    if (ev.phase === 'control') {
      const tool = ev.tool ?? '';
      if (tool === 'pause') this.setControl('paused', ev.t);
      else if (tool === 'resume') this.setControl('running', ev.t);
      else if (tool === 'kick') this.setControl('killed', ev.t);
      return;
    }
    if (ev.phase === 'connect' || ev.phase === 'disconnect' || ev.phase === 'subscribe') return;
    if (ev.phase === 'note') { if (ev.summary) this.thought(ev.summary, ev.t, 'agent'); return; }
    const tool = ev.tool ?? '';
    if (!tool) return;
    const t = ev.t;
    const d: SpectatorDetail = ev.detail ?? {};
    this.calls++;
    this.lastCallAt = t;
    this.callTimes.push(t);
    while (this.callTimes.length && this.callTimes[0] < t - 30_000) this.callTimes.shift();

    const refused = ev.ok === false;
    const paper = tool.startsWith('paper_');
    const status: NodeStatus = refused ? (ev.phase === 'refused' || paper ? 'refused' : 'fail') : (ev.ms ?? 0) > SLOW_MS ? 'slow' : 'ok';

    // ---- learn names
    for (const r of d.rows ?? []) this.symbols.set(r.mint, r.symbol);
    if (d.coin?.symbol) this.symbols.set(d.coin.mint, d.coin.symbol);
    if (d.ticket) this.symbols.set(d.ticket.mint, d.ticket.symbol);
    if (d.fill) this.symbols.set(d.fill.mint, d.fill.symbol);
    if (d.caps) this.caps = { ...d.caps };

    // ---- the phase this call implies
    let next: StoryPhase = this.phase === 'idle' ? 'scanning' : this.phase;
    if (SCAN_TOOLS.has(tool)) next = 'scanning';
    else if (VET_TOOLS.has(tool)) next = 'vetting';
    else if (SIZE_TOOLS.has(tool)) next = 'sizing';
    else if (tool === 'paper_confirm') next = d.fill?.side === 'sell' ? 'exiting' : 'executing';
    else if (tool === 'paper_close') next = 'exiting';
    else if (tool === 'paper_positions' || tool === 'paper_pnl') next = this.arc?.stage === 'open' ? 'holding' : this.phase === 'idle' ? 'scanning' : this.phase;

    // ---- rows the agent looked at (the screen glows them, top to bottom)
    if (!refused && d.rows?.length) {
      d.rows.forEach((r, i) => this.touch(r.mint, r.symbol, t + i * 70, 'scan'));
      this.beats.scanAt = t;
    }
    // ---- the coin in focus
    const coinMint = d.coin?.mint ?? ev.nav?.mint ?? d.ticket?.mint ?? d.fill?.mint ?? null;
    if (!refused && coinMint && (VET_TOOLS.has(tool) || paper)) {
      const sym = this.symbols.get(coinMint) ?? maskAddress(coinMint);
      if (!this.focus || this.focus.mint !== coinMint) {
        if (this.focus) this.leaveFocus(t);
        this.focus = { mint: coinMint, symbol: sym, since: t, verdict: null, larp: null, checks: [] };
        this.focusSaid = null;
        this.score.attempts += 1;
      }
      else this.focus.symbol = sym;
      const chk = CHECK_OF[tool];
      if (chk && !this.focus.checks.includes(chk)) this.focus.checks.push(chk);
      if (d.verdict) this.focus.verdict = { label: d.verdict.label, rug: d.verdict.rug ?? null, at: t };
      if (d.larp) { this.focus.larp = { flags: d.larp.flags, items: [...d.larp.items], at: t }; this.beats.larpAt = t; }
      if (tool !== 'open_token') this.touch(coinMint, sym, t, paper ? 'trade' : 'vet');
      if (d.coin?.priceUsd != null && this.arc && this.arc.mint === coinMint && this.arc.stage === 'open') this.mark(coinMint, d.coin.priceUsd, t);
    }
    if (tool === 'open_token' && !refused && coinMint) {
      const sym = this.symbols.get(coinMint) ?? maskAddress(coinMint);
      this.cursor = { mint: coinMint, symbol: sym, at: t };
      this.touch(coinMint, sym, t, 'open');
      this.beats.openAt = t;
    }

    // ---- the PAPER trade arc
    if (paper) this.foldPaper(tool, d, refused, t);

    // ---- holding: the position stays the headline; other work shows as a sub-activity
    const holding = this.arc?.stage === 'open';
    if (d.ticket?.side === 'sell' && !refused) next = 'exiting'; // a sell ticket is the exit being prepared
    if ((tool === 'paper_confirm' || tool === 'paper_close') && !refused) this.holdUntil = t + EXEC_HOLD_MS; // the execution moment
    else if (refused && (next === 'executing' || next === 'exiting')) next = holding ? 'holding' : 'sizing';
    if (t < this.holdUntil && !(tool === 'paper_confirm' || tool === 'paper_close')) {
      if (next === 'scanning' || next === 'vetting') this.sub = next;
      next = this.phase; // never cut the execution moment short
    } else if (holding && (next === 'scanning' || next === 'vetting')) { this.sub = next; next = 'holding'; }
    else if (!holding || next === 'holding') this.sub = null;
    this.setPhase(next, t);

    // ---- the timeline node (a repeat of the same ok read within 15 s folds into the last node: `price ×14`)
    const lastNode = this.nodes[this.nodes.length - 1];
    if (lastNode && lastNode.tool === tool && !paper && !SIZE_TOOLS.has(tool) && status === 'ok' && lastNode.status === 'ok' && t - lastNode.t < 15_000 && tool !== 'open_token') {
      lastNode.count += 1; lastNode.t = t; lastNode.seq = ev.seq; lastNode.ms = ev.ms ?? null; lastNode.phase = this.phase;
    } else this.nodes.push({ seq: ev.seq, t, tool, label: nodeLabel(tool, d, refused), ms: ev.ms ?? null, status, phase: this.phase, paper, count: 1 });
    if (this.nodes.length > MAX_NODES) this.nodes.splice(0, this.nodes.length - MAX_NODES);

    // ---- the narration line (dexterm's words, shown when the agent's own thoughts are quiet)
    const line = narrate(tool, d, ev, this.symbols, refused);
    if (line) this.thought(line, t, 'dexterm');
  }

  private foldPaper(tool: string, d: SpectatorDetail, refused: boolean, t: number): void {
    if (refused) {
      if (tool === 'paper_open_ticket' || tool === 'paper_size_ticket' || tool === 'paper_confirm' || tool === 'paper_close') {
        if (this.arc && this.arc.stage !== 'open' && this.arc.stage !== 'closed') { this.arc.stage = 'refused'; this.arc.refusal = d.refusal ?? 'refused'; }
        else if (this.arc) this.arc.refusal = d.refusal ?? 'refused';
        this.beats.refusedAt = t;
        const m = d.ticket?.mint ?? d.fill?.mint ?? this.arc?.mint ?? this.focus?.mint ?? null;
        this.decide(t, 'refused', m ? this.symbols.get(m) ?? maskAddress(m) : '?', `desk refused ${tool.slice(6).replace('_', ' ')} · ${d.refusal ?? 'refused'}`);
      }
      return;
    }
    if (d.ticket) {
      const tk = d.ticket;
      if (tk.side === 'buy' && (!this.arc || this.arc.stage === 'closed' || this.arc.stage === 'refused' || this.arc.mint !== tk.mint)) {
        if (this.arc?.stage === 'closed') this.lastResult = this.arc;
        this.arc = newArc(++this.arcSeq, tk.mint, tk.symbol, t);
      }
      if (this.arc && this.arc.mint === tk.mint) {
        if (tk.side === 'buy') { if (tk.usd != null) { this.arc.sizeUsd = tk.usd; if (this.arc.stage === 'ticket') this.arc.stage = 'sized'; } }
        else this.arc.sellFraction = tk.fraction ?? this.arc.sellFraction;
        this.arc.refusal = null;
      }
    }
    if (d.fill) {
      const f = d.fill;
      if (!this.arc || this.arc.mint !== f.mint || (this.arc.stage === 'closed' && f.side === 'buy')) {
        if (this.arc?.stage === 'closed') this.lastResult = this.arc;
        this.arc = newArc(++this.arcSeq, f.mint, f.symbol, t);
      }
      const a = this.arc;
      a.fills.push({ t, side: f.side, sol: f.sol, qty: f.qty, priceUsd: f.priceUsd, impactPct: f.impactPct, realizedSol: f.realizedSol });
      a.refusal = null;
      if (f.side === 'buy') {
        const buys = a.fills.filter((x) => x.side === 'buy');
        const priced = buys.filter((x) => x.priceUsd != null && x.qty > 0);
        const qty = priced.reduce((s, x) => s + x.qty, 0);
        a.entryUsd = qty > 0 ? priced.reduce((s, x) => s + (x.priceUsd as number) * x.qty, 0) / qty : null;
        a.spentSol = buys.reduce((s, x) => s + Math.abs(x.sol), 0);
        if (a.stage !== 'open') { this.score.entries += 1; this.decide(t, 'enter', a.symbol, `entered · ${Math.abs(f.sol).toFixed(4)} SOL${a.sizeUsd != null ? ` ($${a.sizeUsd.toFixed(2)})` : ''}${f.priceUsd != null ? ` @ $${fmtPx(f.priceUsd)}` : ''}`); }
        a.stage = 'open';
        a.filledAt = a.filledAt ?? t;
        this.beats.fillAt = t;
        if (f.priceUsd != null) this.mark(f.mint, f.priceUsd, t);
      } else {
        this.beats.exitAt = t;
        if (f.priceUsd != null) this.mark(f.mint, f.priceUsd, t);
        this.decide(t, 'exit', a.symbol, `sold ${fmtQty(f.qty)} → ${fmtSol(f.sol)}${f.realizedSol != null ? ` · realized ${fmtSol(f.realizedSol)}` : ''}`);
      }
      if (d.position && d.position.mint === f.mint) a.position = { qty: d.position.qty, costSol: d.position.costSol, realizedSol: d.position.realizedSol };
      if (f.side === 'sell' && (!d.position || d.position.qty <= 1e-12)) this.closeArc(t);
    }
  }

  private closeArc(t: number): void {
    const a = this.arc;
    if (!a) return;
    a.stage = 'closed';
    a.closedAt = t;
    const exits = a.fills.filter((x) => x.side === 'sell');
    const realized = a.position?.realizedSol ?? exits.reduce((s, x) => s + (x.realizedSol ?? 0), 0);
    a.result = { realizedSol: realized, pct: a.spentSol > 0 ? realized / a.spentSol : null, holdMs: a.filledAt != null ? t - a.filledAt : 0, exits: exits.length };
    this.score.closed += 1;
    if (realized >= 0) this.score.wins += 1;
    this.score.realizedSol += realized;
  }

  /** The focus moves off a coin: log what became of it (traded coins are logged by their fills). */
  private leaveFocus(t: number): void {
    const f = this.focus;
    if (!f) return;
    if (this.arc && this.arc.mint === f.mint) return; // its ticket / fill / refusal is already in the log
    if (this.decisions.some((d) => d.symbol === f.symbol && (d.kind === 'enter' || d.kind === 'exit') && d.t >= f.since)) return;
    const v = f.verdict;
    let kind: DecisionKind = 'pass';
    let why = f.checks.length ? `no entry after ${f.checks.length} check${f.checks.length === 1 ? '' : 's'}` : 'no entry';
    if (v && /AVOID/i.test(v.label)) { kind = 'reject'; why = `verdict ${v.label}${v.rug != null ? ` · rug heuristic ${(v.rug * 100).toFixed(0)}%` : ''}`; }
    else if (f.larp && f.larp.flags >= 3) { kind = 'reject'; why = `${f.larp.flags} LARP flags${f.larp.items[0] ? ` · ${f.larp.items[0]}` : ''}`; }
    else if (v) why = `verdict ${v.label}${v.rug != null ? ` · rug ${(v.rug * 100).toFixed(0)}%` : ''} · no entry`;
    this.decide(t, kind, f.symbol, why, this.focusSaid);
  }

  private decide(t: number, kind: DecisionKind, symbol: string, text: string, said: string | null = null): void {
    this.decisions.push({ t, kind, symbol, text: ribbonText(text, 90), said: said ? ribbonText(said, 90) : null });
    if (this.decisions.length > MAX_DECISIONS) this.decisions.splice(0, this.decisions.length - MAX_DECISIONS);
  }

  /** The app's own mark price for a held coin (the followed terminal's live token view, or a tool result). */
  mark(mint: string, priceUsd: number, t: number): void {
    const a = this.arc;
    if (!a || a.mint !== mint || !Number.isFinite(priceUsd) || priceUsd <= 0) return;
    if (a.stage !== 'open' && a.stage !== 'closed') return;
    if (a.stage === 'closed' && a.closedAt != null && t > a.closedAt) return;
    a.mark = { priceUsd, at: t };
    if (a.entryUsd != null && a.entryUsd > 0) {
      const p = priceUsd / a.entryUsd - 1;
      a.pnlPct = p;
      if (a.peakPct === null || p > a.peakPct) { a.peakPct = p; a.peakAt = t; }
      const last = a.trace[a.trace.length - 1];
      if (!last || t - last.t >= 250) { a.trace.push({ t, pct: p }); if (a.trace.length > MAX_TRACE) a.trace.splice(0, a.trace.length - MAX_TRACE); }
      else last.pct = p;
    }
  }

  /** A line of the agent's own reasoning (from a thoughts feed) or a narration line. Scrubbed + clipped. */
  thought(raw: string, t: number, source: Thought['source'] = 'agent', demo = false): void {
    const lines = [source === 'agent' ? ribbonSummary(raw, 170) : ribbonText(raw, 120)].filter(Boolean);
    for (const text of lines) {
      const last = this.thoughts[this.thoughts.length - 1];
      if (last && last.text === text) continue;
      this.thoughts.push({ t, text, source, phase: this.phase, ...(demo ? { demo: true } : {}) });
      if (source === 'agent' && this.focus) this.focusSaid = text;
    }
    if (this.thoughts.length > MAX_THOUGHTS) this.thoughts.splice(0, this.thoughts.length - MAX_THOUGHTS);
  }

  /** The owner's control changed (pause / take over / resume / kill). */
  setControl(c: StoryControl, t: number): void {
    if (this.control === 'killed' && c !== 'killed') return; // a kill is final for this run
    if (this.control === c) return;
    this.control = c;
    this.controlAt = t;
  }

  /** Caps the app knows from the mandate the user armed (USD). */
  setCaps(caps: StoryView['caps']): void { this.caps = caps ? { ...caps } : null; }

  private touch(mint: string, symbol: string, at: number, kind: TouchKind): void {
    const prev = this.touched.get(mint);
    const rank = { scan: 0, vet: 1, open: 2, trade: 3 } as const;
    if (prev && rank[prev.kind] > rank[kind] && at - prev.at < 8000) { prev.at = Math.max(prev.at, at); return; }
    this.touched.set(mint, { mint, symbol, at, kind });
  }

  private setPhase(p: StoryPhase, t: number): void {
    if (p !== this.phase) { this.phase = p; this.phaseSince = t; }
  }

  /** Heartbeat in beats per minute: 48 at rest, faster with the call rate and in the execution moment. */
  bpm(now: number): number {
    const recent = this.callTimes.filter((x) => x > now - 30_000).length;
    let b = 48 + recent * 6;
    if (this.phase === 'executing' || this.phase === 'exiting') b += 40;
    else if (this.phase === 'holding') b += 14;
    if (this.control !== 'running') b = 0;
    return Math.max(0, Math.min(168, Math.round(b)));
  }

  /** The story at `now` (phase settles after the execution moment; stale touches drop). */
  view(now: number): StoryView {
    let phase = this.phase;
    if ((phase === 'executing' || phase === 'exiting') && now >= this.holdUntil) {
      phase = this.arc?.stage === 'open' ? 'holding' : this.lastCallAt !== null && now - this.lastCallAt > 60_000 ? 'idle' : 'scanning';
    }
    const phaseSince = phase === this.phase ? this.phaseSince : this.holdUntil;
    const touched = [...this.touched.values()].filter((r) => r.kind === 'trade' || now - r.at < TOUCH_TTL_MS);
    const cloneArc = (a: TradeArc | null): TradeArc | null => (a ? { ...a, fills: a.fills.map((f) => ({ ...f })), trace: a.trace.map((x) => ({ ...x })), position: a.position ? { ...a.position } : null, mark: a.mark ? { ...a.mark } : null, result: a.result ? { ...a.result } : null } : null);
    return {
      agent: this.agent, phase, phaseSince, sub: phase === 'holding' ? this.sub : null,
      control: this.control, controlAt: this.controlAt, bpm: this.bpm(now), lastCallAt: this.lastCallAt, calls: this.calls,
      nodes: this.nodes.map((n) => ({ ...n })), thoughts: this.thoughts.map((x) => ({ ...x })), touched,
      cursor: this.cursor ? { ...this.cursor } : null,
      focus: this.focus ? { ...this.focus, checks: [...this.focus.checks], verdict: this.focus.verdict ? { ...this.focus.verdict } : null, larp: this.focus.larp ? { ...this.focus.larp, items: [...this.focus.larp.items] } : null } : null,
      arc: cloneArc(this.arc), lastResult: cloneArc(this.lastResult), caps: this.caps ? { ...this.caps } : null,
      decisions: this.decisions.map((d) => ({ ...d })), score: { ...this.score }, beats: { ...this.beats },
    };
  }

  /** The mint of the open PAPER position (for the app to feed its mark price), or null. */
  get heldMint(): string | null { return this.arc?.stage === 'open' ? this.arc.mint : null; }
}

function newArc(id: number, mint: string, symbol: string, t: number): TradeArc {
  return { id, mint, symbol, stage: 'ticket', openedAt: t, sizeUsd: null, sellFraction: null, fills: [], position: null, entryUsd: null, spentSol: 0, mark: null, pnlPct: null, peakPct: null, peakAt: null, trace: [], filledAt: null, closedAt: null, refusal: null, result: null };
}

function nodeLabel(tool: string, d: SpectatorDetail, refused: boolean): string {
  if (refused && tool.startsWith('paper_')) return 'REFUSED';
  if (tool === 'paper_confirm' && d.fill?.side === 'sell') return 'SELL';
  return (LABEL_OF[tool] ?? tool.replace(/^get_/, '').replace(/_/g, ' ')).slice(0, 10);
}

/** dexterm's own one-line narration of a call (numbers from the detail only). */
function narrate(tool: string, d: SpectatorDetail, ev: SpectatorEvent, names: Map<string, string>, refused: boolean): string {
  const sym = (m: string | undefined | null): string => (m ? `$${names.get(m) ?? maskAddress(m)}` : '');
  if (refused) {
    if (tool.startsWith('paper_')) return `PAPER ${tool.slice(6).replace('_', ' ')} refused by the desk · ${d.refusal ?? 'refused'}`;
    return `${LABEL_OF[tool] ?? tool} failed`;
  }
  if (d.rows?.length) {
    const movers = d.rows.filter((r) => (r.chg ?? 0) > 0).length;
    return `scanning ${d.rows.length} rows · ${movers} moving up`;
  }
  if (tool === 'open_token') return `opens ${sym(d.coin?.mint ?? ev.nav?.mint)}`;
  if (d.verdict) return `verdict ${d.verdict.label}${d.verdict.rug != null ? ` · rug heuristic ${(d.verdict.rug * 100).toFixed(0)}%` : ''}`;
  if (d.larp) return `LARP evidence · ${d.larp.flags} flag${d.larp.flags === 1 ? '' : 's'}${d.larp.items[0] ? ` · ${d.larp.items[0]}` : ''}`;
  if (d.fill) {
    const f = d.fill;
    if (f.side === 'buy') return `PAPER FILL · ${Math.abs(f.sol).toFixed(4)} SOL → ${fmtQty(f.qty)} ${sym(f.mint)}${f.priceUsd != null ? ` @ $${fmtPx(f.priceUsd)}` : ''}`;
    return `PAPER SELL · ${fmtQty(f.qty)} ${sym(f.mint)} → ${fmtSol(f.sol)}${f.realizedSol != null ? ` · realized ${fmtSol(f.realizedSol)}` : ''}`;
  }
  if (d.ticket) {
    const tk = d.ticket;
    if (tk.side === 'buy') return tk.usd != null ? `PAPER ticket · BUY ${sym(tk.mint)} ${fmtUsd(tk.usd)}` : `PAPER ticket · BUY ${sym(tk.mint)}`;
    return tk.fraction != null ? `PAPER ticket · SELL ${(tk.fraction * 100).toFixed(0)}% of ${sym(tk.mint)}` : `PAPER ticket · SELL ${sym(tk.mint)}`;
  }
  const chk = CHECK_OF[tool];
  if (chk && d.coin) return `checks ${sym(d.coin.mint)} · ${chk}`;
  return '';
}

/** Compact token quantity (1.2M, 34.5K). */
export function fmtQty(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(a >= 10 ? 0 : 2);
}

/** A price in USD with enough significant digits for a micro-cap (0.0000531). */
export function fmtPx(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1) return n.toFixed(4);
  const s = n.toPrecision(3);
  return s.includes('e') ? n.toFixed(10).replace(/0+$/, '') : s;
}

export { pct as fmtSignedPct };
