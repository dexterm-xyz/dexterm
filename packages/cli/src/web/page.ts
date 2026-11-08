// dexterm — the Strategy Builder page (task-2170): one document, its CSS and JS (assets/web) inlined under the
// response's nonce. Values substituted here are ours (the CSRF token, the version); everything the app shows is built
// by web.js with textContent only.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let assets: { css: string; js: string } | null = null;
function load(): { css: string; js: string } {
  if (!assets) {
    const dir = fileURLToPath(new URL('../../assets/web/', import.meta.url));
    assets = { css: readFileSync(dir + 'web.css', 'utf8'), js: readFileSync(dir + 'web.js', 'utf8') };
  }
  return assets;
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
/** A <script>/<style> body must not close its own element. */
const inertBlock = (s: string): string => s.replace(/<\/(script|style)/gi, '<\\/$1');

export function renderWebPage(o: { nonce: string; csrf: string; version: string }): string {
  const a = load();
  const tab = (id: string, label: string, n = false): string => `<button class="tab" id="tab-${id}" type="button">${label}${n ? `<span class="n" id="n-${id}"></span>` : ''}</button>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<meta name="dexterm-csrf" content="${esc(o.csrf)}"><meta name="referrer" content="no-referrer">`
    + `<title>dexterm · strategy builder</title><style nonce="${o.nonce}">${inertBlock(a.css)}</style></head><body>`
    + `<div class="app">`
    + `<header class="top"><span class="brand">◆ dexterm<b>STRATEGY BUILDER</b></span><span class="chip paper">PAPER · SIMULATED</span>`
    + `<span class="chip">127.0.0.1 only</span><span class="chip" id="spect"><span class="dot"></span>…</span><span class="sp"></span>`
    + `<span class="chip">${esc(o.version ? `v${o.version}` : 'dexterm')}</span></header>`
    + `<nav class="tabs">${tab('strategies', 'Strategies', true)}${tab('builder', 'Builder')}${tab('factory', 'Factory')}${tab('chat', 'Chat')}</nav>`
    + `<main>`
    + `<section class="view sel" id="view-strategies"><div class="split"><div><div class="filter"><input type="text" id="sfilter" placeholder="filter strategies" spellcheck="false"></div><div class="list" id="slist"></div></div><div id="sdetail"></div></div></section>`
    + `<section class="view" id="view-builder"></section><section class="view" id="view-factory"></section><section class="view" id="view-chat"></section>`
    + `</main>`
    + `<footer><span>PAPER · SIMULATED. A strategy is a set of rules, not an edge; most generated candidates fail.</span><span>dexterm never holds a key and never signs or sends a transaction.</span><span>Not financial advice.</span></footer>`
    + `</div><div class="modal" id="modal"><div class="box" id="modal-box"></div></div><div class="toast" id="toast"></div>`
    + `<script nonce="${o.nonce}">${inertBlock(a.js)}</script></body></html>`;
}
