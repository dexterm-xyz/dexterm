// dexterm autotrade chat — the service a runner host starts (task-1527, AUTOTRADE-SPEC §8.1).
//
// One process: the runner (`dexterm autotrade run … --paper`) starts the connector when Telegram is set up and
// paired, so chat is a remote control for THIS local engine. Pieces:
//   ChatHub         inbound updates: dedupe, allowlist, rate limits, commands → ControlRouter, taps → broker
//   ApprovalBroker  proposals and confirm buttons (the runner's ApprovalHook)
//   NotifyBus       the run ledger as it is written → messages
//   HostControlPort the router's actions, through the SAME control file the CLI and the Q screen write
//                   (autotrade/control.json, by: "chat"), the runner's live state, and the strategy store
// The runner never waits on chat: the bus queues, the broker answers when a tap lands, and a dead connection means
// no entries that need an approval (UNDELIVERED = skip), never a blocked exit.

import { riskDelta } from '@dexterm/mcp';
import type { LedgerEvent } from '../ledger.ts';
import type { RunnerState } from '../runner.ts';
import type { ResolvedStrategy } from '../strategy.ts';
import { StrategyStore } from '../store.ts';
import { requestControl } from '../safety.ts';
import { healthLine } from '../executor-health.ts';
import { limitsSummary } from '../limits.ts';
import { badgeOf, type ExecutionPort } from '../execution-port.ts';
import { ApprovalBroker, CallbackStore, callbackDbPath } from './approvals.ts';
import { ChatAudit } from './audit.ts';
import { defaultTelegram, loadConnectors, saveConnectors, type TelegramConfig } from './config.ts';
import type { ChatConnector } from './connector.ts';
import type { ControlPort, PositionView, Result, StatusView, StrategyChoice } from './control.ts';
import { ChatHub } from './hub.ts';
import { NotifyBus, type ClosedTradeView } from './notify.ts';

/** connectors.json re-read when it changes (a local `dexterm telegram approvals off` lands without a restart). */
export class ConfigView {
  private cached: TelegramConfig | null = null;
  private at = 0;
  private readonly home: string;
  private readonly now: () => number;
  constructor(home: string, now: () => number = Date.now, initial?: TelegramConfig) { this.home = home; this.now = now; this.cached = initial ?? null; }
  get = (): TelegramConfig => {
    if (!this.cached || this.now() - this.at > 2000) {
      const r = loadConnectors(this.home);
      // A config that turns unreadable mid-run keeps the last good one for reads but takes away every tier.
      this.cached = r.ok ? r.config.telegram : { ...(this.cached ?? defaultTelegram()), tiers: [] };
      this.at = this.now();
    }
    return this.cached;
  };
  /** The one chat-side write: approvals off → on. */
  approvalsOn(): boolean {
    const r = loadConnectors(this.home);
    if (!r.ok) return false;
    if (r.config.telegram.approvals !== 'on') { r.config.telegram.approvals = 'on'; saveConnectors(this.home, r.config); }
    this.cached = null;
    return true;
  }
}

export interface HostPortDeps {
  home: string;
  runId: () => string | null;
  state: () => RunnerState | null;
  strategy: () => ResolvedStrategy | null;
  config: ConfigView;
  broker: () => ApprovalBroker | null;
  /** A confirmed /use: the host switches once nothing is held (it stops entries now). */
  onSwitch: (s: ResolvedStrategy) => void;
  store?: StrategyStore;
}

/** The router's actions for an in-process runner. Every write is the control file, as the CLI writes it. */
export class HostControlPort implements ControlPort {
  private readonly d: HostPortDeps;
  constructor(d: HostPortDeps) { this.d = d; }

  private store(): StrategyStore { return this.d.store ?? new StrategyStore({ home: this.d.home }); }

  status(): StatusView | null {
    const st = this.d.state(); const runId = this.d.runId();
    if (!st || !runId) return null;
    const start = st.book.equityUsd - st.book.realizedTodayUsd;
    const s = this.d.strategy();
    const cfg = this.d.config.get();
    return {
      runId, state: st.state, haltReason: st.haltReason, strategy: st.strategy, open: st.positions.length, candidates: st.candidates.length,
      dayPnlPct: start > 0 ? (st.book.realizedTodayUsd / start) * 100 : null, spend: { todayUsd: st.spend.todayUsd, dayCapUsd: st.spend.dayCapUsd }, allowance: st.spend.allowance,
      approvals: s?.entry.decide === 'agent+approve' ? 'required by the strategy' : cfg.approvals,
      ...(st.real?.executor ? { real: { executor: healthLine(st.real.executor), limits: limitsSummary(st.real.limits ?? {}), pause: st.real.risk?.buyPause ?? null } } : {}),
    };
  }

