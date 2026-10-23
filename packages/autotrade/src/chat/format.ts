// dexterm autotrade chat — inert text and the message templates' small helpers (task-1527, AUTOTRADE-SPEC §8.6).
//
// Every token-derived string (symbol, name, the agent's reason, which quotes token text) goes through the app's
// prompt firewall (`@dexterm/mcp firewall()`: control and bidi characters stripped, whitespace collapsed, links
// and addresses replaced, length capped), then the chat rules: sent as plain text (no parse_mode, so no markup or
// link can be injected), quoted, and with the characters Telegram turns into tappable things in plain text
// (`/command`, `@mention`) swapped for look-alikes, so a token named "/kill" or "@phish" is only ever text.
// Buttons never carry token text: their labels and data are built from engine state only (approvals.ts).

import { firewall } from '@dexterm/mcp';
import { redact } from './redact.ts';

const UNESCAPE: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"' };

/**
 * What chat never shows (§8.6 "Hidden"), replaced before the firewall: a keypair as a JSON byte array, 0x-hex and
 * long bare hex, API-key-shaped strings (vendor prefixes, `api_key=…`, UUIDs), and file paths (absolute, `~/`,
 * `./`, Windows). Engine strings (an exit detail, a halt reason, a guard effect) can quote any of these.
 */
const HIDDEN: readonly [RegExp, string][] = [
  [/\[\s*\d{1,3}(?:\s*,\s*\d{1,3}){15,}\s*\]/g, '[key]'],
  [/\b0x[0-9a-fA-F]{8,}\b/g, '[hex]'],
  [/\b[0-9a-fA-F]{32,}\b/g, '[hex]'],
  [/\b(?:sk|pk|rk)[-_](?:[A-Za-z0-9]+[-_])*[A-Za-z0-9]{12,}/g, '[key]'],
  [/\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,})\b/g, '[key]'],
  [/\b(api[-_]?key|access[-_]?token|auth[-_]?token|secret[-_]?key|client[-_]?secret|private[-_]?key|password|passwd)(\s*[=:]\s*)[^\s'",;&]+/gi, '$1$2[key]'],
  [/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g, '[key]'],
  // Paths: home- or dot-relative, under a filesystem root, any absolute one ending in a file name, or Windows. A JSON
  // pointer (`/bankroll/startUsd`, a /strategies reason) and a slash command stay text.
  [/(^|[\s'"(=:,[])(?:~|\.{1,2})\/[^\s'"()]*/g, '$1[path]'],
  [/(^|[\s'"(=:,[])\/(?:Users|home|root|var|tmp|private|etc|opt|usr|mnt|media|Volumes|Library|System|Applications|srv|run|dev|proc)\/[^\s'"()]*/g, '$1[path]'],
  [/(^|[\s'"(=:,[])\/(?:[^\s/'"()]+\/)+[^\s/'"()]*\.[A-Za-z0-9]{1,8}\b/g, '$1[path]'],
  [/(^|[\s'"(=:,[])[A-Za-z]:\\[^\s'"()]*/g, '$1[path]'],
];

/** Secrets, keys and paths taken out of an engine or token string (inert() applies it first). */
export function hideSecrets(s: string): string {
  let out = redact(s);
  for (const [re, to] of HIDDEN) out = out.replace(re, to);
  return out;
}

/** Token-derived text made inert for a chat message: secrets and paths hidden, firewalled, capped, no tappable command or mention. */
export function inert(text: unknown, max = 32, source = 'token'): string {
  const fw = firewall(text === null || text === undefined ? '' : hideSecrets(String(text)), source, 'description');
  if (!fw) return '';
  const m = fw.match(/^<untrusted [^>]*>([\s\S]*)<\/untrusted>$/);
  let s = (m ? m[1] : fw).replace(/&(amp|lt|gt|quot);/g, (x) => UNESCAPE[x] ?? x);
  s = s.replace(/\//g, '∕').replace(/@/g, '＠').replace(/"/g, "'");
  if (s.length > max) s = `${s.slice(0, Math.max(1, max - 1))}…`;
  return s;
}

/** `abcd…wxyz`: the most of an address a message ever shows. */
export const shortMint = (m: string): string => (m.length > 10 ? `${m.slice(0, 4)}…${m.slice(-4)}` : m);

export const pct = (v: number | null | undefined, digits = 1): string => (v === null || v === undefined || !Number.isFinite(v) ? '?' : `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`);

export function price(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v) || v <= 0) return '?';
  return v >= 1 ? v.toFixed(4) : v.toPrecision(4);
}

export function usdShort(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '?';
  const a = Math.abs(v);
  return a >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : a >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : `$${v.toFixed(2)}`;
}

/** Plain text of a message for the fake transport and the audit (lines joined, badge first). */
export function plain(badge: string | null, lines: string[]): string {
  return [badge ? `${badge} · ${lines[0] ?? ''}` : lines[0] ?? '', ...lines.slice(1)].join('\n');
}

/** Telegram's limit is 4096 characters; stay well under it. */
export const MAX_MESSAGE = 3500;
export const clip = (s: string, max = MAX_MESSAGE): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
