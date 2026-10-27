// task-1532: the yolo (full-port) preset on fakes. The preset validates (HIGH RISK, the four entry gates, cost back
// at 2x then a free bag, no re-entry); the LARP gate refuses a high or an unknown score; the full-port replay measures
// every entry and compounds the wallet. task-1571: yolo is a PAPER preset only (dexterm holds no key and places no
// live order); the devnet rehearsal, yolo-check and the mainnet gate left with the local signer.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KillSwitch } from '@dexterm/data';
import {
  NotifyBus, StrategyStore, builtinTapePath, defaultTelegram, loadTape, measureCopy, presetPath, runAutotrade,
  validateStrategy, yoloReplay, type LedgerEvent, type MarketTick, type ResolvedStrategy, type Tape,
} from '@dexterm/autotrade';
import { riskDelta } from '@dexterm/mcp';
import { larpVet, runCmd } from '../src/autotrade-cmd/run.ts';

const preset = () => JSON.parse(readFileSync(presetPath('yolo'), 'utf8'));
const resolved = (): ResolvedStrategy => { const r = validateStrategy(preset()); if (!r.ok) throw new Error(JSON.stringify(r.errors)); return r.strategy; };
const rehearsalTape = (): Tape => loadTape(builtinTapePath('builtin:yolo-rehearsal'));

test('1532 yolo preset: valid, hashed, HIGH RISK; the four entry gates; cost back at 2x then a free bag; one at a time; never the same coin twice', () => {
  const s = resolved();
  assert.equal(s.id, 'yolo');
  assert.equal(s.mode, 'paper', 'the shipped preset is paper; live needs the user\'s own copy');
  assert.equal(s.highRisk, true);
  assert.match(s.hash, /^[0-9a-f]{16}$/);
  assert.equal(resolved().hash, s.hash, 'the hash is stable');
  assert.match(s.description, /HIGH RISK/);
  const g = s.entry.safety;
  assert.equal(g.requireNoMintAuthority, true);
  assert.equal(g.requireNoFreezeAuthority, true);
  assert.deepEqual(g.larp, { maxScore: 49, unknown: 'reject' });
  assert.match(s.entry.screen, /lplocked >= 90/);
  assert.match(s.entry.screen, /liq >= 25K/);
  assert.equal(s.entry.triggers[0].kind, 'momentum');
  const p = s.exits.profiles.yolo;
  assert.deepEqual(p.costRecovery, { atPct: 100, maxSellFrac: 0.6 });
  assert.deepEqual(p.bagTrail, { trailPct: 50 });
  assert.equal(p.timeStop?.minutes, 45);
  assert.ok(p.thesisBreak.liquidityDropPct && p.thesisBreak.devSell?.exitOnAnyDevSell);
  assert.equal(p.reentry.allowed, false);
  assert.equal(s.risk.maxConcurrent, 1);
  assert.equal(s.risk.perCoin.maxEntries, 1);
  // the store lists it as a HIGH RISK preset; the schema refuses a larp gate with a bad shape
  const home = mkdtempSync(join(tmpdir(), 'dxy1532s-'));
  try {
    const row = new StrategyStore({ DEXTERM_HOME: home } as NodeJS.ProcessEnv).list().find((e) => e.id === 'yolo');
    assert.equal(row?.highRisk, true);
  } finally { rmSync(home, { recursive: true, force: true }); }
  const bad = preset(); bad.entry.safety.larp = { maxScore: 200, unknown: 'maybe' };
  assert.equal(validateStrategy(bad).ok, false);
  // riskDelta: the label is neutral; removing or loosening the LARP gate is looser
  const v = (doc: unknown) => { const r = validateStrategy(doc); assert.ok(r.ok, JSON.stringify(!r.ok && r.errors)); return r.strategy; };
  const looser = preset(); looser.entry.safety.larp = null;
  const d = riskDelta(s, v(looser));
  assert.equal(d.delta, 'looser');
  assert.ok(d.reasons.some((x) => x.path.startsWith('/entry/safety/larp') && x.dir === 'looser'), JSON.stringify(d));
  const higher = preset(); higher.entry.safety.larp.maxScore = 80;
  assert.equal(riskDelta(s, v(higher)).delta, 'looser');
  const relabel = preset(); relabel.highRisk = false;
  assert.equal(riskDelta(s, v(relabel)).delta, 'neutral');
});