  positions(): PositionView[] {
    return (this.d.state()?.positions ?? []).map((p) => ({ mint: p.mint, symbol: p.symbol, profile: p.profile, pnlPct: p.pnlPct, freeBag: !!p.freeBag, next: p.next }));
  }

  private control(action: 'stop' | 'flatten' | 'pause' | 'resume-entries'): Result {
    const runId = this.d.runId();
    if (!runId) return { ok: false, message: 'No runner is running on your computer.' };
    const w = requestControl(this.d.home, runId, action, 'chat');
    if (!w.ok) return { ok: false, message: `Refused: ${w.why}.` };
    return { ok: true, message: w.already ? 'Already requested.' : '' };
  }

  pause(): Result {
    const r = this.control('pause');
    return r.ok ? { ok: true, message: 'Paused: no new entries. Open positions keep their exits. /resume lifts it.' } : r;
  }

  resume(): Result {
    const st = this.d.state();
    if (!st) return { ok: false, message: 'No runner is running on your computer.' };
    // Only a pause lifts from chat. A kill, a stop, the panic switch, a breaker halt or a guard stays local.
    if (st.state !== 'paused' || st.haltReason !== 'paused') {
      return { ok: false, message: st.state === 'running' ? 'Not paused.' : `Refused from chat: the runner is ${st.state}${st.haltReason ? ` (${st.haltReason})` : ''}. That clears only on your computer.` };
    }
    const r = this.control('resume-entries');
    return r.ok ? { ok: true, message: 'Resumed: new entries allowed again.' } : r;
  }

  kill(): Result {
    const r = this.control('stop');
    return r.ok ? { ok: true, message: `${r.message || 'Stopped'}: no new entries, sessions closed, pending orders dropped. Open positions keep their exits; the run ends when nothing is held. Starting again is local.` } : r;
  }

  flatten(): Result {
    const r = this.control('flatten');
    return r.ok ? { ok: true, message: 'Flatten requested: every position sells at its next tick, then the run ends.' } : r;
  }

  strategies(): StrategyChoice[] {
    const cur = this.d.strategy();
    const st = this.store();
    const out: StrategyChoice[] = [];
    for (const e of st.list()) {
      if (!e.ok || !e.hash || !e.version) continue;
      const g = st.get(e.id);
      if (!g || !g.ok) continue;
      const s = g.strategy;
      let allowed = false; let why = 'no strategy is running';
      if (cur) {
        if (s.hash === cur.hash) { allowed = false; why = 'running'; }
        else if (s.mode !== cur.mode) why = 'changes paper/live';
        else {
          const d = riskDelta(cur, s);
          const looser = d.reasons.filter((r) => r.dir === 'looser');
          allowed = looser.length === 0;
          why = allowed ? (d.delta === 'tighter' ? 'tighter' : 'equal') : `looser: ${looser.slice(0, 2).map((r) => r.path).join(', ')}`;
        }
      }
      out.push({ id: e.id, version: s.version, hash: s.hash, preset: e.source === 'preset', current: !!cur && cur.hash === s.hash, allowed, why });
    }
    return out;
  }

  use(id: string): Result {
    const choice = this.strategies().find((x) => x.id === id);
    if (!choice || !choice.allowed) return { ok: false, message: `Refused: ${id} is not an equal-or-tighter validated strategy now.` };
    const g = this.store().get(id);
    if (!g || !g.ok || g.strategy.hash !== choice.hash) return { ok: false, message: 'Refused: that strategy changed since it was listed.' };
    const r = this.control('stop');
    if (!r.ok) return r;
    this.d.onSwitch(g.strategy);
    return { ok: true, message: `Switching to ${id}: no new entries now; it starts once the open positions have closed.` };
  }

  approvalsOn(): Result {
    return this.d.config.approvalsOn() ? { ok: true, message: 'Approvals on: every new entry now waits for your tap. Turning them off is local only.' } : { ok: false, message: 'Could not write the setting.' };
  }

  sell(mint: string): Result {
    const held = (this.d.state()?.positions ?? []).some((p) => p.mint === mint);
    if (!held) return { ok: false, message: 'Not held any more.' };
    const b = this.d.broker();
    if (!b) return { ok: false, message: 'Not available.' };
    b.queueExit(mint, 'a chat button');
    return { ok: true, message: 'Sell queued: it goes at the next tick.' };
  }
}

/** What each confirm button runs once its tap is verified (the same actions as the commands, nothing more). */
export function wireConfirms(broker: ApprovalBroker, port: ControlPort): void {
  broker.onConfirm('flatten', () => port.flatten().message);
  broker.onConfirm('use', (r) => port.use(String(r.payload.id)).message);
  broker.onConfirm('sell', (r) => port.sell(String(r.payload.mint)).message);
}

