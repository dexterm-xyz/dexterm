// task-1509 (AT-7, AUTOTRADE-SPEC §6.3, §6.4): stop, flatten and pause through the control file, the panic file read
// every step, the entry dead-man, the run audit and the session isolation counts. Synthetic ticks + a temp
// $DEXTERM_HOME: no network, no model, no keys, paper only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPreset } from '../src/strategy.ts';
import type { MarketTick } from '../src/replay.ts';
import { parseDecision, type AgentSession } from '../src/session.ts';
import { fileLedger, newRunId, writeJsonAtomic, RUN_SUMMARY_SCHEMA } from '../src/ledger.ts';
import { runAutotrade, type RunSessionFactory } from '../src/runner.ts';
import { RunnerSafety, auditRun, clearControl, clearStaleControl, controlPath, listRunIds, readControl, requestControl, sessionIsolation, type SafetyVerdict } from '../src/safety.ts';

const T0 = 1_792_000_000_000;
const MIN = 60_000;
const A = 'Aaaa1111111111111111111111111111111111111111';
const B = 'Bbbb1111111111111111111111111111111111111111';
const home = () => mkdtempSync(join(tmpdir(), 'at1509-'));

function tick(over: Partial<MarketTick> = {}): MarketTick {
  return {
    mint: A, t: T0, kind: 'live', symbol: 'TEST', launchpad: 'pump.fun', createdAt: T0 - 3 * 3600e3,
    price: 1, mcap: 1e6, mcapResolved: 1e6, mcapFlagged: false, liq: 100_000, vol5m: 10_000, vol1h: 50_000, vol24: 500_000,
    buys5m: 120, sells5m: 80, buys24: 5000, sells24: 4000, chg5m: 4, chg1h: 20, chg6h: 40, chg24h: 80,
    holders: 900, top10: 20, dev: 1, mintAuth: false, freezeAuth: false, org: 70, ...over,
  };
}

/** Enters on the dossier, holds on every event. */
const goer: RunSessionFactory = (id): AgentSession => {
  let n = 0;
  return {
    id, kind: 'stub', costUsd: () => 0,
    async send(text) { n++; const t = text.startsWith('EVENT') ? 'DECISION {"action":"hold","reason":"ok"}' : 'DECISION {"action":"enter","reason":"go"}'; return { text: t, decision: parseDecision(t), costUsd: 0, ms: 0 }; },
    async close(reason) { return { turns: n, costUsd: 0, reason }; },
  };
};

const at = (min: number, over: Partial<MarketTick> = {}) => tick({ t: T0 + min * MIN, ...over });
const kinds = (evs: { kind: string }[]) => evs.map((e) => e.kind);

test('1509 control file: run-scoped; a stop is final (pause/resume refused, a flatten escalates); unreadable fails closed', () => {
  const h = home();
  assert.equal(readControl(h), null);
  const w = requestControl(h, 'run-a', 'pause', 'cli', T0);
  assert.ok(w.ok && !w.already);
  assert.deepEqual(readControl(h), { schema: 'dexterm-autotrade-control/1', runId: 'run-a', action: 'pause', at: T0, by: 'cli' });
  assert.ok(requestControl(h, 'run-a', 'resume-entries', 'tui').ok, 'a pause lifts');
  assert.ok(requestControl(h, 'run-a', 'stop', 'cli').ok);
  const again = requestControl(h, 'run-a', 'stop', 'cli');
  assert.ok(again.ok && again.already, 'a second stop is a no-op');
  for (const a of ['pause', 'resume-entries'] as const) {
    const r = requestControl(h, 'run-a', a, 'tui');
    assert.ok(!r.ok, `${a} cannot lift a stop`);
  }
  assert.ok(requestControl(h, 'run-a', 'flatten', 'cli').ok, 'stop → flatten escalates');
  const back = requestControl(h, 'run-a', 'stop', 'cli');
  assert.ok(back.ok && back.already && back.request.action === 'flatten', 'flatten is never downgraded to a stop');
  // A request for another run never applies; a new run clears it at start.
  assert.ok(clearStaleControl(h, 'run-b'));
  assert.equal(readControl(h), null);
  requestControl(h, 'run-b', 'stop', 'cli');
  clearControl(h, 'run-c');
  assert.notEqual(readControl(h), null, 'clearControl only removes its own run');
  clearControl(h, 'run-b');
  assert.equal(readControl(h), null);
  writeFileSync(controlPath(h), '{not json');
  assert.equal(readControl(h), 'unreadable');
  assert.equal(clearStaleControl(h, 'run-d'), false, 'a new run refuses to start over an unreadable control file');
  const v = new RunnerSafety({ home: h, runId: 'run-d' }).step();
  assert.equal(v.halt, 'control-unreadable');
  assert.equal(v.endWhenFlat, true);
});

