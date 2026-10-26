// task-1508 AUTOTRADE (paper) Q screen: the five views, the keys, save-only-when-valid, undo through the patch
// inverses, and that nothing on the screen reaches live mode or the signer. Fixtures only: a temp strategy home,
// the committed engine tape, an inline runner status document. Goldens: test/snapshots/autotrade-*.txt
// (regenerate with UPDATE_SNAPSHOTS=1 after an intended layout change, then read the diff).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_KEYMAP, THEMES, parseKeys } from '@dexterm/tui';
import { StrategyStore, loadTape, type FleetStatus } from '@dexterm/autotrade';
import { makeFixtureState, renderFrame, FIXTURE_NOW } from '../src/state.ts';
import { applyAction, applyKey } from '../src/main.ts';
import {
  READ_ONLY_PATHS, RUNNER_SCHEMA, STUB_CONTROL, fieldsOf, newAutotradeUi, reloadList, readRunnerRendezvous, defaultGrid,
  type AutotradeDeps, type RunnerControl, type RunnerRead, type RunnerSnapshot, type StrategyProposal,
} from '../src/screens/autotrade-ui.ts';
import { inlineJobs } from '../src/screens/autotrade-worker.ts';

const here = dirname(fileURLToPath(import.meta.url));
const snapDir = resolve(here, 'snapshots');
const UPDATE = process.env.UPDATE_SNAPSHOTS === '1';
const tape = loadTape(new URL('../../autotrade/test/fixtures/autotrade-1498-tape.json', import.meta.url));
const NOW = FIXTURE_NOW.getTime();
const RUNNER_PATH = '/tmp/dexterm-home/autotrade/runner.json';

const runnerFixture = (o: Partial<RunnerSnapshot> = {}): RunnerSnapshot => ({
  schema: RUNNER_SCHEMA, pid: 4242, state: 'running', mode: 'paper', startedAt: NOW - 3_600_000, heartbeatAt: NOW - 4_000, haltReason: null,
  strategy: { id: 'moonbag', version: '1.0.0', hash: '0123456789abcdef' },
  book: { startUsd: 1000, equityUsd: 1012.4, cashUsd: 961.9, realizedTodayUsd: 8.1 },
  spend: { todayUsd: 0.42, dayCapUsd: 10 },
  candidates: [{ mint: 'MintAAAA1111', symbol: 'ALPHA', ageSec: 95, matched: ['screen', 'momentum'], session: 's-1' }, { mint: 'MintBBBB2222', symbol: 'BRAVO', ageSec: 30, matched: ['screen'], session: null }],
  sessions: [{ id: 's-1', mint: 'MintAAAA1111', symbol: 'ALPHA', turns: 3, costUsd: 0.11, budgetUsd: 0.5, lastDecision: 'wait · liquidity still thin' }],
  positions: [{ mint: 'MintCCCC3333', symbol: 'CHARLIE', profile: 'moonbag', costUsd: 20, pnlUsd: 4.4, pnlPct: 22, next: 'cost back at +100%' }, { mint: 'MintDDDD4444', symbol: 'DELTA', profile: 'moonbag', costUsd: 0, pnlUsd: 31.2, pnlPct: 156, next: 'bag trail 55% from peak', freeBag: true }],
  ledgerTail: [
    { seq: 118, t: NOW - 60_000, kind: 'candidate', text: 'ALPHA matched screen · momentum' },
    { seq: 119, t: NOW - 40_000, kind: 'decision', text: 'ALPHA wait (liquidity still thin)' },
    { seq: 120, t: NOW - 20_000, kind: 'refusal', text: 'BRAVO refused: maxConcurrent' },
  ],
  ...o,
});

interface Harness { state: ReturnType<typeof makeFixtureState>; home: string; store: StrategyStore; stack: never[]; runner: { read: RunnerRead }; calls: string[] }

