// dexterm autotrade — candidate and position sessions on a LOCAL model (task-1543, Ollama).
//
// The same protocol as the claude sessions (sessions.ts, AUTOTRADE-SPEC §4): one conversation per coin, the
// DOSSIER first, then DELTA / ENGINE / EVENT messages, and every reply ends in one `DECISION {json}` line that
// session.ts parses against the closed schema and the engine clamps. What differs is only who answers:
//
//   * the session is TOOL-LESS by construction: no `tools` are ever sent to /api/chat (the test asserts the
//     request body), so the model can only answer;
//   * the reply is constrained with Ollama structured output ({ comment, decision }) and rendered back into the
//     exact text form the claude path produces, so parseDecision, the clamp, the caps and the ledger are shared;
//   * a reply later than decideWithinSec aborts the request and resolves as no answer (no late result exists);
//   * cost is $0 (the user's own machine); the day turn / session caps of the SessionGate still apply.
//
// The restriction profile is checked when the factory is built: autotrade on a local engine needs `paper`
// (`full` for anything live). Nothing here sees a key, a wallet or the signer.

import { OllamaError, atLeast, requiredLevel, stripThink, type OllamaClient, type OllamaMessage, type Restriction } from '@dexterm/mcp/engine';
import type { SessionGate, SessionKind, CliSession } from './sessions.ts';
import type { ResolvedStrategy } from './strategy.ts';
import { ACTIONS, parseDecision, type Reply, type SessionStats } from './session.ts';

/** The structured-output schema of one reply: a short comment and the decision object (the closed §4 shape). */
export const OLLAMA_DECISION_FORMAT = {
  type: 'object',
  properties: {
    comment: { type: 'string' },
    decision: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...ACTIONS] },
        profile: { type: 'string' },
        sizePct: { type: 'number' },
        confidence: { type: 'number' },
        fraction: { type: 'number' },
        reason: { type: 'string' },
      },
      required: ['action', 'reason'],
    },
  },
  required: ['comment', 'decision'],
} as const;

