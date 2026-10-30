// dexterm narratives (task-1818): text normalisation for meme coins. A coin needs no real project to run, so the
// signal is the THEME its name/ticker carries: ticker puns, leetspeak, glued words, copy-cat affixes ("BABY X",
// "X 2.0", "X INU"), emoji. Everything here is UNTRUSTED token text: it is firewalled (control/bidi/zero-width
// stripped, length-capped) before use, only ever matched and hashed, and never interpreted as instructions.
import { clean, classify, loadDefaultLexicon } from '@dexterm/packs';

/** Copy-cat / filler affixes: kept as weak tokens (they say "spawn of X", not what X is). */
export const AFFIXES = new Set([
  'baby', 'mini', 'mega', 'super', 'giga', 'ultra', 'little', 'lil', 'big', 'real', 'official', 'og', 'the', 'of', 'a', 'an',
  'on', 'in', 'and', 'my', 'your', 'coin', 'token', 'sol', 'solana', 'classic', 'ceo', 'dao', 'v2', 'v3', 'new', 'x', 'mr',
  'mrs', 'king', 'queen', 'lord', 'sir', 'is', 'it', 'to', 'for', 'with', 'wif', 'inu', 'pump', 'fun', 'meme', 'memecoin',
  'ai', 'gpt', 'bot', 'agent', 'jr', 'junior', 'pro', 'max', 'plus', 'black', 'white', 'red', 'blue', 'green', 'gold', 'golden',
]);
/** Affixes stripped from glued tickers without a vocabulary (longest first). */
const PREFIX_AFFIXES = ['official', 'little', 'super', 'baby', 'mini', 'mega', 'giga', 'real', 'lil', 'the', 'mr', 'og'];
const SUFFIX_AFFIXES = ['coin', 'inu'];   // not ai / sol: they end real words (bonsai, consol)
/** Tokens that carry no theme at all (dropped). */
const STOP = new Set(['', 'de', 'la', 'le', 'el', 'by', 'at', 'or', 'no', 'so', 'be', 'we', 'us', 'me', 'he', 'she']);

const EMOJI: Array<[RegExp, string]> = [
  [/[🐸]/gu, ' frog '], [/[🐶🐕🦮🐩]/gu, ' dog '], [/[🐱🐈😺😸]/gu, ' cat '], [/[🐧]/gu, ' penguin '], [/[🦛]/gu, ' hippo '],
  [/[🤖]/gu, ' robot '], [/[🧠]/gu, ' brain '], [/[🎃]/gu, ' pumpkin '], [/[👻]/gu, ' ghost '], [/[🚀]/gu, ' rocket '],
  [/[🐒🐵🦍]/gu, ' monkey '], [/[🐿]/gu, ' squirrel '], [/[🦈]/gu, ' shark '], [/[🐋🐳]/gu, ' whale '], [/[🍌]/gu, ' banana '],
  [/[🐂🐮🐄]/gu, ' cow '], [/[🐷🐖]/gu, ' pig '], [/[🦆]/gu, ' duck '], [/[🐻]/gu, ' bear '], [/[🔥]/gu, ' fire '],
  [/[💎]/gu, ' diamond '], [/[🌙🌕]/gu, ' moon '], [/[🇺🇸]/gu, ' usa '], [/[🎄🎅]/gu, ' christmas '], [/[🐉🐲]/gu, ' dragon '],
];
const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b' };

/** A base vocabulary used to split glued tickers ("MOODENG" -> moo deng); grows from names seen (learnWords). */
const BASE_VOCAB = [
  'dog', 'cat', 'frog', 'pepe', 'doge', 'shib', 'moo', 'deng', 'pnut', 'nut', 'peanut', 'hat', 'wif', 'trump', 'elon', 'musk',
  'moon', 'sun', 'pump', 'chill', 'guy', 'girl', 'boy', 'man', 'king', 'cash', 'gold', 'baby', 'ai', 'agent', 'bot', 'brain',
  'rot', 'gork', 'grok', 'pig', 'cow', 'ape', 'monkey', 'penguin', 'hippo', 'bear', 'bull', 'duck', 'goat', 'fish', 'shark',
  'whale', 'banana', 'pizza', 'coffee', 'beer', 'fire', 'water', 'god', 'jesus', 'devil', 'ghost', 'pumpkin', 'santa', 'pop',
  'jelly', 'fart', 'butt', 'coin', 'stonk', 'rich', 'poor', 'happy', 'sad', 'mad', 'cute', 'tiny', 'fat', 'big', 'lil',
  'bonk', 'wojak', 'chad', 'sigma', 'giga', 'troll', 'meme', 'tard', 'retard', 'degen', 'ser', 'gm', 'based', 'usa', 'china',
  'japan', 'neko', 'inu', 'kitty', 'puppy', 'mew', 'meow', 'woof', 'bark', 'quack', 'quantum', 'robot', 'cyber', 'dark',
];

