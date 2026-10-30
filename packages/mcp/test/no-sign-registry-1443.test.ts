// task-1443 — THE no-sign guard. The public claim is "no MCP tool can sign or send". This test keeps it true
// and testable: it enumerates the whole tool registry and fails on any tool that is not on an explicit
// allowlist (so a new tool must be consciously classified here), fails on any tool whose name is shaped like a
// real signing / sending / cap-changing op, and proves — structurally — that the tool-call path and the paper
// ledger import NOTHING from the signer, the live executor, the swap-build/send path or any crypto-signing lib.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { TOOLS, READ_ONLY_TOOLS, PAPER_WRITE_TOOLS, PAPER_READ_TOOLS, PAPER_NOTE_TOOLS, isMoneyToolName, STRATEGY_READ_TOOLS, STRATEGY_PROPOSE_TOOLS, LEDGER_READ_TOOLS, LEDGER_PROPOSE_TOOLS } from '../src/index.ts';
import { ANALYST_ACTION_TYPES } from '@dexterm/data';

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_SRC = join(HERE, '..', 'src');
const DATA_SRC = join(HERE, '..', '..', 'data', 'src');

// ── the allowlist: every served tool, classified. A new tool MUST be added to exactly one bucket here. ──
const READ_DATA_TOOLS = [
  'screen_state', 'screener_query', 'get_token', 'get_dossier', 'analyze_token', 'get_holders', 'get_trades',
  'get_candles', 'rugcheck', 'get_dev_history', 'dev_history', 'narrative_board', 'narratives_top', 'narrative_detail', 'narrative_of', 'rug_backtest', 'kb_lookup', 'kb_search',
  'case_lookup', 'get_links', 'fetch_page', 'check_domain', 'check_github', 'check_x', 'larp_check', 'app_help', 'app_state',
];
const UI_NAV_TOOLS = [...ANALYST_ACTION_TYPES]; // task-1313/1413 non-financial navigation + display config
const PAPER_TOOLS = [...PAPER_WRITE_TOOLS, ...PAPER_READ_TOOLS, ...PAPER_NOTE_TOOLS];
// task-1507: AUTOTRADE strategy reads + PROPOSALS (a proposal file; the user's keypress applies it, never a tool)
const STRATEGY_TOOLS = ['strategy_list', 'strategy_get', 'strategy_validate', 'strategy_backtest', 'autotrade_status', 'strategy_propose_edit', 'strategy_propose_new'];
// task-1529: parallel strategies: two reads + start / stop of ONE strategy the user listed (a paper control file)
const PARALLEL_TOOLS = ['autotrade_parallel_list', 'autotrade_parallel_compare', 'autotrade_parallel_start', 'autotrade_parallel_stop'];
// task-1530: TRADE LEDGER reads, a run's candidate record, outcomes, the Telegram / live-signer STATE (`trading_status`:
// the FORBIDDEN rule below and trade-t2-1328's LOCKOUT keep 'signer' and 'live' out of tool names) and one PROPOSE tool (a backtest request file)
// task-1645: `trade_fire_feed` reads real mode's MCP feed and status (the user arms, sets caps and kills on a terminal only)
// task-1654: trading_limits (read/explain) and limits_propose (a diff card; writes nothing) are the analyst's limits surface.
const LEDGER_TOOLS = ['ledger_trades', 'ledger_positions', 'ledger_equity', 'ledger_summary', 'ledger_compare', 'candidate_dossier', 'outcomes_lookup', 'telegram_status', 'trading_status', 'trade_fire_feed', 'trading_limits', 'backtest_requests', 'backtest_request', 'limits_propose'];
// task-1647: the JOURNEY: two reads, paper forward-test control (the strategy's own bankroll, never real) and a promotion
// PROPOSAL (a file; always-on is the user's key, real the user's caps + typed phrase on their terminal)
const JOURNEY_TOOLS = ['strategy_journey', 'strategy_forward_report', 'strategy_forward_start', 'strategy_forward_stop', 'strategy_promote_propose'];
// task-1822: classification models: read-only estimates (classify_coin / classify_batch / classifier_status); they never sign, trade or write config
const CLASSIFIER_TOOLS = ['classify_coin', 'classify_batch', 'classifier_status'];
const ALLOWLIST = new Set<string>([...READ_DATA_TOOLS, ...UI_NAV_TOOLS, ...PAPER_TOOLS, ...STRATEGY_TOOLS, ...PARALLEL_TOOLS, ...LEDGER_TOOLS, ...JOURNEY_TOOLS, ...CLASSIFIER_TOOLS]);

