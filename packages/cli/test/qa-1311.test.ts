// task-1311 regression tests for the v0.1 QA BLOCKERS/MAJORs (internal QA evidence, not published: dexterm-v01-qa-report.md).
// Each test names its QA id. The interactive blockers (B1, B3) are driven through the REAL binary over
// a pty with the QA report's own driver (the internal dexterm-v01-qa-evidence/tools/drive.py),
// reproducing the exact repro keystrokes, so a skipped fix can't hide behind a green unit test. The
// rest (B2, B5, M4, M5) are deterministic in-process checks on the same code paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyAction, copyToClipboard } from '../src/main.ts';
import { makeFixtureState, syncAnalyst, pinNewpairsSelection, renderFrame, type AppState } from '../src/state.ts';
import { createReplayFeed, createLiveFeed, unlimitedBuckets } from '../src/feed.ts';
import { makeFeedState } from '../src/state.ts';
import { LiveContext, TokenLive } from '../src/live/index.ts';
import { screenerView } from '../src/screener/view.ts';
import { presetSpec, bakedFilter } from '../src/screener/presets.ts';
import { fromFixture } from '../src/screener/rows.ts';
import { makeFixtures } from '../src/fixtures.ts';
import { AnalystSession } from '../src/analyst/session.ts';
import { renderAnalystSession } from '../src/screens/analyst-session.ts';
import { Canvas, THEMES, type ScreenKey } from '@dexterm/tui';
import { createDataLayer, FakeClock, type HttpRequest, type HttpResponse } from '@dexterm/data';

const here = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(here, '..', 'bin', 'dexterm.mjs');
const SAMPLE = resolve(here, '..', '..', 'data', 'fixtures', 'live-sample.json');
// task-1319: the QA driver is vendored into the repo (packages/cli/test/measure/drive.py) so a clean
// checkout runs these instead of silently skipping; the original out-of-repo evidence path is a fallback.
const DRIVE_VENDORED = resolve(here, 'measure', 'drive.py');
const DRIVE_EVIDENCE = resolve(here, '..', '..', '..', '..', '..', 'expert-coder', 'handoffs', 'dexterm-v01-qa-evidence', 'tools', 'drive.py');
const DRIVE = existsSync(DRIVE_VENDORED) ? DRIVE_VENDORED : DRIVE_EVIDENCE;
const hasDriver = (() => { try { execFileSync('python3', ['-c', 'import pty'], { stdio: 'ignore' }); return existsSync(DRIVE); } catch { return false; } })();
const skip = hasDriver ? false : 'python3 pty + QA drive.py not present (archive copy)';

/** Run the real binary under the QA pty driver with a key script; return the captured frames + meta.
 *  Every script opens with `WAIT:WELCOME_TO_DEXTERM` (task-1410): under parallel-suite load the first key
 *  must not race the app's first paint; the driver then shifts the rest of the script by the wait. */
function drive(name: string, keys: string, extraArgs: string[] = [], extraEnv: string[] = []): { frames: string; meta: string; snap: (label: string) => string } {
  const out = mkdtempSync(join(tmpdir(), `qa1311-${name}-`));
  const home = mkdtempSync(join(tmpdir(), `qa1311-home-${name}-`));
  const args = ['-I', DRIVE, '--cwd', resolve(here, '..', '..', '..'), '--out', out, '--name', name,
    '--cols', '140', '--rows', '40', '--grace', '6',
    '--env', 'DEXTERM_OFFLINE=1', '--env', `DEXTERM_HOME=${home}`, '--env', 'COLORTERM=truecolor',
    ...extraEnv.flatMap((e) => ['--env', e]),
    '--keys', keys, '--', 'node', BIN, '--fixtures', '--no-boot', '--tz', 'UTC', ...extraArgs];
  const r = spawnSync('python3', args, { encoding: 'utf8', timeout: 120_000 });
  assert.equal(r.status, 0, `pty driver failed: ${r.stderr}`);
  const frames = readFileSync(join(out, `${name}.frames.txt`), 'utf8');
  const meta = readFileSync(join(out, `${name}.meta.txt`), 'utf8');
  // frames file blocks start with "==== t=..s before <KEY> (...) ====" — return the block for a SNAP label
  const snap = (label: string): string => {
    const parts = frames.split('==== ');
    const hit = parts.find((p) => p.startsWith(`t=`) && p.includes(`before SNAP:${label} `));
    return hit ?? '';
  };
  return { frames, meta, snap };
}

