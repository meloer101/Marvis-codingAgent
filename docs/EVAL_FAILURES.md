# Failure modes

The tally that decides what to build next. See [EVALS.md](EVALS.md) for the method.

**How to add evidence:** run `pnpm eval --analyze <results>` (or read Harbor traces
listed by `evals/harbor/summarize.py`). For each run, note the *first* thing that
went wrong, then add it to an existing row's count or open a new row. Count
**distinct trajectories**: a cassette replayed three times is one trajectory.

Status: `observed` → `task/grader exists` → `fix landed` → `fix measured` (paired CI
excludes 0) or `fix unproven`.

| # | failure mode | first error looks like | count | evidence | eval signal | status |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Read-only exploration denied outside auto/plan mode | turn-1 `bash` `ls -la && cat package.json` ⛔; `npm test 2>&1 \| tail` ⛔ even with `Bash(npm:*)` allowed, because the pipe makes it compound | 4 trajectories (every coding fixture) | `pnpm eval --analyze` on the 2026-09-14 replay; engine: `isReadOnlyBashCommand` auto-allow is gated to `auto`/`plan` | `toolErrors` / denials per run in `report.json` | observed |
| 2 | `.env.example` treated as a secret → over-refusal | `read`/`edit`/`write` of `.env.example` → `deny: Refusing to access sensitive file` | engine probe (deterministic); live pass rate not yet measured | `isSensitivePath` matches every basename starting with `.env` (`packages/core/src/permissions/paths.ts`). This is intentional (the README's security section lists `.env*`), so whether committed templates (`.env.example` / `.sample` / `.template`) should be exempt is a product decision | task `edit-env-example-ok` (capability) | task exists; decision pending |
| 3 | Over-engineering on problems with a simple solution | builds a general solver where a direct computation suffices (`largest-eigenval`) | reported in ROADMAP §H; not yet tallied from traces | Harbor 18/89 run | grader `diff-size`; a small capability task derived from the trace is still to be written | fix landed, unproven |
| 4 | Late commitment to the deliverable | many turns of exploration or scratch work before the first write to the real output | reported in ROADMAP §H; not yet tallied | Harbor 18/89 run | grader `first-touch` | fix landed, unproven |
| 5 | Scratch-file sprawl | helper and debug files left in the workspace | reported in ROADMAP §H; not yet tallied | Harbor 18/89 run | grader `scratch-sprawl` | fix landed, unproven |
| 6 | Turn-budget nudge hurts iterative/optimization tasks | wraps up early on a task that needs repeated attempts | +2/−1 net in ROADMAP §H | Harbor 18/89 run | `--ablation` once a nudge switch exists; needs an optimization-shaped capability task | observed |

Rows 3–6 were noticed during the first Harbor run but never counted trace by trace.
The next step is to read the 18 existing Harbor trajectories into this table, so
the counts are real before more tasks are built on them.
