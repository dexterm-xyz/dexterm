// task-2170: the Strategy Builder web UI. Fakes only: temp SAMPLE homes, a stub analyst (no Claude spend), a recorded
// launcher (no terminal opens). Covers: single-use tickets, Host / Origin / CSRF rejection, the route-and-tool allowlist
// (no path to real mode, arming, caps, bankrolls, budgets, signing or sending), the fixed-command launch refusing an
// injected strategy id, confirm-before-apply in the chat, redaction of address-like strings, untrusted text rendered
// inert, the read-only watch window, and one end-to-end pass over the real server with the stub analyst.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as engine from '@dexterm/autotrade';
import { AutotradeTools, TOOLS, WEB_CHAT_DENIED_TOOLS } from '@dexterm/mcp';
import { ANALYST_ACTION_TYPES } from '@dexterm/data';
import { WebAuth, RateLimiter, cookieValue, hostOk, originOk, safeEq } from '../src/web/security.ts';
import { webRedact } from '../src/web/redact.ts';
import { MAC_TERMINAL_SCRIPT, WATCH_ARGS, launchWatch, terminalPlan, watchCommand, type Spawner } from '../src/web/launch.ts';
import { WEB_ROUTES, WEB_READ_TOOLS, WEB_ACTION_TOOLS } from '../src/web/api.ts';
import { WebChat, WEB_ACTION_TYPES, WEB_DENY_TOOLS, type RunTurn, type WebChatEvent } from '../src/web/chat.ts';
import { createWebServer, type WebServer } from '../src/web/server.ts';
import { renderWebPage } from '../src/web/page.ts';
import { buildArgv, deniedActionTools, type AnalystRequest } from '../src/analyst/backend.ts';
import { OVERLAY_PAGES } from '../src/overlay/server.ts';
import { parseOverlayArgs } from '../src/overlay-cmd.ts';
import { strategyOverlayView } from '../src/overlay/strategy.ts';
import { watchCmd } from '../src/autotrade-cmd/watch.ts';
import { buildSampleHome, fakeMint } from './fixtures/web-sample-home.ts';

const tmpHome = (): string => mkdtempSync(join(tmpdir(), 'dexterm-2170-'));
const FORBIDDEN_TOOL = /(^|_)(sign|signer|send|submit|broadcast|arm|wallet|key|keypair|withdraw|transfer|raise|setcap|mandate|approve|fund|pay|promote|real|limits?|caps?|bankroll|budget)(_|$)/i;
const FORBIDDEN_ROUTE = /real|arm|sign|send|key|wallet|caps?\b|limit|bankroll|budget|promote|secret|env|token|mnemonic/i;

// ───────────────────────────── security primitives ─────────────────────────────

test('tickets are single use, expire, and a new session ends the old one', () => {
  let now = 1_000_000;
  const a = new WebAuth({ now: () => now, ticketTtlMs: 60_000 });
  const t1 = a.issueTicket();
  const s1 = a.exchange(t1);
  assert.ok(s1);
  assert.equal(a.exchange(t1), null, 'a spent ticket is refused');
  assert.equal(a.check(s1!.token), s1);
  const t2 = a.issueTicket();
  now += 61_000;
  assert.equal(a.exchange(t2), null, 'an expired ticket is refused');
  const s2 = a.exchange(a.issueTicket())!;
  assert.equal(a.check(s1!.token), null, 'one session at a time: the old cookie stops working');
  assert.equal(a.check(s2.token), s2);
  assert.ok(a.csrfOk(s2, s2.csrf));
  assert.ok(!a.csrfOk(s2, s1!.csrf) && !a.csrfOk(s2, undefined) && !a.csrfOk(s2, [s2.csrf]));
  assert.ok(safeEq('abc', 'abc') && !safeEq('abc', 'abd') && !safeEq('abc', 'abcd'));
});

test('cookie, Host and Origin checks are exact', () => {
  assert.equal(cookieValue('a=1; dxw_session=' + 'x'.repeat(43)), 'x'.repeat(43));
  assert.equal(cookieValue('dxw_session=<script>'), null);
  assert.ok(hostOk('127.0.0.1:4000', 4000));
  for (const h of ['localhost:4000', '127.0.0.1:4001', 'evil.example:4000', '127.0.0.1', undefined]) assert.ok(!hostOk(h, 4000), String(h));
  assert.ok(originOk('http://127.0.0.1:4000', 4000));
  for (const o of ['http://localhost:4000', 'https://127.0.0.1:4000', 'null', 'http://evil.example', undefined]) assert.ok(!originOk(o, 4000), String(o));
  const rl = new RateLimiter({ chat: { max: 2, windowMs: 1000 } }, () => 5);
  assert.ok(rl.take('chat') && rl.take('chat') && !rl.take('chat') && !rl.take('nope'));
});

