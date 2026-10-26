// dexterm autotrade — the run ledgers as UNIFIED TRADE LEDGER drafts (task-1530). Read-only.
//
// Every $DEXTERM_HOME/autotrade/runs/<runId>.jsonl is read, its own hash chain verified (the import event records
// the head and the result), and its fills, reprofiles, closes and session costs become `@dexterm/data/ledger`
// drafts. A run that traded on the paper desk (the desk executor, `executor: "paper-desk"`) booked its fills there:
// the desk journal stays their source (SOL, fees, the book before the fill), and this run adds what the desk does
// not know (the strategy version, whether the agent named the profile, the model, reprofiles, the price extremes
// and the session costs) through `RunHint` and coin-matched tag / close events.
//
// Where each ledger field comes from:
//   strategy           run_start: strategy id, version and strategyHash
//   wallet mode        run_start.mode (paper; real = a real-mode run, task-1655; a live run's executor name says devnet or mainnet)
//   profile            the entry fill's profile; 'structured' when the agent's DECISION named it, else 'default'
//                      (the strategy's default profile), 'rule' for a mechanical (auto) entry
//   entry reason       the agent's DECISION {"action":"enter","reason":…} of the session that entered (structured)
//   exit reason        the sell fill's rule (tp1, trail, stop, max-hold, thesis-…) or agent-exit / agent-trim with
//                      the agent's reason; reprofile events become REPROFILE tags
//   size, prices, mcap USD fills (the desk books in USD); market cap = price × the supply the candidate tick implies
//                      (tick mcap ÷ tick price), or the fill's own tick mcap (task-1530 runs)
//   MFE / MAE          trade_closed peakPrice / troughPrice (task-1530 runs; older runs: the fills only)
//   model              session_start model; session_end costUsd (session ids are scoped by run: s1 of one run is
//                      not s1 of another)

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendTradeLedger, buildLedgerView, cleanLedgerText, collectDataSources, defaultSourcePaths, dextermHomeDir, tagCode, tradeLedgerPath, type Draft, type FillEvent, type FillTag, type LedgerView, type RunHint, type SourceResult, type TagSource, type WalletMode } from '@dexterm/data/ledger';
import { defaultDbPath } from '@dexterm/data';
import { runsDir, verifyChain, type LedgerEvent } from './ledger.ts';

const RUN_FILE = /^([0-9TZ]+-[a-z][a-z0-9-]{1,31}-[0-9a-f]{4})\.jsonl$/;
const fin = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const str = (x: unknown): string | null => (typeof x === 'string' && x ? x : null);
const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** Exit codes the agent chose (its reason is its own words); every other code is a mechanical rule. */
const AGENT_EXITS = new Set(['agent-exit', 'agent-trim']);

export interface RunImport {
  results: SourceResult[];
  /** Every run, by id: what the desk importer needs for the fills a run booked on the paper desk. */
  hints: Map<string, RunHint>;
}

/** Read every run ledger under `home` (missing directory: nothing). */
export function importRunLedgers(home: string): RunImport {
  const dir = runsDir(home);
  const out: RunImport = { results: [], hints: new Map() };
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const m = RUN_FILE.exec(name);
    if (!m) continue;
    const r = importRunLedger(join(dir, name), m[1]);
    out.results.push(r);
    out.hints.set(m[1], r.hint);
  }
  return out;
}

