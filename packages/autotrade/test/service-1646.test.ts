// 0.2.0 card B (the always-on service): the service lock (double start, stale reclaim only for a dead pid), the
// ensure decision (no-op on a fresh heartbeat, a clean stop stays stopped, hung pid, crash restarts with backoff, the
// crash-loop give-up after 5 restarts an hour with ONE notification), the guard aggregator (STOP, panic, disk and load
// hysteresis, busyProcs, stale data, allowance, day caps, recorder, halted strategies), crash recovery from the run
// ledgers (open positions, taken coins, torn last line, broken chain, a second crash), adoption into a new run whose
// exits keep running under every pause, and the bounded log. Temp homes, synthetic ticks: no network, no model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPreset } from '../src/strategy.ts';
import type { MarketTick } from '../src/replay.ts';
import { Ledger, fileLedger, runFiles } from '../src/ledger.ts';
import { runAutotrade } from '../src/runner.ts';
import type { SafetyVerdict } from '../src/safety.ts';
import {
  BoundedLog, MAX_CRASH_RESTARTS, SERVICE_HUNG_MS, SERVICE_SCHEMA, acquireServiceLock, applyEnsure, clearAttention, crashBackoffMs, ensureDecision, readStarts,
  readStopMarker, releaseServiceLock, serviceStopPath, writeStarts, writeStopMarker, type EnsureInput, type ServiceHeartbeat, type StartsDoc,
} from '../src/service.ts';
import { DEFAULT_GUARD_CONFIG, ServiceGuard, guardConfigFrom, guardNoticeText, type GuardInputs } from '../src/service-guard.ts';
import { RESUME_TAKEN_RULE, positionsFromEvents, recoverFleet } from '../src/service-recover.ts';

const T0 = 1_792_000_000_000;
const MIN = 60_000;
const A = 'Aaaa1111111111111111111111111111111111111111';
const B = 'Bbbb1111111111111111111111111111111111111111';
const home = () => mkdtempSync(join(tmpdir(), 'svc1646-'));
const FX = '20261024T100000Z-fleet-aaaa';
const FY = '20261024T110000Z-fleet-bbbb';
const R1 = '20261024T100000Z-moon-a-0001';
const R2 = '20261024T110000Z-moon-a-0002';

// ───────────────────────────── lock ─────────────────────────────

test('1646 lock: a second start is refused while the holder lives; a dead or older-boot holder is reclaimed', () => {
  const h = home();
  const first = acquireServiceLock(h, { pid: 111, alive: () => true, boot: T0, now: T0 });
  assert.equal(first.ok, true);
  const second = acquireServiceLock(h, { pid: 222, alive: () => true, boot: T0, now: T0 + 1 });
  assert.equal(second.ok, false);
  assert.equal(!second.ok && second.holder.pid, 111);
  // Same pid number but from an older boot (pid reuse after a reboot): stale.
  const reboot = acquireServiceLock(h, { pid: 333, alive: () => true, boot: T0 + 3600e3, now: T0 + 3600e3 });
  assert.equal(reboot.ok, true);
  assert.equal(reboot.ok && reboot.reclaimed?.pid, 111);
  // Dead holder: reclaimed.
  const dead = acquireServiceLock(h, { pid: 444, alive: (p) => p !== 333, boot: T0 + 3600e3, now: T0 + 3600e3 });
  assert.equal(dead.ok && dead.reclaimed?.pid, 333);
  releaseServiceLock(h, 999); // not the holder: kept
  assert.equal(existsSync(join(h, 'autotrade', 'service', 'service.lock')), true);
  releaseServiceLock(h, 444);
  assert.equal(existsSync(join(h, 'autotrade', 'service', 'service.lock')), false);
});

// ───────────────────────────── ensure ─────────────────────────────

const hb = (over: Partial<ServiceHeartbeat> = {}): ServiceHeartbeat => ({ schema: SERVICE_SCHEMA, pid: 50, startedAt: T0, heartbeatAt: T0, state: 'running', fleetId: 'f', guard: [], ...over });
const noStarts = (): StartsDoc => ({ crashStarts: [], lastStartAt: null, attention: null, downNotifiedAt: null });
const input = (over: Partial<EnsureInput> = {}): EnsureInput => ({ now: T0, holder: null, heartbeat: null, stop: null, starts: noStarts(), panic: null, ...over });

