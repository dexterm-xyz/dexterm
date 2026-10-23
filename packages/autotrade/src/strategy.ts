// dexterm autotrade — the strategy document (task-1498 spike, AUTOTRADE-SPEC §1).
//
// One declarative, versioned JSON document says everything an autotrade run may do: which coins are
// candidates (the screener filter grammar plus safety gates and triggers), how a position is exited (exit
// profiles, the challenge-kit model extended with `wake`), how much loss is allowed, how a size is picked,
// and what the per-candidate agent session may spend. The engine, the clamp, the monitor and the backtester
// all read this one document, so a backtest and a paper run of the same file make the same decisions.
//
// Validation is the zero-dependency subset validator from @dexterm/custom plus the cross-field rules a
// schema cannot say. Nothing in here can name a key, a wallet or the signer: closed objects make an attempt
// to add one a precise refusal, and `mode: "live"` validates but is refused by the runner (paper only).

import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { validate } from '@dexterm/custom';
import { parseFilter } from '../../cli/src/screener/filter.ts';

type Node = Parameters<typeof validate>[0];
type Refs = NonNullable<Parameters<typeof validate>[4]>;

export const STRATEGY_SCHEMA = 'dexterm-strategy/1';
export const EXIT_PROFILE_VERSION = '1.2.0';

// ───────────────────────────── types ─────────────────────────────

export type TimeAction = 'exit' | 'review' | 'tighten';

export interface ExitProfile {
  kind: 'exit-profile';
  id: string;
  name: string;
  version: string;
  description: string;
  fit: { summary: string; minLiquidityUsd: number; ageHours: { min: number; max: number | null }; maxTop10Pct?: number | null; signals?: string[] };
  sizing: { maxSizePctOfBankroll: number };
  tpLadder: { atPct: number; sellFrac: number }[];
  trailingStop: { armAtPct: number; trailPct: number } | null;
  timeStop: { minutes: number; ifBelowPct: number; action: TimeAction } | null;
  hardStop: { enabled: boolean; atPct: number | null; why: string };
  thesisBreak: {
    liquidityDropPct: number;
    liquidityWindowMin: number;
    mcapDivergenceX: number | null;
    devSell: { exitOnAnyDevSell: boolean; topHolderSellPctOfBag: number | null };
    volumeDeath: { m5TradesBelow: number; forMinutes: number } | null;
  };
  reentry: { allowed: boolean; cooldownMinutes: number; maxEntriesPerCoinPerSession: number; requires: string };
  carry: { allowed: boolean; requiresTpFilled: number; maxRemainderPctOfBankroll: number };
  reprofileTo: string[];
  /** 1.1.0: which judgement calls wake the position's agent session (the mechanical exits never wait for it).
   *  1.2.0: `onCostRecovered` wakes it when the cost-recovery sell filled. */
  wake?: { onTpFilled: boolean; onTimeReview: boolean; drawdownPct: number | null; thesisWarnFrac: number | null; noAnswer: 'hold' | 'exit'; onCostRecovered?: boolean };
  /** 1.2.0: once the gain reaches atPct, sell the tokens whose proceeds (after fee, slippage and impact) pay back
   *  the position's net cost, capped at maxSellFrac of what is held. Fires once; the rest is a free bag. */
  costRecovery?: { atPct: number; maxSellFrac: number } | null;
  /** 1.2.0: a trail on the bag only, armed by the cost-recovery sell (not by a gain), trailPct off the peak;
   *  with armAtPct it waits until the peak gain since entry also reached armAtPct (a free bag can sit out the dump). */
  bagTrail?: { trailPct: number; armAtPct?: number } | null;
  /** 1.1.0: dead-man for the position itself: sell everything after this long, whatever happened (null = never). */
  maxHoldMinutes?: number | null;
  notes?: string[];
}

