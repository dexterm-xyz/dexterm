// dexterm popup — chart v2 pure helpers (task-1325). No DOM, no network, no globals besides the export.
// Inlined into the chart page (before chart.js) under the page's CSP nonce; test/chart-lib.test.ts loads the
// same file through node:vm to unit-test the math. Everything here works on OUR data only: the ChartVM's
// candles (from the terminal's cached/derived series), its trade tape and the ledgers' fills (task-1483 markers).
(function (root) {
  'use strict';
  const INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'];
  const PERIOD_MS = { '1m': 60e3, '5m': 300e3, '15m': 900e3, '1h': 3600e3, '4h': 14400e3, '1d': 86400e3 };
  const INDICATORS = ['ema9', 'ema21', 'vwap', 'volma', 'volume', 'tape'];
  const STYLES = ['candles', 'line', 'area'];
  const SCALES = ['auto', 'log', 'percent'];
  const DAY_MS = 86400e3;
  const fin = (n) => typeof n === 'number' && Number.isFinite(n);
  const sec = (ms) => Math.floor(ms / 1000);
  // LWC lays out tick marks on UTC boundaries. To show the viewer's local wall time with correct day/month
  // ticks, every bar time is shifted by ONE fixed offset (the page's current UTC offset, set once at load).
  // A single offset (not per-timestamp) means a DST change can never make two bars collide.
  let OFFSET_S = 0;
  function setTzOffset(s) { OFFSET_S = fin(s) ? Math.trunc(s) : 0; }
  const chartTime = (ms) => sec(ms) + OFFSET_S;

  /** ChartVM candles (ms, OHLCV) → sorted, de-duplicated LWC bars. `t` keeps the real UTC ms; `time` is the
   *  chart time (UTC seconds + the fixed local offset). Non-finite bars are dropped. */
  function toBars(candles) {
    const byT = new Map();
    for (const c of candles || []) {
      if (!c || !fin(c.t) || !fin(c.o) || !fin(c.h) || !fin(c.l) || !fin(c.c)) continue;
      byT.set(chartTime(c.t), { t: c.t, time: chartTime(c.t), open: c.o, high: Math.max(c.h, c.o, c.c), low: Math.min(c.l, c.o, c.c), close: c.c, volume: fin(c.v) && c.v > 0 ? c.v : 0 });
    }
    return [...byT.values()].sort((a, b) => a.time - b.time);
  }

  /** Merge a 'tail' (the last ≤2 bars of the same series) into bars: same time replaces, newer appends. */
  function mergeTail(bars, tail) {
    const out = bars.slice();
    for (const b of toBars(tail)) {
      const last = out[out.length - 1];
      if (!last || b.time > last.time) out.push(b);
      else {
        // replace in place (usually the last or second-last bar); older-than-window tails are ignored
        for (let i = out.length - 1; i >= Math.max(0, out.length - 4); i--) if (out[i].time === b.time) { out[i] = b; break; }
      }
    }
    return out;
  }

  /** Exponential moving average of closes, seeded with the SMA of the first `period` closes. */
  function ema(bars, period) {
    const out = [];
    if (!(period >= 1) || bars.length < period) return out;
    const k = 2 / (period + 1);
    let seed = 0;
    for (let i = 0; i < period; i++) seed += bars[i].close;
    let v = seed / period;
    out.push({ time: bars[period - 1].time, value: v });
    for (let i = period; i < bars.length; i++) { v = bars[i].close * k + v * (1 - k); out.push({ time: bars[i].time, value: v }); }
    return out;
  }

  /** Simple moving average of `values` ({time, value}). */
  function sma(points, period) {
    const out = [];
    if (!(period >= 1)) return out;
    let sum = 0;
    for (let i = 0; i < points.length; i++) {
      sum += points[i].value;
      if (i >= period) sum -= points[i - period].value;
      if (i >= period - 1) out.push({ time: points[i].time, value: sum / period });
    }
    return out;
  }

  /**
   * VWAP anchored to the UTC day (resets at 00:00 UTC, the usual 24/7 crypto session). Typical price
   * (H+L+C)/3 weighted by the bar's volume — our volume is USD (GeckoTerminal), which still yields a
   * volume-weighted average PRICE. A day with no volume so far carries the typical price.
   */
  function vwap(bars) {
    const out = [];
    let day = null, pv = 0, vol = 0;
    for (const b of bars) {
      const d = Math.floor((fin(b.t) ? b.t : b.time * 1000) / DAY_MS); // the real UTC day, not the shifted one
      if (d !== day) { day = d; pv = 0; vol = 0; }
      const tp = (b.high + b.low + b.close) / 3;
      pv += tp * b.volume; vol += b.volume;
      out.push({ time: b.time, value: vol > 0 ? pv / vol : tp });
    }
    return out;
  }

  /** Volume histogram points, coloured by candle direction. */
  function volumes(bars, upColor, downColor) {
    return bars.map((b) => ({ time: b.time, value: b.volume, color: b.close >= b.open ? upColor : downColor }));
  }

  /** The chart time of the bar a ms timestamp falls in, for a period (same shift as toBars). */
  function barTimeOf(tMs, periodMs) { return chartTime(Math.floor(tMs / periodMs) * periodMs); }

  /**
   * Buy/sell markers from the tape, aggregated per bar and side (one arrow per side per bar; size grows with
   * the USD traded in that bar). Only bars that exist in the series get a marker. Sorted by time.
   */
  function tapeMarkers(trades, periodMs, barTimes, colors) {
    const agg = new Map();
    for (const t of trades || []) {
      if (!t || !fin(t.t) || (t.side !== 'buy' && t.side !== 'sell')) continue;
      const time = barTimeOf(t.t, periodMs);
      if (!barTimes.has(time)) continue;
      const k = `${time}:${t.side}`;
      const a = agg.get(k) || { time, side: t.side, n: 0, usd: 0 };
      a.n++; a.usd += fin(t.usd) ? Math.max(0, t.usd) : 0;
      agg.set(k, a);
    }
    const out = [];
    for (const a of agg.values()) {
      const size = Math.max(0.5, Math.min(1.6, 0.5 + Math.log10(1 + a.usd) / 4));
      out.push(a.side === 'buy'
        ? { time: a.time, position: 'belowBar', shape: 'arrowUp', color: colors.up, size, id: `tape-b-${a.time}` }
        : { time: a.time, position: 'aboveBar', shape: 'arrowDown', color: colors.down, size, id: `tape-s-${a.time}` });
    }
    return out.sort((x, y) => x.time - y.time);
  }

  // ---- task-1483 BUY / SELL markers: a mirror of @dexterm/tui markers.ts (test/chart-lib parity-tests the two). Fills
  // are bucketed to the bars on screen by their REAL time (bar.t, UTC ms); a fill older than the first bar, newer than
  // the last, or in a period with no bar is omitted and counted, never moved onto a neighbour.
  const EPS = 1e-9;
  function cleanFills(fills) {
    const out = [];
    for (const f of fills || []) {
      if (!f || !fin(f.t) || (f.side !== 'buy' && f.side !== 'sell') || (f.source !== 'paper' && f.source !== 'live')) continue;
      if (!fin(f.tokens) || f.tokens <= 0) continue;
      out.push({ t: f.t, side: f.side, source: f.source, priceUsd: fin(f.priceUsd) && f.priceUsd > 0 ? f.priceUsd : null, tokens: f.tokens, sol: fin(f.sol) && f.sol >= 0 ? f.sol : null });
    }
    return out.map((f, i) => [f, i]).sort((a, b) => a[0].t - b[0].t || a[1] - b[1]).map(([f]) => f);
  }
  /** Replay per source (average-cost ledger rule): partial / closing flags, the open average entry, closed round trips. */
  function replayFills(fills) {
    const st = { paper: { held: 0, cost: 0, costOk: true, trip: null }, live: { held: 0, cost: 0, costOk: true, trip: null } };
    const out = [], trips = [];
    for (const f of cleanFills(fills)) {
      const s = st[f.source]; const before = s.held;
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
    const avg = (src) => { const s = st[src]; return s.held > EPS && s.costOk && s.cost > 0 ? s.cost / s.held : null; };
    return { fills: out, avgEntry: { paper: avg('paper'), live: avg('live') }, trips };
  }
  function indexIn(times, t) { let lo = 0, hi = times.length - 1; while (lo <= hi) { const mid = (lo + hi) >> 1; const v = times[mid]; if (v === t) return mid; if (v < t) lo = mid + 1; else hi = mid - 1; } return -1; }
  /** Markers for the bars (`barTimes` = the bars' real UTC ms, ascending): one per (bar, side, source). */
  function chartMarkers(fills, periodMs, barTimes) {
    const rp = replayFills(fills);
    const res = { markers: [], before: 0, after: 0, gap: 0, avgEntry: rp.avgEntry, trips: [] };
    if (!(periodMs > 0) || !barTimes.length) { res.before = rp.fills.length; return res; }
    const first = barTimes[0], last = barTimes[barTimes.length - 1];
    const by = new Map();
    for (const f of rp.fills) {
      const b = Math.floor(f.t / periodMs) * periodMs;
      if (b < first) { res.before++; continue; }
      if (b > last) { res.after++; continue; }
      const index = indexIn(barTimes, b);
      if (index < 0) { res.gap++; continue; }
      const key = `${b}|${f.side}|${f.source}`;
      let m = by.get(key);
      if (!m) { m = { side: f.side, source: f.source, bucket: b, index, t: f.t, tLast: f.t, priceUsd: null, tokens: 0, sol: 0, count: 0, partial: false, closes: false, pTok: 0, pUsd: 0, solOk: true }; by.set(key, m); }
      m.count++; m.tLast = f.t; m.tokens += f.tokens;
      if (f.sol === null) m.solOk = false; else m.sol += f.sol;
      if (f.priceUsd !== null) { m.pTok += f.tokens; m.pUsd += f.tokens * f.priceUsd; }
      if (f.partial) m.partial = true;
      if (f.closes) m.closes = true;
    }
    const order = (m) => (m.side === 'buy' ? 0 : 1) * 2 + (m.source === 'live' ? 1 : 0);
    res.markers = [...by.values()].map(({ pTok, pUsd, solOk, ...m }) => ({ ...m, priceUsd: pTok > 0 ? pUsd / pTok : null, sol: solOk ? m.sol : null }))
      .sort((a, b) => a.index - b.index || order(a) - order(b));
    res.trips = rp.trips.filter((r) => Math.floor(r.closeT / periodMs) * periodMs >= first && Math.floor(r.openT / periodMs) * periodMs <= last);
    return res;
  }
  /**
   * Re-bucket on zoom: when bars are narrower than `minPx`, markers of the same side + source in each run of `k` bars
   * merge into one (token-weighted price, summed size and count, at the run's last bar), so glyphs never pile up.
   */
  function clusterMarkers(markers, barSpacingPx, minPx = 14) {
    const k = fin(barSpacingPx) && barSpacingPx > 0 ? Math.max(1, Math.ceil(minPx / barSpacingPx)) : 1;
    if (k === 1) return markers.map((m) => ({ ...m, span: 1 }));
    const by = new Map();
    for (const m of markers) {
      const g = Math.floor(m.index / k);
      const key = `${g}|${m.side}|${m.source}`;
      const c = by.get(key);
      if (!c) { by.set(key, { ...m, span: k, pTok: m.priceUsd !== null ? m.tokens : 0, pUsd: m.priceUsd !== null ? m.tokens * m.priceUsd : 0 }); continue; }
      c.index = Math.max(c.index, m.index); c.bucket = Math.max(c.bucket, m.bucket);
      c.t = Math.min(c.t, m.t); c.tLast = Math.max(c.tLast, m.tLast);
      c.count += m.count; c.tokens += m.tokens; c.sol = c.sol === null || m.sol === null ? null : c.sol + m.sol;
      if (m.priceUsd !== null) { c.pTok += m.tokens; c.pUsd += m.tokens * m.priceUsd; }
      c.partial = c.partial || m.partial; c.closes = c.closes || m.closes;
    }
    return [...by.values()].map(({ pTok, pUsd, ...m }) => ({ ...m, priceUsd: pTok > 0 ? pUsd / pTok : null })).sort((a, b) => a.index - b.index);
  }
  /** Solid ▲ / ▼ = live, hollow △ / ▽ = paper; B / S always (reads without colour). */
  function markerGlyph(side, source) { return source === 'paper' ? (side === 'buy' ? '△' : '▽') : (side === 'buy' ? '▲' : '▼'); }
  function markerLetter(side) { return side === 'buy' ? 'B' : 'S'; }
  /**
   * Pixel geometry of one marker: the triangle's tip sits ON the fill price (a buy points up from below, a sell points
   * down from above); with no price it sits against the bar (below the low / above the high). `x` = the bar's centre.
   */
  function markerShape(side, x, y, size = 6) {
    const s = size, buy = side === 'buy';
    const base = buy ? y + s * 1.6 : y - s * 1.6;
    const tri = [[x, y], [x - s, base], [x + s, base]];
    const labelY = buy ? base + 9 : base - 9;
    return { tri, labelX: x, labelY, hit: { x0: x - s - 3, x1: x + s + 3, y0: Math.min(y, labelY) - 7, y1: Math.max(y, labelY) + 7 } };
  }
  /** The hover tooltip lines for a marker (time, price — mcap and price on an mcap axis — size, source). */
  function markerTooltip(m, display, timeFmt) {
    const f = axisFormatter(display);
    const px = m.priceUsd === null ? 'price not recorded' : display && display.mode === 'mcap' ? `MC ${f(m.priceUsd)} (${fmtPrice(m.priceUsd)})` : fmtPrice(m.priceUsd);
    const when = m.count > 1 ? `${timeFmt(m.t)} – ${timeFmt(m.tLast)}` : timeFmt(m.t);
    const kind = m.side === 'buy' ? (m.partial ? 'BUY (added)' : 'BUY') : (m.closes ? 'SELL (closed)' : 'SELL (partial)');
    return [
      `${markerGlyph(m.side, m.source)}${markerLetter(m.side)} ${kind}${m.count > 1 ? ` ×${m.count}` : ''}`,
      when,
      `${m.count > 1 && m.priceUsd !== null ? 'avg ' : ''}${px}`,
      `${fmtTokens(m.tokens)} tokens${m.sol !== null ? ` · ${fmtSol(m.sol)}` : ''}`,
      m.source === 'paper' ? 'PAPER · simulated ledger' : 'LIVE · confirmed on-chain fill',
    ];
  }
  function fmtTokens(n) { return !fin(n) ? '—' : n >= 1e12 ? `${(n / 1e12).toFixed(2)}T` : n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e4 ? `${(n / 1e3).toFixed(1)}K` : n >= 1 ? String(Math.round(n * 100) / 100) : n.toPrecision(3); }
  /** "△B ▽S paper  ▲B ▼S live" for the sources on screen; "+N fills off-chart (…)" for what was omitted. */
  function markerLegend(markers) {
    const has = (s) => markers.some((m) => m.source === s);
    return [has('paper') ? '△B ▽S paper' : '', has('live') ? '▲B ▼S live' : ''].filter(Boolean).join('  ');
  }
  function omittedNote(s) {
    const n = s.before + s.after + s.gap;
    if (!n) return '';
    const why = [];
    if (s.before) why.push(`${s.before} earlier`);
    if (s.after) why.push(`${s.after} newer than the last candle`);
    if (s.gap) why.push(`${s.gap} in a period with no candle`);
    return `+${n} fill${n === 1 ? '' : 's'} off-chart (${why.join(', ')})`;
  }

  /** LWC price format for a price magnitude: enough decimals for memecoin prices (down to 1e-12). */
  function priceFormatFor(p) {
    if (!fin(p) || p <= 0) return { type: 'price', precision: 6, minMove: 1e-6 };
    const mag = Math.floor(Math.log10(p));
    const precision = Math.max(2, Math.min(12, 3 - mag + (p < 1 ? 1 : 0)));
    return { type: 'price', precision, minMove: Number((10 ** -precision).toPrecision(1)) };
  }

  // ---- formatting (mirrors @dexterm/tui fmtPrice: subscript zero-compression, $0.0₄123)
  const SUB = '₀₁₂₃₄₅₆₇₈₉';
  function fmtPrice(p) {
    if (!fin(p)) return '—';
    if (p < 0) return '-' + fmtPrice(-p);
    if (p >= 1000) return '$' + p.toLocaleString('en-US', { maximumFractionDigits: 0 });
    if (p >= 1) return '$' + p.toFixed(p >= 100 ? 2 : 3);
    if (p >= 0.01) return '$' + p.toFixed(4);
    if (p === 0) return '$0';
    const s = p.toFixed(14);
    const m = s.match(/^0\.(0*)(\d+)/);
    if (!m) return '$' + p;
    const zeros = m[1].length;
    const digits = m[2].replace(/0+$/, '').slice(0, 4) || '0';
    if (zeros < 3) return `$0.${m[1]}${digits}`;
    return `$0.0${String(zeros).split('').map((c) => SUB[Number(c)]).join('')}${digits}`;
  }
  /** Axis/crosshair price label: fmtPrice without the $ (TradingView style). */
  function fmtAxis(p) { return fmtPrice(p).replace('$', ''); }
  function fmtUsd(x) {
    if (!fin(x)) return '—';
    const a = Math.abs(x), s = x < 0 ? '-' : '';
    if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(2)}B`;
    if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(2)}M`;
    if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(1)}K`;
    return `${s}$${a.toFixed(0)}`;
  }
  // ---- task-1472 the one chart number formatter (mirrors @dexterm/tui fmtCompact, parity-tested): lowercase k, then
  // M/B/T; one decimal while < 10 of the unit, none after; the unit is promoted after rounding (999 900 → 1M); below 1
  // the subscript price form (0.0₅493): never scientific notation. `extra` (0..3) keeps two axis ticks apart.
  const CU = ['', 'k', 'M', 'B', 'T'];
  const trimZeros = (t) => (t.includes('.') ? t.replace(/0+$/, '').replace(/\.$/, '') : t);
  function tinyBare(p) {
    if (p >= 0.01) return p.toFixed(4);
    const m = p.toFixed(12).match(/^0\.(0*)(\d+)/);
    if (!m) return String(p);
    const zeros = m[1].length;
    const digits = m[2].replace(/0+$/, '').slice(0, 4) || '0';
    if (zeros < 3) return `0.${m[1]}${digits}`;
    return `0.0${String(zeros).split('').map((c) => SUB[Number(c)]).join('')}${digits}`;
  }
  function fmtCompact(n, extra = 0) {
    if (!fin(n)) return '—';
    if (n === 0) return '0';
    const sign = n < 0 ? '-' : '';
    const a = Math.abs(n);
    if (a < 1) return sign + trimZeros(tinyBare(a));
    const x = Math.max(0, Math.min(3, Math.floor(extra) || 0));
    const round = (q) => Number(q.toFixed((q < 10 ? 1 : 0) + x));
    let u = 0, v = a;
    while (u < CU.length - 1 && v >= 1000) { v /= 1000; u++; }
    let r = round(v);
    if (r >= 1000 && u < CU.length - 1) { u++; r = round(r / 1000); }
    return `${sign}${trimZeros(r.toFixed((r < 10 ? 1 : 0) + x))}${CU[u]}`;
  }
  /** `$4.9k`, `-$1.2k` (volume pane, legend volume). */
  function fmtCompactUsd(n, extra = 0) {
    const b = fmtCompact(n, extra);
    return b === '—' ? b : b.startsWith('-') ? `-$${b.slice(1)}` : `$${b}`;
  }
  /** task-1366 name kept: the mcap axis label is now the compact formatter. */
  const fmtMcapAxis = (n) => fmtCompact(n);
  const MCAP_LABEL = 'mcap (current supply)';
  const MCAP_FALLBACK = 'price (mcap unavailable)'; // task-1472: the card's wording (was 'supply unknown · showing price')
  /**
   * How the page shows numbers for a VM: `mcap` (with the supply multiplier) only when the terminal is in mcap mode AND
   * sent a usable supply; mcap mode without one is `price` + a visible note. Never invents a supply.
   */
  function displayOf(vm) {
    const wantMcap = !!vm && vm.priceMode === 'mcap';
    const supply = wantMcap && fin(vm.supply) && vm.supply > 0 ? vm.supply : null;
    // the key changes only when the supply moves in its 4th significant digit (no re-format on every tick)
    if (supply) return { mode: 'mcap', supply, label: MCAP_LABEL, key: `mcap:${Number(supply.toPrecision(4))}` };
    return { mode: 'price', supply: null, label: wantMcap ? MCAP_FALLBACK : null, key: wantMcap ? 'price:fallback' : 'price' };
  }
  /** The Y-axis / crosshair label formatter for a display: mcap = price × supply in compact k/M/B, else the price label. */
  function axisFormatter(d) {
    if (d && d.mode === 'mcap' && fin(d.supply)) { const s = d.supply; return (p) => fmtMcapAxis(p * s); }
    return fmtAxis;
  }
  function fmtPct(frac, digits = 2) { return fin(frac) ? `${frac >= 0 ? '+' : '-'}${Math.abs(frac * 100).toFixed(digits)}%` : '—'; }
  function fmtSol(n) { return `${n >= 100 ? n.toFixed(0) : n >= 0.01 ? n.toFixed(2) : n.toFixed(4)} SOL`; }

  /**
   * Crosshair/last-bar legend values for one bar (strings), with change vs the previous close. task-1366: with an mcap
   * display, O/H/L/C read market cap and the close carries the price in parentheses (`C 1.2M ($0.0₄123)`).
   */
  function legendFor(bar, prevClose, display) {
    if (!bar) return null;
    const base = fin(prevClose) && prevClose > 0 ? prevClose : bar.open;
    const chg = base > 0 ? (bar.close - base) / base : null;
    const f = axisFormatter(display);
    const mc = !!display && display.mode === 'mcap';
    return { o: f(bar.open), h: f(bar.high), l: f(bar.low), c: mc ? `${f(bar.close)} (${fmtPrice(bar.close)})` : f(bar.close), v: fmtCompactUsd(bar.volume), chg: fmtPct(chg), up: bar.close >= bar.open };
  }

  /** Index of the bar at `time` (binary search), or -1. */
  function indexOfTime(bars, time) {
    let lo = 0, hi = bars.length - 1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; const t = bars[mid].time; if (t === time) return mid; if (t < time) lo = mid + 1; else hi = mid - 1; }
    return -1;
  }

  /** Fractional logical index for any time (extrapolated past either end by the bar period). */
  function logicalOf(bars, time, periodS) {
    if (!bars.length) return null;
    const first = bars[0].time, last = bars[bars.length - 1].time;
    if (time <= first) return (time - first) / periodS;
    if (time >= last) return bars.length - 1 + (time - last) / periodS;
    let lo = 0, hi = bars.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (bars[mid].time <= time) lo = mid; else hi = mid; }
    const span = bars[hi].time - bars[lo].time;
    return lo + (span > 0 ? (time - bars[lo].time) / span : 0);
  }

  /** Time (UTC s) for a fractional logical index (inverse of logicalOf). */
  function timeOfLogical(bars, logical, periodS) {
    if (!bars.length || !fin(logical)) return null;
    const n = bars.length;
    if (logical <= 0) return bars[0].time + logical * periodS;
    if (logical >= n - 1) return bars[n - 1].time + (logical - (n - 1)) * periodS;
    const i = Math.floor(logical), f = logical - i;
    return bars[i].time + f * (bars[i + 1].time - bars[i].time);
  }

  const api = { setTzOffset, chartTime, INTERVALS, PERIOD_MS, INDICATORS, STYLES, SCALES, toBars, mergeTail, ema, sma, vwap, volumes, barTimeOf, tapeMarkers, cleanFills, replayFills, chartMarkers, clusterMarkers, markerGlyph, markerLetter, markerShape, markerTooltip, markerLegend, omittedNote, priceFormatFor, fmtPrice, fmtAxis, fmtUsd, fmtPct, fmtSol, legendFor, fmtMcapAxis, fmtCompact, fmtCompactUsd, displayOf, axisFormatter, MCAP_LABEL, MCAP_FALLBACK, indexOfTime, logicalOf, timeOfLogical };
  root.DTChart = Object.freeze(api);
})(typeof window !== 'undefined' ? window : globalThis);