test('1646 ensure: no-op on a fresh heartbeat; a hung live pid is ended; a clean stop and the panic switch start nothing', () => {
  const holder = { pid: 50, bootAt: T0, startedAt: T0 };
  assert.equal(ensureDecision(input({ holder, heartbeat: hb({ heartbeatAt: T0 - 5000 }) })).action, 'noop');
  assert.equal(ensureDecision(input({ holder, heartbeat: hb({ heartbeatAt: T0 - 60_000 }) })).action, 'noop'); // busy, not yet hung
  const hung = ensureDecision(input({ holder, heartbeat: hb({ heartbeatAt: T0 - SERVICE_HUNG_MS }) }));
  assert.equal(hung.action, 'kill-hung');
  assert.equal(hung.action === 'kill-hung' && hung.pid, 50);
  const stopped = ensureDecision(input({ heartbeat: hb({ state: 'stopped' }), stop: { at: T0, by: 'chat', reason: 'stop from the bot' } }));
  assert.equal(stopped.action, 'noop');
  assert.match(stopped.why, /service start/);
  assert.equal(ensureDecision(input({ panic: 'panic' })).action, 'noop');
  const first = ensureDecision(input());
  assert.deepEqual([first.action, first.action === 'start' && first.crashed], ['start', false]);
  // A clean end (state stopped, no STOP marker: a logout signal) starts again and is not a crash.
  const clean = ensureDecision(input({ heartbeat: hb({ state: 'stopped' }) }));
  assert.deepEqual([clean.action, clean.action === 'start' && clean.crashed], ['start', false]);
});

test('1646 crash-loop guard: backoff 0, 0, 1, 2, 4 min; gives up after 5 crash restarts in an hour, notifies ONCE, stays down until --clear', () => {
  const h = home();
  const crashedHb = hb({ state: 'running' });
  assert.deepEqual([1, 2, 3, 4, 5].map(crashBackoffMs), [0, 0, 60_000, 120_000, 240_000]);
  let now = T0;
  const notes: string[] = [];
  const tickAt = (t: number) => {
    const d = ensureDecision({ now: t, holder: null, heartbeat: crashedHb, stop: null, starts: readStarts(h), panic: null });
    if (d.action === 'start' || d.action === 'give-up') applyEnsure(h, d, t);
    if ((d.action === 'give-up' && d.notify) || (d.action === 'start' && d.notifyDown)) notes.push(d.action);
    return d;
  };
  const starts: number[] = [];
  for (let i = 0; i < 60 && starts.length < MAX_CRASH_RESTARTS + 2; i++, now += MIN) {
    const d = tickAt(now);
    if (d.action === 'start') starts.push(now);
    if (d.action === 'give-up') break;
  }
  assert.equal(starts.length, MAX_CRASH_RESTARTS);
  // Gaps between restarts follow the backoff (each tick is a minute).
  assert.deepEqual(starts.slice(1).map((t, i) => (t - starts[i]) / MIN), [1, 1, 2, 4]);
  const gave = tickAt(now + MIN);
  assert.equal(gave.action, 'give-up');
  assert.equal(readStarts(h).attention !== null, true);
  // Later ticks stay down and do not notify again.
  for (let i = 2; i < 6; i++) assert.equal(tickAt(now + i * MIN).action, 'give-up');
  assert.deepEqual(notes, ['start', 'give-up']); // one "down" notice an hour + one give-up
  clearAttention(h);
  assert.equal(tickAt(now + 10 * MIN).action, 'start');
  // Old crashes age out of the window.
  writeStarts(h, { ...noStarts(), crashStarts: [T0 - 2 * 3600e3, T0 - 2 * 3600e3, T0 - 2 * 3600e3, T0 - 2 * 3600e3, T0 - 2 * 3600e3] });
  assert.equal(ensureDecision({ now: T0, holder: null, heartbeat: crashedHb, stop: null, starts: readStarts(h), panic: null }).action, 'start');
});

test('1646 stop marker: our JSON or a plain touch both count; clear removes it', () => {
  const h = home();
  assert.equal(readStopMarker(h), null);
  writeStopMarker(h, 'tui', 'Q screen');
  assert.equal(readStopMarker(h)?.by, 'tui');
  writeFileSync(serviceStopPath(h), '');
  assert.equal(readStopMarker(h)?.by, 'file');
});

// ───────────────────────────── guard ─────────────────────────────

const g0 = (over: Partial<GuardInputs> = {}): GuardInputs => ({
  now: T0, stopFile: null, panic: null, freeGb: 100, load1m: 2, busy: [], dataAgeMs: 1000, upMs: 3600e3, runnerAgeMs: 1000,
  allowance: { fiveHour: 0.1, sevenDay: 0.2 }, dayCap: null, recorder: { installed: true, newestAgeMs: 30_000 }, halted: {}, ...over,
});

