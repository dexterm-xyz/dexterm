// LARP detector — keyless X account lookup (task-1471). Read-only, no login, no cookies, no X API key.
//
// Why a fallback chain: measured 2026-10-19 (handoff evidence x-repro.md), FxTwitter answers `404 User not found`
// for accounts that exist on roughly one call in six, a missing handle gets a 302 to the project's GitHub page on
// some calls, and "suspended" is reported only some of the time. vxtwitter serves a cached copy (its own
// `fetched_on`, up to about a day old). X's own oEmbed endpoint says exists / missing and the canonical handle, and
// nothing else. The X syndication timeline (429 / empty) and the Nitter-class mirrors (offline, suspended, or a 200
// "offline" page) gave nothing usable and are not in the chain.
//
// So no single answer is a verdict: `active` needs one source returning the profile; `suspended` needs a source
// saying so; `not_found` needs TWO independent sources (vxtwitter AND oEmbed) saying missing; anything else is
// `unavailable`. Every field that could not be read is listed in `unavailable` and is never guessed.
//
// Politeness: one handle per user action, at most five calls, a per-host spacing limiter, a TTL cache, and a
// circuit breaker per source (the shared HealthRegistry: 3 failures or 2× 429 in a minute → degraded, 30 s..10 min
// backoff). The bio is untrusted text: the caller firewalls it before it reaches a model.

import { HealthRegistry } from '../health.ts';
import { systemClock, type Clock } from '../clock.ts';
import type { SourceId } from '../model.ts';
import { parseHttpUrl } from './links.ts';

export type XLinkKind = 'profile' | 'status' | 'community' | 'other';
export type XAccountStatus = 'active' | 'suspended' | 'not_found' | 'unavailable';
export type XSourceName = 'fxtwitter' | 'vxtwitter' | 'x-oembed';

/** A minimal fetcher: the HTTP status and body; redirects must NOT be followed (a 3xx is evidence). */
export type XFetch = (url: string) => Promise<{ status: number; body: string }>;

export interface XSourceTrace { source: XSourceName; endpoint: 'profile' | 'statuses' | 'status' | 'oembed'; status: number | null; result: string; ms: number }

export interface XAccountReport {
  /** The advertised X link as given. */
  url: string;
  kind: XLinkKind;
  /** The handle in the advertised link (null for a community/other link). */
  handle: string | null;
  status: XAccountStatus;
  /** The account's current screen name as a source returned it (case can differ from the link). */
  screenName: string | null;
  id: string | null;
  /** The status link's post was written by a different handle than the link shows (rename or a borrowed post). */
  renamed: { from: string; to: string; evidence: string } | null;
  createdAt: string | null;
  ageDays: number | null;
  followers: number | null;
  following: number | null;
  tweets: number | null;
  lastPostAt: string | null;
  daysSinceLastPost: number | null;
  /** The bio (untrusted; firewall before use), capped. */
  bio: string | null;
  /** The account's own website field (host only compared). */
  website: string | null;
  bioMentionsToken: boolean | null;
  /** The account's bio or website field names the coin's website host. */
  linksSite: boolean | null;
  /** When the counts were read: now for FxTwitter, vxtwitter's own `fetched_on` for its cached copy. */
  countsAsOf: string | null;
  countsSource: XSourceName | null;
  /** Every field that could not be read (missing data, never scored as clean). */
  unavailable: string[];
  sources: XSourceTrace[];
  cached: boolean;
  fetchedAt: string;
}

export interface XLookupContext {
  symbol?: string | null;
  name?: string | null;
  mint?: string | null;
  /** The coin's advertised website, to check the account's cross-link back. */
  website?: string | null;
}

export interface XLookupOptions {
  fetch: XFetch;
  clock?: Clock;
  health?: HealthRegistry;
  /** Minimum spacing between two calls to the same host (default 1000 ms). */
  minIntervalMs?: number;
  /** Cache TTL for a found/suspended/not_found result (default 30 min) and for `unavailable` (default 10 min). */
  ttlMs?: number;
  ttlUnavailableMs?: number;
  /** Max cached handles (LRU-ish; default 500). */
  maxEntries?: number;
}

