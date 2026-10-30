// dexterm — STREAMER OVERLAY PnL scene (task-1427). Draws the coin's result with the task-1407 card renderer, so
// the stamp (PAPER / LIVE), the provenance block, the data ages and the "not financial advice" footer are the
// renderer's own and cannot be turned off here.
//
// Two sources, never mixed:
//   - the spectator stream (default): the agent's PAPER fills on the coin, exactly as the paper desk booked them.
//     The stream only ever carries paper fills (an agent can never trade for real), so this card is always PAPER.
//   - the trade ledger (`--ledger <tradeId>`): one round trip of the user's own unified ledger, read from the local
//     file (no network). Its wallet mode picks the stamp: paper → PAPER, devnet / live → LIVE. A real-mode row is
//     refused by the adapter (dexterm only modelled that fill).
// Addresses are masked before they reach the card (the stream copy is already redacted; a ledger mint is masked
// here), the size is a band, and the wallet is never drawn. A ledger row's tx signatures stay in the card input so
// the LIVE note counts them truthfully; the renderer prints a signature only with showWallet, which the overlay
// never sets, and only the PNG leaves this module.

import { computeCard, cardPng, stampOf, CardError, CARD_GEOMETRY, ledgerCardInput, type CardInput, type LedgerCardRow, type CardStats } from '../pnl-card.ts';
import { maskAddress } from '@dexterm/agents';
import { THEMES } from '@dexterm/tui';
import { fmtAgeShort, type OverlayState, type SceneHeader } from './model.ts';

/** Paper fills carry whole-token amounts; the card's integer token maths uses this many decimals for them. */
const STREAM_DECIMALS = 6;

export interface PnlView extends SceneHeader {
  scene: 'pnl';
  /** PAPER / LIVE (the renderer's stamp), null when there is no card yet. */
  stamp: string | null;
  /** The renderer's stamp strip ("PAPER · SIMULATED", "LIVE · DEVNET", "LIVE · WALLET-SIGNED"), the page's chip text. */
  strip: string | null;
  /** The card PNG (base64) at the renderer's exact size, null when there is no card yet. */
  png: string | null;
  w: number;
  h: number;
  /** Why there is no card (no fills yet, the ledger refused, …), or the card's source line. */
  note: string;
}

/** Card input from the stream's PAPER fills on one coin. The mark (open position) is the newest stream price. */
export function streamCardInput(state: OverlayState, mint: string): CardInput | null {
  const p = state.paper.get(mint);
  if (!p || !p.fills.length) return null;
  const scale = 10 ** STREAM_DECIMALS;
  const fills = p.fills.map((f) => ({
    t: f.t, side: f.side, solDelta: (f.side === 'buy' ? -1 : 1) * Math.abs(f.sol),
    tokenDelta: BigInt(Math.round(f.qty * scale)) * (f.side === 'buy' ? 1n : -1n), feeSol: null, sig: null,
  }));
  // Mark: the newest price the stream carried, in SOL via the SOL/USD rate the newest priced fill implies
  // (its USD price ÷ its SOL price). Without a later price, the last fill's own SOL price marks the position.
  const last = p.fills[p.fills.length - 1];
  const lastSolPx = Math.abs(last.sol) / last.qty;
  const priced = [...p.fills].reverse().find((f) => f.priceUsd !== null && f.priceUsd > 0);
  const c = state.coins.get(mint);
  let mark: CardInput['mark'] = { priceSol: lastSolPx, at: last.t, via: 'last paper fill' };
  if (priced && c?.priceUsd && c.priceUsd.at > last.t) {
    const solUsd = priced.priceUsd! / (Math.abs(priced.sol) / priced.qty);
    if (solUsd > 0 && Number.isFinite(solUsd)) mark = { priceSol: c.priceUsd.value / solUsd, at: c.priceUsd.at - c.priceUsd.ageSec * 1000, via: 'stream price, SOL/USD implied by the paper fill' };
  }
  return {
    source: 'paper', mint, symbol: p.symbol, name: null, decimals: STREAM_DECIMALS, fills,
    ledger: 'agent paper desk via the spectator stream', wallet: null, mark,
    excluded: [], fees: 'as booked by the paper desk (simulated)', image: null, supply: null,
  };
}

/** Card input from one ledger row, the mint masked first (the overlay never shows a full address). */
export function ledgerOverlayInput(row: LedgerCardRow, solUsd: { usd: number; source: string } | null): CardInput {
  const input = ledgerCardInput(row, { solUsd });
  return { ...input, mint: maskAddress(row.mint) };
}

function header(state: OverlayState, s: CardStats | null, now: number): SceneHeader {
  const ageSec = s ? Math.max(0, now - (s.open && s.input.mark ? s.input.mark.at : s.lastT)) / 1000 : null;
  return { sample: state.sample, ageSec, age: ageSec === null ? 'no data yet' : `data age ${fmtAgeShort(ageSec)}` };
}

/** Render the PnL scene. `input` null → the stream's current coin. Never throws: a refusal becomes the note. */
export function pnlView(state: OverlayState, now: number, input?: CardInput | null): PnlView {
  const g = CARD_GEOMETRY.wide;
  const inp = input ?? (state.paperCurrent ? streamCardInput(state, state.paperCurrent) : null);
  if (!inp) return { scene: 'pnl', ...header(state, null, now), stamp: null, strip: null, png: null, w: g.w, h: g.h, note: 'no PAPER trade by the agent yet' };
  let s: CardStats;
  try { s = computeCard(inp, now); }
  catch (e) {
    if (e instanceof CardError) return { scene: 'pnl', ...header(state, null, now), stamp: null, strip: null, png: null, w: g.w, h: g.h, note: e.message };
    throw e;
  }
  const png = cardPng(s, { aspect: 'wide' }).toString('base64');
  return { scene: 'pnl', ...header(state, s, now), stamp: inp.source === 'paper' ? 'PAPER' : 'LIVE', strip: stampOf(s, THEMES.cyberspace).strip, png, w: g.w, h: g.h, note: inp.ledger };
}
