// dexterm local engine: restriction profiles and the engine-parity matrix (task-1543).
//
// A local engine (Ollama) can do everything the Claude path does, behind a restriction profile the USER picks:
//
//   observe  analyse only: read tools, no UI actions, no proposals, no orders
//   propose  the analyst's surface: read tools + UI actions (open_ticket only OPENS a paper ticket) + strategy
//            proposals the user applies by keypress. The default for a new local setup.
//   paper    propose + paper orders (autotrade paper sessions, agent paper trading inside a mandate you armed)
//   full     everything the Claude path may do, subject to the same user-set mandate tiers and gates
//
// The profile only decides what the engine may ASK for. Every limit that protects money is enforced outside
// the model and is identical for every engine: the signer's caps, the kill switch, the dead-man switch, live-mode
// gating, mandate tiers, the strategy clamp and the Telegram button/nonce rules. A model can request; it can
// never raise a cap, arm a mandate or turn live on, and no tool, MCP call or chat message changes the profile.

import { ANALYST_ACTION_TYPES } from '@dexterm/data';
import { PAPER_NOTE_TOOLS, PAPER_READ_TOOLS, PAPER_WRITE_TOOLS, READ_ONLY_TOOLS } from '../server.ts';
import { JOURNEY_CONTROL_TOOLS, JOURNEY_PROPOSE_TOOLS, PARALLEL_CONTROL_TOOLS, STRATEGY_PROPOSE_TOOLS } from '../autotrade-tools.ts';
import { LEDGER_PROPOSE_TOOLS } from '../ledger-tools.ts';

export const RESTRICTION_LEVELS = ['observe', 'propose', 'paper', 'full'] as const;
export type Restriction = typeof RESTRICTION_LEVELS[number];
export const RESTRICTION_RANK: Record<Restriction, number> = { observe: 0, propose: 1, paper: 2, full: 3 };
/** A new local-engine setup starts here. `full` needs a typed confirmation (`dexterm ai engine ollama --full`). */
export const DEFAULT_RESTRICTION: Restriction = 'propose';

export const RESTRICTION_HELP: Record<Restriction, string> = {
  observe: 'analyse only (read tools; no UI actions, no proposals, no orders)',
  propose: 'analyst + proposals (UI actions, a PAPER ticket you confirm, strategy proposals you apply); no orders',
  paper: 'proposals + paper orders (autotrade paper sessions, agent paper trading inside a mandate you armed)',
  full: 'everything the Claude path may do, inside the same caps, mandate tiers, kill switch and live gating',
};

export function isRestriction(v: unknown): v is Restriction {
  return typeof v === 'string' && (RESTRICTION_LEVELS as readonly string[]).includes(v);
}

export function atLeast(have: Restriction, need: Restriction): boolean {
  return RESTRICTION_RANK[have] >= RESTRICTION_RANK[need];
}

export function lowerOf(a: Restriction, b: Restriction): Restriction {
  return RESTRICTION_RANK[a] <= RESTRICTION_RANK[b] ? a : b;
}

/** What an engine may ask for, by the lowest profile that allows it. */
export const CAPABILITY_LEVEL = {
  analyse: 'observe',
  'ui-actions': 'propose',
  'strategy-proposals': 'propose',
  'paper-orders': 'paper',
  'live-orders': 'full',
} as const satisfies Record<string, Restriction>;
export type Capability = keyof typeof CAPABILITY_LEVEL;

export function allows(level: Restriction, cap: Capability): boolean {
  return atLeast(level, CAPABILITY_LEVEL[cap]);
}

/**
 * Tool names no local engine is ever handed, whatever a server grows (defence in depth: the dexterm MCP server
 * has no such tool, and its no-sign registry test keeps it that way).
 */
export const NEVER_TOOL = /(^|_)(sign|signer|send|transfer|withdraw|arm|disarm|caps?|key|keys|seed|keystore|live|mainnet|unlock|resume|panic|restrictions?|engine)(_|$)/i;

