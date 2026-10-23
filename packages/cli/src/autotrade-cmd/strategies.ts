// `dexterm autotrade list|validate|new|import|remove|journal` (task-1503 AT-1): the strategy store from the CLI.
// Every write goes through @dexterm/autotrade StrategyStore (validated first, atomic, journaled with actor
// "user"); nothing here signs, arms or trades.

import { existsSync, readFileSync } from 'node:fs';
import { fmtIssue, StrategyStore, validateStrategy, type Issue, type StrategyCheck } from '@dexterm/autotrade';
import type { AutotradeIo } from '../autotrade-cmd.ts';

export function parseArgs(argv: string[], booleans: string[] = []): { pos: string[]; opts: Record<string, string | true> } {
  const pos: string[] = [];
  const opts: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq > 0) { opts[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const k = a.slice(2);
    const v = argv[i + 1];
    if (!booleans.includes(k) && v !== undefined && !v.startsWith('--')) { opts[k] = v; i++; } else opts[k] = true;
  }
  return { pos, opts };
}

export const storeFor = (io: AutotradeIo): StrategyStore => new StrategyStore({ env: io.env });

const looksLikeFile = (a: string): boolean => a.endsWith('.json') || a.includes('/') || a.includes('\\');

/** Resolve `<id|file>`: an existing path (or anything that looks like one) is a file; otherwise the store, then the presets. */
export function resolveStrategyArg(arg: string | undefined, io: AutotradeIo): (StrategyCheck & { source: string }) | null {
  if (!arg) return null;
  if (looksLikeFile(arg) || existsSync(arg)) {
    if (!existsSync(arg)) return { ok: false, errors: [{ path: '', msg: `no such file ${arg}` }], warnings: [], source: 'file' };
    let doc: unknown;
    try { doc = JSON.parse(readFileSync(arg, 'utf8')); } catch (e) { return { ok: false, errors: [{ path: '', msg: `not JSON: ${(e as Error).message}` }], warnings: [], source: 'file' }; }
    return { ...validateStrategy(doc), source: 'file' };
  }
  try {
    const g = storeFor(io).get(arg);
    return g ? { ...g, source: g.source } : { ok: false, errors: [{ path: '', msg: `no strategy or preset named ${arg} (dexterm autotrade list)` }], warnings: [], source: 'store' };
  } catch (e) {
    return { ok: false, errors: [{ path: '', msg: (e as Error).message }], warnings: [], source: 'store' };
  }
}

const printIssues = (io: AutotradeIo, kind: 'error' | 'warning', xs: Issue[], to: 'stdout' | 'stderr' = 'stdout') => { for (const x of xs) io[to].write(`${kind} ${fmtIssue(x)}\n`); };

export function listCmd(argv: string[], io: AutotradeIo): number {
  const { opts } = parseArgs(argv, ['json']);
  const store = storeFor(io);
  const rows = store.list();
  if (opts.json) { io.stdout.write(JSON.stringify({ dir: store.dir, strategies: rows }, null, 2) + '\n'); return 0; }
  io.stdout.write(`STRATEGIES · PAPER · ${store.dir}\n`);
  const w = Math.max(4, ...rows.map((r) => r.id.length));
  for (const r of rows) {
    const bt = r.lastBacktest ? `last backtest ${r.lastBacktest.trades} trades ${r.lastBacktest.netUsd >= 0 ? '+' : '-'}$${Math.abs(r.lastBacktest.netUsd).toFixed(2)} (${r.lastBacktest.netPct}%), dd ${r.lastBacktest.maxDrawdownPct}%` : 'no backtest yet';
    const head = `  ${r.id.padEnd(w)}  ${(r.source + (r.shadowsPreset ? '*' : '')).padEnd(7)}`;
    if (!r.ok) { io.stdout.write(`${head}  INVALID: ${(r.errors ?? []).slice(0, 2).map(fmtIssue).join('; ')}\n`); continue; }
    io.stdout.write(`${head}  v${r.version!.padEnd(7)} ${r.hash}  ${r.mode!.padEnd(5)}  profiles ${r.profiles!.join(',')}  · ${bt}${r.highRisk ? '  · ⚠ HIGH RISK' : ''}\n`);
  }
  if (rows.some((r) => r.shadowsPreset)) io.stdout.write('  * your file shadows the shipped preset of the same id\n');
  return 0;
}

