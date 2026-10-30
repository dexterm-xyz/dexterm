// task-1427: the STREAMER OVERLAY (`dexterm overlay`). Hermetic: loopback sockets on a random port, fixture
// events with made-up mints, no network. Covers the popup-host security model (single-use ticket → token, Host /
// Origin / remote checks, empty 404s), the outbound-only socket, redaction, the PAPER / LIVE stamps of the PnL scene,
// the SAMPLE DATA tag of a replay, data ages, and the new stream fields (holders, live signals).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { redactSpectatorEvent, sanitizeDetail, type SpectatorEvent } from '@dexterm/agents';
import { detailFor } from '../../mcp/src/spectator-sink.ts';
import { createOverlayServer, type OverlayServer, type OverlayServerEvent } from '../src/overlay/server.ts';
import { renderOverlayPage, OVERLAY_THEMES } from '../src/overlay/page.ts';
import { emptyOverlayState, foldOverlay, activityView, coinView } from '../src/overlay/model.ts';
import { pnlView, ledgerOverlayInput } from '../src/overlay/pnl.ts';
import { OverlayEngine, parseOverlayArgs } from '../src/overlay-cmd.ts';
import { McpFollowSession } from '../src/mcp-follow.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeCard, renderCard, cardPng, ledgerCardInput, type LedgerCardRow } from '../src/pnl-card.ts';

const MINT = 'FixtMintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const WALLET = 'FixtWa11etBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const KEY = 'K'.repeat(64) + 'x'.repeat(24);
const FULL_ADDR_RE = /[1-9A-HJ-NP-Za-km-z]{32,}/;

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** A raw WebSocket upgrade (so the test controls Host / Origin); resolves the status and, on 101, the socket. */
function upgrade(port: number, path: string, headers: Record<string, string>): Promise<{ status: number; socket: Duplex | null; head?: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers: { host: `127.0.0.1:${port}`, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': randomBytes(16).toString('base64'), ...headers } });
    req.on('upgrade', (res, socket, head) => resolve({ status: res.statusCode ?? 0, socket, head }));
    req.on('response', (res) => { res.resume(); resolve({ status: res.statusCode ?? 0, socket: null }); });
    req.on('error', reject);
    req.end();
  });
}

/** Collect server→client text frames (unmasked) as parsed JSON. */
function frames(socket: Duplex, head?: Buffer): { msgs: Array<Record<string, unknown>>; wait: (pred: (m: Array<Record<string, unknown>>) => boolean, ms?: number) => Promise<void> } {
  const msgs: Array<Record<string, unknown>> = [];
  let buf = Buffer.alloc(0);
  const feed = (d: Buffer): void => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 2) return;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf.length < off + len) return;
      const op = buf[0] & 0x0f;
      if (op === 1) msgs.push(JSON.parse(buf.subarray(off, off + len).toString('utf8')));
      buf = buf.subarray(off + len);
    }
  };
  socket.on('data', feed);
  if (head && head.length) feed(head);
  return {
    msgs,
    wait: (pred, ms = 3000) => new Promise((resolve, reject) => {
      const t0 = Date.now();
      const iv = setInterval(() => { if (pred(msgs)) { clearInterval(iv); resolve(); } else if (Date.now() - t0 > ms) { clearInterval(iv); reject(new Error(`timeout; got ${JSON.stringify(msgs).slice(0, 300)}`)); } }, 10);
    }),
  };
}

/** A masked client→server text frame. */
function clientFrame(text: string): Buffer {
  const p = Buffer.from(text), mask = randomBytes(4);
  const head = p.length < 126 ? Buffer.from([0x81, 0x80 | p.length]) : Buffer.from([0x81, 0x80 | 126, p.length >> 8, p.length & 255]);
  const body = Buffer.from(p.map((b, i) => b ^ mask[i & 3]));
  return Buffer.concat([head, mask, body]);
}

const wsOf = (html: string): string => /name="dexterm-ws" content="([^"]+)"/.exec(html)![1].replace(/&amp;/g, '&');

