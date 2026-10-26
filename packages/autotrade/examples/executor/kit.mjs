// dexterm executor reference kit: the shared part (task-1654). Plain Node (22+), no dependencies, no wallet code.
//
// Every kit executor does the same five things with a LIVE TRADE FIRE signal (`dexterm-trade-fire/1`):
//   1. verify the HMAC (`t=<unix s>,v1=<hex sha256 of "<t>.<body>">`) when you gave it the secret file
//   2. check the shape, and that the signal is for YOUR account id
//   3. dedupe by nonce and id (delivery is at-least-once: a repeat is normal); the seen set survives a restart
//   4. honor the TTL: anything past `expiresAt` is ignored, never acted on late
//   5. write a receipt (`dexterm-trade-receipt/1`) to dexterm's receipts.jsonl, and a heartbeat now and then
//
// It is DRY RUN, always: `act()` below only logs what it WOULD do and the receipt says so (status "rejected",
// reason "dry-run: …"). There is no key, no wallet and no chain call in this kit. To trade for real you replace
// `act()` with your own executor's code (or hand the order to the Telegram trading bot you chose); dexterm never
// signs anything.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const SIGNAL_SCHEMA = 'dexterm-trade-fire/1';
export const RECEIPT_SCHEMA = 'dexterm-trade-receipt/1';
export const HEARTBEAT_SCHEMA = 'dexterm-executor-heartbeat/1';
export const ENVELOPE_SCHEMA = 'dexterm-trade-fire-envelope/1';
const TOLERANCE_SEC = 300;
const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** `--name value` / `--flag` argv into an object. */
export function args(argv = process.argv.slice(2)) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const v = argv[i + 1];
    if (v !== undefined && !v.startsWith('--')) { o[k] = v; i++; } else o[k] = true;
  }
  return o;
}

/** Where dexterm keeps its files (DEXTERM_HOME, else ~/.dexterm). */
export const dextermHome = (env = process.env) => env.DEXTERM_HOME || join(homedir(), '.dexterm');
export const realDir = (home) => join(home, 'autotrade', 'real');

/** The HMAC secret from a file (`dexterm autotrade signal secret generate --out FILE`), or null. */
export function readSecret(file) {
  if (!file) return null;
  const v = readFileSync(file, 'utf8').trim();
  return v || null;
}

export function verify(secret, header, body, nowMs = Date.now()) {
  const m = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(String(header ?? ''));
  if (!m) return { ok: false, why: 'signature-missing' };
  const t = Number(m[1]);
  if (Math.abs(nowMs / 1000 - t) > TOLERANCE_SEC) return { ok: false, why: 'signature-stale' };
  const want = createHmac('sha256', secret).update(`${t}.${body}`).digest();
  const got = Buffer.from(m[2], 'hex');
  return got.length === want.length && timingSafeEqual(got, want) ? { ok: true } : { ok: false, why: 'signature-bad' };
}

/** The seen nonces and ids, in a small JSON file so a restart does not act on a repeat. */
export class SeenStore {
  constructor(file) { this.file = file; this.seen = new Set(); this.maxNonce = 0; try { const d = JSON.parse(readFileSync(file, 'utf8')); for (const x of d.seen ?? []) this.seen.add(x); this.maxNonce = Number(d.maxNonce) || 0; } catch { /* first run */ } }
  has(s) { return this.seen.has(s.id) || this.seen.has(`n${s.nonce}`); }
  add(s) {
    this.seen.add(s.id); this.seen.add(`n${s.nonce}`); this.maxNonce = Math.max(this.maxNonce, s.nonce);
    const keep = [...this.seen].slice(-4000);
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ seen: keep, maxNonce: this.maxNonce }));
    renameSync(tmp, this.file);
  }
}

/**
 * Check one signal body. Returns { verdict, signal?, why }: verdict is act | duplicate | expired | rejected.
 * `secret` null = no HMAC check (only when you chose not to set one).
 */
