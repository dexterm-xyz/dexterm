#!/usr/bin/env node
// task-1645: a FAKE executor used as the `--signal-cmd` command hook in tests. It never trades: it reads one
// trade-fire signal on stdin, checks it like a well-behaved executor (signature when a secret is given, shape,
// account, TTL, dedupe across invocations by nonce), records what it saw, and answers by exit code.
//
//   node fake-executor.mjs <stateDir> <mode> [accountId] [secret]
//   mode: ack | reject | flaky:<n> (exit 1 for the first n calls, then ack)
// Exit: 0 ack, 2 rejected, 3 duplicate, 1 retry.
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { validateSignal, verifyBody } from '../../src/signal.ts';

const [stateDir, mode = 'ack', accountId = 'main', secret = ''] = process.argv.slice(2);
mkdirSync(stateDir, { recursive: true });
const statePath = join(stateDir, 'state.json');
const st = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { calls: 0, seen: [] };
st.calls++;
let body = '';
for await (const c of process.stdin) body += c;
body = body.replace(/\n$/, '');
const save = () => writeFileSync(statePath, JSON.stringify(st));
const log = (verdict) => appendFileSync(join(stateDir, 'got.jsonl'), `${JSON.stringify({ verdict, body })}\n`);

if (mode.startsWith('flaky:') && st.calls <= Number(mode.slice(6))) { save(); log('flaky'); process.exit(1); }
if (secret) {
  const v = verifyBody(secret, process.env.DEXTERM_SIGNAL_SIGNATURE, body, Date.now());
  if (!v.ok) { save(); log(v.why); process.exit(2); }
}
let sig;
try { const v = validateSignal(JSON.parse(body)); if (!v.ok) throw new Error(v.error); sig = v.signal; } catch { save(); log('invalid'); process.exit(2); }
if (sig.accountId !== accountId) { save(); log('wrong-account'); process.exit(2); }
if (st.seen.includes(sig.nonce)) { save(); log('duplicate'); process.exit(3); }
if (Date.now() > sig.expiresAt) { save(); log('expired'); process.exit(2); }
if (mode === 'reject') { save(); log('rejected'); process.exit(2); }
st.seen.push(sig.nonce);
save();
log('ack');
process.exit(0);
