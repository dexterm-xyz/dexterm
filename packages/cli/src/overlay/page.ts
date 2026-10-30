// dexterm — STREAMER OVERLAY page (task-1427): one self-contained HTML document per scene, built for an OBS
// browser source. The body is transparent (OBS composites it over the stream); the panels carry the cyberspace
// look in three presets. Everything is inlined under the server's per-page nonce; the script builds the DOM with
// textContent only (never innerHTML), because every string it shows came from an agent or a token and is untrusted.
// The page has no controls and sends nothing back: the socket is read-only (see server.ts).

import type { OverlayPage } from './server.ts';

export interface OverlayTheme {
  /** Panel fill (alpha so the stream shows through). */
  panel: string; edge: string; glow: string;
  text: string; muted: string; dim: string; accent: string;
  up: string; down: string; warn: string;
}

/** Three presets of the cyberspace look (the app's `cyberspace` theme tokens and two neon variants). */
export const OVERLAY_THEMES = {
  cyberspace: { panel: 'rgba(3,9,12,0.86)', edge: '#0c3a24', glow: '#39ff14', text: '#eafff0', muted: '#62c98a', dim: '#3aa866', accent: '#00f0ff', up: '#5dff6e', down: '#ff3b6b', warn: '#f5ff2d' },
  ice: { panel: 'rgba(2,8,16,0.86)', edge: '#0b3348', glow: '#00f0ff', text: '#e8fbff', muted: '#6cc7dd', dim: '#3f98b0', accent: '#39ff14', up: '#5dff6e', down: '#ff3b6b', warn: '#f5ff2d' },
  neon: { panel: 'rgba(10,3,16,0.86)', edge: '#3b0f4a', glow: '#ff2bd6', text: '#fff0fc', muted: '#d07ac0', dim: '#a04f93', accent: '#00f0ff', up: '#5dff6e', down: '#ff3b6b', warn: '#f5ff2d' },
} as const satisfies Record<string, OverlayTheme>;
export type OverlayThemeName = keyof typeof OVERLAY_THEMES;
export const OVERLAY_THEME_NAMES = Object.keys(OVERLAY_THEMES) as OverlayThemeName[];

const CSS = `
:root{--panel:__PANEL__;--edge:__EDGE__;--glow:__GLOW__;--text:__TEXT__;--muted:__MUTED__;--dim:__DIM__;--accent:__ACCENT__;--up:__UP__;--down:__DOWN__;--warn:__WARN__}
html,body{margin:0;padding:0;background:transparent;color:var(--text);font:600 18px/1.35 ui-monospace,SFMono-Regular,Menlo,Consolas,"DejaVu Sans Mono",monospace;overflow:hidden}
body{padding:12px}
.grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px}
.grid .pnl{grid-column:1 / span 2}
.scene{background:var(--panel);border:1px solid var(--edge);box-shadow:0 0 0 1px rgba(0,0,0,.4),0 0 18px -6px var(--glow);border-radius:6px;padding:10px 14px;max-width:1200px}
.head{display:flex;gap:10px;align-items:center;border-bottom:1px solid var(--edge);padding-bottom:6px;margin-bottom:8px;white-space:nowrap}
.brand{color:var(--glow)}.title{color:var(--muted);letter-spacing:.08em}
.sp{flex:1}
.chip{border:1px solid var(--edge);border-radius:3px;padding:0 6px;color:var(--dim);font-size:14px}
.chip.sample{color:#000;background:var(--warn);border-color:var(--warn)}
.chip.old{color:var(--warn);border-color:var(--warn)}
.chip.paper{color:#000;background:var(--warn);border-color:var(--warn)}
.chip.live{color:#000;background:var(--up);border-color:var(--up)}
.chip.off{color:var(--down);border-color:var(--down)}
.row{display:grid;grid-template-columns:3.2em 9em 11em minmax(0,1fr) 4.5em;gap:8px;white-space:nowrap;overflow:hidden}
.row>*{overflow:hidden;text-overflow:ellipsis}
.when,.age{color:var(--dim)}.agent{color:var(--accent)}.tool{color:var(--muted)}.bad{color:var(--down)}
.sym{font-size:34px;color:var(--text)}.mint{color:var(--dim);font-size:14px}
.kv{display:flex;gap:10px;margin:4px 0;white-space:nowrap}.k{color:var(--dim);min-width:7.5em}.v{overflow:hidden;text-overflow:ellipsis}
.bar{height:14px;border:1px solid var(--edge);border-radius:2px;background:rgba(0,0,0,.35);margin:3px 0 2px}
.fill{height:100%;background:linear-gradient(90deg,var(--up),var(--warn) 55%,var(--down))}
.small{font-size:14px;color:var(--dim)}
.flag{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.flag.warn,.flag.down{color:var(--down)}.flag.up{color:var(--up)}.flag.info{color:var(--muted)}
.card{position:relative}.card img{display:block;width:100%;height:auto;image-rendering:pixelated;border-radius:3px}
.banner{position:absolute;left:0;right:0;top:0;text-align:center;font-size:22px;line-height:30px;color:#000;background:var(--warn);letter-spacing:.12em;border-radius:3px 3px 0 0}
.empty{color:var(--dim)}
.foot{margin-top:6px;color:var(--dim);font-size:13px}
`;

