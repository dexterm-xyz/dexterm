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
  { screen: 'token', title: 'The token screen', feature: 'token-intel', tools: ['get_dossier', 'get_token', 'get_holders', 'get_trades', 'get_candles', 'get_dev_history', 'rugcheck'],
    blurb: 'One coin in depth: market stats, a candle chart, the trades tape, mint/freeze authority, top holders with their class (pool/dev/linked/…), RugCheck + GoPlus, snipers/bundled from the wallet-intel scan, and the ANALYST panel. Open it with ⏎ on any live row or `--mint <CA|link>`.' },
  { screen: 'newpairs', title: 'The new pairs screen', feature: 'new-pairs', tools: ['screener_query'],
    blurb: 'A live feed of just-launched tokens (PumpPortal new-token + migration push, plus Jupiter/RugCheck/DexScreener polls). Bonding progress is a create-time estimate and says so; SNIPE/BUNDLE columns fill in from the wallet-intel scan of the row the cursor rests on (Helius-keyed).' },
  { screen: 'watchlist', title: 'The watchlist screen', feature: 'watchlist', tools: [],
    blurb: 'The coins you watch, persisted in SQLite, priced live every ~10 s with a LIVE/POLL badge. Add with `w` on any coin; remove with `d`.' },
  { screen: 'analyst', title: 'The analyst screen', feature: 'analyst', tools: ['get_dossier', 'kb_search', 'app_help'],
    blurb: 'Your own `claude` CLI as the dexterm analyst: it reads the read-only dexterm MCP tools, grounds every fact in a tool result, and answers in a few terse lines. ⏎ on a coin runs a full dossier; `a` runs a rug-check. Facts never come from model memory; token text passes the prompt firewall.' },
  { screen: 'positions', title: 'The paper positions screen', feature: 'positions', tools: [],
    blurb: 'Your simulated (PAPER) positions and their P&L. dexterm holds no keys and signs nothing; paper trading is a simulation for learning the flow.' },
  { screen: 'trending', title: 'The trending screen', feature: 'trending-board', tools: ['narrative_board'],
    blurb: 'What is trending in the space — narratives and movers aggregated from the feed.' },
  { screen: 'kol', title: 'The KOL lists screen', feature: 'kol-lists', tools: [],
    blurb: 'Key-opinion-leader wallet lists and their activity (official/authorized sources only).' },
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
  { id: 'switch-theme', title: 'Switch the theme', screen: 'all', tags: ['theme', 'themes', 'colour', 'colours', 'color', 'colors', 'look', 'cyberspace', 'midnight', 'ember', 'paper'],
    actions: [{ action: 'theme.next' }], commands: ['theme'], flags: ['--theme'], feature: 'themes-keymaps',
    body: 'Press `t` to cycle themes (cyberspace → midnight → ember → paper). `dexterm theme list|show|init|check` manages your own themes in `~/.dexterm/themes/`; a shared theme cannot hide a warning or swap buy/sell colours (a contrast + hue guard). The analyst can propose a theme change you confirm with a keypress.' },
  { id: 'calm-mode', title: 'Turn on calm mode (effects off)', screen: 'all', tags: ['calm', 'effects', 'rain', 'glitch', 'quiet', 'still', 'intensity'],
    flags: ['--calm', '--intensity'], feature: 'look',
    body: 'Press `c` to toggle calm mode: rain, glitch, blink and scanlines off, back to the last intensity when pressed again. Start calm with `--calm` (or `DEXTERM_CALM=1`); `--intensity normal|fever|off` picks a tier. The analyst can toggle calm for you.' },
  { id: 'price-or-marketcap', title: 'Show price or market cap', screen: 'all', tags: ['price', 'mcap', 'marketcap', 'market', 'display', 'usd', 'cap'],
    actions: [{ action: 'display.priceMode' }], commands: ['display'], flags: ['--price-mode'], feature: 'price-display-mode',
    body: 'Press `$` to flip every price between USD price and MARKET CAP (screener, watchlist, new pairs, token, both charts, order-plan levels). Saved as `display.priceMode`; also `dexterm display price|mcap` or `--price-mode`. A coin with no known supply stays on price and says so. The analyst can set this for you.' },
  { id: 'scan-mode', title: 'Use AI scan mode', screen: 'all', tags: ['scan', 'watcher', 'observe', 'auto', 'ai', 'monitor'],
    actions: [{ action: 'scan.toggle' }, { action: 'scan.resume' }], flags: ['--scan'], feature: 'scan',
    body: 'Scan mode is an observe-only AI watcher (off by default, zero extra requests). Toggle it with `Z` (or `/scan on|off` on the screener line, or `--scan` at launch); `R` resumes a paused scan. It can only surface findings, never take a UI action or trade (structurally observe-only). The analyst can turn it on or off for you.' },
  { id: 'larp-check', title: 'Run the LARP check (is the product real?)', screen: 'token', tags: ['larp', 'fake', 'real', 'legit', 'website', 'product', 'domain', 'github', 'vet'],
    tools: ['larp_check', 'get_links', 'fetch_page', 'check_domain', 'check_github'], feature: 'larp-check',
    body: 'The LARP check vets whether a real product exists (website, domain age, GitHub) read-only — it is not a price call. Ask the analyst "is <coin> a larp?" (skill `larp-check`), or an agent can call the `larp_check` MCP tool. A grade is a risk flag, never a certificate; it never recommends buy/sell.' },
  { id: 'rug-check', title: 'Check if a coin is a rug', screen: 'token', tags: ['rug', 'safe', 'honeypot', 'scam', 'risk', 'check', 'authority', 'mint'],
    actions: [{ action: 'analyst.toggle' }], tools: ['analyze_token', 'get_dossier', 'rugcheck'], feature: 'analyst',
    body: 'Press `a` to run a rug-check on the selected coin: authorities, token program, LP, holder concentration, creator history and tape, with a p(rug) from the H1 heuristic (a ranking, not a calibrated probability). The verdict is WATCH / SPECULATIVE / AVOID. Facts come only from tools; it is not financial advice.' },
  { id: 'ask-the-analyst', title: 'Ask the analyst a question', screen: 'analyst', tags: ['analyst', 'ask', 'claude', 'ai', 'question', 'dossier', 'chat'],
    actions: [{ action: 'analyst.toggle' }, { action: 'open', screen: 'screener' }], tools: ['get_dossier', 'kb_search', 'app_help', 'case_lookup'], feature: 'analyst',
    flags: ['--no-ai'],
    body: 'The analyst is your own `claude` login. ⏎ on a coin runs a full dossier; `a` runs a rug-check (or a trench-scan of the screener when nothing is selected). Type a follow-up and ⏎ to send. If `claude` is missing or logged out the panel shows the one-line fix and the rest of dexterm keeps working. Start without AI using `--no-ai`.' },
  { id: 'connect-an-agent', title: 'Connect your own agent (MCP)', screen: 'all', tags: ['mcp', 'agent', 'agents', 'connect', 'claude', 'tool', 'server', 'bot'],
    commands: ['mcp'], tools: ['screen_state', 'get_dossier', 'kb_search', 'app_help', 'app_state'], feature: 'mcp',
    body: '`dexterm mcp` is a plain stdio MCP server exposing the same read-only tools the analyst uses. Add it to any Claude Code with `claude mcp add dexterm -- node packages/mcp/bin/dexterm-mcp.mjs`. Agents are untrusted: every tool is read-only and an agent can never sign, arm, raise a cap or touch keys. Use `app_help` for "how do I" questions and `app_state` to see what the user sees.' },
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
    body: 'Press `B` / `S` on the token screen to open a PAPER buy/sell ticket in its editing phase. dexterm holds no keys and signs nothing — paper trading is a simulation. Confirming a ticket needs your explicit keypress (the gate); a stray key never confirms. The analyst can open a PAPER ticket but can never size, confirm or send it.' },
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
  { id: 'spectate-an-agent', title: 'Watch an agent drive dexterm (dexterm spectate)', screen: 'all', tags: ['spectate', 'spectator', 'watch', 'agent', 'cook', 'observe', 'replay', 'stream', 'record'],
    commands: ['spectate'], flags: ['--replay'], feature: 'spectator',
    body: '`dexterm spectate --replay FILE` replays a saved agent session so you can watch what an agent did step by step; `dexterm spectate --info` shows the live read-only, token-gated, loopback spectator stream. The stream is redacted — a tool name, refusal, agent line or navigation can never leak a wallet or key — and a spectator can only watch, never act.' },
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
  { id: 'link-a-wallet', title: 'Link a wallet for trading (dexterm wallet)', screen: 'all', tags: ['wallet', 'link', 'unlink', 'phantom', 'connect', 'pubkey', 'caps', 'trade'],
    commands: ['wallet'], flags: ['--mainnet', '--max-usd', '--daily-usd', '--max-sol-out', '--max-slippage-bps', '--trade-rpc', '--no-live'], feature: 'trading',
    body: '`dexterm wallet link|unlink|status` links a Phantom wallet through a loopback bridge — your keys NEVER enter dexterm, only the public key is stored — and shows the link and the signer-side trade caps. dexterm is non-custodial: it builds and simulates transactions, your own wallet signs. The signer-side caps (`--max-usd`, `--daily-usd`, `--max-sol-out`, `--max-slippage-bps`) and the RPC (`--trade-rpc`) bound every trade and live on the signer; `--mainnet` opts in to mainnet and `--no-live` keeps it paper-only. The analyst can never link, unlink, sign, arm or change a cap.' },
  { id: 'order-plans', title: 'Set conditional order plans (dexterm plan)', screen: 'all', tags: ['plan', 'plans', 'order', 'conditional', 'take-profit', 'stop', 'trigger', 'arm'],
    commands: ['plan'], feature: 'order-plans',
    body: '`dexterm plan list|add|remove|arm|disarm` sets conditional order plans (e.g. take-profit / stop levels). Voice and agents can only PROPOSE a plan; ARMING one needs your physical keypress, and the caps and panic-stop stay signer-side. Nothing here lets a model sign or raise a cap.' },
  { id: 'standing-mandates', title: 'Set a standing mandate (dexterm mandate)', screen: 'all', tags: ['mandate', 'mandates', 'standing', 'rule', 'budget', 'auto', 'arm', 'cap'],
    commands: ['mandate'], feature: 'order-plans',
    body: '`dexterm mandate list|add|remove|arm|disarm` sets a standing mandate — a longer-lived conditional rule bounded by a budget. As with plans, a model may only PROPOSE; arming needs your physical keypress and the signer-side caps bound it. The analyst can never arm a mandate or change its caps.' },
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