function harness(o: { proposals?: StrategyProposal[]; control?: RunnerControl; fleet?: () => FleetStatus | null } = {}): Harness {
  const home = mkdtempSync(join(tmpdir(), 'autotrade-ui-1508-'));
  const store = new StrategyStore({ home, now: () => NOW });
  const runner: { read: RunnerRead } = { read: { kind: 'none', path: RUNNER_PATH } };
  const calls: string[] = [];
  const deps: AutotradeDeps = {
    store, jobs: inlineJobs(() => tape), readRunner: () => runner.read, control: o.control ?? STUB_CONTROL,
    proposals: () => o.proposals ?? [], exportDir: join(home, 'exports'), now: () => NOW,
    ...(o.fleet ? { readFleet: o.fleet } : {}),
  };
  const state = makeFixtureState({ theme: THEMES.midnight, calm: true });
  state.autotradeUi = newAutotradeUi(deps);
  const stack: never[] = [];
  applyAction(state, 'screen.autotrade', stack);
  return { state, home, store, stack, runner, calls };
}

const act = (h: Harness, ...actions: Parameters<typeof applyAction>[1][]): void => { for (const a of actions) applyAction(h.state, a, h.stack); };
const type = (h: Harness, text: string): void => { for (const k of parseKeys(text)) applyKey(h.state, k, h.stack); };
const ui = (h: Harness) => h.state.autotradeUi!;
const frame = (h: Harness, w = 120, ht = 40): string => { const f = renderFrame(h.state, w, ht).toPlain(); if (process.env.DEBUG_FRAMES) console.log(f); return f; };
const settle = () => new Promise((r) => setTimeout(r, 0));
async function until(pred: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 400 && !pred(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(pred(), `timed out: ${label}`);
}

function snapshot(name: string, got: string, w = 120, h = 40): void {
  const rows = got.split('\n');
  assert.equal(rows.length, h, `${name}: ${rows.length} rows`);
  for (const r of rows) assert.ok([...r].length <= w, `${name}: a row wider than ${w}`);
  const path = resolve(snapDir, `autotrade-${name}-${w}x${h}.txt`);
  if (UPDATE || !existsSync(path)) { writeFileSync(path, got + '\n'); if (!UPDATE) assert.fail(`wrote missing golden ${path}: re-run`); return; }
  assert.equal(got, readFileSync(path, 'utf8').replace(/\n$/, ''), `${name} differs from its golden (UPDATE_SNAPSHOTS=1 to accept an intended change)`);
}

/** Select a list row by id (presets first, then the user's files). */
function select(h: Harness, id: string, source?: 'user' | 'preset'): void {
  const i = ui(h).entries.findIndex((e) => e.id === id && (!source || e.source === source));
  assert.ok(i >= 0, `${id} is on the list`);
  ui(h).selected = i;
}

function selectField(h: Harness, path: string): void {
  const i = ui(h).editor!.fields.findIndex((f) => f.path === path);
  assert.ok(i >= 0, `field ${path}`);
  ui(h).editor!.selected = i;
}

// ───────────────────────────── keys ─────────────────────────────

test('keymap: Q opens autotrade from anywhere, every autotrade verb is bound, and no scope binds a key twice', () => {
  assert.equal(DEFAULT_KEYMAP.resolveId('Q'), 'screen.autotrade');
  for (const s of ['screener', 'token', 'positions', 'plans', 'rules'] as const) assert.equal(DEFAULT_KEYMAP.resolveId('Q', s), 'screen.autotrade', `Q on ${s}`);
  const want = ['autotrade.view', 'autotrade.new', 'autotrade.dup', 'autotrade.edit', 'autotrade.compare', 'autotrade.backtest', 'autotrade.sweep', 'autotrade.export', 'autotrade.import', 'autotrade.run', 'autotrade.save', 'autotrade.undo', 'autotrade.kill', 'autotrade.pause', 'autotrade.flatten', 'autotrade.proposal',
    'autotrade.journey', 'autotrade.forward', 'autotrade.forwardstop', 'autotrade.promote']; // task-1647: the journey view
  const ours = DEFAULT_KEYMAP.bindings.filter((b) => b.screen === 'autotrade');
  assert.deepEqual(ours.map((b) => b.action).sort(), [...want].sort());
  assert.deepEqual(Object.fromEntries(ours.map((b) => [b.action, b.keys.join(',')])), {
    'autotrade.view': 'tab', 'autotrade.new': 'n', 'autotrade.dup': 'd', 'autotrade.edit': 'e', 'autotrade.compare': 'c', 'autotrade.backtest': 'b', 'autotrade.sweep': 'w',
    'autotrade.export': 'x', 'autotrade.import': 'i', 'autotrade.run': 'r', 'autotrade.save': 's', 'autotrade.undo': 'u', 'autotrade.kill': '!', 'autotrade.pause': 'p', 'autotrade.flatten': 'f',
    'autotrade.proposal': 'o', // task-1507: review a chat proposal
    'autotrade.journey': 'J', 'autotrade.forward': 'F', 'autotrade.forwardstop': 'X', 'autotrade.promote': 'A', // task-1647
  });
  // collisions: inside one scope (global, or one screen) a key id resolves to exactly one binding
  const scopes = new Map<string, Map<string, string>>();
  for (const b of DEFAULT_KEYMAP.bindings) {
    const scope = b.screen ?? '(global)';
    const m = scopes.get(scope) ?? new Map<string, string>();
    for (const k of b.keys) {
      assert.ok(!m.has(k), `key ${k} is bound twice in ${scope}: ${m.get(k)} and ${b.action}`);
      m.set(k, b.action);
    }
    scopes.set(scope, m);
  }
  // Q was unbound everywhere before this card (it is only the global key now)
  assert.equal(DEFAULT_KEYMAP.bindings.filter((b) => b.keys.includes('Q')).length, 1);
  // the movement and back keys the views rely on still resolve on the screen
  for (const [k, a] of [['j', 'move.down'], ['k', 'move.up'], ['enter', 'open'], ['esc', 'back'], ['q', 'quit']] as const) assert.equal(DEFAULT_KEYMAP.resolveId(k, 'autotrade'), a);
});

// ───────────────────────────── views ─────────────────────────────

test('strategies list: presets + the user\'s files with mode, version, hash and the last backtest', () => {
  const h = harness();
  assert.equal(h.state.screen, 'autotrade');
  assert.equal(ui(h).view, 'list');
  const ids = ui(h).entries.map((e) => e.id);
  assert.deepEqual(ids, ['moonbag', 'runner', 'sample-dip-ladder', 'scalp', 'swing', 'yolo']);
  snapshot('list', frame(h));
  const f = frame(h, 176, 48);
  assert.ok(f.includes('PROPOSALS FROM CHAT · 0'));
  assert.ok(f.includes(' PAPER '));
});

test('n / d create the user\'s own copy (journaled), the list marks it yours, esc cancels and q never quits while typing', () => {
  const h = harness();
  select(h, 'swing');
  act(h, 'autotrade.new');
  assert.equal(ui(h).input?.text, 'swing-copy');
  type(h, '\x15fast-swingq'); // ctrl+u clears; q is typed into the id, never quits
  assert.equal(ui(h).input?.text, 'fast-swingq');
  type(h, '\x7f\r');
  assert.match(ui(h).notice ?? '', /created fast-swing v1\.0\.0 from swing/);
  assert.equal(h.state.screen, 'autotrade');
  const j = h.store.journal('fast-swing');
  assert.equal(j.length, 1);
  assert.equal(j[0].actor, 'user');
  assert.equal(j[0].from, 'swing');
  assert.equal(ui(h).entries[ui(h).selected].id, 'fast-swing');
  // d duplicates a user file too; esc cancels a half-typed id
  act(h, 'autotrade.dup');
  type(h, '\x1b');
  assert.equal(ui(h).input, null);
  assert.equal(h.store.userIds().length, 1);
  // an id that could walk out of the directory cannot even be typed
  act(h, 'autotrade.dup');
  type(h, '\x15../../x/Y\r');
  assert.match(ui(h).notice ?? '', /created xy|bad id/);
  for (const id of h.store.userIds()) assert.match(id, /^[a-z][a-z0-9-]{1,31}$/);
});

test('editor: six sections, live per-field validation with the screen filter\'s error column, save only when valid (a new version)', () => {
  const h = harness();
  select(h, 'scalp');
  act(h, 'autotrade.dup');
  type(h, '\x15my-scalp\r');
  act(h, 'autotrade.edit');
  const ed = () => ui(h).editor!;
  assert.equal(ui(h).view, 'editor');
  assert.deepEqual([...new Set(ed().fields.map((f) => f.section))], ['entry', 'exits', 'risk', 'sizing', 'agent', 'execution']);
  snapshot('editor', frame(h));

  // the screen filter: a typo is caught at its column while typing (the screener's own parser), nothing is written
  selectField(h, '/entry/screen');
  act(h, 'open');
  type(h, ' vol5x >= 5K');
  const ty = ed().typing!;
  assert.equal(ty.check?.ok, false);
  const err = ty.check && !ty.check.ok ? ty.check.errors.find((e) => e.path === '/entry/screen') : undefined;
  assert.match(err?.msg ?? '', /column \d+/);
  snapshot('editor-typing-screen-error', frame(h));
  type(h, '\r'); // the bad value is set in the draft …
  assert.equal(ed().check.ok, false);
  act(h, 'autotrade.save'); // … and save refuses it
  assert.match(ui(h).notice ?? '', /^not saved: 1 problem/);
  assert.equal(h.store.raw('my-scalp')!.version, '1.0.0');
  act(h, 'autotrade.undo');
  assert.equal(ed().check.ok, true);

  // a numeric field: out of range is an inline error, in range saves as a new version with the op + inverse journaled
  selectField(h, '/sizing/maxPctOfBankroll');
  act(h, 'open');
  type(h, '\x1599\r');
  assert.equal(ed().check.ok, false);
  const c1 = ed().check;
  assert.ok(!c1.ok && c1.errors.some((e) => e.path === '/sizing/maxPctOfBankroll'));
  act(h, 'open');
  type(h, '\x158\r');
  assert.equal(ed().check.ok, true);
  act(h, 'autotrade.save');
  assert.match(ui(h).notice ?? '', /^saved my-scalp v1\.0\.1 \([0-9a-f]{16}\) · 1 change journaled/);
  const raw = h.store.raw('my-scalp')!;
  assert.equal(raw.version, '1.0.1');
  assert.equal(raw.sizing.maxPctOfBankroll, 8);
  const top = h.store.journal('my-scalp').at(-1)!;
  assert.equal(top.action, 'patch');
  assert.deepEqual(top.ops, [{ op: 'replace', path: '/sizing/maxPctOfBankroll', value: 8 }]);
  assert.deepEqual(top.inverse, [{ op: 'replace', path: '/sizing/maxPctOfBankroll', value: 10 }]);
  act(h, 'autotrade.save');
  assert.match(ui(h).notice ?? '', /nothing to save/);
});

test('undo: an unsaved edit goes back through its inverse; with nothing unsaved the last saved patch is undone as a new version', () => {
  const h = harness();
  select(h, 'swing');
  act(h, 'autotrade.dup');
  type(h, '\x15undo-me\r');
  act(h, 'autotrade.edit');
  const ed = () => ui(h).editor!;
  selectField(h, '/risk/maxConcurrent');
  act(h, 'open'); type(h, '\x154\r');
  selectField(h, '/agent/maxTurns');
  act(h, 'open'); type(h, '\x157\r');
  assert.equal(ed().edits.length, 2);
  act(h, 'autotrade.undo');
  assert.match(ui(h).notice ?? '', /undid \/agent\/maxTurns/);
  assert.equal(ed().edits.length, 1);
  assert.notEqual(ed().draft.agent.maxTurns, 7);
  act(h, 'autotrade.save');
  assert.equal(h.store.raw('undo-me')!.risk.maxConcurrent, 4);
  act(h, 'autotrade.undo'); // nothing unsaved → the saved patch, inverted, as v1.0.2
  assert.match(ui(h).notice ?? '', /undid v1\.0\.1 → saved as v1\.0\.2/);
  const back = h.store.raw('undo-me')!;
  assert.equal(back.version, '1.0.2');
  assert.equal(back.risk.maxConcurrent, h.store.raw('swing')!.risk.maxConcurrent);
  assert.match(h.store.journal('undo-me').at(-1)!.why ?? '', /undo of v1\.0\.1/);
  // a file changed outside since the last edit: undo refuses rather than clobbering it
  const doc = { ...h.store.raw('undo-me')!, version: '1.0.3', name: 'changed outside' };
  h.store.update('undo-me', doc, { actor: 'user' });
  ui(h).editor = null;
  act(h, 'back');
  select(h, 'undo-me');
  act(h, 'autotrade.edit');
  act(h, 'autotrade.undo');
  assert.match(ui(h).notice ?? '', /nothing to undo/);
});

test('a shipped preset opens as a read-only draft: save is refused and nothing is written', () => {
  const h = harness();
  select(h, 'moonbag');
  act(h, 'autotrade.edit');
  assert.match(ui(h).notice ?? '', /shipped preset \(read-only\)/);
  selectField(h, '/risk/maxConcurrent');
  act(h, 'open'); type(h, '\x152\r');
  act(h, 'autotrade.save');
  assert.match(ui(h).notice ?? '', /shipped preset \(read-only\)/);
  assert.equal(h.store.userIds().length, 0);
});

test('compare: two marked strategies side by side, changed fields first, both backtested on the same tape', async () => {
  const h = harness();
  select(h, 'scalp'); act(h, 'autotrade.compare');
  assert.match(ui(h).notice ?? '', /marked scalp/);
  select(h, 'swing'); act(h, 'autotrade.compare');
  assert.equal(ui(h).view, 'compare');
  assert.ok(frame(h).includes('FIELDS · '));
  act(h, 'autotrade.backtest');
  await until(() => ui(h).compareRun?.status === 'done', 'compare backtest');
  const [a, b] = ui(h).compareRun!.result!;
  assert.deepEqual(a.report.tape, b.report.tape, 'one tape for both');
  snapshot('compare', frame(h));
  // the list now shows both last backtests
  act(h, 'back');
  assert.ok(ui(h).entries.find((e) => e.id === 'scalp')!.lastBacktest);
});

test('backtest view: the report (attribution, equity, clamps/refusals, limits) and a sweep with the held-out verdict', async () => {
  const h = harness();
  select(h, 'scalp');
  act(h, 'autotrade.backtest');
  assert.equal(ui(h).view, 'backtest');
  assert.ok(frame(h).includes('running…'));
  await until(() => [...ui(h).backtests.values()].every((j) => j.status !== 'running'), 'backtest');
  const job = [...ui(h).backtests.values()][0];
  assert.equal(job.status, 'done', job.error);
  const f = frame(h);
  for (const want of ['BY EXIT RULE', 'BY PROFILE', 'BY TRIGGER', 'equity', 'clamps fired', 'refusals', 'LIMITS', 'read the counts, not the rates']) assert.ok(f.includes(want), want);
  snapshot('backtest', f);
  act(h, 'autotrade.sweep');
  await until(() => ui(h).sweep?.status !== 'running', 'sweep');
  assert.equal(ui(h).sweep!.status, 'done', ui(h).sweep!.error);
  assert.match(ui(h).sweep!.result!.verdict, /no tuning claim|no edge|keep the strategy|held-out gain/);
  const g = frame(h);
  assert.ok(g.includes('VERDICT: '));
  assert.ok(g.includes('held-out = newest 30% of coins'));
  snapshot('backtest-sweep', g);
  // the grid is the default profile's own knobs, three values around the current one
  const moon = defaultGrid(h.store.get('moonbag')!.ok ? (h.store.get('moonbag') as { strategy: Parameters<typeof defaultGrid>[0] }).strategy : (null as never));
  assert.deepEqual(moon, { 'profile.costRecovery.atPct': [67, 100, 150], 'profile.bagTrail.trailPct': [37, 55, 83] });
});

test('runner view: nothing running, a fixture status file, a stale heartbeat, a malformed or non-paper file', () => {
  const h = harness();
  act(h, 'autotrade.run');
  assert.equal(ui(h).view, 'runner');
  snapshot('runner-none', frame(h));
  h.runner.read = { kind: 'ok', path: RUNNER_PATH, snap: runnerFixture(), readAt: NOW };
  act(h, 'autotrade.run');
  const f = frame(h);
  for (const want of ['RUNNING · moonbag', 'CANDIDATES · 2', 'SESSIONS · 1', 'POSITIONS · 2', 'RUN LEDGER', 'free bag', 'model spend $0.42 of $10.00']) assert.ok(f.includes(want), want);
  snapshot('runner', f);
  h.runner.read = { kind: 'ok', path: RUNNER_PATH, snap: runnerFixture({ heartbeatAt: NOW - 95_000 }), readAt: NOW };
  act(h, 'autotrade.run');
  assert.ok(frame(h).includes('STALE'));
  // the reader: only the paper shape is accepted
  const dir = mkdtempSync(join(tmpdir(), 'autotrade-rdv-'));
  const p = join(dir, 'runner.json');
  assert.equal(readRunnerRendezvous(p).kind, 'none');
  writeFileSync(p, JSON.stringify(runnerFixture()));
  assert.equal(readRunnerRendezvous(p).kind, 'ok');
  writeFileSync(p, JSON.stringify({ ...runnerFixture(), mode: 'live' }));
  const bad = readRunnerRendezvous(p);
  assert.equal(bad.kind, 'bad');
  assert.match(bad.kind === 'bad' ? bad.error : '', /paper runners only/);
  writeFileSync(p, '{"schema":"something-else"}');
  assert.equal(readRunnerRendezvous(p).kind, 'bad');
  writeFileSync(p, 'not json');
  assert.equal(readRunnerRendezvous(p).kind, 'bad');
});

test('! / p / f: no runner says so; a runner goes to RunnerControl (the stub until the stop/flatten commands land); f needs y', () => {
  const calls: string[] = [];
  const control: RunnerControl = { wired: true, kill: () => { calls.push('kill'); return 'stopped'; }, pause: () => { calls.push('pause'); return 'paused'; }, flatten: () => { calls.push('flatten'); return 'flattening'; } };
  const h = harness({ control });
  act(h, 'autotrade.kill');
  assert.match(ui(h).notice ?? '', /no autotrade runner is running/);
  assert.deepEqual(calls, []);
  h.runner.read = { kind: 'ok', path: RUNNER_PATH, snap: runnerFixture(), readAt: NOW };
  act(h, 'autotrade.kill', 'autotrade.pause');
  assert.deepEqual(calls, ['kill', 'pause']);
  act(h, 'autotrade.flatten');
  assert.ok(ui(h).confirm);
  snapshot('flatten-confirm', frame(h));
  type(h, 'n');
  assert.equal(ui(h).confirm, null);
  assert.match(ui(h).notice ?? '', /flatten cancelled/);
  assert.deepEqual(calls, ['kill', 'pause']);
  act(h, 'autotrade.flatten');
  type(h, 'q'); // any key but y cancels, and q does not quit from the confirm
  assert.equal(h.state.screen, 'autotrade');
  assert.deepEqual(calls, ['kill', 'pause']);
  act(h, 'autotrade.flatten');
  type(h, 'y');
  assert.deepEqual(calls, ['kill', 'pause', 'flatten']);
  // the shipped control is the stub: it says what is not wired and does nothing
  assert.equal(STUB_CONTROL.wired, false);
  assert.match(STUB_CONTROL.kill(), /not wired/);
  assert.match(STUB_CONTROL.flatten(), /nothing was sold/);
});

test('chat proposals render as cards (LOOSER in the warn slot) and are never applied from this screen', () => {
  const p: StrategyProposal = {
    proposalId: 'p-1', id: 'scalp', beforeHash: 'aaaaaaaaaaaaaaaa', afterHash: 'bbbbbbbbbbbbbbbb', riskDelta: 'looser', why: 'faster exits',
    diff: ['- /exits/profiles/0/trailingStop/trailPct 15', '+ /exits/profiles/0/trailingStop/trailPct 25'], validation: { ok: true, errors: [] },
  };
  const h = harness({ proposals: [p] });
  const f = frame(h, 176, 48);
  assert.ok(f.includes('PROPOSALS FROM CHAT · 1'));
  assert.ok(f.includes('LOOSER'));
  assert.ok(f.includes('+ /exits/profiles/0/trailingStop/trailPct 25'));
  snapshot('list-proposal', f, 176, 48);
  // no key on the screen applies it: every autotrade verb leaves the presets and the store untouched
  for (const a of ['autotrade.save', 'autotrade.undo', 'autotrade.export'] as const) act(h, a);
  assert.equal(h.store.userIds().length, 0);
});

// ───────────────────────────── no path to live or the signer ─────────────────────────────

test('no path from the Q screen to live mode or the signer', () => {
  const h = harness();
  // the editor has no /mode field (and /mode, /id, /schema are read-only should a field ever list them)
  select(h, 'swing');
  act(h, 'autotrade.dup'); type(h, '\x15paper-only\r');
  act(h, 'autotrade.edit');
  assert.ok(!ui(h).editor!.fields.some((f) => f.path === '/mode'));
  for (const p of ['/mode', '/id', '/schema']) assert.ok(READ_ONLY_PATHS.has(p));
  assert.ok(!fieldsOf(h.store.raw('swing')!).some((f) => READ_ONLY_PATHS.has(f.path)));
  // an import is forced to paper whatever the file says
  const file = join(h.home, 'live.json');
  writeFileSync(file, JSON.stringify({ ...h.store.raw('swing')!, id: 'was-live', mode: 'live' }));
  act(h, 'back');
  act(h, 'autotrade.import');
  type(h, `${file}\r`);
  assert.match(ui(h).notice ?? '', /imported was-live v1\.0\.0 · mode forced to paper/);
  assert.equal(h.store.raw('was-live')!.mode, 'paper');
  // an export is a plain paper strategy document
  select(h, 'was-live');
  act(h, 'autotrade.export');
  const out = readdirSync(join(h.home, 'exports'));
  assert.deepEqual(out, ['strategy-was-live-v1.0.0.json']);
  const exported = JSON.parse(readFileSync(join(h.home, 'exports', out[0]), 'utf8'));
  assert.equal(exported.mode, 'paper');
  for (const k of ['signer', 'wallet', 'key', 'keypair', 'mandate']) assert.ok(!(k in exported), k);
  // a live strategy file (hand-edited) is never backtested or run from here
  const liveDoc = { ...h.store.raw('paper-only')!, mode: 'live', version: '1.0.1' };
  mkdirSync(h.store.dir, { recursive: true });
  writeFileSync(join(h.store.dir, 'paper-only.json'), JSON.stringify(liveDoc));
  reloadList(ui(h));
  select(h, 'paper-only');
  act(h, 'autotrade.backtest');
  assert.match(ui(h).notice ?? '', /autotrade runs paper only/);
  // the screen modules import nothing from the trade, signer, wallet or mandate code
  const srcDir = resolve(here, '..', 'src', 'screens');
  for (const f of readdirSync(srcDir).filter((x) => x.startsWith('autotrade-'))) {
    const imports = readFileSync(join(srcDir, f), 'utf8').split('\n').filter((l) => /^import /.test(l));
    for (const l of imports) assert.doesNotMatch(l, /signer|wallet|mandate|trade\/|paper-desk|plans|keypair/i, `${f}: ${l}`);
  }
});

test('the editor\'s per-field errors and the inline-only types round-trip (strings verbatim, JSON otherwise)', async () => {
  const h = harness();
  select(h, 'moonbag');
  act(h, 'autotrade.dup'); type(h, '\x15bag-two\r');
  act(h, 'autotrade.edit');
  // a null field takes a JSON object (moonbag has no trailing stop)
  const path = '/exits/profiles/0';
  const raw = h.store.raw('bag-two')!;
  assert.equal(typeof raw.exits.profiles[0], 'string', 'moonbag references its builtin profile');
  selectField(h, path);
  act(h, 'open');
  type(h, '\x15builtin:nope\r');
  assert.equal(ui(h).editor!.check.ok, false);
  assert.ok(frame(h).includes('✗ unknown builtin prof'));
  act(h, 'autotrade.undo');
  assert.equal(ui(h).editor!.check.ok, true);
  // a boolean flips with one keypress
  selectField(h, '/entry/safety/requireNoMintAuthority');
  act(h, 'open');
  assert.equal(ui(h).editor!.draft.entry.safety.requireNoMintAuthority, false);
  act(h, 'autotrade.undo');
  await settle();
  // tab cycles the views it has (compare only once two strategies were marked)
  const seen: string[] = [];
  for (let i = 0; i < 5; i++) { act(h, 'autotrade.view'); seen.push(ui(h).view); }
  assert.deepEqual(seen, ['backtest', 'runner', 'list', 'editor', 'backtest']);
});

test('the worker-thread jobs boot (type-stripped module as its own worker) and report a missing history as an error', async () => {
  const { workerJobs } = await import('../src/screens/autotrade-worker.ts');
  const jobs = workerJobs({ DEXTERM_DB_PATH: join(mkdtempSync(join(tmpdir(), 'autotrade-nodb-')), 'none.db') });
  const s = new StrategyStore({ home: mkdtempSync(join(tmpdir(), 'autotrade-w-')) }).get('scalp')!;
  assert.ok(s.ok);
  await assert.rejects(jobs.backtest([s.strategy], { days: 14, until: NOW }), /no recorded history/);
});

test('task-1529 runner view of a parallel run: the STRATEGIES table, strategy-tagged rows, an old fleet file is not shown', () => {
  const member = (id: string, state: string, book: { startUsd: number; equityUsd: number } | null, stats: Partial<Record<string, number>> = {}) => ({
    id, state, basedOn: { id: 'moonbag', version: '1.0.0' }, bankroll: { usd: book?.startUsd ?? 200 }, mode: 'paper', haltReason: null,
    book: book && { ...book, cashUsd: book.equityUsd, realizedTodayUsd: 0 }, spend: null, open: [], candidates: 0, sessions: 0, ledgerPath: null, startedAt: NOW, endedAt: null,
    stats: { closed: 0, wins: 0, losses: 0, entries: 0, enteredUsd: 0, rugExits: 0, rugCostUsd: 0, missedRunners: 0, spendUsd: 0, ...stats },
  });
  let fleet = {
    schema: 'dexterm-autotrade-fleet/1', fleetId: 'fleet-1', pid: 1, mode: 'paper', state: 'running', haltReason: null, startedAt: NOW, heartbeatAt: NOW, source: 'replay', ledgerPath: '/tmp/f.jsonl',
    global: { caps: { maxConcurrentSessions: 2, modelUsdPerDay: 10, candidateSessionsPerDay: 40, positionSessionsPerDay: 40, turnsPerDay: 400 }, today: { modelUsd: 0.31, turns: 9, candidateSessions: 3, positionSessions: 1 }, liveSessions: 1, load: { load1m: 2, paused: false, pauseAbove: 12, resumeBelow: 8 }, allowance: null, blocked: null },
    members: [
      member('scalp-a', 'running', { startUsd: 500, equityUsd: 540 }, { closed: 4, wins: 3, entries: 5, enteredUsd: 400, spendUsd: 0.2 }),
      member('yolo', 'paused', { startUsd: 200, equityUsd: 180 }, { closed: 1, entries: 1, enteredUsd: 200, rugExits: 1, rugCostUsd: 200 }),
    ],
  } as unknown as FleetStatus;
  const h = harness({ fleet: () => fleet });
  const snap = runnerFixture({ candidates: [{ mint: 'MintAAAA1111', symbol: 'ALPHA', ageSec: 95, matched: ['screen'], session: 's-1', strategy: 'yolo' } as RunnerSnapshot['candidates'][number]] });
  h.runner.read = { kind: 'ok', path: RUNNER_PATH, snap: { ...snap, runId: 'fleet-1' } as RunnerSnapshot, readAt: NOW };
  act(h, 'autotrade.run');
  const f = frame(h, 140, 44);
  for (const want of ['STRATEGIES · 2 at once · PAPER', 'scalp-a', 'running', 'paused', '+$40.00', '-$20.00', 'together +$20.00 on $700.00', 'global: 1/2 sessions', '[yolo] ALPHA']) assert.ok(f.includes(want), want);
  // a fleet-status.json from an earlier parallel run (another id) is never shown as this runner's
  fleet = { ...fleet, fleetId: 'fleet-0' };
  act(h, 'autotrade.run');
  assert.ok(!frame(h, 140, 44).includes('STRATEGIES ·'));
});
