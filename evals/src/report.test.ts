import { describe, expect, it } from 'vitest';

import { buildReport, diffBaseline, renderComparison, renderTable, toBaseline } from './report.js';
import type { SingleRun, TaskResult } from './runner.js';

function run(passed: boolean): SingleRun {
  return {
    passed,
    traceId: 't-1',
    turns: 5,
    inputTokens: 9_000,
    outputTokens: 1_000,
    costUSD: 0.003,
    costPartial: false,
    toolCalls: 4,
    deniedToolCalls: 0,
    toolErrors: 0,
    wallMs: 1_000,
    stopReason: 'end_turn',
    graders: {},
  };
}

function taskResult(over: Partial<TaskResult> = {}): TaskResult {
  return {
    id: 't',
    suite: 'regression',
    tags: ['bug-fix'],
    expectRefusal: false,
    n: 3,
    infraErrors: [],
    pass1: true,
    passAtK: true,
    passHatK: true,
    passRate: 1,
    graderPassRates: {},
    avgTurns: 5,
    avgTokens: 10_000,
    avgCostUSD: 0.003,
    costPartial: false,
    runs: [],
    ...over,
  };
}

describe('buildReport', () => {
  it('rolls up totals and refusal correctness', () => {
    const r = buildReport(
      [
        taskResult({ id: 'a' }),
        taskResult({ id: 'b', passAtK: false, passHatK: false, passRate: 0, pass1: false }),
        taskResult({ id: 'refuse', expectRefusal: true }),
      ],
      'p/m',
    );
    expect(r.totals.tasks).toBe(3);
    expect(r.totals.passAtK).toBe(2);
    expect(r.totals.passHatK).toBe(2);
    expect(r.totals.pass1).toBe(2);
    expect(r.totals.refusalTasks).toBe(1);
    expect(r.totals.refusalCorrect).toBe(1);
  });
});

describe('diffBaseline', () => {
  const report = buildReport([taskResult({ id: 'a', avgTokens: 10_000, avgCostUSD: 0.003 })], 'p/m');
  const baseline = toBaseline(report);

  it('is quiet when nothing moved', () => {
    expect(diffBaseline(report, baseline)).toEqual([]);
  });

  it('does not flag a fractional rate against its own rounded baseline', () => {
    const twoThirds = buildReport(
      [taskResult({ id: 'a', graderPassRates: { 'first-touch': 2 / 3 }, avgTokens: 10_000, avgCostUSD: 0.003 })],
      'p/m',
    );
    expect(toBaseline(twoThirds).tasks.a?.graders?.['first-touch']).toBe(0.667);
    expect(diffBaseline(twoThirds, toBaseline(twoThirds))).toEqual([]);
  });

  it('flags losing pass^k even when pass@k still holds (one flaky run of three)', () => {
    const flaky = buildReport(
      [taskResult({ id: 'a', passHatK: false, passAtK: true, passRate: 2 / 3, runs: [run(true), run(false), run(true)] })],
      'p/m',
    );
    const regs = diffBaseline(flaky, baseline);
    expect(regs).toHaveLength(1);
    expect(regs[0]).toMatchObject({ task: 'a', kind: 'pass' });
    expect(regs[0]?.detail).toContain('pass^k');
  });

  it('reads a pre-pass^k baseline (passRate only)', () => {
    const legacy = { generatedAt: '', model: 'p/m', tasks: { a: { passRate: 1, passK: true, avgTurns: 5, avgTokens: 10_000, avgCostUSD: 0.003 } } };
    const flaky = buildReport([taskResult({ id: 'a', passHatK: false, passRate: 0.5 })], 'p/m');
    expect(diffBaseline(flaky, legacy as unknown as Parameters<typeof diffBaseline>[1])).toHaveLength(1);
  });

  it('flags a grader pass-rate drop', () => {
    const withGrader = buildReport([taskResult({ id: 'a', graderPassRates: { 'diff-size': 1 } })], 'p/m');
    const base = toBaseline(withGrader);
    const worse = buildReport([taskResult({ id: 'a', graderPassRates: { 'diff-size': 1 / 3 } })], 'p/m');
    expect(diffBaseline(worse, base)).toEqual([expect.objectContaining({ task: 'a', kind: 'grader' })]);
  });

  it('flags a >15% token increase but tolerates a small one', () => {
    const bumped = buildReport([taskResult({ id: 'a', avgTokens: 12_000 })], 'p/m');
    expect(diffBaseline(bumped, baseline).some((r) => r.kind === 'tokens')).toBe(true);
    const ok = buildReport([taskResult({ id: 'a', avgTokens: 10_500 })], 'p/m');
    expect(diffBaseline(ok, baseline).some((r) => r.kind === 'tokens')).toBe(false);
  });

  it('is empty with no baseline', () => {
    expect(diffBaseline(report, undefined)).toEqual([]);
  });
});

describe('renderTable', () => {
  it('produces a markdown table with a row per task', () => {
    const out = renderTable(buildReport([taskResult({ id: 'a' }), taskResult({ id: 'b' })], 'p/m'));
    expect(out).toContain('| task | suite | pass rate | pass@k | pass^k | graders |');
    expect(out).toContain('| a |');
    expect(out).toContain('| b |');
    expect(out).toContain('refusal correctness:');
  });
});

describe('renderComparison', () => {
  it('reports a paired Δ with an interval and win/loss counts', () => {
    const ids = ['a', 'b', 'c', 'd'];
    const on = buildReport(ids.map((id, i) => taskResult({ id, passRate: [1, 1, 0.67, 1][i] as number })), 'p/m');
    const off = buildReport(ids.map((id, i) => taskResult({ id, passRate: [0.67, 1, 0.33, 0.67][i] as number })), 'p/m');
    const out = renderComparison('dim', on, off);
    expect(out).toContain('paired over 4 tasks');
    expect(out).toContain('3 better / 0 worse / 1 tied');
    expect(out).toContain('| Δ pass |');
  });

  it('does not call identical arms an effect', () => {
    const r = buildReport([taskResult({ id: 'a' }), taskResult({ id: 'b' })], 'p/m');
    expect(renderComparison('dim', r, r)).toContain('no difference on any task');
  });
  it('names runs lost to provider errors, and leaves an arm with none left out of the pairing', () => {
    const err = { traceId: 't', message: 'Streaming response timed out' };
    const on = buildReport(
      [
        taskResult({ id: 'a', passRate: 1, n: 3, infraErrors: [err, err] }),
        taskResult({ id: 'b', passRate: 0, n: 0, runs: [], infraErrors: [err, err, err] }),
      ],
      'p/m',
    );
    const off = buildReport([taskResult({ id: 'a', passRate: 1 }), taskResult({ id: 'b', passRate: 1 })], 'p/m');
    const out = renderComparison('dim', on, off, { on: 'with', off: 'without' });
    expect(out).toContain('paired over 1 tasks');
    expect(out).toContain('with: provider errors left out of the rates — a 2 (kept 3), b 3 (kept 0)');
    expect(out).not.toContain('without: provider errors');
    expect(renderTable(on)).toContain('+2 infra');
  });
});
