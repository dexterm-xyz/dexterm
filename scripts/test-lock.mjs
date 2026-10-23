// task-1480: machine-wide lock + low priority for dexterm test runs.
//
// On 2026-10-19 three or four lanes each ran `npm test` at once (one node per test file, default concurrency
// cores-1, plus the pty serial lane and a 60 s perf lane) and load reached 274 on a 12-core box
// (docs/MACHINE_LOAD_INCIDENT_2026-10-20.md). Every worktree's test run now:
//   - takes one lock shared by ALL worktrees, so two full suites never overlap (a waiting run prints one line
//     every 30 s and gives up after DEXTERM_TEST_LOCK_WAIT_S, default 3600; 0 = fail at once);
//   - lowers its own priority to nice 15 (children inherit it), never raising an already lower priority.
// A stale lock (owner pid gone) is taken over. Children of the lock owner (npm test -> test:serial) see
// DEXTERM_TEST_LOCK_OWNER and do not lock again. What the tests assert is unchanged.
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { getPriority, setPriority, tmpdir } from 'node:os';
import { join } from 'node:path';

// POSIX: /tmp, shared by every worktree and user session. Windows has no /tmp (`D:\tmp` does not exist on a runner),
// so the lock lives in the OS temp dir there (task-1574).
export const LOCK_DIR = process.env.DEXTERM_TEST_LOCK || (process.platform === 'win32' ? join(tmpdir(), 'dexterm-test-suite.lock') : '/tmp/dexterm-test-suite.lock');
export const NICE = 15;

export function lowerPriority(nice = NICE) {
  try {
    if (getPriority() < nice) setPriority(nice);
  } catch {
    /* not permitted: run at the current priority */
  }
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function readOwner(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'owner.json'), 'utf8'));
  } catch {
    return null;
  }
}

// One attempt: true = we own the lock now; otherwise the live owner record.
export function tryLock(dir = LOCK_DIR, info = {}) {
  try {
    mkdirSync(dir);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const owner = readOwner(dir);
    // owner.json is written right after mkdir; a missing one younger than a few seconds is a racing owner
    if (owner ? pidAlive(owner.pid) : !staleEmptyLock(dir)) return owner || { pid: null, cwd: '(starting)' };
    rmSync(dir, { recursive: true, force: true });
    return tryLock(dir, info);
  }
  writeFileSync(join(dir, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), cwd: process.cwd(), ...info }));
  return true;
}

function staleEmptyLock(dir) {
  try {
    return Date.now() - statSync(dir).mtimeMs > 10000;
  } catch {
    return true;
  }
}

export function releaseLock(dir = LOCK_DIR) {
  if (readOwner(dir)?.pid === process.pid) rmSync(dir, { recursive: true, force: true });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wait for the lock (or skip when our parent already holds it). Returns a release function.
export async function acquireTestLock(label, { dir = LOCK_DIR, waitS = Number(process.env.DEXTERM_TEST_LOCK_WAIT_S ?? 3600), pollMs = 5000, log = console.log } = {}) {
  const parent = Number(process.env.DEXTERM_TEST_LOCK_OWNER);
  if (parent && readOwner(dir)?.pid === parent) return () => {};
  const started = Date.now();
  let lastLog = 0;
  for (;;) {
    const got = tryLock(dir, { label });
    if (got === true) break;
    const waited = Math.round((Date.now() - started) / 1000);
    if (waited >= waitS) {
      log(`${label}: another dexterm test run holds ${dir} (pid ${got.pid}, ${got.label || ''} in ${got.cwd}); gave up after ${waited}s`);
      process.exit(75);
    }
    if (Date.now() - lastLog >= 30000) {
      log(`${label}: waiting for ${dir} held by pid ${got.pid} (${got.label || 'test run'} in ${got.cwd}, since ${got.startedAt}); waited ${waited}s`);
      lastLog = Date.now();
    }
    await sleep(pollMs);
  }
  process.env.DEXTERM_TEST_LOCK_OWNER = String(process.pid);
  const release = () => releaseLock(dir);
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { release(); process.exit(128 + ({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1 })[sig]); });
  return release;
}