test('1532 LARP gate: a high score and a check that cannot run are refused (reject), once per coin; allow lets an unknown through', async () => {
  const gate = { maxScore: 49, unknown: 'reject' as const };
  const k = { mint: 'M1', symbol: 'X' } as MarketTick;
  assert.deepEqual(await larpVet(gate, async () => ({ score: 12, band: 'low' }))(k), { ok: true, note: 'LARP score 12 (low) ≤ 49' });
  const hi = await larpVet(gate, async () => ({ score: 80, band: 'high' }))(k);
  assert.equal(hi.ok, false); assert.equal(!hi.ok && hi.rule, 'larp-score');
  const down = await larpVet(gate, async () => { throw new Error('web down'); })(k);
  assert.equal(!down.ok && down.rule, 'larp-unknown');
  const slow = await larpVet(gate, () => new Promise(() => {}), 20)(k);
  assert.equal(!slow.ok && slow.rule, 'larp-unknown');
  const err = await larpVet(gate, async () => ({ error: 'no links' }))(k);
  assert.equal(!err.ok && err.rule, 'larp-unknown');
  assert.equal((await larpVet({ maxScore: 49, unknown: 'allow' }, async () => { throw new Error('x'); })(k)).ok, true);

  // in the runner: a refused coin never becomes a candidate, and the vet runs once per coin
  const tape = rehearsalTape();
  const s = measureCopy(resolved());
  let calls = 0;
  const res = await runAutotrade({ strategy: s, tape, sessions: null, pacing: { mode: 'lockstep' }, vet: async (t) => { calls++; return t.symbol === 'REHA' ? { ok: false, rule: 'larp-score', detail: 'LARP score 80 is above 49' } : { ok: true }; } });
  const refused = res.ledger.events.filter((e: LedgerEvent) => e.kind === 'refused' && (e as LedgerEvent & { rule?: string }).rule === 'larp-score');
  assert.equal(refused.length, 1);
  assert.ok(!res.trades.some((t) => t.symbol === 'REHA') && !res.openAtEnd.some((p) => p.symbol === 'REHA'), 'REHA never opened');
  assert.equal(calls, 3, 'one vet per coin');
  // task-1571: a mode:live copy never runs (paper only), whatever executor it is handed
  const live = { ...resolved(), mode: 'live' as const };
  await assert.rejects(runAutotrade({ strategy: live, tape, sessions: null }), /autotrade runs paper only \(dexterm holds no key and places no live order\)/);
});

test('1532 full-port replay: every entry measured at the same stake, the wallet compounded in order, a seeded bootstrap; deterministic', async () => {
  const s = resolved();
  const a = await yoloReplay(s, rehearsalTape(), { seed: 7 });
  const b = await yoloReplay(s, rehearsalTape(), { seed: 7 });
  assert.deepEqual(a, b);
  assert.equal(a.entries, 3);
  assert.equal(a.costRecovered, 1, 'REHA: the cost came back at 2x');
  assert.equal(a.spread.reduce((n, x) => n + x.n, 0), 3);
  assert.ok(a.bootstrap && a.bootstrap.sequence === 10 && a.bootstrap.resamples === 2000);
  assert.ok(a.small, 'n below the skill minimum is flagged');
  assert.ok(a.limits.some((l) => /Bootstrap/.test(l)) && a.limits.some((l) => /halts .* lifted/.test(l)));
  // a pulled pool at the first entry: the bag is stuck at 0, the wallet is zeroed at entry 1 and the stuck bag blocks the rest (one at a time)
  const rug: Tape = structuredClone(rehearsalTape());
  const rows = rug.ticks.filter((t) => t.symbol === 'REHA');
  for (const t of rows.slice(3)) { t.price = (t.price ?? 0) / 1000; t.liq = 100; }
  const r = await yoloReplay(s, rug);
  assert.equal(r.path.zeroed, true);
  assert.equal(r.path.zeroedAtEntry, 1);
  assert.equal(r.entries, 1);
  assert.equal(r.rugs, 1);
  assert.equal(r.spread[0].n, 1, 'counted in the rug bucket');
  assert.ok(r.bootstrap && r.bootstrap.zeroedPct === 100);
  assert.ok(r.limits.some((l) => /cannot be sold/.test(l)));
});

