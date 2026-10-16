// @dexterm/mcp — the app-help knowledge base (task-1413).
//
// A SECOND bundled KB set, separate from the 17 memecoin-risk entries, that teaches an agent how dexterm
// ITSELF works: what each screen shows, the exact key for a task, the CLI subcommand/flag, and the MCP
// tools. The entries in `assets/kb/app-help/*.md` are GENERATED from the app's own keymap / help overlay /
// MCP tool list / CLI by `packages/cli/src/app-help-gen.ts` (committed, run in tests), so they cannot drift
// from the real app. This module only LOADS and SEARCHES them — it is read-only and dependency-free.
//
// It is kept out of the main KB store on purpose: the memecoin KB's "exactly 17 bundled entries" invariant
// stays true, and a "how do I …" search hits app-help first without the two sets diluting each other.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBundled, type ContentEntry } from './user-content.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The shipped app-help KB directory (read-only; generated). */
export const APP_HELP_DIR = path.resolve(HERE, '..', 'assets', 'kb', 'app-help');

/** One app-help entry with its structured fields surfaced (all lists default to []). */
export interface AppHelpEntry {
  id: string;
  title: string;
  /** The screen this is about, or 'all' for a global/CLI topic. */
  screen: string;
  tags: string[];
  /** Canonical key ids a user presses (e.g. 'E', '?', 'ctrl+w s'); '' for pure-CLI topics. */
  keys: string[];
  /** Keymap action ids referenced (for drift checks against the keymap). */
  actions: string[];
  /** `dexterm` subcommands referenced (e.g. 'doctor', 'voice'). */
  commands: string[];
  /** CLI flags referenced (e.g. '--fixtures', '--export'). */
  flags: string[];
  /** MCP tool names referenced (e.g. 'larp_check'). */
  tools: string[];
  /** features.json id this maps to, or ''. */
  feature: string;
  body: string;
  bytes: number;
}

function list(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? [v] : [];
}

function toAppHelp(e: ContentEntry): AppHelpEntry {
  return {
    id: e.id,
    title: String(e.meta.title ?? e.id),
    screen: String(e.meta.screen ?? 'all'),
    tags: list(e.meta.tags),
    keys: list(e.meta.keys),
    actions: list(e.meta.actions),
    commands: list(e.meta.commands),
    flags: list(e.meta.flags),
    tools: list(e.meta.tools),
    feature: String(e.meta.feature ?? ''),
    body: e.body,
    bytes: e.bytes,
  };
}

/** Load every app-help entry (bundled-only; deterministic order by id). */
export function loadAppHelp(dir: string = APP_HELP_DIR): AppHelpEntry[] {
  const entries = loadBundled([{ dir, layout: 'flat' }]).map(toAppHelp);
  entries.sort((a, b) => a.id.localeCompare(b.id));
  return entries;
}

// Generic words that carry no retrieval signal in a "how do I …" question — dropped before scoring so a
// short noise word ('to', 'my') can't substring-match an unrelated entry and outrank the real one.
const STOP = new Set([
  'how', 'do', 'does', 'did', 'the', 'a', 'an', 'to', 'my', 'me', 'i', 'is', 'it', 'its', 'of', 'in', 'on',
  'at', 'by', 'or', 'and', 'for', 'with', 'this', 'that', 'these', 'those', 'your', 'you', 'can', 'what',
  'which', 'where', 'when', 'who', 'am', 'are', 'be', 'get', 'got', 'use', 'using', 'make', 'want', 'need',
  'from', 'into', 'show', 'see', 'tell', 'about', 'some', 'any', 'all', 'up', 'out', 'off', 'on',
  // generic action verbs — they appear in many entry titles ("Change…", "Switch…") and carry no signal.
  'change', 'switch', 'set', 'setting', 'turn', 'open', 'close', 'enable', 'disable', 'add', 'remove',
  'start', 'stop', 'run', 'cycle', 'pick', 'choose', 'save', 'view', 'check',
]);

function tokenise(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9][a-z0-9-]+/g) ?? []).filter((t) => !STOP.has(t));
}

