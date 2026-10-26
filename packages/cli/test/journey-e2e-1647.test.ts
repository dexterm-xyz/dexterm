// task-1647 (0.2.0 card C): the whole journey end to end, with fakes only (no network, no mainnet, no model, no key).
//
//   1. chat: "build me a strategy that ..." → the analyst (a scripted fake Ollama model, through the REAL dexterm MCP
//      server over stdio) proposes a new strategy and an edit; the user applies each with a key (the Q screen's
//      applyProposal); the analyst reads the journey and is refused when it tries to skip to always-on
//   2. the analyst backtests it (held-out split recorded as evidence), starts a FORWARD TEST (the real forward host,
//      in-process, on a live-shaped feed of the fixture tape), reads the report next to the backtest, and proposes
//      always-on; the user applies it with y on their terminal; autotrade.json gets the paper member
//   3. the analyst proposes real; the user sets their own caps (typed RAISE), a channel, and applies the promotion,
//      which hands over to card A's `signal arm` (evidence panel + typed phrase): the strategy is armed for real
//
// The MCP server subprocess has no recorded history or live feed in a test, so steps 2-3 drive the same AutotradeTools
// class the server builds, in-process, with the fixture tape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProposalFiles, AutotradeTools } from '@dexterm/mcp';
import { StrategyStore, fleetConfigPath, hostForward, journeyView, loadArmings, loadJourney, loadSignalsConfig, enabledChannels, loadTape, realModeCheck, recordForwardResult, type MarketTick, type Tape } from '@dexterm/autotrade';
import { runAnalyst, type AnalystRequest, type ResultEvent } from '../src/analyst/backend.ts';
import { resetOllamaConversations } from '../src/analyst/ollama.ts';
import { applyProposal } from '../src/screens/autotrade-proposals.ts';
import { forwardCmd } from '../src/autotrade-cmd/forward.ts';
import { journeyCmd, promoteCmd } from '../src/autotrade-cmd/journey.ts';
import { signalCmd } from '../src/autotrade-cmd/signal.ts';
import { startFakeOllama, type ChatHandler } from '../../mcp/test/fake-ollama.ts';

process.env.DEXTERM_OFFLINE = '1';
const TAPE = new URL('../../autotrade/test/fixtures/autotrade-1498-tape.json', import.meta.url);
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dexterm-1647-e2e-'));
const ID = 'young-push';
process.env.DEXTERM_HOME = HOME; // the analyst's MCP server inherits the process env

interface Turn { text: string; tools: string[]; result: ResultEvent | null; error: string | null }
function turn(req: AnalystRequest, env: NodeJS.ProcessEnv): Promise<Turn> {
  return new Promise((resolve) => {
    const t: Turn = { text: '', tools: [], result: null, error: null };
    const timer = setTimeout(() => { t.error = 'timeout'; resolve(t); }, 30_000);
    runAnalyst({ engine: 'ollama', ...req }, {
      onInit: () => {}, onToolCall: (ev) => t.tools.push(ev.name), onText: (d) => { t.text += d; },
      onResult: (r) => { clearTimeout(timer); t.result = r; resolve(t); },
      onError: (m, d) => { clearTimeout(timer); t.error = `${m} | ${d ?? ''}`; resolve(t); },
    }, { ollama: { env } });
  });
}
/** One analyst turn: the scripted model calls `calls` in order (one per round), then says `say`. Returns the tool results. */
async function chat(prompt: string, calls: { name: string; arguments: Record<string, unknown> }[], say: string): Promise<{ t: Turn; results: Record<string, unknown>[] }> {
  const chatH: ChatHandler = (_b, n) => (n < calls.length ? { tool_calls: [{ function: calls[n] }] } : { content: say });
  const fake = await startFakeOllama({ chat: chatH });
  try {
    resetOllamaConversations();
    const env = { DEXTERM_HOME: HOME, DEXTERM_OLLAMA_HOST: fake.url, DEXTERM_OLLAMA_MODEL: 'qwen3:8b', DEXTERM_OFFLINE: '1' };
    const t = await turn({ prompt, screenState: { screen: 'autotrade' } }, env);
    const last = fake.chats()[fake.chats().length - 1];
    const results = (last.messages as Array<{ role: string; content: string }>).filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content) as Record<string, unknown>);
    return { t, results };
  } finally { await fake.close(); }
}
function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { stdout: { write: (s: string) => { out.push(s); return true; } }, stderr: { write: (s: string) => { err.push(s); return true; } }, env: { ...process.env, DEXTERM_HOME: HOME } } };
}
function feed(tape: Tape): { name: string; ticks: AsyncIterable<MarketTick>; stop: () => void } {
  let stopped = false;
  return { name: 'live (test feed)', stop: () => { stopped = true; }, ticks: (async function* () { for (const k of tape.ticks) { if (stopped) return; yield k; } })() };
}
const store = () => new StrategyStore({ home: HOME });
const applyPending = (id: string) => {
  const files = new ProposalFiles(HOME);
  const rec = files.list({ status: 'pending', id })[0];
  assert.ok(rec, `a pending proposal for ${id}`);
  const r = applyProposal(store(), files, rec, ['y', 'y']); // the card's y (and the less-safe popup's y if it is looser)
  assert.ok(r.ok, r.message);
};

