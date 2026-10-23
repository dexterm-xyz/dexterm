// v0.1.7 integration (task-1547): the local engine's tool profiles cover the tools the parallel-strategies (task-1529)
// and trade-ledger (task-1530) cards added to the dexterm MCP server, so `paper` / `full` keep parity with the claude
// path and a tool added later cannot silently fall outside every profile.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS, READ_ONLY_TOOLS, PAPER_NOTE_TOOLS } from '../src/server.ts';
import { PARALLEL_CONTROL_TOOLS, PARALLEL_TOOLS } from '../src/autotrade-tools.ts';
import { LEDGER_PROPOSE_TOOLS, LEDGER_TOOLS } from '../src/ledger-tools.ts';
import { NEVER_TOOL, RESTRICTION_LEVELS, engineToolAllowlist } from '../src/engine/index.ts';

const WRITES = [...PARALLEL_CONTROL_TOOLS, ...PAPER_NOTE_TOOLS, ...LEDGER_PROPOSE_TOOLS];

test('1547 engine profiles: every served tool is offered at full unless NEVER_TOOL names it', () => {
  const full = new Set(engineToolAllowlist('full'));
  for (const t of TOOLS) {
    const n = String(t.name);
    if (NEVER_TOOL.test(n)) assert.ok(!full.has(n), `${n} is never offered`);
    else assert.ok(full.has(n), `${n} is offered at full`);
  }
});

test('1547 engine profiles: parallel / ledger reads at observe; their writes only from paper; an AI scan gets none', () => {
  const obs = engineToolAllowlist('observe');
  for (const n of [...PARALLEL_TOOLS, ...LEDGER_TOOLS].filter((x) => READ_ONLY_TOOLS.includes(x))) assert.ok(obs.includes(n), `observe reads ${n}`);
  for (const n of WRITES) {
    assert.ok(!obs.includes(n), `observe excludes ${n}`);
    assert.ok(!engineToolAllowlist('propose').includes(n), `propose excludes ${n}`);
    assert.ok(engineToolAllowlist('paper').includes(n), `paper includes ${n}`);
    for (const lv of RESTRICTION_LEVELS) assert.ok(!engineToolAllowlist(lv, []).includes(n), `${lv} + AI scan excludes ${n}`);
  }
});
