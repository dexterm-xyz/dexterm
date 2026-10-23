// dexterm — the persistent POSITION PnL chip (task-1473). While an auto mode runs and a position is open, one compact
// readout is on every terminal screen and on the chart popup: coin, mark PnL % with sign (and $ when the size is
// known), entry → mark, peak, drawdown from the peak, time held and the take-profit. Sources (state.ts pnlChipFor):
//   · following an agent (task-1466 HUD) that holds a PAPER ticket — the folded story, TP = what the agent said;
//   · AI scan mode with the user's OWN paper or live position (OwnPnlTracker; session peak, TP = the ledger target).
// Where it draws: the HUD dock's signal row when the dock is up (≥ HUD_MIN_H rows while following), else the band
// under the header (row 1, right-aligned: short terminals, scan mode), and the chart popup's chip strip (ChartVM.chip).
// It updates on every mark tick, flashes on a new peak (a ★ glyph says the same under calm mode / NO_COLOR) and drops
// fields from the right as the width shrinks. Display only: it has no input and reads only folded / ledger state.

import { mix, type Canvas, type Hex } from '@dexterm/tui';
import { fmtPx, type StoryView } from '@dexterm/agents';
import { planFromThoughts, fmtDur } from './brain.ts';

export interface PnlChipVM {
  /** Whose ledger: the followed agent's PAPER ticket, or (AI scan mode) the user's own paper / live position. */
  kind: 'PAPER' | 'LIVE';
  symbol: string;
  /** (mark / entry − 1), null before the first mark. */
  pnlPct: number | null;
  /** Paper dollars of the open size (needs the ticket's $ size). */
  pnlUsd: number | null;
  entry: string;
  mark: string;
  peakPct: number | null;
  /** (1 + pnl) / (1 + peak) − 1, ≤ 0. */
  ddPct: number | null;
  heldMs: number | null;
  /** The take-profit the agent said ("+40%"), else null (agent-managed). */
  tp: string | null;
  /** The peak was raised in the last PEAK_FLASH_MS. */
  newPeak: boolean;
  /** What the TP segment says when `tp` is null (default: the agent manages its own exit). */
  tpNone?: string;
}

export const PEAK_FLASH_MS = 1200;

/** The chip for the followed agent's open PAPER position, or null when nothing is held. */
/** task-1537: how a chip level reads: the caller's basis (a market cap at the coin's supply by default), else `$price`. */
export type ChipLevel = (usd: number, mint: string) => string;
export const CHIP_PRICE_LEVEL: ChipLevel = (u) => `$${fmtPx(u)}`;
const PRICE_LEVEL = CHIP_PRICE_LEVEL;

export function pnlChipVM(v: StoryView, now: number, lvl: ChipLevel = PRICE_LEVEL): PnlChipVM | null {
  const a = v.arc;
  if (!a || a.stage !== 'open') return null;
  const dd = a.pnlPct !== null && a.peakPct !== null ? (1 + a.pnlPct) / (1 + a.peakPct) - 1 : null;
  return {
    kind: 'PAPER',
    symbol: a.symbol,
    pnlPct: a.pnlPct,
    pnlUsd: a.pnlPct !== null && a.sizeUsd !== null ? a.sizeUsd * a.pnlPct : null,
    entry: a.entryUsd !== null ? lvl(a.entryUsd, a.mint) : '—',
    mark: a.mark ? lvl(a.mark.priceUsd, a.mint) : '—',
    peakPct: a.peakPct,
    ddPct: dd,
    heldMs: a.filledAt !== null ? now - a.filledAt : null,
    tp: planFromThoughts(v.thoughts, a.openedAt).tp,
    newPeak: a.peakAt !== null && now - a.peakAt < PEAK_FLASH_MS && a.peakPct !== null && a.peakPct > 0,
  };
}

/**
 * One sample of the user's OWN held position (AI scan mode: no agent ticket, the scan is observe-only), marked with
 * the terminal's own price through the task-1323 position row. Built in main.ts from the PositionSource.
 */
export interface OwnHeldSample {
  mint: string;
  symbol: string;
  kind: 'paper' | 'live';
  entryUsd: number | null;
  markUsd: number | null;
  /** Fraction of cost, null before a mark. */
  pnlPct: number | null;
  pnlUsd: number | null;
  /** First fill of the current position (since it was last flat), null when the ledger has no time. */
  openedAt: number | null;
  targetUsd: number | null;
}

/**
 * The user's own position chip in AI scan mode. The ledgers keep no peak, so the peak is this session's highest
 * mark (reset when the held coin or ledger changes, or the position goes flat). Display only.
 */
export class OwnPnlTracker {
  private cur: { s: OwnHeldSample; peakPct: number | null; peakAt: number | null } | null = null;

  update(s: OwnHeldSample | null, now: number): void {
    if (!s) { this.cur = null; return; }
    const seed = !this.cur || this.cur.s.mint !== s.mint || this.cur.s.kind !== s.kind;
    if (seed) this.cur = { s, peakPct: s.pnlPct, peakAt: null }; // the first mark is not a "new peak" flash
    const c = this.cur!;
    c.s = s;
    if (!seed && s.pnlPct !== null && (c.peakPct === null || s.pnlPct > c.peakPct + 1e-9)) { c.peakPct = s.pnlPct; c.peakAt = now; }
  }

