// LARP detector — mechanical evidence signals (task-1315). Pure + deterministic
// given fetched bytes; no network except through an injected fetcher. These are
// SIGNALS, never verdicts: the analyst weighs them. HTML is parsed with regex
// only (zero-dep, and we never execute it) because the page is untrusted data.

import { classifyLink, parseHttpUrl } from './links.ts';
import type { SafeFetchResult } from './safe-fetch.ts';

export interface PageSignals {
  fetched: boolean;
  status: number;
  finalUrl: string | null;
  blocked: string | null;
  title: string | null;
  description: string | null;
  /** <meta name=generator> value (site-builder tell). */
  generator: string | null;
  /** Best guess at the hosting/site builder (wix, carrd, framer, vercel, github-pages…). */
  siteBuilder: string | null;
  /** Non-null when the page looks like a parked/placeholder/default/404 page. */
  defaultPage: string | null;
  /** Rough visible-text length (tags stripped). A near-empty page is a tell. */
  textLength: number;
  linkCount: number;
  externalHosts: string[];
  hasApp: boolean;
  hasDocs: boolean;
  hasWhitepaper: boolean;
  hasGithub: boolean;
  /** Wallet-connect UI present (expected for a dapp, a flag on a brochure site). */
  walletConnect: boolean;
  /** Heuristic drainer/scam signatures (names only; a flag to investigate, not proof). */
  drainerFlags: string[];
  /** External <script> origins (supply-chain / drainer surface). */
  scriptHosts: string[];
  mentionsSymbol: boolean | null;
  mentionsName: boolean | null;
  /** Short, control-stripped text excerpt for the analyst to read (it wraps as untrusted). */
  excerpt: string;
  /** Advertised navigation only; presence does not prove a functioning product. */
  links: Array<{ url: string; kind: string }>;
  teamClaim: boolean;
  stockTextSignals: string[];
}

