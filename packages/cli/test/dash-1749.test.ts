// task-1749: `dexterm dash`, the strategy performance dashboard. A temp DEXTERM_HOME with synthetic run ledgers + a
// fleet status + a market cache DB: the JSON the page reads, the loopback server (127.0.0.1 only, GET only, the Host
// guard, the CSP), the static snapshot, a books file, read-only on the home, and no external URL in the page assets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { collectDash, BOOKS_SCHEMA, PAPER_LABEL } from '../src/dash/data.ts';
import { ASSET_DIR, exportSnapshot, hostAllowed, startDashServer } from '../src/dash/server.ts';
import { dashCommand, resolveHome } from '../src/dash-cmd.ts';

const MIN = 60_000;
const T0 = Date.now() - 2 * 86_400_000;
const L = (o: Record<string, unknown>) => JSON.stringify(o);

function fixtureHome(): { root: string; dh: string } {
  const root = mkdtempSync(join(tmpdir(), 'dash-cmd-1749-'));
  const dh = join(root, '.dexterm'); const runs = join(dh, 'autotrade', 'runs'); mkdirSync(runs, { recursive: true }); mkdirSync(join(dh, 'autotrade', 'service'), { recursive: true });
  const head = (m: string) => [L({ kind: 'fleet_member', member: m, bankroll: { usd: 100 }, mode: 'paper', basedOn: { id: m, version: '1.0.0' }, t: T0 }), L({ kind: 'run_start', strategy: m, t: T0 })];
  const trade = (id: string, mint: string, pct: number, t: number, exitReason = 'tp') => L({ kind: 'trade_closed', trade: { id, mint, symbol: mint.toUpperCase(), openedAt: t - MIN, closedAt: t, costUsd: 25, pnlUsd: (25 * pct) / 100, pnlPct: pct, exitReason }, t });
  writeFileSync(join(runs, '20261025T000000Z-base-0001.jsonl'), [...head('base'),
    L({ kind: 'fill', positionId: 'p1', mint: 'aaa', side: 'buy', usd: 25, t: T0 + MIN }), trade('p1', 'aaa', 40, T0 + 10 * MIN),
    L({ kind: 'fill', positionId: 'p2', mint: 'bbb', side: 'buy', usd: 25, t: T0 + 20 * MIN }), trade('p2', 'bbb', -90, T0 + 30 * MIN, 'rug-liquidity'),
    L({ kind: 'fill', positionId: 'p3', mint: 'ccc', side: 'buy', usd: 20, t: T0 + 40 * MIN })].join('\n') + '\n');
  writeFileSync(join(runs, '20261025T000000Z-variant-0001.jsonl'), [...head('variant'),
    L({ kind: 'fill', positionId: 'p1', mint: 'ddd', side: 'buy', usd: 25, t: T0 + MIN }), trade('p1', 'ddd', 10, T0 + 15 * MIN)].join('\n') + '\n');
  writeFileSync(join(runs, '20261025T000000Z-fleet-0001.jsonl'), L({ kind: 'fleet_start', t: T0 }) + '\n');
  writeFileSync(join(dh, 'autotrade', 'fleet-status.json'), JSON.stringify({ startedAt: T0, members: [{ id: 'base', state: 'running', spend: { todayUsd: 0.5 }, open: [{ mint: 'ccc', symbol: 'CCC', profile: 'v3-swing', costUsd: 20, pnlUsd: 4, pnlPct: 20, stuck: false }] }, { id: 'variant', state: 'running', spend: { todayUsd: 0 }, open: [] }] }));
  writeFileSync(join(dh, 'autotrade', 'service', 'heartbeat.json'), JSON.stringify({ state: 'running', pid: process.pid, heartbeatAt: Date.now() - 5000, dataAgeMs: 12_000 }));
  const db = new DatabaseSync(join(root, 'dexterm.db'));
  db.exec('CREATE TABLE cache (ns TEXT, key TEXT, json TEXT, fetched_at INTEGER, ttl_ms INTEGER, source TEXT, PRIMARY KEY (ns, key))');
  db.prepare('INSERT INTO cache VALUES (?, ?, ?, ?, ?, ?)').run('ds:token', 'ccc', JSON.stringify({ pair: { liquidityUsd: 40_000, fetchedAt: Date.now() - 60_000 } }), Date.now() - 60_000, 30_000, 'dexscreener');
  db.close();
  return { root, dh };
}
const snapshotOf = (dir: string) => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => { const p = join(e.parentPath, e.name); return `${p}:${statSync(p).size}:${statSync(p).mtimeMs}`; }).sort();

