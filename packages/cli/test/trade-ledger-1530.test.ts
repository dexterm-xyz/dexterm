// task-1530 THE UNIFIED TRADE LEDGER: one row per round trip from the agent paper desk's journal (and the paper
// wallet, autotrade runs, the live signer's ledgers), structured PROFILE / EXIT tags (typed fields first, a tag line
// second, never trusted from the file), a sha256-chained append-only file, the `dexterm ledger` CLI, the MCP ledger
// reads (state only: never a key, an address or an exact balance) and the backtest_request -> `autotrade requests`
// round trip. Offline: fixture journals in a temp DEXTERM_HOME (made-up tickers and addresses), no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeClock } from '../../data/src/clock.ts';
import { Journal } from '../../data/src/trade/plans/journal.ts';
import {
  appendTradeLedger, readTradeLedger, tradeLedgerPath, LedgerBrokenError, importDeskJournal, foldTrades, summarize, wilson,
  parseTagLines, buildFillTag, buildLateTag, csvCell, toCsv, exportTrades, PUMP_FUN_SUPPLY_TOKENS, type Draft, type LedgerEvent,
} from '@dexterm/data/ledger';
import { LedgerTools, BacktestRequests } from '@dexterm/mcp';
import { ledgerCommand } from '../src/ledger-cmd.ts';
import { ledgerCardInput, computeCard, mcapView } from '../src/pnl-card.ts';
import { requestsCmd } from '../src/autotrade-cmd/requests.ts';

const PUMP_MINT = 'Fx7aBcDeFgHjJkLmNpPqRsTuVwXyZ123456789Apump';
const OTHER_MINT = 'Gq3aBcDeFgHjJkLmNpPqRsTuVwXyZ1234567891234';
const T0 = 1_792_400_000_000;
const MIN = 60_000;

function home(): string { return mkdtempSync(join(tmpdir(), 'dexterm-ledger-1530-')); }

/** A desk journal written by the real Journal class (so its hash chain verifies like a real one). */
function deskJournal(dir: string, fills: { dt: number; data: Record<string, unknown> }[], tags: { dt: number; data: Record<string, unknown> }[] = []): string {
  let at = T0;
  const path = join(dir, 'paper-agent.journal');
  const j = new Journal({ path, clock: { now: () => at } as unknown as FakeClock });
  const all = [...fills.map((f) => ({ ...f, type: 'agent.paper.fill' })), ...tags.map((g) => ({ ...g, type: 'agent.paper.tag' }))].sort((a, b) => a.dt - b.dt);
  for (const e of all) { at = T0 + e.dt; j.append(e.type, { mandateId: 'mandate_x', data: e.data }); }
  return path;
}

const buy = (mint: string, fillId: number, sol: number, tokensRaw: bigint, extra: Record<string, unknown> = {}) => ({
  agent: 'mcp-agent', mint, symbol: 'FIXT', side: 'buy', paper: true, solDelta: String(-Math.round(sol * 1e9)), tokenDelta: String(tokensRaw),
  priceSol: sol / (Number(tokensRaw) / 1e6), priceUsd: (sol * 150) / (Number(tokensRaw) / 1e6), realizedLamports: '0', fillId, ...extra,
});
const sell = (mint: string, fillId: number, sol: number, tokensRaw: bigint, extra: Record<string, unknown> = {}) => ({
  agent: 'mcp-agent', mint, symbol: 'FIXT', side: 'sell', paper: true, solDelta: String(Math.round(sol * 1e9)), tokenDelta: String(-tokensRaw),
  priceSol: sol / (Number(tokensRaw) / 1e6), priceUsd: (sol * 150) / (Number(tokensRaw) / 1e6), realizedLamports: '0', fillId, ...extra,
});

function capture() {
  let out = '', err = '';
  return { io: { stdout: { write: (s: string) => { out += s; return true; } }, stderr: { write: (s: string) => { err += s; return true; } } }, out: () => out, err: () => err };
}

// ───────────────────────────── tags ─────────────────────────────