test('1509 RunnerSafety: the panic halt is sticky (a released file does not resume the run); dead-man pauses lift by themselves', () => {
  const h = home();
  let panic: { reason: string } | null = null;
  let age = 0;
  let monitor = true;
  const s = new RunnerSafety({ home: h, runId: 'r1', killSwitch: { engaged: () => panic }, heartbeatAgeMs: () => age, monitorAlive: () => monitor });
  assert.deepEqual(s.step(), { halt: null, flatten: false, pauseEntries: null, endWhenFlat: false });
  age = 31_000;
  assert.equal(s.step().pauseEntries, 'heartbeat-stale');
  age = 0; monitor = false;
  assert.equal(s.step().pauseEntries, 'monitor-heartbeat-stale');
  monitor = true;
  assert.equal(s.step().pauseEntries, null);
  requestControl(h, 'other-run', 'stop', 'cli');
  assert.equal(s.step().halt, null, 'a request for another run is ignored');
  requestControl(h, 'r1', 'pause', 'tui');
  assert.equal(s.step().pauseEntries, 'paused');
  panic = { reason: 'manual panic' };
  const v = s.step();
  assert.equal(v.halt, 'kill-switch');
  assert.match(v.detail!, /manual panic/);
  assert.equal(v.endWhenFlat, false, 'the panic alone keeps the runner up (exits keep running)');
  panic = null;
  assert.equal(s.step().halt, 'kill-switch', 'removing the panic file never resumes this run');
  requestControl(h, 'r1', 'stop', 'cli');
  const w = s.step();
  assert.equal(w.halt, 'kill-switch');
  assert.equal(w.endWhenFlat, true, 'a stop after a panic still ends the run once flat');
});

test('1509 stop: no new entries, sessions closed, orders dropped; the hard stop still sells; the run ends once flat', async () => {
  const h = home();
  const s = loadPreset('scalp');
  const runId = 'r-stop';
  const safety = new RunnerSafety({ home: h, runId });
  let asked = false;
  const ticks = [at(0), at(1), at(2), at(3), at(3, { mint: B }), at(4, { mint: B }), at(5, { price: 0.5 }), at(6, { mint: B }), at(10), at(10, { mint: B })];
  const r = await runAutotrade({
    strategy: s, tape: { source: 'synthetic', ticks, mints: [A, B] }, sessions: goer,
    safety: () => safety.step(),
    onState: (st) => { if (!asked && st.positions.length) { asked = true; requestControl(h, runId, 'stop', 'cli'); } },
  });
  const ev = r.ledger.events;
  const halt = ev.find((e) => e.kind === 'halt')!;
  assert.equal(halt.reason, 'stop');
  assert.equal(halt.openPositions, 1);
  assert.ok(ev.some((e) => e.kind === 'session_end' && e.reason === 'stop' && e.seq > halt.seq), 'the live session closed at the halt');
  assert.equal(ev.filter((e) => e.kind === 'candidate' && e.seq > halt.seq).length, 0, 'coin B matched after the stop: no candidate');
  const sell = ev.find((e) => e.kind === 'fill' && e.side === 'sell' && e.seq > halt.seq)!;
  assert.ok(sell, 'the mechanical exit still ran after the stop');
  assert.notEqual(sell.reason, 'flatten');
  assert.ok(ev.some((e) => e.kind === 'stopped_flat'), 'the run ended once nothing was held');
  const end = ev[ev.length - 1];
  assert.equal(end.kind, 'run_end');
  assert.ok(end.t < T0 + 10 * MIN, 'the ticks after flat were never processed');
  assert.equal(r.trades.length, 1);
});

