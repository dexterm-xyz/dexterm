// task-1818: the EXPERIMENTAL MEMES + NARRATIVES tracker in the app. `n` on the N screen flips the theme board ⇄ the heat
// table, ⏎ drills into a narrative's member coins, esc returns to the table; the coin pane's Narrative row; the rules'
// narrative_rank / narrative_score fields and the narrative:<state> tag. Offline: the tracker is built in-test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NarrativeTracker } from '@dexterm/narratives';
import { DEFAULT_KEYMAP, type ScreenKey } from '@dexterm/tui';
import { RulesEngine, ruleToJson, parseExpr, FIELD_NAMES, TAG_NAMES } from '@dexterm/custom';
import { makeFixtureState, renderFrame, computeNarrativeView, type AppState } from '../src/state.ts';
import { applyAction } from '../src/main.ts';
import { ruleRowsOf } from '../src/rules.ts';
import { narrativesCommand } from '../src/narratives-cmd.ts';
import { narrativesUiOf, setNarrativeTracker, ensureNarratives, heatRows, narrativeCell, narrativeRuleFields, currentTracker } from '../src/narratives.ts';

const T = Date.parse('2026-10-28T12:00:00Z'), H = 3_600_000, M = 60_000;

/** An igniting PNUT narrative (3 coins, volume 12x an hour ago, a new coin in the hour) and a copy-cat saturated FROG one (6 coins). */
async function buildTracker(mints: string[]): Promise<{ tr: NarrativeTracker; P: string[]; F: string[] }> {
  const P = mints.slice(0, 3), F = mints.slice(3, 9);
  const tr = new NarrativeTracker();
  await tr.addCoins(F.map((m, i) => ({ mint: m, t: T - 3 * H + i * M, symbol: 'FROG', name: ['frog', 'frog army', 'frog coin', 'frog dog', 'frog king', 'frog inu'][i] })));
  await tr.addCoins([{ mint: P[0], t: T - 2 * H, symbol: 'PNUT', name: 'Peanut the Squirrel' }, { mint: P[1], t: T - 2 * H + M, symbol: 'PNUT', name: 'pnut army' }]);
  const s = (m: string, t: number, vol1h: number, price = 1): void => tr.addSample({ mint: m, t, price, liq: 20_000, vol1h, vol24h: vol1h * 5, traders1h: 50 });
  s(P[0], T - 2 * H + 2 * M, 1000); s(P[1], T - 2 * H + 2 * M, 1000); tr.tick(T - 2 * H + 2 * M, true);
  s(P[0], T - 70 * M, 1000); s(P[1], T - 70 * M, 1000); tr.tick(T - 70 * M, true);
  await tr.addCoins([{ mint: P[2], t: T - 10 * M, symbol: 'PNUT', name: 'pnut king' }]);
  s(P[0], T, 10_000, 3); s(P[1], T, 8_000, 2); s(P[2], T, 6_000);
  F.forEach((m, i) => s(m, T, i < 3 ? 10_000 : 100));
  tr.tick(T, true);
  return { tr, P, F };
}

/** A fixture state on the N screen with the in-test tracker installed (and a fresh refresh stamp so no background build starts). */
async function narrativeState(): Promise<{ state: AppState; P: string[]; F: string[] }> {
  const state = makeFixtureState();
  const mints = state.screener.rows.map((r) => r.mint).filter(Boolean);
  const { tr, P, F } = await buildTracker(mints);
  setNarrativeTracker(state, tr);
  state.screen = 'narrative';
  state.narrative = computeNarrativeView(state, '1h');
  narrativesUiOf(state).refreshedAt = Date.now();
  return { state, P, F };
}

test('keymap: n / ⏎ on the N screen are the narratives verbs; v stays voice everywhere', () => {
  assert.equal(DEFAULT_KEYMAP.resolveId('n', 'narrative'), 'narrative.view');
  assert.equal(DEFAULT_KEYMAP.resolveId('enter', 'narrative'), 'narrative.drill');
  assert.equal(DEFAULT_KEYMAP.resolveId('v', 'screener' as ScreenKey), 'voice.talk');
  assert.equal(DEFAULT_KEYMAP.resolveId('v', 'narrative'), 'voice.talk', 'push-to-talk is not taken on the N screen');
  assert.equal(DEFAULT_KEYMAP.resolveId('enter', 'screener' as ScreenKey), 'open');
});

