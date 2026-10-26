// dexterm autotrade chat — connectors.json (task-1527, AUTOTRADE-SPEC §8.3). It never holds a secret.
//
// $DEXTERM_HOME/connectors.json (0600):
//   { schema, telegram: { enabled, bot: {id, username}, secretStore, tiers, allow: [{senderId, chatId, tiers,
//     pairedAt}], notify: {…per event…}, dailySummaryAt, quietHours, approvals, approvalExpirySec, repriceTolPct,
//     showAbsoluteBook }, signals: {…} }
// task-1645: `signals` is the real-mode trade-fire channel setup (signal-channels.ts parses it); it lives here so the
// Telegram copy and the executor channels are configured in one place. This module only carries it through.
// Only local commands write it (`dexterm telegram setup|pair|revoke|approvals|notify`). From chat, exactly one
// field can change: `approvals` from "off" to "on" (safer); everything else, and "off", is local only.

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from '../ledger.ts';

export const CONNECTORS_SCHEMA = 'dexterm-connectors/1';
export type Tier = 'notify' | 'control' | 'approve';
export const TIERS_ALL: readonly Tier[] = ['notify', 'control', 'approve'];

export interface AllowEntry { senderId: string; chatId: string; tiers: Tier[]; pairedAt: number }

export interface NotifyPrefs {
  /** Candidates found: one digest per 15 minutes (default), each one, or off. */
  candidates: 'digest' | 'each' | 'off';
  entries: boolean;
  closes: boolean;
  halts: boolean;
  spend: boolean;
  daily: boolean;
}

export interface TelegramConfig {
  enabled: boolean;
  bot: { id: string; username: string } | null;
  /** Where the token is: the OS keychain (macOS), libsecret (Linux), or a 0600 file under secrets/. */
  secretStore: 'keychain' | 'libsecret' | 'file' | null;
  tiers: Tier[];
  allow: AllowEntry[];
  notify: NotifyPrefs;
  /** Local "HH:MM" for the daily summary, or null for none. */
  dailySummaryAt: string | null;
  /** Local "HH:MM-HH:MM": notify-only messages wait (proposals, halts and replies to commands still go). */
  quietHours: string | null;
  /** "on" = every entry needs a one-tap approval. Chat can turn it on; only a local command turns it off. */
  approvals: 'on' | 'off';
  approvalExpirySec: number;
  /** A re-quote that moved more than this re-confirms the proposal once (never above the strategy's slippage). */
  repriceTolPct: number;
  /** Paper only: show the absolute book in USD (default: % only). */
  showAbsoluteBook: boolean;
}

export interface ConnectorsConfig { schema: typeof CONNECTORS_SCHEMA; telegram: TelegramConfig; /** task-1645: parsed by signal-channels.ts. */ signals?: unknown }

export const DEFAULT_NOTIFY: NotifyPrefs = { candidates: 'digest', entries: true, closes: true, halts: true, spend: true, daily: true };

export const defaultTelegram = (): TelegramConfig => ({
  enabled: false, bot: null, secretStore: null, tiers: [...TIERS_ALL], allow: [], notify: { ...DEFAULT_NOTIFY },
  dailySummaryAt: '21:00', quietHours: null, approvals: 'off', approvalExpirySec: 90, repriceTolPct: 3, showAbsoluteBook: false,
});

export const connectorsPath = (home: string): string => join(home, 'connectors.json');

const isTier = (x: unknown): x is Tier => x === 'notify' || x === 'control' || x === 'approve';
const hhmm = (x: unknown): string | null => (typeof x === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(x) ? x : null);
const id = (x: unknown): string | null => (typeof x === 'string' && /^-?\d{1,20}$/.test(x) ? x : typeof x === 'number' && Number.isInteger(x) ? String(x) : null);

export type LoadResult = { ok: true; config: ConnectorsConfig; exists: boolean } | { ok: false; error: string };