/** A short, deterministic how-to synonym map so natural phrasings land on the right entry. */
const QUERY_SYNONYMS: Record<string, string> = {
  paste: 'open', ca: 'open', 'contract-address': 'open', address: 'open', link: 'open',
  screenshot: 'export', save: 'export', png: 'export', report: 'export', share: 'export',
  speed: 'rate', faster: 'rate', slower: 'rate', wpm: 'rate',
  speak: 'voice', talk: 'voice', jarvis: 'voice', mic: 'voice', microphone: 'voice',
  notify: 'alert', notification: 'alerts', telegram: 'alerts', discord: 'alerts',
  filtering: 'filter', query: 'filter',
  marketcap: 'mcap', 'market-cap': 'mcap', cap: 'mcap',
  honeypot: 'rug', safe: 'rug', scam: 'rug',
  fake: 'larp', legit: 'larp', real: 'larp', website: 'larp', 'rug-pull': 'rug',
  agent: 'mcp', agents: 'mcp', bot: 'mcp', claude: 'analyst',
  helius: 'key', rpc: 'key', holders: 'key',
  layout: 'workspace', workspaces: 'workspace',
  keybind: 'keymap', keybinding: 'keymap', rebind: 'keymap', shortcut: 'keymap',
  theme: 'theme', colour: 'theme', color: 'theme',
  buy: 'paper', sell: 'paper', trade: 'paper', ticket: 'paper',
  upgrade: 'update',
  chart: 'popup', candles: 'popup',
  bubbles: 'bubble', cluster: 'bubble', clusters: 'bubble',
  scanner: 'scan', watcher: 'scan',
  copy: 'follow', mirror: 'follow', unfollow: 'follow',
};

function expand(terms: string[]): string[] {
  const out = new Set(terms);
  for (const t of terms) { const s = QUERY_SYNONYMS[t]; if (s) out.add(s); }
  return [...out];
}

/** Raw word tokens of a haystack (no stopword filtering), for exact word-boundary matching. */
function words(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9][a-z0-9-]+/g) ?? [];
}

/**
 * Deterministic keyword retrieval over the app-help set (no model). Matches on WORD BOUNDARIES (not
 * substrings) so "screener" does not match the tag "dexscreener" and "token" does not match a tool name
 * like "open_token". title/tags/screen/feature score strongest; the body is the weak tail.
 */
export function searchAppHelp(query: string, limit = 5, entries: AppHelpEntry[] = loadAppHelp()): Array<AppHelpEntry & { score: number }> {
  const terms = expand(tokenise(query));
  // A query whose only meaningful word is a screen name ("what does the screener show") is a request for
  // that screen's overview, not for a topic that happens to run there.
  const soleScreen = terms.length === 1 ? terms[0] : null;
  // An explicit "... screen ..." question ("what does the kol screen show") is a request for that screen's
  // overview even when other words survive; boost the matching overview so it beats a topic that shares the name.
  const asksScreen = words(query).includes('screen');
  const scored = entries.map((e) => {
    const overview = e.id.startsWith('screen-');
    // Screen field matches only for an overview entry; on a topic it is just where the action happens.
    const strong = new Set(words(`${e.title} ${e.tags.join(' ')} ${e.feature}${overview ? ' ' + e.screen : ''}`));
    // An overview's body is the enumerated key list — it names every action word, so it is NOT scored
    // (else "sort the screener" would match the screener overview's `s — sort` line over the sort topic).
    const bodyWords = overview ? [] : words(e.body);
    let score = 0;
    for (const t of terms) {
      if (strong.has(t)) score += 4;
      let n = 0;
      for (const w of bodyWords) if (w === t) n++;
      score += Math.min(n, 3);
    }
    if (overview && soleScreen && soleScreen === e.screen) score += 6;
    if (overview && asksScreen && terms.includes(e.screen)) score += 3;
    return { e, score };
  }).filter((x) => x.score > 0)
    .sort((a, b) => (b.score - a.score) || a.e.id.localeCompare(b.e.id))
    .slice(0, limit);
  return scored.map(({ e, score }) => ({ ...e, score }));
}

/** Fetch one app-help entry by id. */
export function getAppHelp(id: string, entries: AppHelpEntry[] = loadAppHelp()): AppHelpEntry | null {
  return entries.find((e) => e.id === id) ?? null;
}