/**
 * A fake `claude` on PATH so the interactive first-question path can be driven without a real (paid)
 * run: it logs every spawn to a file (proving a run was/was not launched) and emits a minimal
 * stream-json turn that resolves to a known answer. Returns the PATH override + the spawn-log path.
 */
function makeFakeClaude(name: string): { envPath: string; logPath: string; sawSpawn: () => boolean } {
  const dir = mkdtempSync(join(tmpdir(), `qa1311-fakeclaude-${name}-`));
  const logPath = join(dir, 'spawn.log');
  writeFileSync(logPath, ''); // pre-create so an empty log (no spawn) still reads cleanly
  const bin = join(dir, 'claude');
  // Logs the spawn, then streams one assistant turn whose text + result is the sentinel answer.
  const script = [
    '#!/bin/sh',
    'echo spawned >> "$DEXTERM_FAKE_LOG"',
    `printf '%s\\n' '{"type":"system","subtype":"init","model":"fake-sonnet","session_id":"qa-sess-1","mcp_servers":[],"skills":[]}'`,
    `printf '%s\\n' '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"RUGCHECKANSWER42"}}}'`,
    `printf '%s\\n' '{"type":"result","subtype":"success","result":"RUGCHECKANSWER42","total_cost_usd":0,"duration_ms":10,"num_turns":1,"is_error":false,"session_id":"qa-sess-1"}'`,
    '',
  ].join('\n');
  writeFileSync(bin, script, { mode: 0o755 });
  return {
    envPath: `PATH=${dir}:${process.env.PATH ?? ''}`,
    logPath,
    sawSpawn: () => existsSync(logPath) && readFileSync(logPath, 'utf8').includes('spawned'),
  };
}

// ---------------------------------------------------------------- B1
test('QA B1: the Analyst tab is not a trap — number keys are not typed into the box and q quits', { skip }, () => {
  // repro (adapted to the fixed key model): launch · space (dismiss welcome) · 4 (analyst tab) ·
  // snapshot · q  — `q` must quit (never type into the input), proving the tab is not a trap.
  // WAIT (task-1319): block until the analyst tab has painted before the SNAP, so a slow paint under
  // parallel CPU load can't catch an empty/katakana frame (the B1-family flake) — the content is absent,
  // not corrupted, so a fixed 1.9 s offset was the bug, not the rain.
  // Two WAITs: the first lands us on the analyst tab (header), the second waits for its footer to finish
  // painting (a single frame flush can arrive split across reads, so the header can be present a beat
  // before the `q  quit` footer) — both are asserted below, so the SNAP must hold for both.
  const r = drive('b1', '0.3:WAIT:WELCOME_TO_DEXTERM@20,0.6:SPACE,1.3:4,1.4:WAIT:✦_ANALYST,1.5:WAIT:q__quit,1.9:SNAP:analyst,2.4:q,4.0:SNAP:after-q');
  assert.match(r.snap('analyst'), /✦ ANALYST/, 'the analyst tab opened');
  assert.match(r.snap('analyst'), /q {2}quit/, 'the unfocused tab offers `q quit` in the footer (q is a hotkey, not input)');
  assert.match(r.meta, /exit: 0/, 'q quit cleanly from the analyst tab (q was not typed into the box)');
  assert.match(r.meta, /killed by driver: False/, 'the app exited on its own, the driver did not have to kill it');
  assert.match(r.meta, /restored at tail: True/, 'the terminal was restored');
});