const JS = `
(function(){
  'use strict';
  var PAGE = document.querySelector('meta[name="dexterm-page"]').content;
  var WS_URL = document.querySelector('meta[name="dexterm-ws"]').content;
  var SCENES = PAGE === 'all' ? ['coin','activity','pnl'] : [PAGE];
  var TITLES = { activity: 'AGENT ACTIVITY', coin: 'COIN', pnl: 'PnL' };
  var root = document.getElementById('root');
  if (PAGE === 'all') root.className = 'grid';
  var boxes = {};
  function el(tag, cls, text){ var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined && text !== null) e.textContent = String(text); return e; }
  SCENES.forEach(function(s){
    var box = el('section', 'scene ' + s);
    var head = el('div', 'head');
    head.appendChild(el('span', 'brand', '\\u25c6 dexterm'));
    head.appendChild(el('span', 'title', TITLES[s]));
    head.appendChild(el('span', 'sp'));
    var stamp = el('span', 'chip'); stamp.hidden = true; head.appendChild(stamp);
    var sample = el('span', 'chip sample', 'SAMPLE DATA \\u00b7 REPLAY'); sample.hidden = true; head.appendChild(sample);
    var age = el('span', 'chip age', 'waiting for data'); head.appendChild(age);
    var conn = el('span', 'chip off', 'disconnected'); conn.hidden = true; head.appendChild(conn);
    var body = el('div', 'body'); body.appendChild(el('div', 'empty', 'waiting for the agent\\u2026'));
    var foot = el('div', 'foot', 'read-only \\u00b7 addresses redacted \\u00b7 not financial advice \\u00b7 dexterm.xyz');
    box.appendChild(head); box.appendChild(body); box.appendChild(foot);
    root.appendChild(box);
    boxes[s] = { body: body, age: age, sample: sample, stamp: stamp, conn: conn };
  });
  function header(b, v){
    b.sample.hidden = !v.sample;
    b.age.textContent = v.age;
    b.age.className = 'chip age' + (v.ageSec !== null && v.ageSec > 120 ? ' old' : '');
  }
  function clear(n){ while (n.firstChild) n.removeChild(n.firstChild); }
  function kv(k, v, extra){ var r = el('div', 'kv'); r.appendChild(el('span', 'k', k)); r.appendChild(el('span', 'v', v)); if (extra) r.appendChild(el('span', 'age', extra)); return r; }
  var render = {
    activity: function(b, v){
      clear(b.body);
      if (!v.rows.length) { b.body.appendChild(el('div', 'empty', 'no agent calls yet')); return; }
      v.rows.forEach(function(r){
        var row = el('div', 'row' + (r.ok ? '' : ' bad'));
        row.appendChild(el('span', 'when', r.when));
        row.appendChild(el('span', 'agent', r.agent));
        row.appendChild(el('span', 'tool', r.tool || r.phase));
        row.appendChild(el('span', 'sum', r.summary));
        row.appendChild(el('span', 'age', r.dataAge ? r.dataAge + ' old' : ''));
        b.body.appendChild(row);
      });
    },
    coin: function(b, v){
      clear(b.body);
      var c = v.coin;
      if (!c) { b.body.appendChild(el('div', 'empty', 'the agent has not opened a coin yet')); return; }
      var top = el('div', 'kv'); top.appendChild(el('span', 'sym', '$' + c.symbol)); top.appendChild(el('span', 'mint', c.mint)); b.body.appendChild(top);
      if (c.price) b.body.appendChild(kv('PRICE', c.price.text, c.price.age + ' old'));
      b.body.appendChild(c.verdict ? kv('VERDICT', c.verdict.label + (c.verdict.rug ? ' \\u00b7 rug heuristic ' + c.verdict.rug : ''), c.verdict.age + ' old') : kv('VERDICT', 'not run yet'));
      if (c.larp) {
        b.body.appendChild(kv('LARP', c.larp.flags + ' evidence flag' + (c.larp.flags === 1 ? '' : 's') + ' (evidence, not a verdict)', c.larp.age + ' old'));
        c.larp.items.slice(0, 3).forEach(function(i){ b.body.appendChild(el('div', 'small', '  \\u00b7 ' + i)); });
      } else b.body.appendChild(kv('LARP', 'not checked yet'));
      if (c.holders) {
        b.body.appendChild(kv('HOLDERS', c.holders.text, c.holders.age + ' old'));
        var bar = el('div', 'bar'); var f = el('div', 'fill'); f.style.width = Math.max(0, Math.min(100, c.holders.top10Pct)) + '%'; bar.appendChild(f); b.body.appendChild(bar);
        b.body.appendChild(el('div', 'small', c.holders.basis));
      } else b.body.appendChild(kv('HOLDERS', 'not read yet'));
      if (c.flags.length) {
        b.body.appendChild(el('div', 'k', 'LIVE SIGNALS'));
        c.flags.forEach(function(s){ b.body.appendChild(el('div', 'flag ' + s.level, '\\u25cf ' + s.title + ' \\u00b7 ' + s.text + ' \\u00b7 ' + s.source + ' \\u00b7 ' + s.age + ' old' + (s.stale ? ' (stale)' : ''))); });
      } else b.body.appendChild(kv('SIGNALS', 'none fired yet'));
    },
    pnl: function(b, v){
      clear(b.body);
      b.stamp.hidden = !v.stamp;
      if (v.stamp) { b.stamp.textContent = v.strip || (v.stamp === 'LIVE' ? 'LIVE' : 'PAPER \\u00b7 SIMULATED'); b.stamp.className = 'chip ' + (v.stamp === 'LIVE' ? 'live' : 'paper'); }
      if (!v.png) { b.body.appendChild(el('div', 'empty', v.note)); return; }
      var card = el('div', 'card');
      var img = new Image(v.w, v.h); img.alt = (v.stamp || '') + ' PnL card'; img.src = 'data:image/png;base64,' + v.png;
      card.appendChild(img);
      if (v.sample) card.appendChild(el('div', 'banner', 'SAMPLE DATA \\u00b7 REPLAY OF A SAVED SESSION'));
      b.body.appendChild(card);
      b.body.appendChild(el('div', 'small', v.note));
    }
  };
  var ws = new WebSocket(WS_URL);
  ws.onmessage = function(m){
    var msg; try { msg = JSON.parse(m.data); } catch (e) { return; }
    if (!msg || msg.type !== 'view' || !boxes[msg.scene] || !render[msg.scene]) return;
    var b = boxes[msg.scene];
    header(b, msg.view);
    render[msg.scene](b, msg.view);
  };
  ws.onclose = function(){ SCENES.forEach(function(s){ boxes[s].conn.hidden = false; boxes[s].conn.textContent = 'disconnected \\u00b7 run dexterm overlay for a fresh URL'; }); };
})();
`;

const htmlEscape = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

/** The full document for one scene page (or 'all'). Values substituted here are ours (theme tokens, ws url). */
export function renderOverlayPage(o: { page: OverlayPage; theme: OverlayThemeName; nonce: string; wsUrl: string }): string {
  const t: OverlayTheme = OVERLAY_THEMES[o.theme];
  const css = CSS.replace(/__([A-Z]+)__/g, (_m, k: string) => (t as unknown as Record<string, string>)[k.toLowerCase()] ?? '');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">`
    + `<meta name="dexterm-page" content="${htmlEscape(o.page)}"><meta name="dexterm-ws" content="${htmlEscape(o.wsUrl)}">`
    + `<title>dexterm overlay · ${htmlEscape(o.page)}</title><style nonce="${o.nonce}">${css}</style></head>`
    + `<body><main id="root"></main><script nonce="${o.nonce}">${JS}</script></body></html>`;
}
