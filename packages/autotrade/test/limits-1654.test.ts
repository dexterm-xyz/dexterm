// task-1654 (0.2.0 card E): every real-mode limit user-set. The schema file, validation that names the field, scope
// precedence (global replaces the placeholder; mode / strategy / account only tighten; the stricter always wins),
// raise vs lower, the typed confirmation, card A's caps.json migration, the journal integrity check, and the
// signal-time guard (pure).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_LIMITS, LIMIT_FIELDS, LIMIT_KEYS, checkBuy, checkSell, diffLimits, effectiveLimits, emptyLimits, freshRiskState, limitsForRealRun, limitsPath, loadLimits, loadRiskState,
  parseLimitAssignment, raises, recordBuy, recordSell, resetBreaker, riskStatePath, saveLimits, saveRiskState, strictestOf, validateLimits, type BuyContext, type LimitsDoc,
} from '../src/limits.ts';
import { realDir } from '../src/outbox.ts';
import { DEFAULT_REAL_CAPS, loadCaps, readRealJournal, saveCaps } from '../src/real-mode.ts';
import { saveTyped } from './fixtures/typed-save.ts';

const home = () => mkdtempSync(join(tmpdir(), 'dexterm-1654-limits-'));
const SCHEMA_FILE = new URL('../assets/limits.schema.json', import.meta.url);
const doc = (d: Partial<LimitsDoc>): LimitsDoc => ({ ...emptyLimits(), ...d });
const ctx = (strategyId = 'scalp', accountId = 'main', mode: 'real' | 'paper' = 'real') => ({ strategyId, accountId, mode });

test('the placeholder defaults are the raised card-E numbers, and the schema file names exactly the fields the code validates', () => {
  assert.deepEqual({ perTradeSol: DEFAULT_LIMITS.perTradeSol, dailySol: DEFAULT_LIMITS.dailySol, buysPerDay: DEFAULT_LIMITS.buysPerDay, maxOpenPositions: DEFAULT_LIMITS.maxOpenPositions }, { perTradeSol: 0.25, dailySol: 1, buysPerDay: 20, maxOpenPositions: 3 });
  assert.deepEqual(DEFAULT_REAL_CAPS, { perTradeSol: 0.25, dailySol: 1, buysPerDay: 20, maxOpenPositions: 3 });
  const s = JSON.parse(readFileSync(SCHEMA_FILE, 'utf8'));
  assert.equal(s.title, 'dexterm-limits/1');
  assert.deepEqual(Object.keys(s.$defs.set.properties).sort(), [...LIMIT_KEYS].sort());
  assert.deepEqual(Object.keys(s.$defs.globalSet.properties).sort(), [...LIMIT_KEYS].sort());
  for (const f of LIMIT_FIELDS) {
    const p = s.$defs.set.properties[f.key];
    assert.equal(p.type, 'int' in f && f.int ? 'integer' : 'number', f.key);
    assert.equal(p.minimum, f.lo, f.key);
    assert.equal(p.maximum, f.hi, f.key);
  }
  assert.deepEqual(Object.keys(s.properties).sort(), ['accounts', 'global', 'migratedFrom', 'modes', 'schema', 'strategies', 'updatedAt']);
  // No hard-coded ceiling on what a user may choose: the bounds are what a number can mean.
  assert.equal(validateLimits(doc({ global: { perTradeSol: 5000, dailySol: 50_000, buysPerDay: 100_000, maxOpenPositions: 500 } })).length, 0);
});

test('validation messages name the field (path + name + unit)', () => {
  const issues = validateLimits({ schema: 'dexterm-limits/1', global: { perTradeSol: -1, buysPerDay: 1.5, bogus: 1 }, modes: { live: {} }, strategies: { scalp: { dailySol: 'x', perTradeSol: null } }, accounts: { 'Bad Id': {} }, extra: 1 });
  const by = Object.fromEntries(issues.map((i) => [i.path, i.msg]));
  assert.match(by['/global/perTradeSol'], /perTradeSol must be from 0\.000001 to .* SOL/);
  assert.match(by['/global/buysPerDay'], /buysPerDay must be a whole number/);
  assert.match(by['/global/bogus'], /unknown limit "bogus"/);
  assert.match(by['/modes/live'], /unknown mode "live"/);
  assert.match(by['/strategies/scalp/dailySol'], /dailySol must be a number \(SOL\/day\)/);
  assert.match(by['/strategies/scalp/perTradeSol'], /null \(off\) is only allowed in global/);
  assert.match(by['/accounts/Bad Id'], /not a valid id/);
  assert.match(by['/extra'], /unknown key "extra"/);
  assert.match(validateLimits(doc({ global: { perTradeSol: 2, dailySol: 1 } }))[0].msg, /dailySol \(1\) must be at least perTradeSol \(2\)/);
  assert.match(validateLimits(doc({ global: { minPositionSol: 0.5 } }))[0].msg, /minPositionSol \(0\.5\) is above perTradeSol \(0\.25\): every buy would be refused/);
});

