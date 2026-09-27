/**
 * Turn `TaskResult[]` into a committed baseline, a scannable table, and a
 * pass/fail regression verdict against the last baseline.
 */

import type { TaskResult } from './runner.js';
import { clusteredMean, pairedDiff } from './stats.js';
import type { Estimate } from './stats.js';

export interface BaselineTask {
  passRate: number;
  /** Every run passed. The regression gate's pass bar. */
  passHatK: boolean;
  avgTurns: number;
  avgTokens: number;
  avgCostUSD: number;
  /** Per-grader pass rate; absent when the task declares no graders. */
  graders?: Record<string, number>;
}

export interface Baseline {
  generatedAt: string;
  model: string;
  tasks: Record<string, BaselineTask>;
}

export interface Report {
  generatedAt: string;
  model: string;
  results: TaskResult[];
  totals: {
    tasks: number;
    passAtK: number;
    passHatK: number;
    pass1: number;
    /** Trial-level pass rate with a task-clustered 95% interval. */
    passRate: Estimate;
    avgTurns: number;
    avgTokens: number;
    avgCostUSD: number;
    refusalTasks: number;
    refusalCorrect: number;
  };
}

export function buildReport(results: TaskResult[], model: string): Report {
  const refusal = results.filter((r) => r.expectRefusal);
  const num = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  return {
    generatedAt: new Date().toISOString(),
    model,
    results,
    totals: {
      tasks: results.length,
      passAtK: results.filter((r) => r.passAtK).length,
      passHatK: results.filter((r) => r.passHatK).length,
      pass1: results.filter((r) => r.pass1).length,
      passRate: clusteredMean(results.map((r) => r.runs.map((x) => (x.passed ? 1 : 0)))),
      avgTurns: num(results.map((r) => r.avgTurns)),
      avgTokens: num(results.map((r) => r.avgTokens)),
      avgCostUSD: num(results.map((r) => r.avgCostUSD)),
      refusalTasks: refusal.length,
      refusalCorrect: refusal.filter((r) => r.passHatK).length,
    },
  };
}

export function toBaseline(report: Report): Baseline {
  const tasks: Baseline['tasks'] = {};
  for (const r of report.results) {
    const graders = Object.entries(r.graderPassRates);
    tasks[r.id] = {
      passRate: round(r.passRate, 3),
      passHatK: r.passHatK,
      avgTurns: round(r.avgTurns, 2),
      avgTokens: Math.round(r.avgTokens),
      avgCostUSD: round(r.avgCostUSD, 6),
      ...(graders.length ? { graders: Object.fromEntries(graders.map(([k, v]) => [k, round(v, 3)])) } : {}),
    };
  }
  return { generatedAt: report.generatedAt, model: report.model, tasks };
}

export interface Regression {
  task: string;
  kind: 'pass' | 'grader' | 'tokens' | 'cost';
  detail: string;
}

const COST_TOKEN_TOLERANCE = 0.15;

/**
 * Regressions: a task that passed every run no longer does (pass^k), any drop
 * in pass rate or a grader's pass rate, or tokens/cost up more than 15%.
 */
export function diffBaseline(report: Report, baseline: Baseline | undefined): Regression[] {
  if (!baseline) return [];
  const out: Regression[] = [];
  for (const r of report.results) {
    const base = baseline.tasks[r.id] as (Omit<BaselineTask, 'passHatK'> & { passHatK?: boolean }) | undefined;
    if (!base) continue;
    // Baselines written before pass^k existed only carry `passRate`.
    const baseHatK = base.passHatK ?? base.passRate >= 1 - 1e-9;
    if (baseHatK && !r.passHatK) {
      out.push({ task: r.id, kind: 'pass', detail: `pass^k lost: ${passFrac(r)} runs passed` });
    } else if (r.passRate < base.passRate - 1e-9) {
      out.push({
        task: r.id,
        kind: 'pass',
        detail: `pass rate ${pct(base.passRate)} → ${pct(r.passRate)}`,
      });
    }
    for (const [name, baseRate] of Object.entries(base.graders ?? {})) {
      const now = r.graderPassRates[name];
      if (now !== undefined && now < baseRate - 1e-9) {
        out.push({ task: r.id, kind: 'grader', detail: `${name} ${pct(baseRate)} → ${pct(now)}` });
      }
    }
    if (base.avgTokens > 0 && r.avgTokens > base.avgTokens * (1 + COST_TOKEN_TOLERANCE)) {
      out.push({
        task: r.id,
        kind: 'tokens',
        detail: `avg tokens ${fmt(base.avgTokens)} → ${fmt(r.avgTokens)} (+${pct(r.avgTokens / base.avgTokens - 1)})`,
      });
    }
    if (base.avgCostUSD > 0 && r.avgCostUSD > base.avgCostUSD * (1 + COST_TOKEN_TOLERANCE)) {
      out.push({
        task: r.id,
        kind: 'cost',
        detail: `avg cost $${base.avgCostUSD.toFixed(5)} → $${r.avgCostUSD.toFixed(5)}`,
      });
    }
  }
  return out;
}

