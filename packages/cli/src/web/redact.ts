// dexterm — what leaves the Strategy Builder web server (task-2170). Every JSON response and every streamed chat event
// passes `webRedact`: the spectator stream's rules (addresses head4…tail4, key-length base58/hex runs removed, sensitive
// field names blanked) plus the user's home directory and name turned into `~`, and nothing past a fixed depth (the
// spectator helper returns deep values untouched; here they are dropped instead).
import { homedir, userInfo } from 'node:os';
import { redactString, SENSITIVE_KEY_RE } from '@dexterm/agents';

const MAX_DEPTH = 24;
const MAX_STRING = 20_000;

let homeRe: RegExp | null | undefined;
function homeScrub(s: string): string {
  if (homeRe === undefined) {
    const parts: string[] = [];
    try { const h = homedir(); if (h && h.length > 3) parts.push(h); } catch { /* none */ }
    try { const u = userInfo().username; if (u && u.length >= 3) parts.push(`/Users/${u}`, `/home/${u}`, `C:\\Users\\${u}`); } catch { /* none */ }
    homeRe = parts.length ? new RegExp([...new Set(parts)].sort((a, b) => b.length - a.length).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g') : null;
  }
  return homeRe ? s.replace(homeRe, '~') : s;
}

export function webRedactString(s: string): string {
  return redactString(homeScrub(s.length > MAX_STRING ? s.slice(0, MAX_STRING) + '…' : s));
}

/** A redacted copy of any JSON value. */
export function webRedact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[deep]';
  if (typeof value === 'string') return webRedactString(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean' || value === null || value === undefined) return value ?? null;
  if (Array.isArray(value)) return value.slice(0, 2000).map((v) => webRedact(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[webRedactString(k)] = SENSITIVE_KEY_RE.test(k) && !SAFE_KEYS.has(k) ? '[redacted]' : webRedact(v, depth + 1);
    }
    return out;
  }
  return null;
}

/**
 * Field names the UI needs that the spectator's sensitive-name pattern would blank (it matches "sig" and "token").
 * Their VALUES are still scrubbed like any string; only the name is not treated as a secret. The CSRF token is never
 * in a JSON body (it is in the page), so it does not appear here.
 */
const SAFE_KEYS = new Set(['tokens', 'designs', 'insights', 'signals']);
