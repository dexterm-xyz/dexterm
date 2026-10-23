// dexterm autotrade chat — the Telegram transport (task-1527, AUTOTRADE-SPEC §8.2). The user's OWN bot.
//
// Long polling from the user's machine: `getUpdates` (timeout 50 s, allowed_updates message + callback_query,
// offset = last update_id + 1, a dedupe set on top). There is no webhook and no inbound port, so nothing outside can
// inject an update: every update comes from this process's own poll, and Telegram stamps `from.id` server-side.
//
//   sendMessage           plain text: NO parse_mode, link previews off. A token name cannot inject markup or a link.
//   sendPhoto             the PnL card (multipart, the PNG bytes from the card renderer).
//   editMessageText       a resolved proposal is edited to its final line and loses its buttons.
//   answerCallbackQuery   the toast after a tap.
//   getWebhookInfo        on start and every 10 minutes: a webhook that is set, or a 409 on getUpdates, means someone
//                         else holds the token. The connector reports a conflict: approvals stop (the broker refuses
//                         every callback while it is set), the user is alerted locally, local controls keep working.
//
// Rate limits: outbound 1 message/s per chat with a burst of 3 (the notify bus digests above 20/min); a 429's
// `retry_after` is honoured. The token is read once from the secret store and kept in this closure; every error that
// leaves this file goes through redactedError(), because the Bot API URL contains the token.

import type { ChatConnector, ChatKind, ConnectorHealth, InboundAction, InboundCommand, InboundText, OutMessage, SentRef } from './connector.ts';
import { parseCommand } from './connector.ts';
import { clip, plain } from './format.ts';
import { redact, redactedError } from './redact.ts';
import { createHash } from 'node:crypto';

export const TELEGRAM_API = 'https://api.telegram.org';
export const POLL_TIMEOUT_SEC = 50;
export const WEBHOOK_CHECK_MS = 10 * 60_000;
/** Messages older than this when the poll starts are dropped (taps are checked against their own expiry anyway). */
export const STALE_COMMAND_MS = 120_000;

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface TelegramOpts {
  /** The bot token (from the secret store); called once per connector. */
  token: () => string | null;
  fetch?: Fetch;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  apiBase?: string;
  pollTimeoutSec?: number;
  /** A redacted line for the local log (never the token). */
  onLog?: (line: string) => void;
}

interface TgResponse<T> { ok: boolean; result?: T; error_code?: number; description?: string; parameters?: { retry_after?: number } }
interface TgUser { id: number; is_bot?: boolean; username?: string; first_name?: string; last_name?: string }
interface TgChat { id: number; type: string }
interface TgMessage {
  message_id: number; chat: TgChat; from?: TgUser; date: number; text?: string;
  // A forwarded or inline-bot message carries someone else's words: it is never a command.
  forward_origin?: unknown; forward_from?: unknown; forward_from_chat?: unknown; forward_sender_name?: unknown; forward_date?: unknown;
  via_bot?: unknown; is_automatic_forward?: boolean;
}

const relayed = (m: TgMessage): boolean => m.forward_origin !== undefined || m.forward_from !== undefined || m.forward_from_chat !== undefined
  || m.forward_sender_name !== undefined || m.forward_date !== undefined || m.via_bot !== undefined || m.is_automatic_forward === true;
interface TgCallback { id: string; from: TgUser; message?: TgMessage; data?: string }
interface TgUpdate { update_id: number; message?: TgMessage; callback_query?: TgCallback }

export class TelegramApiError extends Error {
  readonly code: number;
  readonly retryAfter: number | null;
  constructor(code: number, description: string, retryAfter: number | null, knownToken?: string | null) {
    super(`telegram ${code}: ${redact(description, knownToken).slice(0, 200)}`);
    this.name = 'TelegramApiError';
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((r) => {
  if (signal?.aborted) { r(); return; }
  const t = setTimeout(r, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true });
});

const kindOf = (c: TgChat): ChatKind => (c.type === 'private' ? 'private' : 'group');

export class TelegramConnector implements ChatConnector {
  readonly transport = 'telegram';
  private readonly o: TelegramOpts;
  private readonly fetchFn: Fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private tokenValue: string | null = null;
  private offset = 0;
  private readonly seen = new Set<number>();
  private cmdH: ((c: InboundCommand) => void)[] = [];
  private actH: ((a: InboundAction) => void)[] = [];
  private txtH: ((t: InboundText) => void)[] = [];
  private h: ConnectorHealth = { transport: 'telegram', lastPollAt: 0, conflict: null, rateLimited: 0, errors: 0, lastError: null };
  /** Per chat send budget (1/s, burst 3). */
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private lastWebhookCheck = 0;
  private startedAt = 0;

  constructor(o: TelegramOpts) {
    this.o = o;
    this.fetchFn = o.fetch ?? ((u, i) => fetch(u, i));
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? defaultSleep;
  }

