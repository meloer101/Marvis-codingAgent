import { isAbsolute, relative } from 'node:path';

import { matchesAny } from './fs.js';
import { numberOpt, stringsOpt } from './types.js';
import type { Grader } from './types.js';

const WRITE_TOOLS = new Set(['write', 'edit']);

/** The `path` a write/edit call targeted. `inputSummary` may be truncated JSON. */
function targetPath(inputSummary: string): string | undefined {
  try {
    const v = (JSON.parse(inputSummary) as { path?: unknown }).path;
    if (typeof v === 'string') return v;
  } catch {
    // truncated — fall through to the regex
  }
  const m = /"path"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(inputSummary);
  return m?.[1] ? (JSON.parse(`"${m[1]}"`) as string) : undefined;
}

/**
 * Late-commitment check: the turn of the first successful write/edit to a
 * `deliverable` path, as a share of the run's turns. Passes when that turn is
 * within `graceTurns` (default 5 — a fix-shaped task legitimately runs the tests
 * and reads a few files first, and on a short run the ratio is meaningless) or
 * within the first `maxRatio` of the run. The signal is for long runs: an agent
 * still exploring at turn 20 of 30 has committed too late. Writes made through `bash` are not
 * seen — keep the deliverable a file the agent would normally `write`/`edit`.
 */
export const firstTouch: Grader = async (ctx, spec) => {
  const deliverable = stringsOpt(spec, 'deliverable');
  const maxRatio = numberOpt(spec, 'maxRatio', 1 / 3);
  const graceTurns = numberOpt(spec, 'graceTurns', 5);
  if (deliverable.length === 0) return { passed: false, detail: 'first-touch needs a "deliverable" glob list' };

  const start = ctx.events.find((e): e is Extract<typeof e, { type: 'run_start' }> => e.type === 'run_start');
  const cwd = start?.cwd ?? ctx.workDir;
  const turns = ctx.events.filter((e) => e.type === 'model_call').length;
  let touchTurn: number | undefined;
  for (const e of ctx.events) {
    if (e.type !== 'tool_call' || !WRITE_TOOLS.has(e.name) || e.isError) continue;
    const raw = targetPath(e.inputSummary);
    if (!raw) continue;
    const rel = (isAbsolute(raw) ? relative(cwd, raw) : raw).replace(/^\.\//, '');
    if (matchesAny(rel, deliverable)) {
      touchTurn = e.turn;
      break;
    }
  }
  if (touchTurn === undefined) return { passed: false, detail: `deliverable never written (${turns} turns)` };
  const ratio = turns > 0 ? touchTurn / turns : 0;
  const passed = touchTurn <= graceTurns || ratio <= maxRatio;
  return { passed, detail: `first write at turn ${touchTurn}/${turns} (${Math.round(ratio * 100)}%)` };
};
