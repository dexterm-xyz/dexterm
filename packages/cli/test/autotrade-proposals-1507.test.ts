// task-1507 (AT-5): a chat proposal reaches a strategy ONLY through the user's keys on the Q screen. `o` opens the
// diff card, y applies a tighter/neutral edit, a LOOSER edit needs a second y on the less-safe popup, n dismisses.
// Applying re-checks the proposal from scratch: a forged or stale proposal file cannot set mode live, raise the day
// budget or skip the second key. Fixtures only: a temp DEXTERM_HOME, proposals made through the real MCP tool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { THEMES, parseKeys } from '@dexterm/tui';
import { StrategyStore } from '@dexterm/autotrade';
import { AutotradeTools, ProposalFiles, type StrategyProposalRecord } from '@dexterm/mcp';
import { makeFixtureState, renderFrame } from '../src/state.ts';
import { applyAction, applyKey } from '../src/main.ts';
import { autotradeCapturing, defaultDeps, newAutotradeUi } from '../src/screens/autotrade-ui.ts';
import { applyProposal, recheck } from '../src/screens/autotrade-proposals.ts';
import { deniedActionTools } from '../src/analyst/backend.ts';
import { codexAllowedTools } from '../src/analyst/codex.ts';

function harness() {
  const home = mkdtempSync(join(tmpdir(), 'autotrade-1507-'));
  const env = { ...process.env, DEXTERM_HOME: home };
  const store = new StrategyStore({ home });
  assert.ok(store.createFrom('swing', 'my-swing', { actor: 'user' }).ok);
  const state = makeFixtureState({ theme: THEMES.midnight, calm: true });
  state.autotradeUi = newAutotradeUi(defaultDeps(env));
  const stack: never[] = [];
  applyAction(state, 'screen.autotrade', stack);
  const ui = state.autotradeUi;
  ui.selected = ui.entries.findIndex((e) => e.id === 'my-swing');
  const chat = new AutotradeTools({ env, actor: 'analyst' });
  const files = new ProposalFiles(home);
  const type = (text: string) => { for (const k of parseKeys(text)) applyKey(state, k, stack); };
  const file = () => readFileSync(join(home, 'strategies', 'my-swing.json'), 'utf8');
  const doc = () => JSON.parse(file());
  return { home, env, store, state, stack, ui, chat, files, type, file, doc };
}
type H = ReturnType<typeof harness>;
const propose = async (h: H, ops: unknown[], why = 'tune') => {
  const r = await h.chat.call('strategy_propose_edit', { id: 'my-swing', ops, why });
  assert.equal(r.ok, true, JSON.stringify(r));
  return String(r.proposalId);
};

test('a tighter edit: o opens the card, one y applies it, the journal names the proposal and the proposer', async () => {
  const h = harness();
  const id = await propose(h, [{ op: 'replace', path: '/risk/maxConcurrent', value: 1 }], 'one position at a time');
  assert.equal(h.doc().risk.maxConcurrent, 2, 'proposing changed nothing');
  h.type('o');
  assert.ok(h.ui.review, 'the review card is open');
  assert.equal(autotradeCapturing(h.ui), true, 'the card owns the keyboard (the loop routes y/n to it, not to alerts or demo keys)');
  const f = renderFrame(h.state, 140, 40).toPlain();
  assert.match(f, /CHAT PROPOSAL · my-swing · TIGHTER · PAPER/);
  assert.match(f, /- \/risk\/maxConcurrent 2/);
  assert.match(f, /\+ \/risk\/maxConcurrent 1/);
  assert.match(f, /proposed by analyst/);
  h.type('y');
  assert.equal(h.ui.review, null);
  assert.match(String(h.ui.notice), /applied my-swing v1\.0\.1 \(tighter\)/);
  assert.equal(h.doc().risk.maxConcurrent, 1);
  assert.equal(h.doc().version, '1.0.1');
  assert.equal(h.ui.entries.find((e) => e.id === 'my-swing')!.version, '1.0.1', 'the list shows the new version at once');
  const j = h.store.journal('my-swing').at(-1)!;
  assert.equal(j.actor, 'analyst'); assert.equal(j.proposalId, id); assert.equal(j.action, 'patch');
  assert.deepEqual(j.ops, [{ op: 'replace', path: '/risk/maxConcurrent', value: 1 }]);
  assert.ok(j.beforeHash && j.afterHash && j.beforeHash !== j.afterHash);
  const rec = h.files.get(id)!;
  assert.equal(rec.status, 'applied'); assert.deepEqual(rec.keys, ['y']); assert.equal(rec.appliedVersion, '1.0.1');
});

test('a LOOSER edit needs two keys: the first y only opens the less-safe popup', async () => {
  const h = harness();
  const id = await propose(h, [{ op: 'replace', path: '/sizing/pct', value: 14 }], 'bigger entries');
  const before = h.file();
  h.type('o');
  assert.match(renderFrame(h.state, 140, 40).toPlain(), /LOOSER: sizing\/pct/);
  h.type('y');
  assert.equal(h.ui.review?.stage, 'less-safe');
  assert.equal(h.file(), before, 'one key applied nothing');
  const f = renderFrame(h.state, 140, 40).toPlain();
  assert.match(f, /LESS SAFE/);
  assert.match(f, /\/sizing\/pct {2}10 → 14/);
  h.type('y');
  assert.equal(h.doc().sizing.pct, 14);
  assert.deepEqual(h.files.get(id)!.keys, ['y', 'y']);
  assert.match(h.store.journal('my-swing').at(-1)!.why ?? '', /after the less-safe popup/);
});

