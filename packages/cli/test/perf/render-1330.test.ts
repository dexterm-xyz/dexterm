// task-1330 render budget, moved to the serial perf lane by task-1410 (`npm run test:perf`, run by `npm test`
// AFTER the parallel suite, one file at a time). Under the parallel suite ~150 test processes share the CPU
// and the wall-clock p95 measured scheduler noise (~40 ms), not render cost (~3 ms alone).
//
// Two guards per screen (trending, token + social panel, KOL) at 176×48:
//  1. FRAME BUDGET — p95 wall time per tick under 16 ms (one 60 Hz frame; the product requirement).
//  2. REGRESSION GUARD — the median render time divided by the median of a fixed reference workload
//     (plain string/array work shaped like a frame build), measured interleaved frame by frame, so machine
//     speed and background load scale both sides alike. It must stay under 2× the ratio recorded below:
//     a 2× or worse render slowdown fails even though the frame would still fit the 16 ms budget.
//     Recalibrate RATIO_BASELINE (the printed `ratio` values) only after an intentional render change, and
//     say so in the handoff.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFixtureState, renderFrame, type AppState } from '../../src/state.ts';
import { socialOf } from '../../src/social/view.ts';

/** render ms ÷ reference ms, medians, on this repo at task-1410 (load-independent; see the header). */
const RATIO_BASELINE = { trending: 2.35, social: 2.85, kol: 2.05 } as const;
const REGRESSION_FACTOR = 2;
const FRAME_BUDGET_MS = 16;

const quantile = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * q))]; };

let sink = 0;
/** A fixed reference workload (~1 ms): build a 176×48 frame of styled rows and sort a few thousand numbers. */
function reference(): void {
  const rows: string[] = [];
  for (let y = 0; y < 48; y++) {
    let row = '';
    for (let x = 0; x < 176; x++) row += String.fromCharCode(33 + ((x * 7 + y * 13) % 90));
    rows.push(`\x1b[38;2;${y};${y * 2};200m` + row);
  }
  const nums = Array.from({ length: 4000 }, (_, i) => (i * 2654435761) % 10007);
  nums.sort((a, b) => a - b);
  sink += rows.join('\n').length + nums[7];
}

type Measured = { p50: number; p95: number; max: number; ratio: number; runs: number[]; ratios: number[] };

/** Three runs of 150 ticks; the frame budget uses the best run's p95, the regression guard the median run ratio. */
function measure(mk: () => AppState, n = 150): Measured {
  const state = mk();
  socialOf(state);
  renderFrame(state, 176, 48); // warm (lazy demo, memo)
  for (let i = 0; i < 20; i++) reference();
  let best: { p50: number; p95: number; max: number } | null = null;
  const runs: number[] = [];
  const ratios: number[] = [];
  for (let r = 0; r < 3; r++) {
    const times: number[] = [];
    const refs: number[] = [];
    for (let i = 0; i < n; i++) {
      state.now = new Date(state.now.getTime() + 500); // every tick moves the clock half a second (busts the 2 s memo every 4th frame)
      let t0 = performance.now();
      renderFrame(state, 176, 48);
      times.push(performance.now() - t0);
      t0 = performance.now();
      reference();
      refs.push(performance.now() - t0);
    }
    const run = { p50: quantile(times, 0.5), p95: quantile(times, 0.95), max: quantile(times, 1) };
    runs.push(run.p95);
    ratios.push(run.p50 / quantile(refs, 0.5));
    if (!best || run.p95 < best.p95) best = run;
  }
  return { ...best!, ratio: quantile(ratios, 0.5), runs, ratios };
}

test('p95 render under 16 ms per tick, and no 2× render regression, for the trending screen, the token social panel and the KOL screen at 176×48', () => {
  const measured = {
    trending: measure(() => makeFixtureState({ screen: 'trending', calm: true })),
    social: measure(() => { const s = makeFixtureState({ screen: 'token', calm: true }); s.tokenSocial = true; return s; }),
    kol: measure(() => makeFixtureState({ screen: 'kol', calm: true })),
  };
  assert.ok(sink > 0);
  for (const [name, m] of Object.entries(measured)) {
    process.stderr.write(`  render ${name}: p95 ${m.p95.toFixed(2)} ms (p50 ${m.p50.toFixed(2)}, max ${m.max.toFixed(2)}; runs ${m.runs.map((x) => x.toFixed(1)).join('/')}) · ratio ${m.ratio.toFixed(2)} (runs ${m.ratios.map((x) => x.toFixed(2)).join('/')})\n`);
  }
  for (const [name, m] of Object.entries(measured)) {
    assert.ok(m.p95 < FRAME_BUDGET_MS, `${name} p95 ${m.p95.toFixed(2)} ms (p50 ${m.p50.toFixed(2)}, max ${m.max.toFixed(2)}; runs ${m.runs.map((x) => x.toFixed(1)).join('/')}) must be under ${FRAME_BUDGET_MS} ms`);
    const limit = RATIO_BASELINE[name as keyof typeof RATIO_BASELINE] * REGRESSION_FACTOR;
    assert.ok(m.ratio < limit, `${name} render/reference ratio ${m.ratio.toFixed(2)} (runs ${m.ratios.map((x) => x.toFixed(2)).join('/')}) must be under ${limit.toFixed(2)} (${REGRESSION_FACTOR}× the recorded ${RATIO_BASELINE[name as keyof typeof RATIO_BASELINE]}): the render got slower`);
  }
  // the engine's own board recompute (memo busted every call) also fits the tick budget
  const state = makeFixtureState({ screen: 'trending', calm: true });
  const feed = socialOf(state)!;
  const times: number[] = [];
  for (let i = 0; i < 100; i++) { feed.invalidate(); const t0 = performance.now(); feed.trendRows(); times.push(performance.now() - t0); }
  process.stderr.write(`  trendRows() recompute p95 ${quantile(times, 0.95).toFixed(2)} ms\n`);
  assert.ok(quantile(times, 0.95) < FRAME_BUDGET_MS, `trendRows() recompute p95 ${quantile(times, 0.95).toFixed(2)} ms`);
});
