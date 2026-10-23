// dexterm local engine: the tool loop (task-1543).
//
// The claude CLI runs its own agent loop; on a local engine dexterm runs it: send the conversation and the
// allowlisted tools to Ollama, execute each tool call the model asks for through the dexterm MCP server, feed
// the results back, repeat until the model answers without a tool call (or a step cap is hit).
//
// A call to a tool outside the allowlist is NEVER executed: the model gets "refused" back and the attempt is
// counted; after `maxRefusals` the turn stops (the codex path's tripwire, softened because small local models
// often invent tool names). Tool results are the MCP server's output, already firewalled.

import { OllamaError, stripThink, type ChatResult, type OllamaClient, type OllamaMessage, type OllamaTool } from './ollama.ts';

export interface ToolLoopOpts {
  client: OllamaClient;
  model: string;
  /** The conversation so far (system first). The loop appends the assistant/tool messages it produces. */
  messages: OllamaMessage[];
  /** Function tools; absent or empty = a tool-less turn. */
  tools?: OllamaTool[];
  /** Tool names that may run (the tools above are already filtered; this is the second wall). */
  allowed: readonly string[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
  numCtx?: number;
  maxSteps?: number;
  maxRefusals?: number;
  /** Cap on one tool result fed back to the model (characters). */
  maxToolResultChars?: number;
  signal?: AbortSignal;
  onText?: (delta: string) => void;
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  onToolResult?: (name: string, text: string) => void;
  onRefused?: (name: string) => void;
}

export interface ToolLoopResult {
  /** The final answer text (thinking stripped). */
  text: string;
  steps: number;
  toolCalls: number;
  refusals: number;
  promptTokens: number;
  evalTokens: number;
  model: string | null;
  /** Why the loop stopped early: 'refusals' | 'steps', or null for a normal answer. */
  stopped: 'refusals' | 'steps' | null;
}

export const DEFAULT_MAX_STEPS = 8;
export const DEFAULT_MAX_REFUSALS = 3;
export const DEFAULT_MAX_TOOL_RESULT = 24_000;

export async function runToolLoop(o: ToolLoopOpts): Promise<ToolLoopResult> {
  const maxSteps = o.maxSteps ?? DEFAULT_MAX_STEPS;
  const maxRefusals = o.maxRefusals ?? DEFAULT_MAX_REFUSALS;
  const cap = o.maxToolResultChars ?? DEFAULT_MAX_TOOL_RESULT;
  const allowed = new Set(o.allowed);
  const tools = o.tools && o.tools.length ? o.tools : undefined;
  const res: ToolLoopResult = { text: '', steps: 0, toolCalls: 0, refusals: 0, promptTokens: 0, evalTokens: 0, model: null, stopped: null };
  const options = o.numCtx ? { num_ctx: o.numCtx } : undefined;

  for (;;) {
    if (o.signal?.aborted) throw new OllamaError('aborted', 'cancelled');
    const lastStep = res.steps >= maxSteps;
    res.steps++;
    // A think block streams as content on some models: hold it back from the user, show only the answer.
    let shown = 0;
    let raw = '';
    const onDelta = o.onText ? (d: string): void => {
      raw += d;
      const visible = stripThink(raw);
      if (raw.includes('<think>') && !/<\/think>/.test(raw)) return;
      if (visible.length > shown) { o.onText!(visible.slice(shown)); shown = visible.length; }
    } : undefined;
    const r: ChatResult = await o.client.chat({ model: o.model, messages: o.messages, ...(tools && !lastStep ? { tools } : {}), ...(options ? { options } : {}) }, { onDelta, signal: o.signal });
    res.promptTokens += r.promptTokens;
    res.evalTokens += r.evalTokens;
    res.model = r.model ?? res.model;
    const content = stripThink(r.content).trim();
    const calls = tools && !lastStep ? r.toolCalls : [];
    o.messages.push({ role: 'assistant', content: r.content, ...(calls.length ? { tool_calls: calls } : {}) });
    if (!calls.length) {
      res.text = content;
      if (lastStep && r.toolCalls.length) res.stopped = 'steps';
      return res;
    }
    for (const c of calls) {
      const name = c.function.name;
      if (!allowed.has(name)) {
        res.refusals++;
        o.onRefused?.(name);
        o.messages.push({ role: 'tool', tool_name: name, content: JSON.stringify({ error: `refused: ${name.slice(0, 64)} is not a tool you have in this session` }) });
        continue;
      }
      res.toolCalls++;
      o.onToolCall?.(name, c.function.arguments);
      let text: string;
      try { text = await o.callTool(name, c.function.arguments); } catch (e) { text = JSON.stringify({ error: (e as Error).message.slice(0, 300) }); }
      o.onToolResult?.(name, text);
      o.messages.push({ role: 'tool', tool_name: name, content: text.length > cap ? `${text.slice(0, cap)}…(truncated)` : text });
    }
    if (res.refusals >= maxRefusals) { res.stopped = 'refusals'; res.text = content; return res; }
    // At the step cap the next round is the last one: no tools, answer with what you have.
    if (res.steps >= maxSteps) o.messages.push({ role: 'user', content: 'Tool budget reached for this turn. Answer now from the tool results above; do not call another tool.' });
  }
}

/**
 * Ask for the final answer as JSON matching a schema (Ollama structured outputs), after a tool loop. Returns the
 * parsed object, or null when the model did not produce valid JSON.
 */
export async function structuredAnswer(o: { client: OllamaClient; model: string; messages: OllamaMessage[]; schema: Record<string, unknown>; numCtx?: number; signal?: AbortSignal; instruction?: string }): Promise<{ value: Record<string, unknown> | null; raw: string; promptTokens: number; evalTokens: number }> {
  o.messages.push({ role: 'user', content: o.instruction ?? 'Now return ONLY the final JSON object that the output schema requires, filled from the tool results and the context above. No prose.' });
  const r = await o.client.chat({ model: o.model, messages: o.messages, format: o.schema, ...(o.numCtx ? { options: { num_ctx: o.numCtx } } : {}) }, { signal: o.signal });
  const raw = stripThink(r.content).trim();
  o.messages.push({ role: 'assistant', content: r.content });
  let value: Record<string, unknown> | null = null;
  try { const v = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '')); value = v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null; } catch { value = null; }
  return { value, raw, promptTokens: r.promptTokens, evalTokens: r.evalTokens };
}
