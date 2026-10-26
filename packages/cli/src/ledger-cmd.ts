// `dexterm ledger <sub>` (task-1530): the unified TRADE LEDGER. One row per round trip from every place dexterm books a
// trade: the paper ticket (paper wallet), the agent paper desk (its journal), autotrade runs (their hash-chained run
// ledgers) and the live signer (its trade ledger). Each row carries the strategy id + version + hash, the declared exit
// profile and entry reason (and where each came from), the exit reason, size and % of book, entry / exit price AND
// market cap, fees, impact, hold, rug flag, wallet mode and the model sessions that made it.
//
// Reads never write: every command folds $DEXTERM_HOME/ledger/trades.jsonl plus what the sources hold that the file
// does not yet (shown as "pending"). `sync` appends those to the file (append-only, sha256-chained; a broken file is
// refused, never rewritten) and `verify` recomputes the chain. No network, no model, no key, no signer.

import { writeFileSync } from 'node:fs';
import type { LedgerView, TradeRow, TradeFilter } from '@dexterm/data/ledger';

export interface LedgerIo {
  stdout: { write(s: string): unknown };
  stderr: { write(s: string): unknown };
  env: NodeJS.ProcessEnv;
}

export const LEDGER_HELP = `dexterm ledger: the unified trade ledger (paper, agent paper desk, autotrade runs, live). Read-only unless sync.

  dexterm ledger trades     [filters] [--limit N] [--json]   one row per round trip, newest first
  dexterm ledger positions  [filters] [--json]               the open trades (cost, % of book, held, profile)
  dexterm ledger summary    [filters] [--json]               win rate (95% interval), P/L, drawdown, rug rate, by profile / exit / strategy / source / mode
  dexterm ledger equity     [filters] [--json]               the realized equity curve and its max drawdown
  dexterm ledger compare    [filters] [--json]               one row per strategy version: the forward-test table
  dexterm ledger export csv|json|parquet-lite [filters] [--out FILE]   (or --format csv|json|parquet-lite)
  dexterm ledger card <tradeId> [--square] [--price] [--exact] [--sol-usd N]   a PnL card (market cap at entry / exit)
  dexterm ledger sync [--json]                                append what the sources hold to the ledger file
  dexterm ledger verify [--json]                              recompute the ledger file's sha256 chain

  filters: --source paper|desk|autotrade|live  --mode paper|devnet|live|real  --strategy ID[@VERSION|@HASH]  --profile P
           --exit REASON  --mint MINT  --run RUN_ID  --account ID  --days N  --status open|closed  --wallet-db PATH

  The file is $DEXTERM_HOME/ledger/trades.jsonl (default ~/.dexterm). PAPER rows are simulated; filter by --mode
  before comparing results. Not financial advice.`;

interface Opts { _: string[]; [flag: string]: string | true | string[] }

const VALUE_FLAGS = new Set(['source', 'mode', 'strategy', 'profile', 'exit', 'mint', 'run', 'account', 'days', 'status', 'limit', 'out', 'sol-usd', 'wallet-db', 'format']);

function parse(argv: string[]): Opts | string {
  const o: Opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { o._.push(a); continue; }
    const eq = a.indexOf('=');
    const k = eq > 0 ? a.slice(2, eq) : a.slice(2);
    if (VALUE_FLAGS.has(k)) {
      const v = eq > 0 ? a.slice(eq + 1) : argv[++i];
      if (v === undefined || v === '') return `--${k} needs a value`;
      o[k] = v;
    } else o[k] = true;
  }
  return o;
}

