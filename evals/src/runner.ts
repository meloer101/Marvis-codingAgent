/**
 * Run one task: materialize its fixture into a fresh workspace, drive the agent
 * N times, run the assertion after each, and collect per-run + aggregate numbers.
 */

import { cp, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProviderError } from '@harness-code/core';

import { runGraders } from './graders/index.js';
import type { GraderResult } from './graders/index.js';
import { runAgentTask, runAssertion } from './harness.js';
import type { Suite, Task } from './tasks.js';

export interface RunConfig {
  /** Where per-run trace jsonl files land (kept for `marvis trace` debugging). */
  resultsDir: string;
  /** Override the task's `runs`. */
  runs?: number;
  /** Live-record the cassette instead of replaying it. */
  record?: boolean;
  /** Hit the real endpoint directly, recording nothing (ablation measurements). */
  live?: boolean;
  /** Provider settings for record / live mode. */
  settings?: import('@harness-code/core').Settings;
  /** Keep the workspace on disk after the run. */
  keep?: boolean;
  /** Ablation knobs forwarded to the harness. */
  compaction?: boolean | number;
  contextWindow?: number;
  maxOutputTokens?: number;
  subagents?: boolean;
  promptTools?: boolean;
  systemPromptUpdate?: 'rewrite' | 'in-history';
  verifyBeforeStop?: boolean;
  /** Distinguishes trace ids / result buckets across ablation arms. */
  label?: string;
}

export interface SingleRun {
  /** Outcome: `assert.mjs` held in the post-run workspace. */
  passed: boolean;
  /** Trace id — `marvis trace <id> --cwd <resultsDir>` / `pnpm eval --analyze`. */
  traceId: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
  costPartial: boolean;
  toolCalls: number;
  deniedToolCalls: number;
  /** Tool calls that returned an error (denials included). */
  toolErrors: number;
  wallMs: number;
  stopReason: string;
  /** Behaviour grader verdicts, by grader name. */
  graders: Record<string, GraderResult>;
  /** assert.mjs / error output, only kept for failures. */
  detail?: string;
}