  get mint(): string | null { return this.cur?.s.mint ?? null; }

  vm(now: number, lvl: ChipLevel = PRICE_LEVEL): PnlChipVM | null {
    const c = this.cur;
    if (!c) return null;
    const s = c.s;
    const dd = s.pnlPct !== null && c.peakPct !== null ? (1 + s.pnlPct) / (1 + c.peakPct) - 1 : null;
    return {
      kind: s.kind === 'live' ? 'LIVE' : 'PAPER',
      symbol: s.symbol,
      pnlPct: s.pnlPct,
      pnlUsd: s.pnlUsd,
      entry: s.entryUsd !== null ? lvl(s.entryUsd, s.mint) : '—',
      mark: s.markUsd !== null ? lvl(s.markUsd, s.mint) : '—',
      peakPct: c.peakPct,
      ddPct: dd,
      heldMs: s.openedAt !== null ? Math.max(0, now - s.openedAt) : null,
      tp: s.targetUsd !== null ? lvl(s.targetUsd, s.mint) : null,
      tpNone: 'not set',
      newPeak: c.peakAt !== null && now - c.peakAt < PEAK_FLASH_MS && c.peakPct !== null && c.peakPct > 0,
    };
  }
}

const pct = (r: number): string => `${r >= 0 ? '+' : '−'}${Math.abs(r * 100).toFixed(1)}%`;
const usd = (n: number): string => `${n >= 0 ? '+' : '−'}$${Math.abs(n).toFixed(2)}`;

/** The chip's segments in priority order (the first ones survive the narrowest widths). */
export function chipSegments(m: PnlChipVM): Array<{ id: string; text: string }> {
  const segs: Array<{ id: string; text: string }> = [];
  const dir = m.pnlPct === null ? '·' : m.pnlPct >= 0 ? '▲' : '▼';
  segs.push({ id: 'head', text: `${m.kind} $${m.symbol}` });
  segs.push({ id: 'pnl', text: `${dir} ${m.pnlPct === null ? '—' : pct(m.pnlPct)}${m.pnlUsd !== null ? ` ${usd(m.pnlUsd)}` : ''}` });
  if (m.peakPct !== null) segs.push({ id: 'peak', text: `peak ${pct(m.peakPct)}${m.newPeak ? ' ★' : ''}` });
  segs.push({ id: 'px', text: `${m.entry} → ${m.mark}` });
  if (m.heldMs !== null) segs.push({ id: 'held', text: `held ${fmtDur(m.heldMs)}` });
  if (m.ddPct !== null && m.ddPct < -0.0005) segs.push({ id: 'dd', text: `dd ${pct(m.ddPct)}` });
  segs.push({ id: 'tp', text: m.tp ? `TP ${m.tp}` : `TP ${m.tpNone ?? 'agent-managed'}` });
  return segs;
}

const SEP = ' │ ';

/** The chip text that fits in `maxW` (segments drop from the end). Pure, for tests. */
export function chipText(m: PnlChipVM, maxW: number): string {
  const segs = chipSegments(m);
  let n = segs.length;
  const join = (k: number): string => ` ${segs.slice(0, k).map((s) => s.text).join(SEP)} `;
  while (n > 1 && join(n).length > maxW) n--;
  const s = join(n);
  return s.length <= maxW ? s : '';
}

/**
 * Draw the chip right-aligned to `right` (exclusive) on row `y`, no wider than `maxW`. Returns the x it starts at
 * (or `right` when nothing fits).
 */
export function renderPnlChip(c: Canvas, right: number, y: number, maxW: number, m: PnlChipVM, o: { now: number; reduced: boolean }): number {
  const t = c.theme;
  const text = chipText(m, maxW);
  if (!text) return right;
  const x0 = right - text.length;
  const bg: Hex = mix(t.bg, t.magenta, 0.22);
  const col = m.pnlPct === null ? t.muted : m.pnlPct >= 0 ? t.up : t.down;
  c.text(x0, y, text, { fg: t.text, bg });
  // re-colour the segments: head magenta, PnL red/green bold (flash on a new peak), peak green, dd warn
  let x = x0 + 1;
  for (const s of chipSegments(m)) {
    if (x + s.text.length > right - 1) break;
    if (s.id === 'head') c.text(x, y, s.text, { fg: t.magenta, bg, b: true });
    else if (s.id === 'pnl') {
      const flash = m.newPeak && !o.reduced;
      c.text(x, y, s.text, flash ? { fg: t.bg, bg: t.up, b: true } : { fg: col, bg, b: true });
    } else if (s.id === 'peak') c.text(x, y, s.text, { fg: m.peakPct !== null && m.peakPct >= 0 ? t.up : t.down, bg, b: m.newPeak });
    else if (s.id === 'dd') c.text(x, y, s.text, { fg: t.warn, bg });
    else c.text(x, y, s.text, { fg: t.muted, bg });
    x += s.text.length;
    if (x + SEP.length < right) c.text(x, y, SEP, { fg: mix(bg, t.border, 0.8), bg });
    x += SEP.length;
  }
  return x0;
}