test('1509 flatten: every position sells at its next tick; a stuck one is retried every tick until it sells', async () => {
  const h = home();
  const s = loadPreset('scalp');
  const runId = 'r-flat';
  const safety = new RunnerSafety({ home: h, runId });
  let asked = false;
  // The request lands after the fill at t+1, so the flatten starts at t+2, where the pool is pulled until t+4.
  const ticks = [at(0), at(1), at(2, { liq: 10 }), at(3, { liq: 10 }), at(4), at(9)];
  const r = await runAutotrade({
    strategy: s, tape: { source: 'synthetic', ticks, mints: [A] }, sessions: goer,
    safety: () => safety.step(),
    onState: (st) => { if (!asked && st.positions.length) { asked = true; requestControl(h, runId, 'flatten', 'tui'); } },
  });
  const ev = r.ledger.events;
  const order = kinds(ev);
  assert.ok(order.indexOf('halt') < order.indexOf('flatten'));
  assert.equal(ev.find((e) => e.kind === 'halt')!.reason, 'flatten');
  const stuck = ev.filter((e) => e.kind === 'stuck');
  assert.equal(stuck.length, 1, 'the pulled pool is stuck once (logged once, retried silently)');
  assert.equal(stuck[0].reason, 'flatten');
  const sells = ev.filter((e) => e.kind === 'fill' && e.side === 'sell');
  assert.equal(sells.length, 1);
  assert.equal(sells[0].reason, 'flatten');
  assert.equal(sells[0].t, T0 + 4 * MIN, 'sold at the first tick with liquidity back');
  assert.equal(r.trades[0].exitReason, 'flatten');
  assert.ok(order.includes('stopped_flat'));
  assert.ok(ev[ev.length - 1].t < T0 + 9 * MIN);
});

test('1509 pause: no new candidates while paused; entries resume after', async () => {
  const s = loadPreset('scalp');
  let n = 0;
  const pauseFor = new Set([2, 3, 4]);
  const r = await runAutotrade({
    strategy: s, tape: { source: 'synthetic', ticks: [at(0, { mint: B }), at(1, { mint: A }), at(2, { mint: A }), at(3, { mint: A }), at(4, { mint: A }), at(5, { mint: A }), at(6, { mint: A })], mints: [A, B] }, sessions: goer,
    safety: (): SafetyVerdict => { n++; return { halt: null, flatten: false, pauseEntries: pauseFor.has(n) ? 'paused' : null, endWhenFlat: false }; },
  });
  const ev = r.ledger.events;
  const p = ev.find((e) => e.kind === 'entries_paused')!;
  const q = ev.find((e) => e.kind === 'entries_resumed')!;
  assert.ok(p && q && p.seq < q.seq);
  assert.equal(ev.filter((e) => e.kind === 'candidate' && e.seq > p.seq && e.seq < q.seq).length, 0);
  assert.ok(ev.some((e) => e.kind === 'candidate' && e.mint === A && e.seq > q.seq), 'coin A becomes a candidate after the resume');
});

test('1509 pause: an enter that lands while entries are paused is refused and logged, and nothing is bought', async () => {
  const s = loadPreset('scalp');
  let n = 0;
  const waitThenEnter: RunSessionFactory = (id): AgentSession => ({
    id, kind: 'stub', costUsd: () => 0,
    async send(text) { const t = text.startsWith('DELTA') ? 'DECISION {"action":"enter","reason":"now"}' : 'DECISION {"action":"wait","reason":"watching"}'; return { text: t, decision: parseDecision(t), costUsd: 0, ms: 0 }; },
    async close(reason) { return { turns: 1, costUsd: 0, reason }; },
  });
  const ticks = [0, 20, 40, 60].map((sec) => tick({ t: T0 + sec * 1000, price: 1 + sec / 1000 }));
  const r = await runAutotrade({
    strategy: s, tape: { source: 'synthetic', ticks, mints: [A] }, sessions: waitThenEnter,
    safety: (): SafetyVerdict => { n++; return { halt: null, flatten: false, pauseEntries: n >= 2 ? 'paused' : null, endWhenFlat: false }; },
  });
  const ev = r.ledger.events;
  assert.ok(ev.some((e) => e.kind === 'refused' && e.rule === 'entries-paused'));
  assert.equal(ev.filter((e) => e.kind === 'clamp').length, 0);
  assert.equal(ev.filter((e) => e.kind === 'fill').length, 0);
});

