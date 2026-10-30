// `dexterm narratives [top|detail ID|of MINT|export] [--db PATH] [--json] [--at ISO] [--lookback-h N] [--out FILE]`
// (task-1818, EXPERIMENTAL). The MEMES + NARRATIVES tracker over the history recorder: coins clustered by the theme
// their name/ticker carries, with per-window heat metrics and lifecycle states. Keyless, local, read-only on the DB.
// Measured heat, never advice.
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { defaultDbPath } from '@dexterm/data';
import { trackerFromRecorder, toExport, renderTable, coinField, embedderFromEnv, HEAT_NOTE, LIFECYCLE_RULES } from '@dexterm/narratives';

export interface NarrativesIo { stdout: { write(s: string): unknown }; stderr: { write(s: string): unknown }; env: NodeJS.ProcessEnv }

export const NARRATIVES_HELP = `dexterm narratives: the MEMES + NARRATIVES tracker (task-1818, EXPERIMENTAL). No network, no model, no key.

  dexterm narratives [top]          the hottest narratives (rank = memetic traction score)
  dexterm narratives detail ID      one narrative: windows, lifecycle rule, member coins in spawn order
  dexterm narratives of MINT        which narrative a coin belongs to
  dexterm narratives export [--out FILE]   the dexterm-narratives/1 JSON the strategy tracker page reads

  --db PATH        defaults to DEXTERM_DB_PATH, else ~/.local/share/dexterm/dexterm.db (opened read-only)
  --at ISO         replay up to this time instead of now (point-in-time: only rows recorded before it)
  --lookback-h N   hours of history to replay (default 26)
  --limit N        rows (default 20)
  --json           machine-readable output

  Coins are grouped by what their name/ticker says (ticker puns, animals, celebrities/politics, AI agents,
  seasonal, copy-cats of a runner); a coin needs no real project to belong. Lifecycle states:
${LIFECYCLE_RULES.map(([s, r]) => `    ${s.padEnd(9)} ${r}`).join('\n')}
  ${HEAT_NOTE}
  Embedder: DEXTERM_NARRATIVE_EMBEDDER=lexical (default, built in) | minilm (needs DEXTERM_EMBED_MODULE_DIR) | ollama[:model].`;

function parse(argv: string[]): { pos: string[]; opts: Record<string, string | true> } {
  const opts: Record<string, string | true> = {}; const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const k = a.slice(2); const v = argv[i + 1];
    if (v !== undefined && !v.startsWith('--') && k !== 'json' && k !== 'help') { opts[k] = v; i++; } else opts[k] = true;
  }
  return { pos, opts };
}

export async function narrativesCommand(argv: string[], io: NarrativesIo): Promise<number> {
  const { pos, opts } = parse(argv);
  if (opts.help || pos[0] === 'help') { io.stdout.write(NARRATIVES_HELP + '\n'); return 0; }
  const cmd = pos[0] ?? 'top';
  if (!['top', 'detail', 'of', 'export'].includes(cmd)) { io.stderr.write(`dexterm narratives: unknown command "${cmd}" (top | detail ID | of MINT | export)\n`); return 2; }
  const path = typeof opts.db === 'string' ? opts.db : (io.env.DEXTERM_DB_PATH || defaultDbPath(io.env));
  if (path === ':memory:') { io.stderr.write('dexterm narratives: an in-memory DB has no history\n'); return 2; }
  const at = typeof opts.at === 'string' ? Date.parse(opts.at) : Date.now();
  if (!Number.isFinite(at)) { io.stderr.write('dexterm narratives: --at needs an ISO time\n'); return 2; }
  const lookbackH = typeof opts['lookback-h'] === 'string' ? Number(opts['lookback-h']) : 26;
  if (!(Number.isFinite(lookbackH) && lookbackH > 0)) { io.stderr.write('dexterm narratives: --lookback-h needs a number of hours above 0\n'); return 2; }
  const limitN = typeof opts.limit === 'string' ? Math.floor(Number(opts.limit)) : 20;
  if (!Number.isFinite(limitN) || limitN < 1) { io.stderr.write('dexterm narratives: --limit needs a whole number of 1 or more\n'); return 2; }
  const limit = Math.min(200, limitN);
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'token_snapshots'").get()) {
      io.stderr.write(`dexterm narratives: no recorded history in ${path} (run the app with the recorder on first)\n`); return 2;
    }
    const t0 = performance.now();
    const tr = await trackerFromRecorder(db, { now: at, lookbackMs: lookbackH * 3_600_000, embedder: embedderFromEnv(io.env) });
    const ms = Math.round(performance.now() - t0);
    if (cmd === 'export') {
      const ex = toExport(tr, { limit: Math.max(limit, 50), now: at });
      const json = JSON.stringify(ex, null, 1) + '\n';
      if (typeof opts.out === 'string') { writeFileSync(opts.out, json); io.stdout.write(`wrote ${opts.out}: ${ex.narratives.length} narratives over ${ex.coins} coins (${ms} ms)\n`); }
      else io.stdout.write(json);
      return 0;
    }
    if (cmd === 'detail' || cmd === 'of') {
      const key = pos[1];
      if (!key) { io.stderr.write(`dexterm narratives ${cmd}: needs ${cmd === 'detail' ? 'a narrative id' : 'a mint'}\n`); return 2; }
      const n = cmd === 'of' ? tr.narrativeOf(key) : null;
      if (cmd === 'of' && !n) { io.stdout.write(opts.json ? JSON.stringify({ mint: key, narrative: null, note: 'not recorded in the lookback window' }) + '\n' : `${coinField(null)} (no recorded sighting in the last ${lookbackH} h)\n`); return 0; }
      const d = tr.detail(cmd === 'of' ? n!.narrative : key);
      if (!d) { io.stderr.write(`dexterm narratives: unknown narrative id ${key}\n`); return 2; }
      if (opts.json) { io.stdout.write(JSON.stringify(cmd === 'of' ? { ...n, detail: d } : d, null, 1) + '\n'); return 0; }
      if (n) io.stdout.write(coinField(n) + '\n');
      io.stdout.write(renderTable([d], 150) + '\n\n');
      io.stdout.write(`lifecycle rule: ${d.lifecycleRule}\nmembers (spawn order, newest ${Math.min(limit, d.memberList.length)} of ${d.memberList.length}):\n`);
      for (const m of d.memberList.slice(-limit)) io.stdout.write(`  #${String(m.spawn).padEnd(4)} ${m.symbol.padEnd(12)} ${m.name.slice(0, 28).padEnd(28)} ${m.x == null ? '   —' : (m.x.toFixed(2) + 'x').padStart(7)}  ${m.mint}\n`);
      return 0;
    }
    const rows = tr.top(limit);
    if (opts.json) { io.stdout.write(JSON.stringify(toExport(tr, { limit, now: at }), null, 1) + '\n'); return 0; }
    io.stdout.write(`NARRATIVES (EXPERIMENTAL) · as of ${tr.lastTickAt ? new Date(tr.lastTickAt).toISOString() : '—'} · ${tr.coins.size} coins over ${lookbackH} h · embedder ${tr.embedder.id} · ${ms} ms\n`);
    io.stdout.write(renderTable(rows, 150) + '\n');
    return 0;
  } catch (e) {
    io.stderr.write(`dexterm narratives: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}
