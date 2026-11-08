// `dexterm autotrade watch <id>` (task-2170, "watch it cook"): one strategy's PAPER run, live, READ-ONLY.
//
//   dexterm autotrade watch <id> [--open-overlay] [--no-overlay] [--every S] [--once [--json]]
//
// The terminal shows the strategy overlay (overlay/strategy.ts): its rules in plain words, open bags HELD and closed
// ones SOLD, entries and exits as the run ledgers record them, paper equity and the exit-ladder rungs hit. The same view
// is served as the overlay `strategy` scene (overlay/server.ts: loopback, single-use ticket → token, outbound-only
// socket); --open-overlay opens that scene in the browser. If a spectator stream is live (`dexterm --spectate-mcp` or
// `agent serve --spectate`), the window attaches to it as a viewer and shows the agent's last calls; it never starts one.
//
// READ-ONLY by construction: this module reads the strategy store, the run ledgers and forward tests, and listens on
// loopback. It has no key handler except q (quit) and n (a fresh overlay URL); it cannot arm, size, sign, send, start or
// stop anything, or change a cap. (autotrade-web-2170.test.ts checks the module's imports and keys.)

import { readFileSync } from 'node:fs';
import * as engine from '@dexterm/autotrade';
import { dextermHome } from '@dexterm/custom';
import { redactSpectatorEvent, type SpectatorEvent } from '@dexterm/agents';
import type { AutotradeIo } from '../autotrade-cmd.ts';
import { spectatorInfoPath } from '../spectate-cmd.ts';
import { strategyOverlayLines, strategyOverlayView, inert } from '../overlay/strategy.ts';
import { createOverlayServer, type OverlayServer } from '../overlay/server.ts';
import { openBrowser, WATCH_ID_RE } from '../web/launch.ts';

export const WATCH_USAGE = `dexterm autotrade watch <id> [--open-overlay] [--no-overlay] [--every S] [--once [--json]]
  watch one strategy's PAPER run, read-only: rules, bags HELD/SOLD, entries and exits, equity, ladder rungs hit.
  --open-overlay   open the strategy overlay scene in your browser (also an OBS browser source; the URL works once)
  --no-overlay     terminal only · --every S  refresh every S seconds (default 2) · --once [--json]  print once and exit
  q quits · n prints a fresh overlay URL. It never arms, sizes, signs, sends or changes a cap.`;

interface Opts { id: string; openOverlay: boolean; overlay: boolean; everyS: number; once: boolean; json: boolean }

export function parseWatchArgs(argv: string[]): Opts | string {
  const o: Opts = { id: '', openOverlay: false, overlay: true, everyS: 2, once: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--open-overlay') o.openOverlay = true;
    else if (a === '--no-overlay') o.overlay = false;
    else if (a === '--once') o.once = true;
    else if (a === '--json') o.json = true;
    else if (a === '--every') { const n = Number(argv[++i]); if (!(n >= 1 && n <= 60)) return '--every is seconds from 1 to 60'; o.everyS = n; }
    else if (!a.startsWith('--') && !o.id) o.id = a;
    else return `unknown option ${JSON.stringify(a.slice(0, 40))}`;
  }
  if (!WATCH_ID_RE.test(o.id)) return 'name a strategy id (dexterm autotrade list)';
  if (o.json && !o.once) return '--json needs --once';
  return o;
}

/** A viewer on the live spectator stream, if one is running (read-only; the token comes from spectator.json). */
function attachSpectator(env: NodeJS.ProcessEnv, onEvent: (ev: SpectatorEvent) => void, onState: (s: string | null) => void): () => void {
  let ws: WebSocket | null = null;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const retry = (): void => { if (!stopped) { timer = setTimeout(connect, 5000); timer.unref?.(); } };
  function connect(): void {
    if (stopped) return;
    let info: { port?: unknown; token?: unknown };
    try { info = JSON.parse(readFileSync(spectatorInfoPath(env), 'utf8')); } catch { onState(null); retry(); return; }
    if (!Number.isInteger(info.port) || typeof info.token !== 'string') { onState(null); retry(); return; }
    try { ws = new WebSocket(`ws://127.0.0.1:${info.port as number}`); } catch { retry(); return; }
    const token = info.token;
    ws.onopen = () => { ws?.send(JSON.stringify({ method: 'hello', token })); onState('attached to the running spectator session'); };
    ws.onmessage = (m) => {
      let msg: { type?: unknown; event?: unknown };
      try { msg = JSON.parse(String(m.data)); } catch { return; }
      if (msg && msg.type === 'event' && msg.event && typeof msg.event === 'object') onEvent(redactSpectatorEvent(msg.event as SpectatorEvent));
    };
    ws.onclose = () => { ws = null; onState(null); retry(); };
    ws.onerror = () => { /* onclose follows */ };
  }
  connect();
  return () => { stopped = true; if (timer) clearTimeout(timer); try { ws?.close(); } catch { /* gone */ } };
}

