/**
 * `pnpm eval --analyze <results>` — condense a results directory into one
 * markdown transcript digest for error analysis.
 *
 * The workflow it serves (Hamel Husain's evals FAQ; Anthropic's "Demystifying
 * evals"): read runs yourself first and note the *first* thing that went wrong
 * in each (open coding), then group the notes into failure modes and count them
 * in docs/EVAL_FAILURES.md (axial coding). The digest is compact enough to also
 * hand to a model for a clustering pass — but a human accepts or rejects every
 * suggested label; the analysis is not outsourced.
 *
 * Traces are body-free (tool names, input summaries, errors — not model text),
 * so the digest shows what the agent *did*; re-run with `--keep` to inspect the
 * workspace it left behind.
 */

import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { readTrace } from '@harness-code/core';
import type { TraceEvent } from '@harness-code/core';

import type { Report } from './report.js';
import type { SingleRun, TaskResult } from './runner.js';
import { evalsRoot, loadTasks } from './tasks.js';

export interface AnalyzeOptions {
  /** Include passing runs too (for the weekly read of ordinary traces). */
  allRuns?: boolean;
}

/** `latest`, a run id under `evals/.results/`, or a path. */
export async function resolveResultsDir(arg: string): Promise<string> {
  const root = join(evalsRoot(), '.results');
  if (arg === 'latest') {
    const ids = (await readdir(root, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    const last = ids.at(-1);
    if (!last) throw new Error(`no results under ${root}`);
    return join(root, last);
  }
  if (existsSync(arg)) return resolve(arg);
  if (existsSync(join(root, arg))) return join(root, arg);
  throw new Error(`no results directory "${arg}"`);
}

/** Every `(arm, TaskResult)` in a results dir: `report.json` and `ablation-*.json`. */
async function loadResults(dir: string): Promise<Array<{ arm?: string; result: TaskResult }>> {
  const out: Array<{ arm?: string; result: TaskResult }> = [];
  for (const name of (await readdir(dir)).sort()) {
    if (name === 'report.json') {
      const report = JSON.parse(await readFile(join(dir, name), 'utf8')) as Report;
      for (const result of report.results) out.push({ result });
    } else if (/^ablation-.+\.json$/.test(name)) {
      const { on, off } = JSON.parse(await readFile(join(dir, name), 'utf8')) as { on: Report; off: Report };
      const kind = name.slice('ablation-'.length, -'.json'.length);
      for (const result of on.results) out.push({ arm: `${kind} on`, result });
      for (const result of off.results) out.push({ arm: `${kind} off`, result });
    }
  }
  return out;
}

function failedGraders(run: SingleRun): string[] {
  return Object.entries(run.graders ?? {})
    .filter(([, g]) => !g.passed)
    .map(([name, g]) => `${name}: ${g.detail}`);
}

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
}

function timeline(events: TraceEvent[]): string[] {
  const out: string[] = [];
  for (const e of events) {
    switch (e.type) {
      case 'tool_call': {
        const flag = e.denied ? ' ⛔ denied' : e.isError ? ' ✗ error' : '';
        out.push(`t${e.turn} ${e.name} ${clip(e.inputSummary, 160)}${flag}`);
        break;
      }
      case 'error':
        out.push(`t${e.turn} ! ${e.scope} error${e.willRetry ? ' (retried)' : ''}: ${clip(e.message, 200)}`);
        break;
      case 'compaction':
        out.push(`t${e.turn} ~ compaction ${e.tokensBefore} → ${e.tokensAfter} tokens`);
        break;
      case 'subagent':
        out.push(`t${e.turn} → subagent ${e.name}: ${e.turns} turns, ${e.stopReason}`);
        break;
      default:
        break;
    }
  }
  return out;
}

export async function analyzeResults(dir: string, opts: AnalyzeOptions = {}): Promise<{ markdown: string; runs: number }> {
  const entries = await loadResults(dir);
  if (entries.length === 0) throw new Error(`no report.json / ablation-*.json in ${dir}`);

  const prompts = new Map<string, string>();
  for (const t of await loadTasks().catch(() => [])) prompts.set(t.spec.id, t.spec.prompt);

  const sections: string[] = [];
  let count = 0;
  for (const { arm, result } of entries) {
    for (const run of result.runs) {
      const graderFails = failedGraders(run);
      if (!opts.allRuns && run.passed && graderFails.length === 0) continue;
      count++;

      let events: TraceEvent[] = [];
      if (run.traceId) {
        const all = await readTrace(join(dir, '.agent'), run.traceId).catch(() => []);
        const start = all.map((e) => e.type).lastIndexOf('run_start');
        events = start > 0 ? all.slice(start) : all;
      }

      const verdict = run.passed ? 'PASS' : 'FAIL';
      sections.push(
        [
          `## ${run.traceId ?? result.id} — ${verdict}${arm ? ` · arm: ${arm}` : ''}`,
          '',
          `- task: \`${result.id}\` (${result.suite ?? 'regression'}; ${result.tags.join(', ') || 'no tags'})`,
          `- prompt: ${clip(prompts.get(result.id) ?? '(task no longer on disk)', 400)}`,
          `- stop: ${run.stopReason} · ${run.turns} turns · ${run.toolCalls ?? '?'} tool calls (${run.toolErrors ?? '?'} errors, ${run.deniedToolCalls} denied) · ${run.inputTokens + run.outputTokens} tokens`,
          ...(graderFails.length ? [`- graders failed: ${graderFails.join('; ')}`] : []),
          ...(run.detail ? ['- assert output:', '', '```', run.detail.trim(), '```'] : []),
          '',
          '```',
          ...(events.length ? timeline(events) : ['(no trace found)']),
          '```',
          '',
          '**First thing that went wrong:** _…_',
          '',
          '**Failure mode:** _…_ (existing row in docs/EVAL_FAILURES.md, or a new one)',
        ].join('\n'),
      );
    }
  }

  const header = [
    `# Eval transcript digest — ${dir}`,
    '',
    `${count} run(s)${opts.allRuns ? '' : ' that failed their assertion or a grader'}.`,
    '',
    'For each run: read the timeline, write the *first* thing that went wrong (later',
    'errors are usually consequences), then name a failure mode. Tally the modes in',
    '`docs/EVAL_FAILURES.md` and turn the frequent ones into tasks or graders. If the',
    'failure looks unfair — the grader rejected a valid solution, or the task is',
    'ambiguous — fix the task, not the agent.',
  ].join('\n');

  return { markdown: [header, ...sections].join('\n\n---\n\n') + '\n', runs: count };
}