test('1646 guard: each source maps to its effect; transitions fire once on and once off', () => {
  const g = new ServiceGuard(DEFAULT_GUARD_CONFIG);
  const clear = g.evaluate(g0());
  assert.deepEqual([clear.states, clear.stop, clear.pauseEntries, clear.transitions], [[], null, null, []]);
  const all = g.evaluate(g0({
    now: T0 + 1000, stopFile: 'service stop', panic: 'panic', freeGb: 1, busy: ['ffmpeg'], dataAgeMs: 600_000, runnerAgeMs: 90_000,
    allowance: { fiveHour: 0.9, sevenDay: 0.2 }, dayCap: 'model $ cap', recorder: { installed: false, newestAgeMs: null }, halted: { 'moon-a': 'daily-loss' },
  }));
  const ids = all.states.map((s) => `${s.id}:${s.effect}`).sort();
  assert.deepEqual(ids, ['allowance-high:notice', 'busy-process:pause-entries', 'data-stale:pause-entries', 'day-cap:notice', 'disk-low:pause-entries', 'panic:stop', 'recorder-down:notice', 'runner-stale:notice', 'stop-file:stop', 'strategy-halted:moon-a:notice'].sort());
  assert.equal(all.stop, 'stop-file');
  assert.match(all.pauseEntries ?? '', /^guard:/);
  assert.equal(all.transitions.filter((t) => t.on).length, 10);
  assert.match(all.states.find((s) => s.id === 'recorder-down')!.detail, /dexterm record install/);
  // Same inputs again: no transitions.
  assert.equal(g.evaluate(g0({ now: T0 + 2000, stopFile: 'service stop', panic: 'panic', freeGb: 1, busy: ['ffmpeg'], dataAgeMs: 600_000, runnerAgeMs: 90_000, allowance: { fiveHour: 0.9, sevenDay: 0.2 }, dayCap: 'model $ cap', recorder: { installed: false, newestAgeMs: null }, halted: { 'moon-a': 'daily-loss' } })).transitions.length, 0);
  // Back to clear (disk needs +1 GB over the floor): every state turns off once.
  const off = g.evaluate(g0({ now: T0 + 3000 }));
  assert.equal(off.states.length, 0);
  assert.equal(off.transitions.filter((t) => !t.on).length, 10);
  assert.match(guardNoticeText(off.transitions.find((t) => t.id === 'disk-low')!), /cleared.*entries resume/);
});

test('1646 guard: load pauses only when sustained and resumes only below the lower mark; disk has a 1 GB hysteresis', () => {
  const g = new ServiceGuard(guardConfigFrom({ load: { pauseAboveLoad1m: 25, resumeBelowLoad1m: 20, sustainSec: 120, busyProcs: [] }, disk: { minFreeGb: 5 } }));
  const at = (sec: number, load1m: number, freeGb = 100) => g.evaluate(g0({ now: T0 + sec * 1000, load1m, freeGb })).pauseEntries;
  assert.equal(at(0, 30), null);
  assert.equal(at(60, 30), null);
  assert.equal(at(119, 30), null);
  assert.equal(at(121, 30), 'guard:load-high');
  assert.equal(at(130, 22), 'guard:load-high'); // between the marks: still paused
  assert.equal(at(140, 19), null);
  assert.equal(at(150, 30), null); // the sustain clock restarted
  assert.equal(at(200, 2, 4.5), 'guard:disk-low');
  assert.equal(at(210, 2, 5.5), 'guard:disk-low'); // above the floor, not yet +1 GB
  assert.equal(at(220, 2, 6.1), null);
  // Stale data waits one window after the start.
  const d = new ServiceGuard(DEFAULT_GUARD_CONFIG);
  assert.equal(d.evaluate(g0({ upMs: 60_000, dataAgeMs: null })).pauseEntries, null);
  assert.equal(d.evaluate(g0({ upMs: 400_000, dataAgeMs: null })).pauseEntries, 'guard:data-stale');
});

// ───────────────────────────── recovery ─────────────────────────────

function fillEv(l: Ledger, t: number, pid: string, mint: string, side: 'buy' | 'sell', usd: number, tokens: number, price: number, reason: string, profile?: string) {
  l.add(t, 'fill', { positionId: pid, mint, ...(profile ? { profile } : {}), side, usd, tokens, price, avgPrice: price, impactPct: 0.1, partial: false, reason });
}