test('any other key on the less-safe popup cancels; the proposal stays pending; n dismisses', async () => {
  const h = harness();
  const id = await propose(h, [{ op: 'replace', path: '/risk/maxExposurePct', value: 60 }]);
  const before = h.file();
  h.type('oyx');
  assert.equal(h.ui.review, null);
  assert.equal(h.file(), before);
  assert.equal(h.files.get(id)!.status, 'pending');
  h.type('on');
  assert.equal(h.files.get(id)!.status, 'dismissed');
  assert.equal(h.file(), before);
});

test('applyProposal refuses a looser edit with one key, whatever riskDelta the stored file claims', async () => {
  const h = harness();
  const id = await propose(h, [{ op: 'replace', path: '/risk/dailyLossHaltPct', value: 40 }]);
  const rec = h.files.get(id)!;
  // a forged file that claims the edit is neutral: the fresh check still says looser
  const forged: StrategyProposalRecord = { ...rec, riskDelta: 'neutral', reasons: [] };
  writeFileSync(join(h.home, 'strategies', '.proposals', `${id}.json`), JSON.stringify(forged));
  const r = applyProposal(h.store, h.files, h.files.get(id)!, ['y']);
  assert.equal(r.ok, false);
  assert.match(r.message, /second keypress/);
  assert.equal(h.doc().risk.dailyLossHaltPct, 15);
  assert.equal(applyProposal(h.store, h.files, h.files.get(id)!, ['y', 'y']).ok, true);
});

test('a forged proposal file cannot set mode live or raise the day budget, even with two keys', async () => {
  const h = harness();
  const id = await propose(h, [{ op: 'replace', path: '/risk/maxConcurrent', value: 1 }]);
  const rec = h.files.get(id)!;
  const before = h.file();
  for (const ops of [
    [{ op: 'replace', path: '/mode', value: 'live' }],
    [{ op: 'replace', path: '/agent', value: { ...h.doc().agent, budgetUsdPerDay: 999 } }],
  ]) {
    const forged = { ...rec, ops, effectiveOps: ops, riskDelta: 'tighter' } as StrategyProposalRecord;
    writeFileSync(join(h.home, 'strategies', '.proposals', `${id}.json`), JSON.stringify(forged));
    assert.equal(recheck(h.store, h.files.get(id)!).ok, false);
    const r = applyProposal(h.store, h.files, h.files.get(id)!, ['y', 'y']);
    assert.equal(r.ok, false, JSON.stringify(ops));
    assert.match(r.message, /only you can change/);
    h.type('o');
    assert.match(renderFrame(h.state, 140, 40).toPlain(), /CANNOT APPLY/);
    h.type('yy');
    assert.equal(h.file(), before, 'nothing written');
    h.type('\x1b');
  }
});

test('a stale proposal (the strategy changed since) is refused; a new-strategy proposal creates the file as paper', async () => {
  const h = harness();
  const id = await propose(h, [{ op: 'replace', path: '/risk/maxConcurrent', value: 1 }]);
  assert.ok(h.store.patch('my-swing', [{ op: 'replace', path: '/risk/maxEntriesPerDay', value: 6 }], { actor: 'user' }).ok);
  const r = applyProposal(h.store, h.files, h.files.get(id)!, ['y']);
  assert.equal(r.ok, false);
  assert.match(r.message, /changed since this proposal/);
  const n = await h.chat.call('strategy_propose_new', { fromPreset: 'moonbag', id: 'bag-two', name: 'Bag two', ops: [] });
  assert.equal(n.ok, true, JSON.stringify(n));
  h.ui.selected = 0;
  h.type('o');
  assert.match(renderFrame(h.state, 140, 40).toPlain(), /new bag-two from moonbag/);
  h.type('y');
  const created = JSON.parse(readFileSync(join(h.home, 'strategies', 'bag-two.json'), 'utf8'));
  assert.equal(created.mode, 'paper');
  assert.equal(created.name, 'Bag two');
  const j = h.store.journal('bag-two').at(-1)!;
  assert.equal(j.action, 'create'); assert.equal(j.proposalId, n.proposalId); assert.equal(j.from, 'moonbag');
});

test('o with no proposals says so; the list card counts pending proposals', async () => {
  const h = harness();
  h.type('o');
  assert.equal(h.ui.review, null);
  assert.match(String(h.ui.notice), /no chat proposals/);
  await propose(h, [{ op: 'replace', path: '/risk/maxConcurrent', value: 1 }]);
  h.ui.deps.proposalSource!.invalidate();
  assert.match(renderFrame(h.state, 140, 40).toPlain(), /PROPOSALS FROM CHAT · 1/);
});

test('the in-app analyst may propose in chat; an observe-only scan session cannot (claude and codex engines)', () => {
  assert.ok(!deniedActionTools(undefined).some((t) => /strategy_propose/.test(t)), 'chat: nothing denied');
  assert.ok(deniedActionTools([]).includes('mcp__dexterm__strategy_propose_edit'));
  assert.ok(deniedActionTools([]).includes('mcp__dexterm__strategy_propose_new'));
  assert.ok(codexAllowedTools(undefined).includes('strategy_propose_edit'));
  assert.ok(!codexAllowedTools([]).some((t) => /strategy_propose/.test(t)));
  for (const t of ['strategy_list', 'strategy_get', 'strategy_backtest', 'autotrade_status']) assert.ok(codexAllowedTools([]).includes(t), `${t} is a read`);
});
