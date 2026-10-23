// task-1507 (AT-5): the AUTOTRADE strategy tools on the agent bus. Reads are observe, the two proposal tools are
// propose; the gate's closed schema carries a strategy document or a patch value as `free` JSON (the tool re-validates
// the content), and still refuses control characters and prototype keys inside it. A proposal is never applied by a
// tool, so these do not take an idempotency key: the tool de-duplicates identical pending proposals itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentGate, type AgentSession } from '../src/gate.ts';
import { MemoryAuditLog } from '../src/audit.ts';
import { PROPOSAL_TOOLS, TOOL_TIERS, neverAllowed, tierFor, toolsForTier } from '../src/tiers.ts';
import { agentTool, toolSchema } from '../src/tools.ts';
import { validateArgs } from '../src/schema.ts';

const READS = ['strategy_list', 'strategy_get', 'strategy_validate', 'strategy_backtest', 'autotrade_status'];
const PROPOSE = ['strategy_propose_edit', 'strategy_propose_new'];

function session(tier: AgentSession['tier']): AgentSession {
  return { id: 's1', agentId: 'a1', agentName: 'tester', tier, transport: 'test', openedAt: 0, lastActivity: 0, closed: false, closedReason: null, client: 'test', topics: new Set() };
}
const gate = () => new AgentGate({ audit: new MemoryAuditLog({ now: () => 1 }), now: () => 1_000_000 });
const check = (tier: AgentSession['tier'], tool: string, args: Record<string, unknown>) => gate().check(session(tier), { tool, args, schema: toolSchema(tool) });

test('tiers: five observe reads, two propose tools; none is on the never-list; both tables agree', () => {
  for (const t of READS) { assert.equal(tierFor(t), 'observe', t); assert.equal(agentTool(t)?.tier, 'observe'); }
  for (const t of PROPOSE) { assert.equal(tierFor(t), 'propose', t); assert.equal(agentTool(t)?.tier, 'propose'); }
  for (const t of [...READS, ...PROPOSE]) { assert.equal(neverAllowed(t), false, t); assert.ok(t in TOOL_TIERS); }
  for (const t of PROPOSE) assert.ok(!PROPOSAL_TOOLS.has(t), `${t} is not an idempotency-key proposal tool`);
  assert.ok(toolsForTier('observe').includes('strategy_backtest'));
  assert.ok(!toolsForTier('annotate').includes('strategy_propose_edit'));
});

test('an observe agent may read and backtest but cannot propose', () => {
  assert.equal(check('observe', 'strategy_list', {}).ok, true);
  assert.equal(check('observe', 'strategy_backtest', { id: 'my-swing', days: 7 }).ok, true);
  assert.equal(check('observe', 'strategy_backtest', { id: 'my-swing', days: 15 }).ok, false, 'days <= 14 in the schema too');
  const r = check('observe', 'strategy_propose_edit', { id: 'my-swing', ops: [{ op: 'replace', path: '/risk/maxConcurrent', value: 1 }], why: 'x' });
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.code, 'tier');
});

test('a propose agent sends patch values and whole documents as free JSON', () => {
  const ops = [
    { op: 'replace', path: '/risk/maxConcurrent', value: 1 },
    { op: 'replace', path: '/exits/profiles/0/trailingStop', value: { armAtPct: 20, trailPct: 15 } },
    { op: 'replace', path: '/entry/safety/youngVertical', value: null },
    { op: 'replace', path: '/entry/screen', value: 'liq >= 50K !flag:mint' },
    { op: 'remove', path: '/notes' },
  ];
  assert.deepEqual(check('propose', 'strategy_propose_edit', { id: 'my-swing', ops, why: 'tighter' }), { ok: true, tool: 'strategy_propose_edit', tier: 'propose' });
  assert.equal(check('propose', 'strategy_propose_new', { fromPreset: 'moonbag', id: 'bag-two', name: 'Bag two' }).ok, true);
  assert.equal(check('observe', 'strategy_validate', { doc: { kind: 'strategy', exits: { profiles: ['builtin:swing', { id: 'x', tpLadder: [{ atPct: 50, sellFrac: 0.5 }] }] } } }).ok, true);
});

test('free JSON still refuses control characters, prototype keys, bad op names and paths', () => {
  const bad = (ops: unknown[]) => check('propose', 'strategy_propose_edit', { id: 'my-swing', ops, why: 'x' }).ok;
  assert.equal(bad([{ op: 'replace', path: '/name', value: 'a\u001b[2Jb' }]), false);
  assert.equal(validateArgs({ free: true }, JSON.parse('{"__proto__": {"x": 1}}')) !== null, true);
  assert.equal(bad([{ op: 'move', path: '/a' }]), false);
  assert.equal(bad([{ op: 'replace', path: 'risk/maxConcurrent', value: 1 }]), false);
  assert.equal(bad([{ op: 'replace', path: '/a', value: 1, from: '/b' }]), false);
  assert.equal(bad(Array.from({ length: 21 }, () => ({ op: 'replace', path: '/a', value: 1 }))), false);
  const deep: Record<string, unknown> = {}; let cur = deep; for (let i = 0; i < 20; i++) { cur.x = {}; cur = cur.x as Record<string, unknown>; }
  assert.equal(bad([{ op: 'replace', path: '/a', value: deep }]), false);
});
