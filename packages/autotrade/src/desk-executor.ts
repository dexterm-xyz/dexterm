// dexterm autotrade — the paper-desk executor (task-1506 AT-4, AUTOTRADE-SPEC §5, §6.1). PAPER ONLY.
//
// Autotrade's orders through the app's existing paper desk (PaperExitDesk: the PaperAgentDesk plus exit plans)
// instead of the backtest fill model, so the agent
// path inherits every fence the desk already has: the armed mandate's caps at the agent tier (hands-free × 0.25),
// the panic file, the control file, the keyless Jupiter quote with its bounded retry, and the hash-chained
// journal. The strategy clamp has already sized the order; the desk's caps sit around it and both apply.
//
//   buy()   an entry or a ladder add. Refused unless the mandate is armed AND paper-only, and refused while the
//           position monitor's heartbeat is stale (the monitor must be up to run the exits). Every entry fill
//           registers its desk-side exit plan (P1), and carries a note (P4) naming the run, position and profile.
//   sell()  a mechanical or agent exit, journaled by the desk as agent.paper.exit.<rule>.
//   costRecoverySellUsd()  the proceeds curve a cost-recovery sell is sized on: a linear-impact estimate from one
//           quote of the largest allowed slice, one confirming quote at the estimate, and at most one correction:
//           never more than 3 quotes, inside the keyless budget.
//   book()  the desk's book in USD, for `bankroll.source: desk`.
//
// Nothing here can sign, send or touch a key: the desk only accepts a paper executor, and this file imports
// types only from the data layer (a refusal is recognised by its error name).

import type { ExitPlan, PaperExitDesk, PaperPositionView, TradeRecord } from '@dexterm/data';
import type { Mandate } from '@dexterm/data/plans';
import type { Fill, Position } from './engine.ts';
import type { MarketTick } from './replay.ts';
import type { OrderContext } from './runner.ts';
import type { ExitProfile } from './strategy.ts';

export const DESK_EXIT_OWNER = 'autotrade-monitor';
/** Most quotes a cost-recovery slice is sized on (the fill then takes its own fresh quote, as every desk fill does). */
export const MAX_SIZING_QUOTES = 3;

export type ExecResult = Fill | { refused: string };

/** What the runner knows about an entry when it places it (all optional: the executor fills in the rest). */
export interface EntryContext extends OrderContext { positionId?: string; profile?: string; sessionId?: string | null; reason?: string; kind?: 'open' | 'add' }
/** What an exit carries into the desk journal. */
export interface ExitContext { detail?: string; positionId?: string; agentReason?: string }

export interface DeskExecutorDeps {
  desk: PaperExitDesk;
  /** The mandate the desk runs under (re-read every call): entries need it armed and paper-only. */
  mandate: () => Mandate | null;
  /** USD per SOL (the desk prices its caps with the same read); null refuses. */
  solUsd: () => number | null;
  /** Token decimals for a mint (from the tick source / token metadata); null refuses the entry. */
  decimals: (mint: string) => number | null;
  /** True while the position monitor's heartbeat is fresh. Entries are refused otherwise (spec §5 dead-man). */
  monitorAlive: () => boolean;
  /** The strategy's default exit profile (an entry without a profile gets it). */
  defaultProfile: string;
  runId?: string | null;
  strategy?: { id: string; hash: string };
  now?: () => number;
}

const errReason = (e: unknown): string => (e instanceof Error && e.name === 'PaperDeskError' ? `desk-${(e as Error & { reason: string }).reason}` : `desk-error:${e instanceof Error ? e.message.slice(0, 120) : String(e)}`);
const r6 = (x: number) => Number(x.toPrecision(6));

export class DeskExecutor {
  readonly name = 'paper-desk';
  /** The monitor process owns the exits of every position this executor opens (a runner must not run them inline). */
  readonly exitsByMonitor = true;
  private readonly d: DeskExecutorDeps;
  private readonly now: () => number;
  private seq = 0;

  constructor(deps: DeskExecutorDeps) {
    this.d = deps;
    this.now = deps.now ?? Date.now;
  }