/** CLI flags → the MCP tool args shape, validated by the same filterFromArgs the ledger tools use. */
async function filterOf(o: Opts, now: number): Promise<{ ok: true; filter: TradeFilter } | { ok: false; error: string }> {
  const { filterFromArgs } = await import('@dexterm/mcp');
  const a: Record<string, unknown> = {};
  for (const [flag, key] of [['source', 'source'], ['mode', 'mode'], ['strategy', 'strategy'], ['profile', 'profile'], ['exit', 'exit_reason'], ['mint', 'mint'], ['run', 'run_id'], ['account', 'account'], ['status', 'status']] as const) {
    if (typeof o[flag] === 'string') a[key] = o[flag];
  }
  if (typeof o.days === 'string') a.days = Number(o.days);
  return filterFromArgs(a, now);
}

async function loadView(io: LedgerIo, o: Opts, now: number): Promise<LedgerView> {
  const at = await import('@dexterm/autotrade');
  return at.loadLedgerView({ env: io.env, now, ...(typeof o['wallet-db'] === 'string' ? { walletDb: o['wallet-db'] } : {}) });
}

// ───────────────────────────── formatting ─────────────────────────────

const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length));
const lpad = (s: string, n: number) => (s.length >= n ? s : ' '.repeat(n - s.length) + s);
const num = (x: number | null | undefined, d = 2): string => (x === null || x === undefined || !Number.isFinite(x) ? '—' : x.toFixed(d));
const pct = (x: number | null | undefined): string => (x === null || x === undefined || !Number.isFinite(x) ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`);
const frac = (x: number | null | undefined): string => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(0)}%`);
export function fmtCap(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}
const hold = (sec: number): string => (sec < 90 ? `${Math.round(sec)}s` : sec < 5400 ? `${Math.round(sec / 60)}m` : sec < 172800 ? `${(sec / 3600).toFixed(1)}h` : `${(sec / 86400).toFixed(1)}d`);
const when = (t: number): string => new Date(t).toISOString().slice(0, 16).replace('T', ' ');
const stratOf = (t: TradeRow): string => (t.strategy ? `${t.strategy.id}@${t.strategy.version ?? (t.strategy.hash ?? '').slice(0, 8)}` : 'manual');
const tagOf = (id: string | null, source: string): string => (id ? (source === 'structured' || source === 'rule' ? id : `${id}*`) : '—');

function banner(v: LedgerView, rows: readonly TradeRow[]): string[] {
  const out: string[] = [];
  const f = v.file;
  out.push(f.exists ? (f.check.ok ? `ledger ${v.path}: ${f.events.length} events, chain verified` : `ledger ${v.path}: FAILS its check at line ${f.check.at}: ${f.check.error}`) : `ledger ${v.path}: not written yet (\`dexterm ledger sync\` writes it)`);
  if (v.pending.length) out.push(`  + ${v.pending.length} events from the sources not in the file yet (shown here; \`dexterm ledger sync\` appends them)`);
  for (const s of v.sources) if (s.problem) out.push(`  ! ${s.problem}`);
  const modes = [...new Set(rows.map((t) => t.walletMode))];
  if (modes.length > 1) out.push('  PAPER, REAL, DEVNET and LIVE trades are mixed here: use --mode before comparing results.');
  else if (modes[0] === 'paper') out.push('  PAPER (simulated) trades.');
  else if (modes[0] === 'real') out.push('  REAL-mode trades: dexterm modelled the trades it signalled to your executor; your executor\'s receipts are the real fills.');
  return out;
}