const servedNames = TOOLS.map((t) => String(t.name));

test('every served tool is on the allowlist, and the allowlist has no stale names', () => {
  for (const n of servedNames) assert.ok(ALLOWLIST.has(n), `UNCLASSIFIED tool "${n}" — add it to the allowlist in no-sign-registry-1443.test.ts and classify it (read / nav / paper / strategy)`);
  assert.deepEqual([...STRATEGY_READ_TOOLS, ...STRATEGY_PROPOSE_TOOLS].sort(), [...STRATEGY_TOOLS].sort());
  assert.deepEqual([...LEDGER_READ_TOOLS, ...LEDGER_PROPOSE_TOOLS].sort(), [...LEDGER_TOOLS].sort());
  for (const n of [...LEDGER_PROPOSE_TOOLS, ...PAPER_NOTE_TOOLS]) assert.ok(!READ_ONLY_TOOLS.includes(n), `${n} writes a file: not read-only`);
  // task-1647: forward-test control and promotion proposals act or write: never on the read-only surface
  for (const n of ['strategy_forward_start', 'strategy_forward_stop', 'strategy_promote_propose']) assert.ok(!READ_ONLY_TOOLS.includes(n), `${n} acts or writes: not read-only`);
  for (const n of ALLOWLIST) assert.ok(servedNames.includes(n), `allowlist names a tool "${n}" the server no longer serves`);
  assert.equal(servedNames.length, ALLOWLIST.size, 'no duplicate or missing tool names');
});

test('no tool is named like a real signing / sending / wallet / cap-changing op', () => {
  // Words that would betray a real-money op. The PAPER tools are NOT here — they are paper only (see below).
  const FORBIDDEN = /(^|_)(sign|signer|send|submit|broadcast|arm|wallet|key|keypair|withdraw|transfer|raise|setcap|mandate|approve|fund|pay)(_|$)/i;
  for (const n of servedNames) assert.ok(!FORBIDDEN.test(n), `tool "${n}" is named like a signing/sending/cap op`);
});

test('the paper WRITE tools are money-shaped (a skill can never name them) and are NOT in the read surface', () => {
  for (const n of PAPER_WRITE_TOOLS) {
    assert.ok(isMoneyToolName(n, READ_ONLY_TOOLS), `${n} must be refused to skills (money-shaped)`);
    assert.ok(!READ_ONLY_TOOLS.includes(n), `${n} must not be classified read-only`);
  }
  // open_ticket (the existing paper-ticket opener) stays money-shaped too.
  assert.ok(isMoneyToolName('open_ticket', READ_ONLY_TOOLS));
});

test('every paper tool advertises PAPER / simulated and claims no profit', () => {
  const paper = TOOLS.filter((t) => String(t.name).startsWith('paper_'));
  assert.equal(paper.length, 7); // task-1530: + paper_tag (journal-only)
  for (const t of paper) {
    const d = String(t.description);
    assert.match(d, /PAPER|SIMULATED|simulated|paper/);
    assert.doesNotMatch(d, /\bprofit\b|\bwinners?\b|\breturns?\b|\bguarantee/i);
  }
});

