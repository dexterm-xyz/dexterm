// @dexterm/mcp — the TRADE LEDGER tools and their neighbours (task-1530). Read-only, plus one PROPOSE tool.
//
//   ledger_trades      observe  trades from the unified ledger (paper, desk, autotrade, live), filtered, newest first
//   ledger_positions   observe  the open trades (cost, held time, profile); no price fetch, no balance
//   ledger_equity      observe  the realized equity curve and its drawdown
//   ledger_summary     observe  win rate (with its 95 % interval), P/L, drawdown, rug rate, per-profile / exit / strategy
//   ledger_compare     observe  one row per strategy version: the forward-test table
//   candidate_dossier  observe  what an autotrade run recorded about a candidate: the rules it matched, the tick,
//                               the session's decisions, the clamp, the fills and the close
//   outcomes_lookup    observe  the recorder's outcome labels (rug / dead / fade / flat / runner) for a coin, or for
//                               every candidate of a run (what the skips turned into)
//   telegram_status    observe  the Telegram connector's settings: enabled, paired chats (a count), approvals, notify
//   trading_status     observe  where live trading happens (task-1571: not in dexterm; it holds no key and places no
//                               live order), whether the panic switch is engaged, and real mode's state (task-1645)
//   trade_fire_feed      observe  task-1645: the MCP channel of real mode: the LIVE TRADE FIRE signals of the feed
//                               (autotrade/real/mcp-feed.jsonl) after a nonce, and real mode's status. Reading is all it
//                               does: no tool arms real mode, changes a cap, lifts the kill switch or records a receipt
//   trading_limits     observe  task-1654: real mode's limits in force (for a strategy / account / mode), where each
//                               number comes from, what each limit does, today's counters and the executor's health
//   backtest_requests  observe  the backtests this agent asked for, and their results once the user ran them
//   backtest_request   propose  ask the user to run a longer backtest (a request file; the user runs or dismisses it)
//   limits_propose     propose  task-1654: a limits change as a DIFF CARD (old -> new, which numbers it raises, the
//                               exact command the user would type). It writes nothing at all: only the user applies a
//                               change, on their own terminal (`dexterm autotrade limits set`; a raise is typed)
//
// Nothing here can trade, sign, change a cap, enable live or touch a key: the ledger is read through
// `@dexterm/autotrade`'s loader (pure file reads, loaded lazily: @dexterm/autotrade imports this package). Text that
// came from a token or an agent is firewalled before it is returned.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { cleanLedgerText, compareStrategies, equityCurve, filterTrades, summarize, type TradeFilter, type TradeRow, type LedgerView } from '@dexterm/data/ledger';
import { firewall } from './firewall.ts';
import { dextermHome } from './user-content.ts';
import { BacktestRequests, MAX_PENDING_REQUESTS, REQUEST_MAX_DAYS, REQUEST_RATE_PER_HOUR } from './backtest-requests.ts';

export const LEDGER_READ_TOOLS: readonly string[] = [
  'ledger_trades', 'ledger_positions', 'ledger_equity', 'ledger_summary', 'ledger_compare',
  'candidate_dossier', 'outcomes_lookup', 'telegram_status', 'trading_status', 'trade_fire_feed', 'trading_limits', 'backtest_requests',
];
/** Write-shaped (a request file), so not on the read-only surface a skill may name. */
export const LEDGER_PROPOSE_TOOLS: readonly string[] = ['backtest_request', 'limits_propose'];
export const LEDGER_TOOLS: readonly string[] = [...LEDGER_READ_TOOLS, ...LEDGER_PROPOSE_TOOLS];

const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const RUN_ID = /^[0-9TZ]+-[a-z][a-z0-9-]{1,31}-[0-9a-f]{4}$/;
const DAY_MS = 86_400_000;

export interface LedgerToolsOpts {
  env?: NodeJS.ProcessEnv;
  actor?: string;
  now?: () => number;
  /** The recorder DB opened read-only (outcomes). */
  historyDb?: () => DatabaseSync | null;
  /** Tests: the ledger view instead of the real loader. */
  view?: () => LedgerView | Promise<LedgerView>;
  /** Tests / CLI: the strategy lookup for backtest_request (default: the autotrade store, loaded lazily). */
  strategyInfo?: (id: string) => Promise<{ ok: boolean; version: string | null; hash: string | null; why?: string } | null>;
}

const fw = (s: string | null | undefined, kind: string): string | null => (s ? firewall(s, 'ledger', kind) : null);
const iso = (t: number | null | undefined): string | null => (typeof t === 'number' && Number.isFinite(t) ? new Date(t < 1e12 ? t * 1000 : t).toISOString() : null);