export function validateCmd(argv: string[], io: AutotradeIo): number {
  const { pos, opts } = parseArgs(argv, ['json']);
  const r = resolveStrategyArg(pos[0] ?? (typeof opts.strategy === 'string' ? opts.strategy : undefined), io);
  if (!r) { io.stderr.write('usage: dexterm autotrade validate <id|file> [--json]\n'); return 2; }
  if (opts.json) {
    io.stdout.write(JSON.stringify(r.ok ? { ok: true, id: r.strategy.id, version: r.strategy.version, hash: r.strategy.hash, mode: r.strategy.mode, warnings: r.warnings } : { ok: false, errors: r.errors, warnings: r.warnings }, null, 2) + '\n');
    return r.ok ? 0 : 2;
  }
  printIssues(io, 'warning', r.warnings);
  if (!r.ok) { printIssues(io, 'error', r.errors); return 2; }
  const s = r.strategy;
  io.stdout.write(`ok ${s.id} v${s.version} hash ${s.hash} mode ${s.mode}${s.mode === 'live' ? ' (does not run: dexterm runs strategies on paper only)' : ''} profiles ${Object.keys(s.exits.profiles).join(',')} (${r.source})\n`);
  return 0;
}

export function newCmd(argv: string[], io: AutotradeIo): number {
  const { pos, opts } = parseArgs(argv);
  const id = pos[0];
  const from = typeof opts.from === 'string' ? opts.from : undefined;
  if (!id || !from) { io.stderr.write('usage: dexterm autotrade new <new-id> --from <preset|id> [--name TEXT]\n'); return 2; }
  let r;
  try { r = storeFor(io).createFrom(from, id, { actor: 'user', name: typeof opts.name === 'string' ? opts.name : undefined }); } catch (e) { io.stderr.write(`dexterm autotrade: ${(e as Error).message}\n`); return 2; }
  if (!r.ok) { printIssues(io, 'error', r.errors, 'stderr'); return 2; }
  printIssues(io, 'warning', r.warnings);
  io.stdout.write(`created ${id} v${r.strategy.version} (${r.strategy.hash}) from ${from} → ${storeFor(io).pathOf(id)}\n  edit the file, then: dexterm autotrade validate ${id} · dexterm autotrade backtest ${id}\n`);
  return 0;
}

export function importCmd(argv: string[], io: AutotradeIo): number {
  const { pos, opts } = parseArgs(argv, ['replace']);
  const file = pos[0];
  if (!file || !existsSync(file)) { io.stderr.write('usage: dexterm autotrade import <file> [--replace]\n'); return 2; }
  let doc: Record<string, unknown>;
  try { doc = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>; } catch (e) { io.stderr.write(`not JSON: ${(e as Error).message}\n`); return 2; }
  // Spec §2c: an imported strategy is always paper, whatever the file says.
  const forced = doc && typeof doc === 'object' && doc.mode !== 'paper';
  if (forced) doc = { ...doc, mode: 'paper' };
  const store = storeFor(io);
  const id = typeof doc.id === 'string' ? doc.id : '';
  let r;
  try { r = opts.replace && id && store.has(id) ? store.update(id, doc, { actor: 'import', why: `import ${file}` }) : store.create(doc, { actor: 'import', why: `import ${file}` }); } catch (e) { io.stderr.write(`dexterm autotrade: ${(e as Error).message}\n`); return 2; }
  if (!r.ok) { printIssues(io, 'error', r.errors, 'stderr'); return 2; }
  printIssues(io, 'warning', r.warnings);
  io.stdout.write(`imported ${r.strategy.id} v${r.strategy.version} (${r.strategy.hash})${forced ? ' · mode forced to paper' : ''}\n`);
  return 0;
}

export function removeCmd(argv: string[], io: AutotradeIo): number {
  const { pos } = parseArgs(argv);
  if (!pos[0]) { io.stderr.write('usage: dexterm autotrade remove <id>\n'); return 2; }
  let r;
  try { r = storeFor(io).remove(pos[0], { actor: 'user' }); } catch (e) { io.stderr.write(`dexterm autotrade: ${(e as Error).message}\n`); return 2; }
  if (!r.ok) { printIssues(io, 'error', r.errors, 'stderr'); return 2; }
  io.stdout.write(`removed ${pos[0]} → ${r.movedTo}\n`);
  return 0;
}

export function journalCmd(argv: string[], io: AutotradeIo): number {
  const { pos, opts } = parseArgs(argv, ['json']);
  const j = storeFor(io).journal(pos[0]);
  if (opts.json) { io.stdout.write(JSON.stringify(j, null, 2) + '\n'); return 0; }
  if (!j.length) { io.stdout.write('no strategy changes journaled yet\n'); return 0; }
  for (const x of j) io.stdout.write(`${new Date(x.t).toISOString()}  ${x.action.padEnd(6)} ${x.id.padEnd(20)} by ${x.actor.padEnd(8)} ${x.beforeHash ?? '—'} → ${x.afterHash ?? '—'}${x.version ? ` v${x.version}` : ''}  ${x.ops.length} op(s)${x.why ? ` · ${x.why}` : ''}\n`);
  return 0;
}
