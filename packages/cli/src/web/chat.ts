// dexterm — the Strategy Builder web chat (task-2170). A second front end on the SAME assistant as the in-app chat:
// one `runAnalyst` turn per message (the user's own Claude CLI, the dexterm MCP server, the analyst system prompt and
// the prompt firewall), resumed so the conversation stays warm. What differs is narrow and stated here:
//   * the chat turn env carries `surface: "web"`: strategy_change previews from here never write or remove FACTORY-STOP,
//     and the MCP server refuses WEB_CHAT_DENIED_TOOLS (promotion, the external-agent factory controls, fleet controls);
//   * UI-action tools (navigate the terminal, open a ticket) are denied at the CLI layer: there is no terminal here;
//   * a change the assistant previews becomes a card with Confirm / Cancel. Confirm runs the SAME confirmChange as
//     typing "confirm <code>" in the next message (the click is the user's own message; the model never confirms);
//     Cancel cancels it the same way a "no" does. Neither click spends a Claude turn.
// Every event the browser receives passes webRedact; the page renders all of it as text.
import { randomBytes } from 'node:crypto';
import * as engine from '@dexterm/autotrade';
import { PAPER_WRITE_TOOLS, WEB_CHAT_DENIED_TOOLS, defaultFactoryRunner } from '@dexterm/mcp';
import { runAnalyst, type AnalystHandle, type AnalystHandlers, type AnalystRequest } from '../analyst/backend.ts';
import { webRedact } from './redact.ts';

export const WEB_CHAT_MAX_CHARS = 1500;
export const WEB_CHAT_BUDGET_USD = 0.5;
/** Not a UI-action type: a non-empty list keeps the propose / change tools and denies all five UI actions. */
export const WEB_ACTION_TYPES = ['web-chat'] as const;
export const WEB_DENY_TOOLS: readonly string[] = [...WEB_CHAT_DENIED_TOOLS, ...PAPER_WRITE_TOOLS];

export type WebChatEvent =
  | { type: 'user'; turn: string; text: string }
  | { type: 'text'; turn: string; delta: string }
  | { type: 'tool'; turn: string; name: string; input: unknown }
  | { type: 'confirm'; turn: string; code: string; action: string; target: string | null; preview: string }
  | { type: 'resolved'; code: string; ok: boolean; text: string }
  | { type: 'done'; turn: string; costUsd: number | null; model: string | null }
  | { type: 'error'; turn: string | null; message: string };

export type RunTurn = (req: AnalystRequest, handlers: AnalystHandlers) => AnalystHandle;

const PREFIX = '[dexterm Strategy Builder web UI. PAPER only. The user sees their strategies, the builder and the factory in a browser. '
  + 'To change something call strategy_change WITHOUT confirm (it previews); the user confirms or cancels with a button, which reaches you as their next message. '
  + 'Never claim a strategy finds winners or makes money; candidates are not edges; dexterm places no orders.]';

export class WebChat {
  readonly chatId: string;
  private readonly home: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly emit: (ev: WebChatEvent) => void;
  private readonly run: RunTurn;
  private readonly model: string | undefined;
  private sessionId: string | null = null;
  private seq = 0;
  private handle: AnalystHandle | null = null;
  private turn: string | null = null;
  /** Results of button confirms the model has not heard about yet (told at the start of the next turn). */
  private notes: string[] = [];
  readonly log: WebChatEvent[] = [];

  constructor(o: { home: string; chatId: string; emit: (ev: WebChatEvent) => void; run?: RunTurn; env?: NodeJS.ProcessEnv; model?: string }) {
    this.home = o.home; this.chatId = o.chatId; this.run = o.run ?? runAnalyst; this.model = o.model; this.env = o.env ?? process.env;
    this.emit = (ev) => { const r = webRedact(ev) as WebChatEvent; this.log.push(r); if (this.log.length > 400) this.log.shift(); o.emit(r); };
  }

  get busy(): boolean { return this.handle !== null; }

