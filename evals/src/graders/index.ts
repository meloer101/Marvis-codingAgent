/**
 * Behaviour graders — deterministic, binary checks that run after `assert.mjs`
 * on the same post-run workspace. `assert.mjs` answers "is the outcome right";
 * a grader answers "was it done the way we want" (no over-engineering, no stray
 * files, tests left alone, the deliverable touched early). They are reported per
 * task and gated against the baseline, but never flip the outcome `passed`.
 *
 * Declared in task.json:
 *
 *   "graders": [{ "name": "diff-size", "maxChangedLines": 40 }, ...]
 */

import { diffSize } from './diff-size.js';
import { firstTouch } from './first-touch.js';
import { scratchSprawl } from './scratch-sprawl.js';
import { testsUntouched } from './tests-untouched.js';
import type { Grader, GraderContext, GraderResult, GraderSpec } from './types.js';

export type { Grader, GraderContext, GraderResult, GraderSpec } from './types.js';

export const GRADERS: Record<string, Grader> = {
  'diff-size': diffSize,
  'first-touch': firstTouch,
  'scratch-sprawl': scratchSprawl,
  'tests-untouched': testsUntouched,
};

export async function runGraders(
  specs: readonly GraderSpec[],
  ctx: GraderContext,
): Promise<Record<string, GraderResult>> {
  const out: Record<string, GraderResult> = {};
  for (const spec of specs) {
    const grader = GRADERS[spec.name];
    if (!grader) {
      out[spec.name] = { passed: false, detail: `unknown grader "${spec.name}"` };
      continue;
    }
    try {
      out[spec.name] = await grader(ctx, spec);
    } catch (err) {
      out[spec.name] = { passed: false, detail: `grader threw: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  return out;
}
