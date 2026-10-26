// `dexterm autotrade report …` (task-1654, 0.2.0 card E): the daily / weekly digest per strategy and mode.
//
//   report [--period day|week] [--strategy ID] [--json]   print it
//   report --telegram                                      send it to your paired chat through your own bot
//   report --schedule daily|weekly|off                     a run with the bot on sends it by itself (default off)
//
// Read-only over the run ledgers, the outbox and the receipts. The numbers are what they are: the digest always
// carries the win rate's interval and a sample-size note, never a gain claim.

import { dextermHome } from '@dexterm/custom';
import { buildDigest, digestLines, effectiveLimits, executorHealth, loadDigestState, loadLimits, readReceipts, saveDigestState, simExecutor, loadPreset, type Digest } from '@dexterm/autotrade';
import type { AutotradeIo } from '../autotrade-cmd.ts';
import { parseArgs } from './strategies.ts';
import { startTelegramHost, type TelegramHostOpts } from './telegram-host.ts';

const out = (io: AutotradeIo, s: string) => { io.stdout.write(`${s}\n`); };
const err = (io: AutotradeIo, s: string) => { io.stderr.write(`dexterm autotrade report: ${s}\n`); };

export interface ReportDeps { now?: () => number; telegram?: Pick<TelegramHostOpts, 'connector' | 'store' | 'timers'> }

export function digestFor(home: string, o: { period: 'day' | 'week'; now: number; strategyId?: string }): Digest {
  const l = loadLimits(home);
  const e = effectiveLimits(l.ok ? l.doc : null, { strategyId: '-', accountId: '-', mode: 'real' });
  const ex = l.ok ? executorHealth(home, { now: o.now, windowMin: e.values.executorSilenceMin ?? null, receipts: readReceipts(home).receipts }) : null;
  return buildDigest(home, { ...o, executor: ex && (ex.lastSeenAt || l.ok) ? ex : null });
}

/** Send lines through the user's own bot (one-shot: start, broadcast, stop). */
export async function sendDigest(home: string, lines: string[], o: { say: (s: string) => void; real: boolean; telegram?: ReportDeps['telegram'] }): Promise<{ ok: true } | { ok: false; why: string }> {
  const t = await startTelegramHost({ home, exec: simExecutor(loadPreset('scalp').execution), say: o.say, ...o.telegram });
  if (!t.ok) return { ok: false, why: t.why };
  try {
    const before = t.host.service.audit.events.length;
    await t.host.service.hub.broadcast({ kind: 'text', badge: o.real ? 'LIVE' : 'PAPER', lines }, 'report');
    if (t.host.service.audit.events.slice(before).some((e) => e.kind === 'out_failed')) return { ok: false, why: 'telegram send failed' };
    return { ok: true };
  } finally { await t.host.stop(); }
}

export async function reportCmd(argv: string[], io: AutotradeIo, deps: ReportDeps = {}): Promise<number> {
  const home = dextermHome(io.env);
  const now = deps.now ?? Date.now;
  const { pos, opts } = parseArgs(argv, ['json', 'telegram']);
  if (pos.length) { err(io, `unexpected ${pos.join(' ')}`); return 2; }
  if (opts.schedule !== undefined) {
    const v = String(opts.schedule);
    if (!['daily', 'weekly', 'off'].includes(v)) { err(io, '--schedule daily|weekly|off'); return 2; }
    const s = loadDigestState(home);
    saveDigestState(home, { ...s, schedule: v as 'daily' | 'weekly' | 'off' });
    out(io, v === 'off' ? 'scheduled digest off' : `scheduled digest: ${v} (sent by a run with your Telegram bot on${v === 'weekly' ? ', on Mondays' : ', after local midnight'})`);
    return 0;
  }
  const period = opts.period === 'week' ? 'week' : opts.period === undefined || opts.period === 'day' ? 'day' : null;
  if (!period) { err(io, '--period day|week'); return 2; }
  const strategyId = typeof opts.strategy === 'string' ? opts.strategy : undefined;
  const d = digestFor(home, { period, now: now(), strategyId });
  if (opts.json) { out(io, JSON.stringify(d, null, 2)); return 0; }
  const lines = digestLines(d);
  for (const l of lines) out(io, l);
  if (opts.telegram) {
    const r = await sendDigest(home, lines, { say: (s) => io.stderr.write(`${s}\n`), real: d.strategies.some((x) => x.mode === 'real'), telegram: deps.telegram });
    if (!r.ok) { err(io, `not sent: ${r.why}`); return 1; }
    out(io, 'sent to your paired Telegram chat');
  }
  return 0;
}
