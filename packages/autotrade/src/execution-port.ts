// dexterm autotrade — the execution port (task-1527, AUTOTRADE-SPEC §8.1, §8.5 step 7). PAPER today.
//
// Where an approved entry goes. The runner's Executor (sim book, paper desk) is the paper side; a live port (the
// local signer with its caps, a later card) is the other side, behind the same three calls:
//
//   entryBlock()      why no entry can go through right now (null = ready). A live port says "live is off", "the
//                     wallet is locked", "the kill switch is engaged", "no caps file" here.
//   confirmRemote()   a chat button approved this exact order. The port cannot check the chat itself (it holds no
//                     bot token), so it gets the connector's evidence {proposalHash, senderId, chatId, updateId} and
//                     answers with a SINGLE-USE proof bound to the order's hash, or a refusal. A live port checks its
//                     own caps here (per trade at the remote-button tier, its remote daily cap, the allowed
//                     strategies, slippage and impact) and refuses anything outside them, whatever the broker said.
//   buy() / sell()    the Executor calls; an approved buy carries its proof in ctx and a port that issued proofs
//                     refuses a buy whose proof is missing, spent, expired or bound to another order (the proof is
//                     bound to the order's hash and the proposal id, and needs a 64-hex proposal hash).
//
// The port has no `badge` field: the runner's Executor may carry its own optional order-line badge (DEVNET/LIVE, the
// live signer's executor), and PAPER must never print there. Chat derives its badge from `network` (badgeOf).
//
// The paper port issues its proofs locally (there is nothing to sign). The live stub refuses everything: it exists
// so the approval path, the runner and the docs can name the live side before it is installed, and so a
// misconfiguration fails closed. Nothing in this file holds a key, signs, or touches the network.

import { createHash, randomBytes } from 'node:crypto';
import type { Fill } from './engine.ts';
import type { MarketTick } from './replay.ts';
import type { Executor, OrderContext } from './runner.ts';
import { canonical } from './strategy.ts';

export type PortNetwork = 'paper' | 'devnet' | 'mainnet';
/** The label every message, card and screen leads with. Mainnet is LIVE. */
export type Badge = 'PAPER' | 'DEVNET' | 'LIVE';
export const badgeOf = (n: PortNetwork): Badge => (n === 'paper' ? 'PAPER' : n === 'devnet' ? 'DEVNET' : 'LIVE');

/** One entry order, exactly as a proposal showed it (the proposal hash covers these fields). */
export interface PortOrder {
  mint: string;
  side: 'buy';
  usd: number;
  slippageBps: number;
  maxImpactPct: number;
  strategyId: string;
  strategyVersion: string;
  /** Named strategyHash, not hash: canonical() drops `hash` keys, and this one must be covered. */
  strategyHash: string;
  profileId: string;
  runId: string | null;
  network: PortNetwork;
}

/** What a chat approval carries to the port (the `remote-button` confirm tier, AUTOTRADE-SPEC §8.5). */
export interface RemoteButtonEvidence {
  tier: 'remote-button';
  transport: string;
  proposalId: string;
  proposalHash: string;
  senderId: string;
  chatId: string;
  updateId: string;
  /** Local clock of the verification. */
  at: number;
}

export type RemoteConfirm = { ok: true; proofId: string; expiresAt: number } | { ok: false; refused: string };

export interface ExecutionPort extends Executor {
  readonly network: PortNetwork;
  /** Why an entry cannot go through right now, or null. */
  entryBlock(): string | null;
  /** A single-use proof for exactly this order, or a refusal (the port's own caps decide; the chat cannot widen them). */
  confirmRemote(order: PortOrder, ev: RemoteButtonEvidence): Promise<RemoteConfirm>;
}

/** sha256 (hex, 32 chars) of the canonical order: the proof binds to it (the runner hands it back in OrderContext). */
export const orderHash = (o: PortOrder): string => createHash('sha256').update(canonical(o)).digest('hex').slice(0, 32);

