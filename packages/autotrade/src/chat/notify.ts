// dexterm autotrade chat — tier 1, notify (task-1527, AUTOTRADE-SPEC §8.4, §8.6).
//
// The bus reads the run ledger as it is written (every event the runner already records) and the runner's state,
// and turns them into short plain-text messages, each led by its badge (PAPER / DEVNET / LIVE):
//   candidate found      a digest every 15 minutes (default), each one, or off
//   entry / exit         side, size ($ and % of the book), price, profile, exit reason, the agent's reason (inert)
//   trade closed         the PnL card image (when the host can render it) + one line
//   halts and guards     state, reason, what clears it (kill, stop, flatten, pause, breaker, stuck bag, guard)
//   spend / allowance    once a day each, at 80 % of the day's model spend cap or of a usage window
//   daily summary        at dailySummaryAt local: trades, wins/losses, day P/L %, open positions, spend, state,
//                        approvals (tapped / skipped / expired)
// Shown: badge, symbol (inert), short mint, strategy id/version/short hash, the trade's size and % of the book, P/L
// in % (and $ per trade), day P/L in %. Hidden: keys, the token, wallet addresses, the absolute book (opt-in for
// paper only), file paths, RPC URLs.
// Rate: above 20 messages a minute the bus switches to digests (notify-only lines wait for the next flush); quiet
// hours hold notify-only lines too. Halts always go. The engine never waits on any of this.

import type { LedgerEvent } from '../ledger.ts';
import type { RunnerState } from '../runner.ts';
import type { Badge } from '../execution-port.ts';
import type { OutMessage } from './connector.ts';
import { localDay as localDayOf } from './audit.ts';
import { inQuietHours, type TelegramConfig } from './config.ts';
import { inert, pct, price, shortMint, usdShort } from './format.ts';

export const DIGEST_EVERY_MS = 15 * 60_000;
export const DIGEST_ABOVE_PER_MIN = 20;

/** What the host renders a PnL card from (engine numbers only). */
export interface ClosedTradeView {
  id: string; mint: string; symbol: string; profileId: string; openedAt: number; closedAt: number; costUsd: number; proceedsUsd: number; pnlUsd: number; pnlPct: number; exitReason: string;
  /** The position's fills from the run ledger (USD and tokens), for the card. */
  fills?: { t: number; side: 'buy' | 'sell'; usd: number; tokens: number }[];
}

export interface NotifyOpts {
  /** Deliver to every chat paired with the notify tier. `urgent` skips quiet hours and the digest switch. */
  send: (msg: OutMessage, o: { urgent: boolean; template: string }) => Promise<void>;
  config: () => TelegramConfig;
  badge: Badge;
  now?: () => number;
  /** The PnL card PNG for a closed trade, or null (the line still goes). */
  card?: (t: ClosedTradeView) => Promise<Uint8Array | null>;
  /** Proposal counts by state since a time (the daily summary). */
  approvalCounts?: (since: number) => Record<string, number>;
}

const HALT_CLEARS: Record<string, string> = {
  'kill-switch': 'the panic switch is on: only `dexterm wallet resume` on your computer lifts it',
  stop: 'this run takes no new entries and ends once nothing is held; start a new run on your computer',
  flatten: 'every position sells at its next tick, then this run ends',
  'control-unreadable': 'the control file cannot be read: look at it on your computer',
  'runner-stopped': 'stopped on your computer',
  'daily-loss': 'the daily loss limit: entries stay off for the rest of the day; it clears locally',
  drawdown: 'the drawdown limit: entries stay off; it clears locally',
};

export class NotifyBus {
  private readonly o: NotifyOpts;
  private readonly now: () => number;
  private readonly symbols = new Map<string, string>();
  private readonly reasons = new Map<string, string>();
  private readonly profiles = new Map<string, string>();
  private readonly fillsByPosition = new Map<string, NonNullable<ClosedTradeView['fills']>>();
  private candidates: string[] = [];
  private digest: string[] = [];
  private lastDigestAt: number;
  private readonly sentAt: number[] = [];
  private queue: Promise<void> = Promise.resolve();
  private state: RunnerState | null = null;
  private strategyLine = '';
  /** task-1532: the run's strategy carries the HIGH RISK label (the yolo preset): every entry and the start say so. */
  private highRisk = false;
  private day = '';
  private dayStats = { closed: 0, wins: 0, losses: 0, pnlUsd: 0 };
  private warned = new Set<string>();
  private summarySentFor = '';
  private readonly dayStart: () => number;
  /** task-1645: a run in mode real is LIVE in every message (its trades go to the user's executor as signals). */
  private realRun = false;
  private badge(): Badge { return this.realRun ? 'LIVE' : this.o.badge; }