// ───────────────────────────── the allowlist: no path to real mode ─────────────────────────────

test('every route is enumerated; none names or reaches real mode, arming, caps, bankrolls, budgets, signing or sending', () => {
  assert.ok(WEB_ROUTES.length >= 20);
  const seen = new Set<string>();
  for (const r of WEB_ROUTES) {
    const k = `${r.method} ${r.path}`;
    assert.ok(!seen.has(k), `duplicate route ${k}`); seen.add(k);
    assert.ok(r.path.startsWith('/api/'), k);
    assert.ok(!FORBIDDEN_ROUTE.test(r.path), `route ${k} is named like a real-mode / cap / key op`);
    for (const x of r.reaches) assert.ok(!/promote|arm\b|signal|real mode|bankroll|budget|limits_propose|set cap/i.test(x), `${k} reaches ${x}`);
    if (r.method === 'GET') assert.equal(r.change, false, `${k}: a GET never changes state`);
  }
  const served = new Set(TOOLS.map((t) => String(t.name)));
  for (const t of [...WEB_READ_TOOLS, ...WEB_ACTION_TOOLS]) {
    assert.ok(served.has(t), `${t} is a real dexterm tool`);
    assert.ok(!FORBIDDEN_TOOL.test(t), `${t} is money/real-shaped`);
  }
  assert.ok(![...WEB_READ_TOOLS, ...WEB_ACTION_TOOLS].includes('strategy_promote_propose' as never));
});

test('the web chat tool surface: UI actions, promotion, agent factory controls and paper orders are denied at the CLI and server layers', async () => {
  const denied = new Set([...deniedActionTools(WEB_ACTION_TYPES), ...WEB_DENY_TOOLS.map((t) => `mcp__dexterm__${t}`)]);
  for (const a of ANALYST_ACTION_TYPES) assert.ok(denied.has(`mcp__dexterm__${a}`), `UI action ${a} denied`);
  for (const t of ['strategy_promote_propose', 'factory_offer_candidate', 'factory_pause', 'factory_resume', 'factory_run_now', 'strategy_enable', 'strategy_disable', 'strategy_retire', 'paper_confirm', 'paper_open_ticket']) assert.ok(denied.has(`mcp__dexterm__${t}`), t);
  const surface = TOOLS.map((t) => String(t.name)).filter((n) => !denied.has(`mcp__dexterm__${n}`));
  for (const n of surface) assert.ok(!/(^|_)(sign|signer|send|submit|broadcast|arm|wallet|key|keypair|withdraw|transfer|raise|setcap|mandate|fund|pay|promote)(_|$)/i.test(n), `web chat could call ${n}`);
  assert.ok(surface.includes('strategy_change') && surface.includes('strategy_overview') && surface.includes('factory_status'), 'the chat keeps its own tools');
  // the argv the CLI gets carries the deny list
  const req: AnalystRequest = { prompt: 'x', screenState: { screen: 'strategy-builder-web' }, actionTypes: WEB_ACTION_TYPES, denyTools: WEB_DENY_TOOLS };
  const argv = buildArgv(req, '/tmp/mcp.json');
  const dis = argv[argv.indexOf('--disallowedTools') + 1].split(',');
  for (const d of denied) assert.ok(dis.includes(d), `--disallowedTools has ${d}`);
  // and the MCP server refuses them itself when the chat turn says web
  const h = tmpHome();
  const tools = new AutotradeTools({ actor: 'analyst', env: { DEXTERM_HOME: h, DEXTERM_CHAT_TURN: JSON.stringify({ chatId: 'webabcdef', turn: 't1', userText: 'x', surface: 'web' }) } });
  for (const t of WEB_CHAT_DENIED_TOOLS) {
    const r = await tools.call(t, { id: 'scalp', to: 'real', why: 'x' });
    assert.match(String(r.error), /not available in the web chat/, t);
  }
  rmSync(h, { recursive: true, force: true });
});