async function withServer(fn: (s: OverlayServer, events: OverlayServerEvent[]) => Promise<void>, opts: { now?: () => number; ticketTtlMs?: number } = {}): Promise<void> {
  const events: OverlayServerEvent[] = [];
  const s = await createOverlayServer({ onEvent: (e) => events.push(e), ...opts });
  try { await fn(s, events); } finally { await s.close(); }
}

let seq = 0;
function ev(e: Partial<SpectatorEvent>): SpectatorEvent {
  return { v: 1, seq: ++seq, t: e.t ?? Date.now(), phase: 'result', agent: 'scanbot', ok: true, ...e } as SpectatorEvent;
}

// ------------------------------------------------------------------------------------------------ server security

test('overlay server: listens on 127.0.0.1 only and a ticket buys exactly one page load', async () => {
  await withServer(async (s) => {
    assert.match(s.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    const url = new URL(s.issueTicket('coin'));
    assert.equal(url.hostname, '127.0.0.1');
    const first = await get(s.port, url.pathname + url.search);
    assert.equal(first.status, 200);
    assert.match(first.body, /<main id="root">/);
    const again = await get(s.port, url.pathname + url.search);
    assert.equal(again.status, 404, 'a spent ticket is refused (a reload or a copied URL)');
    assert.equal(again.body, '');
  });
});

test('overlay server: wrong scene, forged ticket, unknown route and expired ticket are empty 404s', async () => {
  let clock = 1_000_000;
  await withServer(async (s, events) => {
    const u = new URL(s.issueTicket('pnl'));
    assert.equal((await get(s.port, `/overlay/coin${u.search}`)).status, 404, 'a pnl ticket cannot buy the coin page');
    assert.equal((await get(s.port, '/overlay/pnl?p=' + 'A'.repeat(43))).status, 404);
    assert.equal((await get(s.port, '/')).status, 404);
    assert.equal((await get(s.port, '/overlay/../etc/passwd')).status, 404);
    const late = new URL(s.issueTicket('activity'));
    clock += 61_000;
    assert.equal((await get(s.port, late.pathname + late.search)).status, 404, 'an expired ticket is refused');
    const reasons = events.filter((e) => e.ev === 'probe.rejected').map((e) => (e as { reason: string }).reason);
    assert.ok(reasons.includes('bad-ticket') && reasons.includes('unknown-route'));
    // the probe log never carries a ticket
    for (const e of events) if (e.ev === 'probe.rejected') assert.doesNotMatch(e.path, /p=[A-Za-z0-9_-]{8,}/);
  }, { now: () => clock, ticketTtlMs: 60_000 });
});

test('overlay server: a foreign Host header (DNS rebinding) is refused before the ticket is spent', async () => {
  await withServer(async (s, events) => {
    const u = new URL(s.issueTicket('activity'));
    for (const host of [`localhost:${s.port}`, `evil.example:${s.port}`, `127.0.0.1:${s.port + 1}`, `[::1]:${s.port}`]) {
      const r = await get(s.port, u.pathname + u.search, { host });
      assert.equal(r.status, 404, host);
    }
    assert.ok(events.some((e) => e.ev === 'probe.rejected' && e.reason === 'bad-host'));
    assert.equal((await get(s.port, u.pathname + u.search)).status, 200, 'the ticket survived the rejected probes');
  });
});

test('overlay server: page CSP is nonce-only with no remote content and the socket on loopback', async () => {
  await withServer(async (s) => {
    const u = new URL(s.issueTicket('all', 'neon'));
    const r = await get(s.port, u.pathname + u.search);
    const csp = String(r.headers['content-security-policy']);
    const nonce = /'nonce-([A-Za-z0-9_-]+)'/.exec(csp)![1];
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, new RegExp(`connect-src ws://127\\.0\\.0\\.1:${s.port};`));
    assert.match(csp, /img-src data:;/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.doesNotMatch(csp, /https?:\/\/(?!127\.0\.0\.1)/);
    assert.equal(r.headers['access-control-allow-origin'], undefined, 'no CORS header, ever');
    assert.ok(r.body.includes(`<script nonce="${nonce}">`) && r.body.includes(`<style nonce="${nonce}">`));
    assert.doesNotMatch(r.body, /<script(?![^>]*nonce=)/);
    assert.doesNotMatch(r.body, /src=["']https?:/);
    assert.ok(r.body.includes(OVERLAY_THEMES.neon.glow), 'the theme preset is applied');
  });
});

test('overlay server: WebSocket upgrade needs our Origin and a single-use token; inbound frames are dropped', async () => {
  await withServer(async (s, events) => {
    const u = new URL(s.issueTicket('activity'));
    const page = await get(s.port, u.pathname + u.search);
    const ws = new URL(wsOf(page.body));
    const path = ws.pathname + ws.search;
    const origin = `http://127.0.0.1:${s.port}`;
    assert.equal((await upgrade(s.port, path, { origin: 'http://evil.example' })).status, 404, 'foreign Origin');
    assert.equal((await upgrade(s.port, path, {})).status, 404, 'no Origin');
    assert.equal((await upgrade(s.port, path, { origin, host: `localhost:${s.port}` })).status, 404, 'foreign Host');
    assert.equal((await upgrade(s.port, '/ws?t=' + 'B'.repeat(43), { origin })).status, 404, 'forged token');
    s.push('activity', { scene: 'activity', sample: false, age: 'no data yet', ageSec: null, rows: [] });
    const ok = await upgrade(s.port, path, { origin });
    assert.equal(ok.status, 101);
    const f = frames(ok.socket!, ok.head);
    await f.wait((m) => m.some((x) => x.type === 'hello') && m.some((x) => x.type === 'view'));
    assert.equal(s.viewers, 1);
    assert.equal((await upgrade(s.port, path, { origin })).status, 404, 'the token is single-use');
    // anything a page sends is ignored: counted, never parsed or acted on
    ok.socket!.write(clientFrame(JSON.stringify({ type: 'event', name: 'spectator.kill', payload: { agent: 'scanbot' } })));
    ok.socket!.write(clientFrame(JSON.stringify({ method: 'arm', cap: 1e9 })));
    ok.socket!.write(clientFrame('not json'));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(s.dropped, 3);
    assert.ok(events.filter((e) => e.ev === 'viewer.dropped').length === 3);
    const reasons = new Set(events.filter((e) => e.ev === 'probe.rejected').map((e) => (e as { reason: string }).reason));
    for (const r of ['bad-origin', 'bad-host', 'bad-ws-token']) assert.ok(reasons.has(r as never), r);
    // a later push reaches the viewer (outbound works), and only its own scene
    const before = f.msgs.length;
    s.push('coin', { scene: 'coin' });
    s.push('activity', { scene: 'activity', marker: 1 });
    await f.wait((m) => m.some((x) => (x.view as { marker?: number } | undefined)?.marker === 1));
    assert.ok(f.msgs.slice(before).every((x) => x.scene === 'activity'));
    ok.socket!.destroy();
  });
});

test('overlay server: refuses unknown scenes and themes at ticket issue', async () => {
  await withServer(async (s) => {
    assert.throws(() => s.issueTicket('wallet' as never), /unknown overlay scene/);
    assert.throws(() => s.issueTicket('coin', 'beige' as never), /unknown overlay theme/);
  });
});

// ------------------------------------------------------------------------------------------------ model + redaction

test('overlay model: every scene is redacted (addresses head…tail, key material removed)', () => {
  const st = emptyOverlayState(false);
  const now = 2_000_000;
  foldOverlay(st, ev({ t: now - 5000, phase: 'nav', tool: `open_token ${WALLET}`, summary: `opened ${MINT} for wallet ${WALLET} key ${KEY}`, nav: { screen: 'token', mint: MINT } }));
  foldOverlay(st, ev({ t: now - 4000, tool: 'analyze_token', summary: 'verdict', dataAgeSec: 3, detail: { coin: { mint: MINT, symbol: 'FIXT', priceUsd: 0.0042 }, verdict: { label: 'SPECULATIVE', rug: 0.31 } } }));
  foldOverlay(st, ev({ t: now - 3000, tool: 'larp_check', summary: 'larp', detail: { coin: { mint: MINT }, larp: { flags: 2, items: [`site names ${WALLET}`, 'domain 3 days old'] } } }));
  const a = activityView(st, now), c = coinView(st, now);
  const all = JSON.stringify([a, c]);
  assert.doesNotMatch(all, FULL_ADDR_RE, 'no full address or key anywhere in a scene');
  assert.ok(all.includes('Fixt…AAAA') && all.includes('Fixt…BBBB'));
  assert.ok(all.includes('[key]'));
  assert.equal(c.coin!.mint, 'Fixt…AAAA');
  assert.equal(c.coin!.symbol, 'FIXT');
  assert.equal(c.coin!.verdict!.label, 'SPECULATIVE');
  assert.equal(c.coin!.verdict!.rug, '31%');
  assert.equal(c.coin!.larp!.flags, 2);
});

test('overlay model: every scene states its data age, and SAMPLE DATA rides every view of a replay', () => {
  for (const sample of [false, true]) {
    const st = emptyOverlayState(sample);
    const now = 5_000_000;
    assert.equal(activityView(st, now).age, 'no data yet');
    foldOverlay(st, ev({ t: now - 30_000, tool: 'get_holders', dataAgeSec: 12, detail: sanitizeDetail({ coin: { mint: MINT, symbol: 'FIXT' }, holders: { top10Pct: 41.5, count: 1234, basis: 'ex-pools', ageSec: 12 } }) }));
    const a = activityView(st, now), c = coinView(st, now), p = pnlView(st, now);
    for (const v of [a, c, p]) assert.equal(v.sample, sample, `${v.scene} sample tag`);
    assert.equal(a.age, 'data age 42s');
    assert.equal(c.coin!.holders!.top10Pct, 41.5);
    assert.equal(c.coin!.holders!.age, '42s');
    assert.match(c.coin!.holders!.text, /top 10 hold 41\.5% · 1,234 holders/);
    assert.equal(p.png, null);
    assert.match(p.note, /no PAPER trade/);
  }
});

test('overlay model: live signals keep their source and age (and survive the stream redactor)', () => {
  const now = 9_000_000;
  const detail = sanitizeDetail({ coin: { mint: MINT }, liveFlags: [{ kind: 'dev-sell', level: 'warn', title: 'DEV SOLD', text: `dev ${WALLET} sold 12%`, source: 'helius', at: now - 20_000, ageSec: 4, stale: false }] });
  assert.ok(detail?.liveFlags?.length === 1);
  const red = redactSpectatorEvent(ev({ t: now - 20_000, phase: 'note', tool: 'live_signal', detail }));
  assert.ok(Array.isArray(red.detail!.liveFlags), 'the list is not blanked as a sensitive key');
  const st = emptyOverlayState(false);
  foldOverlay(st, red);
  const c = coinView(st, now);
  assert.equal(c.coin!.flags[0].title, 'DEV SOLD');
  assert.equal(c.coin!.flags[0].source, 'helius');
  assert.equal(c.coin!.flags[0].age, '24s');
  assert.match(c.coin!.flags[0].text, /Fixt…BBBB/);
  assert.equal(activityView(st, now).rows.length, 0, 'a live signal is coin data, not an agent call');
  // malformed signals are dropped by the validator
  assert.equal(sanitizeDetail({ liveFlags: [{ kind: 'x', level: 'nuke', title: 't', at: 1, ageSec: 1 }, { kind: 'y', level: 'warn', title: 't', at: 'soon', ageSec: 1 }] }), null);
  assert.equal(sanitizeDetail({ holders: { top10Pct: 140, basis: 'raw' } }), null);
});

test('follow session: a terminal live signal reaches the stream hub, never the agent HUD (timeline / thoughts)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ovl-1427-'));
  const f = new McpFollowSession({ env: { DEXTERM_HOME: home, HOME: home }, pollMs: 60_000 });
  try {
    const sig = { kind: 'dev-sell', mint: MINT, level: 'warn' as const, title: 'DEV SOLD', text: 'dev sold 12%', source: 'helius', dataAgeMs: 2000, stale: false, at: Date.now() };
    f.liveFlag(sig); // not armed yet: dropped
    assert.equal(f.hub.recent().length, 0);
    await f.start();
    f.liveFlag(sig);
    const evs = f.hub.recent();
    assert.equal(evs.length, 1);
    assert.equal(evs[0].phase, 'note');
    assert.equal(evs[0].detail!.liveFlags![0].title, 'DEV SOLD');
    assert.equal(f.view().activity.length, 0, 'not an agent call in the follow view');
    assert.equal(JSON.stringify(f.storyView()).includes('DEV SOLD'), false, 'not an agent thought in the HUD');
  } finally { await f.stop(); rmSync(home, { recursive: true, force: true }); }
});

