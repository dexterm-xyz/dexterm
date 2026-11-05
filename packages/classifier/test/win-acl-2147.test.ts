// task-2147: the TypeSafe key file on Windows. NTFS reports mode 0666 for every file, so the POSIX 0o077 check
// refused the user's own key there (the env var worked). The Windows path locks the file with icacls and checks its
// DACL. These tests drive that path on any OS with a fake whoami / icacls / PowerShell; the real tools run in
// classifier-units-1822 on the Windows CI runner.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { readTypesafeKey, sddlOwnerOnly, typesafeKeyPath, typesafeKeyRefusal, typesafeKeyState, writeTypesafeKey, type WinRun } from '../src/index.ts';

const SID = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
const OTHER = 'S-1-5-21-1111111111-2222222222-3333333333-1002';
const KEY = 'ts_win_key_0123456789';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dexterm-winacl-'));
/** A file under the user profile: inherited SYSTEM + Administrators + the user (owner-only by Windows' defaults). */
const PROFILE = `O:${SID}G:${SID}D:AI(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;${SID})`;

/** A fake Windows: ACLs follow the inode (so a rename keeps them, as NTFS does); every call is recorded. */
function fakeWindows(over: { icacls?: () => void; ps?: () => void; sid?: string; alias?: (sid: string) => string } = {}) {
  const me = over.sid ?? SID;
  const shown = over.alias ?? ((x: string) => x); // how Get-Acl's SDDL spells a SID
  const acl = new Map<number, string>();
  const calls: Array<{ exe: string; args: string[]; aclPath?: string; size?: number }> = [];
  const run: WinRun = (exe, args, env) => {
    const base = path.win32.basename(exe).toLowerCase();
    const aclPath = env.DEXTERM_ACL_PATH;
    calls.push({ exe: base, args, aclPath, size: base === 'icacls.exe' ? fs.statSync(args[0]).size : undefined });
    if (base === 'whoami.exe') return `"host\\someone","${me}"\r\n`;
    if (base === 'icacls.exe') {
      over.icacls?.();
      const [file, inh, grant, ace] = args;
      assert.deepEqual([inh, grant], ['/inheritance:r', '/grant:r']);
      const sid = /^\*(S-[\d-]+):\(F\)$/.exec(ace)![1];
      acl.set(fs.statSync(file).ino, `O:${shown(me)}G:${shown(me)}D:P(A;;FA;;;${shown(sid)})`);
      return 'processed file\r\n';
    }
    if (base === 'powershell.exe') {
      over.ps?.();
      return acl.get(fs.statSync(aclPath!).ino) ?? PROFILE;
    }
    throw new Error(`unexpected ${exe}`);
  };
  return { run, acl, calls, widen: (p: string, sddl: string) => acl.set(fs.statSync(p).ino, sddl) };
}
const win = (f: ReturnType<typeof fakeWindows>) => ({ platform: 'win32' as const, acl: { run: f.run } });