test('scope precedence: global replaces the placeholder; mode < strategy < account only tighten; the stricter always wins', () => {
  const d = doc({
    global: { perTradeSol: 1, dailySol: 5, dailyLossSol: null, minLiquidityUsd: 10_000 },
    modes: { real: { perTradeSol: 0.8 } },
    strategies: { scalp: { perTradeSol: 0.5, minLiquidityUsd: 50_000, maxOpenPositions: 10 }, loose: { perTradeSol: 9 } },
    accounts: { main: { perTradeSol: 0.3 }, big: { dailySol: 50 } },
  });
  const e = effectiveLimits(d, ctx('scalp', 'main'));
  assert.equal(e.values.perTradeSol, 0.3); assert.equal(e.from.perTradeSol, 'accounts.main');
  assert.equal(e.values.minLiquidityUsd, 50_000, 'a floor: the larger is stricter'); assert.equal(e.from.minLiquidityUsd, 'strategies.scalp');
  assert.equal(e.values.maxOpenPositions, 3, 'a strategy cannot loosen the placeholder of 3 open'); assert.equal(e.from.maxOpenPositions, 'default');
  assert.equal(e.values.dailyLossSol, undefined, 'global null turns a limit off');
  assert.equal(e.values.buysPerDay, 20); assert.equal(e.from.buysPerDay, 'default');
  const l = effectiveLimits(d, ctx('loose', 'big'));
  assert.equal(l.values.perTradeSol, 0.8, 'strategy 9 SOL cannot beat the mode scope');
  assert.equal(l.values.dailySol, 5, 'account 50 SOL/day cannot beat global');
  // Paper ignores limits unless the file has a paper scope; then the same fold applies (forward tests can mirror real).
  assert.equal(effectiveLimits(d, ctx('scalp', 'main', 'paper')).applies, false);
  const p = effectiveLimits({ ...d, modes: { ...d.modes, paper: {} } }, ctx('scalp', 'main', 'paper'));
  assert.equal(p.applies, true); assert.equal(p.values.perTradeSol, 0.3);
  // No file at all: the placeholders.
  assert.deepEqual(effectiveLimits(null, ctx()).values, DEFAULT_LIMITS);
  assert.deepEqual(strictestOf({ perTradeSol: 1, minMcapUsd: 5 }, { perTradeSol: 0.5, minMcapUsd: 9, dailySol: 2 }), { perTradeSol: 0.5, minMcapUsd: 9, dailySol: 2 });
});

test('raise vs lower: bigger caps, smaller floors, a removed tighter scope, an off limit and dropping the paper scope are raises', () => {
  const a = doc({ global: { perTradeSol: 0.5 }, strategies: { scalp: { dailySol: 2, minMcapUsd: 1e5 } }, modes: { paper: {} } });
  const kinds = (b: LimitsDoc) => diffLimits(a, b).map((c) => `${c.kind}:${c.scope}.${c.key}`).sort();
  assert.deepEqual(kinds(doc({ ...a, global: { perTradeSol: 0.1 } })), ['lower:global.perTradeSol']);
  assert.deepEqual(kinds(doc({ ...a, global: { perTradeSol: 0.6 } })), ['raise:global.perTradeSol']);
  assert.deepEqual(kinds(doc({ ...a, global: {} })), ['lower:global.perTradeSol'], 'back to the 0.25 placeholder is a lower');
  assert.deepEqual(kinds(doc({ ...a, global: { perTradeSol: 0.5, dailyLossSol: null } })), ['raise:global.dailyLossSol'], 'turning a placeholder limit off');
  assert.deepEqual(kinds(doc({ ...a, strategies: { scalp: { dailySol: 2, minMcapUsd: 5e4 } } })), ['raise:strategies.scalp.minMcapUsd'], 'a smaller floor');
  assert.deepEqual(kinds(doc({ ...a, strategies: {} })), ['raise:strategies.scalp.dailySol', 'raise:strategies.scalp.minMcapUsd']);
  assert.deepEqual(kinds(doc({ ...a, accounts: { main: { buysPerDay: 2 } } })), ['lower:accounts.main.buysPerDay']);
  assert.deepEqual(kinds(doc({ ...a, modes: {} })), ['raise:modes.paper.scope']);
  assert.equal(raises(diffLimits(null, doc({ global: { perTradeSol: 0.1 } }))).length, 0, 'a first file below the placeholders raises nothing');
});

