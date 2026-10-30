// `dexterm overlay` — the STREAMER OVERLAY (task-1427): OBS browser-source scenes fed by the spectator stream.
//
//   dexterm overlay [--scene activity|coin|pnl|all]… [--theme cyberspace|ice|neon]
//                   [--replay FILE [--speed N] [--loop]] [--ledger TRADE_ID [--sol-usd N]]
//                   [--port N] [--ticket-ttl MIN] [--json]
//
// Data: the live, read-only, redacted spectator stream (the one `dexterm --spectate-mcp` or `dexterm agent serve
// --spectate` opens; found through spectator.json, token sent in the hello, loopback only), or a saved recording
// with --replay (every scene then carries a SAMPLE DATA tag). The PnL scene is the agent's PAPER fills on the coin
// (stamped PAPER), or with --ledger one round trip of the user's own trade ledger (PAPER or LIVE by wallet mode).
// Scenes: a loopback page per scene with a single-use ticket → token (overlay/server.ts). No network beyond
// loopback, no inbound control path: the overlay watches; nothing here can arm, sign, size, trade or raise a cap.

import { readFileSync } from 'node:fs';
import { loadSpectatorRecording, sanitizeDetail, type SpectatorEvent } from '@dexterm/agents';
import type { LedgerCardRow, CardInput } from './pnl-card.ts';
import type { Io } from './main.ts';
import { spectatorInfoPath } from './spectate-cmd.ts';
import { emptyOverlayState, foldOverlay, activityView, coinView, type OverlayState } from './overlay/model.ts';
import { pnlView, ledgerOverlayInput } from './overlay/pnl.ts';
import { createOverlayServer, OVERLAY_PAGES, OVERLAY_TICKET_TTL_MS, type OverlayPage, type OverlayServer } from './overlay/server.ts';
import { OVERLAY_THEME_NAMES, type OverlayThemeName } from './overlay/page.ts';

export const OVERLAY_USAGE = `dexterm overlay [options]   streamer overlay: OBS browser-source scenes of the agent's session
  --scene NAME        activity | coin | pnl | all (repeatable; default: the three scenes)
  --theme NAME        ${OVERLAY_THEME_NAMES.join(' | ')} (default cyberspace)
  --replay FILE       play a saved spectator recording instead of the live stream (scenes say SAMPLE DATA)
  --speed N           replay speed (default 1) · --loop  replay again from the start when it ends
  --ledger TRADE_ID   PnL scene from your own trade ledger (PAPER or LIVE stamp by wallet mode) instead of the
                      agent's paper fills · --sol-usd N for a USD-booked trade
  --port N            fixed loopback port (default random) · --ticket-ttl MIN  minutes a URL stays valid (default 10)
  --json              print the scene URLs as JSON
Each URL works ONCE (paste it into an OBS Browser source). Press n for fresh URLs, q to quit.
Loopback only · read-only · addresses redacted · every scene shows its data age.
Full docs: https://dexterm.xyz/docs/overlay/`;

interface Opts { scenes: OverlayPage[]; theme: OverlayThemeName; replay: string | null; speed: number; loop: boolean; ledger: string | null; solUsd: number | null; port: number | undefined; ttlMin: number; json: boolean }

export function parseOverlayArgs(rest: string[]): Opts | string {
  const o: Opts = { scenes: [], theme: 'cyberspace', replay: null, speed: 1, loop: false, ledger: null, solUsd: null, port: undefined, ttlMin: OVERLAY_TICKET_TTL_MS / 60_000, json: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const val = (): string | null => { const v = rest[++i]; return v === undefined || v.startsWith('--') ? null : v; };
    switch (a) {
      case '--scene': { const v = val(); if (!v || !(OVERLAY_PAGES as readonly string[]).includes(v)) return `--scene is one of ${OVERLAY_PAGES.join(', ')}`; if (!o.scenes.includes(v as OverlayPage)) o.scenes.push(v as OverlayPage); break; }
      case '--theme': { const v = val(); if (!v || !(OVERLAY_THEME_NAMES as string[]).includes(v)) return `--theme is one of ${OVERLAY_THEME_NAMES.join(', ')}`; o.theme = v as OverlayThemeName; break; }
      case '--replay': { const v = val(); if (!v) return '--replay needs a FILE'; o.replay = v; break; }
      case '--speed': { const n = Number(val()); if (!(n > 0 && n <= 100)) return '--speed is a number from 0 to 100'; o.speed = n; break; }
      case '--loop': o.loop = true; break;
      case '--ledger': { const v = val(); if (!v) return '--ledger needs a TRADE_ID (from `dexterm ledger trades`)'; o.ledger = v; break; }
      case '--sol-usd': { const n = Number(val()); if (!(n > 0)) return '--sol-usd is a positive number'; o.solUsd = n; break; }
      case '--port': { const n = Number(val()); if (!Number.isInteger(n) || n < 1024 || n > 65535) return '--port is an integer from 1024 to 65535'; o.port = n; break; }
      case '--ticket-ttl': { const n = Number(val()); if (!(n >= 1 && n <= 240)) return '--ticket-ttl is minutes from 1 to 240'; o.ttlMin = n; break; }
      case '--json': o.json = true; break;
      default: return `unknown option ${JSON.stringify(a)}`;
    }
  }
  if (!o.scenes.length) o.scenes = ['activity', 'coin', 'pnl'];
  if (o.loop && !o.replay) return '--loop only applies to --replay';
  return o;
}

