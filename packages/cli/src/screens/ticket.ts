// dexterm — trade ticket screen (task-1310 T0). PAPER only: a simulated buy/sell priced from a live keyless
// Jupiter quote, every frame labelled PAPER. task-1571: there is no LIVE ticket — dexterm holds no key and signs
// nothing; live trading happens in the Telegram trading bot of the user's choice. Pure renderer.
import {
  Canvas, badge, header, footer, breakpoint, mix, isCalm, fmtPrice, fmtPriceBare, fmtAmount, fmtPct, fmtMcap,
} from '@dexterm/tui';
import { priceModeOf, supplyForMint } from '../display.ts';
import { lamportsToSol, rawToTokens } from '@dexterm/data';
import type { AppState } from '../state.ts';
import { headerModel } from '../state.ts';
import { slippageBps, type TicketView } from '../trade.ts';

function fmtSol(sol: number, digits = 4): string {
  const a = Math.abs(sol);
  return `${a.toFixed(digits)} SOL`;
}

/**
 * task-1368 item e: a token quantity for the ticket. `fmtAmount` keeps small amounts (0.0144 AVGOx, never "0");
 * when the token's decimals are still unknown the number would be a guess, so say that and show the raw units.
 */
function tokenAmount(raw: bigint, decimals: number, symbol: string, decimalsKnown: boolean): string {
  if (!decimalsKnown) return `${symbol}: decimals unknown yet (raw ${raw.toString()})`;
  return `${fmtAmount(rawToTokens(raw, decimals))} ${symbol}`;
}