// ---------------------------------------------------------------- B3
test('QA B3: typing a question on the Analyst tab fires no hotkeys — `a` does not launch a run', { skip }, () => {
  // repro: launch · space · 4 (analyst) · i (focus the input) · type "what is a rug" · snapshot.
  // The `a` in "a rug" must be typed, not launch a trench-scan; the whole question lands in the box.
  const r = drive('b3', '0.3:WAIT:WELCOME_TO_DEXTERM@20,0.6:SPACE,1.3:4,1.4:WAIT:✦_ANALYST,1.9:i,2.3:TYPE:what_is_a_rug,3.2:WAIT:what_is_a_rug,3.3:SNAP:typed,3.6:ESC,3.9:ESC,4.2:q');
  assert.match(r.snap('typed'), /what is a rug/, 'the typed question (incl. the `a`) lands in the input, no hotkey fired');
  assert.match(r.meta, /exit: 0/, 'esc blurs then backs out and q quits');
});

// ---------------------------------------------------------------- DEFECT 1 (first question never sent)
test('QA DEFECT 1: the FIRST free-text question on a fresh session spawns claude and resolves', { skip }, () => {
  // repro: launch · space (dismiss welcome) · 4 (analyst tab) · i (focus) · type a question · ⏎.
  // The old bug: a brand-new session started as `busy`, so `ask()` queued the first question behind a
  // turn that never began — 0 claude spawned, a permanent "queued: … will ask" banner. The fix must
  // SEND it: assert a real spawn happened AND the answer resolved (no stuck queue banner).
  const fake = makeFakeClaude('d1');
  const r = drive('d1', '0.3:WAIT:WELCOME_TO_DEXTERM@20,0.6:SPACE,1.3:4,1.4:WAIT:✦_ANALYST,1.9:i,2.3:TYPE:is_this_safe,3.2:ENTER,3.3:WAIT:RUGCHECKANSWER42@12,5.6:SNAP:answered,6.0:ESC,6.4:q',
    [], [fake.envPath, `DEXTERM_FAKE_LOG=${fake.logPath}`]);
  assert.ok(fake.sawSpawn(), 'the first question actually spawned claude (it was sent, not left queued)');
  const answered = r.snap('answered');
  assert.doesNotMatch(answered, /queued:/, 'no "queued" banner — the first question was not stuck behind a never-started turn');
  assert.doesNotMatch(answered, /will ask when the run finishes/, 'the question is not waiting on a phantom run');
  assert.match(answered, /RUGCHECKANSWER42/, 'the analyst answer resolved and rendered on the tab');
});

// ---------------------------------------------------------------- DEFECT 2 (welcome card swallows 1-4)
test('QA DEFECT 2: `4` on the welcome card dismisses it AND switches to the Analyst tab (no paid run)', { skip }, () => {
  // repro: fresh launch · 4 (while the welcome card is up) · type the dangerous "what is a rug".
  // The old bug: `4` only dismissed the card, dropping the user on the screener where the `a` in the
  // typed text fired `analyst.toggle` → a real paid rug-check run. The fix makes `4` dismiss AND
  // navigate in one keypress, landing on the Analyst tab where `a` only focuses the input.
  const fake = makeFakeClaude('d2');
  const r = drive('d2', '0.3:WAIT:WELCOME_TO_DEXTERM@20,0.8:4,0.9:WAIT:✦_ANALYST,1.4:SNAP:analyst,1.8:TYPE:what_is_a_rug,3.4:SNAP:typed,3.8:ESC,4.1:ESC,4.4:q',
    [], [fake.envPath, `DEXTERM_FAKE_LOG=${fake.logPath}`]);
  assert.match(r.snap('analyst'), /✦ ANALYST/, '`4` on the welcome card switched to the Analyst tab in the same keypress');
  assert.ok(!fake.sawSpawn(), 'navigating + typing never launched a paid run — `a` on the analyst tab only focuses the input');
  assert.match(r.meta, /exit: 0/, 'the app quit cleanly');
});

// ---------------------------------------------------------------- B2
test('QA B2: `i` focuses the chat input on the token screen (press-i-to-ask replaces press-4)', () => {
  const s = makeFixtureState({ screen: 'token', selected: 0 });
  const stack: ScreenKey[] = [];
  assert.notEqual(s.aiFocused, true);
  applyAction(s, 'input.focus', stack);
  assert.equal(s.aiFocused, true, '`i` focuses the input');
  assert.equal(s.aiOpen, true, 'the analyst panel is shown so there is somewhere to type');
});

