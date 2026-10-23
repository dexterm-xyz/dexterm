// dexterm — AUTOTRADE (paper) screen renderer (`Q`, task-1508, AUTOTRADE-SPEC §2b): strategies, editor, compare,
// backtest and runner views over AutotradeUi (autotrade-ui.ts). Read-only drawing; the verbs live in
// autotrade-keys.ts. Every view says PAPER; no view offers live mode, a wallet, a key or the signer.

import { Canvas, header, footer, breakpoint, fmtAgeSec, sparkline, wrap, type Hex, type Hint } from '@dexterm/tui';
import { compareRows as fleetCompareRows, compareTable as fleetCompareTable, fleetTotals, type BacktestReport, type ExitProfile, type SweepRow } from '@dexterm/autotrade';
import { tokenize } from '../screener/filter.ts';
import type { AppState } from '../state.ts';
import { headerModel } from '../state.ts';
import {
  AUTOTRADE_VIEWS, VIEW_TITLE, READ_ONLY_PATHS, backtestSubject, compareRows, getAt, heartbeatStale, issuesByField, screenHighlight,
  type AutotradeUi, type StrategyProposal,
} from './autotrade-ui.ts';

/** Per-screen memo of file reads + validation, keyed by what the list says about a strategy (id, hash, version,
 *  last backtest): a frame never re-reads a strategy file; a save, import or backtest reloads the list and so the key. */
const MEMO = new WeakMap<AutotradeUi, Map<string, unknown>>();
function memo<T>(ui: AutotradeUi, key: string, f: () => T): T {
  let m = MEMO.get(ui);
  if (!m) { m = new Map(); MEMO.set(ui, m); }
  if (!m.has(key)) { if (m.size > 32) m.clear(); m.set(key, f()); }
  return m.get(key) as T;
}
const entryKey = (ui: AutotradeUi, id: string): string => { const e = ui.entries.find((x) => x.id === id); return e ? `${e.id}|${e.source}|${e.hash ?? ''}|${e.version ?? ''}|${e.lastBacktest?.t ?? ''}|${e.ok}` : `${id}|missing`; };

