// task-1530 — read-only IMPORTERS: every trade journal dexterm already keeps, as unified ledger drafts.
//
// Nothing here writes to a source. The existing journals stay exactly as they are (and keep being written the way
// they always were), so the unified ledger is fully backward compatible: an old journal with none of the new fields
// imports with those fields null, and the "migration" of an existing install is one `dexterm ledger sync`.
//
//   desk     $DEXTERM_HOME/paper-agent.journal: the agent paper desk (MCP paper tools, the autotrade desk executor).
//            agent.paper.fill events, their structured tag (task-1530), the exit rule journaled just before a monitor
//            sell (agent.paper.exit.<rule>), and late PROFILE / REPROFILE / EXIT declarations (agent.paper.tag).
//            The journal's own hash chain is verified and its head recorded in the import event. An autotrade run on
//            the desk (note.by "autotrade") is imported here too, with its strategy / profile source / model from
//            the run ledger (`RunHint`).
//   paper    the paper wallet's paper_trades table (the TUI ticket). Rows the desk booked are joined to the desk
//            fills (fees, impact, slippage, the book before the fill) and not imported twice.
// task-1571: there is no live source. dexterm holds no key and places no live order, so it keeps no live fills.
// Autotrade run ledgers are imported by @dexterm/autotrade (`importRunLedgers`), which owns that format.
//
// A round trip is every fill on one mint from a buy while flat until the position is empty again (the source's own
// token count). Its key is the ref of its first fill, so re-importing never re-keys a trade.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { eventHash } from '../plans/journal.ts';
import { buildFillTag, buildLateTag, tagCode } from './tags.ts';
import { cleanCode, cleanLedgerText, finite, type Draft, type FillEvent, type FillTag, type ImportEvent, type LedgerSource, type TagEvent, type WalletMode } from './schema.ts';

const LAMPORTS = 1e9;
const num = (x: unknown): number | null => { const n = typeof x === 'string' && x.trim() !== '' ? Number(x) : x; return finite(n); };
const big = (x: unknown): bigint | null => { try { return typeof x === 'bigint' ? x : typeof x === 'string' && /^-?\d+$/.test(x) ? BigInt(x) : typeof x === 'number' && Number.isInteger(x) ? BigInt(x) : null; } catch { return null; } };
const absBig = (b: bigint): bigint => (b < 0n ? -b : b);
const solOf = (l: bigint | null): number | null => (l === null ? null : Number(l) / LAMPORTS);
const mintOk = (x: unknown): x is string => typeof x === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(x);
const sigOk = (x: unknown): string | null => (typeof x === 'string' && /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(x) ? x : null);

export interface SourceResult { label: string; source: LedgerSource; drafts: Draft[]; events: number; note: string | null; problem: string | null }

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Track the token count per key; flags the fill that empties the position. */
class RoundTrips {
  private held = new Map<string, { tokens: bigint; key: string }>();
  /** The trade key for this fill, and whether the position is flat after it. A sell while flat has no trade (null). */
  step(scope: string, side: 'buy' | 'sell', tokenDeltaAbs: bigint, ref: string): { tradeKey: string | null; closes: boolean } {
    const cur = this.held.get(scope);
    if (side === 'buy') {
      if (!cur || cur.tokens <= 0n) { this.held.set(scope, { tokens: tokenDeltaAbs, key: ref }); return { tradeKey: ref, closes: false }; }
      cur.tokens += tokenDeltaAbs; return { tradeKey: cur.key, closes: false };
    }
    if (!cur || cur.tokens <= 0n) return { tradeKey: null, closes: false };
    cur.tokens -= tokenDeltaAbs;
    const closes = cur.tokens <= 0n;
    if (closes) this.held.delete(scope);
    return { tradeKey: cur.key, closes };
  }
}

/** pump.fun mints every coin with 6 decimals and a fixed 1,000,000,000 supply (the PnL card's rule, task-1518). */
export const PUMP_FUN_DECIMALS = 6;
export const PUMP_FUN_SUPPLY_TOKENS = 1_000_000_000;
const isPumpFun = (mint: string): boolean => mint.endsWith('pump');

