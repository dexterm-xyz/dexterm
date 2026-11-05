// dexterm autotrade chat — the read-only data commands /check, /top and /signals (task-1426).
//
// Three commands that only READ, for the paired account in its private chat (the hub's allowlist, chat binding and
// rate limit apply as for /status):
//   /check <CA>    one coin: the LARP score (the `larp_check` tool's 0-100 sum of named flags) and the key risk facts
//                  (authorities, holder concentration, LP lock, liquidity), each with the age of its data
//   /top [N]       the first N (default 5, 1..10) of the screener's trending list, marking the runner's own coins
//   /signals [N]   the last N (default 5, 1..20) signals the runner raised: screen matches, safety refusals, the drain
//                  guard, stuck bags, guards, halts and fills
// Every answer says "data, not advice". No write path: the router is built from a ReadOnlyPort only (it never sees
// the ControlPort or the approval broker, and it returns lines, never a confirm button), and the host's port can
// call only the read tools in READ_TOOLS. Token text (symbol, name) is untrusted: inert() makes it plain text with no
// tappable command, mention or link; a CA is shown only after it validated as base58, and only shortened.

import type { LedgerEvent } from '../ledger.ts';
import type { RunnerState } from '../runner.ts';
import type { InboundCommand } from './connector.ts';
import { hostname, userInfo } from 'node:os';
import { hideSecrets, inert, pct, shortMint, usdShort } from './format.ts';

/** The read-only commands (also in the connector's closed list). */
export const READ_COMMANDS = ['check', 'top', 'signals'] as const;
export type ReadCommand = (typeof READ_COMMANDS)[number];

/** The only data tools the host's port may call (the MCP tool layer's read tools). */
export const READ_TOOLS = ['get_token', 'larp_check', 'screener_query'] as const;
export type ReadTool = (typeof READ_TOOLS)[number];
export type ReadCall = (tool: ReadTool, args: Record<string, unknown>) => Promise<Record<string, unknown>>;

export const TOP_DEFAULT = 5;
export const TOP_MAX = 10;
export const SIGNALS_DEFAULT = 5;
export const SIGNALS_MAX = 20;
/** Signals the bot keeps in memory (newest last). */
export const SIGNAL_LOG_KEEP = 200;