test('saving: a raise needs the typed confirmation, a lower does not; every save is journaled with its hash and document', () => {
  const h = home();
  assert.equal(saveLimits(h, doc({ global: { perTradeSol: 0.1 } }), { confirmed: [] }).ok, true);
  const r = saveLimits(h, doc({ global: { perTradeSol: 0.2 } }), { confirmed: [] });
  assert.equal(r.ok, false);
  assert.match((r as { why: string }).why, /raising global\.perTradeSol needs the typed confirmation on a real terminal/);
  assert.equal((loadLimits(h) as { doc: LimitsDoc }).doc.global.perTradeSol, 0.1, 'nothing changed');
  assert.equal(saveTyped(h, doc({ global: { perTradeSol: 0.2 } })).ok, true);
  const j = readRealJournal(h).filter((l) => l.action === 'limits-set');
  assert.equal(j.length, 2);
  assert.deepEqual(j[1].data.raised, ['global.perTradeSol']);
  assert.equal(typeof j[1].data.hash, 'string');
  const l = loadLimits(h);
  assert.ok(l.ok && l.journaled && l.unjournaled === null);
  assert.match((saveTyped(h, { ...emptyLimits(), global: { perTradeSol: 'x' as unknown as number } }) as { why: string }).why, /\/global\/perTradeSol: perTradeSol must be a number/);
});

test('migration from card A: caps.json is read as global (its numbers stay the user\'s), written to limits.json on the next save; day.json carries over', () => {
  const h = home();
  const dir = realDir(h);
  // card A's files
  const fs = { caps: join(dir, 'caps.json'), day: join(dir, 'day.json') };
  assert.equal(loadLimits(h).ok, false, 'nothing yet');
  assert.equal((loadLimits(h) as { missing?: boolean }).missing, true);
  saveRiskState(h, freshRiskState('2000-01-01')); // creates autotrade/real/
  writeFileSync(fs.caps, JSON.stringify({ schema: 'dexterm-real-caps/1', caps: { perTradeSol: 0.05, dailySol: 0.25, buysPerDay: 10, maxOpenPositions: 1 }, updatedAt: 1 }));
  const today = new Date(); const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  writeFileSync(fs.day, JSON.stringify({ day, buySol: 0.1, buys: 2 }));
  writeFileSync(riskStatePath(h), '{}'); // no valid risk state yet
  const l = loadLimits(h);
  assert.ok(l.ok && l.source === 'migrated');
  const e = effectiveLimits(l.ok ? l.doc : null, ctx());
  assert.deepEqual([e.values.perTradeSol, e.values.dailySol, e.values.buysPerDay, e.values.maxOpenPositions], [0.05, 0.25, 10, 1], 'card A numbers, not the new placeholders');
  assert.equal(limitsForRealRun(h).ok, true, 'a migrated home runs without a new confirmation');
  const r = loadRiskState(h, Date.now());
  assert.deepEqual([r.buys, r.buySol], [2, 0.1], 'the day\'s buys carry over from day.json');
  assert.deepEqual(loadCaps(h), { ok: true, caps: { perTradeSol: 0.05, dailySol: 0.25, buysPerDay: 10, maxOpenPositions: 1 } });
  assert.equal(saveCaps(h, { perTradeSol: 0.04, dailySol: 0.25, buysPerDay: 10, maxOpenPositions: 1 }, { confirmed: [] }).ok, true, 'lowering from the migrated caps is free');
  const saved = JSON.parse(readFileSync(limitsPath(h), 'utf8'));
  assert.deepEqual(saved.global, { perTradeSol: 0.04, dailySol: 0.25, buysPerDay: 10, maxOpenPositions: 1 });
  assert.equal(saved.migratedFrom, undefined);
  assert.match((saveCaps(h, { perTradeSol: 0.04, dailySol: 0.3, buysPerDay: 10, maxOpenPositions: 1 }, { confirmed: [] }) as { why: string }).why, /raising dailySol needs the typed confirmation/);
});