/** A crashed fleet: member moon-a holds A (TP1 sold, cost recovered) and closed B; no run_end, no fleet_end. */
function crashedFleet(h: string, fleetId = FX, runId = R1) {
  const { ledger: fl } = fileLedger(h, fleetId);
  fl.add(T0, 'fleet_start', {});
  fl.add(T0, 'member_start', { member: 'moon-a', runId });
  const { ledger: l } = fileLedger(h, runId);
  l.add(T0, 'run_start', { strategy: 'moonbag' });
  l.add(T0, 'candidate', { mint: A, symbol: 'AAA' });
  fillEv(l, T0 + MIN, 'p1', A, 'buy', 20, 1000, 0.02, 'enter', 'moonbag');
  fillEv(l, T0 + 2 * MIN, 'p1', A, 'sell', 10, 250, 0.04, 'cost-recovery');
  fillEv(l, T0 + 3 * MIN, 'p1', A, 'sell', 6, 100, 0.06, 'tp1');
  l.add(T0 + 3 * MIN, 'candidate', { mint: B, symbol: 'BBB' });
  fillEv(l, T0 + 4 * MIN, 'p2', B, 'buy', 10, 500, 0.02, 'enter', 'moonbag');
  fillEv(l, T0 + 5 * MIN, 'p2', B, 'sell', 5, 500, 0.01, 'stop');
  l.add(T0 + 5 * MIN, 'trade_closed', { trade: { id: 'p2', mint: B, symbol: 'BBB' } });
  return { fl, l, runId };
}

test('1646 recovery: open positions rebuilt from the fills (tp step, cost recovery, tokens left); closed ones and pending orders are not', () => {
  const h = home();
  const { runId } = crashedFleet(h);
  const r = recoverFleet(h, FX);
  assert.equal(r.crashed, true);
  const m = r.members.find((x) => x.member === 'moon-a')!;
  assert.deepEqual(m.runIds, [runId]);
  assert.equal(m.positions.length, 1);
  const p = m.positions[0];
  assert.equal(p.id, `${runId}/p1`);
  assert.deepEqual([p.mint, p.symbol, p.profileId, p.tokens, p.origTokens, p.costUsd, p.realizedUsd, p.tpFilled, p.costRecovered, p.peakPrice, p.ladder.length, p.openedAt], [A, 'AAA', 'moonbag', 650, 1000, 20, 16, 1, true, 0.06, 0, T0 + MIN]);
  assert.equal(p.lastTick.price, 0.06);
  assert.deepEqual(m.taken.sort(), [A, B].sort());
  // A fleet that ended cleanly has nothing to resume.
  const h2 = home();
  const { fl } = crashedFleet(h2);
  fl.add(T0 + 9 * MIN, 'fleet_end', {});
  assert.equal(recoverFleet(h2, FX).crashed, false);
});

test('1646 recovery: a torn last line is dropped; a broken chain adopts nothing but keeps its coins taken', () => {
  const h = home();
  const { runId } = crashedFleet(h);
  appendFileSync(runFiles(h, runId).ledger, '{"seq":99,"t":1,"kind":"fi');
  const torn = recoverFleet(h, FX).members[0];
  assert.equal(torn.positions.length, 1);
  assert.match(torn.problems.join(' '), /torn last line/);
  const h2 = home();
  const c = crashedFleet(h2);
  const path = runFiles(h2, c.runId).ledger;
  writeFileSync(path, readFileSync(path, 'utf8').replace('"usd":20', '"usd":2'));
  const broken = recoverFleet(h2, FX).members[0];
  assert.equal(broken.positions.length, 0);
  assert.deepEqual(broken.taken.sort(), [A, B].sort());
  assert.match(broken.problems.join(' '), /hash chain breaks/);
});

