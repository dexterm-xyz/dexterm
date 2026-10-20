// dexterm popup — spectator page (task-1406, "watch the agent cook"). Renders the SpectatorPopupVM: the
// screen the agent moved to, the connected agents with an 'agent' badge and status, and an activity feed
// with timing and data ages. Every string is already REDACTED TUI-side (wallet addresses/keys masked) and
// is rendered with textContent only — never innerHTML. The ONLY messages this page sends are the
// allow-listed spectator.pause / resume / takeover / kill events (by agent name); it can never arm, sign,
// raise a cap or touch a wallet (no such control exists and the server drops anything off the allow-list).
(() => {
  'use strict';
  const DT = window.DT; DT.page = 'spectator';
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; };
  const ago = (t) => { if (!t) return '—'; const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`; };
  const age = (s) => (s == null ? '' : s < 60 ? `${Math.round(s)}s old` : s < 3600 ? `${Math.floor(s / 60)}m old` : `${Math.floor(s / 3600)}h old`);

  let vm = null;

  const pctS = (p) => (p == null ? '—' : `${p >= 0 ? '+' : '−'}${Math.abs(p * 100).toFixed(1)}%`);
  const px = (n) => (n == null ? '—' : n >= 1 ? `$${n.toFixed(4)}` : `$${Number(n.toPrecision(3))}`);
  const fmtMs = (ms) => (ms == null ? '·' : ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);
  const CHECKS = ['price', 'tape', 'chart', 'holders', 'rug', 'dev', 'larp', 'verdict'];

  // task-1466 spectator v2: the agent story above the activity list (textContent only; strings redacted TUI-side).
  function renderStory(st) {
    const host = $('story'); host.textContent = '';
    if (!st) return;
    const rail = el('div', 'spec-rail');
    const heart = el('span', 'spec-heart' + (st.control === 'killed' ? ' dead' : st.control !== 'running' ? ' still' : ''));
    if (st.bpm > 0) heart.style.animationDuration = `${(60 / st.bpm).toFixed(2)}s`;
    rail.appendChild(heart);
    rail.appendChild(el('span', 'spec-bpm', st.control === 'killed' ? '— bpm' : `${st.bpm} bpm`));
    const ai = st.rail.indexOf(st.phase);
    st.rail.forEach((p, i) => {
      if (i) rail.appendChild(el('span', 'spec-sep', '─'));
      const on = i === ai && st.control !== 'killed';
      rail.appendChild(el('span', 'spec-phase p-' + p + (on ? ' on' : i < ai ? ' done' : ''), (on ? '▸' : '') + p.toUpperCase() + (on && st.sub ? ` · ${st.sub}` : '')));
    });
    if (st.control !== 'running') rail.appendChild(el('span', 'spec-ctlstate ' + st.control, st.control === 'killed' ? '■ KILLED' : st.control === 'paused' ? '❚❚ PAUSED' : 'YOU ARE DRIVING'));
    rail.appendChild(el('span', 'spec-paper', 'PAPER'));
    host.appendChild(rail);
    const th = (st.thoughts || []).slice().reverse();
    const agentT = th.find((x) => x.source === 'agent');
    const ours = th.find((x) => x.source === 'dexterm');
    const pick = agentT && (!ours || agentT.t >= ours.t - 1500 || Date.now() - agentT.t < 9000) ? agentT : ours || agentT;
    const rib = el('div', 'spec-ribbon' + (pick && pick.source === 'dexterm' ? ' ours' : ''));
    if (pick) { if (pick.source === 'agent') rib.appendChild(el('span', 'spec-ribbon-who', '❯')); rib.appendChild(el('span', '', pick.text)); }
    else rib.appendChild(el('span', 'spec-dim', 'the agent has not said anything yet'));
    host.appendChild(rib);
    const tl = el('div', 'spec-timeline');
    (st.nodes || []).slice(-14).forEach((n, i) => {
      if (i) tl.appendChild(el('span', 'spec-link', '──'));
      const node = el('div', 'spec-node' + (n.paper ? ' paper' : ''));
      node.appendChild(el('span', 'spec-node-l', `${n.status === 'refused' ? '✗' : n.paper ? '■' : '●'} ${n.label}${n.count > 1 ? ` ×${n.count}` : ''}`));
      node.appendChild(el('span', 'spec-chip ' + n.status, n.status === 'refused' ? 'refused' : fmtMs(n.ms)));
      tl.appendChild(node);
    });
    host.appendChild(tl);
    const cards = el('div', 'spec-cards');
    if (st.focus) {
      const c = el('div', 'spec-card');
      c.appendChild(el('span', 'spec-card-h', `VETTING $${st.focus.symbol}`));
      const row = el('div');
      for (const k of CHECKS) row.appendChild(el('span', 'spec-check' + (st.focus.checks.includes(k) ? ' ok' : ''), `${st.focus.checks.includes(k) ? '✓' : '·'}${k}`));
      c.appendChild(row);
      if (st.focus.larpFlags != null) c.appendChild(el('div', 'spec-kv', `LARP evidence: ${st.focus.larpFlags} flag${st.focus.larpFlags === 1 ? '' : 's'} (not a verdict)`));
      if (st.focus.verdict) c.appendChild(el('div', 'spec-kv', `verdict ${st.focus.verdict}${st.focus.rug != null ? ` · rug heuristic ${Math.round(st.focus.rug * 100)}%` : ''}`));
      cards.appendChild(c);
    }
    if (st.arc) {
      const a = st.arc;
      const c = el('div', 'spec-card trade');
      c.appendChild(el('span', 'spec-card-h', `PAPER · $${a.symbol} · ${a.stage === 'closed' ? 'RESULT' : a.stage === 'open' ? 'HOLDING' : a.stage === 'refused' ? 'REFUSED' : 'TICKET'}`));
      const big = a.stage === 'closed' ? a.resultPct : a.pnlPct;
      if (big != null) c.appendChild(el('div', 'spec-big ' + (big >= 0 ? 'up' : 'down'), pctS(big)));
      const kv = el('div', 'spec-kv');
      kv.textContent = [a.sizeUsd != null ? `size $${a.sizeUsd.toFixed(2)}` : null, a.entryUsd != null ? `entry ${px(a.entryUsd)}` : null, a.markUsd != null && a.stage !== 'closed' ? `mark ${px(a.markUsd)}` : null,
        a.peakPct != null ? `peak ${pctS(a.peakPct)}` : null, a.exits ? `exits ${a.exits}` : null, a.realizedSol != null ? `realized ${a.realizedSol >= 0 ? '+' : ''}${a.realizedSol.toFixed(4)} SOL` : null,
        a.refusal ? `refused: ${a.refusal}` : null].filter(Boolean).join(' · ');
      c.appendChild(kv);
      c.appendChild(el('div', 'spec-dim', 'simulated paper trade · not a result'));
      cards.appendChild(c);
    }
    if (cards.childNodes.length) host.appendChild(cards);
  }

  function render() {
    if (!vm) return;
    renderStory(vm.story || null);

    const scr = $('screen'); scr.textContent = '';
    const s = vm.screen || {};
    scr.appendChild(el('span', 'spec-screen-k', `screen: ${s.screen || '—'}`));
    if (s.selectedMint) scr.appendChild(el('span', 'spec-screen-dim', ` · token ${s.selectedMint}`));
    if (s.feed) scr.appendChild(el('span', 'spec-screen-dim', ` · feed ${s.feed}`));
    if (s.filter) scr.appendChild(el('span', 'spec-screen-dim', ` · filter ${s.filter}`));
    if (s.highlight) scr.appendChild(el('span', 'spec-screen-dim', ` · ★ ${s.highlight}`));
    if (vm.control === 'user') scr.appendChild(el('span', 'spec-takeover', ' · YOU HAVE TAKEN OVER'));

    const host = $('agents'); host.textContent = '';
    if (!vm.agents || !vm.agents.length) host.appendChild(el('div', 'spec-dim', 'no agents connected yet'));
    for (const a of (vm.agents || [])) {
      const row = el('div', 'spec-agent' + (a.status !== 'active' ? ' off' : ''));
      row.appendChild(el('span', 'spec-badge', 'agent'));           // the 'agent' badge
      row.appendChild(el('span', 'spec-name', a.name));             // textContent — redacted/firewalled, safe
      if (a.tier) row.appendChild(el('span', 'spec-tier tier-' + a.tier, a.tier));
      row.appendChild(el('span', 'spec-status status-' + a.status, a.status));
      row.appendChild(el('span', 'spec-dim', ` · ${ago(a.lastAt)}`));
      const ctl = el('div', 'spec-ctl');
      const mk = (label, name, danger) => { const b = el('button', 'spec-btn' + (danger ? ' danger' : ''), label); b.type = 'button'; b.addEventListener('click', () => DT.send({ type: 'event', name, payload: { agent: a.name } })); return b; };
      if (a.status === 'active') { ctl.appendChild(mk('pause', 'spectator.pause')); ctl.appendChild(mk('take over', 'spectator.takeover')); }
      else ctl.appendChild(mk('resume', 'spectator.resume'));
      ctl.appendChild(mk('kill', 'spectator.kill', true));          // panic
      row.appendChild(ctl);
      host.appendChild(row);
    }

    const act = $('activity'); act.textContent = '';
    for (const r of (vm.activity || []).slice().reverse().slice(0, 80)) {
      const line = el('div', 'spec-act' + (r.ok ? '' : ' bad') + (r.phase === 'nav' ? ' nav' : ''));
      line.appendChild(el('span', 'spec-act-t', ago(r.t)));
      line.appendChild(el('span', 'spec-badge sm', 'agent'));
      line.appendChild(el('span', 'spec-act-agent', r.agent));
      line.appendChild(el('span', 'spec-act-phase', r.phase));
      if (r.tool) line.appendChild(el('span', 'spec-act-tool', r.tool));
      line.appendChild(el('span', 'spec-act-sum', r.summary || ''));  // textContent — redacted upstream
      if (r.ms != null) line.appendChild(el('span', 'spec-act-ms', `${Math.round(r.ms)}ms`));
      if (r.dataAgeSec != null) line.appendChild(el('span', 'spec-act-age', age(r.dataAgeSec)));
      act.appendChild(line);
    }

    $('redact').textContent = vm.redacted ? 'redacted' : 'local (full)';
    const live = (vm.agents || []).filter((a) => a.status === 'active').length;
    DT.status(`${live} cooking`, live ? 'up' : 'muted');
  }

  DT.onHello(() => { DT.mountRain('rain'); const r = DT.rain(); if (r) { r.setActivity(0.3); r.setMood('rain'); } });
  DT.onData((payload) => { vm = payload; render(); });
  DT.onUpdate(() => { /* spectator is pushed as full `data` frames */ });
  DT.wireChrome();
  let lastTick = 0;
  DT.rainEvery = 2; DT.fpsCap = 30;
  DT.loop((now) => { if (now - lastTick > 1000) { lastTick = now; if (vm) render(); } });
  DT.connect();
})();
