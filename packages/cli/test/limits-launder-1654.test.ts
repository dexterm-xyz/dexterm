// task-1654 r2 (verify F1): a raise needs the typed phrase, whatever carries it. A hand edit of limits.json that raises
// a limit must not ride along with a later lowering `limits set` / `limits reset` (no terminal), and a typed `set`
// shows and confirms every raise it saves, not only the line typed. The diff shown is the diff saved (planLimitsSave
// and saveLimits share dexterm's last journaled save as the baseline). A temp $DEXTERM_HOME, fake terminals (typed
// lines through the test seam). No network, no key, no signal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { autotradeCommand } from '../src/autotrade-cmd.ts';
import { limitsCmd } from '../src/autotrade-cmd/limits.ts';
import { signalCmd, type SignalDeps } from '../src/autotrade-cmd/signal.ts';
import { emptyLimits, limitsForRealRun, limitsPath, loadLimits, planLimitsSave, readRealJournal, saveLimits } from '@dexterm/autotrade';

function io(home = mkdtempSync(join(tmpdir(), 'dexterm-1654-launder-'))) {
  const out: string[] = [], err: string[] = [];
  return { home, out, err, io: { stdout: { write: (s: string) => out.push(s) }, stderr: { write: (s: string) => err.push(s) }, env: { DEXTERM_HOME: home, DEXTERM_DB_PATH: join(home, 'none.db'), DEXTERM_SECRET_STORE: 'file' } } };
}
type X = ReturnType<typeof io>;
const wrap = async (x: X, f: () => Promise<number>) => { x.out.length = 0; x.err.length = 0; const code = await f(); return { code, out: x.out.join(''), err: x.err.join('') }; };
const run = (x: X, ...argv: string[]) => wrap(x, () => autotradeCommand(argv, x.io));
const lim = (x: X, deps: SignalDeps, ...argv: string[]) => wrap(x, () => limitsCmd(argv, x.io, deps));
const sig = (x: X, deps: SignalDeps, ...argv: string[]) => wrap(x, () => signalCmd(argv, x.io, deps));
/** task-1679: a test that is not about the evidence floor types the OVERRIDE phrase the arming shows. */
const override = (p: string): string | null => /"(OVERRIDE [^"]+)"/.exec(p)?.[1] ?? null;
const tty = (answer: (prompt: string) => string | null): SignalDeps => ({ tty: true, code: () => 'ABCD', typed: async (p) => override(p) ?? answer(p) });

/** A saved lower, then a hand edit that raises three limits (the runner refuses it). */
async function handEditRaise(x: X) {
  assert.equal((await run(x, 'autotrade', 'limits', 'set', 'perTradeSol=0.1')).code, 0);
  const p = limitsPath(x.home);
  const doc = JSON.parse(readFileSync(p, 'utf8'));
  doc.global.perTradeSol = 50; doc.global.dailySol = 500; doc.global.dailyLossSol = null;
  writeFileSync(p, JSON.stringify(doc));
  assert.equal(limitsForRealRun(x.home).ok, false);
}
const lastSaved = (x: X) => readRealJournal(x.home).filter((l) => String(l.action).startsWith('limits-') || l.action === 'caps-set').at(-1)!;

test('F1: a lowering set or reset with no terminal cannot launder a hand-edit raise', async () => {
  for (const cmd of [['set', 'buysPerDay=19'], ['reset', '--scope', 'strategy:scalp'], ['reset', '--key', 'buysPerDay']]) {
    const x = io();
    if (cmd[1] === '--scope') assert.equal((await run(x, 'autotrade', 'limits', 'set', '--scope', 'strategy:scalp', 'buysPerDay=5')).code, 0);
    await handEditRaise(x);
    if (cmd[1] === '--key') { const d = JSON.parse(readFileSync(limitsPath(x.home), 'utf8')); d.global.buysPerDay = 5; writeFileSync(limitsPath(x.home), JSON.stringify(d)); }
    const before = lastSaved(x);
    const r = await run(x, 'autotrade', 'limits', ...cmd);
    assert.equal(r.code, 1, `${cmd.join(' ')}: ${r.out}`);
    assert.match(r.out, /RAISE global\.perTradeSol: 0\.1 SOL -> 50 SOL/, 'the hidden raise is shown');
    assert.match(r.out, /limits\.json was changed outside dexterm and that edit RAISES global\.perTradeSol, global\.dailySol, global\.dailyLossSol/);
    assert.match(r.err, /real terminal/);
    assert.deepEqual(lastSaved(x), before, 'nothing journaled');
    const l = loadLimits(x.home);
    assert.ok(l.ok && !l.journaled, 'still unaccepted');
    assert.equal(limitsForRealRun(x.home).ok, false, 'a real run still refuses the raise');
  }
});

