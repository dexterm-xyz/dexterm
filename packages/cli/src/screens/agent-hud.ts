// `dexterm` TUI — spectator v2 (task-1466): the AGENT HUD a terminal draws while it follows an agent driving
// dexterm (`--spectate-mcp`). Instead of a list of tool calls, the watcher sees the agent WORK, in the app's own
// cinematic vocabulary:
//   * the DOCK (bottom rows, below the app's footer, so the screen loses no data): a heartbeat ECG + signal line,
//     the phase rail SCANNING > VETTING > SIZING > EXECUTING > HOLDING > EXITING, the PAPER badge and the pause /
//     kill keys, the thought ribbon (the agent's own words, typed in), and the call timeline (nodes + result chips);
//   * OVERLAYS on the screen: the rows the agent scanned glow (a beam sweeps each one), the agent cursor jumps to
//     the row it opens, the token screen assembles top-down, a vetting card fills its checks and sweeps the LARP
//     gauge, the PAPER ticket assembles, the fill lands with a flash, the position panel ticks the mark PnL with a
//     big number + trace, exits flash, the result card resolves, and a kill is a hard red cut.
// Pure: (canvas, StoryView, opts) → cells. Every number comes from the story (app-computed); nothing here can act.
// Reduced motion (calm mode / DEXTERM_REDUCED_MOTION) drops every sweep, flash, glitch and typewriter: the same
// information appears at once. NO_COLOR keeps meaning in glyphs (▸ active phase, ✓ ! ✗ chips, ▶ cursor).

import { mix, hash3, KATAKANA, decryptText, fmtCompactUsd, markerGlyph, markerLetter, type Canvas, type Hex, type Theme, type ColorDepth } from '@dexterm/tui';
import { STORY_RAIL, fmtQty, fmtPx, type StoryView, type StoryPhase, type TimelineNode, type TradeArc } from '@dexterm/agents';
import { pnlChipVM, renderPnlChip, type PnlChipVM } from './pnl-chip.ts';

/** Rows the dock takes at the bottom of the terminal. */
export const DOCK_ROWS = 5;
/** Below this terminal height the HUD collapses to the dock's rail + ribbon only (and no overlays). */
export const HUD_MIN_H = 24;

export interface HudOpts {
  now: number;
  reduced: boolean;
  depth: ColorDepth;
  /** e.g. 'SAMPLE DATA' / 'REPLAY' (null on live data). */
  dataLabel: string | null;
  /** The current screen key (the token screen assembles on an open). */
  screen: string;
  /** task-1473: the analyst panel is showing the BRAIN VIEW (vetting + position live there, so those cards stay off). */
  brain?: boolean;
  /** task-1473 r2: the chip the app resolved (state.ts pnlChipFor: agent ticket, else own position in scan mode). Absent = from the story. */
  chip?: PnlChipVM | null;
  /**
   * task-1472: the chart axis is market cap: the supply ratio (mcap / price) for a mint when the app knows it, else
   * null. Absent / null = the position card reads prices (display only; the arc's numbers stay USD prices).
   */
  mcapScale?: (mint: string) => number | null;
}

/** What renderFrame needs to draw the HUD (set on AppState while following). */
export interface AgentHudState {
  story: { view(now: number): StoryView };
  clock: () => number;
  reduced?: boolean;
  dataLabel?: string | null;
}

const PHASE_LABEL: Record<StoryPhase, [string, string]> = {
  idle: ['IDLE', 'IDLE'], scanning: ['SCANNING', 'SCAN'], vetting: ['VETTING', 'VET'], sizing: ['SIZING', 'SIZE'],
  executing: ['EXECUTING', 'EXEC'], holding: ['HOLDING', 'HOLD'], exiting: ['EXITING', 'EXIT'],
};