export interface TaskResult {
  id: string;
  suite: Suite;
  tags: string[];
  expectRefusal: boolean;
  n: number;
  pass1: boolean;
  /** pass@k, k = n: at least one run passed. */
  passAtK: boolean;
  /** pass^k, k = n: every run passed — the consistency bar a regression gate wants. */
  passHatK: boolean;
  passRate: number;
  /** Per-grader share of runs whose grader passed. */
  graderPassRates: Record<string, number>;
  avgTurns: number;
  avgTokens: number;
  avgCostUSD: number;
  costPartial: boolean;
  runs: SingleRun[];
  /**
   * Live runs that never got a fair attempt: the provider failed (a stream
   * timeout when the machine slept, a 5xx that outlasted the retries). Left out
   * of every rate above, like Harbor's infra bucket, and listed so a thin `n`
   * is visible.
   */
  infraErrors: { traceId: string; message: string }[];
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

export async function runTask(task: Task, cfg: RunConfig): Promise<TaskResult> {
  const n = cfg.runs ?? task.spec.runs;
  const arm = cfg.label ? `${cfg.label}-` : '';
  const runs: SingleRun[] = [];
  const infraErrors: TaskResult['infraErrors'] = [];
  // Traces land under `<resultsDir>/.agent/traces/` so `marvis trace --cwd <resultsDir>` works.
  const traceDir = join(cfg.resultsDir, '.agent');
  await mkdir(traceDir, { recursive: true });

  for (let i = 0; i < n; i++) {
    // The workspace gets a private parent directory. `ls -la` prints the
    // parent's link count and size for `..`, and a shared temp root changes
    // those as unrelated runs come and go — which would put a different number
    // into the model's history on every replay and never match the cassette.
    const container = await realpath(await mkdtemp(join(tmpdir(), `hc-eval-${task.spec.id}-`)));
    const workDir = join(container, 'work');
    try {
      await mkdir(workDir, { recursive: true });
      await cp(task.fixtureDir, workDir, { recursive: true });

      const traceId = `${arm}${task.spec.id}-${i + 1}`;
      const outcome = await runAgentTask({
        workDir,
        prompt: task.spec.prompt,
        modelRef: task.spec.model,
        mode: task.spec.mode,
        traceDir,
        traceId,
        cassettePath: task.cassettePath,
        runIndex: i,
        ...(cfg.record ? { record: true } : {}),
        ...(cfg.live ? { live: true } : {}),
        ...(cfg.settings ? { settings: cfg.settings } : {}),
        ...(cfg.compaction !== undefined ? { compaction: cfg.compaction } : {}),
        ...(cfg.contextWindow ? { contextWindow: cfg.contextWindow } : {}),
        ...(cfg.maxOutputTokens ? { maxOutputTokens: cfg.maxOutputTokens } : {}),
        ...(cfg.subagents ? { subagents: true } : {}),
        ...(cfg.promptTools ? { promptTools: true } : {}),
        ...(cfg.systemPromptUpdate ? { systemPromptUpdate: cfg.systemPromptUpdate } : {}),
        ...(cfg.verifyBeforeStop ? { verifyBeforeStop: true } : {}),
        ...(task.spec.allow ? { allow: task.spec.allow } : {}),
        ...(task.spec.deny ? { deny: task.spec.deny } : {}),
        ...(task.spec.maxTurns ? { maxTurns: task.spec.maxTurns } : {}),
        ...(task.spec.effort ? { reasoningEffort: task.spec.effort } : {}),
        ...(task.spec.followUp ? { followUp: task.spec.followUp } : {}),
        ...(task.spec.planApprovedMode
          ? { planApprovedMode: task.spec.planApprovedMode }
          : {}),
      }).catch((err: unknown) => {
        // Live only. In replay a miss is the regression signal; a half-written
        // recording can't be used; and once the balance is gone (`quota`)
        // every later run fails too — all of those should stop the run.
        if (!cfg.live || !(err instanceof ProviderError) || err.kind === 'quota') throw err;
        infraErrors.push({ traceId, message: err.message });
        process.stderr.write(`  ${traceId}: provider error, not counted — ${err.message}\n`);
        return undefined;
      });
      if (!outcome) continue;
      const { result, trace, events } = outcome;

      // For every task, pass = the assertion holds in the post-run workspace.
      // A refusal task's assertion checks the forbidden outcome never landed —
      // whether the agent declined in text or the engine blocked its attempt
      // (`deniedToolCalls`, reported but not gated on) both satisfy it.
      const assertion = runAssertion(task.assertPath, workDir);
      const passed = assertion.passed;
      const graders = await runGraders(task.spec.graders, { fixtureDir: task.fixtureDir, workDir, events });

      runs.push({
        passed,
        traceId,
        turns: trace.turns,
        inputTokens: trace.inputTokens,
        outputTokens: trace.outputTokens,
        costUSD: trace.costUSD,
        costPartial: trace.costPartial,
        toolCalls: trace.toolCalls,
        deniedToolCalls: trace.deniedToolCalls,
        toolErrors: events.filter((e) => e.type === 'tool_call' && e.isError).length,
        wallMs: trace.wallMs,
        stopReason: result.stopReason,
        graders,
        ...(passed ? {} : { detail: assertion.output.slice(0, 2000) || `stopReason ${result.stopReason}` }),
      });
    } finally {
      if (!cfg.keep) await rm(container, { recursive: true, force: true });
    }
  }

  // Rates are over the runs that completed; `n` says how many that was.
  const done = runs.length;
  const passes = runs.filter((r) => r.passed).length;
  const graderPassRates: Record<string, number> = {};
  for (const g of task.spec.graders) {
    graderPassRates[g.name] = done === 0 ? 0 : runs.filter((r) => r.graders[g.name]?.passed === true).length / done;
  }
  return {
    id: task.spec.id,
    suite: task.spec.suite,
    tags: task.spec.tags,
    expectRefusal: task.spec.expectRefusal === true,
    n: done,
    pass1: runs[0]?.passed === true,
    passAtK: passes > 0,
    passHatK: done > 0 && passes === done,
    passRate: done === 0 ? 0 : passes / done,
    graderPassRates,
    avgTurns: mean(runs.map((r) => r.turns)),
    avgTokens: mean(runs.map((r) => r.inputTokens + r.outputTokens)),
    avgCostUSD: mean(runs.map((r) => r.costUSD)),
    costPartial: runs.some((r) => r.costPartial),
    runs,
    infraErrors,
  };
}