const RESERVED = new Set(['i', 'home', 'search', 'intent', 'hashtag', 'share', 'explore', 'settings', 'messages', 'notifications', 'login', 'signup', 'tos', 'privacy', 'compose']);
const HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const X_HOSTS = new Set(['x.com', 'twitter.com', 'mobile.twitter.com', 'mobile.x.com', 'fxtwitter.com', 'vxtwitter.com', 'fixupx.com', 'nitter.net']);
const SOURCE_ID: Record<XSourceName, SourceId> = { fxtwitter: 'fxtwitter', vxtwitter: 'vxtwitter', 'x-oembed': 'x-oembed' };
const HOST: Record<XSourceName, string> = { fxtwitter: 'api.fxtwitter.com', vxtwitter: 'api.vxtwitter.com', 'x-oembed': 'publish.x.com' };

/** Parse an advertised X link into its kind, handle and status id. Pure. */
export function parseXLink(raw: string): { kind: XLinkKind; handle: string | null; statusId: string | null } {
  const u = parseHttpUrl(raw);
  if (!u) return { kind: 'other', handle: null, statusId: null };
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (!X_HOSTS.has(host)) return { kind: 'other', handle: null, statusId: null };
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts[0]?.toLowerCase() === 'i' && parts[1]?.toLowerCase() === 'communities') return { kind: 'community', handle: null, statusId: null };
  const h = parts[0] ?? '';
  if (!HANDLE.test(h) || RESERVED.has(h.toLowerCase())) return { kind: 'other', handle: null, statusId: null };
  if (parts[1]?.toLowerCase() === 'status' && /^\d{1,25}$/.test(parts[2] ?? '')) return { kind: 'status', handle: h, statusId: parts[2] };
  return { kind: parts.length === 1 ? 'profile' : 'other', handle: h, statusId: null };
}

const json = (body: string): Record<string, unknown> | null => {
  try { const v: unknown = JSON.parse(body); return v && typeof v === 'object' ? (v as Record<string, unknown>) : null; } catch { return null; }
};
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const iso = (v: unknown): string | null => { const t = typeof v === 'string' ? Date.parse(v) : NaN; return Number.isFinite(t) ? new Date(t).toISOString() : null; };
const days = (now: number, at: string | null): number | null => (at ? Math.max(0, Math.floor((now - Date.parse(at)) / 86_400_000)) : null);
const bareHost = (raw: string | null | undefined): string | null => { const u = raw ? parseHttpUrl(raw) : null; return u ? u.hostname.toLowerCase().replace(/^www\./, '') : null; };

function mentionsToken(bio: string, ctx: XLookupContext): boolean | null {
  const sym = (ctx.symbol ?? '').trim();
  const name = (ctx.name ?? '').trim();
  if (!sym && !name && !ctx.mint) return null;
  const b = bio.toLowerCase();
  if (ctx.mint && bio.includes(ctx.mint)) return true;
  if (sym.length >= 2 && new RegExp(`(^|[^a-z0-9])\\$?${sym.toLowerCase().replace(/[^a-z0-9]/g, '')}([^a-z0-9]|$)`).test(b)) return true;
  if (name.length >= 3 && b.includes(name.toLowerCase())) return true;
  return false;
}

interface Profile { screenName: string | null; id: string | null; createdAt: string | null; followers: number | null; following: number | null; tweets: number | null; bio: string | null; website: string | null; asOf: string | null }

/** The lookup service: chain + cache + spacing + circuit breakers. One instance per process. */
export class XAccountLookup {
  private readonly fetchImpl: XFetch;
  private readonly clock: Clock;
  readonly health: HealthRegistry;
  private readonly minIntervalMs: number;
  private readonly ttlMs: number;
  private readonly ttlUnavailableMs: number;
  private readonly maxEntries: number;
  private readonly cache = new Map<string, { at: number; report: XAccountReport }>();
  private readonly lastCall = new Map<string, Promise<void>>();

  constructor(opts: XLookupOptions) {
    this.fetchImpl = opts.fetch;
    this.clock = opts.clock ?? systemClock;
    this.health = opts.health ?? new HealthRegistry({ clock: this.clock });
    this.minIntervalMs = opts.minIntervalMs ?? 1000;
    this.ttlMs = opts.ttlMs ?? 30 * 60_000;
    this.ttlUnavailableMs = opts.ttlUnavailableMs ?? 10 * 60_000;
    this.maxEntries = opts.maxEntries ?? 500;
  }

