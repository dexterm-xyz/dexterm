// DEV HISTORY binding (0.1.5, task-1425): the token screen's DEV rows, the rug-signal row and the `devrugs` rule
// field all read one cached report per mint from the recorder's own SQLite file (creators + outcomes + dev_pct
// series). Synchronous, local, keyless: no request is made here. Linked wallets come from the wallet-intel scan the
// token screen already runs (the creator's funder and any linked cluster it sits in); without a scan they are unknown.
import type { DatabaseSync } from 'node:sqlite';
import { ageShort, creatorOf, devHistoryLine, queryDevHistory, type CreatorLink, type DevHistoryReport } from '@dexterm/recorder';
import type { IntelAnalysis } from '@dexterm/data';

export interface DevLinked {
  /** The creator's funder (first SOL inflow) from the wallet-intel scan; null = not in the scan. */
  fundedBy: string | null;
  /** A linked cluster (same funder / same-block bundle / transfers) the creator sits in, from the scan. */
  cluster: { name: string; kind: string; members: number; pct: number } | null;
  /** Other wallets in that cluster that dexterm has recorded launching coins, with their labelled rugs. */
  linkedCreators: number;
  linkedRugs: number;
  /** When the newest of those mates' labels became known (unix ms); null = none labelled. */
  linkedNewestT: number | null;
  source: 'wallet-intel scan' | null;
  /** When the scan settled (unix ms); null = not given. */
  at: number | null;
}

export interface DevEntry {
  mint: string;
  creator: CreatorLink | null;
  report: DevHistoryReport | null;
  linked: DevLinked | null;
  /** The one-line summary (`unknown: …` when there is nothing to say). */
  line: string;
  at: number;
}

export const DEV_TTL_MS = 60_000;

/** Short creator/funder address for the panel (never a full address in a 40-column cell). */
export const shortAddr = (a: string | null | undefined): string => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : '—');

export class DevHistoryBook {
  private readonly cache = new Map<string, DevEntry>();
  private readonly db: () => DatabaseSync | null | undefined;
  private readonly now: () => number;
  private readonly ttlMs: number;
  constructor(db: () => DatabaseSync | null | undefined, now: () => number = () => Date.now(), ttlMs = DEV_TTL_MS) {
    this.db = db; this.now = now; this.ttlMs = ttlMs;
  }

  /**
   * The entry for `mint` (cached for `ttlMs`). `creatorHint` is the dev wallet a source named on screen (Jupiter
   * `dev`) for a coin the recorder has not linked yet; `intel` is the coin's settled wallet-intel scan, if any, and
   * `intelAt` when that scan settled (the linked row's age).
   */
  forMint(mint: string, creatorHint?: string | null, intel?: IntelAnalysis | null, intelAt?: number | null): DevEntry {
    const now = this.now();
    const hit = this.cache.get(mint);
    if (hit && now - hit.at < this.ttlMs && (hit.creator || !creatorHint) && (hit.linked || !intel)) return hit;
    const db = this.db() ?? null;
    let creator: CreatorLink | null = db ? creatorOf(db, mint) : null;
    if (!creator && creatorHint && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(creatorHint)) creator = { mint, creator: creatorHint, source: 'jupiter-tokens', firstT: now, createdAt: null };
    let report: DevHistoryReport | null = null;
    let linked: DevLinked | null = null;
    if (creator && db) {
      try { report = queryDevHistory(db, { creator: creator.creator, mint, asOf: now }); } catch { report = null; }
    }
    if (creator && intel) linked = linkedFrom(intel, creator.creator, db, intelAt ?? null);
    const line = !db ? 'unknown: the history recorder is off (--no-recorder / DEXTERM_RECORDER=0)'
      : !creator ? 'unknown: no source named the creator yet'
        : report ? devHistoryLine(report) : 'unknown: dev history unreadable';
    const e: DevEntry = { mint, creator, report, linked, line, at: now };
    this.cache.set(mint, e);
    if (this.cache.size > 2000) this.cache.delete(this.cache.keys().next().value!);
    return e;
  }

  /** The `devrugs` rule field: labelled prior rugs by this coin's creator; null = unknown (clauses on it are false). */
  rugsFor(mint: string): number | null {
    const e = this.forMint(mint);
    return e.report && e.report.labelled.n > 0 ? e.report.labelled.rug : null;
  }
}

