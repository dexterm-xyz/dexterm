// LARP score (task-1471): a 0-100 summary of the LARP check's flags. Pure, offline, deterministic.
//
// What it is: the transparent SUM of named flags, each with its points and the evidence that raised it. Higher
// means more of the things that go with LARP coins showed up. It is evidence, not a verdict: every flag can be
// innocent on its own, and the score never says a coin is fake, safe or worth anything.
//
// Missing data never lowers the score and is never scored as clean. A flag whose evidence could not be read (page
// blocked, RDAP down, the X sources unavailable) goes to `missing` with the points it COULD have added, and the
// range `[score, score + those points]` (and its band range) widens instead.
//
// Where the points come from (LARP_SCORE_WEIGHTS[*].source):
//  - `calibrated`: the link-shape flags, fitted on the TRAIN split of the task-1401 eval set (1054 coins, 72 h
//    outcome labels; packages/packs/src/larp-score-backtest.ts). points = clamp(round(8 × ln odds ratio of a bad
//    outcome), 0, 12), using the flag only when ≥ 20 train coins carry it. The cap keeps link shape alone in the
//    `medium` band at most: the larp-check skill never calls a coin LARP from links alone.
//  - `prior`: page, domain, GitHub and X-account flags. The eval set does not hold that evidence point-in-time (the
//    pages are gone or changed, and a deleted X account after a coin dies would leak the outcome), so these are
//    pre-registered weights written from the skill text before any data, and are labelled as such everywhere.

import type { LinkFeatures, LinkSignal } from './link-baseline.ts';
import { linkSignals } from './link-baseline.ts';
import type { XAccountReport } from './x-account.ts';

export const LARP_SCORE_MODEL = 'larp-score-v1';

export type LarpFlagGroup = 'links' | 'website' | 'domain' | 'github' | 'x';
export type LarpFlagId =
  | 'no_website' | 'no_x' | 'x_not_account' | 'no_telegram' | 'site_is_social' | 'site_is_launchpad' | 'site_linktree'
  | 'site_free_host' | 'domain_no_name_match' | 'cheap_tld' | 'links_mismatch'
  | 'default_page' | 'wallet_connect' | 'drainer_markers' | 'never_names_token'
  | 'domain_new' | 'domain_privacy'
  | 'no_github' | 'github_archived' | 'github_fork' | 'github_stale'
  | 'x_suspended' | 'x_not_found' | 'x_account_days_old' | 'x_account_new' | 'x_tiny_following' | 'x_no_posts'
  | 'x_handle_mismatch' | 'x_renamed' | 'x_no_site_link';

export interface LarpWeight { group: LarpFlagGroup; label: string; points: number; source: 'calibrated' | 'prior' }

/**
 * The shipped weights. The `calibrated` rows are asserted equal to a fresh fit on the committed eval set
 * (packages/packs/test/larp-score-1471.test.ts), so a re-tune cannot ship stale points.
 */