test('F1: a typed set confirms every raise it saves; the phrase covers the lines shown', async () => {
  const x = io();
  await handEditRaise(x);
  let prompt = '';
  const r = await lim(x, tty((p) => { prompt = p; return 'RAISE limits ABCD'; }), 'set', 'buysPerDay=19');
  assert.equal(r.code, 0, r.err);
  assert.match(prompt, /RAISE limits ABCD/);
  assert.match(r.out, /3 limit\(s\) RAISED/);
  const j = lastSaved(x);
  assert.deepEqual((j.data as { raised: string[] }).raised.sort(), ['global.dailyLossSol', 'global.dailySol', 'global.perTradeSol']);
  assert.equal(limitsForRealRun(x.home).ok, true, 'typed: accepted as the user\'s numbers');
  // A hand edit that only LOWERS rides along with a non-typed set (lowering is free).
  const d = JSON.parse(readFileSync(limitsPath(x.home), 'utf8'));
  d.global.perTradeSol = 1;
  writeFileSync(limitsPath(x.home), JSON.stringify(d));
  const r2 = await run(x, 'autotrade', 'limits', 'set', 'buysPerDay=10');
  assert.equal(r2.code, 0, r2.err);
  assert.match(r2.out, /lower global\.perTradeSol: 50 SOL -> 1 SOL/);
});

test('F1: accept shows the hand edit against the last save and needs the phrase for its raises', async () => {
  const x = io();
  await handEditRaise(x);
  let r = await run(x, 'autotrade', 'limits', 'accept');
  assert.equal(r.code, 1);
  assert.match(r.out, /RAISE global\.dailySol: 1 SOL\/day -> 500 SOL\/day/);
  r = await lim(x, tty(() => 'RAISE limits ABCD'), 'accept');
  assert.equal(r.code, 0, r.err);
  assert.equal(limitsForRealRun(x.home).ok, true);
});

test('F1: arming after the file was deleted lists the raises against the last save; the phrase confirms them', async () => {
  const x = io();
  assert.equal((await run(x, 'autotrade', 'new', 'my-scalp', '--from', 'scalp')).code, 0);
  assert.equal((await run(x, 'autotrade', 'signal', 'channels', '--jsonl', 'on')).code, 0);
  assert.equal((await run(x, 'autotrade', 'limits', 'set', 'perTradeSol=0.05')).code, 0);
  rmSync(limitsPath(x.home));
  // The wizard: perTradeSol 0.3 (a raise against the saved 0.05), Enter for the rest.
  const deps = tty((p) => { const k = /^\s+(\w+):/.exec(p)?.[1]; if (k) return k === 'perTradeSol' ? '0.3' : ''; return 'REAL my-scalp ABCD'; });
  const r = await sig(x, deps, 'arm', 'my-scalp');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /saving these RAISES limits against dexterm's last saved limits:\n {4}RAISE global\.perTradeSol: 0\.05 SOL -> 0\.3 SOL/);
  assert.ok((lastSaved(x).data as { raised: string[] }).raised.includes('global.perTradeSol'));
});

