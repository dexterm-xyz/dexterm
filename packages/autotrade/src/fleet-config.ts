// dexterm autotrade — the multi-strategy config, `autotrade.json` (task-1529, parallel strategies). PAPER today.
//
// $DEXTERM_HOME/autotrade/autotrade.json, schema dexterm-autotrade/1, lists the strategies one runner process runs at
// the same time on the same live data feed. Each one is a MEMBER with its own id, its own bankroll, its own run
// ledger, caps, breaker, candidate sessions and spend budget; `global` holds the caps across all of them:
//
//   { "schema": "dexterm-autotrade/1",
//     "strategies": [
//       { "id": "moon-a", "preset": "moonbag", "bankroll": { "usd": 500 } },
//       { "id": "yolo",   "preset": "my-yolo", "bankroll": { "sol": 1 }, "caps": { "modelUsdPerDay": 2, "maxSessions": 1 } },
//       { "id": "dip",    "file": "/abs/path/dip.json", "bankroll": { "usd": 200 }, "enabled": false } ],
//     "global": { "maxConcurrentSessions": 3, "modelUsdPerDay": 15, "candidateSessionsPerDay": 60 } }
//
// `preset` names a shipped preset or one of the user's own strategies (~/.dexterm/strategies); `file` is an absolute
// path to a strategy file. Member caps can only TIGHTEN: the stricter of the strategy, the member caps, runner.json
// and the global caps applies, so a shared config can never loosen a strategy. `mode` is "paper" (the default);
// "live" is refused (task-1571: dexterm holds no key and places no live order).
//
// Paper ACCOUNTS (task-1538): `accounts` lists shared simulated wallets, and a strategy with `account` trades from
// that wallet's cash instead of its own bankroll, next to every other strategy on it (paper-accounts.ts). One strategy
// is not tied to one account: `"account": ["main", "yolo"]` runs it once per account, as members `<id>-main` and
// `<id>-yolo` (each its own run, ledger, positions and caps):
//
//     "accounts": [ { "id": "main", "bankroll": { "usd": 1000 } }, { "id": "yolo", "bankroll": { "sol": 1 } } ],
//     "strategies": [ { "id": "moon", "preset": "moonbag", "account": "main" },
//                     { "id": "scalp", "preset": "scalp", "account": ["main", "yolo"] } ]
//
// A member on an account takes no `bankroll` of its own (the account holds the money). Accounts are paper only.
//
// The file is user data: no login, no key, no token, no wallet address (a paper account is a name and a starting
// balance). Like runner.json, it is machine-local.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validate } from '@dexterm/custom';
import { STRATEGY_ID } from './store.ts';
import { MAX_PAPER_ACCOUNTS } from './paper-accounts.ts';
import { strategyHash, type ResolvedStrategy } from './strategy.ts';

type Node = Parameters<typeof validate>[0];

export const FLEET_CONFIG_SCHEMA = 'dexterm-autotrade/1';
export const fleetConfigPath = (home: string): string => join(home, 'autotrade', 'autotrade.json');
/** How many strategies one process runs at most (each one is a book, a ledger and up to its own session cap). */
export const MAX_MEMBERS = 8;

export type Bankroll = { usd: number } | { sol: number };

export interface MemberCaps { maxSessions?: number; modelUsdPerDay?: number; candidateSessionsPerDay?: number; positionSessionsPerDay?: number; turnsPerDay?: number }

export interface MemberConfig {
  id: string;
  /** A shipped preset or a stored strategy id … */
  preset?: string;
  /** … or an absolute path to a strategy file. */
  file?: string;
  bankroll?: Bankroll;
  mode: 'paper' | 'live';
  enabled: boolean;
  caps: MemberCaps;
  /** The shared paper account this member trades from (task-1538); absent: its own bankroll. */
  account?: string;
  /** The strategy entry's own id when a list of accounts expanded it into one member per account. */
  entry?: string;
}

/** A shared paper account (task-1538): a name and a starting balance, simulated. */
export interface PaperAccountConfig { id: string; bankroll: Bankroll }

export interface GlobalCaps {
  /** Model sessions open at once across every strategy (candidate + position). */
  maxConcurrentSessions: number;
  modelUsdPerDay: number;
  candidateSessionsPerDay: number;
  positionSessionsPerDay: number;
  turnsPerDay: number;
}

export interface FleetConfig {
  schema: typeof FLEET_CONFIG_SCHEMA;
  strategies: MemberConfig[];
  global: GlobalCaps;
  /** Shared paper accounts (task-1538); absent or empty: every strategy owns its bankroll. */
  accounts?: PaperAccountConfig[];
  /** SOL in USD for `bankroll.sol` in a replay (live runs read the price at start). */
  solUsd?: number;
}