test('MCP detailFor copies the top-10 holder share from the tool result', () => {
  assert.deepEqual(detailFor('get_holders', { mint: MINT }, { mint: MINT, top10PctExLp: 38.2, holderCount: 900, ageSec: 7 })!.holders, { top10Pct: 38.2, count: 900, basis: 'ex-pools', ageSec: 7 });
  assert.deepEqual(detailFor('get_token', { mint: MINT }, { token: { mint: MINT, symbol: 'FIXT' }, pair: {}, audit: { top10Pct: 55, ageSec: 3 }, stats: { holderCount: 10 } })!.holders, { top10Pct: 55, count: 10, basis: 'raw', ageSec: 3 });
  const dossier = detailFor('get_dossier', { mint: MINT }, { mint: MINT, concentration: { top10PctExLp: 20, holderCount: null, ageSec: 1 } })!;
  assert.equal(dossier.holders!.top10Pct, 20);
  assert.equal(dossier.coin!.mint, MINT);
  assert.equal(detailFor('get_holders', { mint: MINT }, { error: 'rpc down' }), null);
});

// ------------------------------------------------------------------------------------------------ PnL scene

function paperTrade(st: ReturnType<typeof emptyOverlayState>, now: number, closed: boolean): void {
  foldOverlay(st, ev({ t: now - 60_000, tool: 'paper_confirm', summary: 'PAPER buy', detail: { fill: { side: 'buy', symbol: 'FIXT', mint: MINT, sol: -0.5, qty: 100_000, priceUsd: 0.0009, impactPct: 0.4, realizedSol: null } } }));
  if (closed) foldOverlay(st, ev({ t: now - 10_000, tool: 'paper_close', summary: 'PAPER sell', detail: { fill: { side: 'sell', symbol: 'FIXT', mint: MINT, sol: 0.62, qty: 100_000, priceUsd: 0.0011, impactPct: 0.5, realizedSol: 0.12 } } }));
}

