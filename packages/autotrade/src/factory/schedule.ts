// The factory's schedule (task-2159): a generated LaunchAgent (macOS) or systemd user timer (Linux) that runs
// `dexterm autotrade factory run --scheduled` at the configured slot, the same way `autotrade service install` writes
// its job (service-install.ts): files are generated from a spec, a manifest records their hashes, nothing is
// hand-edited and nothing outside the user's own LaunchAgents / systemd user dir is touched.
//
// The slot defaults to 04:10 local, after the nightly tuner (02:40) has finished. A run that is not due (the last run
// scheduled run is newer than intervalHours; runs by hand do not count) skips itself, so an interval above 24 h still uses the daily slot. An interval that
// divides the day (1, 2, 3, 4, 6, 8, 12 h) runs at fixed wall-clock slots counted from `at` (4 h at 04:10 = 00:10,
// 04:10, 08:10, 12:10, 16:10, 20:10), so it never drifts onto the tuner; any other interval under a day uses a plain
// interval from when the job was loaded.

import { createHash } from 'node:crypto';
import { join, posix } from 'node:path';
import { encode, fileSha, type InstallFile, type InstallPlan, type ServicePlatform } from '../service-install.ts';
import { factoryDir } from './config.ts';

export const FACTORY_LABEL = 'xyz.dexterm.factory';
export const FACTORY_INSTALL_SCHEMA = 'dexterm-factory-install/1';

export interface FactoryInstallSpec {
  platform: ServicePlatform;
  label: string;
  nodePath: string;
  binPath: string;
  workingDir: string;
  userHome: string;
  /** DEXTERM_HOME when it is not the default (passed as --home), else null. */
  dexHome: string | null;
  log: string;
  path: string | null;
  uid: number;
  /** HH:MM local. */
  at: string;
  intervalHours: number;
}

export function factoryLabel(dexHome: string, defaultHome: string): string {
  if (dexHome === defaultHome) return FACTORY_LABEL;
  return `${FACTORY_LABEL}.h${createHash('sha256').update(dexHome).digest('hex').slice(0, 8)}`;
}

export const factoryRunArgs = (s: FactoryInstallSpec): string[] => [s.nodePath, s.binPath, 'autotrade', 'factory', 'run', '--scheduled', '--quiet', ...(s.dexHome ? ['--home', s.dexHome] : [])];

const xml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const hm = (at: string): { h: number; m: number } => { const [h, m] = at.split(':').map(Number); return { h, m }; };

/** The wall-clock slots of a schedule, earliest first: one per day for 24 h or more, every intervalHours from `at`
 *  when the interval divides the day, else null (a plain interval). */
export function factorySlots(at: string, intervalHours: number): { h: number; m: number }[] | null {
  const { h, m } = hm(at);
  if (intervalHours >= 24) return [{ h, m }];
  if (!Number.isInteger(intervalHours) || 24 % intervalHours !== 0) return null;
  return Array.from({ length: 24 / intervalHours }, (_, i) => ({ h: (h + i * intervalHours) % 24, m })).sort((a, b) => a.h - b.h);
}

export const describeFactorySchedule = (at: string, intervalHours: number): string => {
  const slots = factorySlots(at, intervalHours);
  const two = (n: number) => String(n).padStart(2, '0');
  if (!slots) return `every ${intervalHours} h`;
  if (slots.length === 1) return `daily at ${at}`;
  return `every ${intervalHours} h at ${slots.map((x) => `${two(x.h)}:${two(x.m)}`).join(', ')}`;
};

// AbandonProcessGroup: a run may start a paper forward-test host (detached); it must outlive the run that started it.
// ProcessType Standard + Nice 15 + LowPriorityIO: it yields the CPU and the disk to everything else, but is not parked in the
// Background QoS band, which on a busy Mac gave a run 3-30% of one core with most of the CPU idle (~40-80 min instead of ~9;
// measured task-2179).
export function renderFactoryLaunchAgent(s: FactoryInstallSpec): string {
  const args = factoryRunArgs(s).map((a) => `    <string>${xml(a)}</string>`).join('\n');
  const env = s.path ? `  <key>EnvironmentVariables</key>\n  <dict>\n    <key>PATH</key>\n    <string>${xml(s.path)}</string>\n  </dict>\n` : '';
  // Wall-clock slots when the interval fits the day (a run that is not due skips itself), else a plain interval.
  const slots = factorySlots(s.at, s.intervalHours);
  const slot = (x: { h: number; m: number }, ind: string) => `${ind}<dict>\n${ind}  <key>Hour</key>\n${ind}  <integer>${x.h}</integer>\n${ind}  <key>Minute</key>\n${ind}  <integer>${x.m}</integer>\n${ind}</dict>\n`;
  const when = !slots
    ? `  <key>StartInterval</key>\n  <integer>${Math.round(s.intervalHours * 3600)}</integer>\n`
    : slots.length === 1
      ? `  <key>StartCalendarInterval</key>\n${slot(slots[0], '  ')}`
      : `  <key>StartCalendarInterval</key>\n  <array>\n${slots.map((x) => slot(x, '    ')).join('')}  </array>\n`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(s.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(s.workingDir)}</string>
${env}${when}  <key>AbandonProcessGroup</key>
  <true/>
  <key>ProcessType</key>
  <string>Standard</string>
  <key>Nice</key>
  <integer>15</integer>
  <key>LowPriorityIO</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(s.log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(s.log)}</string>
</dict>
</plist>
`;
}

export const factorySystemdUnit = (s: FactoryInstallSpec): string => s.label.replace(/^xyz\./, '').replace(/\./g, '-');
const q = (a: string): string => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `"${a.replace(/(["\\$`])/g, '\\$1')}"`);

