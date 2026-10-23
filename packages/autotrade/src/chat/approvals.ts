// dexterm autotrade chat — approve-to-trade (task-1527, AUTOTRADE-SPEC §8.4 tier 3, §8.5). PAPER today.
//
// The runner's clamped entry becomes a PROPOSAL: a card with [Approve] [Half size] [Skip]. ONLY a button callback
// can approve; free text never reaches this file. Each callback is bound to a one-time nonce (128 bits, only its
// hash is stored until it is consumed), the proposal hash (sha256 of the canonical order fields + price + liquidity
// + expiry + network), the local-clock expiry, the paired sender and the private chat. The same store binds the
// command confirms ([Yes, flatten], [Yes, switch]) and the [Sell] buttons of /positions.
//
//  proposed ──sent──▶ OPEN ──[Approve]/[Half]──▶ VERIFYING ──checks pass──▶ APPROVED ──fill──▶ FILLED
//     │ send failed    │ [Skip] ▶ SKIPPED          │ price moved > tol / liq −10 % / impact > cap
//     ▼                │ expiry ▶ EXPIRED          ├──▶ REPRICED: new numbers, hash, nonce, expiry ▶ OPEN (once)
//  UNDELIVERED         │                           └──▶ REFUSED (re-clamp or the port's caps say no)
//  (= skip)            └ kill / pause / halt ▶ CANCELLED            every terminal state: buttons removed
//
// Verification of a tap, in order; any failure is refused, audited and answered with a toast:
//   1. the update came from this connector's own poll (the transport has no inbound endpoint), and the connector
//      reports no conflict (a webhook or a second poller on the token stops every approval);
//   2. the sender is paired with the `approve` tier, the chat is private and is the proposal's chat;
//   3. the record is OPEN, now < expiresAt on the LOCAL clock, and the nonce matches: it is consumed in one SQLite
//      UPDATE … WHERE state = 'OPEN' AND nonce_hash = ?, so a double tap, a second device or a redelivered update
//      gets "already handled";
//   4. the action is A, H or S (Half only ever halves);
//   5. re-quote: price moved more than the tolerance, liquidity fell more than 10 %, or impact over the cap →
//      REPRICED once with fresh numbers, a fresh nonce and a fresh expiry; a second move → EXPIRED;
//   6. re-clamp against the book as it is now (the size can shrink, or the entry is refused);
//   7. the execution port's confirm for exactly this order, with `remote-button` evidence; its single-use proof
//      rides with the order to the executor. A live port checks its own caps there, whatever this file passed.
//
// Restarts expire every open record (never resurrected). Exits never wait on any of this.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ApprovalHook, ApprovalOutcome, EntryProposal, ProposalLive } from '../runner.ts';
import type { ResolvedStrategy } from '../strategy.ts';
import { canonical } from '../strategy.ts';
import { badgeOf, orderHash, type Badge, type ExecutionPort, type PortOrder, type RemoteButtonEvidence } from '../execution-port.ts';
import type { ChatAudit } from './audit.ts';
import type { ChatConnector, InboundAction, OutMessage, SentRef } from './connector.ts';
import { allowed, type TelegramConfig } from './config.ts';
import { inert, price, shortMint, usdShort } from './format.ts';

export type CallbackKind = 'proposal' | 'flatten' | 'use' | 'sell';
export type RecordState = 'OPEN' | 'VERIFYING' | 'APPROVED' | 'FILLED' | 'SKIPPED' | 'EXPIRED' | 'REPRICED' | 'REFUSED' | 'CANCELLED' | 'UNDELIVERED' | 'CONFIRMED' | 'DECLINED';
const TERMINAL: readonly RecordState[] = ['FILLED', 'SKIPPED', 'EXPIRED', 'REFUSED', 'CANCELLED', 'UNDELIVERED', 'CONFIRMED', 'DECLINED'];