test('preview refuses real / arm / caps / bankroll actions; the web never writes or removes FACTORY-STOP', async () => {
  const h = tmpHome();
  await buildSampleHome(h, { factory: false });
  const store = new engine.StrategyStore({ home: h });
  const chat = { chatId: 'webtest01', turn: 'u1', userText: '', surface: 'web' as const };
  for (const a of ['real', 'arm', 'caps', 'bankroll', 'raise', 'live', 'signal']) {
    const r = engine.previewChange(h, store, a, 'my-scalp', { chat });
    assert.ok(!r.ok && r.real, a);
  }
  const p = engine.previewChange(h, store, 'factory-pause', null, { chat });
  assert.ok(p.ok);
  const c = engine.confirmChange(h, store, p.ok ? p.change.code : '', { chat: { ...chat, turn: 'u2', userText: `confirm ${p.ok ? p.change.code : ''}` } });
  assert.ok(c.ok, JSON.stringify(c));
  assert.ok(engine.agentPaused(h), 'the web pause is the pause marker');
  assert.equal(engine.factoryStopped(h), null, 'the web never writes FACTORY-STOP');
  engine.writeFactoryStop(h, 'cli', 'user stop');
  const r = engine.previewChange(h, store, 'factory-resume', null, { chat: { ...chat, turn: 'u3' } });
  assert.ok(!r.ok && /cannot remove it/.test(r.why));
  assert.ok(engine.factoryStopped(h), 'FACTORY-STOP is still there');
  // the in-app chat (no surface) keeps its old behaviour
  const app = engine.previewChange(h, store, 'factory-resume', null, { chat: { chatId: 'apptest01', turn: 'a1', userText: '' } });
  assert.ok(app.ok);
  rmSync(h, { recursive: true, force: true });
});

// ───────────────────────────── the fixed-command launch ─────────────────────────────

test('watch launch: a fixed argv; injected or unknown ids are refused; no shell anywhere', () => {
  const known = ['my-scalp', 'scalp'];
  for (const bad of ['my-scalp; rm -rf ~', '../my-scalp', 'my-scalp\n', 'my-scalp\nrm -rf ~', '$(touch /tmp/x)', 'MY-SCALP', '', 'unknown-id', null, 42, ['my-scalp']]) {
    const r = watchCommand(bad, { knownIds: known });
    assert.ok(!r.ok, JSON.stringify(bad));
  }
  const ok = watchCommand('my-scalp', { knownIds: known, node: '/usr/bin/node', entry: '/opt/dexterm/bin/dexterm.mjs', platform: 'linux' });
  assert.ok(ok.ok);
  assert.deepEqual(ok.ok && ok.cmd.argv, ['/usr/bin/node', '/opt/dexterm/bin/dexterm.mjs', ...WATCH_ARGS.map((a) => (a === '<id>' ? 'my-scalp' : a))]);
  const withHome = watchCommand('my-scalp', { knownIds: known, node: 'node', entry: 'd.mjs', home: "/tmp/it's home", platform: 'darwin' });
  assert.ok(withHome.ok && withHome.cmd.argv[0] === '/usr/bin/env' && withHome.cmd.argv[1] === "DEXTERM_HOME=/tmp/it's home");
  assert.ok(withHome.ok && withHome.cmd.display.includes(`'DEXTERM_HOME=/tmp/it'\\''s home'`), 'the copy command is quoted');
  // macOS: the fixed AppleScript gets the argv AFTER `--`, each quoted by AppleScript itself
  const mac = terminalPlan(['node', 'd.mjs', 'autotrade', 'watch', 'my-scalp'], { platform: 'darwin', which: () => true })!;
  assert.equal(mac.bin, 'osascript');
  assert.deepEqual(mac.args.slice(0, MAC_TERMINAL_SCRIPT.length * 2).filter((_, i) => i % 2 === 1), [...MAC_TERMINAL_SCRIPT]);
  assert.deepEqual(mac.args.slice(mac.args.indexOf('--') + 1), ['node', 'd.mjs', 'autotrade', 'watch', 'my-scalp']);
  assert.ok(MAC_TERMINAL_SCRIPT.some((l) => l.includes('quoted form of')));
  const lin = terminalPlan(['a'], { platform: 'linux', which: (b) => b === 'kitty' })!;
  assert.deepEqual([lin.bin, lin.args], ['kitty', ['a']]);
  assert.equal(terminalPlan(['a'], { platform: 'linux', which: () => false }), null);
  const win = terminalPlan(['a'], { platform: 'win32', which: (b) => b === 'wt' })!;
  assert.equal(win.bin, 'wt');
  // spawn: shell false, detached; no terminal = the command to copy
  const calls: Array<{ bin: string; args: string[]; shell: unknown }> = [];
  const spawn: Spawner = (bin, args, opts) => { calls.push({ bin, args, shell: opts.shell }); return { pid: 99, unref() {}, on() { return null; } }; };
  const r = launchWatch(ok.ok ? ok.cmd : (null as never), { platform: 'linux', which: (b) => b === 'gnome-terminal', spawn });
  assert.ok(r.launched);
  assert.deepEqual(calls, [{ bin: 'gnome-terminal', args: ['--', ...(ok.ok ? ok.cmd.argv : [])], shell: false }]);
  const none = launchWatch(ok.ok ? ok.cmd : (null as never), { platform: 'linux', which: () => false, spawn });
  assert.ok(!none.launched && none.command.includes('autotrade watch my-scalp --open-overlay'));
});

