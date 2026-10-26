// dexterm autotrade — real-mode limits, every number user-set (task-1654, 0.2.0 card E). Builds on card A's caps.
//
// One file, $DEXTERM_HOME/autotrade/real/limits.json (`dexterm-limits/1`, JSON Schema in assets/limits.schema.json):
//
//   global       the home: a number here REPLACES the placeholder default (null = that limit is off)
//   modes.real   real runs        modes.paper  paper runs (opt-in: paper ignores limits unless this scope exists)
//   strategies.<id>  one strategy    accounts.<id>  one account
//
// The effective value of a limit is the placeholder default, replaced by `global`, then the STRICTER of that and
// every other scope that sets it (mode, strategy, account): a strategy or an account can only tighten. Stricter
// means smaller for a cap (per-trade SOL, buys per day …) and larger for a floor (min liquidity, min position, the
// loss-streak pause).
//
// The safety model (unchanged from card A): limits live OUTSIDE the model. No MCP tool, decision verb or chat
// command writes this file; the analyst can read, explain and PROPOSE a diff (limits_propose), never apply it.
// Lowering is free and takes effect at once (a running real run re-reads the file and takes the stricter of what
// it started with and what the file says now). Raising anything - a bigger number on a cap, a smaller floor, a
// limit removed or turned off - needs the typed confirmation on a real terminal and applies from the next run.
// A file that does not match the last save dexterm journaled (a hand edit, or anything else that wrote it) is
// accepted only if it lowers; one that raises is refused until `dexterm autotrade limits accept` (typed).
//
// The defaults are placeholders, not advice: arming real mode asks for your own numbers first and shows the
// effective limits, which the typed phrase confirms. Your numbers win.

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { writeJsonAtomic } from './ledger.ts';
import { localDay } from './chat/audit.ts';
import { realDir } from './outbox.ts';

export const LIMITS_SCHEMA = 'dexterm-limits/1';
export const RISK_STATE_SCHEMA = 'dexterm-real-risk/1';
export const limitsPath = (home: string): string => join(realDir(home), 'limits.json');
export const riskStatePath = (home: string): string => join(realDir(home), 'risk.json');
const legacyCapsPath = (home: string): string => join(realDir(home), 'caps.json');
const legacyDayPath = (home: string): string => join(realDir(home), 'day.json');
const journalPath = (home: string): string => join(realDir(home), 'journal.jsonl');

// ───────────────────────────── the fields ─────────────────────────────

/** `max`: a cap, smaller is stricter. `min`: a floor, larger is stricter. */
export type LimitDir = 'max' | 'min';
export type LimitGroup = 'sizing' | 'risk' | 'sells' | 'executor';

export interface LimitField {
  key: string;
  group: LimitGroup;
  dir: LimitDir;
  /** Validity bounds (what the number can mean), not ceilings on what you may choose. */
  lo: number;
  hi: number;
  int?: boolean;
  unit: string;
  help: string;
}

const BIG = 1e12;

export const LIMIT_FIELDS = [
  { key: 'perTradeSol', group: 'sizing', dir: 'max', lo: 0.000001, hi: BIG, unit: 'SOL', help: 'the most SOL one buy signal may spend (a bigger buy is clamped down to it)' },
  { key: 'perTradePct', group: 'sizing', dir: 'max', lo: 0.01, hi: 100, unit: '% of book', help: 'the most one buy may spend as a percent of the book (bookSol, else the strategy book); with perTradeSol set too, the smaller wins' },
  { key: 'dailySol', group: 'sizing', dir: 'max', lo: 0.000001, hi: BIG, unit: 'SOL/day', help: 'SOL all buy signals may spend per local day (a buy over it is refused)' },
  { key: 'buysPerDay', group: 'sizing', dir: 'max', lo: 0, hi: 1e6, int: true, unit: 'buys/day', help: 'buy signals per local day (0 = no buys)' },
  { key: 'maxOpenPositions', group: 'sizing', dir: 'max', lo: 0, hi: 1e5, int: true, unit: 'open', help: 'real positions open at once, across every strategy and account on this home' },
  { key: 'maxExposurePct', group: 'sizing', dir: 'max', lo: 0.01, hi: 100, unit: '% of book', help: 'the cost of every open real position together, as a percent of the book (a buy is clamped to what is left)' },
  { key: 'minPositionSol', group: 'sizing', dir: 'min', lo: 0, hi: BIG, unit: 'SOL', help: 'a buy smaller than this after every clamp is refused (no dust orders)' },
  { key: 'maxPositionSol', group: 'sizing', dir: 'max', lo: 0.000001, hi: BIG, unit: 'SOL', help: 'the most SOL one position may cost, adds included (a buy is clamped to what is left)' },
  { key: 'perCoinSolPerDay', group: 'sizing', dir: 'max', lo: 0.000001, hi: BIG, unit: 'SOL/day', help: 'SOL spent on one coin per local day, re-entries included (a buy over it is refused)' },
  { key: 'perCoinBuysPerDay', group: 'sizing', dir: 'max', lo: 0, hi: 1e5, int: true, unit: 'buys/day', help: 'buy signals on one coin per local day' },
  { key: 'bookSol', group: 'sizing', dir: 'max', lo: 0.000001, hi: BIG, unit: 'SOL', help: 'what the percent limits are a percent of: the size of YOUR account (unset = the strategy\'s own book)' },
  { key: 'dailyLossSol', group: 'risk', dir: 'max', lo: 0.000001, hi: BIG, unit: 'SOL/day', help: 'when the day\'s realized loss reaches this, no new buy goes out until the next local day (exits still do)' },
  { key: 'maxDrawdownSol', group: 'risk', dir: 'max', lo: 0.000001, hi: BIG, unit: 'SOL', help: 'the drawdown breaker: realized PnL this far below its peak trips it; no new buy until you reset it (typed)' },
  { key: 'lossStreak', group: 'risk', dir: 'max', lo: 1, hi: 1e4, int: true, unit: 'losses', help: 'this many losing closes in a row pause new buys for lossStreakPauseMin' },
  { key: 'lossStreakPauseMin', group: 'risk', dir: 'min', lo: 1, hi: 525_600, unit: 'min', help: 'how long the loss-streak pause lasts' },
  { key: 'maxHoldMinutes', group: 'risk', dir: 'max', lo: 1, hi: 525_600, unit: 'min', help: 'a real position held this long gets its exit signal (the stricter of this and the exit profile\'s own cap)' },
  { key: 'minLiquidityUsd', group: 'risk', dir: 'min', lo: 0, hi: BIG, unit: 'USD', help: 'no buy on a coin with less pool liquidity (unknown liquidity is refused while this is set)' },
  { key: 'minMcapUsd', group: 'risk', dir: 'min', lo: 0, hi: BIG, unit: 'USD', help: 'no buy on a coin below this market cap (unknown is refused while this is set)' },
  { key: 'maxSlippageBps', group: 'risk', dir: 'max', lo: 1, hi: 10_000, int: true, unit: 'bps', help: 'the slippage tolerance a signal states (the stricter of this and the strategy\'s)' },
  { key: 'maxPriceImpactPct', group: 'risk', dir: 'max', lo: 0.01, hi: 100, unit: '%', help: 'the price impact a buy may have on the pool (the engine\'s constant-product model: size / half the liquidity): a buy is clamped to it, and the signal states the stricter tolerance' },
  { key: 'signalTtlSec', group: 'risk', dir: 'max', lo: 10, hi: 600, int: true, unit: 's', help: 'how long an executor may act on a signal (the stricter of this and the channel setting)' },
  { key: 'maxBuysPerMinute', group: 'risk', dir: 'max', lo: 0, hi: 1e4, int: true, unit: 'buys/min', help: 'the signal rate limit: buy signals in any 60 s' },
  { key: 'maxSellsPerMinute', group: 'sells', dir: 'max', lo: 1, hi: 1e4, int: true, unit: 'sells/min', help: 'OPTIONAL: sells are never capped unless you set this; a sell over it waits for the next tick' },
  { key: 'minForwardTrades', group: 'risk', dir: 'min', lo: 0, hi: 1e5, int: true, unit: 'trades', help: 'the evidence floor for real: arming needs a COMPLETED forward test of these exact rules with at least this many closed paper trades, and a backtest on record (below it only a typed override on your own terminal arms, journaled)' },
  { key: 'executorSilenceMin', group: 'executor', dir: 'max', lo: 1, hi: 525_600, unit: 'min', help: 'no heartbeat, receipt or ack from your executor for this long pauses new buy signals (exits still go out)' },
] as const satisfies readonly LimitField[];