test('PnL scene: the agent\'s paper fills draw a PAPER-stamped 1407 card; a refused fill is ignored', () => {
  const st = emptyOverlayState(false);
  const now = 7_000_000;
  foldOverlay(st, ev({ t: now - 70_000, ok: false, tool: 'paper_confirm', detail: { fill: { side: 'buy', symbol: 'FIXT', mint: MINT, sol: -9, qty: 1, priceUsd: 1, impactPct: 0, realizedSol: null } } }));
  paperTrade(st, now, true);
  const v = pnlView(st, now);
  assert.equal(v.stamp, 'PAPER');
  assert.ok(v.png && Buffer.from(v.png, 'base64').subarray(1, 4).toString() === 'PNG');
  assert.equal(v.w, 1200);
  assert.match(v.note, /paper desk/);
  assert.equal(v.age, 'data age 10s');
  // an open position marks on the last fill (an honest, labelled mark) and still draws
  const st2 = emptyOverlayState(true);
  paperTrade(st2, now, false);
  const v2 = pnlView(st2, now);
  assert.equal(v2.stamp, 'PAPER');
  assert.ok(v2.png);
  assert.equal(v2.sample, true);
});

test('PnL scene: a ledger trade stamps LIVE by wallet mode, masks the mint, and a real-mode row is refused', () => {
  const now = 8_000_000;
  const row = (walletMode: LedgerCardRow['walletMode']): LedgerCardRow => ({
    tradeId: 't-1', source: walletMode === 'paper' ? 'paper' : 'live', walletMode, mint: MINT, symbol: 'FIXT', decimals: 6, runId: null, supply: null,
    fills: [
      { t: now - 50_000, side: 'buy', sol: 0.4, usd: null, tokens: 1000, feeSol: 0.00001, txSig: KEY.slice(0, 88) },
      { t: now - 20_000, side: 'sell', sol: 0.5, usd: null, tokens: 1000, feeSol: 0.00001, txSig: KEY.slice(0, 88) },
    ],
  });
  const st = emptyOverlayState(false);
  const live = pnlView(st, now, ledgerOverlayInput(row('devnet'), null));
  assert.equal(live.stamp, 'LIVE');
  assert.equal(live.strip, 'LIVE · DEVNET', 'the page chip names devnet, as the card strip does (verify-1834 F2)');
  assert.ok(live.png);
  const inp = ledgerOverlayInput(row('live'), null);
  assert.equal(inp.mint, 'Fixt…AAAA');
  assert.equal(pnlView(st, now, inp).strip, 'LIVE · WALLET-SIGNED');
  assert.equal(pnlView(st, now, ledgerOverlayInput(row('paper'), null)).strip, 'PAPER · SIMULATED');
  // verify-1834 F1: the LIVE note on the drawn card counts the real signatures, exactly as the H-key card does,
  // and no signature (nor the full mint) is drawn.
  const cardText = (i: Parameters<typeof computeCard>[0]): string => {
    const c = renderCard(computeCard(i, now), { aspect: 'wide' }).canvas;
    const rows: string[] = [];
    for (let y = 0; y < c.h; y++) rows.push(c.ch.slice(y * c.w, (y + 1) * c.w).join(''));
    return rows.join('\n');
  };
  for (const mode of ['live', 'devnet'] as const) {
    const ov = cardText(ledgerOverlayInput(row(mode), null));
    assert.match(ov, /LIVE: 2 wallet-signed txs confirmed/, `${mode}: the note counts both signed fills`);
    const direct = cardText(ledgerCardInput(row(mode)));
    const note = (t: string): string | undefined => t.split('\n').find((l) => l.includes('wallet-signed tx'))?.trim();
    assert.equal(note(ov), note(direct), `${mode}: overlay note = direct card note`);
    assert.ok(!ov.includes(KEY.slice(0, 16)), `${mode}: no tx signature drawn`);
    assert.ok(!ov.includes(MINT), `${mode}: no full mint drawn`);
  }
  assert.equal(pnlView(st, now, inp).png, cardPng(computeCard(inp, now), { aspect: 'wide' }).toString('base64'));
  assert.equal(pnlView(st, now, ledgerOverlayInput(row('paper'), null)).stamp, 'PAPER');
  assert.throws(() => ledgerOverlayInput(row('real'), null), /real-mode/);
});