// ───────────────────────────── the watch window is read-only ─────────────────────────────

function treeHash(dir: string): string {
  const h = createHash('sha256');
  const walk = (d: string): void => { for (const f of readdirSync(d).sort()) { const p = join(d, f); const s = statSync(p); if (s.isDirectory()) walk(p); else h.update(p).update(readFileSync(p)); } };
  walk(dir);
  return h.digest('hex');
}

test('the watch window observes only: no write, control, arm, size, sign or send path; disk unchanged after a watch', async () => {
  const src = readFileSync(fileURLToPath(new URL('../src/autotrade-cmd/watch.ts', import.meta.url)), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  for (const bad of ['writeFileSync', 'appendFileSync', 'renameSync', 'rmSync', 'unlinkSync', 'requestMemberControl', 'previewChange', 'confirmChange', 'applyProposal', 'writeFactoryStop', 'writeAgentPause', 'forward_start', 'createForwardTest', 'spawn(', 'execFile', 'signal', 'arm(', 'setCap', 'bankroll']) {
    assert.ok(!code.includes(bad), `watch.ts uses ${bad}`);
  }
  // the key handler knows q (quit) and n (a fresh overlay URL) only
  const keys = [...code.matchAll(/k === '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(keys)].sort(), ['\\u0003', 'n', 'q'].sort());
  const h = tmpHome();
  await buildSampleHome(h, { factory: false });
  const before = treeHash(h);
  let out = '';
  const rc = await watchCmd(['my-scalp', '--once', '--json'], { stdout: { write: (s: string) => { out += s; return true; } }, stderr: { write: () => true }, env: { DEXTERM_HOME: h } });
  assert.equal(rc, 0);
  const v = JSON.parse(out);
  assert.equal(v.stamp, 'PAPER · SIMULATED');
  assert.ok(v.bags.some((b: { state: string }) => b.state === 'HELD') && v.bags.some((b: { state: string }) => b.state === 'SOLD'));
  assert.ok(v.rungs.some((r: { hits: number }) => r.hits > 0), 'ladder rungs hit');
  assert.ok(!out.includes(fakeMint(1)), 'mints masked');
  assert.equal(treeHash(h), before, 'a watch writes nothing');
  rmSync(h, { recursive: true, force: true });
});

test('overlay: the strategy scene exists, `dexterm overlay` leaves it to the watch window', () => {
  assert.ok(OVERLAY_PAGES.includes('strategy'));
  assert.match(String(parseOverlayArgs(['--scene', 'strategy'])), /autotrade watch/);
  assert.equal(typeof parseOverlayArgs(['--scene', 'coin']), 'object');
});

// ───────────────────────────── redaction + inert text ─────────────────────────────

test('redaction: addresses masked, key-length runs removed, secret-named fields blanked, the home dir hidden', () => {
  const addr = fakeMint(7);
  const key = '5'.repeat(88);
  const r = webRedact({ note: `bag ${addr} sold`, privateKey: 'abc', nested: { apiKey: 'zzz', deep: [{ s: `k ${key}` }] }, tokens: 3, path: join(homedir(), '.dexterm', 'x') }) as Record<string, any>;
  assert.equal(r.note, `bag ${addr.slice(0, 4)}…${addr.slice(-4)} sold`);
  assert.equal(r.privateKey, '[redacted]');
  assert.equal(r.nested.apiKey, '[redacted]');
  assert.equal(r.nested.deep[0].s, 'k [key]');
  assert.equal(r.tokens, 3);
  assert.equal(r.path, join('~', '.dexterm', 'x'));
  let deep: unknown = 'x'; for (let i = 0; i < 40; i++) deep = { d: deep };
  assert.ok(!JSON.stringify(webRedact({ d: deep, s: addr })).includes(addr));
});

test('untrusted text is rendered inert: no innerHTML / eval in the page script; the CSRF meta is escaped; blocks cannot close', () => {
  const js = readFileSync(fileURLToPath(new URL('../assets/web/web.js', import.meta.url)), 'utf8');
  const code = js.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'setAttribute(\'on', '.src =', 'javascript:']) assert.ok(!code.includes(bad), `web.js uses ${bad}`);
  assert.ok(code.includes('textContent'));
  const page = renderWebPage({ nonce: 'N0nce', csrf: '"><script>x</script>', version: '0.0.0' });
  assert.ok(!page.includes('"><script>x</script>'));
  assert.equal((page.match(/<script/g) ?? []).length, 1, 'one script element, ours');
  assert.match(page, /<script nonce="N0nce">/);
  assert.ok(!/ on[a-z]+="/i.test(page), 'no inline handlers');
});

// ───────────────────────────── the chat: confirm before apply ─────────────────────────────

/** A stub analyst: "turn X off" previews through the REAL strategy_change tool (actor analyst, the chat turn env);
 *  "confirm it for them" makes the model try to confirm on its own; anything else answers in text. */
function stubRun(home: string): RunTurn {
  return (req, h) => {
    void (async () => {
      const env = { DEXTERM_HOME: home, DEXTERM_CHAT_TURN: JSON.stringify(req.chatTurn) };
      const tools = new AutotradeTools({ actor: 'analyst', env });
      h.onInit?.({ model: 'stub', skills: [], mcp: ['dexterm'], sessionId: 'stub-session' });
      const q = req.prompt.split('\n\n').slice(-1)[0];
      const m = /turn ([a-z][a-z0-9-]+) (on|off)/.exec(q);
      if (m) {
        h.onToolCall?.({ name: 'mcp__dexterm__strategy_change', input: { action: m[2], id: m[1] } });
        const r = await tools.call('strategy_change', { action: m[2], id: m[1] });
        h.onText?.(String(r.preview ?? r.error ?? JSON.stringify(r)));
      } else if (/confirm it for them (C[0-9A-F]{6})/.test(q)) {
        const code = /(C[0-9A-F]{6})/.exec(q)![1];
        const r = await tools.call('strategy_change', { confirm: code });
        h.onText?.(String(r.error ?? r.result ?? JSON.stringify(r)));
      } else h.onText?.('The factory has made one paper candidate so far; candidates are not edges.');
      h.onResult?.({ structured: null, rawText: null, costUsd: 0, durationMs: 1, turns: 1, model: 'stub', isError: false, sessionId: 'stub-session' });
    })();
    return { cancel() {} };
  };
}
const until = async (f: () => boolean, ms = 5000): Promise<void> => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 10)); } };
const enabled = (h: string): unknown => JSON.parse(readFileSync(engine.fleetConfigPath(h), 'utf8')).strategies[0].enabled;