const DRAINER_SIGNATURES: Array<[RegExp, string]> = [
  [/setApprovalForAll/i, 'setApprovalForAll (ERC-721/1155 approval drainer)'],
  [/permit2|permit\(/i, 'permit/permit2 signature grab'],
  [/eth_sendTransaction|window\.ethereum/i, 'EVM wallet calls on a Solana token (chain mismatch)'],
  [/eval\s*\(\s*atob\s*\(/i, 'eval(atob( obfuscated script'],
  [/Function\s*\(\s*atob/i, 'Function(atob( obfuscated script'],
  [/drainer|seaport\.js|inferno|monkey-drainer|pink-drainer/i, 'known drainer-kit string'],
  [/signAllTransactions[\s\S]{0,400}(SystemProgram\.transfer|createTransferInstruction)/i, 'sign-all then transfer-all pattern'],
];

const BUILDER_SIGNATURES: Array<[RegExp, string]> = [
  [/\.carrd\.co|data-carrd|cardScript/i, 'carrd'],
  [/static\.wixstatic\.com|X-Wix-|wix\.com/i, 'wix'],
  [/squarespace\.com|static1\.squarespace/i, 'squarespace'],
  [/framerusercontent\.com|framer\.com|data-framer/i, 'framer'],
  [/assets\.website-files\.com|webflow\.(io|com)|data-wf-/i, 'webflow'],
  [/cdn\.durable\.co|durable\.co/i, 'durable'],
  [/\.github\.io|github-pages/i, 'github-pages'],
  [/vercel\.app|_next\/static/i, 'vercel/next'],
  [/netlify\.app|netlify/i, 'netlify'],
  [/dorik|data-dorik/i, 'dorik'],
];

const DEFAULT_PAGE_SIGNATURES: Array<[RegExp, string]> = [
  [/there isn.?t a github pages site here|404\.html/i, 'github-pages 404'],
  [/the deployment could not be found|deployment_not_found|welcome to vercel/i, 'vercel default/missing'],
  [/this (domain|site) is (for sale|parked)|buy this domain|parkingcrew|sedoparking|godaddy\.com\/domainfind/i, 'parked domain'],
  [/future home of something|default web page|it works!|apache2 (ubuntu|debian) default/i, 'web-server default page'],
  [/site not found|no such app|there's nothing here/i, 'host placeholder (missing app)'],
  [/this site can.?t be reached|dns_probe_finished/i, 'unreachable'],
  [/^\s*(coming soon|under construction)\s*$/i, 'coming-soon stub'],
];

function firstMatch(html: string, table: Array<[RegExp, string]>): string | null {
  for (const [re, name] of table) if (re.test(html)) return name;
  return null;
}
function allMatches(html: string, table: Array<[RegExp, string]>): string[] {
  const out: string[] = [];
  for (const [re, name] of table) if (re.test(html)) out.push(name);
  return out;
}

function tag(html: string, re: RegExp): string | null {
  const m = re.exec(html);
  return m ? m[1].replace(/\s+/g, ' ').trim() : null;
}

/** Strip tags/scripts/styles to a rough visible-text approximation. */
function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Every absolute http(s) href/src on the page. */
export function extractUrls(html: string, baseUrl: string | null): string[] {
  const out = new Set<string>();
  const re = /(?:href|src)\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1];
    let abs: string | null;
    try { abs = new URL(raw, baseUrl ?? undefined).toString(); } catch { abs = null; }
    const p = abs ? parseHttpUrl(abs) : null;
    if (p) out.add(p.toString());
  }
  return [...out];
}

function hostOf(url: string): string | null {
  const u = parseHttpUrl(url);
  return u ? u.hostname.toLowerCase().replace(/^www\./, '') : null;
}

/**
 * Compute mechanical signals from a fetched page. `symbol`/`name` enable the "does the site even
 * mention this token" check. Returns a `fetched:false` bundle (with the block reason) when the
 * fetch failed, so the analyst can report it as a missing-data fact rather than guess.
 */
export function pageSignals(res: SafeFetchResult, opts: { symbol?: string | null; name?: string | null } = {}): PageSignals {
  const base: PageSignals = {
    fetched: res.ok, status: res.status, finalUrl: res.ok ? res.finalUrl : null, blocked: res.blocked,
    title: null, description: null, generator: null, siteBuilder: null, defaultPage: null,
    textLength: 0, linkCount: 0, externalHosts: [], hasApp: false, hasDocs: false, hasWhitepaper: false,
    hasGithub: false, walletConnect: false, drainerFlags: [], scriptHosts: [], mentionsSymbol: null, mentionsName: null, excerpt: '',
    links: [], teamClaim: false, stockTextSignals: [],
  };
  if (!res.ok || !res.body) return base;
  const html = res.body;
  const finalHost = hostOf(res.finalUrl);
  const title = tag(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const description = tag(html, /<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i)
    ?? tag(html, /<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']*)["']/i);
  const generator = tag(html, /<meta[^>]+name=["']generator["'][^>]*content=["']([^"']*)["']/i);
  const text = visibleText(html);
  const urls = extractUrls(html, res.finalUrl);
  const externalHosts = [...new Set(urls.map(hostOf).filter((h): h is string => !!h && h !== finalHost))];
  const scriptRe = /<script[^>]+src\s*=\s*["']([^"']+)["']/gi;
  const scriptHosts = new Set<string>();
  let sm: RegExpExecArray | null;
  while ((sm = scriptRe.exec(html)) !== null) { const h = hostOf(sm[1].startsWith('http') ? sm[1] : new URL(sm[1], res.finalUrl ?? 'https://x/').toString()); if (h && h !== finalHost) scriptHosts.add(h); }

  const kinds = new Set(urls.map((u) => { const p = parseHttpUrl(u); return p ? classifyLink(p) : 'other'; }));
  const lowerHtml = html.toLowerCase();
  const hasApp = /\b(launch app|open app|dapp|\/app\b|app\.|demo|try (it|now)|get started)\b/i.test(text) || /href=["'][^"']*\/(app|dapp|demo)\b/i.test(html);
  const sym = (opts.symbol ?? '').replace(/^\$/, '').toLowerCase();
  const name = (opts.name ?? '').toLowerCase();
  const lowerText = text.toLowerCase();

  return {
    ...base,
    title: title ? title.slice(0, 160) : null,
    description: description ? description.slice(0, 300) : null,
    generator: generator ? generator.slice(0, 80) : null,
    siteBuilder: firstMatch(html, BUILDER_SIGNATURES) ?? (generator ? generator.split(/[\s(]/)[0].toLowerCase() : null),
    defaultPage: firstMatch(text, DEFAULT_PAGE_SIGNATURES) ?? (text.length < 40 ? 'near-empty page' : null),
    textLength: text.length,
    linkCount: urls.length,
    externalHosts: externalHosts.slice(0, 30),
    hasApp,
    hasDocs: kinds.has('docs') || /\bdocs?\b|documentation|whitepaper|litepaper/i.test(text),
    hasWhitepaper: /whitepaper|litepaper/i.test(lowerHtml),
    hasGithub: kinds.has('github'),
    walletConnect: /connect\s*wallet|walletconnect|@solana\/wallet-adapter|window\.solana|phantom|solflare/i.test(html),
    drainerFlags: allMatches(html, DRAINER_SIGNATURES),
    scriptHosts: [...scriptHosts].slice(0, 20),
    mentionsSymbol: sym ? lowerText.includes(sym) : null,
    mentionsName: name ? lowerText.includes(name) : null,
    excerpt: text.slice(0, 1200),
    links: urls.slice(0, 24).map((url) => ({ url, kind: classifyLink(new URL(url)) })),
    teamClaim: /\b(our team|founder|co-founder|meet the team)\b/i.test(text),
    stockTextSignals: allMatches(text, [[/lorem ipsum/i, 'lorem ipsum placeholder'], [/your (company|brand|business) (name|here)/i, 'template placeholder'], [/insert (text|copy|title) here/i, 'unfilled template']]),
  };
}

// ---------------------------------------------------------------------------
// Network-backed helpers. They take an injected text fetcher so they are unit-testable offline.
export type TextFetch = (url: string) => Promise<{ ok: boolean; status: number; body: string }>;

export interface DomainAge {
  domain: string;
  registeredAt: string | null;
  ageDays: number | null;
  registrar: string | null;
  /** True when the registrant contact is redacted/privacy-protected (common, mild signal). */
  privacy: boolean | null;
  source: 'rdap';
  error: string | null;
}

/** Exact advertised domain, stripping only www. Without a PSL, never attribute
 * a public suffix's registration (co.uk) to a project (docs.coin.co.uk).
 * RDAP may refuse a subdomain; that is missing data, not an invented age. */
export function registrableDomain(url: string): string | null {
  const u = parseHttpUrl(url);
  if (!u) return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (/^\d/.test(host) || host.includes(':')) return null; // IP literal
  const parts = host.split('.');
  if (parts.length < 2) return null;
  return host;
}

/** Domain registration age + registrar via RDAP (rdap.org bootstrap). Keyless. */
export async function domainAgeViaRdap(url: string, fetchText: TextFetch, now = () => Date.now()): Promise<DomainAge> {
  const domain = registrableDomain(url);
  const base: DomainAge = { domain: domain ?? '', registeredAt: null, ageDays: null, registrar: null, privacy: null, source: 'rdap', error: null };
  if (!domain) return { ...base, error: 'no registrable domain' };
  let r: { ok: boolean; status: number; body: string };
  try { r = await fetchText(`https://rdap.org/domain/${encodeURIComponent(domain)}`); } catch (e) { return { ...base, error: `rdap fetch failed: ${(e as Error).message}` }; }
  if (!r.ok) return { ...base, error: `rdap status ${r.status}` };
  let data: Record<string, unknown>;
  try { data = JSON.parse(r.body) as Record<string, unknown>; } catch { return { ...base, error: 'rdap: invalid json' }; }
  const events = (data.events as Array<{ eventAction?: string; eventDate?: string }> | undefined) ?? [];
  const reg = events.find((e) => e.eventAction === 'registration')?.eventDate ?? null;
  const entities = (data.entities as Array<{ roles?: string[]; vcardArray?: unknown; remarks?: Array<{ title?: string }> }> | undefined) ?? [];
  const registrar = entities.find((e) => e.roles?.includes('registrar'))?.vcardArray ? vcardName((entities.find((e) => e.roles?.includes('registrar')) as { vcardArray?: unknown }).vcardArray) : null;
  const registrant = entities.find((e) => e.roles?.includes('registrant'));
  const privacy = registrant ? /redact|privacy|protect|withheld|gdpr/i.test(JSON.stringify(registrant)) : null;
  const ageDays = reg ? Math.max(0, Math.round((now() - Date.parse(reg)) / 86_400_000)) : null;
  return { domain, registeredAt: reg, ageDays: Number.isFinite(ageDays as number) ? ageDays : null, registrar, privacy, source: 'rdap', error: null };
}

function vcardName(vcardArray: unknown): string | null {
  // vCard jCard: ["vcard", [ ["fn", {}, "text", "Name"], ... ]]
  try {
    const entries = (vcardArray as unknown[])[1] as Array<[string, unknown, string, string]>;
    const fn = entries.find((e) => e[0] === 'fn');
    return fn ? String(fn[3]).slice(0, 80) : null;
  } catch { return null; }
}

export interface GithubActivity {
  owner: string;
  repo: string;
  createdAt: string | null;
  pushedAt: string | null;
  daysSincePush: number | null;
  stars: number | null;
  openIssues: number | null;
  archived: boolean | null;
  fork: boolean | null;
  description: string | null;
  commits?: Array<{ sha: string; date: string | null }>;
  historyError?: string | null;
  error: string | null;
}

/** Parse github.com/<owner>/<repo> from a URL. */
export function parseGithubRepo(url: string): { owner: string; repo: string } | null {
  const u = parseHttpUrl(url);
  if (!u || u.hostname.toLowerCase().replace(/^www\./, '') !== 'github.com') return null;
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/, '');
  if (/^(orgs|sponsors|features|about|topics|collections|marketplace)$/i.test(owner)) return null;
  return { owner, repo };
}

/** Repo creation/last-push/stars via the keyless GitHub REST API (60 req/hr unauth). */
export async function githubRepoActivity(url: string, fetchText: TextFetch, now = () => Date.now()): Promise<GithubActivity | null> {
  const r = parseGithubRepo(url);
  if (!r) return null;
  const base: GithubActivity = { owner: r.owner, repo: r.repo, createdAt: null, pushedAt: null, daysSincePush: null, stars: null, openIssues: null, archived: null, fork: null, description: null, error: null };
  let res: { ok: boolean; status: number; body: string };
  try { res = await fetchText(`https://api.github.com/repos/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}`); } catch (e) { return { ...base, error: `github fetch failed: ${(e as Error).message}` }; }
  if (!res.ok) return { ...base, error: res.status === 404 ? 'repo not found' : `github status ${res.status}` };
  let d: Record<string, unknown>;
  try { d = JSON.parse(res.body) as Record<string, unknown>; } catch { return { ...base, error: 'github: invalid json' }; }
  const pushedAt = typeof d.pushed_at === 'string' ? d.pushed_at : null;
  const daysSincePush = pushedAt ? Math.max(0, Math.round((now() - Date.parse(pushedAt)) / 86_400_000)) : null;
  const commits: Array<{ sha: string; date: string | null }> = [];
  let historyError: string | null = null;
  try {
    const history = await fetchText(`https://api.github.com/repos/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}/commits?per_page=5`);
    const parsed: unknown = history.ok ? JSON.parse(history.body) : null;
    if (!Array.isArray(parsed)) historyError = `commit history unavailable (${history.status})`;
    else for (const item of parsed.slice(0, 5)) {
      if (typeof item?.sha === 'string' && /^[a-f0-9]{40}$/.test(item.sha)) commits.push({ sha: item.sha, date: typeof item.commit?.committer?.date === 'string' ? item.commit.committer.date : null });
    }
  } catch { historyError = 'commit history unavailable'; }
  return {
    owner: r.owner, repo: r.repo,
    createdAt: typeof d.created_at === 'string' ? d.created_at : null,
    pushedAt, daysSincePush,
    stars: typeof d.stargazers_count === 'number' ? d.stargazers_count : null,
    openIssues: typeof d.open_issues_count === 'number' ? d.open_issues_count : null,
    archived: typeof d.archived === 'boolean' ? d.archived : null,
    fork: typeof d.fork === 'boolean' ? d.fork : null,
    description: typeof d.description === 'string' ? d.description.slice(0, 200) : null,
    commits, historyError,
    error: null,
  };
}

export interface LinkProbe { url: string; ok: boolean; status: number; blocked: string | null }

/** Reachability of a small set of advertised links (broken-link signal). Caller caps the list. */
export async function probeLinks(urls: string[], fetchProbe: (url: string) => Promise<SafeFetchResult>, max = 8): Promise<LinkProbe[]> {
  const out: LinkProbe[] = [];
  for (const url of urls.slice(0, max)) {
    try { const r = await fetchProbe(url); out.push({ url, ok: r.ok, status: r.status, blocked: r.blocked }); }
    catch (e) { out.push({ url, ok: false, status: 0, blocked: (e as Error).message }); }
  }
  return out;
}
