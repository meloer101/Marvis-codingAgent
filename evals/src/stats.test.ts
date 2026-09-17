import { describe, expect, it } from 'vitest';

import { clusteredMean, minDetectableEffect, pairedDiff, passAtK, passHatK, tasksNeeded, tCrit } from './stats.js';

describe('clusteredMean', () => {
  it('matches the CLT error when every cluster holds one trial', () => {
    const e = clusteredMean([[1], [0], [1], [1]]);
    expect(e.mean).toBeCloseTo(0.75);
    // sqrt(Σ(x−x̄)²)/N = sqrt(0.75)/4
    expect(e.se).toBeCloseTo(Math.sqrt(0.75) / 4);
  });

  it('widens when trials within a task agree', () => {
    const correlated = clusteredMean([
      [1, 1, 1],
      [0, 0, 0],
      [1, 1, 1],
      [0, 0, 0],
    ]);
    const independent = clusteredMean([[1], [0], [1], [0], [1], [0], [1], [0], [1], [0], [1], [0]]);
    expect(correlated.mean).toBeCloseTo(independent.mean);
    expect(correlated.se).toBeGreaterThan(independent.se * 1.5);
    expect(correlated.n).toBe(4);
  });

  it('is zero-width with no data', () => {
    expect(clusteredMean([])).toMatchObject({ mean: 0, se: 0, n: 0 });
  });
});

describe('pairedDiff', () => {
  it('computes the mean difference, interval, and win/loss/tie counts', () => {
    const d = pairedDiff([1, 1, 0.5, 1], [0.5, 1, 0, 0.5]);
    expect(d.mean).toBeCloseTo(0.375);
    expect(d.wins).toBe(3);
    expect(d.ties).toBe(1);
    expect(d.losses).toBe(0);
    expect(d.lo).toBeLessThan(d.mean);
    expect(d.hi).toBeGreaterThan(d.mean);
    expect(d.hi - d.mean).toBeCloseTo(tCrit(3) * d.se);
  });

  it('an A/A comparison has an interval containing 0', () => {
    const a = [1, 0.67, 0.33, 1, 0];
    const b = [0.67, 1, 0.33, 0.67, 0.33];
    const d = pairedDiff(a, b);
    expect(d.lo).toBeLessThanOrEqual(0);
    expect(d.hi).toBeGreaterThanOrEqual(0);
  });

  it('rejects mismatched arms', () => {
    expect(() => pairedDiff([1], [1, 0])).toThrow();
  });
});

describe('power', () => {
  it('needs more tasks to detect a smaller effect', () => {
    expect(minDetectableEffect(0.3, 20)).toBeLessThan(minDetectableEffect(0.3, 5));
    expect(tasksNeeded(0.3, 0.1)).toBeGreaterThan(tasksNeeded(0.3, 0.3));
    const n = tasksNeeded(0.3, 0.2);
    expect(minDetectableEffect(0.3, n)).toBeLessThanOrEqual(0.2);
    expect(minDetectableEffect(0.3, n - 1)).toBeGreaterThan(0.2);
  });
});

describe('pass@k / pass^k estimators', () => {
  it('bracket the per-trial rate and meet at k=1', () => {
    expect(passAtK(5, 3, 1)).toBeCloseTo(0.6);
    expect(passHatK(5, 3, 1)).toBeCloseTo(0.6);
    expect(passAtK(5, 3, 3)).toBeGreaterThan(0.6);
    expect(passHatK(5, 3, 3)).toBeLessThan(0.6);
  });

  it('k = n collapses to any-pass / all-pass', () => {
    expect(passAtK(3, 1, 3)).toBe(1);
    expect(passHatK(3, 2, 3)).toBe(0);
    expect(passHatK(3, 3, 3)).toBe(1);
    expect(passAtK(3, 0, 3)).toBe(0);
  });
});
