#!/usr/bin/env node
// dexterm executor reference kit: the --signal-cmd hook (task-1654). DRY RUN: logs what it would do; no wallet code.
//
// dexterm runs it once per signal, with no shell, the signal line on stdin and the HMAC in DEXTERM_SIGNAL_SIGNATURE
// (when a secret is set). Wire it with an absolute path:
//   dexterm autotrade signal channels --signal-cmd '["/usr/local/bin/node","/path/to/signal-cmd-executor.mjs","--account","main","--secret-file","/path/to/secret"]'
//
// Exit codes dexterm reads: 0 acted (dry run) · 3 duplicate (counted delivered) · 2 rejected or expired (never
// retried) · anything else is retried. A line per signal goes to --log (default autotrade/real/kit-cmd.log).

import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SeenStore, args, dextermHome, handle, heartbeat, readSecret, realDir } from './kit.mjs';

const a = args();
if (!a.account) { console.error('usage: signal-cmd-executor.mjs --account ID [--secret-file FILE] [--home DIR]'); process.exit(2); }
const home = a.home || dextermHome();
const logFile = a.log || join(realDir(home), 'kit-cmd.log');
const log = (s) => { try { appendFileSync(logFile, `[${new Date().toISOString()}] ${s}\n`); } catch { /* the exit code still answers */ } };
const name = String(a.name || 'kit-signal-cmd').slice(0, 32);
const body = readFileSync(0, 'utf8').trim();
const seen = new SeenStore(a.state || join(realDir(home), 'kit-cmd-seen.json'));
const c = handle(body, { accountId: a.account, secret: readSecret(a['secret-file']), requireHmac: !!a['require-hmac'], signature: process.env.DEXTERM_SIGNAL_SIGNATURE ?? null, seen, home, executor: name, log, now: Date.now() });
try { heartbeat(home, { executor: name, accountId: a.account, lastNonce: seen.maxNonce || null }); } catch { /* optional */ }
process.exit(c.verdict === 'act' ? 0 : c.verdict === 'duplicate' ? 3 : 2);
