// task-1818 live smoke: build the narratives tracker from the LIVE recorder DB (read-only), print the heat table,
// then refresh incrementally and check the invariants. Exit 1 on any broken invariant. Never writes, never fetches.
//   node packages/narratives/scripts/smoke-live.ts [--db PATH] [--lookback-h 26]
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { RecorderNarratives, renderTable, toExport, coinField, embedderFromEnv, type Lifecycle } from '../src/index.ts';

const { values: a } = parseArgs({ options: { db: { type: 'string', default: process.env.DEXTERM_DB_PATH ?? join(homedir(), '.local/share/dexterm/dexterm.db') }, 'lookback-h': { type: 'string', default: '26' } } });
const db = new DatabaseSync(a.db!, { readOnly: true });
const svc = new RecorderNarratives(db, { lookbackMs: Number(a['lookback-h']) * 3_600_000, minRefreshMs: 0, embedder: embedderFromEnv() });
const fails: string[] = [];
const check = (ok: boolean, msg: string): void => { if (!ok) fails.push(msg); };

const t0 = performance.now();
const tr = await svc.refresh();
const buildMs = performance.now() - t0;
const top = tr.top(15);
console.log(`live build: ${tr.coins.size} coins, ${tr.clusterer.clusters.size} clusters, ${tr.stats.samples} samples, ${(buildMs / 1000).toFixed(1)} s, heap ${(process.memoryUsage().heapUsed / 1e6).toFixed(0)} MB, as of ${tr.lastTickAt ? new Date(tr.lastTickAt).toISOString() : '—'}`);
console.log(renderTable(top, 140));
const states = new Set<Lifecycle>(['spark', 'ignition', 'peak', 'fading', 'dead']);
check(tr.coins.size > 0, 'no coins recorded in the lookback (is the recorder running?)');
check(top.length > 0, 'no live narrative with >= 2 coins');
for (const s of top) {
  check(states.has(s.lifecycle), `bad lifecycle ${s.lifecycle}`);
  for (const w of Object.values(s.windows)) check(w.volumeShare == null || (w.volumeShare >= 0 && w.volumeShare <= 1 + 1e-9), `${s.id} share out of range`);
  check(s.score >= 0 && s.score <= 100, `${s.id} score out of range`);
  check(s.rank == null || s.rank >= 1, `${s.id} rank`);
  const d = tr.detail(s.id)!;
  check(d.memberList.length === s.members, `${s.id} member count`);
  check(d.memberList.every((m, i) => m.spawn === i + 1), `${s.id} spawn order`);
}
const sample = [...tr.coins.keys()].slice(-5);
for (const m of sample) console.log(`${m.slice(0, 8)}…  ${coinField(tr.narrativeOf(m))}`);
const before = new Map(sample.map((m) => [m, tr.narrativeOf(m)!.narrative]));
const t1 = performance.now();
await svc.refresh();
const refreshMs = performance.now() - t1;
for (const [m, id] of before) check(tr.narrativeOf(m)!.narrative === id, `id changed on refresh for ${m}`);
const ex = toExport(tr);
check(ex.schema === 'dexterm-narratives/1' && /Not advice/.test(ex.note), 'export schema / heat note');
console.log(`incremental refresh ${refreshMs.toFixed(0)} ms · export ${JSON.stringify(ex).length} bytes · ${fails.length ? 'FAIL' : 'OK'}`);
for (const f of fails) console.log(`  ✖ ${f}`);
process.exit(fails.length ? 1 : 0);
