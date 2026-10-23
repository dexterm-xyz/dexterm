// dexterm autotrade chat — the token redactor (task-1527, AUTOTRADE-SPEC §8.3).
//
// A bot token is `<digits>:<35 url-safe chars>`, and the Bot API URL carries it (`/bot<token>/sendMessage`): the
// classic leak is an error message that quotes the URL. Every log line, audit line, ledger field, health string
// and thrown error from the chat layer passes through redact(). Tests throw a fetch error carrying the URL and
// look for the token in every sink.

// The colon may arrive as `:`, `%3A` (a URL inside a URL) or `:` (JSON-escaped).
const COLON = '(?::|%3[Aa]|\\\\u003[Aa])';
const URL_FORM = new RegExp(`bot\\d{3,}${COLON}[A-Za-z0-9_-]{20,}`, 'g');
const BARE_FORM = new RegExp(`\\b\\d{3,}${COLON}[A-Za-z0-9_-]{30,}`, 'g');

export const REDACTED = 'bot<redacted>';

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The text with every bot token (in a URL or bare) replaced. With the known token (always pass it when you have it)
 * also: the token URL-encoded, the secret half alone, the bot id followed by any part of the secret (a truncated
 * echo), and the first 12 characters of the secret anywhere.
 */
export function redact(text: unknown, known?: string | null): string {
  let s = typeof text === 'string' ? text : text instanceof Error ? `${text.name}: ${text.message}` : String(text);
  if (known && known.length >= 8) {
    for (const form of [known, encodeURIComponent(known)]) s = s.split(form).join('<redacted>');
    const i = known.indexOf(':');
    const id = i > 0 ? known.slice(0, i) : '';
    const half = i > 0 ? known.slice(i + 1) : '';
    if (half.length >= 16) {
      s = s.split(half).join('<redacted>');
      if (/^\d+$/.test(id)) s = s.replace(new RegExp(`${id}${COLON}[A-Za-z0-9_-]+`, 'g'), '<redacted>');
      s = s.replace(new RegExp(`${escapeRe(half.slice(0, 12))}[A-Za-z0-9_-]*`, 'g'), '<redacted>');
    }
  }
  return s.replace(URL_FORM, REDACTED).replace(BARE_FORM, '<redacted>');
}

/** True when the string looks like a bot token (the setup prompt's check). */
export const looksLikeBotToken = (s: string): boolean => /^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(s.trim());

/** An Error whose message (and cause chain) has been redacted; the original is dropped, never attached. */
export function redactedError(e: unknown, known?: string | null): Error {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let i = 0; cur && i < 3; i++) {
    parts.push(redact(cur instanceof Error ? cur.message : cur, known));
    cur = cur instanceof Error ? (cur as Error & { cause?: unknown }).cause : null;
  }
  const out = new Error(parts.join(' <- ').slice(0, 300));
  out.name = 'ChatTransportError';
  return out;
}
