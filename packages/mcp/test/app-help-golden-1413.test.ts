// task-1413 — the app-help golden set: >=40 "how do I …" questions, each with the entry id a user should
// land on. A deterministic (no-model) retrieval test: searchAppHelp(q)[0].id must equal the expected id.
// This guards both the entries' coverage and the retrieval's ranking. Tone of a real model answer is NOT
// judged here (that is reported from live `claude` transcripts in the handoff).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadAppHelp, searchAppHelp, getAppHelp } from '../src/app-help.ts';

/** [question, expected top entry id]. */
const GOLDEN: Array<[string, string]> = [
  // open / paste a coin
  ['how do I paste a coin', 'open-a-coin'],
  ['paste a contract address to open it', 'open-a-coin'],
  ['open a token from a dexscreener link', 'open-a-coin'],
  ['open a coin by its CA', 'open-a-coin'],
  // export / share
  ['export the current view', 'export-a-view'],
  ['how do I save a screenshot of a screen', 'export-a-view'],
  ['share a view as a png and report', 'export-a-view'],
  // voice
  ['change the voice speed', 'change-voice-speed'],
  ['make the voice talk faster', 'change-voice-speed'],
  ['change which voice speaks', 'change-voice'],
  ['set up the neural voice', 'setup-neural-voice'],
  ['make the voice sound better', 'setup-neural-voice'],
  ['how do I use voice mode', 'use-voice-mode'],
  ['talk to jarvis with push to talk', 'use-voice-mode'],
  // alerts
  ['turn on alerts', 'turn-on-alerts'],
  ['set up telegram alerts', 'turn-on-alerts'],
  ['enable discord notifications', 'turn-on-alerts'],
  // screener filter / sort / presets
  ['set a filter on the screener', 'set-a-filter'],
  ['how do I filter coins by liquidity', 'set-a-filter'],
  ['sort the screener', 'sort-the-screener'],
  ['open the sort menu', 'sort-the-screener'],
  ['use a screener preset', 'use-presets'],
  ['switch to the runners preset', 'use-presets'],
  // watchlist
  ['watch a coin', 'watch-a-coin'],
  ['add a token to my watchlist', 'watch-a-coin'],
  // popups / maps
  ['open the chart popup', 'open-chart-popup'],
  ['open the bubble map', 'bubble-map'],
  ['see holder clusters', 'bubble-map'],
  // look
  ['switch the theme', 'switch-theme'],
  ['change the colours', 'switch-theme'],
  ['turn on calm mode', 'calm-mode'],
  ['stop the rain effects', 'calm-mode'],
  // price mode
  ['show market cap instead of price', 'price-or-marketcap'],
  ['price vs market cap', 'price-or-marketcap'],
  // scan
  ['use ai scan mode', 'scan-mode'],
  ['turn on the watcher', 'scan-mode'],
  // analyst / larp / rug
  ['use the LARP check', 'larp-check'],
  ['is this a fake project with no real website', 'larp-check'],
  ['check if a coin is a rug', 'rug-check'],
  ['is this coin safe or a honeypot', 'rug-check'],
  ['ask the analyst a question', 'ask-the-analyst'],
  // agents / mcp / state
  ['connect my own agent', 'connect-an-agent'],
  ['add dexterm to claude code with mcp', 'connect-an-agent'],
  ['see what the user currently sees', 'what-dexterm-shows-agents'],
  // keys / config / data
  ['configure a helius key for holders', 'configure-rpc-key'],
  ['save and switch workspaces', 'workspaces'],
  ['customize the keymap and rebind a key', 'custom-keymap'],
  ['paper trade a coin', 'paper-trade'],
  ['how do I paper buy a token', 'paper-trade'],
  ['diagnose problems with doctor', 'run-doctor'],
  ['update dexterm to the latest version', 'update-dexterm'],
  ['edit an analyst skill', 'edit-kb-or-skill'],
  ['backtest the rug model', 'backtest'],
  ['turn off coin images', 'coin-images'],
  ['how do I get started with dexterm', 'getting-started'],
  // per-screen "what does it show"
  ['what does the screener show', 'screen-screener'],
  ['what does the token screen show', 'screen-token'],
  ['what does the new pairs screen show', 'screen-newpairs'],
  ['what does the watchlist screen show', 'screen-watchlist'],
  ['what does the analyst screen do', 'screen-analyst'],
  ['what does the positions screen show', 'screen-positions'],
  ['what does the trending screen show', 'screen-trending'],
  ['what does the kol screen show', 'screen-kol'],
  // --- r2: the subcommands that had no entry (verifier-reported misroutes)
  ['set up a rule', 'edit-rules'],
  ['add an alert rule', 'edit-rules'],
  ['dry-run a rule against recent data', 'edit-rules'],
  ['follow a wallet', 'follow-a-wallet'],
  ['copy trade a wallet', 'follow-a-wallet'],
  ['mirror a trader', 'follow-a-wallet'],
  ['link a wallet', 'link-a-wallet'],
  ['connect my phantom wallet', 'link-a-wallet'],
  ['set a mandate', 'standing-mandates'],
  ['add a standing mandate', 'standing-mandates'],
  ['set a conditional order plan', 'order-plans'],
  ['add a take profit plan', 'order-plans'],
  ['install a pack', 'share-packs'],
  ['export a pack to share', 'share-packs'],
  ['record a data session', 'recorder-history'],
  ['prune the history recorder', 'recorder-history'],
  ['keep the recorder running when the app is closed', 'record-headless'],
  ['collect history in the background', 'record-headless'],
  ['spectate an agent', 'spectate-an-agent'],
  ['watch an agent cook', 'spectate-an-agent'],
  ['manage my connected agents', 'connect-an-agent-registry'],
  ['pause an agent', 'connect-an-agent-registry'],
  ['run alerts in the background', 'watch-headless'],
  ['push alerts when the terminal is closed', 'watch-headless'],
  ['see the narrative board', 'narrative-board'],
  ['manage kol lists', 'kol-lists'],
  ['connect my x account', 'login-with-x'],
  ['login with twitter', 'login-with-x'],
  ['get help on how the app works', 'app-help-command'],
  ['run the popup self-test', 'chart-popup-selftest'],
];

test(`app-help golden set: ${GOLDEN.length} how-do-I questions each hit their expected entry`, () => {
  assert.ok(GOLDEN.length >= 40, `golden set must have >= 40 questions (has ${GOLDEN.length})`);
  const entries = loadAppHelp();
  const misses: string[] = [];
  for (const [q, id] of GOLDEN) {
    const results = searchAppHelp(q, 5, entries);
    if (results[0]?.id !== id) {
      misses.push(`"${q}" -> expected ${id}, got [${results.slice(0, 3).map((r) => `${r.id}:${r.score}`).join(', ') || 'none'}]`);
    }
  }
  assert.equal(misses.length, 0, `golden retrieval misses:\n  ${misses.join('\n  ')}`);
});

test('every expected golden id is a real app-help entry', () => {
  const entries = loadAppHelp();
  for (const [, id] of GOLDEN) assert.ok(getAppHelp(id, entries), `golden id ${id} has no entry`);
});

test('an app-help result carries the exact keys/commands as structured fields', () => {
  const e = getAppHelp('export-a-view')!;
  assert.deepEqual(e.keys, ['E'], 'export entry names the exact key E');
  assert.deepEqual(e.flags, ['--export']);
  const open = getAppHelp('open-a-coin')!;
  assert.ok(open.keys.includes('g'), 'open-a-coin names the g key');
  assert.ok(open.tools.includes('open_token'));
});