// task-1571: the yolo preset runs on PAPER end to end through the CLI (the same path the paper runbook uses): the
// fixture tape, stub sessions, no Telegram, a temp $DEXTERM_HOME. Paper fills only; there is no live path.
test('1571 yolo PAPER run end to end: `autotrade run yolo --paper --replay builtin:yolo-rehearsal --stub` fills on paper and writes the run ledger', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dexterm-yolo-paper-'));
  try {
    const out: string[] = [], err: string[] = [];
    const io = { stdout: { write: (x: string) => { out.push(x); return true; } }, stderr: { write: (x: string) => { err.push(x); return true; } }, env: { ...process.env, DEXTERM_HOME: home, DEXTERM_OFFLINE: '1', DEXTERM_NO_UPDATE_CHECK: '1' } } as unknown as Parameters<typeof runCmd>[1];
    const code = await runCmd(['yolo', '--paper', '--replay', 'builtin:yolo-rehearsal', '--ms-per-tick', '1', '--stub', '--no-telegram'], io, { killSwitch: new KillSwitch(join(home, 'trading.panic')) });
    const text = out.join('');
    assert.equal(code, 0, err.join('') + text);
    assert.match(text, /dexterm autotrade run · PAPER · strategy yolo/);
    assert.match(text, /HIGH RISK strategy \(yolo\).*Paper only/);
    assert.match(text, /\bBUY REH/, 'at least one paper entry filled');
    assert.doesNotMatch(text, /signer|LIVE|DEVNET|mainnet/i);
    const runs = readdirSync(join(home, 'autotrade', 'runs')).filter((f) => f.endsWith('.jsonl'));
    assert.equal(runs.length, 1);
    const ledger = readFileSync(join(home, 'autotrade', 'runs', runs[0]), 'utf8');
    assert.match(ledger, /"kind":"fill"/);
    // --live and the removed rehearsal / signer flags are refused before anything starts
    for (const argv of [['yolo', '--live'], ['yolo', '--paper', '--devnet-rehearsal'], ['yolo', '--paper', '--signer-size', 'max']]) {
      err.length = 0;
      assert.equal(await runCmd(argv, io), 2, argv.join(' '));
      assert.match(err.join(''), /there is no --live: dexterm runs strategies on paper only and never holds a key or signs; live trading happens in the Telegram trading bot of your choice/);
    }
    assert.equal(readdirSync(join(home, 'autotrade', 'runs')).filter((f) => f.endsWith('.jsonl')).length, 1, 'a refused run writes no ledger');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('1532 Telegram: a HIGH RISK run says so at the start and on the strategy line', async () => {
  const sent: string[] = [];
  const bus = new NotifyBus({ badge: 'PAPER', config: () => defaultTelegram(), send: async (m) => { sent.push(m.kind === 'card' ? m.caption : m.lines.join('\n')); } });
  bus.onEvent({ seq: 1, t: Date.now(), kind: 'run_start', strategy: 'my-yolo', version: '1.0.0', strategyHash: 'abcdef0123456789', decide: 'agent', highRisk: true } as unknown as LedgerEvent);
  await bus.flush();
  assert.ok(sent.some((m) => /RUNNER STARTED · ⚠ HIGH RISK · my-yolo/.test(m) && /one rug can zero it/.test(m)), JSON.stringify(sent));
  // a run without the label: no HIGH RISK line
  const plain: string[] = [];
  const bus2 = new NotifyBus({ badge: 'PAPER', config: () => defaultTelegram(), send: async (m) => { plain.push(m.kind === 'card' ? m.caption : m.lines.join('\n')); } });
  bus2.onEvent({ seq: 1, t: Date.now(), kind: 'run_start', strategy: 'swing', version: '1.0.0', strategyHash: 'abcdef0123456789', decide: 'agent' } as unknown as LedgerEvent);
  await bus2.flush();
  assert.ok(plain.length && plain.every((m) => !/HIGH RISK/.test(m)));
});
