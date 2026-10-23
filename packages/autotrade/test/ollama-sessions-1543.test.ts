// task-1543: autotrade sessions on a LOCAL model (Ollama). The protocol is the claude one (DOSSIER/DELTA/EVENT in,
// one DECISION line out), the session is tool-less by construction, cost is $0, and — the money test — the same
// decisions from a claude session and an Ollama session produce the SAME clamps, refusals and fills: the caps, the
// strategy clamp and the book are engine-independent. A fake Ollama on 127.0.0.1; no model, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { OllamaClient, parseOllamaHost, ENGINE_PARITY, type OllamaHost } from '@dexterm/mcp/engine';
import { loadPreset } from '../src/strategy.ts';
import { loadTape } from '../src/replay.ts';
import { parseDecision, stubSession, type AgentSession } from '../src/session.ts';
import { runAutotrade } from '../src/runner.ts';
import { SessionGate } from '../src/sessions.ts';
import { effectiveCaps, DEFAULT_RUNNER_CONFIG } from '../src/runner-config.ts';
import { OLLAMA_DECISION_FORMAT, assertAutotradeAllowed, ollamaSessionFactory, renderOllamaReply } from '../src/ollama-sessions.ts';
import { startFakeOllama } from '../../mcp/test/fake-ollama.ts';

const TAPE = fileURLToPath(new URL('./fixtures/autotrade-1498-tape.json', import.meta.url));
const host = (url: string) => parseOllamaHost(url) as OllamaHost;

function gate() {
  const s = loadPreset('scalp');
  const cfg = DEFAULT_RUNNER_CONFIG;
  return new SessionGate(effectiveCaps(s, cfg), cfg.allowanceGuard);
}

test('1543 sessions: a structured reply renders as the claude-path DECISION text; garbage stays garbage (and is refused by the closed schema)', () => {
  const t = renderOllamaReply(JSON.stringify({ comment: 'buyers ahead\nstill early', decision: { action: 'enter', sizePct: 5, confidence: 0.7, reason: 'momentum', profile: null } }));
  assert.equal(t, 'buyers ahead still early\nDECISION {"action":"enter","sizePct":5,"confidence":0.7,"reason":"momentum"}');
  const d = parseDecision(t);
  assert.ok(d.ok && d.decision.action === 'enter');
  assert.equal(parseDecision(renderOllamaReply('{"comment":"x","decision":{"action":"enter","reason":"r","signer":"k"}}')).ok, false, 'an extra key is refused');
  assert.equal(parseDecision(renderOllamaReply('I would buy the maximum')).ok, false);
  assert.deepEqual(OLLAMA_DECISION_FORMAT.properties.decision.required, ['action', 'reason']);
});

test('1543 sessions: tool-less requests, the conversation carries over, $0, maxTurns, a late reply is no answer (never a late decision)', async () => {
  let slow = false;
  const fake = await startFakeOllama({ chat: async (_b) => (slow ? { delayMs: 600, content: '{"comment":"late","decision":{"action":"enter","reason":"late"}}' } : { content: '{"comment":"looks ok","decision":{"action":"wait","reason":"need volume"}}' }) });
  try {
    const log: Array<{ kind: string; data: Record<string, unknown> }> = [];
    const f = ollamaSessionFactory({ client: new OllamaClient({ host: host(fake.url) }), model: 'qwen3:8b', numCtx: 8192, restriction: 'paper', systemPrompt: () => 'SYSTEM', gate: gate(), log: (kind, data) => log.push({ kind, data }) });
    const s = { ...loadPreset('scalp') };
    s.agent = { ...s.agent, maxTurns: 3, decideWithinSec: 0.3 };
    const sess = f('c1', s, { kind: 'candidate', mint: 'M1' });
    assert.equal(sess.kind, 'ollama');
    assert.equal(sess.model, 'qwen3:8b');
    const r1 = await sess.send('DOSSIER candidate …');
    assert.ok(r1 && r1.decision.ok && r1.decision.decision.action === 'wait');
    assert.equal(r1!.costUsd, 0);
    const r2 = await sess.send('DELTA #1 …');
    assert.ok(r2);
    const bodies = fake.chats();
    for (const b of bodies) {
      assert.equal('tools' in b, false, 'never a tools key: the session can only answer');
      assert.deepEqual(b.format, JSON.parse(JSON.stringify(OLLAMA_DECISION_FORMAT)));
    }
    const msgs = bodies[1].messages as Array<{ role: string; content: string }>;
    assert.deepEqual(msgs.map((m) => m.role), ['system', 'user', 'assistant', 'user'], 'the second turn carries the first exchange');
    assert.match(msgs[2].content, /^looks ok\nDECISION /);
    slow = true;
    assert.equal(await sess.send('DELTA #2 …'), null, 'past decideWithinSec: no answer');
    assert.equal(await sess.send('DELTA #3 …'), null, 'maxTurns reached');
    assert.equal(sess.costUsd(), 0);
    assert.equal((await sess.close('done')).costUsd, 0);
    assert.ok(log.some((e) => e.kind === 'session_init' && e.data.engine === 'ollama' && e.data.tools === 0 && e.data.costUsd === 0 && e.data.model === 'qwen3:8b'));
  } finally { await fake.close(); }
});

