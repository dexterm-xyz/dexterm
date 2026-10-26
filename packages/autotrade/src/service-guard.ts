// dexterm autotrade — the always-on service's guard aggregator (0.2.0 card B, AUTOTRADE-SPEC §7.3 / §7.4).
//
// Every 10 s (and on demand) the service folds what it can see into named guard states. Each state has ONE effect:
//   stop            the service stops the fleet (a soft stop: no new entries, sessions closed, exits keep running)
//   pause-entries   no new entries while it holds; lifts by itself (hysteresis where a value can flap)
//   notice          shown in `service status` and sent once as a notification; nothing pauses
// Open positions are never paused by any state: their exits keep running (the monitor is never paused, §7.4).
//
//   state id         effect          from
//   stop-file        stop            the service STOP marker (`service stop`, a plain `touch`)
//   panic            stop            the panic file (`dexterm wallet panic`); the fleet halts itself too
//   disk-low         pause-entries   free space under runner.json disk.minFreeGb (default 5 GB); +1 GB to lift
//   load-high        pause-entries   1-min load above load.pauseAboveLoad1m for load.sustainSec; lifts below resumeBelowLoad1m
//   busy-process     pause-entries   a runner.json load.busyProcs pattern matches a running process (not ours)
//   data-stale       pause-entries   no strategy has seen a market tick for dataStaleSec (default 300 s)
//   runner-stale     notice          the fleet's heartbeat (runner-status.json) is older than 30 s
//   allowance-high   notice          the model usage windows are above runner.json allowanceGuard (the fleet pauses sessions itself)
//   day-cap          notice          the fleet's global day caps are used up (sessions resume when the day rolls)
//   recorder-down    notice          the market recorder is installed but has written nothing for recorderStaleSec
//                                    (default 15 min); not installed → notice with `dexterm record install`
//   strategy-halted  notice          a strategy halted itself (daily loss / drawdown caps); one per strategy
//
// The guard is pure over its inputs (the service collects them); transitions come back so the caller can log one
// ledger line and send one notification per change, never one per tick.

import type { GuardStateView } from './service.ts';

export type GuardEffect = GuardStateView['effect'];

export interface GuardConfig {
  minFreeGb: number;
  pauseAboveLoad1m: number;
  resumeBelowLoad1m: number;
  sustainSec: number;
  busyProcs: string[];
  dataStaleSec: number;
  recorderStaleSec: number;
  fiveHourMax: number;
  sevenDayMax: number;
}

export const DEFAULT_GUARD_CONFIG: GuardConfig = {
  minFreeGb: 5, pauseAboveLoad1m: 25, resumeBelowLoad1m: 20, sustainSec: 120, busyProcs: [],
  dataStaleSec: 300, recorderStaleSec: 900, fiveHourMax: 0.6, sevenDayMax: 0.8,
};

/** runner.json → the guard's knobs (the stricter of the two never matters here: these only pause). */
export function guardConfigFrom(rc: { load?: { pauseAboveLoad1m: number; resumeBelowLoad1m: number; sustainSec: number; busyProcs: string[] }; disk?: { minFreeGb: number }; allowanceGuard?: { fiveHourMax: number; sevenDayMax: number } } | null, over: Partial<GuardConfig> = {}): GuardConfig {
  return {
    ...DEFAULT_GUARD_CONFIG,
    ...(rc?.load ? { pauseAboveLoad1m: rc.load.pauseAboveLoad1m, resumeBelowLoad1m: rc.load.resumeBelowLoad1m, sustainSec: rc.load.sustainSec, busyProcs: [...rc.load.busyProcs] } : {}),
    ...(rc?.disk ? { minFreeGb: rc.disk.minFreeGb } : {}),
    ...(rc?.allowanceGuard ? { fiveHourMax: rc.allowanceGuard.fiveHourMax, sevenDayMax: rc.allowanceGuard.sevenDayMax } : {}),
    ...over,
  };
}

export interface GuardInputs {
  now: number;
  stopFile: string | null;
  panic: string | null;
  /** Free space where DEXTERM_HOME lives, GB (null: unknown → no state). */
  freeGb: number | null;
  load1m: number | null;
  /** busyProcs patterns that match a running process right now. */
  busy: string[];
  /** Ms since the newest market tick any strategy saw (null: none yet). */
  dataAgeMs: number | null;
  /** Ms the fleet has been running (data-stale waits for one window after the start). */
  upMs: number;
  /** The fleet's own heartbeat age (null: not up yet). */
  runnerAgeMs: number | null;
  allowance: { fiveHour: number | null; sevenDay: number | null } | null;
  /** The fleet's global block (a used-up day cap), or null. */
  dayCap: string | null;
  recorder: { installed: boolean; newestAgeMs: number | null } | null;
  /** Strategies halted by their own caps: id → reason. */
  halted: Record<string, string>;
}

export interface GuardTransition { id: string; on: boolean; effect: GuardEffect; detail: string }

export interface GuardVerdict {
  states: GuardStateView[];
  /** The first stop state's id, or null. */
  stop: string | null;
  /** The first pause-entries state, as a reason for the fleet's pause (`guard:<id>`), or null. */
  pauseEntries: string | null;
  transitions: GuardTransition[];
}

const gb = (n: number) => `${n.toFixed(1)} GB`;

export class ServiceGuard {
  readonly cfg: GuardConfig;
  private readonly active = new Map<string, GuardStateView>();
  private loadAboveSince: number | null = null;
  private loadPaused = false;
  private diskLow = false;