export const DEFAULT_GLOBAL_CAPS: GlobalCaps = { maxConcurrentSessions: 3, modelUsdPerDay: 20, candidateSessionsPerDay: 96, positionSessionsPerDay: 96, turnsPerDay: 4000 };

const num = (min: number, max: number, int = false): Node => ({ type: 'number', min, max, int });
const CAPS: Node = { type: 'object', additional: false, props: {
  maxSessions: num(1, 8, true), modelUsdPerDay: num(0, 10_000), candidateSessionsPerDay: num(0, 10_000, true), positionSessionsPerDay: num(0, 10_000, true), turnsPerDay: num(0, 1_000_000, true),
} };
const BANKROLL: Node = { oneOf: [
  { type: 'object', additional: false, required: ['usd'], props: { usd: num(1, 1e7) } },
  { type: 'object', additional: false, required: ['sol'], props: { sol: num(0.001, 1e5) } },
] };
const ACCOUNT_REF: Node = { oneOf: [
  { type: 'string', pattern: STRATEGY_ID.source },
  { type: 'array', max: MAX_PAPER_ACCOUNTS, items: { type: 'string', pattern: STRATEGY_ID.source } },
] };
const SCHEMA: Node = {
  type: 'object', additional: false, required: ['schema', 'strategies'],
  props: {
    schema: { type: 'string', enum: [FLEET_CONFIG_SCHEMA] },
    strategies: { type: 'array', max: MAX_MEMBERS, items: {
      type: 'object', additional: false, required: ['id'],
      props: {
        id: { type: 'string', pattern: STRATEGY_ID.source },
        preset: { type: 'string', pattern: STRATEGY_ID.source },
        file: { type: 'string', max: 500 },
        bankroll: BANKROLL,
        account: ACCOUNT_REF,
        mode: { type: 'string', enum: ['paper', 'live'] },
        enabled: { type: 'boolean' },
        caps: CAPS,
      },
    } },
    global: { type: 'object', additional: false, props: {
      maxConcurrentSessions: num(1, 32, true), modelUsdPerDay: num(0, 10_000), candidateSessionsPerDay: num(0, 10_000, true), positionSessionsPerDay: num(0, 10_000, true), turnsPerDay: num(0, 1_000_000, true),
    } },
    solUsd: num(1, 100_000),
    accounts: { type: 'array', max: MAX_PAPER_ACCOUNTS, items: {
      type: 'object', additional: false, required: ['id', 'bankroll'],
      props: { id: { type: 'string', pattern: STRATEGY_ID.source }, bankroll: BANKROLL },
    } },
  },
};

export type FleetConfigCheck = { ok: true; config: FleetConfig; path: string } | { ok: false; errors: string[]; path: string };

export interface FleetParseOpts {
  /** True only once a live execution port for the multi-strategy runner is installed (not in this build). */
  liveAvailable?: boolean;
}