  constructor(o: NotifyOpts) {
    this.o = o;
    this.now = o.now ?? Date.now;
    this.lastDigestAt = this.now();
    this.dayStart = () => { const d = new Date(this.now()); d.setHours(0, 0, 0, 0); return d.getTime(); };
  }

  /** Every run ledger event, as it is written. Never throws, never blocks the runner. */
  onEvent(e: LedgerEvent): void {
    try { this.handle(e); } catch { /* a notify failure never reaches the engine */ }
  }

  onState(st: RunnerState): void {
    this.state = st;
    this.strategyLine = `${this.highRisk ? '⚠ HIGH RISK · ' : ''}${inert(st.strategy.id, 32)} v${inert(st.strategy.version, 12)} (${st.strategy.hash.slice(0, 8)})`;
    this.spendWarnings(st);
  }

  private prefs() { return this.o.config().notify; }

  private rollDay(): void {
    const d = localDayOf(this.now());
    if (d !== this.day) { this.day = d; this.dayStats = { closed: 0, wins: 0, losses: 0, pnlUsd: 0 }; this.warned = new Set(); }
  }

  private emit(template: string, lines: string[], urgent = false): void {
    this.post(template, { kind: 'text', badge: this.badge(), lines }, urgent);
  }

  private post(template: string, msg: OutMessage, urgent: boolean): void {
    const now = this.now();
    while (this.sentAt.length && now - this.sentAt[0] > 60_000) this.sentAt.shift();
    const quiet = inQuietHours(this.o.config().quietHours, now);
    if (!urgent && (quiet || this.sentAt.length >= DIGEST_ABOVE_PER_MIN)) {
      this.digest.push(msg.kind === 'card' ? msg.caption : msg.lines.join(' · '));
      return;
    }
    this.sentAt.push(now);
    this.queue = this.queue.then(() => this.o.send(msg, { urgent, template })).catch(() => { /* the host retries and audits */ });
  }

  /** Book share of a size, as text ("2.0% of book"). The absolute book only when opted in (paper). */
  private ofBook(usd: number): string {
    const eq = this.state?.book.equityUsd ?? 0;
    const share = eq > 0 ? `${((usd / eq) * 100).toFixed(1)}% of book` : '% of book unknown';
    return this.o.config().showAbsoluteBook && this.badge() === 'PAPER' && eq > 0 ? `${share}, book ${usdShort(eq)}` : share;
  }

  private sym(mint: string, fallback?: unknown): string { return `"${inert(this.symbols.get(mint) ?? fallback ?? '?', 20)}" ${shortMint(mint)}`; }

