// task-1537: the price basis in autotrade text (the runner's lines, the agents' DOSSIER / ENGINE notes, the ledger's
// fill JSON). Market cap by default, from the tick's own cap and price (the supply that source counts) or pump.fun's
// fixed 1B; no supply → the price and why. Display and wording only: the engine, exits and caps read prices.
import { DEFAULT_PRICE_BASIS, fmtCap, fmtUsdPrice, fmtX, knownSupply, withMcap, type PriceBasis, type SupplyHints } from '@dexterm/data/basis';
import type { MarketTick } from './replay.ts';

export type { PriceBasis };
export { DEFAULT_PRICE_BASIS };

/** The supply hints one tick carries (the resolved cap when the task-1518 split rule picked one). */
export function tickHints(k: Partial<Pick<MarketTick, 'mint' | 'launchpad' | 'price' | 'mcap' | 'mcapResolved'>> | null | undefined): SupplyHints {
  if (!k) return {};
  return { mint: k.mint, launchpad: k.launchpad, price: k.price, mcap: k.mcapResolved ?? k.mcap, via: 'tick' };
}

/** A level in the basis: `$69.7K mcap` / a raw price (price basis, unchanged) / `0.0000697 (price; supply unknown)`. */
export function levelText(basis: PriceBasis, price: number | null | undefined, k: Parameters<typeof tickHints>[0]): string {
  if (price === null || price === undefined || !Number.isFinite(price)) return '—';
  if (basis !== 'mcap') return String(price);
  const sup = knownSupply(tickHints(k));
  return sup ? `${fmtCap(price * sup.tokens)} mcap` : `${fmtUsdPrice(price)} (price; supply unknown)`;
}

/** A row of levels (history, ticks) in the basis: caps at the current supply, else raw prices. */
export function levelsText(basis: PriceBasis, prices: readonly (number | null)[], k: Parameters<typeof tickHints>[0]): string {
  const sup = basis === 'mcap' ? knownSupply(tickHints(k)) : null;
  return prices.map((p) => (p === null || !Number.isFinite(p) ? '—' : sup ? fmtCap(p * sup.tokens) : String(p))).join(' ');
}

/** `x` multiple of the current level over the entry (same in either basis). */
export function multipleText(entry: number | null | undefined, now: number | null | undefined): string { return fmtX(entry, now) ?? '—'; }

/** The ledger's fill JSON keeps BOTH: `price` / `avgPrice` and their caps `mcap` / `avgMcap` (null without a supply). */
export function fillMcaps<T extends { price: number; avgPrice: number }>(view: T, k: Parameters<typeof tickHints>[0]): T & { mcap: number | null; avgMcap: number | null } {
  const h = tickHints(k);
  return withMcap(view, { price: 'mcap', avgPrice: 'avgMcap' }, { mint: h.mint, launchpad: h.launchpad, mcap: h.mcap, price: h.price }) as T & { mcap: number | null; avgMcap: number | null };
}
