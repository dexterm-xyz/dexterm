// dexterm autotrade — the machine-local runner config (task-1505 AT-3, AUTOTRADE-SPEC §7.3).
//
// $DEXTERM_HOME/autotrade/runner.json, schema dexterm-runner/1. It says WHICH Claude account the sessions use and
// the runner's own day caps and allowance guard. It is user data, never part of a strategy or a pack, so a
// shared strategy can never pick an account or raise a cap. The stricter of the runner caps and the strategy
// caps applies (`effectiveCaps`).
//
// The file names how to FETCH a credential (a helper command or an OS keychain item), never the credential.
// A missing file means: the user's own default login (`native`) and the default caps below.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validate } from '@dexterm/custom';
import type { ResolvedStrategy } from './strategy.ts';

type Node = Parameters<typeof validate>[0];

export const RUNNER_CONFIG_SCHEMA = 'dexterm-runner/1';
export const runnerConfigPath = (home: string): string => join(home, 'autotrade', 'runner.json');

export const ACCOUNT_KINDS = ['native', 'oauth-token', 'config-dir', 'api-key'] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

/** Where a secret comes from: a helper command (argv, no shell) or a macOS keychain generic-password item. */
export type SecretSource = { command: string[] } | { keychain: { service: string; account?: string } };

export type AccountConfig =
  | { kind: 'native'; expectApiKeySource?: string[] }
  | { kind: 'oauth-token'; source: SecretSource; expectApiKeySource?: string[] }
  | { kind: 'config-dir'; dir: string; expectApiKeySource?: string[] }
  | { kind: 'api-key'; source: SecretSource; expectApiKeySource?: string[] };

export interface RunnerCaps { candidateSessionsPerDay: number; positionSessionsPerDay: number; modelUsdPerDay: number; turnsPerDay: number }

export interface RunnerConfig {
  schema: typeof RUNNER_CONFIG_SCHEMA;
  account: AccountConfig;
  caps: RunnerCaps;
  allowanceGuard: { fiveHourMax: number; sevenDayMax: number; onLimit: 'pause-until-reset' };
  /** Read by the always-on service's guard (AT-10); validated here so one file has one schema. */
  load?: { pauseAboveLoad1m: number; resumeBelowLoad1m: number; sustainSec: number; busyProcs: string[] };
  disk?: { minFreeGb: number };
}

/** §10 Q7 defaults. */
export const DEFAULT_RUNNER_CONFIG: RunnerConfig = {
  schema: RUNNER_CONFIG_SCHEMA,
  account: { kind: 'native' },
  caps: { candidateSessionsPerDay: 48, positionSessionsPerDay: 48, modelUsdPerDay: 20, turnsPerDay: 2000 },
  allowanceGuard: { fiveHourMax: 0.6, sevenDayMax: 0.8, onLimit: 'pause-until-reset' },
};

const num = (min: number, max: number, int = false): Node => ({ type: 'number', min, max, int });
const argv: Node = { type: 'array', max: 16, items: { type: 'string', max: 400 } };
const source: Node = { oneOf: [
  { type: 'object', additional: false, required: ['command'], props: { command: argv } },
  { type: 'object', additional: false, required: ['keychain'], props: { keychain: { type: 'object', additional: false, required: ['service'], props: { service: { type: 'string', max: 200 }, account: { type: 'string', max: 200 } } } } },
] };
const expect: Node = { type: 'array', max: 8, items: { type: 'string', max: 40 } };
const SCHEMA: Node = {
  type: 'object', additional: false, required: ['schema'],
  props: {
    schema: { type: 'string', enum: [RUNNER_CONFIG_SCHEMA] },
    account: { oneOf: [
      { type: 'object', additional: false, required: ['kind'], props: { kind: { type: 'string', enum: ['native'] }, expectApiKeySource: expect } },
      { type: 'object', additional: false, required: ['kind', 'source'], props: { kind: { type: 'string', enum: ['oauth-token'] }, source, expectApiKeySource: expect } },
      { type: 'object', additional: false, required: ['kind', 'dir'], props: { kind: { type: 'string', enum: ['config-dir'] }, dir: { type: 'string', max: 500 }, expectApiKeySource: expect } },
      { type: 'object', additional: false, required: ['kind', 'source'], props: { kind: { type: 'string', enum: ['api-key'] }, source, expectApiKeySource: expect } },
    ] },
    caps: { type: 'object', additional: false, props: {
      candidateSessionsPerDay: num(0, 10_000, true), positionSessionsPerDay: num(0, 10_000, true), modelUsdPerDay: num(0, 10_000), turnsPerDay: num(0, 1_000_000, true),
    } },
    allowanceGuard: { type: 'object', additional: false, props: {
      fiveHourMax: num(0, 1), sevenDayMax: num(0, 1), onLimit: { type: 'string', enum: ['pause-until-reset'] },
    } },
    load: { type: 'object', additional: false, props: {
      pauseAboveLoad1m: num(0, 1000), resumeBelowLoad1m: num(0, 1000), sustainSec: num(0, 86_400, true),
      busyProcs: { type: 'array', max: 32, items: { type: 'string', max: 200 } },
    } },
    disk: { type: 'object', additional: false, props: { minFreeGb: num(0, 100_000) } },
  },
};

