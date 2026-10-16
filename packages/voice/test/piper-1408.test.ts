// task-1408: the Piper neural TTS engine, exercised against a FAKE piper binary and a FAKE player so
// the logic is deterministic on any platform with no audio device. This verifies the engine contract
// (text on stdin not argv, sanitise, single queue, synth-then-play, degrade when no player) — NOT real
// Piper audio, which is proven separately in Docker (see the task-1408 handoff).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'dexterm-piper-test-'));
const fakePiper = join(dir, 'fake-piper.mjs');
const fakePlayer = join(dir, 'fake-player.mjs');
const model = join(dir, 'en_GB-alan-medium.onnx');
const piperLog = join(dir, 'piper.jsonl');
const playerLog = join(dir, 'player.jsonl');

// Fake piper: reads text on stdin, writes a tiny valid WAV to --output_file, logs {argv, stdin}.
const FAKE_PIPER = `#!/usr/bin/env node
import { appendFileSync, writeFileSync, readFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const out = argv[argv.indexOf('--output_file') + 1];
let stdin = ''; try { stdin = readFileSync(0, 'utf8'); } catch {}
appendFileSync(process.env.PIPER_LOG, JSON.stringify({ argv, stdin }) + '\\n');
// Minimal 16-bit mono 8kHz WAV with a few non-zero samples.
const samples = 160, dataLen = samples * 2, buf = Buffer.alloc(44 + dataLen);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataLen, 4); buf.write('WAVE', 8);
buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
buf.writeUInt32LE(8000, 24); buf.writeUInt32LE(16000, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
buf.write('data', 36); buf.writeUInt32LE(dataLen, 40);
for (let i = 0; i < samples; i++) buf.writeInt16LE((i % 32) * 500, 44 + i * 2);
writeFileSync(out, buf);
process.exit(0);
`;

// Fake player: logs its argv, lives briefly, exits (so handle.done resolves on close).
const FAKE_PLAYER = `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.PLAYER_LOG, JSON.stringify({ argv: process.argv.slice(2) }) + '\\n');
const t = setTimeout(() => process.exit(0), 150);
process.on('SIGTERM', () => { clearTimeout(t); process.exit(143); });
`;

let PiperTts: typeof import('../src/tts/piper.ts').PiperTts;

before(async () => {
  for (const [p, src] of [[fakePiper, FAKE_PIPER], [fakePlayer, FAKE_PLAYER]] as const) {
    writeFileSync(p, src, { mode: 0o755 }); chmodSync(p, 0o755);
  }
  writeFileSync(model, 'fake onnx'); // availability only checks the file exists
  process.env.DEXTERM_PIPER_BIN = fakePiper;
  process.env.DEXTERM_AUDIO_PLAYER = fakePlayer;
  process.env.PIPER_LOG = piperLog;
  process.env.PLAYER_LOG = playerLog;
  ({ PiperTts } = await import('../src/tts/piper.ts'));
});

after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

const readLog = (f: string): Array<{ argv?: string[]; stdin?: string }> =>
  existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];

test('available() true with binary + model + player; false without a player', async () => {
  const tts = new PiperTts(model);
  assert.equal(await tts.available(), true);
  const save = process.env.DEXTERM_AUDIO_PLAYER;
  process.env.DEXTERM_AUDIO_PLAYER = join(dir, 'does-not-exist');
  assert.equal(await tts.available(), false, 'no player → cannot speak aloud');
  assert.equal(tts.canSynth(), true, 'but it can still synthesise to a file');
  process.env.DEXTERM_AUDIO_PLAYER = save;
});

test('listVoices is the model voice id; voiceName matches', async () => {
  const tts = new PiperTts(model);
  assert.deepEqual(await tts.listVoices(), ['en_GB-alan-medium']);
  assert.equal(tts.voiceName, 'en_GB-alan-medium');
});

test('synthToFile writes a non-empty WAV; text on stdin, never argv', async () => {
  writeFileSync(piperLog, '');
  const tts = new PiperTts(model);
  const out = join(dir, 'synth.wav');
  await tts.synthToFile('liquidity is thin', out);
  assert.ok(existsSync(out) && readFileSync(out).length > 44, 'a WAV with audio data');
  const { argv, stdin } = readLog(piperLog).at(-1)!;
  assert.ok(argv!.includes('--model') && argv!.includes('--output_file'));
  assert.ok(!argv!.some((a) => a.includes('liquidity')), 'text is not on argv');
  assert.equal(stdin!.trim(), 'liquidity is thin');
});

test('speak() synthesises then plays the WAV through the player; fires onFirstAudio', async () => {
  writeFileSync(piperLog, ''); writeFileSync(playerLog, '');
  const tts = new PiperTts(model);
  let firstAudio = false;
  const h = tts.speak('three new pairs passed', { onFirstAudio: () => { firstAudio = true; } });
  await h.done;
  const play = readLog(playerLog).at(-1)!;
  assert.ok(play.argv!.some((a) => a.endsWith('.wav')), 'the player was handed a WAV');
  assert.equal(firstAudio, true, 'onFirstAudio fired at player spawn');
});

test('sanitises [[ phoneme/command sequences before piper sees them', async () => {
  writeFileSync(piperLog, '');
  const tts = new PiperTts(model);
  await tts.speak('look [[slnc 5000]] here').done;
  const { stdin } = readLog(piperLog).at(-1)!;
  assert.ok(!stdin!.includes('[['), 'no [[ reaches piper');
});

test('no player → speak() degrades to text (resolves, no crash), synthToFile still works', async () => {
  const save = process.env.DEXTERM_AUDIO_PLAYER;
  process.env.DEXTERM_AUDIO_PLAYER = join(dir, 'nope');
  const tts = new PiperTts(model);
  await tts.speak('still fine').done; // must resolve, not throw
  process.env.DEXTERM_AUDIO_PLAYER = save;
  assert.ok(true);
});
