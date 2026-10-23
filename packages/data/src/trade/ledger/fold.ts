// task-1530 — fold ledger events into TRADES (one row per round trip). Pure: the same events give the same rows.
//
// A trade is every fill that shares a `tradeKey`, from the first buy until the source says it is flat (or a
// `close` event). What the row carries, and where each field comes from:
//   strategy        id + version + hash from the fills (autotrade runs, live runner orders)
//   profile         the entry fill's tag, else a late PROFILE tag, then every REPROFILE in order (the last wins)
//   entry / exit    the entry fill's reason; the closing sell's exit reason code and the agent's words
//   size            SOL (and USD) in, % of the book the source had just before the first buy
//   prices          average entry, blended exit, as SOL price, USD price and market cap (price × recorded supply)
//   costs           fees, the SOL-weighted price impact of entries and exits, the slippage limit used
//   hold            first buy to the closing fill (an open trade: to `now`)
//   MFE / MAE       best and worst move from the entry price that the source SAW: the close event's extremes
//                   plus every fill's own price ('observed' vs 'fills only' says which)
//   rug             an annotate event, else a bag that could not be sold (stuck), else a liquidity exit that
//                   lost 80 %+ ('why' names the rule)
//   model           every session id on the trade's fills / close, and the sum of their recorded costs

import type { AnnotateEvent, CloseEvent, CostEvent, FillEvent, LedgerEvent, LedgerSource, StrategyRef, SupplyRef, TagEvent, TagSource, WalletMode } from './schema.ts';

export interface TradeTagView { id: string | null; source: TagSource }
export interface ReasonView { code: string | null; text: string | null; line: string | null; source: TagSource }

export interface TradeFillView {
  ref: string; t: number; side: 'buy' | 'sell'; sol: number | null; usd: number | null; tokens: number | null;
  priceSol: number | null; priceUsd: number | null; mcapUsd: number | null; feeSol: number | null; impactPct: number | null;
  exitReason: string | null; txSig: string | null;
}

export interface TradeRow {
  tradeId: string;
  source: LedgerSource;
  walletMode: WalletMode;
  status: 'open' | 'closed';
  mint: string; symbol: string; decimals: number | null;
  runId: string | null; agent: string | null;
  strategy: StrategyRef | null;
  /** The shared paper account it was traded from (task-1538), or null. */
  account?: string | null;
  profile: TradeTagView;
  reprofiles: { t: number; from: string | null; to: string | null; reason: string | null }[];
  entryReason: ReasonView;
  exitReason: ReasonView;
  openedAt: number; closedAt: number | null; holdSec: number;
  buys: number; sells: number;
  sizeSol: number | null; sizeUsd: number | null;
  pctOfBook: number | null; bookSol: number | null; bookUsd: number | null;
  entryPriceSol: number | null; entryPriceUsd: number | null; entryMcapUsd: number | null;
  exitPriceSol: number | null; exitPriceUsd: number | null; exitMcapUsd: number | null;
  supply: SupplyRef | null;
  proceedsSol: number | null; proceedsUsd: number | null;
  pnlSol: number | null; pnlUsd: number | null; pnlPct: number | null;
  feesSol: number | null;
  impactPctEntry: number | null; impactPctExit: number | null;
  slippageBps: number | null;
  mfePct: number | null; maePct: number | null; excursionBasis: 'observed' | 'fills only' | null;
  rug: boolean; rugWhy: string | null;
  stuck: boolean;
  txSigs: string[];
  model: { sessionIds: string[]; costUsd: number | null; models: string[] };
  fills: TradeFillView[];
}

/** Exit codes that mean the pool went away under the position. */
const LIQUIDITY_EXITS = new Set(['thesis-liquidity', 'illiquid', 'rug', 'liquidity-pull', 'lp-pull', 'stuck']);
const RUG_LOSS_PCT = -80;

const sum = (xs: (number | null)[]): number | null => { let s = 0, n = 0; for (const x of xs) if (x !== null) { s += x; n++; } return n ? s : null; };
const r = (x: number | null, p = 6): number | null => (x === null || !Number.isFinite(x) ? null : Number(x.toPrecision(p)));
const rank: Record<TagSource, number> = { structured: 6, rule: 5, 'tag-line': 4, late: 3, default: 2, missing: 1 };

