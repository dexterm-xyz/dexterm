// 0.2.0 card B: the always-on service's OS installers, golden files. The macOS LaunchAgent has StartInterval 60,
// RunAtLoad, AbandonProcessGroup and NO KeepAlive (and passes `plutil -lint` on a Mac); the systemd user units keep
// the started service alive past the oneshot tick (KillMode=process); the Windows task runs at logon + every minute and
// is written as UTF-16 LE; a non-default DEXTERM_HOME gets its own label and is passed as --home; quoting survives
// spaces, quotes and `%`. Regenerate the goldens with DEXTERM_UPDATE_GOLDEN=1 after a deliberate change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SERVICE_LABEL, encode, ensureArgs, installPlan, renderLaunchAgent, renderSystemdService, renderSystemdTimer, renderWindowsTask, serviceLabel, winArg, type InstallSpec,
} from '../src/service-install.ts';

const GOLD = fileURLToPath(new URL('./fixtures/service-1646/', import.meta.url));
const UPDATE = process.env.DEXTERM_UPDATE_GOLDEN === '1';

const POSIX: InstallSpec = {
  platform: 'darwin', label: SERVICE_LABEL, nodePath: '/usr/local/bin/node', binPath: '/opt/dexterm/packages/cli/bin/dexterm.mjs', workingDir: '/opt/dexterm',
  userHome: '/Users/tester', dexHome: null, tickLog: '/Users/tester/.dexterm/autotrade/logs/tick.log', path: '/usr/local/bin:/usr/bin:/bin', uid: 501,
};
const CUSTOM: InstallSpec = { ...POSIX, platform: 'linux', label: serviceLabel('/tmp/dex home %1', '/home/tester/.dexterm'), userHome: '/home/tester', dexHome: '/tmp/dex home %1', tickLog: '/tmp/dex home %1/autotrade/logs/tick.log' };
const WIN: InstallSpec = {
  platform: 'win32', label: SERVICE_LABEL, nodePath: 'C:\\Program Files\\nodejs\\node.exe', binPath: 'C:\\dexterm\\packages\\cli\\bin\\dexterm.mjs', workingDir: 'C:\\dexterm',
  userHome: 'C:\\Users\\tester', dexHome: null, tickLog: 'C:\\Users\\tester\\.dexterm\\autotrade\\logs\\tick.log', path: null, uid: 0,
};

function golden(name: string, got: string): void {
  const p = join(GOLD, name);
  if (UPDATE) { mkdirSync(GOLD, { recursive: true }); writeFileSync(p, got); return; }
  assert.equal(got, readFileSync(p, 'utf8'), `${name} differs from its golden file (DEXTERM_UPDATE_GOLDEN=1 after a deliberate change)`);
}

test('1646 installers: golden files for the LaunchAgent, the systemd units and the Windows task', () => {
  golden('launchd.plist', renderLaunchAgent(POSIX));
  golden('systemd.service', renderSystemdService({ ...POSIX, platform: 'linux', userHome: '/home/tester', tickLog: '/home/tester/.dexterm/autotrade/logs/tick.log' }));
  golden('systemd.timer', renderSystemdTimer({ ...POSIX, platform: 'linux' }));
  golden('systemd-custom-home.service', renderSystemdService(CUSTOM));
  golden('task.xml', renderWindowsTask(WIN));
});