export interface NormToken { t: string; w: number; affix: boolean; from: 'symbol' | 'name' | 'description' | 'split' }
export interface Normalized {
  /** Weighted tokens (lowercase, leet/repeats/affixes handled). */
  tokens: NormToken[];
  /** Squashed (repeat-free) non-affix tokens, the copy-cat blocking keys ("mooodeng" and "moodeng" share "modeng"). */
  keys: string[];
  /** The main meme word: the longest non-affix name/ticker token ("baby pnut 2.0" -> pnut). */
  core: string | null;
  /** Lexicon themes (packs/assets/lexicon.json) the text matches, strongest first. */
  themes: string[];
  /** Firewalled display forms. */
  symbol: string;
  name: string;
}

/** Collapse every run of a repeated letter to one ("doggg" -> "dog", "moodeng" -> "modeng"): the fuzzy key form. */
export const squash = (s: string): string => s.replace(/(.)\1+/gu, '$1');

function deLeet(w: string): string {
  if (!/\p{L}/u.test(w) || !/\d/.test(w)) return w;            // pure words and pure numbers stay
  return w.replace(/[0134578]/g, (d) => LEET[d] ?? d);
}

function splitCamel(s: string): string {
  // DogWifHat -> Dog Wif Hat, but leave ALLCAPS and lowercase runs alone
  return s.replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2').replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2');
}

