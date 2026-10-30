// dexterm — NARRATIVE BOARD screen (key N, task-1356; AI-SUITE-DESIGN §7). What is running and what is
// working across the tokens dexterm has recorded: deterministic lexicon clustering, per-narrative volume /
// new launches / runners / pace / "what is working" score. No model in the hot path; the board carries
// its own limits (name-based, X/TG-only narratives missed, honest unclassified share). w flips 1h/24h,
// M opens the HUD popup. The board is computed in state.ts (computeNarrativeView) on entry and the tick.
// task-1818: `n` flips to the EXPERIMENTAL heat table (@dexterm/narratives: clustered by what the name says,
// lifecycle + traction score per narrative); ⏎ drills into one narrative's member coins, esc returns to the table.
import { Canvas, header, footer, badge, breakpoint, type Hex } from '@dexterm/tui';
import type { AppState } from '../state.ts';
import { headerModel } from '../state.ts';
import { clean, type NarrativeBoard, type NarrativeStat } from '@dexterm/packs';
import { HEAT_NOTE, type Lifecycle, type NarrativeSnapshot } from '@dexterm/narratives';
import { heatRows, drillDetail, currentTracker, narrativesSource, UNTRUSTED_NOTE } from '../narratives.ts';

const fmtUsd = (v: number | null): string => { if (v == null) return '—'; const a = Math.abs(v); if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B'; if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M'; if (a >= 1e3) return (v / 1e3).toFixed(1) + 'K'; return v.toFixed(0); };
const fmtPct = (v: number | null): string => (v == null ? '—' : (v > 0 ? '+' : '') + v.toFixed(1) + '%');