function fillDraft(p: Partial<Draft<FillEvent>> & Pick<Draft<FillEvent>, 'ref' | 'tradeKey' | 't' | 'source' | 'walletMode' | 'side' | 'mint' | 'symbol'>): Draft<FillEvent> {
  const d = {
    kind: 'fill', decimals: null, sol: null, usd: null, tokens: null, priceSol: null, priceUsd: null, supply: null, feeSol: null,
    impactPct: null, slippageBps: null, realizedSol: null, realizedUsd: null, bookSol: null, bookUsd: null, closes: null, txSig: null,
    runId: null, agent: null, strategy: null, sessionId: null, model: null, tag: null, ...p,
  } as Draft<FillEvent>;
  // a source that recorded no supply: a pump.fun coin's is fixed, so its market cap is price × 1B; any other stays null
  if (!d.supply && isPumpFun(d.mint)) d.supply = { tokens: PUMP_FUN_SUPPLY_TOKENS, source: 'pump.fun fixed supply' };
  return d;
}

function importDraft(source: LedgerSource, label: string, head: string | null, verified: boolean | null, events: number, t: number, note?: string): Draft<ImportEvent> {
  return { kind: 'import', t, ref: `import:${source}:${label}:${head ?? `n${events}`}`, source, label, sourceHead: head, sourceVerified: verified, events, ...(note ? { note } : {}) } as Draft<ImportEvent>;
}

// ───────────────────────────── the paper wallet table ─────────────────────────────

export interface WalletFillFacts { decimals: number; feeSol: number; impactPct: number | null; slippageBps: number | null; bookSolBefore: number | null; priceUsd: number | null }

interface WalletRow { id: number; t: number; mint: string; symbol: string; side: 'buy' | 'sell'; decimals: number; solDelta: bigint; tokenDelta: bigint; fee: bigint; priceSol: number; priceUsd: number | null; impact: number | null; slippage: number; realized: bigint }

function openRo(path: string): DatabaseSync | null {
  if (!path || path === ':memory:' || !existsSync(path)) return null;
  try { return new DatabaseSync(path, { readOnly: true }); } catch { return null; }
}
const hasTable = (db: DatabaseSync, name: string): boolean => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));

function readWallet(path: string): { rows: WalletRow[]; startLamports: bigint | null; createdAt: number | null } | null {
  const db = openRo(path);
  if (!db) return null;
  try {
    if (!hasTable(db, 'paper_trades')) return null;
    const w = hasTable(db, 'paper_wallet') ? db.prepare('SELECT start_lamports, created_at FROM paper_wallet WHERE id = 1').get() as Record<string, unknown> | undefined : undefined;
    const rows = (db.prepare('SELECT * FROM paper_trades ORDER BY id ASC').all() as Record<string, unknown>[]).map((r) => ({
      id: Number(r.id), t: Number(r.t), mint: String(r.mint), symbol: String(r.symbol), side: r.side === 'sell' ? 'sell' as const : 'buy' as const, decimals: Number(r.decimals),
      solDelta: big(r.sol_delta) ?? 0n, tokenDelta: big(r.token_delta) ?? 0n, fee: big(r.fee_lamports) ?? 0n, priceSol: Number(r.price_sol),
      priceUsd: r.price_usd === null ? null : Number(r.price_usd), impact: r.price_impact_pct === null ? null : Number(r.price_impact_pct),
      slippage: Number(r.slippage_bps), realized: big(r.realized_lamports) ?? 0n,
    }));
    return { rows, startLamports: w ? big(w.start_lamports) : null, createdAt: w ? Number(w.created_at) : null };
  } catch { return null; } finally { try { db.close(); } catch { /* ignore */ } }
}

