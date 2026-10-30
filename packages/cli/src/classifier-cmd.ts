// task-1822: `dexterm classifier …`: pick and manage the classification model (Kev local, hosted Jev with your own
// key, JEV students, LLM baselines, or the built-in heuristic). Outputs are model estimates, never advice.
// Nothing downloads without a typed yes (or --yes) for that model; nothing calls the network without a key/consent.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {
  CATALOG, COIN_RISK, EXTERNAL_MODELS, PROVIDERS, PROVIDER_IDS, catalogEntry, classify, classifyBatch, coinDossier, describeHardware,
  describeResult, detectHardware, dextermHome, fits, freeBytes, fromReasonRunner, gb, isInstalled, loadClassifierConfig, modelPath, modelsDir,
  providerFromConfig, pullModel, readTypesafeKey, recommendTier, removeTypesafeKey, saveClassifierConfig, serveArgv, writeTypesafeKey,
  type ClassifierConfig, type FetchLike, type ProviderId, type RegistryDeps,
} from '@dexterm/classifier';
import { spawnClaudeRunner } from '@dexterm/packs';

export interface ClassifierIo {
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  stdout: NodeJS.WritableStream & { isTTY?: boolean };
  stderr: NodeJS.WritableStream;
  env: NodeJS.ProcessEnv;
  /** Test seams. */
  fetch?: FetchLike;
  exec?: (cmd: string, args: string[]) => Promise<string>;
  pullFetch?: Parameters<typeof pullModel>[1]['fetch'];
  free?: (dir: string) => number;
}

export const CLASSIFIER_USAGE = `dexterm classifier [<command>]
  list                      providers, local models (installed / size / licence / fits this machine) and the current pick
  pick <provider> [model]   heuristic | kev-local [kev-0.8b-q8|kev-4b-q4|…] | jev-hosted | jev-open | claude | ollama-llm
  pull <model> [--yes]      download a Kev GGUF (shows size + source, asks first, checks disk, verifies sha256)
  serve [--model M] [--port P] [--threads N]   run llama-server for the picked Kev model on 127.0.0.1 (foreground)
  doctor [--json]           hardware (RAM, CPU, GPU/VRAM), the recommended tier, provider readiness
  bench [--n 20]            time the current provider on N synthetic coins (latency per coin, per 1,000)
  try                       classify one example coin with the current provider (shows the labelled estimate)
  key set|clear|status      your own TypeSafe API key for hosted Jev (stored 0600 under ~/.dexterm/keys, never printed)
Every answer is a model estimate with the model id and a calibration note; never advice. Docs: /docs/classifier/`;

function flags(argv: string[], bools: string[]): { pos: string[]; opts: Record<string, string | true> } {
  const pos: string[] = []; const opts: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); if (bools.includes(k) || i + 1 >= argv.length) opts[k] = true; else opts[k] = argv[++i]; }
    else pos.push(a);
  }
  return { pos, opts };
}

async function ask(io: ClassifierIo, question: string): Promise<string> {
  if (!io.stdin.isTTY) return '';
  const rl = readline.createInterface({ input: io.stdin, output: io.stdout });
  try { return await new Promise<string>((r) => rl.question(question, r)); } finally { rl.close(); }
}

/** Read a secret from the TTY without echoing it. Non-TTY: read one line from stdin (for `… | dexterm classifier key set`). */
async function readSecret(io: ClassifierIo, prompt: string): Promise<string> {
  if (!io.stdin.isTTY) {
    let s = '';
    for await (const c of io.stdin as AsyncIterable<Buffer | string>) { s += c.toString(); if (s.includes('\n')) break; }
    return s.split('\n')[0];
  }
  io.stdout.write(prompt);
  const stdin = io.stdin as NodeJS.ReadStream;
  stdin.setRawMode?.(true);
  stdin.resume();
  return await new Promise<string>((resolve) => {
    let s = '';
    const on = (b: Buffer) => {
      for (const ch of b.toString('utf8')) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') { stdin.off('data', on); stdin.setRawMode?.(false); stdin.pause(); io.stdout.write('\n'); resolve(s); return; }
        if (ch === '\u0003') { stdin.off('data', on); stdin.setRawMode?.(false); stdin.pause(); io.stdout.write('\n'); resolve(''); return; }
        if (ch === '\u007f') s = s.slice(0, -1); else s += ch;
      }
    };
    stdin.on('data', on);
  });
}