export type LimitKey = (typeof LIMIT_FIELDS)[number]['key'];
export const LIMIT_KEYS: readonly LimitKey[] = LIMIT_FIELDS.map((f) => f.key);
const FIELD = new Map<string, LimitField>(LIMIT_FIELDS.map((f) => [f.key, f]));
export const limitField = (k: string): LimitField | undefined => FIELD.get(k);

/** A scope's numbers. In `global`, null turns a limit off (the placeholder default no longer applies). */
export type LimitSet = Partial<Record<LimitKey, number | null>>;

/**
 * The placeholder defaults for real mode. Conservative for a first real run, not advice: arming asks for your own
 * numbers and shows these only as the starting point. Every other limit is unset (off) until you set it.
 */
export const DEFAULT_LIMITS: Readonly<LimitSet> = Object.freeze({
  perTradeSol: 0.25, dailySol: 1, buysPerDay: 20, maxOpenPositions: 3,
  dailyLossSol: 0.5, lossStreak: 5, lossStreakPauseMin: 60, maxBuysPerMinute: 3, executorSilenceMin: 15,
  // task-1679 (the 0.2.0 product decision, 2026-10-25): the evidence floor for promotion to real.
  minForwardTrades: 10,
});

export interface LimitsDoc {
  schema: typeof LIMITS_SCHEMA;
  global: LimitSet;
  modes: { real?: LimitSet; paper?: LimitSet };
  strategies: Record<string, LimitSet>;
  accounts: Record<string, LimitSet>;
  updatedAt?: number;
  /** Card A's caps.json, read as `global` the first time (its numbers were confirmed when it was armed). */
  migratedFrom?: string;
}

export const emptyLimits = (): LimitsDoc => ({ schema: LIMITS_SCHEMA, global: {}, modes: {}, strategies: {}, accounts: {} });

// ───────────────────────────── validation ─────────────────────────────

export interface LimitIssue { path: string; msg: string }
const SCOPE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const DOC_KEYS = new Set(['schema', 'global', 'modes', 'strategies', 'accounts', 'updatedAt', 'migratedFrom']);

function validateSet(x: unknown, path: string, allowNull: boolean, out: LimitIssue[]): void {
  if (!x || typeof x !== 'object' || Array.isArray(x)) { out.push({ path, msg: 'must be an object of limits' }); return; }
  for (const [k, v] of Object.entries(x)) {
    const f = FIELD.get(k);
    const p = `${path}/${k}`;
    if (!f) { out.push({ path: p, msg: `unknown limit "${k}" (known: ${LIMIT_KEYS.join(', ')})` }); continue; }
    if (v === null) { if (!allowNull) out.push({ path: p, msg: `${k}: null (off) is only allowed in global; remove the key to leave it unset here` }); continue; }
    if (typeof v !== 'number' || !Number.isFinite(v)) { out.push({ path: p, msg: `${k} must be a number (${f.unit})` }); continue; }
    if (v < f.lo || v > f.hi) { out.push({ path: p, msg: `${k} must be from ${f.lo} to ${f.hi} ${f.unit}` }); continue; }
    if (f.int && !Number.isInteger(v)) out.push({ path: p, msg: `${k} must be a whole number` });
  }
}