export function check(body, o) {
  const now = o.now ?? Date.now();
  if (o.secret) { const v = verify(o.secret, o.signature, body, now); if (!v.ok) return { verdict: 'rejected', why: v.why }; }
  else if (o.requireHmac) return { verdict: 'rejected', why: 'signature-required' };
  let s;
  try { s = JSON.parse(body); } catch { return { verdict: 'rejected', why: 'not-json' }; }
  if (!s || s.schema !== SIGNAL_SCHEMA || !['trade', 'halted', 'test'].includes(s.type) || !Number.isSafeInteger(s.nonce) || typeof s.id !== 'string') return { verdict: 'rejected', why: 'shape' };
  if (s.paper !== false) return { verdict: 'rejected', why: 'paper-flag' };
  if (s.accountId !== o.accountId) return { verdict: 'rejected', why: 'wrong-account', signal: s };
  if (o.seen.has(s)) return { verdict: 'duplicate', why: 'duplicate', signal: s };
  if (!(now <= s.expiresAt)) return { verdict: 'expired', why: 'expired', signal: s };
  if (s.type === 'trade' && (!MINT.test(s.mint) || (s.side !== 'buy' && s.side !== 'sell'))) return { verdict: 'rejected', why: 'shape', signal: s };
  if (s.type === 'trade' && s.nonce <= o.seen.maxNonce) return { verdict: 'rejected', why: 'nonce-replay', signal: s };
  return { verdict: 'act', why: null, signal: s };
}

/**
 * What the executor does with a fresh signal. DRY RUN: it only says what it WOULD do. Replace this with your own
 * code to trade (your wallet, your bot); keep the rest of the pipeline (verify, dedupe, TTL, receipt) as it is.
 */
export function act(s) {
  if (s.type === 'test') return { status: 'rejected', reason: 'test signal: received, never traded' };
  if (s.type === 'halted') return { status: null, reason: `halted (${s.reason}): would cancel ${s.outstanding.length} outstanding signal(s)` };
  const what = s.side === 'buy' ? `would BUY ${s.sizeSol} SOL of ${s.symbol} (${s.mint}) with ${s.slippageBps} bps slippage` : `would SELL ${Math.round(s.sellFraction * 1000) / 10}% of ${s.symbol} (${s.mint}): ${s.exitReason}`;
  return { status: 'rejected', reason: `dry-run: ${what}`.slice(0, 120) };
}

/** Append a receipt line to dexterm's receipts.jsonl (the same file `dexterm autotrade receipt` writes). */
export function writeReceipt(home, s, r, executor, now = Date.now()) {
  const line = { schema: RECEIPT_SCHEMA, signalId: s.id, nonce: s.nonce, accountId: s.accountId, status: r.status, at: now, fill: r.fill ?? null, reason: r.reason ?? null, executor };
  mkdirSync(realDir(home), { recursive: true, mode: 0o700 });
  appendFileSync(join(realDir(home), 'receipts.jsonl'), `${JSON.stringify(line)}\n`, { mode: 0o600 });
  return line;
}

/** Append a heartbeat to dexterm's executor.jsonl: dexterm pauses new buys when it hears nothing for too long. */
export function heartbeat(home, o) {
  const hb = { schema: HEARTBEAT_SCHEMA, at: o.now ?? Date.now(), executor: o.executor, accountId: o.accountId ?? null, dryRun: true, lastNonce: o.lastNonce ?? null, note: o.note ?? null };
  mkdirSync(realDir(home), { recursive: true, mode: 0o700 });
  appendFileSync(join(realDir(home), 'executor.jsonl'), `${JSON.stringify(hb)}\n`, { mode: 0o600 });
  return hb;
}

/** The whole pipeline for one body: check, act (dry run), receipt, log line. Returns the verdict. */
export function handle(body, o) {
  const c = check(body, o);
  const s = c.signal;
  if (c.verdict === 'act') {
    o.seen.add(s);
    const r = act(s);
    if (r.status && s.type !== 'halted') writeReceipt(o.home, s, r, o.executor, o.now ?? Date.now());
    o.log(`#${s.nonce} ${s.type}${s.type === 'trade' ? ` ${s.side}` : ''}: ${r.reason}`);
  } else o.log(`${s ? `#${s.nonce} ` : ''}${c.verdict}: ${c.why}`);
  return c;
}

/** A stream line: a bare signal, or a signed envelope (`dexterm autotrade signal channels --jsonl-signed on`). */
export function unwrapLine(line) {
  try {
    const x = JSON.parse(line);
    if (x && x.schema === ENVELOPE_SCHEMA && typeof x.signal === 'string') return { body: x.signal, signature: x.signature ?? null };
  } catch { /* handled by check() */ }
  return { body: line, signature: null };
}

export const exists = existsSync;
