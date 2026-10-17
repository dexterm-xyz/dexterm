import assert from 'node:assert/strict';

/** Windows thread CPU accounting is quantized (hosted samples jump by 16 ms).
 * A single thread cannot consume more CPU time than its elapsed wall time.
 * Use that conservative upper bound on Windows, not the quantized per-tick
 * counter. Never relax the wall-frame budget or the independent ratio guard. */
export function assertFrameBudget(name: string, b: { p95: number; cpuP95: number }, detail: string,
  platform: NodeJS.Platform = process.platform): void {
  const cpuBound = platform === 'win32' ? b.p95 : b.cpuP95;
  const cpuLabel = platform === 'win32' ? 'CPU upper bound (wall p95)' : 'CPU p95';
  assert.ok(cpuBound < 16, `${name} ${cpuLabel} ${cpuBound.toFixed(2)} ms (${detail}) must be under 16 ms`);
  assert.ok(b.p95 < 16, `${name} wall p95 ${b.p95.toFixed(2)} ms (${detail}) must be under 16 ms`);
}