/** Every problem with a limits document, each naming the field (`/strategies/scalp/perTradeSol …`). */
export function validateLimits(x: unknown): LimitIssue[] {
  const out: LimitIssue[] = [];
  const d = x as Record<string, unknown>;
  if (!d || typeof d !== 'object' || Array.isArray(d)) return [{ path: '', msg: 'the limits file is a JSON object' }];
  if (d.schema !== LIMITS_SCHEMA) out.push({ path: '/schema', msg: `schema must be "${LIMITS_SCHEMA}"` });
  for (const k of Object.keys(d)) if (!DOC_KEYS.has(k)) out.push({ path: `/${k}`, msg: `unknown key "${k}" (scopes: global, modes, strategies, accounts)` });
  validateSet(d.global ?? {}, '/global', true, out);
  const modes = (d.modes ?? {}) as Record<string, unknown>;
  if (typeof modes !== 'object' || Array.isArray(modes)) out.push({ path: '/modes', msg: 'modes is an object with real and/or paper' });
  else for (const [m, v] of Object.entries(modes)) { if (m !== 'real' && m !== 'paper') out.push({ path: `/modes/${m}`, msg: `unknown mode "${m}" (real or paper)` }); else validateSet(v, `/modes/${m}`, false, out); }
  for (const scope of ['strategies', 'accounts'] as const) {
    const m = (d[scope] ?? {}) as Record<string, unknown>;
    if (typeof m !== 'object' || Array.isArray(m)) { out.push({ path: `/${scope}`, msg: `${scope} is an object keyed by id` }); continue; }
    for (const [id, v] of Object.entries(m)) { if (!SCOPE_ID.test(id)) out.push({ path: `/${scope}/${id}`, msg: `"${id}" is not a valid id` }); else validateSet(v, `/${scope}/${id}`, false, out); }
  }
  if (!out.length) out.push(...crossCheck(d as unknown as LimitsDoc));
  return out;
}

