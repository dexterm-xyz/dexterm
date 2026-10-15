// @dexterm/data — analyst UI-action channel (task-1313 part C).
//
// The analyst (a local `claude -p` run) can drive non-financial app navigation through a small,
// strictly-validated action set. The MCP server (the only thing claude can call) validates an action
// against the screen context it was given and, on success, appends one line to a local, token-
// authenticated channel file. The running TUI tails that file and RE-validates every action against
// its *current* state before applying it, then shows "analyst did X".
//
// Trust model: all token-derived text (symbols, names, descriptions) is untrusted. An injected
// instruction that convinces the model to call `open_token EVILMINT` cannot act, because a mint is
// only accepted when it is already in the caller-supplied allow-list (what is on screen / watched).
// Nothing here can sign, send, size, or confirm a trade: `open_ticket` only *opens* the PAPER ticket.
//
// This module is pure and zero-dependency so both the MCP server and the CLI import the same
// validator and the same channel format.

export const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Env var the MCP server reads for the channel file path; set by the CLI when it spawns claude. */
export const ACTION_FILE_ENV = 'DEXTERM_ACTION_FILE';
/** Env var carrying the per-run random token that authenticates channel lines. */
export const ACTION_TOKEN_ENV = 'DEXTERM_ACTION_TOKEN';

/** The five non-financial UI actions the analyst may request. */
export const ANALYST_ACTION_TYPES = ['open_token', 'show_in_screener', 'add_to_watchlist', 'switch_feed', 'open_ticket'] as const;
export type AnalystActionType = (typeof ANALYST_ACTION_TYPES)[number];

export type SortDir = 'asc' | 'desc';

export type AnalystAction =
  | { type: 'open_token'; mint: string }
  | { type: 'show_in_screener'; filter?: string; sort?: { key: string; dir: SortDir }; highlight?: string }
  | { type: 'add_to_watchlist'; mint: string }
  | { type: 'switch_feed'; feed: string }
  | { type: 'open_ticket'; mint: string; side: 'buy' | 'sell' };

/** What the caller currently permits: the only mints/feeds/sorts an action may reference. */
export interface ActionAllow {
  /** Mints already on screen / watched / selected — the only mints an action may point at. */
  mints: readonly string[];
  /** Feed ids `switch_feed` may select (the presets available right now). */
  feeds: readonly string[];
  /** Sort keys `show_in_screener` may use. */
  sortKeys: readonly string[];
  /**
   * Action types this session may request (task-1324). Absent = every type above (the task-1313
   * behaviour). AI scan mode passes `[]`: an observe-only session can request NO UI action at all —
   * above all never `open_ticket` — whatever the model emits.
   */
  types?: readonly AnalystActionType[];
}

export type ActionResult = { ok: true; action: AnalystAction; label: string } | { ok: false; error: string };

/** Max actions the consumer should apply per rolling window, and the window length. Advisory shared constants. */
export const ACTION_RATE = { max: 6, windowMs: 10_000 } as const;

const FILTER_MAX = 120;
// A conservative charset for a screener filter string; the consumer re-parses it with the real grammar.
// `!` is included so tag negation (`!flag:mint`, `!launchpad:pump`) — a documented part of the grammar —
// survives the boundary instead of being rejected as malformed (task-1313 part E).
const FILTER_SAFE_RE = /^[\w\s<>=:.%$,+!\-|()]*$/;

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/**
 * Validate one requested action against `allow`. Strict: unknown types/fields, out-of-allow-list
 * mints/feeds/sorts, and malformed values are all rejected. Pure — no I/O, no state.
 */