test('chat: a change is previewed; the model cannot confirm it; the Confirm button applies it, Cancel cancels', async () => {
  const h = tmpHome();
  await buildSampleHome(h, { factory: false });
  const evs: WebChatEvent[] = [];
  const chat = new WebChat({ home: h, chatId: 'webchat0001', emit: (e) => evs.push(e), run: stubRun(h), env: { DEXTERM_HOME: h } });
  assert.ok(chat.send('turn my-scalp off').ok);
  await until(() => evs.some((e) => e.type === 'confirm'));
  const card = evs.find((e) => e.type === 'confirm') as Extract<WebChatEvent, { type: 'confirm' }>;
  assert.equal(card.action, 'off');
  assert.equal(enabled(h), true, 'a preview changes nothing');
  await until(() => !chat.busy);
  assert.ok(chat.send(`confirm it for them ${card.code}`).ok);
  await until(() => evs.filter((e) => e.type === 'done').length === 2);
  assert.equal(enabled(h), true, 'the model cannot confirm with words the user did not say alone');
  const r = chat.confirm(card.code);
  assert.ok(r.ok, r.text);
  assert.equal(enabled(h), false, 'Confirm applied it');
  // Cancel path
  await until(() => !chat.busy);
  chat.send('turn my-scalp on');
  await until(() => evs.filter((e) => e.type === 'confirm').length === 2);
  const card2 = evs.filter((e) => e.type === 'confirm')[1] as Extract<WebChatEvent, { type: 'confirm' }>;
  chat.cancel(card2.code);
  assert.equal(engine.loadPending(h, card2.code)!.status, 'cancelled');
  assert.equal(enabled(h), false);
  assert.equal(chat.confirm(card2.code).ok, false, 'a cancelled change cannot be confirmed');
  assert.ok(chat.send('x'.repeat(2000)).ok === false);
  rmSync(h, { recursive: true, force: true });
});

