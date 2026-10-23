// The Telegram side of `dexterm autotrade run --paper` (task-1527, AUTOTRADE-SPEC §8). PAPER today.
//
// When `dexterm telegram setup` stored a token and a chat is paired, the runner starts the user's own bot in the
// same process: notify (the run ledger as it is written), control (/status /pause /kill …, through the same control
// file the CLI writes) and approve-to-trade (proposals with one-tap buttons; the order then goes through the paper
// port, which wraps the runner's paper executor and spends a single-use proof per approved order). A /use switch
// takes effect when the run has closed out its positions: the host starts the next run with the new strategy.
// The PnL card of a closed trade is the app's card renderer over the position's ledger fills (USD book, priced in
// SOL with the coin's own DexScreener SOL quote at the close; no image when there is none).
// task-1571: the bot is the user's OWN bot and the port is always the paper port. dexterm holds no key and places no
// live order; an approval only ever releases a PAPER order.

import {
  PaperPort, TelegramConnector, TelegramService, loadConnectors, secretStore, type ChatConnector, type ClosedTradeView, type ExecutionPort, type Executor,
  type LedgerEvent, type ResolvedStrategy, type RunnerState, type SecretStore,
} from '@dexterm/autotrade';

/** Why a Telegram approval is refused for a strategy that is not paper (dexterm places no live order). */
export const LIVE_APPROVALS_REFUSED = 'live-approval-port-not-installed';

export interface TelegramHostOpts {
  home: string;
  exec: Executor;
  say: (s: string) => void;
  /** SOL/USD near a coin (its SOL-quoted pair), for the card; null = text only. */
  solUsdFor?: (mint: string) => Promise<number | null>;
  /** Test seams. */
  connector?: ChatConnector;
  store?: SecretStore;
  now?: () => number;
  timers?: boolean;
}

export class TelegramHost {
  readonly service: TelegramService;
  readonly port: ExecutionPort;
  private runId: string | null = null;
  private strategy: ResolvedStrategy | null = null;
  private state: RunnerState | null = null;
  private next: ResolvedStrategy | null = null;
  private readonly execRef: { exec: Executor };
  /** SOL/USD near a coin for the card, set per run (a /use switch starts a new data layer). */
  private solUsdFor: ((mint: string) => Promise<number | null>) | null;

  constructor(o: TelegramHostOpts, connector: ChatConnector, knownToken: string | null = null) {
    this.execRef = { exec: o.exec };
    this.solUsdFor = o.solUsdFor ?? null;
    const exec: Executor = { name: o.exec.name, buy: (k, usd, ctx) => this.execRef.exec.buy(k, usd, ctx), sell: (k, t, r) => this.execRef.exec.sell(k, t, r) };
    // A Telegram approval is a paper proof: every approval for a strategy that is not mode "paper" is refused here
    // (notify and /kill keep working).
    this.port = new PaperPort(exec, { now: o.now, entryBlock: () => (this.strategy && this.strategy.mode !== 'paper' ? LIVE_APPROVALS_REFUSED : null) });
    this.service = new TelegramService({
      home: o.home, connector, port: this.port, now: o.now, timers: o.timers, knownToken: () => knownToken,
      runId: () => this.runId, state: () => this.state, strategy: () => this.strategy,
      onSwitch: (s) => { this.next = s; o.say(`telegram: switch to ${s.id} v${s.version} confirmed; it starts once nothing is held`); },
      alert: (line) => o.say(`! ${line}`),
      card: (t) => (this.solUsdFor ? autotradeCardPng(t, this.solUsdFor) : Promise.resolve(null)), // the card is a paper card
    });
  }

  /** Point the host at the run that is starting (a /use switch starts a new one in the same process). */
  attach(runId: string, s: ResolvedStrategy, exec: Executor, solUsdFor?: (mint: string) => Promise<number | null>): void {
    this.runId = runId; this.strategy = s; this.state = null; this.next = null; this.execRef.exec = exec;
    if (solUsdFor) this.solUsdFor = solUsdFor;
  }

  onLedger = (e: LedgerEvent): void => this.service.onLedger(e);
  onState = (st: RunnerState): void => { this.state = st; this.service.onState(st); };

  /** The strategy a confirmed /use asked for, once (null when none). */
  takeSwitch(): ResolvedStrategy | null { const n = this.next; this.next = null; return n; }

  async stop(): Promise<void> { await this.service.stop(); }
}

export type HostStart = { ok: true; host: TelegramHost } | { ok: false; why: string; quiet: boolean };

/** Start the bot for a run when it is set up and paired; `quiet` = it is simply not set up (say nothing). */
export async function startTelegramHost(o: TelegramHostOpts): Promise<HostStart> {
  const r = loadConnectors(o.home);
  if (!r.ok) return { ok: false, why: r.error, quiet: false };
  const t = r.config.telegram;
  if (!t.enabled || !t.allow.length) return { ok: false, why: 'telegram is not set up (dexterm telegram setup)', quiet: !t.enabled && !r.exists };
  let token: string | null = null;
  let connector = o.connector;
  if (!connector) {
    const store = o.store ?? (t.secretStore ? secretStore(t.secretStore, o.home) : null);
    token = store?.get() ?? null;
    if (!token) return { ok: false, why: 'the bot token is missing from the secret store (dexterm telegram setup)', quiet: false };
    const tk = token;
    connector = new TelegramConnector({ token: () => tk, onLog: (l) => o.say(`telegram: ${l}`) });
  }
  const host = new TelegramHost(o, connector, token);
  await host.service.start();
  return { ok: true, host };
}

/** The PnL card PNG of an autotrade paper trade (pnl-card.ts over the position's fills), or null. */
export async function autotradeCardPng(t: ClosedTradeView, solUsdFor: (mint: string) => Promise<number | null>): Promise<Uint8Array | null> {
  const fills = t.fills ?? [];
  if (!fills.some((f) => f.side === 'buy')) return null;
  const solUsd = await solUsdFor(t.mint).catch(() => null);
  if (!solUsd || !(solUsd > 0)) return null;
  const card = await import('../pnl-card.ts');
  const DEC = 6;
  const input = {
    source: 'paper' as const, mint: t.mint, symbol: t.symbol, name: null, decimals: DEC,
    fills: fills.map((f) => ({ t: f.t, side: f.side, solDelta: (f.side === 'buy' ? -1 : 1) * (f.usd / solUsd), tokenDelta: BigInt(Math.round(f.tokens * 10 ** DEC)) * (f.side === 'buy' ? 1n : -1n), feeSol: null, sig: null })),
    ledger: `dexterm autotrade paper run (USD book, SOL at $${solUsd.toFixed(2)})`, wallet: null, mark: null,
    excluded: [], fees: 'modelled fee, slippage and price impact included',
  };
  try {
    const stats = card.computeCard(input, t.closedAt);
    return new Uint8Array(card.cardPng(stats, { aspect: 'wide' }));
  } catch { return null; }
}