function fit(s: string, w: number): string { return w <= 0 ? '' : s.length > w ? (w > 1 ? s.slice(0, w - 1) + '…' : s.slice(0, w)) : s; }
const usd = (x: number): string => `${x >= 0 ? '+' : '-'}$${Math.abs(x).toFixed(2)}`;
const pct = (x: number | null | undefined, dp = 1): string => (x === null || x === undefined ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(dp)}%`);

export function renderAutotrade(c: Canvas, state: AppState): void {
  const t = c.theme;
  header(c, headerModel(state));
  const ui = state.autotradeUi ?? null;
  if (!ui) { c.text(1, 3, 'autotrade is not loaded', { fg: t.dim, bg: t.bg }); return; }
  const now = ui.deps.now();
  tabs(c, ui);
  const top = 3, bottom = c.h - 1;
  const area = { x: 0, y: top, w: c.w, h: bottom - top };
  if (ui.view === 'list') renderList(c, ui, area, now);
  else if (ui.view === 'editor') renderEditor(c, ui, area);
  else if (ui.view === 'compare') renderCompare(c, ui, area);
  else if (ui.view === 'backtest') renderBacktest(c, ui, area, now);
  else renderRunner(c, ui, area, now);
  if (ui.confirm) confirmCard(c);
  if (ui.review) reviewCard(c, ui);
  footer(c, hintsFor(ui), t.name);
}

/** Row 2: PAPER badge + the five views (the active one lit) + the notice / input line on the right. */
function tabs(c: Canvas, ui: AutotradeUi): void {
  const t = c.theme;
  const y = 2;
  c.fill(0, y, c.w, 1, ' ', { bg: t.bg });
  // task-1528: a live run (through the live signer) is labelled LIVE (mainnet, red) or DEVNET; everything else PAPER.
  const mode = runMode(ui);
  let x = c.text(1, y, mode === 'live' ? ' LIVE · REAL FUNDS ' : mode === 'devnet' ? ' DEVNET ' : ' PAPER ', { fg: t.bg, bg: mode === 'live' ? t.down : t.warn, b: true });
  x = c.text(x + 1, y, 'AUTOTRADE', { fg: t.accent, bg: t.bg, b: true }) + 2;
  for (const v of AUTOTRADE_VIEWS) {
    const on = ui.view === v;
    const off = (v === 'compare' && !ui.compare) || (v === 'editor' && !ui.editor);
    x = c.text(x, y, ` ${VIEW_TITLE[v]} `, { fg: on ? t.text : off ? t.dim : t.muted, bg: on ? t.tabActiveBg : t.bg, b: on }) + 1;
  }
  const line = ui.input
    ? `${ui.input.kind === 'import' ? 'import file: ' : ui.input.kind === 'dup' ? `duplicate ${ui.input.from} as: ` : `new from ${ui.input.from} as: `}${ui.input.text}█  ⏎ ok · esc cancel`
    : ui.notice;
  if (line && x < c.w - 10) c.text(x + 1, y, fit(line, c.w - x - 2), { fg: ui.input ? t.text : t.warn, bg: t.bg, i: !ui.input });
}

function hintsFor(ui: AutotradeUi): Hint[] {
  const common: Hint[] = [['esc', 'back'], ['q', 'quit']];
  if (ui.confirm) return [['y', 'flatten'], ['any key', 'cancel']];
  if (ui.review) return ui.review.stage === 'less-safe' ? [['y', 'apply (less safe)'], ['any key', 'cancel']] : [['y', ui.review.check.ok && ui.review.check.riskDelta === 'looser' ? 'apply… (less safe)' : 'apply'], ['n', 'dismiss'], ['any key', 'close']];
  if (ui.input) return [['⏎', 'ok'], ['esc', 'cancel']];
  switch (ui.view) {
    case 'list': return [['tab', 'view'], ['⏎/e', 'edit'], ['n', 'new'], ['d', 'copy'], ['c', 'compare'], ['b', 'backtest'], ['w', 'sweep'], ['x/i', 'export/import'], ['o', 'chat proposal'], ['r', 'runner'], ...common];
    case 'editor': return ui.editor?.typing
      ? [['⏎', 'set'], ['esc', 'cancel'], ['ctrl+u', 'clear']]
      : [['tab', 'view'], ['↑↓', 'field'], ['⏎', 'change'], ['s', 'save'], ['u', 'undo'], ['b', 'backtest'], ['w', 'sweep'], ...common];
    case 'compare': return [['tab', 'view'], ['↑↓', 'scroll'], ['b', 'backtest both, one tape'], ...common];
    case 'backtest': return [['tab', 'view'], ['b', 'run again'], ['w', 'sweep (held-out)'], ...common];
    default: return [['tab', 'view'], ['!', 'kill'], ['p', 'pause entries'], ['f', 'flatten (confirm)'], ...common];
  }
}

type Area = { x: number; y: number; w: number; h: number };

// ───────────────────────────── strategies ─────────────────────────────

function renderList(c: Canvas, ui: AutotradeUi, a: Area, now: number): void {
  const t = c.theme;
  const bp = breakpoint(c.w);
  const users = ui.entries.filter((e) => e.source === 'user').length;
  // the list takes the rows it needs (min 8); the selected strategy and the chat proposals get the rest
  const listH = Math.min(a.h - 10, Math.max(ui.entries.length + 3, a.h - 16));
  const lowerH = a.h - listH;
  const box = c.box(a.x, a.y, a.w, listH, {
    title: `STRATEGIES · ${ui.entries.length} (${ui.entries.length - users} presets, ${users} yours)`,
    caption: bp === 'compact' ? undefined : 'paper only · your files: ~/.dexterm/strategies · presets are read-only (d makes a copy)', focus: !ui.input,
  });
  const bg = box.bg;
  let y = box.y;
  const active = ui.runner.kind === 'ok' ? ui.runner.snap.strategy : null;
  const wide = bp !== 'compact';
  const cols = wide
    ? { mark: 1, id: 4, src: 26, mode: 34, ver: 41, hash: 50, prof: 68, last: Math.max(82, box.w - 44) }
    : { mark: 1, id: 4, src: 24, mode: 31, ver: 37, hash: -1, prof: -1, last: 45 };
  const head: Array<[number, string]> = [[cols.id, 'STRATEGY'], [cols.src, 'SOURCE'], [cols.mode, 'MODE'], [cols.ver, 'VERSION'], [cols.hash, 'HASH'], [cols.prof, 'PROFILES'], [cols.last, 'LAST BACKTEST · net · dd · n']];
  for (const [x, h] of head) if (x >= 0) c.text(box.x + x, y, h, { fg: t.dim, bg });
  y += 1;
  if (!ui.entries.length) c.text(box.x + 1, y + 1, 'no strategies found (the shipped presets should always list: reinstall if this stays empty)', { fg: t.warn, bg });
  const rows = box.h - 1;
  const scroll = Math.max(0, ui.selected - (rows - 1));
  for (let i = scroll; i < ui.entries.length && y < box.y + box.h; i++) {
    const e = ui.entries[i];
    const sel = i === ui.selected;
    const rb = sel ? t.selBg : bg;
    c.fill(box.x, y, box.w, 1, ' ', { bg: rb });
    if (sel) c.put(box.x, y, '▎', { fg: t.accent, bg: rb, soft: true });
    const running = active && active.id === e.id;
    const marked = ui.marked.includes(e.id);
    c.text(box.x + cols.mark, y, running ? '▶' : marked ? '◆' : ' ', { fg: running ? t.up : t.accent, bg: rb, b: true });
    c.text(box.x + cols.id, y, fit(e.highRisk ? `${e.id} ⚠` : e.id, cols.src - cols.id - 1), { fg: e.ok ? (e.highRisk ? t.warn : sel ? t.borderFocus : t.text) : t.down, bg: rb, b: sel });
    c.text(box.x + cols.src, y, e.source === 'preset' ? 'preset' : e.shadowsPreset ? 'yours*' : 'yours', { fg: e.source === 'preset' ? t.muted : t.accent, bg: rb });
    if (!e.ok) {
      c.text(box.x + cols.mode, y, fit(`✗ invalid: ${e.errors?.[0] ? `${e.errors[0].path || '/'} ${e.errors[0].msg}` : ''}`, box.w - cols.mode - 2), { fg: t.down, bg: rb });
      y += 1; continue;
    }
    c.text(box.x + cols.mode, y, e.mode ?? '—', { fg: e.mode === 'paper' ? t.up : t.warn, bg: rb });
    c.text(box.x + cols.ver, y, `v${e.version}`, { fg: t.muted, bg: rb });
    if (cols.hash >= 0) c.text(box.x + cols.hash, y, e.hash ?? '', { fg: t.dim, bg: rb });
    if (cols.prof >= 0) c.text(box.x + cols.prof, y, fit((e.profiles ?? []).join(' '), cols.last - cols.prof - 1), { fg: t.muted, bg: rb });
    const lb = e.lastBacktest;
    const job = e.hash ? ui.backtests.get(e.hash) : undefined;
    const last = job?.status === 'running' ? 'running…' : lb ? `${usd(lb.netUsd)} (${pct(lb.netPct)}) · ${lb.maxDrawdownPct.toFixed(1)}% · ${lb.trades}` : 'not backtested';
    c.text(box.x + cols.last, y, fit(last, box.w - cols.last - 2), { fg: lb ? (lb.netUsd >= 0 ? t.up : t.down) : t.dim, bg: rb });
    y += 1;
  }

  // lower pane: the selected strategy + chat proposals
  const ly0 = a.y + listH;
  const sel = ui.entries[ui.selected];
  const props = ui.deps.proposals();
  const half = wide ? Math.floor(a.w * 0.58) : a.w;
  const dbox = c.box(a.x, ly0, half, lowerH, { title: sel ? `${sel.id}${sel.name ? ` · ${sel.name}` : ''}` : 'no strategy', caption: running(ui) ? undefined : 'b backtests on recorded history · r shows the runner' });
  let dy = dbox.y;
  const g = sel ? memo(ui, `get:${entryKey(ui, sel.id)}`, () => ui.deps.store.get(sel.id)) : null;
  if (g?.ok) {
    const s = g.strategy;
    const line = (k: string, v: string, fg: Hex = t.text) => {
      wrap(v, dbox.w - 13).forEach((l, i) => { if (dy >= dbox.y + dbox.h) return; c.text(dbox.x + 1, dy, i ? '' : k.padEnd(10), { fg: t.dim, bg: dbox.bg }); c.text(dbox.x + 11, dy, fit(l, dbox.w - 13), { fg, bg: dbox.bg }); dy += 1; });
    };
    if (s.highRisk) line('⚠ HIGH', 'HIGH RISK: full port live (the signer sizes an entry up to the caps you set, up to the whole wallet); one rug can zero it. Experimental, not financial advice.', t.down);
    line('screen', s.entry.screen, t.accent);
    line('age', `${s.entry.ageHours.min}–${s.entry.ageHours.max ?? '∞'} h · ${s.entry.triggers.map((x) => x.kind).join(` ${s.entry.triggerMode} `)} · decide ${s.entry.decide}`);
    line('sizing', `${s.sizing.mode}${s.sizing.pct !== undefined ? ` ${s.sizing.pct}%` : s.sizing.riskPct !== undefined ? ` risk ${s.sizing.riskPct}%` : s.sizing.fixedUsd !== undefined ? ` $${s.sizing.fixedUsd}` : ''} · cap ${s.sizing.maxPctOfBankroll}% / $${s.sizing.maxUsd} · book $${s.bankroll.startUsd}`);
    line('risk', `${s.risk.maxConcurrent} open · ${s.risk.maxExposurePct}% exposure · day halt −${s.risk.dailyLossHaltPct}% · dd ½ at ${s.risk.drawdown.sizeDownAtPct}%, halt ${s.risk.drawdown.haltAtPct}% · ${s.risk.maxEntriesPerDay}/day`);
    for (const p of Object.values(s.exits.profiles)) line(p.id === s.exits.default ? 'exits ●' : 'exits', ladderSketch(p), t.muted);
    for (const w of g.warnings.slice(0, 2)) line('warning', `${w.path} ${w.msg}`, t.warn);
  } else if (g && !g.ok) {
    for (const e of g.errors.slice(0, dbox.h)) { c.text(dbox.x + 1, dy, fit(`✗ ${e.path || '/'} ${e.msg}`, dbox.w - 2), { fg: t.down, bg: dbox.bg }); dy += 1; }
  }
  if (wide) {
    const pbox = c.box(a.x + half, ly0, a.w - half, lowerH, { title: `PROPOSALS FROM CHAT · ${props.length}`, caption: 'o reviews · applied only by your keypress' });
    if (!props.length) {
      let py = pbox.y;
      for (const [txt, it] of [['none yet · ask the analyst to change a strategy and its diff card shows up here', true], ['', false], ['a model only ever proposes: it cannot switch a strategy to live, raise its own spend or apply anything', false]] as const) {
        for (const l of txt ? wrap(txt, pbox.w - 2) : ['']) { if (py >= pbox.y + pbox.h) break; c.text(pbox.x + 1, py, l, { fg: t.dim, bg: pbox.bg, i: it }); py += 1; }
      }
    } else {
      let py = pbox.y;
      for (const p of props) { py = proposalCard(c, p, pbox.x + 1, py, pbox.w - 2, pbox.y + pbox.h); if (py >= pbox.y + pbox.h) break; }
    }
  }
  void now;
}

const running = (ui: AutotradeUi): boolean => ui.runner.kind === 'ok';
/** task-1528: the running runner's mode from its rendezvous ('live' = mainnet through the live signer). */
const runMode = (ui: AutotradeUi): 'paper' | 'devnet' | 'live' => { const m = ui.runner.kind === 'ok' ? (ui.runner.snap as { mode?: string }).mode : 'paper'; return m === 'live' || m === 'devnet' ? m : 'paper'; };

/** One chat proposal card (§2a): id, hashes, the diff lines, validation, LOOSER in the warn colour. */
export function proposalCard(c: Canvas, p: StrategyProposal, x: number, y: number, w: number, maxY: number): number {
  const t = c.theme;
  const bg = c.theme.panel;
  const looser = p.riskDelta === 'looser';
  if (y < maxY) { c.text(x, y, fit(`${p.id} ${p.beforeHash} → ${p.afterHash}`, w - 10), { fg: t.text, bg, b: true }); c.textR(x, y, w, looser ? 'LOOSER' : p.riskDelta.toUpperCase(), { fg: looser ? t.warn : p.riskDelta === 'tighter' ? t.up : t.muted, bg, b: true }); y += 1; }
  for (const d of p.diff.slice(0, 4)) { if (y >= maxY) return y; c.text(x + 1, y, fit(d, w - 1), { fg: d.startsWith('+') ? t.up : d.startsWith('-') ? t.down : t.muted, bg }); y += 1; }
  if (y < maxY) { c.text(x + 1, y, fit(p.validation.ok ? `✓ valid · ${p.why}` : `✗ ${p.validation.errors[0]?.path ?? ''} ${p.validation.errors[0]?.msg ?? ''}`, w - 1), { fg: p.validation.ok ? t.dim : t.down, bg, i: true }); y += 1; }
  return y + 1;
}

/**
 * task-1507: the review card of one chat proposal (`o`). The full diff, who proposed it and why, the validation, and
 * every less-safe field when it is LOOSER. On a looser edit the first y turns the card into the "less safe" popup and
 * only a second y applies it.
 */
function reviewCard(c: Canvas, ui: AutotradeUi): void {
  const t = c.theme;
  const rv = ui.review!;
  const r = rv.rec;
  const chk = rv.check;
  const looser = chk.ok && chk.riskDelta === 'looser';
  const lessSafe = rv.stage === 'less-safe';
  const w = Math.min(96, c.w - 4), h = Math.min(c.h - 4, 24);
  const x = Math.floor((c.w - w) / 2), y = Math.floor((c.h - h) / 2);
  c.noRain(x, y, w, h);
  const delta = chk.ok ? chk.riskDelta.toUpperCase() : 'CANNOT APPLY';
  const b = c.box(x, y, w, h, { title: `${lessSafe ? '⚠ LESS SAFE · ' : ''}CHAT PROPOSAL · ${r.kind === 'new' ? `new ${r.id} from ${r.from}` : r.id} · ${delta} · PAPER`, focus: true, bg: t.panelAlt, border: looser || !chk.ok ? t.warn : t.accent });
  const bg = b.bg;
  let yy = b.y;
  const line = (s: string, st: { fg: Hex; b?: boolean; i?: boolean }) => { if (yy < b.y + b.h) { c.text(b.x + 1, yy, fit(s, b.w - 2), { ...st, bg }); yy += 1; } };
  line(`proposed by ${r.actor} · ${r.proposalId} · ${r.beforeHash} → ${r.afterHash} · from v${r.baseVersion}`, { fg: t.muted });
  for (const l of wrap(`why: ${r.why}`, b.w - 2).slice(0, 2)) line(l, { fg: t.text, i: true });
  if (!chk.ok) {
    yy += 1;
    for (const e of chk.errors.slice(0, 6)) line(`✗ ${e.path || '/'} ${e.msg}`, { fg: t.down });
    line('n dismisses it · any other key closes', { fg: t.warn, b: true });
    return;
  }
  const less = chk.reasons.filter((x) => x.dir === 'looser');
  if (lessSafe) {
    yy += 1;
    line('THIS IS LESS SAFE. These risk numbers get looser:', { fg: t.warn, b: true });
    for (const x of less.slice(0, Math.max(1, b.h - 7))) line(`  ${x.path}  ${x.from} → ${x.to}${x.note ? `  (${x.note})` : ''}`, { fg: t.warn });
    yy = Math.max(yy, b.y + b.h - 2);
    line('y applies it anyway (a new version, journaled) · any other key cancels', { fg: t.warn, b: true });
    return;
  }
  line(`✓ valid${chk.validation.warnings.length ? ` · ${chk.validation.warnings.length} warning(s): ${chk.validation.warnings[0].path} ${chk.validation.warnings[0].msg}` : ''}`, { fg: t.up });
  if (looser) line(`LOOSER: ${less.map((x) => x.path.split('/').slice(-2).join('/')).join(', ')}`, { fg: t.warn, b: true });
  const room = b.y + b.h - 1 - yy; // the last row is the key line
  const diff = chk.diff.length > room ? [...chk.diff.slice(0, Math.max(0, room - 1)), `… ${chk.diff.length - room + 1} more lines`] : chk.diff;
  for (const d of diff) line(d, { fg: d.startsWith('+') ? t.up : d.startsWith('-') ? t.down : t.muted });
  c.text(b.x + 1, b.y + b.h - 1, fit(looser ? 'y opens the less-safe popup (a second y applies) · n dismisses · any other key closes' : 'y applies it (a new version, journaled) · n dismisses · any other key closes', b.w - 2), { fg: looser ? t.warn : t.accent, bg, b: true });
}

/** A one-line sketch of an exit profile: stop · cost-back · TP steps · trails · time/hold limits. */
export function ladderSketch(p: ExitProfile): string {
  const parts: string[] = [];
  parts.push(p.hardStop.enabled && p.hardStop.atPct !== null ? `stop ${p.hardStop.atPct}% ┤` : 'no stop ┤');
  parts.push('entry');
  const steps: Array<[number, string]> = p.tpLadder.map((s) => [s.atPct, `+${s.atPct}% ${frac(s.sellFrac)}`]);
  if (p.costRecovery) steps.push([p.costRecovery.atPct, `+${p.costRecovery.atPct}% cost back (≤${Math.round(p.costRecovery.maxSellFrac * 100)}%)`]);
  steps.sort((x, y) => x[0] - y[0]);
  for (const [, s] of steps) parts.push(s);
  const tail: string[] = [];
  if (p.trailingStop) tail.push(`trail ${p.trailingStop.trailPct}% after +${p.trailingStop.armAtPct}%`);
  if (p.bagTrail) tail.push(`bag trail ${p.bagTrail.trailPct}%${p.bagTrail.armAtPct ? ` after +${p.bagTrail.armAtPct}%` : ''}`);
  if (p.timeStop) tail.push(`${p.timeStop.minutes}m ${p.timeStop.action}`);
  if (p.maxHoldMinutes) tail.push(`hold ≤ ${p.maxHoldMinutes >= 1440 ? `${+(p.maxHoldMinutes / 1440).toFixed(1)}d` : p.maxHoldMinutes >= 60 ? `${+(p.maxHoldMinutes / 60).toFixed(1)}h` : `${p.maxHoldMinutes}m`}`);
  return `${p.id}: ${parts.join(' ── ')}${tail.length ? ` · ${tail.join(' · ')}` : ''}`;
}
const frac = (f: number): string => ({ 0.5: '½', 0.25: '¼', 0.75: '¾' } as Record<number, string>)[f] ?? (Math.abs(f - 1 / 3) < 0.01 ? '⅓' : `${Math.round(f * 100)}%`);

// ───────────────────────────── editor ─────────────────────────────

function renderEditor(c: Canvas, ui: AutotradeUi, a: Area): void {
  const t = c.theme;
  const ed = ui.editor;
  if (!ed) { c.text(a.x + 1, a.y + 1, 'no strategy open · e on the list opens one', { fg: t.dim, bg: t.bg }); return; }
  const wide = breakpoint(c.w) !== 'compact';
  const formW = wide ? Math.floor(a.w * 0.6) : a.w;
  const inputH = ed.typing ? 4 : 0;
  const check = ed.typing?.check ?? ed.check;
  const unsaved = ed.edits.length;
  const status = ed.typing ? (ed.typing.parseError ? '✗ not a value' : check.ok ? '✓ valid' : `✗ ${check.errors.length} problem${check.errors.length === 1 ? '' : 's'}`) : check.ok ? '✓ valid' : `✗ ${check.errors.length} problem${check.errors.length === 1 ? '' : 's'}`;
  const box = c.box(a.x, a.y, formW, a.h - inputH, {
    title: `${ed.id} · v${ed.baseVersion}${unsaved ? ` + ${unsaved} unsaved` : ''} · ${ed.draft.mode.toUpperCase()} · ${status}`,
    caption: ed.source === 'preset' ? 'shipped preset: read-only (d on the list makes your copy)' : 's saves a new version (only when valid) · u undoes', focus: !ed.typing,
  });
  const bg = box.bg;
  const { at } = issuesByField(ed.fields, ed.check.ok ? [] : ed.check.errors);
  const typingIssues = ed.typing?.check && !ed.typing.check.ok ? ed.typing.check.errors : [];
  // the rows: a section header before each section's first field
  type Row = { kind: 'section'; s: string } | { kind: 'field'; i: number };
  const rows: Row[] = [];
  let last = '';
  ed.fields.forEach((f, i) => { if (f.section !== last) { rows.push({ kind: 'section', s: f.section }); last = f.section; } rows.push({ kind: 'field', i }); });
  const selRow = rows.findIndex((r) => r.kind === 'field' && r.i === ed.selected);
  const view = box.h;
  const scroll = Math.max(0, Math.min(rows.length - view, selRow - Math.floor(view / 2)));
  const labelW = Math.min(36, Math.max(...ed.fields.map((f) => f.path.length - f.section.length)) + 2, Math.floor(box.w * 0.45));
  let y = box.y;
  for (let r = scroll; r < rows.length && y < box.y + box.h; r++, y++) {
    const row = rows[r];
    if (row.kind === 'section') { c.text(box.x + 1, y, row.s.toUpperCase(), { fg: t.accent, bg, b: true }); c.hline(box.x + 2 + row.s.length, y, box.w - row.s.length - 4, { fg: t.border, bg, soft: true }); continue; }
    const f = ed.fields[row.i];
    const sel = row.i === ed.selected;
    const rb = sel ? t.selBg : bg;
    c.fill(box.x, y, box.w, 1, ' ', { bg: rb });
    if (sel) c.put(box.x, y, '▎', { fg: t.accent, bg: rb, soft: true });
    const changed = ed.edits.some((x) => x.op.path === f.path);
    c.text(box.x + 2, y, fit(f.path.slice(f.section.length + 2) || f.path, labelW - 2), { fg: READ_ONLY_PATHS.has(f.path) ? t.dim : changed ? t.warn : t.muted, bg: rb });
    const vx = box.x + labelW + 1;
    const vw = box.w - labelW - 3;
    const v = getAt(ed.draft, f.path);
    const errs = at.get(f.path) ?? [];
    const text = f.kind === 'string' ? String(v) : JSON.stringify(v);
    // the value gets what it needs; an error takes the rest of the row
    const valW = errs.length ? Math.min(text.length + 1, Math.floor(vw * 0.5)) : vw;
    if (f.path === '/entry/screen') screenValue(c, String(v ?? ''), vx, y, valW, rb);
    else c.text(vx, y, fit(text, valW), { fg: changed ? t.warn : t.text, bg: rb, b: changed });
    if (errs.length) { const mx = vx + valW + 1; c.text(mx, y, fit(`✗ ${errs[0].msg}`, box.x + box.w - mx - 1), { fg: t.down, bg: rb }); }
  }

  if (ed.typing) {
    const iy = a.y + a.h - inputH;
    const ib = c.box(a.x, iy, formW, inputH, { title: `set ${ed.typing.path}`, caption: '⏎ set · esc cancel · re-validated on every key', focus: true });
    const shownW = ib.w - 4;
    const txt = ed.typing.text;
    const shown = txt.length > shownW ? '…' + txt.slice(txt.length - shownW + 1) : txt;
    if (ed.typing.path === '/entry/screen') screenValue(c, shown, ib.x + 1, ib.y, shownW, ib.bg);
    else c.text(ib.x + 1, ib.y, shown, { fg: t.text, bg: ib.bg });
    c.put(ib.x + 1 + Math.min(shown.length, shownW), ib.y, '█', { fg: t.accent, bg: ib.bg, soft: true });
    // the live result under the value: for the screen filter a caret at the parser's error column
    const ty = ed.typing;
    const own = ty.check && !ty.check.ok ? ty.check.errors.find((e) => e.path === ty.path || e.path.startsWith(`${ty.path}/`)) : undefined;
    const sh = ty.path === '/entry/screen' ? screenHighlight(txt) : null;
    const res = ty.parseError ? `✗ ${ty.parseError}` : own ? `✗ ${own.msg}` : ty.check && !ty.check.ok ? `✓ this field · ✗ ${ty.check.errors.length} elsewhere` : '✓ valid';
    const shift = txt.length - shown.length;
    if (sh?.at && sh.at - 1 - shift >= 0 && sh.at - 1 - shift < shownW) {
      const cx = ib.x + 1 + sh.at - 1 - shift;
      c.put(cx, ib.y + 1, '^', { fg: t.down, bg: ib.bg, b: true });
      c.text(cx + 2, ib.y + 1, fit(res, ib.x + ib.w - cx - 4), { fg: t.down, bg: ib.bg });
    } else c.text(ib.x + 1, ib.y + 1, fit(res, ib.w - 2), { fg: res.startsWith('✓') ? t.up : t.down, bg: ib.bg });
  }

  if (!wide) return;
  // right column: validation of the draft (or of the value being typed) + the exit ladders
  const rx = a.x + formW, rw = a.w - formW;
  const vh = Math.max(6, Math.floor(a.h * 0.45));
  const vbox = c.box(rx, a.y, rw, vh, { title: ed.typing ? 'VALIDATION · with the value you are typing' : 'VALIDATION', caption: 'dexterm-strategy/1 + cross-field rules' });
  let vy = vbox.y;
  const vline = (s: string, fg: Hex) => { wrap(s, vbox.w - 4).forEach((l, i) => { if (vy < vbox.y + vbox.h) { c.text(vbox.x + 1 + (i ? 2 : 0), vy, fit(l, vbox.w - 2 - (i ? 2 : 0)), { fg, bg: vbox.bg }); vy += 1; } }); };
  if (ed.typing?.parseError) vline(`✗ ${ed.typing.parseError}`, t.down);
  const shownIssues = ed.typing ? typingIssues : ed.check.ok ? [] : ed.check.errors;
  if (!ed.typing?.parseError && !shownIssues.length) vline('✓ valid: every field and the cross-field rules pass', t.up);
  for (const i of shownIssues) vline(`✗ ${i.path || '/'}  ${i.msg}`, t.down);
  for (const w of (ed.typing?.check ?? ed.check).warnings) vline(`! ${w.path}  ${w.msg}`, t.warn);
  const lbox = c.box(rx, a.y + vh, rw, a.h - vh, { title: 'EXIT PROFILES', caption: 'stop ┤ entry ── take-profits ── trails · limits' });
  let ly = lbox.y;
  const chk = ed.check;
  const profiles = chk.ok ? Object.values(chk.strategy.exits.profiles) : [];
  if (!profiles.length) c.text(lbox.x + 1, ly, 'fix the problems to see the ladders', { fg: t.dim, bg: lbox.bg, i: true });
  for (const p of profiles) {
    if (ly >= lbox.y + lbox.h - 1) break;
    c.text(lbox.x + 1, ly, fit(`${p.id === ed.draft.exits.default ? '● ' : '  '}${p.name}`, lbox.w - 2), { fg: t.accent, bg: lbox.bg, b: true }); ly += 1;
    for (const l of wrapSketch(ladderSketch(p).replace(/^[^:]+: /, ''), lbox.w - 4).slice(0, 2)) { c.text(lbox.x + 3, ly, l, { fg: t.muted, bg: lbox.bg }); ly += 1; }
  }
}

function wrapSketch(s: string, w: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const part of s.split(' · ')) { const next = cur ? `${cur} · ${part}` : part; if (next.length > w && cur) { out.push(cur); cur = part; } else cur = next; }
  if (cur) out.push(fit(cur, w));
  return out;
}

/** The screen filter in the screener's own tokens: fields / ops / tags coloured, the parser's error column lit. */
function screenValue(c: Canvas, src: string, x: number, y: number, w: number, bg: Hex): void {
  const t = c.theme;
  const shown = fit(src, w);
  c.text(x, y, shown, { fg: t.text, bg });
  for (const tok of tokenize(shown)) {
    const fg = tok.kind === 'op' ? t.warn : tok.kind === 'not' ? t.down : tok.kind === 'colon' ? t.dim : /^[0-9.]/.test(tok.text) ? t.up : t.accent;
    c.text(x + tok.at - 1, y, tok.text, { fg, bg });
  }
  const h = screenHighlight(src);
  if (h.at !== null && h.at - 1 < shown.length) c.put(x + Math.max(0, h.at - 1), y, shown[Math.max(0, h.at - 1)] ?? ' ', { fg: t.bg, bg: t.down, b: true });
}

// ───────────────────────────── compare ─────────────────────────────

function renderCompare(c: Canvas, ui: AutotradeUi, a: Area): void {
  const t = c.theme;
  const cmp = ui.compare;
  if (!cmp) { c.text(a.x + 1, a.y + 1, 'c on two strategies in the list compares them', { fg: t.dim, bg: t.bg }); return; }
  const store = ui.deps.store;
  const { rows, lastA, lastB } = memo(ui, `cmp:${entryKey(ui, cmp.a)}:${entryKey(ui, cmp.b)}`, () => {
    const ga = store.get(cmp.a), gb = store.get(cmp.b);
    const bts = store.backtests();
    return {
      rows: compareRows(store.raw(cmp.a), store.raw(cmp.b)),
      lastA: ga?.ok ? bts[ga.strategy.hash] : undefined, lastB: gb?.ok ? bts[gb.strategy.hash] : undefined,
    };
  });
  const changed = rows.filter((r) => r.changed).length;
  const btH = 6;
  const bt = c.box(a.x, a.y, a.w, btH, { title: 'BACKTESTS · same tape', caption: 'b runs both on one window of recorded history' });
  const half = Math.floor((bt.w - 2) / 2);
  const job = ui.compareRun;
  const cell = (i: 0 | 1, id: string, last: ReturnType<typeof store.backtests>[string] | undefined, x: number) => {
    let y = bt.y;
    c.text(x, y, fit(id, half - 1), { fg: t.accent, bg: bt.bg, b: true }); y += 1;
    const out = job?.status === 'done' ? job.result![i] : null;
    if (out) { for (const l of reportLines(out.report).slice(0, 3)) { c.text(x, y, fit(l, half - 1), { fg: out.report.netUsd >= 0 ? t.up : t.down, bg: bt.bg }); y += 1; } return; }
    const line = job?.status === 'running' ? 'running…' : job?.status === 'error' ? `✗ ${job.error}` : last ? `last: ${usd(last.netUsd)} · dd ${last.maxDrawdownPct.toFixed(1)}% · ${last.trades} trades · ${last.tape}` : 'not backtested yet';
    c.text(x, y, fit(line, half - 1), { fg: job?.status === 'error' ? t.down : t.muted, bg: bt.bg });
  };
  cell(0, cmp.a, lastA, bt.x + 1);
  cell(1, cmp.b, lastB, bt.x + 1 + half);
  if (job?.status === 'done') c.text(bt.x + 1, bt.y + bt.h - 1, fit(`tape: ${job.result![0].report.tape.mints} coins · ${job.result![0].report.tape.from ?? '?'} → ${job.result![0].report.tape.to ?? '?'} (both)`, bt.w - 2), { fg: t.dim, bg: bt.bg });

  const box = c.box(a.x, a.y + btH, a.w, a.h - btH, { title: `FIELDS · ${changed} differ of ${rows.length}`, caption: 'changed fields lit · builtin profiles compare as references', focus: true });
  const pw = Math.min(46, Math.floor(box.w * 0.34));
  const vw = Math.floor((box.w - pw - 3) / 2);
  c.text(box.x + 1, box.y, 'FIELD', { fg: t.dim, bg: box.bg });
  c.text(box.x + 1 + pw, box.y, fit(cmp.a, vw), { fg: t.dim, bg: box.bg });
  c.text(box.x + 2 + pw + vw, box.y, fit(cmp.b, vw), { fg: t.dim, bg: box.bg });
  // changed rows first, then the rest, so the differences are on the first screen
  const ordered = [...rows.filter((r) => r.changed), ...rows.filter((r) => !r.changed)];
  cmp.scroll = Math.max(0, Math.min(cmp.scroll, Math.max(0, ordered.length - (box.h - 1))));
  let y = box.y + 1;
  for (let i = cmp.scroll; i < ordered.length && y < box.y + box.h; i++, y++) {
    const r = ordered[i];
    const rbg = r.changed ? t.selBg : box.bg;
    c.fill(box.x, y, box.w, 1, ' ', { bg: rbg });
    c.text(box.x + 1, y, fit(r.path, pw - 1), { fg: r.changed ? t.warn : t.dim, bg: rbg });
    c.text(box.x + 1 + pw, y, fit(r.a, vw - 1), { fg: r.changed ? t.text : t.muted, bg: rbg, b: r.changed });
    c.text(box.x + 2 + pw + vw, y, fit(r.b, vw - 1), { fg: r.changed ? t.text : t.muted, bg: rbg, b: r.changed });
  }
}

// ───────────────────────────── backtest ─────────────────────────────

export function reportLines(r: BacktestReport): string[] {
  const wr = r.winRate ? `${r.winRate.value.toFixed(1)}% (95% ${r.winRate.lo.toFixed(1)}–${r.winRate.hi.toFixed(1)}%)` : '—';
  return [
    `${r.trades} trades · win rate ${wr} · net ${usd(r.netUsd)} (${pct(r.netPct)})`,
    `max drawdown ${r.maxDrawdownPct.toFixed(1)}% · profit factor ${r.profitFactor === null ? '—' : r.profitFactor.toFixed(2)} · best ${pct(r.bestPct)} · worst ${pct(r.worstPct)}`,
    `stuck ${r.stuck} · open at end ${r.openAtEnd} · candidates ${r.candidates} · rugs ${r.tail.rugs} · cost back ${r.tail.costRecovered} · net without the best trade ${usd(r.tail.netWithoutBestUsd)}`,
  ];
}

function renderBacktest(c: Canvas, ui: AutotradeUi, a: Area, now: number): void {
  const t = c.theme;
  const subj = backtestSubject(ui);
  const job = subj?.hash ? ui.backtests.get(subj.hash) : undefined;
  const sw = ui.sweep && subj && ui.sweep.id === subj.id ? ui.sweep : null;
  const sweepH = sw ? Math.min(11, Math.max(7, Math.floor(a.h * 0.32))) : 0;
  const box = c.box(a.x, a.y, a.w, a.h - sweepH, {
    title: `BACKTEST · ${subj?.id ?? 'no strategy'} · PAPER · recorded history, modelled fills`,
    caption: job?.status === 'done' && job.result ? `${job.result.report.tape.mints} coins · ${job.result.report.tape.from ?? '?'} → ${job.result.report.tape.to ?? '?'}` : 'b runs it · w sweeps with a held-out check',
    focus: true,
  });
  const bg = box.bg;
  let y = box.y;
  const line = (s: string, fg: Hex = t.text, b = false) => { if (y < box.y + box.h) { c.text(box.x + 1, y, fit(s, box.w - 2), { fg, bg, b }); y += 1; } };
  if (!job) line(subj ? `${subj.id} has no backtest in this session yet · b runs it on the last 14 days of recorded history` : 'select a strategy on the list', t.dim);
  else if (job.status === 'running') line(`running… ${fmtAgeSec(Math.max(0, Math.round((now - job.startedAt) / 1000)))} (off the screen loop; the app stays live)`, t.muted);
  else if (job.status === 'error') line(`✗ ${job.error}`, t.down);
  const r = job?.status === 'done' ? job.result?.report : undefined;
  if (r && job?.result) {
    const ls = reportLines(r);
    line(ls[0], r.netUsd >= 0 ? t.up : t.down, true);
    line(ls[1]);
    line(ls[2], t.muted);
    if (r.tail.perEntry) line(`per entry ${pct(r.tail.perEntry.meanPct)} (bootstrap 95% ${pct(r.tail.perEntry.lo)} … ${pct(r.tail.perEntry.hi)})${r.tail.multiples ? ` · exit multiples P50 ${r.tail.multiples.p50.toFixed(2)}× · P90 ${r.tail.multiples.p90.toFixed(2)}× · max ${r.tail.multiples.max.toFixed(2)}×` : ''}`, t.muted);
    if (r.trades < 20) line('n < 20: read the counts, not the rates', t.warn, true);
    // equity sparkline (marked equity: stuck bags count as 0)
    if (y < box.y + box.h) {
      c.text(box.x + 1, y, 'equity', { fg: t.dim, bg });
      sparkline(c, box.x + 9, y, Math.min(box.w - 11, 90), job.result.curve, { bg, color: r.netUsd >= 0 ? t.up : t.down });
      y += 2;
    }
    // attribution tables, side by side
    const tables: Array<[string, Record<string, { n: number; pnlUsd: number }>]> = [['BY EXIT RULE', r.byExit], ['BY PROFILE', r.byProfile], ['BY TRIGGER', r.byTrigger]];
    const tw = Math.floor((box.w - 2) / 3);
    const ty0 = y;
    let maxY = y;
    tables.forEach(([title, rows], i) => {
      let yy = ty0;
      const x = box.x + 1 + i * tw;
      if (yy < box.y + box.h) c.text(x, yy, title, { fg: t.accent, bg, b: true }); yy += 1;
      for (const [k, b] of Object.entries(rows).sort((p, q) => p[1].pnlUsd - q[1].pnlUsd).slice(0, 6)) {
        if (yy >= box.y + box.h) break;
        c.text(x, yy, fit(k, tw - 18), { fg: t.muted, bg });
        c.textR(x, yy, tw - 2, `${String(b.n).padStart(3)}  ${usd(b.pnlUsd).padStart(10)}`, { fg: b.pnlUsd >= 0 ? t.up : t.down, bg });
        yy += 1;
      }
      maxY = Math.max(maxY, yy);
    });
    y = maxY + 1;
    const clamps = Object.entries(r.clamps).map(([k, n]) => `${k} ${n}`).join(' · ') || 'none';
    const refusals = Object.entries(r.refusals).sort((p, q) => q[1] - p[1]).slice(0, 6).map(([k, n]) => `${k} ${n}`).join(' · ') || 'none';
    line(`clamps fired: ${clamps}`, t.muted);
    line(`refusals: ${refusals}`, t.muted);
    y += 1;
    // the data-limits box, always printed
    if (y < box.y + box.h) {
      const lh = Math.min(r.limits.length + 2, box.y + box.h - y);
      if (lh >= 3) {
        const lb = c.box(box.x + 1, y, box.w - 2, lh, { title: 'LIMITS (read before trusting any number)', bg: t.panelAlt, border: t.warn });
        r.limits.slice(0, lb.h).forEach((l, i) => c.text(lb.x + 1, lb.y + i, fit(`· ${l}`, lb.w - 2), { fg: t.muted, bg: lb.bg }));
      }
    }
  } else if (y < box.y + box.h - 3) {
    y += 1;
    line('What a backtest here is: the same engine as the runner (entry rules, clamp, exits) replayed over the recorder\'s history,', t.dim);
    line('with mechanical entries (no agent), modelled fills, stuck bags valued at 0, and the limits box printed with every report.', t.dim);
  }

  if (sw) {
    const sb = c.box(a.x, a.y + a.h - sweepH, a.w, sweepH, { title: `SWEEP · ${Object.keys(sw.grid).join(' × ')} · held-out = newest 30% of coins`, caption: 'tuned on train only; the held-out coins are touched twice' });
    let sy = sb.y;
    const sl = (s: string, fg: Hex = t.text, b = false) => { if (sy < sb.y + sb.h) { c.text(sb.x + 1, sy, fit(s, sb.w - 2), { fg, bg: sb.bg, b }); sy += 1; } };
    if (sw.status === 'running') sl(`running… ${fmtAgeSec(Math.max(0, Math.round((now - sw.startedAt) / 1000)))}`, t.muted);
    else if (sw.status === 'error') sl(`✗ ${sw.error}`, t.down);
    else if (sw.result) {
      const s = sw.result;
      const gain = /^held-out gain/.test(s.verdict);
      sl(`VERDICT: ${s.verdict}`, gain ? t.up : t.warn, true);
      sl(`split: train ${s.split.trainMints} coins · held-out ${s.split.testMints} coins (newest, from ${s.split.cutoff}) · ${s.combos} combinations run · ${s.invalid.length} refused as invalid`, t.muted);
      const pw = Math.max(9, ...[s.baseline, s.best, ...s.top].map((x) => paramText(x).length));
      sl(`unchanged   ${sweepRow(s.baseline, pw)}`);
      sl(`train best  ${sweepRow(s.best, pw)}`);
      sl('top on train:', t.dim);
      for (const x of s.top.slice(0, Math.max(0, sb.h - 5))) sl(`            ${sweepRow(x, pw)}`, t.dim);
    }
  }
}

const paramText = (x: SweepRow): string => Object.entries(x.params).map(([k, v]) => `${k.replace(/^profile\./, '')}=${v}`).join(' ') || '(as is)';
function sweepRow(x: SweepRow, pw: number): string {
  return `${paramText(x).padEnd(pw)}  train ${String(x.train.trades).padStart(3)} ${usd(x.train.netUsd).padStart(10)} dd ${x.train.maxDrawdownPct.toFixed(1)}%${x.test ? `  · held-out ${String(x.test.trades).padStart(3)} ${usd(x.test.netUsd).padStart(10)} dd ${x.test.maxDrawdownPct.toFixed(1)}%` : ''}`;
}

// ───────────────────────────── runner ─────────────────────────────

function renderRunner(c: Canvas, ui: AutotradeUi, a: Area, now: number): void {
  const t = c.theme;
  const rr = ui.runner;
  const sh = 5;
  const mode = runMode(ui);
  const sbox = c.box(a.x, a.y, a.w, sh, { title: `RUNNER · ${mode === 'live' ? 'LIVE · MAINNET' : mode === 'devnet' ? 'DEVNET (live signer rehearsal)' : 'PAPER'}`, caption: `status file: ${rr.path || '~/.dexterm/autotrade/runner.json'}`, focus: true });
  let y = sbox.y;
  const sl = (s: string, fg: Hex = t.text, b = false) => { if (y < sbox.y + sbox.h) { c.text(sbox.x + 1, y, fit(s, sbox.w - 2), { fg, bg: sbox.bg, b }); y += 1; } };
  if (rr.kind === 'none') {
    sl('no autotrade runner is running', t.muted, true);
    sl('the runner (headless, one per machine) writes its status here every heartbeat; this view picks it up within 2 s', t.dim);
    sl('`!` kill · `p` pause entries · `f` flatten act on a running runner only; nothing on this screen reaches a wallet or the signer', t.dim);
    return;
  }
  if (rr.kind === 'bad') { sl(`✗ status file unreadable: ${rr.error}`, t.down, true); sl('the view shows nothing it cannot verify', t.dim); return; }
  const s = rr.snap;
  const stale = heartbeatStale(rr, now);
  const age = fmtAgeSec(Math.max(0, Math.round((now - s.heartbeatAt) / 1000)));
  const stateFg = stale ? t.down : s.state === 'running' ? t.up : s.state === 'paused' ? t.warn : t.down;
  sl(`${stale ? 'STALE' : s.state.toUpperCase()} · ${s.strategy.id} v${s.strategy.version} (${s.strategy.hash}) · pid ${s.pid} · heartbeat ${age} ago${stale ? ' (no heartbeat for over 30 s: treat it as down)' : ''}`, stateFg, true);
  sl(`book $${s.book.equityUsd.toFixed(2)} of $${s.book.startUsd.toFixed(2)} · cash $${s.book.cashUsd.toFixed(2)} · realized today ${usd(s.book.realizedTodayUsd)} · model spend $${s.spend.todayUsd.toFixed(2)} of $${s.spend.dayCapUsd.toFixed(2)} today`);
  sl(s.haltReason ? `halted: ${s.haltReason}` : 'no halt', s.haltReason ? t.down : t.dim, !!s.haltReason);

  // task-1529: a `run --all` shows its strategies side by side above the shared panels (rows tagged [strategy]).
  const fleet = ui.fleet;
  let fh = 0;
  if (fleet) {
    const lines = fleetCompareTable(fleetCompareRows(fleet));
    fh = Math.min(lines.length + 4, Math.max(5, Math.floor((a.h - sh) * 0.4)));
    const tot = fleetTotals(fleet);
    const g = fleet.global;
    const fb = c.box(a.x, a.y + sh, a.w, fh, { title: `STRATEGIES · ${fleet.members.length} at once · PAPER`, caption: 'one strategy: dexterm autotrade pause|stop|start --strategy ID' });
    const rows = lines.slice(0, Math.max(0, fb.h - 2));
    rows.forEach((l, i) => {
      const m = i ? fleet.members[i - 1] : null;
      const fg = !m ? t.muted : m.state === 'running' ? t.text : m.state === 'paused' ? t.warn : m.state === 'error' || m.state === 'halted' ? t.down : t.dim;
      c.text(fb.x + 1, fb.y + i, fit(l, fb.w - 2), { fg, bg: fb.bg, b: !m });
    });
    const foot: Array<[string, Hex]> = [
      [`together ${usd(tot.pnlUsd)} on $${tot.startUsd.toFixed(2)} · ${tot.closed} closed · ${tot.open} open · simulated fills, not financial advice`, tot.pnlUsd >= 0 ? t.up : t.down],
      [`global: ${g.liveSessions}/${g.caps.maxConcurrentSessions} sessions · $${g.today.modelUsd.toFixed(2)} of $${g.caps.modelUsdPerDay} model spend today${g.load.paused ? ' · machine busy, new sessions wait' : ''}${g.blocked ? ` · ${g.blocked}` : ''}`, g.load.paused || g.blocked ? t.warn : t.muted],
    ];
    foot.slice(0, Math.max(0, fb.h - rows.length)).forEach(([l, fg], i) => c.text(fb.x + 1, fb.y + rows.length + i, fit(l, fb.w - 2), { fg, bg: fb.bg }));
  }
  const tag = (x: object) => { const id = (x as { strategy?: unknown }).strategy; return typeof id === 'string' ? `[${id}] ` : ''; };
  const rest = a.h - sh - fh;
  const ledgerH = Math.max(4, Math.floor(rest * 0.3));
  const upper = rest - ledgerH;
  const third = Math.floor(a.w / 3);
  const panel = (x: number, w: number, title: string, lines: Array<[string, Hex]>) => {
    const b = c.box(x, a.y + sh + fh, w, upper, { title });
    lines.slice(0, b.h).forEach(([l, fg], i) => c.text(b.x + 1, b.y + i, fit(l, b.w - 2), { fg, bg: b.bg }));
    if (!lines.length) c.text(b.x + 1, b.y, 'none', { fg: t.dim, bg: b.bg, i: true });
  };
  panel(a.x, third, `CANDIDATES · ${s.candidates.length}`, s.candidates.map((k) => [`${tag(k)}${k.symbol.padEnd(9)} ${fmtAgeSec(k.ageSec).padStart(4)}  ${k.matched.join(' · ')}${k.session ? '  ◆ session' : ''}`, t.text]));
  panel(a.x + third, third, `SESSIONS · ${s.sessions.length}`, s.sessions.flatMap((k): Array<[string, Hex]> => [
    [`${tag(k)}${k.symbol.padEnd(9)} ${String(k.turns).padStart(3)} turns  $${k.costUsd.toFixed(2)} of $${k.budgetUsd.toFixed(2)}`, k.costUsd > k.budgetUsd * 0.8 ? t.warn : t.text],
    [`  last: ${k.lastDecision ?? '—'}`, t.muted],
  ]));
  panel(a.x + 2 * third, a.w - 2 * third, `POSITIONS · ${s.positions.length}`, s.positions.flatMap((p): Array<[string, Hex]> => [
    [`${tag(p)}${p.symbol.padEnd(8)}${pct(p.pnlPct).padStart(8)}${usd(p.pnlUsd).padStart(9)}${p.freeBag ? ' free bag' : ''}`, p.pnlUsd >= 0 ? t.up : t.down],
    [`  ${p.profile} · next: ${p.next ?? '—'}`, t.muted],
  ]));
  const lb = c.box(a.x, a.y + sh + fh + upper, a.w, ledgerH, { title: 'RUN LEDGER · newest last', caption: 'hash-chained; every step with its exact inputs' });
  const tail = s.ledgerTail.slice(-lb.h);
  tail.forEach((e, i) => {
    const ago = fmtAgeSec(Math.max(0, Math.round((now - e.t) / 1000)));
    c.text(lb.x + 1, lb.y + i, fit(`#${String(e.seq).padEnd(6)} ${ago.padStart(4)}  ${e.kind.padEnd(16)} ${e.text}`, lb.w - 2), { fg: /refus|halt|kill|rug/.test(e.kind) ? t.warn : t.muted, bg: lb.bg });
  });
}

function confirmCard(c: Canvas): void {
  const t = c.theme;
  const w = Math.min(64, c.w - 4), h = 6;
  const x = Math.floor((c.w - w) / 2), y = Math.floor((c.h - h) / 2);
  c.noRain(x, y, w, h);
  const b = c.box(x, y, w, h, { title: 'FLATTEN · PAPER', focus: true, bg: t.panelAlt, border: t.warn });
  c.text(b.x + 1, b.y, fit('Sell every paper position of this runner at the next tick.', b.w - 2), { fg: t.text, bg: b.bg });
  c.text(b.x + 1, b.y + 1, fit('New entries stop first; mechanical exits keep running.', b.w - 2), { fg: t.muted, bg: b.bg });
  c.text(b.x + 1, b.y + 3, 'y flatten · any other key cancels', { fg: t.warn, bg: b.bg, b: true });
}