for (const [w, h] of [[176, 48], [120, 40], [90, 36]] as const) {
  test(`n flips the theme board ⇄ the EXPERIMENTAL heat table (${w}×${h})`, async () => {
    const { state } = await narrativeState();
    assert.match(renderFrame(state, w, h).toPlain(), /NARRATIVE BOARD/, 'the theme board stays the default');
    applyAction(state, 'narrative.view', []);
    assert.equal(state.narrativesUi?.mode, 'heat');
    const plain = renderFrame(state, w, h).toPlain();
    assert.match(plain, /NARRATIVES · EXPERIMENTAL/);
    assert.match(plain, /PNUT/);
    assert.match(plain, /FROG/);
    assert.match(plain, /ignition/);
    assert.match(plain, /peak\*/, 'copy-cat saturation is marked with *');
    if (w >= 120) assert.match(plain, /measured heat, not advice/);
    if (w >= 176) { assert.match(plain, /Not advice, not a prediction/); assert.match(plain, /control-stripped/); assert.match(plain, /PNUT 3\.00x/, 'the top runner'); }
    assert.doesNotMatch(plain, /\b(buy|pick|profit|win)\b/i);
    applyAction(state, 'narrative.view', []);
    assert.equal(state.narrativesUi?.mode, 'board');
    assert.match(renderFrame(state, w, h).toPlain(), /NARRATIVE BOARD/);
  });
}

