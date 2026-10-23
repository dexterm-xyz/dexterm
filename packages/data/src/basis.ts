// @dexterm/data/basis (task-1537): THE price-basis module. Market cap is the default way dexterm shows and talks
// about a coin ("entered at $69.7K, exited at $264.9K, 3.8x"); USD price per token is the alternative when the user
// sets `display.priceMode: "price"` in ~/.dexterm/config.json (or for one run: `--price` / DEXTERM_PRICE_BASIS=price).
//
// One resolver (`resolveBasis`) decides what a price slot shows, one formatter pair (`fmtCap` / `fmtUsdPrice`) draws it,
// and `basisLanguage` is the paragraph every model-facing prompt carries so the agents speak the same basis as the UI.
//
// Supply rule (shared with the PnL card, task-1518): a market cap the data source reports, else price × a supply that
// is KNOWN: the source's own mcap ÷ price, the recorded FDV ÷ price, or pump.fun's fixed 1B for a pump.fun coin. A
// supply is never guessed: with none, the slot shows the price and says why (`fallback`).
//
// Pure: no I/O, no imports. Display and wording only; nothing here is read by the signer, caps, plans or tickets.
// JSON outputs keep BOTH `price` and `mcap` fields always (`withMcap`); only the human-facing text switches.

export type PriceBasis = 'mcap' | 'price';
export const PRICE_BASES = ['mcap', 'price'] as const;
/** The default basis everywhere (UI, CLI text, agent language) when config, flag and env say nothing. */
export const DEFAULT_PRICE_BASIS: PriceBasis = 'mcap';
/** One-run override: `DEXTERM_PRICE_BASIS=price dexterm …` (the CLI flags `--price` / `--mcap` set it too). */
export const PRICE_BASIS_ENV = 'DEXTERM_PRICE_BASIS';

export function isPriceBasis(v: unknown): v is PriceBasis { return v === 'mcap' || v === 'price'; }

/** The one-run override from the environment, or null when unset / not a basis. */
export function envPriceBasis(env: Record<string, string | undefined> | null | undefined): PriceBasis | null {
  const v = env?.[PRICE_BASIS_ENV]?.trim().toLowerCase();
  return isPriceBasis(v) ? v : null;
}

/**
 * The basis in effect: the one-run override (flag/env) wins, then the config value (`display.priceMode`), then mcap.
 * A config written before task-1537 is migrated (custom v4 → v5), so `configured` is the user's saved choice.
 */
export function pickBasis(configured: unknown, env?: Record<string, string | undefined> | null): PriceBasis {
  return envPriceBasis(env) ?? (isPriceBasis(configured) ? configured : DEFAULT_PRICE_BASIS);
}

// ------------------------------------------------------------------------------------------------ formatters

const SUB = '₀₁₂₃₄₅₆₇₈₉';
const trim = (s: string): string => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);

/**
 * A market cap (or any large USD amount) in sentences, rows and lines: `$950`, `$69.7K`, `$264.9K`, `$1.2M`, `$1.23M`,
 * `$4.5B`. K keeps one decimal, M / B / T two, trailing zeros dropped; the unit is promoted AFTER rounding so 999 960
 * reads `$1M`, never `$1000K`. Null / non-finite → '—'. (Narrow table cells use the 3-significant-digit tui form.)
 */
export function fmtCap(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const sign = n < 0 ? '-' : '';
  const a = Math.abs(n);
  if (a < 999.5) return `${sign}$${a < 1 ? trim(a.toFixed(2)) : String(Math.round(a))}`;
  const units = ['K', 'M', 'B', 'T'];
  let u = 0, v = a / 1000;
  while (u < units.length - 1 && v >= 1000) { v /= 1000; u++; }
  const dp = (i: number): number => (i === 0 ? 1 : 2);
  let r = Number(v.toFixed(dp(u)));
  if (r >= 1000 && u < units.length - 1) { u++; r = Number((r / 1000).toFixed(dp(u))); }
  return `${sign}$${trim(r.toFixed(dp(u)))}${units[u]}`;
}

/**
 * A USD price per token, the usual small-number form with subscript zeros: `$0.0₄123`, `$0.0123`, `$1.234`, `$142.50`.
 * Matches `fmtPrice` in @dexterm/tui (tested), so a price reads the same on every surface.
 */