// ------------------------------------------------------------------------------------------------ engine, page, args

test('overlay engine: folds untrusted stream frames, pushes the three scenes, and has no control surface', async () => {
  const pushed: Array<{ scene: string; view: Record<string, unknown> }> = [];
  const fake = { push: (scene: string, view: unknown) => { pushed.push({ scene, view: view as Record<string, unknown> }); } } as unknown as OverlayServer;
  let clock = 10_000_000;
  const e = new OverlayEngine({ sample: true, server: fake, now: () => clock });
  assert.equal(e.feed(null), false);
  assert.equal(e.feed({ phase: 'result' }), false, 'no timestamp → dropped');
  assert.equal(e.feed({ phase: 'result', t: clock, agent: 'scanbot', tool: 'get_token', detail: { coin: { mint: MINT, symbol: '<b>FIXT</b>' }, bogus: { x: 1 } } }), true);
  e.tick();
  assert.deepEqual(pushed.map((p) => p.scene), ['activity', 'coin', 'pnl']);
  assert.ok(pushed.every((p) => p.view.sample === true));
  // the engine exposes feed / tick / reset only: nothing that could arm, sign, trade or raise a cap
  const methods = Object.getOwnPropertyNames(OverlayEngine.prototype).filter((m) => m !== 'constructor').sort();
  assert.deepEqual(methods, ['feed', 'reset', 'tick']);
  clock += 1000; pushed.length = 0; e.tick();
  assert.deepEqual(pushed.map((p) => p.scene), ['activity', 'coin'], 'an unchanged PnL card is not re-rendered every second');
  e.reset();
  assert.equal(e.state.events, 0);
});