  private handle(e: LedgerEvent): void {
    this.rollDay();
    const p = this.prefs();
    const mint = typeof e.mint === 'string' ? e.mint : '';
    switch (e.kind) {
      case 'run_start': {
        this.highRisk = e.highRisk === true;
        this.realRun = e.mode === 'real';
        this.strategyLine = `${this.highRisk ? '⚠ HIGH RISK · ' : ''}${inert(e.strategy, 32)} v${inert(e.version, 12)} (${String(e.strategyHash ?? '').slice(0, 8)})`;
        this.emit('run_start', [`RUNNER STARTED · ${this.strategyLine}`, ...(this.highRisk ? ['full-port strategy: one entry can be the whole stake, and one rug can zero it. Experimental; not financial advice.'] : []), ...(this.realRun ? ['REAL MODE: every trade below also goes to YOUR executor as a LIVE TRADE FIRE signal (dexterm holds no key). Experimental; not financial advice.'] : []), `entries: ${e.decide === 'agent+approve' || e.approvals === 'required' ? 'each one waits for your tap' : String(e.decide) === 'auto' ? 'mechanical' : 'your agent decides'} · /status /pause /kill /help`], true);
        return;
      }
      case 'candidate': {
        this.symbols.set(mint, String(e.symbol ?? '?'));
        if (p.candidates === 'off') return;
        const line = `${this.sym(mint, e.symbol)} matched ${Array.isArray(e.matched) ? (e.matched as unknown[]).map((m) => inert(m, 24)).join(', ') : '?'}`;
        if (p.candidates === 'each') this.emit('candidate', [`CANDIDATE · ${line}`]);
        else this.candidates.push(line);
        return;
      }
      case 'reply': {
        const d = e.decision as { ok?: boolean; decision?: { action?: string; reason?: string; profile?: string } } | undefined;
        if (mint && d?.ok && d.decision?.reason) this.reasons.set(mint, d.decision.reason);
        return;
      }
      case 'fill': {
        const side = e.side === 'buy' ? 'buy' : 'sell';
        if (typeof e.positionId === 'string') {
          const fs = this.fillsByPosition.get(e.positionId) ?? [];
          fs.push({ t: e.t, side, usd: Number(e.usd), tokens: Number(e.tokens) });
          this.fillsByPosition.set(e.positionId, fs);
        }
        if (side === 'buy') {
          if (typeof e.profile === 'string') this.profiles.set(mint, e.profile);
          if (!p.entries) return;
          const why = this.reasons.get(mint);
          this.emit('entry', [
            `${e.reason === 'ladder-add' ? 'ADD' : 'ENTRY'} · ${this.strategyLine}`,
            `${this.sym(mint)} · ${usdShort(Number(e.usd))} (${this.ofBook(Number(e.usd))}) @ ${price(Number(e.price))}${e.impactPct !== undefined ? ` · impact ${Number(e.impactPct).toFixed(2)}%` : ''}${e.partial ? ' · PARTIAL' : ''}`,
            ...(typeof e.profile === 'string' ? [`profile ${inert(e.profile, 32)}`] : []),
            ...(why && e.reason !== 'ladder-add' ? [`why (the agent's words): "${inert(why, 280, 'agent')}"`] : []),
          ]);
        } else {
          if (!p.entries) return;
          this.emit('exit', [`${e.reason === 'cost-recovery' ? 'COST RECOVERED' : 'EXIT'} · ${this.sym(mint)}`, `sold ${usdShort(Number(e.usd))} @ ${price(Number(e.price))} · ${inert(e.reason, 40)}${typeof e.detail === 'string' ? ` · ${inert(e.detail, 120)}` : ''}`]);
        }
        return;
      }
      case 'trade_closed': {
        const t0 = e.trade as ClosedTradeView | undefined;
        if (!t0) return;
        const t: ClosedTradeView = { ...t0, fills: this.fillsByPosition.get(t0.id) ?? [] };
        this.fillsByPosition.delete(t0.id);
        this.dayStats.closed++;
        this.dayStats.pnlUsd += t.pnlUsd;
        if (t.pnlUsd >= 0) this.dayStats.wins++; else this.dayStats.losses++;
        this.symbols.delete(t.mint); this.reasons.delete(t.mint);
        if (!p.closes) return;
        const caption = `CLOSED · "${inert(t.symbol, 20)}" ${shortMint(t.mint)} · ${pct(t.pnlPct)} (${t.pnlUsd >= 0 ? '+' : ''}${usdShort(t.pnlUsd)}) by ${inert(t.exitReason, 40)} · held ${Math.max(1, Math.round((t.closedAt - t.openedAt) / 60_000))} min`;
        const card = this.o.card;
        // task-1645: a real run's close is the monitor's modelled view, not your executor's fills: text only, no
        // shareable card (the receipts say what really filled).
        if (this.realRun) { this.emit('closed', [`${caption} · modelled; your executor's fills may differ (dexterm autotrade receipt list)`]); return; }
        if (!card) { this.emit('closed', [caption]); return; }
        void card(t).then((png) => {
          if (png) this.post('closed_card', { kind: 'card', badge: this.badge(), png, caption }, false);
          else this.emit('closed', [caption]);
        }, () => this.emit('closed', [caption]));
        return;
      }
      case 'halt': {
        if (!p.halts) return;
        const r = String(e.reason ?? '?');
        this.emit('halt', [`HALT · ${inert(r, 40)}`, HALT_CLEARS[r] ?? 'clears locally', `open positions keep their exits${typeof e.openPositions === 'number' ? ` (${e.openPositions} open)` : ''}`], true);
        return;
      }
      case 'flatten': {
        const n = Array.isArray(e.positions) ? e.positions.length : 0;
        this.emit('flatten', [`FLATTEN · ${n} position${n === 1 ? '' : 's'} sell at the next tick`], true);
        return;
      }
      case 'entries_paused': if (p.halts) this.emit('paused', [`PAUSED · no new entries (${inert(e.reason, 40)})`, 'exits keep running · /resume lifts a pause'], true); return;
      case 'entries_resumed': if (p.halts) this.emit('resumed', ['RESUMED · new entries allowed again'], true); return;
      case 'guard': if (p.halts) this.emit('guard', [`GUARD · ${inert(e.state, 40)}`, inert(e.effect, 160)], true); return;
      case 'stuck': if (p.halts) this.emit('stuck', [`STUCK · ${this.sym(mint)} cannot sell (${inert(e.why, 60)})`, 'retried every tick'], true); return;
      case 'stopped_flat': this.emit('stopped', ['RUNNER STOPPED · nothing held'], true); return;
      case 'run_end': this.emit('run_end', [`RUNNER ENDED · ${Number(e.trades ?? 0)} closed, ${Number(e.openAtEnd ?? 0)} open`], true); return;
      default: return;
    }
  }

