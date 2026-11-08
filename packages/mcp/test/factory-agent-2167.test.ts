// task-2167: an EXTERNAL agent drives the strategy factory over MCP. A fake client talks JSON-RPC to the real stdio
// server (bin/dexterm-mcp.mjs) on a temp home: initialize (clientInfo "fake-agent") -> factory_status -> factory_lessons
// -> factory_evidence -> an offer citing a made-up number (refused) -> an offer trying a bankroll / mode / budget (refused)
// -> a good offer (queued) -> the inbox-only admission (in process, the same runFactory) -> factory_candidates /
// factory_why / strategy_compare_lab show it as mcp:fake-agent -> strategy_retire. Hard lines checked on disk after every
// step: no cap / bankroll / budget / mode file changed, FACTORY-STOP never removed, presets and the user's own strategy
// untouched, nothing written outside the factory / strategy state. Plus AutotradeTools unit checks per tool.
import { after, test } from 'node:test';
import { rmSync } from 'node:fs';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { presetPath, StrategyStore, fleetConfigPath, runFactory, stubAnalyst, loadTape, loadEvidenceSnapshot, factoryStopPath, writeFactoryStop, type Strategy } from '@dexterm/autotrade';
import { AutotradeTools, TOOLS, FACTORY_AGENT_TOOLS, FACTORY_READ_TOOLS, agentSource } from '../src/index.ts';

/** temp homes, removed when the file's tests end */
const HOMES: string[] = [];
after(() => { for (const h of HOMES) rmSync(h, { recursive: true, force: true }); });
const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', 'bin', 'dexterm-mcp.mjs');
const TAPE = loadTape(new URL('../../autotrade/test/fixtures/autotrade-1498-tape.json', import.meta.url));
const T0 = Date.now() - 60_000;
const DAY = 86_400_000;

function home(): string {
  const h = mkdtempSync(join(tmpdir(), 'dexterm-2167-mcp-'));
  HOMES.push(h);
  const st = new StrategyStore({ home: h });
  for (const id of ['ss-s2', 'my-own']) assert.ok(st.create({ ...JSON.parse(readFileSync(presetPath('moonbag'), 'utf8')), id, name: id, version: '1.0.0' } as Strategy, { actor: 'test' }).ok);
  mkdirSync(join(h, 'autotrade'), { recursive: true });
  writeFileSync(fleetConfigPath(h), JSON.stringify({ schema: 'dexterm-autotrade/1', strategies: [{ id: 'ss-s2', preset: 'ss-s2' }] }));
  return h;
}

/** Every file under the home with its sha256 (relative paths). */
function tree(h: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else out.set(relative(h, p), createHash('sha256').update(readFileSync(p)).digest('hex')); } };
  walk(h);
  return out;
}
/** The files that must never change from an agent call (caps, bankrolls, budgets, the user's own strategy, the user's stop). */
const GUARDED = (h: string): string[] => [fleetConfigPath(h), join(h, 'autotrade', 'factory', 'factory.json'), join(h, 'strategies', 'my-own.json'), join(h, 'strategies', 'ss-s2.json'), factoryStopPath(h)].map((p) => relative(h, p));
/** Where agent calls may write: the factory's and the strategies' state (generated candidates, journey, forward tests). */
const ALLOWED = /^(autotrade\/factory\/|autotrade\/journey\/|autotrade\/forward\/|strategies\/)/;
function assertHardLines(h: string, before: Map<string, string>, why: string): void {
  const after = tree(h);
  for (const g of GUARDED(h)) assert.equal(after.get(g), before.get(g), `${why}: ${g} changed`);
  for (const [p, sum] of after) if (before.get(p) !== sum) assert.match(p, ALLOWED, `${why}: wrote ${p}`);
  for (const p of before.keys()) assert.ok(after.has(p) || ALLOWED.test(p), `${why}: removed ${p}`);
}