/** Validate a parsed autotrade.json and fill the defaults. */
export function parseFleetConfig(doc: unknown, path = 'autotrade.json', o: FleetParseOpts = {}): FleetConfigCheck {
  const errs = validate(SCHEMA, doc, '');
  if (errs.length) return { ok: false, errors: errs.map((e) => `${e.path || '/'} ${e.msg}`), path };
  type Entry = Omit<Partial<MemberConfig>, 'account'> & { account?: string | string[] };
  const d = doc as { strategies: Entry[]; global?: Partial<GlobalCaps>; solUsd?: number; accounts?: PaperAccountConfig[] };
  const errors: string[] = [];
  const accounts = d.accounts ?? [];
  const accountIds = new Set<string>();
  accounts.forEach((a, i) => { if (accountIds.has(a.id)) errors.push(`/accounts/${i}/id ${a.id} is used twice (every paper account needs its own id)`); accountIds.add(a.id); });
  const seen = new Set<string>();
  const strategies: MemberConfig[] = [];
  d.strategies.forEach((m, i) => {
    const at = `/strategies/${i}`;
    if (!!m.preset === !!m.file) errors.push(`${at} needs exactly one of preset or file`);
    if (m.file && !m.file.startsWith('/')) errors.push(`${at}/file must be an absolute path`);
    if (m.mode === 'live' && !o.liveAvailable) errors.push(`${at}/mode live execution is not available for parallel strategies in this build; every strategy runs on paper`);
    const refs = m.account === undefined ? [] : Array.isArray(m.account) ? m.account : [m.account];
    if (m.account !== undefined) {
      if (!refs.length) errors.push(`${at}/account lists no paper account`);
      if (new Set(refs).size !== refs.length) errors.push(`${at}/account names an account twice`);
      for (const a of refs) if (!accountIds.has(a)) errors.push(`${at}/account ${a} is not a paper account in /accounts`);
      if (m.bankroll) errors.push(`${at}/bankroll a strategy on a paper account trades from the account's balance; drop its own bankroll`);
      if (m.mode === 'live') errors.push(`${at}/account paper accounts hold simulated cash only; a live strategy cannot use one`);
    }
    const base = { ...(m.preset ? { preset: m.preset } : {}), ...(m.file ? { file: m.file } : {}), ...(m.bankroll ? { bankroll: m.bankroll } : {}), mode: m.mode ?? 'paper', enabled: m.enabled ?? true, caps: m.caps ?? {} } as const;
    // A list of accounts runs the same strategy once per account: one member each, `<id>-<account>`.
    const ids = Array.isArray(m.account) ? m.account.map((a) => ({ id: `${m.id}-${a}`, account: a })) : [{ id: m.id!, account: refs[0] }];
    for (const x of ids) {
      if (!STRATEGY_ID.test(x.id)) errors.push(`${at}/account ${x.id} (strategy id + "-" + account id) is not a valid member id (lowercase, at most 32 characters): shorten one of them`);
      if (seen.has(x.id)) errors.push(`${at}/id ${x.id} is used twice (every strategy in the list needs its own id)`);
      seen.add(x.id);
      strategies.push({ id: x.id, ...base, ...(x.account ? { account: x.account } : {}), ...(Array.isArray(m.account) ? { entry: m.id! } : {}) });
    }
  });
  if (!strategies.length) errors.push('/strategies lists no strategy');
  if (strategies.length > MAX_MEMBERS) errors.push(`/strategies ${strategies.length} strategy runs (after one per listed account); at most ${MAX_MEMBERS} run at once`);
  if (errors.length) return { ok: false, errors, path };
  return { ok: true, config: { schema: FLEET_CONFIG_SCHEMA, strategies, global: { ...DEFAULT_GLOBAL_CAPS, ...d.global }, ...(accounts.length ? { accounts: accounts.map((a) => ({ id: a.id, bankroll: a.bankroll })) } : {}), ...(d.solUsd ? { solUsd: d.solUsd } : {}) }, path };
}

export function loadFleetConfig(home: string, file?: string, o: FleetParseOpts = {}): FleetConfigCheck | { ok: false; missing: true; path: string; errors: string[] } {
  const path = file ?? fleetConfigPath(home);
  if (!existsSync(path)) return { ok: false, missing: true, path, errors: [`no ${path}: list the strategies to run at once there (dexterm autotrade run --all --help)`] };
  let doc: unknown;
  try { doc = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { return { ok: false, errors: [`not JSON: ${(e as Error).message}`], path }; }
  return parseFleetConfig(doc, path, o);
}

/**
 * A member's strategy: the resolved strategy under the member's id, with the member's bankroll, re-hashed so every
 * ledger line names the exact rules it ran (two members on one preset with different bankrolls hash differently).
 * The base strategy's id / version / hash stay in `basedOn` (the member's first ledger line).
 */
export function memberStrategy(base: ResolvedStrategy, m: MemberConfig, startUsd: number | null): { strategy: ResolvedStrategy; basedOn: { id: string; version: string; hash: string } } {
  const { hash: _h, ...rest } = base;
  const body: Omit<ResolvedStrategy, 'hash'> = { ...rest, id: m.id, bankroll: { ...base.bankroll, ...(startUsd !== null ? { startUsd } : {}), source: 'fixed' } };
  return { strategy: { ...body, hash: strategyHash(body) }, basedOn: { id: base.id, version: base.version, hash: base.hash } };
}

/** The bankroll in USD (a SOL bankroll at the given SOL price), or null when the strategy's own startUsd applies. */
export function bankrollUsd(b: Bankroll | undefined, solUsd: number | null): { usd: number | null; error?: string } {
  if (!b) return { usd: null };
  if ('usd' in b) return { usd: b.usd };
  if (!solUsd || !(solUsd > 0)) return { usd: null, error: 'a SOL bankroll needs the SOL price (live: read at start; a replay: "solUsd" in autotrade.json or --sol-usd)' };
  return { usd: Math.round(b.sol * solUsd * 100) / 100 };
}
