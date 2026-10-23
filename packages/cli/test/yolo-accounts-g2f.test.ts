// v0.1.7 merge of G2 (paper accounts, task-1538) and F (yolo preset, task-1532): the yolo preset on shared paper
// accounts under `run --all --paper`, its HIGH RISK line there, its LARP gate in the fleet (the single run had it, the
// fleet did not pass it on), and the live refusals that still hold for the combination. A paced replay of the yolo
// fixture tape with stub sessions and fake LARP checks in a temp $DEXTERM_HOME: no network, no model, no keys, paper only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KillSwitch } from '@dexterm/data';
import {
  DEFAULT_GLOBAL_CAPS, DEFAULT_RUNNER_CONFIG, FleetGuard, Ledger, builtinTapePath, loadPreset, loadTape, memberStrategy, runFleet,
  type FleetMemberSpec, type LedgerEvent, type MarketTick, type MemberConfig,
} from '@dexterm/autotrade';
import { fleetLarpVet, fleetRunCmd } from '../src/autotrade-cmd/fleet.ts';

const TAPE = fileURLToPath(builtinTapePath('builtin:yolo-rehearsal'));
const OK = { halt: null, flatten: false, pauseEntries: null, endWhenFlat: false };

function io(config?: unknown) {
  const home = mkdtempSync(join(tmpdir(), 'dexterm-g2f-'));
  mkdirSync(join(home, 'autotrade'), { recursive: true });
  if (config !== undefined) writeFileSync(join(home, 'autotrade', 'autotrade.json'), JSON.stringify(config));
  const out: string[] = [], err: string[] = [];
  return { home, out, err, io: { stdout: { write: (s: string) => { out.push(s); return true; } }, stderr: { write: (s: string) => { err.push(s); return true; } }, env: { DEXTERM_HOME: home, DEXTERM_DB_PATH: join(home, 'none.db'), PATH: process.env.PATH ?? '' } } };
}
const noPanic = (home: string) => new KillSwitch(join(home, 'trading.panic'));
const CONFIG = {
  schema: 'dexterm-autotrade/1', solUsd: 150,
  accounts: [{ id: 'main', bankroll: { usd: 1000 } }, { id: 'degen', bankroll: { sol: 1 } }],
  strategies: [{ id: 'yolo', preset: 'yolo', account: ['main', 'degen'] }, { id: 'moon', preset: 'moonbag', account: 'main' }],
};

test('g2f cli: yolo on two paper accounts next to moonbag; HIGH RISK said for the yolo members; the account table', async () => {
  const x = io(CONFIG);
  const code = await fleetRunCmd(['--all', '--paper', '--replay', TAPE, '--ms-per-tick', '1', '--stub'], x.io, { killSwitch: noPanic(x.home) });
  const out = x.out.join('');
  assert.equal(code, 0, x.err.join(''));
  assert.match(out, /PAPER · 3 strategies at once/);
  assert.match(out, /paper accounts: main \$1000 ← yolo-main, moon · degen \$150 \(1 SOL\) ← yolo-degen/);
  assert.match(out, /⚠ HIGH RISK strategies \(yolo-main, yolo-degen\): .*can lose all funds; not financial advice/);
  assert.doesNotMatch(out, /HIGH RISK[^\n]*moon/, 'moonbag is not high risk');
  assert.match(out, /\[yolo-main\] BUY /);
  assert.match(out, /\[yolo-degen\] BUY /);
  assert.match(out, /yolo-main\s+main\s+stopped/);
  assert.match(out, /yolo-degen\s+degen\s+stopped/);
  assert.match(out, /main\s+\$1000 .*yolo-main moon/);
  assert.match(out, /together .* on \$1150\.00 \(paper\)/, 'main $1000 + degen $150, each counted once');
  // The trade ledger per account; % of book is the entry against the account (25% at most on paper), not x100 again.
  const { ledgerCommand } = await import('../src/ledger-cmd.ts');
  const lo: string[] = [];
  assert.equal(await ledgerCommand(['trades', '--account', 'degen'], { ...x.io, stdout: { write: (s: string) => { lo.push(s); return true; } } } as never), 0);
  const rows = lo.join('').split('\n').filter((l) => /yolo-degen@/.test(l));
  assert.ok(rows.length >= 1, lo.join(''));
  for (const r of rows) {
    const pct = Number(/\$\d+\s+(\d+)%/.exec(r)?.[1]);
    assert.ok(pct > 0 && pct <= 30, `% of book ${pct} in: ${r}`);
  }
});

test('g2f cli: a live yolo member on a paper account is refused before anything starts; run --all stays paper only', async () => {
  const x = io({ schema: 'dexterm-autotrade/1', accounts: [{ id: 'main', bankroll: { usd: 1000 } }], strategies: [{ id: 'my-yolo', preset: 'yolo', account: 'main', mode: 'live' }] });
  assert.equal(await fleetRunCmd(['--all', '--paper', '--replay', TAPE, '--stub'], x.io, { killSwitch: noPanic(x.home) }), 1);
  assert.match(x.err.join(''), /\/strategies\/0\/mode live execution is not available for parallel strategies/);
  assert.match(x.err.join(''), /\/strategies\/0\/account paper accounts hold simulated cash only; a live strategy cannot use one/);
  const y = io(CONFIG);
  assert.equal(await fleetRunCmd(['--all', '--live', '--stub'], y.io, { killSwitch: noPanic(y.home) }), 2);
  assert.match(y.err.join(''), /parallel strategies run on paper only/);
});