test('1647 e2e: chat build → edit → validate → backtest (held-out) → forward test → report → always-on → real, nothing promoted by the model', async () => {
  // ── 1. chat: a new strategy from a natural-language request, through the real MCP server
  const t1 = await chat('build me a strategy that buys young pairs on a 5 minute push, takes the cost back at 2x and lets the rest ride', [
    { name: 'strategy_list', arguments: {} },
    { name: 'strategy_propose_new', arguments: { fromPreset: 'moonbag', id: ID, name: 'Young pair push', ops: [{ op: 'replace', path: '/risk/maxConcurrent', value: 2 }], why: 'young pairs on a push, cost back at 2x, the rest rides (from the moonbag preset)' } },
  ], 'I proposed "young-push" from the moonbag preset. Open the card on the Q screen (o) and press y to create it. It is paper.');
  assert.equal(t1.t.error, null, t1.t.error ?? '');
  assert.deepEqual(t1.t.tools, ['strategy_list', 'strategy_propose_new']);
  assert.equal(t1.results[1].applied, false, JSON.stringify(t1.results).slice(0, 600));
  assert.equal(t1.results[1].ok, true, JSON.stringify(t1.results[1]).slice(0, 600));
  assert.ok(!store().has(ID), 'nothing exists until the user applies it');
  applyPending(ID);
  assert.equal(store().get(ID)?.ok, true);
  assert.equal((store().raw(ID) as { mode: string }).mode, 'paper');

  // an edit, validated by the server, applied by the user
  const doc = store().raw(ID) as unknown as Record<string, unknown>;
  const t2 = await chat('make each entry a bit smaller', [
    { name: 'strategy_propose_edit', arguments: { id: ID, ops: [{ op: 'replace', path: '/sizing/maxUsd', value: 40 }], why: 'smaller entries' } },
    { name: 'strategy_validate', arguments: { doc: { ...doc, sizing: { ...(doc.sizing as object), maxUsd: 40 } } } },
  ], 'Proposed: max entry $40 (tighter). Press y on the card to apply.');
  assert.equal(t2.t.error, null, t2.t.error ?? '');
  assert.equal(t2.results[0].riskDelta, 'tighter');
  assert.equal(t2.results[1].ok, true);
  applyPending(ID);
  assert.equal((store().raw(ID) as { version: string }).version, '1.0.1');

  // the analyst reads the ladder and is refused when it tries to skip ahead
  const t3 = await chat('put it on the always-on service', [
    { name: 'strategy_journey', arguments: { id: ID } },
    { name: 'strategy_promote_propose', arguments: { id: ID, to: 'always-on', why: 'the user asked' } },
  ], 'It is a draft: it needs a backtest and a forward test before always-on.');
  assert.equal(t3.t.error, null, t3.t.error ?? '');
  assert.equal(t3.results[0].stage, 'draft');
  assert.equal(t3.results[1].reason, 'skip-refused');
  assert.ok(!fs.existsSync(fleetConfigPath(HOME)));

  // ── 2. backtest + forward test + report + always-on (the same tool class, in-process, on the fixture tape)
  let clock = Date.UTC(2026, 9, 24, 15);
  const hosts: Promise<unknown>[] = [];
  const analyst = new AutotradeTools({
    env: { ...process.env, DEXTERM_HOME: HOME }, actor: 'analyst', tape: () => loadTape(TAPE), now: () => clock,
    forwardSpawner: (h, t) => { hosts.push(hostForward({ home: h, forwardId: t.forwardId, source: feed(loadTape(TAPE)), sessions: null, pacing: { mode: 'lockstep' } })); return process.pid; },
  });
  const bt = await analyst.call('strategy_backtest', { id: ID });
  assert.ok(bt.heldOut, JSON.stringify(bt).slice(0, 200));
  const cur = store().get(ID);
  assert.ok(cur && cur.ok);
  assert.equal(journeyView(HOME, cur.strategy).stage, 'backtested');
  const fs1 = await analyst.call('strategy_forward_start', { id: ID, trades: 2 });
  assert.equal(fs1.started, true, JSON.stringify(fs1));
  const st = io();
  assert.equal(await forwardCmd(['status', ID], st.io), 0);
  assert.match(st.out.join(''), new RegExp(`${String(fs1.forwardId)}\\s+${ID}`));
  await Promise.all(hosts);
  clock += 60_000;
  const rep = await analyst.call('strategy_forward_report', { id: ID });
  assert.equal(rep.state, 'done');
  assert.equal((rep.comparison as { claim: boolean }).claim, false);
  assert.ok((rep.comparison as { verdict: string[] }).verdict.some((v) => /too small a sample to claim anything/.test(v)));
  const cliRep = io();
  assert.equal(await forwardCmd(['report', ID], cliRep.io), 0);
  assert.match(cliRep.out.join(''), /forward vs backtest of the same rules/);
  const p1 = await analyst.call('strategy_promote_propose', { id: ID, to: 'always-on', why: 'the forward test ran its window' });
  assert.equal(p1.ok, true);
  assert.equal(p1.applied, false);
  assert.ok(!fs.existsSync(fleetConfigPath(HOME)), 'a proposal is not a promotion');
  const ap = io();
  assert.equal(await promoteCmd(['apply', String(p1.proposalId)], ap.io, { tty: true, typed: async () => 'y' }), 0, ap.err.join(''));
  assert.ok(JSON.parse(fs.readFileSync(fleetConfigPath(HOME), 'utf8')).strategies.some((m: { preset: string }) => m.preset === ID));
  const jv = io();
  assert.equal(journeyCmd([ID], jv.io), 0);
  assert.match(jv.out.join(''), /stage ALWAYS-ON/);

  // ── 3. real: proposed by the model, applied only through the user's caps + typed phrase (card A's arm)
  // task-1679: the 2-trade forward test is below the evidence floor (10): nothing is proposed
  const p2low = await analyst.call('strategy_promote_propose', { id: ID, to: 'real', why: 'always-on is running' });
  assert.equal(p2low.reason, 'evidence-floor');
  const fw = loadJourney(HOME, ID).forwards.find((x) => x.state === 'done');
  assert.ok(fw && fw.metrics);
  recordForwardResult(HOME, { ...fw, metrics: { ...fw.metrics, trades: 12 } }); // as if the window had closed 12
  const p2 = await analyst.call('strategy_promote_propose', { id: ID, to: 'real', why: 'always-on is running' });
  assert.equal(p2.ok, true);
  const noCaps = io();
  assert.equal(await promoteCmd(['apply', String(p2.proposalId)], noCaps.io, { tty: true, typed: async () => 'y' }), 1);
  assert.match(noCaps.err.join(''), /set your own real-mode caps first/);
  const phrase = (p: string) => /"([^"]+)"/.exec(p)![1];
  const caps = io();
  assert.equal(await signalCmd(['caps', 'set', '--per-trade-sol', '0.02', '--daily-sol', '0.1', '--buys-per-day', '5', '--max-open', '1'], caps.io, { tty: true, code: () => 'C4PS', typed: async (p) => phrase(p) }), 0, caps.err.join(''));
  assert.equal(await signalCmd(['channels', '--jsonl', 'on'], io().io), 0);
  const arm = io();
  assert.equal(await promoteCmd(['apply', String(p2.proposalId)], arm.io, { tty: true, code: () => 'R3AL', typed: async (p) => phrase(p) }), 0, arm.err.join(''));
  const armOut = arm.out.join('');
  assert.match(armOut, /REAL MODE · arm young-push/);
  assert.match(armOut, /held-out {2}too few trades to claim anything/);
  assert.match(armOut, /journey {3}stage always-on/);
  assert.doesNotMatch(armOut, /SKIPS THE LADDER/);
  assert.match(armOut, /evidence {2}floor met: a completed forward test with 12 closed paper trades \(at least 10\)/);
  assert.doesNotMatch(armOut, /OVERRIDE/);
  assert.match(armOut, /forward {3}fw_\S+ done; v1\.0\.1; \d+ trades/);
  assert.match(armOut, /promotion pp_\S+ → real: applied by this arming/);
  const s = store().get(ID);
  assert.ok(s && s.ok && s.strategy.mode === 'real');
  assert.equal(loadArmings(HOME)[ID].strategyHash, s.strategy.hash);
  assert.equal(journeyView(HOME, s.strategy, { armedHash: loadArmings(HOME)[ID].strategyHash }).stage, 'real');
  assert.ok(realModeCheck(HOME, s.strategy, enabledChannels(loadSignalsConfig(HOME).config)).ok, 'the runner would accept it: armed, caps, channel, kill off');
  // the audit trail: who proposed and who applied each rung
  const j = loadJourney(HOME, ID);
  assert.deepEqual(j.promotions.map((x) => `${x.to}:${x.action}:${x.by}`).reverse(), ['always-on:proposed:analyst', 'always-on:applied:user', 'real:proposed:analyst', 'real:applied:user:signal-arm']);
  assert.ok(store().journal(ID).every((l) => l.actor === 'analyst' || l.actor.startsWith('user')), 'strategy writes name the proposer; the mode switch names the user');
});
