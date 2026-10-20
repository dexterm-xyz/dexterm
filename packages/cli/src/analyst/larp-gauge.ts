// dexterm — the LARP score gauge in the analyst panel (task-1471).
//
// The number comes from the dexterm MCP server's own `larp_check` result (the tool_result the claude stream
// carries back), never from the model's answer, so the panel only shows a score the app computed from evidence
// it can list. Shape-checked here; anything malformed shows nothing.

import { mix, type Canvas } from '@dexterm/tui';

export interface LarpGauge {
  score: number;
  band: 'low' | 'medium' | 'high';
  lo: number;
  hi: number;
  thresholds: { medium: number; high: number };
  /** Up to three biggest contributors: points + the flag's published label. */
  top: Array<{ points: number; label: string }>;
  missing: number;
}

const BANDS = new Set(['low', 'medium', 'high']);
const pct = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100;
// Labels are the app's own published flag labels; still strip control characters and cap the length.
const clean = (s: unknown): string => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, 80);

/** Pull the gauge out of a larp_check result object (null when absent or malformed). */
export function parseLarpGauge(result: unknown): LarpGauge | null {
  const s = (result as { larp_score?: unknown } | null)?.larp_score as Record<string, unknown> | undefined;
  if (!s || typeof s !== 'object') return null;
  const range = s.range as { lo?: unknown; hi?: unknown } | undefined;
  const th = s.thresholds as { medium?: unknown; high?: unknown } | undefined;
  if (!pct(s.score) || !BANDS.has(String(s.band)) || !range || !pct(range.lo) || !pct(range.hi) || !th || !pct(th.medium) || !pct(th.high)) return null;
  const top = Array.isArray(s.top) ? (s.top as Array<{ points?: unknown; label?: unknown }>).filter((f) => pct(f.points)).slice(0, 3).map((f) => ({ points: f.points as number, label: clean(f.label) })) : [];
  return { score: s.score, band: s.band as LarpGauge['band'], lo: range.lo, hi: range.hi, thresholds: { medium: th.medium, high: th.high }, top, missing: Array.isArray(s.missing) ? s.missing.length : 0 };
}

/** The one-line text form (plain mode, tests, voice-free summaries). */
export function larpGaugeText(g: LarpGauge): string {
  const range = g.hi > g.score ? ` · could be up to ${g.hi} (${g.missing} unread)` : '';
  return `LARP score ${g.score}/100 ${g.band}${range}`;
}

/**
 * Draw the gauge (one bar row + up to three reason rows) starting at `y`; returns the next free row.
 * The bar fills to the score, a lighter tail shows the missing-data range, ticks mark the band thresholds.
 */
export function drawLarpGauge(c: Canvas, x: number, y: number, w: number, maxY: number, g: LarpGauge, bg: string): number {
  const t = c.theme;
  if (y >= maxY || w < 24) return y;
  const col = g.band === 'high' ? t.down : g.band === 'medium' ? t.warn : t.up;
  const label = `LARP ${String(g.score).padStart(3)}/100 `;
  const tail = ` ${g.band}${g.hi > g.score ? ` ≤${g.hi}` : ''}`;
  const barW = Math.max(8, w - label.length - tail.length);
  c.text(x, y, label, { fg: col, bg, b: true });
  const filled = Math.round((g.score / 100) * barW), upto = Math.round((g.hi / 100) * barW);
  for (let i = 0; i < barW; i++) {
    const tick = i === Math.round((g.thresholds.medium / 100) * barW) || i === Math.round((g.thresholds.high / 100) * barW);
    const ch = i < filled ? '█' : i < upto ? '▒' : tick ? '┊' : '·';
    c.text(x + label.length + i, y, ch, { fg: i < filled ? col : i < upto ? mix(bg, col, 0.45) : t.dim, bg });
  }
  c.text(x + label.length + barW, y, tail, { fg: col, bg }, w - label.length - barW);
  y += 1;
  for (const f of g.top) {
    if (y >= maxY) break;
    c.text(x + 1, y, `+${String(f.points).padStart(2)} ${f.label}`, { fg: t.muted, bg }, w - 1);
    y += 1;
  }
  if (g.missing && y < maxY) { c.text(x + 1, y, `${g.missing} check${g.missing === 1 ? '' : 's'} unread: range ${g.lo}–${g.hi}, not counted as clean`, { fg: t.dim, bg, i: true }, w - 1); y += 1; }
  return y;
}