/** Rules across fields, on the effective numbers of every scope combination the file names. */
function crossCheck(d: LimitsDoc): LimitIssue[] {
  const out: LimitIssue[] = [];
  const g = { ...DEFAULT_LIMITS, ...d.global };
  if (num(g.perTradeSol) !== null && num(g.dailySol) !== null && g.dailySol! < g.perTradeSol!) out.push({ path: '/global/dailySol', msg: `dailySol (${g.dailySol}) must be at least perTradeSol (${g.perTradeSol})` });
  if (num(g.minPositionSol) !== null && num(g.perTradeSol) !== null && g.minPositionSol! > g.perTradeSol!) out.push({ path: '/global/minPositionSol', msg: `minPositionSol (${g.minPositionSol}) is above perTradeSol (${g.perTradeSol}): every buy would be refused` });
  return out;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Normalize a valid document (drop empty scopes, sort keys) so its hash is stable. */
export function normalizeLimits(d: LimitsDoc): LimitsDoc {
  const set = (s: LimitSet | undefined): LimitSet => Object.fromEntries(LIMIT_KEYS.filter((k) => s && k in s).map((k) => [k, s![k]])) as LimitSet;
  const map = (m: Record<string, LimitSet>) => Object.fromEntries(Object.keys(m ?? {}).sort().map((id) => [id, set(m[id])]).filter(([, s]) => Object.keys(s as LimitSet).length));
  const modes: LimitsDoc['modes'] = {};
  if (d.modes?.real) modes.real = set(d.modes.real);
  if (d.modes?.paper) modes.paper = set(d.modes.paper); // an empty paper scope still means "apply to paper"
  return { schema: LIMITS_SCHEMA, global: set(d.global), modes, strategies: map(d.strategies), accounts: map(d.accounts), ...(d.migratedFrom ? { migratedFrom: d.migratedFrom } : {}) };
}

export const limitsHash = (d: LimitsDoc): string => createHash('sha256').update(JSON.stringify({ ...normalizeLimits(d), migratedFrom: undefined })).digest('hex').slice(0, 16);

// ───────────────────────────── effective limits ─────────────────────────────

export interface LimitsContext { strategyId: string; accountId: string; mode: 'real' | 'paper' }

export interface EffectiveLimits {
  /** Only the limits that are on. */
  values: Partial<Record<LimitKey, number>>;
  /** Where each value came from: default | global | modes.real | strategies.<id> | accounts.<id>. */
  from: Partial<Record<LimitKey, string>>;
  /** False for a paper run when the file has no modes.paper scope (paper ignores limits then). */
  applies: boolean;
}

const stricter = (k: LimitKey, a: number, b: number): number => (FIELD.get(k)!.dir === 'max' ? Math.min(a, b) : Math.max(a, b));

export function effectiveLimits(doc: LimitsDoc | null, c: LimitsContext): EffectiveLimits {
  const d = doc ?? emptyLimits();
  if (c.mode === 'paper' && !d.modes.paper) return { values: {}, from: {}, applies: false };
  const values: EffectiveLimits['values'] = {};
  const from: EffectiveLimits['from'] = {};
  for (const k of LIMIT_KEYS) {
    if (k in (d.global ?? {})) { const v = d.global[k]; if (v !== null && v !== undefined) { values[k] = v; from[k] = 'global'; } }
    else if (DEFAULT_LIMITS[k] !== undefined) { values[k] = DEFAULT_LIMITS[k]!; from[k] = 'default'; }
  }
  const layers: [string, LimitSet | undefined][] = [[`modes.${c.mode}`, d.modes[c.mode]], [`strategies.${c.strategyId}`, d.strategies[c.strategyId]], [`accounts.${c.accountId}`, d.accounts[c.accountId]]];
  for (const [name, s] of layers) {
    if (!s) continue;
    for (const k of LIMIT_KEYS) {
      const v = s[k];
      if (typeof v !== 'number') continue;
      const cur = values[k];
      const next = cur === undefined ? v : stricter(k, cur, v);
      if (next !== cur) { values[k] = next; from[k] = name; }
    }
  }
  return { values, from, applies: true };
}

/** The stricter of two effective sets, limit by limit (a run: what it started with vs the file now). */
export function strictestOf(a: EffectiveLimits['values'], b: EffectiveLimits['values']): EffectiveLimits['values'] {
  const out: EffectiveLimits['values'] = {};
  for (const k of LIMIT_KEYS) {
    const x = a[k]; const y = b[k];
    if (x === undefined && y === undefined) continue;
    out[k] = x === undefined ? y : y === undefined ? x : stricter(k, x, y);
  }
  return out;
}

// ───────────────────────────── diff: what raises, what lowers ─────────────────────────────

/** `key: 'scope'` = a whole scope appeared or went (only modes.paper means something on its own). */
export interface LimitChange { scope: string; key: LimitKey | 'scope'; from: number | null; to: number | null; kind: 'raise' | 'lower' }

/** A scope's value as a strictness-comparable number: unset = no limit (+inf for a cap, -inf for a floor). */
function asBound(k: LimitKey, v: number | null | undefined): number {
  if (typeof v === 'number') return v;
  return FIELD.get(k)!.dir === 'max' ? Infinity : -Infinity;
}

/** Every changed number, scope by scope; `raise` = laxer (needs the typed confirmation), `lower` = stricter. */
export function diffLimits(before: LimitsDoc | null, afterIn: LimitsDoc): LimitChange[] {
  const b = before ? normalizeLimits(before) : emptyLimits();
  const after = normalizeLimits(afterIn);
  const out: LimitChange[] = [];
  const cmp = (scope: string, x: LimitSet | undefined, y: LimitSet | undefined, isGlobal: boolean) => {
    for (const k of LIMIT_KEYS) {
      // In global an absent number means the placeholder default.
      const fx = isGlobal && !(x && k in x) ? (DEFAULT_LIMITS[k] ?? undefined) : x?.[k];
      const fy = isGlobal && !(y && k in y) ? (DEFAULT_LIMITS[k] ?? undefined) : y?.[k];
      const bx = asBound(k, fx); const by = asBound(k, fy);
      if (bx === by) continue;
      const laxer = FIELD.get(k)!.dir === 'max' ? by > bx : by < bx;
      out.push({ scope, key: k, from: fx ?? null, to: fy ?? null, kind: laxer ? 'raise' : 'lower' });
    }
  };
  cmp('global', b.global, after.global, true);
  // A paper scope appearing makes paper runs obey limits (stricter); removing it frees them (a raise).
  if (!!b.modes.paper !== !!after.modes.paper) out.push({ scope: 'modes.paper', key: 'scope', from: null, to: null, kind: after.modes.paper ? 'lower' : 'raise' });
  for (const m of ['real', 'paper'] as const) cmp(`modes.${m}`, b.modes[m], after.modes[m], false);
  for (const scope of ['strategies', 'accounts'] as const) {
    for (const id of new Set([...Object.keys(b[scope]), ...Object.keys(after[scope])])) cmp(`${scope}.${id}`, b[scope][id], after[scope][id], false);
  }
  return out;
}

export const raises = (c: LimitChange[]): LimitChange[] => c.filter((x) => x.kind === 'raise');

export function changeLine(c: LimitChange): string {
  if (c.key === 'scope') return c.kind === 'raise' ? 'RAISE modes.paper removed: paper runs stop obeying the limits' : 'lower modes.paper added: paper runs obey the limits too';
  const f = FIELD.get(c.key)!;
  const v = (x: number | null) => (x === null ? 'off' : `${x} ${f.unit}`);
  return `${c.kind === 'raise' ? 'RAISE' : 'lower'} ${c.scope}.${c.key}: ${v(c.from)} -> ${v(c.to)}`;
}

// ───────────────────────────── the file ─────────────────────────────

export interface LimitsJournalLine { t: number; action: string; by: 'local-terminal' | 'runner' | 'cli'; data: Record<string, unknown> }

function journal(home: string, line: LimitsJournalLine): void {
  mkdirSync(realDir(home), { recursive: true, mode: 0o700 });
  appendFileSync(journalPath(home), `${JSON.stringify(line)}\n`, { mode: 0o600 });
}

/** The last limits document dexterm saved itself (from the journal), with its hash. */
/**
 * card A's last journaled `signal caps set` (a `caps-set` line with `after` = the four caps and no hash), or null.
 * Card A wrote caps.json only through that command, so a genuine caps.json always matches it.
 */
function lastCardACaps(home: string): LimitSet | null {
  if (!existsSync(journalPath(home))) return null;
  const lines = readFileSync(journalPath(home), 'utf8').split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const l = JSON.parse(lines[i]) as LimitsJournalLine;
      if (l.action !== 'caps-set' || typeof l.data.hash === 'string') continue;
      const a = l.data.after as Record<string, unknown> | undefined;
      if (!a) return null;
      const s: LimitSet = {};
      for (const k of ['perTradeSol', 'dailySol', 'buysPerDay', 'maxOpenPositions'] as const) if (typeof a[k] === 'number') s[k] = a[k] as number;
      return Object.keys(s).length === 4 ? s : null;
    } catch { /* torn line */ }
  }
  return null;
}

function lastJournaled(home: string): { hash: string; doc: LimitsDoc | null } | null {
  if (!existsSync(journalPath(home))) return null;
  const lines = readFileSync(journalPath(home), 'utf8').split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const l = JSON.parse(lines[i]) as LimitsJournalLine;
      if (['limits-set', 'limits-accept', 'limits-reset', 'limits-migrated', 'caps-set'].includes(l.action) && typeof l.data.hash === 'string') return { hash: l.data.hash, doc: (l.data.after as LimitsDoc | undefined) ?? null };
    } catch { /* torn line */ }
  }
  return null;
}

export type LimitsLoad =
  | { ok: true; doc: LimitsDoc; source: 'file' | 'migrated'; hash: string; journaled: boolean; unjournaled: LimitChange[] | null }
  | { ok: false; why: string; missing?: boolean; issues?: LimitIssue[] };

/** card A's caps.json, if that is all there is. */
function legacyCaps(home: string): LimitSet | null {
  try {
    const d = JSON.parse(readFileSync(legacyCapsPath(home), 'utf8')) as { schema?: string; caps?: Record<string, unknown> };
    if (d.schema !== 'dexterm-real-caps/1' || !d.caps) return null;
    const s: LimitSet = {};
    for (const k of ['perTradeSol', 'dailySol', 'buysPerDay', 'maxOpenPositions'] as const) if (typeof d.caps[k] === 'number') s[k] = d.caps[k] as number;
    return Object.keys(s).length === 4 ? s : null;
  } catch { return null; }
}