export function fmtUsdPrice(p: number | null | undefined): string {
  if (p === null || p === undefined || !Number.isFinite(p)) return '—';
  if (p < 0) return `-${fmtUsdPrice(-p)}`;
  if (p >= 1000) return `$${p.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  if (p >= 1) return `$${p.toFixed(p >= 100 ? 2 : 3)}`;
  if (p >= 0.01) return `$${p.toFixed(4)}`;
  const m = p.toFixed(12).match(/^0\.(0*)(\d+)/);
  if (!m) return `$${p}`;
  const zeros = m[1].length;
  const digits = m[2].replace(/0+$/, '').slice(0, 4) || '0';
  if (zeros < 3) return `$0.${m[1]}${digits}`;
  return `$0.0${String(zeros).split('').map((c) => SUB[Number(c)]).join('')}${digits}`;
}

/** An x-multiple between two levels of the same basis: `3.8x`, `0.42x`, `12x`. Null when either side is unusable. */
export function fmtX(from: number | null | undefined, to: number | null | undefined): string | null {
  if (from === null || from === undefined || to === null || to === undefined || !Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to < 0) return null;
  const x = to / from;
  return `${x >= 10 ? x.toFixed(0) : x >= 1 ? x.toFixed(1) : x.toFixed(2)}x`;
}

// ------------------------------------------------------------------------------------------------ supply + resolver

/** pump.fun mints a fixed 1,000,000,000 supply per coin (none is minted later), so its market cap is price × 1B. */
export const PUMP_FUN_SUPPLY = 1_000_000_000;

export interface SupplyInfo { tokens: number; source: string }

export interface SupplyHints {
  mint?: string | null;
  launchpad?: string | null;
  /** The source's market cap and price AT THE SAME TICK (their ratio is the supply that source counts). */
  mcap?: number | null;
  price?: number | null;
  /** Recorded FDV (total supply × price). */
  fdv?: number | null;
  /** An explicit, already-known supply in whole tokens (e.g. recorded on a ledger row). */
  supply?: number | null;
  /** Where these numbers came from, for the source note (`market data`, `recorded tick`, …). */
  via?: string | null;
}

const pos = (n: number | null | undefined): n is number => n !== null && n !== undefined && Number.isFinite(n) && n > 0;

/**
 * The KNOWN supply for a coin, or null. Order: an explicit supply; the source's mcap ÷ price; recorded FDV ÷ price
 * (a fully diluted cap on a non-pump coin, and the source says so); pump.fun's fixed 1B for a pump.fun coin (by
 * launchpad, or a `…pump` mint with no launchpad). Never guessed.
 */
export function knownSupply(h: SupplyHints): SupplyInfo | null {
  const via = h.via ? ` (${h.via})` : '';
  if (pos(h.supply)) return { tokens: h.supply, source: `recorded supply${via}` };
  if (pos(h.mcap) && pos(h.price) && Number.isFinite(h.mcap / h.price)) return { tokens: h.mcap / h.price, source: `market cap ÷ price${via}` };
  if (pos(h.fdv) && pos(h.price) && Number.isFinite(h.fdv / h.price)) return { tokens: h.fdv / h.price, source: `recorded FDV ÷ price${via}` };
  const mint = h.mint ?? '';
  if (h.launchpad === 'pump.fun' || ((!h.launchpad || h.launchpad === 'unknown') && mint.endsWith('pump'))) return { tokens: PUMP_FUN_SUPPLY, source: 'pump.fun fixed supply' };
  return null;
}

/** Why a slot that wanted market cap shows a price instead (said next to the number, never hidden). */
export const NO_SUPPLY_REASON = 'market cap unknown: no supply recorded, showing price';

/** What one price slot shows under a basis. */
export interface BasisValue {
  /** The basis asked for (config / flag / env). */
  want: PriceBasis;
  /** The basis actually drawn: 'mcap' only when a supply is known. */
  basis: PriceBasis;
  price: number | null;
  mcap: number | null;
  /** The headline text: `$69.7K` in mcap, `$0.0₄697` in price. */
  text: string;
  /** Both numbers, the asked-for one first: `$69.7K mcap ($0.0₄697)` / `$0.0₄697 (mcap $69.7K)`. */
  both: string;
  /** Non-null when mcap was asked for but cannot be shown: the reason, to print next to the price. */
  fallback: string | null;
  supply: SupplyInfo | null;
}

/**
 * THE resolver every screen, line, table and prompt calls: the headline figure for one price slot.
 * `price` is the USD (or the caller's unit) price at that moment; `mcap` a cap the source reports for the SAME moment.
 * A historical price (an entry fill) is turned into a cap with a known supply (`supply` / FDV / pump.fun 1B).
 */
export function resolveBasis(want: PriceBasis, o: SupplyHints & { price?: number | null; mcap?: number | null }): BasisValue {
  const price = Number.isFinite(o.price as number) ? (o.price as number) : null;
  const sup = knownSupply(o);
  const mcap = pos(o.mcap) && !pos(o.supply) ? o.mcap : price !== null && sup ? price * sup.tokens : null;
  const pText = fmtUsdPrice(price);
  if (want === 'mcap' && mcap !== null) {
    return { want, basis: 'mcap', price, mcap, text: fmtCap(mcap), both: price !== null ? `${fmtCap(mcap)} mcap (${pText})` : `${fmtCap(mcap)} mcap`, fallback: null, supply: sup };
  }
  const fallback = want === 'mcap' && price !== null ? NO_SUPPLY_REASON : null;
  const both = mcap !== null ? `${pText} (mcap ${fmtCap(mcap)})` : fallback ? `${pText} (${fallback})` : pText;
  return { want, basis: 'price', price, mcap, text: pText, both, fallback, supply: sup };
}

/** A level in a sentence: `$69.7K` (mcap) or `$0.0₄697` (price, or the mcap fallback with `· supply unknown`). */
export function fmtLevel(want: PriceBasis, o: SupplyHints & { price?: number | null; mcap?: number | null }): string {
  const v = resolveBasis(want, o);
  return v.fallback ? `${v.text} (price; supply unknown)` : v.text;
}

/**
 * An entry → exit (or → now) sentence in the basis: mcap `entered at $69.7K, exited at $264.9K (3.8x)`, price
 * `entered at $0.0₄697, exited at $0.0₃265 (3.8x)`. Both levels use the same supply, so the multiple is the same in
 * either basis. `exit` null with `now` → `…, now $120K (1.7x)`.
 */
export function entryExitLine(want: PriceBasis, o: SupplyHints & { entry: number | null; exit?: number | null; now?: number | null }): string {
  const sup = knownSupply({ ...o, mcap: o.mcap, price: o.price });
  const asCap = want === 'mcap' && sup !== null;
  const f = (p: number | null | undefined): string => (p === null || p === undefined || !Number.isFinite(p) ? '—' : asCap ? fmtCap(p * sup!.tokens) : fmtUsdPrice(p));
  const end = o.exit !== null && o.exit !== undefined ? o.exit : o.now ?? null;
  const verb = o.exit !== null && o.exit !== undefined ? 'exited at' : 'now';
  const x = fmtX(o.entry, end);
  const tail = want === 'mcap' && !asCap ? ' (prices: supply unknown)' : '';
  return `entered at ${f(o.entry)}${end !== null ? `, ${verb} ${f(end)}` : ''}${x ? ` (${x})` : ''}${tail}`;
}

/**
 * JSON keeps BOTH numbers: return `obj` with a market-cap twin for each price key (`pairs` maps price key → cap key,
 * e.g. `{ price: 'mcap', entryPrice: 'entryMcap' }`), from a known supply, else null. A cap already on the object (a
 * source-reported one) is kept. Never removes or changes a price field.
 */
export function withMcap<T extends Record<string, unknown>>(obj: T, pairs: Readonly<Record<string, string>>, h: SupplyHints): T & Record<string, number | null> {
  const sup = knownSupply(h);
  const out: Record<string, unknown> = { ...obj };
  for (const [k, name] of Object.entries(pairs)) {
    if (typeof out[name] === 'number' && Number.isFinite(out[name] as number)) continue;
    const p = obj[k];
    out[name] = typeof p === 'number' && Number.isFinite(p) && sup ? p * sup.tokens : null;
  }
  return out as T & Record<string, number | null>;
}

// ------------------------------------------------------------------------------------------------ agent language

/** A short hint for tool descriptions (MCP, agent tool table) so external agents also speak the basis. */
export const MCAP_FIELD_HINT = 'Every price field has a market-cap twin (`mcap`, `entryMcap`, …; null when the supply is unknown). basis: talk in market cap by default (cap at entry, cap now, targets/stops as cap levels, x-multiples); use the price fields only when the user\'s display.priceMode is "price" or the cap is null.';

/**
 * The paragraph every model-facing prompt carries (the chat assistant, the autotrade candidate agent, help answers).
 * Follows the basis AT RUN TIME: tests assert both texts.
 */
export function basisLanguage(basis: PriceBasis): string {
  if (basis === 'price') {
    return [
      'PRICE BASIS: USD PRICE (the user set display.priceMode = "price").',
      'Talk in USD price per token: the price at entry, the price now, targets and stops as price levels (with x-multiples).',
      'Quote market cap only as a secondary number in brackets ("$0.0₄697 (mcap $69.7K)"). Tools return both `price` and `mcap` fields.',
    ].join(' ');
  }
  return [
    'PRICE BASIS: MARKET CAP (the default; display.priceMode = "mcap").',
    'Talk about a coin the way traders do, in market cap: the cap at entry and the cap now ("in at $69.7K, now $264.9K, 3.8x"),',
    'targets and stops as market-cap levels ("take profit at $500K, stop at $40K"), and moves as x-multiples.',
    'Use the `mcap` / `*Mcap` fields tools return; write caps as $69.7K / $1.2M. A per-token price only in brackets when it helps,',
    'or alone when the cap is null (the supply is unknown): then say "price only, supply unknown". Never invent a supply.',
  ].join(' ');
}
