// dexterm narratives (task-1818): incremental clustering of coins into narratives with STABLE ids.
//
// Leader clustering in first-seen order (online, one pass, point-in-time: a coin only ever joins clusters that
// existed when it was first seen). Candidates come from blocking (shared squashed meme words) plus the currently
// hot clusters, so a semantic embedder can still link "puppy" to a dog narrative without a shared word.
// A coin joins the most similar candidate whose CENTROID cosine >= joinSim; the seed vector also has to stay
// within seedSim so a cluster cannot drift away from what started it. Otherwise it seeds a new cluster.
// Ids never change: `nar_<hash of the seed coin's core word + mint>`. Clusters are never merged or split (an
// honest limit: two narratives that converge later stay two rows).
import { cosine, unit } from './embed.ts';
import type { Normalized } from './normalize.ts';
import { AFFIXES, squash } from './normalize.ts';

export interface ClusterOptions {
  joinSim?: number;      // centroid cosine to join (default 0.62 lexical)
  seedSim?: number;      // seed cosine floor (default 0.45)
  hotMax?: number;       // hot clusters always compared (default 300; 0 for the lexical embedder, which needs a shared word)
  perKey?: number;       // most-recently-joined clusters compared per blocking key (default 80)
  activeMs?: number;     // a cluster with no new member for this long leaves the candidate set (default 72 h)
}

export interface Member { mint: string; t: number; spawn: number; core: string | null; symbol: string; name: string }

export interface Cluster {
  id: string;
  seedMint: string;
  seedCore: string | null;
  firstT: number;
  lastJoinT: number;
  members: Member[];
  /** n-gram counts over members (each member counted once per gram). */
  grams: Map<string, number>;
  /** surface forms per gram (for display casing). */
  forms: Map<string, Map<string, number>>;
  themes: Map<string, number>;
  cores: Map<string, number>;
  sum: Float32Array;
  /** The seed coin's vector; null while the cluster is a singleton (then it equals `sum`). */
  seed: Float32Array | null;
  /** An optional cached model label (never used for metrics). */
  modelLabel?: string | null;
}

function hashId(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  let h2 = 0x9e3779b9;
  for (let i = s.length - 1; i >= 0; i--) { h2 ^= s.charCodeAt(i); h2 = Math.imul(h2, 0x85ebca6b) >>> 0; }
  return (h >>> 0).toString(36).padStart(7, '0') + (h2 >>> 0).toString(36).slice(0, 3);
}