// ------------------------------------------------------------------------------------------------ the engine

export interface OverlayEngineOptions {
  sample: boolean;
  server: OverlayServer;
  now?: () => number;
  /** A fixed PnL input (the --ledger card); null → the stream's PAPER fills. */
  pnlInput?: () => CardInput | null;
  /** Re-render the PnL card at least this often (an open position's mark ages). Default 10 s. */
  pnlEveryMs?: number;
}

/**
 * Folds events into the overlay state and pushes the scene views to the server. Public for the tests (they drive it
 * with fixture events and a fake clock); the command wires it to the stream or a recording.
 */
export class OverlayEngine {
  readonly state: OverlayState;
  private readonly server: OverlayServer;
  private readonly now: () => number;
  private readonly pnlInput: (() => CardInput | null) | undefined;
  private readonly pnlEveryMs: number;
  private lastPnlAt = -Infinity;
  private lastPnlKey = '';

  constructor(o: OverlayEngineOptions) {
    this.state = emptyOverlayState(o.sample);
    this.server = o.server;
    this.now = o.now ?? (() => Date.now());
    this.pnlInput = o.pnlInput;
    this.pnlEveryMs = o.pnlEveryMs ?? 10_000;
  }

  /** Start over (a looped replay): the scenes forget every coin, fill and call. */
  reset(): void { Object.assign(this.state, emptyOverlayState(this.state.sample)); }

  /** Fold one event read off the stream or a recording (untrusted data: the detail is re-validated first). */
  feed(raw: unknown): boolean {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    const e = raw as Record<string, unknown>;
    if (typeof e.phase !== 'string' || typeof e.t !== 'number' || !Number.isFinite(e.t)) return false;
    // the stream and saved files are redacted (mints are head…tail), so the detail is validated in that shape
    const ev = { ...e, detail: sanitizeDetail(e.detail, { masked: true }) } as unknown as SpectatorEvent;
    foldOverlay(this.state, ev);
    return true;
  }

  /** Push the current views (activity + coin always; the PnL card when its fills changed or it aged). */
  tick(): void {
    const now = this.now();
    this.server.push('activity', activityView(this.state, now));
    this.server.push('coin', coinView(this.state, now));
    const p = this.state.paperCurrent ? this.state.paper.get(this.state.paperCurrent) : undefined;
    const key = this.pnlInput ? 'ledger' : `${this.state.paperCurrent}:${p?.fills.length ?? 0}:${this.state.coins.get(this.state.paperCurrent ?? '')?.priceUsd?.at ?? 0}`;
    if (key !== this.lastPnlKey || now - this.lastPnlAt >= this.pnlEveryMs) {
      this.lastPnlKey = key; this.lastPnlAt = now;
      let input: CardInput | null = null;
      let note: string | null = null;
      if (this.pnlInput) { try { input = this.pnlInput(); } catch (err) { note = (err as Error).message; } }
      const view = pnlView(this.state, now, input);
      this.server.push('pnl', note ? { ...view, note } : view);
    }
  }
}

// ------------------------------------------------------------------------------------------------ the command

interface LedgerLoader { load(): Promise<void>; input(): CardInput | null }

function ledgerLoader(io: Io, tradeId: string, solUsd: number | null): LedgerLoader {
  let row: LedgerCardRow | null = null;
  let problem: string | null = 'reading the trade ledger…';
  return {
    async load() {
      try {
        const at = await import('@dexterm/autotrade');
        const v = await at.loadLedgerView({ env: io.env, now: Date.now() });
        const t = v.trades.find((x) => x.tradeId === tradeId);
        if (!t) { row = null; problem = `no trade ${tradeId} in the trade ledger`; return; }
        row = t as unknown as LedgerCardRow; problem = null;
      } catch (e) { row = null; problem = `trade ledger: ${(e as Error).message}`; }
    },
    input() {
      if (!row) throw new Error(problem ?? 'no ledger trade');
      return ledgerOverlayInput(row, solUsd ? { usd: solUsd, source: '--sol-usd' } : null);
    },
  };
}

