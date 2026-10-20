// task-1471: keyless X account lookup chain. Fixtures only: the fetcher is a fake keyed by URL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { XAccountLookup, parseXLink, xHandleAgreement, FakeClock, type XFetch } from '../src/index.ts';

const NOW = Date.parse('2026-10-19T12:00:00Z');
const fx = (u: Record<string, unknown>) => ({ status: 200, body: JSON.stringify({ code: 200, message: 'OK', user: u }) });
const FX_404 = { status: 404, body: JSON.stringify({ code: 404, message: 'User not found' }) };
const VX_404 = { status: 404, body: JSON.stringify({ error: 'User not found.' }) };
const VX_SUSP = { status: 500, body: JSON.stringify({ error: 'User is suspended' }) };
const OE_OK = { status: 200, body: JSON.stringify({ url: 'https://x.com/x', type: 'rich' }) };
const OE_404 = { status: 404, body: '<html>not found</html>' };
const statuses = (...at: string[]) => ({ status: 200, body: JSON.stringify({ code: 200, results: at.map((created_at) => ({ type: 'status', created_at })) }) });

function fake(map: Record<string, { status: number; body: string } | Error>): { fetch: XFetch; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetch: async (url) => {
      calls.push(url);
      const r = map[url];
      if (r instanceof Error) throw r;
      return r ?? { status: 404, body: '' };
    },
  };
}
const lookup = (f: XFetch, clock = new FakeClock(NOW)) => new XAccountLookup({ fetch: f, clock, minIntervalMs: 0 });
const FXP = (h: string) => `https://api.fxtwitter.com/${h}`;
const VXP = (h: string) => `https://api.vxtwitter.com/${h}`;
const OE = (h: string) => `https://publish.x.com/oembed?url=${encodeURIComponent(`https://x.com/${h}`)}`;
const ST = (h: string) => `https://api.fxtwitter.com/2/profile/${h}/statuses`;

test('parseXLink: account, post, community, reserved paths and non-X hosts', () => {
  assert.deepEqual(parseXLink('https://x.com/examplecoin'), { kind: 'profile', handle: 'examplecoin', statusId: null });
  assert.deepEqual(parseXLink('https://twitter.com/examplecoin/status/123?s=20'), { kind: 'status', handle: 'examplecoin', statusId: '123' });
  assert.equal(parseXLink('https://x.com/i/communities/1789').kind, 'community');
  assert.equal(parseXLink('https://x.com/search?q=coin').handle, null);
  assert.equal(parseXLink('https://x.com/a_handle_that_is_too_long').handle, null);
  assert.equal(parseXLink('https://example.com/examplecoin').kind, 'other');
});

test('active account from FxTwitter: counts, age, last post, bio and site cross-link', async () => {
  const f = fake({
    [FXP('examplecoin')]: fx({ screen_name: 'ExampleCoin', id: '42', joined: 'Sat Oct 17 04:00:00 +0000 2026', followers: 12, following: 3, tweets: 9, description: 'Official $EXC. Site: examplecoin.io', website: { url: 'https://examplecoin.io' } }),
    [ST('examplecoin')]: statuses('Sun Oct 18 10:00:00 +0000 2026', 'Sat Oct 17 09:00:00 +0000 2026'),
  });
  const r = await lookup(f.fetch).lookup('https://x.com/examplecoin', { symbol: 'EXC', name: 'Example Coin', website: 'https://www.examplecoin.io/' });
  assert.equal(r.status, 'active');
  assert.equal(r.screenName, 'ExampleCoin');
  assert.equal(r.ageDays, 2);
  assert.equal(r.followers, 12);
  assert.equal(r.following, 3);
  assert.equal(r.tweets, 9);
  assert.equal(r.lastPostAt, '2026-10-18T10:00:00.000Z');
  assert.equal(r.daysSinceLastPost, 1);
  assert.equal(r.bioMentionsToken, true);
  assert.equal(r.linksSite, true);
  assert.equal(r.countsSource, 'fxtwitter');
  assert.deepEqual(r.unavailable, []);
  assert.equal(f.calls.length, 2, 'profile + statuses only');
});