  /** Why an entry may not go to the desk right now, or null. */
  entryBlock(): string | null {
    const m = this.d.mandate();
    if (!m) return 'no-mandate';
    if (m.paperOnly !== true) return 'mandate-not-paper-only';
    if (m.status !== 'armed' || !m.armedBy) return 'mandate-not-armed';
    if (!this.d.monitorAlive()) return 'monitor-heartbeat-stale';
    return null;
  }

  private held(mint: string): PaperPositionView | null {
    return this.d.desk.positions().find((p) => p.mint === mint && p.tokens > 0) ?? null;
  }

  private toFill(k: MarketTick, rec: TradeRecord, reason: string): Fill {
    const solUsd = this.d.solUsd() ?? (rec.priceUsd && rec.priceSol ? rec.priceUsd / rec.priceSol : 0);
    const usd = (Math.abs(Number(rec.solDelta)) / 1e9) * solUsd;
    const tokens = Math.abs(Number(rec.tokenDelta)) / 10 ** rec.decimals;
    return {
      t: rec.t, side: rec.side, usd: r6(usd), tokens, price: k.price ?? (rec.priceSol * solUsd), avgPrice: tokens > 0 ? r6(usd / tokens) : 0,
      impactPct: rec.priceImpactPct ?? 0, partial: false, reason,
    };
  }

  /** An entry (or a ladder add) of `usd` through the desk, with its exit plan registered on the first fill. */
  async buy(k: MarketTick, usd: number, ctx: EntryContext = {}): Promise<ExecResult> {
    const block = this.entryBlock();
    if (block) return { refused: block };
    const decimals = this.d.decimals(k.mint);
    if (decimals === null) return { refused: 'decimals-unknown' };
    const kind = ctx.kind ?? (this.held(k.mint) ? 'add' : 'open');
    const profile = ctx.profile ?? this.d.defaultProfile;
    const positionId = ctx.positionId ?? `${this.d.runId ?? 'run'}:${k.mint.slice(0, 8)}:${this.now().toString(36)}${++this.seq}`;
    const note = {
      by: 'autotrade', kind, positionId, profile, runId: this.d.runId ?? null, sessionId: ctx.sessionId ?? null, mid: k.price,
      ...(this.d.strategy ? { strategy: this.d.strategy.id, strategyHash: this.d.strategy.hash } : {}),
      ...(ctx.reason ? { reason: ctx.reason.slice(0, 200) } : {}),
    };
    try {
      const t = this.d.desk.open({ mint: k.mint, symbol: k.symbol, decimals, side: 'buy' });
      this.d.desk.size(t.id, { usd });
      const { fill } = await this.d.desk.confirm(t.id, { note });
      if (kind === 'open') this.d.desk.registerExitPlan({ mint: k.mint, owner: DESK_EXIT_OWNER, positionId, profileId: profile, runId: this.d.runId ?? null, note: { sessionId: ctx.sessionId ?? null } });
      return this.toFill(k, fill, kind === 'open' ? 'entry' : 'ladder-add');
    } catch (e) {
      return { refused: errReason(e) };
    }
  }

  /** Sell `tokens` of the held position as exit rule `reason` (journaled agent.paper.exit.<reason>). */
  async sell(k: MarketTick, tokens: number, reason: string, ctx: ExitContext = {}): Promise<ExecResult> {
    const pos = this.held(k.mint);
    if (!pos) return { refused: 'no-position' };
    const fraction = Math.min(1, tokens / pos.tokens);
    if (!(fraction > 0)) return { refused: 'nothing-to-sell' };
    try {
      const r = await this.d.desk.exit({
        mint: k.mint, fraction: fraction >= 0.999999 ? 1 : fraction, rule: reason, detail: ctx.detail,
        note: { by: 'autotrade', runId: this.d.runId ?? null, ...(ctx.positionId ? { positionId: ctx.positionId } : {}), ...(ctx.agentReason ? { agentReason: ctx.agentReason.slice(0, 200) } : {}) },
      });
      return this.toFill(k, r.fill, reason);
    } catch (e) {
      return { refused: errReason(e) };
    }
  }