test('saveLimits: confirmed is the list of raises the user saw; a raise outside it, or a moved baseline, is refused', () => {
  const x = io();
  assert.equal(saveLimits(x.home, { ...emptyLimits(), global: { perTradeSol: 0.1 } }, { confirmed: [] }).ok, true, 'a lower needs nothing');
  const next = { ...emptyLimits(), global: { perTradeSol: 0.5, dailySol: 3 } };
  const plan = planLimitsSave(x.home, next);
  assert.deepEqual(plan.raised.sort(), ['global.dailySol', 'global.perTradeSol']);
  let r = saveLimits(x.home, next, { confirmed: ['global.perTradeSol'], baseline: plan.baseline });
  assert.equal(r.ok, false);
  assert.match((r as { why: string }).why, /raising global\.dailySol needs the typed confirmation/);
  // Another save between the plan and this one: the confirmed diff is stale.
  assert.equal(saveLimits(x.home, { ...emptyLimits(), global: { perTradeSol: 0.09 } }, { confirmed: [] }).ok, true);
  r = saveLimits(x.home, next, { confirmed: plan.raised, baseline: plan.baseline });
  assert.equal(r.ok, false);
  assert.match((r as { why: string }).why, /changed while you were confirming/);
  const fresh = planLimitsSave(x.home, next);
  assert.equal(saveLimits(x.home, next, { confirmed: fresh.raised, baseline: fresh.baseline }).ok, true);
});

// r3 (verify task-1670 F2): `signal caps set` is planned like any limits save, so a hand edit of limits.json that
// raises a non-cap limit or drops a tighter scope is shown and confirmed with the caps, never carried along.
test('F2: a typed caps set shows every raise it saves, a hand edit of any scope included', async () => {
  const x = io();
  assert.equal((await run(x, 'autotrade', 'limits', 'set', 'dailyLossSol=0.2')).code, 0);
  assert.equal((await run(x, 'autotrade', 'limits', 'set', '--scope', 'strategy:scalp', 'perTradeSol=0.05')).code, 0);
  const p = limitsPath(x.home);
  const doc = JSON.parse(readFileSync(p, 'utf8'));
  doc.global.dailyLossSol = null; doc.global.lossStreak = null; doc.strategies = {};
  writeFileSync(p, JSON.stringify(doc));
  assert.equal(limitsForRealRun(x.home).ok, false);
  // No terminal: refused, nothing journaled.
  const before = lastSaved(x);
  let r = await run(x, 'autotrade', 'signal', 'caps', 'set', '--daily-sol', '1.5');
  assert.equal(r.code, 1);
  assert.deepEqual(lastSaved(x), before);
  // Typed: every raise is listed before the phrase, and the journal names each.
  r = await sig(x, tty(() => 'RAISE caps ABCD'), 'caps', 'set', '--daily-sol', '1.5');
  assert.equal(r.code, 0, r.err);
  for (const l of [/RAISE global\.dailySol: 1 SOL\/day -> 1\.5 SOL\/day/, /RAISE global\.dailyLossSol: 0\.2 SOL\/day -> off/, /RAISE global\.lossStreak: 5 .*-> off/, /RAISE strategies\.scalp\.perTradeSol: 0\.05 SOL -> off/]) assert.match(r.out, l);
  assert.match(r.out, /that edit RAISES global\.dailyLossSol, global\.lossStreak, strategies\.scalp\.perTradeSol/);
  assert.deepEqual([...(lastSaved(x).data as { raised: string[] }).raised].sort(), ['global.dailyLossSol', 'global.dailySol', 'global.lossStreak', 'strategies.scalp.perTradeSol']);
  // A cap-only raise on a clean file still works as before.
  const y = io();
  assert.equal((await sig(y, tty(() => 'RAISE caps ABCD'), 'caps', 'set', '--per-trade-sol', '0.5')).code, 0);
  assert.equal((loadLimits(y.home) as { doc: { global: { perTradeSol: number } } }).doc.global.perTradeSol, 0.5);
});

test('F2: saveLimits / saveCaps have no confirm-everything: a raise outside the confirmed list is refused', async () => {
  const x = io();
  assert.equal(saveLimits(x.home, { ...emptyLimits(), global: { perTradeSol: 0.1 } }, { confirmed: [] }).ok, true);
  const { saveCaps, planCaps } = await import('@dexterm/autotrade');
  const d = JSON.parse(readFileSync(limitsPath(x.home), 'utf8'));
  d.global.dailyLossSol = null;
  writeFileSync(limitsPath(x.home), JSON.stringify(d));
  const caps = { perTradeSol: 0.5, dailySol: 1, buysPerDay: 20, maxOpenPositions: 3 };
  const r = saveCaps(x.home, caps, { confirmed: ['global.perTradeSol'] });
  assert.equal(r.ok, false);
  assert.match((r as { why: string }).why, /raising dailyLossSol needs the typed confirmation/);
  const plan = planCaps(x.home, caps);
  assert.ok(!('error' in plan));
  assert.deepEqual([...plan.raised].sort(), ['global.dailyLossSol', 'global.perTradeSol']);
});

