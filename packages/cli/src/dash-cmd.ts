// `dexterm dash` (task-1749): the STRATEGY PERFORMANCE DASHBOARD. Local-first: it reads your own autotrade run ledgers
// ($DEXTERM_HOME/autotrade/runs) and serves a page on 127.0.0.1 only; no account, no cloud, nothing leaves the machine.
// Read-only: it never writes into the engine's state. PAPER results are simulated; not financial advice.

import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { dextermHome } from '@dexterm/custom';
import { defaultDbPath } from '@dexterm/data';
import { collectDash, homeLabel, type DashHome } from './dash/data.ts';
import { exportSnapshot, startDashServer } from './dash/server.ts';

export interface DashIo { stdout: { write(s: string): unknown }; stderr: { write(s: string): unknown }; env: NodeJS.ProcessEnv }

export const DASH_PORT = 4317;
export const DASH_HELP = `dexterm dash: track how your autotrade strategies perform, in a browser, on this machine only. Read-only.

  dexterm dash                          serve the dashboard on http://127.0.0.1:${DASH_PORT}/ (Ctrl-C stops it)
  dexterm dash --json                   print the numbers the page shows and exit
  dexterm dash --export DIR [--redact-mints]   write a static read-only snapshot (the page + data.json) and exit

  --port N            the loopback port (default ${DASH_PORT}; 0 = any free port)
  --home DIR          a dexterm home to read (default $DEXTERM_HOME or ~/.dexterm); repeat for several
  --db PATH           the market cache DB for pool reads (default: dexterm.db next to a .dexterm home, else DEXTERM_DB_PATH or the default DB)
  --books FILE        add books from a dexterm-dash-books/1 JSON file (your own script's output); repeat for several
  --baseline ID       the strategy every other one is compared against
  --allow-host NAME   also answer requests for this host name (a private proxy in front, e.g. tailscale serve)

  Overview, strategy detail, rugs & stuck, compare (vs the baseline, with the 95% interval) and live status, refreshed
  every 30 s. The server binds 127.0.0.1 only, makes no network request and loads nothing from the internet.
  PAPER results are simulated. Not financial advice.`;

interface Opts { _: string[]; flags: Map<string, string[]>; bools: Set<string> }
const VALUE = new Set(['port', 'home', 'db', 'books', 'baseline', 'allow-host', 'export']);
const BOOL = new Set(['json', 'help', 'redact-mints']);

function parse(argv: string[]): Opts | string {
  const o: Opts = { _: [], flags: new Map(), bools: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') { o.bools.add('help'); continue; }
    if (!a.startsWith('--')) { o._.push(a); continue; }
    const [k, inline] = a.slice(2).split(/=(.*)/s, 2);
    if (BOOL.has(k)) { o.bools.add(k); continue; }
    if (!VALUE.has(k)) return `unknown flag --${k}`;
    const v = inline ?? argv[++i];
    if (v === undefined || v === '') return `--${k} needs a value`;
    o.flags.set(k, [...(o.flags.get(k) ?? []), v]);
  }
  return o;
}

/** A home given as DIR: the .dexterm folder itself, or a folder holding one (the kit's layout: <dir>/.dexterm + <dir>/dexterm.db). */
export function resolveHome(dir: string, env: NodeJS.ProcessEnv, db?: string): DashHome {
  let d = resolve(dir);
  if (basename(d) !== '.dexterm' && !existsSync(join(d, 'autotrade')) && existsSync(join(d, '.dexterm'))) d = join(d, '.dexterm');
  const sibling = basename(d) === '.dexterm' ? join(dirname(d), 'dexterm.db') : null;
  return { dir: d, label: homeLabel(d), db: db ?? (sibling && existsSync(sibling) ? sibling : env.DEXTERM_DB_PATH || defaultDbPath(env)) };
}

export async function dashCommand(argv: string[], io: DashIo, { wait = true } = {}): Promise<number> {
  const o = parse(argv);
  if (typeof o === 'string') { io.stderr.write(`dexterm dash: ${o}\n\n${DASH_HELP}\n`); return 2; }
  if (o.bools.has('help') || o._[0] === 'help') { io.stdout.write(`${DASH_HELP}\n`); return 0; }
  if (o._.length) { io.stderr.write(`dexterm dash: unexpected argument ${o._[0]}\n\n${DASH_HELP}\n`); return 2; }
  const db = o.flags.get('db')?.[0];
  const homes = (o.flags.get('home') ?? [dextermHome(io.env)]).map((h) => resolveHome(h, io.env, db));
  const books = (o.flags.get('books') ?? []).map((b) => resolve(b));
  const baseline = o.flags.get('baseline')?.[0] ?? null;
  if (o.bools.has('json')) { io.stdout.write(`${JSON.stringify(collectDash({ homes, books, baseline }), null, 1)}\n`); return 0; }
  const out = o.flags.get('export')?.[0];
  if (out) {
    const files = exportSnapshot(collectDash({ homes, books, baseline }), resolve(out), { redactMints: o.bools.has('redact-mints') });
    io.stdout.write(`snapshot written to ${resolve(out)}: ${files.join(', ')}\nIt is a static read-only copy of what this machine shows now. Publishing it is your decision; check it first. Not financial advice.\n`);
    return 0;
  }
  const port = Number(o.flags.get('port')?.[0] ?? DASH_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) { io.stderr.write(`dexterm dash: --port must be 0-65535\n`); return 2; }
  let server;
  try { server = await startDashServer({ homes, books, baseline, allowHosts: o.flags.get('allow-host') ?? [] }, port); }
  catch (e) { io.stderr.write(`dexterm dash: cannot listen on 127.0.0.1:${port} (${(e as NodeJS.ErrnoException).code ?? e}); try --port N\n`); return 1; }
  const addr = server.address(); const p = typeof addr === 'object' && addr ? addr.port : port;
  io.stdout.write(`dexterm dash: http://127.0.0.1:${p}/  (reading ${homes.map((h) => h.label).join(', ')}${books.length ? ` + ${books.length} books file(s)` : ''}; loopback only, read-only; Ctrl-C stops)\nPaper trading, not financial advice.\n`);
  if (!wait) { server.close(); return 0; }
  await new Promise<void>((done) => { const stop = () => { server.close(() => done()); }; process.once('SIGINT', stop); process.once('SIGTERM', stop); });
  return 0;
}
