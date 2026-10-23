// @dexterm/tui — task-1483 BUY / SELL markers: the pure model every chart draws from (terminal candles, the agent
// views' traces, and — mirrored in packages/popup/src/pages/chart-lib.js, parity-tested — the chart popup).
//
// Input: the fills the app already holds (the paper ledger's trades and the live ledger's confirmed swaps), never a
// fetch. Output: one marker per (bar, side, source) for the bars on screen, the open position's average entry per
// source, and the closed round trips. Display only: nothing here can arm, size, sign or confirm anything.
//
// Placement rules (the card's "never clamped to a wrong place"):
//   - a fill belongs to the bar whose period contains its time (bar open = floor(t / period) · period);
//   - a fill older than the first bar on screen, newer than the last bar, or in a period with no bar (a quiet coin
//     can skip a minute) is OMITTED and counted, never moved onto a neighbouring bar;
//   - the price is the fill's own USD price (token-weighted when one bar holds several fills of a side); with no
//     known price the marker is drawn against the bar (below it for a buy, above it for a sell) and says so.
// The axis never changes a marker's position: bars and markers are both laid out in USD price; an mcap axis only
// relabels (price × the current supply, task-1366/1472).

export type FillSide = 'buy' | 'sell';
/** `paper` = the simulated ledger (the user's and an agent's PAPER trades); `live` = the signer's confirmed fills. */
export type FillSource = 'paper' | 'live';

/** One fill as the charts read it. */
export interface ChartTradeFill {
  /** Fill time, ms since the epoch (UTC). */
  t: number;
  side: FillSide;
  source: FillSource;
  /** USD per whole token at the fill; null when the ledger did not record one. */
  priceUsd: number | null;
  /** Whole tokens moved (absolute). */
  tokens: number;
  /** SOL leg, gross of fees (absolute); null when unknown. */
  sol: number | null;
}

/** A fill after the ledger replay: what it did to the position of its source. */
export interface ReplayedFill extends ChartTradeFill {
  /** Tokens held (this source) before / after the fill. */
  heldBefore: number;
  heldAfter: number;
  /** A buy into an open position (scale-in) or a sell that leaves tokens held. */
  partial: boolean;
  /** This fill brought the source's position to flat. */
  closes: boolean;
}

export interface TradeMarker {
  side: FillSide;
  source: FillSource;
  /** Open time (ms) of the bar the fills fall in. */
  bucket: number;
  /** Index of that bar in the window's `barTimes`. */
  index: number;
  /** First and last fill time in the bar. */
  t: number;
  tLast: number;
  /** Token-weighted average USD fill price of the fills with a known price; null = none known (draw against the bar). */
  priceUsd: number | null;
  tokens: number;
  /** Sum of the SOL legs; null when any is unknown. */
  sol: number | null;
  /** How many fills this marker stands for (several in one bar on a coarse timeframe). */
  count: number;
  /** At least one fill was partial (a scale-in buy, or a sell that left tokens held). */
  partial: boolean;
  /** A fill in this bar closed the position. */
  closes: boolean;
}

/** A completed round trip of one source: the first buy from flat to the sell that made it flat again. */
export interface RoundTrip {
  source: FillSource;
  openT: number;
  closeT: number;
  /** Token-weighted average buy / sell prices (null when a fill had no USD price). */
  entryUsd: number | null;
  exitUsd: number | null;
}

export interface MarkerWindow {
  /** The chart's bar period, ms (1m = 60 000 …). */
  periodMs: number;
  /** Open times (ms) of the bars on screen, ascending. */
  barTimes: readonly number[];
}

export interface MarkerSet {
  markers: TradeMarker[];
  /** Fills omitted because they are older than the first bar on screen. */
  before: number;
  /** Fills omitted because they are newer than the last bar (its candle has not arrived yet). */
  after: number;
  /** Fills omitted because their period has no bar (no trades on the market in that period). */
  gap: number;
  /** Average entry (USD) of the OPEN position per source, from the fills; null = flat or a price unknown. */
  avgEntry: Record<FillSource, number | null>;
  /** Closed round trips that overlap the window (for the optional entry → exit band). */
  trips: RoundTrip[];
}

/** Bar periods by the app's timeframe names. */
export const MARKER_PERIOD_MS: Readonly<Record<string, number>> = { '1m': 60e3, '5m': 300e3, '15m': 900e3, '1h': 3600e3, '4h': 14400e3, '1d': 86400e3 };

/** The open time of the bar a time falls in. */
export function bucketOf(t: number, periodMs: number): number { return Math.floor(t / periodMs) * periodMs; }

const fin = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const EPS = 1e-9;

