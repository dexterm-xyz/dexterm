// dexterm autotrade chat — the hub: one connector, the allowlist, the rate limits, the audit (task-1527, §8.1, §8.6).
//
// Inbound, in order, for every update from the connector's own poll:
//   dedupe by update id (a redelivered update is recorded once and never acted on twice);
//   audit (update id, sender, chat, the command or the action's record id; free text as length + hash only);
//   pairing (only while a local pairing window is open: `/pair <code>` from a private chat);
//   the allowlist: an unknown sender gets NO reply and nothing happens (five in an hour raise a local alert:
//     "possible token leak"); a paired sender needs the tier the command needs, in the chat it was paired in;
//   rate limit: 10 commands a minute per sender, except /kill, /stop, /pause and /flatten (never limited);
//   commands → the ControlRouter; button callbacks → the ApprovalBroker (the only trade authority);
//   free text → the help text, never parsed.
// Outbound: notify messages go to every chat paired with the notify tier; replies go to the asking chat only.

import type { ChatAudit } from './audit.ts';
import type { ApprovalBroker } from './approvals.ts';
import { allowed, type AllowEntry, type TelegramConfig, type Tier } from './config.ts';
import type { ChatConnector, InboundAction, InboundCommand, InboundText, OutMessage } from './connector.ts';
import { ControlRouter, HELP_LINES, NEVER_RATE_LIMITED, type ControlPort } from './control.ts';
import type { PairingWindow, PairResult } from './pairing.ts';
import type { Badge } from '../execution-port.ts';

export const COMMANDS_PER_MIN = 10;
export const UNKNOWN_ALERT_PER_HOUR = 5;

const READ_ONLY = ['status', 'positions', 'strategies', 'help', 'start'];

export interface HubOpts {
  connector: ChatConnector;
  config: () => TelegramConfig;
  audit: ChatAudit;
  badge: Badge;
  broker?: ApprovalBroker | null;
  port?: ControlPort | null;
  now?: () => number;
  /** A local alert (the terminal / runner log), never sent to chat. */
  alert?: (line: string) => void;
}

export class ChatHub {
  private readonly o: HubOpts;
  private readonly now: () => number;
  private readonly seen = new Set<string>();
  private readonly cmdTimes = new Map<string, number[]>();
  private unknownTimes: number[] = [];
  private lastUnknownAlert = 0;
  private router: ControlRouter | null;
  private pairing: { window: PairingWindow; onResult: (r: PairResult, c: InboundCommand) => void } | null = null;
  private inflight = new Set<Promise<unknown>>();

  constructor(o: HubOpts) {
    this.o = o;
    this.now = o.now ?? Date.now;
    this.router = o.port ? new ControlRouter(o.port) : null;
    o.connector.onCommand((c) => this.track(this.onCommand(c)));
    o.connector.onAction((a) => this.track(this.onAction(a)));
    o.connector.onText((t) => this.track(this.onText(t)));
  }

  private track(p: Promise<unknown>): void {
    const q = p.catch((e: unknown) => { this.o.audit.add(this.now(), 'hub_error', { error: e instanceof Error ? e.message.slice(0, 160) : String(e).slice(0, 160) }); }).finally(() => this.inflight.delete(q));
    this.inflight.add(q);
  }

  /** Wait for every inbound handler in flight (tests, shutdown). */
  async idle(): Promise<void> { while (this.inflight.size) await Promise.allSettled([...this.inflight]); }

  setPort(port: ControlPort | null): void { this.router = port ? new ControlRouter(port) : null; }

  /** Open a local pairing window: `/pair <code>` from a private chat is checked against it. */
  openPairing(window: PairingWindow, onResult: (r: PairResult, c: InboundCommand) => void): void { this.pairing = { window, onResult }; }
  closePairing(): void { this.pairing = null; }

  private dup(updateId: string): boolean {
    if (this.seen.has(updateId)) return true;
    this.seen.add(updateId);
    if (this.seen.size > 5000) { const f = this.seen.values().next().value; if (f !== undefined) this.seen.delete(f); }
    return false;
  }

  private unknown(senderId: string, what: string): void {
    const now = this.now();
    this.unknownTimes = this.unknownTimes.filter((t) => now - t < 3600_000);
    this.unknownTimes.push(now);
    this.o.audit.add(now, 'in_unknown_sender', { senderId, what });
    if (this.unknownTimes.length >= UNKNOWN_ALERT_PER_HOUR && now - this.lastUnknownAlert > 3600_000) {
      this.lastUnknownAlert = now;
      this.o.alert?.(`telegram: ${this.unknownTimes.length} messages from unknown accounts in the last hour: possible bot token leak. Revoke it with BotFather (/revoke), then run \`dexterm telegram setup\` again.`);
    }
  }

  private entry(senderId: string, chatId: string, tier: Tier): AllowEntry | null { return allowed(this.o.config(), senderId, chatId, tier); }

  private limited(senderId: string, command: string): boolean {
    if (NEVER_RATE_LIMITED.includes(command)) return false;
    const now = this.now();
    const ts = (this.cmdTimes.get(senderId) ?? []).filter((t) => now - t < 60_000);
    const over = ts.length >= COMMANDS_PER_MIN;
    if (!over) ts.push(now);
    this.cmdTimes.set(senderId, ts);
    return over;
  }

  async reply(chatId: string, lines: string[], template: string): Promise<void> {
    if (!lines.length) return;
    try {
      const ref = await this.o.connector.send({ chatId }, { kind: 'text', badge: this.o.badge, lines });
      this.o.audit.add(this.now(), 'out', { template, chatId, messageId: ref.messageId });
    } catch (e) {
      this.o.audit.add(this.now(), 'out_failed', { template, chatId, error: (e as Error).message.slice(0, 160) });
    }
  }

