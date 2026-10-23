// dexterm autotrade chat — where the bot token lives (task-1527, AUTOTRADE-SPEC §8.3).
//
// The token never goes in connectors.json, a log, argv or the environment. Stores, best first:
//   keychain   macOS: the login keychain through `security`. The token goes in on STDIN (`security -i` reads the
//              add command from a pipe), never on the command line, so `ps` cannot see it.
//   libsecret  Linux: `secret-tool store` reads the secret from stdin.
//   file       a 0600 file under $DEXTERM_HOME/secrets/ (directory 0700), outside every repo, as with the Helius key.
// The item is named per dexterm home (a hash of its path), so a test home or a second profile never reads or
// replaces the real one. `DEXTERM_SECRET_STORE=file` forces the file store (CI, containers, tests).

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export type SecretStoreKind = 'keychain' | 'libsecret' | 'file' | 'memory';

export interface SecretStore {
  readonly kind: SecretStoreKind;
  get(): string | null;
  set(value: string): void;
  remove(): void;
}

export const SECRET_SERVICE = 'xyz.dexterm.telegram';
export const accountFor = (home: string): string => `bot-token-${createHash('sha256').update(resolve(home)).digest('hex').slice(0, 12)}`;

const has = (bin: string): boolean => spawnSync('/usr/bin/env', ['which', bin], { stdio: 'ignore' }).status === 0;

class KeychainStore implements SecretStore {
  readonly kind = 'keychain' as const;
  private readonly account: string;
  constructor(account: string) { this.account = account; }
  get(): string | null {
    const r = spawnSync('security', ['find-generic-password', '-a', this.account, '-s', SECRET_SERVICE, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const v = r.status === 0 ? r.stdout.trim() : '';
    return v || null;
  }
  set(value: string): void {
    if (!/^[A-Za-z0-9:_-]+$/.test(value)) throw new Error('refusing to store a value with characters a bot token never has');
    // The add command (with the value) goes through stdin; argv only says "-i".
    const r = spawnSync('security', ['-i'], { input: `add-generic-password -U -a ${this.account} -s ${SECRET_SERVICE} -l "dexterm telegram bot" -w "${value}"\n`, encoding: 'utf8', stdio: ['pipe', 'ignore', 'pipe'] });
    if (r.status !== 0 || this.get() !== value) throw new Error('the macOS keychain did not store the token');
  }
  remove(): void { spawnSync('security', ['delete-generic-password', '-a', this.account, '-s', SECRET_SERVICE], { stdio: 'ignore' }); }
}

class LibsecretStore implements SecretStore {
  readonly kind = 'libsecret' as const;
  private readonly account: string;
  constructor(account: string) { this.account = account; }
  get(): string | null {
    const r = spawnSync('secret-tool', ['lookup', 'service', SECRET_SERVICE, 'account', this.account], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const v = r.status === 0 ? r.stdout.trim() : '';
    return v || null;
  }
  set(value: string): void {
    const r = spawnSync('secret-tool', ['store', '--label=dexterm telegram bot', 'service', SECRET_SERVICE, 'account', this.account], { input: value, encoding: 'utf8', stdio: ['pipe', 'ignore', 'pipe'] });
    if (r.status !== 0 || this.get() !== value) throw new Error('libsecret did not store the token');
  }
  remove(): void { spawnSync('secret-tool', ['clear', 'service', SECRET_SERVICE, 'account', this.account], { stdio: 'ignore' }); }
}

class FileStore implements SecretStore {
  readonly kind = 'file' as const;
  readonly path: string;
  constructor(home: string) { this.path = join(home, 'secrets', 'telegram-bot.token'); }
  get(): string | null {
    if (!existsSync(this.path)) return null;
    const v = readFileSync(this.path, 'utf8').trim();
    return v || null;
  }
  set(value: string): void {
    mkdirSync(join(this.path, '..'), { recursive: true, mode: 0o700 });
    chmodSync(join(this.path, '..'), 0o700);
    writeFileSync(this.path, `${value}\n`, { mode: 0o600 });
    chmodSync(this.path, 0o600);
  }
  remove(): void { rmSync(this.path, { force: true }); }
}

/** In memory (tests). */
export class MemoryStore implements SecretStore {
  readonly kind = 'memory' as const;
  private v: string | null;
  constructor(v: string | null = null) { this.v = v; }
  get(): string | null { return this.v; }
  set(value: string): void { this.v = value; }
  remove(): void { this.v = null; }
}

/** The store a kind names (the one setup recorded), for this home. */
export function secretStore(kind: SecretStoreKind, home: string): SecretStore {
  if (kind === 'keychain') return new KeychainStore(accountFor(home));
  if (kind === 'libsecret') return new LibsecretStore(accountFor(home));
  if (kind === 'memory') return new MemoryStore();
  return new FileStore(home);
}

/** The best store on this machine: DEXTERM_SECRET_STORE wins, then the OS store, then the 0600 file. */
export function chooseSecretStore(home: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): SecretStore {
  const want = env.DEXTERM_SECRET_STORE;
  if (want === 'file' || want === 'keychain' || want === 'libsecret') return secretStore(want, home);
  if (platform === 'darwin' && has('security')) return secretStore('keychain', home);
  if (platform === 'linux' && has('secret-tool')) return secretStore('libsecret', home);
  return secretStore('file', home);
}