test('⏎ drills into the selected narrative (members in spawn order + its lifecycle rule); esc returns to the table', async () => {
  const { state } = await narrativeState();
  const stack: ScreenKey[] = ['screener'];
  applyAction(state, 'narrative.view', stack);
  const rows = heatRows(state);
  assert.equal(rows[0].label, 'PNUT');
  applyAction(state, 'move.down', stack);
  assert.equal(state.narrativesUi!.selected, 1, 'j/k move the heat-table cursor');
  applyAction(state, 'move.up', stack);
  applyAction(state, 'narrative.drill', stack);
  assert.equal(state.narrativesUi!.drill?.id, rows[0].id);
  const plain = renderFrame(state, 176, 48).toPlain();
  assert.match(plain, /NARRATIVE · PNUT · ignition/);
  assert.match(plain, /lifecycle rule \(ignition\): 1 h volume >= \$5k/);
  const order = ['Peanut the Squirrel', 'pnut army', 'pnut king'].map((n) => plain.indexOf(n));
  assert.ok(order.every((i) => i > 0) && order[0] < order[1] && order[1] < order[2], 'members in spawn order');
  assert.match(plain, /#1 +PNUT +Peanut the Squirrel +3\.00x/);
  applyAction(state, 'move.down', stack);
  assert.equal(state.narrativesUi!.drill?.selected, 1);
  // fixtures: ⏎ on a member says the token screen needs live mode (no fake token)
  applyAction(state, 'narrative.drill', stack);
  assert.equal(state.screen, 'narrative');
  assert.match(state.pendingToast ?? '', /needs live mode \(PNUT/);
  applyAction(state, 'back', stack);
  assert.equal(state.screen, 'narrative', 'esc in the drill stays on the screen');
  assert.equal(state.narrativesUi!.drill, null);
  assert.match(renderFrame(state, 176, 48).toPlain(), /NARRATIVES · EXPERIMENTAL/);
  applyAction(state, 'back', stack);
  assert.equal(state.screen, 'screener', 'a second esc leaves the screen');
});

test('no tracker yet: the heat table says it is building (and the one-time cost), never a fake table', () => {
  const state = makeFixtureState();
  state.screen = 'narrative';
  state.narrative = computeNarrativeView(state, '1h');
  Object.assign(narrativesUiOf(state), { mode: 'heat', busy: true });
  const plain = renderFrame(state, 176, 48).toPlain();
  assert.match(plain, /building narratives from the visible rows/);
  assert.match(plain, /Not advice/);
});

test('fixture mode (no recorder DB): the tracker is built from the visible screener rows', async () => {
  const state = makeFixtureState();
  state.screen = 'narrative';
  assert.equal(currentTracker(state), null);
  const tr = await ensureNarratives(state, T);
  assert.ok(tr && tr.coins.size > 10);
  assert.equal(currentTracker(state), tr);
  narrativesUiOf(state).mode = 'heat';
  const plain = renderFrame(state, 176, 48).toPlain();
  assert.match(plain, /NARRATIVES · EXPERIMENTAL · \d+ narratives · \d+ coins · visible rows/);
  assert.match(plain, /spark/, 'no history: every narrative starts as a spark');
});

test('coin pane: the Narrative row reads the built tracker only', async () => {
  const bare = makeFixtureState();
  assert.deepEqual(narrativeCell(bare, 'x'), ['open N → n to build', 'na'], 'never builds from the token pane');
  const { state, P, F } = await narrativeState();
  const [txt, lvl] = narrativeCell(state, P[2]);
  assert.equal(lvl, 'na', 'heat is neutral, never a green ok');
  assert.equal(txt, 'PNUT · lifecycle: ignition · rank 1 · #3 of 3');
  assert.equal(narrativeCell(state, F[0])[1], 'warn', 'copy-cat saturated → warn');
  assert.match(narrativeCell(state, F[0])[0], /copy-cat saturated/);
  assert.deepEqual(narrativeCell(state, 'unknownMint'), ['— (not tracked yet)', 'na']);
});

test('rules: narrative_rank / narrative_score fields and the narrative:<state> tag evaluate from the tracker', async () => {
  assert.ok(FIELD_NAMES.includes('narrative_rank') && FIELD_NAMES.includes('narrative_score'));
  assert.ok(TAG_NAMES.includes('narrative'));
  assert.doesNotThrow(() => parseExpr('narrative:ignition and narrative_rank <= 3'));
  const { state, P, F } = await narrativeState();
  assert.deepEqual(narrativeRuleFields(state, P[0]), { narrativeRank: 1, narrativeScore: heatRows(state)[0].score, narrativeLifecycle: 'ignition', narrativeSaturated: false });
  assert.deepEqual(narrativeRuleFields(state, 'nope'), { narrativeRank: null, narrativeScore: null, narrativeLifecycle: null, narrativeSaturated: null });
  const rows = ruleRowsOf(state);
  const fire = (when: string): string[] => {
    const e = new RulesEngine({ rules: [ruleToJson(`when ${when} then alert(info, "narrative heat (not advice)") scope screener name "n"`)] });
    e.observe(rows, T);
    return e.evaluate(rows, T).alerts.map((a) => a.mint).sort();
  };
  assert.deepEqual(fire('narrative:ignition'), [...P].sort(), 'only the igniting narrative\'s coins');
  assert.deepEqual(fire('narrative:saturated'), [...F].sort());
  assert.deepEqual(fire('narrative_rank <= 1'), [...P].sort());
  assert.deepEqual(fire('narrative_score >= 0'), [...P, ...F].sort(), 'untracked coins have no score (clause false)');
  assert.deepEqual(fire('narrative:peak and narrative:saturated'), [...F].sort());
  // no tracker → every narrative clause is false
  const bare = makeFixtureState();
  const e = new RulesEngine({ rules: [ruleToJson('when narrative_score >= 0 or narrative:spark then alert(info, "x") scope screener name "n"')] });
  e.observe(ruleRowsOf(bare), T);
  assert.equal(e.evaluate(ruleRowsOf(bare), T).alerts.length, 0);
});

test('dexterm narratives: a junk --limit / --lookback-h is a usage error (exit 2), not NaN rows or an empty replay', async () => {
  for (const argv of [['--limit', 'abc'], ['--limit', '0'], ['--lookback-h', 'abc'], ['--lookback-h', '-3']]) {
    let err = '';
    const io = { stdout: { write: () => true }, stderr: { write: (s: string) => { err += s; return true; } }, env: {} };
    assert.equal(await narrativesCommand(['top', '--db', '/nonexistent/dexterm.db', ...argv], io), 2, argv.join(' '));
    assert.match(err, /needs a/, argv.join(' '));
  }
});