/** A Solana mint: base58 (no 0, O, I, l), 32 to 44 characters. */
export const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** task-2146: one answer stays short (Telegram's own cap is 4096; the transport clips at 3500 as a last fence). */
export const READ_REPLY_MAX_CHARS = 1800;
export const READ_REPLY_MAX_LINES = 26;
/** task-2146: an answer that takes longer than this says so instead of hanging (the per-call limits are shorter). */
export const READ_TIMEOUT_MS = 45_000;
/** task-2146: answers that call the data sources, per chat per minute (the hub's 10 a minute per sender also applies). */
export const READS_PER_MIN = 5;

export const NOT_ADVICE = 'data, not advice';
export const USAGE_CHECK = "Usage: /check <CA> (the coin's mint address: 32 to 44 base58 characters). Read-only; data, not advice.";
export const USAGE_TOP = `Usage: /top [N] (N from 1 to ${TOP_MAX}, default ${TOP_DEFAULT}). Read-only; data, not advice.`;
export const USAGE_SIGNALS = `Usage: /signals [N] (N from 1 to ${SIGNALS_MAX}, default ${SIGNALS_DEFAULT}). Read-only; data, not advice.`;

/** `failed`: the read threw or timed out (the hub audits it); otherwise the data is simply not there. */
export type Unavailable = { unavailable: string; failed?: true };
/** One answer: lines only. `limited`: over READS_PER_MIN, nothing read. `failed`: a read failed (its cleaned text). */
export interface ReadAnswer { lines: string[]; limited?: true; failed?: string }
export type EngineMark = 'held' | 'candidate' | null;

export interface CoinCheckView {
  mint: string;
  /** When the answer was assembled (local clock). */
  at: number;
  /** Raw token text from the sources: UNTRUSTED (the router makes it inert). */
  symbol: string | null;
  name: string | null;
  larp: { score: number; band: string; hi: number | null; unread: number; flags: { label: string; points: number }[] } | null;
  larpError: string | null;
  market: { mcap: number | null; liq: number | null; holders: number | null; tokenAgeSec: number | null; fetchedAt: number | null } | null;
  audit: { mintAuth: boolean | null; freezeAuth: boolean | null; top10Pct: number | null; devPct: number | null; lpLockedPct: number | null; rugScore: number | null; fetchedAt: number | null } | null;
  dataError: string | null;
  engine: EngineMark;
}

export interface TopRowView { mint: string; /** UNTRUSTED */ symbol: string | null; mcap: number | null; liq: number | null; volH1: number | null; chgH1: number | null; tokenAgeSec: number | null; fetchedAt: number | null; engine: EngineMark }
export interface TopView { source: string; at: number; rows: TopRowView[] }

export type SignalLevel = 'info' | 'warn' | 'alert';
/** One signal; `text` is an engine line that can quote token text (made inert when shown). */
export interface SignalView { at: number; level: SignalLevel; title: string; text: string; mint: string | null; /** UNTRUSTED */ symbol: string | null; strategy: string | null }
export interface SignalsView { at: number; total: number; rows: SignalView[] }

/** What the read-only commands may ask the host. Nothing here writes. */
export interface ReadOnlyPort {
  check(mint: string): Promise<CoinCheckView | Unavailable>;
  top(n: number): Promise<TopView | Unavailable>;
  signals(n: number): SignalsView | Unavailable;
}

const isUnavailable = (v: unknown): v is Unavailable => !!v && typeof v === 'object' && typeof (v as Unavailable).unavailable === 'string';

/** "45s", "12m", "3h", "2d". */
export function ageShort(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '?';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 48 * 3600) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

const old = (at: number | null, now: number): string => (at === null ? 'age unknown' : `${ageShort(now - at)} old`);

/** `[]` → def, `['7']` → 7 clamped to 1..max, anything else → null (the usage line). */
export function parseCount(args: readonly string[], def: number, max: number): number | null {
  if (args.length === 0) return def;
  if (args.length > 1 || !/^\d{1,4}$/.test(args[0])) return null;
  return Math.min(max, Math.max(1, Number(args[0])));
}

const yesNo = (v: boolean | null, on: string, off: string): string => (v === null ? `${off.split(' ')[0]} authority unknown` : v ? on : off);
const pctPlain = (v: number | null): string => (v === null || !Number.isFinite(v) ? '?' : `${v.toFixed(1)}%`);

// ───────────────────────────── outgoing text (task-2146) ─────────────────────────────

/**
 * Characters that render as nothing (or flip text direction) and that the prompt firewall does not strip: soft hyphen,
 * combining grapheme joiner, Arabic letter mark, Hangul fillers, Mongolian separators, word joiners and invisible
 * operators, the deprecated format characters, interlinear annotation marks and the tag block.
 */
const INVISIBLE = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u2060-\u2064\u206A-\u206F\u3164\uFFA0\uFFF9-\uFFFB]|[\u{E0000}-\u{E007F}]/gu;
/** Half of a surrogate pair (a cut emoji): Telegram refuses the whole message when one is in it. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * On top of inert(): what Telegram still turns into a tappable thing in a plain-text message. A bare domain
 * ("claim-now.xyz", "t.me") gets a one-dot leader instead of its dot, a #hashtag and a $CASHTAG get look-alikes.
 */