/**
 * The dexterm MCP tools a local engine may call at a profile. `actionTypes` is the session's UI-action list
 * exactly as the claude path reads it: absent = all of them, `[]` (AI scan) = none and no proposals either.
 */
export function engineToolAllowlist(level: Restriction, actionTypes?: readonly string[]): string[] {
  const actions = ANALYST_ACTION_TYPES as readonly string[];
  const reads = READ_ONLY_TOOLS.filter((n) => !/^paper_/.test(n) && !actions.includes(n));
  const out = new Set<string>(reads);
  const observeOnly = !!actionTypes && actionTypes.length === 0;
  if (allows(level, 'ui-actions') && !observeOnly) for (const t of actions) if (!actionTypes || actionTypes.includes(t)) out.add(t);
  if (allows(level, 'strategy-proposals') && !observeOnly) for (const t of [...STRATEGY_PROPOSE_TOOLS, ...JOURNEY_PROPOSE_TOOLS]) out.add(t);
  // Paper tools: the MCP server still refuses them unless the user armed a mandate and enabled agent paper trading.
  if (allows(level, 'paper-orders') && !observeOnly) for (const t of [...PAPER_READ_TOOLS, ...PAPER_WRITE_TOOLS]) out.add(t);
  // v0.1.7 integration: the other paper-side writes (start / stop / pause one listed parallel strategy, a paper
  // journal tag, a backtest request file) join at `paper`, so `paper` and `full` offer every tool the claude path has
  if (allows(level, 'paper-orders') && !observeOnly) for (const t of [...PARALLEL_CONTROL_TOOLS, ...JOURNEY_CONTROL_TOOLS, ...PAPER_NOTE_TOOLS, ...LEDGER_PROPOSE_TOOLS]) out.add(t);
  return [...out].filter((n) => !NEVER_TOOL.test(n));
}

/** The surfaces that run a model, and the profile each needs on a local engine. */
export const SURFACES = ['analyst', 'autotrade', 'packs', 'agent'] as const;
export type Surface = typeof SURFACES[number];

/** The profile a surface needs before a local engine may run it (live autotrade needs `full`). */
export function requiredLevel(surface: Surface, o: { live?: boolean } = {}): Restriction {
  if (surface === 'autotrade') return o.live ? 'full' : 'paper';
  if (surface === 'agent') return 'propose';
  return 'observe';
}

export type ParityStatus = 'equivalent' | 'degrade' | 'engine-independent' | 'not-in-app';

export interface ParityRow {
  id: string;
  surface: string;
  /** What the Claude path does today. */
  claude: string;
  /** What the local engine does (or the documented, tested degrade). */
  local: string;
  status: ParityStatus;
  /** The lowest restriction profile that allows it on a local engine (null: not engine-gated). */
  minLevel: Restriction | null;
  /** The test file that proves the row (the parity matrix test checks every row names one that exists). */
  test: string;
}

/**
 * Every place the Claude CLI is spawned or assumed, and its local-engine equivalent. Kept in code so the docs,
 * `dexterm ai status` and the parity test read the same list.
 */
