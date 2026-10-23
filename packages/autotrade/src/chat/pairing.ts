// dexterm autotrade chat — pairing by a local code (task-1527, AUTOTRADE-SPEC §8.3).
//
// `dexterm telegram pair` shows a 6-digit code on the local screen that lives 5 minutes. The user sends
// `/pair <code>` to their bot from their own account in a PRIVATE chat. The code travels through Telegram, so a
// token holder with a competing poll can read it (and swallow the user's message): a correct code is therefore not
// enough. Pairing refuses while a webhook or a 409 conflict is seen, and the account that sent the code (its
// @username and id) is shown on the local screen for a y/N before that sender id + chat id go on the allowlist
// (telegram-cmd.ts). The code is single use, compared in constant time, and five wrong tries end the window.

import { randomInt, timingSafeEqual } from 'node:crypto';
import type { ChatKind } from './connector.ts';

export const PAIR_TTL_MS = 5 * 60_000;
export const PAIR_MAX_TRIES = 5;

export type PairResult = { ok: true; senderId: string; chatId: string } | { ok: false; why: 'expired' | 'wrong-code' | 'group-chat' | 'locked' | 'used' | 'no-code' | 'conflict' };

export class PairingWindow {
  readonly code: string;
  readonly expiresAt: number;
  private tries = 0;
  private done = false;
  private readonly now: () => number;

  constructor(o: { now?: () => number; code?: string; ttlMs?: number } = {}) {
    this.now = o.now ?? Date.now;
    this.code = o.code ?? String(randomInt(0, 1_000_000)).padStart(6, '0');
    this.expiresAt = this.now() + (o.ttlMs ?? PAIR_TTL_MS);
  }

  get open(): boolean { return !this.done && this.tries < PAIR_MAX_TRIES && this.now() < this.expiresAt; }

  /** Close the window for good (someone else holds the token): the code never pairs anyone after this. */
  abort(): PairResult { this.done = true; return { ok: false, why: 'conflict' }; }

  attempt(senderId: string, chatId: string, chatKind: ChatKind, args: string[]): PairResult {
    if (this.done) return { ok: false, why: 'used' };
    if (this.tries >= PAIR_MAX_TRIES) return { ok: false, why: 'locked' };
    if (this.now() >= this.expiresAt) return { ok: false, why: 'expired' };
    if (chatKind !== 'private') return { ok: false, why: 'group-chat' };
    const given = (args[0] ?? '').replace(/\D/g, '');
    if (!given) return { ok: false, why: 'no-code' };
    this.tries++;
    const a = Buffer.from(given.padStart(6, '0').slice(-6));
    const b = Buffer.from(this.code);
    if (given.length !== 6 || !timingSafeEqual(a, b)) return { ok: false, why: this.tries >= PAIR_MAX_TRIES ? 'locked' : 'wrong-code' };
    this.done = true;
    return { ok: true, senderId, chatId };
  }
}