// ---------------------------------------------------------------- B5
test('QA B5: `y` copies the full contract address and confirms', () => {
  const s = makeFixtureState({ screen: 'token', selected: 0 });
  const mint = s.token!.mint;
  assert.ok(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint), 'a full base58 mint');
  applyAction(s, 'copy.ca', []);
  assert.equal(s.pendingCopy, mint, 'the full mint is queued for the clipboard (the loop runs pbcopy/xclip/clip)');
  assert.match(s.screener.notice ?? '', /copied contract address/, 'a confirmation is shown');
  assert.doesNotThrow(() => copyToClipboard(mint), 'the clipboard helper never throws, even with no tool present');
});

// ---------------------------------------------------------------- M4
test('QA M4: the live screener defaults to the trench feed; the baked filter hides blue chips/stocks/stables', () => {
  const feed = createLiveFeed({ dbPath: undefined });
  try { assert.equal(feed.preset, 'trench', 'the live app opens on the trench feed'); } finally { feed.close(); }

  const spec = presetSpec('trench');
  assert.ok(spec, 'the trench preset exists and is reachable in the feed switcher');
  const f = bakedFilter(spec!);
  assert.ok(f, 'the trench feed has a baked filter');
  const base = fromFixture(makeFixtures(7).tokens[0]);
  const blueChip = { ...base, symbol: 'ORCA', verified: true, liq: 5_000_000 };
  const stock = { ...base, symbol: 'NVDAx', verified: true, liq: 800_000 };
  const memecoin = { ...base, symbol: 'WIF', verified: false, liq: 50_000 };
  const dust = { ...base, symbol: 'DEAD', verified: false, liq: 200 };
  assert.equal(f!.predicate(blueChip), false, 'a verified blue chip is hidden');
  assert.equal(f!.predicate(stock), false, 'a tokenized stock is hidden');
  assert.equal(f!.predicate(memecoin), true, 'an unverified memecoin over the floor is kept');
  assert.equal(f!.predicate(dust), false, 'dust below the liquidity floor is hidden');
});

// ---------------------------------------------------------------- M5
test('QA M5: opening a token never starts a paid analyst run; each token keeps its own chat', async () => {
  const feed = createReplayFeed(SAMPLE);
  await feed.refresh();
  const state = makeFeedState(feed, 'replay', { selected: 0 });
  state.live = new LiveContext(feed.dl, { mode: 'replay' });
  const stack: ScreenKey[] = [];
  // pick a real (non-fixture) row so `open` takes the live path
  const idx = screenerView(state.screener).findIndex((r) => !(r as { fixture?: unknown }).fixture);
  state.selected = Math.max(0, idx);
  applyAction(state, 'open', stack);
  assert.equal(state.screen, 'token', 'the token opened');
  assert.equal(state.pendingAnalyst ?? null, null, 'no paid dossier is queued on ⏎ (QA M5)');

  // moving between tokens restores the token's own conversation instead of cancelling it
  const mintA = state.live.token?.view.mint ?? 'A';
  const sessionA = { marker: 'A' } as unknown as NonNullable<AppState['analyst']>;
  state.analystByMint!.set(mintA, sessionA);
  state.analyst = null;
  syncAnalyst(state);
  assert.equal(state.analyst, sessionA, "returning to a token restores that token's chat");
  state.live.close();
  feed.close();
});

// ---------------------------------------------------------------- M8
test('QA M8: the New pairs highlight follows the picked coin by mint when new creates insert on top', () => {
  // the cursor is on mint "B"; a new coin lands at the top (newest-first), shifting every index.
  let list = [{ mint: 'X' }, { mint: 'A' }, { mint: 'B' }];
  const s = { screen: 'newpairs', selected: 2, selectedMint: 'B', live: { newpairs: { list: () => list } } } as unknown as AppState;
  pinNewpairsSelection(s);
  assert.equal(s.selected, 2, 'pinned on B');
  list = [{ mint: 'NEW' }, { mint: 'X' }, { mint: 'A' }, { mint: 'B' }]; // a create inserted at the top
  pinNewpairsSelection(s);
  assert.equal(s.selected, 3, 'the highlight tracked the mint to its new index, not the stale row 2');
  assert.equal(list[s.selected].mint, 'B', 'still on the coin the user picked');
});