function rpc(child: ChildProcess, id: number, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`rpc ${method} timed out`)), 20_000);
    const onData = (d: Buffer) => {
      buf += d.toString('utf8');
      for (const line of buf.split('\n')) {
        if (!line.trim()) continue;
        try { const m = JSON.parse(line); if (m.id === id) { clearTimeout(timer); child.stdout!.off('data', onData); resolve(m); return; } } catch { /* partial */ }
      }
    };
    child.stdout!.on('data', onData);
    child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

test('the agent tools are served with closed schemas, and no schema has a mode / bankroll / cap / budget / limit / promote field', () => {
  const byName = new Map(TOOLS.map((t) => [String(t.name), t as unknown as { inputSchema: { properties: Record<string, unknown>; additionalProperties: boolean } }]));
  for (const n of [...FACTORY_AGENT_TOOLS, ...FACTORY_READ_TOOLS]) {
    const t = byName.get(n);
    assert.ok(t, n);
    assert.equal(t.inputSchema.additionalProperties, false, n);
    // the controls take no knob that could reach a mode, bankroll, cap or budget (a read may page with `limit`)
    if (FACTORY_AGENT_TOOLS.includes(n)) for (const k of Object.keys(t.inputSchema.properties)) assert.doesNotMatch(k, /mode|bankroll|cap|budget|limit|promote|arm|live|real|key|sign|send/i, `${n}.${k}`);
  }
  assert.equal(agentSource('mcp-agent', 'Claude Code'), 'mcp:claude-code');
  assert.equal(agentSource('mcp-agent', '../../evil'), 'mcp:evil');
  assert.equal(agentSource('mcp-agent', null), 'mcp:agent');
  assert.equal(agentSource('analyst', 'x'), 'mcp:dexterm-chat');
});