/** The compact, firewalled view of one trade an agent gets (fills only when asked). */
export function tradeView(t: TradeRow, o: { fills?: boolean } = {}): Record<string, unknown> {
  return {
    tradeId: t.tradeId, source: t.source, walletMode: t.walletMode, status: t.status, mint: t.mint, symbol: fw(t.symbol, 'symbol'),
    strategy: t.strategy, runId: t.runId, account: t.account ?? null,
    profile: t.profile, reprofiles: t.reprofiles.map((r) => ({ at: iso(r.t), from: r.from, to: r.to, reason: fw(r.reason, 'reason') })),
    entryReason: { text: fw(t.entryReason.text, 'reason'), source: t.entryReason.source },
    exitReason: { code: t.exitReason.code, text: fw(t.exitReason.text, 'reason'), source: t.exitReason.source },
    openedAt: iso(t.openedAt), closedAt: iso(t.closedAt), holdSec: t.holdSec,
    sizeSol: t.sizeSol, sizeUsd: t.sizeUsd, pctOfBook: t.pctOfBook,
    entry: { priceSol: t.entryPriceSol, priceUsd: t.entryPriceUsd, mcapUsd: t.entryMcapUsd },
    exit: { priceSol: t.exitPriceSol, priceUsd: t.exitPriceUsd, mcapUsd: t.exitMcapUsd },
    supply: t.supply, pnlSol: t.pnlSol, pnlUsd: t.pnlUsd, pnlPct: t.pnlPct,
    feesSol: t.feesSol, impactPct: { entry: t.impactPctEntry, exit: t.impactPctExit }, slippageBps: t.slippageBps,
    mfePct: t.mfePct, maePct: t.maePct, excursionBasis: t.excursionBasis, rug: t.rug, rugWhy: t.rugWhy, stuck: t.stuck,
    txSigs: t.txSigs, model: t.model,
    ...(o.fills ? { fills: t.fills.map((f) => ({ ...f, at: iso(f.t) })) } : {}),
  };
}

/** Tool args → a ledger filter. Unknown values are refused, never guessed. */
export function filterFromArgs(a: Record<string, unknown>, now: number): { ok: true; filter: TradeFilter } | { ok: false; error: string } {
  const f: TradeFilter = {};
  const pick = <T extends string>(k: string, allowed: readonly T[]): T | undefined | false => {
    if (a[k] === undefined) return undefined;
    return (allowed as readonly unknown[]).includes(a[k]) ? a[k] as T : false;
  };
  const source = pick('source', ['paper', 'desk', 'autotrade', 'live'] as const);
  const mode = pick('mode', ['paper', 'devnet', 'live', 'real'] as const);
  const status = pick('status', ['open', 'closed'] as const);
  if (source === false || mode === false || status === false) return { ok: false, error: 'source is paper|desk|autotrade|live, mode is paper|devnet|live|real, status is open|closed' };
  if (source) f.source = source;
  if (mode) f.mode = mode;
  if (status) f.status = status;
  for (const [k, key, re] of [['strategy', 'strategy', /^[a-z][a-z0-9-]{0,31}(@[0-9a-z.]{1,16})?$/], ['profile', 'profile', /^[a-z][a-z0-9-]{0,31}$/], ['exit_reason', 'exitReason', /^[a-z][a-z0-9-]{0,31}$/]] as const) {
    if (a[k] === undefined) continue;
    if (typeof a[k] !== 'string' || !re.test(a[k] as string)) return { ok: false, error: `${k} is not a valid id` };
    (f as Record<string, unknown>)[key] = a[k];
  }
  if (a.mint !== undefined) { if (typeof a.mint !== 'string' || !MINT.test(a.mint)) return { ok: false, error: 'mint is not a Solana address' }; f.mint = a.mint; }
  if (a.run_id !== undefined) { if (typeof a.run_id !== 'string' || !RUN_ID.test(a.run_id)) return { ok: false, error: 'run_id is not a run id' }; f.runId = a.run_id; }
  if (a.account !== undefined) { if (typeof a.account !== 'string' || !/^[a-z][a-z0-9-]{1,31}$/.test(a.account)) return { ok: false, error: 'account is not a paper account id' }; f.account = a.account; }
  if (a.days !== undefined) {
    const d = Number(a.days);
    if (!Number.isFinite(d) || d <= 0 || d > 3650) return { ok: false, error: 'days is a number from 0 to 3650' };
    f.since = now - d * DAY_MS;
  }
  return { ok: true, filter: f };
}