export function validateAnalystAction(raw: unknown, allow: ActionAllow): ActionResult {
  if (!isObj(raw)) return { ok: false, error: 'action must be an object' };
  const type = raw.type;
  if (typeof type !== 'string' || !(ANALYST_ACTION_TYPES as readonly string[]).includes(type)) {
    return { ok: false, error: `unknown action type ${JSON.stringify(type)}` };
  }
  if (allow.types && !allow.types.includes(type as AnalystActionType)) {
    return { ok: false, error: `${type}: not allowed in this session (allowed: ${allow.types.join(', ') || 'none — observe-only'})` };
  }
  const mintOk = (m: unknown): m is string => typeof m === 'string' && BASE58_RE.test(m) && allow.mints.includes(m);
  const short = (m: string): string => m.slice(0, 4) + '…' + m.slice(-4);

  switch (type) {
    case 'open_token': {
      if (!mintOk(raw.mint)) return { ok: false, error: 'open_token: mint not among the tokens currently on screen' };
      return { ok: true, action: { type, mint: raw.mint }, label: `opened ${short(raw.mint)}` };
    }
    case 'add_to_watchlist': {
      if (!mintOk(raw.mint)) return { ok: false, error: 'add_to_watchlist: mint not among the tokens currently on screen' };
      return { ok: true, action: { type, mint: raw.mint }, label: `watchlisted ${short(raw.mint)}` };
    }
    case 'open_ticket': {
      if (!mintOk(raw.mint)) return { ok: false, error: 'open_ticket: mint not among the tokens currently on screen' };
      if (raw.side !== 'buy' && raw.side !== 'sell') return { ok: false, error: 'open_ticket: side must be "buy" or "sell"' };
      return { ok: true, action: { type, mint: raw.mint, side: raw.side }, label: `opened a PAPER ${raw.side} ticket for ${short(raw.mint)}` };
    }
    case 'switch_feed': {
      if (typeof raw.feed !== 'string' || !allow.feeds.includes(raw.feed)) {
        return { ok: false, error: `switch_feed: feed must be one of ${allow.feeds.join(', ') || '(none)'}` };
      }
      return { ok: true, action: { type, feed: raw.feed }, label: `switched the screener to "${raw.feed}"` };
    }
    case 'show_in_screener': {
      const out: Extract<AnalystAction, { type: 'show_in_screener' }> = { type };
      const bits: string[] = [];
      if (raw.filter !== undefined && raw.filter !== null && raw.filter !== '') {
        if (typeof raw.filter !== 'string' || raw.filter.length > FILTER_MAX || !FILTER_SAFE_RE.test(raw.filter)) {
          return { ok: false, error: 'show_in_screener: filter is malformed or too long' };
        }
        out.filter = raw.filter.trim();
        bits.push(`filter ${out.filter}`);
      }
      if (raw.sort !== undefined && raw.sort !== null) {
        if (!isObj(raw.sort) || typeof raw.sort.key !== 'string' || !allow.sortKeys.includes(raw.sort.key)) {
          return { ok: false, error: `show_in_screener: sort.key must be one of ${allow.sortKeys.join(', ')}` };
        }
        const dir: SortDir = raw.sort.dir === 'asc' ? 'asc' : 'desc';
        out.sort = { key: raw.sort.key, dir };
        bits.push(`sort ${out.sort.key} ${dir}`);
      }
      if (raw.highlight !== undefined && raw.highlight !== null && raw.highlight !== '') {
        if (!mintOk(raw.highlight)) return { ok: false, error: 'show_in_screener: highlight mint not among the tokens currently on screen' };
        out.highlight = raw.highlight;
        bits.push(`highlight ${short(raw.highlight)}`);
      }
      if (!bits.length) return { ok: false, error: 'show_in_screener: nothing to do (give filter, sort, or highlight)' };
      return { ok: true, action: out, label: `showed the screener (${bits.join(', ')})` };
    }
    default:
      return { ok: false, error: `unknown action type ${type}` };
  }
}

/** One line on the channel: version + auth token + monotonic seq + the requested (unvalidated) action. */
export interface ActionLine { v: 1; token: string; seq: number; ts: number; action: Record<string, unknown> }

/** Serialize a channel line (newline-terminated). */
export function serializeActionLine(token: string, seq: number, action: Record<string, unknown>): string {
  const line: ActionLine = { v: 1, token, seq, ts: Date.now(), action };
  return JSON.stringify(line) + '\n';
}

/**
 * Parse and authenticate one channel line. Returns the (still unvalidated) requested action only when
 * the line is well-formed and its token matches `expectedToken`; otherwise null. Validation against an
 * allow-list is a separate step (`validateAnalystAction`) the consumer must still run.
 */
export function parseActionLine(line: string, expectedToken: string): { seq: number; action: Record<string, unknown> } | null {
  const s = line.trim();
  if (!s) return null;
  let msg: unknown;
  try { msg = JSON.parse(s); } catch { return null; }
  if (!isObj(msg) || msg.v !== 1) return null;
  if (typeof msg.token !== 'string' || msg.token !== expectedToken) return null;
  if (typeof msg.seq !== 'number' || !isObj(msg.action)) return null;
  return { seq: msg.seq, action: msg.action };
}