test('1646 LaunchAgent: StartInterval 60, RunAtLoad, Background, Nice 10, LowPriorityIO, AbandonProcessGroup, and never KeepAlive', () => {
  const p = renderLaunchAgent(POSIX);
  for (const k of ['<key>StartInterval</key>\n  <integer>60</integer>', '<key>RunAtLoad</key>\n  <true/>', '<key>ProcessType</key>\n  <string>Background</string>', '<key>Nice</key>\n  <integer>10</integer>', '<key>LowPriorityIO</key>\n  <true/>', '<key>AbandonProcessGroup</key>\n  <true/>']) assert.ok(p.includes(k), k);
  assert.doesNotMatch(p, /KeepAlive/);
  assert.match(p, /<string>ensure<\/string>\n {4}<string>--quiet<\/string>/);
  // Only PATH goes into the job's environment.
  assert.deepEqual([...p.matchAll(/<key>([A-Z_]+)<\/key>\n {4}<string>/g)].map((m) => m[1]), ['PATH']);
  const plan = installPlan(POSIX, '/Users/tester/.dexterm');
  assert.deepEqual(plan.activate, [['launchctl', 'bootout', `gui/501/${SERVICE_LABEL}`], ['launchctl', 'bootstrap', 'gui/501', `/Users/tester/Library/LaunchAgents/${SERVICE_LABEL}.plist`]]);
  assert.ok(!plan.activate.flat().includes('kickstart') && !plan.activate.flat().includes('submit'));
  if (process.platform === 'darwin') {
    const dir = mkdtempSync(join(tmpdir(), 'svc1646-plist-'));
    const f = join(dir, 'x.plist');
    writeFileSync(f, renderLaunchAgent({ ...POSIX, dexHome: '/tmp/a & b <c>', label: serviceLabel('/tmp/a & b <c>', '/x') }));
    const r = spawnSync('plutil', ['-lint', f], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('1646 systemd: oneshot ensure that leaves the started service running; timer every 60 s; quoting of spaces and %', () => {
  const s = renderSystemdService(CUSTOM);
  assert.match(s, /^Type=oneshot$/m);
  assert.match(s, /^KillMode=process$/m);
  assert.match(s, /--home" "\/tmp\/dex home %%1"/);
  const t = renderSystemdTimer(CUSTOM);
  assert.match(t, /^OnUnitActiveSec=60$/m);
  assert.match(t, new RegExp(`^Unit=dexterm-autotrade-h[0-9a-f]{8}\\.service$`, 'm'));
  const plan = installPlan(CUSTOM, '/tmp/dex home %1');
  assert.equal(plan.files.length, 2);
  assert.deepEqual(plan.deactivate[0].slice(0, 4), ['systemctl', '--user', 'disable', '--now']);
});

test('1646 Windows task: logon + 1-minute repetition, IgnoreNew, least privilege, UTF-16 LE with a BOM; argv quoting', () => {
  const x = renderWindowsTask(WIN);
  for (const k of ['<LogonTrigger>', '<Interval>PT1M</Interval>', '<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>', '<RunLevel>LeastPrivilege</RunLevel>', '<Command>C:\\Program Files\\nodejs\\node.exe</Command>']) assert.ok(x.includes(k), k);
  const plan = installPlan(WIN, 'C:\\Users\\tester\\.dexterm');
  assert.equal(plan.files[0].encoding, 'utf16le');
  const bytes = encode(plan.files[0].content, 'utf16le');
  assert.deepEqual([bytes[0], bytes[1]], [0xff, 0xfe]);
  assert.equal(winArg('plain'), 'plain');
  assert.equal(winArg('C:\\a b\\'), '"C:\\a b\\\\"');
  assert.equal(winArg('say "hi"'), '"say \\"hi\\""');
});

test('1646 labels: the default home keeps the plain label; any other home gets its own (a test home never replaces the real one)', () => {
  assert.equal(serviceLabel('/h/.dexterm', '/h/.dexterm'), SERVICE_LABEL);
  const a = serviceLabel('/tmp/one', '/h/.dexterm');
  assert.match(a, /^xyz\.dexterm\.autotrade\.h[0-9a-f]{8}$/);
  assert.notEqual(a, serviceLabel('/tmp/two', '/h/.dexterm'));
  assert.deepEqual(ensureArgs(CUSTOM).slice(-2), ['--home', '/tmp/dex home %1']);
  assert.ok(!ensureArgs(POSIX).includes('--home'));
});
