// dexterm narratives (task-1818): embedders. All are LOCAL and keyless.
//  - `lexical` (default, built in, zero dependencies, deterministic): signed feature hashing of the normalised
//    tokens, the character trigrams of each meme word and the lexicon themes into a 384-dim unit vector.
//  - `minilm`: sentence-transformers/all-MiniLM-L6-v2 (Apache-2.0, ~23 MB quantised ONNX, CPU) through
//    transformers.js, loaded ONLY if `@huggingface/transformers` resolves from DEXTERM_EMBED_MODULE_DIR (it is not
//    an app dependency). Its vector is mixed with the lexical one so copy-cat keys still dominate.
//  - `ollama`: any local Ollama embedding model (`nomic-embed-text`, `all-minilm`) at 127.0.0.1:11434.
// Embeddings are cached per normalised text, so a re-seen name costs a map lookup.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Normalized } from './normalize.ts';
import { squash } from './normalize.ts';

export interface Embedder {
  readonly id: string;
  readonly dim: number;
  /** Unit vectors, one per input, same order. */
  embed(items: Normalized[]): Promise<Float32Array[]>;
}

export const LEXICAL_DIM = 384;

function fnv1a(s: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  // murmur3 fmix32: FNV's low bits mix poorly under a small modulus (biden and ray shared a dimension)
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0; h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0; h ^= h >>> 16;
  return h >>> 0;
}

export function unit(v: Float32Array): Float32Array {
  let n = 0; for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n); if (n > 0) for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na > 0 && nb > 0 ? d / Math.sqrt(na * nb) : 0;
}

const textKey = (n: Normalized): string => `${n.symbol.toLowerCase()}|${n.name.toLowerCase()}`;

/** The built-in lexical embedding: word identity (squashed), meme-word trigrams, lexicon themes. */
export function lexicalVector(n: Normalized, dim = LEXICAL_DIM): Float32Array {
  const v = new Float32Array(dim);
  const put = (f: string, w: number): void => { const h = fnv1a(f); v[h % dim] += (h & 0x80000000 ? -1 : 1) * w; };
  for (const tok of n.tokens) {
    const s = squash(tok.t);
    put('w:' + s, tok.w * (tok.t === n.core ? 1.6 : 1));
    if (tok.affix || s.length < 3) continue;
    const p = `^${s}$`; const tris: string[] = [];
    for (let i = 0; i + 3 <= p.length; i++) tris.push(p.slice(i, i + 3));
    const tw = (0.55 * tok.w) / Math.sqrt(tris.length);
    for (const t of tris) put('g:' + t, tw);
  }
  n.themes.slice(0, 3).forEach((th, i) => put('th:' + th, i === 0 ? 0.55 : 0.3));
  return unit(v);
}

export class LexicalEmbedder implements Embedder {
  readonly id = 'lexical-v1';
  readonly dim = LEXICAL_DIM;
  async embed(items: Normalized[]): Promise<Float32Array[]> { return items.map((n) => lexicalVector(n, this.dim)); }
}

/** Mix a semantic vector with the lexical one: [a * semantic, b * lexical], renormalised (a^2 + b^2 = 1). */
export function mix(sem: Float32Array, lex: Float32Array, semWeight = 0.6): Float32Array {
  const a = Math.sqrt(semWeight), b = Math.sqrt(1 - semWeight);
  const out = new Float32Array(sem.length + lex.length);
  for (let i = 0; i < sem.length; i++) out[i] = a * sem[i];
  for (let i = 0; i < lex.length; i++) out[sem.length + i] = b * lex[i];
  return unit(out);
}

/** The text a semantic model sees: the firewalled name and ticker, plus the split pieces (never a description prompt). */
export const semanticText = (n: Normalized): string => {
  const pieces = n.tokens.filter((t) => t.from === 'split').map((t) => t.t);
  return [n.name, n.symbol, ...pieces].filter(Boolean).join(' ').slice(0, 96);
};