export function renderNarrative(c: Canvas, state: AppState): void {
  if (state.narrativesUi?.mode === 'heat') { if (state.narrativesUi.drill) renderDrill(c, state); else renderHeat(c, state); return; }
  const t = c.theme;
  const bp = breakpoint(c.w);
  header(c, headerModel(state));
  const view = state.narrative ?? null;
  const board: NarrativeBoard | null = view?.board ?? null;
  const top = 2, bottom = c.h - 1;
  const win = view?.window ?? '1h';
  const srcLabel = view?.source === 'recorded' ? 'recorded history' : view?.source === 'screen' ? 'visible rows' : 'no data';
  const title = `NARRATIVE BOARD · ${win} · ${board ? `${board.meta.tokens_total} tokens · ${(100 * board.meta.unclassified_share).toFixed(0)}% unclassified` : srcLabel}`;
  const caption = bp === 'compact' ? undefined : `model output: none (deterministic lexicon v${board?.meta.lexicon_version ?? '—'}) · name-based · source: ${srcLabel}`;
  const box = c.box(0, top, c.w, bottom - top, { title, caption, focus: true });
  const bg: Hex = box.bg;

  if (!board || board.narratives.every((n) => n.tokens === 0)) {
    c.textC(box.x, box.y + 1, box.w, 'collecting narratives — run the app with the recorder on, or open the screener first', { fg: t.muted, bg, i: true });
    c.textC(box.x, box.y + 3, box.w, view?.error ? `(${view.error})` : 'clusters come from token names against a lexicon (owner: maintainers); X/Telegram-only narratives are missed', { fg: t.dim, bg });
    footer(c, [['w', '1h/24h'], ['n', 'narratives (exp)'], ['esc', 'back'], ['q', 'quit']], t.name);
    return;
  }

  const shown = board.narratives.filter((n) => n.tokens > 0);
  const sel = Math.max(0, Math.min(shown.length - 1, state.selected ?? 0));
  // column header
  let cy = box.y;
  const wide = bp !== 'compact';
  c.text(box.x + 1, cy, '#', { fg: t.dim, bg });
  c.text(box.x + 4, cy, 'NARRATIVE', { fg: t.dim, bg });
  c.text(box.x + 22, cy, 'TOK', { fg: t.dim, bg });
  c.text(box.x + 28, cy, 'NEW 1h/24h', { fg: t.dim, bg });
  c.text(box.x + 40, cy, `VOL ${win}`, { fg: t.dim, bg });
  c.text(box.x + 50, cy, 'PACE', { fg: t.dim, bg });
  c.text(box.x + 57, cy, 'MED1h', { fg: t.dim, bg });
  c.text(box.x + 65, cy, 'SCORE', { fg: t.dim, bg });
  if (wide) c.text(box.x + 72, cy, 'TOP RUNNER (liq≥$10K)', { fg: t.dim, bg });
  cy += 1;
  c.hline(box.x, cy, box.w, { fg: t.border, bg }); cy += 1;

  let rank = 0;
  const scroll = Math.max(0, sel - (box.h - 6));
  for (let i = scroll; i < shown.length; i++) {
    if (cy >= box.y + box.h - 2) break;
    const n: NarrativeStat = shown[i];
    if (n.score != null) rank++;
    const selected = i === sel;
    const rb = selected ? t.selBg : bg;
    c.fill(box.x, cy, box.w, 1, ' ', { bg: rb });
    if (selected) c.put(box.x, cy, '▎', { fg: t.accent, bg: rb, soft: true });
    c.text(box.x + 1, cy, n.score == null ? '·' : String(rank), { fg: n.score == null ? t.dim : t.accent, bg: rb, b: true });
    c.text(box.x + 4, cy, n.narrative, { fg: n.narrative === 'unclassified' ? t.dim : selected ? t.borderFocus : t.text, bg: rb, b: n.score != null }, 17);
    c.text(box.x + 22, cy, String(n.tokens), { fg: t.text, bg: rb });
    c.text(box.x + 28, cy, `${n.new_1h}/${n.new_24h}`, { fg: t.muted, bg: rb });
    c.text(box.x + 40, cy, fmtUsd(win === '24h' ? n.vol_h24 : n.vol_h1), { fg: t.text, bg: rb });
    c.text(box.x + 50, cy, n.pace_mature != null ? n.pace_mature.toFixed(1) + 'x' : n.pace == null ? '—' : n.pace.toFixed(1) + '*', { fg: t.muted, bg: rb });
    const med = win === '24h' ? n.med_chg_h24 : n.med_chg_h1;
    c.text(box.x + 57, cy, fmtPct(med), { fg: med == null ? t.dim : med >= 0 ? t.up : t.down, bg: rb });
    c.text(box.x + 65, cy, n.score == null ? '—' : n.score.toFixed(0), { fg: n.score == null ? t.dim : t.accent, bg: rb, b: true });
    if (wide) {
      const r = n.runners[0];
      if (r) {
        let cx = c.text(box.x + 72, cy, r.symbol, { fg: t.text, bg: rb }, 12);
        cx = c.text(cx + 1, cy, fmtPct(r.chg_h1), { fg: (r.chg_h1 ?? 0) >= 0 ? t.up : t.down, bg: rb });
        c.text(cx + 1, cy, fmtUsd(r.mcap), { fg: t.muted, bg: rb });
      } else c.text(box.x + 72, cy, '—', { fg: t.dim, bg: rb });
    }
    cy += 1;
  }
  // limits line
  const ly = box.y + box.h - 1;
  if (wide) c.textC(box.x, ly, box.w, `model output: none (deterministic lexicon v${board.meta.lexicon_version}) · ${board.meta.copycat_tokens} copycat symbols · name-based · pace '*' = all tokens · compute ${board.meta.compute_ms}ms`, { fg: t.dim, bg });

  footer(c, [['↑↓', 'move'], ['w', win === '1h' ? '→24h' : '→1h'], ['n', 'narratives (exp)'], ['M', 'popup'], ['esc', 'back'], ['q', 'quit']], t.name);
}

// ---- task-1818 EXPERIMENTAL heat table + drill-down ------------------------------------------------------------
const heatUsd = (v: number | null | undefined): string => (v == null ? '—' : '$' + fmtUsd(v));
const fmtShare = (v: number | null | undefined): string => (v == null ? '—' : (v * 100).toFixed(1) + '%');
const fmtX = (v: number | null | undefined): string => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(2) + 'x');
function lcColor(t: Canvas['theme'], lc: Lifecycle): Hex {
  // states are measured heat, so none is painted as a market up/down colour (no green "go")
  return lc === 'ignition' ? t.accent : lc === 'peak' ? t.text : lc === 'fading' ? t.warn : lc === 'dead' ? t.dim : t.muted;
}

/** The limits line: the full HEAT_NOTE when it fits, else the short form (the note must never be the part that is cut). */
function limitsLine(w: number, extra: string): string {
  const full = `${HEAT_NOTE} · ${UNTRUSTED_NOTE} · ${extra}`;
  return full.length <= w ? full : `measured heat, not advice · ${UNTRUSTED_NOTE} · ${extra}`;
}