export type SizingMode = 'fixed' | 'pct' | 'risk' | 'confidence';
export type Trigger =
  | { kind: 'screen' }
  | { kind: 'momentum'; m5MinPct: number; buySellMin: number }
  | { kind: 'narrative'; minHeat: number }
  | { kind: 'wallet'; list: 'followed'; minBuyUsd: number };

export interface Strategy {
  kind: 'strategy';
  schema: typeof STRATEGY_SCHEMA;
  id: string;
  name: string;
  version: string;
  description: string;
  /** paper is the default and the only mode the runner executes; live is designed, gated and refused here. */
  mode: 'paper' | 'live';
  /** task-1532: a HIGH RISK label (the yolo preset): the TUI, the run banner, the CLI list and Telegram say so. A label only;
   *  the clamp, the caps and the signer decide the same with or without it. */
  highRisk?: boolean;
  /** startUsd is the paper book for runs and backtests. source (1.2.0, §7.2): fixed (default) uses startUsd;
   *  desk reads the book from the paper desk on every tick in a run (backtests always use startUsd). */
  bankroll: { startUsd: number; source?: 'fixed' | 'desk' };
  entry: {
    /** The screener filter grammar, verbatim (`liq >= 30K vol1h > 15K !flag:mint`). */
    screen: string;
    ageHours: { min: number; max: number | null };
    safety: {
      maxTop10Pct: number | null;
      maxDevPct: number | null;
      requireNoMintAuthority: boolean;
      requireNoFreezeAuthority: boolean;
      maxMcapSplitX: number | null;
      /** Reject a coin younger than maxAgeHours that is already up more than maxH1Pct on the hour. */
      youngVertical: { maxAgeHours: number; maxH1Pct: number } | null;
      /** What to do when the holder source is down: reject (safe default) or allow. */
      unknownHolders: 'reject' | 'allow';
      /** task-1532: the LARP check (the `larp_check` tool's 0-100 score) before a candidate opens, on live data only:
       *  a score above maxScore is refused, and so is a check that could not run when unknown is reject. Replays and
       *  backtests have no web, so they do not evaluate it (see DATA_LIMITS). */
      larp?: { maxScore: number; unknown: 'reject' | 'allow' } | null;
    };
    triggers: Trigger[];
    triggerMode: 'any' | 'all';
    /** agent = spawn a candidate session that decides; auto = mechanical entry at the strategy size (backtests);
     *  agent+approve = the agent decides and every entry waits for a one-tap approval in chat (task-1527, §8.4). */
    decide: 'agent' | 'auto' | 'agent+approve';
    /** A candidate the session has not entered within this many seconds expires. */
    candidateTtlSec: number;
  };
  exits: { default: string; profiles: (ExitProfile | string)[] };
  sizing: {
    mode: SizingMode;
    fixedUsd?: number;
    pct?: number;
    /** risk mode: lose at most riskPct of the bankroll if the profile's stop (or assumedLossPct) is hit. */
    riskPct?: number;
    confidence?: { minPct: number; maxPct: number; default: number };
    /** Optional scale-in: tranche fractions of the full size; the first fills at entry. */
    ladder?: { frac: number; atPct: number; withinMin: number }[];
    maxPctOfBankroll: number;
    maxUsd: number;
    minUsd: number;
  };
  risk: {
    perTrade: { maxLossPctOfBankroll: number; assumedLossPctNoStop: number };
    dailyLossHaltPct: number;
    drawdown: { sizeDownAtPct: number; sizeDownMult: number; recoverBelowPct: number; haltAtPct: number };
    maxConcurrent: number;
    maxExposurePct: number;
    lossStreak: { losses: number; cooldownMin: number };
    maxEntriesPerDay: number;
    perCoin: { maxEntries: number; cooldownMin: number };
    /** 1.2.0: positions whose cost was recovered (free bags) may stop counting toward maxConcurrent; at most maxBags of them. */
    recoveredBags?: { countAsOpen: boolean; maxBags: number };
  };
  agent: {
    model: string;
    maxSessions: number;
    budgetUsdPerSession: number;
    budgetUsdPerDay: number;
    maxTurns: number;
    deltaEverySec: number;
    decideWithinSec: number;
    sessionMaxMin: number;
    /** What the engine does when the session misses decideWithinSec or dies: skip the candidate / keep mechanical exits only. */
    onTimeout: 'skip';
    /** 1.2.0 (§5): a wake for a position whose session has ended starts a short position session (runner card). */
    respawnOnWake?: boolean;
  };
  execution: { slippageBps: number; feeBps: number; networkFeeUsd: number; latencyMs: number; maxPriceImpactPct: number; minExitLiquidityUsd: number };
  notes?: string[];
}