export async function watchCmd(argv: string[], io: AutotradeIo): Promise<number> {
  const out = (s: string) => io.stdout.write(s + '\n');
  if (argv.includes('--help') || argv.includes('-h')) { out(WATCH_USAGE); return 0; }
  const o = parseWatchArgs(argv);
  if (typeof o === 'string') { io.stderr.write(`dexterm autotrade watch: ${o}\n${WATCH_USAGE}\n`); return 2; }
  const home = dextermHome(io.env);
  const store = new engine.StrategyStore({ home, env: io.env });
  if (!store.get(o.id)) { io.stderr.write(`dexterm autotrade watch: no strategy ${o.id} (dexterm autotrade list)\n`); return 1; }

  if (o.once) {
    const v = strategyOverlayView({ home, store, id: o.id });
    if (o.json) out(JSON.stringify(v));
    else for (const l of strategyOverlayLines(v, 100)) out(l);
    return 0;
  }

  let server: OverlayServer | null = null;
  let overlayUrl: string | null = null;
  if (o.overlay) {
    try {
      server = await createOverlayServer({ onEvent: () => {} });
      overlayUrl = server.issueTicket('strategy');
      if (o.openOverlay && !openBrowser(overlayUrl)) overlayUrl += '  (could not open a browser: paste it)';
      else if (o.openOverlay) overlayUrl = null; // spent by the browser; n prints a fresh one
    } catch (e) { io.stderr.write(`overlay: could not listen on 127.0.0.1 (${(e as Error).message}); terminal only\n`); server = null; }
  }

  let attached: string | null = null;
  const agentLines: string[] = [];
  const detach = attachSpectator(io.env, (ev) => {
    agentLines.unshift(`[agent] ${inert(ev.agent, 20)} ${inert(ev.phase, 10)} ${inert(ev.tool ?? '', 24)} ${inert(ev.summary ?? '', 60)}`);
    agentLines.length = Math.min(agentLines.length, 4);
  }, (s) => { attached = s; });

  const tty = !!(io.stdout as { isTTY?: boolean }).isTTY;
  const draw = (): void => {
    const v = strategyOverlayView({ home, store, id: o.id, attached });
    server?.push('strategy', v);
    const cols = (io.stdout as { columns?: number }).columns ?? 100;
    const lines = strategyOverlayLines(v, cols);
    if (agentLines.length) lines.push('', 'AGENT (spectator stream, read-only)', ...agentLines.map((l) => `  ${l}`));
    lines.push('', overlayUrl ? `overlay scene (works once): ${overlayUrl}` : server ? 'overlay scene open in the browser · n = a fresh URL' : 'overlay off', 'read-only · q quits · n new overlay URL');
    io.stdout.write((tty ? '\x1b[H\x1b[2J' : '') + lines.join('\n') + '\n');
  };
  draw();
  const timer = setInterval(draw, o.everyS * 1000);

  return new Promise<number>((resolve) => {
    const stdin = io.stdin as unknown as (NodeJS.ReadStream & { isTTY?: boolean }) | undefined;
    const stop = (): void => {
      clearInterval(timer); detach();
      if (stdin?.isTTY) { try { stdin.setRawMode(false); } catch { /* ignore */ } stdin.pause(); }
      process.off('SIGINT', stop); process.off('SIGTERM', stop);
      void (server ? server.close() : Promise.resolve()).then(() => resolve(0));
    };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    if (stdin?.isTTY) {
      stdin.setRawMode(true); stdin.resume();
      stdin.on('data', (d: Buffer) => {
        const k = d.toString();
        if (k === 'q' || k === '\u0003') stop();
        else if (k === 'n' && server) { overlayUrl = server.issueTicket('strategy'); draw(); }
      });
    }
  });
}
