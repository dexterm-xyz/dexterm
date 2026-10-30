// task-1822: keep `state.classifierByMint` filled for the `rugp` watch-rule field. It does nothing (no model call,
// no network) unless an ENABLED rule mentions `rugp`. Then, each rules tick:
//   - provider `heuristic`: every rule row is scored at once (local arithmetic, H1 p(rug)).
//   - any other provider: one coin at a time in the background, each re-scored at most every RESCORE_MS, the open
//     token first; a failure falls back to the heuristic (labelled by the provider id stored with the estimate).
// Estimates are model output for alerts only: nothing here trades, sizes, arms or writes config.

import type { RuleRow } from '@dexterm/custom';
import type { AppState } from './state.ts';

export const RESCORE_MS = 10 * 60_000;

interface Live {
  provider: import('@dexterm/classifier').Provider | null;
  loading: Promise<void> | null;
  inflight: boolean;
  fallback: boolean;
  calibration: Record<string, import('@dexterm/classifier').Platt>;
}
const LIVE = new WeakMap<AppState, Live>();

export function rulesUseRugp(state: AppState): boolean {
  return !!state.rulesUi?.engine.rules.some((r) => r.enabled && /\brugp\b/i.test(r.whenText));
}

/** The dossier fields a rule row carries (the screener row is structurally a RuleRow). */
export function coinInputFromRuleRow(r: RuleRow): import('@dexterm/classifier').CoinInput {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const b = (v: unknown) => (v === 1 ? true : v === 0 ? false : null);
  return {
    mint: r.mint, symbol: r.symbol ?? null, age_min: n(r.ageMin), liquidity_usd: n(r.liq), mcap_usd: n(r.mcap),
    vol5m_usd: n(r.vol5m), vol1h_usd: n(r.vol1h), holders: n(r.holders), top10_pct: n(r.top10), dev_pct: n(r.dev),
    organic_score: n(r.org), change5m_pct: n(r.chg?.m5), change1h_pct: n(r.chg?.h1), buys1h: n(r.buys), sells1h: n(r.sells),
    mint_authority: b(r.mintable), freeze_authority: b(r.freezable), launchpad: r.launchpad ?? null,
  };
}

async function load(state: AppState, live: Live, env: NodeJS.ProcessEnv): Promise<void> {
  const C = await import('@dexterm/classifier');
  const cfg = C.loadClassifierConfig(env).config;
  live.fallback = cfg.fallback;
  live.calibration = cfg.calibration;
  try { live.provider = C.providerFromConfig(cfg, cfg.provider, { env }); } catch { live.provider = C.heuristicProvider(); }
  void state;
}

/** One step; call from the rules tick with the rows it is about to evaluate. Never throws. */
export function classifierLiveTick(state: AppState, rows: readonly RuleRow[], now: number, env: NodeJS.ProcessEnv = process.env): void {
  if (!rows.length || !rulesUseRugp(state)) return;
  let live = LIVE.get(state);
  if (!live) { live = { provider: null, loading: null, inflight: false, fallback: true, calibration: {} }; LIVE.set(state, live); }
  if (!live.provider) { live.loading ??= load(state, live, env).catch(() => { live!.loading = null; }); return; }
  const map = (state.classifierByMint ??= new Map());
  const due = (m: string) => { const e = map.get(m); return !e || now - e.at >= RESCORE_MS; };
  const provider = live.provider;
  if (live.inflight) return;
  live.inflight = true;
  const open = state.live?.token?.view.mint ?? null;
  const queue = rows.filter((r) => due(r.mint)).sort((a, b) => (a.mint === open ? -1 : b.mint === open ? 1 : 0));
  const batch = provider.id === 'heuristic' ? queue : queue.slice(0, 1);
  if (!batch.length) { live.inflight = false; return; }
  void (async () => {
    try {
      const C = await import('@dexterm/classifier');
      for (const r of batch) {
        try {
          const res = await C.classify(provider, C.COIN_RISK, C.coinDossier(coinInputFromRuleRow(r)), { calibration: live!.calibration, fallback: live!.fallback ? undefined : null });
          const p = res.answers.drain_6h?.probs.yes;
          if (typeof p === 'number') map.set(r.mint, { p, model: `${res.provider} ${res.model}`, at: now });
        } catch { map.set(r.mint, { p: NaN, model: 'error', at: now }); }
      }
    } finally { live!.inflight = false; }
  })();
}