/** A strategy with every profile reference resolved to a validated document. */
export interface ResolvedStrategy extends Omit<Strategy, 'exits'> {
  exits: { default: string; profiles: Record<string, ExitProfile> };
  hash: string;
}

// ───────────────────────────── schema ─────────────────────────────

const ID = '^[a-z][a-z0-9-]{1,31}$';
const SEMVER = '^[0-9]+\\.[0-9]+\\.[0-9]+$';
const num = (min?: number, max?: number, int = false): Node => ({ type: 'number', min, max, int });
const str = (max: number, pattern?: string): Node => ({ type: 'string', max, pattern });
const obj = (props: Record<string, Node>, required: string[] = Object.keys(props)): Node => ({ type: 'object', additional: false, required, props });
const nullable = (n: Node): Node => ({ oneOf: [{ type: 'null' }, n] });
const ageRange = obj({ min: num(0, 8760), max: nullable(num(0, 8760)) });

export const SCHEMAS: Refs = {
  exitProfile: obj({
    kind: { type: 'string', enum: ['exit-profile'] },
    id: str(32, ID), name: str(40), version: str(16, SEMVER), description: str(400),
    fit: obj({ summary: str(300), minLiquidityUsd: num(1000), ageHours: ageRange, maxTop10Pct: nullable(num(0, 100)), signals: { type: 'array', items: str(200), max: 8 } }, ['summary', 'minLiquidityUsd', 'ageHours']),
    sizing: obj({ maxSizePctOfBankroll: num(0.1, 25) }),
    tpLadder: { type: 'array', max: 6, items: obj({ atPct: num(0.1, 10000), sellFrac: num(0.01, 1) }) },
    trailingStop: nullable(obj({ armAtPct: num(0), trailPct: num(5, 60) })),
    timeStop: nullable(obj({ minutes: num(1, 10080), ifBelowPct: num(-100, 10000), action: { type: 'string', enum: ['exit', 'review', 'tighten'] } })),
    hardStop: obj({ enabled: { type: 'boolean' }, atPct: nullable(num(-90, 0)), why: str(400) }),
    thesisBreak: obj({
      liquidityDropPct: num(5, 90), liquidityWindowMin: num(1, 60), mcapDivergenceX: nullable(num(1.5)),
      devSell: obj({ exitOnAnyDevSell: { type: 'boolean' }, topHolderSellPctOfBag: nullable(num(1, 100)) }),
      volumeDeath: nullable(obj({ m5TradesBelow: num(1, 10000, true), forMinutes: num(1, 1440) })),
    }),
    reentry: obj({ allowed: { type: 'boolean' }, cooldownMinutes: num(0, 10080), maxEntriesPerCoinPerSession: num(1, 5, true), requires: str(300) }),
    carry: obj({ allowed: { type: 'boolean' }, requiresTpFilled: num(0, 6, true), maxRemainderPctOfBankroll: num(0, 25) }),
    reprofileTo: { type: 'array', max: 8, items: str(32, ID) },
    wake: obj({ onTpFilled: { type: 'boolean' }, onTimeReview: { type: 'boolean' }, drawdownPct: nullable(num(-95, -1)), thesisWarnFrac: nullable(num(0.1, 0.95)), noAnswer: { type: 'string', enum: ['hold', 'exit'] }, onCostRecovered: { type: 'boolean' } }, ['onTpFilled', 'onTimeReview', 'drawdownPct', 'thesisWarnFrac', 'noAnswer']),
    costRecovery: nullable(obj({ atPct: num(10, 10000), maxSellFrac: num(0.1, 0.9) })),
    bagTrail: nullable(obj({ trailPct: num(10, 90), armAtPct: num(0, 100000) }, ['trailPct'])),
    maxHoldMinutes: nullable(num(1, 43200)),
    notes: { type: 'array', max: 8, items: str(300) },
  }, ['kind', 'id', 'name', 'version', 'description', 'fit', 'sizing', 'tpLadder', 'trailingStop', 'timeStop', 'hardStop', 'thesisBreak', 'reentry', 'carry', 'reprofileTo']),
  trigger: {
    oneOf: [
      obj({ kind: { type: 'string', enum: ['screen'] } }),
      obj({ kind: { type: 'string', enum: ['momentum'] }, m5MinPct: num(-100, 10000), buySellMin: num(0, 100) }),
      obj({ kind: { type: 'string', enum: ['narrative'] }, minHeat: num(0, 100) }),
      obj({ kind: { type: 'string', enum: ['wallet'] }, list: { type: 'string', enum: ['followed'] }, minBuyUsd: num(0, 1e7) }),
    ],
  },
  strategy: obj({
    kind: { type: 'string', enum: ['strategy'] },
    schema: { type: 'string', enum: [STRATEGY_SCHEMA] },
    id: str(32, ID), name: str(40), version: str(16, SEMVER), description: str(600),
    mode: { type: 'string', enum: ['paper', 'live'] },
    highRisk: { type: 'boolean' },
    bankroll: obj({ startUsd: num(1, 1e7), source: { type: 'string', enum: ['fixed', 'desk'] } }, ['startUsd']),
    entry: obj({
      screen: str(400),
      ageHours: ageRange,
      safety: obj({
        maxTop10Pct: nullable(num(0, 100)), maxDevPct: nullable(num(0, 100)),
        requireNoMintAuthority: { type: 'boolean' }, requireNoFreezeAuthority: { type: 'boolean' },
        maxMcapSplitX: nullable(num(1.5, 100)),
        youngVertical: nullable(obj({ maxAgeHours: num(0, 168), maxH1Pct: num(0, 100000) })),
        unknownHolders: { type: 'string', enum: ['reject', 'allow'] },
        larp: nullable(obj({ maxScore: num(0, 100), unknown: { type: 'string', enum: ['reject', 'allow'] } })),
      }, ['maxTop10Pct', 'maxDevPct', 'requireNoMintAuthority', 'requireNoFreezeAuthority', 'maxMcapSplitX', 'youngVertical', 'unknownHolders']),
      triggers: { type: 'array', max: 8, items: 'trigger' },
      triggerMode: { type: 'string', enum: ['any', 'all'] },
      decide: { type: 'string', enum: ['agent', 'auto', 'agent+approve'] },
      candidateTtlSec: num(10, 3600),
    }),
    exits: obj({ default: str(32, ID), profiles: { type: 'array', max: 8, items: { oneOf: [str(48, '^builtin:[a-z][a-z0-9-]{1,31}$'), 'exitProfile'] } } }),
    sizing: obj({
      mode: { type: 'string', enum: ['fixed', 'pct', 'risk', 'confidence'] },
      fixedUsd: num(1, 1e6), pct: num(0.1, 25), riskPct: num(0.1, 10),
      confidence: obj({ minPct: num(0.1, 25), maxPct: num(0.1, 25), default: num(0, 1) }),
      ladder: { type: 'array', max: 4, items: obj({ frac: num(0.05, 1), atPct: num(-90, 1000), withinMin: num(1, 1440) }) },
      maxPctOfBankroll: num(0.1, 25), maxUsd: num(1, 1e6), minUsd: num(0.01, 1e6),
    }, ['mode', 'maxPctOfBankroll', 'maxUsd', 'minUsd']),
    risk: obj({
      perTrade: obj({ maxLossPctOfBankroll: num(0.1, 25), assumedLossPctNoStop: num(10, 100) }),
      dailyLossHaltPct: num(1, 100),
      drawdown: obj({ sizeDownAtPct: num(1, 100), sizeDownMult: num(0.05, 1), recoverBelowPct: num(0, 100), haltAtPct: num(1, 100) }),
      maxConcurrent: num(1, 20, true), maxExposurePct: num(1, 100),
      lossStreak: obj({ losses: num(1, 50, true), cooldownMin: num(0, 10080) }),
      maxEntriesPerDay: num(1, 500, true),
      perCoin: obj({ maxEntries: num(1, 20, true), cooldownMin: num(0, 10080) }),
      recoveredBags: obj({ countAsOpen: { type: 'boolean' }, maxBags: num(0, 50, true) }),
    }, ['perTrade', 'dailyLossHaltPct', 'drawdown', 'maxConcurrent', 'maxExposurePct', 'lossStreak', 'maxEntriesPerDay', 'perCoin']),
    agent: obj({
      model: str(64, '^[a-z0-9][a-z0-9.-]{1,63}$'), maxSessions: num(1, 8, true),
      budgetUsdPerSession: num(0.01, 50), budgetUsdPerDay: num(0.01, 500), maxTurns: num(1, 1000, true),
      deltaEverySec: num(1, 600), decideWithinSec: num(5, 3600), sessionMaxMin: num(1, 1440),
      onTimeout: { type: 'string', enum: ['skip'] },
      respawnOnWake: { type: 'boolean' },
    }, ['model', 'maxSessions', 'budgetUsdPerSession', 'budgetUsdPerDay', 'maxTurns', 'deltaEverySec', 'decideWithinSec', 'sessionMaxMin', 'onTimeout']),
    execution: obj({ slippageBps: num(0, 5000), feeBps: num(0, 1000), networkFeeUsd: num(0, 10), latencyMs: num(0, 120000), maxPriceImpactPct: num(0.1, 50), minExitLiquidityUsd: num(0, 1e7) }),
    notes: { type: 'array', max: 8, items: str(300) },
  }, ['kind', 'schema', 'id', 'name', 'version', 'description', 'mode', 'bankroll', 'entry', 'exits', 'sizing', 'risk', 'agent', 'execution']),
};

