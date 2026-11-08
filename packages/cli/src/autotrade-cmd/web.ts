// `dexterm autotrade web` (= `dexterm strategies web`, task-2170): the Strategy Builder in the browser. PAPER ONLY.
//
//   dexterm autotrade web [--no-open] [--port N] [--json]
//
// Starts the loopback server (web/server.ts), prints a one-time URL (the ticket buys one session; press n for a fresh
// one) and opens the browser unless --no-open. The UI: Strategies, Builder, Factory, Chat and the Watch it cook button.
// It reads the same files as the TUI and changes things only through the existing paper paths (proposals, preview →
// confirm, forward tests). No route reaches real mode, arming, caps, bankrolls, Claude budgets, signing or sending.
import type { AutotradeIo } from '../autotrade-cmd.ts';
import { VERSION } from '../version.ts';
import { createWebServer, type WebServer } from '../web/server.ts';
import { openBrowser } from '../web/launch.ts';

export const WEB_USAGE = `dexterm autotrade web [--no-open] [--port N] [--json]   (also: dexterm strategies web)
  the Strategy Builder in your browser, on this machine only (127.0.0.1): strategies with their numbers, a builder that
  writes proposals you apply, the strategy factory, a chat on your own Claude, and Watch it cook (opens a read-only
  dexterm window on one strategy's paper run with the strategy overlay).
  --no-open   print the URL, do not open a browser · --port N  a fixed loopback port (default: a free one)
  --json      print {url} as JSON
  The URL works ONCE (it becomes a session cookie); press n for a fresh one, q to quit. PAPER only.`;

export function parseWebArgs(argv: string[]): { open: boolean; port: number | undefined; json: boolean } | string {
  const o = { open: true, port: undefined as number | undefined, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-open') o.open = false;
    else if (a === '--json') o.json = true;
    else if (a === '--port') { const n = Number(argv[++i]); if (!Number.isInteger(n) || n < 1024 || n > 65535) return '--port is an integer from 1024 to 65535'; o.port = n; }
    else return `unknown option ${JSON.stringify(String(a).slice(0, 40))}`;
  }
  return o;
}

export async function webCmd(argv: string[], io: AutotradeIo): Promise<number> {
  const out = (s: string) => io.stdout.write(s + '\n');
  if (argv.includes('--help') || argv.includes('-h')) { out(WEB_USAGE); return 0; }
  const o = parseWebArgs(argv);
  if (typeof o === 'string') { io.stderr.write(`dexterm autotrade web: ${o}\n${WEB_USAGE}\n`); return 2; }
  let server: WebServer;
  try {
    server = await createWebServer({ env: io.env, port: o.port, version: VERSION, onEvent: (ev) => { if (ev.ev === 'probe.rejected' && ev.reason !== 'no-session') io.stderr.write(`web: refused ${ev.method} ${ev.path} (${ev.reason})\n`); } });
  } catch (e) { io.stderr.write(`dexterm autotrade web: cannot listen on 127.0.0.1${o.port ? `:${o.port}` : ''}: ${(e as Error).message}\n`); return 1; }
  const show = (): void => {
    const url = server.issueUrl();
    if (o.json) { out(JSON.stringify({ url, origin: server.origin })); return; }
    out(`dexterm strategy builder · PAPER · ${server.origin} (this machine only)`);
    out(`  open once: ${url}`);
    if (o.open && openBrowser(url)) out('  (opened in your browser; the link is spent)');
    out('  n = a fresh link (ends the old session) · q = quit');
  };
  show();
  o.open = false; // a fresh link from n is printed, not opened again

  return new Promise<number>((resolve) => {
    const stdin = io.stdin as unknown as (NodeJS.ReadStream & { isTTY?: boolean }) | undefined;
    const stop = (): void => {
      if (stdin?.isTTY) { try { stdin.setRawMode(false); } catch { /* ignore */ } stdin.pause(); }
      process.off('SIGINT', stop); process.off('SIGTERM', stop);
      void server.close().then(() => resolve(0));
    };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    if (stdin?.isTTY) {
      stdin.setRawMode(true); stdin.resume();
      stdin.on('data', (d: Buffer) => { const k = d.toString(); if (k === 'q' || k === '\u0003') stop(); else if (k === 'n') show(); });
    }
  });
}