describe('task-2147 Windows DACL check (SDDL)', () => {
  it('accepts the user alone, or with SYSTEM / Administrators (protected or inherited)', () => {
    assert.deepEqual(sddlOwnerOnly(PROFILE, SID), { ok: true });
    assert.deepEqual(sddlOwnerOnly(`O:${SID}G:${SID}D:P(A;;FA;;;${SID})`, SID), { ok: true });
    assert.deepEqual(sddlOwnerOnly(`D:P(A;;FA;;;${SID.toLowerCase()})(A;;FA;;;S-1-5-18)(A;;FA;;;S-1-5-32-544)`, SID), { ok: true });
    assert.deepEqual(sddlOwnerOnly(`D:P(A;;FA;;;${SID})(D;;FA;;;WD)(A;OICIIO;FA;;;CO)`, SID), { ok: true }, 'deny and inherit-only entries grant nothing');
  });
  it('task-2155: the built-in Administrator (RID 500) and Guest (RID 501) are written as LA / LG and are still the user', () => {
    const admin = 'S-1-5-21-1111111111-2222222222-3333333333-500';
    const guest = 'S-1-5-21-1111111111-2222222222-3333333333-501';
    assert.deepEqual(sddlOwnerOnly('O:LAG:LAD:P(A;;FA;;;LA)', admin), { ok: true });
    assert.deepEqual(sddlOwnerOnly('O:LAG:LAD:AI(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;LA)', admin), { ok: true });
    assert.deepEqual(sddlOwnerOnly('D:P(A;;FA;;;LG)', guest), { ok: true });
    assert.deepEqual(sddlOwnerOnly(`D:P(A;;FA;;;${SID})(A;;FA;;;LA)`, SID), { ok: true }, 'LA is a member of BA, already allowed');
    assert.equal(sddlOwnerOnly(`D:P(A;;FA;;;${SID})(A;;FR;;;LG)`, SID).ok, false, 'the Guest account is another account for anyone else');
    assert.equal(sddlOwnerOnly('D:P(A;;FA;;;LA)(A;;FR;;;S-1-5-21-9-9-9-500)', admin).ok, false, "another domain's administrator is another account");
  });
  it('refuses Everyone, Users, Authenticated Users, another account, no DACL, odd entries and junk', () => {
    for (const who of ['WD', 'BU', 'AU', OTHER]) {
      const r = sddlOwnerOnly(`D:P(A;;FA;;;${SID})(A;;FR;;;${who})`, SID);
      assert.equal(r.ok, false, who);
      assert.match((r as { reason: string }).reason, new RegExp(`other accounts can access it \\(${who}\\)`));
    }
    assert.deepEqual(sddlOwnerOnly(`O:${SID}D:NO_ACCESS_CONTROL`, SID), { ok: false, reason: 'no access list (everyone has access)' });
    assert.equal(sddlOwnerOnly(`O:${SID}G:${SID}`, SID).ok, false, 'no DACL at all');
    assert.equal(sddlOwnerOnly(`D:P(XA;;FA;;;${SID};(WIN://x))`, SID).ok, false, 'conditional entries are not parsed, so refused');
    assert.equal(sddlOwnerOnly('', SID).ok, false);
    assert.equal(sddlOwnerOnly(`D:P(A;;FA;;;${SID})(A;CIOI;FR;;;WD)`, SID).ok, false, 'CI+OI is not inherit-only although the letters spell IO');
    assert.equal(sddlOwnerOnly(`D:P(A;;FA;;;${SID})S:(AU;SA;FA;;;WD)`, SID).ok, true, 'an audit (SACL) entry is not access');
  });
});

