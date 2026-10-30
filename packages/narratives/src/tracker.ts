// dexterm narratives (task-1818): the tracker. Coins come in (first sighting: name/ticker/description), market
// samples come in (price, liquidity, rolling volume, traders), and on each tick it recomputes, per narrative and
// per window (5m / 1h / 6h / 24h): coin count, new-coin rate, volume share, unique-trader growth, the top runner
// and its drawdown, a lifecycle state, a copy-cat saturation flag and a memetic traction score.
//
// Everything is MEASURED HEAT from recorded/live market data, never advice. Point-in-time by construction: a tick
// at `now` only reads samples with t <= now that were already ingested (the replay feeds rows in time order).
// Lifecycle rules (LIFECYCLE_RULES below, also in the docs page) are evaluated in order; the first match wins.
import { Clusterer, clusterLabel, type Cluster, type ClusterOptions } from './cluster.ts';
import { LexicalEmbedder, type Embedder } from './embed.ts';
import { normalize, Vocab, type Normalized } from './normalize.ts';

export type Lifecycle = 'spark' | 'ignition' | 'peak' | 'fading' | 'dead';
export type WindowKey = '5m' | '1h' | '6h' | '24h';
export const WINDOWS: Record<WindowKey, number> = { '5m': 300_000, '1h': 3_600_000, '6h': 21_600_000, '24h': 86_400_000 };

/** Thresholds of the lifecycle and saturation rules (owner: maintainers; changing one changes the docs page). */
export const RULES = {
  deadVol1h: 1_000,          // narrative 1 h volume under this and no new coin in 6 h -> dead
  sparkAgeMs: 3_600_000,     // a narrative younger than 1 h is a spark
  ignitionVol1h: 5_000,      // ignition needs at least this much 1 h volume ...
  ignitionGrowth: 2,         // ... at least 2x its 1 h volume an hour ago (floored at deadVol1h) ...
  ignitionTraders: 0.5,      // ... and a new coin in the last hour OR +50% unique traders (1 h)
  fadeFromMax: 0.4,          // 1 h volume <= 40% of its 24 h max -> fading
  fadeGrowth: 0.6,           // or <= 60% of an hour ago
  saturationMembers: 5,      // copy-cat saturation: >= 5 coins,
  saturationNew6h: 3,        // >= 3 of them new in 6 h,
  saturationCopyShare: 0.25, // and the coins after the 3 oldest hold < 25% of the 1 h volume
  runnerMinLiq: 10_000,      // a top runner must have a sellable pool
  staleMs: 6 * 3_600_000,    // a coin sample older than this does not count as live volume
};

export const LIFECYCLE_RULES: Array<[Lifecycle, string]> = [
  ['dead', 'no member sampled in 6 h, or 1 h volume < $1k with no new coin in 6 h'],
  ['spark', 'first coin < 1 h ago (just formed)'],
  ['ignition', '1 h volume >= $5k and >= 2x the 1 h volume an hour ago, with a new coin in the hour or unique traders (1 h) +50%'],
  ['fading', '1 h volume <= 40% of its 24 h max, or <= 60% of an hour ago'],
  ['peak', 'otherwise: hot, near its 24 h high, growth under 2x'],
];

export interface CoinInput { mint: string; t: number; symbol?: string | null; name?: string | null; description?: string | null; socials?: Record<string, string | null | undefined> | null }
export interface Sample { mint: string; t: number; price?: number | null; liq?: number | null; mcap?: number | null; vol5m?: number | null; vol1h?: number | null; vol6h?: number | null; vol24h?: number | null; traders1h?: number | null; netBuyers1h?: number | null; holders?: number | null }

interface CoinState {
  mint: string; firstT: number; narrative: string; spawn: number; symbol: string; name: string; core: string | null;
  last: Sample | null; firstLiqPrice: number | null; peakPrice: number | null; lastT: number;
}

