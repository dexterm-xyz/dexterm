// Shared fixtures for the task-1527 chat tests (not a test file itself). No network: the fake transport only.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MarketTick } from '../src/replay.ts';
import type { EntryProposal, Executor, ProposalLive } from '../src/runner.ts';
import { PaperPort, badgeOf, type ExecutionPort } from '../src/execution-port.ts';
import { ApprovalBroker, CallbackStore } from '../src/chat/approvals.ts';
import { ChatAudit } from '../src/chat/audit.ts';
import { defaultTelegram, type TelegramConfig, type Tier } from '../src/chat/config.ts';
import { FakeConnector } from '../src/chat/fake.ts';
import { ChatHub } from '../src/chat/hub.ts';
import type { ControlPort } from '../src/chat/control.ts';

export const T0 = 1_792_000_000_000;
export const MINT = 'Mint1111111111111111111111111111111111111111';
export const ME = '424242';
export const tmpHome = (): string => mkdtempSync(join(tmpdir(), 'chat1527-'));

export function pairedConfig(o: { senderId?: string; chatId?: string; tiers?: Tier[]; approvals?: 'on' | 'off' } = {}): TelegramConfig {
  const t = defaultTelegram();
  t.enabled = true;
  t.allow = [{ senderId: o.senderId ?? ME, chatId: o.chatId ?? o.senderId ?? ME, tiers: o.tiers ?? ['notify', 'control', 'approve'], pairedAt: T0 }];
  t.approvals = o.approvals ?? 'off';
  return t;
}

export function tick(over: Partial<MarketTick> = {}): MarketTick {
  return {
    mint: MINT, t: T0, kind: 'live', symbol: 'TEST', launchpad: 'pump.fun', createdAt: T0 - 3 * 3600e3,
    price: 1, mcap: 1e6, mcapResolved: 1e6, mcapFlagged: false, liq: 100_000, vol5m: 10_000, vol1h: 50_000, vol24: 500_000,
    buys5m: 120, sells5m: 80, buys24: 5000, sells24: 4000, chg5m: 4, chg1h: 20, chg6h: 40, chg24h: 80,
    holders: 900, top10: 20, dev: 1, mintAuth: false, freezeAuth: false, org: 70, ...over,
  } as MarketTick;
}

export function proposal(over: Partial<EntryProposal> = {}): EntryProposal {
  return {
    runId: 'run-1', mint: MINT, symbol: 'TEST', strategy: { id: 'scalp', version: '1.0.0', hash: 'abcdef0123456789' }, profileId: 'scalp',
    usd: 20, firstTrancheUsd: 20, pctOfBook: 2, bookUsd: 1000, price: 1, liq: 100_000, impactPct: 0.04, slippageBps: 500, maxImpactPct: 3,
    exitPlan: 'scalp: take profit +20%, stop -10%', reason: 'buyers ahead', sessionId: 's1', clamps: [], decidedAt: T0, ...over,
  };
}

/** A ProposalLive whose market and book the test moves. */
export function fakeLive(o: { price?: number; liq?: number } = {}) {
  const st = { tick: tick({ price: o.price ?? 1, liq: o.liq ?? 100_000 }), blocked: null as string | null, cap: Infinity, refuse: null as string | null, reclamps: [] as number[] };
  const live: ProposalLive = {
    tick: () => st.tick,
    reclamp: (usd) => { st.reclamps.push(usd); return st.refuse ? { ok: false, refused: st.refuse } : { ok: true, usd: Math.min(usd, st.cap), clamps: usd > st.cap ? ['max-exposure'] : [] }; },
    blocked: () => st.blocked,
  };
  return { st, live };
}

export const okExec: Executor & { buys: { usd: number; proofId?: string }[] } = Object.assign(
  { name: 'test-exec', buys: [] as { usd: number; proofId?: string }[] },
  {
    buy(k: MarketTick, usd: number, ctx?: { proofId?: string }) { okExec.buys.push({ usd, proofId: ctx?.proofId }); return { t: k.t, side: 'buy' as const, usd, tokens: usd / (k.price ?? 1), price: k.price ?? 1, avgPrice: k.price ?? 1, impactPct: 0, partial: false, reason: 'entry' }; },
    sell(k: MarketTick, tokens: number, reason: string) { return { t: k.t, side: 'sell' as const, usd: tokens * (k.price ?? 1), tokens, price: k.price ?? 1, avgPrice: k.price ?? 1, impactPct: 0, partial: false, reason }; },
  },
);

export function rig(o: { config?: TelegramConfig; port?: ExecutionPort; controlPort?: ControlPort; maxOpen?: number; home?: string | null } = {}) {
  const clock = { now: T0 };
  const now = () => clock.now;
  const fake = new FakeConnector({ now });
  let cfg = o.config ?? pairedConfig();
  const config = () => cfg;
  const store = new CallbackStore(':memory:');
  const audit = new ChatAudit(o.home === undefined ? null : o.home);
  const port = o.port ?? new PaperPort(okExec, { now });
  const broker = new ApprovalBroker({ connector: fake, store, audit, port, config, now, maxOpen: o.maxOpen ?? 2, timers: false });
  const hub = new ChatHub({ connector: fake, config, audit, badge: badgeOf(port.network), broker, port: o.controlPort ?? null, now });
  const me = fake.user(ME);
  return { clock, now, fake, store, audit, port, broker, hub, me, setConfig: (c: TelegramConfig) => { cfg = c; } };
}

/** Let queued promise work (sends, edits, verification) settle. */
export const flush = async (n = 5): Promise<void> => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

/** The proposal card the fake chat shows (newest), its buttons and ref. */
export function proposalCard(fake: FakeConnector) {
  const m = fake.last(/PROPOSAL/);
  if (!m) throw new Error('no proposal card was sent');
  const btn = (label: string) => { const b = m.buttons.find((x) => x.label === label); if (!b) throw new Error(`no ${label} button`); return b.data; };
  return { m, ref: m.ref, approve: () => btn('Approve'), half: () => btn('Half size'), skip: () => btn('Skip') };
}