  private spendWarnings(st: RunnerState): void {
    if (!this.prefs().spend) return;
    this.rollDay();
    const s = st.spend;
    if (Number.isFinite(s.dayCapUsd) && s.dayCapUsd > 0 && s.todayUsd >= 0.8 * s.dayCapUsd && !this.warned.has('spend')) {
      this.warned.add('spend');
      this.emit('spend', [`SPEND · model spend today ${Math.round((s.todayUsd / s.dayCapUsd) * 100)}% of the day cap`, 'new sessions stop at the cap; exits keep running'], true);
    }
    for (const [k, v] of [['five-hour', s.allowance?.fiveHour], ['seven-day', s.allowance?.sevenDay]] as const) {
      if (typeof v === 'number' && v >= 0.8 && !this.warned.has(k)) { this.warned.add(k); this.emit('allowance', [`USAGE · your ${k} Claude window is at ${Math.round(v * 100)}%`], true); }
    }
  }

  /** Digests, the daily summary. The host calls it every few seconds; tests call it with a moved clock. */
  async tick(): Promise<void> {
    const now = this.now();
    this.rollDay();
    if (this.candidates.length && now - this.lastDigestAt >= DIGEST_EVERY_MS) {
      const n = this.candidates.length;
      const lines = this.candidates.splice(0, n);
      this.emit('candidate_digest', [`CANDIDATES · ${n} in the last ${Math.round((now - this.lastDigestAt) / 60_000)} min`, ...lines.slice(0, 10), ...(n > 10 ? [`…and ${n - 10} more`] : [])]);
      this.lastDigestAt = now;
    } else if (!this.candidates.length && now - this.lastDigestAt >= DIGEST_EVERY_MS) this.lastDigestAt = now;
    const quiet = inQuietHours(this.o.config().quietHours, now);
    while (this.sentAt.length && now - this.sentAt[0] > 60_000) this.sentAt.shift();
    if (this.digest.length && !quiet && this.sentAt.length < DIGEST_ABOVE_PER_MIN / 2) {
      const lines = this.digest.splice(0);
      this.post('digest', { kind: 'text', badge: this.badge(), lines: [`DIGEST · ${lines.length} update${lines.length === 1 ? '' : 's'}`, ...lines.slice(-25)] }, true);
    }
    this.maybeSummary(now);
    await this.queue;
  }

  private maybeSummary(now: number): void {
    const at = this.o.config().dailySummaryAt;
    if (!at || !this.prefs().daily) return;
    const [h, m] = at.split(':').map(Number);
    const d = new Date(now);
    if (d.getHours() * 60 + d.getMinutes() < h * 60 + m) return;
    const day = localDayOf(now);
    if (this.summarySentFor === day) return;
    this.summarySentFor = day;
    this.post('daily', { kind: 'text', badge: this.badge(), lines: this.summaryLines() }, true);
  }

  summaryLines(): string[] {
    const st = this.state;
    const ds = this.dayStats;
    const start = st ? st.book.equityUsd - st.book.realizedTodayUsd : 0;
    const dayPct = st && start > 0 ? (st.book.realizedTodayUsd / start) * 100 : null;
    const ap = this.o.approvalCounts?.(this.dayStart()) ?? null;
    const apLine = ap && Object.keys(ap).length ? `approvals: ${Object.entries(ap).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(', ')}` : null;
    return [
      `DAILY SUMMARY · ${this.strategyLine || 'no run'}`,
      `trades closed ${ds.closed} (${ds.wins} won, ${ds.losses} lost) · day P/L ${pct(dayPct)}`,
      `open positions ${st?.positions.length ?? 0} · state ${st ? `${st.state}${st.haltReason ? ` (${inert(st.haltReason, 40)})` : ''}` : 'unknown'}`,
      `model spend today ${st ? `$${st.spend.todayUsd.toFixed(2)}${Number.isFinite(st.spend.dayCapUsd) ? ` of $${st.spend.dayCapUsd}` : ''}` : '?'}`,
      ...(apLine ? [apLine] : []),
    ];
  }

  /** Wait for everything queued (end of the host). */
  async flush(): Promise<void> { await this.queue; }
}
