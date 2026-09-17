/**
 * Error bars for eval scores, after Anthropic's "Adding Error Bars to Evals"
 * (arXiv:2411.00640): trials of the same task are correlated, so the task — not
 * the trial — is the sampling unit. Report a clustered standard error on a mean
 * score, and compare two arms on task-level paired differences.
 */

export interface Estimate {
  mean: number;
  se: number;
  /** 95% interval, `mean ± t·se`. */
  lo: number;
  hi: number;
  /** Sampling units (tasks) the estimate rests on. */
  n: number;
}

/**
 * Mean of every trial score, with a cluster-robust (CR0) standard error:
 * `SE² = Σ_c (Σ_{i∈c} (x_i − x̄))² / N²`. Collapses to the plain CLT error when
 * every cluster holds one trial, and grows when trials within a task agree —
 * which, for a flaky-or-not agent, they usually do.
 */
export function clusteredMean(clusters: number[][]): Estimate {
  const all = clusters.flat();
  const N = all.length;
  if (N === 0) return { mean: 0, se: 0, lo: 0, hi: 0, n: 0 };
  const mean = all.reduce((a, b) => a + b, 0) / N;
  let v = 0;
  for (const c of clusters) {
    const s = c.reduce((a, x) => a + (x - mean), 0);
    v += s * s;
  }
  const se = Math.sqrt(v) / N;
  const k = clusters.filter((c) => c.length > 0).length;
  const t = tCrit(Math.max(1, k - 1));
  return { mean, se, lo: mean - t * se, hi: mean + t * se, n: k };
}

export interface PairedComparison extends Estimate {
  /** Tasks where arm A scored higher / lower / the same. */
  wins: number;
  losses: number;
  ties: number;
  /** Sample SD of the per-task differences (0 when every task tied). */
  sdDiff: number;
  /** Smallest true mean difference this many tasks detects at α=.05, 80% power. */
  mde: number;
}

/**
 * Paired comparison of two arms over the same tasks: `a[i]` and `b[i]` are the
 * per-task scores (e.g. pass rates) of task `i`. Inference is on `a[i] − b[i]`,
 * which cancels task difficulty out of the variance — far tighter than
 * comparing the two arms' means independently.
 */
export function pairedDiff(a: number[], b: number[]): PairedComparison {
  if (a.length !== b.length) throw new Error(`pairedDiff: ${a.length} vs ${b.length} tasks`);
  const d = a.map((x, i) => x - (b[i] as number));
  const n = d.length;
  if (n === 0) {
    return { mean: 0, se: 0, lo: 0, hi: 0, n: 0, wins: 0, losses: 0, ties: 0, sdDiff: 0, mde: 0 };
  }
  const mean = d.reduce((s, x) => s + x, 0) / n;
  const sdDiff = n > 1 ? Math.sqrt(d.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : 0;
  const se = sdDiff / Math.sqrt(n);
  const t = tCrit(Math.max(1, n - 1));
  const eps = 1e-9;
  return {
    mean,
    se,
    lo: mean - t * se,
    hi: mean + t * se,
    n,
    wins: d.filter((x) => x > eps).length,
    losses: d.filter((x) => x < -eps).length,
    ties: d.filter((x) => Math.abs(x) <= eps).length,
    sdDiff,
    mde: minDetectableEffect(sdDiff, n),
  };
}

/**
 * Power analysis for a paired test: the smallest mean difference `n` tasks can
 * detect at two-sided α=.05 with 80% power, given the SD of per-task
 * differences. Run it on a pilot before believing a "no difference" result.
 */
export function minDetectableEffect(sdDiff: number, n: number): number {
  if (n < 2) return Number.POSITIVE_INFINITY;
  const Z_BETA_80 = 0.8416;
  return (tCrit(n - 1) + Z_BETA_80) * (sdDiff / Math.sqrt(n));
}

/** Tasks needed to detect a mean difference of `effect` (α=.05, 80% power). */
export function tasksNeeded(sdDiff: number, effect: number): number {
  if (effect <= 0) return Number.POSITIVE_INFINITY;
  if (sdDiff === 0) return 2;
  for (let n = 2; n < 100_000; n++) {
    if (minDetectableEffect(sdDiff, n) <= effect) return n;
  }
  return Number.POSITIVE_INFINITY;
}

/** C(n, k) as a float — fine for eval-sized n. */
function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

/** Unbiased pass@k from `c` passes in `n` trials: P(at least one of k passes). */
export function passAtK(n: number, c: number, k: number): number {
  if (k > n) throw new Error(`pass@${k} needs at least ${k} trials, got ${n}`);
  return 1 - choose(n - c, k) / choose(n, k);
}

/** Unbiased pass^k from `c` passes in `n` trials: P(all k pass). */
export function passHatK(n: number, c: number, k: number): number {
  if (k > n) throw new Error(`pass^${k} needs at least ${k} trials, got ${n}`);
  return choose(c, k) / choose(n, k);
}

// Two-sided 95% Student-t critical values, df 1..30.
const T975 = [
  12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131,
  2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042,
];

/** Conservative two-sided 95% t critical value (rounds df down between table rows). */
export function tCrit(df: number): number {
  if (df < 1) return T975[0] as number;
  if (df <= 30) return T975[Math.floor(df) - 1] as number;
  if (df < 40) return 2.042;
  if (df < 60) return 2.021;
  if (df < 120) return 2.0;
  return 1.98;
}
