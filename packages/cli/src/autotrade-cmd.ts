// `dexterm autotrade <sub>` (task-1503 AT-1, AUTOTRADE-SPEC). No keys, no wallet, no signer: paper, or real mode
// (task-1645: trade-fire signals to the user's own executor, `signal` / `receipt` rows).
//
// A dispatcher table: each subcommand is one row that lazy-loads its own module under ./autotrade-cmd/, so
// later cards add a row (run, service, stop, flatten, audit) without editing anyone else's lines.
// `dexterm backtest --subject strategy …` is routed here too (the strategy subject runs on this engine).

export interface AutotradeIo {
  stdout: { write(s: string): unknown };
  stderr: { write(s: string): unknown };
  env: NodeJS.ProcessEnv;
  /** A real terminal's stdin, for keypress confirms (flatten); a pipe is never a TTY. */
  stdin?: import('./wallet-cmd.ts').KeyInput;
}

export type SubcommandFn = (argv: string[], io: AutotradeIo) => number | Promise<number>;
export interface Subcommand { usage: string; summary: string; load: () => Promise<SubcommandFn> }

export const SUBCOMMANDS: Record<string, Subcommand> = {
  list: {
    usage: 'dexterm autotrade list [--json]',
    summary: 'your strategies (~/.dexterm/strategies) and the shipped presets: version, hash, mode, profiles, last backtest',
    load: () => import('./autotrade-cmd/strategies.ts').then((m) => m.listCmd),
  },
  validate: {
    usage: 'dexterm autotrade validate <id|file> [--json]',
    summary: 'check a strategy file or a stored strategy; every problem is printed with its path',
    load: () => import('./autotrade-cmd/strategies.ts').then((m) => m.validateCmd),
  },
  new: {
    usage: 'dexterm autotrade new <new-id> --from <preset|id> [--name TEXT]',
    summary: 'copy a preset (or one of your strategies) into ~/.dexterm/strategies/<new-id>.json to edit',
    load: () => import('./autotrade-cmd/strategies.ts').then((m) => m.newCmd),
  },
  import: {
    usage: 'dexterm autotrade import <file> [--replace]',
    summary: 'validate a strategy file and store it (mode is forced to paper; --replace needs a higher version)',
    load: () => import('./autotrade-cmd/strategies.ts').then((m) => m.importCmd),
  },
  remove: {
    usage: 'dexterm autotrade remove <id>',
    summary: 'move one of your strategies to ~/.dexterm/strategies/.removed/ (journaled; presets cannot be removed)',
    load: () => import('./autotrade-cmd/strategies.ts').then((m) => m.removeCmd),
  },
  journal: {
    usage: 'dexterm autotrade journal [<id>] [--json]',
    summary: 'the append-only change journal: who changed what, with the before and after hashes',
    load: () => import('./autotrade-cmd/strategies.ts').then((m) => m.journalCmd),
  },
  backtest: {
    usage: 'dexterm autotrade backtest <id|file> [--tape FILE | --db PATH [--days N | --since T] [--until T]] [--every-candidate [--unit-usd 20]] [--recall 5,10] [--json]',
    summary: 'replay a strategy over recorded history with modelled fills (paper); the limits of the data are always printed',
    load: () => import('./autotrade-cmd/backtest.ts').then((m) => m.backtestCmd),
  },
  sweep: {
    usage: 'dexterm autotrade sweep <id|file> [--tape FILE | --db PATH] [--grid JSON] [--mode grid|random] [--max N] [--seed N] [--json]',
    summary: 'tune on the older coins, check once on the newest 30% it never saw; no gain wording without enough trades and a held-out profit',
    load: () => import('./autotrade-cmd/backtest.ts').then((m) => m.sweepCmd),
  },
  'yolo-replay': {
    usage: 'dexterm autotrade yolo-replay <id|file> [--tape FILE | --db PATH [--days N | --since T] [--until T]] [--seed N] [--json]',
    summary: 'HIGH RISK check before arming a full-port strategy: replay it at 100% of the book over recorded history (paper): rugs, the loss spread, how often it zeroed the wallet',
    load: () => import('./autotrade-cmd/backtest.ts').then((m) => m.yoloReplayCmd),
  },
  requests: {
    usage: 'dexterm autotrade requests [list [--all] [--json] | run <br_id> | dismiss <br_id>]',
    summary: 'backtests an agent asked for over MCP (backtest_request): nothing runs until you run one here (paper, recorded data)',
    load: () => import('./autotrade-cmd/requests.ts').then((m) => m.requestsCmd),
  },
  run: {
    usage: 'dexterm autotrade run <id|file> --paper|--real [--replay TAPE [--ms-per-tick 2000]] [--model M] [--max-minutes N] [--sol-usd N] [--stub] [--raw] [--quiet] [--no-telegram]',
    summary: 'the runner: the screener hands each candidate to your own Claude (runner.json picks the account), every size clamped; ledger in autotrade/runs/; your paired Telegram bot starts with it (dexterm telegram setup). --real (a strategy you armed with signal arm) runs in the FOREGROUND only, on live data: the always-on service runs paper strategies, and while no real run is running NO signal goes out, sells included',
    load: () => import('./autotrade-cmd/run.ts').then((m) => m.runCmd),
  },
  'run --all': {
    usage: 'dexterm autotrade run --all --paper [--config FILE] [--replay TAPE] [--sol-usd N] [--stub] [--max-minutes N]',
    summary: 'every strategy of autotrade/autotrade.json at once on one data feed: each its own bankroll, ledger, caps and budget, under global caps',
    load: () => import('./autotrade-cmd/fleet.ts').then((m) => m.fleetRunCmd),
  },
  status: {
    usage: 'dexterm autotrade status [--all] [--json]',
    summary: 'the paper runner now; --all: every strategy of a parallel run side by side (P/L, win rate, rug exposure, missed runners, spend per entry)',
    load: () => import('./autotrade-cmd/strategy-control.ts').then((m) => m.statusCmd),
  },
  start: {
    usage: 'dexterm autotrade start <strategy> [--wait SEC] [--json]',
    summary: 'start one strategy of autotrade.json inside the running `run --all` (paper, its own book and caps)',
    load: () => import('./autotrade-cmd/strategy-control.ts').then((m) => m.startCmd),
  },
  pause: {
    usage: 'dexterm autotrade pause [--strategy ID] [--json]',
    summary: 'no new entries (every strategy, or just one with --strategy); open positions keep their exits',
    load: () => import('./autotrade-cmd/strategy-control.ts').then((m) => m.pauseCmd),
  },
  resume: {
    usage: 'dexterm autotrade resume [--strategy ID] [--json]',
    summary: 'lift a pause (every strategy, or just one with --strategy); a stop is final and is never lifted',
    load: () => import('./autotrade-cmd/strategy-control.ts').then((m) => m.resumeCmd),
  },
  stop: {
    usage: 'dexterm autotrade stop [--strategy ID] [--wait SEC] [--json]',
    summary: 'soft-stop the paper runner: no new entries, sessions closed, orders dropped; mechanical exits keep running until nothing is held',
    load: () => import('./autotrade-cmd/stop.ts').then((m) => m.stopCmd),
  },
  flatten: {
    usage: 'dexterm autotrade flatten [--strategy ID] [--yes] [--wait SEC] [--json]',
    summary: 'stop, then sell every paper position at its next tick (confirm with y on a terminal, or --yes)',
    load: () => import('./autotrade-cmd/flatten.ts').then((m) => m.flattenCmd),
  },
  audit: {
    usage: 'dexterm autotrade audit [<run-id>|--last] [--verify] [--json]',
    summary: 'list the run ledgers; --verify recomputes each hash chain and names the first edited, missing or reordered event',
    load: () => import('./autotrade-cmd/audit.ts').then((m) => m.auditCmd),
  },
  signal: {
    usage: 'dexterm autotrade signal status|channels|secret|arm|disarm|caps|kill|unkill|held|release|test|flush|tail|reconcile …',
    summary: 'real mode: a LIVE TRADE FIRE signal per trade to YOUR executor (webhook, --signal-cmd, JSONL, MCP, Telegram copy); arm on your own terminal; hard caps, kill switch; dexterm holds no key',
    load: () => import('./autotrade-cmd/signal.ts').then((m) => m.signalCmd),
  },
  receipt: {
    usage: 'dexterm autotrade receipt <nonce|id> executed|rejected|failed [--price USD] [--size-sol N] [--tokens N] [--tx SIG] [--reason TEXT] | receipt list [--json]',
    summary: 'what your executor did with a trade-fire signal, as data only (positions stay unconfirmed until a receipt); the drift between signals and fills',
    load: () => import('./autotrade-cmd/receipt.ts').then((m) => m.receiptCmd),
  },
  service: {
    usage: 'dexterm autotrade service install|uninstall|ensure|run|start|stop|status|logs [--home PATH]',
    summary: 'the always-on service: your PAPER strategies (autotrade.json) start at login, restart after a crash, stop on any kill switch and tell you when they cannot run; real mode does not run under it (run --real, in the foreground)',
    load: () => import('./autotrade-cmd/service.ts').then((m) => m.serviceCmd),
  },
  forward: {
    usage: 'dexterm autotrade forward start <id> [--hours H] [--trades N] [--bankroll-usd N] | status [<id>] | stop <id> | report <id> [--json]',
    summary: 'forward test: the strategy on the LIVE tape, on paper, own bankroll and run file, for hours or N trades; the report sets it next to its backtest',
    load: () => import('./autotrade-cmd/forward.ts').then((m) => m.forwardCmd),
  },
  journey: {
    usage: 'dexterm autotrade journey [<id>] [--json]',
    summary: 'where a strategy stands on the ladder draft → backtested → forward-tested → always-on → real, and what the next rung needs',
    load: () => import('./autotrade-cmd/journey.ts').then((m) => m.journeyCmd),
  },
  promote: {
    usage: 'dexterm autotrade promote <id> --to always-on|real | list | show <pp-id> | apply <pp-id> | dismiss <pp-id>',
    summary: 'a promotion with its evidence card: always-on needs your y on a real terminal; real needs the evidence floor (a completed forward test with minForwardTrades closed paper trades + a backtest) and hands over to signal arm (your caps, a typed phrase); no rung is skipped',
    load: () => import('./autotrade-cmd/journey.ts').then((m) => m.promoteCmd),
  },
  limits: {
    usage: 'dexterm autotrade limits show|set|diff|reset|accept|breaker reset|explain|schema …',
    summary: 'real mode: every limit is yours (per trade SOL or % of book, per day, open positions, exposure, loss limits, breaker, rate, slippage, TTL, executor silence), global / per mode / per strategy / per account, the stricter wins; raising is typed on your own terminal',
    load: () => import('./autotrade-cmd/limits.ts').then((m) => m.limitsCmd),
  },
  executor: {
    usage: 'dexterm autotrade executor status [--json] | heartbeat [--name N] [--account ID] [--dry-run] [--nonce N] | kit --out DIR',
    summary: 'real mode: is YOUR executor alive (heartbeat, last receipt, lag)? A silent executor pauses new buy signals; `kit --out DIR` copies the dry-run reference executors (webhook, signal-cmd, JSONL tail)',
    load: () => import('./autotrade-cmd/executor.ts').then((m) => m.executorCmd),
  },
  report: {
    usage: 'dexterm autotrade report [--period day|week] [--strategy ID] [--json] [--telegram]',
    summary: 'the digest per strategy and mode: trades, win rate with its interval, net, drawdown, refusals, limits hit, executor health, paper vs real fills, an honest small-sample note',
    load: () => import('./autotrade-cmd/report.ts').then((m) => m.reportCmd),
  },
  extract: {
    usage: 'dexterm autotrade extract --out FILE [--db PATH] [--max-mints N] [--min-peak-liq USD] [--span-hours H]',
    summary: 'save a replay tape from your recorder history (read-only) to a file you can backtest offline',
    load: () => import('./autotrade-cmd/backtest.ts').then((m) => m.extractCmd),
  },
};