/** Words of a firewalled string: emoji mapped to words, camelCase split, lowercased, leet decoded, runs of 3+ cut to 2. */
export function words(raw: string): string[] {
  let s = raw;
  for (const [re, w] of EMOJI) s = s.replace(re, w);
  // apostrophes join ("don't" -> dont, not "don" + "t": the audit's "Don't Nut" joined a "don" narrative)
  s = splitCamel(s).normalize('NFKC').toLowerCase().replace(/^\$+/, '').replace(/\$/g, ' ').replace(/(\p{L})['’](\p{L})/gu, '$1$2');
  return s.split(/[^\p{L}\p{N}]+/u).map(deLeet).map((w) => w.replace(/(.)\1{2,}/gu, '$1$1')).filter((w) => !STOP.has(w));
}

/** Learned vocabulary (words seen standalone in >= 2 coin names) + the base list; used to split glued tickers. */
export class Vocab {
  private seen = new Map<string, number>();
  private words = new Set<string>(BASE_VOCAB);
  constructor(extra: Iterable<string> = []) { for (const w of extra) if (w.length >= 3 && /^\p{L}+$/u.test(w)) this.words.add(w); }
  learn(ws: string[]): void {
    for (const w of new Set(ws)) {
      if (w.length < 3 || w.length > 12 || !/^\p{L}+$/u.test(w) || AFFIXES.has(w)) continue;
      const n = (this.seen.get(w) ?? 0) + 1; this.seen.set(w, n);
      if (n === 2) this.words.add(w);
    }
  }
  has(w: string): boolean { return this.words.has(w) || AFFIXES.has(w); }
  get size(): number { return this.words.size; }
  /** Split a glued word into <= 3 known pieces (each >= 2 chars, at least one >= 3), longest-first DP; null if none.
   *  Fallback with no vocabulary: a leading or trailing copy-cat affix ("BABYFROGGO" -> baby + froggo, "FROGINU"
   *  -> frog + inu) even when the meme word has not been seen standalone yet (a copy can launch before the vocab knows it). */
  segment(w: string): string[] | null {
    if (w.length < 5 || w.length > 24 || this.words.has(w)) return null;
    const dp = this.segmentDp(w);
    if (dp) return dp;
    for (const p of PREFIX_AFFIXES) if (w.startsWith(p) && w.length - p.length >= 3) return [p, w.slice(p.length)];
    for (const x of SUFFIX_AFFIXES) if (w.endsWith(x) && w.length - x.length >= 3) return [w.slice(0, -x.length), x];
    return null;
  }
  private segmentDp(w: string): string[] | null {
    const n = w.length; const best: Array<string[] | null> = new Array(n + 1).fill(null); best[0] = [];
    for (let i = 0; i < n; i++) {
      const cur = best[i]; if (!cur || cur.length >= 3) continue;
      for (let j = Math.min(n, i + 12); j >= i + 2; j--) {
        const piece = w.slice(i, j);
        if (!(piece.length >= 3 ? this.has(piece) : piece === 'ai' || piece === 'gm' || piece === 'og')) continue;
        const cand = [...cur, piece];
        const prev = best[j];
        if (!prev || cand.length < prev.length) best[j] = cand;
      }
    }
    const r = best[n];
    return r && r.length >= 2 && r.some((p) => p.length >= 3) ? r : null;
  }
}

const lexicon = (): ReturnType<typeof loadDefaultLexicon> => loadDefaultLexicon();

/**
 * Normalise one coin's text. `description` is optional (most launches carry none in the recorder).
 * Weights: ticker 1.2, name 1.0, description 0.4, glued-word pieces 0.7; affixes x0.25.
 */
export function normalize(input: { symbol?: string | null; name?: string | null; description?: string | null }, vocab?: Vocab): Normalized {
  const symbol = clean(input.symbol, 16); const name = clean(input.name, 64); const desc = clean(input.description, 512);
  const out: NormToken[] = []; const seen = new Map<string, NormToken>();
  const add = (t: string, w: number, from: NormToken['from']): void => {
    if (!t || t.length > 24 || /^\d+$/.test(t) && t.length > 4) return;
    const affix = AFFIXES.has(t) || /^\d+$/.test(t);
    const ww = affix ? w * 0.25 : w;
    const e = seen.get(t);
    if (e) { e.w = Math.max(e.w, ww); return; }
    const tok: NormToken = { t, w: ww, affix, from }; seen.set(t, tok); out.push(tok);
  };
  const fields: Array<[string, number, NormToken['from']]> = [[symbol, 1.2, 'symbol'], [name, 1.0, 'name'], [desc, 0.4, 'description']];
  for (const [text, w, from] of fields) {
    if (!text) continue;
    const ws = from === 'description' ? words(text).slice(0, 40) : words(text);
    // glued words are split only where gluing is the norm: the ticker, or a name that is one word ("#BOYCOTTPUMPFUN");
    // splitting ordinary name words pulled strangers in ("HEY EVERYONE" via "ever")
    const glued = from === 'symbol' || (from === 'name' && ws.length === 1);
    for (const x of ws) {
      add(x, w, from);
      if (vocab && glued) {
        const seg = vocab.segment(x);
        if (seg) {
          for (const p of seg) add(p, 0.7, 'split');
          // "babymoodeng" -> also "moodeng" at full weight: the copy-cat affix is not part of the meme
          const rest = seg.filter((p) => !AFFIXES.has(p));
          if (rest.length && rest.length < seg.length) add(rest.join(''), w, from);
        }
      }
    }
  }
  const strong = out.filter((t) => !t.affix && t.from !== 'description' && t.t.length >= 2);
  // the core meme word: a ticker word also in the name; else the ticker (a glued "BABYPNUT" -> its non-affix piece);
  // else the longest name word
  const nameWords = words(name);
  const symWords = symbol ? words(symbol) : [];
  const inBoth = strong.find((t) => t.from === 'symbol' && nameWords.includes(t.t));
  let core: string | null = inBoth?.t ?? null;
  if (!core && symWords.length === 1 && symWords[0].length >= 3 && !AFFIXES.has(symWords[0])) {
    const seg = vocab?.segment(symWords[0]);
    const piece = seg?.some((p) => AFFIXES.has(p)) ? seg.filter((p) => !AFFIXES.has(p)).join('') || undefined : undefined;
    core = piece ?? symWords[0];
  }
  if (!core) core = [...strong].filter((t) => t.from === 'name').sort((a, b) => b.t.length - a.t.length || b.w - a.w)[0]?.t ?? strong[0]?.t ?? null;
  const keys = [...new Set(strong.map((t) => squash(t.t)).filter((k) => k.length >= 3))];
  const cls = classify({ mint: '', symbol, name, description: desc || null }, lexicon());
  return { tokens: out, keys, core, themes: cls.labels.map((l) => l.theme), symbol, name };
}