// ───────────────────────────── the real server, end to end (stub analyst) ─────────────────────────────

interface Res { status: number; headers: http.IncomingHttpHeaders; body: string }
function req(srv: WebServer, method: string, path: string, o: { headers?: Record<string, string>; body?: string } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: srv.port, method, path, headers: { host: `127.0.0.1:${srv.port}`, ...(o.headers ?? {}) } }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: b }));
    });
    r.on('error', reject);
    if (o.body !== undefined) r.write(o.body);
    r.end();
  });
}

test('end to end: ticket → cookie, Host/Origin/CSRF gates, strategies, builder check, chat off → Confirm, factory pause, watch launch refused/recorded', async () => {
  const h = tmpHome();
  const sample = await buildSampleHome(h);
  const launches: string[][] = [];
  const srv = await createWebServer({ env: { DEXTERM_HOME: h, DEXTERM_DB_PATH: join(h, 'none.db') }, runTurn: stubRun(h), launch: (cmd) => { launches.push(cmd.argv); return { launched: true, via: 'test', command: cmd.display }; } });
  try {
    const url = new URL(srv.issueUrl());
    const ticket = url.searchParams.get('t')!;
    assert.equal((await req(srv, 'GET', '/api/strategies')).status, 401, 'no session');
    const ex = await req(srv, 'GET', `/?t=${ticket}`);
    assert.equal(ex.status, 303);
    const cookie = String(ex.headers['set-cookie']).split(';')[0];
    assert.match(String(ex.headers['set-cookie']), /HttpOnly; SameSite=Strict/);
    assert.equal((await req(srv, 'GET', `/?t=${ticket}`)).status, 403, 'the ticket is single use');
    assert.equal((await req(srv, 'GET', '/', { headers: { host: `localhost:${srv.port}`, cookie } })).status, 404, 'DNS-rebind: Host must be 127.0.0.1:port');
    const page = await req(srv, 'GET', '/', { headers: { cookie } });
    assert.equal(page.status, 200);
    const csp = String(page.headers['content-security-policy']);
    const nonce = /nonce-([A-Za-z0-9_-]+)/.exec(csp)![1];
    assert.match(csp, /default-src 'none'/);
    assert.ok(page.body.includes(`<script nonce="${nonce}">`));
    const csrf = /name="dexterm-csrf" content="([^"]+)"/.exec(page.body)![1];
    const post = (path: string, body: unknown, extra: Record<string, string> = {}) => req(srv, 'POST', path, { headers: { cookie, origin: srv.origin, 'x-dexterm-csrf': csrf, 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) });
    const J = async (p: Promise<Res>) => JSON.parse((await p).body);

    assert.equal((await post('/api/strategies/check', {}, { 'x-dexterm-csrf': 'wrong' })).status, 403, 'bad CSRF');
    assert.equal((await post('/api/strategies/check', {}, { origin: 'http://evil.example' })).status, 403, 'bad Origin');
    assert.equal((await req(srv, 'POST', '/api/strategies/check', { headers: { cookie, 'x-dexterm-csrf': csrf, 'content-type': 'application/json' }, body: '{}' })).status, 403, 'no Origin');
    assert.equal((await post('/api/strategies/check', {}, { 'content-type': 'text/plain' })).status, 400, 'JSON only');
    assert.equal((await req(srv, 'GET', '/api/nothing', { headers: { cookie } })).status, 404);
    assert.equal((await req(srv, 'GET', '/../../etc/passwd', { headers: { cookie } })).status, 404);

    const st = await J(req(srv, 'GET', '/api/strategies', { headers: { cookie } }));
    const ids = st.strategies.map((s: { id: string }) => s.id);
    assert.ok(ids.includes('my-scalp') && ids.includes(sample.generated[0]));
    const gen = st.strategies.find((s: { id: string }) => s.id === sample.generated[0]);
    assert.equal(gen.source, 'generated');
    assert.ok(gen.numbers.heldOut && typeof gen.numbers.heldOut.n === 'number', 'held-out numbers come from the report');
    assert.equal((await J(req(srv, 'GET', '/api/strategy?id=../../etc', { headers: { cookie } }))).error, 'unknown strategy id');
    const det = await J(req(srv, 'GET', '/api/strategy?id=my-scalp', { headers: { cookie } }));
    assert.ok(det.words.entry.length && det.cook.bags.length);
    const all = JSON.stringify(st) + JSON.stringify(det);
    for (let i = 1; i <= 4; i++) assert.ok(!all.includes(fakeMint(i)), 'no full mint in a response');
    assert.ok(!all.includes(h), 'no home path in a response');

    // builder: a tighter edit checks, proposes, applies; a /mode or /bankroll edit is refused by the proposal policy
    const ops = [{ op: 'replace', path: '/risk/maxConcurrent', value: 1 }];
    const chk = await J(post('/api/strategies/check', { kind: 'edit', id: 'my-scalp', ops }));
    assert.ok(chk.ok && chk.riskDelta === 'tighter');
    for (const path of ['/mode', '/bankroll/startUsd', '/agent/budgetUsdPerDay']) {
      const bad = await J(post('/api/strategies/check', { kind: 'edit', id: 'my-scalp', ops: [{ op: 'replace', path, value: path === '/mode' ? 'real' : 99999 }] }));
      assert.equal(bad.ok, false, path);
    }
    const prop = await J(post('/api/strategies/propose', { kind: 'edit', id: 'my-scalp', ops, why: 'one at a time' }));
    assert.ok(prop.proposalId, JSON.stringify(prop));
    assert.equal(new engine.StrategyStore({ home: h }).raw('my-scalp')!.risk.maxConcurrent, 2, 'a proposal is not a write');
    assert.equal((await J(post('/api/proposals/apply', { proposalId: prop.proposalId }))).ok, false, 'Apply needs the explicit confirm');
    const ap = await J(post('/api/proposals/apply', { proposalId: prop.proposalId, confirm: 'apply' }));
    assert.ok(ap.ok, ap.message);
    assert.equal(new engine.StrategyStore({ home: h }).raw('my-scalp')!.risk.maxConcurrent, 1);

    // chat over SSE: "turn my-scalp off" → preview card → the Confirm button applies it
    const events: WebChatEvent[] = [];
    const sse = http.request({ host: '127.0.0.1', port: srv.port, path: '/api/chat/stream', headers: { host: `127.0.0.1:${srv.port}`, cookie } }, (res) => {
      let buf = ''; res.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n\n')) >= 0) { const blk = buf.slice(0, i); buf = buf.slice(i + 2); if (blk.startsWith('data: ')) events.push(JSON.parse(blk.slice(6))); } });
    });
    sse.end();
    await new Promise((r) => setTimeout(r, 100));
    assert.ok((await J(post('/api/chat/message', { text: 'turn my-scalp off' }))).ok);
    await until(() => events.some((e) => e.type === 'confirm'));
    const card = events.find((e) => e.type === 'confirm') as Extract<WebChatEvent, { type: 'confirm' }>;
    assert.equal(enabled(h), true);
    const conf = await J(post('/api/change/confirm', { code: card.code }));
    assert.ok(conf.ok, conf.text);
    assert.equal(enabled(h), false);
    await until(() => events.some((e) => e.type === 'resolved'));
    await until(() => events.some((e) => e.type === 'done'));
    assert.ok((await J(post('/api/chat/message', { text: 'what has the factory made so far?' }))).ok);
    await until(() => events.filter((e) => e.type === 'done').length === 2);
    assert.match(events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join(''), /not edges/);
    sse.destroy();

    // factory: pause from the web = the pause marker; FACTORY-STOP is shown and cannot be removed here
    const pv = await J(post('/api/change/preview', { action: 'factory-pause' }));
    assert.ok(pv.ok);
    assert.ok((await J(post('/api/change/confirm', { code: pv.code }))).ok);
    assert.ok(engine.agentPaused(h) && !engine.factoryStopped(h));
    engine.writeFactoryStop(h, 'cli', 'stop');
    const f = await J(req(srv, 'GET', '/api/factory', { headers: { cookie } }));
    assert.equal(f.stopFile.by, 'cli');
    const rs = await J(post('/api/change/preview', { action: 'factory-resume' }));
    assert.ok(!rs.ok && /cannot remove it/.test(rs.why));
    for (const a of ['real', 'arm']) assert.equal((await J(post('/api/change/preview', { action: a, id: 'my-scalp' }))).refused, 'real-mode');

    // watch it cook: injected ids never reach the launcher; a listed id launches the fixed command (3 a minute: the
    // other injected shapes are in the unit test above)
    for (const bad of ['my-scalp; rm -rf ~', '../x\nrm -rf ~']) assert.equal((await J(post('/api/watch', { id: bad }))).launched, false, bad);
    assert.equal(launches.length, 0);
    const w = await J(post('/api/watch', { id: 'my-scalp' }));
    assert.ok(w.launched && /no spectator session/.test(w.spectator));
    assert.deepEqual(launches[0].slice(-4), ['autotrade', 'watch', 'my-scalp', '--open-overlay']);

    // one session at a time
    const ex2 = await req(srv, 'GET', `/?t=${new URL(srv.issueUrl()).searchParams.get('t')}`);
    assert.equal(ex2.status, 303);
    assert.equal((await req(srv, 'GET', '/api/session', { headers: { cookie } })).status, 401, 'the old session ended');
    assert.ok(!existsSync(join(h, 'autotrade', 'factory', 'FACTORY-STOP')) || engine.factoryStopped(h)?.by === 'cli');
  } finally {
    await srv.close();
    rmSync(h, { recursive: true, force: true });
  }
});

