// task-1406: the `dexterm spectate` CLI — replay a saved session into the follow-mode screen model +
// activity panel, and show the live stream endpoint. Hermetic: a temp file, no network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpectatorHub, SpectatorRecorder } from '@dexterm/agents';
import { runSpectate } from '../src/spectate-cmd.ts';
import type { Io } from '../src/main.ts';

function io(env: NodeJS.ProcessEnv = {}): Io & { out: string; err: string } {
  const o = {
    out: '', err: '', env,
    stdin: undefined as unknown as Io['stdin'],
    stdout: { write(s: string) { (o as { out: string }).out += s; return true; } } as unknown as Io['stdout'],
    stderr: { write(s: string) { (o as { err: string }).err += s; return true; } } as unknown as Io['stderr'],
  };
  return o as Io & { out: string; err: string };
}

const MINT = 'FixtMintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function writeRecording(file: string): void {
  const hub = new SpectatorHub();
  const rec = new SpectatorRecorder({ path: file, note: 'test' }).attach(hub);
  hub.emit({ phase: 'connect', agent: 'scanbot', tier: 'observe' });
  hub.emit({ phase: 'nav', agent: 'scanbot', tool: 'open_token', summary: `open ${MINT}`, nav: { screen: 'token', mint: MINT } });
  hub.emit({ phase: 'result', agent: 'scanbot', tool: 'rugcheck', summary: 'rugcheck', ms: 5, dataAgeSec: 3 });
  rec.stop();
}

test('spectate --replay folds a saved session into the screen + activity (redacted)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spectate-'));
  const file = join(dir, 's.jsonl');
  try {
    writeRecording(file);
    const a = io();
    assert.equal(await runSpectate(['--replay', file], a), 0);
    assert.match(a.out, /SCREEN/);
    assert.match(a.out, /screen token/);
    assert.match(a.out, /Fixt…AAAA/, 'the replayed screen shows the redacted mint');
    assert.ok(!a.out.includes(MINT), 'the full address never appears');
    assert.match(a.out, /\[agent\] scanbot/);
    assert.match(a.out, /rugcheck/);
    assert.match(a.out, /3s old/, 'the data age is shown');

    const j = io();
    assert.equal(await runSpectate(['--replay', file, '--json'], j), 0);
    const parsed = JSON.parse(j.out);
    assert.equal(parsed.view.screen.screen, 'token');
    assert.equal(parsed.meta.redacted, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('spectate --info reports the live endpoint, or says there is none', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spectate-info-'));
  try {
    const none = io({ DEXTERM_HOME: dir });
    assert.equal(await runSpectate(['--info'], none), 1);
    assert.match(none.err, /no live spectator stream/);

    writeFileSync(join(dir, 'spectator.json'), JSON.stringify({ protocol: 'dexterm-spectator/1', port: 49999, token: 'secret', pid: 1, startedAt: 1 }));
    const live = io({ DEXTERM_HOME: dir });
    assert.equal(await runSpectate(['--info'], live), 0);
    assert.match(live.out, /ws:\/\/127\.0\.0\.1:49999/);
    assert.ok(!live.out.includes('secret'), 'the token is never printed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('spectate with no args prints usage', async () => {
  const a = io();
  assert.equal(await runSpectate([], a), 0);
  assert.match(a.out, /dexterm spectate/);
});