export interface WindowStats {
  coins: number;            // members with a sample in the window
  newCoins: number;         // members first seen in the window
  newPerHour: number;
  volume: number;           // sum of the members' rolling volume for the window (as reported by the source)
  volumeShare: number | null; // of all tracked coins' volume for the same window
  traders: number;          // sum of unique traders (1 h, Jupiter) now
  tradersGrowth: number | null; // vs the start of the window (null when no history yet)
}

export interface NarrativeSnapshot {
  id: string;
  label: string;
  modelLabel: string | null;
  theme: string | null;
  members: number;
  firstT: number;
  ageMin: number;
  lifecycle: Lifecycle;
  lifecycleRule: string;
  saturated: boolean;
  score: number;            // memetic traction 0-100
  components: Record<string, number | null>;
  rank: number | null;      // among narratives with >= 2 coins (1 = hottest)
  windows: Record<WindowKey, WindowStats>;
  vol1hAgo: number | null;
  vol1hMax24h: number | null;
  topRunner: { mint: string; symbol: string; x: number; drawdownPct: number; liq: number } | null;
  repeatedName1h: number;   // members in the last hour whose meme word equals the narrative's main one
  holderOverlap: null;      // cross-coin holder overlap: not recorded by the data layer (stated, never faked)
}

export interface CoinNarrative {
  mint: string; narrative: string; label: string; theme: string | null; spawn: number; members: number;
  lifecycle: Lifecycle | null; rank: number | null; score: number | null; saturated: boolean; isTopRunner: boolean;
  vol1hShare: number | null; newPerHour1h: number | null; growth1h: number | null;
}

export interface Transition { id: string; label: string; from: Lifecycle | null; to: Lifecycle; t: number; rank: number | null; members: number }

export interface TrackerOptions extends ClusterOptions {
  embedder?: Embedder;
  /** Minimum time between full metric recomputes (default 60 s; the replay uses 5 min). */
  tickMs?: number;
}

interface Hist { t: number; vol1h: number; traders: number }

