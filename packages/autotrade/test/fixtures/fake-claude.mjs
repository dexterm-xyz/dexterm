#!/usr/bin/env node
// task-1505 test fixture: a stand-in for `claude -p --input-format stream-json --output-format stream-json`.
// It speaks the same line protocol (init, rate_limit_event, assistant, result per user turn) and is driven by env:
//   FAKE_OUT            file to write a JSON report to (argv, env NAMES, the sha256 of what fd 3 carried)
//   FAKE_API_KEY_SOURCE the init event's apiKeySource (default "none")
//   FAKE_TOOLS          comma list for the init tool list (default empty)
//   FAKE_PLUGINS        comma list of plugin names for the init plugin list (default empty; task-1509)
//   FAKE_MCP            comma list of MCP server names for the init mcp_servers list (default empty; task-1509)
//   FAKE_RATE           JSON for rate_limit_info (default: allowed, 0.1 / 0.2)
//   FAKE_REPLIES        JSON array of reply texts, one per turn (the last one repeats)
//   FAKE_DELAYS         JSON array of per-turn delays in ms (default 0)
//   FAKE_COST           cost added per turn in USD (default 0.0003)
// No network, no model, no keys. The fd-3 content is hashed, never written.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const env = process.env;
let fd3 = null;
if (env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR) {
  try { fd3 = createHash('sha256').update(readFileSync(Number(env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR))).digest('hex'); } catch { fd3 = 'unreadable'; }
}
if (env.FAKE_OUT) writeFileSync(env.FAKE_OUT, JSON.stringify({ argv: process.argv.slice(2), envNames: Object.keys(env).sort(), fd3Sha256: fd3, configDir: env.CLAUDE_CONFIG_DIR ?? null, hasApiKey: !!env.ANTHROPIC_API_KEY, apiKeySha256: env.ANTHROPIC_API_KEY ? createHash('sha256').update(env.ANTHROPIC_API_KEY).digest('hex') : null }));

const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const replies = JSON.parse(env.FAKE_REPLIES ?? '["ok\\nDECISION {\\"action\\":\\"wait\\",\\"reason\\":\\"watching\\"}"]');
const delays = JSON.parse(env.FAKE_DELAYS ?? '[0]');
const perTurn = Number(env.FAKE_COST ?? '0.0003');
const tools = env.FAKE_TOOLS ? env.FAKE_TOOLS.split(',') : [];
const plugins = env.FAKE_PLUGINS ? env.FAKE_PLUGINS.split(',').map((name) => ({ name, path: 'builtin', source: `${name}@builtin` })) : [];
const mcpServers = env.FAKE_MCP ? env.FAKE_MCP.split(',').map((name) => ({ name, status: 'connected' })) : [];
let turn = 0;
let cost = 0;
let sentInit = false;

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const n = turn++;
  if (!sentInit) {
    sentInit = true;
    out({ type: 'system', subtype: 'init', tools, mcp_servers: mcpServers, model: 'fake-model', plugins, agents: ['general'], skills: [], slash_commands: [], apiKeySource: env.FAKE_API_KEY_SOURCE ?? 'none', permissionMode: 'dontAsk' });
    out({ type: 'rate_limit_event', rate_limit_info: JSON.parse(env.FAKE_RATE ?? '{"status":"allowed","resetsAt":1792562400,"unifiedWindows":{"five_hour":{"utilization":0.1},"seven_day":{"utilization":0.2}}}') });
  }
  const text = replies[Math.min(n, replies.length - 1)];
  setTimeout(() => {
    cost += perTurn;
    out({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
    out({ type: 'result', subtype: 'success', result: text, total_cost_usd: Number(cost.toFixed(6)), num_turns: n + 1 });
  }, delays[Math.min(n, delays.length - 1)] ?? 0);
});
rl.on('close', () => setTimeout(() => process.exit(0), 20));