// ───────────────────────────── validation ─────────────────────────────

export interface Issue { path: string; msg: string }

/** Schema + the cross-field rules for one exit profile. */
export function validateExitProfile(p: unknown, at = ''): Issue[] {
  const errs = validate('exitProfile', p, at, [], SCHEMAS);
  if (errs.length) return errs;
  const x = p as ExitProfile;
  for (let i = 1; i < x.tpLadder.length; i++) if (!(x.tpLadder[i].atPct > x.tpLadder[i - 1].atPct)) errs.push({ path: `${at}/tpLadder/${i}`, msg: 'atPct must be strictly ascending' });
  const sum = x.tpLadder.reduce((s, t) => s + t.sellFrac, 0);
  if (sum > 1 + 1e-9) errs.push({ path: `${at}/tpLadder`, msg: `sellFrac adds up to ${round(sum, 4)} (more than the whole position)` });
  if (x.hardStop.enabled && x.hardStop.atPct === null) errs.push({ path: `${at}/hardStop/atPct`, msg: 'an enabled hard stop needs atPct' });
  if (x.carry.allowed && x.carry.maxRemainderPctOfBankroll <= 0) errs.push({ path: `${at}/carry`, msg: 'carry allowed needs maxRemainderPctOfBankroll > 0' });
  if (x.bagTrail && !x.costRecovery) errs.push({ path: `${at}/bagTrail`, msg: 'a bag trail is armed by the cost-recovery sell: set costRecovery' });
  if (x.costRecovery && x.tpLadder.length && x.tpLadder[0].atPct <= x.costRecovery.atPct) errs.push({ path: `${at}/tpLadder/0`, msg: 'a TP step at or below the cost-recovery level would sell first: put the ladder above costRecovery.atPct' });
  if (x.reprofileTo.includes(x.id)) errs.push({ path: `${at}/reprofileTo`, msg: 'a profile cannot re-profile to itself' });
  return errs;
}