/** Per wallet row: the book (cash + open cost) just BEFORE it, replayed from the wallet's start balance. */
function walletFacts(w: NonNullable<ReturnType<typeof readWallet>>): Map<number, WalletFillFacts> {
  const out = new Map<number, WalletFillFacts>();
  let cash = w.startLamports;
  const cost = new Map<string, { tokens: bigint; cost: bigint }>();
  for (const r of w.rows) {
    const openCost = [...cost.values()].reduce((s, c) => s + c.cost, 0n);
    out.set(r.id, { decimals: r.decimals, feeSol: Number(r.fee) / LAMPORTS, impactPct: r.impact, slippageBps: Number.isFinite(r.slippage) ? r.slippage : null, bookSolBefore: cash === null ? null : Number(cash + openCost) / LAMPORTS, priceUsd: r.priceUsd });
    if (cash !== null) cash += r.solDelta;
    const c = cost.get(r.mint) ?? { tokens: 0n, cost: 0n };
    if (r.side === 'buy') { c.tokens += absBig(r.tokenDelta); c.cost += absBig(r.solDelta); }
    else if (c.tokens > 0n) {
      const sold = absBig(r.tokenDelta) > c.tokens ? c.tokens : absBig(r.tokenDelta);
      c.cost -= (c.cost * sold) / c.tokens; c.tokens -= sold;
    }
    if (c.tokens <= 0n) cost.delete(r.mint); else cost.set(r.mint, c);
  }
  return out;
}

// ───────────────────────────── desk journal ─────────────────────────────

interface JEvent { seq: number; ts: number; type: string; planId: string | null; mandateId: string | null; data: Record<string, unknown> | null; prev: string; hash: string }

function verifyDeskChain(events: JEvent[]): { ok: boolean; at: number | null } {
  let prev = 'genesis';
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.seq !== i + 1 || e.prev !== prev) return { ok: false, at: i + 1 };
    const { hash, ...rest } = e;
    if (eventHash(rest) !== hash) return { ok: false, at: i + 1 };
    prev = hash;
  }
  return { ok: true, at: null };
}

/** What an autotrade run ledger knows about the desk fills it caused (the run itself books them on the desk). */
export interface RunHint {
  strategy: { id: string; version: string | null; hash: string | null } | null;
  /** Run-scoped session ids (`<runId>:<sid>`) whose enter DECISION named its exit profile. */
  declared: ReadonlySet<string>;
  /** Run-scoped session id -> model. */
  models: ReadonlyMap<string, string>;
}

export interface DeskImportOptions {
  /** Paper wallet SQLite (joins fees, impact, slippage, decimals and the book before each fill). */
  walletDb?: string | null;
  /** Autotrade runs by id: their desk fills get the run's strategy version, the profile source and the model. */
  runs?: ReadonlyMap<string, RunHint>;
}