test('forward start from the web never passes a bankroll; rate limits answer 429', async () => {
  const h = tmpHome();
  await buildSampleHome(h, { factory: false });
  const calls: Array<[string, Record<string, unknown>]> = [];
  const fake = { call: async (n: string, a: Record<string, unknown>) => { calls.push([n, a]); return n === 'strategy_overview' ? { strategies: [] } : { ok: true }; } } as unknown as AutotradeTools;
  const srv = await createWebServer({ env: { DEXTERM_HOME: h }, tools: fake, launch: (c) => ({ launched: false, via: null, command: c.display }) });
  try {
    const ex = await req(srv, 'GET', `/?t=${new URL(srv.issueUrl()).searchParams.get('t')}`);
    const cookie = String(ex.headers['set-cookie']).split(';')[0];
    const page = await req(srv, 'GET', '/', { headers: { cookie } });
    const csrf = /name="dexterm-csrf" content="([^"]+)"/.exec(page.body)![1];
    const post = (path: string, body: unknown) => req(srv, 'POST', path, { headers: { cookie, origin: srv.origin, 'x-dexterm-csrf': csrf, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    await post('/api/forward/start', { id: 'my-scalp', hours: 2, bankrollUsd: 1_000_000 });
    const fw = calls.find((c) => c[0] === 'strategy_forward_start')!;
    assert.deepEqual(fw[1], { id: 'my-scalp', hours: 2 });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await post('/api/watch', { id: 'my-scalp' })).status);
    assert.deepEqual(codes, [200, 200, 200, 429, 429]);
  } finally { await srv.close(); rmSync(h, { recursive: true, force: true }); }
});