test('tags: PROFILE / REPROFILE / EXIT lines parse; typed fields win over a line; junk codes are dropped', () => {
  const p = parseTagLines('**PROFILE runner for $FIXT (Fx7a…pump): fresh migration, clean holders · size 0.5 SOL (5% of bankroll)**\nREPROFILE FIXT runner -> moonbag: free bag\nEXIT FIXT tp1: hit 2x');
  assert.deepEqual(p.map((g) => g.kind), ['profile', 'reprofile', 'exit']);
  assert.equal(p[0].kind === 'profile' && p[0].profile, 'runner');
  assert.equal(p[0].kind === 'profile' && p[0].sizeSol, 0.5);
  // typed beats line; the line still supplies the reason
  const t = buildFillTag('buy', { profile: 'scalp', line: 'PROFILE runner for FIXT: reason from line' });
  assert.deepEqual([t?.profile, t?.source, t?.reason], ['scalp', 'structured', 'reason from line']);
  // line only -> tag-line source
  assert.equal(buildFillTag('buy', { line: 'PROFILE swing for FIXT: x' })?.source, 'tag-line');
  // a code outside the strategy-id alphabet is reduced to it (never raw text in a code field)
  assert.match(buildFillTag('buy', { profile: 'Runner; rm -rf /' })?.profile ?? '', /^[a-z][a-z0-9-]{0,31}$/);
  assert.equal(buildFillTag('buy', { profile: '; ;' })?.profile ?? null, null);
  // a sell never carries a profile, a buy never an exit reason
  assert.equal(buildFillTag('sell', { profile: 'runner', exitReason: 'trail' })?.profile, null);
  assert.equal(buildFillTag('buy', { exitReason: 'trail', profile: 'runner' })?.exitReason, null);
  assert.equal(buildFillTag('buy', {}), null);
  // late tags say what is missing
  assert.equal(buildLateTag({ kind: 'exit' }).ok, false);
  assert.deepEqual(buildLateTag({ line: 'REPROFILE FIXT scalp -> runner: ran' }), { ok: true, tagKind: 'reprofile', from: 'scalp', to: 'runner', reason: 'ran', line: 'REPROFILE FIXT scalp -> runner: ran' });
});

// ───────────────────────────── the file ─────────────────────────────