  private token(): string {
    if (this.tokenValue === null) this.tokenValue = this.o.token();
    if (!this.tokenValue) throw new Error('no bot token: run `dexterm telegram setup`');
    return this.tokenValue;
  }

  private log(s: string): void { this.o.onLog?.(redact(s, this.tokenValue)); }

  /** One Bot API call. Requests are built here only; nothing outside sees the URL. */
  async call<T>(method: string, body?: Record<string, unknown> | FormData, signal?: AbortSignal, timeoutMs = 15_000): Promise<T> {
    const url = `${this.o.apiBase ?? TELEGRAM_API}/bot${this.token()}/${method}`;
    const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    let res: Response;
    try {
      res = await this.fetchFn(url, body instanceof FormData
        ? { method: 'POST', body, signal: sig }
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}), signal: sig });
    } catch (e) {
      throw redactedError(e, this.tokenValue);
    }
    let j: TgResponse<T>;
    try { j = (await res.json()) as TgResponse<T>; } catch (e) { throw redactedError(new Error(`telegram ${res.status}: not JSON (${(e as Error).message})`), this.tokenValue); }
    if (!j.ok) throw new TelegramApiError(j.error_code ?? res.status, j.description ?? 'error', j.parameters?.retry_after ?? null, this.tokenValue);
    return j.result as T;
  }

  /** The bot's own account (setup prints the username only). */
  async getMe(): Promise<{ id: string; username: string }> {
    const me = await this.call<TgUser>('getMe');
    return { id: String(me.id), username: me.username ?? '' };
  }

  /** 'clear' only when Telegram answered and no webhook is set; pairing refuses anything else. */
  async checkWebhook(): Promise<'clear' | 'webhook' | 'unknown'> {
    this.lastWebhookCheck = this.now();
    try {
      const w = await this.call<{ url?: string }>('getWebhookInfo');
      if (w.url) { this.setConflict('a webhook is set on this bot: someone else may hold its token'); return 'webhook'; }
      return 'clear';
    } catch (e) { this.noteError(e); return 'unknown'; }
  }

  private setConflict(why: string): void {
    if (this.h.conflict) return;
    this.h.conflict = why;
    this.log(`conflict: ${why}`);
  }

  private noteError(e: unknown): void {
    this.h.errors++;
    this.h.lastError = redact(e instanceof Error ? e.message : String(e), this.tokenValue).slice(0, 200);
    this.log(`error: ${this.h.lastError}`);
  }

  /** Tell Telegram every update up to the last one seen is handled (one short call, no wait). */
  async confirmOffset(): Promise<void> {
    if (this.offset > 0) await this.call('getUpdates', { offset: this.offset, timeout: 0, limit: 1, allowed_updates: ['message', 'callback_query'] });
  }

  async start(signal: AbortSignal): Promise<void> {
    this.startedAt = this.now();
    await this.checkWebhook();
    let backoff = 1000;
    while (!signal.aborted) {
      if (this.now() - this.lastWebhookCheck >= WEBHOOK_CHECK_MS) await this.checkWebhook();
      try {
        const timeout = this.o.pollTimeoutSec ?? POLL_TIMEOUT_SEC;
        const ups = await this.call<TgUpdate[]>('getUpdates', { offset: this.offset, timeout, allowed_updates: ['message', 'callback_query'] }, signal, (timeout + 15) * 1000);
        this.h.lastPollAt = this.now();
        backoff = 1000;
        for (const u of ups) this.handle(u);
      } catch (e) {
        if (signal.aborted) break;
        if (e instanceof TelegramApiError && e.code === 409) this.setConflict('another getUpdates poll or a webhook holds this bot (409)');
        if (e instanceof TelegramApiError && e.code === 429) { this.h.rateLimited++; await this.sleep(Math.max(1, e.retryAfter ?? 5) * 1000, signal); continue; }
        this.noteError(e);
        await this.sleep(backoff, signal);
        backoff = Math.min(30_000, backoff * 2);
      }
    }
  }

  /** One update (exported for the transport tests). Duplicates and updates from bots are dropped. */
  handle(u: TgUpdate): void {
    if (typeof u.update_id !== 'number') return;
    this.offset = Math.max(this.offset, u.update_id + 1);
    if (this.seen.has(u.update_id)) return;
    this.seen.add(u.update_id);
    if (this.seen.size > 2000) { const first = this.seen.values().next().value; if (first !== undefined) this.seen.delete(first); }
    const updateId = String(u.update_id);
    if (u.callback_query) {
      const q = u.callback_query;
      if (!q.message || q.from.is_bot || typeof q.data !== 'string') return;
      const a: InboundAction = { transport: this.transport, updateId, actionId: q.id, chatId: String(q.message.chat.id), chatKind: kindOf(q.message.chat), senderId: String(q.from.id), ref: { chatId: String(q.message.chat.id), messageId: String(q.message.message_id) }, data: q.data.slice(0, 64), t: (q.message.date ?? 0) * 1000 };
      for (const h of this.actH) h(a);
      return;
    }
    const m = u.message;
    if (!m || !m.from || m.from.is_bot || typeof m.text !== 'string') return;
    // A command typed while nothing was polling (minutes or days ago) is not acted on when the bot comes back.
    if (this.startedAt && m.date * 1000 < this.startedAt - STALE_COMMAND_MS) { this.h.staleSkipped = (this.h.staleSkipped ?? 0) + 1; return; }
    const base = { transport: this.transport, updateId, chatId: String(m.chat.id), chatKind: kindOf(m.chat), senderId: String(m.from.id), t: m.date * 1000 };
    const p = relayed(m) ? null : parseCommand(m.text);
    if (p) {
      const name = [m.from.first_name, m.from.last_name].filter((x) => typeof x === 'string' && x).join(' ');
      const sender = { ...(typeof m.from.username === 'string' && m.from.username ? { username: m.from.username } : {}), ...(name ? { name } : {}) };
      for (const h of this.cmdH) h({ ...base, sender, command: p.command, args: p.args });
      return;
    }
    const x: InboundText = { ...base, length: m.text.length, sha256: createHash('sha256').update(m.text).digest('hex') };
    for (const h of this.txtH) h(x);
  }

  /** 1 message/s per chat with a burst of 3 (a token bucket): wait for a slot. */
  private async slot(chatId: string): Promise<void> {
    for (;;) {
      const now = this.now();
      const b = this.buckets.get(chatId) ?? { tokens: 3, at: now };
      b.tokens = Math.min(3, b.tokens + Math.max(0, now - b.at) / 1000);
      b.at = now;
      this.buckets.set(chatId, b);
      if (b.tokens >= 1) { b.tokens -= 1; return; }
      await this.sleep(Math.ceil((1 - b.tokens) * 1000));
    }
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (let i = 0; ; i++) {
      try { return await fn(); } catch (e) {
        if (e instanceof TelegramApiError && e.code === 429 && i < 2) { this.h.rateLimited++; await this.sleep(Math.max(1, e.retryAfter ?? 3) * 1000); continue; }
        throw e instanceof TelegramApiError ? e : redactedError(e, this.tokenValue);
      }
    }
  }

  private markup(msg: OutMessage): Record<string, unknown> | undefined {
    if (msg.kind !== 'proposal') return undefined;
    return { inline_keyboard: [msg.buttons.map((b) => ({ text: b.label.slice(0, 32), callback_data: b.data }))] };
  }

  async send(to: { chatId: string }, msg: OutMessage): Promise<SentRef> {
    await this.slot(to.chatId);
    if (msg.kind === 'card') {
      return this.withRetry(async () => {
        const fd = new FormData();
        fd.set('chat_id', to.chatId);
        fd.set('caption', clip(plain(msg.badge, [msg.caption]), 1000));
        fd.set('photo', new Blob([msg.png as Uint8Array<ArrayBuffer>], { type: 'image/png' }), 'pnl-card.png');
        const m = await this.call<TgMessage>('sendPhoto', fd, undefined, 30_000);
        return { chatId: to.chatId, messageId: String(m.message_id) };
      });
    }
    return this.withRetry(async () => {
      const m = await this.call<TgMessage>('sendMessage', {
        chat_id: to.chatId, text: clip(plain(msg.badge, msg.lines)), link_preview_options: { is_disabled: true },
        ...(this.markup(msg) ? { reply_markup: this.markup(msg) } : {}),
      });
      return { chatId: to.chatId, messageId: String(m.message_id) };
    });
  }

  async edit(ref: SentRef, msg: OutMessage): Promise<void> {
    if (msg.kind === 'card') return;
    await this.withRetry(() => this.call('editMessageText', {
      chat_id: ref.chatId, message_id: Number(ref.messageId), text: clip(plain(msg.badge, msg.lines)), link_preview_options: { is_disabled: true },
      reply_markup: this.markup(msg) ?? { inline_keyboard: [] },
    }));
  }

  onCommand(h: (c: InboundCommand) => void): void { this.cmdH.push(h); }
  onAction(h: (a: InboundAction) => void): void { this.actH.push(h); }
  onText(h: (t: InboundText) => void): void { this.txtH.push(h); }

  async ackAction(a: InboundAction, toast: string): Promise<void> {
    try { await this.call('answerCallbackQuery', { callback_query_id: a.actionId, text: toast.slice(0, 190) }); } catch (e) { this.noteError(e); }
  }

  health(): ConnectorHealth { return { ...this.h }; }
}