export function autotradeHelp(): string {
  return [
    'dexterm autotrade: strategies, backtests and the runner. PAPER by default; mode real sends a LIVE TRADE FIRE signal per trade to YOUR executor (`signal arm`, on your own terminal; dexterm holds no key). Not financial advice.',
    '',
    ...Object.values(SUBCOMMANDS).map((s) => `  ${s.usage}\n      ${s.summary}`),
    '',
    '  Strategies live in $DEXTERM_HOME/strategies (default ~/.dexterm/strategies), one JSON file each, with an',
    '  append-only .journal.jsonl. Presets: scalp, swing, runner, moonbag, sample-dip-ladder, yolo (HIGH RISK) (read-only; copy one with `new`).',
    '  `dexterm backtest --subject strategy --strategy <id|file>` runs the same backtest.',
  ].join('\n') + '\n';
}

/** The value of `--subject` (or `--subject=x`) in an argv, if any. */
function subjectOf(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--subject') return argv[i + 1];
    if (argv[i].startsWith('--subject=')) return argv[i].slice('--subject='.length);
  }
  return undefined;
}

/** True for `dexterm autotrade …` and `dexterm backtest --subject strategy …`. */
export function handles(argv: string[]): boolean {
  return argv[0] === 'autotrade' || (argv[0] === 'backtest' && subjectOf(argv) === 'strategy');
}