  send(text0: unknown): { ok: true; turn: string } | { ok: false; why: string } {
    if (this.busy) return { ok: false, why: 'the assistant is still answering' };
    const text = typeof text0 === 'string' ? text0.replace(/\r/g, '').trim() : '';
    if (!text) return { ok: false, why: 'empty message' };
    if (text.length > WEB_CHAT_MAX_CHARS) return { ok: false, why: `at most ${WEB_CHAT_MAX_CHARS} characters` };
    const turn = `w${++this.seq}-${randomBytes(3).toString('hex')}`;
    this.turn = turn;
    this.emit({ type: 'user', turn, text });
    const notes = this.notes.splice(0);
    const prompt = `${PREFIX}${notes.length ? `\n[Since your last reply, from the web UI buttons: ${notes.join(' · ')}]` : ''}\n\n${text}`;
    const req: AnalystRequest = {
      prompt, resume: this.sessionId ?? undefined, budgetUsd: WEB_CHAT_BUDGET_USD, ...(this.model ? { model: this.model } : {}),
      screenState: { screen: 'strategy-builder-web', selected: null, watchlist: [] },
      actionTypes: WEB_ACTION_TYPES, denyTools: WEB_DENY_TOOLS,
      chatTurn: { chatId: this.chatId, turn, userText: text, surface: 'web' },
    };
    let ended = false;
    // Redaction works on whole strings, and an address has no whitespace: streamed text is held back to its last
    // whitespace so an address split across two deltas is still masked (flushed at the end of the turn).
    let held = '';
    const flush = (all: boolean): void => {
      const cut = all ? held.length : Math.max(held.lastIndexOf(' '), held.lastIndexOf('\n'), held.length > 4000 ? held.length : -1) + 1;
      if (cut <= 0) return;
      const out = held.slice(0, cut); held = held.slice(cut);
      if (out) this.emit({ type: 'text', turn, delta: out });
    };
    const end = (): void => { if (ended) return; ended = true; flush(true); this.handle = null; this.turn = null; this.offerConfirm(turn); };
    this.handle = { cancel() {} }; // busy while the turn starts (a stub may answer synchronously)
    const h = this.run(req, {
      onInit: (i) => { if (i.sessionId) this.sessionId = i.sessionId; },
      onText: (d) => { held += d; flush(false); },
      onToolCall: (ev) => { flush(true); this.emit({ type: 'tool', turn, name: ev.name.replace(/^mcp__dexterm__/, ''), input: clip(ev.input) }); },
      onResult: (r) => { if (r.sessionId) this.sessionId = r.sessionId; flush(true); this.emit({ type: 'done', turn, costUsd: r.costUsd, model: r.model }); end(); },
      onError: (m, d) => { flush(true); this.emit({ type: 'error', turn, message: d ? `${m}: ${d}` : m }); end(); },
    });
    if (!ended) this.handle = h;
    return { ok: true, turn };
  }

  cancelTurn(): boolean {
    if (!this.handle) return false;
    const t = this.turn;
    try { this.handle.cancel(); } catch { /* gone */ }
    this.handle = null; this.turn = null;
    this.emit({ type: 'error', turn: t, message: 'stopped' });
    return true;
  }

  /** A change previewed in this turn (this chat's newest pending one) becomes a Confirm / Cancel card. */
  private offerConfirm(turn: string): void {
    const p = engine.listPending(this.home, this.chatId).find((x) => x.status === 'pending' && x.turn === turn);
    if (p) this.emit({ type: 'confirm', turn, code: p.code, action: p.action, target: p.target, preview: p.preview });
  }

  /** The Confirm button: the user's own message "confirm <code>", through the same confirmChange. */
  confirm(code: unknown): { ok: boolean; text: string } {
    if (typeof code !== 'string' || !/^C[0-9A-F]{6}$/.test(code)) return { ok: false, text: 'not a change code' };
    const store = new engine.StrategyStore({ home: this.home, env: this.env });
    const chat = { chatId: this.chatId, turn: `wb-${randomBytes(4).toString('hex')}`, userText: `confirm ${code}`, surface: 'web' as const };
    const r = engine.confirmChange(this.home, store, code, { chat, deps: { runFactory: () => defaultFactoryRunner(this.home, this.env, { by: 'chat' }) } });
    const text = r.ok ? r.result : r.why;
    this.notes.push(`${code} ${r.ok ? `applied: ${text}` : `not applied: ${text}`}`);
    this.emit({ type: 'resolved', code, ok: r.ok, text });
    return { ok: r.ok, text };
  }

  /** The Cancel button: the user's own "cancel", through the same confirmChange (a no-word cancels). */
  cancel(code: unknown): { ok: boolean; text: string } {
    if (typeof code !== 'string' || !/^C[0-9A-F]{6}$/.test(code)) return { ok: false, text: 'not a change code' };
    const store = new engine.StrategyStore({ home: this.home, env: this.env });
    const chat = { chatId: this.chatId, turn: `wb-${randomBytes(4).toString('hex')}`, userText: 'cancel', surface: 'web' as const };
    const r = engine.confirmChange(this.home, store, code, { chat });
    const text = r.ok ? r.result : r.change?.status === 'cancelled' ? 'cancelled: nothing changed' : r.why;
    this.notes.push(`${code} cancelled by the user`);
    this.emit({ type: 'resolved', code, ok: false, text });
    return { ok: true, text };
  }
}

function clip(x: unknown): unknown {
  try { const s = JSON.stringify(x); return s.length > 600 ? `${s.slice(0, 600)}…` : x; } catch { return null; }
}