export async function runOverlay(rest: string[], io: Io): Promise<number> {
  const out = (s: string) => io.stdout.write(s + '\n');
  const errOut = (s: string) => io.stderr.write(s + '\n');
  if (rest.includes('--help') || rest.includes('-h')) { out(OVERLAY_USAGE); return 0; }
  const o = parseOverlayArgs(rest);
  if (typeof o === 'string') { errOut(`dexterm overlay: ${o}`); errOut(OVERLAY_USAGE); return 2; }

  let recording: { events: SpectatorEvent[] } | null = null;
  if (o.replay) {
    try { recording = loadSpectatorRecording(o.replay); }
    catch (e) { errOut(`dexterm overlay: cannot read ${o.replay}: ${(e as Error).message}`); return 1; }
    if (!recording.events.length) { errOut(`dexterm overlay: ${o.replay} has no events`); return 1; }
  }

  let server: OverlayServer;
  try {
    server = await createOverlayServer({
      port: o.port, ticketTtlMs: o.ttlMin * 60_000,
      onEvent: (ev) => { if (ev.ev === 'probe.rejected') errOut(`overlay: refused ${ev.method} ${ev.path} (${ev.reason})`); },
    });
  } catch (e) { errOut(`dexterm overlay: cannot listen on 127.0.0.1${o.port ? `:${o.port}` : ''}: ${(e as Error).message}`); return 1; }

  const ledger = o.ledger ? ledgerLoader(io, o.ledger, o.solUsd) : null;
  if (ledger) await ledger.load();
  const engine = new OverlayEngine({ sample: !!recording, server, ...(ledger ? { pnlInput: () => ledger.input() } : {}) });

  const printUrls = (): void => {
    const urls = o.scenes.map((s) => ({ scene: s, url: server.issueTicket(s, o.theme) }));
    if (o.json) { out(JSON.stringify({ theme: o.theme, sample: !!recording, ttlMin: o.ttlMin, scenes: urls })); return; }
    out(`dexterm overlay · theme ${o.theme}${recording ? ' · SAMPLE DATA (replay)' : ''} · each URL works once, for ${o.ttlMin} min`);
    for (const u of urls) out(`  ${u.scene.padEnd(9)} ${u.url}`);
  };
  printUrls();
  if (!o.json) out(recording ? `replaying ${recording.events.length} event(s) from ${o.replay}` : 'watching the live spectator stream (start one with `dexterm --spectate-mcp` or `dexterm agent serve --spectate`)');

  const timers: NodeJS.Timeout[] = [];
  let stopped = false;
  let ws: WebSocket | null = null;

  // ---- data source
  if (recording) {
    const evs = recording.events;
    let i = 0;
    const step = (): void => {
      if (stopped) return;
      if (i >= evs.length) { if (!o.loop) return; i = 0; engine.reset(); }
      const ev = evs[i];
      // replayed events are re-timed to the playback clock (a signal's own `at` shifts with them), so their ages
      // read as "this long ago in the replay"
      const shift = Date.now() - ev.t;
      const flags = ev.detail?.liveFlags;
      engine.feed({ ...ev, t: ev.t + shift, ...(flags ? { detail: { ...ev.detail, liveFlags: flags.map((f) => ({ ...f, at: (typeof f.at === 'number' ? f.at : ev.t) + shift })) } } : {}) });
      const next = evs[i + 1];
      i++;
      // the end of a looped replay holds its final scenes (the PnL card lands last) before it starts again
      const gap = next ? Math.min(5000, Math.max(0, next.t - ev.t)) / o.speed : 10_000;
      timers.push(setTimeout(step, gap));
    };
    step();
  } else {
    const connect = (): void => {
      if (stopped) return;
      let info: { port?: unknown; token?: unknown };
      try { info = JSON.parse(readFileSync(spectatorInfoPath(io.env), 'utf8')); } catch { timers.push(setTimeout(connect, 3000)); return; }
      if (!Number.isInteger(info.port) || typeof info.token !== 'string') { timers.push(setTimeout(connect, 3000)); return; }
      try { ws = new WebSocket(`ws://127.0.0.1:${info.port as number}`); } catch { timers.push(setTimeout(connect, 3000)); return; }
      const token = info.token;
      ws.onopen = () => ws?.send(JSON.stringify({ method: 'hello', token }));
      ws.onmessage = (m) => {
        let msg: { type?: unknown; event?: unknown };
        try { msg = JSON.parse(String(m.data)); } catch { return; }
        if (msg && msg.type === 'event') engine.feed(msg.event);
      };
      ws.onclose = () => { ws = null; if (!stopped) timers.push(setTimeout(connect, 3000)); };
      ws.onerror = () => { /* onclose follows */ };
    };
    connect();
  }

  const ticker = setInterval(() => engine.tick(), 1000);
  engine.tick();
  const ledgerTimer = ledger ? setInterval(() => { void ledger.load(); }, 30_000) : null;

  return new Promise<number>((resolve) => {
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      clearInterval(ticker); if (ledgerTimer) clearInterval(ledgerTimer);
      for (const t of timers) clearTimeout(t);
      try { ws?.close(); } catch { /* ignore */ }
      if (io.stdin.isTTY) { try { io.stdin.setRawMode(false); } catch { /* ignore */ } io.stdin.pause(); }
      process.off('SIGINT', stop); process.off('SIGTERM', stop);
      void server.close().then(() => resolve(0));
    };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    if (io.stdin.isTTY) {
      io.stdin.setRawMode(true);
      io.stdin.resume();
      io.stdin.on('data', (d: Buffer) => {
        const k = d.toString();
        if (k === 'q' || k === '\u0003') stop();
        else if (k === 'n') printUrls();
      });
    }
  });
}