test('integrity: a hand edit that only lowers is accepted (journaled); one that raises is refused until accepted on the terminal', () => {
  const h = home();
  assert.ok(saveTyped(h, doc({ global: { perTradeSol: 0.2 } })).ok);
  const raw = JSON.parse(readFileSync(limitsPath(h), 'utf8'));
  writeFileSync(limitsPath(h), JSON.stringify({ ...raw, global: { perTradeSol: 0.1 } }));
  let r = limitsForRealRun(h);
  assert.equal(r.ok, true);
  assert.equal(readRealJournal(h).at(-1)!.action, 'limits-accept');
  assert.equal(readRealJournal(h).at(-1)!.by, 'runner');
  writeFileSync(limitsPath(h), JSON.stringify({ ...raw, global: { perTradeSol: 5, dailySol: 50 } }));
  r = limitsForRealRun(h);
  assert.equal(r.ok, false);
  assert.match((r as { why: string }).why, /changed outside dexterm and RAISES global\.perTradeSol, global\.dailySol/);
  writeFileSync(limitsPath(h), '{not json');
  assert.match((limitsForRealRun(h) as { why: string }).why, /unreadable/);
});

test('parseLimitAssignment: camelCase or kebab-case names, "off", and a precise refusal', () => {
  assert.deepEqual(parseLimitAssignment('per-trade-sol=0.5'), { key: 'perTradeSol', value: 0.5 });
  assert.deepEqual(parseLimitAssignment('dailyLossSol=off'), { key: 'dailyLossSol', value: null });
  assert.match((parseLimitAssignment('perTradeSOL=1') as { error: string }).error, /unknown limit/);
  assert.match((parseLimitAssignment('perTradeSol=abc') as { error: string }).error, /not a number/);
});

const B = (o: Partial<BuyContext> = {}): BuyContext => ({ now: 1_000_000, solUsd: 200, usd: 100, bookUsd: 1000, mint: 'M', liqUsd: 1e6, mcapUsd: 1e7, positionCostUsd: 0, openCostUsd: 0, ...o });

test('the guard: per-trade SOL vs % of book (the smaller wins), bookSol, position, exposure, impact, minimum, per coin, daily', () => {
  const s = freshRiskState('d');
  let v = checkBuy({ perTradeSol: 0.25, perTradePct: 2 }, s, B());
  assert.ok(v.ok); assert.equal(v.usd, 20, '2% of a $1000 book beats 0.25 SOL ($50)'); assert.deepEqual(v.clamps, ['perTradeSol', 'perTradePct']);
  v = checkBuy({ perTradeSol: 0.25, perTradePct: 2, bookSol: 100 }, s, B());
  assert.ok(v.ok); assert.equal(v.usd, 50, 'bookSol: 2% of 100 SOL is 2 SOL; 0.25 SOL wins');
  v = checkBuy({ maxPositionSol: 0.3 }, s, B({ positionCostUsd: 40 }));
  assert.ok(v.ok); assert.equal(v.usd, 20, 'an add is clamped to what is left of the position');
  assert.deepEqual(checkBuy({ maxPositionSol: 0.2 }, s, B({ positionCostUsd: 40 })), { ok: false, refused: 'real-max-position', detail: 'nothing left under maxPositionSol' });
  assert.equal((checkBuy({ maxExposurePct: 10 }, s, B({ openCostUsd: 100 })) as { refused: string }).refused, 'real-max-exposure');
  v = checkBuy({ maxPriceImpactPct: 1 }, s, B({ liqUsd: 10_000 }));
  assert.ok(v.ok); assert.equal(v.usd, 50, '1% of the $5000 quote side'); assert.equal(v.impactPct, 1);
  assert.equal((checkBuy({ maxPriceImpactPct: 1 }, s, B({ liqUsd: null })) as { refused: string }).refused, 'real-impact-unknown');
  assert.equal((checkBuy({ minPositionSol: 1 }, s, B()) as { refused: string }).refused, 'real-below-min-position');
  assert.equal((checkBuy({ minLiquidityUsd: 2e6 }, s, B()) as { refused: string }).refused, 'real-min-liquidity');
  assert.equal((checkBuy({ minLiquidityUsd: 1 }, s, B({ liqUsd: null })) as { refused: string }).refused, 'real-liquidity-unknown', 'unknown liquidity fails closed');
  assert.equal((checkBuy({ minMcapUsd: 1e8 }, s, B()) as { refused: string }).refused, 'real-min-mcap');
  const t = freshRiskState('d');
  recordBuy(t, 'M', 0.4, 1); recordBuy(t, 'M', 0.4, 2);
  assert.equal((checkBuy({ perCoinBuysPerDay: 2 }, t, B()) as { refused: string }).refused, 'real-per-coin-buys');
  assert.equal((checkBuy({ perCoinSolPerDay: 1 }, t, B()) as { refused: string }).refused, 'real-per-coin-sol');
  assert.equal((checkBuy({ dailySol: 1 }, t, B()) as { refused: string }).refused, 'real-daily-cap');
  assert.equal((checkBuy({ buysPerDay: 2 }, t, B()) as { refused: string }).refused, 'real-buys-per-day');
  assert.equal((checkBuy({ buysPerDay: 0 }, freshRiskState('d'), B()) as { refused: string }).refused, 'real-buys-per-day', '0 buys a day = none');
});

