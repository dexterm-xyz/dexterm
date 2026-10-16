// @dexterm/mcp — read-only MCP server over stdio (SPEC §5, D-09 / task-1302).
// Every tool is read-only and schema-described; nothing in this package may build,
// sign or send a transaction (SPEC §5.2, §6.3).

export { runStdioServer, selfTest, McpTools, TOOLS, READ_ONLY_TOOLS, firewall, listPrompts, getPrompt, resourceList, resourceRead, overlayCounts, userSkillPreamble, BUNDLED_KB_DIR, BUNDLED_SKILLS_DIR } from './server.ts';
export {
  OverlayStore, mergeOverlay, loadBundled, checkKb, checkSkill, moneyToolMentions, isMoneyToolName, parseFrontmatter,
  dextermHome, userKbDir, userSkillsDir, userDir, contentJournalPath, journalContent, writeOverlayFile, resetOverlayFile, templateFor,
  KB_LIMITS, SKILL_LIMITS, KB_ID, SKILL_NAME, KB_RULE, MONEY_TOOLS,
  type ContentEntry, type ContentKind, type MergedSet, type SkippedFile, type CheckResult, type BundledSource, type Origin,
} from './user-content.ts';
export { buildDossier, type DossierInput, type DossierAvailability } from './dossier.ts';
// task-1406: the spectator sink the tool-call path writes to when launched with a spectator channel.
export { recordForToolCall, maxAgeSec, fileSpectatorSinkFromEnv, type McpSpectatorRecord, type McpSpectatorSink } from './spectator-sink.ts';
export { loadAppHelp, searchAppHelp, getAppHelp, APP_HELP_DIR, type AppHelpEntry } from './app-help.ts';

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
  'kb_lookup',
  'kb_search',
  'case_lookup',
] as const;

export type PlannedTool = (typeof PLANNED_TOOLS)[number];
