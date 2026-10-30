// dexterm dash (task-1749): the page. Plain JS, no dependency, no external request. Reads the JSON the local server
// computes (or data.json in a static snapshot), renders five views by hash route and refreshes every 30 s.
'use strict';
(() => {
  const SRC = document.querySelector('meta[name="dash-data"]').content;
  const LIVE = document.body.dataset.mode === 'live';
  const REFRESH_MS = 30_000;
  const $ = (s) => document.querySelector(s);
  const view = $('#view');
  let D = null; let lastOk = 0; let lastSig = '';

  // ---------- formatting ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fin = (x) => typeof x === 'number' && Number.isFinite(x);
  const MINUS = '−';
  const sgn = (x, d = 1) => (fin(x) ? `${x > 0 ? '+' : x < 0 ? MINUS : ''}${Math.abs(x).toFixed(d)}` : '–');
  const pct = (x, d = 1) => (fin(x) ? `<span class="num ${x > 0 ? 'up' : x < 0 ? 'down' : ''}">${sgn(x, d)}%</span>` : '<span class="muted">–</span>');
  const pp = (x) => (fin(x) ? `${sgn(x)} pp` : '–');
  const money = (x, unit = 'USD', d) => (!fin(x) ? '–' : unit === 'SOL' ? `${x < 0 ? MINUS : ''}${Math.abs(x).toFixed(d ?? 4)} SOL` : `${x < 0 ? MINUS : ''}$${Math.abs(x).toFixed(d ?? 2)}`);
  const smoney = (x, unit) => (fin(x) ? `<span class="num ${x > 0 ? 'up' : x < 0 ? 'down' : ''}">${x > 0 ? '+' : ''}${money(x, unit)}</span>` : '–');
  const ci = (lo, hi) => (fin(lo) && fin(hi) ? `<span class="num muted">(${sgn(lo)} … ${sgn(hi)})</span>` : '');
  const dtf = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  const when = (t) => (fin(t) ? dtf.format(new Date(t)) : '–');
  const ago = (t) => { if (!fin(t)) return '–'; const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 90 ? `${s} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };
  const coin = (c) => `${esc(c.symbol ?? '?')}${c.mint ? ` <span class="muted mono">${esc(c.mint.slice(0, 4))}…${esc(c.mint.slice(-4))}</span>` : ''}`;
  const byId = (id) => D.strategies.find((s) => s.id === id);
  const minN = () => D.definitions.minClosed;
  const badge = (s) => {
    const r = s.row;
    const b = r.sample === 'none' ? '<span class="badge none">no closed trades</span>' : r.sample === 'exploratory' ? `<span class="badge expl" title="Fewer than ${minN()} closed trades: read nothing into the numbers yet">exploratory · ${r.closed} closed &lt; ${minN()}</span>` : `<span class="badge ok">${r.closed} closed ≥ ${minN()}</span>`;
    return b + (s.baseline ? ' <span class="badge base">baseline</span>' : '');
  };
  const eta = (r) => (r.closed >= minN() ? 'reached' : fin(r.etaDays) ? `≈ ${r.etaDays < 1 ? `${Math.round(r.etaDays * 24)} h` : `${r.etaDays.toFixed(1)} d`}` : 'no entries yet');

  // ---------- charts (inline SVG, one series per chart, one y-axis) ----------
  // the SVG is drawn at its container's width (320-720 user units) so 11 px axis text stays 11 px on a phone
  let W = 720; let H = 240; const P = { l: 58, r: 12, t: 12, b: 26 };
  const narrow = () => W < 520;
  const fitWidth = () => { W = Math.round(Math.min(720, Math.max(320, view.clientWidth - 34))); H = narrow() ? 200 : 240; };
  const ticks = (lo, hi, n = 4) => { if (lo === hi) { lo -= 1; hi += 1; } const step0 = (hi - lo) / n; const mag = 10 ** Math.floor(Math.log10(step0)); const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0); const out = []; for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(10)); return out; };
  function spark(s) {
    const pts = [{ v: s.equity.start }, ...s.equity.points.map((p) => ({ v: p.usd }))];
    if (pts.length < 2) return '<svg class="spark" viewBox="0 0 120 40" aria-hidden="true"><line class="ref" x1="0" x2="120" y1="20" y2="20"/></svg>';
    const vs = pts.map((p) => p.v); const lo = Math.min(...vs); const hi = Math.max(...vs); const span = hi - lo || 1;
    const x = (i) => (i / (pts.length - 1)) * 116 + 2; const y = (v) => 36 - ((v - lo) / span) * 32;
    return `<svg class="spark" viewBox="0 0 120 40" preserveAspectRatio="none" role="img" aria-label="Realized equity, ${esc(money(s.equity.start, s.unit))} to ${esc(money(s.equity.end, s.unit))}"><line class="ref" x1="0" x2="120" y1="${y(s.equity.start).toFixed(1)}" y2="${y(s.equity.start).toFixed(1)}"/><path class="ln" vector-effect="non-scaling-stroke" d="${pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join('')}"/></svg>`;
  }
  /** A time-series line (or drawdown area) with a crosshair + tooltip. pts: [{t, v, tip}] */
  function timeChart(id, pts, { ref = null, fmt = (v) => v.toFixed(2), kind = 'line', label }) {
    if (pts.length < 2) return `<p class="empty">Not enough closed trades for a curve yet (${pts.length}).</p>`;
    const t0 = pts[0].t; const t1 = pts[pts.length - 1].t; const tspan = t1 - t0 || 1;
    const vs = pts.map((p) => p.v).concat(ref === null ? [] : [ref]); let lo = Math.min(...vs); let hi = Math.max(...vs);
    if (kind === 'dd') { hi = 0; lo = Math.min(lo, -1); }
    const pad = (hi - lo || 1) * 0.08; lo -= kind === 'dd' ? pad : pad; hi += kind === 'dd' ? 0 : pad;
    const X = (t) => P.l + ((t - t0) / tspan) * (W - P.l - P.r); const Y = (v) => P.t + (1 - (v - lo) / (hi - lo)) * (H - P.t - P.b);
    const yt = ticks(lo, hi); const path = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`).join('');
    const xt = [t0, t0 + tspan / 2, t1];
    let body = `<g class="grid">${yt.map((v) => `<line x1="${P.l}" x2="${W - P.r}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/>`).join('')}</g>`;
    body += `<g class="axis">${yt.map((v) => `<text x="${P.l - 6}" y="${(Y(v) + 4).toFixed(1)}" text-anchor="end">${esc(fmt(v))}</text>`).join('')}${xt.map((t, i) => `<text x="${X(t).toFixed(1)}" y="${H - 6}" text-anchor="${['start', 'middle', 'end'][i]}">${esc(when(t))}</text>`).join('')}</g>`;
    if (ref !== null) body += `<line class="ref" x1="${P.l}" x2="${W - P.r}" y1="${Y(ref).toFixed(1)}" y2="${Y(ref).toFixed(1)}"/>`;
    if (kind === 'dd') body += `<path class="dd-area" d="${path}L${X(t1).toFixed(1)},${Y(0).toFixed(1)}L${X(t0).toFixed(1)},${Y(0).toFixed(1)}Z"/><path class="dd" d="${path}"/>`;
    else body += `<path class="area" d="${path}L${X(t1).toFixed(1)},${(H - P.b).toFixed(1)}L${X(t0).toFixed(1)},${(H - P.b).toFixed(1)}Z"/><path class="ln" d="${path}"/>`;
    const last = pts[pts.length - 1];
    if (kind !== 'dd') body += `<circle class="dot" r="4.5" cx="${X(last.t).toFixed(1)}" cy="${Y(last.v).toFixed(1)}"/>`;
    body += `<line class="xh" id="${id}-xh" y1="${P.t}" y2="${H - P.b}" x1="-10" x2="-10"/><rect class="hit" x="${P.l}" y="0" width="${W - P.l - P.r}" height="${H}"/>`;
    chartData[id] = { pts: pts.map((p) => ({ x: X(p.t), y: Y(p.v), tip: p.tip })) };
    return `<div class="chartbox"><svg class="chart" id="${id}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">${body}</svg><div class="tip" id="${id}-tip"></div></div>`;
  }
  const chartData = {};
  function wireCharts() {
    for (const [id, cd] of Object.entries(chartData)) {
      const svg = document.getElementById(id); if (!svg) continue;
      const tip = document.getElementById(`${id}-tip`); const xh = document.getElementById(`${id}-xh`);
      const move = (ev) => {
        const r = svg.getBoundingClientRect(); const vx = ((ev.clientX - r.left) / r.width) * W;
        let best = cd.pts[0]; for (const p of cd.pts) if (Math.abs(p.x - vx) < Math.abs(best.x - vx)) best = p;
        xh.setAttribute('x1', best.x); xh.setAttribute('x2', best.x);
        tip.innerHTML = best.tip; tip.style.display = 'block';
        const box = svg.parentElement.getBoundingClientRect();
        tip.style.left = `${Math.min(Math.max((best.x / W) * r.width + (r.left - box.left), 70), box.width - 70)}px`; tip.style.top = `${(best.y / H) * r.height + (r.top - box.top)}px`;
      };
      const out = () => { tip.style.display = 'none'; xh.setAttribute('x1', -10); xh.setAttribute('x2', -10); };
      svg.addEventListener('pointermove', move); svg.addEventListener('pointerdown', move); svg.addEventListener('pointerleave', out);
    }
  }
  /** Exit reasons as horizontal bars (count), the mean % per reason as text. */
  function exitBars(exits) {
    if (!exits.length) return '<p class="empty">No closed trades yet.</p>';
    const max = Math.max(...exits.map((e) => e.n)); const rowH = 30; const h = exits.length * rowH + 8; const L = narrow() ? 92 : 150; const R = narrow() ? 92 : 150;
    const rows = exits.map((e, i) => { const w = Math.max(4, (e.n / max) * (W - L - R)); const y = 4 + i * rowH;
      return `<g><title>${esc(e.reason)}: ${e.n} closed, mean ${sgn(e.meanPct)}%, ${e.wins} wins</title><text class="lbl" x="${L - 8}" y="${y + 18}" text-anchor="end">${esc(e.reason.slice(0, narrow() ? 12 : 20))}</text><rect class="bar${fin(e.meanPct) && e.meanPct < 0 ? ' neg' : ''}" x="${L}" y="${y + 5}" width="${w.toFixed(1)}" height="18" rx="4"/><text class="lbl" x="${L + w + 8}" y="${y + 18}">${e.n} · ${esc(sgn(e.meanPct))}%</text></g>`; }).join('');
    return `<div class="chartbox"><svg class="chart" viewBox="0 0 ${W} ${h}" role="img" aria-label="Closed trades by exit reason">${rows}</svg></div>`;
  }
  /** Compare: the difference in mean % per entry vs the baseline with its 95% interval (a dot and whisker per variant). */
  function forest(cs) {
    const ok = cs.filter((c) => fin(c.diff.mean)); if (!ok.length) return '<p class="empty">Nothing to compare yet.</p>';
    const vals = ok.flatMap((c) => [c.diff.lo, c.diff.hi, c.diff.mean]).filter(fin).concat([0]); let lo = Math.min(...vals); let hi = Math.max(...vals); const pad = (hi - lo || 1) * 0.06; lo -= pad; hi += pad;
    const L = narrow() ? 118 : 150; const R = 16; const rowH = 30; const h = ok.length * rowH + 34; const X = (v) => L + ((v - lo) / (hi - lo)) * (W - L - R);
    const xt = ticks(lo, hi, 5);
    let b = `<g class="grid">${xt.map((v) => `<line x1="${X(v).toFixed(1)}" x2="${X(v).toFixed(1)}" y1="4" y2="${h - 24}"/>`).join('')}</g><g class="axis">${xt.map((v) => `<text x="${X(v).toFixed(1)}" y="${h - 8}" text-anchor="middle">${esc(sgn(v, 0))}</text>`).join('')}</g><line class="zero" x1="${X(0).toFixed(1)}" x2="${X(0).toFixed(1)}" y1="4" y2="${h - 24}"/>`;
    ok.forEach((c, i) => { const y = 4 + i * rowH + 14;
      b += `<g><title>${esc(c.id)} − ${esc(c.base)}: ${pp(c.diff.mean)} (95% ${sgn(c.diff.lo)} … ${sgn(c.diff.hi)}), ${c.n} vs ${c.baseN} closed. ${esc(c.verdict)}</title><text class="lbl" x="${L - 8}" y="${y + 4}" text-anchor="end">${esc(c.id.slice(0, narrow() ? 15 : 18))}</text>${fin(c.diff.lo) && fin(c.diff.hi) ? `<line class="ci" x1="${X(c.diff.lo).toFixed(1)}" x2="${X(c.diff.hi).toFixed(1)}" y1="${y}" y2="${y}"/>` : ''}<circle class="mean" r="5.5" cx="${X(c.diff.mean).toFixed(1)}" cy="${y}"/></g>`; });
    return `<div class="chartbox"><svg class="chart" viewBox="0 0 ${W} ${h}" role="img" aria-label="Difference in mean % per entry against the baseline, with 95% intervals">${b}</svg></div><p class="muted note">Dot = difference in mean % on cost per entry (variant minus baseline, percentage points); line = its 95% interval. A line that crosses 0 means the data cannot tell them apart.</p>`;
  }

  // ---------- views ----------
  const disclaimer = () => `<p class="disclaimer"><strong>Paper trading, not financial advice.</strong> Simulated fills on paper books. Small samples say almost nothing: every number carries its sample size, and anything under ${minN()} closed trades is exploratory.</p>`;
  function overview() {
    const S = D.strategies;
    if (!S.length) return `<h1>Overview</h1>${disclaimer()}<p class="empty">No strategies found. Run a paper strategy with <code>dexterm autotrade run</code>, then come back.</p>${notes()}`;
    const cards = S.map((s) => { const r = s.row;
      return `<a class="card${s.baseline ? ' base' : ''}" href="#/strategy/${encodeURIComponent(s.id)}"><div class="head"><span class="id">${esc(s.id)}</span><span class="grp">${esc(s.group)}</span></div><div class="label">${esc(s.label)}</div><div>${badge(s)}</div>
        <div class="kv"><div><div class="k">mean / trade</div><div class="v">${pct(r.meanPct)}</div></div><div><div class="k">closed · open</div><div class="v">${r.closed} · ${r.open}</div></div><div><div class="k">wins · rugs</div><div class="v">${r.wins} · ${r.rugs}</div></div>
        <div><div class="k">95% interval</div><div class="v sm">${fin(r.lo) ? `${sgn(r.lo)} … ${sgn(r.hi)}` : '–'}</div></div><div><div class="k">realized</div><div class="v md">${smoney(r.realizedUsd, s.unit)}</div></div><div><div class="k">ETA to ${minN()}</div><div class="v md">${eta(r)}</div></div></div>${spark(s)}</a>`; }).join('');
    const rows = S.map((s) => { const r = s.row; return `<tr${s.baseline ? ' class="base"' : ''}><td><a href="#/strategy/${encodeURIComponent(s.id)}">${esc(s.id)}</a>${s.baseline ? ' <span class="badge base">baseline</span>' : ''}</td><td>${esc(s.group)}</td><td class="r num">${r.entries}</td><td class="r num">${r.closed}</td><td class="r num">${r.open}</td><td class="r num">${r.writtenOff}</td><td class="r num">${r.wins} / ${r.losses}</td><td class="r num">${r.rugs}${r.closed ? ` (${Math.round(r.rugRate * 100)}%)` : ''}</td><td class="r">${pct(r.meanPct)} ${ci(r.lo, r.hi)}</td><td class="r">${smoney(r.realizedUsd, s.unit)}</td><td class="r num">${fin(s.equity.maxDrawdownPct) ? `${s.equity.maxDrawdownPct.toFixed(1)}%` : '–'}</td><td class="r num">${fin(r.entriesPerDay) ? r.entriesPerDay.toFixed(1) : '–'}</td><td>${eta(r)}</td><td>${r.sample === 'exploratory' ? 'exploratory' : r.sample === 'none' ? '–' : 'n ≥ ' + minN()}</td></tr>`; }).join('');
    return `<h1>Overview</h1><p class="lead">${S.length} strategies side by side${D.baseline ? `; the baseline is <strong class="mono">${esc(D.baseline)}</strong>` : ''}. Tap one for its detail.</p>${disclaimer()}<div class="grid g4">${cards}</div>
      <h2>Table view</h2><div class="tw"><table><caption>Mean % on cost per closed trade with its 95% interval; rugs = closed at ${D.definitions.rugPct}% or worse; drawdown of the realized equity curve.</caption><thead><tr><th>strategy</th><th>group</th><th class="r">entries</th><th class="r">closed</th><th class="r">open</th><th class="r">written off</th><th class="r">wins / losses</th><th class="r">rugs</th><th class="r">mean % (95%)</th><th class="r">realized</th><th class="r">max DD</th><th class="r">entries/day</th><th>ETA to ${minN()}</th><th>sample</th></tr></thead><tbody>${rows}</tbody></table></div>${notes()}`;
  }
  function strategy(id) {
    const S = D.strategies; if (!S.length) return overview();
    const s = byId(id) ?? S[0]; const r = s.row; const u = s.unit;
    const pick = `<label class="pick" for="pick">Strategy <select id="pick">${S.map((x) => `<option value="${esc(x.id)}"${x.id === s.id ? ' selected' : ''}>${esc(x.id)}${x.baseline ? ' (baseline)' : ''} · ${esc(x.group)}</option>`).join('')}</select></label>`;
    const tiles = [['mean % on cost', pct(r.meanPct), fin(r.lo) ? `95% ${sgn(r.lo)} … ${sgn(r.hi)}` : 'no interval yet'], ['closed', `<span class="num">${r.closed}</span>`, `${r.entries} entries · ${r.open} open`], ['wins / losses', `<span class="num">${r.wins} / ${r.losses}</span>`, r.closed ? `${Math.round((r.wins / r.closed) * 100)}% won` : '–'],
      ['rugs (≤ ' + D.definitions.rugPct + '%)', `<span class="num">${r.rugs}</span>`, r.closed ? `${Math.round(r.rugRate * 100)}% (95% ${Math.round((r.rugCi[0] ?? 0) * 100)}–${Math.round((r.rugCi[1] ?? 0) * 100)}%)` : '–'], ['realized', smoney(r.realizedUsd, u), `book ${money(s.equity.start, u)} → ${money(s.equity.end, u)}`], ['max drawdown', `<span class="num">${s.equity.maxDrawdownPct.toFixed(1)}%</span>`, `${fin(r.entriesPerDay) ? r.entriesPerDay.toFixed(1) : '–'} entries/day · ETA ${eta(r)}`]]
      .map(([k, v, x]) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${x}</div></div>`).join('');
    const eqPts = [{ t: s.firstEventAt ?? (s.equity.points[0]?.t ?? 0), v: s.equity.start, tip: `start ${money(s.equity.start, u)}` }, ...s.equity.points.map((p, i) => { const c = s.trades[i]; return { t: p.t, v: p.usd, tip: `${esc(when(p.t))} · ${money(p.usd, u)}${c ? ` · ${esc(c.symbol ?? '?')} ${sgn(c.pnlPct)}%` : ''}` }; })];
    const ddPts = [{ t: eqPts[0].t, v: 0, tip: 'peak' }, ...s.equity.points.map((p) => ({ t: p.t, v: -p.drawdownPct, tip: `${esc(when(p.t))} · drawdown ${p.drawdownPct.toFixed(1)}%` }))];
    const open = s.open.length ? `<div class="tw"><table><thead><tr><th>coin</th><th>profile</th><th class="r">cost</th><th class="r">engine mark</th><th class="r">pool liquidity</th><th class="r">realizable</th><th>state</th></tr></thead><tbody>${s.open.map((o) => `<tr><td>${coin(o)}</td><td>${esc(o.profile ?? '–')}</td><td class="r num">${money(o.costUsd, u)}</td><td class="r">${money(o.markUsd, u)} ${pct(o.markPct)}</td><td class="r num">${fin(o.liqUsd) ? `$${Math.round(o.liqUsd).toLocaleString()} <span class="muted">(${ago(o.liqAt)})</span>` : '<span class="muted">not read</span>'}</td><td class="r">${fin(o.realizableUsd) ? `${money(o.realizableUsd, u)} ${pct(o.realizablePct)}` : '<span class="muted">unknown (no pool read)</span>'}</td><td>${o.stuck ? '<strong class="down">stuck: no pool to sell into</strong>' : 'open'}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">No open positions.</p>';
    const trades = s.trades.length ? `<div class="tw"><table><thead><tr><th>closed</th><th>coin</th><th>profile</th><th class="r">% on cost</th><th class="r">P/L</th><th class="r">cost</th><th class="r">held</th><th>exit</th></tr></thead><tbody>${[...s.trades].reverse().slice(0, 300).map((c) => `<tr><td class="num">${esc(when(c.t))}</td><td>${coin(c)}</td><td>${esc(c.profile ?? '–')}</td><td class="r">${pct(c.pnlPct)}</td><td class="r">${smoney(c.pnlUsd, u)}</td><td class="r num">${money(c.costUsd, u)}</td><td class="r num">${fin(c.openedAt) ? `${Math.max(0, Math.round((c.t - c.openedAt) / 60000))} min` : '–'}</td><td>${c.writtenOff ? '<strong>written off</strong>' : esc(c.exitReason ?? '–')}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">No closed trades yet.</p>';
    return `<h1 class="mono">${esc(s.id)}</h1><p class="lead">${esc(s.label)} · ${esc(s.group)} · ${esc(s.mode ?? 'paper')} · ${badge(s)} · last event ${ago(s.lastEventAt)}</p>${pick}${disclaimer()}<div class="tiles">${tiles}</div>
      <h2>Realized equity</h2>${timeChart('eq', eqPts, { ref: s.equity.start, fmt: (v) => (u === 'SOL' ? v.toFixed(2) : `$${v.toFixed(0)}`), label: `Realized equity of ${s.id} over time` })}
      <h2>Drawdown from the running peak</h2>${timeChart('dd', ddPts, { fmt: (v) => `${v.toFixed(0)}%`, kind: 'dd', label: `Drawdown of ${s.id}` })}
      <h2>Exit reasons</h2>${exitBars(r.exits)}
      <h2>Open positions</h2><p class="lead">Engine mark = what the engine values it at. Realizable = that mark sold into the last pool read from the local cache (price impact on half the liquidity, 2.3% fees and slippage). Stuck = 0.</p>${open}
      <h2>Trades (${s.trades.length})</h2>${trades}`;
  }
  function rugs() {
    const all = D.strategies.flatMap((s) => s.rugs.map((c) => ({ s, c }))).sort((a, b) => b.c.t - a.c.t);
    const stuckOpen = D.strategies.flatMap((s) => s.open.filter((o) => o.stuck).map((o) => ({ s, o })));
    const rows = all.map(({ s, c }) => `<tr><td><a href="#/strategy/${encodeURIComponent(s.id)}">${esc(s.id)}</a></td><td>${coin(c)}</td><td class="num">${esc(when(c.t))}</td><td class="r">${pct(c.pnlPct)}</td><td class="r num">${money(c.costUsd, s.unit)}</td><td class="r num">${c.writtenOff ? money(c.realizedUsd, s.unit) : '–'}</td><td class="r num">${fin(c.entryAgeMin) ? `${c.entryAgeMin < 120 ? `${Math.round(c.entryAgeMin)} min` : `${(c.entryAgeMin / 60).toFixed(1)} h`}` : '–'}</td><td class="r num">${fin(c.entryLiqUsd) ? `$${Math.round(c.entryLiqUsd).toLocaleString()}` : '–'}</td><td class="wrap">${c.writtenOff ? `<strong>written off</strong>: ${esc(c.reason ?? '')}` : `closed ${esc(c.exitReason ?? '')}`}</td></tr>`).join('');
    const age = (c) => (fin(c.entryAgeMin) ? (c.entryAgeMin < 120 ? `${Math.round(c.entryAgeMin)} min` : `${(c.entryAgeMin / 60).toFixed(1)} h`) : '–');
    const cards = all.map(({ s, c }) => `<div class="card rug"><div class="head"><span class="id">${coin(c)}</span><span class="grp">${esc(s.id)}</span><span class="r">${pct(c.pnlPct)}</span></div><dl class="items"><dt>closed</dt><dd>${esc(when(c.t))}</dd><dt>cost → sold</dt><dd>${money(c.costUsd, s.unit)} → ${c.writtenOff ? money(c.realizedUsd, s.unit) : '–'}</dd><dt>pool at entry</dt><dd>${age(c)} old${fin(c.entryLiqUsd) ? ` · $${Math.round(c.entryLiqUsd).toLocaleString()} liq` : ''}</dd><dt>why</dt><dd>${c.writtenOff ? `<strong>written off</strong>: ${esc(c.reason ?? '')}` : `closed ${esc(c.exitReason ?? '')}`}</dd></dl></div>`).join('');
    return `<h1>Rugs &amp; stuck</h1><p class="lead">Closed at ${D.definitions.rugPct}% or worse, plus every stuck position written off: the engine could not sell it (no pool to sell into) for ${D.definitions.writeOffMin} min or more, so it is closed here at what it actually sold; the unsold rest counts 0. The engine's own files are never edited.</p>${disclaimer()}
      ${stuckOpen.length ? `<h2>Stuck now (not yet written off)</h2><div class="tw"><table><thead><tr><th>strategy</th><th>coin</th><th class="r">cost</th><th class="r">engine mark</th></tr></thead><tbody>${stuckOpen.map(({ s, o }) => `<tr><td>${esc(s.id)}</td><td>${coin(o)}</td><td class="r num">${money(o.costUsd, s.unit)}</td><td class="r">${money(o.markUsd, s.unit)}</td></tr>`).join('')}</tbody></table></div>` : ''}
      <h2>Rugs and write-offs (${all.length})</h2>${all.length ? `<div class="only-narrow">${cards}</div><div class="tw only-wide"><table><thead><tr><th>strategy</th><th>coin</th><th>closed</th><th class="r">% on cost</th><th class="r">cost</th><th class="r">sold before stuck</th><th class="r">pool age at entry</th><th class="r">liquidity at entry</th><th>why</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="empty">None so far.</p>'}`;
  }
  function compare() {
    if (!D.baseline) return `<h1>Compare</h1>${disclaimer()}<p class="empty">No baseline set. Start the dashboard with <code>--baseline ID</code> to compare every strategy with it.</p>`;
    const rows = D.comparisons.map((c) => `<tr><td><a href="#/strategy/${encodeURIComponent(c.id)}">${esc(c.id)}</a></td><td class="r num">${c.n} / ${c.baseN}</td><td class="r num">${pp(c.diff.mean)}</td><td class="r">${ci(c.diff.lo, c.diff.hi)}</td><td>${esc(c.verdict)}</td></tr>`).join('');
    return `<h1>Compare with the baseline</h1><p class="lead">Each strategy against <strong class="mono">${esc(D.baseline)}</strong>: the difference in mean % on cost per closed trade, with its 95% bootstrap interval.</p>${disclaimer()}<div class="rule"><strong>Decision rule.</strong> ${esc(D.decisionRule)}</div>${forest(D.comparisons)}
      <h2>Table view</h2><div class="tw"><table><thead><tr><th>strategy</th><th class="r">closed (strategy / baseline)</th><th class="r">difference</th><th class="r">95% interval</th><th>verdict</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  function live() {
    const cards = D.status.map((c) => `<section class="card status ${esc(c.state)}"><div class="head"><h3>${esc(c.title)}</h3><span class="st ${esc(c.state)}">${esc({ ok: 'up', warn: 'attention', down: 'down', idle: 'idle' }[c.state] ?? c.state)}</span></div><dl class="items">${c.items.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(v) ? `${esc(when(Date.parse(v)))} <span class="muted">(${ago(Date.parse(v))})</span>` : esc(v)}</dd>`).join('')}</dl>${fin(c.updatedAt) ? `<p class="muted note">updated ${ago(c.updatedAt)}</p>` : ''}</section>`).join('');
    const last = D.strategies.map((s) => `<tr><td>${esc(s.id)}</td><td>${esc(s.group)}</td><td class="num">${ago(s.lastEventAt)}</td><td class="r num">${s.open.length}</td></tr>`).join('');
    return `<h1>Live status</h1><p class="lead">${LIVE ? `What is running now. This page re-reads the ledgers every ${REFRESH_MS / 1000} s.` : 'A snapshot: what was running when it was taken.'} Data computed ${ago(D.generatedAt)}.</p>${disclaimer()}<div class="grid">${cards || '<p class="empty">No status sources.</p>'}</div>
      <h2>Last ledger event per strategy</h2><div class="tw"><table><thead><tr><th>strategy</th><th>group</th><th>last event</th><th class="r">open</th></tr></thead><tbody>${last}</tbody></table></div>${notes()}`;
  }
  const notes = () => (D.notes?.length ? `<h2>Notes</h2><ul class="muted">${D.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : '');
  function foot() {
    $('#foot').innerHTML = `<p><strong>Paper trading, not financial advice.</strong> Simulated trades on paper books; no real funds, no wallet, no keys. Simulated results say nothing about future results.</p><details><summary>What the numbers mean</summary><ul>${D.definitions.text.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></details><p>${LIVE ? 'Served by <code>dexterm dash</code> on this machine (read-only).' : `Read-only snapshot taken ${esc(when(D.generatedAt))}.`}</p>`;
  }

  // ---------- routing, refresh, theme ----------
  const route = () => { const h = location.hash.replace(/^#\/?/, '').split('/'); return { name: h[0] || 'overview', arg: h[1] ? decodeURIComponent(h[1]) : null }; };
  function render() {
    if (!D) return;
    const r = route(); const focusPick = document.activeElement?.id === 'pick'; const sy = window.scrollY;
    for (const k of Object.keys(chartData)) delete chartData[k];
    fitWidth();
    view.innerHTML = r.name === 'strategy' ? strategy(r.arg) : r.name === 'rugs' ? rugs() : r.name === 'compare' ? compare() : r.name === 'live' ? live() : overview();
    for (const a of document.querySelectorAll('nav.tabs a')) { if (a.dataset.view === (['strategy', 'rugs', 'compare', 'live'].includes(r.name) ? r.name : 'overview')) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); }
    const pick = $('#pick'); if (pick) { pick.addEventListener('change', () => { location.hash = `#/strategy/${encodeURIComponent(pick.value)}`; }); if (focusPick) pick.focus(); }
    wireCharts(); foot(); window.scrollTo(0, sy);
  }
  function stamp(err) {
    const el = $('#updated'); const t = $('#updated-text');
    if (!D) { t.textContent = err ? `cannot read data (${err})` : 'loading…'; el.classList.toggle('stale', !!err); return; }
    const stale = LIVE ? (Date.now() - lastOk > REFRESH_MS * 3 || !!err) : true;
    el.classList.toggle('stale', LIVE && stale);
    t.innerHTML = LIVE ? `updated ${esc(ago(D.generatedAt))}<span class="long"> · auto-refresh ${REFRESH_MS / 1000} s</span>${err ? ` · <strong>refresh failed</strong>` : ''}` : `snapshot ${esc(when(D.generatedAt))}`;
  }
  async function load() {
    try {
      const res = await fetch(SRC, { cache: 'no-store' }); if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json(); lastOk = Date.now(); D = d;
      const sig = JSON.stringify([d.strategies, d.status, d.comparisons]);
      if (sig !== lastSig) { lastSig = sig; render(); }
      stamp(null);
    } catch (e) { stamp(String(e.message ?? e)); }
  }
  const THEMES = ['auto', 'dark', 'light'];
  function setTheme(t) { if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t; const b = $('#theme'); b.textContent = t; b.setAttribute('aria-label', `Theme: ${t}. Switch theme`); try { localStorage.setItem('dexterm-dash-theme', t); } catch { /* private mode */ } }
  $('#theme').addEventListener('click', () => { const cur = document.documentElement.dataset.theme ?? 'auto'; setTheme(THEMES[(THEMES.indexOf(cur) + 1) % 3]); });
  try { const t = new URLSearchParams(location.search).get('theme') ?? localStorage.getItem('dexterm-dash-theme'); if (THEMES.includes(t)) setTheme(t); } catch { /* none */ }
  let lastW = 0; window.addEventListener('resize', () => { const w = view.clientWidth; if (Math.abs(w - lastW) > 40) { lastW = w; clearTimeout(window.__dashRs); window.__dashRs = setTimeout(render, 150); } });
  window.addEventListener('hashchange', () => { render(); view.focus({ preventScroll: true }); window.scrollTo(0, 0); });
  load();
  if (LIVE) { setInterval(load, REFRESH_MS); setInterval(() => stamp(null), 10_000); }
})();