export function renderFactorySystemdService(s: FactoryInstallSpec): string {
  return `[Unit]
Description=dexterm strategy factory (paper): one generation run
[Service]
Type=oneshot
WorkingDirectory=${s.workingDir}
ExecStart=${factoryRunArgs(s).map(q).join(' ')}
${s.path ? `Environment=PATH=${s.path}\n` : ''}Nice=15
IOSchedulingClass=idle
StandardOutput=append:${s.log}
StandardError=append:${s.log}
`;
}

export function renderFactorySystemdTimer(s: FactoryInstallSpec): string {
  const slots = factorySlots(s.at, s.intervalHours);
  const two = (n: number) => String(n).padStart(2, '0');
  const when = slots ? `OnCalendar=*-*-* ${slots.map((x) => two(x.h)).join(',')}:${two(slots[0].m)}:00` : `OnUnitActiveSec=${Math.round(s.intervalHours * 60)}min\nOnBootSec=15min`;
  return `[Unit]
Description=dexterm strategy factory schedule (paper)
[Timer]
${when}
Persistent=false
[Install]
WantedBy=timers.target
`;
}

export type FactoryPlanResult = { ok: true; plan: InstallPlan } | { ok: false; why: string };

export function factoryInstallPlan(s: FactoryInstallSpec): FactoryPlanResult {
  if (s.platform === 'darwin') {
    const path = posix.join(s.userHome, 'Library', 'LaunchAgents', `${s.label}.plist`);
    const domain = `gui/${s.uid}`;
    return {
      ok: true,
      plan: {
        platform: s.platform, label: s.label, name: s.label,
        files: [{ path, content: renderFactoryLaunchAgent(s) }],
        activate: [['launchctl', 'bootout', `${domain}/${s.label}`], ['launchctl', 'bootstrap', domain, path]],
        deactivate: [['launchctl', 'bootout', `${domain}/${s.label}`]],
        notes: [`Runs once per slot (${describeFactorySchedule(s.at, s.intervalHours)}) while you are logged in on this Mac, at low priority.`, 'To change the slot: edit factory.json (`dexterm autotrade factory config set at 05:00`) and run `factory install --load` again; never edit the plist by hand.'],
      },
    };
  }
  if (s.platform === 'linux') {
    const unit = factorySystemdUnit(s);
    const dir = posix.join(s.userHome, '.config', 'systemd', 'user');
    return {
      ok: true,
      plan: {
        platform: s.platform, label: s.label, name: `${unit}.timer`,
        files: [{ path: posix.join(dir, `${unit}.service`), content: renderFactorySystemdService(s) }, { path: posix.join(dir, `${unit}.timer`), content: renderFactorySystemdTimer(s) }],
        activate: [['systemctl', '--user', 'daemon-reload'], ['systemctl', '--user', 'enable', '--now', `${unit}.timer`]],
        deactivate: [['systemctl', '--user', 'disable', '--now', `${unit}.timer`]],
        notes: ['A systemd user timer runs while you are logged in (`loginctl enable-linger` is your choice).'],
      },
    };
  }
  return { ok: false, why: 'the factory schedule is generated for macOS (LaunchAgent) and Linux (systemd user timer); on Windows run `dexterm autotrade factory run --scheduled` from Task Scheduler yourself' };
}

export interface FactoryInstallManifest {
  schema: typeof FACTORY_INSTALL_SCHEMA;
  platform: ServicePlatform;
  label: string;
  name: string;
  installedAt: number;
  files: { path: string; sha256: string }[];
  deactivate: string[][];
  loaded: boolean;
  at: string;
  intervalHours: number;
}

export const factoryManifestPath = (dexHome: string): string => join(factoryDir(dexHome), 'install.json');

export function manifestFor(plan: InstallPlan, s: FactoryInstallSpec, loaded: boolean, now = Date.now()): FactoryInstallManifest {
  return {
    schema: FACTORY_INSTALL_SCHEMA, platform: plan.platform, label: plan.label, name: plan.name, installedAt: now,
    files: plan.files.map((f: InstallFile) => ({ path: f.path, sha256: fileSha(f.content, f.encoding) })), deactivate: plan.deactivate, loaded, at: s.at, intervalHours: s.intervalHours,
  };
}

export { encode as encodeInstallFile };
