// task-1571 — THE no-key / no-sign guard for the whole build. 0.1.7 holds NO key, signs NOTHING and has no local
// trading wallet: live trading happens in the Telegram trading bot of the user's choice. This test scans everything
// the npm package ships (packages/<pkg>/src, the runtime dirs build-dist.mjs copies, the bins, and packages/cli/dist
// when it has been built) and fails on any key-store, signing or transaction-sending code.
//
// What it refuses (outside the allow-list below):
//   modules     tweetnacl, @solana/web3.js, @solana/kit, @solana/signers, @noble/ed25519, @noble/curves, bs58, bip39,
//               bip32, ed25519-hd-key, scrypt-js, argon2 (imports, requires and package.json dependencies)
//   node:crypto anything but hashing / randomness / constant-time compare (createHash, createHmac, randomBytes,
//               randomInt, randomUUID, timingSafeEqual): no sign / createSign / createPrivateKey / generateKeyPair /
//               scrypt / pbkdf2 / createCipheriv / createDecipheriv / privateEncrypt / privateDecrypt / subtle
//   identifiers signTransaction, signAllTransactions, sendTransaction, sendRawTransaction, requestAirdrop, Keypair,
//               fromSecretKey, secretKey, the old key-file names (trading-wallet.json, fast-wallet.json,
//               signer-caps.json) and Jupiter's transaction-build endpoint (/swap/v1/swap)
//   files       the removed signer / keystore / swap-build / submit modules and the vendored @solana/web3.js bundle
//
// ALLOW-LIST (read-only, public-key uses), each documented and pinned:
//   data/src/trade/tx-decode.ts  `createPublicKey` + `verify` from node:crypto: verifies the Ed25519 proof Phantom
//                                signs over a dexterm MESSAGE when the user links a wallet (`dexterm wallet link`), with
//                                the wallet's PUBLIC key; it also decodes transactions read from the chain. It holds no
//                                key and produces no signature.
//   data/src/larp/evidence.ts    `signAllTransactions` inside a REGEX literal: the LARP check flags a fetched web page
//                                that carries wallet-drainer code ("sign-all then transfer-all"). Detection, not use.
// Comments are stripped before the identifier scan, so history notes in comments do not count.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PKGS = join(ROOT, 'packages');

const FORBIDDEN_MODULES = ['tweetnacl', '@solana/web3.js', '@solana/kit', '@solana/signers', '@noble/ed25519', '@noble/curves', 'bs58', 'bip39', 'bip32', 'ed25519-hd-key', 'scrypt-js', 'argon2'];
const CRYPTO_OK = new Set(['createHash', 'createHmac', 'randomBytes', 'randomInt', 'randomUUID', 'timingSafeEqual']);
const CRYPTO_ALLOW: Record<string, string[]> = { 'packages/data/src/trade/tx-decode.ts': ['createPublicKey', 'verify'] };
/** Names a file may carry, with why (see the header). Only inside the given file, only those names. */
const IDENT_ALLOW: Record<string, string[]> = { 'packages/data/src/larp/evidence.ts': ['signAllTransactions'] };
const CRYPTO_BAD_MEMBER = /\bcrypto\.(sign|createSign|createPrivateKey|generateKeyPair(Sync)?|generateKey(Sync)?|scrypt(Sync)?|pbkdf2(Sync)?|createCipheriv|createDecipheriv|privateEncrypt|privateDecrypt|subtle|webcrypto)\b/;
const BAD_IDENT = /\b(signTransaction|signAllTransactions|sendTransaction|sendRawTransaction|requestAirdrop|Keypair|fromSecretKey|secretKey)\b|trading-wallet\.json|fast-wallet\.json|signer-caps\.json|\/swap\/v1\/swap\b/;
const VENDOR_BAD = /@solana\/|tweetnacl|nacl\.sign|\bKeypair\b|\bsecretKey\b|\bsignTransaction\b|\bsendTransaction\b/;
const REMOVED = [
  'packages/data/src/trade/live', 'packages/data/src/trade/signer', 'packages/data/vendor', 'packages/data/src/trade/executor.ts',
  'packages/data/src/trade/swap-build.ts', 'packages/data/src/trade/rpc-exec.ts', 'packages/data/src/trade/token-delta.ts', 'packages/data/src/trade/caps.ts',
  'packages/data/src/trade/plans/executor-live.ts', 'packages/autotrade/src/live-executor.ts', 'packages/cli/src/live-cmd.ts', 'packages/cli/src/live-help.ts',
];
const CODE = /\.(ts|mts|cts|js|mjs|cjs)$/;

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); } else out.push(p);
  }
  return out;
}
/** Comments out, strings kept (good enough for first-party code: URLs keep their `//` because `:` precedes it). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => (/^\s*\/\//.test(l) ? '' : l.replace(/(^|\s)\/\/\s.*$/, ''))).join('\n');
}
const rel = (f: string) => relative(ROOT, f).split('\\').join('/');

/** What the published package is built from (build-dist.mjs): every src, the runtime dirs, the bins. */
function shippedFiles(): { firstParty: string[]; vendor: string[] } {
  const firstParty: string[] = [];
  const vendor: string[] = [];
  for (const d of readdirSync(PKGS)) {
    const pkg = join(PKGS, d);
    if (!existsSync(join(pkg, 'package.json'))) continue;
    for (const sub of ['src', 'bin', 'assets']) for (const f of walk(join(pkg, sub))) if (CODE.test(f)) firstParty.push(f);
    for (const f of walk(join(pkg, 'vendor'))) if (CODE.test(f)) vendor.push(f);
  }
  return { firstParty, vendor };
}

