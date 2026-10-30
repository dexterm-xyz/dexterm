// task-1822: the `rugp` watch-rule field reads the classifier's drain estimate for a scored coin (null = not scored).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RulesEngine, parseRule, FIELD_NAMES } from '@dexterm/custom';
import { makeFixtureState } from '../src/index.ts';
import { ruleRowsOf } from '../src/rules.ts';

const A = 'RugpMintA111111111111111111111111111111111', B = 'RugpMintB111111111111111111111111111111111';

test('rule field rugp: parses, reads state.classifierByMint, unscored coins never fire', () => {
  assert.ok(FIELD_NAMES.includes('rugp'));
  parseRule('when rugp > 0.8 then alert(warn, "x") scope screener');
  const state = makeFixtureState({ screen: 'screener' }) as never as Parameters<typeof ruleRowsOf>[0];
  (state as { live: unknown }).live = null;
  (state as { screener: { rows: unknown[] } }).screener.rows = [{ mint: A, symbol: 'AAA', mcap: 1e5 }, { mint: B, symbol: 'BBB', mcap: 1e5 }];
  (state as { classifierByMint: Map<string, unknown> }).classifierByMint = new Map([[A, { p: 0.91, model: 'kev-4b-q4', at: Date.now() }]]);
  const rows = ruleRowsOf(state);
  assert.equal(rows.find((r) => r.mint === A)?.rugP, 0.91);
  assert.equal(rows.find((r) => r.mint === B)?.rugP, null);
  const engine = new RulesEngine({ rules: ['when rugp > 0.8 then alert(warn, "classifier: high drain estimate") scope screener name "rugp"'] });
  engine.observe(rows, Date.now());
  const fired = engine.evaluate(rows, Date.now()).alerts.map((e) => e.mint);
  assert.deepEqual(fired, [A]);
});

test('live scoring: no rugp rule = no work; with one, the heuristic fills classifierByMint and the rule can fire', async () => {
  const { classifierLiveTick } = await import('../src/classifier-live.ts');
  const { RulesEngine: RE } = await import('@dexterm/custom');
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const env = { DEXTERM_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'dexterm-clf-live-')) };
  const rows = [
    { mint: A, symbol: 'AAA', liq: 2000, mcap: 30_000, ageMin: 5, freezable: 1, mintable: 1, top10: 60, dev: 20 },
    { mint: B, symbol: 'BBB', liq: 200_000, mcap: 5_000_000, ageMin: 20_000, freezable: 0, mintable: 0, holders: 5000, top10: 10, dev: 0 },
  ];
  const quiet = { rulesUi: { engine: new RE({ rules: ['when liq > 1 then alert(info, "x")'] }) }, classifierByMint: new Map() } as never as Parameters<typeof classifierLiveTick>[0];
  classifierLiveTick(quiet, rows as never, Date.now(), env);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((quiet as { classifierByMint: Map<string, unknown> }).classifierByMint.size, 0, 'no rugp rule: nothing scored');

  const state = { rulesUi: { engine: new RE({ rules: ['when rugp > 0.7 then alert(warn, "high drain estimate")'] }) }, classifierByMint: new Map() } as never as Parameters<typeof classifierLiveTick>[0];
  const map = (state as { classifierByMint: Map<string, { p: number; model: string }> }).classifierByMint;
  for (let i = 0; i < 40 && map.size < 2; i++) { classifierLiveTick(state, rows as never, Date.now(), env); await new Promise((r) => setTimeout(r, 50)); }
  assert.equal(map.size, 2);
  assert.ok(map.get(A)!.p > 0.7 && map.get(B)!.p < 0.3, JSON.stringify([...map]));
  assert.match(map.get(A)!.model, /^heuristic /);
});
