// task-2147: owner-only secret files on Windows. NTFS has no POSIX mode bits (chmod only toggles read-only and
// stat reports 0666), so the mode cannot say who may read a file; its DACL can. Writes lock the file to the current
// user with icacls, by SID (account names are localized); reads check the DACL as SDDL (locale-free). Any probe
// failure refuses the file: the caller names the TYPESAFE_API_KEY env var as the way out.

import { execFileSync } from 'node:child_process';
import path from 'node:path';

/** Runs a Windows system tool and returns its stdout (throws on a non-zero exit). Injected by tests. */
export type WinRun = (exe: string, args: string[], env: NodeJS.ProcessEnv) => string;

export interface WinAclDeps { run?: WinRun }

/**
 * Well-known principals that may hold a key file besides its user (the set Windows OpenSSH accepts). `LA` is the
 * built-in Administrator (RID 500), always a member of BA: SDDL writes that account's own SID in this alias form.
 */
const ALLOWED_WELL_KNOWN = new Set(['SY', 'S-1-5-18', 'BA', 'S-1-5-32-544', 'LA']);

/** The SDDL aliases that can stand for `sid` itself (task-2155: SDDL never spells RID 500 / 501 as S-1-…). */
const selfAliases = (sid: string): string[] => (/-500$/.test(sid) ? ['LA'] : /-501$/.test(sid) ? ['LG'] : []);
const SID_RE = /^S-1-\d+(-\d+)+$/i;

const system32 = (...p: string[]): string => path.win32.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', ...p);

const defaultRun: WinRun = (exe, args, env) => execFileSync(exe, args, { env, encoding: 'utf8', windowsHide: true, timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] });

/** The current user's SID (`whoami /user`, CSV: "host\user","S-1-5-21-..."). */
export function currentUserSid(deps: WinAclDeps = {}): string {
  const out = (deps.run ?? defaultRun)(system32('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], process.env);
  const sid = out.trim().split(/\r?\n/).pop()?.split(',').pop()?.replace(/"/g, '').trim() ?? '';
  if (!SID_RE.test(sid)) throw new Error('could not read the current Windows account SID');
  return sid;
}

/** Remove inherited access and grant only `sid` full control (icacls, no shell). */
export function lockOwnerOnly(p: string, sid: string, deps: WinAclDeps = {}): void {
  if (!SID_RE.test(sid)) throw new Error('bad SID');
  (deps.run ?? defaultRun)(system32('icacls.exe'), [p, '/inheritance:r', '/grant:r', `*${sid}:(F)`], process.env);
}

/** The file's security descriptor as SDDL. The path goes through the environment, never into the command text. */
export function readSddl(p: string, deps: WinAclDeps = {}): string {
  const ps = system32('WindowsPowerShell', 'v1.0', 'powershell.exe');
  return (deps.run ?? defaultRun)(ps, ['-NoProfile', '-NonInteractive', '-Command', '(Get-Acl -LiteralPath $env:DEXTERM_ACL_PATH).Sddl'], { ...process.env, DEXTERM_ACL_PATH: p }).replace(/\s+/g, ''); // SDDL has no whitespace: undo any console wrap
}

/**
 * Is this DACL owner-only? Every ACE that grants anything must name `sid` (as S-1-… or its alias), SYSTEM or
 * Administrators. A missing or
 * null DACL (everyone has access) and any ACE kind this parser does not know (e.g. conditional) are refused.
 */
export function sddlOwnerOnly(sddl: string, sid: string): { ok: true } | { ok: false; reason: string } {
  const m = /D:([A-Z_]*)((?:\([^()]*\))*)(?:S:|$)/.exec(sddl.trim());
  if (!m) return { ok: false, reason: 'no readable access list' };
  if (/NO_ACCESS_CONTROL/.test(m[1])) return { ok: false, reason: 'no access list (everyone has access)' };
  const others = new Set<string>();
  const self = new Set([sid.toUpperCase(), ...selfAliases(sid)]);
  for (const ace of m[2].match(/\(([^()]*)\)/g) ?? []) {
    const [type, flags = '', , , , who = ''] = ace.slice(1, -1).split(';');
    if (type === 'D' || type === 'OD') continue;            // deny entries only take access away
    if (type !== 'A' && type !== 'OA') return { ok: false, reason: `unsupported access entry ${type}` };
    if ((flags.match(/../g) ?? []).some((f) => f === 'IO')) continue; // inherit-only (2-letter flags): not the file itself
    const w = who.toUpperCase();
    if (!self.has(w) && !ALLOWED_WELL_KNOWN.has(w)) others.add(w);
  }
  return others.size ? { ok: false, reason: `other accounts can access it (${[...others].join(', ')})` } : { ok: true };
}

/** Check a file's ACL: owner-only or a reason. Never throws. */
export function checkOwnerOnly(p: string, deps: WinAclDeps = {}): { ok: true } | { ok: false; reason: string } {
  try { return sddlOwnerOnly(readSddl(p, deps), currentUserSid(deps)); } catch (e) {
    return { ok: false, reason: `its Windows access list could not be checked (${e instanceof Error ? e.message.split(/\r?\n/)[0] : String(e)})` };
  }
}