test('the sample home stays SAMPLE: synthetic coins only', async () => {
  const h = tmpHome();
  await buildSampleHome(h, { factory: false });
  const v = strategyOverlayView({ home: h, store: new engine.StrategyStore({ home: h }), id: 'my-scalp' });
  assert.ok(v.bags.every((b) => /^SAMPLE\d$/.test(b.symbol)));
  writeFileSync(join(h, 'marker'), 'x');
  rmSync(h, { recursive: true, force: true });
});

test('chat redaction holds across stream deltas: an address split in two is still masked', async () => {
  const addr = fakeMint(9);
  const evs: WebChatEvent[] = [];
  const run: RunTurn = (_req, h) => {
    h.onText?.(`the bag ${addr.slice(0, 20)}`); h.onText?.(`${addr.slice(20)} was sold `); h.onText?.('on paper.');
    h.onResult?.({ structured: null, rawText: null, costUsd: 0, durationMs: 1, turns: 1, model: 'stub', isError: false, sessionId: 's' });
    return { cancel() {} };
  };
  const chat = new WebChat({ home: tmpHome(), chatId: 'webchat0002', emit: (e) => evs.push(e), run, env: {} });
  assert.ok(chat.send('which bag sold?').ok);
  const text = evs.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('');
  assert.ok(!text.includes(addr), text);
  assert.ok(text.includes(`${addr.slice(0, 4)}…${addr.slice(-4)}`) && text.endsWith('on paper.'), text);
});