  constructor(cfg: GuardConfig = DEFAULT_GUARD_CONFIG) { this.cfg = cfg; }

  evaluate(i: GuardInputs): GuardVerdict {
    const c = this.cfg;
    const want = new Map<string, { effect: GuardEffect; detail: string }>();
    const on = (id: string, effect: GuardEffect, detail: string) => { want.set(id, { effect, detail }); };

    if (i.stopFile) on('stop-file', 'stop', i.stopFile);
    if (i.panic) on('panic', 'stop', `the panic switch is engaged (${i.panic}); \`dexterm wallet resume\` lifts it`);

    if (i.freeGb !== null) {
      if (!this.diskLow && i.freeGb < c.minFreeGb) this.diskLow = true;
      else if (this.diskLow && i.freeGb >= c.minFreeGb + 1) this.diskLow = false;
      if (this.diskLow) on('disk-low', 'pause-entries', `${gb(i.freeGb)} free, under the ${gb(c.minFreeGb)} floor (runner.json disk.minFreeGb); lifts at ${gb(c.minFreeGb + 1)}`);
    }

    if (i.load1m !== null) {
      if (i.load1m > c.pauseAboveLoad1m) {
        this.loadAboveSince ??= i.now;
        if (i.now - this.loadAboveSince >= c.sustainSec * 1000) this.loadPaused = true;
      } else {
        this.loadAboveSince = null;
        if (i.load1m < c.resumeBelowLoad1m) this.loadPaused = false;
      }
      if (this.loadPaused) on('load-high', 'pause-entries', `1-min load ${i.load1m.toFixed(1)} (pauses above ${c.pauseAboveLoad1m} for ${c.sustainSec} s, resumes below ${c.resumeBelowLoad1m})`);
    }

    if (i.busy.length) on('busy-process', 'pause-entries', `a busy process is running (${i.busy.slice(0, 3).join(', ')})`);

    if (i.upMs >= c.dataStaleSec * 1000 && (i.dataAgeMs === null || i.dataAgeMs > c.dataStaleSec * 1000)) {
      on('data-stale', 'pause-entries', i.dataAgeMs === null ? `no market tick since the start (${Math.round(i.upMs / 1000)} s)` : `the newest market tick is ${Math.round(i.dataAgeMs / 1000)} s old (limit ${c.dataStaleSec} s)`);
    }

    if (i.runnerAgeMs !== null && i.runnerAgeMs > 30_000) on('runner-stale', 'notice', `the strategies' heartbeat is ${Math.round(i.runnerAgeMs / 1000)} s old`);

    const a = i.allowance;
    if (a && ((a.fiveHour ?? 0) > c.fiveHourMax || (a.sevenDay ?? 0) > c.sevenDayMax)) {
      on('allowance-high', 'notice', `model usage 5 h ${pctOf(a.fiveHour)} / 7 d ${pctOf(a.sevenDay)} (limits ${pctOf(c.fiveHourMax)} / ${pctOf(c.sevenDayMax)}): no new sessions until it falls`);
    }
    if (i.dayCap) on('day-cap', 'notice', `${i.dayCap}: no new sessions until the day rolls`);

    if (i.recorder) {
      if (!i.recorder.installed) on('recorder-down', 'notice', 'the market recorder is not installed: backtests and tuning see no new history (`dexterm record install`)');
      else if (i.recorder.newestAgeMs === null || i.recorder.newestAgeMs > c.recorderStaleSec * 1000) on('recorder-down', 'notice', `the market recorder has written nothing for ${i.recorder.newestAgeMs === null ? 'ever' : `${Math.round(i.recorder.newestAgeMs / 60_000)} min`} (\`dexterm record status\`)`);
    }

    for (const [id, why] of Object.entries(i.halted)) on(`strategy-halted:${id}`, 'notice', `strategy ${id} halted itself (${why}); its open positions keep their exits`);

    const transitions: GuardTransition[] = [];
    for (const [id, w] of want) {
      const cur = this.active.get(id);
      if (!cur) { this.active.set(id, { id, effect: w.effect, detail: w.detail, since: i.now }); transitions.push({ id, on: true, effect: w.effect, detail: w.detail }); }
      else cur.detail = w.detail;
    }
    for (const [id, cur] of [...this.active]) {
      if (want.has(id)) continue;
      this.active.delete(id);
      transitions.push({ id, on: false, effect: cur.effect, detail: cur.detail });
    }
    const states = [...this.active.values()].map((s) => ({ ...s }));
    const stop = states.find((s) => s.effect === 'stop')?.id ?? null;
    const pause = states.find((s) => s.effect === 'pause-entries')?.id ?? null;
    return { states, stop, pauseEntries: pause ? `guard:${pause}` : null, transitions };
  }
}

const pctOf = (v: number | null) => (v === null ? '?' : `${Math.round(v * 100)}%`);

/** A one-line notification text for a guard transition (plain text, no paths, no secrets). */
export function guardNoticeText(t: GuardTransition): string {
  const what = t.effect === 'stop' ? 'STOP' : t.effect === 'pause-entries' ? 'ENTRIES PAUSED' : 'NOTICE';
  return t.on ? `autotrade service · ${what} · ${t.id}: ${t.detail}` : `autotrade service · cleared · ${t.id}${t.effect === 'pause-entries' ? ': entries resume' : ''}`;
}