  /** Per-host spacing: calls to one host are serialized at least minIntervalMs apart. */
  private async spaced<T>(host: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.lastCall.get(host) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => { release = r; });
    this.lastCall.set(host, prev.then(() => mine));
    await prev;
    try { return await fn(); } finally {
      if (this.minIntervalMs > 0) void this.clock.sleep(this.minIntervalMs).then(release); else release();
    }
  }

  private async get(source: XSourceName, endpoint: XSourceTrace['endpoint'], url: string, trace: XSourceTrace[]): Promise<{ status: number; body: string; ms: number } | null> {
    const sid = SOURCE_ID[source];
    if (!this.health.isAvailable(sid)) { trace.push({ source, endpoint, status: null, result: 'skipped: circuit open (source degraded)', ms: 0 }); return null; }
    const t0 = this.clock.now();
    try {
      const r = await this.spaced(HOST[source], () => this.fetchImpl(url));
      const ms = this.clock.now() - t0;
      // 404 / 3xx are answers (a vote), not source failures; 429 and 5xx other than vxtwitter's suspended body are.
      const failed = r.status === 0 || r.status === 429 || (r.status >= 500 && !/suspended/i.test(r.body));
      this.health.record(sid, failed ? { ok: false, status: r.status, latencyMs: ms, error: `http ${r.status}` } : { ok: true, status: r.status, latencyMs: ms });
      return { status: r.status, body: r.body, ms };
    } catch (e) {
      const ms = this.clock.now() - t0;
      this.health.record(sid, { ok: false, latencyMs: ms, error: (e as Error).message });
      trace.push({ source, endpoint, status: null, result: `error: ${(e as Error).message}`.slice(0, 120), ms });
      return null;
    }
  }

  /** Look up the account behind an advertised X link. Never throws. */
  async lookup(xUrl: string, ctx: XLookupContext = {}): Promise<XAccountReport> {
    const link = parseXLink(xUrl);
    const now = this.clock.now();
    const key = `${link.handle?.toLowerCase() ?? xUrl}|${link.statusId ?? ''}|${(ctx.symbol ?? '').toLowerCase()}|${(ctx.name ?? '').toLowerCase()}|${ctx.mint ?? ''}|${bareHost(ctx.website) ?? ''}`;
    const hit = this.cache.get(key);
    if (hit && now - hit.at < (hit.report.status === 'unavailable' ? this.ttlUnavailableMs : this.ttlMs)) return { ...hit.report, cached: true };
    const report = await this.uncached(xUrl, link, ctx);
    this.cache.delete(key);
    this.cache.set(key, { at: now, report });
    while (this.cache.size > this.maxEntries) this.cache.delete(this.cache.keys().next().value as string);
    return report;
  }

  private async uncached(url: string, link: ReturnType<typeof parseXLink>, ctx: XLookupContext): Promise<XAccountReport> {
    const now = this.clock.now();
    const trace: XSourceTrace[] = [];
    const base: XAccountReport = {
      url, kind: link.kind, handle: link.handle, status: 'unavailable', screenName: null, id: null, renamed: null,
      createdAt: null, ageDays: null, followers: null, following: null, tweets: null, lastPostAt: null, daysSinceLastPost: null,
      bio: null, website: null, bioMentionsToken: null, linksSite: null, countsAsOf: null, countsSource: null,
      unavailable: [], sources: trace, cached: false, fetchedAt: new Date(now).toISOString(),
    };
    if (!link.handle) {
      base.unavailable = ['account (the X link is not an account or a post)'];
      return base;
    }
    let h = link.handle;
    // A status link: who wrote the post now. A different author means a renamed account or a borrowed post.
    if (link.statusId) {
      const r = await this.get('fxtwitter', 'status', `https://api.fxtwitter.com/${h}/status/${link.statusId}`, trace);
      const j = r ? json(r.body) : null;
      const author = str((j?.tweet as { author?: { screen_name?: unknown } } | undefined)?.author?.screen_name);
      if (r) trace.push({ source: 'fxtwitter', endpoint: 'status', status: r.status, result: author ? `post by @${author}` : `no post (${str(j?.message) ?? r.status})`, ms: r.ms });
      if (author && author.toLowerCase() !== h.toLowerCase()) {
        base.renamed = { from: h, to: author, evidence: `the linked post ${link.statusId} is now shown under @${author}` };
        h = author;
      }
    }
    let profile: Profile | null = null;
    let suspended = false;
    let missingVotes = 0;
    const missingBy: string[] = [];

    // 1) FxTwitter profile: fresh counts. A 404 is one vote only (measured false 404s).
    const fx = await this.get('fxtwitter', 'profile', `https://api.fxtwitter.com/${h}`, trace);
    if (fx) {
      const j = json(fx.body);
      const u = j?.user as Record<string, unknown> | undefined;
      if (fx.status === 200 && u) {
        profile = { screenName: str(u.screen_name), id: str(u.id), createdAt: iso(u.joined), followers: num(u.followers), following: num(u.following), tweets: num(u.tweets), bio: typeof u.description === 'string' ? u.description : null, website: str((u.website as { url?: unknown } | null | undefined)?.url), asOf: new Date(now).toISOString() };
        trace.push({ source: 'fxtwitter', endpoint: 'profile', status: 200, result: 'profile', ms: fx.ms });
      } else if (str(j?.reason) === 'suspended') { suspended = true; trace.push({ source: 'fxtwitter', endpoint: 'profile', status: fx.status, result: 'suspended', ms: fx.ms }); }
      else { trace.push({ source: 'fxtwitter', endpoint: 'profile', status: fx.status, result: fx.status >= 300 && fx.status < 400 ? 'redirect (missing handle or error page)' : `no profile (${str(j?.message) ?? fx.status})`, ms: fx.ms }); }
    }
    // 2) vxtwitter: cached copy; says suspended / missing reliably in the probe.
    if (!profile) {
      const vx = await this.get('vxtwitter', 'profile', `https://api.vxtwitter.com/${h}`, trace);
      if (vx) {
        const j = json(vx.body);
        if (vx.status === 200 && j && str(j.screen_name)) {
          const fetchedOn = num(j.fetched_on);
          profile = { screenName: str(j.screen_name), id: j.id === undefined || j.id === null ? null : String(j.id), createdAt: iso(j.created_at), followers: num(j.followers_count), following: num(j.following_count), tweets: num(j.tweet_count), bio: typeof j.description === 'string' ? j.description : null, website: null, asOf: fetchedOn ? new Date(fetchedOn * 1000).toISOString() : null };
          trace.push({ source: 'vxtwitter', endpoint: 'profile', status: 200, result: 'profile (cached copy)', ms: vx.ms });
        } else if (/suspended/i.test(str(j?.error) ?? '')) { suspended = true; trace.push({ source: 'vxtwitter', endpoint: 'profile', status: vx.status, result: 'suspended', ms: vx.ms }); }
        else if (vx.status === 404) { missingVotes++; missingBy.push('vxtwitter'); trace.push({ source: 'vxtwitter', endpoint: 'profile', status: 404, result: 'not found', ms: vx.ms }); }
        else trace.push({ source: 'vxtwitter', endpoint: 'profile', status: vx.status, result: 'no answer', ms: vx.ms });
      }
    }
    // 3) X oEmbed: exists vs missing (200 for a suspended account too).
    let oembedExists: boolean | null = null;
    if (!profile && !suspended) {
      const oe = await this.get('x-oembed', 'oembed', `https://publish.x.com/oembed?url=${encodeURIComponent(`https://x.com/${h}`)}`, trace);
      if (oe) {
        const j = json(oe.body);
        if (oe.status === 200 && j) { oembedExists = true; trace.push({ source: 'x-oembed', endpoint: 'oembed', status: 200, result: 'exists', ms: oe.ms }); }
        else if (oe.status === 404) { oembedExists = false; missingVotes++; missingBy.push('x-oembed'); trace.push({ source: 'x-oembed', endpoint: 'oembed', status: 404, result: 'not found', ms: oe.ms }); }
        else trace.push({ source: 'x-oembed', endpoint: 'oembed', status: oe.status, result: 'no answer', ms: oe.ms });
      }
    }
    // 4) Last post date (FxTwitter statuses), only for an account that exists.
    let lastPostAt: string | null = null;
    let postsRead = false;
    if (profile) {
      const st = await this.get('fxtwitter', 'statuses', `https://api.fxtwitter.com/2/profile/${h}/statuses`, trace);
      const j = st ? json(st.body) : null;
      const results = Array.isArray(j?.results) ? (j.results as Array<{ created_at?: unknown }>) : null;
      if (st?.status === 200 && results) {
        postsRead = true;
        const times = results.map((r) => iso(r.created_at)).filter((t): t is string => !!t).sort();
        lastPostAt = times.at(-1) ?? null;
        trace.push({ source: 'fxtwitter', endpoint: 'statuses', status: 200, result: `${results.length} recent posts`, ms: st!.ms });
      } else if (st) trace.push({ source: 'fxtwitter', endpoint: 'statuses', status: st.status, result: 'posts unavailable', ms: st.ms });
    }

    const out: XAccountReport = { ...base };
    if (profile) {
      out.status = 'active';
      Object.assign(out, {
        screenName: profile.screenName, id: profile.id, createdAt: profile.createdAt, ageDays: days(now, profile.createdAt),
        followers: profile.followers, following: profile.following, tweets: profile.tweets,
        bio: profile.bio !== null ? profile.bio.slice(0, 280) : null, website: profile.website,
        countsAsOf: profile.asOf, countsSource: trace.find((t) => t.endpoint === 'profile' && t.status === 200)?.source ?? null,
        lastPostAt, daysSinceLastPost: days(now, lastPostAt),
      });
      // A posts list that came back empty for an account with zero tweets is "no posts", not missing.
      if (postsRead && !lastPostAt && profile.tweets === 0) out.daysSinceLastPost = null;
      out.bioMentionsToken = profile.bio !== null ? mentionsToken(profile.bio, ctx) : null;
      const site = bareHost(ctx.website);
      if (site) {
        const bioHit = (profile.bio ?? '').toLowerCase().includes(site);
        const webHit = bareHost(profile.website) === site;
        out.linksSite = bioHit || webHit ? true : (profile.website !== null || profile.bio !== null) ? false : null;
      }
    } else if (suspended) out.status = 'suspended';
    else if (missingVotes >= 2) out.status = 'not_found';
    else if (oembedExists) out.status = 'unavailable'; // exists per X, but no source returned the profile
    const miss: string[] = [];
    if (out.status !== 'active') {
      if (out.status === 'unavailable') miss.push(`account status (${missingBy.length ? `only ${missingBy.join(' + ')} said missing; ` : ''}no source returned the profile)`);
    } else {
      if (out.createdAt === null) miss.push('account created date');
      if (out.followers === null) miss.push('follower count');
      if (out.following === null) miss.push('following count');
      if (out.tweets === null) miss.push('post count');
      if (!postsRead) miss.push('last post date');
      if (out.bio === null) miss.push('bio');
      if (ctx.website && out.linksSite === null) miss.push('site cross-link');
      if (out.bioMentionsToken === null && (ctx.symbol || ctx.name)) miss.push('bio mentions the token');
    }
    out.unavailable = miss;
    return out;
  }
}