test('a FxTwitter false 404 falls through to vxtwitter, dated by its own fetched_on', async () => {
  const f = fake({
    [FXP('realcoin')]: FX_404,
    [VXP('realcoin')]: { status: 200, body: JSON.stringify({ screen_name: 'realcoin', id: 7, created_at: 'Tue Apr 01 06:50:41 +0000 2025', followers_count: 8000, following_count: 50, tweet_count: 6000, description: 'gm', fetched_on: NOW / 1000 - 3600 }) },
    [ST('realcoin')]: { status: 404, body: '{"code":404,"results":[]}' },
  });
  const r = await lookup(f.fetch).lookup('https://x.com/realcoin');
  assert.equal(r.status, 'active');
  assert.equal(r.countsSource, 'vxtwitter');
  assert.equal(r.countsAsOf, new Date(NOW - 3600_000).toISOString());
  assert.equal(r.followers, 8000);
  assert.ok(r.unavailable.includes('last post date'), 'posts endpoint failed → listed, not guessed');
  assert.equal(r.lastPostAt, null);
});

test('suspended: vxtwitter says so even when FxTwitter only says "not found"', async () => {
  const f = fake({ [FXP('gonecoin')]: FX_404, [VXP('gonecoin')]: VX_SUSP });
  const r = await lookup(f.fetch).lookup('https://x.com/gonecoin');
  assert.equal(r.status, 'suspended');
  assert.ok(!f.calls.includes(OE('gonecoin')), 'no oEmbed call once suspension is known');
});

test('not_found needs two independent sources; one 404 vote plus oEmbed "exists" is unavailable', async () => {
  const gone = fake({ [FXP('nobody')]: FX_404, [VXP('nobody')]: VX_404, [OE('nobody')]: OE_404 });
  assert.equal((await lookup(gone.fetch).lookup('https://x.com/nobody')).status, 'not_found');
  const unsure = fake({ [FXP('flaky')]: FX_404, [VXP('flaky')]: VX_404, [OE('flaky')]: OE_OK });
  const r = await lookup(unsure.fetch).lookup('https://x.com/flaky');
  assert.equal(r.status, 'unavailable');
  assert.match(r.unavailable[0], /account status/);
  const fxOnly = fake({ [FXP('fxonly')]: FX_404, [VXP('fxonly')]: { status: 502, body: '' }, [OE('fxonly')]: { status: 503, body: '' } });
  assert.equal((await lookup(fxOnly.fetch).lookup('https://x.com/fxonly')).status, 'unavailable', 'a FxTwitter 404 alone is never "not found"');
});

test('a FxTwitter redirect (missing handle page) is one vote, never parsed as data', async () => {
  const f = fake({ [FXP('nohandle')]: { status: 302, body: '' }, [VXP('nohandle')]: VX_404, [OE('nohandle')]: OE_404 });
  const r = await lookup(f.fetch).lookup('https://x.com/nohandle');
  assert.equal(r.status, 'not_found');
  assert.match(r.sources[0].result, /redirect/);
});

test('rename: a status link whose post now shows another author', async () => {
  const f = fake({
    'https://api.fxtwitter.com/oldname/status/99': { status: 200, body: JSON.stringify({ code: 200, tweet: { author: { screen_name: 'newname' } } }) },
    [FXP('newname')]: fx({ screen_name: 'newname', id: '1', joined: 'Wed Dec 08 13:14:10 +0000 2010', followers: 900, following: 10, tweets: 400, description: '' }),
    [ST('newname')]: statuses('Mon Oct 19 09:00:00 +0000 2026'),
  });
  const r = await lookup(f.fetch).lookup('https://x.com/oldname/status/99');
  assert.equal(r.kind, 'status');
  assert.deepEqual(r.renamed?.from, 'oldname');
  assert.equal(r.renamed?.to, 'newname');
  assert.equal(r.screenName, 'newname');
  assert.equal(r.bio, '', 'an empty bio is present, not missing');
});