export function defuse(s: string): string {
  return s
    .replace(INVISIBLE, '')
    .replace(/([\p{L}\p{N}_-])\.(?=\p{L})/gu, '$1\u2024')
    .replace(/#/g, '\uFF03')
    .replace(/\$(?=\p{L})/gu, '\uFF04')
    .replace(LONE_SURROGATE, '');
}

/** Token or engine text for a read-only answer: inert() (secrets, paths, the prompt firewall, the cap) then defuse(). */
export const tx = (text: unknown, max = 32, source = 'token'): string => defuse(inert(text, max, source));

/** This computer's names (host, short host, login), which a read-only answer never shows. */
export function localNames(): string[] {
  const out: string[] = [];
  try { const h = hostname(); out.push(h, h.split('.')[0]); } catch { /* no host name */ }
  try { out.push(userInfo().username); } catch { /* no user */ }
  return [...new Set(out.filter((x) => typeof x === 'string' && x.length >= 4 && !/^(localhost|root|user)$/i.test(x)))];
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Cut at a code point, never inside a surrogate pair. */
function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = Math.max(1, max - 1);
  if (/[\uD800-\uDBFF]/.test(s[end - 1] ?? '')) end--;
  return `${s.slice(0, end)}…`;
}

/**
 * The last fence on every read-only answer: secrets and paths hidden again (an error text from a source can carry
 * either), this computer's names replaced, invisible characters and cut surrogates dropped, and the answer capped
 * in lines and characters (a "(cut)" line says so).
 */
export function finalizeReply(lines: string[], names: readonly string[]): string[] {
  const nameRes = names.map((n) => new RegExp(escapeRe(n), 'gi'));
  const clean = lines.map((l) => {
    let s = hideSecrets(String(l)).replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url]');
    for (const re of nameRes) s = s.replace(re, '[host]');
    return cut(defuse(s), 400);
  });
  const out: string[] = [];
  let used = 0;
  for (const l of clean) {
    if (out.length >= READ_REPLY_MAX_LINES - 1 || used + l.length + 1 > READ_REPLY_MAX_CHARS - 40) { out.push('(cut: the answer was too long for one message)'); break; }
    out.push(l);
    used += l.length + 1;
  }
  return out;
}

export interface ReadOnlyRouterOpts {
  /** Names to keep out of every answer (default: this computer's host and login names). */
  hideNames?: readonly string[];
  /** The whole answer's time limit (default READ_TIMEOUT_MS). */
  timeoutMs?: number;
}

export class ReadOnlyRouter {
  private readonly port: ReadOnlyPort;
  private readonly now: () => number;
  private readonly names: readonly string[];
  private readonly timeoutMs: number;
  /** Chats with a /check in flight (one at a time per chat). */
  private readonly checking = new Set<string>();
  private readonly readTimes = new Map<string, number[]>();
  private readonly limitTold = new Map<string, number>();
  constructor(port: ReadOnlyPort, now: () => number = Date.now, opts: ReadOnlyRouterOpts = {}) {
    this.port = port; this.now = now;
    this.names = opts.hideNames ?? localNames();
    this.timeoutMs = opts.timeoutMs ?? READ_TIMEOUT_MS;
  }

  /**
   * Lines only: a read-only command never produces a button or a confirm. Every answer goes through finalizeReply.
   * `limited`: the chat was over READS_PER_MIN (no data was read; `lines` is the once-a-minute notice, or empty).
   */
  async handle(c: InboundCommand): Promise<ReadAnswer> {
    const r = await this.route(c);
    const lines = finalizeReply(r.lines, this.names);
    return { ...r, lines, ...(r.failed ? { failed: lines[0] ?? '' } : {}) };
  }

  /** Count one data read for the chat; the answer when the chat is over its limit (null = go ahead). */
  private overLimit(chatId: string): { lines: string[]; limited: true } | null {
    const now = this.now();
    const ts = (this.readTimes.get(chatId) ?? []).filter((t) => now - t < 60_000);
    if (ts.length < READS_PER_MIN) { ts.push(now); this.readTimes.set(chatId, ts); return null; }
    this.readTimes.set(chatId, ts);
    if (now - (this.limitTold.get(chatId) ?? -Infinity) < 60_000) return { lines: [], limited: true };
    this.limitTold.set(chatId, now);
    return { lines: [`Too many data requests: up to ${READS_PER_MIN} a minute in this chat. /kill and /pause always work.`], limited: true };
  }

  private route(c: InboundCommand): Promise<ReadAnswer> {
    switch (c.command) {
      case 'check': return this.check(c);
      case 'top': return this.top(c);
      case 'signals': return this.signals(c);
      default: return Promise.resolve({ lines: [USAGE_CHECK] });
    }
  }

  /** A port answer within the router's limit; a late or failed one becomes an Unavailable that says what was not read. */
  private async ask<T>(what: string, p: () => Promise<T> | T): Promise<T | Unavailable> {
    try { return await within(Promise.resolve().then(p), this.timeoutMs, what); } catch (e) {
      return { unavailable: `Could not read ${what} right now (${errOf(e)}). Nothing was guessed; try again in a minute.`, failed: true };
    }
  }