// ── structural: the tool-call path and the paper ledger cannot reach a signer / live / send module ──
const FORBIDDEN_IMPORTS = [
  'signer/', 'executor-live', 'swap-build', 'rpc-exec', 'trade/bridge', 'tx-decode', 'token-delta', 'fast-wallet',
  'tweetnacl', '@solana/web3.js', 'ed25519',
];

function importLines(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  return src.split('\n').filter((l) => /^\s*import\b/.test(l) || /\bfrom ['"]/.test(l) || /\brequire\(/.test(l));
}
function assertNoForbiddenImports(file: string): void {
  const lines = importLines(file);
  for (const l of lines) {
    for (const bad of FORBIDDEN_IMPORTS) {
      assert.ok(!l.includes(bad), `${file.split('/').slice(-2).join('/')} imports a forbidden (sign/send) module: "${bad}" in: ${l.trim()}`);
    }
  }
}

test('the MCP server + paper-agent resolver import no signer/live/send module', () => {
  assertNoForbiddenImports(join(MCP_SRC, 'server.ts'));
  assertNoForbiddenImports(join(MCP_SRC, 'paper-agent.ts'));
  assertNoForbiddenImports(join(MCP_SRC, 'autotrade-tools.ts'));
  assertNoForbiddenImports(join(MCP_SRC, 'ledger-tools.ts'));
  assertNoForbiddenImports(join(MCP_SRC, 'backtest-requests.ts'));
});

test('task-1507: the strategy tools never write a strategy: no store write call on the tool path', () => {
  const src = readFileSync(join(MCP_SRC, 'autotrade-tools.ts'), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  // StrategyStore writes are create/update/patch/remove/recordBacktest; the tools may only read the store
  assert.doesNotMatch(src, /\.(create|createFrom|update|patch|remove|recordBacktest)\(/, 'autotrade-tools.ts calls a strategy-store write');
  // the only proposal-file status change (applied/dismissed) is ProposalFiles.resolve, which the tools never call
  const body = src.slice(src.indexOf('export class AutotradeTools'));
  assert.doesNotMatch(body, /\.resolve\(/);
  assert.doesNotMatch(src, /\b(mode\s*:\s*'live'|SignerClient|armMandate|signTransaction|sendTransaction)\b/);
});

test('the paper agent desk + paper ledger import no signer/live/send/crypto-signing module', () => {
  assertNoForbiddenImports(join(DATA_SRC, 'trade', 'agent', 'paper-desk.ts'));
  assertNoForbiddenImports(join(DATA_SRC, 'trade', 'agent', 'rendezvous.ts'));
  assertNoForbiddenImports(join(DATA_SRC, 'paper.ts'));
  // paper.ts states it imports no signing/crypto lib — assert it stays that way.
  const paper = readFileSync(join(DATA_SRC, 'paper.ts'), 'utf8');
  assert.doesNotMatch(paper, /\bKeypair\b|nacl\.sign|createSign|\.sign\(/);
});

test('the paper executor behind the desk is the paper executor (its one op books the simulated ledger)', () => {
  // The desk refuses a non-paper executor at construction; its only trade op is executor.execute on PaperWallet.
  const desk = readFileSync(join(DATA_SRC, 'trade', 'agent', 'paper-desk.ts'), 'utf8');
  assert.match(desk, /kind !== 'paper'/, 'the desk guards that its executor is paper');
  assert.match(desk, /executor\.execute/, 'the only trade op is executor.execute');
});

// ── tighter than a deny-list: the paper path may import ONLY these modules (a new import must be reviewed here) ──
const IMPORT_ALLOW: Record<string, string[]> = {
  'mcp/paper-agent.ts': ['@dexterm/data', '@dexterm/data/plans'],
  'data/paper-desk.ts': ['../../clock.ts', '../plans/mandate.ts', '../kill-switch.ts', '../plans/journal.ts', '../../paper.ts', '../../sources/jupiter-swap.ts', '../plans/types.ts', '../ledger/tags.ts', '../ledger/schema.ts'],
  'data/rendezvous.ts': ['node:fs', 'node:os', 'node:path', '../../clock.ts', '../plans/journal.ts', '../plans/mandate.ts', './paper-desk.ts'],
};
const PAPER_PATH: Record<string, string> = {
  'mcp/paper-agent.ts': join(MCP_SRC, 'paper-agent.ts'),
  'data/paper-desk.ts': join(DATA_SRC, 'trade', 'agent', 'paper-desk.ts'),
  'data/rendezvous.ts': join(DATA_SRC, 'trade', 'agent', 'rendezvous.ts'),
};
const specifiers = (file: string): string[] => [...readFileSync(file, 'utf8').matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);

test('the paper path imports only reviewed modules', () => {
  for (const [k, file] of Object.entries(PAPER_PATH)) {
    for (const s of specifiers(file)) assert.ok(IMPORT_ALLOW[k].includes(s), `${k} imports an unreviewed module "${s}" — review it for any sign/send/cap path, then add it to IMPORT_ALLOW`);
  }
  // '@dexterm/data/plans' re-exports the live plan executor: paper-agent may only take TYPES from it.
  const pa = readFileSync(PAPER_PATH['mcp/paper-agent.ts'], 'utf8');
  for (const m of pa.matchAll(/import\s+(type\s+)?\{[^}]*\}\s+from\s+['"]@dexterm\/data\/plans['"]/g)) assert.ok(m[1], 'paper-agent.ts takes only types from @dexterm/data/plans');
  // The only swap-vendor call on the paper path is the keyless QUOTE.
  for (const m of pa.matchAll(/jupiterSwap\.(\w+)/g)) assert.equal(m[1], 'quote');
});

test('no sign / send / arm / cap-changing identifier appears on the tool-call or paper path', () => {
  const BAD = /\b(SignerClient|SignerService|LivePlanExecutor|LiveExecutor|FastWallet|signTransaction|signAllTransactions|sendTransaction|sendRawTransaction|armMandate|armMandateByKeypress|armPlanByKeypress|draftMandate|revokeMandate|setLive|useLive|writeCaps|setCaps|raiseCap)\b/;
  for (const file of [join(MCP_SRC, 'server.ts'), ...Object.values(PAPER_PATH)]) {
    const src = readFileSync(file, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n'); // code, not comments
    const hit = BAD.exec(src);
    assert.equal(hit, null, `${file.split('/').slice(-2).join('/')} references "${hit?.[1]}"`);
  }
});

test('the paper tools dispatch only to the desk verbs, and the desk exposes nothing else', async () => {
  const server = readFileSync(join(MCP_SRC, 'server.ts'), 'utf8');
  const body = server.slice(server.indexOf('private async paperTool('), server.indexOf('private async paperTool(') + 4000);
  const called = new Set([...body.matchAll(/\bdesk\.(\w+)\(/g)].map((m) => m[1]));
  assert.deepEqual([...called].sort(), ['close', 'confirm', 'open', 'pnl', 'positions', 'size', 'tag']);
  const { PaperAgentDesk } = await import('@dexterm/data');
  const methods = Object.getOwnPropertyNames(PaperAgentDesk.prototype).filter((n) => n !== 'constructor');
  const isPublic = (n: string) => !/^(perTradeCapUsd|note|refuse|gate|requireAction|requireMintAllowed|price|costUsd|openCostUsd|realizedLossUsd|admitBuy|buildOrder|freshQuote|book|positionView|sessionId|bookLamports)$/.test(n);
  // task-1530: tag() appends a journal line only (agent.paper.tag); it books nothing
  assert.deepEqual(methods.filter(isPublic).sort(), ['close', 'confirm', 'open', 'pnl', 'positions', 'size', 'tag'], 'a new desk method must be reviewed here');
});