test('1509 audit: a clean ledger verifies; an edited, reordered or cut-off ledger is named with its first bad event', () => {
  const h = home();
  const mk = (n: number) => {
    const id = newRunId('scalp', T0 + n * 1000, `00${n}a`.slice(-4));
    const { ledger, files } = fileLedger(h, id);
    ledger.add(T0, 'run_start', { strategy: 'scalp', version: '1.0.0', strategyHash: 'abc', mode: 'paper' });
    for (let i = 0; i < 5; i++) ledger.add(T0 + i, 'candidate', { mint: A, i });
    ledger.add(T0 + 9, 'run_end', { head: ledger.head() });
    writeJsonAtomic(files.summary, { schema: RUN_SUMMARY_SCHEMA, runId: id, events: ledger.events.length, ledgerHead: ledger.head() });
    return { id, files };
  };
  const ok = mk(1);
  const a = auditRun(h, ok.id);
  assert.ok(a.ok && a.ended && a.events === 7 && a.summary?.matches);
  assert.deepEqual(a.strategy, { id: 'scalp', version: '1.0.0', hash: 'abc' });

  const edited = mk(2);
  const lines = readFileSync(edited.files.ledger, 'utf8').trim().split('\n');
  writeFileSync(edited.files.ledger, `${lines.map((l, i) => (i === 3 ? l.replace('"i":2', '"i":7') : l)).join('\n')}\n`);
  const e = auditRun(h, edited.id);
  assert.ok(!e.ok);
  assert.equal(e.brokenAt, 4);
  assert.match(e.error!, /edited/);

  const reordered = mk(3);
  const l3 = readFileSync(reordered.files.ledger, 'utf8').trim().split('\n');
  [l3[2], l3[3]] = [l3[3], l3[2]];
  writeFileSync(reordered.files.ledger, `${l3.join('\n')}\n`);
  assert.equal(auditRun(h, reordered.id).brokenAt, 3);

  const cut = mk(4);
  const l4 = readFileSync(cut.files.ledger, 'utf8').trim().split('\n');
  writeFileSync(cut.files.ledger, `${l4.slice(0, 4).join('\n')}\n`);
  const c = auditRun(h, cut.id);
  assert.ok(!c.ok, 'a chain cut at the end still verifies on its own; the summary catches it');
  assert.equal(c.ended, false);
  assert.match(c.error!, /cut from the end/);
  assert.deepEqual(listRunIds(h), [ok.id, edited.id, reordered.id, cut.id]);
});

test('1509 isolation: the init event counts tools, MCP servers, plugins, agents, skills and slash commands; only no tools and no MCP pass', () => {
  // The shape a real `claude -p` stream-json init had in the task-1498 spike (names generalised).
  const init = { type: 'system', subtype: 'init', tools: [], mcp_servers: [], slash_commands: [], skills: [], agents: ['general', 'explore', 'plan', 'statusline'], plugins: [{ name: 'p1', path: 'builtin', source: 'p1@builtin' }, { name: 'p2', path: 'builtin', source: 'p2@builtin' }, { name: 'p3', path: 'builtin', source: 'p3@builtin' }] };
  assert.deepEqual(sessionIsolation(init), { tools: 0, mcpServers: 0, plugins: 3, agents: 4, skills: 0, slashCommands: 0, ok: true });
  assert.equal(sessionIsolation({ ...init, tools: ['Bash'] }).ok, false);
  assert.equal(sessionIsolation({ ...init, mcp_servers: [{ name: 'x' }] }).ok, false);
  assert.equal(sessionIsolation({}).ok, false, 'a missing tool list is not proof of none');
});