export function renderTable(report: Report): string {
  const rows = report.results.map((r) => {
    const cost = r.costPartial ? '—' : `$${r.avgCostUSD.toFixed(5)}`;
    const graders = Object.entries(r.graderPassRates)
      .map(([name, rate]) => `${name} ${pct(rate)}`)
      .join(', ');
    return `| ${r.id} | ${r.suite} | ${pct(r.passRate)} (${passFrac(r)}) | ${yn(r.passAtK)} | ${yn(r.passHatK)} | ${graders || '—'} | ${r.avgTurns.toFixed(1)} | ${fmt(r.avgTokens)} | ${cost} |`;
  });
  const t = report.totals;
  return [
    `**${report.model}** · ${new Date(report.generatedAt).toISOString().slice(0, 10)} · ` +
      `${t.passHatK}/${t.tasks} tasks pass^k, ${t.passAtK}/${t.tasks} pass@k, ${t.pass1}/${t.tasks} pass@1 · ` +
      `trial pass rate ${ci(t.passRate)}`,
    '',
    '| task | suite | pass rate | pass@k | pass^k | graders | avg turns | avg tokens | avg cost |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
    `refusal correctness: ${t.refusalCorrect}/${t.refusalTasks}`,
  ].join('\n');
}

/**
 * Two arms of an ablation, side by side, with the verdict drawn from task-level
 * paired differences (A − B) rather than the two arms' means. `arms` names the
 * columns; it defaults to `on`/`off`, but a dimension without a natural on/off —
 * e.g. prompt-encoded vs native tool calling — can pass its own labels.
 */
export function renderComparison(
  label: string,
  on: Report,
  off: Report,
  arms: { on: string; off: string } = { on: 'on', off: 'off' },
): string {
  // A task that lost every run of an arm to provider errors has no rate to
  // compare; pairing it as 0% would invent a difference.
  const pairs = on.results.flatMap((a) => {
    const b = off.results.find((r) => r.id === a.id);
    return b && a.n > 0 && b.n > 0 ? [{ a, b }] : [];
  });
  const rows = pairs.map(({ a, b }) => {
    const d = a.passRate - b.passRate;
    return `| ${a.id} | ${pct(a.passRate)} · ${fmt(a.avgTokens)}t · ${a.avgTurns.toFixed(1)} | ${pct(b.passRate)} · ${fmt(b.avgTokens)}t · ${b.avgTurns.toFixed(1)} | ${signedPct(d)} |`;
  });
  const pass = pairedDiff(
    pairs.map((p) => p.a.passRate),
    pairs.map((p) => p.b.passRate),
  );
  const tokens = pairedDiff(
    pairs.map((p) => p.a.avgTokens),
    pairs.map((p) => p.b.avgTokens),
  );
  const verdict =
    pass.n < 2
      ? 'too few tasks for an interval'
      : pass.lo > 0 || pass.hi < 0
        ? `significant at 95% (${pass.mean > 0 ? arms.on : arms.off} better)`
        : pass.sdDiff === 0
          ? 'no difference on any task — add trials or harder tasks before concluding "no effect"'
          : `not significant — this suite only detects ≥${pct(pass.mde)} at 80% power`;
  return [
    `### Ablation: ${label}`,
    '',
    `| task | ${label}: ${arms.on} (pass · tokens · turns) | ${arms.off} | Δ pass |`,
    '| --- | --- | --- | --- |',
    ...rows,
    '',
    `Δ pass rate (${arms.on} − ${arms.off}), paired over ${pass.n} tasks: ${signedPct(pass.mean)} ` +
      `[${signedPct(pass.lo)}, ${signedPct(pass.hi)}] · ${pass.wins} better / ${pass.losses} worse / ${pass.ties} tied · ${verdict}`,
    `Δ avg tokens: ${signed(tokens.mean)} [${signed(tokens.lo)}, ${signed(tokens.hi)}]`,
    ...infraNote(on, arms.on),
    ...infraNote(off, arms.off),
  ].join('\n');
}

function passFrac(r: TaskResult): string {
  const infra = r.infraErrors?.length ?? 0;
  return `${r.runs.filter((x) => x.passed).length}/${r.n}${infra > 0 ? ` +${infra} infra` : ''}`;
}
/** A line per arm that lost runs to provider errors: its rates rest on fewer runs than asked for. */
function infraNote(report: Report, arm: string): string[] {
  const lost = report.results.filter((r) => (r.infraErrors?.length ?? 0) > 0);
  if (lost.length === 0) return [];
  return [
    `${arm}: provider errors left out of the rates — ` +
      lost.map((r) => `${r.id} ${r.infraErrors.length} (kept ${r.n})`).join(', '),
  ];
}

function yn(b: boolean): string {
  return b ? '✓' : '✗';
}
function ci(e: Estimate): string {
  return `${pct(e.mean)} [${pct(Math.max(0, e.lo))}, ${pct(Math.min(1, e.hi))}]`;
}
function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}
function signedPct(x: number): string {
  const p = Math.round(x * 100);
  return `${p > 0 ? '+' : ''}${p}%`;
}
function signed(n: number): string {
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${fmt(Math.abs(n))}`;
}
function fmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));
}
function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