  private async check(c: InboundCommand): Promise<ReadAnswer> {
    // The CA is never echoed unless it validated; an invalid one gets the usage line only.
    if (c.args.length !== 1 || !MINT_RE.test(c.args[0])) return { lines: [USAGE_CHECK] };
    const mint = c.args[0];
    if (this.checking.has(c.chatId)) return { lines: ['A /check is still running: wait for its answer.'] };
    const lim = this.overLimit(c.chatId);
    if (lim) return lim;
    this.checking.add(c.chatId);
    let v: CoinCheckView | Unavailable;
    try { v = await this.ask('this coin', () => this.port.check(mint)); } finally { this.checking.delete(c.chatId); }
    if (isUnavailable(v)) return { lines: [v.unavailable], ...(v.failed ? { failed: v.unavailable } : {}) };
    const now = this.now();
    const sym = v.symbol ? `"${tx(v.symbol, 20)}" ` : '';
    const name = v.name ? ` · "${tx(v.name, 32)}"` : '';
    const lines = [`CHECK ${sym}${shortMint(v.mint)}${name} · ${NOT_ADVICE}`];
    if (v.larp) {
      const range = v.larp.hi !== null && v.larp.hi > v.larp.score ? ` · up to ${v.larp.hi} with ${v.larp.unread} check${v.larp.unread === 1 ? '' : 's'} unread` : '';
      lines.push(`LARP score ${v.larp.score}/100 (${tx(v.larp.band, 12, 'engine')})${range} · checked ${ageShort(now - v.at)} ago`);
      for (const f of v.larp.flags.slice(0, 3)) lines.push(`  · ${tx(f.label, 70, 'engine')} (+${f.points})`);
    } else lines.push(`LARP score: could not be read${v.larpError ? ` (${tx(v.larpError, 80, 'engine')})` : ''}`);
    if (v.audit) {
      const a = v.audit;
      lines.push(`risk: ${yesNo(a.mintAuth, 'mint authority ON', 'mint authority revoked')} · ${yesNo(a.freezeAuth, 'freeze authority ON', 'freeze authority revoked')} · top-10 holders ${pctPlain(a.top10Pct)} · dev ${pctPlain(a.devPct)} · LP locked ${pctPlain(a.lpLockedPct)}${a.rugScore !== null ? ` · rug score ${Math.round(a.rugScore)}` : ''} (${old(a.fetchedAt, now)})`);
    } else lines.push(v.dataError ? `risk: could not be read (${tx(v.dataError, 80, 'engine')})` : 'risk: the sources reported no holder/authority data for this coin');
    if (v.market) {
      const m = v.market;
      lines.push(`market: mcap ${usdShort(m.mcap)} · liquidity ${usdShort(m.liq)}${m.holders !== null ? ` · ${m.holders} holders` : ''}${m.tokenAgeSec !== null ? ` · coin age ${ageShort(m.tokenAgeSec * 1000)}` : ''} (${old(m.fetchedAt, now)})`);
    } else lines.push(`market: could not be read${v.dataError ? ` (${tx(v.dataError, 80, 'engine')})` : ''}`);
    if (v.engine) lines.push(v.engine === 'held' ? 'the runner holds this coin now (/positions)' : 'a candidate of the runner now');
    lines.push('The LARP score is evidence, not a verdict, and not a safety check. Data, not advice.');
    return { lines };
  }

  private async top(c: InboundCommand): Promise<ReadAnswer> {
    const n = parseCount(c.args, TOP_DEFAULT, TOP_MAX);
    if (n === null) return { lines: [USAGE_TOP] };
    const lim = this.overLimit(c.chatId);
    if (lim) return lim;
    const v = await this.ask('the ranking', () => this.port.top(n));
    if (isUnavailable(v)) return { lines: [v.unavailable], ...(v.failed ? { failed: v.unavailable } : {}) };
    if (!v.rows.length) return { lines: [`Nothing ranked right now (${tx(v.source, 80, 'engine')}).`] };
    const now = this.now();
    const ages = v.rows.map((r) => r.fetchedAt).filter((x): x is number => x !== null);
    const oldest = ages.length ? Math.min(...ages) : null;
    const rows = v.rows.slice(0, n);
    return {
      lines: [
        `TOP ${rows.length} · ${tx(v.source, 80, 'engine')} (${old(oldest, now)}) · ${NOT_ADVICE}`,
        ...rows.map((r, i) => `${i + 1}. ${r.symbol ? `"${tx(r.symbol, 16)}" ` : ''}${shortMint(r.mint)} · mcap ${usdShort(r.mcap)} · liq ${usdShort(r.liq)}${r.volH1 !== null ? ` · 1h vol ${usdShort(r.volH1)}` : ''}${r.chgH1 !== null ? ` · 1h ${pct(r.chgH1)}` : ''}${r.tokenAgeSec !== null ? ` · age ${ageShort(r.tokenAgeSec * 1000)}` : ''}${r.engine === 'held' ? ' · HELD' : r.engine === 'candidate' ? ' · candidate' : ''}`),
        '/check <CA> for one coin.',
      ],
    };
  }