// ---------------------------------------------------------------- M12
test('QA M12: a long analyst answer is not cut at 16 lines — it scrolls, and reveals in full', () => {
  const sess = new AnalystSession({ skill: 'token-dossier', screenState: {} }, () => {});
  sess.status = 'done';
  sess.doneAt = Date.now();
  sess.verdict = null;
  sess.summary = Array.from({ length: 40 }, (_, i) => `answer line number ${i + 1} of forty`);
  assert.equal(sess.summary.length, 40, 'the full answer is kept (no slice(0,16))');

  const draw = (scroll: number): string => {
    const c = new Canvas(64, 22, THEMES.midnight);
    c.fill(0, 0, 64, 22, ' ', { bg: THEMES.midnight.bg });
    renderAnalystSession(c, 0, 0, 64, 22, sess, { frame: 0, code: '0123456789abcdef', calm: true, scroll, revealAll: true });
    return c.toPlain();
  };
  const top = draw(0);
  assert.match(top, /answer line number 1 of forty/, 'the top of the answer shows, fully revealed');
  assert.match(top, /more .* j\/k/, 'a scroll marker tells the user there is more');
  assert.doesNotMatch(top, /line number 40 of forty/, 'the last line is below the fold at scroll 0');
  const bottom = draw(40);
  assert.match(bottom, /answer line number 40 of forty/, 'scrolling reaches the end of the answer');
});

// ---------------------------------------------------------------- M13
test('QA M13: in live mode the Analyst tab shows no canned demo conversation or 2024 fixture tickers', async () => {
  const feed = createReplayFeed(SAMPLE);
  await feed.refresh();
  const state = makeFeedState(feed, 'replay', { screen: 'analyst' });
  state.live = new LiveContext(feed.dl, { mode: 'replay' });
  const out = renderFrame(state, 176, 48).toPlain();
  for (const fake of ['SIGMA', 'GOAT', 'CHILLGUY', 'NEIRO', 'screen for tokens under $5M']) {
    assert.doesNotMatch(out, new RegExp(fake), `the demo artefact "${fake}" must not sit next to live data`);
  }
  assert.match(out, /No conversation yet/, 'the live tab explains how to start a real conversation');
  // the screener spotlight no longer dangles an internal "D-15" ticket at the user
  state.screen = 'screener';
  assert.doesNotMatch(renderFrame(state, 176, 48).toPlain(), /D-15/);
  feed.close();
});

// ---------------------------------------------------------------- M9
test('QA M9: a fresh pair with no indexed pool keeps the mcap known from the new-pairs stream', async () => {
  const clock = new FakeClock(1_700_000_000_000);
  const MINT = 'FreshPumpMintaaaaaaaaaaaaaaaaaaaaaaaaaaapump';
  const json = (status: number, body: unknown): HttpResponse => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), latencyMs: 1 });
  const jup = { id: MINT, name: 'Fresh', symbol: 'FRESH', decimals: 6, launchpad: 'pump.fun', isVerified: false, usdPrice: null, mcap: null, fdv: null, liquidity: null };
  const transport = async (req: HttpRequest): Promise<HttpResponse> => {
    const u = new URL(req.url);
    if (u.pathname.startsWith('/tokens/v1/solana/')) return json(200, []);   // no DexScreener pool yet
    if (u.pathname === '/tokens/v2/search') return json(200, [jup]);          // Jupiter sees the mint, no market
    if (u.pathname === '/price/v3') return json(200, {});
    return json(404, {});
  };
  const dl = createDataLayer({ clock, transport, buckets: unlimitedBuckets() });
  // seeded from the New pairs stream: mcap/price are known even before any pool exists
  const live = new TokenLive(dl, { mint: MINT, symbol: 'FRESH', name: 'Fresh', launchpad: 'pump.fun', mcap: 3000, price: 0.0000031, ageMin: 0.5 }, { now: () => clock.now() });
  const p = live.load();
  for (let i = 0; i < 30 && live.view.updatedAt === null; i++) await clock.advance(100);
  await p;
  assert.equal(live.view.mcap, 3000, 'the known mcap is preserved, not blanked to —');
  assert.equal(live.view.price, 0.0000031, 'the known price is preserved');
  dl.close();
});
