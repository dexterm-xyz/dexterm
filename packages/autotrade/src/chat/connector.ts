// dexterm autotrade chat — the transport-agnostic connector (task-1527, AUTOTRADE-SPEC §8.2).
//
// The engine never imports a transport. A connector delivers three things inward and two outward:
//   inward   commands from a closed list ("/status", "/pause", …), button callbacks (the ONLY thing that can
//            authorise a trade), and the pairing message "/pair <code>". Free text is never parsed into anything:
//            it arrives as `text` with its length only and is answered with the help text.
//   outward  plain-text messages (never markup), PnL card images, and proposals with buttons whose labels and
//            callback data come from engine state only.
//
// Transports: telegram (long poll from the user's machine, telegram.ts) and fake (in memory, fake.ts, every test).

import type { Badge } from '../execution-port.ts';

export type { Badge } from '../execution-port.ts';

/** The closed command list (§8.4 tier 2). Anything else is `help`. */
export const COMMANDS = ['status', 'positions', 'pause', 'resume', 'kill', 'stop', 'flatten', 'strategies', 'use', 'approvals', 'help', 'pair', 'start'] as const;
export type Command = (typeof COMMANDS)[number];

export type ChatKind = 'private' | 'group';

export interface ChatTarget { chatId: string }
export interface SentRef { chatId: string; messageId: string }

export interface InboundCommand {
  transport: string;
  updateId: string;
  chatId: string;
  chatKind: ChatKind;
  senderId: string;
  /** The sender's public handle and display name as the transport reports them (pairing shows them locally only). */
  sender?: { username?: string; name?: string };
  command: Command;
  args: string[];
  /** The transport's timestamp (logged only: the local clock decides every expiry). */
  t: number;
}

export interface InboundAction {
  transport: string;
  updateId: string;
  /** The transport's id for this callback (answered with ackAction). */
  actionId: string;
  chatId: string;
  chatKind: ChatKind;
  senderId: string;
  /** The message the button was on. */
  ref: SentRef;
  data: string;
  t: number;
}

/** A message that is not a command: never parsed, only measured (the audit keeps its length and hash). */
export interface InboundText {
  transport: string;
  updateId: string;
  chatId: string;
  chatKind: ChatKind;
  senderId: string;
  length: number;
  sha256: string;
  t: number;
}

export interface Button { label: string; data: string }

export type OutMessage =
  | { kind: 'text'; badge: Badge | null; lines: string[] }
  | { kind: 'card'; badge: Badge; png: Uint8Array; caption: string }
  | { kind: 'proposal'; badge: Badge; lines: string[]; buttons: Button[]; expiresAt: number };

export interface ConnectorHealth {
  transport: string;
  /** Local time of the last successful poll (0 = never). */
  lastPollAt: number;
  /** Someone else holds the token (a webhook is set, or a 409 on getUpdates): approvals stop, local controls stay. */
  conflict: string | null;
  rateLimited: number;
  errors: number;
  lastError: string | null;
  /** Commands sent while nothing was polling, dropped when it came back. */
  staleSkipped?: number;
}

export interface ChatConnector {
  readonly transport: string;
  /** Outbound polling only; resolves when the signal aborts. */
  start(signal: AbortSignal): Promise<void>;
  send(to: ChatTarget, msg: OutMessage): Promise<SentRef>;
  /** Replace a message's text and drop its buttons (a resolved proposal loses its buttons). */
  edit(ref: SentRef, msg: OutMessage): Promise<void>;
  onCommand(h: (c: InboundCommand) => void): void;
  onAction(h: (a: InboundAction) => void): void;
  onText(h: (t: InboundText) => void): void;
  ackAction(a: InboundAction, toast: string): Promise<void>;
  health(): ConnectorHealth;
}

/** "/Status@my_bot arg" → {command, args}; null when it is not a slash command. Unknown names map to help. */
export function parseCommand(text: string): { command: Command; args: string[] } | null {
  const t = text.trim();
  if (!t.startsWith('/')) return null;
  const [head, ...rest] = t.split(/\s+/);
  const name = head.slice(1).split('@')[0].toLowerCase();
  const command = (COMMANDS as readonly string[]).includes(name) ? (name as Command) : 'help';
  // Args are short tokens only (a preset id, a pairing code, on/off): never prose.
  const args = rest.slice(0, 3).map((a) => a.slice(0, 40));
  return { command, args };
}
