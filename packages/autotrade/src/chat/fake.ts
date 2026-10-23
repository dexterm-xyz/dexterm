// dexterm autotrade chat — the fake transport (task-1527, AUTOTRADE-SPEC §8.2). No network, for every test.
//
// An in-memory ChatConnector with a scriptable user: `user(id, chatId).command('/pause')`, `.tap(ref, data)`,
// `.text('buy it now')`. Every outbound message is kept in `sent` (with its plain text, buttons and edits), so a
// test can read exactly what a phone would show. Updates get increasing update ids like Telegram's; `redeliver`
// replays an old update (a duplicate delivery) to test the dedupe.

import { createHash } from 'node:crypto';
import { parseCommand, type ChatConnector, type ChatKind, type ConnectorHealth, type InboundAction, type InboundCommand, type InboundText, type OutMessage, type SentRef } from './connector.ts';
import { plain } from './format.ts';

export interface FakeSent { ref: SentRef; msg: OutMessage; text: string; buttons: { label: string; data: string }[]; edits: OutMessage[]; acks: string[] }

type Update = { kind: 'command'; c: InboundCommand } | { kind: 'action'; a: InboundAction } | { kind: 'text'; x: InboundText };

export class FakeConnector implements ChatConnector {
  readonly transport = 'fake';
  readonly sent: FakeSent[] = [];
  readonly toasts: { actionId: string; toast: string }[] = [];
  /** Make the next n sends fail (a Telegram outage, a 429). */
  failSends = 0;
  conflict: string | null = null;
  private cmdH: ((c: InboundCommand) => void)[] = [];
  private actH: ((a: InboundAction) => void)[] = [];
  private txtH: ((t: InboundText) => void)[] = [];
  private updateSeq = 1000;
  private msgSeq = 1;
  private readonly delivered: Update[] = [];
  private readonly clock: () => number;

  constructor(o: { now?: () => number } = {}) { this.clock = o.now ?? Date.now; }

  async start(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    await new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true }));
  }

  async send(to: { chatId: string }, msg: OutMessage): Promise<SentRef> {
    if (this.failSends > 0) { this.failSends--; throw new Error('fake transport: send failed'); }
    const ref = { chatId: to.chatId, messageId: String(this.msgSeq++) };
    const lines = msg.kind === 'card' ? [msg.caption] : msg.lines;
    this.sent.push({ ref, msg, text: plain(msg.badge, lines), buttons: msg.kind === 'proposal' ? msg.buttons.map((b) => ({ ...b })) : [], edits: [], acks: [] });
    return ref;
  }

  async edit(ref: SentRef, msg: OutMessage): Promise<void> {
    const s = this.sent.find((x) => x.ref.chatId === ref.chatId && x.ref.messageId === ref.messageId);
    if (!s) throw new Error('fake transport: no such message');
    s.edits.push(msg);
    s.buttons = msg.kind === 'proposal' ? msg.buttons.map((b) => ({ ...b })) : [];
    s.text = plain(msg.badge, msg.kind === 'card' ? [msg.caption] : msg.lines);
  }

  onCommand(h: (c: InboundCommand) => void): void { this.cmdH.push(h); }
  onAction(h: (a: InboundAction) => void): void { this.actH.push(h); }
  onText(h: (t: InboundText) => void): void { this.txtH.push(h); }

  async ackAction(a: InboundAction, toast: string): Promise<void> {
    this.toasts.push({ actionId: a.actionId, toast });
    const s = this.sent.find((x) => x.ref.chatId === a.ref.chatId && x.ref.messageId === a.ref.messageId);
    s?.acks.push(toast);
  }

  health(): ConnectorHealth { return { transport: this.transport, lastPollAt: this.clock(), conflict: this.conflict, rateLimited: 0, errors: 0, lastError: null }; }

  /** A scripted person in a chat (`sender`: the @username / display name Telegram would report with a command). */
  user(senderId: string, chatId = senderId, chatKind: ChatKind = 'private', sender?: { username?: string; name?: string }) {
    const base = () => ({ transport: this.transport, updateId: String(++this.updateSeq), chatId, chatKind, senderId, t: this.clock() });
    return {
      /** Send "/cmd args" (or any text: non-commands arrive as text, never parsed). */
      command: (text: string) => {
        const p = parseCommand(text);
        if (!p) { this.deliver({ kind: 'text', x: { ...base(), length: text.length, sha256: createHash('sha256').update(text).digest('hex') } }); return; }
        this.deliver({ kind: 'command', c: { ...base(), ...(sender ? { sender } : {}), command: p.command, args: p.args } });
      },
      text: (text: string) => this.deliver({ kind: 'text', x: { ...base(), length: text.length, sha256: createHash('sha256').update(text).digest('hex') } }),
      /** Tap a button: by its message ref and data (a forged tap can carry any data). */
      tap: (ref: SentRef, data: string) => this.deliver({ kind: 'action', a: { ...base(), actionId: `cb${this.updateSeq}`, ref, data } }),
    };
  }

  /** The newest message whose text matches, for tests. */
  last(re?: RegExp): FakeSent | undefined {
    for (let i = this.sent.length - 1; i >= 0; i--) if (!re || re.test(this.sent[i].text)) return this.sent[i];
    return undefined;
  }

  /** Deliver an old update again (Telegram can redeliver; the router dedupes by update id). */
  redeliver(index = -1): void {
    const u = this.delivered.at(index);
    if (u) this.dispatch(u);
  }

  private deliver(u: Update): void { this.delivered.push(u); this.dispatch(u); }

  private dispatch(u: Update): void {
    if (u.kind === 'command') for (const h of this.cmdH) h(u.c);
    else if (u.kind === 'action') for (const h of this.actH) h(u.a);
    else for (const h of this.txtH) h(u.x);
  }
}