/** Weighted mean of `v` by `w` over the fills where both are known. */
function wmean(fs: FillEvent[], v: (f: FillEvent) => number | null, w: (f: FillEvent) => number | null): number | null {
  let s = 0, ws = 0;
  for (const f of fs) { const a = v(f), b = w(f); if (a !== null && b !== null && b > 0) { s += a * b; ws += b; } }
  return ws > 0 ? s / ws : null;
}

export interface FoldOptions { now?: number }

export function foldTrades(events: readonly LedgerEvent[], o: FoldOptions = {}): TradeRow[] {
  const now = o.now ?? Date.now();
  const fills = new Map<string, FillEvent[]>();
  const tags: TagEvent[] = [];
  const closes = new Map<string, CloseEvent>();
  const looseCloses: CloseEvent[] = [];
  const costs = new Map<string, { usd: number; model: string | null }>();
  const notes = new Map<string, AnnotateEvent>();
  for (const e of events) {
    if (e.kind === 'fill') { const a = fills.get(e.tradeKey) ?? []; a.push(e); fills.set(e.tradeKey, a); }
    else if (e.kind === 'tag') tags.push(e);
    else if (e.kind === 'close') { if (e.tradeKey) closes.set(e.tradeKey, e); else looseCloses.push(e); }
    else if (e.kind === 'cost') { const c = costs.get(e.sessionId); costs.set(e.sessionId, { usd: (c?.usd ?? 0) + e.costUsd, model: e.model ?? c?.model ?? null }); }
    else if (e.kind === 'annotate') notes.set(e.tradeKey, e as AnnotateEvent);
  }
  const rows: TradeRow[] = [];
  for (const [key, fsRaw] of fills) {
    const fs = [...fsRaw].sort((a, b) => a.t - b.t || a.seq - b.seq);
    const buys = fs.filter((f) => f.side === 'buy');
    const sells = fs.filter((f) => f.side === 'sell');
    if (!buys.length) continue; // a sell with no buy on record has no basis; it is not a trade
    const first = buys[0];
    const closing = [...fs].reverse().find((f) => f.closes === true) ?? null;
    // a loose close (the run that traded this coin on the desk): the first one after the entry, near the last fill
    const lastT = fs[fs.length - 1].t;
    const close = closes.get(key) ?? looseCloses.find((c) => c.mint === first.mint && c.source === first.source && c.t >= first.t - 5_000 && (closing ? c.t <= closing.t + 120_000 : c.t <= lastT + 120_000) && c.t >= lastT - 120_000) ?? null;
    const status: TradeRow['status'] = close || closing ? 'closed' : 'open';
    const closedAt = status === 'closed' ? Math.max(close?.t ?? -Infinity, closing?.t ?? -Infinity, fs[fs.length - 1].t) : null;

    // ── tags ──
    const myTags = tags.filter((g) => g.tradeKey === key || (g.tradeKey === null && g.mint === first.mint && g.source === first.source && g.t >= first.t && (closedAt === null || g.t <= closedAt + 120_000)));
    let profile: TradeTagView = { id: null, source: 'missing' };
    const pick = (id: string | null | undefined, source: TagSource) => { if (id && rank[source] > rank[profile.source]) profile = { id, source }; };
    pick(first.tag?.profile, first.tag?.source ?? 'missing');
    for (const g of myTags) if (g.tagKind === 'profile') pick(g.profile, g.tagSource);
    const reprofiles = myTags.filter((g) => g.tagKind === 'reprofile').sort((a, b) => a.t - b.t).map((g) => ({ t: g.t, from: g.from ?? null, to: g.to ?? null, reason: g.reason ?? null }));
    if (reprofiles.length && reprofiles[reprofiles.length - 1].to) profile = { id: reprofiles[reprofiles.length - 1].to, source: profile.source === 'missing' ? 'late' : profile.source };

    const entryTagged = first.tag && first.tag.reason ? first.tag : (myTags.find((g) => g.tagKind === 'profile' && g.reason) ?? null);
    const entryReason: ReasonView = entryTagged
      ? { code: null, text: entryTagged.reason ?? null, line: entryTagged.line ?? null, source: 'tagSource' in entryTagged ? entryTagged.tagSource : entryTagged.reasonSource ?? entryTagged.source }
      : { code: null, text: null, line: null, source: first.tag?.source === 'default' ? 'default' : 'missing' };

    const lastSell = closing ?? sells[sells.length - 1] ?? null;
    const exitTag = lastSell?.tag ?? null;
    const lateExit = [...myTags].reverse().find((g) => g.tagKind === 'exit') ?? null;
    let exitReason: ReasonView = { code: null, text: null, line: null, source: 'missing' };
    if (exitTag && (exitTag.exitReason || exitTag.reason)) exitReason = { code: exitTag.exitReason ?? null, text: exitTag.reason ?? null, line: exitTag.line ?? null, source: exitTag.source };
    if (lateExit && rank[lateExit.tagSource] > rank[exitReason.source]) exitReason = { code: lateExit.exitReason ?? exitReason.code, text: lateExit.reason ?? exitReason.text, line: lateExit.line ?? null, source: lateExit.tagSource };
    if (!exitReason.code && close?.reason) exitReason = { ...exitReason, code: close.reason, source: exitReason.source === 'missing' ? 'rule' : exitReason.source };
    if (status === 'open') exitReason = { code: null, text: null, line: null, source: 'missing' };

    // ── money ──
    const sizeSol = sum(buys.map((f) => f.sol));
    const sizeUsd = sum(buys.map((f) => f.usd));
    const proceedsSol = sells.length ? sum(sells.map((f) => f.sol)) : null;
    const proceedsUsd = sells.length ? sum(sells.map((f) => f.usd)) : null;
    const boughtTok = sum(buys.map((f) => f.tokens));
    const soldTok = sum(sells.map((f) => f.tokens));
    const entryPriceSol = sizeSol !== null && boughtTok ? sizeSol / boughtTok : wmean(buys, (f) => f.priceSol, (f) => f.tokens);
    const entryPriceUsd = sizeUsd !== null && boughtTok ? sizeUsd / boughtTok : wmean(buys, (f) => f.priceUsd, (f) => f.tokens);
    const exitPriceSol = proceedsSol !== null && soldTok ? proceedsSol / soldTok : wmean(sells, (f) => f.priceSol, (f) => f.tokens);
    const exitPriceUsd = proceedsUsd !== null && soldTok ? proceedsUsd / soldTok : wmean(sells, (f) => f.priceUsd, (f) => f.tokens);
    const supply = [...fs].reverse().find((f) => f.supply && f.supply.tokens > 0)?.supply ?? null;
    const mcap = (p: number | null) => (p !== null && supply ? p * supply.tokens : null);
    const closedOut = status === 'closed';
    const pnlSol = closedOut && sizeSol !== null ? (proceedsSol ?? 0) - sizeSol : null;
    const pnlUsd = closedOut && sizeUsd !== null ? (proceedsUsd ?? 0) - sizeUsd : null;
    const pnlPct = pnlSol !== null && sizeSol ? (pnlSol / sizeSol) * 100 : pnlUsd !== null && sizeUsd ? (pnlUsd / sizeUsd) * 100 : null;
    const bookSol = first.bookSol;
    const bookUsd = first.bookUsd;
    const pctOfBook = sizeSol !== null && bookSol ? (first.sol ?? sizeSol) / bookSol * 100 : first.usd !== null && bookUsd ? first.usd / bookUsd * 100 : null;

    // ── excursions: the source's extremes + every fill's own price, in the unit the entry is known in ──
    const unit: 'sol' | 'usd' | null = close?.priceUnit ?? (entryPriceSol !== null ? 'sol' : entryPriceUsd !== null ? 'usd' : null);
    const entryRef = close?.entryPrice ?? (unit === 'sol' ? entryPriceSol : unit === 'usd' ? entryPriceUsd : null);
    const obs: number[] = [];
    for (const f of fs) { const p = unit === 'sol' ? f.priceSol : f.priceUsd; if (p !== null && p > 0) obs.push(p); }
    if (close?.peakPrice) obs.push(close.peakPrice);
    if (close?.troughPrice) obs.push(close.troughPrice);
    const mfePct = entryRef && obs.length ? (Math.max(...obs) / entryRef - 1) * 100 : null;
    const maePct = entryRef && obs.length ? (Math.min(...obs) / entryRef - 1) * 100 : null;
    const excursionBasis = mfePct === null ? null : close && (close.peakPrice || close.troughPrice) ? 'observed' : 'fills only';

    // ── rug ──
    const stuck = close?.stuck ?? false;
    const note = notes.get(key) ?? null;
    let rug = false, rugWhy: string | null = null;
    if (note && note.rug !== null) { rug = note.rug; rugWhy = note.why; }
    else if (stuck) { rug = true; rugWhy = 'stuck: the bag could not be sold (no exit liquidity)'; }
    else if (closedOut && exitReason.code && LIQUIDITY_EXITS.has(exitReason.code) && pnlPct !== null && pnlPct <= RUG_LOSS_PCT) { rug = true; rugWhy = `${exitReason.code} exit at ${pnlPct.toFixed(0)}%`; }

    // ── model ──
    const sessionIds = [...new Set([...fs.map((f) => f.sessionId), close?.sessionId ?? null].filter((x): x is string => !!x))];
    const known = sessionIds.filter((id) => costs.has(id));
    const costUsd = known.length ? known.reduce((s, id) => s + costs.get(id)!.usd, 0) : null;
    const models = [...new Set([...fs.map((f) => f.model), ...known.map((id) => costs.get(id)!.model)].filter((x): x is string => !!x))];

    const weightSol = (f: FillEvent) => f.sol ?? f.usd;
    rows.push({
      tradeId: key, source: first.source, walletMode: first.walletMode, status, mint: first.mint, symbol: first.symbol, decimals: fs.find((f) => f.decimals !== null)?.decimals ?? null,
      runId: first.runId, agent: first.agent, strategy: [...fs].reverse().find((f) => f.strategy)?.strategy ?? null,
      account: fs.find((f) => f.account)?.account ?? null,
      profile, reprofiles, entryReason, exitReason,
      openedAt: first.t, closedAt, holdSec: Math.max(0, Math.round(((closedAt ?? now) - first.t) / 1000)),
      buys: buys.length, sells: sells.length,
      sizeSol: r(sizeSol), sizeUsd: r(sizeUsd), pctOfBook: r(pctOfBook, 4), bookSol: r(bookSol), bookUsd: r(bookUsd),
      entryPriceSol: r(entryPriceSol), entryPriceUsd: r(entryPriceUsd), entryMcapUsd: r(mcap(entryPriceUsd)),
      exitPriceSol: r(exitPriceSol), exitPriceUsd: r(exitPriceUsd), exitMcapUsd: r(mcap(exitPriceUsd)),
      supply, proceedsSol: r(proceedsSol), proceedsUsd: r(proceedsUsd),
      pnlSol: r(pnlSol), pnlUsd: r(pnlUsd), pnlPct: r(pnlPct, 4),
      feesSol: r(sum(fs.map((f) => f.feeSol))),
      impactPctEntry: r(wmean(buys, (f) => f.impactPct, weightSol), 4), impactPctExit: r(wmean(sells, (f) => f.impactPct, weightSol), 4),
      slippageBps: fs.reduce<number | null>((m, f) => (f.slippageBps === null ? m : Math.max(m ?? 0, f.slippageBps)), null),
      mfePct: r(mfePct, 4), maePct: r(maePct, 4), excursionBasis,
      rug, rugWhy, stuck,
      txSigs: fs.map((f) => f.txSig).filter((x): x is string => !!x),
      model: { sessionIds, costUsd: r(costUsd), models },
      fills: fs.map((f) => ({ ref: f.ref, t: f.t, side: f.side, sol: f.sol, usd: f.usd, tokens: f.tokens, priceSol: f.priceSol, priceUsd: f.priceUsd, mcapUsd: r(mcap(f.priceUsd)), feeSol: f.feeSol, impactPct: f.impactPct, exitReason: f.tag?.exitReason ?? null, txSig: f.txSig })),
    });
  }
  return rows.sort((a, b) => a.openedAt - b.openedAt || a.tradeId.localeCompare(b.tradeId));
}