function deps(c: ClassifierConfig, io: ClassifierIo): RegistryDeps {
  return { env: io.env, fetch: io.fetch, claudeRunner: fromReasonRunner(spawnClaudeRunner, c.llm.claudeModel) };
}

/** Where llama-server is: $DEXTERM_LLAMA_SERVER, else on PATH. */
export function llamaServerBin(env: NodeJS.ProcessEnv): string | null {
  if (env.DEXTERM_LLAMA_SERVER && fs.existsSync(env.DEXTERM_LLAMA_SERVER)) return env.DEXTERM_LLAMA_SERVER;
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    const p = path.join(dir, 'llama-server');
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ }
  }
  return null;
}

/**
 * Does this llama-server serve decision models (`/v1/systemone`, llama.cpp PR #29818, 2026-10-02)? Older builds (e.g.
 * Homebrew's 0.4.1) start fine and then 404 every request, so `serve` and `doctor` check the help text first.
 */
export async function llamaSupportsDecisions(bin: string, exec?: ClassifierIo['exec']): Promise<boolean> {
  const run = exec ?? ((cmd: string, args: string[]) => new Promise<string>((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const t = setTimeout(() => child.kill('SIGKILL'), 8000);
    child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (out += d));
    child.on('error', () => { clearTimeout(t); resolve(''); });
    child.on('close', () => { clearTimeout(t); resolve(out); });
  }));
  try { return /decision/i.test(await run(bin, ['--help'])); } catch { return false; }
}

const LLAMA_TOO_OLD = 'this llama-server has no /v1/systemone (decision models need a llama.cpp build from 2026-10-02 or later): update llama.cpp, or point DEXTERM_LLAMA_SERVER at a newer llama-server';