test('fake external client end to end: read status, lessons and evidence, offer (made-up number refused, cap/bankroll refused, good one queued), it is admitted, watched, retired', async () => {
  const h = home();
  // the factory's own first run (stub analyst): the evidence snapshot an agent may cite
  await runFactory({ home: h, analyst: stubAnalyst(), tape: () => TAPE, now: () => T0 });
  writeFactoryStop(h, 'cli', 'the user stopped it', T0); // the user's stop: no agent call may lift it
  const before = tree(h);
  const child = spawn(process.execPath, [BIN], { env: { ...process.env, HOME: h, DEXTERM_HOME: h, DEXTERM_DB_PATH: ':memory:' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let id = 1;
  const call = async (name: string, args: Record<string, unknown> = {}) => JSON.parse(((await rpc(child, ++id, 'tools/call', { name, arguments: args })).result as { content: Array<{ text: string }> }).content[0].text) as Record<string, any>;
  try {
    await rpc(child, id, 'initialize', { clientInfo: { name: 'fake-agent', version: '1' } });
    const st = await call('factory_status');
    assert.equal(st.enabled, false);
    assert.equal(st.factoryStop.by, 'cli');
    assert.match(st.inUse.activeGenerated, /^1 of 5$/);
    const ls = await call('factory_lessons');
    assert.match(String(ls.lessons), /^<untrusted source="factory:lessons.md"/);
    const ev = await call('factory_evidence');
    assert.match(String(ev.table), /^<untrusted /);
    assert.ok(ev.citable > 0);
    // offers are refused while the user's FACTORY-STOP stands; resume cannot lift it (it becomes a proposal)
    const res = await call('factory_resume');
    assert.match(res.changed, /FACTORY-STOP is the user's and stays/);
    assert.ok(existsSync(factoryStopPath(h)));
    assertHardLines(h, before, 'factory_resume');
    const stopped = await call('factory_offer_candidate', { base: 'ss-s2', name: 'probe', rationale: { summary: 's', rules: [{ change: 'c', why: 'w' }], expectedFailure: 'f' }, citations: [] });
    assert.equal(stopped.reason, 'stopped');
  } finally { child.kill(); }

  // the user lifts their stop (their terminal), then the agent works
  (await import('node:fs')).unlinkSync(factoryStopPath(h));
  const before2 = tree(h);
  const child2 = spawn(process.execPath, [BIN], { env: { ...process.env, HOME: h, DEXTERM_HOME: h, DEXTERM_DB_PATH: ':memory:' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const call2 = async (name: string, args: Record<string, unknown> = {}) => JSON.parse(((await rpc(child2, ++id, 'tools/call', { name, arguments: args })).result as { content: Array<{ text: string }> }).content[0].text) as Record<string, any>;
  try {
    await rpc(child2, ++id, 'initialize', { clientInfo: { name: 'fake-agent' } });
    const snap = loadEvidenceSnapshot(h)!;
    const row = snap.rows.find((r) => r.id === 'ss-s2')!;
    const key = `${row.ref}.n`;
    const offer = (over: Record<string, unknown> = {}) => ({
      base: 'ss-s2', parents: ['ss-s2'], name: 'wider age window',
      ops: [{ op: 'replace', path: '/entry/ageHours/max', value: 8 }],
      rationale: { summary: `ss-s2 rules, but coins up to eight hours old (${snap.numbers[key]} entries in the evidence).`, rules: [{ change: 'max age 8 h', why: 'more candidates to judge', cites: [key] }], expectedFailure: 'older coins drift down after costs', versusParents: 'one rule' },
      citations: [{ ref: key, value: snap.numbers[key] }], ...over,
    });
    const madeUp = await call2('factory_offer_candidate', offer({ rationale: { summary: 'This held up at 63.4% per entry on later days.', rules: [{ change: 'max age 8 h', why: 'w' }], expectedFailure: 'f' } }));
    assert.equal(madeUp.ok, false);
    assert.match(madeUp.problems.join('|'), /63\.4, which is not in the evidence/);
    // a full strategy that tries to set the bankroll, the mode or the Claude budget
    const doc = JSON.parse(readFileSync(join(h, 'strategies', 'ss-s2.json'), 'utf8'));
    for (const bad of [{ ...doc, bankroll: { startUsd: 1e6 } }, { ...doc, mode: 'real' }, { ...doc, agent: { ...doc.agent, budgetUsdPerDay: 500 } }]) {
      const { ops: _x, ...noOps } = offer();
      const r = await call2('factory_offer_candidate', { ...noOps, strategy: bad });
      assert.equal(r.ok, false, JSON.stringify(r));
    }
    // extra arguments (a cap, a mode) are outside the closed schema, and the tool ignores them if a client sends them anyway
    const good = await call2('factory_offer_candidate', { ...offer(), maxActiveGenerated: 99, mode: 'real' } as Record<string, unknown>);
    assert.equal(good.ok, true, JSON.stringify(good));
    assert.equal(good.from, 'mcp:fake-agent');
    // r1 (verifier task-2173): the document exactly as strategy_get returns it (profiles as "builtin:moonbag"), one rule changed, is queued
    const got = await call2('strategy_get', { id: 'ss-s2' });
    const fromGet = JSON.parse(JSON.stringify(got.document)) as Record<string, any>;
    assert.ok(fromGet.exits.profiles.some((x: unknown) => typeof x === 'string' && x.startsWith('builtin:')), 'the base uses a builtin profile ref');
    fromGet.entry.ageHours.max = 10;
    const { ops: _o2, ...noOps2 } = offer({ name: 'ten hours old' });
    const full = await call2('factory_offer_candidate', { ...noOps2, strategy: fromGet });
    assert.equal(full.ok, true, JSON.stringify(full));
    assertHardLines(h, before2, 'factory_offer_candidate');
    // enable / disable are proposals; nothing in autotrade.json changes
    const dis = await call2('strategy_disable', { id: 'ss-s2' });
    assert.equal(dis.applied, false);
    assert.match(dis.proposal.code, /^C[0-9A-F]{6}$/);
    const realish = await call2('strategy_enable', { id: 'my-own' });
    assert.equal(realish.ok, false, 'my-own is not on the always-on list: nothing to enable');
    // retire refuses presets and the user's own strategy
    for (const t of ['moonbag', 'my-own']) assert.equal((await call2('strategy_retire', { id: t, why: 'not mine to keep' })).ok, false, t);
    // pause / resume round trip (AGENT-PAUSE only)
    assert.equal((await call2('factory_pause', { why: 'testing' })).ok, true);
    assert.equal(existsSync(factoryStopPath(h)), false);
    assert.equal((await call2('factory_run_now', {})).ok, false, 'paused: no run');
    assert.equal((await call2('factory_resume')).ok, true);
    assertHardLines(h, before2, 'controls');
    const st2 = await call2('factory_status');
    assert.equal(st2.offers.queued, 2);
    assert.ok(st2.waitingForUser.some((p: { action: string }) => p.action === 'off'));
  } finally { child2.kill(); }

  // the next factory run admits the offer (inbox only: no analyst call, no spend), through the same code as an analyst reply
  const run = await runFactory({ home: h, analyst: async () => { throw new Error('no analyst in an inbox-only run'); }, tape: () => TAPE, now: () => T0 + DAY, inboxOnly: true });
  assert.equal(run.candidates.length, 1, run.verdict);
  const gid = run.candidates[0].id;
  const t = new AutotradeTools({ env: { DEXTERM_HOME: h }, actor: 'mcp-agent', client: () => 'fake-agent', now: () => T0 + DAY });
  const cands = await t.call('factory_candidates', {});
  const mine = (cands.candidates as Array<Record<string, any>>).find((c) => c.id === gid)!;
  assert.equal(mine.source, 'mcp:fake-agent');
  assert.equal(mine.stage, 'queued-forward');
  assert.equal(typeof mine.backtest.n, 'number');
  const why = await t.call('factory_why', { id: gid });
  assert.equal(why.madeBy, 'mcp:fake-agent');
  assert.ok((why.evidence as { citations: unknown[] }).citations.length >= 1);
  const lab = await t.call('strategy_compare_lab', {});
  assert.ok((lab.rows as Array<{ id: string }>).some((r) => r.id === gid));
  const ret = await t.call('strategy_retire', { id: gid, why: 'trying the retire path' });
  assert.equal(ret.ok, true);
  assert.match(String(ret.undo), /factory unretire/);
});

test('the in-app chat (actor analyst) cannot use the agent controls: it keeps strategy_change (preview + the user\'s own confirm)', async () => {
  const h = home();
  const t = new AutotradeTools({ env: { DEXTERM_HOME: h }, actor: 'analyst', now: () => T0 });
  for (const n of FACTORY_AGENT_TOOLS) {
    const r = await t.call(n, { id: 'ss-s2', why: 'x' });
    assert.equal(r.ok, false, n);
    assert.match(String(r.error), /strategy_change/, n);
  }
});

test('factory_run_now: refused when paused or busy, rate-limited, inbox-only refuses an empty inbox; the run itself is the factory\'s', async () => {
  const h = home();
  const runs: Array<{ inboxOnly?: boolean }> = [];
  let now = T0;
  const t = new AutotradeTools({ env: { DEXTERM_HOME: h }, actor: 'mcp-agent', client: () => 'x', now: () => now, factoryRunner: (_h, _e, o) => { runs.push(o ?? {}); return true; } });
  const empty = await t.call('factory_run_now', { analyst: false });
  assert.equal(empty.ok, false);
  const a = await t.call('factory_run_now', {});
  assert.equal(a.ok, true);
  const b = await t.call('factory_run_now', {});
  assert.equal(b.reason, 'rate-limited');
  for (let i = 0; i < 6; i++) { now += 31 * 60_000; await t.call('factory_run_now', {}); }
  assert.equal(runs.length, 4, 'at most 4 a day');
  await t.call('factory_pause', {});
  now += DAY;
  assert.equal((await t.call('factory_run_now', {})).ok, false);
});
