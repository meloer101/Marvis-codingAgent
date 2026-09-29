# coding-e2e

End-to-end coding tasks run through the real `hc agent` CLI, graded on the end state. The cases are
listed in `.claude/hillclimb/coding-e2e/cases.json` (tasks live in `evals/tasks/<id>/`), and the case
review sheet is `cases.md` next to it.

- **Harness under test:** a single-file hc bundle frozen per variant, driving `deepseek/deepseek-flash`
  with the key from `.env`.
- **Grader:** the task's hidden `assert.mjs` (`pass`), plus one `claude -p` Haiku call per run that
  labels the final message (`overclaim`, `refused`). The judge uses the logged-in Claude subscription;
  no Anthropic API key is involved.

```bash
# 1. freeze the hc build a variant is measured on (once per variant)
node evals/e2e/freeze-harness.mjs --variant baseline --commit <rev>
node evals/e2e/freeze-harness.mjs --variant v1 --from-worktree

# 2. run it (resumable: re-run the same command after a crash or a limit)
node evals/e2e/run-eval.mjs --variant baseline --reps 3
node evals/e2e/run-eval.mjs --variant baseline --reps 1 --only fix-null-deref,http-endpoint-feature

# 3. report
node ~/.claude/skills/claude-api/shared/evals/report/build-report-lite.mjs .claude/hillclimb/coding-e2e/
```

The first run, and any run after the runner, the cases or a task's check changes, stops until you
review the change and add `--approve-harness`. That flag records a sha of those files in
`_state.json`.

## Isolation

Each (case, rep) gets a fresh temp dir:

- the fixture, committed once to a new git repo;
- an empty `HOME`, so hc's global memory, skills, settings and MCP config start empty and nothing
  leaks between runs or into `~/.agent`;
- its own `HC_STATE_DIR`.

The agent's process group is killed when hc exits, which reaps any server it left running.

## Resume and limits

- **Cache:** a finished hc run is cached in `<variant>/runs/<id>_rep<k>/` as `run.json` (with the
  session log, trace and workspace diff), and its judge label as `judge.json`. Re-running never
  re-runs hc for a cached attempt.
- **Subscription limit on the judge:** the attempt is logged to `errors.jsonl`, the case is
  re-queued, and the whole pass pauses until the limit resets (or 5 → 60 min backoff).
- **DeepSeek errors:**
  - A 402 (balance exhausted) stops the pass with exit code 3.
  - Rate-limit, network and server errors are retried with backoff. They are never scored.

## Fixing a check

Grading runs on each run's end state, rebuilt from `workspace.tgz`. Runs recorded before snapshots
existed are rebuilt from the fixture plus `workspace.diff`.

The check result is cached in `check.json`, keyed by the task's `assert.mjs` and its graders. After
you correct a task's check:

1. Move that variant's `results.jsonl` and `traces/` aside.
2. Re-approve the harness.
3. Re-run the same command.

Every row is re-scored from the cached runs and judge labels, without re-running hc or the judge.
Scores from before and after a check change are not comparable, so re-score the whole variant rather
than a subset.

## Self-tests (no DeepSeek calls)

```bash
node evals/e2e/run-eval.mjs --selftest oracle   # stub hc applies each task's reference/: expect 19/19
node evals/e2e/run-eval.mjs --selftest null     # stub hc changes nothing: expect 0/19
node evals/e2e/run-eval.mjs --judge-selftest    # 12 labeled final messages through the judge (Haiku)
```