/** Read connectors.json; a missing file is the defaults (disabled), a broken one is an error (the bot stays off). */
export function loadConnectors(home: string): LoadResult {
  const p = connectorsPath(home);
  if (!existsSync(p)) return { ok: true, config: { schema: CONNECTORS_SCHEMA, telegram: defaultTelegram() }, exists: false };
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(p, 'utf8')); } catch (e) { return { ok: false, error: `${p} is not JSON: ${(e as Error).message.slice(0, 120)}` }; }
  const d = raw as { schema?: unknown; telegram?: Record<string, unknown>; signals?: unknown };
  if (d.schema !== CONNECTORS_SCHEMA) return { ok: false, error: `${p}: schema is not ${CONNECTORS_SCHEMA}` };
  const t = d.telegram ?? {};
  const base = defaultTelegram();
  const allow: AllowEntry[] = [];
  for (const a of Array.isArray(t.allow) ? t.allow : []) {
    const x = a as Record<string, unknown>;
    const s = id(x.senderId); const c = id(x.chatId);
    if (!s || !c) continue;
    allow.push({ senderId: s, chatId: c, tiers: Array.isArray(x.tiers) ? (x.tiers as unknown[]).filter(isTier) : [], pairedAt: typeof x.pairedAt === 'number' ? x.pairedAt : 0 });
  }
  const n = (t.notify ?? {}) as Record<string, unknown>;
  const bool = (v: unknown, dflt: boolean) => (typeof v === 'boolean' ? v : dflt);
  const bot = t.bot && typeof t.bot === 'object' ? (t.bot as Record<string, unknown>) : null;
  const exp = Number(t.approvalExpirySec);
  const tol = Number(t.repriceTolPct);
  const qh = typeof t.quietHours === 'string' && /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/.test(t.quietHours) ? t.quietHours : null;
  const telegram: TelegramConfig = {
    enabled: t.enabled === true,
    bot: bot && id(bot.id) && typeof bot.username === 'string' ? { id: id(bot.id)!, username: String(bot.username).slice(0, 64) } : null,
    secretStore: t.secretStore === 'keychain' || t.secretStore === 'libsecret' || t.secretStore === 'file' ? t.secretStore : null,
    tiers: Array.isArray(t.tiers) ? (t.tiers as unknown[]).filter(isTier) : base.tiers,
    allow,
    notify: {
      candidates: n.candidates === 'each' || n.candidates === 'off' ? n.candidates : 'digest',
      entries: bool(n.entries, true), closes: bool(n.closes, true), halts: bool(n.halts, true), spend: bool(n.spend, true), daily: bool(n.daily, true),
    },
    dailySummaryAt: t.dailySummaryAt === null ? null : hhmm(t.dailySummaryAt) ?? base.dailySummaryAt,
    quietHours: qh,
    approvals: t.approvals === 'on' ? 'on' : 'off',
    // §8.4: 60 to 120 s, default 90.
    approvalExpirySec: Number.isFinite(exp) ? Math.min(120, Math.max(60, Math.round(exp))) : 90,
    repriceTolPct: Number.isFinite(tol) && tol > 0 ? Math.min(10, tol) : 3,
    showAbsoluteBook: t.showAbsoluteBook === true,
  };
  return { ok: true, config: { schema: CONNECTORS_SCHEMA, telegram, ...(d.signals !== undefined ? { signals: d.signals } : {}) }, exists: true };
}

export function saveConnectors(home: string, c: ConnectorsConfig): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeJsonAtomic(connectorsPath(home), c);
}

/** The allowlist entry for a sender in a chat, or null. A sender paired in one chat is not allowed in another. */
export function allowed(t: TelegramConfig, senderId: string, chatId: string, tier: Tier): AllowEntry | null {
  if (!t.tiers.includes(tier)) return null;
  return t.allow.find((a) => a.senderId === senderId && a.chatId === chatId && a.tiers.includes(tier)) ?? null;
}

/** True while local time is inside "HH:MM-HH:MM" (wrapping midnight). */
export function inQuietHours(q: string | null, t: number): boolean {
  if (!q) return false;
  const [a, b] = q.split('-').map((x) => { const [h, m] = x.split(':').map(Number); return h * 60 + m; });
  const d = new Date(t);
  const now = d.getHours() * 60 + d.getMinutes();
  return a <= b ? now >= a && now < b : now >= a || now < b;
}