/** Load the shipped exit-profile library (assets/autotrade/profiles). */
export function builtinProfiles(dir = new URL('../assets/profiles/', import.meta.url)): Record<string, ExitProfile> {
  const out: Record<string, ExitProfile> = {};
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    const p = JSON.parse(readFileSync(new URL(f, dir), 'utf8')) as ExitProfile;
    const errs = validateExitProfile(p);
    if (errs.length) throw new Error(`builtin profile ${f} is invalid: ${errs.map(fmtIssue).join('; ')}`);
    out[p.id] = p;
  }
  return out;
}

export type StrategyCheck = { ok: true; strategy: ResolvedStrategy; warnings: Issue[] } | { ok: false; errors: Issue[]; warnings: Issue[] };

/**
 * Validate a strategy document and resolve its profile references. Never throws on bad input: every
 * problem comes back as a path + message so the TUI editor and the assistant's tool can show it inline.
 */
export function validateStrategy(doc: unknown, library: Record<string, ExitProfile> = builtinProfiles()): StrategyCheck {
  const warnings: Issue[] = [];
  const errors = validate('strategy', doc, '', [], SCHEMAS);
  if (errors.length) return { ok: false, errors, warnings };
  const s = doc as Strategy;

  const f = parseFilter(s.entry.screen);
  if (!f.ok) errors.push({ path: '/entry/screen', msg: `${f.error} (column ${f.at})` });

  const profiles: Record<string, ExitProfile> = {};
  s.exits.profiles.forEach((ref, i) => {
    const p = typeof ref === 'string' ? library[ref.slice('builtin:'.length)] : ref;
    if (!p) { errors.push({ path: `/exits/profiles/${i}`, msg: `unknown builtin profile ${String(ref)}` }); return; }
    errors.push(...validateExitProfile(p, `/exits/profiles/${i}`));
    if (profiles[p.id]) errors.push({ path: `/exits/profiles/${i}`, msg: `duplicate profile id ${p.id}` });
    profiles[p.id] = p;
  });
  if (!profiles[s.exits.default]) errors.push({ path: '/exits/default', msg: `default profile ${s.exits.default} is not in exits.profiles` });
  for (const p of Object.values(profiles)) {
    for (const t of p.reprofileTo) if (!profiles[t]) warnings.push({ path: '/exits/profiles', msg: `${p.id} may re-profile to ${t}, which this strategy does not include (that edge is unused)` });
    if (p.sizing.maxSizePctOfBankroll < s.sizing.maxPctOfBankroll) warnings.push({ path: '/sizing/maxPctOfBankroll', msg: `profile ${p.id} caps a position at ${p.sizing.maxSizePctOfBankroll}% (the lower cap wins)` });
  }

  const z = s.sizing;
  const need = (k: keyof Strategy['sizing'], mode: SizingMode) => { if (z.mode === mode && z[k] === undefined) errors.push({ path: `/sizing/${k}`, msg: `sizing mode ${mode} needs ${k}` }); };
  need('fixedUsd', 'fixed'); need('pct', 'pct'); need('riskPct', 'risk'); need('confidence', 'confidence');
  if (z.confidence && z.confidence.minPct > z.confidence.maxPct) errors.push({ path: '/sizing/confidence', msg: 'minPct is above maxPct' });
  if (z.minUsd > z.maxUsd) errors.push({ path: '/sizing/minUsd', msg: 'minUsd is above maxUsd' });
  if (z.ladder) {
    const sum = z.ladder.reduce((a, t) => a + t.frac, 0);
    if (Math.abs(sum - 1) > 1e-6) errors.push({ path: '/sizing/ladder', msg: `tranche fractions add up to ${round(sum, 4)}, they must add up to 1` });
    if (z.ladder[0] && z.ladder[0].atPct !== 0) errors.push({ path: '/sizing/ladder/0/atPct', msg: 'the first tranche fills at entry (atPct 0)' });
  }
  const r = s.risk;
  if (r.drawdown.sizeDownAtPct > r.drawdown.haltAtPct) errors.push({ path: '/risk/drawdown', msg: 'sizeDownAtPct must not exceed haltAtPct' });
  if (r.drawdown.recoverBelowPct >= r.drawdown.sizeDownAtPct) errors.push({ path: '/risk/drawdown/recoverBelowPct', msg: 'recoverBelowPct must be below sizeDownAtPct' });
  if (s.agent.budgetUsdPerSession > s.agent.budgetUsdPerDay) errors.push({ path: '/agent/budgetUsdPerSession', msg: 'a session budget above the daily budget' });
  if (s.entry.ageHours.max !== null && s.entry.ageHours.max < s.entry.ageHours.min) errors.push({ path: '/entry/ageHours', msg: 'max is below min' });
  if (s.entry.triggers.length === 0) errors.push({ path: '/entry/triggers', msg: 'at least one trigger (use {"kind":"screen"} for "every screen match")' });
  for (const [i, t] of s.entry.triggers.entries()) if (t.kind === 'narrative' || t.kind === 'wallet') warnings.push({ path: `/entry/triggers/${i}`, msg: `${t.kind} triggers need the live ${t.kind} feed; replays and backtests treat them as not firing` });
  if (s.bankroll.source === 'desk') warnings.push({ path: '/bankroll/source', msg: 'desk reads the paper desk book during a run; backtests use startUsd' });
  if (s.entry.safety.larp) warnings.push({ path: '/entry/safety/larp', msg: 'the LARP gate needs the live web (live data runs only); replays and backtests do not evaluate it' });
  if (s.mode === 'live') warnings.push({ path: '/mode', msg: 'mode live does not run: dexterm runs strategies on paper only (it holds no key and places no live order); live trading happens in the Telegram trading bot of your choice' });

  if (errors.length) return { ok: false, errors, warnings };
  const resolved: Omit<ResolvedStrategy, 'hash'> = { ...s, exits: { default: s.exits.default, profiles } };
  return { ok: true, strategy: { ...resolved, hash: strategyHash(resolved) }, warnings };
}

/** Stable content hash (sorted keys) written into every audit line so a decision names its exact rules. */
export function strategyHash(s: unknown): string {
  return createHash('sha256').update(canonical(s)).digest('hex').slice(0, 16);
}

export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined && k !== 'hash').sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}

export function loadStrategyFile(path: string | URL, library?: Record<string, ExitProfile>): StrategyCheck {
  let doc: unknown;
  try { doc = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { return { ok: false, errors: [{ path: '', msg: `not JSON: ${(e as Error).message}` }], warnings: [] }; }
  return validateStrategy(doc, library);
}

/** The shipped presets (assets/autotrade/strategies). */
export function presetPath(id: string): URL {
  return new URL(`../assets/strategies/${id}.json`, import.meta.url);
}

export function loadPreset(id: string): ResolvedStrategy {
  const r = loadStrategyFile(presetPath(id));
  if (!r.ok) throw new Error(`preset ${id} is invalid: ${r.errors.map(fmtIssue).join('; ')}`);
  return r.strategy;
}

export const fmtIssue = (i: Issue): string => `${i.path || '/'}: ${i.msg}`;
export const round = (x: number, dp = 2): number => Math.round(x * 10 ** dp) / 10 ** dp;
