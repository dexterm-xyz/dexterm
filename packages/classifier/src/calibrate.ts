// Calibration + scoring metrics (task-1822). A decision model's own temperature is fitted on ITS training
// distribution, not on memecoins, so dexterm can apply a local Platt map (p' = sigmoid(a * logit(p) + b)) fitted on
// labelled rows of the user's / our own data. The fit is plain logistic regression on one feature (Newton steps,
// a small ridge so a separable sample cannot run away). Metrics: AUROC (ties half), Brier, log-loss, ECE with
// equal-width bins, reliability bins, precision at recall.

export interface Platt { a: number; b: number; n: number; fitted_on: string }

const clamp = (p: number) => Math.min(1 - 1e-6, Math.max(1e-6, p));
export const logit = (p: number) => { const q = clamp(p); return Math.log(q / (1 - q)); };
export const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

/** Fit p' = sigmoid(a * logit(p) + b) to binary labels. */
export function fitPlatt(ps: readonly number[], ys: readonly boolean[], fittedOn: string, ridge = 1e-3): Platt {
  if (ps.length !== ys.length || ps.length < 2) throw new Error('fitPlatt: need >= 2 paired rows');
  let a = 1, b = 0;
  const xs = ps.map(logit);
  // Penalised negative log-likelihood (the ridge pulls a toward 1, i.e. toward "keep the model's own scale").
  const nll = (a: number, b: number) => {
    let s = (ridge / 2) * (a - 1) ** 2;
    for (let i = 0; i < xs.length; i++) { const z = a * xs[i] + b; s += ys[i] ? Math.log1p(Math.exp(-z)) : Math.log1p(Math.exp(z)); }
    return s;
  };
  let cur = nll(a, b);
  for (let it = 0; it < 100; it++) {
    let ga = ridge * (a - 1), gb = 0, haa = ridge, hab = 0, hbb = 1e-9;
    for (let i = 0; i < xs.length; i++) {
      const q = sigmoid(a * xs[i] + b), y = ys[i] ? 1 : 0, w = q * (1 - q);
      ga += (q - y) * xs[i]; gb += q - y;
      haa += w * xs[i] * xs[i]; hab += w * xs[i]; hbb += w;
    }
    const det = haa * hbb - hab * hab;
    if (!(Math.abs(det) > 1e-12)) break;
    const da = (hbb * ga - hab * gb) / det, db = (haa * gb - hab * ga) / det;
    // Pure Newton can overshoot and diverge on logistic losses: halve the step until the loss goes down.
    let t = 1, next = nll(a - da, b - db);
    while (!(next <= cur) && t > 1e-6) { t /= 2; next = nll(a - t * da, b - t * db); }
    if (!(next <= cur)) break;
    a -= t * da; b -= t * db;
    const gain = cur - next;
    cur = next;
    if (gain < 1e-12 || Math.abs(t * da) + Math.abs(t * db) < 1e-10) break;
  }
  return { a, b, n: ps.length, fitted_on: fittedOn };
}

export function applyPlatt(p: number, m: Platt): number { return sigmoid(m.a * logit(p) + m.b); }

export function auroc(scores: readonly number[], ys: readonly boolean[]): number | null {
  const idx = scores.map((s, i) => i).sort((i, j) => scores[i] - scores[j]);
  let pos = 0, neg = 0, rankSum = 0;
  // Average ranks over ties (Mann-Whitney U).
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && scores[idx[j + 1]] === scores[idx[i]]) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) if (ys[idx[k]]) rankSum += r;
    i = j + 1;
  }
  for (const y of ys) { if (y) pos++; else neg++; }
  if (!pos || !neg) return null;
  return (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
}

export function brier(ps: readonly number[], ys: readonly boolean[]): number {
  return ps.reduce((s, p, i) => s + (p - (ys[i] ? 1 : 0)) ** 2, 0) / ps.length;
}

export function logLoss(ps: readonly number[], ys: readonly boolean[]): number {
  return -ps.reduce((s, p, i) => s + Math.log(ys[i] ? clamp(p) : 1 - clamp(p)), 0) / ps.length;
}

export interface Bin { lo: number; hi: number; n: number; mean_p: number; rate: number }

export function reliability(ps: readonly number[], ys: readonly boolean[], bins = 10): Bin[] {
  const out: Bin[] = [];
  for (let b = 0; b < bins; b++) {
    const lo = b / bins, hi = (b + 1) / bins;
    let n = 0, sp = 0, sy = 0;
    ps.forEach((p, i) => { if (p >= lo && (p < hi || (b === bins - 1 && p <= hi))) { n++; sp += p; sy += ys[i] ? 1 : 0; } });
    out.push({ lo, hi, n, mean_p: n ? sp / n : NaN, rate: n ? sy / n : NaN });
  }
  return out;
}

export function ece(ps: readonly number[], ys: readonly boolean[], bins = 10): number {
  const N = ps.length;
  return reliability(ps, ys, bins).reduce((s, b) => s + (b.n ? (b.n / N) * Math.abs(b.mean_p - b.rate) : 0), 0);
}

/** Best precision reachable at each recall target (threshold sweep over the scores). */
export function precisionAtRecall(scores: readonly number[], ys: readonly boolean[], targets = [0.25, 0.5, 0.75, 0.9]): Array<{ recall: number; precision: number | null; threshold: number | null }> {
  const order = scores.map((s, i) => i).sort((i, j) => scores[j] - scores[i]);
  const P = ys.filter(Boolean).length;
  const curve: Array<{ r: number; p: number; t: number }> = [];
  let tp = 0;
  for (let k = 0; k < order.length; k++) {
    if (ys[order[k]]) tp++;
    if (k + 1 < order.length && scores[order[k + 1]] === scores[order[k]]) continue;
    curve.push({ r: P ? tp / P : 0, p: tp / (k + 1), t: scores[order[k]] });
  }
  return targets.map((target) => {
    const ok = curve.filter((c) => c.r >= target);
    if (!ok.length) return { recall: target, precision: null, threshold: null };
    const best = ok.reduce((m, c) => (c.p > m.p ? c : m));
    return { recall: target, precision: best.p, threshold: best.t };
  });
}

/** F1 for one class given predicted labels. */
export function f1(pred: readonly string[], truth: readonly string[], label: string): { precision: number | null; recall: number | null; f1: number | null; n: number } {
  let tp = 0, fp = 0, fn = 0;
  pred.forEach((p, i) => { if (p === label && truth[i] === label) tp++; else if (p === label) fp++; else if (truth[i] === label) fn++; });
  const precision = tp + fp ? tp / (tp + fp) : null, recall = tp + fn ? tp / (tp + fn) : null;
  const f = precision !== null && recall !== null && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : null;
  return { precision, recall, f1: f, n: tp + fn };
}
