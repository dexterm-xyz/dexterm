// dexterm Strategy Builder (task-2170). Vanilla JS, no dependencies, no network beyond this loopback server.
// Every string from the server (strategy names, model text, token symbols, feed text) is UNTRUSTED: the DOM is built
// with textContent / createElement only. There is no innerHTML, no eval, no inline handler anywhere in this file.
(function () {
  'use strict';
  var CSRF = document.querySelector('meta[name="dexterm-csrf"]').getAttribute('content');
  var STAGES = ['draft', 'backtested', 'forward-tested', 'always-on'];
  var GEN_STAGES = ['candidate', 'backtested', 'queued-forward', 'forward-testing', 'forward-passed', 'retired'];
  var S = { tab: 'strategies', list: [], sel: null, detail: null, filter: '', factory: null, lessons: null, session: null, b: null, proposals: [], busy: false };

  // ───────────── helpers ─────────────
  function h(tag, a, kids) {
    var e = document.createElement(tag);
    a = a || {};
    if (a.cls) e.className = a.cls;
    if (a.text !== undefined && a.text !== null) e.textContent = String(a.text);
    if (a.attrs) Object.keys(a.attrs).forEach(function (k) { if (a.attrs[k] !== null && a.attrs[k] !== undefined && a.attrs[k] !== false) e.setAttribute(k, a.attrs[k] === true ? '' : String(a.attrs[k])); });
    if (a.on) Object.keys(a.on).forEach(function (k) { e.addEventListener(k, a.on[k]); });
    (kids || []).forEach(function (k) { if (k === null || k === undefined || k === false) return; e.appendChild(typeof k === 'string' || typeof k === 'number' ? document.createTextNode(String(k)) : k); });
    return e;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); return n; }
  function $(id) { return document.getElementById(id); }
  function api(path, body) {
    var o = { credentials: 'same-origin', headers: {} };
    if (body !== undefined) { o.method = 'POST'; o.headers['content-type'] = 'application/json'; o.headers['x-dexterm-csrf'] = CSRF; o.body = JSON.stringify(body); }
    return fetch(path, o).then(function (r) {
      if (r.status === 401) { toast('This session ended (a newer link was opened, or it timed out). Run `dexterm autotrade web` for a fresh link.', true); throw new Error('session'); }
      if (r.status === 429) { toast('Too many requests: wait a minute.', true); throw new Error('rate'); }
      return r.json();
    });
  }
  var toastT = null;
  function toast(msg, bad) { var t = $('toast'); t.textContent = String(msg); t.className = 'toast show' + (bad ? ' bad' : ''); clearTimeout(toastT); toastT = setTimeout(function () { t.className = 'toast'; }, 6500); }
  function num(x, suffix) { return x === null || x === undefined || x === '' ? '—' : String(x) + (suffix || ''); }
  function pct(x) { return x === null || x === undefined ? '—' : (x > 0 ? '+' : '') + x + '%'; }
  function range(lo, hi) { return lo === null || lo === undefined || hi === null || hi === undefined ? '—' : lo + '% to ' + hi + '%'; }
  function untag(s) { return String(s === null || s === undefined ? '' : s).replace(/<\/?untrusted[^>]*>/g, ''); }
  function chip(text, cls) { return h('span', { cls: 'chip ' + (cls || ''), text: text }); }
  function btn(text, onclick, cls, disabled, title) { return h('button', { cls: 'btn ' + (cls || ''), text: text, attrs: { type: 'button', disabled: !!disabled, title: title || null }, on: { click: onclick } }); }
  function panel(title, kids, extra) { return h('section', { cls: 'panel' }, [h('h2', {}, [title].concat(extra ? [h('span', { cls: 'sp' })].concat(extra) : []))].concat(kids)); }
  function sourceChip(r) { return r.source === 'generated' ? chip('GENERATED', 'gen') : r.source === 'preset' ? chip('PRESET', 'preset') : chip('YOURS', 'user'); }

  // ───────────── tabs ─────────────
  function setTab(t) {
    S.tab = t;
    ['strategies', 'builder', 'factory', 'chat'].forEach(function (x) { $('tab-' + x).className = 'tab' + (x === t ? ' sel' : ''); $('view-' + x).className = 'view' + (x === t ? ' sel' : ''); });
    if (t === 'factory') loadFactory();
    if (t === 'builder') renderBuilder();
    if (t === 'chat') setTimeout(function () { var l = $('chat-log'); l.scrollTop = l.scrollHeight; }, 0);
  }

  // ───────────── session / header ─────────────
  function loadSession() {
    return api('/api/session').then(function (s) {
      S.session = s;
      var sp = $('spect');
      clear(sp).appendChild(h('span', { cls: 'dot' + (s.spectator && s.spectator.live ? ' ok' : '') }));
      sp.appendChild(document.createTextNode(s.spectator && s.spectator.live ? 'spectator session running' : 'no spectator session'));
    }).catch(function () {});
  }

  // ───────────── strategies ─────────────
  function loadStrategies() {
    return api('/api/strategies').then(function (r) {
      S.list = r.strategies || [];
      $('n-strategies').textContent = String(S.list.length);
      if (!S.sel && S.list.length) S.sel = (S.list.find(function (x) { return x.source !== 'preset'; }) || S.list[0]).id;
      renderList();
      if (S.sel) loadDetail(S.sel);
    }).catch(function (e) { if (e.message !== 'session') toast('Could not read strategies: ' + e.message, true); });
  }
  function renderList() {
    var box = clear($('slist'));
    var f = S.filter.toLowerCase();
    var rows = S.list.filter(function (r) { return !f || (r.id + ' ' + untag(r.name)).toLowerCase().indexOf(f) >= 0; });
    if (!rows.length) box.appendChild(h('div', { cls: 'empty', text: 'no strategies match' }));
    rows.forEach(function (r) {
      var chips = [sourceChip(r)];
      if (r.source !== 'preset') chips.push(chip(r.generated ? r.generated.stage : r.stage));
      if (r.on === true) chips.push(chip('ALWAYS-ON: ON', 'on')); else if (r.on === false) chips.push(chip('ALWAYS-ON: OFF', 'off'));
      if (r.running) chips.push(chip('running: ' + r.running, 'live'));
      if (r.pendingProposals && r.pendingProposals.length) chips.push(chip(r.pendingProposals.length + ' proposal' + (r.pendingProposals.length > 1 ? 's' : ''), 'live'));
      box.appendChild(h('button', { cls: 'card' + (r.id === S.sel ? ' sel' : ''), attrs: { type: 'button' }, on: { click: function () { S.sel = r.id; renderList(); loadDetail(r.id); } } }, [
        h('div', { cls: 'row1' }, [h('span', { cls: 'nm', text: untag(r.name) })]),
        h('div', { cls: 'id', text: r.id + (r.lastBacktest ? ' · last backtest ' + r.lastBacktest : '') }),
        h('div', { cls: 'chips' }, chips),
      ]));
    });
  }
  function rowOf(id) { return S.list.find(function (x) { return x.id === id; }) || null; }
  function loadDetail(id) {
    var box = clear($('sdetail'));
    box.appendChild(h('div', { cls: 'empty', text: 'reading ' + id + '…' }));
    return api('/api/strategy?id=' + encodeURIComponent(id)).then(function (d) {
      if (S.sel !== id) return;
      S.detail = d;
      renderDetail();
    }).catch(function () {});
  }
  function ladder(journey, row) {
    var rungs = (journey && journey.rungs) || [];
    var stage = (journey && journey.stage) || (row && row.stage) || 'draft';
    var here = STAGES.indexOf(stage);
    return h('div', { cls: 'ladder' }, STAGES.map(function (s, i) {
      var r = rungs.find(function (x) { return x.stage === s; });
      var done = r ? r.ok : i < here;
      return h('span', { cls: 'rung' + (done ? ' done' : '') + (s === stage && !done ? ' here' : ''), text: s === 'always-on' ? 'always-on paper' : s, attrs: { title: r ? untag(r.detail) : null } });
    }));
  }
  function wordsList(w) {
    if (!w) return h('div', { cls: 'muted', text: 'this strategy does not validate, so it has no rules to show' });
    var items = [];
    function sect(k, lines) { items.push(h('li', { cls: 'k', text: k })); lines.forEach(function (l) { items.push(h('li', { text: l })); }); }
    sect('entry', w.entry); sect('sizing', w.sizing);
    w.exits.forEach(function (x) { sect('exits · ' + x.profile, x.lines.length ? x.lines : ['no exit ladder']); });
    sect('caps', w.caps);
    return h('ul', { cls: 'rules' }, items);
  }
  function numbersTable(r) {
    var n = (r && r.numbers) || {};
    var ev = r && r.evidence;
    var rows = [];
    function tr(label, cells, none) { rows.push(h('tr', { cls: none ? 'none' : '' }, [h('td', { cls: 'lbl', text: label })].concat(cells.map(function (c) { return h('td', { cls: 'num', text: c }); })))); }
    var ho = n.heldOut;
    tr('held-out test (generated)', ho ? [num(ho.n), pct(ho.meanPct), range(ho.lo, ho.hi), pct(ho.mean2xPct), pct(ho.noTop3Pct), num(ho.rugRatePct, '%')] : ['—', '—', '—', '—', '—', '—'], !ho);
    tr('factory evidence window', ev ? [num(ev.n), pct(ev.meanPct), range(ev.lo, ev.hi), pct(ev.mean2xPct), pct(ev.noTop3Pct), num(ev.rugRatePct, '%')] : ['—', '—', '—', '—', '—', '—'], !ev);
    var head = h('tr', {}, ['', 'entries', 'mean / entry', '95% range', 'at 2x costs', 'without top 3', 'rug rate'].map(function (x, i) { return h('th', { cls: i ? 'num' : '', text: x }); }));
    var t1 = h('table', {}, [h('thead', {}, [head]), h('tbody', {}, rows)]);
    var rows2 = [];
    function tr2(label, m, extra, none) { rows2.push(h('tr', { cls: none ? 'none' : '' }, [h('td', { cls: 'lbl', text: label }), h('td', { cls: 'num', text: m ? num(m.trades) : '—' }), h('td', { cls: 'num', text: m ? pct(m.netPct) : '—' }), h('td', { cls: 'num', text: m ? num(m.winRatePct, '%') : '—' }), h('td', { cls: 'num', text: m ? num(m.rugRatePct, '%') : '—' }), h('td', { text: extra || '' })])); }
    var bt = n.backtest;
    tr2('backtest (full)', bt && bt.full, bt ? bt.days + ' d · ' + untag(bt.verdict) : '', !bt);
    tr2('backtest held-out half', bt && bt.heldOutHalf, '', !bt);
    tr2('paper forward test', n.forward, n.forward ? n.forward.state : '', !n.forward);
    var lp = n.livePaper;
    rows2.push(h('tr', { cls: lp ? '' : 'none' }, [h('td', { cls: 'lbl', text: 'running paper account' }), h('td', { cls: 'num', text: lp ? num(lp.closed) : '—' }), h('td', { cls: 'num', text: lp ? pct(lp.pnlPct) : '—' }), h('td', { cls: 'num', text: lp ? num(lp.winRatePct, '%') : '—' }), h('td', { cls: 'num', text: '—' }), h('td', { text: lp ? lp.state + ' · ' + lp.open + ' open' : '' })]));
    var head2 = h('tr', {}, ['', 'trades', 'net', 'win rate', 'rug rate', ''].map(function (x, i) { return h('th', { cls: i && i < 5 ? 'num' : '', text: x }); }));
    var t2 = h('table', {}, [h('thead', {}, [head2]), h('tbody', {}, rows2)]);
    return [h('div', { cls: 'tablewrap' }, [t1]), h('h3', { text: 'backtest · forward · paper account' }), h('div', { cls: 'tablewrap' }, [t2]),
      h('div', { cls: 'sub', text: 'PAPER · SIMULATED. Every number is copied from dexterm\'s own stats; a dash means there is none. Different windows and samples: never rank on one column, and small samples mean nothing.' })];
  }
  function cookPanel(v, id) {
    var kids = [];
    kids.push(h('div', { cls: 'sub', text: v.source + ' · ' + v.age }));
    var e = v.equity;
    kids.push(h('div', { cls: 'small', text: 'paper equity: ' + (e.startUsd !== null ? 'start $' + e.startUsd : 'no book yet') + (e.endUsd !== null ? ' · now $' + e.endUsd : '') + (e.netUsd !== null ? ' · net $' + e.netUsd : '') + ' · ' + e.entries + ' entries · ' + e.closed + ' closed · ' + e.open + ' open' }));
    kids.push(h('h3', { text: 'bags' }));
    if (!v.bags.length) kids.push(h('div', { cls: 'muted small', text: 'no paper bags yet' }));
    v.bags.forEach(function (b) { kids.push(h('div', { cls: 'bag' }, [h('span', { cls: 'st ' + b.state, text: b.state }), h('span', { text: (b.symbol ? '$' + b.symbol + ' ' : '') + b.mint }), h('span', { cls: 'muted', text: b.costUsd !== null ? 'cost $' + b.costUsd : '' }), h('span', { cls: b.pnlPct === null ? 'muted' : b.pnlPct >= 0 ? 'upline' : 'downline', text: b.pnlPct === null ? (b.state === 'HELD' ? 'open' : '') : pct(b.pnlPct) })])); });
    if (v.rungs.length) { kids.push(h('h3', { text: 'ladder rungs hit' })); kids.push(h('div', { cls: 'rungset' }, v.rungs.map(function (r) { return chip((r.hits ? '● ' : '○ ') + r.label + (r.hits ? ' ×' + r.hits : ''), r.hits ? 'hit' : ''); }))); }
    kids.push(h('h3', { text: 'entries and exits' }));
    if (!v.events.length) kids.push(h('div', { cls: 'muted small', text: 'no paper fills yet' }));
    v.events.slice(0, 8).forEach(function (f) { kids.push(h('div', { cls: 'ev', text: f.when + '  ' + (f.side === 'buy' ? 'ENTRY' : 'EXIT ') + '  ' + (f.symbol ? '$' + f.symbol + ' ' : '') + f.mint + (f.usd !== null ? '  $' + f.usd : '') + '  ' + f.reason })); });
    kids.push(h('div', { cls: 'btns' }, [btn('Watch it cook', function () { watch(id); }, 'cook sm')]));
    return panel('cooking now', [h('div', { cls: 'cook' }, kids)], [chip('PAPER', 'paper')]);
  }
  function renderDetail() {
    var d = S.detail; var r = rowOf(d.id) || {};
    var box = clear($('sdetail'));
    var raw = d.raw || {};
    var chips = [sourceChip(r), chip('paper', 'paper')];
    if (r.on === true) chips.push(chip('ALWAYS-ON: ON', 'on')); else if (r.on === false) chips.push(chip('ALWAYS-ON: OFF', 'off'));
    if (r.running) chips.push(chip('running: ' + r.running, 'live'));
    if (!d.valid) chips.push(chip('does not validate', 'bad'));
    var fw = d.forward && d.forward.test ? d.forward.test : null;
    var fwRunning = d.journey && d.journey.forward && /running|starting/.test(String(d.journey.forward.state || ''));
    var actions = [
      btn('Watch it cook', function () { watch(d.id); }, 'cook'),
      btn('Edit in Builder', function () { openBuilder(d.id); }),
      btn('Backtest 7 d', function () { backtest(d.id); }, '', r.source === 'preset' && false),
      fwRunning ? btn('Stop forward test', function () { forwardStop(d.id); }, 'danger') : btn('Start paper forward test', function () { forwardStart(d.id); }),
    ];
    if (r.on !== null && r.on !== undefined) actions.push(btn(r.on ? 'Turn off (paper)' : 'Turn on (paper)', function () { change(r.on ? 'off' : 'on', d.id); }));
    if (r.generated && r.generated.stage !== 'retired') actions.push(btn('Retire', function () { change('retire', d.id); }, 'danger'));
    box.appendChild(h('section', { cls: 'panel' }, [
      h('div', { cls: 'title', text: untag(raw.name || r.name || d.id) }),
      h('div', { cls: 'sub', text: d.id + (raw.version ? ' · v' + raw.version : '') + (d.doc && d.doc.hash ? ' · ' + d.doc.hash : '') }),
      h('div', { cls: 'chips', attrs: {} }, chips),
      ladder(d.journey, r),
      d.journey && d.journey.next ? h('div', { cls: 'sub', text: 'next: ' + untag(d.journey.next.stage) + ' · ' + untag(d.journey.next.how) }) : null,
      raw.description ? h('div', { cls: 'small', text: untag(raw.description) }) : null,
      h('div', { cls: 'btns' }, actions),
    ]));
    if (r.generated) {
      var g = r.generated;
      box.appendChild(panel('generated by the strategy factory', [
        h('div', { cls: 'warnline small', text: 'GENERATED · PAPER · SIMULATED. A candidate, not an edge: most generated strategies fail their tests.' }),
        h('h3', { text: 'parents' }), h('div', { text: (g.parents || []).join(', ') || '—' }),
        g.summary ? h('h3', { text: 'why it was made (model text)' }) : null, g.summary ? h('div', { text: g.summary }) : null,
        g.expectedFailure ? h('h3', { text: 'what it is expected to fail on' }) : null, g.expectedFailure ? h('div', { text: g.expectedFailure }) : null,
        g.retired ? h('div', { cls: 'downline small', text: 'retired: ' + (g.retired.why || '') }) : null,
      ]));
    }
    box.appendChild(panel('numbers', numbersTable(r), [chip('PAPER · SIMULATED', 'paper')]));
    box.appendChild(h('div', { cls: 'cols2' }, [
      h('div', {}, [panel('rules in plain words', [wordsList(d.words)])]),
      h('div', {}, [d.cook ? cookPanel(d.cook, d.id) : null]),
    ]));
    if (d.pending && d.pending.length) box.appendChild(panel('proposals waiting for you', d.pending.map(proposalCard)));
  }

  // ───────────── proposals ─────────────
  function proposalCard(p) {
    var risk = p.riskDelta || '';
    var kids = [
      h('div', { cls: 'small' }, [h('b', { text: p.id + ' · ' }), h('span', { cls: 'risk ' + risk, text: risk.toUpperCase() }), h('span', { cls: 'muted', text: ' · ' + p.proposalId })]),
      h('div', { cls: 'small muted', text: untag(p.why) }),
      h('pre', { cls: 'mono-pre diff', text: (p.diff || []).join('\n') || '(no change)' }),
    ];
    if (p.validation && !p.validation.ok) kids.push(h('ul', { cls: 'issues' }, (p.validation.errors || []).map(function (e) { return h('li', { cls: 'err', text: e.path + ' ' + e.msg }); })));
    var bs = [risk === 'looser' ? btn('Apply…', function () { lessSafe(p); }, 'primary') : btn('Apply', function () { apply(p, 'apply'); }, 'primary'), btn('Dismiss', function () { dismiss(p); }, 'ghost')];
    kids.push(h('div', { cls: 'btns' }, bs));
    if (risk === 'looser') kids.push(h('div', { cls: 'warnline small', text: 'This edit is LOOSER (less safe): Apply opens a second, explicit step, like the Q screen\'s less-safe popup.' }));
    return h('div', { cls: 'panel' }, kids);
  }
  function lessSafe(p) {
    openModal('less safe · ' + p.id, [h('div', { cls: 'warnline', text: 'This edit makes ' + p.id + ' LOOSER. Every less-safe change:' }), h('pre', { cls: 'mono-pre diff', text: (p.diff || []).join('\n') }),
      h('div', { cls: 'sub', text: 'Paper only. It is re-checked from scratch when applied; nothing else changes.' }),
      h('div', { cls: 'btns' }, [btn('Apply anyway (less safe)', function () { closeModal(); apply(p, 'apply-looser'); }, 'danger')])]);
  }
  function apply(p, how) {
    api('/api/proposals/apply', { proposalId: p.proposalId, confirm: how }).then(function (r) { toast(r.message || JSON.stringify(r), !r.ok); refreshAll(); }).catch(function () {});
  }
  function dismiss(p) { api('/api/proposals/dismiss', { proposalId: p.proposalId }).then(function (r) { toast(r.message, !r.ok); refreshAll(); }).catch(function () {}); }
  function refreshAll() { loadStrategies(); if (S.tab === 'builder') loadProposals(); if (S.tab === 'factory') loadFactory(); }

  // ───────────── paper actions ─────────────
  function backtest(id) {
    toast('backtesting ' + id + ' on recorded history (paper, up to 7 days)…');
    api('/api/backtest', { id: id, days: 7 }).then(function (r) {
      if (r.error) { toast(r.error, true); return; }
      openModal('backtest · ' + id, [h('pre', { cls: 'mono-pre', text: summarize(r) })]);
      loadStrategies();
    }).catch(function () {});
  }
  function forwardStart(id) {
    api('/api/forward/start', { id: id, hours: 24 }).then(function (r) { toast(r.error || r.note || r.message || 'forward test started (paper, 24 h or its trade count, the strategy\'s own paper bankroll)', !!r.error); loadStrategies(); }).catch(function () {});
  }
  function forwardStop(id) { api('/api/forward/stop', { id: id }).then(function (r) { toast(r.error || r.note || 'stop requested', !!r.error); loadStrategies(); }).catch(function () {}); }
  function summarize(o) {
    var out = [];
    (function walk(x, pre, depth) {
      if (depth > 3 || out.length > 80) return;
      if (x === null || typeof x !== 'object') { out.push(pre + String(x)); return; }
      Object.keys(x).forEach(function (k) { var v = x[k]; if (v !== null && typeof v === 'object' && !Array.isArray(v)) { out.push(pre + k + ':'); walk(v, pre + '  ', depth + 1); } else out.push(pre + k + ': ' + (Array.isArray(v) ? v.map(function (y) { return typeof y === 'object' ? JSON.stringify(y) : y; }).join(' · ') : untag(v))); });
    })(o, '', 0);
    return out.join('\n');
  }

  // ───────────── preview → confirm (on / off / retire / factory) ─────────────
  function change(action, id) {
    api('/api/change/preview', id ? { action: action, id: id } : { action: action }).then(function (r) {
      if (!r.ok) { toast(r.why, true); return; }
      var res = h('div', { cls: 'small' });
      var bConfirm = btn('Confirm', function () { bConfirm.disabled = true; bCancel.disabled = true; api('/api/change/confirm', { code: r.code }).then(function (x) { res.textContent = (x.ok ? 'Done: ' : 'Not applied: ') + x.text; res.className = 'small ' + (x.ok ? 'upline' : 'downline'); refreshAll(); }); }, 'primary');
      var bCancel = btn('Cancel', function () { bConfirm.disabled = true; bCancel.disabled = true; api('/api/change/cancel', { code: r.code }).then(function (x) { res.textContent = x.text; res.className = 'small muted'; }); }, 'ghost');
      openModal('confirm a paper change · ' + r.code, [h('div', { text: r.preview }), h('div', { cls: 'btns' }, [bConfirm, bCancel]), res, h('div', { cls: 'sub', text: 'Nothing has changed yet. Confirm applies exactly this, re-checked now; Cancel leaves everything as it is.' })]);
    }).catch(function () {});
  }

  // ───────────── watch it cook ─────────────
  function watch(id) {
    openModal('watch it cook · ' + id, [h('div', { cls: 'muted', text: 'opening a dexterm window…' })]);
    api('/api/watch', { id: id }).then(function (r) {
      var kids = [];
      if (r.launched) kids.push(h('div', { cls: 'upline', text: 'Opened a new window (' + r.via + ') running dexterm in watch-it-cook mode on ' + id + ', with the strategy overlay. It is read-only: it observes the paper run and cannot arm, size, sign, send or change a cap.' }));
      else kids.push(h('div', { cls: 'warnline', text: (r.why || 'Could not open a terminal window') + '. Run this in a terminal:' }));
      if (r.spectator) kids.push(h('div', { cls: 'sub', text: r.spectator }));
      if (r.command) {
        var code = h('code', { text: r.command });
        kids.push(h('div', { cls: 'cmd' }, [code, btn('Copy', function () { if (navigator.clipboard) navigator.clipboard.writeText(r.command).then(function () { toast('copied'); }, function () { toast('copy failed: select the text', true); }); }, 'sm')]));
      }
      openModal('watch it cook · ' + id, kids);
    }).catch(function () {});
  }

  // ───────────── modal ─────────────
  function openModal(title, kids) {
    var m = $('modal'); var b = clear($('modal-box'));
    b.appendChild(h('h2', { text: title }));
    kids.forEach(function (k) { if (k) b.appendChild(k); });
    b.appendChild(h('div', { cls: 'btns' }, [btn('Close', closeModal, 'ghost')]));
    m.className = 'modal open';
  }
  function closeModal() { $('modal').className = 'modal'; }

  // ───────────── builder ─────────────
  function openBuilder(id) { setTab('builder'); loadBuilder(id); }
  function deep(x) { return JSON.parse(JSON.stringify(x === undefined ? null : x)); }
  function loadBuilder(id) {
    api('/api/strategy?id=' + encodeURIComponent(id)).then(function (d) {
      var mine = d.source === 'user' && !(rowOf(id) || {}).generated;
      S.b = { base: d, id: id, kind: mine ? 'edit' : 'new', newId: mine ? '' : (id + '-v2').slice(0, 32), newName: mine ? '' : untag((d.raw && d.raw.name) || id) + ' (mine)', doc: deep(d.raw), profiles: deep(d.profiles || {}), check: null, proposal: null };
      renderBuilder(); scheduleCheck();
    }).catch(function () {});
  }
  function getPath(o, p) { return p.split('/').slice(1).reduce(function (a, k) { return a === null || a === undefined ? undefined : a[k]; }, o); }
  function setPath(o, p, v) { var ks = p.split('/').slice(1); var last = ks.pop(); var t = ks.reduce(function (a, k) { if (a[k] === null || typeof a[k] !== 'object') a[k] = {}; return a[k]; }, o); t[last] = v; }
  var FIELDS = [
    { sect: 'entry gates', path: '/entry/screen', label: 'screen (the screener filter)', type: 'text', full: true },
    { sect: 'entry gates', path: '/entry/ageHours/min', label: 'pool age from (h)', type: 'num' },
    { sect: 'entry gates', path: '/entry/ageHours/max', label: 'pool age to (h, empty = no limit)', type: 'num', nullable: true },
    { sect: 'entry gates', path: '/entry/safety/maxTop10Pct', label: 'top 10 holders at most (%)', type: 'num', nullable: true },
    { sect: 'entry gates', path: '/entry/safety/maxDevPct', label: 'dev holds at most (%)', type: 'num', nullable: true },
    { sect: 'entry gates', path: '/entry/safety/requireNoMintAuthority', label: 'no mint authority', type: 'bool' },
    { sect: 'entry gates', path: '/entry/safety/requireNoFreezeAuthority', label: 'no freeze authority', type: 'bool' },
    { sect: 'entry gates', path: '/entry/triggerMode', label: 'triggers', type: 'select', options: ['any', 'all'] },
    { sect: 'sizing', path: '/sizing/mode', label: 'size mode', type: 'select', options: ['fixed', 'pct', 'risk', 'confidence'] },
    { sect: 'sizing', path: '/sizing/fixedUsd', label: 'fixed size ($, fixed mode)', type: 'num', optional: true },
    { sect: 'sizing', path: '/sizing/pct', label: 'size (% of paper book, pct mode)', type: 'num', optional: true },
    { sect: 'sizing', path: '/sizing/minUsd', label: 'smallest trade ($)', type: 'num' },
    { sect: 'sizing', path: '/sizing/maxUsd', label: 'largest trade ($)', type: 'num' },
    { sect: 'sizing', path: '/sizing/maxPctOfBankroll', label: 'at most (% of paper book)', type: 'num' },
    { sect: 'caps', path: '/risk/maxConcurrent', label: 'open at once', type: 'num' },
    { sect: 'caps', path: '/risk/maxEntriesPerDay', label: 'entries a day', type: 'num' },
    { sect: 'caps', path: '/risk/perCoin/maxEntries', label: 'entries per coin', type: 'num' },
    { sect: 'caps', path: '/risk/maxExposurePct', label: 'exposure at most (%)', type: 'num' },
    { sect: 'caps', path: '/risk/dailyLossHaltPct', label: 'daily loss halt (%)', type: 'num' },
  ];
  function fieldInput(f) {
    var b = S.b; var v = getPath(b.doc, f.path);
    var onChange = function (e) {
      var t = e.target; var val;
      if (f.type === 'bool') val = t.checked;
      else if (f.type === 'num') { val = t.value.trim() === '' ? (f.nullable ? null : undefined) : Number(t.value); if (val !== undefined && val !== null && !isFinite(val)) val = undefined; }
      else val = t.value;
      if (val === undefined) { if (f.optional) { var ks = f.path.split('/'); var k = ks.pop(); var par = getPath(b.doc, ks.join('/')); if (par) delete par[k]; } } else setPath(b.doc, f.path, val);
      scheduleCheck();
    };
    if (f.type === 'bool') return h('label', { cls: 'f check' + (f.full ? ' full' : '') }, [h('input', { attrs: { type: 'checkbox', checked: !!v }, on: { change: onChange } }), f.label]);
    var input;
    if (f.type === 'select') input = h('select', { on: { change: onChange } }, f.options.map(function (o) { return h('option', { text: o, attrs: { value: o, selected: o === v } }); }));
    else input = h('input', { attrs: { type: f.type === 'num' ? 'number' : 'text', value: v === null || v === undefined ? '' : String(v), step: 'any', spellcheck: 'false' }, on: { input: onChange } });
    return h('label', { cls: 'f' + (f.full ? ' full' : '') }, [f.label, input]);
  }
  function profileEditor(i) {
    var b = S.b; var refs = b.doc.exits.profiles; var ref = refs[i];
    var pid = typeof ref === 'string' ? ref.replace(/^builtin:/, '') : ref.id;
    var p = b.profiles[pid] || (typeof ref === 'object' ? ref : null);
    if (!p) return h('div', { cls: 'muted', text: 'profile ' + pid + ' is not readable' });
    if (!b.edit) b.edit = {};
    if (!b.edit[i]) b.edit[i] = deep({ tpLadder: p.tpLadder || [], bagTrail: p.bagTrail || null, trailingStop: p.trailingStop || null, hardStop: p.hardStop, timeStop: p.timeStop || null });
    var e = b.edit[i];
    var byCap = e.tpLadder.length > 0 && e.tpLadder[0].atMcapUsd !== undefined;
    var rows = h('div', { cls: 'rungs' });
    function redraw() { var n = profileEditor(i); var old = $('prof-' + i); old.parentNode.replaceChild(n, old); scheduleCheck(); }
    e.tpLadder.forEach(function (t, k) {
      var lvl = h('input', { attrs: { type: 'number', step: 'any', value: String(byCap ? t.atMcapUsd : t.atPct), title: byCap ? 'market cap in $' : 'gain over entry in %' }, on: { input: function (ev) { var x = Number(ev.target.value); if (byCap) t.atMcapUsd = x; else t.atPct = x; scheduleCheck(); } } });
      var frac = h('input', { attrs: { type: 'number', step: 'any', value: String(Math.round(t.sellFrac * 1000) / 10), title: 'sell this % of the bag' }, on: { input: function (ev) { t.sellFrac = Number(ev.target.value) / 100; moon.textContent = moonText(); scheduleCheck(); } } });
      rows.appendChild(h('div', { cls: 'rungrow' }, [h('span', { cls: 'ix', text: 'TP' + (k + 1) }), h('label', { cls: 'f' }, [byCap ? 'at market cap ($)' : 'at gain (%)', lvl]), h('label', { cls: 'f' }, ['sell (% of bag)', frac]), btn('×', function () { e.tpLadder.splice(k, 1); redraw(); }, 'sm ghost', false, 'remove this rung')]));
    });
    function moonText() { var sold = e.tpLadder.reduce(function (s, t) { return s + (Number(t.sellFrac) || 0); }, 0); var m = Math.round((1 - sold) * 1000) / 10; return m > 0 ? 'moonbag: ' + m + '% of the bag rides after the ladder' + (e.bagTrail ? ', trailed ' + e.bagTrail.trailPct + '% off its peak' : '') : (m < 0 ? 'the ladder sells more than the whole bag (' + Math.round(sold * 1000) / 10 + '%)' : 'no moonbag: the ladder sells the whole bag'); }
    var moon = h('div', { cls: 'moon', text: moonText() });
    var kind = h('select', { on: { change: function (ev) { var cap = ev.target.value === 'cap'; e.tpLadder = e.tpLadder.map(function (t, k) { return cap ? { atMcapUsd: (k + 1) * 100000, sellFrac: t.sellFrac } : { atPct: (k + 1) * 50, sellFrac: t.sellFrac }; }); redraw(); } } }, [h('option', { text: 'gain over entry (%)', attrs: { value: 'pct', selected: !byCap } }), h('option', { text: 'market cap ($)', attrs: { value: 'cap', selected: byCap } })]);
    var add = btn('+ rung', function () { var last = e.tpLadder[e.tpLadder.length - 1]; e.tpLadder.push(byCap ? { atMcapUsd: last ? last.atMcapUsd * 2 : 100000, sellFrac: 0.1 } : { atPct: last ? last.atPct * 2 : 50, sellFrac: 0.1 }); redraw(); }, 'sm', e.tpLadder.length >= (byCap ? 10 : 6));
    function optNum(label, get, set) { return h('label', { cls: 'f' }, [label, h('input', { attrs: { type: 'number', step: 'any', value: get() === null || get() === undefined ? '' : String(get()) }, on: { input: function (ev) { set(ev.target.value.trim() === '' ? null : Number(ev.target.value)); moon.textContent = moonText(); scheduleCheck(); } } })]); }
    var extra = h('div', { cls: 'form' }, [
      optNum('moonbag trail (% off peak)', function () { return e.bagTrail ? e.bagTrail.trailPct : null; }, function (x) { e.bagTrail = x === null ? null : Object.assign({}, e.bagTrail || {}, { trailPct: x }); }),
      optNum('hard stop (%, e.g. -25)', function () { return e.hardStop && e.hardStop.enabled ? e.hardStop.atPct : null; }, function (x) { e.hardStop = Object.assign({}, e.hardStop, { enabled: x !== null, atPct: x }); }),
      optNum('trailing stop arms at (+%)', function () { return e.trailingStop ? e.trailingStop.armAtPct : null; }, function (x) { e.trailingStop = x === null ? null : Object.assign({ trailPct: 20 }, e.trailingStop || {}, { armAtPct: x }); }),
      optNum('trailing stop trails (%)', function () { return e.trailingStop ? e.trailingStop.trailPct : null; }, function (x) { if (x === null) e.trailingStop = null; else e.trailingStop = Object.assign({ armAtPct: 30 }, e.trailingStop || {}, { trailPct: x }); }),
      optNum('time stop after (min)', function () { return e.timeStop ? e.timeStop.minutes : null; }, function (x) { e.timeStop = x === null ? null : Object.assign({ ifBelowPct: 0, action: 'exit' }, e.timeStop || {}, { minutes: x }); }),
    ]);
    return h('div', { cls: 'panel', attrs: { id: 'prof-' + i } }, [h('h2', {}, ['exit ladder · ' + pid, h('span', { cls: 'sp' }), kind, add]), rows, moon, extra]);
  }
  function computeOps() {
    var b = S.b; var base = b.base.raw; var ops = [];
    FIELDS.forEach(function (f) {
      var a = getPath(base, f.path), v = getPath(b.doc, f.path);
      if (JSON.stringify(a) === JSON.stringify(v)) return;
      if (v === undefined) ops.push({ op: 'remove', path: f.path }); else ops.push({ op: a === undefined ? 'add' : 'replace', path: f.path, value: v });
    });
    Object.keys(b.edit || {}).forEach(function (i) {
      var ref = base.exits.profiles[i]; var pid = typeof ref === 'string' ? ref.replace(/^builtin:/, '') : ref.id;
      var p = b.base.profiles[pid] || {}; var e = b.edit[i];
      ['tpLadder', 'bagTrail', 'trailingStop', 'hardStop', 'timeStop'].forEach(function (k) {
        var was = p[k] === undefined ? null : p[k];
        if (JSON.stringify(was) === JSON.stringify(e[k])) return;
        ops.push({ op: p[k] === undefined ? 'add' : 'replace', path: '/exits/profiles/' + i + '/' + k, value: e[k] });
      });
    });
    return ops;
  }
  var checkT = null;
  function scheduleCheck() { clearTimeout(checkT); checkT = setTimeout(runCheck, 350); }
  function input() { var b = S.b; return b.kind === 'new' ? { kind: 'new', id: b.newId, from: b.id, name: b.newName, ops: computeOps() } : { kind: 'edit', id: b.id, ops: computeOps() }; }
  function runCheck() {
    if (!S.b) return;
    var inp = input();
    var box = $('b-check'); if (!box) return;
    if (inp.kind === 'edit' && !inp.ops.length) { renderCheck({ ok: null }); return; }
    api('/api/strategies/check', inp).then(function (r) { S.b.check = r; renderCheck(r); }).catch(function () {});
  }
  function renderCheck(r) {
    var box = $('b-check'); if (!box) return; clear(box);
    var n = S.b ? computeOps().length : 0;
    if (r.ok === null) { box.appendChild(h('div', { cls: 'muted', text: 'no changes yet: edit a field and the check runs here' })); return; }
    var items = [];
    if (r.ok) items.push(h('li', { cls: 'ok', text: 'valid · ' + n + ' change' + (n === 1 ? '' : 's') + ' · ' })), items[0].appendChild(h('span', { cls: 'risk ' + r.riskDelta, text: String(r.riskDelta || '').toUpperCase() }));
    (r.errors || []).forEach(function (e) { items.push(h('li', { cls: 'err', text: (e.path || '') + ' ' + e.msg })); });
    (r.warnings || []).forEach(function (e) { items.push(h('li', { cls: 'warn', text: (e.path || '') + ' ' + e.msg })); });
    (r.reasons || []).forEach(function (x) { items.push(h('li', { cls: x.dir === 'looser' ? 'warn' : 'ok', text: (x.dir || '') + ': ' + (x.path || '') + ' ' + (x.from !== undefined ? x.from + ' → ' + x.to : '') })); });
    box.appendChild(h('ul', { cls: 'issues' }, items));
    if (r.diff && r.diff.length) box.appendChild(h('pre', { cls: 'mono-pre diff', text: r.diff.join('\n') }));
    $('b-propose').disabled = !r.ok;
  }
  function propose() {
    var inp = input(); inp.why = ($('b-why').value || '').trim() || 'edited in the web Strategy Builder';
    api('/api/strategies/propose', inp).then(function (r) {
      if (r.error || r.ok === false) { toast(r.error || (r.errors || []).map(function (e) { return e.path + ' ' + e.msg; }).join('; ') || 'not proposed', true); return; }
      toast('proposal ' + (r.proposalId || '') + ' written: review it below and Apply (nothing changed yet)');
      loadProposals(); loadStrategies();
    }).catch(function () {});
  }
  function loadProposals() { api('/api/proposals').then(function (r) { S.proposals = r.pending || []; var box = $('b-proposals'); if (!box) return; clear(box); if (!S.proposals.length) box.appendChild(h('div', { cls: 'muted', text: 'no proposals waiting' })); S.proposals.forEach(function (p) { box.appendChild(proposalCard(p)); }); }).catch(function () {}); }
  function renderBuilder() {
    var root = clear($('view-builder'));
    var pick = h('select', { on: { change: function (e) { loadBuilder(e.target.value); } } }, [h('option', { text: 'choose a strategy to start from…', attrs: { value: '' } })].concat(S.list.map(function (r) { return h('option', { text: r.id + ' · ' + untag(r.name) + ' (' + r.source + ')', attrs: { value: r.id, selected: S.b && S.b.id === r.id } }); })));
    var head = panel('strategy builder', [
      h('div', { cls: 'form' }, [h('label', { cls: 'f full' }, ['start from', pick])]),
      h('div', { cls: 'sub', text: 'Editing makes a PROPOSAL (the same files the Q screen applies): nothing is overwritten until you press Apply. Presets and generated strategies are copied into a new strategy of yours. Mode stays paper; the paper book, the daily Claude budget and real mode are not editable here; a looser edit (wider caps, for example) asks twice before it applies.' }),
    ], [chip('PAPER', 'paper')]);
    root.appendChild(head);
    if (!S.b) { root.appendChild(h('div', { cls: 'empty', text: 'pick a strategy above (or "Edit in Builder" on the Strategies tab)' })); return; }
    var b = S.b;
    var who = b.kind === 'new'
      ? h('div', { cls: 'form' }, [
        h('label', { cls: 'f' }, ['new strategy id', h('input', { attrs: { type: 'text', value: b.newId, spellcheck: 'false' }, on: { input: function (e) { b.newId = e.target.value.trim(); scheduleCheck(); } } })]),
        h('label', { cls: 'f' }, ['name', h('input', { attrs: { type: 'text', value: b.newName }, on: { input: function (e) { b.newName = e.target.value; scheduleCheck(); } } })]),
      ])
      : h('div', { cls: 'sub', text: 'editing your strategy ' + b.id + ' (a new version once applied)' });
    var sects = {};
    FIELDS.forEach(function (f) { (sects[f.sect] = sects[f.sect] || []).push(fieldInput(f)); });
    var left = h('div', {}, [panel('what', [who]), panel('entry gates', [h('div', { cls: 'form' }, sects['entry gates'])]), panel('sizing', [h('div', { cls: 'form' }, sects['sizing'])]), panel('caps', [h('div', { cls: 'form' }, sects['caps'])])]);
    var right = h('div', {}, (b.doc.exits.profiles || []).map(function (_r, i) { return profileEditor(i); }).concat([
      panel('live check', [h('div', { attrs: { id: 'b-check' } }), h('label', { cls: 'f' }, ['why (goes into the proposal and the journal)', h('input', { attrs: { type: 'text', id: 'b-why', maxlength: '200', placeholder: 'e.g. tighter top-10 gate, market-cap ladder' } })]),
        h('div', { cls: 'btns' }, [h('button', { cls: 'btn primary', text: 'Create proposal', attrs: { type: 'button', id: 'b-propose', disabled: true }, on: { click: propose } }),
          b.kind === 'edit' ? btn('Backtest current version', function () { backtest(b.id); }) : null,
          b.kind === 'edit' ? btn('Start paper forward test', function () { forwardStart(b.id); }) : null,
          btn('Watch it cook', function () { watch(b.id); }, 'cook')])]),
    ]));
    root.appendChild(h('div', { cls: 'cols2' }, [left, right]));
    root.appendChild(panel('proposals waiting for you', [h('div', { attrs: { id: 'b-proposals' } })]));
    renderCheck({ ok: null }); loadProposals();
    if (b.kind === 'new') scheduleCheck();
  }

  // ───────────── factory ─────────────
  function loadFactory() {
    api('/api/factory').then(function (f) { S.factory = f; renderFactory(); }).catch(function () {});
  }
  function inUse(s) { var m = /^([\d.]+) of ([\d.]+)/.exec(String(s || '')); return m ? { a: Number(m[1]), b: Number(m[2]) } : null; }
  function renderFactory() {
    var f = S.factory; var st = f.status || {}; var root = clear($('view-factory'));
    if (f.stopFile) root.appendChild(h('div', { cls: 'banner' }, [h('b', { text: 'STOPPED · FACTORY-STOP  ' }), 'by ' + (f.stopFile.by || '?') + ' at ' + (f.stopFile.at || '?') + (f.stopFile.why ? ': ' + f.stopFile.why : '') + '. This is your own switch: the web UI shows it and cannot remove it. Run `dexterm autotrade factory resume` in your terminal to lift it.']));
    if (f.agentPause) root.appendChild(h('div', { cls: 'banner pause' }, [h('b', { text: 'PAUSED  ' }), 'pause marker by ' + (f.agentPause.by || '?') + (f.agentPause.why ? ': ' + f.agentPause.why : '') + '. Resume lifts it.']));
    var lr = st.lastRun || {};
    var stats = [
      h('div', { cls: 'stat' }, [h('div', { cls: 'k', text: 'last run' }), h('div', { cls: 'v', text: lr.at || 'never' }), h('div', { cls: 'sub', text: untag(lr.verdict || lr.stop || '') })]),
      h('div', { cls: 'stat' }, [h('div', { cls: 'k', text: 'schedule' }), h('div', { cls: 'v', text: st.schedule && st.schedule.next ? 'next ' + st.schedule.next : st.schedule && st.schedule.installed ? 'installed' : 'not installed' }), h('div', { cls: 'sub', text: st.caps ? 'every ' + st.caps.intervalHours + ' h at ' + st.caps.at : '' })]),
    ];
    var iu = st.inUse || {};
    [['Claude calls today', iu.claudeCallsToday], ['Claude $ today', iu.claudeUsdToday], ['active candidates', iu.activeGenerated], ['forward tests', iu.forwardTests], ['disk (MB)', iu.diskMb]].forEach(function (x) {
      var u = inUse(x[1]); var w = u && u.b ? Math.min(100, Math.round(u.a / u.b * 100)) : 0;
      var bar = h('div', { cls: 'bar' + (w >= 80 ? ' hot' : '') }, [h('div', {})]); bar.firstChild.style.width = w + '%';
      stats.push(h('div', { cls: 'stat' }, [h('div', { cls: 'k', text: x[0] }), h('div', { cls: 'v', text: x[1] || '—' }), bar]));
    });
    var halted = !!(f.stopFile || f.agentPause);
    root.appendChild(panel('strategy factory', [h('div', { cls: 'cols3' }, stats),
      h('div', { cls: 'btns' }, [btn('Pause', function () { change('factory-pause'); }, '', halted), btn('Resume', function () { change('factory-resume'); }, '', !f.agentPause || !!f.stopFile, f.stopFile ? 'FACTORY-STOP is lifted on your terminal only' : null), btn('Run now', function () { change('factory-run'); }, 'primary', halted), btn('Lessons', loadLessons, 'ghost')]),
      h('div', { cls: 'sub', text: 'Candidates are PAPER and SIMULATED, made by your own Claude from the same limited data. Most will fail. A candidate is never an edge; the caps above bound every run.' }),
    ], [chip('PAPER', 'paper')]));
    var cands = (f.candidates && f.candidates.candidates) || st.candidates || [];
    var board = h('div', { cls: 'stages' }, GEN_STAGES.map(function (s) {
      var xs = cands.filter(function (c) { return c.stage === s; });
      return h('div', { cls: 'stage' }, [h('div', { cls: 'k' }, [h('span', { text: s }), h('span', { text: String(xs.length) })])].concat(xs.slice(0, 6).map(function (c) {
        return h('div', { cls: 'cand', on: { click: function () { S.sel = c.id; setTab('strategies'); renderList(); loadDetail(c.id); } } }, [h('div', { text: c.id }), h('div', { cls: 'muted small', text: 'from ' + (c.parents || []).join('+') })]);
      })));
    }));
    root.appendChild(panel('candidates by stage', [board]));
    var rows = cands.map(function (c) {
      return h('tr', {}, [h('td', { text: c.id }), h('td', { text: c.stage }), h('td', { text: (c.parents || []).join(', ') }), h('td', { text: c.by || c.source || '' }), h('td', { text: heldOutLine(c.backtest) }), h('td', { text: c.forward ? c.forward.state + (c.forward.progress ? ' · ' + c.forward.progress.closed + ' closed, ' + c.forward.progress.open + ' open' : '') : '—' }),
        h('td', {}, [c.stage !== 'retired' ? btn('Retire', function () { change('retire', c.id); }, 'sm danger') : h('span', { cls: 'muted', text: untag(c.retired && c.retired.why ? c.retired.why : c.retire || '') })])]);
    });
    root.appendChild(panel('candidates', [cands.length ? h('div', { cls: 'tablewrap' }, [h('table', {}, [h('thead', {}, [h('tr', {}, ['id', 'stage', 'parents', 'made by', 'held-out test', 'forward test', ''].map(function (x) { return h('th', { text: x }); }))]), h('tbody', {}, rows)])]) : h('div', { cls: 'empty', text: 'no candidates yet: a factory run makes at most its capped number' })]));
    if (f.waiting && f.waiting.length) root.appendChild(panel('waiting for you (proposed by an agent)', f.waiting.map(function (p) {
      var res = h('div', { cls: 'small' });
      return h('div', { cls: 'panel' }, [h('div', { text: p.preview }), h('div', { cls: 'sub', text: p.code + ' · ' + (p.origin || 'agent') }), h('div', { cls: 'btns' }, [btn('Confirm', function () { api('/api/change/confirm', { code: p.code }).then(function (x) { res.textContent = (x.ok ? 'Done: ' : 'Not applied: ') + x.text; loadFactory(); }); }, 'primary'), btn('Cancel', function () { api('/api/change/cancel', { code: p.code }).then(function (x) { res.textContent = x.text; loadFactory(); }); }, 'ghost')]), res]);
    })));
    var lessonsBox = h('div', { attrs: { id: 'f-lessons' } }, [h('div', { cls: 'muted', text: 'press Lessons to read lessons.md' })]);
    root.appendChild(panel('lessons.md', [lessonsBox]));
    if (S.lessons) showLessons();
  }
  function heldOutLine(b) { return b ? 'n ' + b.n + ' · mean ' + pct(b.meanPct) + ' (' + range(b.lo, b.hi) + ') · 2x costs ' + pct(b.mean2xPct) + ' · without top 3 ' + pct(b.noTop3Pct) : '—'; }
  function loadLessons() { api('/api/factory/lessons').then(function (r) { S.lessons = r; showLessons(); }).catch(function () {}); }
  function showLessons() {
    var box = $('f-lessons'); if (!box) return; clear(box);
    var r = S.lessons; var text = String(r.lessons || '');
    box.appendChild(h('pre', { cls: 'mono-pre', text: text || '(empty)' }));
    box.appendChild(h('div', { cls: 'sub', text: 'lessons.md is data written by the factory and by agents, shown as plain text; lines from held-out days are hidden.' }));
  }

  // ───────────── chat ─────────────
  var cur = {}; // turn -> assistant bubble
  function chatEvent(ev) {
    var log = $('chat-log');
    var atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    if (ev.type === 'user') { log.appendChild(h('div', { cls: 'msg user', text: ev.text })); setBusy(true); }
    else if (ev.type === 'text') { var b = cur[ev.turn]; if (!b) { b = cur[ev.turn] = h('div', { cls: 'msg bot' }); log.appendChild(b); } b.appendChild(document.createTextNode(ev.delta)); }
    else if (ev.type === 'tool') { cur[ev.turn] = null; var a = ev.input === null || ev.input === undefined ? '' : typeof ev.input === 'string' ? ev.input : JSON.stringify(ev.input); log.appendChild(h('div', { cls: 'toolcard' }, [h('b', { text: '⚙ ' + ev.name }), a && a !== '{}' ? h('div', { cls: 'args', text: a.length > 300 ? a.slice(0, 300) + '…' : a }) : null])); }
    else if (ev.type === 'confirm') {
      var res = h('div', { cls: 'done small' });
      var bc = btn('Confirm', function () { bc.disabled = true; bx.disabled = true; api('/api/change/confirm', { code: ev.code }).catch(function () {}); }, 'primary');
      var bx = btn('Cancel', function () { bc.disabled = true; bx.disabled = true; api('/api/change/cancel', { code: ev.code }).catch(function () {}); }, 'ghost');
      log.appendChild(h('div', { cls: 'confirmcard', attrs: { 'data-code': ev.code } }, [h('div', { cls: 'h', text: 'preview · nothing changed yet · ' + ev.code }), h('div', { text: ev.preview }), h('div', { cls: 'btns' }, [bc, bx]), res]));
    }
    else if (ev.type === 'resolved') {
      var card = log.querySelector('.confirmcard[data-code="' + String(ev.code).replace(/[^A-Z0-9]/g, '') + '"]');
      var line = h('div', { cls: 'small ' + (ev.ok ? 'upline' : 'muted'), text: (ev.ok ? 'Done: ' : '') + ev.text });
      if (card) { card.querySelectorAll('button').forEach(function (x) { x.disabled = true; }); card.appendChild(line); } else log.appendChild(h('div', { cls: 'toolcard' }, [line]));
      refreshAll();
    }
    else if (ev.type === 'done') { log.appendChild(h('div', { cls: 'meta', text: (ev.model ? ev.model + ' · ' : '') + (ev.costUsd !== null && ev.costUsd !== undefined ? '$' + Number(ev.costUsd).toFixed(4) + ' of your Claude' : '') })); cur[ev.turn] = null; setBusy(false); }
    else if (ev.type === 'error') { log.appendChild(h('div', { cls: 'msg err', text: ev.message })); setBusy(false); }
    if (atEnd || ev.type === 'user') log.scrollTop = log.scrollHeight;
  }
  function setBusy(b) { S.busy = b; $('chat-send').disabled = b; $('chat-stop').disabled = !b; }
  function sendChat() {
    var t = $('chat-in'); var text = t.value.trim(); if (!text || S.busy) return;
    api('/api/chat/message', { text: text }).then(function (r) { if (!r.ok) toast(r.why, true); else t.value = ''; }).catch(function () {});
  }
  function startStream() {
    var es = new EventSource('/api/chat/stream');
    es.onmessage = function (m) { var ev; try { ev = JSON.parse(m.data); } catch (e) { return; } chatEvent(ev); };
    es.onerror = function () { /* the browser reconnects */ };
  }
  function buildChat() {
    var root = $('view-chat');
    var ta = h('textarea', { attrs: { id: 'chat-in', placeholder: 'ask about your strategies or the factory, or say what to change (e.g. "turn my-scalp off")', maxlength: '1500' }, on: { keydown: function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } } } });
    var examples = ['list my strategies and which are on', 'turn my-scalp off', 'why did the factory make its newest candidate?', 'what are the factory lessons so far?'];
    root.appendChild(h('div', { cls: 'chat' }, [
      h('section', { cls: 'panel' }, [h('h2', {}, ['chat', h('span', { cls: 'sp' }), chip('your own Claude', 'live'), chip('PAPER', 'paper')]), h('div', { cls: 'log', attrs: { id: 'chat-log' } }),
        h('div', { cls: 'composer' }, [ta, h('div', { cls: 'btns' }, [h('button', { cls: 'btn primary', text: 'Send', attrs: { type: 'button', id: 'chat-send' }, on: { click: sendChat } }), h('button', { cls: 'btn ghost', text: 'Stop', attrs: { type: 'button', id: 'chat-stop', disabled: true }, on: { click: function () { api('/api/chat/stop', {}).catch(function () {}); } } })])])]),
      h('aside', {}, [
        panel('what the chat can do', [h('ul', { cls: 'rules' }, ['list strategies, their stage and numbers', 'turn a PAPER always-on strategy on or off', 'pause, resume or run the factory now', 'say why the factory made a candidate', 'retire a generated candidate', 'propose a strategy edit (you apply it)', 'start or stop a paper forward test'].map(function (x) { return h('li', { text: x }); }))]),
        panel('what it cannot do', [h('ul', { cls: 'rules' }, ['real mode, arming or promotion', 'your real-mode limits, the paper book or the daily Claude budget', 'sign or send anything (dexterm never holds a key)', 'remove FACTORY-STOP', 'apply a change you did not confirm'].map(function (x) { return h('li', { text: x }); }))]),
        panel('try', examples.map(function (x) { return h('div', {}, [btn(x, function () { ta.value = x; ta.focus(); }, 'sm ghost wrap')]); })),
        h('div', { cls: 'sub', text: 'Each message is one turn of your own Claude CLI (capped at $0.50 a turn, 6 a minute). Token names and feed text are untrusted data to it, never instructions. A change shows as a preview with Confirm / Cancel: nothing happens until you press Confirm.' }),
      ]),
    ]));
    api('/api/chat/log').then(function (r) { (r.events || []).forEach(chatEvent); setBusy(!!r.busy); startStream(); }).catch(function () { startStream(); });
  }

  // ───────────── boot ─────────────
  ['strategies', 'builder', 'factory', 'chat'].forEach(function (t) { $('tab-' + t).addEventListener('click', function () { setTab(t); }); });
  $('sfilter').addEventListener('input', function (e) { S.filter = e.target.value; renderList(); });
  $('modal').addEventListener('click', function (e) { if (e.target === $('modal')) closeModal(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });
  buildChat(); setTab('strategies');
  loadSession(); loadStrategies();
  setInterval(function () { loadSession(); if (S.tab === 'strategies' && S.sel && S.detail && document.visibilityState === 'visible') api('/api/cook?id=' + encodeURIComponent(S.sel)).then(function (v) { if (S.detail && S.detail.id === v.id) { S.detail.cook = v; } }).catch(function () {}); }, 5000);
})();
