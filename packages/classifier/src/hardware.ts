// Hardware detection + model-tier recommendation (`dexterm doctor`, `dexterm classifier doctor`). Reads RAM / CPU from
// node:os and asks `nvidia-smi` (when present) for GPU name + VRAM. Never installs or downloads anything. The tier
// table is the benchmark's (research/classifier-2026-10/REPORT.md "Hardware tiers").

import { execFile } from 'node:child_process';
import os from 'node:os';
import { CATALOG } from './models.ts';

export interface Gpu { vendor: 'nvidia' | 'apple'; name: string; vramGb: number | null }
export interface Hardware { platform: string; arch: string; cpuModel: string; cores: number; ramGb: number; freeRamGb: number; gpus: Gpu[] }

export type ExecLike = (cmd: string, args: string[]) => Promise<string>;

const defaultExec: ExecLike = (cmd, args) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: 4000, maxBuffer: 64 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
});

export async function detectHardware(o: { exec?: ExecLike; os?: Pick<typeof os, 'platform' | 'arch' | 'cpus' | 'totalmem' | 'freemem'> } = {}): Promise<Hardware> {
  const O = o.os ?? os;
  const exec = o.exec ?? defaultExec;
  const cpus = O.cpus();
  const hw: Hardware = {
    platform: O.platform(), arch: O.arch(), cpuModel: (cpus[0]?.model ?? 'unknown').replace(/\s+/g, ' ').trim(), cores: cpus.length,
    ramGb: round1(O.totalmem() / 1024 ** 3), freeRamGb: round1(O.freemem() / 1024 ** 3), gpus: [],
  };
  try {
    const out = await exec('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']);
    for (const line of out.split('\n')) {
      const m = line.match(/^(.+?),\s*(\d+)\s*$/);
      if (m) hw.gpus.push({ vendor: 'nvidia', name: m[1].trim().slice(0, 60), vramGb: round1(Number(m[2]) / 1024) });
    }
  } catch { /* no NVIDIA driver: fine */ }
  if (hw.platform === 'darwin' && hw.arch === 'arm64') hw.gpus.push({ vendor: 'apple', name: 'Apple Silicon (unified memory)', vramGb: null });
  return hw;
}

const round1 = (x: number) => Math.round(x * 10) / 10;

export interface Recommendation {
  tier: 'none' | 'cpu-small' | 'cpu' | 'apple' | 'gpu' | 'gpu-large';
  model: string | null;
  /** A higher-quality option the machine can also run, if any. */
  bestQuality: string | null;
  why: string;
}

/**
 * Pick a tier from detected hardware (task-1822 REPORT.md §4). Model ids are catalog ids; null = stay on the built-in
 * scores. Kev 4B Q4 is the only model recommended: Kev 0.8B ranked coins no better than chance on dexterm's labelled
 * history, and Kev 9B (measured on an RTX 4080 in task-1883) was no better than Kev 4B on VALID and tied the built-in
 * scores on held-out, so no tier lists it as a better-quality option.
 */
export function recommendTier(hw: Hardware): Recommendation {
  const nv = hw.gpus.filter((g) => g.vendor === 'nvidia' && g.vramGb !== null).sort((a, b) => (b.vramGb ?? 0) - (a.vramGb ?? 0))[0];
  if (nv && (nv.vramGb ?? 0) >= 12) return { tier: 'gpu-large', model: 'kev-4b-q4', bestQuality: null, why: `${nv.name} with ${nv.vramGb} GB VRAM: Kev 4B Q4 (~3 GB) on the GPU; Kev 9B Q4 (~6 GB) also fits but measured no better than Kev 4B on dexterm data` };
  if (nv && (nv.vramGb ?? 0) >= 6) return { tier: 'gpu', model: 'kev-4b-q4', bestQuality: null, why: `${nv.name} with ${nv.vramGb} GB VRAM: Kev 4B Q4 (~3 GB) fits with room for the context` };
  if (hw.gpus.some((g) => g.vendor === 'apple')) {
    if (hw.ramGb >= 16) return { tier: 'apple', model: 'kev-4b-q4', bestQuality: null, why: `Apple Silicon with ${hw.ramGb} GB unified memory (llama.cpp Metal)${hw.ramGb >= 32 ? '; Kev 9B also fits but measured no better than Kev 4B on dexterm data (on an NVIDIA GPU)' : ''}` };
    return { tier: 'none', model: null, bestQuality: null, why: `Apple Silicon with ${hw.ramGb} GB: keep the built-in scores (Kev 4B needs ~4 GB on top of everything else)` };
  }
  if (hw.ramGb >= 16 && hw.cores >= 8) return { tier: 'cpu', model: 'kev-4b-q4', bestQuality: null, why: `CPU only (${hw.cores} threads, ${hw.ramGb} GB): Kev 4B Q4 for on-demand coins (measured 5-20 s per coin on shared CPUs), not for scoring a whole screener` };
  return { tier: 'cpu-small', model: null, bestQuality: null, why: `CPU only (${hw.cores} threads, ${hw.ramGb} GB): keep the built-in scores; Kev 4B would take tens of seconds per coin here` };
}

export function describeHardware(hw: Hardware): string {
  const g = hw.gpus.length ? hw.gpus.map((x) => `${x.name}${x.vramGb ? ` ${x.vramGb} GB` : ''}`).join(', ') : 'no GPU detected';
  return `${hw.platform}/${hw.arch}, ${hw.cpuModel} (${hw.cores} threads), ${hw.ramGb} GB RAM, ${g}`;
}

export function fits(modelId: string, hw: Hardware): boolean {
  const e = CATALOG.find((c) => c.id === modelId);
  if (!e) return false;
  const nv = hw.gpus.find((g) => g.vendor === 'nvidia' && (g.vramGb ?? 0) >= e.memGb + 1);
  return Boolean(nv) || hw.ramGb >= e.memGb + 4;
}
