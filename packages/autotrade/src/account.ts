// dexterm autotrade — which Claude account a session runs on (task-1505 AT-3, AUTOTRADE-SPEC §7.3).
//
// App code ships the account KINDS and the env-var names only; which account is used is the user's runner.json.
//
//   native       the user's default `claude` login. Nothing is added; inherited key/token variables are removed
//                so a stray ANTHROPIC_API_KEY in the shell cannot silently switch the account.
//   oauth-token  a long-lived Claude login token, fetched at spawn from a helper command or a keychain item and
//                handed to `claude` on file descriptor 3 (CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR=3). It is never
//                put in argv, a file, the environment or the ledger.
//   config-dir   CLAUDE_CONFIG_DIR=<dir>: a separate Claude config with its own login (an empty one answers
//                "Not logged in"; it never falls back to the native login).
//   api-key      a pay-as-you-go key from a helper or the keychain, in the child's environment only.
//
// Proof per session: the init event's `apiKeySource` must be one of `expectApiKeySource` for the kind, else the
// session is ended before its first turn. Measured on the native OAuth login: `none` (task-1498). The other kinds'
// values are the expected ones (an OAuth token or a config-dir login is not an API key; a key is reported as
// ANTHROPIC_API_KEY) and can be overridden per machine in runner.json once measured there. The check catches a
// switch between key and login; it cannot tell two OAuth logins apart (the init event names no account).

import { execFile } from 'node:child_process';
import type { AccountConfig, AccountKind, SecretSource } from './runner-config.ts';

export const EXPECTED_API_KEY_SOURCE: Record<AccountKind, string[]> = {
  native: ['none'],
  'oauth-token': ['none'],
  'config-dir': ['none'],
  'api-key': ['ANTHROPIC_API_KEY'],
};

/** Variables that select an account; removed from the child env unless the kind sets them itself. */
export const ACCOUNT_ENV_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR'] as const;

export const TOKEN_FD = 3;

/** What a spawn needs: the child env, and (oauth-token only) bytes to write to fd 3 and close. */
export interface SpawnAccount {
  kind: AccountKind;
  env: NodeJS.ProcessEnv;
  /** Written to the child's fd 3 right after spawn, then the pipe is closed. Never logged. */
  fdSecret: Buffer | null;
  expectApiKeySource: string[];
  /** Safe to log: the kind and, for config-dir, the directory. */
  label: string;
}

export type SecretFetcher = (src: SecretSource) => Promise<string>;

/** Run a helper command (no shell) or read a keychain item; stdout is the secret, trimmed. */
export const fetchSecret: SecretFetcher = (src) => new Promise((resolve, reject) => {
  const [bin, args] = 'command' in src
    ? [src.command[0], src.command.slice(1)]
    : ['security', ['find-generic-password', '-w', '-s', src.keychain.service, ...(src.keychain.account ? ['-a', src.keychain.account] : [])]];
  if (!bin) { reject(new Error('empty secret command')); return; }
  execFile(bin, args, { timeout: 10_000, maxBuffer: 64 * 1024, env: process.env }, (err, stdout) => {
    // The helper's stderr and our error text never carry the secret; stdout is never echoed.
    if (err) { reject(new Error(`the account's secret source failed (${'command' in src ? 'helper command' : 'keychain item'}: ${(err as NodeJS.ErrnoException).code ?? 'exit'})`)); return; }
    const v = String(stdout).trim();
    if (!v) { reject(new Error('the account\'s secret source printed nothing')); return; }
    resolve(v);
  });
});

/** Build the env (and fd secret) for one `claude` spawn. `base` is the runner's own environment. */
export async function prepareAccount(cfg: AccountConfig, base: NodeJS.ProcessEnv, fetch: SecretFetcher = fetchSecret): Promise<SpawnAccount> {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const k of ACCOUNT_ENV_VARS) delete env[k];
  const expectApiKeySource = cfg.expectApiKeySource?.length ? cfg.expectApiKeySource : EXPECTED_API_KEY_SOURCE[cfg.kind];
  switch (cfg.kind) {
    case 'native':
      return { kind: 'native', env, fdSecret: null, expectApiKeySource, label: 'native' };
    case 'config-dir':
      env.CLAUDE_CONFIG_DIR = cfg.dir;
      return { kind: 'config-dir', env, fdSecret: null, expectApiKeySource, label: `config-dir ${cfg.dir}` };
    case 'oauth-token': {
      const token = await fetch(cfg.source);
      env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR = String(TOKEN_FD);
      return { kind: 'oauth-token', env, fdSecret: Buffer.from(token, 'utf8'), expectApiKeySource, label: 'oauth-token' };
    }
    case 'api-key': {
      env.ANTHROPIC_API_KEY = await fetch(cfg.source);
      return { kind: 'api-key', env, fdSecret: null, expectApiKeySource, label: 'api-key' };
    }
  }
}