export function phaseColor(t: Theme, p: StoryPhase): Hex {
  switch (p) {
    case 'scanning': return t.accent;
    case 'vetting': return t.borderFocus;
    case 'sizing': return t.meteora;
    case 'executing': return t.up;
    case 'holding': return t.magenta;
    case 'exiting': return t.ai;
    default: return t.dim;
  }
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const easeOut = (x: number): number => 1 - (1 - clamp01(x)) ** 3;
const fmtMs = (ms: number | null): string => (ms == null ? '·' : ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);
const signPct = (p: number, d = 1): string => `${p >= 0 ? '+' : '−'}${Math.abs(p * 100).toFixed(d)}%`;
const signSol = (s: number): string => `${s >= 0 ? '+' : '−'}${Math.abs(s).toFixed(4)} SOL`;
function fmtDur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

/** Mix the background of a rectangle toward a colour (overlay tint; drawn after the effects). */
function tintRect(c: Canvas, x: number, y: number, w: number, h: number, color: Hex, amt: number, fgToo = 0): void {
  if (amt <= 0) return;
  for (let yy = Math.max(0, y); yy < Math.min(c.h, y + h); yy++) {
    for (let xx = Math.max(0, x); xx < Math.min(c.w, x + w); xx++) {
      const i = c.idx(xx, yy);
      c.bg[i] = mix(c.bg[i], color, amt);
      if (fgToo) c.fg[i] = mix(c.fg[i], color, fgToo);
    }
  }
}

/**
 * Big text: a 5-row, full-block font (the boot logo's vocabulary). Full blocks only, so it renders solid in every
 * terminal and in the cell-exact HTML capture (half blocks show gaps there). Digits, sign, %, . and a few letters.
 */
const BIG: Record<string, string[]> = {
  '0': [' ███ ', '█   █', '█   █', '█   █', ' ███ '],
  '1': ['  █  ', ' ██  ', '  █  ', '  █  ', ' ███ '],
  '2': ['████ ', '    █', ' ███ ', '█    ', '█████'],
  '3': ['████ ', '    █', ' ███ ', '    █', '████ '],
  '4': ['█   █', '█   █', '█████', '    █', '    █'],
  '5': ['█████', '█    ', '████ ', '    █', '████ '],
  '6': [' ███ ', '█    ', '████ ', '█   █', ' ███ '],
  '7': ['█████', '    █', '   █ ', '  █  ', '  █  '],
  '8': [' ███ ', '█   █', ' ███ ', '█   █', ' ███ '],
  '9': [' ███ ', '█   █', ' ████', '    █', ' ███ '],
  '+': ['     ', '  █  ', '█████', '  █  ', '     '],
  '-': ['     ', '     ', '█████', '     ', '     '],
  '−': ['     ', '     ', '█████', '     ', '     '],
  '.': ['  ', '  ', '  ', '  ', '██'],
  '%': ['██  █', '██ █ ', '  █  ', ' █ ██', '█  ██'],
  ' ': ['   ', '   ', '   ', '   ', '   '],
  'K': ['█   █', '█  █ ', '███  ', '█  █ ', '█   █'],
  'I': ['███', ' █ ', ' █ ', ' █ ', '███'],
  'L': ['█    ', '█    ', '█    ', '█    ', '█████'],
  'E': ['█████', '█    ', '████ ', '█    ', '█████'],
  'D': ['████ ', '█   █', '█   █', '█   █', '████ '],
};
export const BIG_ROWS = 5;

/** Draw big text (5 rows) with a soft top-to-bottom ramp. Returns the width drawn. */
export function bigText(c: Canvas, x: number, y: number, str: string, fg: Hex, _bg: Hex): number {
  let cx = x;
  for (const ch of str) {
    const g = BIG[ch] ?? BIG[' '];
    for (let r = 0; r < BIG_ROWS; r++) {
      const col = mix(fg, '#ffffff', r === 0 ? 0.28 : r === 1 ? 0.12 : 0);
      // ink = the cell BACKGROUND (fills the whole cell in every renderer, no line gaps) + a █ glyph for NO_COLOR
      for (let k = 0; k < g[r].length; k++) if (g[r][k] !== ' ') c.put(cx + k, y + r, '█', { fg: col, bg: col, soft: true });
    }
    cx += g[0].length + 1;
  }
  return Math.max(0, cx - x - 1);
}
export const bigTextWidth = (str: string): number => Math.max(0, [...str].reduce((s, ch) => s + (BIG[ch] ?? BIG[' '])[0].length + 1, 0) - 1);

/** A floating card: tinted fill, rounded (or double) border in `color`, a title set into the top edge. */
function card(c: Canvas, x: number, y: number, w: number, h: number, title: string, color: Hex, opts: { double?: boolean; right?: string; rightColor?: Hex; fill?: number } = {}): Hex {
  const t = c.theme;
  const bg = mix(t.bg, color, opts.fill ?? 0.07);
  c.fill(x, y, w, h, ' ', { bg });
  const [tl, tr, bl, br, hz, vt] = opts.double ? ['╔', '╗', '╚', '╝', '═', '║'] : ['╭', '╮', '╰', '╯', '─', '│'];
  const st = { fg: color, bg, soft: true };
  c.put(x, y, tl, st); c.put(x + w - 1, y, tr, st); c.put(x, y + h - 1, bl, st); c.put(x + w - 1, y + h - 1, br, st);
  c.hline(x + 1, y, w - 2, st, hz); c.hline(x + 1, y + h - 1, w - 2, st, hz);
  c.vline(x, y + 1, h - 2, st, vt); c.vline(x + w - 1, y + 1, h - 2, st, vt);
  c.text(x + 2, y, ` ${title} `, { fg: t.bg, bg: color, b: true }, w - 4);
  if (opts.right) { const r = ` ${opts.right} `; c.text(x + w - 2 - r.length, y, r, { fg: opts.rightColor ?? color, bg, b: true }); }
  return bg;
}

// ---------------------------------------------------------------------------------------------------------------
// The dock

export function renderAgentDock(c: Canvas, v: StoryView, o: HudOpts, y0: number): void {
  const t = c.theme;
  const rows = Math.min(DOCK_ROWS, c.h - y0);
  if (rows <= 0) return;
  const dockBg = mix(t.bg, t.headBg, 0.6);
  c.fill(0, y0, c.w, rows, ' ', { bg: dockBg });
  signalRow(c, v, o, y0, dockBg);
  if (rows > 1) railRow(c, v, o, y0 + 1);
  if (rows > 2) ribbonRow(c, v, o, y0 + 2, dockBg);
  if (rows > 4) timelineRows(c, v, o, y0 + 3, dockBg);
}

/** Row 0: heartbeat ECG at the left, then a hairline with a travelling pulse, the data label at the right. */
function signalRow(c: Canvas, v: StoryView, o: HudOpts, y: number, bg: Hex): void {
  const t = c.theme;
  const dead = v.control === 'killed';
  const held = v.control === 'paused' || v.control === 'takeover';
  const ecgW = Math.min(22, Math.floor(c.w / 6));
  const beatMs = v.bpm > 0 ? 60_000 / v.bpm : Infinity;
  const ecgColor = dead ? t.down : held ? t.warn : t.up;
  const LV = ' ▁▂▃▄▅▆▇█';
  for (let i = 0; i < ecgW; i++) {
    let lv = 1;
    if (!dead && !held && Number.isFinite(beatMs)) {
      const ti = (o.reduced ? 0 : o.now) - (ecgW - 1 - i) * 55;
      const p = ((ti % beatMs) + beatMs) % beatMs / beatMs;
      lv = p < 0.035 ? 8 : p < 0.06 ? 0 : p < 0.1 ? 3 : p > 0.32 && p < 0.42 ? 2 : 1;
    }
    const fade = o.reduced ? 1 : 0.55 + 0.45 * (i / Math.max(1, ecgW - 1));
    c.put(1 + i, y, dead || held ? '─' : LV[lv], { fg: mix(bg, ecgColor, fade), bg, soft: true });
  }
  const lx = ecgW + 2;
  const right = o.dataLabel ? ` ${o.dataLabel} ` : '';
  const lw = Math.max(0, c.w - lx - right.length - 2);
  const pulseAt = o.reduced || dead || held ? -99 : Math.floor(((o.now % 1600) / 1600) * lw);
  const lineColor = dead ? mix(t.bg, t.down, 0.5) : mix(t.border, phaseColor(t, v.phase), 0.55);
  for (let i = 0; i < lw; i++) {
    const d = pulseAt - i;
    const glow = d >= 0 && d < 10 ? 1 - d / 10 : 0;
    c.put(lx + i, y, glow > 0.5 ? '━' : '─', { fg: glow > 0 ? mix(lineColor, mix(phaseColor(t, v.phase), '#ffffff', 0.3), glow) : lineColor, bg, soft: true });
  }
  if (right) c.text(c.w - right.length - 1, y, right, { fg: t.bg, bg: t.warn, b: true });
  // task-1473: the persistent POSITION PnL chip (every screen while the agent holds), right of the hairline
  const chip = o.chip !== undefined ? o.chip : pnlChipVM(v, o.now);
  if (chip) renderPnlChip(c, c.w - right.length - 2, y, Math.max(0, lw - 6), chip, { now: o.now, reduced: o.reduced });
}

/** Row 1: agent badge, heartbeat, the phase rail, PAPER, and the control keys. */
function railRow(c: Canvas, v: StoryView, o: HudOpts, y: number): void {
  const t = c.theme;
  const bg = t.headBg;
  c.fill(0, y, c.w, 1, ' ', { bg });
  const compact = c.w < 150;
  const pcol = phaseColor(t, v.phase);
  const beatMs = v.bpm > 0 ? 60_000 / v.bpm : Infinity;
  const beatP = Number.isFinite(beatMs) && !o.reduced ? ((o.now % beatMs) / beatMs) : 0.5;
  const beatGlow = v.control === 'running' && !o.reduced ? Math.max(0, 1 - beatP * 5) : 0;
  let x = 1;
  x = c.text(x, y, '◆', { fg: v.control === 'killed' ? t.down : mix(pcol, '#ffffff', beatGlow * 0.5), bg, b: true });
  x = c.text(x + 1, y, 'AGENT', { fg: t.dim, bg });
  x = c.text(x + 1, y, v.agent.slice(0, compact ? 12 : 20), { fg: t.text, bg, b: true });
  const heart = v.control === 'killed' ? '♡' : '♥';
  const hcol = v.control === 'killed' ? t.down : v.control === 'running' ? mix(mix(t.down, bg, 0.35), t.down, beatGlow) : t.warn;
  x = c.text(x + 2, y, heart, { fg: hcol, bg, b: true });
  x = c.text(x + 1, y, v.control === 'killed' ? '--' : String(v.bpm).padStart(2, ' '), { fg: v.control === 'killed' ? t.down : t.muted, bg });
  x += 3;

  // the rail (dark after a kill: nothing is moving any more)
  const ai = v.control === 'killed' ? -1 : STORY_RAIL.indexOf(v.phase);
  const sweep = o.reduced ? 1 : clamp01((o.now - v.phaseSince) / 320);
  for (let i = 0; i < STORY_RAIL.length; i++) {
    const p = STORY_RAIL[i];
    const label = PHASE_LABEL[p][compact ? 1 : 0];
    const col = phaseColor(t, p);
    if (i > 0) {
      const lit = ai >= 0 && i <= ai;
      x = c.text(x, y, compact ? '─' : '──', { fg: lit ? mix(t.border, col, 0.7) : mix(bg, t.border, 0.8), bg, soft: true });
    }
    if (i === ai) {
      const s = `▸${label}`;
      const cellBg = mix(bg, col, 0.28);
      const start = x;
      x = c.text(x, y, ` ${s} `, { fg: col, bg: cellBg, b: true });
      if (sweep < 1) {
        const sx = start + Math.floor(sweep * (s.length + 2));
        for (let k = start; k < x; k++) { const i2 = c.idx(k, y); c.bg[i2] = k <= sx ? mix(cellBg, col, k === sx ? 0.6 : 0) : bg; if (k > sx) c.fg[i2] = mix(bg, col, 0.4); }
      }
      if (p === 'holding' && v.sub) x = c.text(x, y, `·${PHASE_LABEL[v.sub][1].toLowerCase()}`, { fg: mix(bg, phaseColor(t, v.sub), 0.8), bg });
    } else {
      const passed = ai >= 0 && i < ai;
      x = c.text(x, y, ` ${label} `, { fg: passed ? mix(t.dim, col, 0.45) : mix(bg, t.dim, 0.75), bg });
    }
  }
  if (v.phase === 'idle') x = c.text(x + 2, y, 'waiting for the agent', { fg: t.dim, bg });

  // right cluster: PAPER (always visible) + control state + keys
  const segs: Array<[string, { fg: Hex; bg: Hex; b?: boolean }]> = [];
  segs.push([' PAPER ', { fg: t.bg, bg: t.warn, b: true }]);
  segs.push([' ', { fg: t.text, bg }]);
  if (v.control === 'killed') segs.push([' ■ AGENT KILLED ', { fg: '#ffffff', bg: t.down, b: true }]);
  else {
    if (v.control === 'paused') segs.push([' ❚❚ PAUSED ', { fg: t.bg, bg: t.warn, b: true }]);
    if (v.control === 'takeover') segs.push([' YOU ARE DRIVING ', { fg: t.bg, bg: t.accent, b: true }]);
    segs.push([' ', { fg: t.text, bg }]);
    segs.push([' ^P ', { fg: t.bg, bg: t.accent, b: true }]);
    segs.push([v.control === 'running' ? ' pause ' : ' resume ', { fg: t.muted, bg }]);
    segs.push([' ^K ', { fg: '#ffffff', bg: t.down, b: true }]);
    segs.push([' KILL ', { fg: t.down, bg, b: true }]);
  }
  const rw = segs.reduce((s, [txt]) => s + txt.length, 0);
  let rx = Math.max(x + 1, c.w - rw - 1);
  for (const [txt, st] of segs) rx = c.text(rx, y, txt, st);
}

/** Row 2: the thought ribbon (agent words in coral, typed in; dexterm narration muted when the agent is quiet). */
function ribbonRow(c: Canvas, v: StoryView, o: HudOpts, y: number, bg: Hex): void {
  const t = c.theme;
  const agentT = [...v.thoughts].reverse().find((x) => x.source === 'agent');
  const ours = [...v.thoughts].reverse().find((x) => x.source === 'dexterm');
  // The agent's own words win while fresh; otherwise dexterm narrates what the call did.
  const th = agentT && (!ours || agentT.t >= ours.t - 1500 || o.now - agentT.t < 9000) ? agentT : ours ?? agentT;
  const meta = `${v.calls} call${v.calls === 1 ? '' : 's'}${v.lastCallAt !== null ? ` · last ${fmtDur(o.now - v.lastCallAt)} ago` : ''}`;
  const metaX = c.w - meta.length - 2;
  c.text(metaX, y, meta, { fg: mix(bg, t.dim, 0.8), bg });
  if (!th) { c.text(2, y, '› the agent has not said anything yet', { fg: mix(bg, t.dim, 0.7), bg }); return; }
  const isAgent = th.source === 'agent';
  const col = isAgent ? t.ai : t.muted;
  const lead = isAgent ? '❯ ' : '› ';
  let x = c.text(2, y, lead, { fg: col, bg, b: true });
  if (isAgent) x = c.text(x, y, `${v.agent}: `, { fg: mix(bg, t.ai, 0.7), bg });
  const maxW = Math.max(0, metaX - x - 2);
  const text = th.text.length > maxW ? th.text.slice(0, Math.max(0, maxW - 1)) + '…' : th.text;
  const revealed = o.reduced ? text.length : Math.floor((o.now - th.t) / 14);
  if (revealed >= text.length) {
    c.text(x, y, text, { fg: isAgent ? mix(t.text, t.ai, 0.25) : t.muted, bg, i: !isAgent });
  } else {
    const end = decryptText(c, x, y, text, Math.max(0, revealed), Math.floor(o.now / 33), { fg: isAgent ? mix(t.text, t.ai, 0.25) : t.muted, bg }, maxW);
    c.put(Math.min(end, metaX - 2), y, '▌', { fg: col, bg, soft: true });
  }
}

const NODE_GLYPH = (n: TimelineNode): string => (n.status === 'refused' ? '✗' : n.paper ? '■' : /^(open_token|show_in_screener|switch_screen|switch_feed)$/.test(n.tool) ? '◈' : '●');
const CHIP_MARK: Record<TimelineNode['status'], string> = { ok: '✓', slow: '!', fail: '✗', refused: '✗' };

/** Rows 3–4: the call timeline, newest at the right; spacing follows the time between calls. */
function timelineRows(c: Canvas, v: StoryView, o: HudOpts, y: number, bg: Hex): void {
  const t = c.theme;
  const nodes = v.nodes;
  if (!nodes.length) { c.text(2, y, '○ no calls yet', { fg: mix(bg, t.dim, 0.7), bg }); return; }
  const newest = nodes[nodes.length - 1];
  const slide = o.reduced ? 0 : Math.round((1 - easeOut((o.now - newest.t) / 260)) * 8);
  let right = c.w - 3 + slide;
  const chipColor = (n: TimelineNode): [Hex, Hex] => (n.status === 'ok' ? [t.up, t.upSoft] : n.status === 'slow' ? [t.warn, t.warnSoft] : [t.down, t.downSoft]);
  for (let k = nodes.length - 1; k >= 0 && right > 4; k--) {
    const n = nodes[k];
    const head = `${NODE_GLYPH(n)} ${n.label}${n.count > 1 ? ` ×${n.count}` : ''}`;
    const chip = ` ${o.depth === 'none' ? CHIP_MARK[n.status] : ''}${n.status === 'refused' ? 'refused' : fmtMs(n.ms)} `;
    const cw = Math.max(head.length, chip.length);
    const x0 = right - cw + 1;
    const age = o.now - n.t;
    const fresh = k === nodes.length - 1 && !o.reduced ? Math.max(0, 1 - age / 500) : 0;
    const edgeFade = x0 < 24 ? 0.35 + 0.65 * (Math.max(0, x0) / 24) : 1;
    const pc = phaseColor(t, n.phase);
    const [cf, cb] = chipColor(n);
    const gcol = n.status === 'refused' || n.status === 'fail' ? t.down : n.paper ? t.warn : pc;
    if (x0 >= 1) {
      c.text(x0, y, NODE_GLYPH(n), { fg: mix(bg, mix(gcol, '#ffffff', fresh * 0.6), edgeFade), bg: fresh > 0 ? mix(bg, gcol, fresh * 0.5) : bg, b: true });
      const lx = c.text(x0 + 2, y, n.label, { fg: mix(bg, n.paper || n.status === 'refused' ? gcol : t.text, edgeFade * (n.paper ? 1 : 0.85)), bg, b: n.paper });
      if (n.count > 1) c.text(lx, y, ` ×${n.count}`, { fg: mix(bg, pc, edgeFade), bg, b: true });
      c.text(x0, y + 1, chip, { fg: mix(cb, cf, edgeFade), bg: mix(bg, cb, edgeFade), b: n.status !== 'ok' });
    }
    // connector to the previous (older) node: longer when more time passed
    const prev = nodes[k - 1];
    if (prev) {
      const dt = Math.max(0, n.t - prev.t);
      const len = Math.max(1, Math.min(7, 1 + Math.floor(Math.log2(1 + dt / 600))));
      const changed = prev.phase !== n.phase;
      for (let i = 1; i <= len + 1; i++) {
        const cx = x0 - i;
        if (cx < 1) break;
        const ch = changed && i === Math.ceil((len + 1) / 2) ? '┼' : '─';
        c.put(cx, y, ch, { fg: mix(bg, changed && ch === '┼' ? pc : mix(t.border, pc, 0.45), edgeFade), bg, soft: true });
      }
      right = x0 - len - 2;
    } else right = x0 - 2;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Overlays on the screen region (rows 0 .. screenH-1)

export function renderAgentOverlays(c: Canvas, v: StoryView, o: HudOpts, screenH: number): void {
  const t = c.theme;
  // 1) the kill: a hard, dramatic stop takes the whole screen for a moment.
  if (v.control === 'killed') {
    const age = o.now - v.controlAt;
    if (age >= 0 && age < 4800) { killCut(c, v, o, screenH, age); return; }
  }
  // 2) the rows the agent touched glow; the agent cursor marks the row it opened.
  rowGlow(c, v, o, screenH);
  // 3) the token screen assembles top-down right after the agent opens a coin.
  if (o.screen === 'token' && v.beats.openAt !== null && !o.reduced) {
    const age = o.now - v.beats.openAt;
    if (age >= 0 && age < 700) assemble(c, o, screenH, age / 700);
  }
  // 4) cards: result > ticket / fill > position; the vetting card while vetting.
  const arc = v.arc;
  const res = arc?.stage === 'closed' ? arc : null;
  if (res && res.closedAt !== null && o.now - res.closedAt < 10_000) resultCard(c, res, o, screenH);
  else {
    if (arc && (arc.stage === 'ticket' || arc.stage === 'sized' || arc.stage === 'refused' || (arc.stage === 'open' && arc.filledAt !== null && o.now - arc.filledAt < 2600))) ticketCard(c, v, arc, o, screenH);
    else if (arc && arc.stage === 'open' && !o.brain) positionCard(c, v, arc, o, screenH);
    if (!o.brain && v.focus && (v.phase === 'vetting' || v.phase === 'sizing' || (v.phase === 'scanning' && o.now - v.focus.since < 4000)) && !(arc && arc.stage === 'open')) vetCard(c, v, o);
  }
  // 5) flashes: the fill (green), an exit (gold on profit, red on loss), a refusal (red).
  if (!o.reduced) {
    const flash = (at: number | null, color: Hex, peak: number, ms: number): void => {
      if (at === null) return;
      const age = o.now - at;
      if (age >= 0 && age < ms) tintRect(c, 0, 1, c.w, screenH - 1, color, peak * (1 - age / ms));
    };
    flash(v.beats.fillAt, t.up, 0.2, 420);
    const lastExit = arc?.fills.filter((f) => f.side === 'sell').at(-1);
    flash(v.beats.exitAt, lastExit && (lastExit.realizedSol ?? 0) < 0 ? t.down : t.meteora, 0.2, 420);
    flash(v.beats.refusedAt, t.down, 0.16, 300);
  }
  // 6) paused / taken over: say so on the band under the header, and frame the screen.
  if (v.control === 'paused' || v.control === 'takeover') {
    const col = v.control === 'paused' ? t.warn : t.accent;
    const label = v.control === 'paused' ? ' ❚❚ AGENT PAUSED BY YOU · its next call is held · ^P resume · ^K kill ' : ' YOU ARE DRIVING · the agent is frozen · ^P hand back · ^K kill ';
    const x = Math.max(0, Math.floor((c.w - label.length) / 2));
    c.text(x, 1, label, { fg: t.bg, bg: col, b: true });
    for (let yy = 2; yy < screenH; yy++) { c.put(0, yy, '▌', { fg: col, bg: c.bg[c.idx(0, yy)], soft: true }); c.put(c.w - 1, yy, '▐', { fg: col, bg: c.bg[c.idx(c.w - 1, yy)], soft: true }); }
  }
}

function rowGlow(c: Canvas, v: StoryView, o: HudOpts, screenH: number): void {
  const t = c.theme;
  const touched = new Map(v.touched.map((r) => [r.mint, r]));
  const cursor = v.cursor;
  for (const m of c.rowMarks) {
    if (m.y >= screenH - 1) continue;
    const isCursor = cursor !== null && cursor.mint === m.key;
    const r = touched.get(m.key);
    if (!r && !isCursor) continue;
    const age = r ? o.now - r.at : Infinity;
    if (r && age < 0 && !isCursor) continue; // staggered: this row's beam has not arrived yet
    if (r && r.kind === 'trade') {
      tintRect(c, m.x, m.y, m.w, 1, t.magenta, 0.16);
      const tag = ' PAPER ◆ ';
      c.text(m.x + m.w - tag.length, m.y, tag, { fg: t.bg, bg: t.magenta, b: true });
    } else if (r && r.kind === 'scan') {
      const amt = o.reduced ? (age < 6000 ? 0.12 : 0) : 0.28 * Math.exp(-age / 1600);
      tintRect(c, m.x, m.y, m.w, 1, t.accent, amt);
      if (!o.reduced && age < 420) {
        const bx = m.x + Math.floor((age / 420) * m.w);
        for (let k = 0; k < 6; k++) tintRect(c, bx - k, m.y, 1, 1, t.accent, 0.55 * (1 - k / 6));
      }
    } else if (r && r.kind === 'vet') {
      tintRect(c, m.x, m.y, m.w, 1, t.borderFocus, 0.1);
    }
    if (isCursor) {
      const jump = o.reduced ? 0 : Math.max(0, 1 - (o.now - cursor.at) / 520);
      tintRect(c, m.x, m.y, m.w, 1, t.accent, 0.2 + 0.4 * jump);
      c.put(m.x - 1, m.y, '▶', { fg: t.accent, bg: c.bg[c.idx(Math.max(0, m.x - 1), m.y)], b: true });
      const tag = ' ◀ AGENT ';
      const slide = o.reduced ? 0 : Math.round(jump * 6);
      const tx = m.x + m.w - tag.length + slide;
      c.text(tx, m.y, tag, { fg: t.bg, bg: t.accent, b: true }, m.x + m.w - tx);
    }
  }
}

function assemble(c: Canvas, o: HudOpts, screenH: number, p: number): void {
  const t = c.theme;
  const top = 2;
  const yr = top + Math.floor(easeOut(p) * (screenH - top - 1));
  for (let y = yr + 1; y < screenH - 1; y++) {
    for (let x = 0; x < c.w; x++) {
      const i = c.idx(x, y);
      const h = hash3(x, y, Math.floor(o.now / 50)) / 4294967296;
      c.bg[i] = t.bg;
      if (h < 0.05) { c.ch[i] = KATAKANA[Math.floor(h * 997) % KATAKANA.length]; c.fg[i] = mix(t.bg, t.borderFocus, 0.35); c.at[i] = 0; }
      else { c.ch[i] = ' '; c.at[i] = 0; }
    }
  }
  tintRect(c, 0, yr, c.w, 1, t.accent, 0.55);
  if (yr > top) tintRect(c, 0, yr - 1, c.w, 1, t.accent, 0.18);
}

function vetCard(c: Canvas, v: StoryView, o: HudOpts): void {
  const t = c.theme;
  const f = v.focus!;
  const w = Math.min(46, c.w - 4);
  const larp = f.larp;
  const all = ['price', 'tape', 'chart', 'holders', 'rug', 'dev', 'larp', 'verdict'];
  let checkRows = 1;
  { let cx = 2; for (const k of all) { const n = k.length + 1; if (cx + n > w - 2) { checkRows++; cx = 2; } cx += n + 2; } }
  const h = 2 + checkRows + 1 + (larp ? 2 + Math.min(2, larp.items.length) : 0) + (f.verdict ? 1 : 0);
  const x = c.w - w - 2;
  const y = 3;
  const bg = card(c, x, y, w, h, `VETTING $${f.symbol}`, t.borderFocus, { right: fmtDur(o.now - f.since) });
  let yy = y + 1;
  // checks done, as chips
  let cx = x + 2;
  for (const k of all) {
    const done = f.checks.includes(k);
    const s = `${done ? '✓' : '·'}${k}`;
    if (cx + s.length > x + w - 2) { yy++; cx = x + 2; }
    c.text(cx, yy, s, { fg: done ? t.up : mix(bg, t.dim, 0.6), bg, b: done });
    cx += s.length + 2;
  }
  yy += 2;
  void checkRows;
  if (larp) {
    const sweep = o.reduced ? 1 : easeOut((o.now - larp.at) / 750);
    const max = 6;
    const target = Math.min(max, larp.flags) / max;
    const gw = Math.max(8, w - 22);
    const fillN = Math.round(sweep * target * gw);
    const gcol = larp.flags === 0 ? t.up : larp.flags <= 2 ? t.warn : t.down;
    let gx = c.text(x + 2, yy, 'LARP ', { fg: t.muted, bg, b: true });
    gx = c.text(gx, yy, '▕', { fg: t.dim, bg });
    for (let i = 0; i < gw; i++) {
      const on = i < fillN;
      const zone = i / gw < 1 / 6 ? t.up : i / gw < 3 / 6 ? t.warn : t.down;
      c.put(gx + i, yy, on ? '█' : '░', { fg: on ? mix(zone, '#ffffff', i === fillN - 1 && sweep < 1 ? 0.5 : 0) : mix(bg, t.dim, 0.45), bg, soft: true });
    }
    gx = c.text(gx + gw, yy, '▏', { fg: t.dim, bg });
    c.text(gx + 1, yy, `${larp.flags} flag${larp.flags === 1 ? '' : 's'}`, { fg: gcol, bg, b: true });
    yy++;
    if (sweep >= 1) for (const it of larp.items.slice(0, 2)) { c.text(x + 3, yy, `· ${it}`, { fg: t.muted, bg }, w - 6); yy++; }
    else yy += Math.min(2, larp.items.length);
    c.text(x + 3, yy, 'mechanical evidence, not a verdict', { fg: mix(bg, t.dim, 0.7), bg, i: true }, w - 6);
    yy++;
  }
  if (f.verdict) {
    const vc = f.verdict.label === 'WATCH' ? t.up : f.verdict.label === 'AVOID' ? t.down : t.warn;
    let vx = c.text(x + 2, yy, 'VERDICT ', { fg: t.muted, bg, b: true });
    vx = c.text(vx, yy, ` ${f.verdict.label} `, { fg: t.bg, bg: vc, b: true });
    if (f.verdict.rug != null) c.text(vx + 1, yy, `rug heuristic ${(f.verdict.rug * 100).toFixed(0)}%`, { fg: t.muted, bg });
  }
}

function ticketCard(c: Canvas, v: StoryView, arc: TradeArc, o: HudOpts, screenH: number): void {
  const t = c.theme;
  const w = Math.min(64, c.w - 4);
  const h = 11;
  const x = Math.min(c.w - w - 2, Math.floor((c.w - w) / 2) + Math.floor(c.w / 8));
  const y = Math.max(2, Math.floor((screenH - h) / 2) - 2);
  const fill = arc.fills.find((f) => f.side === 'buy') ?? null;
  const filled = arc.stage === 'open' && fill !== null;
  const refused = arc.stage === 'refused';
  const col = refused ? t.down : filled ? t.up : t.meteora;
  const bg = card(c, x, y, w, h, 'PAPER ORDER TICKET', col, { double: true, right: refused ? 'REFUSED' : filled ? 'FILLED' : arc.sizeUsd != null ? 'SIZED' : 'OPEN', rightColor: col });
  const lines: Array<[string, string, Hex]> = [
    ['SIDE', `BUY  $${arc.symbol}`, t.text],
    ['SIZE', arc.sizeUsd != null ? `$${arc.sizeUsd.toFixed(2)}${v.caps ? `   cap $${v.caps.perTradeUsd.toFixed(2)}/trade · $${v.caps.totalUsd.toFixed(0)} total` : ''}` : 'sizing…', arc.sizeUsd != null ? t.text : t.dim],
    ['GATE', 'YOUR keypress armed the mandate · tier hands-free', t.muted],
    ['', 'no keypress per trade inside it · desk enforces caps', mix(bg, t.dim, 0.85)],
    // task-1537: the fill reads as the market cap it filled at when the HUD's cap scale knows the supply (like the position card)
    ['ENTRY', fill ? `${Math.abs(fill.sol).toFixed(4)} SOL → ${fmtQty(fill.qty)} $${arc.symbol}${fill.priceUsd != null ? ` @ ${((sc) => (sc ? `MC ${fmtCompactUsd(fill.priceUsd * sc)}` : `$${fmtPx(fill.priceUsd)}`))(o.mcapScale?.(arc.mint) ?? null)}` : ''}` : refused ? '—' : 'awaiting confirm · fresh quote at fill', fill ? t.text : t.dim],
    ['IMPACT', fill?.impactPct != null ? `${fill.impactPct.toFixed(2)}%${v.caps?.maxPriceImpactPct != null ? `   max ${v.caps.maxPriceImpactPct}%` : ''}` : '—', t.muted],
    ['EXITS', 'agent-managed · no resting orders on PAPER', t.muted],
  ];
  const t0 = arc.openedAt;
  lines.forEach(([k, val, fg], i) => {
    const appear = o.reduced ? Infinity : o.now - (t0 + i * 110);
    if (appear < 0) return;
    const yy = y + 1 + i;
    c.text(x + 2, yy, k, { fg: col, bg, b: true });
    const revealed = o.reduced ? val.length : Math.floor(appear / 9);
    if (revealed >= val.length) c.text(x + 10, yy, val, { fg, bg, b: k === 'SIDE' || (k === 'ENTRY' && !!fill) }, w - 12);
    else decryptText(c, x + 10, yy, val, revealed, Math.floor(o.now / 33), { fg, bg }, w - 12);
  });
  const sy = y + h - 2;
  if (refused) {
    const s = ` ✗ REFUSED BY THE DESK · ${arc.refusal ?? 'refused'} `;
    c.text(x + Math.max(2, Math.floor((w - s.length) / 2)), sy, s, { fg: '#ffffff', bg: t.down, b: true }, w - 4);
  } else if (filled) {
    const age = o.now - (arc.filledAt ?? o.now);
    const blink = o.reduced || age > 700 || Math.floor(age / 140) % 2 === 0;
    const s = ' ✔ FILLED · PAPER · simulated ledger ';
    if (blink) c.text(x + Math.floor((w - s.length) / 2), sy, s, { fg: t.bg, bg: t.up, b: true });
  } else {
    const s = arc.sizeUsd != null ? '◌ waiting for the agent to confirm' : '◌ the agent is sizing';
    const pulse = o.reduced ? 0.8 : 0.5 + 0.5 * Math.sin(o.now / 180);
    c.text(x + Math.floor((w - s.length) / 2), sy, s, { fg: mix(bg, t.meteora, pulse), bg });
  }
}

/**
 * task-1483: where the arc's fills sit on the PnL trace: the column of the first sample at or after the fill (the sample
 * that first reflects it). A fill before the first SHOWN sample when older samples were cut off, or after the last
 * sample, gets no column (it is not moved onto another one). Columns are 0-based into `shownT`.
 */
export function traceFillCols(allT: readonly number[], shownFrom: number, fills: readonly { t: number; side: 'buy' | 'sell' }[]): Array<{ col: number; side: 'buy' | 'sell'; count: number }> {
  const by = new Map<string, { col: number; side: 'buy' | 'sell'; count: number }>();
  for (const f of fills) {
    const i = allT.findIndex((t) => t >= f.t);
    if (i < 0 || i < shownFrom) continue;
    const key = `${i}|${f.side}`;
    const e = by.get(key);
    if (e) e.count++; else by.set(key, { col: i - shownFrom, side: f.side, count: 1 });
  }
  return [...by.values()].sort((a, b) => a.col - b.col);
}

function positionCard(c: Canvas, v: StoryView, arc: TradeArc, o: HudOpts, screenH: number): void {
  const t = c.theme;
  const w = Math.min(62, c.w - 4);
  const h = 11;
  const x = c.w - w - 2;
  const y = Math.max(2, screenH - h - 2);
  const p = arc.pnlPct;
  const col = p === null ? t.muted : p >= 0 ? t.up : t.down;
  const exits = arc.fills.filter((f) => f.side === 'sell');
  const lastExit = exits.at(-1);
  const exitFresh = lastExit && o.now - lastExit.t < 2600;
  const bg = card(c, x, y, w, h, `PAPER POSITION · $${arc.symbol}`, t.magenta, { right: exitFresh ? 'EXITING' : 'HOLDING', rightColor: exitFresh ? t.ai : t.magenta });
  // the big number: the mark PnL of the open size, ticking with the app's mark price
  const big = p === null ? '--' : signPct(p);
  const tick = arc.mark && !o.reduced ? Math.max(0, 1 - (o.now - arc.mark.at) / 350) : 0;
  bigText(c, x + 2, y + 1, big, mix(col, '#ffffff', tick * 0.45), bg);
  const sx = x + 3 + bigTextWidth(big);
  c.text(sx, y + 1, 'MARK PnL', { fg: t.dim, bg });
  if (arc.peakPct !== null) c.text(sx, y + 2, `peak ${signPct(arc.peakPct)}`, { fg: arc.peakPct >= 0 ? t.up : t.down, bg });
  c.text(sx, y + 3, `held ${fmtDur(o.now - (arc.filledAt ?? o.now))}`, { fg: t.muted, bg });
  if (exits.length) c.text(sx, y + 4, `exits ${exits.length} · ${signSol(exits.reduce((s, e) => s + (e.realizedSol ?? 0), 0))}`, { fg: t.ai, bg }, x + w - 2 - sx);
  // the trace: one cell per sample, zero line dotted
  const tw = w - 4;
  const tr = arc.trace.slice(-tw);
  if (tr.length > 1) {
    const lo = Math.min(0, ...tr.map((s) => s.pct)), hi = Math.max(0, ...tr.map((s) => s.pct));
    const span = hi - lo || 1;
    const LV = '▁▂▃▄▅▆▇█';
    tr.forEach((s, i) => {
      const lv = Math.round(((s.pct - lo) / span) * 7);
      c.put(x + 2 + i, y + 6, LV[lv], { fg: s.pct >= 0 ? t.up : t.down, bg, soft: true });
    });
    // task-1483: the agent's PAPER fills under the trace (△B / ▽S, hollow = paper), at the sample that first shows them
    const used = new Set<number>();
    for (const m of traceFillCols(arc.trace.map((s) => s.t), arc.trace.length - tr.length, arc.fills)) {
      const cx = x + 2 + m.col;
      if (used.has(m.col) || used.has(m.col + 1) || cx + 1 >= x + w - 1) continue;
      used.add(m.col); used.add(m.col + 1);
      const col = m.side === 'buy' ? t.up : t.down;
      c.text(cx, y + 7, `${markerGlyph(m.side, 'paper')}${markerLetter(m.side)}`, { fg: col, bg: mix(bg, col, 0.2), b: true, hard: true });
    }
  } else c.text(x + 2, y + 6, '· waiting for the first mark tick', { fg: t.dim, bg });
  // task-1472: with the chart axis on market cap and a known supply, entry/mark read MC (compact k/M/B), like the charts
  const sc = o.mcapScale?.(arc.mint) ?? null;
  const px = (p: number): string => (sc ? `MC ${fmtCompactUsd(p * sc)}` : `$${fmtPx(p)}`);
  const entry = arc.entryUsd !== null ? `entry ${px(arc.entryUsd)}` : 'entry —';
  const mark = arc.mark ? `mark ${px(arc.mark.priceUsd)}` : 'mark —';
  c.text(x + 2, y + 8, `${entry} · ${mark} · ${arc.spentSol.toFixed(4)} SOL in`, { fg: t.muted, bg }, w - 4);
  c.text(x + 2, y + 9, 'mark = the app\'s live price · PAPER · simulated', { fg: mix(bg, t.dim, 0.7), bg, i: true }, w - 4);
  // a desk refusal while holding (paused / stopped / a cap): said on the panel, in red, for a few seconds
  const refusedFresh = arc.refusal && v.beats.refusedAt !== null && o.now - v.beats.refusedAt < 3500;
  if (refusedFresh && !exitFresh) {
    const s = ` ✗ REFUSED BY THE DESK · ${arc.refusal} `;
    c.text(x + w - s.length - 2, y + 6, s, { fg: '#ffffff', bg: t.down, b: true });
  }
  if (exitFresh) {
    const s = ` SOLD ${fmtQty(lastExit!.qty)} · ${signSol(lastExit!.sol)} `;
    c.text(x + w - s.length - 2, y + 6, s, { fg: t.bg, bg: (lastExit!.realizedSol ?? 0) >= 0 ? t.meteora : t.down, b: true });
  }
}

function resultCard(c: Canvas, arc: TradeArc, o: HudOpts, screenH: number): void {
  const t = c.theme;
  const r = arc.result!;
  const win = r.realizedSol >= 0;
  const col = win ? t.up : t.down;
  const age = o.now - (arc.closedAt ?? o.now);
  const w = Math.min(64, c.w - 4);
  const h = 12;
  const x = Math.floor((c.w - w) / 2);
  const y = Math.max(2, Math.floor((screenH - h) / 2));
  if (!o.reduced && age < 220) {
    // the card opens from a line
    const half = Math.max(1, Math.floor((w / 2) * easeOut(age / 220)));
    c.hline(Math.floor(c.w / 2) - half, y + Math.floor(h / 2), half * 2, { fg: col, bg: c.bg[c.idx(Math.floor(c.w / 2), y + Math.floor(h / 2))], b: true }, '━');
    return;
  }
  const bg = card(c, x, y, w, h, `PAPER RESULT · $${arc.symbol}`, col, { double: true, right: win ? 'CLOSED GREEN' : 'CLOSED RED', fill: 0.1 });
  const big = r.pct === null ? signSol(r.realizedSol) : signPct(r.pct);
  const bw = bigTextWidth(big);
  bigText(c, x + Math.floor((w - bw) / 2), y + 2, big, col, bg);
  const l1 = `${signSol(r.realizedSol)} realized · held ${fmtDur(r.holdMs)} · ${r.exits} exit${r.exits === 1 ? '' : 's'}${arc.peakPct !== null ? ` · peak ${signPct(arc.peakPct)}` : ''}`;
  c.textC(x + 1, y + 8, w - 2, l1, { fg: t.text, bg, b: true });
  c.textC(x + 1, y + 9, w - 2, 'simulated paper trade · not a result · not advice', { fg: mix(bg, t.dim, 0.8), bg, i: true });
}

function killCut(c: Canvas, v: StoryView, o: HudOpts, screenH: number, age: number): void {
  const t = c.theme;
  if (!o.reduced && age < 140) {
    tintRect(c, 0, 0, c.w, screenH, t.down, 0.5, 0.3);
  } else if (!o.reduced && age < 820) {
    // glitch: rows slip sideways, colour drains, red bars cut through
    const f = Math.floor(age / 40);
    for (let y = 0; y < screenH; y++) {
      const h = hash3(y, f, 77) / 4294967296;
      if (h < 0.3) {
        const shift = Math.floor((hash3(y, f, 11) / 4294967296) * 9) - 4;
        const row = c.ch.slice(y * c.w, (y + 1) * c.w);
        for (let x = 0; x < c.w; x++) c.ch[c.idx(x, y)] = row[(x - shift + c.w) % c.w];
      }
      tintRect(c, 0, y, c.w, 1, t.bg, 0.45, 0.55);
      if (h > 0.93) tintRect(c, 0, y, c.w, 1, t.down, 0.55);
    }
  } else {
    tintRect(c, 0, 0, c.w, screenH, t.bg, 0.55, 0.62);
  }
  if (o.reduced || age >= 140) {
    const word = 'KILLED';
    const bw = bigTextWidth(word);
    const w = Math.min(c.w - 4, Math.max(bw + 8, 64));
    const h = 11;
    const x = Math.floor((c.w - w) / 2);
    const y = Math.max(1, Math.floor((screenH - h) / 2));
    const bg = card(c, x, y, w, h, 'AGENT STOPPED', t.down, { double: true, fill: 0.16 });
    bigText(c, x + Math.floor((w - bw) / 2), y + 2, word, t.down, bg);
    c.textC(x + 1, y + 8, w - 2, `${v.agent} · session closed · agent paper desk stopped`, { fg: t.text, bg, b: true });
    c.textC(x + 1, y + 9, w - 2, 'you are driving · restart to let an agent in again', { fg: t.muted, bg });
  }
}

/**
 * Whether the HUD has motion to show right now (the frame loop then paints at full fps instead of the idle stride):
 * the agent called in the last 20 s, a PAPER position is open, a result / kill is on screen, or a line is typing.
 */
export function hudAnimating(v: StoryView, now: number): boolean {
  if (v.control === 'killed') return now - v.controlAt < 5000;
  if (v.control !== 'running') return false;
  if (v.arc && (v.arc.stage === 'open' || (v.arc.closedAt !== null && now - v.arc.closedAt < 10_000))) return true;
  if (v.lastCallAt !== null && now - v.lastCallAt < 20_000) return true;
  const last = v.thoughts[v.thoughts.length - 1];
  return !!last && now - last.t < 8000;
}

/** Compose: the app's frame rendered `screenH` rows tall on top, the dock below, overlays over the screen. */
export function composeHud(full: Canvas, screen: Canvas, v: StoryView, o: HudOpts): Canvas {
  const n = screen.w * screen.h;
  for (let i = 0; i < n; i++) {
    full.ch[i] = screen.ch[i]; full.fg[i] = screen.fg[i]; full.bg[i] = screen.bg[i]; full.at[i] = screen.at[i];
    full.hard[i] = screen.hard[i]; full.zone[i] = screen.zone[i]; full.shield[i] = screen.shield[i];
  }
  full.images = screen.images.slice();
  full.rowMarks = screen.rowMarks.slice();
  full.headings = screen.headings.slice();
  full.shields = screen.shields.slice();
  full.imageMode = screen.imageMode;
  if (full.h >= HUD_MIN_H) renderAgentOverlays(full, v, o, screen.h);
  renderAgentDock(full, v, o, screen.h);
  return full;
}