export class LedgerTools {
  private readonly env: NodeJS.ProcessEnv;
  private readonly actor: string;
  private readonly now: () => number;
  private readonly requestTimes: number[] = [];
  private readonly o: LedgerToolsOpts;

  constructor(o: LedgerToolsOpts = {}) {
    this.o = o;
    this.env = o.env ?? process.env;
    this.actor = o.actor && /^[a-z][a-z0-9:._-]{0,63}$/.test(o.actor) ? o.actor : 'mcp-agent';
    this.now = o.now ?? Date.now;
  }

  private home(): string { return dextermHome(this.env); }

  private async view(): Promise<LedgerView> {
    if (this.o.view) return this.o.view();
    const at = await import('@dexterm/autotrade');
    return at.loadLedgerView({ env: this.env, now: this.now() });
  }

  async call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
      switch (name) {
        case 'ledger_trades': case 'ledger_positions': case 'ledger_equity': case 'ledger_summary': case 'ledger_compare': return await this.ledger(name, args);
        case 'candidate_dossier': return await this.dossier(args);
        case 'outcomes_lookup': return await this.outcomes(args);
        case 'telegram_status': return this.telegram();
        case 'trading_status': return this.trading();
        case 'trade_fire_feed': return this.signals(args);
        case 'trading_limits': return await this.limits(args);
        case 'limits_propose': return await this.limitsPropose(args);
        case 'backtest_requests': return this.requests();
        case 'backtest_request': return await this.request(args);
        default: return { error: `unknown ledger tool ${name}` };
      }
    } catch (e) {
      return { error: firewall(e instanceof Error ? e.message : String(e), 'ledger', 'error') ?? 'error' };
    }
  }

  // ───────────────────────────── the ledger reads ─────────────────────────────

  private async ledger(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const fr = filterFromArgs(args, this.now());
    if (!fr.ok) return { error: fr.error };
    const v = await this.view();
    const filter = name === 'ledger_positions' ? { ...fr.filter, status: 'open' as const } : fr.filter;
    const rows = filterTrades(v.trades, filter);
    const integrity = { ledger: v.file.check.ok ? `verified, ${v.file.events.length} events` : `FAILS its check at line ${v.file.check.at}: ${v.file.check.error}`, pendingFromSources: v.pending.length, problems: v.sources.filter((s) => s.problem).map((s) => s.problem) };
    const modes = [...new Set(rows.map((t) => t.walletMode))];
    const base = { readOnly: true, modes, integrity, note: modes.length > 1 ? 'PAPER, REAL, DEVNET and LIVE trades are in this set: filter by mode before comparing results.' : modes.includes('paper') ? 'PAPER (simulated) trades: never present them as results.' : modes.includes('real') ? 'REAL-mode trades: dexterm\'s model of the trades it signalled to the user\'s executor; the executor\'s receipts are the real fills.' : undefined };
    if (name === 'ledger_trades' || name === 'ledger_positions') {
      const limit = Math.min(200, Math.max(1, Number.isInteger(args.limit) ? Number(args.limit) : 50));
      const newest = [...rows].sort((a, b) => b.openedAt - a.openedAt).slice(0, limit);
      return { ...base, count: rows.length, shown: newest.length, trades: newest.map((t) => tradeView(t, { fills: args.fills === true })) };
    }
    if (name === 'ledger_equity') {
      const c = equityCurve(rows);
      const max = 200;
      const step = Math.max(1, Math.ceil(c.points.length / max));
      const pts = c.points.filter((_, i) => i % step === 0 || i === c.points.length - 1).map((p) => ({ at: iso(p.t), tradeId: p.tradeId, pnl: p.pnl, cum: p.cum, drawdown: p.drawdown }));
      return { ...base, unit: c.unit, startingBook: c.start, final: c.final, maxDrawdown: c.maxDrawdown, maxDrawdownPct: c.maxDrawdownPct, points: pts, sampled: step > 1 ? `every ${step}th of ${c.points.length} closes` : undefined };
    }
    if (name === 'ledger_summary') return { ...base, summary: summarize(rows) };
    return { ...base, ...compareStrategies(rows), note: 'One row per strategy version; a small trade count means little (see winRate.lo / hi).' };
  }

  // ───────────────────────────── a run's record of one candidate ─────────────────────────────

  private async dossier(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (typeof args.mint !== 'string' || !MINT.test(args.mint)) return { error: 'mint is required (a Solana address)' };
    if (args.run_id !== undefined && (typeof args.run_id !== 'string' || !RUN_ID.test(args.run_id))) return { error: 'run_id is not a run id' };
    const dir = join(this.home(), 'autotrade', 'runs');
    if (!existsSync(dir)) return { found: false, note: 'no autotrade runs on this machine' };
    const runs = readdirSync(dir).filter((f) => /\.jsonl$/.test(f)).map((f) => f.slice(0, -6)).filter((r) => RUN_ID.test(r)).sort().reverse();
    const pick = args.run_id ? runs.filter((r) => r === args.run_id) : runs.slice(0, 30);
    for (const runId of pick) {
      const p = join(dir, `${runId}.jsonl`);
      if (statSync(p).size > 64 * 1024 * 1024) continue;
      const evs: Record<string, unknown>[] = [];
      for (const l of readFileSync(p, 'utf8').split('\n')) { if (!l.trim()) continue; try { evs.push(JSON.parse(l) as Record<string, unknown>); } catch { break; } }
      const cands = evs.filter((e) => e.kind === 'candidate' && e.mint === args.mint);
      if (!cands.length) continue;
      const start = evs.find((e) => e.kind === 'run_start') ?? {};
      const sids = new Set(evs.filter((e) => e.kind === 'session_start' && e.mint === args.mint).map((e) => String(e.sessionId)));
      const pos = new Set(evs.filter((e) => e.kind === 'fill' && e.mint === args.mint).map((e) => String(e.positionId)));
      const decisions = evs.filter((e) => e.kind === 'reply' && sids.has(String(e.sessionId))).map((e) => {
        const d = e.decision as { ok?: boolean; decision?: Record<string, unknown>; error?: string } | undefined;
        return { at: iso(e.t as number), sessionId: e.sessionId, costUsd: e.costUsd, ...(d?.ok ? { action: d.decision?.action, profile: d.decision?.profile ?? null, sizePct: d.decision?.sizePct ?? null, reason: fw(d.decision?.reason as string, 'reason') } : { invalid: fw(d?.error ?? 'invalid', 'error') }) };
      });
      const tick = (cands[cands.length - 1].tick ?? {}) as Record<string, unknown>;
      return {
        found: true, readOnly: true, runId, strategy: { id: start.strategy ?? null, version: start.version ?? null, hash: start.strategyHash ?? null }, mode: start.mode ?? 'paper',
        mint: args.mint, symbol: fw(cands[cands.length - 1].symbol as string, 'symbol'),
        candidate: cands.map((c) => ({ at: iso(c.t as number), matched: c.matched })),
        tick: Object.fromEntries(Object.entries(tick).filter(([, v]) => typeof v === 'number' || typeof v === 'boolean' || v === null)),
        sessions: [...sids], decisions,
        clamp: evs.filter((e) => e.kind === 'clamp' && e.mint === args.mint).map((e) => ({ at: iso(e.t as number), result: e.result })),
        fills: evs.filter((e) => e.kind === 'fill' && e.mint === args.mint).map((e) => ({ at: iso(e.t as number), side: e.side, usd: e.usd, price: e.avgPrice ?? e.price, reason: e.reason, profile: e.profile ?? null, detail: fw(e.detail as string, 'detail') })),
        closed: evs.filter((e) => e.kind === 'trade_closed' && pos.has(String((e.trade as Record<string, unknown> | undefined)?.id))).map((e) => { const tr = e.trade as Record<string, unknown>; return { at: iso(e.t as number), exitReason: tr.exitReason, pnlUsd: tr.pnlUsd, pnlPct: tr.pnlPct, stuck: tr.stuck === true }; }),
        note: 'What the run recorded (the session\'s own dossier text is kept only in a --verbose run). For the coin as it is now, call get_dossier.',
      };
    }
    return { found: false, note: args.run_id ? `run ${String(args.run_id)} has no candidate ${args.mint}` : `no candidate ${args.mint} in the last ${pick.length} runs` };
  }

  // ───────────────────────────── the recorder's outcome labels ─────────────────────────────

  private async outcomes(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const db = this.o.historyDb?.() ?? null;
    if (!db) return { error: 'no recorder history on this machine (outcomes come from the recorder DB; run the app with the recorder on)' };
    const limit = Math.min(100, Math.max(1, Number.isInteger(args.limit) ? Number(args.limit) : 20));
    const q = db.prepare('SELECT mint, t0, horizon_sec, t1, label, label_tier, mcap_ratio, liq_ratio, price_ratio, max_mcap_ratio FROM outcomes WHERE mint = ? ORDER BY t0 DESC, horizon_sec ASC LIMIT ?');
    const row = (r: Record<string, unknown>) => ({ t0: iso(Number(r.t0)), horizonSec: Number(r.horizon_sec), observedAt: r.t1 === null ? null : iso(Number(r.t1)), label: r.label, tier: r.label_tier, mcapRatio: r.mcap_ratio, liqRatio: r.liq_ratio, priceRatio: r.price_ratio, maxMcapRatio: r.max_mcap_ratio });
    const legend = 'Labels are code-only, from recorded numbers: rug, dead, fade, flat, runner, unobserved (keyless-proxy unless chain-verified). Not a prediction.';
    if (args.mint !== undefined) {
      if (typeof args.mint !== 'string' || !MINT.test(args.mint)) return { error: 'mint is not a Solana address' };
      return { readOnly: true, mint: args.mint, outcomes: (q.all(args.mint, limit) as Record<string, unknown>[]).map(row), legend };
    }
    if (typeof args.run_id !== 'string' || !RUN_ID.test(args.run_id)) return { error: 'pass mint or run_id' };
    const p = join(this.home(), 'autotrade', 'runs', `${args.run_id}.jsonl`);
    if (!existsSync(p)) return { error: `no run ${args.run_id}` };
    const seen = new Map<string, { symbol: unknown; at: number; entered: boolean }>();
    for (const l of readFileSync(p, 'utf8').split('\n')) {
      if (!l.trim()) continue;
      let e: Record<string, unknown>;
      try { e = JSON.parse(l) as Record<string, unknown>; } catch { break; }
      const mint = typeof e.mint === 'string' ? e.mint : null;
      if (!mint || !MINT.test(mint)) continue;
      if (e.kind === 'candidate' && !seen.has(mint)) seen.set(mint, { symbol: e.symbol, at: Number(e.t), entered: false });
      if (e.kind === 'fill' && e.side === 'buy' && seen.has(mint)) seen.get(mint)!.entered = true;
    }
    const coins = [...seen.entries()].slice(0, limit).map(([mint, c]) => ({ mint, symbol: fw(String(c.symbol ?? ''), 'symbol'), candidateAt: iso(c.at), entered: c.entered, outcomes: (q.all(mint, 6) as Record<string, unknown>[]).map(row) }));
    return { readOnly: true, runId: args.run_id, candidates: seen.size, shown: coins.length, coins, legend };
  }

  // ───────────────────────────── telegram (settings only) ─────────────────────────────

  private telegram(): Record<string, unknown> {
    const p = join(this.home(), 'connectors.json');
    if (!existsSync(p)) return { readOnly: true, configured: false, note: 'Telegram is not set up (`dexterm telegram setup` on this machine).' };
    let raw: Record<string, unknown>;
    try { raw = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>; } catch { return { readOnly: true, configured: false, error: 'connectors.json is not readable JSON (the bot stays off)' }; }
    const t = (raw.telegram && typeof raw.telegram === 'object' ? raw.telegram : {}) as Record<string, unknown>;
    const allow = Array.isArray(t.allow) ? t.allow : [];
    const n = (t.notify && typeof t.notify === 'object' ? t.notify : {}) as Record<string, unknown>;
    const tiers = Array.isArray(t.tiers) ? (t.tiers as unknown[]).filter((x) => x === 'notify' || x === 'control' || x === 'approve') : [];
    return {
      readOnly: true, configured: true, enabled: t.enabled === true, botConfigured: !!t.bot,
      tokenStore: t.secretStore === 'keychain' || t.secretStore === 'libsecret' || t.secretStore === 'file' ? t.secretStore : null,
      pairedChats: allow.length, tiers, approvals: t.approvals === 'on' ? 'on' : 'off',
      approvalExpirySec: typeof t.approvalExpirySec === 'number' ? t.approvalExpirySec : null,
      notify: Object.fromEntries(['candidates', 'entries', 'closes', 'halts', 'spend', 'daily'].map((k) => [k, typeof n[k] === 'boolean' || typeof n[k] === 'string' ? n[k] : null])),
      quietHours: typeof t.quietHours === 'string' ? t.quietHours : null, dailySummaryAt: typeof t.dailySummaryAt === 'string' ? t.dailySummaryAt : null,
      note: 'Settings only (no token, no chat or sender ids). The bot runs inside `dexterm autotrade run` when a chat is paired; only local commands change these settings.',
    };
  }

  // ───────────────────────────── live trading (task-1571: not in dexterm) ───────────────

  private trading(): Record<string, unknown> {
    const panic = existsSync(join(this.home(), 'trading.panic'));
    const real = this.realState();
    return {
      readOnly: true,
      liveTrading: 'not in dexterm: dexterm holds no key, signs nothing and places no live order. Live trading happens in the Telegram trading bot (or script) the user chose, which holds its own wallet; dexterm only sends alerts, run control and, in real mode, LIVE TRADE FIRE signals to the user\'s own executor (telegram_status, trade_fire_feed).',
      paperTrading: 'local: the paper ticket, paper accounts and paper autotrade runs (ledger_* tools)',
      realMode: `${real.armed.length} strategy(ies) armed for real mode by the user on their own terminal${real.kill ? `; the real-mode kill switch is ON (${real.kill})` : ''}. Only the user arms, disarms, sets caps or lifts the kill switch, on their own terminal; no tool can.`,
      panicSwitch: panic ? 'engaged (autotrade runs and the paper agent desk are halted; only `dexterm wallet resume` in a terminal clears it)' : 'off',
    };
  }

  // ───────────────────────────── real mode (task-1645) ─────────────────────────────

  private readJson(path: string): Record<string, unknown> | null {
    try { return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>; } catch { return null; }
  }

  /** Real mode's state from its files (pure reads; ids and numbers only). */
  private realState(): { armed: { id: string; version: string; accountId: string }[]; kill: string | null; caps: Record<string, number> | null; lastNonce: number | null } {
    const dir = join(this.home(), 'autotrade', 'real');
    const arming = this.readJson(join(dir, 'arming.json'));
    const armed = Object.values((arming?.armed ?? {}) as Record<string, { strategyId?: unknown; version?: unknown; accountId?: unknown }>)
      .filter((a) => typeof a.strategyId === 'string' && /^[a-z][a-z0-9-]{1,31}$/.test(a.strategyId))
      .map((a) => ({ id: String(a.strategyId), version: String(a.version ?? '').slice(0, 16), accountId: String(a.accountId ?? '').replace(/[^a-z0-9_-]/g, '').slice(0, 32) }));
    const killFile = join(dir, 'kill.json');
    const k = existsSync(killFile) ? this.readJson(killFile) : null;
    // task-1654: the caps are four of the limits (limits.json global, else card A's caps.json).
    const lim = this.readJson(join(dir, 'limits.json'))?.global as Record<string, unknown> | undefined;
    const caps = (lim ? Object.fromEntries(['perTradeSol', 'dailySol', 'buysPerDay', 'maxOpenPositions'].filter((k) => typeof lim[k] === 'number').map((k) => [k, lim[k]])) : undefined) ?? this.readJson(join(dir, 'caps.json'))?.caps as Record<string, unknown> | undefined;
    const capsNum = caps ? Object.fromEntries(Object.entries(caps).filter(([, v]) => typeof v === 'number')) as Record<string, number> : null;
    const n = Number(this.readJson(join(dir, 'nonce.json'))?.last);
    return { armed, kill: existsSync(killFile) ? cleanLedgerText(k?.reason ?? 'engaged', 80) || 'engaged' : null, caps: capsNum, lastNonce: Number.isSafeInteger(n) ? n : null };
  }

  private signals(args: Record<string, unknown>): Record<string, unknown> {
    const after = Number(args.after_nonce ?? 0);
    const limit = Number(args.limit ?? 50);
    if (!Number.isSafeInteger(after) || after < 0) return { error: 'after_nonce is a whole number >= 0' };
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return { error: 'limit is a whole number from 1 to 100' };
    const feed = join(this.home(), 'autotrade', 'real', 'mcp-feed.jsonl');
    const out: Record<string, unknown>[] = [];
    let feedOn = false;
    if (existsSync(feed)) {
      feedOn = true;
      for (const l of readFileSync(feed, 'utf8').split('\n')) {
        if (!l.trim()) continue;
        let x: Record<string, unknown>;
        try { x = JSON.parse(l) as Record<string, unknown>; } catch { continue; }
        if (x.schema !== 'dexterm-trade-fire/1' || typeof x.nonce !== 'number' || x.nonce <= after) continue;
        // The signal as dexterm wrote it; the only token text in it is the symbol, already reduced to [A-Za-z0-9._$-].
        out.push({ ...x, symbol: typeof x.symbol === 'string' ? x.symbol.replace(/[^A-Za-z0-9._$-]/g, '').slice(0, 16) : undefined });
        if (out.length >= limit) break;
      }
    }
    const st = this.realState();
    return {
      readOnly: true, schema: 'dexterm-trade-fire/1', signals: out, nextAfterNonce: out.length ? out[out.length - 1].nonce : after,
      realMode: { armed: st.armed, kill: st.kill, caps: st.caps, lastNonce: st.lastNonce, mcpFeed: feedOn ? 'on' : 'off (the user enables it: dexterm autotrade signal channels --mcp on)' },
      rules: 'An executor acts only on its own accountId, ignores a signal after expiresAt, and dedupes by nonce (delivery is at-least-once). type "halted" ends a run; type "test" is never traded. The user records what was done with `dexterm autotrade receipt`; this tool changes nothing.',
    };
  }

  // ───────────────────────────── limits (task-1654) ─────────────────────────────

  private limitsContext(args: Record<string, unknown>): { strategyId: string; accountId: string; mode: 'real' | 'paper' } | { error: string } {
    const id = (v: unknown, name: string): string | { error: string } => (v === undefined ? '-' : typeof v === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(v) ? v : { error: `${name} is an id ([a-z0-9._-], 64 max)` });
    const strategyId = id(args.strategy, 'strategy'); if (typeof strategyId !== 'string') return strategyId;
    const accountId = id(args.account, 'account'); if (typeof accountId !== 'string') return accountId;
    if (args.mode !== undefined && args.mode !== 'real' && args.mode !== 'paper') return { error: 'mode is real or paper' };
    return { strategyId, accountId, mode: args.mode === 'paper' ? 'paper' : 'real' };
  }

  private async limits(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const c = this.limitsContext(args);
    if ('error' in c) return c;
    const at = await import('@dexterm/autotrade');
    const home = this.home();
    const l = at.loadLimits(home);
    const doc = l.ok ? l.doc : null;
    const e = at.effectiveLimits(doc, c);
    const risk = at.loadRiskState(home, this.now());
    const ex = at.executorHealth(home, { now: this.now(), windowMin: e.values.executorSilenceMin ?? null });
    return {
      readOnly: true, context: c, applies: e.applies,
      state: l.ok ? (l.source === 'migrated' ? 'migrated from caps.json' : l.unjournaled ? 'changed outside dexterm (a real run refuses it if it raises anything)' : 'saved by the user') : l.missing ? 'not set yet: placeholder defaults (real mode does not arm on them silently)' : 'unreadable: real buys are refused',
      limits: at.LIMIT_FIELDS.map((f) => ({ key: f.key, group: f.group, unit: f.unit, kind: f.dir === 'max' ? 'cap (smaller is stricter)' : 'floor (larger is stricter)', value: e.values[f.key as keyof typeof e.values] ?? null, from: e.from[f.key as keyof typeof e.from] ?? null, placeholder: at.DEFAULT_LIMITS[f.key as keyof typeof at.DEFAULT_LIMITS] ?? null, what: f.help })),
      today: { day: risk.day, buys: risk.buys, buySol: risk.buySol, realizedSol: risk.dayPnlSol, lossStreak: risk.lossStreak, pausedUntil: iso(risk.pausedUntil), breaker: risk.breaker ? { at: iso(risk.breaker.at), drawdownSol: risk.breaker.drawdownSol } : null },
      executor: at.healthLine(ex),
      rules: 'Limits live outside the model. The effective number is the placeholder default replaced by the user\'s global value, then the STRICTER of every scope that sets it (mode, strategy, account). No tool changes them: limits_propose returns a diff card for the user to apply on their own terminal (raising needs their typed confirmation). The defaults are placeholders, not advice.',
    };
  }

  private async limitsPropose(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const at = await import('@dexterm/autotrade');
    const scope = typeof args.scope === 'string' ? args.scope : 'global';
    const changes = args.changes;
    if (!changes || typeof changes !== 'object' || Array.isArray(changes) || !Object.keys(changes).length || Object.keys(changes).length > 24) return { error: 'changes is an object of 1 to 24 limits: { "perTradeSol": 0.1, "dailyLossSol": null }' };
    // The agent's own reason is returned apart from the card, firewalled: the card is engine-made lines only.
    const why = typeof args.why === 'string' ? fw(args.why.slice(0, 200), 'limits-why') : null;
    const home = this.home();
    const l = at.loadLimits(home);
    const cur = l.ok ? l.doc : at.emptyLimits();
    const next = structuredClone(cur);
    delete next.migratedFrom;
    const ref = at.scopeRef(next, scope, true);
    if ('error' in ref) return { error: ref.error };
    for (const [k, v] of Object.entries(changes as Record<string, unknown>)) {
      if (!at.limitField(k)) return { error: `unknown limit "${String(k).slice(0, 40)}"` };
      if (v !== null && (typeof v !== 'number' || !Number.isFinite(v))) return { error: `${k}: a number, or null to remove it` };
      if (v === null && !ref.isGlobal) delete ref.set![k as keyof typeof ref.set]; else (ref.set as Record<string, number | null>)[k] = v as number | null;
    }
    const issues = at.validateLimits(next);
    if (issues.length) return { error: issues.map((i) => `${i.path}: ${i.msg}`).join('; ').slice(0, 400) };
    const diff = at.diffLimits(l.ok ? cur : null, next);
    const up = at.raises(diff);
    const assign = Object.entries(changes as Record<string, unknown>).map(([k, v]) => `${k}=${v === null ? 'off' : v}`).join(' ');
    return {
      applied: false, proposal: true,
      card: [`PROPOSED LIMITS CHANGE · ${scope}`, ...diff.map((d) => `  ${at.changeLine(d)}`), up.length ? `  raises ${up.length} limit(s): you would type the confirmation on your own terminal` : '  lowers only: applies at once when you run it', `  to apply it yourself: dexterm autotrade limits set --scope ${scope} ${assign}`],
      changes: diff, raises: up.length, why,
      command: `dexterm autotrade limits set --scope ${scope} ${assign}`,
      note: 'Nothing was changed: no tool can change a limit. Only the user applies this, on their own terminal.',
    };
  }

  // ───────────────────────────── backtest requests ─────────────────────────────

  private requests(): Record<string, unknown> {
    const rs = new BacktestRequests(this.home()).list().slice(0, 20);
    return { readOnly: true, requests: rs.map((r) => ({ requestId: r.requestId, id: r.id, days: r.days, everyCandidate: r.everyCandidate, status: r.status, why: fw(r.why, 'why'), createdAt: iso(r.createdAt), resolvedAt: iso(r.resolvedAt ?? null), result: r.result ?? null })), note: 'The user runs a request with `dexterm autotrade requests run <requestId>`; results are backtests on recorded history, not predictions.' };
  }

  private async request(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = args.id;
    if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{1,31}$/.test(id)) return { error: 'id must be a strategy id from strategy_list' };
    const days = Number(args.days ?? 30);
    if (!Number.isInteger(days) || days < 1 || days > REQUEST_MAX_DAYS) return { error: `days must be a whole number from 1 to ${REQUEST_MAX_DAYS}` };
    // stored as plain one-line text (the user reads it in `dexterm autotrade requests`); fenced when an agent reads it back
    const why = cleanLedgerText(args.why, 200);
    if (!why) return { error: 'why is required (one line: what the backtest should answer)' };
    const t = this.now();
    while (this.requestTimes.length && t - this.requestTimes[0] > 3_600_000) this.requestTimes.shift();
    if (this.requestTimes.length >= REQUEST_RATE_PER_HOUR) return { error: `at most ${REQUEST_RATE_PER_HOUR} backtest requests per hour`, reason: 'rate-limited' };
    const files = new BacktestRequests(this.home());
    if (files.list({ status: 'pending' }).length >= MAX_PENDING_REQUESTS) return { error: `${MAX_PENDING_REQUESTS} requests are already waiting for the user; wait for them to be run or dismissed`, reason: 'quota' };
    const info = await (this.o.strategyInfo ?? defaultStrategyInfo(this.env, this.now))(id);
    if (!info) return { error: `no strategy ${id}` };
    if (!info.ok) return { error: `${id} does not validate: ${info.why ?? 'invalid'}` };
    this.requestTimes.push(t);
    const r = files.create({ id, version: info.version, strategyHash: info.hash, days, everyCandidate: args.every_candidate === true, why, actor: this.actor, createdAt: t });
    return { proposal: true, requestId: r.requestId, id, days, everyCandidate: r.everyCandidate, status: 'pending', note: `Nothing ran. The user runs it with \`dexterm autotrade requests run ${r.requestId}\` (or dismisses it); read the result with backtest_requests.` };
  }
}

function defaultStrategyInfo(env: NodeJS.ProcessEnv, now: () => number): (id: string) => Promise<{ ok: boolean; version: string | null; hash: string | null; why?: string } | null> {
  return async (id) => {
    const at = await import('@dexterm/autotrade');
    const got = new at.StrategyStore({ home: dextermHome(env), now }).get(id);
    if (!got) return null;
    if (!got.ok) return { ok: false, version: null, hash: null, why: got.errors.map(at.fmtIssue).join('; ').slice(0, 200) };
    return { ok: true, version: String(got.strategy.version ?? ''), hash: at.strategyHash(got.strategy) };
  };
}