function tradesTable(rows: readonly TradeRow[]): string[] {
  const head = `${pad('opened', 16)}  ${pad('symbol', 8)} ${pad('src', 9)} ${pad('mode', 6)} ${pad('strategy', 18)} ${pad('profile', 10)} ${pad('exit', 14)} ${lpad('size', 8)} ${lpad('%book', 6)} ${lpad('entry mc', 9)} ${lpad('exit mc', 9)} ${lpad('P/L', 8)} ${lpad('hold', 6)} ${lpad('MFE', 7)} ${lpad('MAE', 7)}  id`;
  const out = [head];
  for (const t of rows) {
    const size = t.sizeSol !== null ? `${num(t.sizeSol, 3)}◎` : t.sizeUsd !== null ? `$${num(t.sizeUsd, 0)}` : '—';
    out.push([
      pad(when(t.openedAt), 16), ' ', pad(t.symbol, 8), ' ', pad(t.source, 9), ' ', pad(t.walletMode, 6), ' ', pad(stratOf(t), 18), ' ',
      pad(tagOf(t.profile.id, t.profile.source), 10), ' ', pad(t.status === 'open' ? 'open' : `${t.exitReason.code ?? 'untagged'}${t.rug ? ' RUG' : ''}`, 14), ' ',
      lpad(size, 8), ' ', lpad(t.pctOfBook === null ? '—' : `${t.pctOfBook.toFixed(0)}%`, 6), ' ', lpad(fmtCap(t.entryMcapUsd), 9), ' ', lpad(fmtCap(t.exitMcapUsd), 9), ' ',
      lpad(t.status === 'open' ? '—' : pct(t.pnlPct), 8), ' ', lpad(hold(t.holdSec), 6), ' ', lpad(pct(t.mfePct), 7), ' ', lpad(pct(t.maePct), 7), '  ', t.tradeId,
    ].join(''));
  }
  return out;
}

// ───────────────────────────── subcommands ─────────────────────────────

