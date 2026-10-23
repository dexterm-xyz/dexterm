// @dexterm/mcp — read-only MCP server over stdio (SPEC §5, D-09 / task-1302).
// Every tool is read-only and schema-described; nothing in this package may build,
// sign or send a transaction (SPEC §5.2, §6.3).

export { runStdioServer, selfTest, McpTools, TOOLS, READ_ONLY_TOOLS, PAPER_WRITE_TOOLS, PAPER_READ_TOOLS, PAPER_NOTE_TOOLS, appHelpAnswer, firewall, listPrompts, getPrompt, resourceList, resourceRead, overlayCounts, userSkillPreamble, BUNDLED_KB_DIR, BUNDLED_SKILLS_DIR } from './server.ts';
// task-1443: resolve the paper agent desk from the running app's rendezvous (null when agent paper trading is off).
export { resolvePaperAgentDesk, paperAgentDeskDb } from './paper-agent.ts';
export {
  OverlayStore, mergeOverlay, loadBundled, checkKb, checkSkill, moneyToolMentions, isMoneyToolName, parseFrontmatter,
  dextermHome, userKbDir, userSkillsDir, userDir, contentJournalPath, journalContent, writeOverlayFile, resetOverlayFile, templateFor,
  KB_LIMITS, SKILL_LIMITS, KB_ID, SKILL_NAME, KB_RULE, MONEY_TOOLS,
  type ContentEntry, type ContentKind, type MergedSet, type SkippedFile, type CheckResult, type BundledSource, type Origin,
} from './user-content.ts';
// task-1507: the AUTOTRADE chat tools (strategy reads + proposals), the model deny-list, the risk delta and the
// proposal files the Q screen's keypress path re-checks and applies.
export {
  AutotradeTools, ProposalFiles, checkProposal, riskDelta, diffLines, screenDelta, deniedChanges, opsPolicyErrors, opsShapeErrors,
  proposalCardView, proposalsDir, isProposalId, cleanText, loadEngine, STRATEGY_DENIED_FOR_MODELS, STRATEGY_READ_TOOLS, STRATEGY_PROPOSE_TOOLS,
  AUTOTRADE_TOOLS, PARALLEL_READ_TOOLS, PARALLEL_CONTROL_TOOLS, PARALLEL_TOOLS, MAX_PROPOSAL_OPS, BACKTEST_MAX_DAYS, BACKTEST_RATE, PROPOSAL_SCHEMA, RUNNER_STATUS_SCHEMA,
  type Engine, type StrategyProposalRecord, type ProposalCheck, type ProposalInput, type RiskDelta, type RiskReason, type ProposalStatus,
} from './autotrade-tools.ts';
export { buildDossier, type DossierInput, type DossierAvailability } from './dossier.ts';
// task-1530: the trade-ledger tools (reads + the backtest request), and the request files the CLI runs or dismisses.
export { LedgerTools, LEDGER_TOOLS, LEDGER_READ_TOOLS, LEDGER_PROPOSE_TOOLS, tradeView, filterFromArgs, type LedgerToolsOpts } from './ledger-tools.ts';
export { BacktestRequests, requestsDir, isRequestId, BACKTEST_REQUEST_SCHEMA, REQUEST_MAX_DAYS, MAX_PENDING_REQUESTS, REQUEST_RATE_PER_HOUR, type BacktestRequest, type RequestStatus } from './backtest-requests.ts';
// task-1406 + task-1421: the spectator sink the tool-call path writes to when a spectator surface is open
// (via DEXTERM_SPECTATOR_FILE, or the ~/.dexterm rendezvous an external `dexterm mcp` client uses).
export {
  recordForToolCall, maxAgeSec, fileSpectatorSinkFromEnv, resolveSpectatorSink, rendezvousPath,
  MCP_SPECTATOR_RENDEZVOUS, MCP_FOLLOW_SCREEN, FOLLOW_NAV_ACTIONS, followScreenPath, readFollowScreen, writeFollowScreen, clearFollowScreen,
  type McpSpectatorRecord, type McpSpectatorSink, type LiveSpectatorSink, type McpSpectatorRendezvous,
} from './spectator-sink.ts';
export { loadAppHelp, searchAppHelp, getAppHelp, APP_HELP_DIR, type AppHelpEntry, loadDocsKb, searchDocs, getDocs, searchHelp, DOCS_KB_DIR, helpIntent, type DocsEntry, type HelpHit } from './app-help.ts';

/** Tool names served in v1 (SPEC §5.2 core + the task-1293 KB/case tools + the task-1314 dossier). */
export const PLANNED_TOOLS = [
  'screen_state',
  'screener_query',
  'get_token',
  'get_dossier',
  'analyze_token',
  'get_holders',
  'get_trades',
  'get_candles',
  'rugcheck',
  'get_dev_history',
  'dev_history',
  'kb_lookup',
  'kb_search',
  'case_lookup',
] as const;

export type PlannedTool = (typeof PLANNED_TOOLS)[number];