/**
 * The limits file. Missing: card A's caps.json is migrated (read as `global`; written on the next save), else
 * { missing }. Invalid or unreadable: not ok, and a real run refuses to start (fail closed). `unjournaled` lists how
 * the file differs from dexterm's last journaled save when it does (null when it matches).
 */
export function loadLimits(home: string): LimitsLoad {
  const p = limitsPath(home);
  if (!existsSync(p)) {
    const caps = legacyCaps(home);
    if (!caps) return { ok: false, missing: true, why: 'no real-mode limits are set yet: arming asks for your numbers (dexterm autotrade signal arm <id>), or dexterm autotrade limits set …' };
    // task-1654 r3 (verify F3): card A's caps.json is a migration only when it equals card A's own journaled caps
    // and no limits save exists; anything else is an outside edit, measured from the integrity baseline.
    return integrityOf(home, { ...emptyLimits(), global: caps, migratedFrom: 'caps.json' }, 'migrated');
  }
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(p, 'utf8')); } catch (e) { return { ok: false, why: `${p} is unreadable (${(e as Error).message.slice(0, 60)}): real buys stay refused until it is fixed` }; }
  const issues = validateLimits(raw);
  if (issues.length) return { ok: false, issues, why: `limits: ${issues.slice(0, 3).map((i) => `${i.path} ${i.msg}`).join('; ')}` };
  return integrityOf(home, normalizeLimits(raw as LimitsDoc), 'file');
}

/**
 * task-1654 r4 (verify F4): the ONE integrity baseline. What loadLimits measures an outside edit from AND what every
 * save is planned and checked against (planLimitsSave / saveLimits), so the diff a user confirms is always the diff
 * the real run's check measures:
 *   dexterm's last hashed limits save
 *   else card A's own last journaled caps (`signal caps set`, as `global`)
 *   else null: the placeholder defaults.
 * Never the file itself: a file nobody journaled is an outside edit until it is saved or accepted.
 */
function integrityBaseline(home: string): { doc: LimitsDoc | null; hash: string | null } {
  const last = lastJournaled(home);
  if (last) return { doc: last.doc, hash: last.hash };
  const a = lastCardACaps(home);
  return { doc: a ? { ...emptyLimits(), global: a } : null, hash: null };
}

function integrityOf(home: string, doc: LimitsDoc, source: 'file' | 'migrated'): LimitsLoad {
  const hash = limitsHash(doc);
  const base = integrityBaseline(home);
  if (base.hash !== null && base.hash === hash) return { ok: true, doc, source, hash, journaled: true, unjournaled: null };
  const changes = diffLimits(base.doc, doc);
  // Against a hashed save, any other hash is unjournaled (its changes may be empty); otherwise no change = journaled.
  const journaled = base.hash === null && !changes.length;
  return { ok: true, doc, source, hash, journaled, unjournaled: journaled ? null : changes };
}

/** mtime of the file, to re-read it only when it changed. */
export function limitsStamp(home: string): number { try { return statSync(limitsPath(home)).mtimeMs; } catch { return 0; } }

/** What a save of `next` would change, against the SAME baseline saveLimits uses (shown and confirmed before a save). */
export interface LimitsPlan {
  /** The integrity baseline: dexterm's last hashed save, else card A's journaled caps, else null (the placeholders). Never the file. */
  before: LimitsDoc | null;
  /** The baseline's hash ('none' without one): a save refuses when it moved between the plan and the save. */
  baseline: string;
  changes: LimitChange[];
  /** `scope.key` of every raise in `changes`: the typed confirmation must cover exactly these. */
  raised: string[];
}

function baselineOf(home: string): LimitsDoc | null {
  return integrityBaseline(home).doc;
}

const raiseKey = (c: LimitChange) => `${c.scope}.${c.key}`;

/**
 * task-1654 r2 (verify F1): the diff a save would make. Any unjournaled hand edit in the file shows up here too (it
 * is measured from the last journaled save, not from the file), so a lowering `set` on top of a hand-edit raise is a
 * raise, and the typed confirmation covers every line shown, never only the line the user typed.
 */
export function planLimitsSave(home: string, next: LimitsDoc): LimitsPlan {
  const before = baselineOf(home);
  const changes = diffLimits(before, normalizeLimits(next));
  return { before, baseline: before ? limitsHash(before) : 'none', changes, raised: raises(changes).map(raiseKey) };
}

/**
 * Save a new limits document. Every raise needs confirming: `confirmed` is the list of raises (`scope.key`, from
 * planLimitsSave) the user confirmed with the typed phrase on a real terminal; there is no "confirm everything"
 * (task-1654 r3, verify F2: a phrase confirms only the lines shown). Lowering needs nothing. With `baseline`, the save
 * refuses when dexterm's last save changed since the plan. Journaled with the document and its hash.
 */
export function saveLimits(home: string, next: LimitsDoc, o: { confirmed: readonly string[]; baseline?: string; action?: 'limits-set' | 'limits-reset' | 'limits-accept' | 'caps-set'; now?: number; by?: LimitsJournalLine['by'] }): { ok: true; changes: LimitChange[]; hash: string } | { ok: false; why: string; issues?: LimitIssue[]; changes?: LimitChange[] } {
  const issues = validateLimits(next);
  if (issues.length) return { ok: false, issues, why: issues.map((i) => `${i.path}: ${i.msg}`).join('; ') };
  const doc = normalizeLimits(next);
  const before = baselineOf(home);
  if (o.baseline !== undefined && o.baseline !== (before ? limitsHash(before) : 'none')) return { ok: false, why: 'the limits changed while you were confirming (another save): nothing saved; run the command again' };
  const changes = diffLimits(before, doc);
  const up = raises(changes);
  const unconfirmed = up.filter((c) => !o.confirmed.includes(raiseKey(c)));
  if (unconfirmed.length) return { ok: false, changes, why: `raising ${unconfirmed.map(raiseKey).join(', ')} needs the typed confirmation on a real terminal` };
  const now = o.now ?? Date.now();
  mkdirSync(realDir(home), { recursive: true, mode: 0o700 });
  writeJsonAtomic(limitsPath(home), { ...doc, updatedAt: now });
  const hash = limitsHash(doc);
  journal(home, { t: now, action: o.action ?? 'limits-set', by: o.by ?? 'local-terminal', data: { hash, before, after: doc, raised: up.map((c) => `${c.scope}.${c.key}`), changes: changes.map(changeLine) } });
  return { ok: true, changes, hash };
}