export async function classifierCommand(argv: string[], io: ClassifierIo): Promise<number> {
  const out = (s: string) => io.stdout.write(s + '\n');
  const err = (s: string) => io.stderr.write(s + '\n');
  const loaded = loadClassifierConfig(io.env);
  for (const e of loaded.errors) err(`classifier.json: ${e}`);
  const c = loaded.config;
  const home = dextermHome(io.env);
  const sub = argv[0] ?? 'list';
  const { pos, opts } = flags(argv.slice(1), ['yes', 'json']);

  if (sub === 'help' || sub === '--help' || sub === '-h') { out(CLASSIFIER_USAGE); return 0; }

  if (sub === 'list') {
    const hw = await detectHardware({ exec: io.exec });
    out(`current: ${c.provider}${c.provider === 'kev-local' ? ` (${c.kev.model})` : ''} · shipped default model: ${c.default}`);
    out('\nproviders:');
    for (const p of PROVIDERS) out(`  ${p.id.padEnd(11)} ${p.title}  [network: ${p.network}; needs ${p.needs}]`);
    out('\nlocal models (llama.cpp GGUF, pinned revisions, sha256-verified):');
    for (const e of CATALOG) {
      const inst = isInstalled(home, e) ? 'installed' : 'not downloaded';
      out(`  ${e.id.padEnd(12)} ${gb(e.bytes).padStart(7)}  ${e.license}  ${inst.padEnd(14)} ${fits(e.id, hw) ? 'fits this machine' : 'too big for this machine'}  (${e.authorNote})`);
    }
    out('\nlisted, not pulled by dexterm:');
    for (const x of EXTERNAL_MODELS) out(`  ${x.id.padEnd(12)} ${x.repo} (${x.license}): ${x.note}`);
    return 0;
  }

  if (sub === 'pick') {
    const id = pos[0] as ProviderId | undefined;
    if (!id || !(PROVIDER_IDS as readonly string[]).includes(id)) { err(`pick one of: ${PROVIDER_IDS.join(', ')}`); return 2; }
    const next: ClassifierConfig = { ...c, provider: id };
    if (id === 'kev-local') {
      const model = pos[1] ?? c.kev.model;
      try { catalogEntry(model); } catch (e) { err((e as Error).message); return 2; }
      next.kev = { ...c.kev, model };
      if (!isInstalled(home, catalogEntry(model))) out(`note: ${model} is not downloaded yet: dexterm classifier pull ${model}. Until it is served, answers fall back to the heuristic.`);
    }
    if (id === 'jev-hosted' && !readTypesafeKey(io.env)) out('note: no TypeSafe key yet: dexterm classifier key set. Until then answers fall back to the heuristic.');
    const p = saveClassifierConfig(next, io.env);
    out(`classifier.provider = ${id}${id === 'kev-local' ? ` (${next.kev.model})` : ''}  (${p})`);
    return 0;
  }

  if (sub === 'pull') {
    const id = pos[0] ?? c.kev.model;
    let e;
    try { e = catalogEntry(id); } catch (x) { err((x as Error).message); return 2; }
    if (isInstalled(home, e)) { out(`${e.id} is already installed: ${modelPath(home, e)}`); return 0; }
    const free = (io.free ?? freeBytes)(modelsDir(home));
    out(`${e.title}: ${gb(e.bytes)} from huggingface.co/${e.repo} (revision ${e.revision.slice(0, 8)}, ${e.license}, base ${e.base})`);
    out(`to ${modelsDir(home)} · ${gb(free)} free · sha256 ${e.sha256.slice(0, 16)}… checked before use`);
    let yes = opts.yes === true;
    if (!yes) {
      const a = (await ask(io, 'Download it now? Type yes to continue: ')).trim().toLowerCase();
      yes = a === 'yes';
    }
    if (!yes) { out('not downloaded (no consent). Re-run with --yes to skip the question.'); return 1; }
    let lastPct = -1;
    try {
      const r = await pullModel(e.id, { home, consent: true, fetch: io.pullFetch, free: io.free, onProgress: (d, t) => { const pct = Math.floor((d / t) * 20) * 5; if (pct !== lastPct) { lastPct = pct; io.stdout.write(`\r  ${pct}%`); } } });
      io.stdout.write('\n');
      saveClassifierConfig({ ...c, consent: { ...c.consent, [e.id]: new Date().toISOString() } }, io.env);
      out(`verified ${r.sha256.slice(0, 16)}… → ${r.path}`);
      out(`next: dexterm classifier pick kev-local ${e.id} && dexterm classifier serve`);
      return 0;
    } catch (x) { io.stdout.write('\n'); err(`pull failed: ${(x as Error).message}`); return 1; }
  }

  if (sub === 'serve') {
    const id = typeof opts.model === 'string' ? opts.model : c.kev.model;
    let e;
    try { e = catalogEntry(id); } catch (x) { err((x as Error).message); return 2; }
    if (!isInstalled(home, e)) { err(`${id} is not downloaded: dexterm classifier pull ${id}`); return 1; }
    const bin = llamaServerBin(io.env);
    if (!bin) { err('llama-server not found. Install llama.cpp (a build with /v1/systemone, 2026-10-02 or later) or set DEXTERM_LLAMA_SERVER.'); return 1; }
    if (!(await llamaSupportsDecisions(bin, io.exec))) { err(LLAMA_TOO_OLD); return 1; }
    const port = Number(typeof opts.port === 'string' ? opts.port : new URL(c.kev.endpoint).port || 8031);
    const threads = typeof opts.threads === 'string' ? Number(opts.threads) : c.kev.threads ?? undefined;
    const args = serveArgv(e, modelPath(home, e), port, threads);
    out(`serving ${e.id} on http://127.0.0.1:${port} (Ctrl+C to stop): ${path.basename(bin)} ${args.join(' ')}`);
    return await new Promise<number>((resolve) => {
      const child = spawn(bin, args, { stdio: 'inherit' });
      child.on('error', (x) => { err(`llama-server: ${x.message}`); resolve(1); });
      child.on('close', (code) => resolve(code ?? 0));
    });
  }

  if (sub === 'doctor' || sub === 'status') {
    const hw = await detectHardware({ exec: io.exec });
    const rec = recommendTier(hw);
    let provStatus: { ready: boolean; detail: string };
    try { provStatus = await providerFromConfig(c, c.provider, deps(c, io)).status(); } catch (x) { provStatus = { ready: false, detail: (x as Error).message }; }
    const llama = llamaServerBin(io.env);
    const llamaOk = llama ? await llamaSupportsDecisions(llama, io.exec) : false;
    if (opts.json === true) {
      out(JSON.stringify({ hardware: hw, recommendation: rec, provider: c.provider, model: c.provider === 'kev-local' ? c.kev.model : null, ready: provStatus.ready, detail: provStatus.detail, llamaServer: Boolean(llama), llamaServerDecisions: llamaOk, typesafeKey: Boolean(readTypesafeKey(io.env)) }, null, 2));
      return 0;
    }
    out(`hardware: ${describeHardware(hw)}`);
    out(`recommended: ${rec.model ?? 'the built-in heuristic'}${rec.bestQuality ? ` (best quality here: ${rec.bestQuality})` : ''}: ${rec.why}`);
    out(`provider: ${c.provider}${c.provider === 'kev-local' ? ` (${c.kev.model})` : ''}: ${provStatus.ready ? 'ready' : 'not ready'}: ${provStatus.detail}`);
    out(`llama-server: ${!llama ? 'not found (needed for kev-local)' : llamaOk ? 'found, serves decision models' : `found but too old: ${LLAMA_TOO_OLD}`} · TypeSafe key: ${readTypesafeKey(io.env) ? 'configured' : 'none (hosted Jev is optional)'}`);
    if (c.fallback) out('fallback: the heuristic answers when the provider is unreachable (labelled as a fallback)');
    return 0;
  }

  if (sub === 'bench') {
    const n = Math.max(1, Math.min(500, Number(opts.n ?? 20) || 20));
    let provider;
    try { provider = providerFromConfig(c, c.provider, deps(c, io)); } catch (x) { err((x as Error).message); return 1; }
    const coins = Array.from({ length: n }, (_, i) => coinDossier({ mint: `Bench${String(i).padStart(4, '0')}`.padEnd(32, '1'), symbol: `B${i}`, age_min: 5 + i * 7, liquidity_usd: 2000 + i * 1500, mcap_usd: 9000 + i * 7000, holders: 50 + i * 20, top10_pct: 10 + (i % 40), mint_authority: i % 9 === 0, freeze_authority: i % 13 === 0 }));
    const r = await classifyBatch(provider, COIN_RISK, coins, { fallback: null });
    const ok = r.results.filter((x) => !('error' in x));
    const per = ok.length ? r.ms / ok.length : NaN;
    out(`${provider.id} ${provider.model()}: ${ok.length}/${n} answered in ${(r.ms / 1000).toFixed(1)} s · ${per.toFixed(0)} ms per coin · ~${((per * 1000) / 60_000).toFixed(1)} min per 1,000 coins (one at a time)`);
    const failed = r.results.find((x) => 'error' in x) as { error: string } | undefined;
    if (failed) err(`first failure: ${failed.error}`);
    return ok.length ? 0 : 1;
  }

  if (sub === 'key') {
    const action = pos[0] ?? 'status';
    if (action === 'status') { out(readTypesafeKey(io.env) ? 'TypeSafe key: configured (not shown)' : 'TypeSafe key: none'); return 0; }
    if (action === 'clear') { out(removeTypesafeKey(io.env) ? 'TypeSafe key removed' : 'no key file to remove'); return 0; }
    if (action === 'set') {
      const k = await readSecret(io, 'Paste your TypeSafe API key (input hidden): ');
      if (!k.trim()) { err('no key entered'); return 1; }
      try { const p = writeTypesafeKey(k, io.env); out(`saved to ${p} (0600). It is only sent to ${c.jev.endpoint}.`); return 0; } catch (x) { err((x as Error).message); return 1; }
    }
    err('key set|clear|status'); return 2;
  }

  if (sub === 'try') {
    // A one-off classification of a hand-written coin (no network unless the picked provider is remote).
    let provider;
    try { provider = providerFromConfig(c, c.provider, deps(c, io)); } catch (x) { err((x as Error).message); return 1; }
    const r = await classify(provider, COIN_RISK, coinDossier({ mint: 'Example11111111111111111111111111', symbol: 'EXMPL', liquidity_usd: 12000, mcap_usd: 40000, age_min: 20, holders: 300, top10_pct: 35, freeze_authority: false, mint_authority: false }), { fallback: c.fallback ? undefined : null });
    out(describeResult(r));
    return 0;
  }

  err(`unknown classifier command: ${sub}\n${CLASSIFIER_USAGE}`);
  return 2;
}