export const LARP_SCORE_WEIGHTS: Record<LarpFlagId, LarpWeight> = {
  // links (DexScreener / Jupiter advertised links): calibrated where the eval set had ≥ 20 train coins.
  no_website: { group: 'links', label: 'no website advertised', points: 9, source: 'calibrated' },
  no_x: { group: 'links', label: 'no X account advertised', points: 10, source: 'calibrated' },
  x_not_account: { group: 'links', label: 'X link is a single post or a community, not an account', points: 5, source: 'calibrated' },
  no_telegram: { group: 'links', label: 'no Telegram advertised', points: 12, source: 'calibrated' },
  site_is_social: { group: 'links', label: 'the "website" is a social page', points: 1, source: 'calibrated' },
  domain_no_name_match: { group: 'links', label: "the website's domain does not name the token", points: 0, source: 'calibrated' },
  cheap_tld: { group: 'links', label: 'website on a throwaway-priced TLD', points: 0, source: 'calibrated' },
  site_is_launchpad: { group: 'links', label: 'the "website" is a launchpad/explorer page', points: 4, source: 'prior' },
  site_linktree: { group: 'links', label: 'the "website" is a link hub', points: 2, source: 'prior' },
  site_free_host: { group: 'links', label: 'website on a free/site-builder host', points: 2, source: 'prior' },
  links_mismatch: { group: 'links', label: 'sources advertise different sites or X accounts', points: 8, source: 'prior' },
  // website (one SSRF-safe fetch, no JavaScript)
  drainer_markers: { group: 'website', label: 'wallet-drainer markers on the page', points: 30, source: 'prior' },
  default_page: { group: 'website', label: 'website is a default/placeholder page', points: 15, source: 'prior' },
  wallet_connect: { group: 'website', label: 'website asks to connect a wallet', points: 8, source: 'prior' },
  never_names_token: { group: 'website', label: 'website never names the token', points: 8, source: 'prior' },
  // domain (RDAP)
  domain_new: { group: 'domain', label: 'domain registered under 30 days ago', points: 8, source: 'prior' },
  domain_privacy: { group: 'domain', label: 'domain behind registrant privacy', points: 2, source: 'prior' },
  // GitHub (keyless API)
  no_github: { group: 'github', label: 'no GitHub repo advertised', points: 2, source: 'prior' },
  github_archived: { group: 'github', label: 'GitHub repo is archived', points: 4, source: 'prior' },
  github_fork: { group: 'github', label: 'GitHub repo is a fork', points: 4, source: 'prior' },
  github_stale: { group: 'github', label: 'GitHub repo not pushed in 180+ days', points: 4, source: 'prior' },
  // X account (keyless lookup chain)
  x_suspended: { group: 'x', label: 'X account is suspended', points: 20, source: 'prior' },
  x_not_found: { group: 'x', label: 'X account does not exist', points: 15, source: 'prior' },
  x_account_days_old: { group: 'x', label: 'X account under 7 days old', points: 12, source: 'prior' },
  x_account_new: { group: 'x', label: 'X account under 30 days old', points: 6, source: 'prior' },
  x_tiny_following: { group: 'x', label: 'X account has under 50 followers', points: 5, source: 'prior' },
  x_no_posts: { group: 'x', label: 'X account has no posts in 30 days', points: 6, source: 'prior' },
  x_handle_mismatch: { group: 'x', label: "the website's X link and the advertised X account differ", points: 10, source: 'prior' },
  x_renamed: { group: 'x', label: 'the linked X post is now under another handle', points: 5, source: 'prior' },
  x_no_site_link: { group: 'x', label: "the X account's bio/website does not link the coin's site", points: 3, source: 'prior' },
};

/** Band thresholds (pre-registered round numbers; their measured precision is in LARP_SCORE_MEASURED). */
export const LARP_SCORE_BANDS = { medium: 25, high: 50 } as const;
export type LarpBand = 'low' | 'medium' | 'high';
export const bandOf = (score: number): LarpBand => (score >= LARP_SCORE_BANDS.high ? 'high' : score >= LARP_SCORE_BANDS.medium ? 'medium' : 'low');

/**
 * Held-out TEST-split numbers for the link-shape part of the score (the only part the eval set can replay),
 * from packages/packs/eval/larp-score-backtest.json (`dexterm backtest --subject larp-score`). A test asserts these match the committed report.
 */
export const LARP_SCORE_MEASURED = {
  model: LARP_SCORE_MODEL,
  eval: 'task-1401 eval set (built 2026-10-16), 72h outcome labels, bad = rug or dead',
  part: 'link-shape flags only (page, domain, GitHub and X-account flags cannot be replayed on history)',
  test: { n: 328, bad: 61, auroc: 0.691, by_band: { low: { n: 218, bad: 27 }, medium: { n: 110, bad: 34 }, high: { n: 0, bad: 0 } } },
  train: { n: 726, bad: 294, auroc: 0.727 },
} as const;

export interface LarpPageEvidence { ok: true; defaultPage: boolean; walletConnect: boolean; drainerFlags: string[]; mentionsSymbol: boolean | null; mentionsName: boolean | null; links?: string[] }
export interface LarpUnread { ok: false; reason: string }

