// dexterm — generator for the app-help knowledge base (task-1413).
//
// Builds the `@dexterm/mcp` app-help KB entries (assets/kb/app-help/*.md) from the app's OWN authoritative
// sources so the help text cannot drift from the app:
//   - the keymap           (packages/tui/src/keymap.ts: DEFAULT_KEYMAP)         → the exact key for a task
//   - the help overlay     (packages/cli/src/screens/overlay.ts: helpRows)      → per-screen key lists
//   - the CLI              (packages/cli/src/main.ts: subcommands + flags)      → the exact command
//   - the MCP tool list    (packages/mcp/src/server.ts: TOOLS)                  → the exact tool names
// The prose (titles, bodies, synonyms, which key/command a topic uses) is a committed TOPICS table below.
// The STRUCTURE (resolved keys, the tool/command/flag sets) is read from the app at generate time, so a
// re-run after a keymap/tool change rewrites the entries and the drift test (regenerate-and-diff, plus the
// bidirectional structural checks) fails until they are regenerated.
//
// Deterministic by construction: no clock, no network, no filesystem writes here (the script does that).
// `GENERATED_DATE` is a constant so regenerate-and-diff is stable; bump it when regenerating deliberately.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_KEYMAP, type ScreenKey } from '@dexterm/tui';
import { helpRows } from './screens/overlay.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Repo root: packages/cli/src → up three. */
const ROOT = path.resolve(HERE, '..', '..', '..');

/** Stamped into every generated entry; bump on a deliberate regenerate. */
export const GENERATED_DATE = '2026-10-16';

// ---------------------------------------------------------------------------------------- app sources

/** Pretty single-key display, mirroring overlay.ts prettyKey for the handful of keys topics use. */
function prettyKey(id: string): string {
  const map: Record<string, string> = { enter: '⏎', escape: 'esc', tab: 'tab', space: 'space', up: '↑', down: '↓', left: '←', right: '→' };
  if (map[id]) return map[id];
  if (id.startsWith('ctrl+')) return '^' + id.slice(5).toUpperCase().replace(/\+/g, ' ');
  if (id.startsWith('alt+')) return '⌥' + id.slice(4);
  return id;
}

/** The first binding for an action (screen-specific preferred, else global); its canonical keys + display. */
function keyFor(action: string, screen?: string): { keys: string[]; display: string } {
  const bindings = DEFAULT_KEYMAP.bindings;
  const pick = bindings.find((b) => b.action === action && (screen ? b.screen === screen : false))
    ?? bindings.find((b) => b.action === action && !b.screen)
    ?? bindings.find((b) => b.action === action);
  if (!pick) return { keys: [], display: '' };
  return { keys: [...pick.keys], display: [...new Set(pick.keys.map(prettyKey))].join(' / ') };
}

/** Labeled actions + their canonical keys for a screen (every key that screen shows), from the keymap. */
function screenActions(screen: ScreenKey): { actions: string[]; keys: string[] } {
  const actions: string[] = [];
  const keys = new Set<string>();
  for (const b of DEFAULT_KEYMAP.forScreen(screen)) {
    if (!b.label) continue;
    if (!actions.includes(b.action)) actions.push(b.action);
    for (const k of b.keys) keys.add(k);
  }
  return { actions, keys: [...keys] };
}

