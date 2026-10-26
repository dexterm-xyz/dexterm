// `dexterm autotrade executor …` (task-1654, 0.2.0 card E): is YOUR executor alive?
//
//   status     the last heartbeat, the last receipt, the receipt lag, and whether a real run would pause new buys now
//   heartbeat  append one heartbeat (for executors that prefer to shell out; the kit appends or POSTs its own)
//   kit        copy the executor reference kit (webhook / signal-cmd / JSONL tail, all dry run) to a folder of yours
//
// A heartbeat is data: it can only keep new buy signals from pausing. It cannot raise a limit, lift the kill switch,
// reset the breaker or confirm a position (receipts do that, and only as data).

import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dextermHome } from '@dexterm/custom';
import { Outbox, appendHeartbeat, effectiveLimits, executorHealth, healthLine, heartbeatPath, loadLimits, readReceipts, ACCOUNT_ID_RE } from '@dexterm/autotrade';
import type { AutotradeIo } from '../autotrade-cmd.ts';
import { parseArgs } from './strategies.ts';

/** The kit inside the app (shipped in the npm package too: build-dist copies examples/). */
export const KIT_DIR = fileURLToPath(new URL('../../../autotrade/examples/executor/', import.meta.url));

const out = (io: AutotradeIo, s: string) => { io.stdout.write(`${s}\n`); };
const err = (io: AutotradeIo, s: string) => { io.stderr.write(`dexterm autotrade executor: ${s}\n`); };

export async function executorCmd(argv: string[], io: AutotradeIo, deps: { now?: () => number } = {}): Promise<number> {
  const home = dextermHome(io.env);
  const now = deps.now ?? Date.now;
  const { pos, opts } = parseArgs(argv.slice(1), ['json', 'dry-run']);
  switch (argv[0]) {
    case undefined: case 'help':
      out(io, 'dexterm autotrade executor status [--json] | heartbeat [--name N] [--account ID] [--dry-run] [--nonce N] [--note TEXT] | kit --out DIR');
      return 0;
    case 'kit': {
      if (typeof opts.out !== 'string') { err(io, 'kit --out DIR (a new or empty folder)'); return 2; }
      const dir = resolve(opts.out);
      if (existsSync(dir) && readdirSync(dir).length) { err(io, `${dir} is not empty`); return 1; }
      mkdirSync(dir, { recursive: true });
      const files = readdirSync(KIT_DIR).filter((f) => /\.(mjs|md)$/.test(f));
      for (const f of files) copyFileSync(join(KIT_DIR, f), join(dir, f));
      out(io, `executor reference kit (DRY RUN: it logs what it would do; no wallet code) copied to ${dir}: ${files.join(', ')}`);
      out(io, `  start one:  node ${join(dir, 'webhook-executor.mjs')} --account main`);
      out(io, '  wire it:    dexterm autotrade signal channels --webhook http://127.0.0.1:8787/signal');
      out(io, '  prove it:   dexterm autotrade signal test   (then dexterm autotrade executor status)');
      return 0;
    }
    case 'status': {
      const l = loadLimits(home);
      const e = effectiveLimits(l.ok ? l.doc : null, { strategyId: '-', accountId: '-', mode: 'real' });
      const ob = Outbox.open(home, { channels: [], noLock: true });
      const h = executorHealth(home, { now: now(), windowMin: e.values.executorSilenceMin ?? null, signal: (n) => ob.get(n), receipts: readReceipts(home).receipts });
      if (opts.json) { out(io, JSON.stringify(h, null, 2)); return 0; }
      out(io, `executor  ${healthLine(h)}`);
      out(io, `  heartbeats: ${heartbeatPath(home)} (append, POST to the run's listener, or dexterm autotrade executor heartbeat)`);
      if (h.alive === false) out(io, '  a real run would PAUSE new buy signals now (exits still go out); start your executor, then dexterm autotrade signal test');
      return 0;
    }
    case 'heartbeat': {
      if (pos.length) { err(io, `unexpected ${pos.join(' ')}`); return 2; }
      const accountId = typeof opts.account === 'string' ? opts.account : null;
      if (accountId && !ACCOUNT_ID_RE.test(accountId)) { err(io, '--account: lowercase letters, digits, - and _'); return 2; }
      const nonce = opts.nonce === undefined ? null : Number(opts.nonce);
      try {
        const hb = appendHeartbeat(home, { at: now(), executor: typeof opts.name === 'string' ? opts.name : 'cli', accountId, dryRun: opts['dry-run'] === true ? true : null, lastNonce: nonce, note: typeof opts.note === 'string' ? opts.note : null });
        if (opts.json) out(io, JSON.stringify(hb)); else out(io, `heartbeat from ${hb.executor} recorded`);
        return 0;
      } catch (e) { err(io, (e as Error).message); return 2; }
    }
    default: err(io, `unknown subcommand ${JSON.stringify(argv[0])}`); return 2;
  }
}