/**
 * A file that differs from the last journaled save: lower-only edits are accepted (journaled `limits-accept`, by the
 * runner); one that raises anything is refused until `dexterm autotrade limits accept` (typed).
 */
export function limitsForRealRun(home: string, now = Date.now()): { ok: true; doc: LimitsDoc; hash: string } | { ok: false; why: string } {
  const l = loadLimits(home);
  if (!l.ok) return { ok: false, why: l.why };
  if (l.unjournaled) {
    const up = raises(l.unjournaled);
    if (up.length) return { ok: false, why: `${l.source === 'migrated' ? 'limits.json is missing and caps.json' : 'limits.json'} was changed outside dexterm and RAISES ${up.map((c) => `${c.scope}.${c.key}`).join(', ')}: review it (dexterm autotrade limits diff) and accept it on your own terminal (dexterm autotrade limits accept)` };
    journal(home, { t: now, action: 'limits-accept', by: 'runner', data: { hash: l.hash, after: l.doc, changes: l.unjournaled.map(changeLine), why: 'lower-only edit outside dexterm' } });
  }
  return { ok: true, doc: l.doc, hash: l.hash };
}

/** Parse `perTradeSol=0.5` / `per-trade-sol=0.5` / `dailyLossSol=off`. */
export function parseLimitAssignment(s: string): { key: LimitKey; value: number | null } | { error: string } {
  const m = /^([A-Za-z-]+)=(.+)$/.exec(s.trim());
  if (!m) return { error: `"${s}" is not name=value` };
  const camel = m[1].replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
  const f = FIELD.get(camel);
  if (!f) return { error: `unknown limit "${m[1]}" (dexterm autotrade limits show --all lists them)` };
  if (m[2] === 'off' || m[2] === 'null') return { key: f.key as LimitKey, value: null };
  const v = Number(m[2]);
  if (!Number.isFinite(v)) return { error: `${f.key}: "${m[2]}" is not a number` };
  return { key: f.key as LimitKey, value: v };
}

/** Where a scope lives in the document (`global`, `real`/`paper`, `strategy:<id>`, `account:<id>`). */
export function scopeRef(doc: LimitsDoc, scope: string, create: boolean): { set: LimitSet | undefined; name: string; isGlobal: boolean } | { error: string } {
  if (scope === 'global') return { set: doc.global, name: 'global', isGlobal: true };
  if (scope === 'real' || scope === 'paper') { if (create) doc.modes[scope] ??= {}; return { set: doc.modes[scope], name: `modes.${scope}`, isGlobal: false }; }
  const m = /^(strategy|account):(.+)$/.exec(scope);
  if (!m || !SCOPE_ID.test(m[2])) return { error: `scope "${scope}": global, real, paper, strategy:<id> or account:<id>` };
  const key = m[1] === 'strategy' ? 'strategies' : 'accounts';
  if (create) doc[key][m[2]] ??= {};
  return { set: doc[key][m[2]], name: `${key}.${m[2]}`, isGlobal: false };
}

// ───────────────────────────── the guard at signal time ─────────────────────────────

export interface RiskState {
  schema: typeof RISK_STATE_SCHEMA;
  day: string;
  buys: number;
  buySol: number;
  perCoin: Record<string, { buys: number; sol: number }>;
  /** Realized PnL today / since the start, in SOL (dexterm's modelled fills, the paper view of each signal). */
  dayPnlSol: number;
  cumPnlSol: number;
  peakCumPnlSol: number;
  lossStreak: number;
  pausedUntil: number | null;
  breaker: { at: number; drawdownSol: number } | null;
  /** Times of recent buy / sell signals (the rate limits; last 60 s kept). */
  recentBuys: number[];
  recentSells: number[];
}

export function freshRiskState(day: string): RiskState {
  return { schema: RISK_STATE_SCHEMA, day, buys: 0, buySol: 0, perCoin: {}, dayPnlSol: 0, cumPnlSol: 0, peakCumPnlSol: 0, lossStreak: 0, pausedUntil: null, breaker: null, recentBuys: [], recentSells: [] };
}

/** The persisted guard state, rolled to today (day counters reset; PnL peak, streak and breaker carry). */
export function loadRiskState(home: string, now: number): RiskState {
  const today = localDay(now);
  let s: RiskState | null = null;
  try { const d = JSON.parse(readFileSync(riskStatePath(home), 'utf8')) as RiskState; if (d.schema === RISK_STATE_SCHEMA) s = d; } catch { /* none yet */ }
  if (!s) {
    s = freshRiskState(today);
    // card A kept the day's buys in day.json: carry them over once.
    try { const d = JSON.parse(readFileSync(legacyDayPath(home), 'utf8')) as { day?: string; buySol?: number; buys?: number }; if (d.day === today) { s.buys = Number(d.buys) || 0; s.buySol = Number(d.buySol) || 0; } } catch { /* none */ }
  }
  if (s.day !== today) s = { ...s, day: today, buys: 0, buySol: 0, perCoin: {}, dayPnlSol: 0 };
  s.recentBuys = (s.recentBuys ?? []).filter((t) => now - t < 60_000);
  s.recentSells = (s.recentSells ?? []).filter((t) => now - t < 60_000);
  return s;
}

export function saveRiskState(home: string, s: RiskState): void {
  mkdirSync(realDir(home), { recursive: true, mode: 0o700 });
  writeJsonAtomic(riskStatePath(home), s);
}