export function importDeskJournal(path: string, o: DeskImportOptions = {}): SourceResult & { fillIds: Set<number> } {
  const label = 'paper-agent.journal';
  const res = { label, source: 'desk' as const, drafts: [] as Draft[], events: 0, note: null as string | null, problem: null as string | null, fillIds: new Set<number>() };
  if (!existsSync(path)) return res;
  const events: JEvent[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line) as JEvent); } catch { res.problem = `a line of ${label} is not JSON; imported the ${events.length} events before it`; break; }
  }
  res.events = events.length;
  const chain = verifyDeskChain(events);
  const head = events.length ? events[events.length - 1].hash : null;
  const wallet = o.walletDb ? readWallet(o.walletDb) : null;
  const facts = wallet ? walletFacts(wallet) : new Map<number, WalletFillFacts>();
  const trips = new RoundTrips();
  const lastExitRule = new Map<string, { rule: string; detail: string | null; t: number }>();
  const tradeOfMint = new Map<string, string>();
  for (const e of events) {
    const d = (e.data ?? {}) as Record<string, unknown>;
    const ref = `desk:${e.seq}:${String(e.hash).slice(0, 12)}`;
    if (e.type.startsWith('agent.paper.exit.') && e.type !== 'agent.paper.exit.plan' && e.type !== 'agent.paper.exit.done' && mintOk(d.mint)) {
      lastExitRule.set(d.mint, { rule: e.type.slice('agent.paper.exit.'.length), detail: cleanLedgerText(d.detail, 200), t: e.ts });
      continue;
    }
    if (e.type === 'agent.paper.tag' && mintOk(d.mint)) {
      const g = buildLateTag({ kind: d.tagKind, profile: d.profile, from: d.from, to: d.to, exitReason: d.exitReason, reason: d.reason, line: d.line });
      if (!g.ok) continue;
      res.drafts.push({
        kind: 'tag', t: e.ts, ref, tradeKey: tradeOfMint.get(d.mint) ?? null, source: 'desk', mint: d.mint, tagKind: g.tagKind,
        profile: g.tagKind === 'profile' ? g.profile : null, from: g.tagKind === 'reprofile' ? g.from : null, to: g.tagKind === 'reprofile' ? g.to : null,
        exitReason: g.tagKind === 'exit' ? g.exitReason : null, reason: g.reason, line: g.line, tagSource: g.tagKind === 'reprofile' ? 'structured' : 'late',
      } as Draft<TagEvent>);
      continue;
    }
    if (e.type !== 'agent.paper.fill' || !mintOk(d.mint)) continue;
    const side = d.side === 'sell' ? 'sell' as const : 'buy' as const;
    const solDelta = big(d.solDelta);
    const tokenDelta = big(d.tokenDelta);
    if (solDelta === null || tokenDelta === null) continue;
    const fillId = num(d.fillId);
    if (fillId !== null) res.fillIds.add(fillId);
    const note = (d.note && typeof d.note === 'object' ? d.note : {}) as Record<string, unknown>;
    const runId = typeof note.runId === 'string' ? cleanCode(note.runId, 80) : null;
    const byRun = note.by === 'autotrade';
    const hint = byRun && runId ? o.runs?.get(runId) ?? null : null;
    const trip = trips.step(d.mint, side, absBig(tokenDelta), ref);
    if (trip.tradeKey) tradeOfMint.set(d.mint, trip.tradeKey);
    if (!trip.tradeKey) continue;
    const f = fillId !== null ? facts.get(fillId) : undefined;
    // journals before task-1530 carry no decimals: a pump.fun coin's are fixed; any other mint stays unknown (no tokens)
    const decimals = num(d.decimals) ?? f?.decimals ?? (isPumpFun(d.mint) ? PUMP_FUN_DECIMALS : null);
    const tokens = decimals !== null ? Number(absBig(tokenDelta)) / 10 ** decimals : null;
    const sol = Number(absBig(solDelta)) / LAMPORTS;
    const priceSol = num(d.priceSol);
    const priceUsd = num(d.priceUsd) ?? f?.priceUsd ?? null;
    const solUsd = priceSol && priceUsd ? priceUsd / priceSol : null;
    // an autotrade run's session ids are per run (s1, s2, …): scope them so two runs never share one
    const rawSid = typeof d.sessionId === 'string' ? d.sessionId : typeof note.sessionId === 'string' ? note.sessionId : null;
    const sessionId = cleanCode(byRun && runId && rawSid ? `${runId}:${rawSid}` : rawSid, 80);
    // the tag: the structured one the desk now persists; else what an autotrade note carries; else the monitor exit
    // rule journaled just before the sell
    let tag: FillTag | null = d.tag && typeof d.tag === 'object' ? sanitizeStoredTag(side, d.tag as Record<string, unknown>) : null;
    if (side === 'buy' && !tag && typeof note.profile === 'string') {
      const reason = cleanLedgerText(note.reason, 200);
      const named = sessionId !== null && (hint?.declared.has(sessionId) ?? false);
      tag = { profile: tagCode(note.profile), reason, exitReason: null, line: null, source: named ? 'structured' : 'default', ...(reason && !named ? { reasonSource: 'structured' as const } : {}) };
    }
    const exitNote = typeof note.exit === 'string' ? tagCode(note.exit) : null;
    const seen = lastExitRule.get(d.mint);
    const rule = side === 'sell' ? (exitNote ? { rule: exitNote, detail: null } : seen && e.ts - seen.t < 600_000 ? seen : null) : null;
    if (side === 'sell' && rule && !(tag && tag.exitReason)) {
      const code = tagCode(rule.rule);
      const agentWords = cleanLedgerText(note.agentReason, 200);
      tag = { profile: null, reason: tag?.reason ?? agentWords ?? rule.detail ?? null, exitReason: code, line: tag?.line ?? null, source: code === 'agent-exit' || code === 'agent-trim' ? 'structured' : 'rule' };
    }
    if (side === 'sell') lastExitRule.delete(d.mint);
    const noteStrategy = byRun && typeof note.strategy === 'string' ? { id: cleanCode(note.strategy, 32) ?? 'unknown', version: null, hash: cleanCode(note.strategyHash, 64) } : null;
    res.drafts.push(fillDraft({
      ref, tradeKey: trip.tradeKey, t: e.ts, source: 'desk', walletMode: 'paper', side, mint: d.mint, symbol: cleanLedgerText(d.symbol, 24) ?? '?', decimals,
      sol, usd: solUsd ? sol * solUsd : null, tokens, priceSol, priceUsd,
      feeSol: num(d.feeLamports) !== null ? num(d.feeLamports)! / LAMPORTS : f?.feeSol ?? null,
      impactPct: num(d.impactPct) ?? f?.impactPct ?? null, slippageBps: num(d.slippageBps) ?? f?.slippageBps ?? null,
      realizedSol: side === 'sell' ? solOf(big(d.realizedLamports)) : null,
      bookSol: num(d.bookLamports) !== null ? num(d.bookLamports)! / LAMPORTS : f?.bookSolBefore ?? null,
      bookUsd: null, closes: trip.closes, runId, agent: cleanLedgerText(d.agent, 40),
      strategy: hint?.strategy ?? noteStrategy, sessionId,
      model: cleanLedgerText(d.model, 40) ?? (sessionId ? hint?.models.get(sessionId) ?? null : null), tag,
    }));
  }
  if (events.length) res.drafts.unshift(importDraft('desk', label, head, chain.ok, events.length, events[events.length - 1].ts, chain.ok ? undefined : `the journal's chain breaks at event ${chain.at}`));
  if (!chain.ok) res.problem = `${label}: its hash chain breaks at event ${chain.at} (imported as found; \`dexterm ledger verify\` shows the import)`;
  return res;
}

