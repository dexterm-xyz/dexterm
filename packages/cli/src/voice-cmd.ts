// `dexterm voice …` (task-1408): inspect the voice engines on this machine and download the two
// optional voice models — whisper.cpp base.en (speech-in) and the Piper en_GB-alan-medium voice
// (neural speech-out). Downloads are OFF by default: this is the ONLY place dexterm fetches a model,
// it asks before it does, and it verifies the download against a pinned checksum from the official
// source. Nothing here runs the signer, touches keys, or changes trading behaviour.
//
// No new dependencies: the confirm prompt is node:readline, the download uses global fetch, and the
// checksum/stream logic lives in @dexterm/voice (unit-tested with an injected fetch).

import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { modelRegistry, downloadModel, modelStatus, resolvePiperBin, pickPlayer, PIPER_MODEL, DEFAULT_PIPER_VOICE, type ModelSpec } from '@dexterm/voice';
import { dextermHome } from '@dexterm/custom';

export interface VoiceCmdIo {
  stdin: NodeJS.ReadStream & { isTTY?: boolean };
  stdout: { write(s: string): unknown };
  stderr: { write(s: string): unknown };
  env: NodeJS.ProcessEnv;
}

export const VOICE_USAGE = [
  'usage:',
  '  dexterm voice [status]                 show the voice engines + which models are installed',
  '  dexterm voice download <model> [--yes] download a voice model (asks first; checksum-verified)',
  '',
  '  models: whisper        whisper.cpp base.en  (speech-to-text, off macOS this is the default)',
  '          piper-voice    Piper en_GB-alan-medium (neural speech-out, preferred over espeak-ng)',
  '          all            both of the above',
].join('\n');

function onPath(bin: string, env: NodeJS.ProcessEnv): boolean {
  const sep = process.platform === 'win32' ? ';' : ':';
  for (const p of (env.PATH ?? '').split(sep)) {
    if (p && existsSync(join(p, bin))) return true;
  }
  return false;
}

/** y/N prompt on a TTY. Without a TTY (piped/CI) it returns false — the caller tells the user to pass --yes. */
function askYesNo(io: VoiceCmdIo, question: string): Promise<boolean> {
  if (!io.stdin.isTTY) return Promise.resolve(false);
  const rl = createInterface({ input: io.stdin, output: io.stdout as NodeJS.WritableStream });
  return new Promise((resolve) => {
    rl.question(`${question} [y/N] `, (ans) => { rl.close(); resolve(/^y(es)?$/i.test(ans.trim())); });
  });
}

async function printStatus(io: VoiceCmdIo): Promise<number> {
  const home = dextermHome(io.env);
  const reg = modelRegistry(home);
  const lines: string[] = ['dexterm voice', ''];

  if (process.platform === 'darwin') {
    lines.push('  speech-out  macOS `say` (built-in) · see `dexterm doctor` for the resolved voice');
    lines.push('  speech-in   Apple Speech (swiftc) preferred, else whisper.cpp');
  } else {
    const piperBin = resolvePiperBin();
    const player = pickPlayer();
    const piperReady = piperBin !== null && existsSync(PIPER_MODEL) && player !== null;
    lines.push(`  speech-out  Piper ${piperReady ? `ready (${DEFAULT_PIPER_VOICE}, plays via ${player})` : 'not ready'}${piperReady ? '' : ` · espeak-ng ${onPath('espeak-ng', io.env) || onPath('espeak', io.env) ? 'ready (baseline)' : 'not installed'}`}`);
    lines.push(`  speech-in   whisper.cpp (default off macOS) · mic tool ${['arecord', 'sox', 'rec', 'ffmpeg'].find((b) => onPath(b, io.env)) ?? 'none found'}`);
  }

  lines.push('', '  models:');
  for (const spec of Object.values(reg)) {
    const st = await modelStatus(spec);
    lines.push(`    ${st.installed ? '✓' : '·'} ${spec.id.padEnd(12)} ${spec.label}${st.installed ? ' (installed)' : ''}`);
  }
  lines.push('', `  download a model: dexterm voice download <whisper|piper-voice|all>`);
  io.stdout.write(lines.join('\n') + '\n');
  return 0;
}

async function runDownload(io: VoiceCmdIo, which: string, yes: boolean): Promise<number> {
  const home = dextermHome(io.env);
  const reg = modelRegistry(home);
  const ids = which === 'all' ? Object.keys(reg) : [which];
  const specs: ModelSpec[] = [];
  for (const id of ids) {
    const spec = reg[id];
    if (!spec) { io.stderr.write(`dexterm voice: unknown model ${JSON.stringify(id)}\n${VOICE_USAGE}\n`); return 2; }
    specs.push(spec);
  }
  if (!yes && !io.stdin.isTTY) {
    io.stderr.write('dexterm voice download: no interactive terminal to confirm; re-run with --yes to approve the download.\n');
    return 2;
  }

  let anyFailed = false;
  for (const spec of specs) {
    try {
      const res = await downloadModel(spec, {
        confirm: (prompt) => (yes ? Promise.resolve(true) : askYesNo(io, `\n${prompt}`)),
        log: (s) => io.stdout.write(s + '\n'),
      });
      if (res.status === 'cancelled') return 1; // the user said no — stop here
    } catch (e) {
      io.stderr.write(`dexterm voice download ${spec.id}: ${(e as Error).message}\n`);
      anyFailed = true;
    }
  }
  return anyFailed ? 1 : 0;
}

/** `dexterm voice …`. Returns the process exit code. */
export async function voiceCommand(argv: string[], io: VoiceCmdIo): Promise<number> {
  const yes = argv.includes('--yes') || argv.includes('-y');
  const rest = argv.filter((a) => a !== '--yes' && a !== '-y');
  const sub = rest[0];

  if (sub === undefined || sub === 'status') return printStatus(io);
  if (sub === 'download') {
    const which = rest[1];
    if (!which) { io.stderr.write(`dexterm voice download: name a model.\n${VOICE_USAGE}\n`); return 2; }
    return runDownload(io, which, yes);
  }
  if (sub === '--help' || sub === '-h' || sub === 'help') { io.stdout.write(VOICE_USAGE + '\n'); return 0; }
  io.stderr.write(`dexterm voice: unknown subcommand ${JSON.stringify(sub)}\n${VOICE_USAGE}\n`);
  return 2;
}
