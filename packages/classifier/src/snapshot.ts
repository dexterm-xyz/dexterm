// The app's live token row (@dexterm/data TokenSnapshot: token + pair + stats + audit) -> CoinInput, so the screener,
// the MCP tools and watch rules all build the same dossier the benchmark scored.

import type { TokenSnapshot } from '@dexterm/data';
import { coinDossier, type CoinInput } from './dossier.ts';
import type { Dossier } from './types.ts';

const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function coinInputFromSnapshot(s: TokenSnapshot & { mint?: string }, now = Date.now()): CoinInput {
  const p = s.pair, st = s.stats, a = s.audit;
  const created = n(s.token.createdAt) ?? n(p?.createdAt);
  const h1 = st?.perWindow?.h1 ?? null;
  return {
    mint: s.mint ?? s.token.mint,
    symbol: s.token.symbol ?? null,
    name: s.token.name ?? null,
    age_min: created === null ? null : Math.max(0, (now - created) / 60_000),
    liquidity_usd: n(p?.liquidityUsd),
    mcap_usd: n(p?.mcap) ?? n(p?.fdv),
    vol5m_usd: n(p?.volume?.m5),
    vol1h_usd: n(p?.volume?.h1),
    buys5m: n(p?.txns?.m5?.buys), sells5m: n(p?.txns?.m5?.sells),
    buys1h: n(p?.txns?.h1?.buys), sells1h: n(p?.txns?.h1?.sells),
    change5m_pct: n(p?.priceChange?.m5), change1h_pct: n(p?.priceChange?.h1),
    holders: n(st?.holderCount), organic_score: n(st?.organicScore),
    traders1h: n(h1?.numTraders), net_buyers1h: n(h1?.numNetBuyers),
    top10_pct: n(a?.top10Pct), dev_pct: n(a?.devPct), dev_other_mints: n(a?.devMints),
    mint_authority: a?.mintAuthority ?? null, freeze_authority: a?.freezeAuthority ?? null,
    launchpad: typeof s.token.launchpad === 'string' ? s.token.launchpad : null,
    dex: p?.dex ?? null,
  };
}

export function dossierFromSnapshot(s: TokenSnapshot & { mint?: string }, now = Date.now()): Dossier {
  return coinDossier(coinInputFromSnapshot(s, now));
}
