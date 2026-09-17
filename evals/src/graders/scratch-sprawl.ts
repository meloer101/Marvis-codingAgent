import { listFiles, matchesAny } from './fs.js';
import { stringsOpt } from './types.js';
import type { Grader } from './types.js';

/**
 * Scratch-file sprawl: every file the run created must match one of the task's
 * `allow` globs (the deliverable, plus anything legitimately generated).
 */
export const scratchSprawl: Grader = async (ctx, spec) => {
  const allow = stringsOpt(spec, 'allow');
  const before = new Set(await listFiles(ctx.fixtureDir));
  const stray = (await listFiles(ctx.workDir)).filter((p) => !before.has(p) && !matchesAny(p, allow));
  return {
    passed: stray.length === 0,
    detail: stray.length ? `unexpected new files: ${stray.join(', ')}` : 'no stray files',
  };
};
