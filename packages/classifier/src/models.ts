// Model manager (task-1822): the catalog of local decision models dexterm knows how to run, and a download that
// needs EXPLICIT consent, checks free disk first, pins the Hub revision, verifies the sha256 while streaming and only
// then renames the file into place. Nothing downloads lazily without the user saying yes for that model id.
//
// Catalog facts were read from the Hugging Face API on 2026-10-28 (file sizes, LFS sha256, repo revision, licence).

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ClassifierError } from './types.ts';

export interface CatalogEntry {
  id: string;
  family: 'kev' | 'jev-open';
  title: string;
  /** Hugging Face repo + pinned revision + file. */
  repo: string;
  revision: string;
  file: string;
  bytes: number;
  sha256: string;
  license: string;
  /** Source model the GGUF was converted from. */
  base: string;
  /** Estimated resident memory when served (file size + ~0.5 GB of context/compute buffers), GB. The benchmark report has measured values for the models it ran. */
  memGb: number;
  runtime: 'llama-server' | 'vllm';
  /** Author-reported numbers, quoted as such (never measured by dexterm). */
  authorNote: string;
}

const KEV_NOTE = 'author numbers on general text (Kev 1.0 cards), not memecoins';

export const CATALOG: readonly CatalogEntry[] = [
  { id: 'kev-0.8b-q8', family: 'kev', title: 'Kev 0.8B (Q8_0)', repo: 'ggml-org/Kev-0.8B-GGUF', revision: '9231cb757e3320120077e42e52371971968f008d', file: 'Kev-0.8B-Q8_0.gguf', bytes: 812_406_304, sha256: '27278f34eb3273bceea4c053dc50dd61a5161da21a718c4aacdf8fd5830771d0', license: 'Apache-2.0', base: 'jaredpalmer/kev-0.8b', memGb: 1.4, runtime: 'llama-server', authorNote: `~69.7% out-of-domain (${KEV_NOTE}); NOT recommended: near chance on dexterm's labelled history (task-1822)` },
  { id: 'kev-4b-q4', family: 'kev', title: 'Kev 4B (Q4_K_M)', repo: 'ggml-org/Kev-4B-GGUF', revision: 'f4624b6bb7072f1bab726a622c1cad3f96030b9e', file: 'Kev-4B-Q4_K_M.gguf', bytes: 3_033_489_824, sha256: '33ae6b18926502b2209a1bf7d3b61a350d65938441515c686bb87d226a19eff9', license: 'Apache-2.0', base: 'jaredpalmer/kev-4b', memGb: 3.8, runtime: 'llama-server', authorNote: `~83.8% out-of-domain (${KEV_NOTE})` },
  { id: 'kev-4b-q8', family: 'kev', title: 'Kev 4B (Q8_0)', repo: 'ggml-org/Kev-4B-GGUF', revision: 'f4624b6bb7072f1bab726a622c1cad3f96030b9e', file: 'Kev-4B-Q8_0.gguf', bytes: 4_483_801_504, sha256: '7c2ebed90560522c2801389db482ac1dc4c36d828f201f6074c1d60e433948da', license: 'Apache-2.0', base: 'jaredpalmer/kev-4b', memGb: 5.2, runtime: 'llama-server', authorNote: `~83.8% out-of-domain (${KEV_NOTE})` },
  { id: 'kev-9b-q4', family: 'kev', title: 'Kev 9B (Q4_K_M)', repo: 'ggml-org/Kev-9B-GGUF', revision: '6927aa248a75f163aa8fc46260f7cad718d1565b', file: 'Kev-9B-Q4_K_M.gguf', bytes: 6_358_923_744, sha256: '86a6084984a6ef6818eb12c07cdc67ed3c47b00208d41a8816c64301bc6bcbda', license: 'Apache-2.0', base: 'jaredpalmer/kev-9b', memGb: 7.5, runtime: 'llama-server', authorNote: `${KEV_NOTE}; on dexterm's labelled history (task-1883, RTX 4080) no better than kev-4b-q4 and tied the built-in scores on held-out` },
  { id: 'kev-9b-q8', family: 'kev', title: 'Kev 9B (Q8_0)', repo: 'ggml-org/Kev-9B-GGUF', revision: '6927aa248a75f163aa8fc46260f7cad718d1565b', file: 'Kev-9B-Q8_0.gguf', bytes: 9_529_735_648, sha256: 'd30b225bfdc985d1856bb04a990be76008d0cf40dccbf78938e3069744bc614c', license: 'Apache-2.0', base: 'jaredpalmer/kev-9b', memGb: 10.8, runtime: 'llama-server', authorNote: KEV_NOTE },
];

/** Models we list but cannot pull as one GGUF (served by vLLM from the full repo). */
export const EXTERNAL_MODELS: ReadonlyArray<{ id: string; repo: string; revision: string; license: string; note: string }> = [
  { id: 'jev-9b', repo: 'autotrust/JEV-9B', revision: '7ac669b8fb476ba926491e3d1c39f9330d68dbed', license: 'Apache-2.0', note: 'vLLM + decision LoRA, ~18 GB bf16: needs a >= 24 GB GPU unquantized; provider jev-open' },
  { id: 'jev-27b', repo: 'autotrust/JEV-27B', revision: '14b425269ed24452e0a5ad5a8f3e51d139647a88', license: 'Apache-2.0', note: 'vLLM, ~54 GB bf16: data-centre GPU; provider jev-open' },
  { id: 'kev-27b', repo: 'jaredpalmer/kev-27b', revision: 'main', license: 'Apache-2.0', note: 'full-weight model, no ggml-org GGUF published (2026-10-28); serve with the Kev repo' },
];