export type RunnerConfigCheck = { ok: true; config: RunnerConfig; source: 'file' | 'default'; path: string } | { ok: false; errors: string[]; path: string };

/** Validate a parsed runner.json and fill the defaults. */
export function parseRunnerConfig(doc: unknown, path = 'runner.json'): RunnerConfigCheck {
  const errs = validate(SCHEMA, doc, '');
  if (errs.length) return { ok: false, errors: errs.map((e) => `${e.path || '/'} ${e.msg}`), path };
  const d = doc as Partial<RunnerConfig>;
  const errors: string[] = [];
  if (d.account?.kind === 'config-dir' && !d.account.dir.startsWith('/')) errors.push('/account/dir must be an absolute path');
  if (d.account && 'source' in d.account && 'command' in d.account.source && d.account.source.command.length === 0) errors.push('/account/source/command is empty');
  if (errors.length) return { ok: false, errors, path };
  const config: RunnerConfig = {
    schema: RUNNER_CONFIG_SCHEMA,
    account: d.account ?? DEFAULT_RUNNER_CONFIG.account,
    caps: { ...DEFAULT_RUNNER_CONFIG.caps, ...d.caps },
    allowanceGuard: { ...DEFAULT_RUNNER_CONFIG.allowanceGuard, ...d.allowanceGuard },
    ...(d.load ? { load: d.load } : {}),
    ...(d.disk ? { disk: d.disk } : {}),
  };
  return { ok: true, config, source: 'file', path };
}

export function loadRunnerConfig(home: string): RunnerConfigCheck {
  const path = runnerConfigPath(home);
  if (!existsSync(path)) return { ok: true, config: DEFAULT_RUNNER_CONFIG, source: 'default', path };
  let doc: unknown;
  try { doc = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { return { ok: false, errors: [`not JSON: ${(e as Error).message}`], path }; }
  return parseRunnerConfig(doc, path);
}

/** The caps a run enforces: the stricter of the runner config and the strategy. */
export interface EffectiveCaps {
  maxSessions: number;
  budgetUsdPerSession: number;
  modelUsdPerDay: number;
  candidateSessionsPerDay: number;
  positionSessionsPerDay: number;
  turnsPerDay: number;
  maxTurnsPerSession: number;
}

export function effectiveCaps(s: ResolvedStrategy, c: RunnerConfig): EffectiveCaps {
  return {
    maxSessions: s.agent.maxSessions,
    budgetUsdPerSession: s.agent.budgetUsdPerSession,
    modelUsdPerDay: Math.min(s.agent.budgetUsdPerDay, c.caps.modelUsdPerDay),
    candidateSessionsPerDay: c.caps.candidateSessionsPerDay,
    positionSessionsPerDay: c.caps.positionSessionsPerDay,
    turnsPerDay: c.caps.turnsPerDay,
    maxTurnsPerSession: s.agent.maxTurns,
  };
}
