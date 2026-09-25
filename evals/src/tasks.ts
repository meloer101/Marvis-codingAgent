/**
 * Task discovery. A task is a directory under `evals/tasks/<id>/` holding:
 *
 *   task.json      metadata (id, prompt, model, mode, suite, tags, runs, expectRefusal, graders)
 *   fixture/       files copied verbatim into a fresh workspace before the run
 *   assert.mjs     run with cwd = the post-run workspace; exit 0 = pass
 *   cassette.jsonl recorded model exchanges (committed; replayed in CI) — regression suite only
 *   reference/     optional: files that, laid over the fixture, make assert.mjs pass —
 *                  a reference solution; tasks.test.ts checks it passes and the bare
 *                  fixture fails, so a task can't be unpassable or pass by doing nothing
 *
 * Suites (after Anthropic's "Demystifying evals for AI agents"):
 *   regression  should stay ~100%; replayed from cassettes and gated on the baseline
 *   capability  starts hard; run live (`--live`) with several trials, never gated
 *   heldout     like capability, but only run before a change lands — never tuned against
 */

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PermissionMode, ReasoningEffort } from '@harness-code/core';

import type { GraderSpec } from './graders/index.js';

export type Suite = 'regression' | 'capability' | 'heldout';
export const SUITES: readonly Suite[] = ['regression', 'capability', 'heldout'];

export interface TaskSpec {
  id: string;
  prompt: string;
  /** `provider/model`. */
  model: string;
  mode: PermissionMode;
  suite: Suite;
  tags: string[];
  /** How many times the runner executes this task. */
  runs: number;
  /** A correct outcome is the agent declining — a forbidden action never lands. */
  expectRefusal?: boolean;
  /** Extra permission rules for this task. */
  allow?: string[];
  deny?: string[];
  /** Cap on agent turns for this task (harness default 30). */
  maxTurns?: number;
  /** Reasoning effort for this task; omitted = the model's declared default. */
  effort?: ReasoningEffort;
  /**
   * A second user turn, sent after the first run ends. With `"mode": "plan"`
   * this makes the task plan-shaped: plan → approve → implement.
   */
  followUp?: string;
  /** Mode an approved plan switches to. Default `acceptEdits`. */
  planApprovedMode?: PermissionMode;
  /** Behaviour checks run after `assert.mjs` (see `graders/`). */
  graders: GraderSpec[];
}

export interface Task {
  spec: TaskSpec;
  dir: string;
  fixtureDir: string;
  assertPath: string;
  cassettePath: string;
}

/** `<repo>/evals` — this file is `evals/dist/tasks.js` at runtime, `evals/src/tasks.ts` under vitest. */
export function evalsRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/ or src/ -> parent is evals/
  return join(here, '..');
}

export function tasksDir(): string {
  return join(evalsRoot(), 'tasks');
}

const REQUIRED_MODES: PermissionMode[] = ['ask', 'plan', 'acceptEdits', 'readOnly', 'yolo', 'auto'];

function validate(raw: unknown, id: string): TaskSpec {
  if (typeof raw !== 'object' || raw === null) throw new Error(`${id}/task.json is not an object`);
  const r = raw as Record<string, unknown>;
  if (r.id !== id) throw new Error(`${id}/task.json: "id" is "${String(r.id)}", must equal the directory name`);
  if (typeof r.prompt !== 'string' || r.prompt.trim() === '') throw new Error(`${id}/task.json: "prompt" missing`);
  if (typeof r.model !== 'string') throw new Error(`${id}/task.json: "model" missing`);
  if (!REQUIRED_MODES.includes(r.mode as PermissionMode)) {
    throw new Error(`${id}/task.json: "mode" must be one of ${REQUIRED_MODES.join(', ')}`);
  }
  const suite = r.suite === undefined ? 'regression' : r.suite;
  if (!SUITES.includes(suite as Suite)) throw new Error(`${id}/task.json: "suite" must be one of ${SUITES.join(', ')}`);
  const graders = Array.isArray(r.graders) ? r.graders : [];
  for (const g of graders) {
    if (typeof g !== 'object' || g === null || typeof (g as { name?: unknown }).name !== 'string') {
      throw new Error(`${id}/task.json: every "graders" entry needs a "name"`);
    }
  }
  return {
    id,
    prompt: r.prompt,
    model: r.model,
    mode: r.mode as PermissionMode,
    suite: suite as Suite,
    tags: Array.isArray(r.tags) ? r.tags.map(String) : [],
    runs: typeof r.runs === 'number' && r.runs > 0 ? Math.floor(r.runs) : 3,
    ...(r.expectRefusal === true ? { expectRefusal: true } : {}),
    ...(Array.isArray(r.allow) ? { allow: r.allow.map(String) } : {}),
    ...(Array.isArray(r.deny) ? { deny: r.deny.map(String) } : {}),
    ...(typeof r.maxTurns === 'number' ? { maxTurns: Math.floor(r.maxTurns) } : {}),
    ...(typeof r.effort === 'string' ? { effort: r.effort as ReasoningEffort } : {}),
    ...(typeof r.followUp === 'string' ? { followUp: r.followUp } : {}),
    ...(typeof r.planApprovedMode === 'string'
      ? { planApprovedMode: r.planApprovedMode as PermissionMode }
      : {}),
    graders: graders as GraderSpec[],
  };
}

/**
 * Load tasks, optionally narrowed to explicit ids and/or suites. Explicit ids
 * win over the suite filter — `--task x` runs `x` whatever suite it is in.
 */
export async function loadTasks(only?: string[], suites?: readonly Suite[]): Promise<Task[]> {
  const root = tasksDir();
  let names: string[];
  try {
    names = (await readdir(root, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    throw new Error(`no tasks directory at ${root}`);
  }
  const wanted = only && only.length > 0 ? new Set(only) : undefined;

  const tasks: Task[] = [];
  for (const id of names) {
    if (wanted && !wanted.has(id)) continue;
    const dir = join(root, id);
    const spec = validate(JSON.parse(await readFile(join(dir, 'task.json'), 'utf8')), id);
    if (!wanted && suites && !suites.includes(spec.suite)) continue;
    tasks.push({
      spec,
      dir,
      fixtureDir: join(dir, 'fixture'),
      assertPath: join(dir, 'assert.mjs'),
      cassettePath: join(dir, 'cassette.jsonl'),
    });
  }
  if (wanted) {
    for (const id of wanted) {
      if (!tasks.some((t) => t.spec.id === id)) throw new Error(`no task "${id}" under ${root}`);
    }
  }
  return tasks;
}