/** The status line under an empty heat table: building (with the one-time stall warning), failed, or nothing yet. */
function heatPlaceholder(state: AppState): [string, string] {
  const ui = state.narrativesUi;
  const rec = narrativesSource(state) === 'recorded';
  if (ui?.error) return [`narratives failed: ${clean(ui.error, 120)}`, 'the theme board (v) still works'];
  if (!currentTracker(state)) return [rec ? 'building narratives from recorded history…' : 'building narratives from the visible rows…',
    rec ? 'first build reads the last 26 h of the recorder: tens of seconds, the screen stays live (once per run)' : 'no recorder DB here (fixtures / replay): no history, so every narrative starts as a spark'];
  return ['no narrative with 2+ coins yet', 'a narrative needs at least two coins whose names share a theme · measured heat, not advice'];
}

function renderHeat(c: Canvas, state: AppState): void {
  const t = c.theme;
  const bp = breakpoint(c.w);
  header(c, headerModel(state));
  const ui = state.narrativesUi!;
  const rows: NarrativeSnapshot[] = heatRows(state);
  const tr = currentTracker(state);
  const src = narrativesSource(state) === 'recorded' ? 'recorded history' : 'visible rows';
  const top = 2, bottom = c.h - 1;
  const title = `NARRATIVES · EXPERIMENTAL · ${tr ? `${rows.length} narratives · ${tr.coins.size} coins` : 'building'} · ${src}${ui.busy && tr ? ' · refreshing' : ''}`;
  const caption = bp === 'compact' ? undefined : 'measured heat, not advice';
  const box = c.box(0, top, c.w, bottom - top, { title, caption, focus: true });
  const bg: Hex = box.bg;
  const keys: Array<[string, string]> = [['↑↓', 'move'], ['⏎', 'drill'], ['n', 'theme board'], ['esc', 'back'], ['q', 'quit']];
  if (!rows.length) {
    const [a, b] = heatPlaceholder(state);
    c.textC(box.x, box.y + 1, box.w, a, { fg: t.muted, bg, i: true });
    c.textC(box.x, box.y + 3, box.w, b, { fg: t.dim, bg });
    c.textC(box.x, box.y + 5, box.w, HEAT_NOTE, { fg: t.dim, bg });
    footer(c, keys, t.name);
    return;
  }
  const sel = Math.max(0, Math.min(rows.length - 1, ui.selected));
  // columns: [x, header]; a column that does not fit the box is dropped (the runner first)
  const cols: Array<[number, string, number]> = [[1, '#', 3], [5, 'NARRATIVE', 18], [24, 'THEME', 12], [37, 'STATE', 10], [48, 'COINS', 5], [54, 'NEW/h', 5], [60, 'VOL 1h', 9], [70, 'SHARE', 6], [77, 'TRADERS', 7], [85, 'SCORE', 5], [91, 'TOP RUNNER (x · drawdown)', 28]];
  const fits = (i: number): boolean => cols[i][0] + Math.min(cols[i][2], 12) <= box.w - 1;
  let cy = box.y;
  cols.forEach(([x, h], i) => { if (fits(i)) c.text(box.x + x, cy, h, { fg: t.dim, bg }, box.w - x - 1); });
  cy += 1;
  c.hline(box.x, cy, box.w, { fg: t.border, bg }); cy += 1;
  const scroll = Math.max(0, sel - (box.h - 6));
  for (let i = scroll; i < rows.length; i++) {
    if (cy >= box.y + box.h - 2) break;
    const s = rows[i]; const w1 = s.windows['1h'];
    const selected = i === sel;
    const rb = selected ? t.selBg : bg;
    c.fill(box.x, cy, box.w, 1, ' ', { bg: rb });
    if (selected) c.put(box.x, cy, '▎', { fg: t.accent, bg: rb, soft: true });
    const cell = (k: number, v: string, st: { fg: Hex; b?: boolean }): void => { if (fits(k)) c.text(box.x + cols[k][0], cy, v, { ...st, bg: rb }, Math.min(cols[k][2], box.w - cols[k][0] - 1)); };
    cell(0, s.rank == null ? '·' : String(s.rank), { fg: s.rank == null ? t.dim : t.accent, b: true });
    cell(1, clean(s.label, 18), { fg: selected ? t.borderFocus : t.text, b: s.rank != null });
    cell(2, s.theme ? clean(s.theme, 12) : '—', { fg: t.muted });
    cell(3, s.lifecycle + (s.saturated ? '*' : ''), { fg: lcColor(t, s.lifecycle), b: s.lifecycle === 'ignition' });
    cell(4, String(s.members), { fg: t.text });
    cell(5, w1.newPerHour.toFixed(0), { fg: t.muted });
    cell(6, heatUsd(w1.volume), { fg: t.text });
    cell(7, fmtShare(w1.volumeShare), { fg: t.muted });
    cell(8, String(w1.traders), { fg: t.muted });
    cell(9, String(s.score), { fg: t.accent, b: true });
    const r = s.topRunner;
    cell(10, r ? `${clean(r.symbol, 10)} ${fmtX(r.x)} · ${r.drawdownPct.toFixed(0)}%` : '—', { fg: r ? t.text : t.dim });
    cy += 1;
  }
  c.textC(box.x, box.y + box.h - 1, box.w, limitsLine(box.w, '* = copy-cat saturated'), { fg: t.dim, bg });
  footer(c, keys, t.name);
}