/** Linked wallets from a settled wallet-intel scan: the creator's funder and any multi-wallet cluster it sits in. */
export function linkedFrom(a: IntelAnalysis, creator: string, db: DatabaseSync | null, at: number | null = null): DevLinked {
  const h = a.holders.find((x) => x.owner === creator);
  const fundedBy = h?.funder?.address ?? a.funding[creator]?.funder ?? null;
  const c = a.clusters.find((x) => x.members.includes(creator) && x.members.length > 1) ?? null;
  let linkedCreators = 0, linkedRugs = 0, linkedNewestT: number | null = null;
  if (c && db) {
    try {
      const others = c.members.filter((m) => m !== creator).slice(0, 50);
      const launched = db.prepare('SELECT COUNT(*) AS n FROM creators WHERE creator = ?');
      for (const w of others) {
        if (Number((launched.get(w) as { n: number }).n) <= 0) continue;
        linkedCreators++;
        const r = queryDevHistory(db, { creator: w, devExit: false });
        linkedRugs += r.labelled.rug;
        if (r.labelled.newestT !== null) linkedNewestT = Math.max(linkedNewestT ?? 0, r.labelled.newestT);
      }
    } catch { /* an old DB without the table: nothing linked */ }
  }
  return { fundedBy, cluster: c ? { name: c.name, kind: c.kind, members: c.members.length, pct: c.pct } : null, linkedCreators, linkedRugs, linkedNewestT, source: h || c || a.funding[creator] ? 'wallet-intel scan' : null, at };
}

/** Short source tags for a panel cell: `rec` = dexterm's recorder, `scan` = the wallet-intel scan; creator links by feed. */
const LINK_TAG: Record<string, string> = { 'jupiter-tokens': 'jup', pumpportal: 'pump', rugcheck: 'rc' };
const linkTag = (src: string | null | undefined): string => (src ? LINK_TAG[src] ?? src : '?');
const ageAt = (t: number | null | undefined, now: number): string => ageShort(t === null || t === undefined ? null : Math.max(0, Math.round((now - t) / 1000)));

/**
 * Rows for the token screen's DEV block: [label, value, level]. Every value names its source, sample and age (or
 * says unknown): `rec` = dexterm's recorder, `scan` = the wallet-intel scan, `dev:jup` = which feed named the creator.
 * Ages are measured from `now` (default: when the entry was read): the newest label / sighting / exit / scan behind it.
 */
export function devRows(e: DevEntry, now: number = e.at): Array<[string, string, 'ok' | 'warn' | 'bad' | 'na']> {
  const rows: Array<[string, string, 'ok' | 'warn' | 'bad' | 'na']> = [];
  const r = e.report;
  const rugLevel = (): 'ok' | 'warn' | 'bad' | 'na' => !r || r.labelled.n === 0 ? 'na' : r.serialRugger ? 'bad' : r.labelled.rug > 0 || (r.badRate ?? 0) >= 0.5 ? 'warn' : 'ok';
  rows.push(['Dev rugs', r && r.labelled.n ? `${r.labelled.rug}/${r.labelled.n} · n=${r.labelled.n} · rec ${ageAt(r.labelled.newestT, now)}` : 'unknown', rugLevel()]);
  rows.push(['Dev launches', r && r.status === 'ok' ? `n=${r.launches.n} · rec ${ageAt(r.launches.newestT, now)} · dev:${linkTag(e.creator?.source)}` : 'unknown', 'na']);
  if (r && r.devExit.n) rows.push(['Dev sold bag', `med ${Math.round(r.devExit.medianMin!)}m · n=${r.devExit.n} · rec ${ageAt(r.devExit.newestT, now)}`, r.devExit.medianMin! <= 60 ? 'warn' : 'ok']);
  const l = e.linked;
  if (l && (l.fundedBy || l.cluster)) {
    const scan = `scan ${ageAt(l.at, now)}`;
    rows.push(['Dev linked', l.cluster ? `${l.cluster.kind} ${l.cluster.members}w · ${scan}` : `funded by ${shortAddr(l.fundedBy)} · ${scan}`, 'na']);
    if (l.linkedCreators) rows.push(['Linked dev rugs', `${l.linkedRugs} · n=${l.linkedCreators} devs · rec ${ageAt(l.linkedNewestT, now)}`, l.linkedRugs > 0 ? 'bad' : 'na']);
  }
  return rows;
}

/** The app's one book (created on first use), reading the live recorder's DB. Null when there is no recorder. */
export function devBookOf(state: { devBook?: DevHistoryBook; live?: { recorder?: { readonly database?: DatabaseSync } | null } | null }): DevHistoryBook | null {
  if (!state.live?.recorder) return null;
  if (!state.devBook) { const live = state.live; state.devBook = new DevHistoryBook(() => live?.recorder?.database ?? null); }
  return state.devBook;
}
