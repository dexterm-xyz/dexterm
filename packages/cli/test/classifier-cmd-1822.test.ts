// task-1822: `dexterm classifier …` end to end with a temp DEXTERM_HOME and injected seams (no network, no downloads).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import { classifierCommand, CLASSIFIER_USAGE, type ClassifierIo } from '../src/classifier-cmd.ts';

function io(home: string, input = '', over: Partial<ClassifierIo> = {}) {
  const stdin = new PassThrough(); stdin.end(input);
  let out = '', err = '';
  const stdout = new PassThrough(); stdout.on('data', (d) => (out += d));
  const stderr = new PassThrough(); stderr.on('data', (d) => (err += d));
  const x: ClassifierIo = { stdin, stdout, stderr, env: { DEXTERM_HOME: home, PATH: '' }, exec: async () => { throw new Error('no nvidia-smi'); }, ...over };
  return { io: x, out: () => out, err: () => err };
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dexterm-clf-cli-'));

describe('dexterm classifier', () => {
  it('help lists every subcommand', async () => {
    const t = io(tmp());
    assert.equal(await classifierCommand(['help'], t.io), 0);
    for (const w of ['list', 'pick', 'pull', 'serve', 'doctor', 'bench', 'try', 'key']) assert.match(t.out(), new RegExp(`\\b${w}\\b`));
    assert.equal(t.out().trim(), CLASSIFIER_USAGE);
  });
  it('list shows providers, catalog sizes + licences, and that nothing is installed', async () => {
    const t = io(tmp());
    assert.equal(await classifierCommand(['list'], t.io), 0);
    assert.match(t.out(), /current: heuristic/);
    assert.match(t.out(), /kev-4b-q4 +2\.8 GB +Apache-2\.0 +not downloaded/);
    assert.match(t.out(), /jev-hosted/);
    assert.match(t.out(), /jev-9b/);
  });
  it('pick writes classifier.provider and warns when the model is missing', async () => {
    const home = tmp();
    const t = io(home);
    assert.equal(await classifierCommand(['pick', 'kev-local', 'kev-4b-q4'], t.io), 0);
    assert.match(t.out(), /not downloaded yet/);
    const c = JSON.parse(fs.readFileSync(path.join(home, 'classifier.json'), 'utf8'));
    assert.equal(c.provider, 'kev-local');
    assert.equal(c.kev.model, 'kev-4b-q4');
    const bad = io(home);
    assert.equal(await classifierCommand(['pick', 'gpt-9'], bad.io), 2);
    assert.equal(await classifierCommand(['pick', 'kev-local', 'kev-99b'], bad.io), 2);
  });
  it('pull without a typed yes downloads nothing', async () => {
    const home = tmp();
    let fetched = false;
    const t = io(home, '', { pullFetch: async () => { fetched = true; return { status: 200, body: null }; }, free: () => 1e12 });
    assert.equal(await classifierCommand(['pull', 'kev-0.8b-q8'], t.io), 1);
    assert.match(t.out(), /0\.8 GB from huggingface\.co\/ggml-org\/Kev-0\.8B-GGUF/);
    assert.match(t.out(), /no consent/);
    assert.equal(fetched, false);
  });
  it('pull --yes with a tampered body fails the checksum and leaves no file', async () => {
    const home = tmp();
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([1, 2, 3])); c.close(); } });
    const t = io(home, '', { pullFetch: async () => ({ status: 200, body }), free: () => 1e12 });
    assert.equal(await classifierCommand(['pull', 'kev-0.8b-q8', '--yes'], t.io), 1);
    assert.match(t.err(), /checksum mismatch/);
    assert.deepEqual(fs.readdirSync(path.join(home, 'models')), []);
  });
  it('pull refuses when the disk is too full', async () => {
    const t = io(tmp(), '', { free: () => 1e9, pullFetch: async () => { throw new Error('must not fetch'); } });
    assert.equal(await classifierCommand(['pull', 'kev-4b-q4', '--yes'], t.io), 1);
    assert.match(t.err(), /not enough disk/);
  });
  it('serve explains what is missing instead of failing obscurely', async () => {
    const t = io(tmp());
    assert.equal(await classifierCommand(['serve'], t.io), 1);
    assert.match(t.err(), /not downloaded/);
  });
  it('doctor --json reports hardware, a recommendation and readiness (no key leaked)', async () => {
    const home = tmp();
    const t = io(home, '', { exec: async () => 'NVIDIA GeForce RTX 4080, 16376\n' });
    assert.equal(await classifierCommand(['doctor', '--json'], t.io), 0);
    const j = JSON.parse(t.out());
    assert.equal(j.recommendation.tier, 'gpu-large');
    assert.equal(j.provider, 'heuristic');
    assert.equal(j.ready, true);
    assert.equal(j.typesafeKey, false);
  });
  it('key set reads stdin, stores it 0600, never prints it; status and clear work', async () => {
    const home = tmp();
    const t = io(home, 'ts_cli_test_key_987654321\n');
    assert.equal(await classifierCommand(['key', 'set'], t.io), 0);
    const p = path.join(home, 'keys', 'typesafe');
    assert.equal(fs.statSync(p).mode & 0o777, 0o600);
    assert.ok(!t.out().includes('ts_cli_test_key') && !t.err().includes('ts_cli_test_key'));
    const s = io(home);
    await classifierCommand(['key', 'status'], s.io);
    assert.match(s.out(), /configured \(not shown\)/);
    const c = io(home);
    await classifierCommand(['key', 'clear'], c.io);
    assert.equal(fs.existsSync(p), false);
  });
  it('bench and try run on the heuristic offline and label the estimate', async () => {
    const t = io(tmp());
    assert.equal(await classifierCommand(['bench', '--n', '5'], t.io), 0);
    assert.match(t.out(), /heuristic heuristic-h1\+larp: 5\/5 answered/);
    const u = io(tmp());
    assert.equal(await classifierCommand(['try'], u.io), 0);
    assert.match(u.out(), /^model estimate \(heuristic heuristic-h1\+larp/);
  });
  it('a picked local model that is not served falls back to the heuristic in `try`, and says so', async () => {
    const home = tmp();
    fs.writeFileSync(path.join(home, 'classifier.json'), JSON.stringify({ provider: 'kev-local', kev: { endpoint: 'http://127.0.0.1:9', model: 'kev-0.8b-q8' } }));
    const t = io(home);
    assert.equal(await classifierCommand(['try'], t.io), 0);
    assert.match(t.out(), /fallback from kev-local/);
  });
  it('an old llama-server without /v1/systemone is reported, and serve refuses it', async () => {
    const home = tmp();
    const bin = path.join(home, 'llama-server');
    fs.writeFileSync(bin, '#!/bin/sh\necho old\n', { mode: 0o755 });
    fs.mkdirSync(path.join(home, 'models'));
    // a fake installed model: right size via a sparse file
    const fd = fs.openSync(path.join(home, 'models', 'Kev-0.8B-Q8_0.gguf'), 'w'); fs.ftruncateSync(fd, 812_406_304); fs.closeSync(fd);
    const old = io(home, '', { env: { DEXTERM_HOME: home, PATH: '', DEXTERM_LLAMA_SERVER: bin }, exec: async (cmd, args) => { if (cmd === 'nvidia-smi') throw new Error('no'); assert.deepEqual(args, ['--help']); return 'usage: llama-server [options]'; } });
    assert.equal(await classifierCommand(['serve', '--model', 'kev-0.8b-q8'], old.io), 1);
    assert.match(old.err(), /no \/v1\/systemone/);
    const doc = io(home, '', { env: { DEXTERM_HOME: home, PATH: '', DEXTERM_LLAMA_SERVER: bin }, exec: async (cmd) => { if (cmd === 'nvidia-smi') throw new Error('no'); return '--cache-ram N  (0 for decision models)'; } });
    await classifierCommand(['doctor'], doc.io);
    assert.match(doc.out(), /found, serves decision models/);
  });
  it('unknown subcommand exits 2 with usage', async () => {
    const t = io(tmp());
    assert.equal(await classifierCommand(['frobnicate'], t.io), 2);
    assert.match(t.err(), /unknown classifier command/);
  });
});