export interface BuyContext {
  now: number;
  solUsd: number;
  /** What the strategy asked for (after its own clamp). */
  usd: number;
  /** The strategy's book equity (USD); the percent limits use bookSol instead when it is set. */
  bookUsd: number;
  mint: string;
  liqUsd: number | null;
  mcapUsd: number | null;
  /** The cost (USD) still open on this mint for this strategy (adds), and on every real position together. */
  positionCostUsd: number;
  openCostUsd: number;
}

export type BuyVerdict = { ok: true; usd: number; clamps: string[]; impactPct: number | null } | { ok: false; refused: string; detail: string };

const r6 = (v: number) => Math.round(v * 1e6) / 1e6;

/** Why new buys are paused right now (loss limits, the breaker, the streak pause), or null. */
export function buyPause(L: EffectiveLimits['values'], s: RiskState, now: number): { refused: string; detail: string } | null {
  if (s.breaker) return { refused: 'real-drawdown-breaker', detail: `the drawdown breaker tripped (${s.breaker.drawdownSol} SOL below the peak): dexterm autotrade limits breaker reset, on your own terminal` };
  if (L.dailyLossSol !== undefined && -s.dayPnlSol >= L.dailyLossSol - 1e-12) return { refused: 'real-daily-loss', detail: `today's realized loss ${r6(-s.dayPnlSol)} SOL reached dailyLossSol ${L.dailyLossSol}: new buys resume tomorrow` };
  if (s.pausedUntil && now < s.pausedUntil) return { refused: 'real-loss-streak', detail: `${L.lossStreak ?? '?'} losing closes in a row: new buys paused until ${new Date(s.pausedUntil).toISOString().slice(11, 16)} UTC` };
  return null;
}

/**
 * Every buy limit at the moment of the signal: the pauses, the counters, the floors, then the size clamps (per
 * trade SOL/%, position, exposure, price impact) and the refusals (daily SOL, per coin, minimum). Pure: the caller
 * persists with recordBuy. Open-position count and held-elsewhere stay in the executor (they need the holdings).
 */
export function checkBuy(L: EffectiveLimits['values'], s: RiskState, c: BuyContext): BuyVerdict {
  const no = (refused: string, detail: string): BuyVerdict => ({ ok: false, refused, detail });
  const p = buyPause(L, s, c.now);
  if (p) return no(p.refused, p.detail);
  if (L.buysPerDay !== undefined && s.buys >= L.buysPerDay) return no('real-buys-per-day', `${s.buys} buys today, buysPerDay ${L.buysPerDay}`);
  if (L.maxBuysPerMinute !== undefined && s.recentBuys.filter((t) => c.now - t < 60_000).length >= L.maxBuysPerMinute) return no('real-rate-limit', `maxBuysPerMinute ${L.maxBuysPerMinute}`);
  const coin = s.perCoin[c.mint] ?? { buys: 0, sol: 0 };
  if (L.perCoinBuysPerDay !== undefined && coin.buys >= L.perCoinBuysPerDay) return no('real-per-coin-buys', `${coin.buys} buys on this coin today, perCoinBuysPerDay ${L.perCoinBuysPerDay}`);
  if (L.minLiquidityUsd !== undefined) { if (c.liqUsd === null || !Number.isFinite(c.liqUsd)) return no('real-liquidity-unknown', 'minLiquidityUsd is set and the pool liquidity is unknown'); if (c.liqUsd < L.minLiquidityUsd) return no('real-min-liquidity', `liquidity $${Math.round(c.liqUsd)} < minLiquidityUsd ${L.minLiquidityUsd}`); }
  if (L.minMcapUsd !== undefined) { if (c.mcapUsd === null || !Number.isFinite(c.mcapUsd)) return no('real-mcap-unknown', 'minMcapUsd is set and the market cap is unknown'); if (c.mcapUsd < L.minMcapUsd) return no('real-min-mcap', `mcap $${Math.round(c.mcapUsd)} < minMcapUsd ${L.minMcapUsd}`); }
  const clamps: string[] = [];
  let usd = c.usd;
  const clamp = (cap: number, rule: string) => { if (usd > cap + 1e-9) { usd = Math.max(0, cap); clamps.push(rule); } };
  const bookUsd = L.bookSol !== undefined ? L.bookSol * c.solUsd : c.bookUsd;
  if (L.perTradeSol !== undefined) clamp(L.perTradeSol * c.solUsd, 'perTradeSol');
  if (L.perTradePct !== undefined) clamp((L.perTradePct / 100) * bookUsd, 'perTradePct');
  if (L.maxPositionSol !== undefined) clamp(L.maxPositionSol * c.solUsd - c.positionCostUsd, 'maxPositionSol');
  if (L.maxExposurePct !== undefined) clamp((L.maxExposurePct / 100) * bookUsd - c.openCostUsd, 'maxExposurePct');
  let impactPct: number | null = null;
  if (L.maxPriceImpactPct !== undefined) {
    if (c.liqUsd === null || !(c.liqUsd > 0)) return no('real-impact-unknown', 'maxPriceImpactPct is set and the pool liquidity is unknown');
    // The engine's constant-product model: the quote side is half the pool's liquidity and the impact is size / side.
    const side = c.liqUsd / 2;
    clamp((L.maxPriceImpactPct / 100) * side, 'maxPriceImpactPct');
    impactPct = Math.round((usd / side) * 10_000) / 100;
  }
  if (!(usd > 1e-9)) return no(clamps.includes('maxExposurePct') ? 'real-max-exposure' : clamps.includes('maxPositionSol') ? 'real-max-position' : 'real-size-zero', `nothing left under ${clamps.join(', ') || 'the limits'}`);
  const sol = usd / c.solUsd;
  if (L.dailySol !== undefined && s.buySol + sol > L.dailySol + 1e-9) return no('real-daily-cap', `${r6(s.buySol)} + ${r6(sol)} SOL > dailySol ${L.dailySol}`);
  if (L.perCoinSolPerDay !== undefined && coin.sol + sol > L.perCoinSolPerDay + 1e-9) return no('real-per-coin-sol', `${r6(coin.sol)} + ${r6(sol)} SOL on this coin > perCoinSolPerDay ${L.perCoinSolPerDay}`);
  if (L.minPositionSol !== undefined && sol < L.minPositionSol - 1e-12) return no('real-below-min-position', `${r6(sol)} SOL < minPositionSol ${L.minPositionSol}`);
  return { ok: true, usd, clamps, impactPct };
}

