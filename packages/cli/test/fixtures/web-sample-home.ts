// task-2170: a SAMPLE dexterm home for the Strategy Builder web UI tests and screenshots. Synthetic only: the
// autotrade fixture tape, a stub factory analyst (no Claude, no spend), coins named SAMPLEn with made-up mints.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fleetConfigPath, loadTape, presetPath, runFactory, runsDir, StrategyStore, stubAnalyst, type Strategy } from '@dexterm/autotrade';

const TAPE = loadTape(fileURLToPath(new URL('../../../autotrade/test/fixtures/autotrade-1498-tape.json', import.meta.url)));
export const SAMPLE_T0 = Date.UTC(2026, 10, 5, 12);

/** A made-up base58 "mint" (never a real address): 44 chars from a fixed seed. */
export function fakeMint(i: number): string {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let s = ''; let x = 7919 * (i + 3);
  for (let k = 0; k < 44; k++) { x = (x * 48271 + 11) % 2147483647; s += A[x % A.length]; }
  return s;
}

export async function buildSampleHome(home: string, o: { now?: number; factory?: boolean } = {}): Promise<{ userId: string; generated: string[] }> {
  const now = o.now ?? SAMPLE_T0;
  const store = new StrategyStore({ home, now: () => now });
  const scalp = JSON.parse(readFileSync(presetPath('scalp'), 'utf8')) as Strategy;
  const userId = 'my-scalp';
  store.create({ ...scalp, id: userId, name: 'My scalp (sample)', version: '1.0.0', mode: 'paper' }, { actor: 'sample' });
  const moon = JSON.parse(readFileSync(presetPath('moonbag'), 'utf8')) as Strategy;
  store.create({ ...moon, id: 'moon-ladder', name: 'Moon ladder (sample)', version: '1.0.0', mode: 'paper' }, { actor: 'sample' });
  mkdirSync(join(home, 'autotrade'), { recursive: true, mode: 0o700 });
  writeFileSync(fleetConfigPath(home), JSON.stringify({ schema: 'dexterm-autotrade/1', strategies: [{ id: userId, preset: userId, enabled: true }, { id: 'moon-ladder', preset: 'moon-ladder', enabled: false }] }, null, 2));

  // a paper run ledger for my-scalp: three closed bags (one through the ladder), one held
  mkdirSync(runsDir(home), { recursive: true, mode: 0o700 });
  const t = now - 3 * 3600_000;
  const L: Record<string, unknown>[] = [
    { kind: 'fleet_member', member: userId, bankroll: { usd: 1000 }, mode: 'paper', basedOn: { id: userId, version: '1.0.0' }, t },
    { kind: 'run_start', strategy: userId, mode: 'paper', t },
  ];
  const coin = (i: number) => ({ mint: fakeMint(i), symbol: `SAMPLE${i}` });
  const trades: Array<[number, number, number, string[], string]> = [
    // i, cost, pnlUsd, sell reasons, exitReason
    [1, 50, 31.5, ['tp1', 'tp2', 'trail'], 'trail'],
    [2, 50, -12.4, ['hard-stop'], 'hard-stop'],
    [3, 50, 8.1, ['tp1', 'time'], 'time'],
  ];
  let k = 0;
  for (const [i, cost, pnl, reasons, exit] of trades) {
    const c = coin(i); const t1 = t + (k++) * 40 * 60_000;
    L.push({ kind: 'candidate', ...c, t: t1 - 1000 });
    L.push({ kind: 'fill', positionId: `p${i}`, mint: c.mint, side: 'buy', usd: cost, reason: 'entry', profile: 'scalp', t: t1 });
    reasons.forEach((r, j) => L.push({ kind: 'fill', positionId: `p${i}`, mint: c.mint, side: 'sell', usd: Math.round(((cost + pnl) / reasons.length) * 100) / 100, reason: r, profile: 'scalp', t: t1 + (j + 1) * 6 * 60_000 }));
    L.push({ kind: 'trade_closed', trade: { id: `p${i}`, mint: c.mint, symbol: c.symbol, openedAt: t1, closedAt: t1 + 20 * 60_000, costUsd: cost, pnlUsd: pnl, pnlPct: Math.round((pnl / cost) * 1e4) / 100, exitReason: exit, stuck: false }, t: t1 + 20 * 60_000 });
  }
  const held = coin(4);
  L.push({ kind: 'candidate', ...held, t: now - 9 * 60_000 });
  L.push({ kind: 'fill', positionId: 'p4', mint: held.mint, side: 'buy', usd: 50, reason: 'entry', profile: 'scalp', t: now - 8 * 60_000 });
  writeFileSync(join(runsDir(home), `${userId}-sample.jsonl`), L.map((x) => JSON.stringify(x)).join('\n') + '\n');

  const generated: string[] = [];
  if (o.factory !== false) {
    const r = await runFactory({ home, analyst: stubAnalyst(), tape: () => TAPE, now: () => now, log: () => {} });
    for (const c of r.candidates) generated.push(c.id);
  }
  return { userId, generated };
}