test('1646 restart: the new run adopts the position, keeps its exits under a pause, refuses the taken coin, and a second crash keeps both', async () => {
  const h = home();
  crashedFleet(h);
  const rec = recoverFleet(h, FX).members[0];
  const s = loadPreset('scalp');
  const tick = (t: number, mint: string, price: number): MarketTick => ({
    mint, t, kind: 'live', symbol: mint === A ? 'AAA' : 'BBB', launchpad: 'pump.fun', createdAt: T0 - 3 * 3600e3, price, mcap: 1e6, mcapResolved: 1e6, mcapFlagged: false,
    liq: 100_000, vol5m: 10_000, vol1h: 50_000, vol24: 500_000, buys5m: 120, sells5m: 80, buys24: 5000, sells24: 4000, chg5m: 4, chg1h: 20, chg6h: 40, chg24h: 80,
    holders: 900, top10: 20, dev: 1, mintAuth: false, freezeAuth: false, org: 70,
  });
  // A collapses (the adopted bag's stop fires); B looks like an entry the whole time.
  const ticks: MarketTick[] = [];
  for (let i = 0; i < 12; i++) { ticks.push(tick(T0 + (10 + i) * MIN, A, i < 3 ? 0.05 : 0.005)); ticks.push(tick(T0 + (10 + i) * MIN + 1, B, 0.02)); }
  const paused: SafetyVerdict = { halt: null, flatten: false, pauseEntries: 'guard:disk-low', endWhenFlat: false };
  const taken = new Set(rec.taken);
  const ledger = new Ledger();
  const res = await runAutotrade({
    strategy: s, tape: { source: 't', ticks, mints: [A, B] }, sessions: null, ledger, adopt: rec.positions,
    safety: () => paused, vet: async (k) => (taken.has(k.mint) ? { ok: false, rule: RESUME_TAKEN_RULE, detail: 'taken' } : { ok: true }),
  });
  const kinds = ledger.events.map((e) => e.kind);
  assert.ok(kinds.includes('position_adopted'));
  const fills = ledger.events.filter((e) => e.kind === 'fill');
  assert.equal(fills.filter((e) => e.side === 'buy').length, 0, 'no buy under the pause, and never the taken coin');
  assert.ok(fills.some((e) => e.side === 'sell' && e.mint === A), 'the adopted bag still exits under a pause');
  assert.equal(res.trades.length, 1);
  assert.equal(res.trades[0].mint, A);
  // Without the pause the taken coin is refused by the vet, not bought again.
  const l2 = new Ledger();
  await runAutotrade({ strategy: s, tape: { source: 't', ticks, mints: [A, B] }, sessions: null, ledger: l2, vet: async (k) => (taken.has(k.mint) ? { ok: false, rule: RESUME_TAKEN_RULE, detail: 'taken' } : { ok: true }) });
  assert.equal(l2.events.filter((e) => e.kind === 'fill' && e.side === 'buy').length, 0);
  assert.ok(l2.events.some((e) => e.kind === 'refused' && e.rule === RESUME_TAKEN_RULE));
  // A second crash: the resumed run's position_adopted snapshot + the fleet's service_resume carry over again.
  const { ledger: fl2 } = fileLedger(h, FY);
  fl2.add(T0, 'service_resume', { fromFleet: FX, members: { 'moon-a': { taken: rec.taken, adopted: 1 } } });
  fl2.add(T0, 'member_start', { member: 'moon-a', runId: R2 });
  const { ledger: m2 } = fileLedger(h, R2);
  m2.add(T0, 'run_start', {});
  const snap = recoverFleet(h, FX).members[0].positions[0]; // as the runner wrote it at adoption (the run above sold its copy)
  m2.add(T0, 'position_adopted', { positionId: snap.id, mint: A, symbol: 'AAA', position: snap });
  const again = recoverFleet(h, FY).members[0];
  assert.equal(again.positions.length, 1);
  assert.equal(again.positions[0].id, rec.positions[0].id, 'an id that names its run keeps it');
  assert.equal(again.positions[0].tokens, 650);
  assert.deepEqual(again.taken.sort(), [A, B].sort());
});

test('1646 positionsFromEvents: a position sold out without its trade_closed line (crash) is not open', () => {
  const l = new Ledger();
  fillEv(l, T0, 'p1', A, 'buy', 10, 100, 0.1, 'enter');
  fillEv(l, T0 + 1, 'p1', A, 'sell', 12, 100, 0.12, 'tp1');
  const r = positionsFromEvents(l.events);
  assert.equal(r.positions.length, 0);
  assert.deepEqual(r.taken, [A]);
});

// ───────────────────────────── bounded log ─────────────────────────────

test('1646 bounded log: never more than about twice the cap on disk', () => {
  const h = home();
  const path = join(h, 'logs', 'service.log');
  const log = new BoundedLog(path, 2000);
  for (let i = 0; i < 500; i++) log.line(`line ${i} ${'x'.repeat(40)}`);
  assert.ok(statSync(path).size <= 2000);
  assert.ok(statSync(`${path}.1`).size <= 2000);
  const w = log.writer('! ');
  w.write('partial ');
  w.write('then the rest\n');
  assert.match(readFileSync(path, 'utf8'), /! partial then the rest/);
});
