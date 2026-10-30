// task-1893: the publish build rewrites bare @dexterm/* imports with one regex; a package export the regex cannot match
// (a hyphen in `@dexterm/autotrade/strategy-stats`) stopped `npm pack` while typecheck and the suite stayed green.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('the publish build rewrite matches every workspace package export', () => {
  const src = fs.readFileSync(path.join(ROOT, 'packages/cli/scripts/build-dist.mjs'), 'utf8');
  const m = src.match(/\(@dexterm\\\/[^\n]*?\)\\2\/g/);
  assert.ok(m, 'build-dist.mjs rewrite regex not found');
  const re = new RegExp(`^${m[0].slice(0, -'\\2/g'.length).replace(/\\\//g, '/')}$`);
  const pkgs = path.join(ROOT, 'packages');
  let seen = 0;
  for (const d of fs.readdirSync(pkgs)) {
    const f = path.join(pkgs, d, 'package.json');
    if (!fs.existsSync(f)) continue;
    const pj = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!pj.name?.startsWith('@dexterm/') || !pj.exports) continue;
    for (const sub of Object.keys(pj.exports)) {
      const spec = sub === '.' ? pj.name : `${pj.name}/${sub.replace(/^\.\//, '')}`;
      assert.match(spec, re, `${spec} would stay unresolved in the published package`);
      seen++;
    }
  }
  assert.ok(seen > 5, `only ${seen} exports seen`);
});