describe('task-2147 key file on Windows (simulated)', () => {
  it('set locks an EMPTY temp file to the user SID before the key goes in; read accepts it although stat says 0666', () => {
    const f = fakeWindows();
    const env: NodeJS.ProcessEnv = { DEXTERM_HOME: tmp() };
    const p = writeTypesafeKey(KEY, env, win(f));
    assert.equal(p, typesafeKeyPath(env));
    const icacls = f.calls.find((c) => c.exe === 'icacls.exe')!;
    assert.deepEqual(icacls.args.slice(1), ['/inheritance:r', '/grant:r', `*${SID}:(F)`]);
    assert.equal(icacls.size, 0, 'the key is written only after the access list is locked');
    assert.ok(icacls.args[0].endsWith('.tmp'));
    assert.ok(f.calls.some((c) => c.exe === 'powershell.exe' && c.aclPath === p), 'the final file is checked after the rename');
    assert.ok(!JSON.stringify(f.calls).includes(KEY), 'the key never reaches a command line or env');
    if (process.platform !== 'win32') fs.chmodSync(p, 0o666); // what NTFS reports: the Windows path must not read mode bits
    assert.equal(readTypesafeKey(env, win(f)), KEY);
    assert.deepEqual(fs.readdirSync(path.dirname(p)), ['typesafe'], 'no temp file left');
  });
  it('task-2155: the built-in Administrator stores and reads its own key (Get-Acl prints its SID as LA)', () => {
    const admin = 'S-1-5-21-1111111111-2222222222-3333333333-500';
    const f = fakeWindows({ sid: admin, alias: (x) => (x === admin ? 'LA' : x) });
    const env: NodeJS.ProcessEnv = { DEXTERM_HOME: tmp() };
    writeTypesafeKey(KEY, env, win(f));
    assert.ok(f.calls.some((c) => c.exe === 'icacls.exe' && c.args.includes(`*${admin}:(F)`)));
    assert.equal(readTypesafeKey(env, win(f)), KEY);
  });
  it('a key file other accounts can read is refused with a reason that names TYPESAFE_API_KEY (never the key)', () => {
    const f = fakeWindows();
    const env: NodeJS.ProcessEnv = { DEXTERM_HOME: tmp() };
    const p = writeTypesafeKey(KEY, env, win(f));
    f.widen(p, `O:${SID}D:AI(A;ID;FA;;;${SID})(A;ID;0x1200a9;;;BU)`);
    const s = typesafeKeyState(env, win(f));
    assert.equal(s.source, 'refused');
    const msg = typesafeKeyRefusal(s as { path: string; reason: string });
    assert.match(msg, /other accounts can access it \(BU\).*TYPESAFE_API_KEY/);
    assert.ok(!msg.includes(KEY));
    assert.equal(readTypesafeKey(env, win(f)), null);
    assert.equal(readTypesafeKey({ ...env, TYPESAFE_API_KEY: 'ts_env_key_12345678' }, win(f)), 'ts_env_key_12345678', 'the env var still works');
  });
  it('a key file whose access list cannot be checked is refused (fail closed)', () => {
    const ok = fakeWindows();
    const env: NodeJS.ProcessEnv = { DEXTERM_HOME: tmp() };
    writeTypesafeKey(KEY, env, win(ok));
    const broken = fakeWindows({ ps: () => { throw new Error('powershell.exe is blocked by policy'); } });
    const s = typesafeKeyState(env, win(broken));
    assert.equal(s.source, 'refused');
    assert.match((s as { reason: string }).reason, /could not be checked \(powershell\.exe is blocked by policy\)/);
  });
  it('when icacls fails nothing is saved and the error names TYPESAFE_API_KEY', () => {
    const f = fakeWindows({ icacls: () => { throw new Error('Access is denied.'); } });
    const env: NodeJS.ProcessEnv = { DEXTERM_HOME: tmp() };
    assert.throws(() => writeTypesafeKey(KEY, env, win(f)), (e: Error) => /Nothing was saved\. Set TYPESAFE_API_KEY/.test(e.message) && /Access is denied/.test(e.message) && !e.message.includes(KEY));
    assert.deepEqual(fs.readdirSync(path.dirname(typesafeKeyPath(env))), []);
  });
  it('a lock that does not take (the file stays shared) is refused at write time and removed', () => {
    const f = fakeWindows();
    const run: WinRun = (exe, args, env) => (path.win32.basename(exe) === 'icacls.exe' ? 'processed\r\n' : f.run(exe, args, env));
    const env: NodeJS.ProcessEnv = { DEXTERM_HOME: tmp() };
    f.acl.clear();
    const shared = `O:${SID}D:AI(A;ID;FA;;;${SID})(A;ID;FR;;;WD)`;
    const run2: WinRun = (exe, args, e) => (path.win32.basename(exe) === 'powershell.exe' ? shared : run(exe, args, e));
    assert.throws(() => writeTypesafeKey(KEY, env, { platform: 'win32', acl: { run: run2 } }), /other accounts can access it \(WD\).*TYPESAFE_API_KEY/);
    assert.deepEqual(fs.readdirSync(path.dirname(typesafeKeyPath(env))), []);
  });
  it('the POSIX check is unchanged: a group-readable file is refused on darwin/linux', { skip: process.platform === 'win32' ? 'chmod cannot set group bits on NTFS' : false }, () => {
    const env: NodeJS.ProcessEnv = { DEXTERM_HOME: tmp() };
    const p = writeTypesafeKey(KEY, env, { platform: 'linux' });
    assert.equal(fs.statSync(p).mode & 0o777, 0o600);
    assert.equal(readTypesafeKey(env, { platform: 'linux' }), KEY);
    for (const m of [0o640, 0o604, 0o620, 0o602]) {
      fs.chmodSync(p, m);
      assert.equal(typesafeKeyState(env, { platform: 'darwin' }).source, 'refused', m.toString(8));
    }
  });
});