/** Valid fills only (finite time, a side, a source, a positive token amount), oldest first; stable for equal times. */
export function cleanFills(fills: readonly ChartTradeFill[] | null | undefined): ChartTradeFill[] {
  const out: ChartTradeFill[] = [];
  for (const f of fills ?? []) {
    if (!f || !fin(f.t) || (f.side !== 'buy' && f.side !== 'sell') || (f.source !== 'paper' && f.source !== 'live')) continue;
    if (!fin(f.tokens) || f.tokens <= 0) continue;
    out.push({ t: f.t, side: f.side, source: f.source, priceUsd: fin(f.priceUsd) && f.priceUsd > 0 ? f.priceUsd : null, tokens: f.tokens, sol: fin(f.sol) && f.sol >= 0 ? f.sol : null });
  }
  return out.map((f, i) => [f, i] as const).sort((a, b) => a[0].t - b[0].t || a[1] - b[1]).map(([f]) => f);
}

/**
 * Replay the fills per source (oldest first) the way the ledgers book them: a buy adds tokens and cost, a sell
 * removes tokens at the average cost. A sell bigger than what the replay holds (the history was truncated) is
 * treated as closing. Returns every fill annotated, the open position's average entry, and the closed trips.
 */
export function replayFills(fills: readonly ChartTradeFill[] | null | undefined): { fills: ReplayedFill[]; avgEntry: Record<FillSource, number | null>; trips: RoundTrip[] } {
  const st: Record<FillSource, { held: number; cost: number; costOk: boolean; trip: { openT: number; bTok: number; bUsd: number; bOk: boolean; sTok: number; sUsd: number; sOk: boolean } | null }> = {
    paper: { held: 0, cost: 0, costOk: true, trip: null },
    live: { held: 0, cost: 0, costOk: true, trip: null },
  };
  const out: ReplayedFill[] = [];
  const trips: RoundTrip[] = [];
  for (const f of cleanFills(fills)) {
    const s = st[f.source];
    const before = s.held;
    if (f.side === 'buy') {
      if (s.held <= EPS) { s.held = 0; s.cost = 0; s.costOk = true; s.trip = { openT: f.t, bTok: 0, bUsd: 0, bOk: true, sTok: 0, sUsd: 0, sOk: true }; }
      s.held += f.tokens;
      if (f.priceUsd === null) s.costOk = false; else s.cost += f.tokens * f.priceUsd;
      if (s.trip) { s.trip.bTok += f.tokens; if (f.priceUsd === null) s.trip.bOk = false; else s.trip.bUsd += f.tokens * f.priceUsd; }
      out.push({ ...f, heldBefore: before, heldAfter: s.held, partial: before > EPS, closes: false });
      continue;
    }
    const sold = Math.min(f.tokens, s.held);
    const frac = s.held > EPS ? sold / s.held : 1;
    s.cost -= s.cost * frac;
    s.held = Math.max(0, s.held - f.tokens);
    const closes = s.held <= f.tokens * 1e-9 || s.held <= EPS;
    if (closes) s.held = 0;
    if (s.trip) { s.trip.sTok += f.tokens; if (f.priceUsd === null) s.trip.sOk = false; else s.trip.sUsd += f.tokens * f.priceUsd; }
    out.push({ ...f, heldBefore: before, heldAfter: s.held, partial: !closes, closes });
    if (closes) {
      if (s.trip) trips.push({ source: f.source, openT: s.trip.openT, closeT: f.t, entryUsd: s.trip.bOk && s.trip.bTok > 0 ? s.trip.bUsd / s.trip.bTok : null, exitUsd: s.trip.sOk && s.trip.sTok > 0 ? s.trip.sUsd / s.trip.sTok : null });
      s.trip = null; s.cost = 0; s.costOk = true;
    }
  }
  const avg = (src: FillSource): number | null => { const s = st[src]; return s.held > EPS && s.costOk && s.cost > 0 ? s.cost / s.held : null; };
  return { fills: out, avgEntry: { paper: avg('paper'), live: avg('live') }, trips };
}

/** Index of `t` in an ascending list, or -1 (binary search). */
function indexOf(times: readonly number[], t: number): number {
  let lo = 0, hi = times.length - 1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; const v = times[mid]; if (v === t) return mid; if (v < t) lo = mid + 1; else hi = mid - 1; }
  return -1;
}

/**
 * The markers for a window of bars: one per (bar, side, source), oldest first; buys before sells within a bar.
 * Fills outside the window (or in a period with no bar) are counted in before / after / gap, never placed.
 */