const clip01 = (x: number): number => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export class NarrativeTracker {
  readonly clusterer: Clusterer;
  readonly embedder: Embedder;
  readonly vocab = new Vocab();
  readonly coins = new Map<string, CoinState>();
  private hist = new Map<string, Hist[]>();
  private snap = new Map<string, NarrativeSnapshot>();
  private lastTick = -Infinity;
  private tickMs: number;
  private listeners: Array<(t: Transition) => void> = [];
  private recent = new Set<string>();   // coins sampled in the last 24 h
  readonly stats = { coins: 0, samples: 0, ticks: 0, embedMs: 0, tickMs: 0 };

  constructor(opts: TrackerOptions = {}) {
    this.embedder = opts.embedder ?? new LexicalEmbedder();
    // the lexical embedder only links coins that share a word, so the "hot clusters" candidate set is wasted work there
    this.clusterer = new Clusterer({ ...opts, hotMax: opts.hotMax ?? (this.embedder.id.startsWith('lexical') ? 0 : 300) });
    this.tickMs = opts.tickMs ?? 60_000;
  }

  onTransition(fn: (t: Transition) => void): () => void { this.listeners.push(fn); return () => { this.listeners = this.listeners.filter((f) => f !== fn); }; }

  /** First sightings, in time order. Social links are used only as extra theme words (their handle), never fetched. */
  async addCoins(inputs: CoinInput[]): Promise<void> {
    const fresh = inputs.filter((c) => !this.coins.has(c.mint));
    if (!fresh.length) return;
    const norms: Normalized[] = fresh.map((c) => {
      const handle = c.socials ? Object.values(c.socials).filter(Boolean).map((u) => String(u).split(/[/?#@]/).filter(Boolean).pop() ?? '').join(' ') : '';
      const desc = [c.description ?? '', handle].filter(Boolean).join(' ') || null;
      const n = normalize({ symbol: c.symbol, name: c.name, description: desc }, this.vocab);
      this.vocab.learn(n.tokens.filter((t) => t.from === 'name' || t.from === 'symbol').map((t) => t.t));
      return n;
    });
    const t0 = performance.now();
    const vecs = await this.embedder.embed(norms);
    this.stats.embedMs += performance.now() - t0;
    fresh.forEach((c, i) => {
      if (this.coins.has(c.mint)) return;
      const a = this.clusterer.assign(c.mint, c.t, norms[i], vecs[i]);
      this.coins.set(c.mint, { mint: c.mint, firstT: c.t, narrative: a.id, spawn: a.spawn, symbol: norms[i].symbol, name: norms[i].name, core: norms[i].core, last: null, firstLiqPrice: null, peakPrice: null, lastT: c.t });
      this.stats.coins++;
    });
  }

  /** A market sample for a known coin (unknown mints are ignored: call addCoins first). */
  addSample(s: Sample): void {
    const c = this.coins.get(s.mint); if (!c) return;
    this.stats.samples++;
    c.last = s; c.lastT = s.t; this.recent.add(s.mint);
    const p = s.price ?? null;
    if (p != null && p > 0 && num(s.liq) >= RULES.runnerMinLiq) {
      if (c.firstLiqPrice == null) c.firstLiqPrice = p;
      c.peakPrice = Math.max(c.peakPrice ?? 0, p);
    }
  }

  /** Recompute every narrative's metrics if at least tickMs passed (or force). Returns true when it ran. */
  tick(now: number, force = false): boolean {
    if (!force && now - this.lastTick < this.tickMs) return false;
    const t0 = performance.now();
    this.lastTick = now; this.stats.ticks++;
    type Acc = { w: Record<WindowKey, { coins: number; newCoins: number; volume: number }>; traders: number; vol1hByMember: Array<[CoinState, number]>; runner: CoinState | null; runnerX: number; repeated: number; liveMembers: number; newest6h: number };
    const acc = new Map<string, Acc>();
    const tot: Record<WindowKey, number> = { '5m': 0, '1h': 0, '6h': 0, '24h': 0 };
    const vkey: Record<WindowKey, keyof Sample> = { '5m': 'vol5m', '1h': 'vol1h', '6h': 'vol6h', '24h': 'vol24h' };
    const get = (id: string): Acc => {
      let a = acc.get(id);
      if (!a) acc.set(id, (a = { w: { '5m': { coins: 0, newCoins: 0, volume: 0 }, '1h': { coins: 0, newCoins: 0, volume: 0 }, '6h': { coins: 0, newCoins: 0, volume: 0 }, '24h': { coins: 0, newCoins: 0, volume: 0 } }, traders: 0, vol1hByMember: [], runner: null, runnerX: 0, repeated: 0, liveMembers: 0, newest6h: 0 }));
      return a;
    };
    for (const mint of this.recent) {
      const c = this.coins.get(mint)!;
      if (now - c.lastT > WINDOWS['24h']) { this.recent.delete(mint); continue; }
      const s = c.last!; const a = get(c.narrative);
      const age = now - s.t; const live = age <= RULES.staleMs;
      if (live) a.liveMembers++;
      for (const k of Object.keys(WINDOWS) as WindowKey[]) {
        if (age <= Math.max(WINDOWS[k], 900_000)) a.w[k].coins++;
        if (live) { const v = num(s[vkey[k]]); a.w[k].volume += v; tot[k] += v; }
      }
      if (live) { a.traders += num(s.traders1h); a.vol1hByMember.push([c, num(s.vol1h)]); }
      if (live && c.firstLiqPrice && s.price && num(s.liq) >= RULES.runnerMinLiq) {
        const x = s.price / c.firstLiqPrice;
        if (x > a.runnerX) { a.runnerX = x; a.runner = c; }
      }
    }
    // new-coin counts and repeated-name velocity come from the member lists (first sightings), not samples
    for (const [id, a] of acc) {
      const cl = this.clusterer.clusters.get(id)!;
      const main = mainCore(cl);
      for (let i = cl.members.length - 1; i >= 0; i--) {
        const m = cl.members[i]; const age = now - m.t;
        if (age < 0) continue;
        if (age > WINDOWS['24h']) break;
        for (const k of Object.keys(WINDOWS) as WindowKey[]) if (age <= WINDOWS[k]) a.w[k].newCoins++;
        if (age <= WINDOWS['1h'] && main && m.core && squashEq(m.core, main)) a.repeated++;
        if (age <= WINDOWS['6h']) a.newest6h++;
      }
    }
    const next = new Map<string, NarrativeSnapshot>();
    const ranked: NarrativeSnapshot[] = [];
    const newCoinVol1h = [...this.recent].reduce((s, m) => { const c = this.coins.get(m)!; return s + (now - c.firstT <= WINDOWS['24h'] && now - c.lastT <= RULES.staleMs ? num(c.last?.vol1h) : 0); }, 0);
    for (const [id, a] of acc) {
      const cl = this.clusterer.clusters.get(id)!;
      // history only for real narratives (>= 2 coins): a singleton's 24 h history was 2/3 of the replay's memory
      const h = cl.members.length > 1 ? this.pushHist(id, now, a.w['1h'].volume, a.traders) : [];
      const ago = histAt(h, now - WINDOWS['1h']);
      const max24 = h.reduce((m, x) => (now - x.t <= WINDOWS['24h'] ? Math.max(m, x.vol1h) : m), 0);
      const V1 = a.w['1h'].volume;
      const windows = {} as Record<WindowKey, WindowStats>;
      for (const k of Object.keys(WINDOWS) as WindowKey[]) {
        const tr = histAt(h, now - WINDOWS[k]);
        // history points are 15 min apart, so a 5-min trader growth would really be ~15-20 min: null there, never mislabelled
        windows[k] = { coins: a.w[k].coins, newCoins: a.w[k].newCoins, newPerHour: a.w[k].newCoins / (WINDOWS[k] / 3_600_000), volume: a.w[k].volume, volumeShare: tot[k] > 0 ? a.w[k].volume / tot[k] : null, traders: a.traders, tradersGrowth: k !== '5m' && tr && tr.traders > 0 ? a.traders / tr.traders - 1 : null };
      }
      const growth = ago ? V1 / Math.max(ago.vol1h, RULES.deadVol1h) : null;
      const age = now - cl.firstT;
      let lc: Lifecycle, rule: string;
      if (a.liveMembers === 0 || (V1 < RULES.deadVol1h && a.newest6h === 0)) [lc, rule] = LIFECYCLE_RULES[0];
      else if (age < RULES.sparkAgeMs) [lc, rule] = LIFECYCLE_RULES[1];
      else if (V1 >= RULES.ignitionVol1h && growth != null && growth >= RULES.ignitionGrowth && (windows['1h'].newCoins >= 1 || (windows['1h'].tradersGrowth ?? 0) >= RULES.ignitionTraders)) [lc, rule] = LIFECYCLE_RULES[2];
      else if ((max24 > 0 && V1 <= RULES.fadeFromMax * max24) || (growth != null && growth <= RULES.fadeGrowth)) [lc, rule] = LIFECYCLE_RULES[3];
      else [lc, rule] = LIFECYCLE_RULES[4];
      // copy-cat saturation: many recent spawns, and the spawns after the first three are not getting the volume
      const byAge = [...a.vol1hByMember].sort((x, y) => x[0].spawn - y[0].spawn);
      const copyVol = byAge.slice(3).reduce((s, x) => s + x[1], 0);
      const saturated = cl.members.length >= RULES.saturationMembers && a.newest6h >= RULES.saturationNew6h && V1 > 0 && copyVol / V1 < RULES.saturationCopyShare;
      const comp: Record<string, number | null> = {
        growth: growth == null ? null : clip01(Math.log2(Math.max(growth, 1e-6)) / 2 + 0.5),
        spawnRate: clip01(windows['1h'].newCoins / 5),
        nameVelocity: clip01(a.repeated / 5),
        newCoinVolumeShare: newCoinVol1h > 0 ? clip01((V1 / newCoinVol1h) * 10) : null,
        breadth: clip01(a.vol1hByMember.filter(([c]) => num(c.last?.liq) >= RULES.runnerMinLiq).length / 5),
        holderOverlap: null,
      };
      const W: Record<string, number> = { growth: 0.3, spawnRate: 0.2, nameVelocity: 0.15, newCoinVolumeShare: 0.25, breadth: 0.1, holderOverlap: 0.1 };
      let sw = 0, sv = 0;
      for (const [k, v] of Object.entries(comp)) if (v != null) { sw += W[k]; sv += W[k] * v; }
      const score = lc === 'dead' ? 0 : Math.round((sw > 0 ? sv / sw : 0) * 100);
      const r = a.runner;
      const snap: NarrativeSnapshot = {
        id, label: cl.members.length > 1 ? clusterLabel(cl) : (cl.members[0].symbol || cl.seedCore || '?'), modelLabel: cl.modelLabel ?? null, theme: this.clusterer.topTheme(cl), members: cl.members.length, firstT: cl.firstT,
        ageMin: Math.round(age / 60_000), lifecycle: lc, lifecycleRule: rule, saturated, score, components: comp, rank: null, windows,
        vol1hAgo: ago ? ago.vol1h : null, vol1hMax24h: max24 || null,
        topRunner: r && r.last?.price && r.peakPrice ? { mint: r.mint, symbol: r.symbol, x: a.runnerX, drawdownPct: (r.last.price / r.peakPrice - 1) * 100, liq: num(r.last.liq) } : null,
        repeatedName1h: a.repeated, holderOverlap: null,
      };
      next.set(id, snap);
      if (cl.members.length >= 2 && lc !== 'dead') ranked.push(snap);
    }
    ranked.sort((x, y) => y.score - x.score || y.windows['1h'].volume - x.windows['1h'].volume || (x.id < y.id ? -1 : 1));
    ranked.forEach((s, i) => { s.rank = i + 1; });
    for (const [id, s] of next) {
      const prev = this.snap.get(id)?.lifecycle ?? null;
      if (prev !== s.lifecycle && s.members >= 2) for (const fn of this.listeners) fn({ id, label: s.label, from: prev, to: s.lifecycle, t: now, rank: s.rank, members: s.members });
    }
    // narratives with no recent member keep their last state as dead
    for (const [id, s] of this.snap) if (!next.has(id) && s.lifecycle !== 'dead') next.set(id, { ...s, lifecycle: 'dead', lifecycleRule: LIFECYCLE_RULES[0][1], rank: null, score: 0 });
    else if (!next.has(id)) next.set(id, s);
    this.snap = next;
    if (this.stats.ticks % 12 === 0) for (const [id, h] of this.hist) if (!h.length || now - h[h.length - 1].t > WINDOWS['24h'] + 3_600_000) this.hist.delete(id);
    this.stats.tickMs += performance.now() - t0;
    return true;
  }

  private pushHist(id: string, t: number, vol1h: number, traders: number): Hist[] {
    let h = this.hist.get(id); if (!h) this.hist.set(id, (h = []));
    // one point per 15 min is enough for "an hour ago" and the 24 h max (the newest point is overwritten in between)
    const last = h[h.length - 1];
    if (last && h.length > 1 && t - h[h.length - 2].t < 900_000) { last.t = t; last.vol1h = vol1h; last.traders = traders; }
    else h.push({ t, vol1h, traders });
    while (h.length && t - h[0].t > WINDOWS['24h'] + 3_600_000) h.shift();
    return h;
  }

  /** Narratives by rank (ranked first, then by 1 h volume). */
  top(limit = 20, opts: { includeDead?: boolean; minMembers?: number } = {}): NarrativeSnapshot[] {
    const min = opts.minMembers ?? 2;
    return [...this.snap.values()].filter((s) => s.members >= min && (opts.includeDead || s.lifecycle !== 'dead'))
      .sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || b.windows['1h'].volume - a.windows['1h'].volume).slice(0, limit);
  }

  detail(id: string): (NarrativeSnapshot & { memberList: Array<{ mint: string; symbol: string; name: string; spawn: number; firstT: number; price: number | null; liq: number | null; vol1h: number | null; x: number | null }> }) | null {
    const cl = this.clusterer.clusters.get(id); if (!cl) return null;
    const s = this.snap.get(id) ?? this.emptySnap(cl);
    const memberList = cl.members.map((m) => {
      const c = this.coins.get(m.mint)!;
      const p = c.last?.price ?? null;
      return { mint: m.mint, symbol: m.symbol, name: m.name, spawn: m.spawn, firstT: m.t, price: p, liq: c.last?.liq ?? null, vol1h: c.last?.vol1h ?? null, x: p && c.firstLiqPrice ? p / c.firstLiqPrice : null };
    });
    return { ...s, memberList };
  }

  /** Narrative of one coin at the last tick (point-in-time in a replay). */
  narrativeOf(mint: string): CoinNarrative | null {
    const c = this.coins.get(mint); if (!c) return null;
    const cl = this.clusterer.clusters.get(c.narrative)!;
    const s = this.snap.get(c.narrative) ?? null;
    return {
      mint, narrative: c.narrative, label: s?.label ?? clusterLabel(cl), theme: this.clusterer.topTheme(cl), spawn: c.spawn,
      members: cl.members.filter((m) => m.t <= this.lastTick || this.lastTick === -Infinity).length,
      lifecycle: s?.lifecycle ?? null, rank: s?.rank ?? null, score: s?.score ?? null, saturated: s?.saturated ?? false,
      isTopRunner: s?.topRunner?.mint === mint, vol1hShare: s?.windows['1h'].volumeShare ?? null, newPerHour1h: s?.windows['1h'].newPerHour ?? null,
      growth1h: s && s.vol1hAgo != null ? s.windows['1h'].volume / Math.max(s.vol1hAgo, RULES.deadVol1h) : null,
    };
  }

  setModelLabel(id: string, label: string | null): void { const c = this.clusterer.clusters.get(id); if (c) c.modelLabel = label; }

  get lastTickAt(): number | null { return Number.isFinite(this.lastTick) ? this.lastTick : null; }

  private emptySnap(cl: Cluster): NarrativeSnapshot {
    const z = (): WindowStats => ({ coins: 0, newCoins: 0, newPerHour: 0, volume: 0, volumeShare: null, traders: 0, tradersGrowth: null });
    return { id: cl.id, label: clusterLabel(cl), modelLabel: cl.modelLabel ?? null, theme: this.clusterer.topTheme(cl), members: cl.members.length, firstT: cl.firstT, ageMin: 0, lifecycle: 'spark', lifecycleRule: LIFECYCLE_RULES[1][1], saturated: false, score: 0, components: {}, rank: null, windows: { '5m': z(), '1h': z(), '6h': z(), '24h': z() }, vol1hAgo: null, vol1hMax24h: null, topRunner: null, repeatedName1h: 0, holderOverlap: null };
  }
}

function mainCore(c: Cluster): string | null {
  let best: string | null = null, n = 0;
  for (const [k, v] of c.cores) if (v > n) { best = k; n = v; }
  return best;
}
const squashEq = (a: string, b: string): boolean => a.replace(/(.)\1+/gu, '$1') === b;

/** The newest history point at or before t (null if none within 2 ticks' tolerance of the window start). */
function histAt(h: Hist[], t: number): Hist | null {
  let lo = 0, hi = h.length - 1, r: Hist | null = null;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (h[mid].t <= t) { r = h[mid]; lo = mid + 1; } else hi = mid - 1; }
  return r;
}