// r3 (verify task-1670 F3): card A's caps.json is migrated only while dexterm has never journaled a limits save.
test('F3: with a journal, a caps.json that appears (limits.json deleted) is an outside edit: a raise is refused until accept', async () => {
  const x = io();
  assert.equal((await run(x, 'autotrade', 'limits', 'set', 'perTradeSol=0.1', 'dailyLossSol=0.2')).code, 0);
  rmSync(limitsPath(x.home));
  const capsP = join(x.home, 'autotrade', 'real', 'caps.json');
  assert.equal(existsSync(capsP), false);
  writeFileSync(capsP, JSON.stringify({ schema: 'dexterm-real-caps/1', caps: { perTradeSol: 50, dailySol: 500, buysPerDay: 1000, maxOpenPositions: 50 } }));
  const l = loadLimits(x.home);
  assert.ok(l.ok && l.source === 'migrated' && !l.journaled && l.unjournaled!.some((c) => c.kind === 'raise'));
  const rr = limitsForRealRun(x.home);
  assert.equal(rr.ok, false);
  assert.match((rr as { why: string }).why, /limits\.json is missing and caps\.json was changed outside dexterm and RAISES global\.perTradeSol/);
  // No terminal: accept refuses; typed: accepted and written as limits.json.
  assert.equal((await run(x, 'autotrade', 'limits', 'accept')).code, 1);
  assert.equal(limitsForRealRun(x.home).ok, false);
  assert.equal((await lim(x, tty(() => 'RAISE limits ABCD'), 'accept')).code, 0);
  assert.equal(limitsForRealRun(x.home).ok, true);
  // A caps.json that only lowers is accepted by the runner (lowering is free), as for limits.json.
  const y = io();
  assert.equal((await run(y, 'autotrade', 'limits', 'set', 'perTradeSol=0.1')).code, 0);
  rmSync(limitsPath(y.home));
  writeFileSync(join(y.home, 'autotrade', 'real', 'caps.json'), JSON.stringify({ schema: 'dexterm-real-caps/1', caps: { perTradeSol: 0.05, dailySol: 0.5, buysPerDay: 10, maxOpenPositions: 1 } }));
  const ly = limitsForRealRun(y.home);
  assert.equal(ly.ok, true, ly.ok ? '' : ly.why);
});

test('F3: with no limits journal, caps.json migrates only when it matches card A\'s own journaled caps', async () => {
  const realDirOf = (h: string) => join(h, 'autotrade', 'real');
  const cardA = (h: string, after: Record<string, number>) => {
    mkdirSync(realDirOf(h), { recursive: true });
    appendFileSync(join(realDirOf(h), 'journal.jsonl'), `${JSON.stringify({ t: 1, action: 'caps-set', by: 'local-terminal', data: { before: null, after, raised: Object.keys(after) } })}\n`);
  };
  const capsFile = (h: string, caps: Record<string, number>) => writeFileSync(join(realDirOf(h), 'caps.json'), JSON.stringify({ schema: 'dexterm-real-caps/1', caps, updatedAt: 1 }));
  const big = { perTradeSol: 2, dailySol: 10, buysPerDay: 50, maxOpenPositions: 5 };
  // A genuine card A home: caps.json = its last journaled caps (above the new placeholders): migrated, no phrase.
  const a = io();
  cardA(a.home, big); capsFile(a.home, big);
  let l = loadLimits(a.home);
  assert.ok(l.ok && l.source === 'migrated' && l.journaled);
  assert.equal(limitsForRealRun(a.home).ok, true, 'card A\'s numbers stay the user\'s');
  // A caps.json that card A never journaled: measured from the placeholders; raising is refused.
  const b = io();
  mkdirSync(realDirOf(b.home), { recursive: true });
  capsFile(b.home, big);
  l = loadLimits(b.home);
  assert.ok(l.ok && !l.journaled && l.unjournaled!.some((c) => c.kind === 'raise' && c.key === 'perTradeSol'));
  assert.equal(limitsForRealRun(b.home).ok, false);
  // One that differs from card A's last journaled caps: measured from those caps.
  const c = io();
  cardA(c.home, { perTradeSol: 0.05, dailySol: 0.25, buysPerDay: 10, maxOpenPositions: 1 }); capsFile(c.home, big);
  l = loadLimits(c.home);
  assert.ok(l.ok && !l.journaled);
  assert.ok(l.unjournaled!.some((x) => x.kind === 'raise' && x.key === 'perTradeSol' && x.from === 0.05));
  assert.equal(limitsForRealRun(c.home).ok, false);
});

