// `dexterm autotrade <sub>` (task-1503 AT-1, AUTOTRADE-SPEC). PAPER ONLY: no keys, no wallet, no signer.
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
    usage: 'dexterm autotrade run <id|file> --paper [--replay TAPE [--ms-per-tick 2000]] [--model M] [--max-minutes N] [--stub] [--raw] [--quiet] [--no-telegram]',
    summary: 'the paper runner: the screener hands each candidate to your own Claude (runner.json picks the account), every size clamped; ledger in autotrade/runs/; your paired Telegram bot starts with it (dexterm telegram setup)',
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
  extract: {
    usage: 'dexterm autotrade extract --out FILE [--db PATH] [--max-mints N] [--min-peak-liq USD] [--span-hours H]',
    summary: 'save a replay tape from your recorder history (read-only) to a file you can backtest offline',
    load: () => import('./autotrade-cmd/backtest.ts').then((m) => m.extractCmd),
  },
};

export function autotradeHelp(): string {
  return [
    'dexterm autotrade: strategies, backtests and the paper runner. PAPER ONLY, not financial advice.',
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