test('collectDash: strategies, baseline, comparisons, open with realizable from the local cache, status, no absolute paths', () => {
  const { root, dh } = fixtureHome();
  const before = snapshotOf(dh);
  const d = collectDash({ homes: [resolveHome(root, {})], baseline: 'base' });
  assert.equal(d.paper, PAPER_LABEL);
  assert.deepEqual(d.strategies.map((s) => s.id), ['base', 'variant']); // the baseline first
  const base = d.strategies[0];
  assert.equal(base.baseline, true); assert.equal(base.group, root.split('/').pop());
  assert.equal(base.row.closed, 2); assert.equal(base.row.rugs, 1); assert.equal(base.row.sample, 'exploratory');
  assert.equal(base.rugs.length, 1); assert.equal(base.rugs[0].symbol, 'BBB');
  assert.equal(base.open.length, 1);
  const o = base.open[0];
  assert.equal(o.markUsd, 24); assert.equal(o.liqUsd, 40_000); assert.ok(o.realizableUsd! < 24 && o.realizableUsd! > 23);
  assert.equal(d.comparisons.length, 1); assert.match(d.comparisons[0].verdict, /^not yet/);
  assert.match(d.decisionRule!, /beats base/);
  assert.equal(d.status[0].state, 'ok'); assert.ok(d.status[0].items.some(([k, v]) => k === 'Model spend today' && v === '$0.50'));
  assert.ok(!JSON.stringify(d).includes(root), 'no absolute path in the data');
  assert.deepEqual(snapshotOf(dh), before, 'read-only: the home is untouched');
});

test('a books file adds a SOL book through the same definitions, with labels, groups and status cards', () => {
  const { root } = fixtureHome();
  const f = join(root, 'books.json');
  writeFileSync(f, JSON.stringify({ schema: BOOKS_SCHEMA, baseline: 'base', labels: { base: 'baseline: no filter' }, groups: { base: 'control', variant: 'control' },
    books: [{ id: 'challenge', label: 'agent, rules v3', group: 'agent', unit: 'SOL', start: 1, trades: [{ t: T0 + MIN, pnlPct: 6.6, pnl: 0.029 }, { t: T0 + 2 * MIN, pnlPct: -100, pnl: -0.4, exitReason: 'rug' }] }],
    status: [{ title: 'Challenge', state: 'warn', items: [['Next session', '13:33']] }], notes: ['The challenge book is in SOL; compare by % on cost.'] }));
  const d = collectDash({ homes: [resolveHome(root, {})], books: [f] });
  const c = d.strategies.find((s) => s.id === 'challenge')!;
  assert.equal(c.unit, 'SOL'); assert.equal(c.row.closed, 2); assert.equal(c.row.rugs, 1); assert.equal(c.equity.end, 0.63);
  assert.equal(d.baseline, 'base'); assert.equal(d.strategies[0].label, 'baseline: no filter'); assert.equal(d.strategies[0].group, 'control');
  assert.ok(d.status.some((s) => s.title === 'Challenge'));
  assert.ok(d.notes.includes('The challenge book is in SOL; compare by % on cost.'), 'the books file notes reach the page');
  const bad = collectDash({ homes: [], books: [join(root, 'missing.json')] });
  assert.match(bad.notes[0], /missing or not dexterm-dash-books\/1/);
});

test('hostAllowed: loopback names on any port, explicit hosts, nothing else', () => {
  assert.ok(hostAllowed('127.0.0.1:4317', [])); assert.ok(hostAllowed('localhost:1', [])); assert.ok(hostAllowed('[::1]:4317', []));
  assert.ok(!hostAllowed('evil.example', [])); assert.ok(!hostAllowed('127.0.0.1.evil.example:4317', [])); assert.ok(!hostAllowed(undefined, []));
  assert.ok(hostAllowed('box.tail1234.ts.net:8743', ['box.tail1234.ts.net'])); assert.ok(hostAllowed('box.tail1234.ts.net', ['box.tail1234.ts.net']));
});

