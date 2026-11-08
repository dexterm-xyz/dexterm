// dexterm — the Strategy Builder web UI's gatekeeper (task-2170). Pure functions + one small in-memory store, so every
// rule is unit-tested without a socket:
//   * loopback only: the remote must be 127.0.0.1 / ::1, the Host header must be exactly `127.0.0.1:<port>` (DNS-rebind
//     guard), a state change must carry Origin `http://127.0.0.1:<port>` and the session's CSRF token in a header;
//   * the URL the command prints carries a single-use TICKET (32 random bytes, 2 min) that buys ONE session: the server
//     answers it with an HttpOnly SameSite=Strict cookie and a redirect that drops the ticket from the address bar;
//   * ONE session at a time: exchanging a new ticket ends the previous session (its cookie stops working);
//   * every secret compare is constant-time; rate limits are sliding windows per action.
import { randomBytes, timingSafeEqual } from 'node:crypto';

export const WEB_TICKET_TTL_MS = 2 * 60_000;
export const WEB_SESSION_IDLE_MS = 12 * 3600_000;
export const WEB_COOKIE = 'dxw_session';
export const CSRF_HEADER = 'x-dexterm-csrf';
const LOOPBACK = new Set(['127.0.0.1', '::ffff:127.0.0.1', '::1']);

export function safeEq(a: string, b: string): boolean {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  // compare against itself on a length mismatch so the time does not depend on where the strings differ
  if (ba.length !== bb.length) { timingSafeEqual(ba, ba); return false; }
  return timingSafeEqual(ba, bb);
}

export const isLoopbackRemote = (addr: string | undefined): boolean => LOOPBACK.has(addr ?? '');
export const hostOk = (host: string | undefined, port: number): boolean => host === `127.0.0.1:${port}`;
export const originOk = (origin: string | undefined, port: number): boolean => origin === `http://127.0.0.1:${port}`;

/** The session cookie value from a Cookie header (only ours; anything malformed = none). */
export function cookieValue(header: string | undefined, name = WEB_COOKIE): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      const v = part.slice(i + 1).trim();
      return /^[A-Za-z0-9_-]{20,100}$/.test(v) ? v : null;
    }
  }
  return null;
}

export const sessionCookie = (value: string): string => `${WEB_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/`;
export const clearedCookie = (): string => `${WEB_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;

export interface WebSession { token: string; csrf: string; createdAt: number; lastAt: number; chatId: string }

/** Tickets and the one live session. */
export class WebAuth {
  private readonly tickets = new Map<string, number>(); // ticket -> expiry
  private session: WebSession | null = null;
  private readonly now: () => number;
  private readonly ttl: number;
  constructor(o: { now?: () => number; ticketTtlMs?: number } = {}) {
    this.now = o.now ?? Date.now;
    this.ttl = Math.max(1000, o.ticketTtlMs ?? WEB_TICKET_TTL_MS);
  }

  private sweep(): void { const t = this.now(); for (const [k, exp] of this.tickets) if (exp < t) this.tickets.delete(k); }

  issueTicket(): string {
    this.sweep();
    const ticket = randomBytes(32).toString('base64url');
    this.tickets.set(ticket, this.now() + this.ttl);
    return ticket;
  }

  /** Spend a ticket: a fresh session replaces any previous one. Null = unknown, expired or already used. */
  exchange(ticket: string): WebSession | null {
    this.sweep();
    const key = [...this.tickets.keys()].find((k) => safeEq(k, ticket));
    if (!key) return null;
    const exp = this.tickets.get(key)!;
    this.tickets.delete(key); // single use, even when it turns out expired
    if (exp < this.now()) return null;
    const t = this.now();
    this.session = { token: randomBytes(32).toString('base64url'), csrf: randomBytes(24).toString('base64url'), createdAt: t, lastAt: t, chatId: `web${randomBytes(9).toString('base64url')}` };
    return this.session;
  }

  /** The live session for a cookie value (constant-time), refreshed; null when it does not match or idled out. */
  check(token: string | null): WebSession | null {
    const s = this.session;
    if (!s || !token || !safeEq(token, s.token)) return null;
    if (this.now() - s.lastAt > WEB_SESSION_IDLE_MS) { this.session = null; return null; }
    s.lastAt = this.now();
    return s;
  }

  csrfOk(s: WebSession, header: string | string[] | undefined): boolean {
    return typeof header === 'string' && safeEq(header, s.csrf);
  }

  end(): void { this.session = null; }
  get pendingTickets(): number { this.sweep(); return this.tickets.size; }
}

/** Sliding-window limits per action key (chat turns, launches, backtests). */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly now: () => number;
  private readonly limits: Record<string, { max: number; windowMs: number }>;
  constructor(limits: Record<string, { max: number; windowMs: number }>, now: () => number = Date.now) { this.limits = limits; this.now = now; }
  /** True and counted when allowed; false (not counted) when over the limit. Unknown keys are refused. */
  take(key: string): boolean {
    const lim = this.limits[key];
    if (!lim) return false;
    const t = this.now();
    const xs = (this.hits.get(key) ?? []).filter((x) => t - x < lim.windowMs);
    if (xs.length >= lim.max) { this.hits.set(key, xs); return false; }
    xs.push(t);
    this.hits.set(key, xs);
    return true;
  }
}

export const WEB_RATE_LIMITS = {
  chat: { max: 6, windowMs: 60_000 },
  launch: { max: 3, windowMs: 60_000 },
  backtest: { max: 4, windowMs: 10 * 60_000 },
  change: { max: 20, windowMs: 60_000 },
} as const;