  private async onCommand(c: InboundCommand): Promise<void> {
    if (this.dup(c.updateId)) { this.o.audit.add(this.now(), 'in_duplicate', { updateId: c.updateId }); return; }
    this.o.audit.add(this.now(), 'in_command', { updateId: c.updateId, senderId: c.senderId, chatId: c.chatId, chatKind: c.chatKind, command: c.command, args: c.command === 'pair' ? c.args.length : c.args.map((a) => a.slice(0, 32)) });
    if (c.command === 'pair' && this.pairing) {
      // Another poller or a webhook on this bot means someone else holds the token and may have read the code:
      // the window closes for everyone (A-B1). The local side starts over once the token is revoked.
      const conflict = this.o.connector.health().conflict;
      const r: PairResult = conflict ? this.pairing.window.abort() : this.pairing.window.attempt(c.senderId, c.chatId, c.chatKind, c.args);
      this.o.audit.add(this.now(), 'pairing', { senderId: c.senderId, chatId: c.chatId, result: r.ok ? 'code-accepted' : r.why });
      this.pairing.onResult(r, c);
      // The code alone does not pair: the person at the computer confirms the account first (telegram-cmd.ts).
      if (r.ok) await this.reply(c.chatId, ['Code accepted. Confirm this account on your computer to finish pairing. I never ask for keys or seed phrases.'], 'pair_code_accepted');
      else if (r.why === 'group-chat') await this.reply(c.chatId, ['Pair from a private chat with the bot, not a group.'], 'pair_refused');
      return;
    }
    // Commands count only in a private chat (the allowlist pins the chat id too; this is the second fence).
    if (c.chatKind !== 'private') { this.unknown(c.senderId, `command:${c.command}:${c.chatKind}`); return; }
    const tier: Tier = READ_ONLY.includes(c.command) ? 'notify' : 'control';
    const e = this.entry(c.senderId, c.chatId, tier) ?? (tier === 'notify' ? this.entry(c.senderId, c.chatId, 'control') : null);
    if (!e) { this.unknown(c.senderId, `command:${c.command}`); return; }
    if (this.limited(c.senderId, c.command)) { this.o.audit.add(this.now(), 'rate_limited', { senderId: c.senderId, command: c.command }); await this.reply(c.chatId, ['Too many commands: wait a minute. /kill and /pause always work.'], 'rate_limited'); return; }
    if (!this.router) { await this.reply(c.chatId, ['No runner is connected right now.'], 'no_runner'); return; }
    const r = this.router.handle(c);
    this.o.audit.add(this.now(), 'command_result', { updateId: c.updateId, command: c.command, lines: r.lines.length, confirms: r.confirm?.length ?? 0 });
    await this.reply(c.chatId, r.lines, `cmd_${c.command}`);
    for (const cf of r.confirm ?? []) {
      if (!this.o.broker) { await this.reply(c.chatId, ['Confirm buttons are not available here: use dexterm on your computer.'], 'no_broker'); break; }
      await this.o.broker.confirm(cf.kind, { senderId: c.senderId, chatId: c.chatId }, cf.lines, cf.yes, cf.payload);
    }
  }

  private async onAction(a: InboundAction): Promise<void> {
    if (this.dup(a.updateId)) { this.o.audit.add(this.now(), 'in_duplicate', { updateId: a.updateId }); return; }
    const recId = /^[pc]:([A-Za-z0-9_-]{8}):/.exec(a.data)?.[1] ?? null;
    this.o.audit.add(this.now(), 'in_action', { updateId: a.updateId, senderId: a.senderId, chatId: a.chatId, chatKind: a.chatKind, messageId: a.ref.messageId, record: recId, bytes: a.data.length });
    // Unknown senders: dropped (counted), no toast beyond the transport's spinner end.
    if (!this.o.config().allow.some((x) => x.senderId === a.senderId)) {
      this.unknown(a.senderId, 'action');
      await this.o.connector.ackAction(a, '');
      return;
    }
    if (!this.o.broker) { await this.o.connector.ackAction(a, 'Not available.'); return; }
    await this.o.broker.handleAction(a);
  }

  private async onText(t: InboundText): Promise<void> {
    if (this.dup(t.updateId)) return;
    this.o.audit.add(this.now(), 'in_text', { updateId: t.updateId, senderId: t.senderId, chatId: t.chatId, length: t.length, sha256: t.sha256.slice(0, 16) });
    if (!this.entry(t.senderId, t.chatId, 'notify') && !this.entry(t.senderId, t.chatId, 'control')) { this.unknown(t.senderId, 'text'); return; }
    await this.reply(t.chatId, ['I only take /commands and buttons; messages are never read as trades.', ...HELP_LINES.slice(1, 3)], 'text_help');
  }

  /** Send to every chat paired with the notify tier. */
  async broadcast(msg: OutMessage, template: string): Promise<void> {
    const t = this.o.config();
    if (!t.tiers.includes('notify')) return;
    const chats = [...new Set(t.allow.filter((a) => a.tiers.includes('notify')).map((a) => a.chatId))];
    for (const chatId of chats) {
      try {
        const ref = await this.o.connector.send({ chatId }, msg);
        this.o.audit.add(this.now(), 'out', { template, chatId, messageId: ref.messageId, kind: msg.kind, lines: msg.kind === 'card' ? 1 : msg.lines.length });
      } catch (e) {
        this.o.audit.add(this.now(), 'out_failed', { template, chatId, error: (e as Error).message.slice(0, 160) });
      }
    }
  }
}