test('1543 sessions: the restriction profile gates autotrade (paper; live needs full); an unreachable server ends the session', async () => {
  assert.throws(() => assertAutotradeAllowed('observe'), /profile is observe; an autotrade run needs paper/);
  assert.throws(() => assertAutotradeAllowed('propose'), /needs paper \(dexterm ai restrictions paper\)/);
  assert.doesNotThrow(() => assertAutotradeAllowed('paper'));
  assert.throws(() => assertAutotradeAllowed('paper', true), /a live run needs full/);
  assert.doesNotThrow(() => assertAutotradeAllowed('full', true));
  const dead = ollamaSessionFactory({ client: new OllamaClient({ host: host('127.0.0.1:9') }), model: 'qwen3:8b', numCtx: 4096, restriction: 'paper', systemPrompt: () => '', gate: gate(), log: () => {} });
  const sess = dead('c1', loadPreset('scalp'), { kind: 'candidate', mint: 'M1' });
  assert.equal(await sess.send('DOSSIER'), null);
  assert.equal(sess.endReason(), 'ollama-unreachable');
  assert.equal(await sess.send('DELTA'), null, 'a dead session stays dead');
});

test('1543 CAPS PARITY: the same decisions from a claude session and an Ollama session give identical clamps, refusals and fills (caps are engine-independent)', async () => {
  // The decision maker for both engines: the deterministic stub, asking for 100 % of the bankroll every time (far
  // beyond the strategy, so the clamp and the caps must cut it the same way whoever asked).
  const brain = stubSession({ askPct: 100, confidence: 0.9 });
  const brains = new Map<string, AgentSession>();
  const decide = async (id: string, text: string) => {
    if (!brains.has(id)) brains.set(id, brain(id, loadPreset('scalp')));
    return (await brains.get(id)!.send(text))!;
  };
  // claude-kind: what the claude factory hands the runner, minus the process.
  const claudeKind = (id: string) => {
    let turns = 0;
    return {
      id, kind: 'claude' as const, model: 'claude-sonnet-5-5', costUsd: () => 0, endReason: () => null, turnsUsed: () => turns,
      send: (text: string) => { turns++; return decide(`claude:${id}`, text); },
      close: async (reason: string) => ({ turns, costUsd: 0, reason }),
    };
  };
  const s = { ...loadPreset('scalp') };
  const a = await runAutotrade({ strategy: s, tape: loadTape(TAPE), sessions: (id) => claudeKind(id), pacing: { mode: 'lockstep' } });

  // ollama: a fake server whose "model" is the same stub, answering in the structured shape.
  const fake = await startFakeOllama({ chat: async (b) => {
    const msgs = b.messages as Array<{ role: string; content: string }>;
    const sid = String(msgs[0].content);
    const r = await decide(`ollama:${sid}`, msgs[msgs.length - 1].content);
    const d = r.decision.ok ? r.decision.decision : { action: 'skip', reason: 'x' };
    return { content: JSON.stringify({ comment: 'stub', decision: d }) };
  } });
  try {
    // The system prompt carries the session id so the fake keeps one stub brain per session.
    let sid = '';
    const f = ollamaSessionFactory({ client: new OllamaClient({ host: host(fake.url) }), model: 'qwen3:8b', numCtx: 8192, restriction: 'paper', systemPrompt: () => sid, gate: gate(), log: () => {} });
    const b = await runAutotrade({ strategy: s, tape: loadTape(TAPE), sessions: (id, st, ctx) => { sid = id; return f(id, st, ctx); }, pacing: { mode: 'lockstep' } });
    const norm = (evs: typeof a.ledger.events) => evs.map((e) => {
      // engine/model differ by design; ms is wall-clock latency (a process vs an HTTP round trip)
      const { hash: _h, prev: _p, head: _hd, agent: _a, model: _m, ms: _ms, ...rest } = e as Record<string, unknown>;
      return rest;
    });
    assert.ok(a.trades.length > 0, 'the run trades');
    const clampsA = a.ledger.events.filter((e) => e.kind === 'clamp');
    assert.ok(clampsA.length > 0, 'the 100 % asks were clamped');
    assert.deepEqual(norm(b.ledger.events), norm(a.ledger.events), 'identical ledgers apart from the engine and model fields');
    assert.deepEqual(b.trades, a.trades);
    assert.deepEqual(b.refusals, a.refusals);
    assert.ok(Object.values(a.refusals).reduce((x, y) => x + y, 0) > 0, "the run hit refusals (caps/cooldowns) on both engines");
    assert.deepEqual(b.clamps, a.clamps);
    assert.ok(b.ledger.events.some((e) => e.kind === 'session_start' && e.agent === 'ollama' && e.model === 'qwen3:8b'), 'the ledger records the engine and the local model');
    assert.ok(a.ledger.events.some((e) => e.kind === 'session_start' && e.agent === 'claude' && e.model === 'claude-sonnet-5-5'));
    assert.equal(b.sessionCostUsd, 0);
  } finally { await fake.close(); }
});

test('1543 parity rows for autotrade, live and Telegram name this file and the profile they need', () => {
  const rows = ENGINE_PARITY.filter((r) => ['autotrade-sessions', 'live-executors', 'telegram', 'allowance-guard'].includes(r.id));
  assert.equal(rows.length, 4);
  for (const r of rows) assert.equal(r.test, 'packages/autotrade/test/ollama-sessions-1543.test.ts');
  assert.equal(rows.find((r) => r.id === 'live-executors')!.minLevel, 'full');
  assert.equal(rows.find((r) => r.id === 'telegram')!.status, 'engine-independent');
});