abstract class CachedSemantic implements Embedder {
  abstract readonly id: string;
  abstract readonly dim: number;
  protected cache = new Map<string, Float32Array>();
  protected semWeight: number;
  constructor(semWeight = 0.6) { this.semWeight = semWeight; }
  protected abstract raw(texts: string[]): Promise<Float32Array[]>;
  async embed(items: Normalized[]): Promise<Float32Array[]> {
    const miss: Normalized[] = []; const keys = items.map(textKey);
    keys.forEach((k, i) => { if (!this.cache.has(k)) miss.push(items[i]); });
    if (miss.length) {
      const uniq = [...new Map(miss.map((m) => [textKey(m), m])).values()];
      const vecs = await this.raw(uniq.map(semanticText));
      uniq.forEach((m, i) => this.cache.set(textKey(m), mix(unit(vecs[i]), lexicalVector(m), this.semWeight)));
      if (this.cache.size > 200_000) this.cache.clear();
    }
    return keys.map((k) => this.cache.get(k)!);
  }
}

type FeatureExtractor = (texts: string[], opts: { pooling: 'mean'; normalize: boolean }) => Promise<{ data: Float32Array; dims: number[] }>;

/** all-MiniLM-L6-v2 through transformers.js (CPU, quantised). `moduleDir` holds node_modules/@huggingface/transformers. */
export class MiniLmEmbedder extends CachedSemantic {
  readonly id: string;
  readonly dim = 384 + LEXICAL_DIM;
  private extractor: FeatureExtractor | null = null;
  private moduleDir: string;
  private model: string;
  constructor(moduleDir: string, model = 'Xenova/all-MiniLM-L6-v2', semWeight = 0.6) {
    super(semWeight); this.id = `minilm-mix-${semWeight}`; this.moduleDir = moduleDir; this.model = model;
  }
  private async load(): Promise<FeatureExtractor> {
    if (this.extractor) return this.extractor;
    const req = createRequire(join(this.moduleDir, 'package.json'));
    const entry = req.resolve('@huggingface/transformers');
    type Mod = { pipeline: (task: string, model: string, o: Record<string, unknown>) => Promise<FeatureExtractor>; env: Record<string, unknown> };
    const loaded = (await import(pathToFileURL(entry).href)) as Mod & { default?: Mod };
    const mod: Mod = loaded.env ? loaded : loaded.default!;   // the CJS build arrives as a default export
    mod.env.allowRemoteModels = process.env.DEXTERM_EMBED_ALLOW_DOWNLOAD === '1'; // offline unless the user opts in to the one-time model fetch
    this.extractor = await mod.pipeline('feature-extraction', this.model, { dtype: 'q8' });
    return this.extractor;
  }
  protected async raw(texts: string[]): Promise<Float32Array[]> {
    const ex = await this.load(); const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += 64) {
      const batch = texts.slice(i, i + 64);
      const r = await ex(batch, { pooling: 'mean', normalize: true });
      const d = r.dims[r.dims.length - 1];
      for (let k = 0; k < batch.length; k++) out.push(Float32Array.from(r.data.subarray(k * d, (k + 1) * d)));
    }
    return out;
  }
}

/** A local Ollama embedding model. Loopback only; fails closed (throws) when Ollama is not running. */
export class OllamaEmbedder extends CachedSemantic {
  readonly id: string;
  readonly dim: number;
  private model: string;
  private base: string;
  constructor(model = 'all-minilm', dim = 384, base = 'http://127.0.0.1:11434', semWeight = 0.6) {
    super(semWeight); this.id = `ollama-${model}-mix-${semWeight}`; this.dim = dim + LEXICAL_DIM; this.model = model; this.base = base;
    const host = new URL(base).hostname;
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') throw new Error('ollama embedder is loopback-only');
  }
  protected async raw(texts: string[]): Promise<Float32Array[]> {
    const res = await fetch(`${this.base}/api/embed`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: this.model, input: texts }) });
    if (!res.ok) throw new Error(`ollama embed HTTP ${res.status}`);
    const j = (await res.json()) as { embeddings: number[][] };
    return j.embeddings.map((e) => Float32Array.from(e));
  }
}

/** Pick an embedder from env: DEXTERM_NARRATIVE_EMBEDDER = lexical (default) | minilm | ollama[:model]. */
export function embedderFromEnv(env: NodeJS.ProcessEnv = process.env): Embedder {
  const want = (env.DEXTERM_NARRATIVE_EMBEDDER ?? 'lexical').trim();
  if (want === 'minilm' && env.DEXTERM_EMBED_MODULE_DIR) return new MiniLmEmbedder(env.DEXTERM_EMBED_MODULE_DIR);
  if (want.startsWith('ollama')) return new OllamaEmbedder(want.split(':')[1] || 'all-minilm');
  return new LexicalEmbedder();
}
