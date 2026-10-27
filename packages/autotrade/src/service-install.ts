// dexterm autotrade — the always-on service's OS installers (0.2.0 card B, AUTOTRADE-SPEC §7.4).
//
// Every platform runs the same thing: `dexterm autotrade service ensure` once a minute and at login. `ensure` exits at
// once while the service's heartbeat is fresh and otherwise starts it detached, so a crash costs at most one tick and
// a clean stop stays stopped. The generators are pure (golden-file tested); the CLI shows the user every file and
// command before anything is written, and records what it wrote (install manifest) so uninstall removes exactly that.
//
//   macOS    ~/Library/LaunchAgents/<label>.plist: StartInterval 60, RunAtLoad, ProcessType Background, Nice 10,
//            LowPriorityIO, AbandonProcessGroup (the started service outlives the tick). NO KeepAlive and never
//            `launchctl submit` (a KeepAlive job relaunches forever). Loaded with `launchctl bootout` + `bootstrap`:
//            `kickstart -k` does NOT re-read the plist's arguments.
//   Linux    ~/.config/systemd/user/<unit>.service (oneshot ensure, Nice 10, idle IO, KillMode=process so the started
//            service survives the tick) + <unit>.timer (30 s after login, then every 60 s). Without
//            `loginctl enable-linger` a user unit runs only while the user is logged in.
//   Windows  a scheduled task (XML for `schtasks /Create /XML`): at logon + every minute, ignore-new on overlap,
//            below-normal priority, least privilege, 5-minute limit for the tick itself.
//
// One label per DEXTERM_HOME: the default home gets `xyz.dexterm.autotrade`; any other home gets a suffix from a hash
// of its path, so a test home never replaces (or removes) the real one. A non-default home is passed as `--home`.
// Only PATH is copied into the job's environment (the service needs to find `claude`); nothing else, no secrets.

import { createHash } from 'node:crypto';
import { join, posix } from 'node:path';

export const SERVICE_LABEL = 'xyz.dexterm.autotrade';
export const INSTALL_MANIFEST_SCHEMA = 'dexterm-autotrade-service-install/1';
export type ServicePlatform = 'darwin' | 'linux' | 'win32';

export interface InstallSpec {
  platform: ServicePlatform;
  label: string;
  nodePath: string;
  binPath: string;
  workingDir: string;
  /** The user's home directory (where LaunchAgents / systemd user units live). */
  userHome: string;
  /** DEXTERM_HOME when it is not the default (passed as --home), else null. */
  dexHome: string | null;
  /** Where the tick's own output goes. */
  tickLog: string;
  /** PATH for the job (macOS / Linux); null leaves the scheduler's default. */
  path: string | null;
  /** The numeric uid for launchctl's gui/<uid> domain (macOS). */
  uid: number;
}

export interface InstallFile { path: string; content: string; encoding?: 'utf8' | 'utf16le' }
export interface InstallPlan {
  platform: ServicePlatform;
  label: string;
  /** The scheduler's name for it (plist label, systemd unit, task name). */
  name: string;
  files: InstallFile[];
  /** Commands that load it (run only with --load). */
  activate: string[][];
  /** Commands that unload it (uninstall runs them when the job is loaded). */
  deactivate: string[][];
  notes: string[];
}

/** The label for a DEXTERM_HOME: the default one, or one suffixed by a hash of the path. */
export function serviceLabel(dexHome: string, defaultHome: string): string {
  if (dexHome === defaultHome) return SERVICE_LABEL;
  return `${SERVICE_LABEL}.h${createHash('sha256').update(dexHome).digest('hex').slice(0, 8)}`;
}

/** The tick's command line (`--quiet`: a tick that changes nothing prints nothing, so the tick log stays small). */
export const ensureArgs = (s: InstallSpec): string[] => [s.nodePath, s.binPath, 'autotrade', 'service', 'ensure', '--quiet', ...(s.dexHome ? ['--home', s.dexHome] : [])];

// ───────────────────────────── macOS ─────────────────────────────

const xml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// LaunchAgent and systemd paths are macOS / Linux paths whatever host computes the plan (task-1712: a Windows host
// joined them with `\`); the Windows task and the manifest live under the local dexHome and use the host's join.
export const launchAgentPath = (s: InstallSpec): string => posix.join(s.userHome, 'Library', 'LaunchAgents', `${s.label}.plist`);

export function renderLaunchAgent(s: InstallSpec): string {
  const args = ensureArgs(s).map((a) => `    <string>${xml(a)}</string>`).join('\n');
  const env = s.path ? `  <key>EnvironmentVariables</key>\n  <dict>\n    <key>PATH</key>\n    <string>${xml(s.path)}</string>\n  </dict>\n` : '';
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
${env}  <key>StartInterval</key>
  <integer>60</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>Nice</key>
  <integer>10</integer>
  <key>LowPriorityIO</key>
  <true/>
  <key>AbandonProcessGroup</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(s.tickLog)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(s.tickLog)}</string>
</dict>
</plist>
`;
}

// ───────────────────────────── Linux (systemd user) ─────────────────────────────

export const systemdUnit = (s: InstallSpec): string => s.label.replace(/^xyz\./, '').replace(/\./g, '-');
export const systemdDir = (s: InstallSpec): string => posix.join(s.userHome, '.config', 'systemd', 'user');

/** systemd quoting: double quotes, backslash and quote escaped, `%` doubled (specifier expansion). */
const sd = (a: string): string => `"${a.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;