export const ENGINE_PARITY: readonly ParityRow[] = [
  { id: 'analyst-chat', surface: 'Analyst chat (token screen, `a`, follow-ups)', claude: 'claude -p with the read-only dexterm MCP server', local: 'Ollama /api/chat (streamed) with the same dexterm MCP server over stdio, same tools, same firewall', status: 'equivalent', minLevel: 'observe', test: 'packages/cli/test/ollama-analyst-1543.test.ts' },
  { id: 'analyst-skills', surface: 'Structured skills (dossier, rug-check, larp-check, trench-scan)', claude: '--json-schema structured output', local: 'tool loop, then Ollama structured output (format = the same schema)', status: 'equivalent', minLevel: 'observe', test: 'packages/cli/test/ollama-analyst-1543.test.ts' },
  { id: 'analyst-no-tools', surface: 'A model without tool calling', claude: 'n/a (Claude always has tools)', local: 'dexterm fetches the dossier itself and the model answers from it without tools, and says so', status: 'degrade', minLevel: 'observe', test: 'packages/cli/test/ollama-analyst-1543.test.ts' },
  { id: 'ai-scan', surface: 'AI scan mode (Z)', claude: 'observe-only analyst session', local: 'same session on the local engine, observe-only at the allowlist, the MCP server and the app', status: 'equivalent', minLevel: 'observe', test: 'packages/cli/test/ollama-analyst-1543.test.ts' },
  { id: 'jarvis', surface: 'Jarvis voice questions', claude: 'asks through the analyst session', local: 'asks through the same session, on whichever engine /engine picked', status: 'equivalent', minLevel: 'observe', test: 'packages/cli/test/ollama-analyst-1543.test.ts' },
  { id: 'ask', surface: 'Headless question (`dexterm ai ask`)', claude: 'the analyst backend on claude', local: 'the analyst backend on Ollama', status: 'equivalent', minLevel: 'observe', test: 'packages/cli/test/ollama-analyst-1543.test.ts' },
  { id: 'strategy-proposals', surface: 'Tune by chat (strategy_propose_edit / _new)', claude: 'MCP propose tools; the user applies by keypress', local: 'the same tools at `propose`; the same keypress apply path', status: 'equivalent', minLevel: 'propose', test: 'packages/mcp/test/ollama-engine-1543.test.ts' },
  { id: 'autotrade-sessions', surface: 'Autotrade candidate + position sessions', claude: 'tool-less claude -p, DECISION line, engine clamp', local: 'tool-less Ollama session, the same DECISION line (structured output), the same clamp, caps and ledger', status: 'equivalent', minLevel: 'paper', test: 'packages/autotrade/test/ollama-sessions-1543.test.ts' },
  { id: 'live-executors', surface: 'Live orders (signer, mandates)', claude: 'requests only; the signer enforces the caps', local: 'requests only, at `full`; the same signer, caps, mandate tiers, kill switch and live gating', status: 'equivalent', minLevel: 'full', test: 'packages/autotrade/test/ollama-sessions-1543.test.ts' },
  { id: 'packs-reason', surface: 'Pack reasoning stage (tighten-only verdict; a library stage no app screen calls today)', claude: 'tool-less claude -p with --json-schema', local: 'tool-less Ollama structured output, the same grounding/tighten-only checks (ollamaReasonRunner)', status: 'equivalent', minLevel: 'observe', test: 'packages/mcp/test/ollama-engine-1543.test.ts' },
  { id: 'mcp-agent', surface: 'MCP agent (incl. agent paper trading in an armed mandate)', claude: 'claude -p connected to `dexterm mcp`', local: '`dexterm ai agent`: Ollama as the MCP client, tools by profile, paper tools only at `paper`', status: 'equivalent', minLevel: 'propose', test: 'packages/cli/test/ollama-analyst-1543.test.ts' },
  { id: 'telegram', surface: 'Telegram control + approvals', claude: 'human buttons (one-time, nonce/hash/expiry, sender allowlist)', local: 'the same: approvals are taps by the user, never by a model, whichever engine proposed', status: 'engine-independent', minLevel: null, test: 'packages/autotrade/test/ollama-sessions-1543.test.ts' },
  { id: 'agent-bus', surface: 'Loopback agent bus / SDK agents', claude: 'agents bring their own model', local: 'the same; a local agent can use the SDK or `dexterm ai agent`', status: 'engine-independent', minLevel: null, test: 'packages/mcp/test/ollama-engine-1543.test.ts' },
  { id: 'allowance-guard', surface: 'Claude allowance guard (rate_limit_event)', claude: 'pauses sessions near the plan limit', local: 'no plan limit and $0 cost; the day turn and session caps still apply', status: 'degrade', minLevel: null, test: 'packages/autotrade/test/ollama-sessions-1543.test.ts' },
  { id: 'routines', surface: 'Scheduled routines', claude: 'none run in the app today (daily-digest is defined only)', local: 'any future routine goes through the same engine seam', status: 'not-in-app', minLevel: null, test: 'packages/mcp/test/ollama-engine-1543.test.ts' },
];