/** A tag read back from a journal: re-cleaned (the journal is a file; never trust what it holds). */
function sanitizeStoredTag(side: 'buy' | 'sell', g: Record<string, unknown>): FillTag | null {
  const t = buildFillTag(side, { profile: g.profile, reason: g.reason, exitReason: g.exitReason, line: g.line });
  if (!t) return null;
  const src = g.source;
  const known = src === 'structured' || src === 'tag-line' || src === 'rule' || src === 'late' || src === 'default';
  return { ...t, source: known ? src as FillTag['source'] : t.source };
}

// ───────────────────────────── paper wallet (the TUI ticket) ─────────────────────────────

export function importPaperWallet(dbPath: string, deskFillIds: ReadonlySet<number> = new Set()): SourceResult {
  const label = 'paper-wallet';
  const res: SourceResult = { label, source: 'paper', drafts: [], events: 0, note: null, problem: null };
  const w = readWallet(dbPath);
  if (!w) return res;
  res.events = w.rows.length;
  const facts = walletFacts(w);
  const trips = new RoundTrips();
  const scope = `w${w.createdAt ?? 0}`;
  let n = 0;
  for (const r of w.rows) {
    const ref = `paper:${scope}:${r.id}`;
    const trip = trips.step(r.mint, r.side, absBig(r.tokenDelta), ref);
    if (deskFillIds.has(r.id) || !trip.tradeKey || !mintOk(r.mint)) continue; // the desk's fills come from its journal
    const f = facts.get(r.id)!;
    const sol = Number(absBig(r.solDelta)) / LAMPORTS;
    const solUsd = r.priceUsd && r.priceSol ? r.priceUsd / r.priceSol : null;
    res.drafts.push(fillDraft({
      ref, tradeKey: trip.tradeKey, t: r.t, source: 'paper', walletMode: 'paper', side: r.side, mint: r.mint, symbol: cleanLedgerText(r.symbol, 24) ?? '?',
      decimals: r.decimals, sol, usd: solUsd ? sol * solUsd : null, tokens: Number(absBig(r.tokenDelta)) / 10 ** r.decimals, priceSol: r.priceSol, priceUsd: r.priceUsd,
      feeSol: f.feeSol, impactPct: r.impact, slippageBps: r.slippage, realizedSol: r.side === 'sell' ? Number(r.realized) / LAMPORTS : null,
      bookSol: f.bookSolBefore, closes: trip.closes,
    }));
    n++;
  }
  if (w.rows.length) res.drafts.unshift(importDraft('paper', label, `${scope}:${w.rows[w.rows.length - 1].id}`, null, w.rows.length, w.rows[w.rows.length - 1].t, n ? undefined : 'no fills outside the agent desk'));
  return res;
}