test('overlay engine: a REDACTED stream frame (masked mints) still fills the coin card and the PnL card', () => {
  const pushed = new Map<string, Record<string, unknown>>();
  const fake = { push: (scene: string, view: unknown) => { pushed.set(scene, view as Record<string, unknown>); } } as unknown as OverlayServer;
  const now = 11_000_000;
  const e = new OverlayEngine({ sample: false, server: fake, now: () => now });
  // the frames exactly as the stream server sends them: redactSpectatorEvent copies, through JSON
  const raw = [
    ev({ t: now - 70_000, tool: 'get_holders', detail: { coin: { mint: MINT, symbol: 'FIXT' }, holders: { top10Pct: 25, count: 50, basis: 'ex-pools', ageSec: 2 } } }),
    ev({ t: now - 60_000, tool: 'paper_confirm', detail: { fill: { side: 'buy', symbol: 'FIXT', mint: MINT, sol: -0.5, qty: 100_000, priceUsd: 0.0009, impactPct: 0.4, realizedSol: null } } }),
    ev({ t: now - 10_000, tool: 'paper_close', detail: { fill: { side: 'sell', symbol: 'FIXT', mint: MINT, sol: 0.62, qty: 100_000, priceUsd: 0.0011, impactPct: 0.5, realizedSol: 0.12 } } }),
  ];
  for (const r of raw) assert.equal(e.feed(JSON.parse(JSON.stringify(redactSpectatorEvent(r)))), true);
  e.tick();
  const coin = pushed.get('coin') as unknown as ReturnType<typeof coinView>;
  assert.equal(coin.coin!.symbol, 'FIXT');
  assert.equal(coin.coin!.mint, 'Fixt…AAAA');
  assert.equal(coin.coin!.holders!.top10Pct, 25);
  assert.equal((pushed.get('pnl') as { stamp: string }).stamp, 'PAPER');
  // a full (unredacted) mint is not the stream's shape: that detail is dropped rather than shown
  const e2 = new OverlayEngine({ sample: false, server: fake, now: () => now });
  e2.feed({ ...raw[0] });
  assert.equal(e2.state.coins.size, 0);
});