export function importRunLedger(path: string, runId: string): SourceResult & { hint: RunHint } {
  const declared = new Set<string>();
  const res: SourceResult & { hint: RunHint } = { label: `run ${runId}`, source: 'autotrade', drafts: [], events: 0, note: null, problem: null, hint: { strategy: null, declared, models: new Map() } };
  const events: LedgerEvent[] = [];
  let cut = false;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line) as LedgerEvent); } catch { cut = true; break; }
  }
  res.events = events.length;
  if (!events.length) return res;
  const chain = verifyChain(events as unknown as Record<string, unknown>[]);
  const start = events.find((e) => e.kind === 'run_start') ?? null;
  const strategy = start && str(start.strategy) ? { id: String(start.strategy), version: str(start.version), hash: str(start.strategyHash) } : null;
  const executor = String(start?.executor ?? '');
  const walletMode: WalletMode = start?.mode === 'real' ? 'real' : start?.mode === 'live' ? (/mainnet/.test(executor) ? 'live' : 'devnet') : 'paper';
  const auto = start?.decide === 'auto';
  // task-1538: a parallel-run strategy on a shared paper account names it in its first line (and run_start).
  const memberLine = events.find((e) => e.kind === 'fleet_member') ?? null;
  const acct = str(memberLine?.account) ?? str(start?.account);
  const account = acct && /^[a-z][a-z0-9-]{1,31}$/.test(acct) ? acct : null;
  // A run on the paper desk booked its fills there: the desk journal is their source (SOL, fees, the book), so
  // this run adds only what the desk does not know: reprofiles, the exit's price extremes and the session costs.
  const onDesk = executor === 'paper-desk';
  const looseSource = onDesk ? 'desk' as const : 'autotrade' as const;
  const scope = (sid: unknown): string | null => (typeof sid === 'string' && sid ? `${runId}:${sid}`.slice(0, 80) : null);

  const symbolOf = new Map<string, string>();
  const supplyOf = new Map<string, { tokens: number; source: string }>();
  const modelOf = res.hint.models as Map<string, string>;
  res.hint.strategy = strategy;
  const enterOf = new Map<string, { reason: string | null; profile: string | null }>();
  const clampOf = new Map<string, { sessionId: string | null; profile: string | null }>();
  const posOf = new Map<string, { key: string; sessionId: string | null; mint: string }>();
  const supplyFrom = (mcap: unknown, price: unknown, source: string) => {
    const mc = fin(mcap), p = fin(price);
    return mc && p && mc > 0 && p > 0 && Number.isFinite(mc / p) ? { tokens: mc / p, source } : null;
  };

  for (const e of events) {
    const ref = `run:${runId}:${e.seq}`;
    switch (e.kind) {
      case 'candidate': {
        const mint = str(e.mint);
        if (!mint) break;
        const sym = cleanLedgerText(e.symbol, 24);
        if (sym) symbolOf.set(mint, sym);
        const tick = (e.tick ?? {}) as Record<string, unknown>;
        const s = supplyFrom(tick.mcap, tick.price, 'tick market cap ÷ price');
        if (s) supplyOf.set(mint, s);
        break;
      }
      case 'session_start': { const sid = scope(e.sessionId); const model = cleanLedgerText(e.model, 40); if (sid && model) modelOf.set(sid, model); break; }
      case 'reply': {
        const d = e.decision as { ok?: boolean; decision?: { action?: string; reason?: string; profile?: string } } | undefined;
        const sid = scope(e.sessionId);
        if (sid && d?.ok && d.decision?.action === 'enter') {
          enterOf.set(sid, { reason: cleanLedgerText(d.decision.reason, 200), profile: tagCode(d.decision.profile) });
          if (tagCode(d.decision.profile)) declared.add(sid);
        }
        break;
      }
      case 'clamp': {
        const mint = str(e.mint);
        const r = (e.result ?? {}) as { ok?: boolean; profile?: string };
        if (mint && r.ok) clampOf.set(mint, { sessionId: scope(e.sessionId), profile: tagCode(r.profile) });
        break;
      }
      case 'fill': {
        const mint = str(e.mint), pid = str(e.positionId);
        if (!mint || !MINT.test(mint) || !pid) break;
        const side = e.side === 'sell' ? 'sell' as const : 'buy' as const;
        let pos = posOf.get(pid);
        if (!pos) {
          if (side === 'sell') break; // a sell with no entry on record
          const c = clampOf.get(mint);
          pos = { key: `run:${runId}:${pid}`, sessionId: c?.sessionId ?? null, mint };
          posOf.set(pid, pos);
        }
        if (onDesk) break;
        const usd = fin(e.usd), tokens = fin(e.tokens);
        const own = supplyFrom(e.mcap, e.price, 'fill tick market cap ÷ price');
        if (own) supplyOf.set(mint, own);
        let tag: FillTag | null = null;
        const reason = str(e.reason);
        if (side === 'buy' && reason === 'entry') {
          const dec = pos.sessionId ? enterOf.get(pos.sessionId) : undefined;
          const profile = tagCode(e.profile) ?? clampOf.get(mint)?.profile ?? null;
          const source: TagSource = dec?.profile ? 'structured' : dec ? 'default' : auto ? 'rule' : 'default';
          tag = { profile, reason: dec?.reason ?? (auto ? 'mechanical entry (the strategy\'s entry rules matched)' : null), exitReason: null, line: null, source, ...(dec?.reason && source !== 'structured' ? { reasonSource: 'structured' as const } : {}) };
        } else if (side === 'sell' && reason) {
          const code = tagCode(reason);
          tag = { profile: null, reason: cleanLedgerText(e.detail, 200), exitReason: code, line: null, source: code && AGENT_EXITS.has(code) ? 'structured' : 'rule' };
        }
        res.drafts.push({
          kind: 'fill', ref, tradeKey: pos.key, t: e.t, source: 'autotrade', walletMode, side, mint, symbol: symbolOf.get(mint) ?? mint.slice(0, 4),
          decimals: null, sol: null, usd, tokens, priceSol: null, priceUsd: fin(e.avgPrice) ?? fin(e.price), supply: supplyOf.get(mint) ?? null,
          feeSol: null, impactPct: fin(e.impactPct), slippageBps: null, realizedSol: null, realizedUsd: null, bookSol: null, bookUsd: fin(e.bookUsd),
          closes: null, txSig: str(e.txSig), runId, agent: auto ? 'auto' : 'agent', strategy, ...(account ? { account } : {}), sessionId: pos.sessionId,
          model: pos.sessionId ? modelOf.get(pos.sessionId) ?? null : null, tag,
        } as Draft<FillEvent>);
        break;
      }
      case 'reprofile': {
        const pos = posOf.get(String(e.positionId));
        if (!pos) break;
        res.drafts.push({ kind: 'tag', t: e.t, ref, tradeKey: onDesk ? null : pos.key, source: looseSource, mint: pos.mint, tagKind: 'reprofile', from: tagCode(e.from), to: tagCode(e.to), reason: cleanLedgerText(e.reason, 200), line: null, tagSource: 'structured' } as Draft);
        break;
      }
      case 'trade_closed': {
        const tr = (e.trade ?? {}) as Record<string, unknown>;
        const pos = posOf.get(String(tr.id));
        if (!pos) break;
        const sym = cleanLedgerText(tr.symbol, 24);
        if (sym) symbolOf.set(pos.mint, sym);
        res.drafts.push({
          kind: 'close', t: e.t, ref, tradeKey: onDesk ? null : pos.key, source: looseSource, mint: pos.mint, reason: tagCode(tr.exitReason), stuck: tr.stuck === true,
          peakPrice: fin(e.peakPrice), troughPrice: fin(e.troughPrice), entryPrice: fin(e.entryPrice), priceUnit: 'usd', sessionId: pos.sessionId,
        } as Draft);
        break;
      }
      case 'session_end': {
        const sid = scope(e.sessionId), cost = fin(e.costUsd);
        if (sid && cost !== null && cost > 0) res.drafts.push({ kind: 'cost', t: e.t, ref, source: 'autotrade', sessionId: sid, costUsd: cost, model: modelOf.get(sid) ?? null, runId } as Draft);
        break;
      }
      default: break;
    }
  }
  const last = events[events.length - 1];
  const head = String(last.hash ?? '');
  res.drafts.unshift({ kind: 'import', t: last.t, ref: `import:autotrade:${runId}:${head || `n${events.length}`}`, source: 'autotrade', label: res.label, sourceHead: head || null, sourceVerified: chain.ok && !cut, events: events.length, ...(chain.ok ? {} : { note: `the run's chain breaks at event ${chain.at}` }) } as Draft);
  if (!chain.ok) res.problem = `${res.label}: its hash chain breaks at event ${chain.at} (${chain.error}); imported as found`;
  else if (cut) res.problem = `${res.label}: a line is not JSON; imported the ${events.length} events before it`;
  return res;
}

