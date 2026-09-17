import { diffWorkspace, matchesAny } from './fs.js';
import { numberOpt, stringsOpt } from './types.js';
import type { Grader } from './types.js';

/**
 * Over-engineering check: line churn and new-file count stay under the task's
 * caps. `ignore` globs drop generated/lock files from both counts.
 */
export const diffSize: Grader = async (ctx, spec) => {
  const maxChangedLines = numberOpt(spec, 'maxChangedLines', Number.POSITIVE_INFINITY);
  const maxNewFiles = numberOpt(spec, 'maxNewFiles', Number.POSITIVE_INFINITY);
  const ignore = stringsOpt(spec, 'ignore', ['package-lock.json']);

  const changes = (await diffWorkspace(ctx.fixtureDir, ctx.workDir)).filter((c) => !matchesAny(c.path, ignore));
  const churn = changes.reduce((s, c) => s + c.added + c.removed, 0);
  const newFiles = changes.filter((c) => c.status === 'added').map((c) => c.path);

  const problems: string[] = [];
  if (churn > maxChangedLines) problems.push(`${churn} changed lines > ${maxChangedLines}`);
  if (newFiles.length > maxNewFiles) problems.push(`${newFiles.length} new files > ${maxNewFiles} (${newFiles.join(', ')})`);
  return {
    passed: problems.length === 0,
    detail: problems.length ? problems.join('; ') : `${churn} changed lines, ${newFiles.length} new files`,
  };
};