export async function autotradeCommand(argv: string[], io: AutotradeIo): Promise<number> {
  let rest: string[];
  if (argv[0] === 'backtest') {
    // `dexterm backtest --subject strategy [--strategy X] …` → `dexterm autotrade backtest [X] …`
    rest = ['backtest'];
    for (let i = 1; i < argv.length; i++) {
      if (argv[i] === '--subject') { i++; continue; }
      if (argv[i].startsWith('--subject=')) continue;
      rest.push(argv[i]);
    }
  } else rest = argv.slice(1);
  const sub = rest[0];
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') { io.stdout.write(autotradeHelp()); return 0; }
  // `run --all` has its own row (parallel strategies, task-1529) so its --help shows its own flags.
  const key = sub === 'run' && rest.includes('--all') ? 'run --all' : sub;
  const row = Object.hasOwn(SUBCOMMANDS, key) ? SUBCOMMANDS[key] : undefined;
  if (!row) { io.stderr.write(`dexterm autotrade: unknown subcommand ${JSON.stringify(sub)}\n\n${autotradeHelp()}`); return 2; }
  if (rest.includes('--help') || rest.includes('-h')) { io.stdout.write(`${row.usage}\n  ${row.summary}\n`); return 0; }
  const fn = await row.load();
  return fn(rest.slice(1), io);
}