export interface CallbackRecord {
  id: string;
  kind: CallbackKind;
  hash: string;
  chatId: string;
  senderId: string;
  network: string;
  createdAt: number;
  expiresAt: number;
  state: RecordState;
  repriced: number;
  messageId: string | null;
  payload: Record<string, unknown>;
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

// ───────────────────────────── the store (SQLite) ─────────────────────────────

/** $DEXTERM_HOME/autotrade/chat/callbacks.db, or ':memory:' for tests. */
export const callbackDbPath = (home: string): string => join(home, 'autotrade', 'chat', 'callbacks.db');

export class CallbackStore {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 2000;
      CREATE TABLE IF NOT EXISTS callbacks (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, hash TEXT NOT NULL, nonce_hash TEXT, chat_id TEXT NOT NULL, sender_id TEXT NOT NULL,
        network TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, state TEXT NOT NULL, repriced INTEGER NOT NULL DEFAULT 0,
        message_id TEXT, payload TEXT NOT NULL, updated_at INTEGER NOT NULL)`);
  }

  insert(r: CallbackRecord, nonceHash: string, now: number): void {
    this.db.prepare('INSERT INTO callbacks (id, kind, hash, nonce_hash, chat_id, sender_id, network, created_at, expires_at, state, repriced, message_id, payload, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(r.id, r.kind, r.hash, nonceHash, r.chatId, r.senderId, r.network, r.createdAt, r.expiresAt, r.state, r.repriced, r.messageId, JSON.stringify(r.payload), now);
  }

  get(id: string): (CallbackRecord & { nonceHash: string | null }) | null {
    const row = this.db.prepare('SELECT * FROM callbacks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id), kind: row.kind as CallbackKind, hash: String(row.hash), nonceHash: row.nonce_hash === null ? null : String(row.nonce_hash), chatId: String(row.chat_id), senderId: String(row.sender_id),
      network: String(row.network), createdAt: Number(row.created_at), expiresAt: Number(row.expires_at), state: row.state as RecordState, repriced: Number(row.repriced),
      messageId: row.message_id === null ? null : String(row.message_id), payload: JSON.parse(String(row.payload)) as Record<string, unknown>,
    };
  }

  /** Consume the nonce: OPEN → VERIFYING only if it is still OPEN and the nonce matches. True for exactly one caller. */
  consume(id: string, nonceHash: string, now: number): boolean {
    const r = this.db.prepare("UPDATE callbacks SET state = 'VERIFYING', nonce_hash = NULL, updated_at = ? WHERE id = ? AND state = 'OPEN' AND nonce_hash = ? AND expires_at > ?").run(now, id, nonceHash, now);
    return Number(r.changes) === 1;
  }

  setState(id: string, state: RecordState, now: number, from?: RecordState[]): boolean {
    const r = from?.length
      ? this.db.prepare(`UPDATE callbacks SET state = ?, nonce_hash = CASE WHEN ? THEN NULL ELSE nonce_hash END, updated_at = ? WHERE id = ? AND state IN (${from.map(() => '?').join(',')})`).run(state, TERMINAL.includes(state) ? 1 : 0, now, id, ...from)
      : this.db.prepare('UPDATE callbacks SET state = ?, nonce_hash = CASE WHEN ? THEN NULL ELSE nonce_hash END, updated_at = ? WHERE id = ?').run(state, TERMINAL.includes(state) ? 1 : 0, now, id);
    return Number(r.changes) === 1;
  }

  /** A REPRICED record goes back to OPEN once, with new numbers, hash, nonce and expiry. */
  reopen(id: string, hash: string, nonceHash: string, expiresAt: number, payload: Record<string, unknown>, now: number): boolean {
    const r = this.db.prepare("UPDATE callbacks SET state = 'OPEN', hash = ?, nonce_hash = ?, expires_at = ?, payload = ?, repriced = repriced + 1, updated_at = ? WHERE id = ? AND state = 'REPRICED' AND repriced = 0").run(hash, nonceHash, expiresAt, JSON.stringify(payload), now, id);
    return Number(r.changes) === 1;
  }

  setMessage(id: string, messageId: string): void { this.db.prepare('UPDATE callbacks SET message_id = ? WHERE id = ?').run(messageId, id); }

  open(): CallbackRecord[] {
    return (this.db.prepare("SELECT id FROM callbacks WHERE state IN ('OPEN', 'VERIFYING', 'REPRICED', 'APPROVED')").all() as { id: string }[]).map((x) => this.get(x.id)!).filter(Boolean);
  }

  /** States by count for today (the daily summary's approval line). */
  countsSince(t: number): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.db.prepare("SELECT state, COUNT(*) AS n FROM callbacks WHERE kind = 'proposal' AND created_at >= ? GROUP BY state").all(t) as { state: string; n: number }[]) out[r.state] = Number(r.n);
    return out;
  }

  close(): void { try { this.db.close(); } catch { /* closed */ } }
}

// ───────────────────────────── callback data ─────────────────────────────

/** `p:<id8>:<nonce22>:<A|H|S>` (36 bytes) and `c:<id8>:<nonce22>:<Y|N>`: well under Telegram's 64-byte limit. */
export function encodeCallback(kind: 'p' | 'c', id: string, nonce: string, action: string): string { return `${kind}:${id}:${nonce}:${action}`; }

export function decodeCallback(data: string): { kind: 'p' | 'c'; id: string; nonce: string; action: string } | null {
  const m = /^([pc]):([A-Za-z0-9_-]{8}):([A-Za-z0-9_-]{22}):([A-Z])$/.exec(data);
  return m ? { kind: m[1] as 'p' | 'c', id: m[2], nonce: m[3], action: m[4] } : null;
}

const newId = (): string => randomBytes(6).toString('base64url');
const newNonce = (): string => randomBytes(16).toString('base64url');
const nonceHashOf = (nonce: string): string => sha(`dexterm-chat-nonce:${nonce}`);

/** The proposal hash (§8.5): sha256 of the canonical order + the numbers it was shown with. Full 64 hex: the live
 *  signer's remote evidence requires it. It never rides in callback_data (that carries id + nonce only). */
export function proposalHash(f: { mint: string; side: 'buy'; usd: number; slippageBps: number; maxImpactPct: number; strategyHash: string; profileId: string; priceAtProposal: number | null; liqAtProposal: number | null; expiresAt: number; network: string }): string {
  return sha(canonical(f));
}

// ───────────────────────────── the broker ─────────────────────────────

export interface BrokerOpts {
  connector: ChatConnector;
  store: CallbackStore;
  audit: ChatAudit;
  port: ExecutionPort;
  config: () => TelegramConfig;
  /** Turn approvals on from chat (persisted by the host). */
  approvalsOn?: () => boolean;
  now?: () => number;
  /** Most proposals open at once (the strategy's maxSessions). */
  maxOpen?: number;
  /** Override the configured expiry (tests). */
  expiryMs?: number;
  /** Timers (tests drive sweep() themselves). */
  timers?: boolean;
  /** Called for local alerts (not chat). */
  alert?: (line: string) => void;
}

interface Waiter { resolve: (o: ApprovalOutcome) => void; proposal: EntryProposal; live: ProposalLive; strategy: { maxSlipPct: number } }

/** What a confirm callback (flatten, use, sell) runs once verified. */
export type ConfirmHandler = (rec: CallbackRecord, a: InboundAction) => Promise<string> | string;

const LIQ_DROP_PCT = 10;

export class ApprovalBroker implements ApprovalHook {
  private readonly o: BrokerOpts;
  private readonly now: () => number;
  private readonly waiters = new Map<string, Waiter>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly confirmHandlers = new Map<CallbackKind, ConfirmHandler>();
  private skippedOverCap = 0;

  constructor(o: BrokerOpts) {
    this.o = o;
    this.now = o.now ?? Date.now;
  }

  get badge(): Badge { return badgeOf(this.o.port.network); }
  get overCapSkips(): number { return this.skippedOverCap; }

  /** At start: every record left open by a previous process is expired (never resurrected). */
  async expireLeftovers(): Promise<number> {
    const left = this.o.store.open();
    for (const r of left) {
      this.o.store.setState(r.id, 'EXPIRED', this.now());
      this.o.audit.add(this.now(), 'callback_state', { id: r.id, kind: r.kind, hash: r.hash, state: 'EXPIRED', why: 'restart' });
      if (r.messageId) await this.editQuiet({ chatId: r.chatId, messageId: r.messageId }, { kind: 'text', badge: this.badge, lines: [`${r.kind === 'proposal' ? 'PROPOSAL' : 'CONFIRM'} #${r.id} expired: dexterm restarted.`] });
    }
    return left.length;
  }

  onConfirm(kind: CallbackKind, h: ConfirmHandler): void { this.confirmHandlers.set(kind, h); }

  required(s: ResolvedStrategy): boolean { return s.entry.decide === 'agent+approve' || this.o.config().approvals === 'on'; }

  private expiryMs(): number { return this.o.expiryMs ?? this.o.config().approvalExpirySec * 1000; }

  /** The paired private chat(s) that may approve. */
  private approvers(): { senderId: string; chatId: string }[] {
    const t = this.o.config();
    return t.allow.filter((a) => a.tiers.includes('approve') && t.tiers.includes('approve') && a.chatId === a.senderId).map((a) => ({ senderId: a.senderId, chatId: a.chatId }));
  }

  private conflict(): string | null { return this.o.connector.health().conflict; }

  // ── proposals ──

  async request(p: EntryProposal, live: ProposalLive): Promise<ApprovalOutcome> {
    const now = this.now();
    const openNow = [...this.waiters.keys()].length;
    if (openNow >= (this.o.maxOpen ?? 2)) { this.skippedOverCap++; this.o.audit.add(now, 'proposal_skipped', { mint: p.mint, why: 'max-open-proposals', open: openNow }); return { approved: false, state: 'SKIPPED', why: 'too many proposals open at once' }; }
    const conflict = this.conflict();
    if (conflict) { this.o.audit.add(now, 'proposal_skipped', { mint: p.mint, why: 'connector-conflict' }); return { approved: false, state: 'UNDELIVERED', why: `approvals are stopped: ${conflict}` }; }
    const to = this.approvers()[0];
    if (!to) return { approved: false, state: 'UNDELIVERED', why: 'no paired private chat with the approve tier' };
    const id = newId();
    const nonce = newNonce();
    const expiresAt = now + this.expiryMs();
    const payload = this.payloadOf(p, p.usd, p.price, p.liq, p.impactPct, expiresAt);
    const hash = proposalHash(this.hashFields(payload));
    const rec: CallbackRecord = { id, kind: 'proposal', hash, chatId: to.chatId, senderId: to.senderId, network: this.o.port.network, createdAt: now, expiresAt, state: 'OPEN', repriced: 0, messageId: null, payload };
    this.o.store.insert(rec, nonceHashOf(nonce), now);
    this.o.audit.add(now, 'callback_state', { id, kind: 'proposal', hash, nonceHash: nonceHashOf(nonce).slice(0, 16), state: 'OPEN', mint: p.mint, usd: p.usd, expiresAt });
    const out = new Promise<ApprovalOutcome>((resolve) => { this.waiters.set(id, { resolve, proposal: p, live, strategy: { maxSlipPct: p.slippageBps / 100 } }); });
    try {
      const ref = await this.o.connector.send({ chatId: to.chatId }, this.card(id, nonce, payload, 0));
      this.o.store.setMessage(id, ref.messageId);
      this.o.audit.add(this.now(), 'out', { template: 'proposal', id, messageId: ref.messageId, chatId: to.chatId });
      this.arm(id, expiresAt);
    } catch (e) {
      this.finish(id, 'UNDELIVERED', `the proposal could not be sent (${(e as Error).message.slice(0, 80)})`, null);
    }
    return out;
  }

  private payloadOf(p: EntryProposal, usd: number, px: number | null, liq: number | null, impactPct: number, expiresAt: number): Record<string, unknown> {
    return {
      mint: p.mint, symbol: p.symbol, strategyId: p.strategy.id, strategyVersion: p.strategy.version, strategyHash: p.strategy.hash, profileId: p.profileId,
      usd, firstTrancheUsd: p.usd > 0 ? (p.firstTrancheUsd * usd) / p.usd : 0, pctOfBook: p.bookUsd > 0 ? Math.round((usd / p.bookUsd) * 1000) / 10 : 0,
      price: px, liq, impactPct, slippageBps: p.slippageBps, maxImpactPct: p.maxImpactPct, exitPlan: p.exitPlan, reason: p.reason, runId: p.runId, expiresAt, clamps: p.clamps,
    };
  }

  private hashFields(x: Record<string, unknown>) {
    return { mint: String(x.mint), side: 'buy' as const, usd: Number(x.usd), slippageBps: Number(x.slippageBps), maxImpactPct: Number(x.maxImpactPct), strategyHash: String(x.strategyHash), profileId: String(x.profileId), priceAtProposal: (x.price as number | null) ?? null, liqAtProposal: (x.liq as number | null) ?? null, expiresAt: Number(x.expiresAt), network: this.o.port.network };
  }

  /** The proposal card. Every number is engine state; the symbol and the reason are inert quoted data. */
  card(id: string, nonce: string, x: Record<string, unknown>, repriced: number): OutMessage {
    const secs = Math.max(0, Math.round((Number(x.expiresAt) - this.now()) / 1000));
    const lines = [
      `${repriced ? 'PROPOSAL (re-quoted, confirm again)' : 'PROPOSAL'} · ${inert(x.strategyId, 32)} v${inert(x.strategyVersion, 12)} (${String(x.strategyHash).slice(0, 8)})`,
      `token "${inert(x.symbol, 20)}" ${shortMint(String(x.mint))}`,
      `buy ${usdShort(Number(x.usd))} (${x.pctOfBook}% of book) @ ${price(x.price as number | null)} · liq ${usdShort(x.liq as number | null)} · impact ~${Number(x.impactPct).toFixed(2)}%`,
      `plan: ${inert(x.exitPlan, 120)}`,
      `why (the agent's words, unverified): "${inert(x.reason, 300, 'agent')}"`,
      `expires in ${secs} s · #${id}`,
      'Only these buttons approve. Replies are ignored.',
    ];
    return {
      kind: 'proposal', badge: this.badge, lines, expiresAt: Number(x.expiresAt),
      buttons: [{ label: 'Approve', data: encodeCallback('p', id, nonce, 'A') }, { label: 'Half size', data: encodeCallback('p', id, nonce, 'H') }, { label: 'Skip', data: encodeCallback('p', id, nonce, 'S') }],
    };
  }

  private arm(id: string, expiresAt: number): void {
    if (this.o.timers === false) return;
    const old = this.timers.get(id);
    if (old) clearTimeout(old);
    const t = setTimeout(() => { void this.sweep(); }, Math.max(0, expiresAt - this.now()) + 50);
    t.unref?.();
    this.timers.set(id, t);
  }

  /** Expire every record past its expiry (the timers call it; tests call it with a moved clock). */
  async sweep(): Promise<void> {
    const now = this.now();
    for (const r of this.o.store.open()) {
      if (r.state === 'OPEN' && now >= r.expiresAt) {
        if (r.kind === 'proposal') await this.finish(r.id, 'EXPIRED', 'no answer before the expiry (expired means skip)', null);
        else await this.finishConfirm(r, 'EXPIRED', 'expired');
      }
    }
  }

  /** Terminal state for a proposal: store, audit, edit the card (buttons removed), resolve the runner's request. */
  private async finish(id: string, state: RecordState, why: string, approved: { usd: number; proofId: string; orderHash: string; via: string } | null): Promise<void> {
    const t = this.timers.get(id);
    if (t) { clearTimeout(t); this.timers.delete(id); }
    const rec = this.o.store.get(id);
    if (!rec) return;
    // APPROVED was set by the tap (from VERIFYING); every other end state wins only over a live state, once.
    if (!approved && !this.o.store.setState(id, state, this.now(), ['OPEN', 'VERIFYING', 'REPRICED'])) return;
    this.o.audit.add(this.now(), 'callback_state', { id, kind: 'proposal', hash: rec.hash, state, why, ...(approved ? { usd: approved.usd, proofId: `${approved.proofId.slice(0, 6)}…` } : {}) });
    const w = this.waiters.get(id);
    this.waiters.delete(id);
    const sym = inert(rec.payload.symbol, 20);
    const line = approved ? `APPROVED "${sym}" ${usdShort(approved.usd)} · the order goes to the ${this.o.port.network} executor · #${id}` : `${state} "${sym}" · ${why} · #${id}`;
    if (rec.messageId) await this.editQuiet({ chatId: rec.chatId, messageId: rec.messageId }, { kind: 'text', badge: this.badge, lines: [line] });
    if (w) w.resolve(approved ? { approved: true, proposalId: id, usd: approved.usd, proofId: approved.proofId, orderHash: approved.orderHash, via: approved.via } : { approved: false, proposalId: id, state, why });
  }

  private async editQuiet(ref: SentRef, msg: OutMessage): Promise<void> {
    try { await this.o.connector.edit(ref, msg); } catch (e) { this.o.audit.add(this.now(), 'edit_failed', { messageId: ref.messageId, error: (e as Error).message.slice(0, 120) }); }
  }

  /** The runner filled an approved order (from the run ledger's fill event). */
  filled(proposalId: string): void {
    if (this.o.store.setState(proposalId, 'FILLED', this.now(), ['APPROVED'])) this.o.audit.add(this.now(), 'callback_state', { id: proposalId, kind: 'proposal', state: 'FILLED' });
  }

  cancelAll(reason: string): void {
    for (const id of [...this.waiters.keys()]) void this.finish(id, 'CANCELLED', `cancelled: ${reason}`, null);
    // A strategy switch waiting for its confirm is cancelled too; a flatten or a sell confirm (both safer) is not.
    for (const r of this.o.store.open()) if (r.kind === 'use' && r.state === 'OPEN') void this.finishConfirm(r, 'CANCELLED', `cancelled: ${reason}`);
  }

  // ── confirms (flatten, use, sell) ──

  /** A confirm card bound like a proposal. `payload` must be engine data only. */
  async confirm(kind: Exclude<CallbackKind, 'proposal'>, to: { senderId: string; chatId: string }, lines: string[], yes: string, payload: Record<string, unknown>, ttlMs = 60_000): Promise<string | null> {
    const now = this.now();
    const id = newId();
    const nonce = newNonce();
    const expiresAt = now + ttlMs;
    const hash = sha(canonical({ kind, ...payload, expiresAt })).slice(0, 32);
    this.o.store.insert({ id, kind, hash, chatId: to.chatId, senderId: to.senderId, network: this.o.port.network, createdAt: now, expiresAt, state: 'OPEN', repriced: 0, messageId: null, payload }, nonceHashOf(nonce), now);
    this.o.audit.add(now, 'callback_state', { id, kind, hash, nonceHash: nonceHashOf(nonce).slice(0, 16), state: 'OPEN', expiresAt });
    try {
      const ref = await this.o.connector.send({ chatId: to.chatId }, { kind: 'proposal', badge: this.badge, lines: [...lines, `expires in ${Math.round(ttlMs / 1000)} s · #${id}`], expiresAt, buttons: [{ label: yes, data: encodeCallback('c', id, nonce, 'Y') }, { label: 'No', data: encodeCallback('c', id, nonce, 'N') }] });
      this.o.store.setMessage(id, ref.messageId);
      this.arm(id, expiresAt);
      return id;
    } catch {
      this.o.store.setState(id, 'UNDELIVERED', this.now());
      return null;
    }
  }

  private async finishConfirm(r: CallbackRecord, state: RecordState, line: string): Promise<void> {
    const t = this.timers.get(r.id);
    if (t) { clearTimeout(t); this.timers.delete(r.id); }
    if (!this.o.store.setState(r.id, state, this.now(), ['OPEN', 'VERIFYING'])) return;
    this.o.audit.add(this.now(), 'callback_state', { id: r.id, kind: r.kind, hash: r.hash, state, why: line.slice(0, 160) });
    if (r.messageId) await this.editQuiet({ chatId: r.chatId, messageId: r.messageId }, { kind: 'text', badge: this.badge, lines: [`${line} · #${r.id}`] });
  }

  // ── a tap ──

  /** Verify and act on one button callback. Returns the toast (also sent with ackAction). */
  async handleAction(a: InboundAction): Promise<string> {
    const now = this.now();
    const toast = async (s: string, result: string, extra: Record<string, unknown> = {}) => {
      this.o.audit.add(this.now(), 'verify', { updateId: a.updateId, senderId: a.senderId, chatId: a.chatId, result, ...extra });
      await this.o.connector.ackAction(a, s);
      return s;
    };
    const cb = decodeCallback(a.data);
    if (!cb) return toast('Not a dexterm button.', 'refused:malformed');
    const rec = this.o.store.get(cb.id);
    if (!rec) return toast('Unknown or old button.', 'refused:unknown-id', { id: cb.id });
    const ctx = { id: rec.id, kind: rec.kind };
    // 1. own poll (by construction) and no conflict on the token.
    const conflict = this.conflict();
    if (conflict) return toast('Approvals are stopped on this bot (a token conflict). Use dexterm locally.', 'refused:connector-conflict', ctx);
    // 2. sender, tier, private chat, the record's chat.
    const tier = rec.kind === 'proposal' ? 'approve' : 'control';
    if (a.chatKind !== 'private') return toast('Buttons work only in your private chat with the bot.', 'refused:group-chat', ctx);
    if (!allowed(this.o.config(), a.senderId, a.chatId, tier)) return toast('This account is not paired for that.', 'refused:sender-not-allowed', ctx);
    if (a.chatId !== rec.chatId || a.senderId !== rec.senderId || (rec.messageId !== null && a.ref.messageId !== rec.messageId)) return toast('This button belongs to another chat or message.', 'refused:wrong-chat-or-message', ctx);
    // 3. state, local-clock expiry, nonce (consumed once).
    if (TERMINAL.includes(rec.state) || rec.state === 'APPROVED') return toast('Already handled.', `refused:state-${rec.state}`, ctx);
    if (rec.state !== 'OPEN') return toast('Already being handled.', `refused:state-${rec.state}`, ctx);
    if (now >= rec.expiresAt) {
      if (rec.kind === 'proposal') await this.finish(rec.id, 'EXPIRED', 'the tap arrived after the expiry', null); else await this.finishConfirm(rec, 'EXPIRED', 'expired');
      return toast('Expired: nothing happened.', 'refused:expired', ctx);
    }
    const nh = nonceHashOf(cb.nonce);
    if (!rec.nonceHash || !safeEq(nh, rec.nonceHash)) return toast('Old or forged button: nothing happened.', 'refused:nonce', ctx);
    // 4. the action.
    const okActions = rec.kind === 'proposal' ? ['A', 'H', 'S'] : ['Y', 'N'];
    if ((rec.kind === 'proposal') !== (cb.kind === 'p') || !okActions.includes(cb.action)) return toast('Not a valid choice.', 'refused:action', ctx);
    if (!this.o.store.consume(rec.id, nh, now)) return toast('Already handled.', 'refused:nonce-consumed', ctx);
    this.o.audit.add(this.now(), 'verify', { updateId: a.updateId, senderId: a.senderId, chatId: a.chatId, result: 'nonce-consumed', ...ctx, action: cb.action });
    if (rec.kind !== 'proposal') return this.runConfirm(rec, cb.action, a, toast);
    return this.runProposal(rec, cb.action as 'A' | 'H' | 'S', a, toast);
  }

  private async runConfirm(rec: CallbackRecord, action: string, a: InboundAction, toast: (s: string, r: string, x?: Record<string, unknown>) => Promise<string>): Promise<string> {
    if (action === 'N') { await this.finishConfirm(rec, 'DECLINED', 'cancelled, nothing changed'); return toast('Nothing changed.', 'declined', { id: rec.id }); }
    const h = this.confirmHandlers.get(rec.kind);
    if (!h) { await this.finishConfirm(rec, 'REFUSED', 'not available here'); return toast('Not available.', 'refused:no-handler', { id: rec.id }); }
    let msg: string;
    try { msg = await h(rec, a); } catch (e) { msg = `refused: ${(e as Error).message.slice(0, 120)}`; }
    await this.finishConfirm(rec, 'CONFIRMED', msg);
    return toast(msg.slice(0, 180), 'confirmed', { id: rec.id, kind: rec.kind });
  }

  private async runProposal(rec: CallbackRecord, action: 'A' | 'H' | 'S', a: InboundAction, toast: (s: string, r: string, x?: Record<string, unknown>) => Promise<string>): Promise<string> {
    const w = this.waiters.get(rec.id);
    const ctx = { id: rec.id, action };
    if (!w) { await this.finish(rec.id, 'EXPIRED', 'the runner is no longer waiting for it', null); return toast('Expired: nothing happened.', 'refused:no-waiter', ctx); }
    if (action === 'S') { await this.finish(rec.id, 'SKIPPED', 'skipped by tap', null); return toast('Skipped.', 'skipped', ctx); }
    const blocked = w.live.blocked();
    if (blocked) { await this.finish(rec.id, 'CANCELLED', `entries are stopped (${blocked})`, null); return toast('Entries are stopped: nothing happened.', 'refused:blocked', { ...ctx, blocked }); }
    const shownUsd = Number(rec.payload.usd);
    const wantUsd = action === 'H' ? shownUsd / 2 : shownUsd;
    // 5. re-quote.
    const k = w.live.tick();
    const p0 = rec.payload.price as number | null;
    const l0 = rec.payload.liq as number | null;
    const tol = Math.min(this.o.config().repriceTolPct, w.strategy.maxSlipPct > 0 ? w.strategy.maxSlipPct : this.o.config().repriceTolPct);
    const R = (k?.liq ?? 0) / 2;
    const firstUsd = Number(rec.payload.firstTrancheUsd) * (wantUsd / (shownUsd || 1));
    const impactNow = R > 0 ? (firstUsd / R) * 100 : Infinity;
    const movedPct = k?.price && p0 ? Math.abs(k.price / p0 - 1) * 100 : Infinity;
    const liqDropPct = k?.liq && l0 ? (1 - k.liq / l0) * 100 : Infinity;
    const moved = !(movedPct <= tol) || !(liqDropPct <= LIQ_DROP_PCT) || impactNow > Number(rec.payload.maxImpactPct);
    this.o.audit.add(this.now(), 'verify', { updateId: a.updateId, result: moved ? 'requote-moved' : 'requote-ok', id: rec.id, priceAtProposal: p0, priceNow: k?.price ?? null, movedPct: Number.isFinite(movedPct) ? Math.round(movedPct * 100) / 100 : null, liqDropPct: Number.isFinite(liqDropPct) ? Math.round(liqDropPct * 10) / 10 : null, impactPct: Number.isFinite(impactNow) ? Math.round(impactNow * 100) / 100 : null, tolPct: tol });
    if (moved) {
      if (rec.repriced >= 1 || !k?.price) { await this.finish(rec.id, 'EXPIRED', 'the price moved again after a re-quote (expired means skip)', null); return toast('The price moved again: skipped.', 'expired:second-move', ctx); }
      // REPRICED: fresh numbers, a fresh nonce, a fresh expiry, the same buttons; confirm once more.
      this.o.store.setState(rec.id, 'REPRICED', this.now(), ['VERIFYING']);
      const expiresAt = this.now() + this.expiryMs();
      const re = this.payloadOf(w.proposal, shownUsd, k.price, k.liq ?? null, R > 0 ? Math.round((Number(rec.payload.firstTrancheUsd) / R) * 1e4) / 100 : 0, expiresAt);
      const hash = proposalHash(this.hashFields(re));
      const nonce = newNonce();
      this.o.store.reopen(rec.id, hash, nonceHashOf(nonce), expiresAt, re, this.now());
      this.o.audit.add(this.now(), 'callback_state', { id: rec.id, kind: 'proposal', hash, nonceHash: nonceHashOf(nonce).slice(0, 16), state: 'OPEN', repriced: 1, why: `moved ${Number.isFinite(movedPct) ? movedPct.toFixed(2) : '?'}% (tolerance ${tol}%)` });
      if (rec.messageId) await this.editQuiet({ chatId: rec.chatId, messageId: rec.messageId }, this.card(rec.id, nonce, re, 1));
      this.arm(rec.id, expiresAt);
      return toast('The price moved: check the new numbers and tap again.', 'repriced', ctx);
    }
    // 6. re-clamp against the book as it is now.
    const rc = w.live.reclamp(wantUsd);
    if (!rc.ok) { await this.finish(rec.id, 'REFUSED', `the strategy's limits refuse it now (${rc.refused})`, null); return toast('Refused by your limits: nothing happened.', 'refused:reclamp', { ...ctx, refused: rc.refused }); }
    const usd = Math.min(rc.usd, wantUsd);
    // 7. the port's confirm (its own caps), with remote-button evidence.
    const order: PortOrder = {
      mint: String(rec.payload.mint), side: 'buy', usd, slippageBps: Number(rec.payload.slippageBps), maxImpactPct: Number(rec.payload.maxImpactPct),
      strategyId: String(rec.payload.strategyId), strategyVersion: String(rec.payload.strategyVersion), strategyHash: String(rec.payload.strategyHash), profileId: String(rec.payload.profileId),
      runId: (rec.payload.runId as string | null) ?? null, network: this.o.port.network,
    };
    const ev: RemoteButtonEvidence = { tier: 'remote-button', transport: a.transport, proposalId: rec.id, proposalHash: rec.hash, senderId: a.senderId, chatId: a.chatId, updateId: a.updateId, at: this.now() };
    const proof = await this.o.port.confirmRemote(order, ev);
    this.o.audit.add(this.now(), 'verify', { updateId: a.updateId, result: proof.ok ? 'port-confirmed' : `port-refused:${proof.refused}`, id: rec.id, usd, clamps: rc.clamps, port: this.o.port.name, proofId: proof.ok ? `${proof.proofId.slice(0, 6)}…` : null });
    if (!proof.ok) { await this.finish(rec.id, 'REFUSED', `the ${this.o.port.network} executor refused it (${proof.refused})`, null); return toast('Refused by the executor: nothing happened.', 'refused:port', { ...ctx, refused: proof.refused }); }
    if (!this.o.store.setState(rec.id, 'APPROVED', this.now(), ['VERIFYING'])) return toast('Cancelled while it was being checked: nothing happened.', 'refused:cancelled-mid-check', ctx);
    await this.finish(rec.id, 'APPROVED', 'approved', { usd, proofId: proof.proofId, orderHash: orderHash(order), via: `${a.transport} button (${action === 'H' ? 'half size' : 'approve'})` });
    return toast(action === 'H' ? `Approved at half size (${usdShort(usd)}).` : `Approved (${usdShort(usd)}).`, 'approved', { ...ctx, usd });
  }

  // ── chat sells (/positions [Sell]) ──

  private readonly exits = new Map<string, { id: string; via: string }>();

  /** A confirmed [Sell]: the runner takes it at the coin's next tick. */
  queueExit(mint: string, via: string): string {
    const id = newId();
    this.exits.set(mint, { id, via });
    this.o.audit.add(this.now(), 'exit_queued', { id, mint, via });
    return id;
  }

  takeExit(mint: string): { id: string; via: string } | null {
    const x = this.exits.get(mint) ?? null;
    if (x) this.exits.delete(mint);
    return x;
  }

  exitResult(id: string, result: string): void { this.o.audit.add(this.now(), 'exit_result', { id, result }); }

  /** Stop every timer (end of the host). */
  close(): void { for (const t of this.timers.values()) clearTimeout(t); this.timers.clear(); }
}

function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