test('community link: no lookups, account listed as unavailable', async () => {
  const f = fake({});
  const r = await lookup(f.fetch).lookup('https://x.com/i/communities/1789');
  assert.equal(r.status, 'unavailable');
  assert.equal(f.calls.length, 0);
});

test('cache: a second lookup within the TTL makes no request; unavailable results expire sooner', async () => {
  const clock = new FakeClock(NOW);
  const f = fake({ [FXP('cachedcoin')]: fx({ screen_name: 'cachedcoin', id: '3', joined: 'Sat Oct 10 04:01:46 +0000 2026', followers: 100, following: 4, tweets: 150, description: 'x' }), [ST('cachedcoin')]: statuses('Mon Oct 19 09:00:00 +0000 2026') });
  const lk = lookup(f.fetch, clock);
  await lk.lookup('https://x.com/cachedcoin');
  const n = f.calls.length;
  const again = await lk.lookup('https://x.com/CachedCoin');
  assert.equal(again.cached, true);
  assert.equal(f.calls.length, n);
  await clock.advance(31 * 60_000);
  assert.equal((await lk.lookup('https://x.com/cachedcoin')).cached, false, 'refetched after 30 min');
});

test('circuit breaker: a source that keeps failing is skipped while degraded', async () => {
  const clock = new FakeClock(NOW);
  const map: Record<string, { status: number; body: string } | Error> = {};
  for (const h of ['a1', 'a2', 'a3', 'a4']) { map[FXP(h)] = new Error('connect ECONNREFUSED'); map[VXP(h)] = VX_404; map[OE(h)] = OE_404; }
  const f = fake(map);
  const lk = lookup(f.fetch, clock);
  for (const h of ['a1', 'a2', 'a3']) await lk.lookup(`https://x.com/${h}`);
  const r = await lk.lookup('https://x.com/a4');
  assert.ok(!f.calls.includes(FXP('a4')), 'FxTwitter not called while its circuit is open');
  assert.match(r.sources[0].result, /circuit open/);
  assert.equal(r.status, 'not_found', 'the other two sources still answer');
});

test('per-host spacing serializes calls to one host', async () => {
  const order: string[] = [];
  const f: XFetch = async (url) => { order.push(`start ${url}`); await new Promise((r) => setTimeout(r, 5)); order.push(`end ${url}`); return FX_404; };
  const lk = new XAccountLookup({ fetch: f, minIntervalMs: 1 });
  await Promise.all([lk.lookup('https://x.com/p1'), lk.lookup('https://x.com/p2')]);
  const fxCalls = order.filter((o) => o.includes('api.fxtwitter.com'));
  for (let i = 0; i + 1 < fxCalls.length; i += 2) assert.ok(fxCalls[i].startsWith('start') && fxCalls[i + 1].startsWith('end'), `no overlap on one host: ${fxCalls.join(' | ')}`);
});

test('xHandleAgreement: sources and the site\'s own X links', () => {
  const same = xHandleAgreement([{ url: 'https://x.com/coin', source: 'dexscreener' }, { url: 'https://twitter.com/Coin', source: 'jupiter' }], ['https://x.com/coin']);
  assert.equal(same.agree, true);
  assert.equal(same.siteLinksAdvertised, true);
  const two = xHandleAgreement([{ url: 'https://x.com/coin', source: 'dexscreener' }, { url: 'https://x.com/other', source: 'jupiter' }], null);
  assert.equal(two.agree, false);
  assert.equal(two.siteAgrees, null, 'source disagreement is links_mismatch, not a site mismatch');
  assert.match(two.note ?? '', /different X accounts/);
  const site = xHandleAgreement([{ url: 'https://x.com/coin', source: 'dexscreener' }], ['https://x.com/somebodyelse']);
  assert.equal(site.agree, false);
  assert.equal(site.siteAgrees, false);
  assert.match(site.note ?? '', /website links @somebodyelse/);
  assert.equal(xHandleAgreement([{ url: 'https://x.com/coin', source: 'dexscreener' }], []).agree, true, 'a site with no X link is not a mismatch');
});