/** The evidence larp_check gathered, normalized. `null` = not applicable (e.g. no website to fetch). */
export interface LarpEvidence {
  /** `token`: links came from the coin's listings; `url`: a single site was vetted directly (no link flags). */
  mode: 'token' | 'url';
  link: LinkFeatures | null;
  mismatch: string[];
  website: string | null;
  page: LarpPageEvidence | LarpUnread | null;
  domain: { ok: true; ageDays: number | null; privacy: boolean | null } | LarpUnread | null;
  /** `'none'` = no repo advertised. */
  github: { ok: true; archived: boolean | null; fork: boolean | null; daysSincePush: number | null } | LarpUnread | 'none' | null;
  x: XAccountReport | null;
  /**
   * Whether the website's own X links include the advertised handle (xHandleAgreement). Only `siteAgrees` scores:
   * sources that advertise different X accounts are already the `links_mismatch` flag.
   */
  xAgreement: { agree: boolean | null; siteAgrees?: boolean | null; note: string | null } | null;
  /**
   * Evidence groups this surface does not check at all (the web checker reads link shape only). Each becomes a
   * `missing` entry with the group's full points, so the range shows what a full check could still add.
   */
  notChecked?: Array<{ group: 'website' | 'domain' | 'github' | 'x'; why: string }>;
}

export interface LarpFlag { id: LarpFlagId; group: LarpFlagGroup; label: string; points: number; weight: 'calibrated' | 'prior'; evidence: string }
export interface LarpMissing { id: LarpFlagId | `${LarpFlagGroup}:*`; group: LarpFlagGroup; what: string; maxPoints: number }

export interface LarpScore {
  model: typeof LARP_SCORE_MODEL;
  score: number;
  band: LarpBand;
  /** The score if every missing piece had come back as a flag: the uncertainty, never subtracted. */
  range: { lo: number; hi: number; bandLo: LarpBand; bandHi: LarpBand };
  thresholds: { medium: number; high: number };
  flags: LarpFlag[];
  /** The three biggest contributors (what the share card shows). */
  top: LarpFlag[];
  missing: LarpMissing[];
  measured: string;
  caveat: string;
}

const W = LARP_SCORE_WEIGHTS;
const LINK_FLAG: Record<LinkSignal, LarpFlagId> = {
  site_is_social: 'site_is_social', site_is_launchpad: 'site_is_launchpad', site_linktree: 'site_linktree', site_free_host: 'site_free_host',
  site_no_name_match: 'domain_no_name_match', cheap_tld: 'cheap_tld', x_not_profile: 'x_not_account', no_x: 'no_x', no_tg: 'no_telegram',
};

/** The link-shape flags of a feature set (shared by the live score and the backtest, so both score the same thing). */
export function linkFlagIds(f: LinkFeatures): LarpFlagId[] {
  const ids: LarpFlagId[] = linkSignals(f).map((s) => LINK_FLAG[s]);
  if (f.web === 'none') ids.unshift('no_website');
  return ids;
}

/** Sum the link-shape points only (what the backtest scores). */
export function linkScore(f: LinkFeatures, weights: Partial<Record<LarpFlagId, number>> = {}): number {
  return Math.min(100, linkFlagIds(f).reduce((a, id) => a + (weights[id] ?? W[id].points), 0));
}