describe('dexterm doctor classifier line', async () => {
  const { classifierCheck, runDoctor } = await import('../src/doctor.ts');
  const base = { hardware: 'darwin/x64, Test CPU (12 threads), 64 GB RAM, no GPU detected', recommended: 'kev-0.8b-q8', bestQuality: 'kev-4b-q4', why: 'CPU only', provider: 'heuristic', model: 'heuristic-h1+larp', ready: true, detail: '' };
  it('passes on the built-in scores and states the tier', () => {
    const c = classifierCheck(base);
    assert.equal(c.status, 'pass');
    assert.match(c.detail, /recommended model here: kev-0\.8b-q8 \(best quality: kev-4b-q4\)/);
  });
  it('warns (never fails) when a picked local model is not served, with the fix', () => {
    const c = classifierCheck({ ...base, provider: 'kev-local', model: 'kev-4b-q4', ready: false, detail: 'no llama-server' });
    assert.equal(c.status, 'warn');
    assert.match(c.fix!, /classifier pull kev-4b-q4/);
  });
  it('runDoctor includes the line when the probe is wired', async () => {
    const r = await runDoctor({ env: {}, isTTY: false, nodeVersion: '24.0.0', platform: 'darwin', claude: async () => 'ok', probe: async () => ({ ok: true, status: 200, ms: 1 }) as never, checkWritable: () => null, offline: true, classifier: async () => base } as never);
    assert.ok(r.checks.some((c: { name: string }) => c.name === 'Classification model (experimental)'));
  });
});