test('server: 127.0.0.1 only, GET only, Host guard, CSP, the page + JSON', async () => {
  const { root } = fixtureHome();
  const srv = await startDashServer({ homes: [resolveHome(root, {})], books: [], baseline: 'base', allowHosts: ['box.ts.net'] }, 0);
  try {
    const a = srv.address() as { address: string; port: number };
    assert.equal(a.address, '127.0.0.1');
    const url = `http://127.0.0.1:${a.port}`;
    const page = await fetch(`${url}/`); assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy')!, /default-src 'none'/);
    assert.match(await page.text(), /PAPER/);
    const j = await (await fetch(`${url}/api/dash.json`)).json() as { schema: string; strategies: unknown[] }; assert.equal(j.schema, 'dexterm-dash/1'); assert.equal(j.strategies.length, 2);
    assert.equal((await fetch(`${url}/`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${url}/../../etc/passwd`)).status, 404);
    // fetch cannot override Host; a raw request can
    const { request } = await import('node:http');
    const status = (host: string) => new Promise<number>((ok) => { request({ host: '127.0.0.1', port: a.port, path: '/api/dash.json', headers: { Host: host } }, (r) => { r.resume(); ok(r.statusCode!); }).end(); });
    assert.equal(await status('attacker.example'), 421);
    assert.equal(await status('box.ts.net:8743'), 200);
  } finally { srv.close(); }
});

test('export: a static snapshot reads data.json, says snapshot, can drop the mints', () => {
  const { root } = fixtureHome();
  const out = join(root, 'snap');
  const files = exportSnapshot(collectDash({ homes: [resolveHome(root, {})], baseline: 'base' }), out, { redactMints: true });
  assert.ok(files.includes('data.json') && files.includes('index.html') && files.includes('_headers'));
  const html = readFileSync(join(out, 'index.html'), 'utf8');
  assert.match(html, /content="data\.json"/); assert.match(html, /data-mode="snapshot"/);
  const data = JSON.parse(readFileSync(join(out, 'data.json'), 'utf8'));
  assert.equal(data.snapshot, true); assert.ok(!JSON.stringify(data).includes('"aaa"'), 'mints dropped');
});

test('the page assets reference no external URL and carry the PAPER label', () => {
  for (const f of readdirSync(ASSET_DIR)) {
    const s = readFileSync(join(ASSET_DIR, f), 'utf8');
    assert.ok(!/(https?:)?\/\/(?!www\.w3\.org\/2000\/svg)[a-z0-9.-]+\.[a-z]{2,}/i.test(s), `${f} references an external URL`);
  }
  const js = readFileSync(join(ASSET_DIR, 'dash.js'), 'utf8');
  assert.match(js, /Paper trading, not financial advice/);
  assert.ok(!/style="/.test(js), 'no inline style attribute in rendered HTML: the CSP (style-src self) blocks it');
  assert.match(readFileSync(join(ASSET_DIR, 'index.html'), 'utf8'), /Paper trading, not financial advice/);
});

test('dexterm dash --json / --help / bad flags', async () => {
  const { root } = fixtureHome();
  let out = ''; let err = '';
  const io = { stdout: { write: (s: string) => { out += s; } }, stderr: { write: (s: string) => { err += s; } }, env: {} as NodeJS.ProcessEnv };
  assert.equal(await dashCommand(['--home', root, '--baseline', 'base', '--json'], io), 0);
  assert.equal(JSON.parse(out).strategies.length, 2);
  out = ''; assert.equal(await dashCommand(['--help'], io), 0); assert.match(out, /127\.0\.0\.1/);
  assert.equal(await dashCommand(['--nope'], io), 2); assert.match(err, /unknown flag --nope/);
  assert.equal(await dashCommand(['--port', 'x', '--home', root], io), 2);
});