  private async signals(c: InboundCommand): Promise<ReadAnswer> {
    const n = parseCount(c.args, SIGNALS_DEFAULT, SIGNALS_MAX);
    if (n === null) return { lines: [USAGE_SIGNALS] };
    const lim = this.overLimit(c.chatId);
    if (lim) return lim;
    const v = await this.ask('the signals', () => this.port.signals(n));
    if (isUnavailable(v)) return { lines: [v.unavailable], ...(v.failed ? { failed: v.unavailable } : {}) };
    if (!v.rows.length) return { lines: ['No signals yet: nothing matched the screen or tripped a check since the bot came on.'] };
    const now = this.now();
    const rows = v.rows.slice(0, n);
    return {
      lines: [
        `SIGNALS · last ${rows.length} of ${v.total} · newest first · ${NOT_ADVICE}`,
        ...rows.map((s) => `${ageShort(now - s.at)} ago · ${tx(s.title, 14, 'engine')}${s.strategy ? ` · ${tx(s.strategy, 24, 'engine')}` : ''} · ${s.symbol ? `"${tx(s.symbol, 16)}" ` : ''}${s.mint && MINT_RE.test(s.mint) ? `${shortMint(s.mint)} ` : ''}${tx(s.text, 120, 'engine')}`),
      ],
    };
  }
}

// ───────────────────────────── the host side ─────────────────────────────

/** Narrow a tool layer (the MCP tools a run already has) to the read tools; any other name throws. */
export function readOnlyCall(tools: { call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> }): ReadCall {
  return (tool, args) => {
    if (!(READ_TOOLS as readonly string[]).includes(tool)) return Promise.reject(new Error(`not a read tool: ${String(tool).slice(0, 32)}`));
    return tools.call(tool, args);
  };
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** The tool layer wraps token text as `<untrusted …>text</untrusted>` (escaped): back to the raw (still untrusted) text. */
export function untrustedText(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const m = s.match(/^<untrusted [^>]*>([\s\S]*)<\/untrusted>$/);
  if (!m) return s;
  return m[1].replace(/&(amp|lt|gt|quot);/g, (x) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"' })[x] ?? x);
}

async function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  // A plain (ref'd) timer, cleared in finally: a check that never answers still settles.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`${what}: no answer in ${Math.round(ms / 1000)} s`)), ms); })]);
  } finally { clearTimeout(timer); }
}

/** An error as chat may show it: secrets and paths hidden, links and addresses replaced, capped (task-2146). */
const errOf = (e: unknown): string => tx(e instanceof Error ? e.message : String(e), 120, 'engine');

/** The signals the runner raised, from its ledger as it is written (the bot's own copy, in memory). */
export class SignalLog {
  private readonly rows: SignalView[] = [];
  private readonly symbols = new Map<string, string>();
  private seen = 0;
  private readonly keep: number;
  constructor(keep = SIGNAL_LOG_KEEP) { this.keep = keep; }

  get total(): number { return this.seen; }

  push(s: SignalView): void {
    this.rows.push(s);
    this.seen++;
    if (this.rows.length > this.keep) this.rows.splice(0, this.rows.length - this.keep);
  }

  /** Newest first. */
  recent(n: number): SignalView[] { return this.rows.slice(-Math.max(0, n)).reverse(); }