export function renderTicket(c: Canvas, state: AppState): void {
  const t = c.theme;
  header(c, headerModel(state));
  const bp = breakpoint(c.w);
  // Live binding is the source of truth; the seeded demo view backs fixture/one-shot frames.
  const view = (state.live?.ticket ? state.live.ticket.view() : state.ticket) ?? null;

  // Always-on banner strip (never hidden, any state).
  const bannerY = 2;
  const bannerColor = t.warn;
  c.fill(0, bannerY, c.w, 1, ' ', { bg: mix(t.bg, bannerColor, 0.16) });
  c.text(2, bannerY, ' ◈ PAPER TRADING — simulated · no real orders · no keys · no signing ', { fg: bannerColor, bg: mix(t.bg, bannerColor, 0.16), b: true });
  const linked = state.live?.linkedWallet;
  if (linked) c.textR(2, bannerY, c.w - 3, `linked: ${linked.publicKey.slice(0, 4)}…${linked.publicKey.slice(-4)} `, { fg: t.muted, bg: mix(t.bg, bannerColor, 0.16) });
  c.noRain(0, bannerY, c.w, 1);

  if (!view) {
    c.text(2, 4, 'Open a paper trade ticket from a token screen:  B buy · S sell', { fg: t.muted, bg: t.bg });
    footer(c, [['esc', 'back'], ['P', 'positions'], ['q', 'quit']], t.name, isCalm(state.vfx));
    return;
  }

  const ts = view.ticket;
  const mode = priceModeOf(state); // task-1537: fills and prices read as market caps by default
  const sup = supplyForMint(state, ts.mint);
  const buy = ts.side === 'buy';
  const sideColor = buy ? t.up : t.down;
  const top = 4;
  const w = Math.min(bp === 'compact' ? c.w - 2 : 78, c.w - 2);
  const x0 = 1;
  const h = c.h - top - 1;
  const title = `◈ PAPER ${ts.side.toUpperCase()} TICKET`;
  const caption = 'jupiter keyless quote · paper fill';
  // task-1340: the ticket is PLAIN by construction — no heading (no chromatic split on its title) and every cell of
  // its rect is shielded below, so no effect pass (rain, mosh, shake, scanlines, trade moments) can write a glyph, a
  // colour or a background into it in any phase. The banner rows above it are shielded too.
  const box = c.box(x0, top, w, h, { title, titleFg: sideColor, caption, captionFg: t.dim, border: mix(t.border, sideColor, 0.5), plain: true });
  c.shieldRect(x0, top, w, h);
  c.shieldRect(0, bannerY, c.w, 2);
  const bg = box.bg;
  const ix = box.x + 2;
  const iw = box.w - 4;
  let y = box.y + 1;

  // identity + side toggle
  let x = c.text(ix, y, `$${ts.symbol}`, { fg: t.borderFocus, bg, b: true });
  x = c.text(x + 1, y, `${ts.mint.slice(0, 4)}…${ts.mint.slice(-4)}`, { fg: t.dim, bg });
  x = badge(c, x + 2, y, buy ? '▲ BUY' : '▼ SELL', sideColor, { on: bg, bold: true }) + 1;
  x = badge(c, x + 1, y, 'PAPER', t.warn, { on: bg, bold: true }) + 1;
  c.textR(ix, y, iw, ts.phase === 'editing' ? '← → flip side' : '', { fg: t.dim, bg });
  y += 2;

  // size field
  const sizeUnit = buy ? (ts.sizeUnit === 'sol' ? 'SOL' : '% of balance') : '% of position';
  field(c, ix, y, iw, bg, 'Size', `${ts.sizeInput || '—'} ${sizeUnit}`, ts.field === 'size' && ts.phase === 'editing', t);
  y += 1;
  field(c, ix, y, iw, bg, 'Slippage', `${slippageBps(ts)} bps`, ts.field === 'slippage' && ts.phase === 'editing', t);
  y += 2;

  {
    // quote block (the paper warm quote)
    c.text(ix, y, 'QUOTE', { fg: t.dim, bg });
    c.textR(ix, y, iw, view.loading ? '· fetching…' : view.quote ? `· ${Math.max(0, Math.round((view.quoteAgeMs ?? 0) / 1000))}s ago` : view.error ? '· unavailable' : '', { fg: view.error ? t.down : t.dim, bg });
    c.hline(box.x + 1, y + 1, box.w - 2, { fg: t.border, bg, soft: true });
    y += 2;
    const q = view.quote;
    const preview = view.preview;
    const decimalsKnown = view.decimalsKnown !== false;
    if (q && preview) {
      const tokenAbs = buy ? preview.tokenDelta : -preview.tokenDelta;
      const spend = buy ? `${fmtSol(lamportsToSol(-preview.solDelta))}` : tokenAmount(tokenAbs, ts.decimals, ts.symbol, decimalsKnown);
      const recv = buy ? tokenAmount(tokenAbs, ts.decimals, ts.symbol, decimalsKnown) : `${fmtSol(lamportsToSol(preview.solDelta))}`;
      kv(c, ix, y++, iw, bg, 'You pay', spend, t, buy ? t.down : t.text);
      kv(c, ix, y++, iw, bg, 'You receive', recv, t, buy && !decimalsKnown ? t.warn : t.up);
      // task-1537: in the market-cap basis (default) the fill price reads as the cap it buys/sells at, the price beside it
      const capAt = mode === 'mcap' && sup !== null && preview.priceUsd !== null ? fmtMcap(preview.priceUsd * sup) : null;
      kv(c, ix, y++, iw, bg, capAt ? 'At mcap' : 'Price', decimalsKnown ? `${capAt ? `${capAt}  ·  ` : ''}${fmtPriceBare(preview.priceSol)} SOL${preview.priceUsd !== null ? `  ·  ${fmtPrice(preview.priceUsd)}` : ''}` : 'per-token price needs the decimals', t, decimalsKnown ? t.text : t.warn);
      const impact = preview.priceImpactPct;
      kv(c, ix, y++, iw, bg, 'Price impact', impact === null ? '—' : fmtPct(impact, { sign: false }), t, impact !== null && impact > 5 ? t.down : impact !== null && impact > 1 ? t.warn : t.muted);
      kv(c, ix, y++, iw, bg, 'Min received', buy ? tokenAmount(q.otherAmountThreshold, ts.decimals, ts.symbol, decimalsKnown) : fmtSol(lamportsToSol(q.otherAmountThreshold)), t, t.muted);
      kv(c, ix, y++, iw, bg, 'Sim fee', fmtSol(lamportsToSol(preview.feeLamports), 6), t, t.muted);
      kv(c, ix, y++, iw, bg, 'Route', q.route.length ? q.route.join(' → ') : 'direct', t, t.accent);
    } else if (view.error) {
      c.text(ix, y++, `⚠ ${view.error}`, { fg: t.down, bg }, iw);
    } else {
      c.text(ix, y++, view.loading ? 'fetching a live quote…' : 'enter a size to see a quote', { fg: t.dim, bg }, iw);
    }
    y += 1;
  }

  // wallet line
  c.hline(box.x + 1, y, box.w - 2, { fg: t.border, bg, soft: true });
  y += 1;
  kv(c, ix, y++, iw, bg, 'Paper balance', fmtSol(view.balanceSol), t, t.text);
  if (!buy || view.positionTokens > 0) kv(c, ix, y++, iw, bg, `Position`, `${fmtAmount(view.positionTokens)} ${ts.symbol}`, t, t.muted);
  y += 1;

  // gate / receipt region
  const gy = box.y + box.h - 3;
  c.hline(box.x, gy - 1, box.w, { fg: mix(t.border, sideColor, 0.5), bg, soft: true });
  const tint = mix(bg, sideColor, 0.18);
  if (ts.phase === 'confirm') {
    c.fill(box.x + 1, gy, box.w - 2, 2, ' ', { bg: tint });
    if (ts.typebackRequired) {
      c.text(ix, gy, `⚠ large order — type the size (${ts.sizeInput}) then press Y:`, { fg: t.warn, bg: tint, b: true }, iw);
      c.text(ix, gy + 1, `▌ ${ts.typeback || ''}`, { fg: t.text, bg: tint, b: true });
    } else {
      c.text(ix, gy, `CONFIRM PAPER ${ts.side.toUpperCase()} — press Y   (esc cancels)`, { fg: sideColor, bg: tint, b: true }, iw);
    }
    if (ts.message) c.text(ix, gy + 1, ts.message, { fg: t.warn, bg: tint }, iw);
  } else if (ts.phase === 'filling') {
    const line = view.rateLimited
      ? '⚠ rate limited by Jupiter — retrying…   (esc cancels)'
      : 'booking paper fill from a fresh quote…   (esc cancels)';
    c.text(ix, gy, line, { fg: view.rateLimited ? t.warn : t.ai, bg, b: true }, iw);
  } else if (ts.phase === 'filled' && view.receipt) {
    const r = view.receipt;
    const got = r.side === 'buy' ? `${fmtAmount(rawToTokens(r.tokenDelta, r.decimals))} ${r.symbol}` : fmtSol(lamportsToSol(r.solDelta));
    const at = mode === 'mcap' && sup !== null && r.priceUsd !== null ? `${fmtMcap(r.priceUsd * sup)} mcap (${fmtPriceBare(r.priceSol)} SOL)` : `${fmtPriceBare(r.priceSol)} SOL`; // task-1537
    c.text(ix, gy, `✓ PAPER ${r.side.toUpperCase()} filled — ${got} @ ${at}`, { fg: t.up, bg, b: true }, iw);
    const extra = r.side === 'sell' ? `realized ${r.realizedLamports >= 0n ? '+' : ''}${fmtSol(lamportsToSol(r.realizedLamports))}` : 'cost booked to position';
    c.text(ix, gy + 1, `${extra} · esc=back to token · P=positions`, { fg: t.muted, bg }, iw);
  } else if (ts.phase === 'error') {
    c.text(ix, gy, `⚠ ${ts.message ?? 'order failed'}`, { fg: t.down, bg, b: true }, iw);
    c.text(ix, gy + 1, 'esc=back to token · P=positions', { fg: t.muted, bg }, iw);
  } else {
    c.text(ix, gy, `⏎ review → Y confirm   ·   gate ${ts.gateOn ? 'ON' : 'off'} (keypress required)`, { fg: t.muted, bg }, iw);
    if (ts.message) c.text(ix, gy + 1, ts.message, { fg: t.warn, bg }, iw);
  }

  const keys: [string, string][] = [['⏎', 'review'], ['Y', 'confirm'], ['tab', 'field'], ['←→', 'side'], ['u', 'unit']];
  keys.push(['esc', 'cancel'], ['P', 'positions']);
  footer(c, keys, t.name, isCalm(state.vfx));
}

function field(c: Canvas, x: number, y: number, w: number, bg: string, label: string, value: string, active: boolean, t: Canvas['theme']): void {
  const lblW = 10;
  c.text(x, y, label, { fg: t.dim, bg });
  const vx = x + lblW;
  if (active) {
    c.fill(vx - 1, y, w - lblW + 1, 1, ' ', { bg: mix(t.bg, t.accent, 0.16) });
    c.text(vx, y, value, { fg: t.text, bg: mix(t.bg, t.accent, 0.16), b: true });
    c.put(vx - 1, y, '▌', { fg: t.accent, bg });
  } else {
    c.text(vx, y, value, { fg: t.text, bg });
  }
}

function kv(c: Canvas, x: number, y: number, w: number, bg: string, label: string, value: string, t: Canvas['theme'], valColor: string): void {
  const v = value.length > w - 14 ? value.slice(0, Math.max(1, w - 15)) + '…' : value;
  c.text(x, y, label, { fg: t.muted, bg }, Math.max(0, w - v.length - 1));
  c.textR(x, y, w, v, { fg: valColor, bg });
}

export type { TicketView };