/** Render a structured reply as the claude-path text: comment lines, then one DECISION line. Raw text is kept as is. */
export function renderOllamaReply(content: string): string {
  const s = stripThink(content).trim();
  let v: unknown;
  try { v = JSON.parse(s); } catch { return s; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return s;
  const o = v as { comment?: unknown; decision?: unknown };
  if (!o.decision || typeof o.decision !== 'object') return s;
  // Drop keys the model set to null (optional fields), keep everything else for the closed-schema check to judge.
  const d = Object.fromEntries(Object.entries(o.decision as Record<string, unknown>).filter(([, x]) => x !== null));
  const comment = typeof o.comment === 'string' ? o.comment.replace(/\n+/g, ' ').trim().slice(0, 400) : '';
  return `${comment}\nDECISION ${JSON.stringify(d)}`.trim();
}

export interface OllamaSessionOpts {
  client: OllamaClient;
  model: string;
  numCtx: number;
  systemPrompt: string;
  maxTurns: number;
  decideWithinMs: number;
  onRaw?: (line: string) => void;
}

class OllamaSession implements CliSession {
  readonly id: string;
  readonly kind = 'ollama' as const;
  readonly model: string;
  private readonly o: OllamaSessionOpts;
  private readonly messages: OllamaMessage[];
  private turns = 0;
  private closed = false;
  private why: string | null = null;
  private inflight: AbortController | null = null;

  constructor(id: string, o: OllamaSessionOpts) {
    this.id = id;
    this.o = o;
    this.model = o.model;
    this.messages = [{ role: 'system', content: o.systemPrompt }];
  }

  costUsd(): number { return 0; }
  endReason(): string | null { return this.why; }
  turnsUsed(): number { return this.turns; }

  async send(text: string): Promise<Reply | null> {
    if (this.closed || this.why) return null;
    if (this.turns >= this.o.maxTurns) return null;
    this.turns++;
    const t0 = Date.now();
    this.messages.push({ role: 'user', content: text });
    const ac = new AbortController();
    this.inflight = ac;
    const timer = setTimeout(() => ac.abort(), this.o.decideWithinMs);
    timer.unref?.();
    try {
      // Tool-less: the request never carries `tools`.
      const r = await this.o.client.chat({ model: this.o.model, messages: this.messages, format: OLLAMA_DECISION_FORMAT as unknown as Record<string, unknown>, options: { num_ctx: this.o.numCtx } }, { signal: ac.signal, timeoutMs: this.o.decideWithinMs + 1000 });
      this.o.onRaw?.(JSON.stringify({ engine: 'ollama', model: r.model ?? this.o.model, content: r.content.slice(0, 4000), promptTokens: r.promptTokens, evalTokens: r.evalTokens }));
      const reply = renderOllamaReply(r.content);
      this.messages.push({ role: 'assistant', content: reply });
      return { text: reply, decision: parseDecision(reply), costUsd: 0, ms: Date.now() - t0 };
    } catch (e) {
      // No answer in time (or the server went away): the turn resolves as no answer, never as a late decision.
      this.messages.push({ role: 'assistant', content: '(no answer in time)' });
      if (e instanceof OllamaError && (e.kind === 'unreachable' || e.kind === 'model-missing')) this.why = e.kind === 'unreachable' ? 'ollama-unreachable' : 'model-missing';
      return null;
    } finally {
      clearTimeout(timer);
      if (this.inflight === ac) this.inflight = null;
    }
  }

  async close(reason: string): Promise<SessionStats> {
    this.closed = true;
    try { this.inflight?.abort(); } catch { /* ignore */ }
    this.why ??= reason;
    return { turns: this.turns, costUsd: 0, reason };
  }
}

export interface OllamaFactoryOpts {
  client: OllamaClient;
  /** The local model (strategy.agent.model names a claude model, so the local one is set explicitly). */
  model: string;
  numCtx: number;
  /** The user's local-engine profile; autotrade needs `paper` (`full` when the run is live). */
  restriction: Restriction;
  live?: boolean;
  systemPrompt: (s: ResolvedStrategy) => string;
  gate: SessionGate;
  log: (kind: string, data: Record<string, unknown>) => void;
  onRaw?: (sessionId: string, line: string) => void;
}

/** Throws when the profile does not allow autotrade on a local engine (the run refuses to start). */
export function assertAutotradeAllowed(restriction: Restriction, live = false): void {
  const need = requiredLevel('autotrade', { live });
  if (!atLeast(restriction, need)) throw new Error(`the local engine's restriction profile is ${restriction}; ${live ? 'a live' : 'an autotrade'} run needs ${need} (dexterm ai restrictions ${need}${need === 'full' ? ', or dexterm ai engine ollama --full' : ''})`);
}

/** The runner's session factory on the user's local Ollama: same signature and protocol as claudeSessionFactory. */
export function ollamaSessionFactory(f: OllamaFactoryOpts): (id: string, s: ResolvedStrategy, ctx: { kind: SessionKind; mint: string }) => CliSession {
  assertAutotradeAllowed(f.restriction, f.live);
  return (id, s, ctx) => {
    f.log('session_init', { sessionId: id, sessionKind: ctx.kind, engine: 'ollama', model: f.model, host: f.client.host.local ? 'local' : 'remote', tools: 0, mcpServers: 0, restriction: f.restriction, costUsd: 0, ok: true });
    return new OllamaSession(id, {
      client: f.client, model: f.model, numCtx: f.numCtx, systemPrompt: f.systemPrompt(s),
      maxTurns: s.agent.maxTurns, decideWithinMs: s.agent.decideWithinSec * 1000,
      onRaw: f.onRaw ? (line) => f.onRaw!(id, line) : undefined,
    });
  };
}