function cryptoNames(src: string): string[] {
  const names: string[] = [];
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](node:)?crypto['"]/g)) for (const n of m[1].split(',')) { const k = n.trim().split(/\s+as\s+/)[0]; if (k && k !== 'type') names.push(k.replace(/^type\s+/, '')); }
  for (const m of src.matchAll(/\{([^}]*)\}\s*=\s*(await\s+import\(\s*['"](node:)?crypto['"]\s*\)|require\(\s*['"](node:)?crypto['"]\s*\))/g)) for (const n of m[1].split(',')) { const k = n.trim().split(/\s*:\s*/)[0]; if (k) names.push(k); }
  return names;
}

test('1571 the removed signer / keystore / swap / submit modules and the @solana/web3.js bundle are gone from the tree', () => {
  for (const p of REMOVED) assert.ok(!existsSync(join(ROOT, p)), `${p} is back: dexterm 0.1.7 holds no key and signs nothing`);
  const build = readFileSync(join(PKGS, 'cli', 'scripts', 'build-dist.mjs'), 'utf8');
  assert.doesNotMatch(build, /data:\s*\[\s*'vendor'\s*\]/, 'build-dist no longer ships a data/vendor dir');
  const pj = JSON.parse(readFileSync(join(PKGS, 'data', 'package.json'), 'utf8')) as { exports: Record<string, string> };
  assert.equal(pj.exports['./live'], undefined, '@dexterm/data/live is not exported');
});

test('1571 no package depends on a signing / key / Solana-transaction library', () => {
  for (const d of readdirSync(PKGS).concat('.')) {
    const f = d === '.' ? join(ROOT, 'package.json') : join(PKGS, d, 'package.json');
    if (!existsSync(f)) continue;
    const pj = JSON.parse(readFileSync(f, 'utf8')) as Record<string, Record<string, string> | undefined>;
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const dep of Object.keys(pj[field] ?? {})) assert.ok(!FORBIDDEN_MODULES.includes(dep), `${rel(f)} ${field} has ${dep}`);
    }
  }
});

test('1571 no shipped file imports a signing library, uses node:crypto beyond hashing, or names a sign / send / key-store path', () => {
  const { firstParty, vendor } = shippedFiles();
  assert.ok(firstParty.length > 300, `scanned ${firstParty.length} first-party files (the walk found the sources)`);
  const hits: string[] = [];
  for (const f of firstParty) {
    const raw = readFileSync(f, 'utf8');
    const r = rel(f);
    for (const mod of FORBIDDEN_MODULES) if (new RegExp(`(from\\s*|import\\s*\\(\\s*|require\\(\\s*)['"]${mod.replace(/[./]/g, (c) => `\\${c}`)}(/[^'"]*)?['"]`).test(raw)) hits.push(`${r}: imports ${mod}`);
    const allowed = new Set([...CRYPTO_OK, ...(CRYPTO_ALLOW[r] ?? [])]);
    for (const n of cryptoNames(raw)) if (!allowed.has(n)) hits.push(`${r}: node:crypto ${n}`);
    const code = stripComments(raw);
    if (CRYPTO_BAD_MEMBER.test(code)) hits.push(`${r}: ${CRYPTO_BAD_MEMBER.exec(code)![0]}`);
    const okIdents = IDENT_ALLOW[r] ?? [];
    for (const m of code.matchAll(new RegExp(BAD_IDENT.source, 'g'))) if (!okIdents.includes(m[0])) hits.push(`${r}: ${m[0]}`);
  }
  for (const f of vendor) { const m = VENDOR_BAD.exec(readFileSync(f, 'utf8')); if (m) hits.push(`${rel(f)} (vendored): ${m[0]}`); }
  assert.deepEqual(hits, [], `key / signing / sending code in the build:\n${hits.join('\n')}`);
  // the allow-list is real and minimal: tx-decode verifies with a PUBLIC key and never signs
  const td = readFileSync(join(PKGS, 'data', 'src', 'trade', 'tx-decode.ts'), 'utf8');
  assert.match(td, /import \{ createPublicKey, verify as edVerify \} from 'node:crypto';/);
  assert.doesNotMatch(stripComments(td), /createPrivateKey|\bsign\(|createSign/);
  const ev = readFileSync(join(PKGS, 'data', 'src', 'larp', 'evidence.ts'), 'utf8');
  for (const line of ev.split('\n').filter((l) => l.includes('signAllTransactions'))) assert.match(line, /^\s*\[\/.*signAllTransactions.*\/i, '/, 'evidence.ts names it only inside a detection regex');
});

test('1571 the built package (packages/cli/dist, when built) carries none of it either', () => {
  const dist = join(PKGS, 'cli', 'dist');
  if (!existsSync(dist) || !statSync(dist).isDirectory()) return; // built by `npm run build -w dexterm`; the source scan above covers what it is built from
  const hits: string[] = [];
  for (const f of walk(dist)) {
    if (!CODE.test(f)) continue;
    const src = readFileSync(f, 'utf8');
    const r = rel(f);
    if (r.includes('/vendor/')) { const m = VENDOR_BAD.exec(src); if (m) hits.push(`${r}: ${m[0]}`); continue; }
    for (const mod of FORBIDDEN_MODULES) if (src.includes(`'${mod}'`) || src.includes(`"${mod}"`)) hits.push(`${r}: ${mod}`);
    const code = stripComments(src);
    const okIdents = IDENT_ALLOW[r.replace('packages/cli/dist/', '').replace(/\.js$/, '.ts')] ?? [];
    for (const m of code.matchAll(new RegExp(BAD_IDENT.source, 'g'))) if (!okIdents.includes(m[0])) hits.push(`${r}: ${m[0]}`);
    const cm = CRYPTO_BAD_MEMBER.exec(code);
    if (cm) hits.push(`${r}: ${cm[0]}`);
  }
  assert.deepEqual(hits, [], hits.join('\n'));
});