  /** One run ledger event → a signal when it is one (screen match, safety refusal, drain, stuck, guard, halt, fill). */
  onLedger(e: LedgerEvent): void {
    const mint = str(e.mint);
    const sym = str(e.symbol);
    if (mint && sym) this.symbols.set(mint, sym);
    if (this.symbols.size > 2000) { const f = this.symbols.keys().next().value; if (f !== undefined) this.symbols.delete(f); }
    const symbol = sym ?? (mint ? this.symbols.get(mint) ?? null : null);
    const strategy = str(e.strategyId);
    const s = (level: SignalLevel, title: string, text: string) => this.push({ at: e.t, level, title, text, mint, symbol, strategy });
    const detail = (k: string) => { const v = e[k]; return v === undefined || v === null ? '' : String(v); };
    switch (e.kind) {
      case 'candidate': { const m = Array.isArray(e.matched) ? (e.matched as unknown[]).map(String).join(', ') : ''; s('info', 'SCREEN', `matched the screen${m ? `: ${m}` : ''}`); break; }
      case 'refused': if (e.stage === 'vet') s('warn', 'SAFETY', `refused by ${detail('rule')}${detail('detail') ? `: ${detail('detail')}` : ''}`); break;
      case 'drain_guard': s('alert', 'DRAIN', `${detail('reason')}${detail('detail') ? `: ${detail('detail')}` : ''}`); break;
      case 'stuck': s('warn', 'STUCK', `cannot sell${detail('why') ? ` (${detail('why')})` : ''}`); break;
      case 'written_off': s('warn', 'WRITTEN OFF', detail('why') || 'closed at realizable value'); break;
      case 'guard': s('warn', 'GUARD', `${detail('state')}${detail('effect') ? `: ${detail('effect')}` : ''}`); break;
      case 'halt': s('alert', 'HALT', detail('reason') || 'halted'); break;
      case 'fill': {
        const side = detail('side');
        const usd = num(e.usd);
        s('info', side === 'sell' ? 'SELL' : 'BUY', `${side || 'fill'}${usd !== null ? ` ${usdShort(usd)}` : ''}${detail('reason') ? ` · ${detail('reason')}` : ''} (paper book)`);
        break;
      }
      default: break;
    }
  }
}

export interface HostReadDeps {
  /** The run's read tools (a run on live data), or null: a replay, the stub, offline, no run. */
  call: () => ReadCall | null;
  state: () => RunnerState | null;
  signals: SignalLog;
  now?: () => number;
  /** Per-call time limits (ms). */
  timeoutMs?: { token?: number; larp?: number; top?: number };
}

const NO_LIVE_DATA = 'No live data here: the bot is not attached to a run on live data (no run, a replay, the stub, or offline). Start one with `dexterm autotrade run <id> --paper`.';

/** The ReadOnlyPort of a runner host: the run's read tools and its state, nothing else. */
export class HostReadPort implements ReadOnlyPort {
  private readonly d: HostReadDeps;
  private readonly now: () => number;
  constructor(d: HostReadDeps) { this.d = d; this.now = d.now ?? Date.now; }

  private mark(mint: string): EngineMark {
    const st = this.d.state();
    if (!st) return null;
    if (st.positions.some((p) => p.mint === mint)) return 'held';
    if (st.candidates.some((c) => c.mint === mint)) return 'candidate';
    return null;
  }