function renderDrill(c: Canvas, state: AppState): void {
  const t = c.theme;
  header(c, headerModel(state));
  const ui = state.narrativesUi!;
  const d = drillDetail(state);
  const top = 2, bottom = c.h - 1;
  const keys: Array<[string, string]> = [['↑↓', 'move'], ['⏎', 'open coin'], ['esc', 'table'], ['q', 'quit']];
  if (!d) {
    const box = c.box(0, top, c.w, bottom - top, { title: 'NARRATIVE · EXPERIMENTAL', focus: true });
    c.textC(box.x, box.y + 1, box.w, 'this narrative is no longer tracked (esc returns to the table)', { fg: t.muted, bg: box.bg, i: true });
    footer(c, keys, t.name);
    return;
  }
  const w1 = d.windows['1h'];
  const title = `NARRATIVE · ${clean(d.label, 24)} · ${d.lifecycle}${d.saturated ? ' · copy-cat saturated' : ''} · ${d.memberList.length} coin${d.memberList.length === 1 ? '' : 's'} · EXPERIMENTAL`;
  const box = c.box(0, top, c.w, bottom - top, { title, caption: 'measured heat, not advice · members in spawn order', focus: true });
  const bg: Hex = box.bg;
  let cy = box.y;
  c.text(box.x + 1, cy, `lifecycle rule (${d.lifecycle}): ${d.lifecycleRule}`, { fg: lcColor(t, d.lifecycle), bg }, box.w - 2); cy += 1;
  c.text(box.x + 1, cy, `1h: vol ${heatUsd(w1.volume)} · share ${fmtShare(w1.volumeShare)} · new/h ${w1.newPerHour.toFixed(0)} · traders ${w1.traders} · score ${d.score}${d.rank ? ` · rank ${d.rank}` : ''}${d.theme ? ` · theme ${clean(d.theme, 16)}` : ''}`, { fg: t.muted, bg }, box.w - 2); cy += 1;
  const cols: Array<[number, string, number]> = [[1, '#', 4], [6, 'SYMBOL', 12], [19, 'NAME', 26], [46, 'X SINCE 1ST', 11], [58, 'LIQ', 9], [68, 'VOL 1h', 9]];
  const fits = (i: number): boolean => cols[i][0] + Math.min(cols[i][2], 8) <= box.w - 1;
  cols.forEach(([x, h], i) => { if (fits(i)) c.text(box.x + x, cy, h, { fg: t.dim, bg }); });
  cy += 1;
  c.hline(box.x, cy, box.w, { fg: t.border, bg }); cy += 1;
  const n = d.memberList.length;
  const sel = Math.max(0, Math.min(n - 1, ui.drill!.selected));
  const scroll = Math.max(0, sel - (box.h - 8));
  for (let i = scroll; i < n; i++) {
    if (cy >= box.y + box.h - 1) break;
    const m = d.memberList[i];
    const selected = i === sel;
    const rb = selected ? t.selBg : bg;
    c.fill(box.x, cy, box.w, 1, ' ', { bg: rb });
    if (selected) c.put(box.x, cy, '▎', { fg: t.accent, bg: rb, soft: true });
    const cell = (k: number, v: string, fg: Hex): void => { if (fits(k)) c.text(box.x + cols[k][0], cy, v, { fg, bg: rb }, Math.min(cols[k][2], box.w - cols[k][0] - 1)); };
    cell(0, `#${m.spawn}`, t.dim);
    cell(1, clean(m.symbol, 12), selected ? t.borderFocus : t.text);
    cell(2, clean(m.name, 26), t.muted);
    cell(3, fmtX(m.x), m.x == null ? t.dim : m.x >= 1 ? t.up : t.down);
    cell(4, heatUsd(m.liq), t.text);
    cell(5, heatUsd(m.vol1h), t.text);
    cy += 1;
  }
  c.textC(box.x, box.y + box.h - 1, box.w, limitsLine(box.w, 'x = now vs first $10K+ pool price'), { fg: t.dim, bg });
  footer(c, keys, t.name);
}