export function recordBuy(s: RiskState, mint: string, sol: number, now: number): void {
  s.buys += 1; s.buySol = r6(s.buySol + sol);
  const coin = s.perCoin[mint] ?? { buys: 0, sol: 0 };
  s.perCoin[mint] = { buys: coin.buys + 1, sol: r6(coin.sol + sol) };
  s.recentBuys.push(now);
}

/** A sell may wait only for the optional sell rate (sells are never capped otherwise). */
export function checkSell(L: EffectiveLimits['values'], s: RiskState, now: number): { ok: true } | { ok: false; refused: string; detail: string } {
  if (L.maxSellsPerMinute !== undefined && s.recentSells.filter((t) => now - t < 60_000).length >= L.maxSellsPerMinute) return { ok: false, refused: 'real-sell-rate', detail: `maxSellsPerMinute ${L.maxSellsPerMinute}: the sell waits for the next tick` };
  return { ok: true };
}

/**
 * A sell's realized PnL (SOL) into the day, the running total, the loss streak (on a full close) and the drawdown
 * breaker. Returns what tripped, for the notification.
 */
export function recordSell(L: EffectiveLimits['values'], s: RiskState, o: { pnlSol: number; closedPnlSol: number | null; now: number }): string[] {
  const tripped: string[] = [];
  s.recentSells.push(o.now);
  const wasDayLoss = L.dailyLossSol !== undefined && -s.dayPnlSol >= L.dailyLossSol;
  s.dayPnlSol = r6(s.dayPnlSol + o.pnlSol);
  s.cumPnlSol = r6(s.cumPnlSol + o.pnlSol);
  s.peakCumPnlSol = Math.max(s.peakCumPnlSol, s.cumPnlSol);
  if (!wasDayLoss && L.dailyLossSol !== undefined && -s.dayPnlSol >= L.dailyLossSol) tripped.push(`daily loss limit reached (${r6(-s.dayPnlSol)} SOL): no new buy until tomorrow`);
  if (o.closedPnlSol !== null) {
    s.lossStreak = o.closedPnlSol < 0 ? s.lossStreak + 1 : 0;
    if (L.lossStreak !== undefined && s.lossStreak >= L.lossStreak) {
      const min = L.lossStreakPauseMin ?? 60;
      s.pausedUntil = o.now + min * 60_000; s.lossStreak = 0;
      tripped.push(`${L.lossStreak} losing closes in a row: new buys paused ${min} min`);
    }
  }
  const dd = r6(s.peakCumPnlSol - s.cumPnlSol);
  if (!s.breaker && L.maxDrawdownSol !== undefined && dd >= L.maxDrawdownSol) { s.breaker = { at: o.now, drawdownSol: dd }; tripped.push(`drawdown breaker tripped (${dd} SOL below the peak): new buys stop until you reset it`); }
  return tripped;
}

/** `dexterm autotrade limits breaker reset` (typed): the breaker off, the peak moved to now. Journaled. */
export function resetBreaker(home: string, o: { confirmed: boolean; now?: number }): { ok: true; was: RiskState['breaker'] } | { ok: false; why: string } {
  if (!o.confirmed) return { ok: false, why: 'resetting the drawdown breaker needs the typed confirmation on a real terminal' };
  const now = o.now ?? Date.now();
  const s = loadRiskState(home, now);
  const was = s.breaker;
  s.breaker = null; s.peakCumPnlSol = s.cumPnlSol; s.pausedUntil = null; s.lossStreak = 0;
  saveRiskState(home, s);
  journal(home, { t: now, action: 'breaker-reset', by: 'local-terminal', data: { was } });
  return { ok: true, was };
}

// ───────────────────────────── presenting them ─────────────────────────────

export function fmtLimit(k: LimitKey, v: number | undefined | null): string {
  if (v === undefined || v === null) return 'off';
  return `${v} ${FIELD.get(k)!.unit}`;
}

/** Lines for `limits show` / the arming panel / the Q screen: effective value + where it came from. */
export function limitsLines(e: EffectiveLimits, o: { all?: boolean } = {}): string[] {
  const out: string[] = [];
  for (const g of ['sizing', 'risk', 'sells', 'executor'] as const) {
    const rows = LIMIT_FIELDS.filter((f) => f.group === g && (o.all || e.values[f.key as LimitKey] !== undefined));
    if (!rows.length) continue;
    out.push(`${g}:`);
    for (const f of rows) {
      const k = f.key as LimitKey;
      out.push(`  ${k.padEnd(19)} ${fmtLimit(k, e.values[k]).padEnd(18)} ${e.from[k] ? `(${e.from[k] === 'default' ? 'placeholder default' : e.from[k]})` : ''}`.trimEnd());
    }
  }
  return out;
}

/** The one-line summary (status, run banner, Telegram). */
export function limitsSummary(v: EffectiveLimits['values']): string {
  const p: string[] = [];
  if (v.perTradeSol !== undefined) p.push(`${v.perTradeSol} SOL/trade`);
  if (v.perTradePct !== undefined) p.push(`${v.perTradePct}% of book/trade`);
  if (v.dailySol !== undefined) p.push(`${v.dailySol} SOL/day`);
  if (v.buysPerDay !== undefined) p.push(`${v.buysPerDay} buys/day`);
  if (v.maxOpenPositions !== undefined) p.push(`${v.maxOpenPositions} open`);
  if (v.dailyLossSol !== undefined) p.push(`stop at -${v.dailyLossSol} SOL/day`);
  if (v.executorSilenceMin !== undefined) p.push(`pause if the executor is silent ${v.executorSilenceMin} min`);
  return p.join(' · ') || 'no limits on';
}