export function chartMarkers(fills: readonly ChartTradeFill[] | null | undefined, win: MarkerWindow): MarkerSet {
  const rp = replayFills(fills);
  const times = win.barTimes;
  const empty = (): MarkerSet => ({ markers: [], before: 0, after: 0, gap: 0, avgEntry: rp.avgEntry, trips: [] });
  if (!(win.periodMs > 0) || !times.length) { const e = empty(); e.before = rp.fills.length; return e; }
  const first = times[0], last = times[times.length - 1];
  const res = empty();
  const by = new Map<string, TradeMarker & { pTok: number; pUsd: number; solOk: boolean }>();
  for (const f of rp.fills) {
    const b = bucketOf(f.t, win.periodMs);
    if (b < first) { res.before++; continue; }
    if (b > last) { res.after++; continue; }
    const index = indexOf(times, b);
    if (index < 0) { res.gap++; continue; }
    const key = `${b}|${f.side}|${f.source}`;
    let m = by.get(key);
    if (!m) { m = { side: f.side, source: f.source, bucket: b, index, t: f.t, tLast: f.t, priceUsd: null, tokens: 0, sol: 0, count: 0, partial: false, closes: false, pTok: 0, pUsd: 0, solOk: true }; by.set(key, m); }
    m.count++; m.tLast = f.t; m.tokens += f.tokens;
    if (f.sol === null) m.solOk = false; else m.sol = (m.sol ?? 0) + f.sol;
    if (f.priceUsd !== null) { m.pTok += f.tokens; m.pUsd += f.tokens * f.priceUsd; }
    if (f.partial) m.partial = true;
    if (f.closes) m.closes = true;
  }
  const order = (m: TradeMarker) => (m.side === 'buy' ? 0 : 1) * 2 + (m.source === 'live' ? 1 : 0);
  res.markers = [...by.values()].map(({ pTok, pUsd, solOk, ...m }) => ({ ...m, priceUsd: pTok > 0 ? pUsd / pTok : null, sol: solOk ? m.sol : null }))
    .sort((a, b) => a.index - b.index || order(a) - order(b));
  res.trips = rp.trips.filter((r) => bucketOf(r.closeT, win.periodMs) >= first && bucketOf(r.openT, win.periodMs) <= last);
  return res;
}

/** The glyph for a marker: solid ▲ / ▼ for live fills, hollow △ / ▽ for paper. Reads without colour (NO_COLOR). */
export function markerGlyph(side: FillSide, source: FillSource): string {
  if (source === 'paper') return side === 'buy' ? '△' : '▽';
  return side === 'buy' ? '▲' : '▼';
}

/** The letter for a marker (always shown with the glyph, so BUY / SELL never depends on colour). */
export function markerLetter(side: FillSide): 'B' | 'S' { return side === 'buy' ? 'B' : 'S'; }

/** "△ ▽ paper  ▲ ▼ live" — the legend for the sources actually on screen (empty when none). */
export function markerLegend(markers: readonly Pick<TradeMarker, 'source'>[], avgShown = false): string {
  const has = (s: FillSource) => markers.some((m) => m.source === s);
  const parts: string[] = [];
  if (has('paper')) parts.push('△B ▽S paper');
  if (has('live')) parts.push('▲B ▼S live');
  if (avgShown) parts.push('┄ avg entry');
  return parts.join('  ');
}

/** "+2 fills off-chart (1 earlier, 1 newer than the last candle)" — what the window omitted, or ''. */
export function omittedNote(s: Pick<MarkerSet, 'before' | 'after' | 'gap'>): string {
  const n = s.before + s.after + s.gap;
  if (!n) return '';
  const why: string[] = [];
  if (s.before) why.push(`${s.before} earlier`);
  if (s.after) why.push(`${s.after} newer than the last candle`);
  if (s.gap) why.push(`${s.gap} in a period with no candle`);
  return `+${n} fill${n === 1 ? '' : 's'} off-chart (${why.join(', ')})`;
}

/**
 * The plot row of a price on a terminal chart laid out between `lo` and `hi` over `plotH` rows (row 0 = `hi`), the same
 * mapping candleChart uses for candle bodies. Null when the price is outside the plotted range (omitted, not clamped).
 */
export function markerRow(priceUsd: number, lo: number, hi: number, plotH: number): number | null {
  if (!fin(priceUsd) || !(hi > lo) || plotH < 1) return null;
  const r = Math.floor(((hi - priceUsd) / (hi - lo)) * plotH);
  return r >= 0 && r < plotH ? r : null;
}

/** "B 41.2k" / "S×2 0.0₄123": the compact terminal label (axis value = price × scale, formatted by the axis). */
export function markerLabel(m: Pick<TradeMarker, 'side' | 'count' | 'priceUsd'>, fmt: (n: number) => string, scale = 1): string {
  const head = `${markerLetter(m.side)}${m.count > 1 ? `×${m.count}` : ''}`;
  return m.priceUsd === null ? head : `${head} ${fmt(m.priceUsd * (scale > 0 ? scale : 1))}`;
}