// r4 (verify task-1671 F4): with no hashed limits save, the save baseline was the FILE while the integrity check
// measured from card A's journaled caps or the placeholders. Now both use one baseline, never the file.
test('F4: card-A upgrade home: an outside caps.json raise is not laundered by a non-TTY accept, a lowering set or caps set', async () => {
  const big = { perTradeSol: 50, dailySol: 500, buysPerDay: 1000, maxOpenPositions: 50 };
  for (const cmd of [['limits', 'accept'], ['limits', 'set', 'lossStreak=3'], ['signal', 'caps', 'set', '--max-open', '40']]) {
    const x = io();
    const dir = join(x.home, 'autotrade', 'real');
    mkdirSync(dir, { recursive: true });
    const cardA = { perTradeSol: 0.25, dailySol: 1, buysPerDay: 20, maxOpenPositions: 3 };
    appendFileSync(join(dir, 'journal.jsonl'), `${JSON.stringify({ t: 1, action: 'caps-set', by: 'local-terminal', data: { before: null, after: cardA, raised: [] } })}\n`);
    writeFileSync(join(dir, 'caps.json'), JSON.stringify({ schema: 'dexterm-real-caps/1', caps: cardA, updatedAt: 1 }));
    assert.equal(limitsForRealRun(x.home).ok, true, 'a genuine card A home');
    writeFileSync(join(dir, 'caps.json'), JSON.stringify({ schema: 'dexterm-real-caps/1', caps: big, updatedAt: 2 }));
    assert.equal(limitsForRealRun(x.home).ok, false);
    const journal = readFileSync(join(dir, 'journal.jsonl'), 'utf8');
    const r = await run(x, 'autotrade', ...cmd);
    assert.equal(r.code, 1, `${cmd.join(' ')}: ${r.out}`);
    assert.match(r.out, /RAISE global\.perTradeSol: 0\.25 SOL -> 50 SOL/);
    assert.equal(readFileSync(join(dir, 'journal.jsonl'), 'utf8'), journal, 'nothing journaled');
    assert.equal(limitsForRealRun(x.home).ok, false, 'the real run still refuses');
  }
});

test('F4: fresh home with no journal: a limits.json written above the placeholders is not laundered', async () => {
  for (const cmd of [['limits', 'accept'], ['limits', 'set', 'buysPerDay=999']]) {
    const x = io();
    mkdirSync(join(x.home, 'autotrade', 'real'), { recursive: true });
    writeFileSync(limitsPath(x.home), JSON.stringify({ ...emptyLimits(), global: { perTradeSol: 50, dailySol: 500, buysPerDay: 1000, maxOpenPositions: 50, dailyLossSol: null, lossStreak: null } }));
    assert.equal(limitsForRealRun(x.home).ok, false);
    const r = await run(x, 'autotrade', ...cmd);
    assert.equal(r.code, 1, `${cmd.join(' ')}: ${r.out}`);
    assert.match(r.out, /RAISE global\.dailyLossSol: 0\.5 SOL\/day -> off/);
    assert.equal(limitsForRealRun(x.home).ok, false);
    // Typed: accepted as the user's numbers.
    assert.equal((await lim(x, tty(() => 'RAISE limits ABCD'), 'accept')).code, 0);
    assert.equal(limitsForRealRun(x.home).ok, true);
  }
  // A hand-written file within the placeholders (lower-only) is accepted by the runner, as before.
  const y = io();
  mkdirSync(join(y.home, 'autotrade', 'real'), { recursive: true });
  writeFileSync(limitsPath(y.home), JSON.stringify({ ...emptyLimits(), global: { perTradeSol: 0.1 } }));
  assert.equal(limitsForRealRun(y.home).ok, true);
});