export const PROOF_TTL_MS = 30_000;

interface Proof { orderHash: string; proposalId: string; usd: number; mint: string; expiresAt: number }

const PROPOSAL_HASH = /^[0-9a-f]{64}$/;

/**
 * The paper side: the runner's Executor behind the port calls. confirmRemote issues a local single-use proof
 * (PROOF_TTL_MS) for the order; a buy that carries a proofId must match it (order hash, proposal id, mint, size
 * at most the approved one) and spends it. A buy
 * without one is an ordinary runner entry (no approval was required) and goes straight to the executor.
 */
export class PaperPort implements ExecutionPort {
  readonly network = 'paper' as const;
  readonly name: string;
  private readonly exec: Executor;
  private readonly proofs = new Map<string, Proof>();
  private readonly now: () => number;
  private readonly block: () => string | null;

  constructor(exec: Executor, o: { now?: () => number; entryBlock?: () => string | null } = {}) {
    this.exec = exec;
    this.name = `paper-port(${exec.name})`;
    this.now = o.now ?? Date.now;
    this.block = o.entryBlock ?? (() => null);
  }

  entryBlock(): string | null { return this.block(); }

  async confirmRemote(order: PortOrder, ev: RemoteButtonEvidence): Promise<RemoteConfirm> {
    if (order.network !== 'paper') return { ok: false, refused: 'port-network-mismatch' };
    if (ev.tier !== 'remote-button') return { ok: false, refused: 'tier-unknown' };
    if (!PROPOSAL_HASH.test(ev.proposalHash) || !ev.proposalId) return { ok: false, refused: 'evidence-malformed' };
    const b = this.entryBlock();
    if (b) return { ok: false, refused: b };
    if (!(order.usd > 0)) return { ok: false, refused: 'size-not-positive' };
    const proofId = randomBytes(12).toString('base64url');
    const expiresAt = this.now() + PROOF_TTL_MS;
    this.proofs.set(proofId, { orderHash: orderHash(order), proposalId: ev.proposalId, usd: order.usd, mint: order.mint, expiresAt });
    return { ok: true, proofId, expiresAt };
  }

  async buy(k: MarketTick, usd: number, ctx?: OrderContext): Promise<Fill | { refused: string }> {
    if (ctx?.proofId !== undefined) {
      const p = this.proofs.get(ctx.proofId);
      this.proofs.delete(ctx.proofId); // single use, whatever happens next
      if (!p) return { refused: 'proof-unknown-or-spent' };
      if (this.now() > p.expiresAt) return { refused: 'proof-expired' };
      if (ctx.orderHash !== p.orderHash || ctx.proposalId !== p.proposalId || p.mint !== k.mint || usd > p.usd + 1e-9) return { refused: 'proof-order-mismatch' };
    }
    return this.exec.buy(k, usd, ctx);
  }

  sell(k: MarketTick, tokens: number, reason: string): Fill | { refused: string } | Promise<Fill | { refused: string }> {
    return this.exec.sell(k, tokens, reason);
  }
}

/**
 * The live side before it is installed: every call refuses. A runner or a broker that is handed this port takes no
 * entry and says why; exits that would need it are refused too (a live position cannot exist without a live port).
 */
export class LivePortStub implements ExecutionPort {
  readonly network: PortNetwork;
  readonly name = 'live-port-stub';
  static readonly REASON = 'live-port-not-installed';
  constructor(network: Exclude<PortNetwork, 'paper'> = 'devnet') { this.network = network; }
  entryBlock(): string | null { return LivePortStub.REASON; }
  async confirmRemote(): Promise<RemoteConfirm> { return { ok: false, refused: LivePortStub.REASON }; }
  buy(): { refused: string } { return { refused: LivePortStub.REASON }; }
  sell(): { refused: string } { return { refused: LivePortStub.REASON }; }
}
