// task-1471: the 0-100 LARP score is a transparent sum of named flags; missing data widens the range only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { larpScore, linkFeatures, LARP_SCORE_WEIGHTS, LARP_SCORE_BANDS, bandOf, type LarpEvidence, type XAccountReport } from '../src/index.ts';

const xActive = (over: Partial<XAccountReport> = {}): XAccountReport => ({
  url: 'https://x.com/examplecoin', kind: 'profile', handle: 'examplecoin', status: 'active', screenName: 'examplecoin', id: '1', renamed: null,
  createdAt: '2026-10-18T00:00:00.000Z', ageDays: 1, followers: 3, following: 0, tweets: 2, lastPostAt: '2026-10-19T00:00:00.000Z', daysSinceLastPost: 0,
  bio: 'hi', website: null, bioMentionsToken: false, linksSite: false, countsAsOf: '2026-10-19T12:00:00.000Z', countsSource: 'fxtwitter',
  unavailable: [], sources: [], cached: false, fetchedAt: '2026-10-19T12:00:00.000Z', ...over,
});
const base = (over: Partial<LarpEvidence> = {}): LarpEvidence => ({
  mode: 'token',
  link: linkFeatures({ web: 'https://examplecoin.io', x: 'https://x.com/examplecoin', tg: 'https://t.me/examplecoin', symbol: 'EXC', name: 'Example Coin' }),
  mismatch: [], website: 'https://examplecoin.io/',
  page: { ok: true, defaultPage: false, walletConnect: false, drainerFlags: [], mentionsSymbol: true, mentionsName: true },
  domain: { ok: true, ageDays: 400, privacy: false },
  github: 'none', x: xActive({ ageDays: 900, createdAt: '2024-01-01T00:00:00.000Z', followers: 5000, linksSite: true, bioMentionsToken: true }), xAgreement: { agree: true, note: null },
  ...over,
});

test('the score is exactly the sum of the listed flags, sorted, with the top 3 surfaced', () => {
  const s = larpScore(base({
    page: { ok: true, defaultPage: true, walletConnect: true, drainerFlags: ['setApprovalForAll'], mentionsSymbol: false, mentionsName: false },
    domain: { ok: true, ageDays: 3, privacy: true },
    x: xActive(),
  }));
  assert.equal(s.score, Math.min(100, s.flags.reduce((a, f) => a + f.points, 0)));
  for (const f of s.flags) assert.equal(f.points, LARP_SCORE_WEIGHTS[f.id].points, `${f.id} carries its published weight`);
  assert.deepEqual(s.top.map((f) => f.id), ['drainer_markers', 'default_page', 'x_account_days_old']);
  assert.equal(s.band, 'high');
  assert.ok(s.flags.every((f, i) => i === 0 || s.flags[i - 1].points >= f.points), 'sorted by points');
  assert.ok(s.flags.every((f) => f.evidence.length > 0), 'every flag names its evidence');
  assert.match(s.caveat, /not a verdict/);
});

test('a clean-looking coin scores low with nothing missing', () => {
  const s = larpScore(base());
  assert.deepEqual(s.flags.map((f) => f.id), ['no_github']);
  assert.equal(s.score, LARP_SCORE_WEIGHTS.no_github.points);
  assert.equal(s.band, 'low');
  assert.deepEqual(s.missing, []);
  assert.equal(s.range.hi, s.score);
});

test('missing data widens the range and never lowers the score', () => {
  const full = larpScore(base());
  const blind = larpScore(base({ page: { ok: false, reason: 'robots disallow; page not fetched' }, domain: { ok: false, reason: 'rdap status 503' }, x: xActive({ status: 'unavailable', ageDays: null, followers: null, tweets: null, following: null, createdAt: null, lastPostAt: null, linksSite: null, unavailable: ['account status'] }) }));
  assert.equal(blind.score, full.score, 'unread evidence adds no points and removes none');
  assert.ok(blind.range.hi > blind.score);
  assert.deepEqual(blind.missing.map((m) => m.group).sort(), ['domain', 'website', 'x']);
  assert.match(blind.missing.find((m) => m.group === 'website')!.what, /robots disallow/);
  assert.equal(blind.range.bandLo, 'low');
  assert.equal(blind.range.bandHi, bandOf(blind.range.hi));
});

