// dexterm narratives (task-1818): the export JSON (schema dexterm-narratives/1) the strategy tracker page reads,
// a text table, and the one-line coin field. Every surface says MEASURED HEAT, NOT ADVICE. Coin names and
// tickers are untrusted: they are firewalled (packs `clean`) here and wrapped again by the MCP layer.
import { clean } from '@dexterm/packs';
import { LIFECYCLE_RULES, type CoinNarrative, type NarrativeSnapshot, type NarrativeTracker } from './tracker.ts';

export const EXPORT_SCHEMA = 'dexterm-narratives/1';
export const HEAT_NOTE = 'Measured heat from recorded market data (volume, new coins, traders). Not advice, not a prediction.';

export interface NarrativeExport {
  schema: typeof EXPORT_SCHEMA;
  generatedAt: string;
  asOf: string | null;
  note: string;
  embedder: string;
  lifecycleRules: Array<{ state: string; rule: string }>;
  coins: number;
  narratives: Array<Omit<NarrativeSnapshot, 'components'> & { components: Record<string, number | null> }>;
  limits: string[];
}

export const LIMITS = [
  'Narratives come from coin names, tickers and (when present) descriptions; X/Telegram-only themes are missed.',
  'Cross-coin holder overlap is not recorded by the data layer, so it is not part of the score (shown as null).',
  'Volume is the source\'s rolling window at the newest sample per coin; coins not sampled for 6 h count as 0.',
  'Clusters never merge or split after the fact: ids are stable, so two converging themes stay two rows.',
];

export function toExport(tr: NarrativeTracker, opts: { limit?: number; now?: number } = {}): NarrativeExport {
  const rows = tr.top(opts.limit ?? 50).map((s) => sanitize(s));
  return {
    schema: EXPORT_SCHEMA, generatedAt: new Date(opts.now ?? Date.now()).toISOString(), asOf: tr.lastTickAt ? new Date(tr.lastTickAt).toISOString() : null,
    note: HEAT_NOTE, embedder: tr.embedder.id, lifecycleRules: LIFECYCLE_RULES.map(([state, rule]) => ({ state, rule })),
    coins: tr.coins.size, narratives: rows, limits: LIMITS,
  };
}

export function sanitize(s: NarrativeSnapshot): NarrativeSnapshot {
  return { ...s, label: clean(s.label, 40), modelLabel: s.modelLabel ? clean(s.modelLabel, 40) : null, topRunner: s.topRunner ? { ...s.topRunner, symbol: clean(s.topRunner.symbol, 16) } : null };
}

const usd = (v: number | null | undefined): string => { if (v == null) return '—'; const a = Math.abs(v); return a >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : a >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : `$${v.toFixed(0)}`; };
const pct = (v: number | null | undefined): string => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);

/** "narrative: PNUT · lifecycle: ignition · rank 3" (the screener/coin pane field). */
export function coinField(n: CoinNarrative | null): string {
  if (!n) return 'narrative: — (not tracked yet)';
  const solo = n.members < 2;
  return `narrative: ${clean(n.label, 24)}${solo ? ' (solo)' : ''} · lifecycle: ${n.lifecycle ?? '—'}${n.rank ? ` · rank ${n.rank}` : ''}${n.saturated ? ' · copy-cat saturated' : ''} · #${n.spawn} of ${n.members}`;
}

/** A plain-text heat table (CLI `narratives top`, MCP text form). */
export function renderTable(rows: NarrativeSnapshot[], width = 110): string {
  const head = '  #  NARRATIVE              THEME           STATE     COINS NEW/h  VOL 1h    SHARE  TRADERS  SCORE  TOP RUNNER';
  const lines = [head.slice(0, width)];
  for (const s of rows) {
    const r = s.topRunner ? `${clean(s.topRunner.symbol, 10)} ${s.topRunner.x.toFixed(1)}x dd ${s.topRunner.drawdownPct.toFixed(0)}%` : '—';
    const line = `${String(s.rank ?? '-').padStart(3)}  ${clean(s.label, 20).padEnd(21)}  ${(s.theme ?? '—').slice(0, 14).padEnd(14)}  ${(s.lifecycle + (s.saturated ? '*' : '')).padEnd(9)} ${String(s.members).padStart(5)} ${s.windows['1h'].newPerHour.toFixed(0).padStart(5)}  ${usd(s.windows['1h'].volume).padEnd(8)}  ${pct(s.windows['1h'].volumeShare).padStart(6)}  ${String(s.windows['1h'].traders).padStart(7)}  ${String(s.score).padStart(5)}  ${r}`;
    lines.push(line.slice(0, width));
  }
  lines.push('* copy-cat saturated · ' + HEAT_NOTE);
  return lines.join('\n');
}

/**
 * The strategy tracker page (`dexterm dash --books FILE`, schema dexterm-dash-books/1) shows `status` cards
 * `{ title, state: 'ok'|'warn'|'down'|'idle', items: [label, value][] }`. One card with the top narratives lets the
 * kit's books feeder add narrative heat to the page without a dashboard change.
 */
export function dashStatusCard(ex: NarrativeExport, limit = 8): { title: string; state: 'ok' | 'warn' | 'down' | 'idle'; items: Array<[string, string]> } {
  const fresh = ex.asOf != null && Date.parse(ex.generatedAt) - Date.parse(ex.asOf) < 15 * 60_000;
  const items: Array<[string, string]> = ex.narratives.slice(0, limit).map((n) => [
    `#${n.rank ?? '-'} ${clean(n.label, 24)}`,
    `${n.lifecycle}${n.saturated ? ' · saturated' : ''} · ${n.members} coins · vol 1h ${usd(n.windows['1h'].volume)} · score ${n.score}`,
  ]);
  items.push(['note', 'measured heat, not advice']);
  return { title: 'Narratives (experimental)', state: !ex.narratives.length ? 'idle' : fresh ? 'ok' : 'warn', items };
}
