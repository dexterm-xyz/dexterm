#!/usr/bin/env node
// dexterm bin shim. Runs the TypeScript sources directly via Node's built-in type stripping
// (Node >= 22.18 / 23.6+ / 24). This is the checkout/source-tarball entry; the npm package's bin is
// the compiled copy at dist/packages/cli/bin/dexterm.mjs, built by scripts/build-dist.mjs (task-1346).
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  process.stderr.write(`dexterm needs Node 22.18 or newer (found ${process.versions.node})\n`);
  process.exit(1);
}
const { main } = await import('../src/main.ts');
process.exitCode = await main(process.argv.slice(2));