test('overlay page: transparent body, DOM built with textContent only, no inbound sends', () => {
  const html = renderOverlayPage({ page: 'coin', theme: 'cyberspace', nonce: 'N0nce', wsUrl: 'ws://127.0.0.1:1234/ws?t=abc' });
  assert.match(html, /html,body\{[^}]*background:transparent/);
  assert.doesNotMatch(html, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
  assert.doesNotMatch(html, /\.send\(/, 'the page never sends on the socket');
  assert.doesNotMatch(html, /on(click|load|error)=/);
  assert.match(html, /SAMPLE DATA/);
  assert.equal(Object.keys(OVERLAY_THEMES).length, 3);
});

test('overlay args: scenes, themes and bounds are validated', () => {
  const o = parseOverlayArgs([]);
  assert.ok(typeof o !== 'string' && o.scenes.join() === 'activity,coin,pnl' && o.theme === 'cyberspace');
  const p = parseOverlayArgs(['--scene', 'all', '--theme', 'ice', '--replay', 'x.jsonl', '--loop', '--speed', '4']);
  assert.ok(typeof p !== 'string' && p.scenes.join() === 'all' && p.loop && p.speed === 4);
  assert.match(parseOverlayArgs(['--scene', 'wallet']) as string, /--scene/);
  assert.match(parseOverlayArgs(['--theme', 'x']) as string, /--theme/);
  assert.match(parseOverlayArgs(['--port', '80']) as string, /--port/);
  assert.match(parseOverlayArgs(['--loop']) as string, /--replay/);
  assert.match(parseOverlayArgs(['--arm']) as string, /unknown option/);
});