/** Display label: the top bigram when it is nearly as common as the top word, else the top word. */
export function clusterLabel(c: Cluster): string {
  let best: [string, number] | null = null, bestBi: [string, number] | null = null;
  for (const [g, n] of c.grams) {
    if (g.includes(' ')) { if (!bestBi || n > bestBi[1] || (n === bestBi[1] && g < bestBi[0])) bestBi = [g, n]; }
    else if (!best || n > best[1] || (n === best[1] && g.length > best[0].length)) best = [g, n];
  }
  const pick = bestBi && best && bestBi[1] >= 2 && bestBi[1] >= 0.6 * best[1] ? bestBi[0] : best?.[0] ?? c.seedCore ?? '?';
  return pick.split(' ').map((w) => {
    const forms = c.forms.get(w); if (!forms) return w;
    return [...forms.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }).join(' ');
}

export class Clusterer {
  readonly opts: Required<ClusterOptions>;
  readonly clusters = new Map<string, Cluster>();
  readonly byMint = new Map<string, string>();
  /** blocking key -> cluster ids in join order (may repeat; read newest-first, compacted when long). */
  private block = new Map<string, string[]>();
  private hot: string[] = [];
  private hotDirty = 0;

  constructor(opts: ClusterOptions = {}) {
    this.opts = { joinSim: opts.joinSim ?? 0.62, seedSim: opts.seedSim ?? 0.45, hotMax: opts.hotMax ?? 300, perKey: opts.perKey ?? 80, activeMs: opts.activeMs ?? 72 * 3_600_000 };
  }

  /** Assign one coin (first sighting at t). Returns the cluster id and the coin's spawn index (1 = seed). */
  assign(mint: string, t: number, norm: Normalized, vec: Float32Array): { id: string; spawn: number; joined: boolean; sim: number } {
    const known = this.byMint.get(mint);
    if (known) { const c = this.clusters.get(known)!; return { id: known, spawn: c.members.find((m) => m.mint === mint)?.spawn ?? 0, joined: false, sim: 1 }; }
    const cand = new Set<string>();
    for (const k of norm.keys) {
      const ids = this.block.get(k); if (!ids) continue;
      const local = new Set<string>();
      for (let i = ids.length - 1; i >= 0 && local.size < this.opts.perKey; i--) local.add(ids[i]);
      for (const id of local) cand.add(id);
    }
    if (this.opts.hotMax > 0) { if (++this.hotDirty >= 200) this.refreshHot(t); for (const id of this.hot) cand.add(id); }
    let bestId: string | null = null, bestSim = -1;
    for (const id of cand) {
      const c = this.clusters.get(id)!;
      if (t - c.lastJoinT > this.opts.activeMs) continue;
      const s = cosine(vec, c.sum);
      if (s > bestSim && s >= this.opts.joinSim && cosine(vec, c.seed ?? c.sum) >= this.opts.seedSim) { bestSim = s; bestId = id; }
    }
    let c: Cluster;
    if (bestId) c = this.clusters.get(bestId)!;
    else {
      const id = 'nar_' + hashId(`${norm.core ?? ''}|${mint}`);
      c = { id, seedMint: mint, seedCore: norm.core, firstT: t, lastJoinT: t, members: [], grams: new Map(), forms: new Map(), themes: new Map(), cores: new Map(), sum: new Float32Array(vec.length), seed: null };
      this.clusters.set(id, c);
    }
    if (c.members.length === 1 && !c.seed) c.seed = Float32Array.from(c.sum);
    const spawn = c.members.length + 1;
    c.members.push({ mint, t, spawn, core: norm.core, symbol: norm.symbol, name: norm.name });
    c.lastJoinT = Math.max(c.lastJoinT, t);
    for (let i = 0; i < vec.length; i++) c.sum[i] += vec[i];
    this.count(c, norm);
    for (const k of norm.keys) {
      let ids = this.block.get(k); if (!ids) this.block.set(k, (ids = []));
      if (ids[ids.length - 1] !== c.id) ids.push(c.id);
      if (ids.length > 6 * this.opts.perKey) { // compact: keep the newest occurrence of each id, newest perKey*2 ids
        const keep: string[] = []; const seen = new Set<string>();
        for (let i = ids.length - 1; i >= 0 && keep.length < 2 * this.opts.perKey; i--) if (!seen.has(ids[i])) { seen.add(ids[i]); keep.push(ids[i]); }
        this.block.set(k, keep.reverse());
      }
    }
    this.byMint.set(mint, c.id);
    return { id: c.id, spawn, joined: !!bestId, sim: bestId ? bestSim : 1 };
  }

  private count(c: Cluster, n: Normalized): void {
    const ws = n.tokens.filter((t) => !t.affix && t.from !== 'description' && t.t.length >= 2).map((t) => t.t);
    const uniq = [...new Set(ws)];
    const grams = new Set(uniq);
    const nameWords = n.name.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w && !AFFIXES.has(w));
    for (let i = 0; i + 1 < nameWords.length; i++) grams.add(nameWords[i] + ' ' + nameWords[i + 1]);
    for (const g of grams) c.grams.set(g, (c.grams.get(g) ?? 0) + 1);
    // display forms from the raw (firewalled) text
    for (const raw of [n.symbol, ...n.name.split(/[^\p{L}\p{N}]+/u)]) {
      const lw = raw.toLowerCase(); if (!grams.has(lw)) continue;
      let f = c.forms.get(lw); if (!f) c.forms.set(lw, (f = new Map())); f.set(raw, (f.get(raw) ?? 0) + 1);
    }
    for (const th of n.themes.slice(0, 1)) c.themes.set(th, (c.themes.get(th) ?? 0) + 1);
    if (n.core) { const k = squash(n.core); c.cores.set(k, (c.cores.get(k) ?? 0) + 1); }
  }

  private refreshHot(t: number): void {
    this.hotDirty = 0;
    const live = [...this.clusters.values()].filter((c) => c.members.length >= 3 && t - c.lastJoinT <= 24 * 3_600_000);
    live.sort((a, b) => b.lastJoinT - a.lastJoinT || b.members.length - a.members.length);
    this.hot = live.slice(0, this.opts.hotMax).map((c) => c.id);
  }

  /** Drop inactive singleton clusters from the blocking index (memory bound for long runs). Ids stay valid. */
  prune(t: number, idleMs = 7 * 86_400_000): number {
    let n = 0;
    for (const [k, ids] of this.block) {
      const keep = ids.filter((id) => { const c = this.clusters.get(id)!; return !(c.members.length === 1 && t - c.lastJoinT > idleMs); });
      n += ids.length - keep.length;
      if (keep.length) this.block.set(k, keep); else this.block.delete(k);
    }
    return n;
  }

  /** The lexicon theme most members carry, if enough do (>= 2 coins and >= 30%; a solo coin keeps its own). Display only. */
  topTheme(c: Cluster): string | null {
    let best: string | null = null, bn = 0;
    for (const [th, n] of c.themes) if (n > bn) { best = th; bn = n; }
    const m = c.members.length;
    return m === 1 || (bn >= 2 && bn >= 0.3 * m) ? best : null;
  }

  /** Mean member-to-centroid cosine (cohesion) for an audit; needs the member vectors. */
  static cohesion(vecs: Float32Array[]): number {
    if (vecs.length < 2) return 1;
    const s = new Float32Array(vecs[0].length);
    for (const v of vecs) for (let i = 0; i < v.length; i++) s[i] += v[i];
    unit(s);
    return vecs.reduce((a, v) => a + cosine(v, s), 0) / vecs.length;
  }
}