test('the guard: rate limit, daily loss, loss-streak pause, drawdown breaker (typed reset), optional sell rate; state persists across loads', () => {
  const L = { maxBuysPerMinute: 2, dailyLossSol: 0.5, lossStreak: 2, lossStreakPauseMin: 30, maxDrawdownSol: 1, maxSellsPerMinute: 1 };
  const s = freshRiskState('d');
  recordBuy(s, 'A', 0.1, 1000); recordBuy(s, 'B', 0.1, 2000);
  assert.equal((checkBuy(L, s, B({ now: 3000 })) as { refused: string }).refused, 'real-rate-limit');
  assert.equal(checkBuy(L, s, B({ now: 70_000 })).ok, true, 'a minute later');
  assert.deepEqual(checkSell(L, s, 70_000), { ok: true });
  assert.deepEqual(recordSell(L, s, { pnlSol: -0.2, closedPnlSol: -0.2, now: 70_000 }), []);
  assert.equal((checkSell(L, s, 70_500) as { refused: string }).refused, 'real-sell-rate', 'only because the user set maxSellsPerMinute');
  assert.deepEqual(checkSell({}, s, 70_500), { ok: true }, 'sells are uncapped by default');
  const tripped = recordSell(L, s, { pnlSol: -0.2, closedPnlSol: -0.2, now: 80_000 });
  assert.deepEqual(tripped, ['2 losing closes in a row: new buys paused 30 min']);
  assert.equal((checkBuy(L, s, B({ now: 90_000 })) as { refused: string }).refused, 'real-loss-streak');
  assert.equal(checkBuy(L, s, B({ now: 80_000 + 31 * 60_000 })).ok, true, 'the pause ends');
  const t2 = recordSell(L, s, { pnlSol: -0.2, closedPnlSol: null, now: 80_000 + 32 * 60_000 });
  assert.match(t2[0], /daily loss limit reached \(0\.6 SOL\)/);
  assert.equal((checkBuy(L, s, B({ now: 80_000 + 33 * 60_000 })) as { refused: string }).refused, 'real-daily-loss');
  const h = home();
  const big = { ...freshRiskState('d'), cumPnlSol: 2, peakCumPnlSol: 2 };
  const t3 = recordSell({ maxDrawdownSol: 1 }, big, { pnlSol: -1.1, closedPnlSol: -1.1, now: 5 });
  assert.match(t3[0], /drawdown breaker tripped \(1\.1 SOL below the peak\)/);
  saveRiskState(h, big);
  const re = loadRiskState(h, Date.now());
  assert.ok(re.breaker, 'the breaker survives a restart (and a new day)');
  assert.equal((checkBuy({}, re, B()) as { refused: string }).refused, 'real-drawdown-breaker');
  assert.deepEqual(resetBreaker(h, { confirmed: false }), { ok: false, why: 'resetting the drawdown breaker needs the typed confirmation on a real terminal' });
  assert.equal(resetBreaker(h, { confirmed: true }).ok, true);
  assert.equal(loadRiskState(h, Date.now()).breaker, null);
  assert.equal(readRealJournal(h).at(-1)!.action, 'breaker-reset');
});