/** Advertised handles per source, and whether they and the site's own X links agree. Pure. */
export function xHandleAgreement(advertised: Array<{ url: string; source: string }>, siteLinks: string[] | null): {
  handles: Array<{ handle: string; source: string }>;
  agree: boolean | null;
  /** The website's own X profile links include the advertised handle (null: no site links read, or none on the page). */
  siteAgrees: boolean | null;
  siteHandles: string[] | null;
  siteLinksAdvertised: boolean | null;
  note: string | null;
} {
  const handles = advertised.map((l) => ({ h: parseXLink(l.url), source: l.source })).filter((x) => x.h.handle).map((x) => ({ handle: x.h.handle as string, source: x.source }));
  const distinct = [...new Set(handles.map((x) => x.handle.toLowerCase()))];
  const siteHandles = siteLinks === null ? null : [...new Set(siteLinks.map((u) => parseXLink(u)).filter((x) => x.kind === 'profile' && x.handle).map((x) => (x.handle as string).toLowerCase()))];
  const siteLinksAdvertised = siteHandles === null || !distinct.length ? null : siteHandles.length === 0 ? false : siteHandles.some((s) => distinct.includes(s));
  const agree = distinct.length === 0 ? null : distinct.length === 1 && (siteHandles === null || siteHandles.length === 0 || siteHandles.includes(distinct[0]));
  const siteAgrees = !distinct.length || !siteHandles?.length ? null : siteHandles.some((s) => distinct.includes(s));
  const note = distinct.length > 1 ? `sources advertise different X accounts: ${distinct.map((d) => `@${d}`).join(', ')}`
    : agree === false && siteHandles?.length ? `the website links @${siteHandles.join(', @')} but the token lists @${distinct[0]}` : null;
  return { handles, agree, siteAgrees, siteHandles, siteLinksAdvertised, note };
}