/** Compute the LARP score from the gathered evidence. Pure. */
export function larpScore(ev: LarpEvidence): LarpScore {
  const flags: LarpFlag[] = [];
  const missing: LarpMissing[] = [];
  // A flag fitted to 0 points (it did not go with bad outcomes) is not listed: it would add nothing but noise.
  const add = (id: LarpFlagId, evidence: string) => { const w = W[id]; if (w.points > 0) flags.push({ id, group: w.group, label: w.label, points: w.points, weight: w.source, evidence }); };
  const miss = (id: LarpMissing['id'], group: LarpFlagGroup, what: string, maxPoints: number) => { if (maxPoints > 0) missing.push({ id, group, what, maxPoints }); };
  const pts = (...ids: LarpFlagId[]) => ids.reduce((a, id) => a + W[id].points, 0);

  if (ev.mode === 'token' && ev.link) {
    const why: Partial<Record<LarpFlagId, string>> = {
      no_website: 'DexScreener/Jupiter list no website', no_x: 'DexScreener/Jupiter list no X link', no_telegram: 'DexScreener/Jupiter list no Telegram link',
      x_not_account: `the advertised X link is a ${ev.link.x === 'status' ? 'single post' : ev.link.x === 'community' ? 'community' : 'non-account page'}`,
      site_is_social: 'the advertised website is a social-network page', site_is_launchpad: 'the advertised website is a launchpad/explorer page',
      site_linktree: 'the advertised website is a link hub', site_free_host: 'the advertised website is on a free/site-builder host',
      domain_no_name_match: 'neither the symbol nor the name appears in the domain', cheap_tld: 'the domain is on a throwaway-priced TLD',
    };
    for (const id of linkFlagIds(ev.link)) add(id, why[id] ?? W[id].label);
  }
  if (ev.mismatch.length) add('links_mismatch', ev.mismatch.join('; '));

  // website page
  if (ev.website) {
    const p = ev.page;
    if (!p || !p.ok) miss('website:*', 'website', `website page not read${p && !p.ok ? ` (${p.reason})` : ''}`, pts('drainer_markers', 'default_page', 'wallet_connect', 'never_names_token'));
    else {
      if (p.drainerFlags.length) add('drainer_markers', `markers: ${p.drainerFlags.slice(0, 3).join(', ')}`);
      if (p.defaultPage) add('default_page', 'the page matches a default/placeholder template');
      if (p.walletConnect) add('wallet_connect', 'the page carries a wallet-connect prompt');
      if (p.mentionsSymbol === false && p.mentionsName === false) add('never_names_token', 'neither the symbol nor the name appears in the page text');
      else if (p.mentionsSymbol === null && p.mentionsName === null) miss('never_names_token', 'website', 'whether the page names the token (no symbol/name to look for)', W.never_names_token.points);
    }
    const d = ev.domain;
    if (!d || !d.ok) miss('domain:*', 'domain', `domain registration not read${d && !d.ok ? ` (${d.reason})` : ''}`, pts('domain_new', 'domain_privacy'));
    else {
      if (typeof d.ageDays === 'number' && d.ageDays < 30) add('domain_new', `registered ${d.ageDays} days ago (RDAP)`);
      else if (d.ageDays === null) miss('domain_new', 'domain', 'domain registration date', W.domain_new.points);
      if (d.privacy === true) add('domain_privacy', 'the RDAP registrant contact is redacted');
      else if (d.privacy === null) miss('domain_privacy', 'domain', 'registrant privacy', W.domain_privacy.points);
    }
  }

  // GitHub
  const g = ev.github;
  if (g === 'none') { if (ev.mode === 'token') add('no_github', 'no github.com repo link among the advertised links or on the fetched page'); }
  else if (g && !g.ok) miss('github:*', 'github', `GitHub repo not read (${g.reason})`, pts('github_archived', 'github_fork', 'github_stale'));
  else if (g) {
    if (g.archived) add('github_archived', 'the GitHub API marks the repo archived');
    if (g.fork) add('github_fork', 'the GitHub API marks the repo a fork');
    if (typeof g.daysSincePush === 'number' && g.daysSincePush > 180) add('github_stale', `last push ${g.daysSincePush} days ago`);
  }

  // X account
  const x = ev.x;
  if (x && x.handle) {
    const at = `@${x.screenName ?? x.handle}`;
    if (x.status === 'suspended') add('x_suspended', `${at}: an X lookup source reports the account suspended`);
    else if (x.status === 'not_found') add('x_not_found', `@${x.handle}: two independent sources (vxtwitter, X oEmbed) found no such account`);
    else if (x.status === 'unavailable') miss('x:*', 'x', `X account not read (${x.unavailable[0] ?? 'every source failed'})`, Math.max(pts('x_suspended'), pts('x_account_days_old', 'x_tiny_following', 'x_no_posts', 'x_no_site_link')));
    else {
      if (typeof x.ageDays === 'number' && x.ageDays < 7) add('x_account_days_old', `${at} created ${x.createdAt?.slice(0, 10)} (${x.ageDays} days ago)`);
      else if (typeof x.ageDays === 'number' && x.ageDays < 30) add('x_account_new', `${at} created ${x.createdAt?.slice(0, 10)} (${x.ageDays} days ago)`);
      else if (x.ageDays === null) miss('x_account_days_old', 'x', 'X account created date', W.x_account_days_old.points);
      if (typeof x.followers === 'number' && x.followers < 50) add('x_tiny_following', `${at} has ${x.followers} followers${x.countsSource === 'vxtwitter' && x.countsAsOf ? ` (cached copy from ${x.countsAsOf.slice(0, 16).replace('T', ' ')} UTC)` : ''}`);
      else if (x.followers === null) miss('x_tiny_following', 'x', 'X follower count', W.x_tiny_following.points);
      if (x.tweets === 0) add('x_no_posts', `${at} has never posted`);
      else if (typeof x.daysSinceLastPost === 'number' && x.daysSinceLastPost > 30) add('x_no_posts', `${at} last posted ${x.lastPostAt?.slice(0, 10)} (${x.daysSinceLastPost} days ago)`);
      else if (x.lastPostAt === null && x.tweets !== 0) miss('x_no_posts', 'x', 'X last post date', W.x_no_posts.points);
      if (x.linksSite === false) add('x_no_site_link', `${at}'s bio and website field do not mention ${ev.website ? new URL(ev.website).hostname.replace(/^www\./, '') : 'the site'}`);
      else if (x.linksSite === null && ev.website) miss('x_no_site_link', 'x', "whether the X account links the coin's site", W.x_no_site_link.points);
    }
    if (x.renamed) add('x_renamed', x.renamed.evidence);
  }
  if (ev.xAgreement?.siteAgrees === false) add('x_handle_mismatch', ev.xAgreement.note ?? "the website's X link and the advertised account differ");

  const GROUP_MAX: Record<'website' | 'domain' | 'github' | 'x', number> = {
    website: pts('drainer_markers', 'default_page', 'wallet_connect', 'never_names_token'),
    domain: pts('domain_new', 'domain_privacy'),
    github: pts('github_archived', 'github_fork', 'github_stale'),
    x: Math.max(pts('x_suspended'), pts('x_account_days_old', 'x_tiny_following', 'x_no_posts', 'x_no_site_link')),
  };
  for (const n of ev.notChecked ?? []) if (!missing.some((m) => m.group === n.group)) miss(`${n.group}:*`, n.group, n.why, GROUP_MAX[n.group]);

  flags.sort((a, b) => b.points - a.points);
  const score = Math.min(100, flags.reduce((a, f) => a + f.points, 0));
  const hi = Math.min(100, score + missing.reduce((a, m) => a + m.maxPoints, 0));
  const m = LARP_SCORE_MEASURED.test;
  return {
    model: LARP_SCORE_MODEL, score, band: bandOf(score),
    range: { lo: score, hi, bandLo: bandOf(score), bandHi: bandOf(hi) },
    thresholds: { ...LARP_SCORE_BANDS },
    flags, top: flags.filter((f) => f.points > 0).slice(0, 3), missing,
    measured: `link-shape part only, held-out test split (${m.n} coins, ${m.bad} went bad within 72 h): AUROC ${m.auroc.toFixed(2)}; ${m.by_band.low.bad}/${m.by_band.low.n} low-band and ${m.by_band.medium.bad}/${m.by_band.medium.n} medium-band coins went bad. Page, domain, GitHub and X points are pre-registered priors, not fitted.`,
    caveat: 'a sum of named flags, evidence not a verdict: any flag can be innocent, a low score is not a safety check, and missing data widens the range instead of lowering the score',
  };
}