export async function ledgerCommand(argv: string[], io: LedgerIo): Promise<number> {
  const sub = argv[0];
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') { io.stdout.write(`${LEDGER_HELP}\n`); return 0; }
  const o = parse(argv.slice(1));
  if (typeof o === 'string') { io.stderr.write(`dexterm ledger: ${o}\n`); return 2; }
  const now = Date.now();
  const json = o.json === true;
  const out = (s: string) => io.stdout.write(s.endsWith('\n') ? s : `${s}\n`);
  try {
    if (sub === 'verify') {
      const { readTradeLedger, tradeLedgerPath } = await import('@dexterm/data/ledger');
      const path = tradeLedgerPath(io.env);
      const r = readTradeLedger(path);
      if (json) out(JSON.stringify({ path, exists: r.exists, ...r.check }));
      else if (!r.exists) out(`${path}: not written yet (nothing to verify)`);
      else out(r.check.ok ? `${path}: ${r.check.events} events, chain verified, head ${r.check.head.slice(0, 16)}` : `${path}: FAILS at line ${r.check.at}: ${r.check.error}`);
      return r.exists && !r.check.ok ? 1 : 0;
    }
    if (sub === 'sync') {
      const at = await import('@dexterm/autotrade');
      const r = at.syncLedger({ env: io.env, now, ...(typeof o['wallet-db'] === 'string' ? { walletDb: o['wallet-db'] } : {}) });
      const problems = r.view.sources.filter((s) => s.problem).map((s) => s.problem);
      if (json) out(JSON.stringify({ path: r.view.path, added: r.added, skipped: r.skipped, events: r.events, head: r.head, sources: r.view.sources }));
      else {
        out(`${r.view.path}: +${r.added} events (${r.skipped} already there), ${r.events} total, head ${r.head.slice(0, 16)}`);
        for (const s of r.view.sources) out(`  ${pad(s.source, 9)} ${s.label}: ${s.events} source events, ${s.pending} new${s.note ? ` · ${s.note}` : ''}`);
        for (const p of problems) out(`  ! ${p}`);
      }
      return 0;
    }
    const fr = await filterOf(o, now);
    if (!fr.ok) { io.stderr.write(`dexterm ledger: ${fr.error}\n`); return 2; }
    const { filterTrades, summarize, equityCurve, compareStrategies, exportTrades, EXPORT_FORMATS } = await import('@dexterm/data/ledger');
    const v = await loadView(io, o, now);
    const filter = sub === 'positions' ? { ...fr.filter, status: 'open' as const } : fr.filter;
    const rows = filterTrades(v.trades, filter).sort((a, b) => b.openedAt - a.openedAt);
    switch (sub) {
      case 'trades': case 'positions': {
        const limit = typeof o.limit === 'string' ? Math.max(1, Math.min(10_000, Number.parseInt(o.limit, 10) || 50)) : sub === 'positions' ? 10_000 : 50;
        const shown = rows.slice(0, limit);
        if (json) { out(JSON.stringify({ count: rows.length, trades: shown })); return 0; }
        for (const l of banner(v, rows)) out(l);
        if (!rows.length) { out(sub === 'positions' ? 'no open trades' : 'no trades match'); return 0; }
        for (const l of tradesTable(shown)) out(l);
        out(`${shown.length} of ${rows.length} shown · profile/exit with * = not declared structurally (tag line, late, default)`);
        return 0;
      }
      case 'summary': {
        const s = summarize(rows);
        if (json) { out(JSON.stringify(s)); return 0; }
        for (const l of banner(v, rows)) out(l);
        const u = s.unit === 'SOL' ? '◎' : '$';
        out(`trades ${s.trades} closed · ${s.open} open · wins ${s.wins} · losses ${s.losses}`);
        out(`win rate ${s.winRate ? `${frac(s.winRate.value)} (95% ${frac(s.winRate.lo)}–${frac(s.winRate.hi)})` : '—'} · P/L ${num(s.pnl, s.unit === 'SOL' ? 3 : 2)}${u} · avg ${pct(s.avgPnlPct)} · median ${pct(s.medianPnlPct)} · best ${pct(s.bestPct)} · worst ${pct(s.worstPct)}`);
        out(`profit factor ${num(s.profitFactor)} · max drawdown ${num(s.maxDrawdown, 3)}${u}${s.maxDrawdownPct !== null ? ` (${num(s.maxDrawdownPct, 1)}%)` : ''} · rugs ${s.rugs} (${frac(s.rugRate)}) · avg hold ${s.avgHoldSec === null ? '—' : hold(s.avgHoldSec)} · MFE ${pct(s.avgMfePct)} · MAE ${pct(s.avgMaePct)}`);
        out(`fees ${num(s.feesSol, 4)}◎ · model cost $${num(s.modelCostUsd)} · declared profile ${frac(s.tagCoverage.profileDeclared)} · declared exit ${frac(s.tagCoverage.exitDeclared)}`);
        for (const [title, gs] of [['by profile', s.byProfile], ['by exit reason', s.byExitReason], ['by strategy', s.byStrategy], ['by source', s.bySource], ['by mode', s.byMode]] as const) {
          if (!gs.length) continue;
          out(`\n${title}`);
          for (const g of gs) out(`  ${pad(g.key, 22)} ${lpad(String(g.trades), 4)} closed ${lpad(String(g.open), 3)} open  win ${lpad(frac(g.winRate), 4)}  P/L ${lpad(num(g.pnl, s.unit === 'SOL' ? 3 : 2), 9)}${u}  avg ${lpad(pct(g.avgPnlPct), 7)}  rugs ${g.rugs}`);
        }
        if (s.trades < 30) out(`\n${s.trades} closed trades: a small sample says little (see the interval).`);
        return 0;
      }
      case 'equity': {
        const c = equityCurve(rows);
        if (json) { out(JSON.stringify(c)); return 0; }
        for (const l of banner(v, rows)) out(l);
        const u = c.unit === 'SOL' ? '◎' : '$';
        out(`realized equity (${c.unit}), ${c.points.length} closes · final ${num(c.final, 3)}${u} · max drawdown ${num(c.maxDrawdown, 3)}${u}${c.maxDrawdownPct !== null ? ` (${num(c.maxDrawdownPct, 1)}%)` : ''}`);
        const step = Math.max(1, Math.ceil(c.points.length / 40));
        for (const [i, p] of c.points.entries()) if (i % step === 0 || i === c.points.length - 1) out(`  ${when(p.t)}  ${pad(p.symbol, 8)} ${lpad(num(p.pnl, 3), 9)}  cum ${lpad(num(p.cum, 3), 9)}  dd ${lpad(num(p.drawdown, 3), 8)}`);
        return 0;
      }
      case 'compare': {
        const c = compareStrategies(rows);
        if (json) { out(JSON.stringify(c)); return 0; }
        for (const l of banner(v, rows)) out(l);
        const u = c.unit === 'SOL' ? '◎' : '$';
        out(`${pad('strategy', 24)} ${pad('modes', 12)} ${lpad('trades', 6)} ${lpad('open', 4)} ${lpad('win', 4)} ${pad(' (95%)', 10)} ${lpad(`P/L ${u}`, 9)} ${lpad('avg', 7)} ${lpad('maxDD', 8)} ${lpad('rugs', 5)} ${lpad('hold', 6)} ${lpad('MFE', 7)} ${lpad('MAE', 7)} ${lpad('model $', 8)}`);
        for (const r of c.rows) out(`${pad(r.key, 24)} ${pad(r.modes.join(','), 12)} ${lpad(String(r.trades), 6)} ${lpad(String(r.open), 4)} ${lpad(frac(r.winRate?.value), 4)} ${pad(r.winRate ? ` ${frac(r.winRate.lo)}–${frac(r.winRate.hi)}` : '', 10)} ${lpad(num(r.pnl, 3), 9)} ${lpad(pct(r.avgPnlPct), 7)} ${lpad(num(r.maxDrawdown, 3), 8)} ${lpad(frac(r.rugRate), 5)} ${lpad(r.avgHoldSec === null ? '—' : hold(r.avgHoldSec), 6)} ${lpad(pct(r.avgMfePct), 7)} ${lpad(pct(r.avgMaePct), 7)} ${lpad(num(r.modelCostUsd), 8)}`);
        return 0;
      }
      case 'export': {
        const fmt = o._[0] ?? (typeof o.format === 'string' ? o.format : undefined);
        if (!fmt || !(EXPORT_FORMATS as readonly string[]).includes(fmt)) { io.stderr.write(`dexterm ledger export: the format is ${EXPORT_FORMATS.join(' | ')}\n`); return 2; }
        const text = exportTrades(rows, fmt as (typeof EXPORT_FORMATS)[number], { exportedAt: now, ledgerHead: v.file.check.ok ? v.file.check.head : null, unit: summarize(rows).unit, filters: { ...filter } });
        if (typeof o.out === 'string') { writeFileSync(o.out, text, { mode: 0o600 }); io.stderr.write(`wrote ${rows.length} trades to ${o.out}\n`); }
        else io.stdout.write(text);
        return 0;
      }
      case 'card': {
        const id = o._[0];
        const t = id ? v.trades.find((x) => x.tradeId === id) : undefined;
        if (!t) { io.stderr.write(`dexterm ledger card: ${id ? `no trade ${id}` : 'pass a tradeId (from `dexterm ledger trades`)'}\n`); return 2; }
        const card = await import('./pnl-card.ts');
        const solUsd = typeof o['sol-usd'] === 'string' ? Number(o['sol-usd']) : null;
        if (solUsd !== null && !(solUsd > 0)) { io.stderr.write('dexterm ledger card: --sol-usd is a positive number\n'); return 2; }
        const input = card.ledgerCardInput(t, { solUsd: solUsd ? { usd: solUsd, source: '--sol-usd' } : null });
        const s = card.computeCard(input, now);
        const opts = { aspect: o.square === true ? 'square' as const : 'wide' as const, exactSize: o.exact === true, ...(o.price === true ? { basis: 'price' as const } : {}) };
        const files = card.saveCard(s, opts, { env: io.env, now });
        out(card.cardText(s, opts));
        out(`saved ${files.wide}\n      ${files.square}\n      ${files.txt}`);
        return 0;
      }
      default:
        io.stderr.write(`dexterm ledger: unknown subcommand ${JSON.stringify(sub)}\n\n${LEDGER_HELP}\n`);
        return 2;
    }
  } catch (e) {
    io.stderr.write(`dexterm ledger: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}