// ───────────────────────────── the whole view (every source) ─────────────────────────────

export interface FullLedgerOptions {
  env?: NodeJS.ProcessEnv;
  /** The paper wallet SQLite (the app's `--db`); default: the paper desk's rendezvous db, else the app's default db. */
  walletDb?: string | null;
  /** The ledger file; default `$DEXTERM_HOME/ledger/trades.jsonl`. */
  path?: string;
  now?: number;
}

/** The paper wallet db the desk last used (its rendezvous names it), else the app's default db path. */
export function defaultWalletDb(env: NodeJS.ProcessEnv = process.env): string {
  try {
    const rv = JSON.parse(readFileSync(join(dextermHomeDir(env), 'paper-agent.json'), 'utf8')) as { db?: unknown };
    if (typeof rv.db === 'string' && rv.db && rv.db !== ':memory:') return rv.db;
  } catch { /* none */ }
  return defaultDbPath(env);
}

/** Every source as drafts: the run ledgers first (their hints feed the desk importer), then the data-layer journals. */
export function collectAllSources(o: FullLedgerOptions = {}): SourceResult[] {
  const env = o.env ?? process.env;
  const runs = importRunLedgers(dextermHomeDir(env));
  const data = collectDataSources(defaultSourcePaths(env, o.walletDb === undefined ? defaultWalletDb(env) : o.walletDb), { runs: runs.hints });
  return [...data, ...runs.results];
}

/** The read view (file + pending drafts, folded). Writes nothing. */
export function loadLedgerView(o: FullLedgerOptions = {}): LedgerView {
  const env = o.env ?? process.env;
  return buildLedgerView(o.path ?? tradeLedgerPath(env), collectAllSources(o), o.now ?? Date.now());
}

/** `dexterm ledger sync`: append what the sources hold that the file does not (idempotent; refuses a broken file). */
export function syncLedger(o: FullLedgerOptions = {}): { view: LedgerView; added: number; skipped: number; head: string; events: number } {
  const view = loadLedgerView(o);
  const r = appendTradeLedger(view.path, view.pending, o.now ?? Date.now());
  return { view, ...r };
}