  /**
   * The proceeds curve for a cost-recovery sell, from at most MAX_SIZING_QUOTES desk quotes (spec §9 AT-4):
   *   1. quote the largest allowed slice (maxSellFrac of the bag): proceeds P at size C;
   *   2. a linear-impact model through it (proceeds(t) = t·m·(1 − a·t), m = the tick's mid price) gives the
   *      slice t* that nets the owed cost; quote t* to confirm;
   *   3. if the confirmation is short, scale once (t3 = t*·owed/proceeds(t*), at most C) and quote that.
   * Returns a monotone piecewise-linear `sellUsd(tokens)` through the quoted points for monitorTick's search, or
   * null when no quote could be had (the monitor then waits for the next tick: a cost-recovery sell is never
   * sized on a guess).
   */
  async costRecoverySellUsd(p: Position, prof: ExitProfile, k: MarketTick): Promise<{ sellUsd: (tokens: number) => number; quotes: number } | null> {
    const cr = prof.costRecovery;
    const solUsd = this.d.solUsd();
    if (!cr || !solUsd || !k.price || p.tokens <= 0) return null;
    const owed = p.costUsd - p.realizedUsd;
    const cap = p.tokens * cr.maxSellFrac;
    let quotes = 0;
    const quote = async (tokens: number): Promise<number | null> => {
      if (quotes >= MAX_SIZING_QUOTES) return null;
      quotes++;
      try { const q = await this.d.desk.previewSell({ mint: p.mint, fraction: Math.min(1, tokens / p.tokens) }); return q.solOut * solUsd; } catch { return null; }
    };
    const pts: [number, number][] = [[0, 0]];
    const pc = await quote(cap);
    if (pc === null) return null;
    pts.push([cap, pc]);
    if (owed > 0 && pc > owed) {
      const m = k.price;
      const a = Math.max(0, (1 - pc / (cap * m)) / cap);
      // smaller root of a·m·t² − m·t + owed = 0 (or the no-impact line when a = 0)
      const disc = m * m - 4 * a * m * owed;
      const est = a > 0 && disc > 0 ? (m - Math.sqrt(disc)) / (2 * a * m) : owed / m;
      const t1 = Math.min(cap, Math.max(cap * 1e-6, est));
      const p1 = await quote(t1);
      if (p1 !== null) {
        pts.push([t1, p1]);
        if (p1 < owed && p1 > 0) {
          const t2 = Math.min(cap, (t1 * owed) / p1);
          const p2 = t2 > t1 ? await quote(t2) : null;
          if (p2 !== null) pts.push([t2, p2]);
        }
      }
    }
    pts.sort((x, y) => x[0] - y[0]);
    for (let i = 1; i < pts.length; i++) pts[i][1] = Math.max(pts[i][1], pts[i - 1][1]); // monotone
    const sellUsd = (t: number): number => {
      if (t <= 0) return 0;
      for (let i = 1; i < pts.length; i++) {
        const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
        if (t <= x1) return x1 === x0 ? y1 : y0 + ((y1 - y0) * (t - x0)) / (x1 - x0);
      }
      return pts[pts.length - 1][1];
    };
    return { sellUsd, quotes };
  }

  /** The desk's paper book in USD (for `bankroll.source: desk`): cash, open cost, and their sum. */
  book(): { paper: true; cashUsd: number; openCostUsd: number; equityUsd: number; solUsd: number } | null {
    const solUsd = this.d.solUsd();
    if (!solUsd) return null;
    const v = this.d.desk.pnl();
    const cashUsd = v.balanceSol * solUsd;
    const openCostUsd = v.openCostSol * solUsd;
    return { paper: true, cashUsd: r6(cashUsd), openCostUsd: r6(openCostUsd), equityUsd: r6(cashUsd + openCostUsd), solUsd };
  }

  /** The desk's exit plans (read-only). */
  exitPlans(): ExitPlan[] { return this.d.desk.exitPlans(); }
}
