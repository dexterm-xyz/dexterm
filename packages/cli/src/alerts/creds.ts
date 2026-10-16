// dexterm — alert-channel credentials (task-1398). Bot tokens and webhook URLs are NEVER in config.json
// (the config schema has no key-shaped fields, by rule). They live in ~/.dexterm/<channel>.json, mode 0600,
// outside every repo, read only by the adapters. Nothing here ever prints a secret; `redactCreds()` scrubs
// a token / webhook out of any string before it could reach a log, a toast, a test fixture or an error.
import { readFileSync, writeFileSync, mkdirSync, statSync, chmodSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export interface TelegramCreds { token: string; chatId: string }
export interface DiscordCreds { webhook: string }

export const telegramCredsPath = (home: string): string => join(home, 'telegram.json');
export const discordCredsPath = (home: string): string => join(home, 'discord.json');

function readJson(path: string): Record<string, unknown> | null {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch { return null; }
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch { return null; }
}

function writeJson(path: string, home: string, value: Record<string, unknown>): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  // rename is atomic; chmod again in case an old file had looser bits.
  try { chmodSync(tmp, 0o600); } catch { /* best effort */ }
  renameSync(tmp, path);
}

export function readTelegramCreds(home: string): TelegramCreds | null {
  const j = readJson(telegramCredsPath(home));
  if (!j) return null;
  const token = typeof j.token === 'string' ? j.token.trim() : '';
  const chatId = typeof j.chatId === 'string' ? j.chatId.trim() : (typeof j.chatId === 'number' ? String(j.chatId) : '');
  if (!token || !chatId) return null;
  return { token, chatId };
}

export function writeTelegramCreds(home: string, creds: TelegramCreds): void {
  if (!creds.token.trim()) throw new Error('telegram token is empty');
  if (!/^-?\d{1,19}$/.test(creds.chatId.trim())) throw new Error('telegram chatId must be a numeric id (e.g. 123456789 or -1001234567890)');
  writeJson(telegramCredsPath(home), home, { token: creds.token.trim(), chatId: creds.chatId.trim() });
}

export function readDiscordCreds(home: string): DiscordCreds | null {
  const j = readJson(discordCredsPath(home));
  if (!j) return null;
  const webhook = typeof j.webhook === 'string' ? j.webhook.trim() : '';
  if (!webhook) return null;
  return { webhook };
}

export function writeDiscordCreds(home: string, creds: DiscordCreds): void {
  const w = creds.webhook.trim();
  if (!/^https:\/\/(?:[a-z0-9.-]+\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/i.test(w)) {
    throw new Error('discord webhook must be a https://discord.com/api/webhooks/<id>/<token> URL');
  }
  writeJson(discordCredsPath(home), home, { webhook: w });
}

/** True when the file exists with 0600-ish perms; a looser mode is reported so the user can tighten it. */
export function credsMode(path: string): number | null {
  try { return statSync(path).mode & 0o777; } catch { return null; }
}

const TELEGRAM_TOKEN_RE = /\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g;
const DISCORD_WEBHOOK_RE = /https:\/\/(?:[a-z0-9.-]+\.)?discord(?:app)?\.com\/api\/webhooks\/\S+/gi;

/** Scrub any bot token / webhook URL out of a string before it could be logged or shown. Total; never throws. */
export function redactCreds(s: unknown): string {
  return String(s ?? '').replace(TELEGRAM_TOKEN_RE, 'bot[redacted]').replace(DISCORD_WEBHOOK_RE, '[redacted-webhook]');
}