function read(rel: string): string { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

/** Every `dexterm <subcommand>` main() dispatches (same regex the site's facts.mjs uses). */
export function appSubcommands(): string[] {
  const src = read('packages/cli/src/main.ts');
  return [...new Set([...src.matchAll(/argv\[0\] === '([a-z]+)'/g)].map((m) => m[1]))];
}

/** Every `--flag` parseArgs() accepts (main flags; scan `--scan-*` are a separate table the site adds). */
export function appFlags(): string[] {
  const src = read('packages/cli/src/main.ts');
  const body = src.slice(src.indexOf('export function parseArgs'), src.indexOf('export function intensityFor'));
  const flags: string[] = [];
  for (const m of body.matchAll(/k === '(--?[a-z-]+)'/g)) if (!flags.includes(m[1])) flags.push(m[1]);
  return flags;
}

/** Every MCP tool the server registers (same regex the site's facts.mjs uses). */
export function appTools(): string[] {
  const src = read('packages/mcp/src/server.ts');
  return [...src.matchAll(/\{ name: '([a-z_]+)', description: (?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g)].map((m) => m[1]);
}

// ---------------------------------------------------------------------------------------- the content

/** Screens that get a "what it shows + its keys" entry. */
const SCREENS: Array<{ screen: ScreenKey; title: string; blurb: string; tools: string[]; feature: string }> = [
  { screen: 'screener', title: 'The screener screen', feature: 'screener', tools: ['screener_query'],
    blurb: 'The live table of Solana tokens (DexScreener + Jupiter, refreshed every ~10 s): price, 5m/1h/6h/24h change, volume, liquidity, market cap, age, holders, organic score, flags and a sparkline, with a p(rug) column. Cells whose source is down show a dash and the caption says why — never a fabricated number.' },
  { screen: 'token', title: 'The token screen', feature: 'token-intel', tools: ['get_dossier', 'get_token', 'get_holders', 'get_trades', 'get_candles', 'get_dev_history', 'dev_history', 'rugcheck'],
    blurb: 'One coin in depth: market stats, a candle chart, the trades tape, mint/freeze authority, top holders with their class (pool/dev/linked/…), RugCheck + GoPlus, snipers/bundled from the wallet-intel scan, and the ANALYST panel. Open it with ⏎ on any live row or `--mint <CA|link>`.' },
  { screen: 'newpairs', title: 'The new pairs screen', feature: 'new-pairs', tools: ['screener_query'],
    blurb: 'A live feed of just-launched tokens (PumpPortal new-token + migration push, plus Jupiter/RugCheck/DexScreener polls). Bonding progress is a create-time estimate and says so; SNIPE/BUNDLE columns fill in from the wallet-intel scan of the row the cursor rests on (Helius-keyed).' },
  { screen: 'watchlist', title: 'The watchlist screen', feature: 'watchlist', tools: [],
    blurb: 'The coins you watch, persisted in SQLite, priced live every ~10 s with a LIVE/POLL badge. Add with `w` on any coin; remove with `d`.' },
  { screen: 'analyst', title: 'The analyst screen', feature: 'analyst', tools: ['get_dossier', 'kb_search', 'app_help'],
    blurb: 'Your own `claude` CLI as the dexterm analyst: it reads the read-only dexterm MCP tools, grounds every fact in a tool result, and answers in a few terse lines. ⏎ on a coin runs a full dossier; `a` runs a rug-check. Facts never come from model memory; token text passes the prompt firewall.' },
  { screen: 'positions', title: 'The paper positions screen', feature: 'positions', tools: ['paper_positions', 'paper_pnl'],
    blurb: 'Your simulated (PAPER) positions and their P&L. dexterm holds no keys and signs nothing; paper trading is a simulation for learning the flow. An agent you enabled can read these over MCP with the read-only paper_positions and paper_pnl tools.' },
  { screen: 'trending', title: 'The trending screen', feature: 'trending-board', tools: ['narrative_board'],
    blurb: 'What is trending in the space — narratives and movers aggregated from the feed.' },
  { screen: 'kol', title: 'The KOL lists screen', feature: 'kol-lists', tools: [],
    blurb: 'Key-opinion-leader wallet lists and their activity (official/authorized sources only).' },
  { screen: 'autotrade', title: 'The autotrade (paper) screen', feature: 'autotrade-strategies', tools: ['strategy_list', 'autotrade_status'],
    blurb: 'Press `Q` anywhere for AUTOTRADE, paper only. tab cycles five views: STRATEGIES (the presets and your own files with mode, version, hash and the last backtest), EDITOR (one form in six sections: entry, exits, risk, sizing, agent, execution; every change re-validates, errors show inline with their path, the screen filter is checked by the screener\'s own parser and its error column is marked; `s` saves only a valid draft as a new version, `u` undoes), COMPARE (two marked strategies side by side, changed fields first, both backtested on the same tape), BACKTEST (the report with attribution, an equity sparkline, clamps, refusals and the limits box; `w` runs a sweep whose verdict comes from coins it never tuned on) and RUNNER (the paper runner\'s heartbeat, halt reason, candidates, sessions, positions and ledger tail). Presets are read-only: `d` makes your own copy. Nothing on this screen switches a strategy to live, arms a mandate or touches a wallet. A strategy edit the analyst proposed in chat shows as a card: `o` opens its diff, `y` applies it, and a LOOSER edit (any risk number less safe) needs a second `y` on the less-safe popup.' },
];

/** The screen keys that get an overview entry (for the drift test's forward key-coverage check). */
export const SCREENS_DOCUMENTED: readonly ScreenKey[] = SCREENS.map((s) => s.screen);

/**
 * Flags that are deliberately NOT given a "how do I" entry (task-1413 r2): internal / render / replay /
 * debug knobs a normal user never reaches for, so an absent answer for them is correct, not a drift bug.
 * The forward-flag drift test requires every OTHER accepted flag to be named by some app-help entry.
 * Keep this list exhaustive and honest — a user-facing flag must earn a topic, not hide here.
 */
export const INTERNAL_FLAGS: ReadonlySet<string> = new Set([
  '--max-requests', '--max-credits', // request/credit budget limiters (data layer tuning)
  '--listen', '--db',                 // bus listen address + sqlite path overrides
  '--verbose',                        // extra diagnostic logging
  '--width', '--height', '--html', '--selected', '--title', // screenshot/export renderer internals
  '--seed', '--tz', '--color',        // determinism + rendering overrides for tests/screenshots
  '--fps', '--frame', '--t', '--event', '--ai', '--mood', '--activity', '--no-boot', // demo/replay/render scripting
  '--fit', '--font', '--ascii-rain',  // popup / render tuning
  '--plain', '--ansi',                // output-format overrides (CI / piping)
]);

/** A how-do-I topic. `actions` resolve to keys from the keymap; commands/flags/tools are validated to exist. */
interface Topic {
  id: string; title: string; screen: ScreenKey | 'all'; tags: string[];
  actions?: Array<{ action: string; screen?: ScreenKey }>; commands?: string[]; flags?: string[]; tools?: string[]; feature?: string;
  /** Body paragraph(s). A trailing "Keys:"/"CLI:" line is appended automatically from the resolved facts. */
  body: string;
}

const TOPICS: Topic[] = [
  { id: 'getting-started', title: 'Get started with dexterm', screen: 'all', tags: ['start', 'install', 'first', 'run', 'setup', 'begin'],
    commands: ['doctor'], flags: ['--fixtures', '--calm', '--version', '-h', '--help'], feature: 'doctor',
    body: 'Run `dexterm doctor` first: it checks Node, terminal colour, the claude CLI, each data source, the Helius key and a writable data dir, and prints the exact fix for anything not passing. Then run `dexterm` — the first launch shows a one-screen welcome; press any key to enter the live screener. Press `?` on any screen for that screen\'s full key list. Try `--fixtures` for an offline demo. `--version` prints the version; `--help` (or `-h`) prints usage.' },
  { id: 'open-a-coin', title: 'Open / paste a coin (contract address or link)', screen: 'all', tags: ['paste', 'open', 'coin', 'contract', 'address', 'ca', 'link', 'pump', 'dexscreener', 'solscan', 'go', 'goto'],
    actions: [{ action: 'goto.open', screen: 'screener' }], commands: [], flags: ['--mint'], tools: ['open_token'], feature: 'go-to-coin',
    body: 'Press `g` to open the go-to prompt and paste a contract address — or a dexscreener / pump.fun / solscan / birdeye link — then ⏎ to open that coin\'s live token screen, read-only. A CA or link also works in the analyst chat and the screener `/` line. One-shot: `--mint <CA|link>`. Nothing here trades.' },
  { id: 'export-a-view', title: 'Export or share the current view', screen: 'all', tags: ['export', 'share', 'screenshot', 'png', 'report', 'save', 'image'],
    actions: [{ action: 'export.view' }], flags: ['--export'], feature: 'export-share',
    body: 'Press `E` on any screen to write the current view to `~/.dexterm/exports/` as a PNG and a plain-text report (the toast names the file). The PNG is rendered calm with a data-source label (LIVE / SAMPLE / REPLAY) and the age of every panel. Nothing is uploaded or posted. One-shot: `--export [DIR]`.' },
  { id: 'change-voice-speed', title: 'Change the voice speed (rate)', screen: 'all', tags: ['voice', 'speed', 'rate', 'faster', 'slower', 'wpm'],
    commands: ['voice'], feature: 'jarvis',
    body: 'Voice speed is `voice.rate` in `~/.dexterm/config.json` (words per minute, 80–400). Edit it there and restart. Voice settings are yours alone: the analyst/agent CANNOT change them (the voice path is denied to models) — only you set them. `dexterm voice status` shows the current voice engines.' },
  { id: 'change-voice', title: 'Change which voice speaks', screen: 'all', tags: ['voice', 'choose', 'speak', 'say', 'name'],
    commands: ['voice'], feature: 'jarvis',
    body: 'The default speaking voice is the neural Piper voice once it is set up (`dexterm voice setup`), with the built-in macOS `say` as the fallback. Press `,` to cycle the `say` voice while running, or set `voice.name` in `~/.dexterm/config.json` (that chooses the `say` fallback voice; Piper has one fixed voice). Nothing is sent to a paid API. Voice is user-only: the analyst/agent cannot change it (the voice path is denied to models) — only the keyboard or your config sets it.' },
  { id: 'setup-neural-voice', title: 'Set up the neural voice (make it sound better)', screen: 'all', tags: ['voice', 'neural', 'piper', 'better', 'quality', 'natural', 'realistic', 'nicer', 'improve', 'install', 'alan'],
    commands: ['voice'], feature: 'jarvis',
    body: 'dexterm can speak with a neural British voice (Piper, en_GB-alan-medium) that sounds markedly more natural than the built-in system voices. Run `dexterm voice setup` to install it: it asks first, builds a private local Python runtime and downloads a ~61 MB checksum-verified voice from the official source, then runs fully offline with no key. Once installed it becomes the DEFAULT speaking voice automatically (the system voice stays as the fallback); `dexterm voice uninstall` removes it. It needs Python 3.9+ — `dexterm doctor` prints the exact fix if it is missing, and shows which engine is speaking.' },
  { id: 'use-voice-mode', title: 'Use voice mode (Jarvis, push-to-talk)', screen: 'all', tags: ['voice', 'jarvis', 'talk', 'mic', 'microphone', 'push', 'listen'],
    actions: [{ action: 'voice.talk' }], flags: ['--sound'], feature: 'jarvis',
    body: 'Press `v` to start push-to-talk: speak, press `v` again to send (a red ● LISTENING badge shows while the mic is live; it also auto-closes after 15 s). Instant commands ("show the runners", "open bonk", "filter liquidity over 50k") run locally; questions go to `claude`. Voice only PROPOSES trades — it can never confirm, sign, arm or raise a cap. macOS only; every voice action also has a key. `--sound on|off` sets the sound/voice output at launch.' },
  { id: 'turn-on-alerts', title: 'Turn on alerts (Telegram / Discord / desktop)', screen: 'all', tags: ['alerts', 'alert', 'notify', 'notification', 'telegram', 'discord', 'desktop', 'channel'],
    actions: [{ action: 'alert.propose', screen: 'screener' }], commands: ['alerts'], feature: 'push-alerts',
    body: 'Use `dexterm alerts` to see channels and enable them; `dexterm alerts set-telegram` / `set-discord` store the bot token / webhook in `~/.dexterm/` (mode 0600) — never in config.json, argv or a log. In-app, `b` proposes a liquidity alert on the highlighted coin and `y` arms it. The analyst can never change alert channels or see their secrets.' },
  { id: 'set-a-filter', title: 'Filter the screener', screen: 'screener', tags: ['filter', 'screen', 'query', 'search', 'grammar', 'volume', 'liquidity'],
    actions: [{ action: 'filter.edit', screen: 'screener' }], flags: ['--filter'], feature: 'filter-grammar',
    body: 'Press `/` to open the filter editor and type the grammar, e.g. `vol24 > 250K liq > 50K age < 30d org >= 60 launchpad:pump !flag:mint`. Errors show inline with the column. One-shot: `--filter "…"`. The analyst can set a filter for you (it shows "analyst did X").' },
  { id: 'sort-the-screener', title: 'Sort the screener', screen: 'screener', tags: ['sort', 'order', 'rank', 'column', 'menu'],
    actions: [{ action: 'sort.menu', screen: 'screener' }], flags: ['--sort'], feature: 'filter-grammar',
    body: 'Press `s` for the sort menu: j/k pick a key, ⏎ on the current key flips the direction (ascending/descending). One-shot at launch: `--sort <key>`.' },
  { id: 'use-presets', title: 'Use screener presets', screen: 'screener', tags: ['preset', 'presets', 'trending', 'runners', 'organic', 'graduating', 'smart'],
    actions: [{ action: 'preset.next', screen: 'screener' }, { action: 'preset.prev', screen: 'screener' }], flags: ['--preset'], feature: 'presets',
    body: 'Press `]` / `[` to step through presets (Trending, Runners, Organic; Graduating ships keyless as an `approx` mcap-band proxy; Smart money needs a key and says so). The analyst can switch the feed too. One-shot at launch: `--preset <name>`.' },
  { id: 'watch-a-coin', title: 'Watch (or unwatch) a coin', screen: 'all', tags: ['watch', 'watchlist', 'follow', 'track', 'token', 'tokens', 'coins'],
    actions: [{ action: 'watch.add', screen: 'screener' }], feature: 'watchlist',
    body: 'Press `w` to watch/unwatch the highlighted coin (screener, new pairs, token screen). The watchlist is persisted and priced live. On the watchlist screen `d` removes a row.' },
  { id: 'open-chart-popup', title: 'Open the chart popup', screen: 'token', tags: ['chart', 'popup', 'candles', 'window', 'dock', 'graph'],
    actions: [{ action: 'popup.chart', screen: 'token' }], feature: 'popup-chart',
    body: 'Press `C` on the token screen to open the docked chart popup (a native window, or your browser as fallback). It is fed only by the terminal\'s caches over one loopback WebSocket and never sees your keys. The analyst can open or close it for you.' },
  { id: 'chart-trade-markers', title: 'See your buys and sells on the chart (B / S markers)', screen: 'token', tags: ['markers', 'marker', 'buy', 'sell', 'bought', 'sold', 'fills', 'fill', 'entry', 'exit', 'trades', 'chart', 'avg', 'average', 'paper', 'live', 'arrows'],
    commands: ['display'], feature: 'chart-trade-markers',
    body: 'Every fill of the open coin from your paper ledger (your own and an agent\'s PAPER trades) and the live ledger (confirmed real swaps) is marked on the token screen\'s chart and the chart popup, on every timeframe: `B` for a buy and `S` for a sell, at the fill\'s time and price. Hollow `△ ▽` = PAPER, solid `▲ ▼` = live, so it reads without colour too. Each partial sell gets its own marker (several in one bar show a count), a dashed `avg` line marks the average entry while the position is open, and a closed round trip gets a faint wash from entry to exit. A fill outside the candles on screen is not moved: the chart says how many are off-chart. In the popup, hover a marker for its time, price, size and ledger; `k` or the **MARKERS** button turns them off or on for both charts (saved as `display.chartMarkers`; also `dexterm display markers on|off`). Display only: no marker can arm, size, sign or confirm anything, and nothing is fetched to draw them.' },
  { id: 'switch-theme', title: 'Switch the theme', screen: 'all', tags: ['theme', 'themes', 'colour', 'colours', 'color', 'colors', 'look', 'cyberspace', 'midnight', 'ember', 'paper'],
    actions: [{ action: 'theme.next' }], commands: ['theme'], flags: ['--theme'], feature: 'themes-keymaps',
    body: 'Press `t` to cycle themes (cyberspace → midnight → ember → paper). `dexterm theme list|show|init|check` manages your own themes in `~/.dexterm/themes/`; a shared theme cannot hide a warning or swap buy/sell colours (a contrast + hue guard). The analyst can propose a theme change you confirm with a keypress.' },
  { id: 'calm-mode', title: 'Turn on calm mode (effects off)', screen: 'all', tags: ['calm', 'effects', 'rain', 'glitch', 'quiet', 'still', 'intensity'],
    flags: ['--calm', '--intensity'], feature: 'look',
    body: 'Press `c` to toggle calm mode: rain, glitch, blink and scanlines off, back to the last intensity when pressed again. Start calm with `--calm` (or `DEXTERM_CALM=1`); `--intensity normal|fever|off` picks a tier. The analyst can toggle calm for you.' },
  { id: 'price-or-marketcap', title: 'Market cap or price (market cap is the default)', screen: 'all', tags: ['price', 'mcap', 'marketcap', 'market', 'display', 'usd', 'cap', 'basis'],
    actions: [{ action: 'display.priceMode' }], commands: ['display'], flags: ['--price-mode', '--price', '--mcap'], feature: 'price-display-mode',
    body: 'Market cap is the default basis: every screen, the CLI text, the chat assistant and the autotrade agents show and talk about a coin in market cap (entered at $69.7K, exited at $264.9K, 3.8x). Press `$` (or type `/display price` in the chat box, `/display mcap` to go back) to switch to USD price and back. Saved as `display.priceMode`; also `dexterm display mcap|price`. For one run: `--price` / `--mcap` on any command, `--price-mode`, or `DEXTERM_PRICE_BASIS=price`. Market cap = price × a known supply (the source\'s cap ÷ price, recorded FDV ÷ price, or pump.fun\'s 1B); a coin with no known supply shows its price marked ᵖ and says so. JSON keeps both `price` and `mcap`. The charts have their own axis setting (`A`). The analyst can propose this for you.' },
  { id: 'scan-mode', title: 'Use AI scan mode', screen: 'all', tags: ['scan', 'watcher', 'observe', 'auto', 'ai', 'monitor'],
    actions: [{ action: 'scan.toggle' }, { action: 'scan.resume' }], flags: ['--scan'], feature: 'scan',
    body: 'Scan mode is an observe-only AI watcher (off by default, zero extra requests). Toggle it with `Z` (or `/scan on|off` on the screener line, or `--scan` at launch); `R` resumes a paused scan. It can only surface findings, never take a UI action or trade (structurally observe-only). While it is on, the token screen\'s analyst panel shows its brain view: the scan log (locks, refreshes, releases, blocked actions) with the read streaming under it, the vetting checklist and the data strip. While it runs and you hold a paper or live position, a PnL chip shows it on the band under the header of every screen and on the chart popup; display only. The analyst can turn it on or off for you.' },
  { id: 'larp-check', title: 'Run the LARP check (is the product real?)', screen: 'token', tags: ['larp', 'fake', 'real', 'legit', 'website', 'product', 'domain', 'github', 'vet', 'score', 'x', 'twitter'],
    tools: ['larp_check', 'get_links', 'fetch_page', 'check_domain', 'check_github', 'check_x'], feature: 'larp-check',
    body: 'The LARP check vets whether a real product exists (website, domain age, GitHub, the X account) read-only — it is not a price call. Ask the analyst "is <coin> a larp?" (skill `larp-check`), or an agent can call the `larp_check` MCP tool. It returns a 0-100 LARP score: the sum of named flags with their points (low under 25, medium 25-49, high 50+), plus a list of what could not be read, which widens the range instead of lowering the score. A score is a summary of flags, never a certificate; it never recommends buy/sell.' },
  { id: 'rug-check', title: 'Check if a coin is a rug', screen: 'token', tags: ['rug', 'safe', 'honeypot', 'scam', 'risk', 'check', 'authority', 'mint'],
    actions: [{ action: 'analyst.toggle' }], tools: ['analyze_token', 'get_dossier', 'rugcheck'], feature: 'analyst',
    body: 'Press `a` to run a rug-check on the selected coin: authorities, token program, LP, holder concentration, creator history and tape, with a p(rug) from the H1 heuristic (a ranking, not a calibrated probability). The verdict is WATCH / SPECULATIVE / AVOID. Facts come only from tools; it is not financial advice.' },
  { id: 'ask-the-analyst', title: 'Ask the analyst a question', screen: 'analyst', tags: ['analyst', 'ask', 'claude', 'ai', 'question', 'dossier', 'chat'],
    actions: [{ action: 'analyst.toggle' }, { action: 'open', screen: 'screener' }], tools: ['get_dossier', 'kb_search', 'app_help', 'case_lookup'], feature: 'analyst',
    flags: ['--no-ai'],
    body: 'The analyst is your own `claude` login (or your own `codex` login: `/engine codex`, see "Run the analyst on Codex"). ⏎ on a coin runs a full dossier; `a` runs a rug-check (or a trench-scan of the screener when nothing is selected). Type a follow-up and ⏎ to send. If `claude` is missing or logged out the panel shows the one-line fix and the rest of dexterm keeps working. Start without AI using `--no-ai`.' },
  { id: 'connect-an-agent', title: 'Connect your own agent (MCP)', screen: 'all', tags: ['mcp', 'agent', 'agents', 'connect', 'claude', 'tool', 'server', 'bot'],
    commands: ['mcp'], tools: ['screen_state', 'get_dossier', 'kb_search', 'app_help', 'app_state'], feature: 'mcp',
    body: '`dexterm mcp` is a plain stdio MCP server exposing the same read-only tools the analyst uses. Add it to any Claude Code with `claude mcp add dexterm -- node packages/mcp/bin/dexterm-mcp.mjs`, or set up Claude Code, Claude Desktop, Cursor or Codex in one command with `dexterm mcp install <client>`. Agents are untrusted: every tool is read-only and an agent can never sign, arm, raise a cap or touch keys. Use `app_help` for "how do I" questions and `app_state` to see what the user sees.' },
  { id: 'use-codex-analyst', title: 'Run the analyst on Codex instead of Claude', screen: 'all', tags: ['codex', 'openai', 'chatgpt', 'engine', 'analyst', 'claude', 'switch', 'backend'],
    flags: ['--analyst-engine'], feature: 'analyst',
    body: 'The analyst can run on your own Codex CLI login instead of Claude (0.1.5). Pick it with `--analyst-engine codex`, `DEXTERM_ANALYST_ENGINE=codex`, `"analyst": {"engine": "codex"}` in `~/.dexterm/config.json`, or type `/engine codex` in the chat box (new conversations; `/engine` alone shows the engine and what is installed). The default `auto` uses claude when it is installed, else codex. dexterm stores no credentials: your `codex login` does the work. The Codex run is locked read-only: only the read-only dexterm tools (plus the UI actions the session allows, none in scan mode), no shell, no file edits, no web search, no other MCP server; a turn that tries anything else is stopped. `dexterm doctor` shows a Codex CLI line (installed, version, logged in). Codex is also supported as an MCP client: `dexterm mcp install codex`.' },
  { id: 'use-local-model', title: 'Run dexterm\'s AI on a free local model (Ollama)', screen: 'all', tags: ['ollama', 'local', 'model', 'free', 'offline', 'engine', 'llama', 'qwen', 'restrictions', 'privacy'],
    commands: ['ai', 'ask'], flags: ['--analyst-engine'], feature: 'analyst',
    body: 'dexterm\'s AI can run on a free model on your own machine through Ollama: no login, no key, $0 per answer, and it talks only to http://127.0.0.1:11434 by default. Set it up in two minutes: install Ollama (https://ollama.com/download), `ollama pull qwen3:8b`, `dexterm ai engine ollama`, `dexterm ai model qwen3:8b`, then `dexterm doctor` (the Ollama line should pass). In the chat box `/engine ollama` switches new conversations, `/engine claude` switches back; `--analyst-engine ollama` and `DEXTERM_ANALYST_ENGINE=ollama` work too, and `dexterm ai engine ollama --surface autotrade` picks one surface. The local engine uses the same dexterm tools and the same firewalled context as Claude. What it may do is your restriction profile: `observe` (analyse only), `propose` (the default for a new setup: UI actions, a PAPER ticket you confirm, strategy proposals you apply), `paper` (adds paper autotrade sessions and agent paper trading in a mandate you armed: `dexterm ai restrictions paper`), `full` (only after `dexterm ai engine ollama --full` and typing ENABLE FULL, for one model). Caps, the kill switch, mandate tiers, live gating and Telegram buttons are enforced outside the model for every engine. `dexterm ai probe --json` checks tool calling, context and decision formatting; a model without tools answers from the dossier dexterm fetches and says so. Paper autotrade on it: `dexterm autotrade run <strategy> --paper --engine ollama`. Headless: `dexterm ask "question"`, `dexterm ai agent "goal"`. Docs: https://dexterm.xyz/docs/ollama/' },
  { id: 'dev-history', title: 'Check if a coin\'s creator rugged before (dev history)', screen: 'token', tags: ['dev', 'deployer', 'creator', 'serial', 'rugger', 'rugged', 'history', 'launches'],
    tools: ['dev_history', 'get_dev_history'], feature: 'token-intel',
    body: 'The token screen\'s ON-CHAIN panel shows the creator\'s recorded track record (0.1.5): `Dev rugs` (rugs out of labelled prior launches, e.g. `2/3 · n=3 · rec 7d`), `Dev launches` (`n=3 · rec 2h · dev:jup`: which feed named the creator), `Dev sold bag` (median minutes to the dev\'s exit, `med 20m · n=3 · rec 1d`), `Dev linked` (funder or cluster from the wallet-intel scan, with the scan\'s age) and `Linked dev rugs` (rugs by other wallets in that cluster). Every value names its source (`rec` = the recorder, `scan` = the wallet-intel scan), its sample (n=) and the age of its newest datum. It comes from dexterm\'s own local history recorder (keyless creator links + code-only outcome labels), so it says `unknown` when there is no record; it is a risk flag from observed history, never a certificate. Alert on it with the rule field `devrugs`, e.g. `when devrugs >= 2 then alert(warn, "new coin from a wallet that rugged before") scope newpairs`. Agents and the analyst use the `dev_history` MCP tool.' },
  { id: 'configure-rpc-key', title: 'Configure a Helius / RPC key for holders', screen: 'all', tags: ['helius', 'rpc', 'key', 'holders', 'free', 'api', 'ranked'],
    feature: 'keyless',
    body: 'dexterm is free-forever and keyless by default. The one real keyless gap is the ranked top-holder list: add a free RPC key for it. Save a Helius key ONLY at `~/.dexterm/helius.key` (mode 600, never a repo or command line), or set `DEXTERM_RPC_URL` to any read-only RPC. `dexterm doctor` prints the exact command. Without a key the holders panel shows count + top-10% via Jupiter.' },
  { id: 'workspaces', title: 'Save and switch workspaces', screen: 'all', tags: ['workspace', 'workspaces', 'layout', 'hud', 'save', 'morning'],
    actions: [{ action: 'workspace.save' }], commands: ['workspace'], flags: ['--workspace', '--screen'], feature: 'workspaces',
    body: 'A workspace saves a start screen, theme, intensity, screener preset/filter/sort, token panels and the HUD popups to open together. `ctrl+w` then `s` saves as; `w` lists; `n`/`N` cycle. `dexterm workspace list|show|remove|init` manages them. The analyst can open a saved workspace for you.' },
  { id: 'custom-keymap', title: 'Customize the keymap', screen: 'all', tags: ['keymap', 'keybind', 'keybinding', 'rebind', 'shortcut', 'keys', 'remap'],
    commands: ['keymap'], feature: 'themes-keymaps',
    body: '`config.keymap` in `~/.dexterm/config.json` re-binds actions to keys; `dexterm keymap [screen]` shows the effective bindings including your overrides. Reserved keys (ctrl+c, esc, enter, y, !) and the confirm/dismiss/panic/quit actions cannot be rebound, and collisions refuse the whole keymap.' },
  { id: 'paper-trade', title: 'Paper trade a coin', screen: 'token', tags: ['paper', 'trade', 'buy', 'sell', 'ticket', 'simulate', 'practice'],
    actions: [{ action: 'trade.buy', screen: 'token' }, { action: 'trade.sell', screen: 'token' }], feature: 'paper-ticket',
    body: 'Press `B` / `S` on the token screen to open a PAPER buy/sell ticket in its editing phase. dexterm holds no keys and signs nothing — paper trading is a simulation. Confirming a ticket needs your explicit keypress (the gate); a stray key never confirms. The in-app analyst can open a PAPER ticket but can never size, confirm or send it. If you separately arm a mandate and enable agent paper trading, a connected agent can open, size, confirm and close PAPER trades inside your caps (never raising them, never signing) — see "Let an agent paper trade".' },
  { id: 'agent-paper-trade', title: 'Let an agent paper trade', screen: 'all', tags: ['agent', 'mcp', 'paper', 'autonomous', 'experimental', 'confirm', 'close', 'simulated'],
    flags: ['--agent-paper'], tools: ['paper_open_ticket', 'paper_size_ticket', 'paper_confirm', 'paper_close', 'paper_positions', 'paper_pnl'], feature: 'mcp',
    body: 'Experimental, paper only, off by default. Arm a mandate yourself (its caps, by keypress), then start `dexterm --spectate-mcp --agent-paper <mandate-id>`: an agent connected through `dexterm mcp` can then open, size, confirm and close SIMULATED (paper) trades inside those caps with paper_open_ticket / paper_size_ticket / paper_confirm / paper_close, and read paper_positions / paper_pnl. The agent is untrusted: it can never sign, send a real transaction, touch keys, or raise a cap; its per-trade cap is a quarter of the mandate\'s, and a size over any cap is refused. Caps are re-read from your armed mandate on every call, so revoking it or the panic key stops the agent. Every call is journaled and shows in this terminal\'s agent activity; Ctrl+P pauses, Ctrl+K stops for the rest of the run, any key takes over, and quitting turns it off. Figures are simulated and are not a result.' },
  { id: 'run-doctor', title: 'Diagnose problems with doctor', screen: 'all', tags: ['doctor', 'diagnose', 'check', 'troubleshoot', 'broken', 'fix', 'problem'],
    commands: ['doctor'], feature: 'doctor',
    body: '`dexterm doctor` is the first stop for any problem: non-interactive, never touches your keys, exits 0 when dexterm will run and 1 when something must be fixed. Every non-pass line prints the exact fix. `dexterm doctor --offline` skips the network probes.' },
  { id: 'update-dexterm', title: 'Update dexterm', screen: 'all', tags: ['update', 'upgrade', 'version', 'latest', 'new'],
    commands: ['update'], feature: 'update-check',
    body: '`dexterm update` updates the app; a daily notice tells you when a new version is out. The analyst can never install or update software.' },
  { id: 'edit-kb-or-skill', title: 'Edit the knowledge base or an analyst skill', screen: 'all', tags: ['kb', 'knowledge', 'skill', 'edit', 'customize', 'override', 'analyst'],
    commands: ['kb', 'skill'], tools: ['kb_lookup', 'kb_search'], feature: 'kb',
    body: 'Your own KB entries and skills live in `~/.dexterm/kb/entries/<id>.md` and `~/.dexterm/skills/<name>.md` (same frontmatter as the bundled ones). `dexterm kb|skill list|show|new|edit|check|reset|path`: `edit` copies the bundled file and opens your editor, `check` validates it, `reset` restores the bundled one. A skill is read-only guidance and may never name a trade/sign/arm tool.' },
  { id: 'backtest', title: 'Backtest the rug model or skills', screen: 'all', tags: ['backtest', 'eval', 'accuracy', 'model', 'metrics', 'history'],
    commands: ['backtest'], tools: ['rug_backtest'], feature: 'skill-backtest',
    body: '`dexterm backtest --subject heuristic|skills|larp|pack_verdicts` scores a subject against the recorder\'s outcome-labelled history and prints honest metrics (precision/recall, Brier vs base rate, AUC, calibration) with leakage checks. With no labelled outcomes it says so and prints no metrics rather than fabricating any.' },
  { id: 'autotrade-strategies', title: 'Autotrade strategies on paper (dexterm autotrade)', screen: 'all', tags: ['autotrade', 'strategy', 'strategies', 'preset', 'presets', 'moonbag', 'scalp', 'swing', 'sweep', 'held-out'],
    commands: ['autotrade'], feature: 'autotrade-strategies',
    body: '`dexterm autotrade list|validate|new|import|remove|journal` manages strategy files in ~/.dexterm/strategies (one validated JSON file each, every change in an append-only journal); the presets scalp, swing, runner, moonbag, sample-dip-ladder and yolo (HIGH RISK, see the yolo entry) are read-only, copy one with `dexterm autotrade new <id> --from <preset>`. `dexterm autotrade backtest <id>` replays a strategy over your recorded history with modelled fills and always prints the limits of the data (`--every-candidate`, `--recall 5,10` for tail strategies); `dexterm autotrade sweep <id>` tunes on older coins and checks once on the newest 30% it never saw, with no gain wording unless both halves have 20+ trades and the held-out net is positive. Paper only: a strategy cannot hold a key, wallet or signer section, and a copy in mode live does not run (dexterm holds no key and places no live order). Not financial advice. Full docs: https://dexterm.xyz/docs/autotrade/' },
  { id: 'autotrade-runner', title: 'The autotrade paper runner and candidate sessions (dexterm autotrade run)', screen: 'all', tags: ['autotrade', 'runner', 'run', 'candidate', 'session', 'sessions', 'agent', 'replay', 'ledger', 'runner.json'],
    commands: ['autotrade'], feature: 'autotrade-runner',
    body: '`dexterm autotrade run <id|file> --paper` runs one strategy on paper, headless, one runner per machine: the screener feeds it the same live data as the app (every 10 s, candidate and held coins every 5 s), and each coin that matches gets one session on your own Claude login with the full picture first, then only what changed. Your agent answers with a typed decision (enter, wait, skip, hold, exit, tighten, reprofile); every size is clamped by your strategy and the exits run on their own. At most 2 sessions at once, $0.50 per session and the day caps in ~/.dexterm/autotrade/runner.json (which Claude account, sessions and spend per day, a usage guard). Every step goes to ~/.dexterm/autotrade/runs/<run>.jsonl, hash-chained. `--replay FILE` paces a recorded tape instead of live data; `--stub` uses a scripted agent with no Claude cost. Paper only: a run never signs or touches a wallet, and there is no `--live` (dexterm holds no key and places no live order). Not financial advice. Full docs: https://dexterm.xyz/docs/autotrade/#the-runner-and-candidate-sessions' },
  { id: 'live-trading', title: 'Live trading: dexterm holds no key; a Telegram trading bot of your choice trades', screen: 'all', tags: ['live', 'trading', 'real', 'money', 'telegram', 'bot', 'key', 'wallet', 'custody', 'signer', 'mainnet'],
    commands: ['telegram', 'wallet', 'live'], feature: 'live-trading',
    body: 'dexterm never holds a key and never signs or sends a transaction: there is no trading wallet, no signer and no live order in dexterm. Live trading happens in a Telegram trading bot of your choice, which holds its own wallet; you act in that bot. dexterm\'s part is the Telegram connector to your OWN bot (`dexterm telegram setup`): alerts, signals and run control for your paper runs. dexterm does not place orders in a trading bot for you: in real mode (0.2.0, experimental) a strategy you armed on your own terminal sends a signal for each trade to an executor you run, and your executor places the order by its own rules (`dexterm autotrade signal`, https://dexterm.xyz/docs/real-mode/). Paper trading (the ticket, paper accounts, paper autotrade) is local. `dexterm wallet link` keeps a Phantom public key for display only. Not financial advice. Full docs: https://dexterm.xyz/docs/live-trading/' },
  { id: 'live-yolo', title: 'The full-port yolo strategy on paper: replay and a paper run (HIGH RISK)', screen: 'all', tags: ['yolo', 'full', 'port', 'all-in', 'high', 'risk', 'preset', 'replay', 'paper'],
    commands: ['autotrade'], feature: 'yolo-preset',
    body: 'HIGH RISK, PAPER only; not financial advice. The `yolo` preset enters one young pair at a time on an early 5-minute push after the holder-safety gates (LP burned or locked, no mint or freeze authority, a LARP score of 49 or less checked live before a coin becomes a candidate, liquidity of $25K or more), takes the cost back at about 2x, lets the rest ride on a loose 50% trail, exits at once on a liquidity pull, a dev sell or dead volume, has a -50% stop and a 45-minute time stop, and never buys the same coin twice. On paper it caps an entry at 25% like every strategy. `dexterm autotrade yolo-replay yolo` measures every entry at full port over your recorded history (rugs, the loss spread, how often it zeroed the wallet); `dexterm autotrade run yolo --paper` runs it on paper (`--replay builtin:yolo-rehearsal --stub` for a short fixture run; next to other strategies, or on a shared paper account, through `autotrade.json` and `dexterm autotrade run --all --paper`). Stop: `dexterm autotrade stop`, /kill in Telegram, Ctrl-C. dexterm places no live order. Full docs: https://dexterm.xyz/docs/yolo/' },
  { id: 'autotrade-stop', title: 'Stop, flatten or audit the autotrade paper runner (dexterm autotrade stop|flatten|audit)', screen: 'all', tags: ['autotrade', 'stop', 'kill', 'halt', 'flatten', 'sell', 'pause', 'panic', 'audit', 'verify', 'ledger', 'resume'],
    commands: ['autotrade'], feature: 'autotrade-runner',
    body: '`dexterm autotrade stop` is a soft stop of the paper runner: no new entries, every session closed, pending orders dropped, and the mechanical exits (stops, take-profits, trails, rug exits) keep running until nothing is held; then the runner ends. `dexterm autotrade flatten` stops it and sells every paper position at its next tick (a coin that cannot sell is retried every tick); it asks for y on a real terminal, or takes --yes. On the AUTOTRADE screen (`Q`): `!` stops, `p` pauses or resumes new entries, `f` then y flattens. A stop is final for that run. `dexterm wallet panic` is the harder switch: the runner reads it every step, a new run will not start while it is on, and only `dexterm wallet resume` on a real terminal lifts it. `dexterm autotrade audit --verify` recomputes the hash chain of every run file in ~/.dexterm/autotrade/runs/ and names the first edited, missing or reordered line. Paper only; your agent cannot stop, resume or flatten anything. Not financial advice. Full docs: https://dexterm.xyz/docs/autotrade/#stopping-it' },
  { id: 'autotrade-parallel', title: 'Run several autotrade strategies at once on paper (dexterm autotrade run --all)', screen: 'all', tags: ['autotrade', 'parallel', 'several', 'multiple', 'strategies', 'compare', 'side', 'forward', 'test', 'bankroll', 'fleet', 'autotrade.json'],
    commands: ['autotrade'], tools: ['autotrade_parallel_list', 'autotrade_parallel_compare', 'autotrade_parallel_start', 'autotrade_parallel_stop'], feature: 'autotrade-parallel',
    body: '`dexterm autotrade run --all --paper` runs every strategy listed in ~/.dexterm/autotrade/autotrade.json at the same time on one data feed, to forward-test several ideas side by side. Each entry has an `id`, a `preset` (a shipped preset or your own strategy) or an absolute `file`, a `bankroll` in USD or SOL, optional `caps` that can only tighten it, and `enabled`. Each strategy gets its own paper book, run file, loss limits and breaker, sessions and model spend budget; a breaker or a stop on one never stops another. The screener fetches once for all of them, and the `global` limits (sessions open at once, model spend and sessions per day, one check of how busy the computer is) count across all of them. `dexterm autotrade status --all` and the runner view on the AUTOTRADE screen (`Q`) compare them: P/L, win rate with the closed count, rug exits and exposure, missed runners, spend per entry. `dexterm autotrade stop|flatten|pause|resume` act on every strategy; add `--strategy ID` to act on one, and `dexterm autotrade start ID` starts a listed one that is not running. An MCP agent can list and compare them and start or stop one listed strategy, never add one or change a size or a cap. Paper only: live is refused. Not financial advice. Full docs: https://dexterm.xyz/docs/autotrade/#several-strategies-at-once' },
  { id: 'autotrade-telegram', title: 'Your own Telegram bot for the autotrade runner: notify, control, one-tap approvals (dexterm telegram)', screen: 'all', tags: ['telegram', 'bot', 'phone', 'mobile', 'notify', 'notifications', 'approve', 'approval', 'approvals', 'pair', 'pairing', 'kill', 'pause', 'remote', 'botfather'],
    commands: ['telegram'], feature: 'autotrade-telegram',
    body: 'Create a bot with @BotFather, then run `dexterm telegram setup`: paste the token at the hidden prompt (never as an argument), dexterm checks it and keeps it in your keychain (or the system keyring, or a 0600 file), then shows a 6-digit code; send `/pair <code>` to your bot from your own private chat and confirm the account it shows (@username and id) with `y` on your computer. Pairing is refused while a webhook or another program polls the bot. Only that account in that chat is answered. `dexterm autotrade run <id> --paper` then starts the bot by itself (`--no-telegram` keeps it off): entries, exits, PnL cards, halts and a daily summary reach your phone; `/status`, `/positions`, `/pause`, `/resume` (a pause only), `/kill`, `/flatten` and `/use` (each after a confirm button, `/use` only to an equal-or-tighter strategy; a change it cannot rank counts as looser) and `/approvals on` work from chat, which can make things safer and never less safe. With `entry.decide: "agent+approve"` or approvals on, every entry is a card with [Approve] [Half size] [Skip]: only a button approves, once, for that proposal, your account and your private chat; the price and your limits are checked again at the tap; no answer is a skip. Typed messages are never trades. `dexterm telegram status|test|audit --verify|revoke`. Nothing is hosted; paper only; never send keys or seed phrases in chat. Not financial advice. Full docs: https://dexterm.xyz/docs/telegram/' },
  { id: 'autotrade-real-signal', title: 'Real mode: send a strategy\'s trades to your own executor as LIVE TRADE FIRE signals (dexterm autotrade signal)', screen: 'all', tags: ['real', 'mode', 'live', 'trade', 'fire', 'signal', 'signals', 'executor', 'webhook', 'hook', 'jsonl', 'receipt', 'receipts', 'arm', 'caps', 'kill', 'outbox', 'nonce'],
    commands: ['autotrade'], tools: ['trade_fire_feed'], feature: 'autotrade-real-signal',
    body: 'Real mode runs a strategy exactly like paper (the same clamp, exits, monitor and run file) and sends every buy and sell it fills, first, as a LIVE TRADE FIRE signal (`dexterm-trade-fire/1`: buy or sell, mint, symbol, size in SOL and % of book, the sell fraction and exit reason, strategy, run, account, an always-growing nonce, an idempotency id and an expiry) to YOUR executor: a Telegram trading bot of your choice or any script. dexterm holds no key and signs nothing. Set channels with `dexterm autotrade signal channels --webhook URL | --signal-cmd \'["/abs/path"]\' | --jsonl on | --mcp on | --telegram on` (they live in connectors.json next to the Telegram setup; a bot cannot read another bot, so the Telegram copy alone is not enough), a webhook HMAC secret with `signal secret generate --out FILE`, hard caps with `signal caps set` (raising needs a typed confirmation), then arm on your own terminal with `dexterm autotrade signal arm <id>` (evidence panel + a typed phrase with a one-time code; any later edit disarms; below the evidence floor, a completed forward test with your `minForwardTrades` closed paper trades and a backtest of these exact rules, or past a missing rung of the ladder, it refuses unless you first type a separate OVERRIDE phrase, which is journaled) and run `dexterm autotrade run <id> --real` (live data only, in the foreground: in 0.2.0 the always-on service runs paper strategies only). Delivery is at least once from a restart-safe outbox, in nonce order, retried until acked or expired; the executor dedupes by nonce, ignores expired signals and acts only on its own account. Every run ends with a `halted` signal that lists the positions still open; the run\'s last lines and the Telegram copy name them too. Open positions are carried to the next real run of the same strategy and account, whose exits keep firing; while no real run is running NO signal goes out, sells included, so manage them in your executor. Positions stay unconfirmed until `dexterm autotrade receipt <nonce> executed|rejected|failed` (data only). `signal kill` stops every signal; `signal status`, `signal tail`, `receipt list` and `autotrade audit` show the outbox, receipts and drift; agents can read the MCP feed with trade_fire_feed. No model, tool or chat tap can arm real mode, raise a cap or lift the kill switch. Experimental; not financial advice.' },
  { id: 'autotrade-limits', title: 'Set your own real-mode limits: per trade, per day, open positions, loss stops, the breaker (dexterm autotrade limits)', screen: 'all', tags: ['limits', 'limit', 'caps', 'cap', 'size', 'sizing', 'per', 'trade', 'daily', 'loss', 'drawdown', 'breaker', 'streak', 'exposure', 'slippage', 'ttl', 'rate', 'raise', 'lower', 'scope'],
    commands: ['autotrade'], tools: ['trading_limits', 'limits_propose'], feature: 'autotrade-limits',
    body: 'Every limit real mode enforces is yours to set, in one file (`~/.dexterm/autotrade/real/limits.json`, schema `dexterm-limits/1`): per trade as SOL or as % of the book (the smaller wins), SOL and buys per day, open positions, exposure, min and max position, per coin per day, a daily loss stop, a drawdown breaker, a loss-streak pause, max hold time, the evidence floor for arming (`minForwardTrades`: closed paper trades in a completed forward test, placeholder 10), min liquidity and market cap, max slippage and price impact, the signal TTL, a buy rate limit, an optional sell rate (sells are never capped unless you set one) and how long a silent executor may stay silent. `dexterm autotrade limits show [--strategy ID] [--account ID]` lists what is in force and where each number comes from; `limits set perTradeSol=0.5 dailyLossSol=0.3` (or `--scope real|paper|strategy:ID|account:ID`) changes them: a global number replaces the placeholder default, every other scope can only tighten, and the stricter always wins. Paper runs ignore them unless you add a `paper` scope; then a single paper run (not `run --all`) obeys them on its own state (a replay then needs `--sol-usd N`). Daily counters cover the whole home (every strategy and account), so a strategy or account number can only stop buys sooner. Lowering is immediate, even for a running real run; raising shows the old -> new diff and needs the typed phrase on your own terminal, and applies from the next run. `limits diff`, `limits accept` (a hand-edited file), `limits reset`, `limits breaker reset` (typed) and `limits explain` do the rest. The defaults (0.25 SOL a trade, 1 SOL a day, 20 buys, 3 open, stop at -0.5 SOL a day) are placeholders: arming asks for your own numbers first. The analyst can read and explain them (`trading_limits`) and propose a change as a diff card (`limits_propose`); it can never apply one.' },
  { id: 'autotrade-executor-kit', title: 'Wire up a test executor, check it is alive, and get the digest (dexterm autotrade executor, signal test, report)', screen: 'all', tags: ['executor', 'kit', 'example', 'heartbeat', 'alive', 'silent', 'health', 'test', 'webhook', 'receiver', 'dry', 'run', 'digest', 'report', 'daily', 'weekly', 'divergence', 'slippage', 'latency'],
    commands: ['autotrade'], feature: 'autotrade-executor-kit',
    body: '`dexterm autotrade executor kit --out ~/my-executor` copies the reference executors: a webhook receiver, a `--signal-cmd` hook and a JSONL tail. Each verifies the HMAC, dedupes by nonce, honours the TTL, writes a receipt and a heartbeat, and is DRY RUN: it only logs what it would do, with no wallet code in it. Start one, point a channel at it (`dexterm autotrade signal channels --webhook http://127.0.0.1:8787/signal`), then `dexterm autotrade signal test` sends a test signal (`test: true`, no coin, nothing to trade) and shows, per channel, whether it was delivered, how long it took and the executor\'s receipt. `dexterm autotrade executor status` shows the last heartbeat, the last receipt and the lag; a real run pauses new buy signals (exits still go out) when nothing is heard for longer than your `executorSilenceMin` limit, and tells you. With receipts that carry fills, `signal status`, `autotrade audit` and `dexterm autotrade report` show paper vs real: slippage against dexterm\'s own paper fill, latency, partial fills and rejections. `report [--period day|week] [--telegram]` is the digest per strategy and mode with the win rate\'s interval and a small-sample note; `report --schedule daily|weekly` makes a run with your bot on send it.' },
  { id: 'autotrade-chat', title: 'Change an autotrade strategy by chat (paper)', screen: 'autotrade', tags: ['autotrade', 'strategy', 'chat', 'analyst', 'proposal', 'tune', 'change', 'diff', 'looser', 'less', 'safe'],
    actions: [{ action: 'analyst.toggle' }, { action: 'autotrade.proposal', screen: 'autotrade' }],
    tools: ['strategy_list', 'strategy_get', 'strategy_validate', 'strategy_propose_edit', 'strategy_propose_new', 'strategy_backtest', 'autotrade_status'], feature: 'autotrade-chat',
    body: 'Ask the analyst to change one of your strategies ("make my swing exit faster"). It can only PROPOSE: the change arrives as a card on the AUTOTRADE screen (`Q`) with the field lines that change, the validation result and TIGHTER, NEUTRAL or LOOSER. `o` opens the card, `y` applies it as a new version (journaled with who proposed it), `n` dismisses it. When any risk number gets less safe (bigger size or exposure, more loss, a stop or safety gate removed) the edit is LOOSER and needs a second `y` on the less-safe popup. The mode, the book, the daily session budget and the exit-liquidity floor are yours only: the analyst cannot change them. It can backtest a proposal next to the current version on your recorded history (up to 14 days, read-only). Paper only.' },
  { id: 'autotrade-journey', title: 'Build a strategy by chat, back-test it, forward-test it, then promote it (paper, then real)', screen: 'all', tags: ['autotrade', 'strategy', 'build', 'chat', 'journey', 'ladder', 'backtest', 'held-out', 'forward', 'test', 'promote', 'promotion', 'always-on', 'real', 'evidence'],
    commands: ['autotrade'], tools: ['strategy_journey', 'strategy_forward_start', 'strategy_forward_stop', 'strategy_forward_report', 'strategy_promote_propose'], feature: 'autotrade-journey',
    body: 'A strategy climbs one ladder, one rung at a time: draft → backtested → forward-tested → always-on (paper) → real. Each rung needs evidence measured on that strategy\'s exact rules; any rule change starts it again (a rename or arming keeps it). Ask the analyst to build one ("build me a strategy that buys young pairs on a 5-minute push and takes profit at 2x"): it proposes a copy of a preset with changes (strategy_propose_new), you apply it on the Q screen. BACKTESTED: `dexterm autotrade backtest <id>` or strategy_backtest runs it on recorded history and on each half of the held-out split (the newest 30% of coins); verdict rule 6 allows gain wording only with at least 20 trades in both halves and a held-out net above 0. FORWARD-TESTED: `dexterm autotrade forward start <id> --hours 24` (or `--trades N`, or strategy_forward_start from the chat) runs the same version on the LIVE tape, on paper, with its own bankroll and run file, in the background next to the always-on service; `forward status`, `forward stop` and `forward report` (the forward numbers next to the backtest: trades, win rate with its interval, net, drawdown, rug rate, fill cost drift, and a plain line when a sample is too small). Only a test that ran its whole window on live data counts. ALWAYS-ON: the analyst can propose it (strategy_promote_propose), you apply it with `dexterm autotrade promote apply <pp-id>` (y on your own terminal) or on the Q screen journey view (`J`, then `y`); it joins autotrade.json and the always-on service runs it on paper. REAL: you set your own limits (`dexterm autotrade limits set`; `signal caps set` sets four of them), then `dexterm autotrade promote <id> --to real` hands over to `signal arm` (evidence panel, typed phrase with a one-time code). No tool or model can apply a promotion, skip a rung, set a cap, pick a bankroll or arm real mode. `dexterm autotrade journey <id>` shows where a strategy stands. Paper by default; not financial advice.' },
  { id: 'trade-ledger', title: 'See every trade in one ledger: win rate, profiles, exit reasons, strategy versions (dexterm ledger)', screen: 'all', tags: ['ledger', 'journal', 'trades', 'history', 'results', 'stats', 'win', 'rate', 'drawdown', 'profile', 'exit', 'reason', 'compare', 'export', 'csv', 'equity', 'mfe', 'mae'],
    commands: ['ledger'], tools: ['ledger_trades', 'ledger_positions', 'ledger_summary', 'ledger_equity', 'ledger_compare', 'candidate_dossier', 'outcomes_lookup', 'trading_status', 'telegram_status', 'backtest_requests'], feature: 'trade-ledger',
    body: '`dexterm ledger trades` lists every round trip dexterm booked, from the paper ticket, the agent paper desk and autotrade runs, newest first: strategy version, the exit profile and entry reason it was opened with (marked * when not declared with the fill), the exit reason, size and % of book, entry and exit market cap, P/L, hold and MFE/MAE. `positions` shows the open ones. `summary` gives the win rate with its 95% interval, P/L, profit factor, drawdown and rug rate by profile, exit reason, strategy, source and mode; `equity` the realized equity curve; `compare` strategy versions side by side (for strategies run in parallel); `export csv|json|parquet-lite [--out FILE]`; `card <tradeId>` a PnL card from a row. Filters: --source, --mode paper|devnet|live|real (real = a real-mode run: dexterm\'s model of the trades it signalled), --strategy id[@version], --profile, --exit, --mint, --run, --days, --status. Reads never write; `dexterm ledger sync` appends to ~/.dexterm/ledger/trades.jsonl (sha256-chained) and `dexterm ledger verify` names the first edited line. Agents read the same rows with the read-only ledger_* tools; `trading_status` and `telegram_status` show settings and state, never a key, address, exact balance, bot token or chat id. A backtest an agent asks for (backtest_request) only runs when you run it: `dexterm autotrade requests`. PAPER rows are simulated; filter by --mode before comparing. Not financial advice. Full docs: https://dexterm.xyz/docs/paper-trading/#the-trade-ledger' },
  { id: 'coin-images', title: 'Turn coin images on or off', screen: 'all', tags: ['images', 'image', 'pictures', 'icons', 'logos', 'off'],
    flags: ['--no-images'], feature: 'coin-images',
    body: 'Coin pictures render as real pixels in image-capable terminals (kitty/iTerm2/sixel) and as block art everywhere else. Turn them off with `--no-images` (or `DEXTERM_IMAGES=0`, or `enabled:false` in `~/.dexterm/images.json`). `dexterm doctor` has a Coin images line that says which path you get.' },
  { id: 'bubble-map', title: 'Open the bubble map', screen: 'token', tags: ['bubble', 'bubbles', 'map', 'cluster', 'clusters', 'holders', 'wallets', 'cabal'],
    actions: [{ action: 'intel.bubbles', screen: 'token' }], feature: 'bubble-map',
    body: 'Press `M` on a token to open the BUBBLE MAP: top holders as discs (area = share of supply, colour = the rule that labelled the wallet), linked-cluster rings, a CLUSTERS table and a WHY THIS LABEL panel. Keyless it uses the public holder list with static labels; a free Helius key adds funders and the launch window.' },
  { id: 'what-dexterm-shows-agents', title: 'See what the user currently sees (app_state)', screen: 'all', tags: ['state', 'current', 'screen', 'context', 'selected', 'agent', 'see'],
    tools: ['app_state', 'screen_state'], feature: 'mcp',
    body: 'An agent can call the read-only `app_state` MCP tool to fit an answer to what the user sees: the current screen, the selected coin, the theme, price mode, voice name/rate, whether scan and calm are on, and which alert channels are configured (YES/NO only — never a token, webhook or key). `screen_state` adds the visible rows and the action allow-list.' },
  // --- user-facing subcommand topics (task-1413 r2: forward subcommand/flag coverage)
  { id: 'app-help-command', title: 'Get help on how dexterm works (dexterm help)', screen: 'all', tags: ['help', 'how', 'topic', 'topics', 'guide', 'manual', 'docs', 'commands'],
    commands: ['help'], flags: ['--help'], feature: 'app-help',
    body: '`dexterm help [topic]` answers "how do I ..." from the generated app-help knowledge base — the same entries the analyst\'s `app_help` tool uses, so they cannot drift from the app. `dexterm help` lists the topics; `dexterm help <topic|key|command>` prints the matching entry with the exact key or command. `--help` (or `-h`) on any command prints its usage. The analyst searches app-help first and never invents a key.' },
  { id: 'connect-an-agent-registry', title: 'Manage connected agents (dexterm agent)', screen: 'all', tags: ['agent', 'agents', 'registry', 'tier', 'pause', 'resume', 'kick', 'audit', 'bus', 'serve'],
    commands: ['agent'], feature: 'mcp',
    body: '`dexterm agent add|list|rotate|remove|tier|pause|resume|kick|audit|packs` manages your bring-your-own-agent registry and the loopback bus; `dexterm agent serve` runs a standalone bus on fixtures and `connect` attaches one. Every agent is untrusted and read-only: it can never sign, arm, raise a cap, touch keys or change network settings.' },
  { id: 'spectate-an-agent', title: 'Watch an agent drive dexterm (dexterm spectate)', screen: 'all', tags: ['spectate', 'spectator', 'watch', 'agent', 'cook', 'observe', 'replay', 'stream', 'record', 'mcp', 'follow'],
    commands: ['spectate'], flags: ['--replay', '--spectate-mcp', '--spectate-thoughts'], feature: 'spectator',
    body: 'Watch an agent work. For an agent on the loopback bus, `dexterm agent serve --spectator-popup` opens the AGENT ACTIVITY window, `--spectate` starts the read-only, token-gated, loopback stream, and `--record FILE` saves a redacted session. For an agent connected over MCP (`dexterm mcp install`), run the app with `dexterm --spectate-mcp`: the running terminal follows the agent and an agent dock appears under the screen — a phase rail (SCANNING > VETTING > SIZING > EXECUTING > HOLDING > EXITING) with a heartbeat, the call timeline with result chips, the rows it scans glow and a cursor marks the coin it opens, a vetting card fills its checks and LARP evidence, and a PAPER trade shows its ticket, the fill, a live position with the mark PnL and a result card. `--spectate-thoughts FILE` streams the agent\'s own words into a thought ribbon from a JSONL file it writes (for example `claude -p --output-format stream-json`); display only. PAPER is always on screen; ctrl+p pauses, ctrl+k kills (a hard stop) and any key you press takes control; calm mode drops the motion. While the agent is active, the token screen\'s analyst panel is its BRAIN VIEW: the reasoning stream with phase tags (or dexterm\'s narration when there is no thoughts feed), the vetting checklist with the app\'s numbers and pass/warn/fail/pending, a data strip, the PAPER plan and position, and the session\'s decision log with a simulated scoreboard. While it holds a PAPER position, a PnL chip shows coin, PnL, entry to mark, peak, drawdown, time held and the take-profit it said, on every terminal screen (in the dock, or on the band under the header on terminals under 24 rows) and on the chart popup; display only. `dexterm spectate --replay FILE` replays a saved session step by step and `dexterm spectate --info` shows the live stream endpoint. Every shared copy is redacted — a tool name, refusal, agent line or navigation can never leak a wallet or key — and a spectator can only watch, never act. Full docs: https://dexterm.xyz/docs/spectator/' },
  { id: 'recorder-history', title: 'Work with the history recorder (dexterm recorder)', screen: 'all', tags: ['recorder', 'record', 'history', 'stats', 'label', 'prune', 'outcomes', 'database', 'session', 'capture', 'data'],
    commands: ['recorder'], flags: ['--record', '--no-recorder'], feature: 'recorder',
    body: '`dexterm recorder stats|label|prune|export` works with the local history recorder\'s tables (the outcome-labelled data the rug model and backtests learn from). No network. Recording is on by default; `--no-recorder` disables it for a run and `--record FILE` captures a data session to a file for replay.' },
  { id: 'record-headless', title: 'Keep the recorder running with the app closed (dexterm record)', screen: 'all', tags: ['collector', 'collect', 'background', 'headless', 'launchd', 'daemon', 'keep', 'closed', 'backtest'],
    commands: ['record'], feature: 'recorder',
    body: '`dexterm record` runs the history recorder with no terminal UI, so the data the backtests learn from keeps growing while dexterm is closed. `dexterm record status` shows what it has collected; `dexterm record install --dry-run` prints the user-level LaunchAgent it would create (macOS, no sudo) and `dexterm record uninstall` removes it. It uses the same free-tier request limits as the app, never trades, and a disk cap pauses new observations when the database gets large.' },
  { id: 'narrative-board', title: 'See the narrative board (dexterm narrative)', screen: 'trending', tags: ['narrative', 'narratives', 'board', 'trending', 'movers', 'window', 'summary'],
    commands: ['narrative'], feature: 'trending-board',
    body: '`dexterm narrative [--window 1h|24h] [--summary]` prints the narrative board — what is trending across the recorded feed — with no network and no model. In-app it is the trending screen.' },
  { id: 'kol-lists', title: 'Manage KOL wallet lists (dexterm kol)', screen: 'kol', tags: ['kol', 'kols', 'influencer', 'leader', 'list', 'lists', 'wallet', 'mute', 'import'],
    commands: ['kol'], feature: 'kol-lists',
    body: '`dexterm kol list|create|add|remove|mute|unmute|enable|disable|import` manages key-opinion-leader wallet lists on the shared DB (official / authorized sources only). In-app the KOL screen shows the lists and their activity.' },
  { id: 'login-with-x', title: 'Connect your X account (dexterm x)', screen: 'all', tags: ['x', 'twitter', 'login', 'oauth', 'account', 'social', 'connect', 'client'],
    commands: ['x'], feature: 'login-with-x',
    body: '`dexterm x status|set-client-id|login|logout` connects your X (Twitter) account via OAuth2 PKCE on a loopback callback. Tokens stay in `~/.dexterm/x` (0600), are never printed, and the scopes are read-only. It only improves social signal; nothing is posted.' },
  { id: 'edit-rules', title: 'Set up alert rules (dexterm rules)', screen: 'all', tags: ['rules', 'rule', 'trigger', 'condition', 'alert', 'add', 'dry-run', 'fields', 'engine'],
    commands: ['rules'], feature: 'rules-engine',
    body: '`dexterm rules list|add|remove|enable|disable|check|dry-run|fields` configures the rules engine — the conditions that raise an alert (e.g. liquidity jump, volume spike). `dry-run` tests a rule against recent data; `fields` lists what you can match on. No network, no model, and a rule can never trade. Deliver the alerts with `dexterm alerts` and `dexterm watch`.' },
  { id: 'watch-headless', title: 'Run alerts in the background (dexterm watch)', screen: 'all', tags: ['watch', 'background', 'headless', 'push', 'alerts', 'notify', 'daemon', 'interval'],
    commands: ['watch'], flags: ['--interval'], feature: 'push-alerts',
    body: '`dexterm watch [--interval S] [--once|--ticks N] [--replay FILE]` runs the rules engine headless and PUSHES alerts to your enabled channels, so they reach you when the terminal is closed. It has no signer and can never trade. Set channels up first with `dexterm alerts`.' },
  { id: 'share-packs', title: 'Share or install packs (dexterm pack)', screen: 'all', tags: ['pack', 'packs', 'share', 'install', 'export', 'sign', 'trust', 'lock', 'bundle'],
    commands: ['pack'], feature: 'packs',
    body: '`dexterm pack list|verify|add|remove|export|lock|sign|trust|signers|keymap|widget` shares themes, keymaps, rules and widgets as plain files with a sha256 lock and an optional ssh signature. A pack never runs code: widgets land disabled, unsigned rules load disabled, and a keymap merges only on the explicit command.' },
  { id: 'link-a-wallet', title: 'Link a wallet to show its public key (dexterm wallet)', screen: 'all', tags: ['wallet', 'link', 'unlink', 'phantom', 'connect', 'pubkey', 'panic', 'resume'],
    commands: ['wallet'], flags: ['--no-live'], feature: 'trading',
    body: '`dexterm wallet link|unlink|status` links a Phantom wallet through a loopback bridge (Phantom signs a MESSAGE, never a transaction): your keys NEVER enter dexterm, only the public key is stored, for display. dexterm holds no key and never signs or sends a transaction; trading in dexterm is paper, and live trading happens in the Telegram trading bot of your choice. `dexterm wallet panic` halts autotrade runs and the paper agent desk at once; only `dexterm wallet resume`, a keypress on a real terminal, clears it. `--no-live` (0.1.6) is accepted and changes nothing. The analyst can never link, unlink or resume.' },
  { id: 'order-plans', title: 'Set conditional order plans (dexterm plan)', screen: 'all', tags: ['plan', 'plans', 'order', 'conditional', 'take-profit', 'stop', 'trigger', 'arm'],
    commands: ['plan'], feature: 'order-plans',
    body: '`dexterm plan list|add|remove|arm|disarm` sets conditional order plans (e.g. take-profit / stop levels). Voice and agents can only PROPOSE a plan; ARMING one needs your physical keypress, and plans fill on PAPER (dexterm places no live order). Nothing here lets a model sign or raise a cap.' },
  { id: 'standing-mandates', title: 'Set a standing mandate (dexterm mandate)', screen: 'all', tags: ['mandate', 'mandates', 'standing', 'rule', 'budget', 'auto', 'arm', 'cap'],
    commands: ['mandate'], feature: 'order-plans',
    body: '`dexterm mandate list|add|remove|arm|disarm` sets a standing mandate — a longer-lived conditional rule bounded by a budget. As with plans, a model may only PROPOSE; arming needs your physical keypress and its caps bound it; fills are PAPER. The analyst can never arm a mandate or change its caps.' },
  { id: 'follow-a-wallet', title: 'Copy / follow a wallet (dexterm follow)', screen: 'all', tags: ['follow', 'copy', 'mirror', 'wallet', 'trader', 'track', 'unfollow', 'list'],
    commands: ['follow'], feature: 'copy-trading',
    body: '`dexterm follow list|add|remove` is the copy-trading follow list: local, self-directed and read-only. When a followed wallet trades, dexterm can surface a one-key MIRROR TICKET you confirm yourself — it never auto-trades, never signs, and the analyst can never add a follow or confirm a mirror.' },
  { id: 'chart-popup-selftest', title: 'Run the popup self-test (dexterm popup --self-test)', screen: 'all', tags: ['self-test', 'selftest', 'test', 'shell', 'fps', 'diagnose', 'hotkey'],
    commands: ['popup'], feature: 'popup-selftest',
    body: '`dexterm popup --self-test [--browser] [--seconds N] [--theme NAME]` opens a chart popup on fixture data and reports the shell, hotkey and fps it can measure headlessly, labelling what still needs a human at an unlocked Mac. In-app, open the popup for real with `C` on the token screen (see "Open the chart popup").' },
];

// ---------------------------------------------------------------------------------------- build + serialize

export interface GenEntry { id: string; frontmatter: Record<string, unknown>; body: string }

function fm(order: Array<[string, unknown]>): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const [k, v] of order) if (v !== undefined && !(Array.isArray(v) && v.length === 0) && v !== '') o[k] = v;
  return o;
}

/** Build every app-help entry from the current app sources + the committed TOPICS/SCREENS tables. */
export function buildAppHelpEntries(): GenEntry[] {
  const subcommands = new Set(appSubcommands());
  const flags = new Set(appFlags());
  const tools = new Set(appTools());
  const out: GenEntry[] = [];

  // --- per-screen entries
  for (const s of SCREENS) {
    const { actions, keys } = screenActions(s.screen);
    const rows = helpRows(s.screen, false);
    const keyList = rows.filter((r) => r.keys && r.label).map((r) => `  \`${r.keys}\` — ${r.label}`).join('\n');
    const toolsUsed = s.tools.filter((t) => tools.has(t));
    const body = `${s.blurb}\n\nKeys on this screen:\n${keyList}`;
    out.push({
      id: `screen-${s.screen}`,
      frontmatter: fm([
        ['id', `screen-${s.screen}`], ['title', s.title], ['kind', 'app-help'], ['screen', s.screen],
        ['feature', s.feature], ['tags', ['app-help', 'screen', s.screen, ...s.title.toLowerCase().split(/\s+/)]],
        ['keys', keys], ['actions', actions], ['tools', toolsUsed],
        ['confidence', 'high'], ['owner', 'maintainers'], ['origin', 'app-help-generated'],
        ['reviewed_by', `generated@${GENERATED_DATE}`],
        ['generated_from', 'dexterm/app keymap + overlay + mcp tools (task-1413)'],
        ['sources', ['packages/tui/src/keymap.ts', 'packages/cli/src/screens/overlay.ts']],
        ['date', GENERATED_DATE],
      ]),
      body,
    });
  }

  // --- topic entries
  for (const t of TOPICS) {
    const keys: string[] = [];
    const actions: string[] = [];
    const keyLines: string[] = [];
    for (const a of t.actions ?? []) {
      const k = keyFor(a.action, a.screen);
      if (!actions.includes(a.action)) actions.push(a.action);
      for (const kk of k.keys) if (!keys.includes(kk)) keys.push(kk);
      if (k.display) keyLines.push(`\`${k.display}\`${a.screen ? ` (${a.screen})` : ''}`);
    }
    // Validate referenced commands/flags/tools exist in the app (fail the generator loudly if not).
    const cmds = (t.commands ?? []).filter((c) => { if (!subcommands.has(c)) throw new Error(`app-help topic ${t.id}: unknown subcommand "${c}"`); return true; });
    const fls = (t.flags ?? []).filter((f) => { if (!flags.has(f)) throw new Error(`app-help topic ${t.id}: unknown flag "${f}"`); return true; });
    const tls = (t.tools ?? []).filter((x) => { if (!tools.has(x)) throw new Error(`app-help topic ${t.id}: unknown MCP tool "${x}"`); return true; });

    const trailer: string[] = [];
    if (keyLines.length) trailer.push(`Keys: ${keyLines.join(', ')}.`);
    if (cmds.length) trailer.push(`CLI: ${cmds.map((c) => `\`dexterm ${c}\``).join(', ')}.`);
    const body = trailer.length ? `${t.body}\n\n${trailer.join(' ')}` : t.body;

    out.push({
      id: t.id,
      frontmatter: fm([
        ['id', t.id], ['title', t.title], ['kind', 'app-help'], ['screen', t.screen],
        ['feature', t.feature ?? ''], ['tags', ['app-help', ...t.tags]],
        ['keys', keys], ['actions', actions], ['commands', cmds], ['flags', fls], ['tools', tls],
        ['confidence', 'high'], ['owner', 'maintainers'], ['origin', 'app-help-generated'],
        ['reviewed_by', `generated@${GENERATED_DATE}`],
        ['generated_from', 'dexterm/app keymap + overlay + mcp tools + cli (task-1413)'],
        ['sources', ['packages/tui/src/keymap.ts', 'packages/cli/src/main.ts', 'packages/mcp/src/server.ts']],
        ['date', GENERATED_DATE],
      ]),
      body,
    });
  }

  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

/** Serialize an entry to the bundled `.md` format the loader parses (block lists, deterministic order). */
export function serializeEntry(e: GenEntry): string {
  const lines: string[] = ['---'];
  for (const [k, v] of Object.entries(e.frontmatter)) {
    if (Array.isArray(v)) {
      lines.push(`${k}:`);
      for (const item of v) lines.push(`  - ${item}`);
    } else {
      lines.push(`${k}: ${v}`);
    }
  }
  lines.push('---', '', e.body.trim(), '');
  return lines.join('\n');
}