export function catalogEntry(id: string): CatalogEntry {
  const e = CATALOG.find((c) => c.id === id);
  if (!e) throw new ClassifierError('invalid', `unknown model ${JSON.stringify(id)}; known: ${CATALOG.map((c) => c.id).join(', ')}`);
  return e;
}

export const downloadUrl = (e: CatalogEntry): string => `https://huggingface.co/${e.repo}/resolve/${e.revision}/${e.file}`;

export const modelsDir = (home: string): string => path.join(home, 'models');
export const modelPath = (home: string, e: CatalogEntry): string => path.join(modelsDir(home), e.file);

export function isInstalled(home: string, e: CatalogEntry): boolean {
  try { return fs.statSync(modelPath(home, e)).size === e.bytes; } catch { return false; }
}

/** Free bytes on the filesystem holding `dir` (walks up to the nearest existing parent). */
export function freeBytes(dir: string): number {
  let d = dir;
  while (!fs.existsSync(d) && path.dirname(d) !== d) d = path.dirname(d);
  const s = fs.statfsSync(d);
  return s.bavail * s.bsize;
}

/** Keep this much free after a download. */
export const DISK_MARGIN_BYTES = 2 * 1024 ** 3;

export interface PullOpts {
  home: string;
  /** Must be true: the CLI sets it only after the user typed yes (or passed --yes) for THIS model. */
  consent: boolean;
  fetch?: (url: string) => Promise<{ status: number; body: ReadableStream<Uint8Array> | null }>;
  free?: (dir: string) => number;
  onProgress?: (done: number, total: number) => void;
  /** Test hooks: override the URL / the catalog entry. */
  url?: string;
  entry?: CatalogEntry;
}

export async function pullModel(id: string, o: PullOpts): Promise<{ path: string; sha256: string; bytes: number; skipped: boolean }> {
  const e = o.entry ?? catalogEntry(id);
  const dest = modelPath(o.home, e);
  if (isInstalled(o.home, e)) return { path: dest, sha256: e.sha256, bytes: e.bytes, skipped: true };
  if (!o.consent) throw new ClassifierError('consent', `downloading ${e.title} (${gb(e.bytes)}) from ${e.repo} needs your consent`);
  const free = (o.free ?? freeBytes)(modelsDir(o.home));
  if (free < e.bytes + DISK_MARGIN_BYTES) throw new ClassifierError('not_ready', `not enough disk: ${gb(e.bytes)} needed + ${gb(DISK_MARGIN_BYTES)} margin, ${gb(free)} free`);
  fs.mkdirSync(modelsDir(o.home), { recursive: true, mode: 0o700 });
  const part = `${dest}.part`;
  const f = o.fetch ?? (async (u: string) => { const r = await fetch(u, { redirect: 'follow' }); return { status: r.status, body: r.body }; });
  let res: Awaited<ReturnType<NonNullable<PullOpts['fetch']>>>;
  try { res = await f(o.url ?? downloadUrl(e)); } catch (err) { throw new ClassifierError('offline', `download failed: ${(err as Error).message}`); }
  if (res.status !== 200 || !res.body) throw new ClassifierError('bad_response', `download failed: HTTP ${res.status}`);
  const hash = createHash('sha256');
  const out = fs.createWriteStream(part, { mode: 0o600 });
  let done = 0;
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      done += chunk.byteLength;
      if (done > e.bytes) throw new ClassifierError('bad_response', 'download is larger than the catalog size');
      if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()));
      o.onProgress?.(done, e.bytes);
    }
    await new Promise<void>((r, j) => out.end((err?: Error | null) => (err ? j(err) : r())));
  } catch (err) {
    out.destroy();
    fs.rmSync(part, { force: true });
    throw err instanceof ClassifierError ? err : new ClassifierError('offline', `download interrupted: ${(err as Error).message}`);
  }
  const sha = hash.digest('hex');
  if (sha !== e.sha256 || done !== e.bytes) {
    fs.rmSync(part, { force: true });
    throw new ClassifierError('bad_response', `checksum mismatch for ${e.file}: got ${sha.slice(0, 12)}… (${done} bytes), expected ${e.sha256.slice(0, 12)}… (${e.bytes} bytes); file removed`);
  }
  fs.renameSync(part, dest);
  return { path: dest, sha256: sha, bytes: done, skipped: false };
}

export function gb(bytes: number): string { return `${(bytes / 1024 ** 3).toFixed(1)} GB`; }

/**
 * argv for llama-server serving a catalog model on loopback (the CLI's `classifier serve`). `-c 8192` is Kev's validated
 * context (its card) and `-np 1` one slot: llama-server's defaults (the model's 262k context x 4 slots) reserved ~13 GB
 * of RAM for the 0.8B model in the task-1822 benchmark.
 */
export function serveArgv(e: CatalogEntry, file: string, port: number, threads?: number): string[] {
  if (e.runtime !== 'llama-server') throw new ClassifierError('invalid', `${e.id} is not served by llama-server`);
  return ['-m', file, '--host', '127.0.0.1', '--port', String(port), '-c', '8192', '-np', '1', ...(threads ? ['-t', String(threads)] : [])];
}