test('g2f fleetLarpVet: only gated members get a vet; per-member threshold; one check per coin; a failed check is not kept and fails closed', async () => {
  const yolo = loadPreset('yolo');
  const spec = (id: string, larp: { maxScore: number; unknown: 'reject' | 'allow' } | null): FleetMemberSpec => {
    const config: MemberConfig = { id, preset: 'yolo', mode: 'paper', enabled: true, caps: {} };
    const { strategy, basedOn } = memberStrategy(yolo, config, 1000);
    return { config, strategy: { ...strategy, entry: { ...strategy.entry, safety: { ...strategy.entry.safety, larp } } }, basedOn, bankroll: { usd: 1000 } };
  };
  const calls: string[] = [];
  let fail = true;
  const vetOf = fleetLarpVet(async (mint) => {
    calls.push(mint);
    if (mint === 'BAD' && fail) throw new Error('timeout');
    return { score: mint === 'MID' ? 60 : 10, band: 'x' };
  });
  assert.equal(vetOf(spec('plain', null)), undefined, 'a strategy without the gate gets no vet');
  const strict = vetOf(spec('strict', { maxScore: 49, unknown: 'reject' }))!;
  const loose = vetOf(spec('loose', { maxScore: 90, unknown: 'reject' }))!;
  const k = (mint: string) => ({ mint }) as MarketTick;
  assert.deepEqual(await strict(k('MID')), { ok: false, rule: 'larp-score', detail: 'LARP score 60 (x) is above 49' });
  assert.equal((await loose(k('MID'))).ok, true, 'the other member applies its own threshold');
  assert.deepEqual(calls, ['MID'], 'one larp_check per coin for the fleet');
  assert.equal((await strict(k('BAD'))).ok, false);
  assert.match(JSON.stringify(await strict(k('BAD'))), /larp-unknown/);
  fail = false;
  assert.equal((await loose(k('BAD'))).ok, true, 'a failed check was not kept: the next member asks again');
  assert.deepEqual(calls, ['MID', 'BAD', 'BAD', 'BAD']);
});

test('g2f runFleet: the yolo LARP gate runs for members on a paper account; a refused coin is never bought and the account keeps its cash', async () => {
  const yolo = loadPreset('yolo');
  const member = (id: string, account: string): FleetMemberSpec => {
    const config: MemberConfig = { id, preset: 'yolo', mode: 'paper', enabled: true, caps: {}, account };
    const { strategy, basedOn } = memberStrategy(yolo, config, 1000);
    return { config, strategy, basedOn, bankroll: { usd: 1000 } };
  };
  const run = async (score: number | null) => {
    const ledgers = new Map<string, Ledger>();
    let n = 0, checks = 0;
    const res = await runFleet({
      fleetId: 'fleet-g2f', home: mkdtempSync(join(tmpdir(), 'dexterm-g2f-fleet-')), members: [member('yolo-main', 'main'), member('yolo-alt', 'alt')],
      tape: loadTape(TAPE), runner: DEFAULT_RUNNER_CONFIG, accounts: [{ id: 'main', startUsd: 1000 }, { id: 'alt', startUsd: 500 }],
      guard: new FleetGuard(DEFAULT_GLOBAL_CAPS, DEFAULT_RUNNER_CONFIG, { clock: () => 0, loadavg: () => 0 }),
      sessions: null, vet: fleetLarpVet(async () => { checks++; if (score === null) throw new Error('down'); return { score }; }),
      ledgerFor: (m, _r, tap) => { const l = new Ledger((e) => tap(e)); ledgers.set(m, l); return { ledger: l, files: null }; },
      newRunId: (m) => `run-${m}-${++n}`, fleetLedger: new Ledger(), globalSafety: () => OK, memberControl: false, verbose: false,
      pacing: { mode: 'lockstep' },
    });
    return { res, ledgers, checks };
  };
  const buys = (l: Ledger) => l.events.filter((e: LedgerEvent) => e.kind === 'fill' && e.side === 'buy');
  const refusals = (l: Ledger, rule: string) => l.events.filter((e: LedgerEvent) => e.kind === 'refused' && e.rule === rule && e.stage === 'vet');
  const pass = await run(10);
  assert.ok(buys(pass.ledgers.get('yolo-main')!).length >= 1 && buys(pass.ledgers.get('yolo-alt')!).length >= 1, 'a low score lets both members trade');
  assert.ok(pass.checks >= 1 && pass.checks <= 3, `one check per coin across both members (${pass.checks})`);
  for (const [score, rule] of [[80, 'larp-score'], [null, 'larp-unknown']] as const) {
    const r = await run(score);
    for (const id of ['yolo-main', 'yolo-alt']) {
      const l = r.ledgers.get(id)!;
      assert.equal(buys(l).length, 0, `${id}: nothing bought when the LARP gate says ${rule}`);
      assert.ok(refusals(l, rule).length >= 1, `${id}: ${rule} refused at the vet`);
    }
    const acct = r.res.status.accounts!;
    assert.deepEqual(acct.map((a) => [a.id, a.cashUsd]), [['main', 1000], ['alt', 500]], 'the accounts keep their cash');
  }
});