test('file: header + sha256 chain, re-append skips by ref, an edited line is refused and named by verify', () => {
  const dir = home();
  try {
    const path = tradeLedgerPath({ DEXTERM_HOME: dir });
    const d = (ref: string) => ({ kind: 'annotate', t: T0, ref, tradeId: 'desk:1:x', note: 'n' }) as unknown as Draft;
    const a = appendTradeLedger(path, [d('a'), d('b')], T0);
    assert.deepEqual([a.added, a.skipped, a.events], [2, 0, 3]);
    const b = appendTradeLedger(path, [d('b'), d('c')], T0);
    assert.deepEqual([b.added, b.skipped, b.events], [1, 1, 4]);
    const r = readTradeLedger(path);
    assert.equal(r.check.ok, true);
    assert.equal((r.events[0] as { kind: string }).kind, 'header');
    // tamper with line 3: verify names it and append refuses (never rewrites)
    const lines = readFileSync(path, 'utf8').split('\n');
    lines[2] = lines[2].replace('"note":"n"', '"note":"edited"');
    writeFileSync(path, lines.join('\n'));
    const bad = readTradeLedger(path);
    assert.equal(bad.check.ok, false);
    assert.equal(!bad.check.ok && bad.check.at, 3);
    assert.throws(() => appendTradeLedger(path, [d('z')], T0), LedgerBrokenError);
    assert.equal(readFileSync(path, 'utf8'), lines.join('\n'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ───────────────────────────── the desk importer + fold ─────────────────────────────

test('desk import: structured tags, pump.fun decimals + 1B supply for an old journal, market cap at entry / exit', () => {
  const dir = home();
  try {
    const path = deskJournal(dir, [
      { dt: 0, data: buy(PUMP_MINT, 1, 1, 10_000_000_000n, { tag: { profile: 'runner', reason: 'fresh migration', exitReason: null, line: null, source: 'structured' } }) },
      { dt: 30 * MIN, data: sell(PUMP_MINT, 2, 2, 10_000_000_000n, { tag: { profile: null, reason: 'hit 2x', exitReason: 'tp1', line: null, source: 'structured' } }) },
      // a non-pump mint with no decimals: no token amount, no market cap (never guessed)
      { dt: 40 * MIN, data: buy(OTHER_MINT, 3, 1, 5_000_000n) },
    ]);
    const res = importDeskJournal(path);
    assert.equal(res.problem, null, 'the real Journal chain verifies');
    const rows = foldTrades(res.drafts.map((d, i) => ({ ...d, seq: i + 1 }) as unknown as LedgerEvent), { now: T0 + 60 * MIN });
    const pump = rows.find((t) => t.mint === PUMP_MINT)!;
    assert.equal(pump.status, 'closed');
    assert.deepEqual([pump.profile.id, pump.profile.source, pump.exitReason.code, pump.exitReason.source], ['runner', 'structured', 'tp1', 'structured']);
    assert.equal(pump.supply?.tokens, PUMP_FUN_SUPPLY_TOKENS);
    assert.ok(Math.abs((pump.pnlPct ?? 0) - 100) < 0.5, `pnl ${pump.pnlPct}`);
    // 10,000 tokens for 1 SOL at $150/SOL -> $0.015 a token -> $15M cap at entry, $30M at exit
    assert.ok(Math.abs((pump.entryMcapUsd ?? 0) - 15_000_000) < 1, `entry ${pump.entryMcapUsd}`);
    assert.ok(Math.abs((pump.exitMcapUsd ?? 0) - 30_000_000) < 1, `exit ${pump.exitMcapUsd}`);
    const other = rows.find((t) => t.mint === OTHER_MINT)!;
    assert.equal(other.status, 'open');
    assert.equal(other.entryMcapUsd, null);
    // a tag in the file is re-cleaned: an injected code is dropped
    const path2 = deskJournal(home(), [{ dt: 0, data: buy(PUMP_MINT, 1, 1, 1_000_000n, { tag: { profile: '"; DROP', source: 'tag-line' } }) }]);
    const r2 = foldTrades(importDeskJournal(path2).drafts.map((d, i) => ({ ...d, seq: i + 1 }) as unknown as LedgerEvent));
    assert.match(r2[0].profile.id ?? '', /^[a-z][a-z0-9-]{0,31}$|^$/);
    assert.notEqual(r2[0].profile.source, 'structured', 'a file cannot promote its own tag to structured without a typed profile');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('stats + export: Wilson interval, CSV never starts a formula', () => {
  const w = wilson(2, 10)!;
  assert.ok(w.lo > 0.05 && w.lo < 0.06 && w.hi > 0.50 && w.hi < 0.52, JSON.stringify(w));
  assert.equal(wilson(0, 0), null);
  assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(csvCell('-1+2'), `'-1+2`);
  assert.equal(csvCell('a\nb'), 'a b');
  assert.equal(toCsv([]).split('\n')[0].split(',')[0], 'trade_id');
  assert.equal(summarize([]).trades, 0);
  const j = JSON.parse(exportTrades([], 'json', { exportedAt: T0, ledgerHead: null, unit: 'SOL' })) as { schema: string };
  assert.equal(j.schema, 'dexterm-ledger-export/1');
});

// ───────────────────────────── the CLI ─────────────────────────────

test('CLI: trades show pending source rows, sync appends once, verify passes, card uses market cap, bad input exits 2', async () => {
  const dir = home();
  try {
    deskJournal(dir, [
      { dt: 0, data: buy(PUMP_MINT, 1, 1, 10_000_000_000n, { tag: { profile: 'scalp', source: 'structured' } }) },
      { dt: 5 * MIN, data: sell(PUMP_MINT, 2, 0.5, 10_000_000_000n, { tag: { exitReason: 'stop', source: 'structured' } }) },
    ]);
    const env = { DEXTERM_HOME: dir } as NodeJS.ProcessEnv;
    let c = capture();
    assert.equal(await ledgerCommand(['trades'], { ...c.io, env }), 0);
    assert.match(c.out(), /not written yet/);
    assert.match(c.out(), /events from the sources not in the file yet/);
    assert.match(c.out(), /scalp\s+stop/);
    assert.match(c.out(), /\$15\.00M\s+\$7\.50M\s+-50\.0%/);
    c = capture();
    assert.equal(await ledgerCommand(['sync'], { ...c.io, env }), 0);
    assert.match(c.out(), /\+\d+ events \(0 already there\)/);
    c = capture();
    assert.equal(await ledgerCommand(['sync'], { ...c.io, env }), 0);
    assert.match(c.out(), /\+0 events/);
    c = capture();
    assert.equal(await ledgerCommand(['verify'], { ...c.io, env }), 0);
    assert.match(c.out(), /chain verified/);
    c = capture();
    assert.equal(await ledgerCommand(['trades', '--json'], { ...c.io, env }), 0);
    const row = (JSON.parse(c.out()) as { trades: { tradeId: string; walletMode: string }[] }).trades[0];
    assert.equal(row.walletMode, 'paper');
    c = capture();
    assert.equal(await ledgerCommand(['summary', '--profile', 'scalp'], { ...c.io, env }), 0);
    assert.match(c.out(), /trades 1 closed/);
    c = capture();
    assert.equal(await ledgerCommand(['export', 'csv'], { ...c.io, env }), 0);
    assert.equal(c.out().trim().split('\n').length, 2);
    c = capture();
    assert.equal(await ledgerCommand(['export', '--format', 'json'], { ...c.io, env }), 0);
    assert.equal((JSON.parse(c.out()) as { schema: string }).schema, 'dexterm-ledger-export/1');
    for (const bad of [['bogus'], ['export', 'xls'], ['trades', '--source'], ['card'], ['card', 'nope']]) {
      c = capture();
      assert.equal(await ledgerCommand(bad, { ...c.io, env }), 2, bad.join(' '));
    }
    // the card: built from the ledger row with the shared card code, market cap basis, PAPER stamp
    const { loadLedgerView } = await import('@dexterm/autotrade');
    const t = loadLedgerView({ env, now: T0 + HOUR }).trades[0];
    const s = computeCard(ledgerCardInput(t), T0 + HOUR);
    assert.equal(s.input.source, 'paper');
    assert.equal(s.input.supply?.tokens, PUMP_FUN_SUPPLY_TOKENS);
    assert.equal(mcapView(s).basis, 'mcap');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
const HOUR = 60 * MIN;

// ───────────────────────────── MCP reads + backtest_request ─────────────────────────────

test('MCP: ledger reads are read-only and paper-labelled; trading_status / telegram_status never carry a key, an address or a balance', async () => {
  const dir = home();
  try {
    deskJournal(dir, [{ dt: 0, data: buy(PUMP_MINT, 1, 1, 10_000_000_000n) }]);
    const PUB = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
    writeFileSync(join(dir, 'trading-wallet.json'), JSON.stringify({ publicKey: PUB, createdAt: T0, origin: 'generated', seed: 'ENCRYPTED-SEED-BLOB', check: 'CHECK' }));
    writeFileSync(join(dir, 'connectors.json'), JSON.stringify({ telegram: { enabled: true, bot: 'b', token: 'SECRET-TOKEN', allow: [123456789], tiers: ['notify'] } }));
    const tools = new LedgerTools({ env: { DEXTERM_HOME: dir }, now: () => T0 + HOUR });
    const tr = await tools.call('ledger_positions', {});
    assert.equal(tr.readOnly, true);
    assert.equal(tr.count, 1);
    assert.match(String(tr.note), /PAPER/);
    assert.ok((await tools.call('ledger_trades', { source: 'nope' })).error);
    const live = JSON.stringify(await tools.call('trading_status', {}));
    for (const leak of [PUB, 'ENCRYPTED-SEED-BLOB', 'CHECK']) assert.ok(!live.includes(leak), `trading_status leaks ${leak}`);
    // task-1571: dexterm has no live trading of its own; a stray key file from an older build is not even read
    assert.match(live, /not in dexterm: dexterm holds no key, signs nothing and places no live order/);
    assert.match(live, /"panicSwitch":"off"/);
    const tg = JSON.stringify(await tools.call('telegram_status', {}));
    for (const leak of ['SECRET-TOKEN', '123456789']) assert.ok(!tg.includes(leak), `telegram_status leaks ${leak}`);
    assert.match(tg, /"pairedChats":1/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('backtest_request files a request only; the user runs or dismisses it with `dexterm autotrade requests`', async () => {
  const dir = home();
  try {
    const env = { DEXTERM_HOME: dir } as NodeJS.ProcessEnv;
    const tools = new LedgerTools({ env, now: () => T0, strategyInfo: async (id) => (id === 'fixt-runner' ? { ok: true, version: '3', hash: 'h'.repeat(64) } : null) });
    assert.ok((await tools.call('backtest_request', { id: 'fixt-runner', days: 7 })).error, 'why is required');
    assert.ok((await tools.call('backtest_request', { id: 'fixt-runner', days: 999, why: 'x' })).error, 'days bounded');
    assert.ok((await tools.call('backtest_request', { id: 'missing', why: 'x' })).error);
    const r = await tools.call('backtest_request', { id: 'fixt-runner', days: 7, why: 'does the trail beat tp1?' });
    assert.equal(r.proposal, true);
    const id = String(r.requestId);
    const files = new BacktestRequests(dir);
    assert.equal(files.get(id)?.status, 'pending');
    // rate limit: 6 an hour per server
    for (let i = 0; i < 5; i++) await tools.call('backtest_request', { id: 'fixt-runner', days: 7, why: `q${i}` });
    assert.equal((await tools.call('backtest_request', { id: 'fixt-runner', days: 7, why: 'one more' })).reason, 'rate-limited');
    let c = capture();
    assert.equal(await requestsCmd(['list'], { ...c.io, env }), 0);
    assert.match(c.out(), new RegExp(id));
    c = capture();
    assert.equal(await requestsCmd(['dismiss', id], { ...c.io, env }), 0);
    assert.equal(files.get(id)?.status, 'dismissed');
    c = capture();
    assert.equal(await requestsCmd(['run', id], { ...c.io, env }), 2, 'a resolved request cannot be run');
    c = capture();
    assert.equal(await requestsCmd(['run', 'br_zz'], { ...c.io, env }), 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