test('X flags: suspended / not found / new, tiny, silent, unlinked, renamed, handle mismatch', () => {
  assert.ok(larpScore(base({ x: xActive({ status: 'suspended' }) })).flags.some((f) => f.id === 'x_suspended'));
  const nf = larpScore(base({ x: xActive({ status: 'not_found' }) }));
  assert.ok(nf.flags.some((f) => f.id === 'x_not_found' && /two independent sources/.test(f.evidence)));
  const s = larpScore(base({ x: xActive({ ageDays: 20, createdAt: '2026-09-29T00:00:00.000Z', followers: 10, tweets: 5, lastPostAt: '2026-09-01T00:00:00.000Z', daysSinceLastPost: 48, linksSite: false, renamed: { from: 'a', to: 'b', evidence: 'the linked post 1 is now shown under @b' } }), xAgreement: { agree: false, siteAgrees: false, note: 'the website links @other but the token lists @examplecoin' } }));
  const ids = s.flags.map((f) => f.id);
  for (const id of ['x_account_new', 'x_tiny_following', 'x_no_posts', 'x_no_site_link', 'x_renamed', 'x_handle_mismatch'] as const) assert.ok(ids.includes(id), id);
  assert.ok(!ids.includes('x_account_days_old'), '7-30 days is the smaller flag only');
  const cached = larpScore(base({ x: xActive({ followers: 2, countsSource: 'vxtwitter', countsAsOf: '2026-10-18T09:30:00.000Z' }) }));
  assert.match(cached.flags.find((f) => f.id === 'x_tiny_following')!.evidence, /cached copy from 2026-10-18 09:30 UTC/);
});

test('link-shape flags come from the same features the backtest scores; a site vetted directly has none', () => {
  const bare = larpScore(base({ link: linkFeatures({ web: null, x: null, tg: null }), website: null, page: null, domain: null, x: null, xAgreement: null }));
  assert.deepEqual(bare.flags.map((f) => f.id).sort(), ['no_github', 'no_telegram', 'no_website', 'no_x'].sort());
  assert.ok(bare.flags.filter((f) => f.id !== 'no_github').every((f) => f.weight === 'calibrated'));
  assert.ok(bare.score < LARP_SCORE_BANDS.high, 'link shape alone never reaches the high band');
  const url = larpScore(base({ mode: 'url', link: null, github: null, x: null, xAgreement: null }));
  assert.deepEqual(url.flags, []);
});

test('bands use the published thresholds', () => {
  assert.equal(bandOf(LARP_SCORE_BANDS.medium - 1), 'low');
  assert.equal(bandOf(LARP_SCORE_BANDS.medium), 'medium');
  assert.equal(bandOf(LARP_SCORE_BANDS.high), 'high');
  const capped = larpScore(base({ page: { ok: true, defaultPage: true, walletConnect: true, drainerFlags: ['a'], mentionsSymbol: false, mentionsName: false }, domain: { ok: true, ageDays: 1, privacy: true }, x: xActive({ status: 'suspended' }), mismatch: ['multiple website hosts: a, b'], github: { ok: true, archived: true, fork: true, daysSincePush: 999 }, link: linkFeatures({ web: 'https://a.vercel.app', x: 'https://x.com/i/communities/1', tg: null }) }));
  assert.equal(capped.score, 100, 'capped at 100');
});

test('notChecked groups (the link-only web checker) widen the range with each group\'s full points', () => {
  const s = larpScore(base({ website: null, page: null, domain: null, github: null, x: null, xAgreement: null, link: linkFeatures({ web: 'https://examplecoin.io', x: 'https://x.com/examplecoin', tg: null, symbol: 'EXC' }), notChecked: [
    { group: 'website', why: 'the web checker reads link shape only; the page is not fetched' },
    { group: 'domain', why: 'not checked on the web' }, { group: 'github', why: 'not checked on the web' }, { group: 'x', why: 'not checked on the web' },
  ] }));
  assert.deepEqual(s.flags.map((f) => f.id), ['no_telegram']);
  assert.deepEqual(s.missing.map((m) => m.group), ['website', 'domain', 'github', 'x']);
  assert.equal(s.range.hi, Math.min(100, s.score + s.missing.reduce((a, m) => a + m.maxPoints, 0)));
  assert.equal(s.range.bandHi, 'high', 'a link-only read cannot rule the high band out');
});
