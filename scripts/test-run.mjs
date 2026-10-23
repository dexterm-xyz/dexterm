#!/usr/bin/env node
// task-1480: `npm test` driver. It runs the unchanged pre-task-1480 chain (typecheck, the parallel suite, the
// serial lane, the perf lane, stop at the first failure) under the machine-wide test lock at nice 15
// (scripts/test-lock.mjs) and caps the parallel suite at 3 test files at once instead of node's default cores-1,
// by adding --test-concurrency=N to the chain's `node --test` call.
// task-1574: the chain lives here, not as a single-quoted package.json argument, and runs in the platform shell
// (cmd.exe on Windows, /bin/sh elsewhere), so `npm test` works on the Windows CI leg as it did before task-1480.
//
//   node scripts/test-run.mjs                 # what `npm test` runs (CHAIN below)
//   node scripts/test-run.mjs '<chain>'       # another chain containing `node --test `
//   DEXTERM_TEST_CONCURRENCY=1 npm test       # override the parallel-suite fan-out
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireTestLock, lowerPriority } from './test-lock.mjs';

const CHAIN = 'npm run typecheck && node --test "packages/*/test/*.test.ts" && npm run test:serial && npm run test:perf';
const chain = process.argv[2] ?? CHAIN;
if (!chain || !chain.includes('node --test ')) {
  console.error(`usage: node scripts/test-run.mjs '<command chain containing node --test>'`);
  process.exit(2);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const concurrency = Math.max(1, Math.floor(Number(process.env.DEXTERM_TEST_CONCURRENCY)) || 3);
const command = chain.replaceAll('node --test ', `node --test --test-concurrency=${concurrency} `);

lowerPriority();
await acquireTestLock('npm test');
console.log(`npm test (task-1480): nice 15, lock held, parallel suite --test-concurrency=${concurrency}`);
const r = spawnSync(command, { cwd: root, stdio: 'inherit', env: process.env, shell: true });
process.exit(r.status ?? 1);