export interface TelegramServiceOpts {
  home: string;
  connector: ChatConnector;
  port: ExecutionPort;
  config?: ConfigView;
  audit?: ChatAudit;
  store?: CallbackStore;
  now?: () => number;
  card?: (t: ClosedTradeView) => Promise<Uint8Array | null>;
  alert?: (line: string) => void;
  /** The bot token, so every audit line is redacted against the exact token (URL-encoded and partial forms too). */
  knownToken?: () => string | null;
  maxOpen?: number;
  runId: () => string | null;
  state: () => RunnerState | null;
  strategy: () => ResolvedStrategy | null;
  onSwitch?: (s: ResolvedStrategy) => void;
  /** Timers on (default). Tests drive tick() and sweep() themselves. */
  timers?: boolean;
  retryDelaysMs?: number[];
}

export class TelegramService {
  readonly hub: ChatHub;
  readonly broker: ApprovalBroker;
  readonly bus: NotifyBus;
  readonly audit: ChatAudit;
  readonly config: ConfigView;
  readonly port: HostControlPort;
  private readonly o: TelegramServiceOpts;
  private readonly now: () => number;
  private readonly ac = new AbortController();
  private polling: Promise<void> | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private readonly store: CallbackStore;

  constructor(o: TelegramServiceOpts) {
    this.o = o;
    this.now = o.now ?? Date.now;
    this.config = o.config ?? new ConfigView(o.home, this.now);
    this.audit = o.audit ?? new ChatAudit(o.home, { knownToken: o.knownToken });
    this.store = o.store ?? new CallbackStore(callbackDbPath(o.home));
    const cfg = this.config.get;
    this.broker = new ApprovalBroker({ connector: o.connector, store: this.store, audit: this.audit, port: o.port, config: cfg, now: this.now, maxOpen: o.maxOpen, timers: o.timers, alert: o.alert });
    this.port = new HostControlPort({ home: o.home, runId: o.runId, state: o.state, strategy: o.strategy, config: this.config, broker: () => this.broker, onSwitch: o.onSwitch ?? (() => {}) });
    this.hub = new ChatHub({ connector: o.connector, config: cfg, audit: this.audit, badge: badgeOf(o.port.network), broker: this.broker, port: this.port, now: this.now, alert: o.alert });
    const delays = o.retryDelaysMs ?? [1000, 4000];
    this.bus = new NotifyBus({
      badge: badgeOf(o.port.network), config: cfg, now: this.now, card: o.card, approvalCounts: (since) => this.store.countsSince(since),
      send: async (msg, x) => {
        for (let i = 0; ; i++) {
          const failedBefore = this.audit.events.length;
          await this.hub.broadcast(msg, x.template);
          const failed = this.audit.events.slice(failedBefore).some((e) => e.kind === 'out_failed');
          if (!failed || i >= delays.length) return;
          await new Promise((r) => setTimeout(r, delays[i]));
        }
      },
    });
    wireConfirms(this.broker, this.port);
  }

  /** Expire leftovers, start polling and the notify ticker. Resolves once started (polling runs in the background). */
  async start(): Promise<void> {
    const n = await this.broker.expireLeftovers();
    this.audit.add(this.now(), 'connector_start', { transport: this.o.connector.transport, expiredLeftovers: n, network: this.o.port.network });
    this.polling = this.o.connector.start(this.ac.signal).catch((e: unknown) => { this.audit.add(this.now(), 'connector_error', { error: e instanceof Error ? e.message.slice(0, 160) : String(e) }); });
    if (this.o.timers !== false) {
      this.ticker = setInterval(() => { void this.tick(); }, 5000);
      this.ticker.unref?.();
    }
  }

  private conflictAlerted = false;

  async tick(): Promise<void> {
    const h = this.o.connector.health();
    if (h.conflict && !this.conflictAlerted) {
      this.conflictAlerted = true;
      this.audit.add(this.now(), 'connector_conflict', { why: h.conflict });
      this.o.alert?.(`telegram: ${h.conflict}. Approvals are stopped; local controls keep working. Revoke the token with BotFather (/revoke) and run \`dexterm telegram setup\` again.`);
      this.broker.cancelAll('connector-conflict');
    }
    await this.broker.sweep();
    await this.bus.tick();
  }

  /** The run ledger tap: every event, as it is written. */
  onLedger = (e: LedgerEvent): void => {
    this.bus.onEvent(e);
    if (e.kind === 'fill' && typeof e.proposalId === 'string') this.broker.filled(e.proposalId);
  };

  onState = (st: RunnerState): void => { this.bus.onState(st); };

  async stop(): Promise<void> {
    this.broker.cancelAll('connector-stopped');
    if (this.ticker) clearInterval(this.ticker);
    await this.bus.flush();
    await this.hub.idle();
    this.ac.abort();
    await this.polling;
    this.broker.close();
    this.audit.add(this.now(), 'connector_stop', { transport: this.o.connector.transport });
    this.store.close();
  }
}