  async check(mint: string): Promise<CoinCheckView | Unavailable> {
    if (!MINT_RE.test(mint)) return { unavailable: USAGE_CHECK };
    const call = this.d.call();
    if (!call) return { unavailable: NO_LIVE_DATA };
    const t = this.d.timeoutMs ?? {};
    const [tok, larp] = await Promise.all([
      within(call('get_token', { mint }), t.token ?? 15_000, 'token data').catch((e: unknown): Record<string, unknown> => ({ error: errOf(e) })),
      within(call('larp_check', { mint }), t.larp ?? 25_000, 'LARP check').catch((e: unknown): Record<string, unknown> => ({ error: errOf(e) })),
    ]);
    const at = this.now();
    const tk = rec(tok.token);
    const pair = rec(tok.pair);
    const stats = rec(tok.stats);
    const audit = rec(tok.audit);
    const ls = rec(larp.larp_score);
    const score = num(larp.score);
    const flagsSrc = Array.isArray(ls?.top) && (ls!.top as unknown[]).length ? (ls!.top as unknown[]) : Array.isArray(ls?.flags) ? (ls!.flags as unknown[]) : [];
    const flags = flagsSrc.map(rec).filter((x): x is Record<string, unknown> => !!x && typeof x.label === 'string' && num(x.points) !== null).map((x) => ({ label: String(x.label), points: num(x.points)! })).sort((a, b) => b.points - a.points);
    const range = rec(ls?.range);
    const created = num(tk?.createdAt) ?? num(pair?.createdAt);
    const mcapRes = rec(pair?.mcapResolved);
    return {
      mint, at,
      symbol: untrustedText(tk?.symbol), name: untrustedText(tk?.name),
      larp: score === null ? null : { score, band: str(larp.band) ?? '?', hi: num(range?.hi), unread: Array.isArray(ls?.missing) ? (ls!.missing as unknown[]).length : 0, flags },
      larpError: score === null ? str(larp.error) ?? 'no score came back' : null,
      market: pair ? { mcap: num(mcapRes?.value) ?? num(pair.mcap), liq: num(pair.liquidityUsd), holders: num(stats?.holderCount), tokenAgeSec: created !== null ? Math.max(0, Math.round((at - created) / 1000)) : null, fetchedAt: num(pair.fetchedAt) } : null,
      audit: audit ? { mintAuth: bool(audit.mintAuthority), freezeAuth: bool(audit.freezeAuthority), top10Pct: num(audit.top10Pct), devPct: num(audit.devPct), lpLockedPct: num(audit.lpLockedPct), rugScore: num(audit.rugScore), fetchedAt: num(audit.fetchedAt) } : null,
      dataError: pair ? null : str(tok.error) ?? 'the sources did not answer',
      engine: this.mark(mint),
    };
  }

  async top(n: number): Promise<TopView | Unavailable> {
    const k = Math.min(TOP_MAX, Math.max(1, Math.floor(n) || TOP_DEFAULT));
    const call = this.d.call();
    let why = '';
    if (call) {
      try {
        const r = await within(call('screener_query', { preset: 'trending', limit: k }), this.d.timeoutMs?.top ?? 20_000, 'screener');
        const rows = Array.isArray(r.rows) ? (r.rows as unknown[]).map(rec).filter((x): x is Record<string, unknown> => !!x && typeof x.mint === 'string' && MINT_RE.test(x.mint as string)) : [];
        if (rows.length) {
          return {
            source: "the screener's trending list", at: this.now(),
            rows: rows.slice(0, k).map((x) => ({
              mint: String(x.mint), symbol: untrustedText(x.symbol), mcap: num(x.mcap), liq: num(x.liquidityUsd), volH1: num(x.volH1), chgH1: num(rec(x.priceChange)?.h1),
              tokenAgeSec: num(x.tokenAgeSec), fetchedAt: num(x.fetchedAt), engine: this.mark(String(x.mint)),
            })),
          };
        }
        why = 'the screener returned nothing: offline, or the sources did not answer';
      } catch (e) { why = `the screener did not answer (${errOf(e)})`; }
    }
    // No live screener: the runner's own candidates and holdings, which it ranks by nothing but time.
    const st = this.d.state();
    const own = st ? [...st.positions.map((p) => ({ mint: p.mint, symbol: p.symbol, engine: 'held' as const })), ...st.candidates.map((c) => ({ mint: c.mint, symbol: c.symbol, engine: 'candidate' as const }))] : [];
    if (own.length) {
      return {
        source: `${why || 'no live screener here'}; the runner's own coins instead`, at: this.now(),
        rows: own.slice(0, k).map((x) => ({ mint: x.mint, symbol: x.symbol, mcap: null, liq: null, volH1: null, chgH1: null, tokenAgeSec: null, fetchedAt: st!.t, engine: x.engine })),
      };
    }
    return { unavailable: why ? `No ranking right now: ${why}.` : NO_LIVE_DATA };
  }

  signals(n: number): SignalsView | Unavailable {
    const log = this.d.signals;
    if (!log.total && !this.d.state()) return { unavailable: 'No signals: no run has started since the bot came on.' };
    return { at: this.now(), total: log.total, rows: log.recent(Math.min(SIGNALS_MAX, Math.max(1, Math.floor(n) || SIGNALS_DEFAULT))) };
  }
}