export function renderSystemdService(s: InstallSpec): string {
  return `[Unit]
Description=dexterm autotrade service: start it when it is not running (one tick)

[Service]
Type=oneshot
ExecStart=${ensureArgs(s).map(sd).join(' ')}
WorkingDirectory=${s.workingDir.replace(/%/g, '%%')}
${s.path ? `Environment=${sd(`PATH=${s.path}`)}\n` : ''}Nice=10
IOSchedulingClass=idle
KillMode=process
StandardOutput=append:${s.tickLog.replace(/%/g, '%%')}
StandardError=append:${s.tickLog.replace(/%/g, '%%')}
`;
}

export function renderSystemdTimer(s: InstallSpec): string {
  return `[Unit]
Description=dexterm autotrade service tick (every minute)

[Timer]
OnStartupSec=30
OnUnitActiveSec=60
AccuracySec=10
Unit=${systemdUnit(s)}.service

[Install]
WantedBy=timers.target
`;
}

// ───────────────────────────── Windows (scheduled task) ─────────────────────────────

export const windowsTaskName = (s: InstallSpec): string => `\\dexterm\\${s.label.replace(/^xyz\.dexterm\./, '')}`;
export const windowsTaskFile = (dexHome: string, s: InstallSpec): string => join(dexHome, 'autotrade', 'service', `${s.label}.task.xml`);

/** Windows command-line quoting for one argument (CommandLineToArgvW rules). */
export function winArg(a: string): string {
  if (a && !/[\s"]/.test(a)) return a;
  let out = '"';
  let bs = 0;
  for (const ch of a) {
    if (ch === '\\') { bs++; continue; }
    if (ch === '"') { out += '\\'.repeat(bs * 2 + 1) + '"'; bs = 0; continue; }
    out += '\\'.repeat(bs) + ch; bs = 0;
  }
  return `${out}${'\\'.repeat(bs * 2)}"`;
}

export function renderWindowsTask(s: InstallSpec): string {
  const [cmd, ...rest] = ensureArgs(s);
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>dexterm autotrade service: start it when it is not running (one tick a minute)</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
    <TimeTrigger>
      <Repetition>
        <Interval>PT1M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <StartBoundary>2026-01-01T00:00:00</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT5M</ExecutionTimeLimit>
    <Priority>7</Priority>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xml(cmd)}</Command>
      <Arguments>${xml(rest.map(winArg).join(' '))}</Arguments>
      <WorkingDirectory>${xml(s.workingDir)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

// ───────────────────────────── the plan ─────────────────────────────

export function installPlan(s: InstallSpec, dexHome: string): InstallPlan {
  if (s.platform === 'darwin') {
    const path = launchAgentPath(s);
    const domain = `gui/${s.uid}`;
    return {
      platform: s.platform, label: s.label, name: s.label,
      files: [{ path, content: renderLaunchAgent(s) }],
      activate: [['launchctl', 'bootout', `${domain}/${s.label}`], ['launchctl', 'bootstrap', domain, path]],
      deactivate: [['launchctl', 'bootout', `${domain}/${s.label}`]],
      notes: ['A LaunchAgent starts at login: the service runs while you are logged in on this Mac.', 'To change it later: edit nothing by hand; run `dexterm autotrade service install --load` again (bootout + bootstrap; `kickstart -k` would keep the old arguments).'],
    };
  }
  if (s.platform === 'linux') {
    const unit = systemdUnit(s);
    const dir = systemdDir(s);
    return {
      platform: s.platform, label: s.label, name: `${unit}.timer`,
      files: [{ path: posix.join(dir, `${unit}.service`), content: renderSystemdService(s) }, { path: posix.join(dir, `${unit}.timer`), content: renderSystemdTimer(s) }],
      activate: [['systemctl', '--user', 'daemon-reload'], ['systemctl', '--user', 'enable', '--now', `${unit}.timer`]],
      deactivate: [['systemctl', '--user', 'disable', '--now', `${unit}.timer`]],
      notes: ['A systemd user timer runs while you are logged in; `loginctl enable-linger` (your choice) keeps it running after logout and from boot.'],
    };
  }
  const file = windowsTaskFile(dexHome, s);
  const name = windowsTaskName(s);
  return {
    platform: s.platform, label: s.label, name,
    files: [{ path: file, content: renderWindowsTask(s), encoding: 'utf16le' }],
    activate: [['schtasks', '/Create', '/TN', name, '/XML', file, '/F']],
    deactivate: [['schtasks', '/Delete', '/TN', name, '/F']],
    notes: ['The task runs at logon and every minute while you are logged in.'],
  };
}

export interface InstallManifest {
  schema: typeof INSTALL_MANIFEST_SCHEMA;
  platform: ServicePlatform;
  label: string;
  name: string;
  installedAt: number;
  files: { path: string; sha256: string }[];
  deactivate: string[][];
  loaded: boolean;
}

export const fileSha = (content: string, encoding: InstallFile['encoding'] = 'utf8'): string => createHash('sha256').update(encode(content, encoding)).digest('hex');
/** The bytes written for a file (UTF-16 LE with a BOM for the Windows task XML). */
export function encode(content: string, encoding: InstallFile['encoding'] = 'utf8'): Buffer {
  return encoding === 'utf16le' ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, 'utf16le')]) : Buffer.from(content, 'utf8');
}
export const installManifestPath = (dexHome: string): string => join(dexHome, 'autotrade', 'service', 'install.json');
