# Evaluating and improving `marvis`

How `marvis` is measured and how measurements turn into fixes. The method follows
Anthropic's [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents),
[Adding error bars to evals](https://www.anthropic.com/research/statistical-approach-to-model-evals),
and Hamel Husain's [evals FAQ](https://hamel.dev/blog/posts/evals-faq/).

## The loop

```
read transcripts → note the first thing that went wrong → tally failure modes
      ↑                                                        ↓
promote stable tasks                            write a task or grader for a frequent mode
      ↑                                                        ↓
measure with paired CIs  ←──────────  change the harness (behind a switch)
```

1. **Error analysis comes first.** Read runs, write down the first error in each
   (later errors are usually consequences), group the notes into failure modes,
   and count them in the failure-mode table in [ROADMAP.md](ROADMAP.md). Only frequent, real
   failure modes get a task or grader. Don't write tests for failures you haven't
   actually seen.
2. **A good task is one where two experts would give the same verdict.** Every
   task ships a reference solution the assert accepts and a check that the
   untouched fixture fails: put the solution in `reference/` (laid over the
   fixture) and `src/tasks.test.ts` checks both. If a task passes 0% of the time even with many trials,
   suspect the task before the agent.
3. **Grade the outcome, not the path.** `assert.mjs` checks the workspace. Graders
   add binary behaviour checks. Nothing checks a specific tool-call sequence.
4. **Don't trust a number until someone has read the transcripts behind it.**

## Suites

| suite | purpose | how it runs | gate |
| --- | --- | --- | --- |
| `regression` | things `marvis` already does; should stay ~100% | cassette replay, free, deterministic | yes: `baseline.json` |
| `capability` | things `marvis` struggles with; starts low | live model, ≥5 trials | no, measured |
| `heldout` | check a change generalizes | live, only right before a change lands | no |
| Harbor `subset.txt` | real containerized tasks (Terminal-Bench 2.0) | `evals/harbor/run-subset.sh` | no |
| Harbor `heldout.txt` | unseen Terminal-Bench tasks | `HC_BENCH_LIST=…/heldout.txt` | no |

`suite` is set in `task.json` and defaults to `regression`.

### Plan-shaped tasks

A task with `"mode": "plan"` and a `followUp` prompt runs two user turns:
plan → approval (scripted) → implement. It is the only shape where a mid-session
prompt change and a mode-stable tool list are observable, so it is where the
`system-update` ablation has a signal; `plan-then-implement` is the one such
task. Its runs diverge early, so until 2026-09-29 it kept a single trajectory:
every replay followed the first recorded one, since they all start with the
same request. Entries are now tagged with their run and replay of run *i*
serves run *i*'s; it was re-recorded that day with `"runs": 3`.

Measured on it (2026-09-19, `--ablation system-update`), on the first request
after the mode switch — the turn where the strategies differ:

| delivery of the changed prompt | that request's prompt cache |
| --- | --- |
| append only the changed segments (`in-history`) | 9344/9516 cached — **98.2%** |
| rewrite the head (`rewrite`) | 640/4800 cached — **13.3%** |

Rewriting the head moves every token after the edit, so the whole conversation
is re-processed; over a run, the arms came out at 94.9% vs 79.7% cached. The
arms take different trajectories, so compare the *rates*, not the totals.

## Metrics

Replayed runs of a task are distinct trajectories only when its cassette was
recorded with run tags (`--record` since 2026-09-29; every regression cassette
was re-recorded that day). A cassette without them replays its first trajectory
every time, and counts as one.

- **pass@k**: at least one of k trials passed. **pass^k**: all k passed. An agent
  users rely on needs consistency, so the regression gate is on pass^k: one flaky
  run out of three is a regression.
- **Trial pass rate** comes with a 95% interval whose standard error is clustered
  by task, because trials of the same task are correlated.
- **Ablations** compare per-task paired differences (arm A − arm B) and report the
  mean Δ with a 95% CI, win/loss/tie counts, and the minimum detectable effect at
  80% power. If the CI contains 0, the change has no demonstrated effect.
- Per run: turns, tokens, cost, tool calls, tool errors, denials, wall time, and
  each grader's verdict.

## Graders (`evals/src/graders/`)

Deterministic and binary. They run after `assert.mjs` and are gated against the
baseline, but they never change the outcome.

| grader | catches | options |
| --- | --- | --- |
| `tests-untouched` | passing by editing or deleting tests | `paths` (globs, default the test tree) |
| `diff-size` | over-engineering | `maxChangedLines`, `maxNewFiles`, `ignore` |
| `scratch-sprawl` | stray scratch files | `allow` (globs for legitimate new files) |
| `first-touch` | committing to the deliverable too late | `deliverable` (globs), `maxRatio` (⅓), `graceTurns` (5) |

LLM-as-judge graders are deliberately absent. Add one only when error analysis
shows a failure mode deterministic checks can't catch, and only after aligning it
against ~100 human-labelled examples (true-positive and true-negative rates on a
held-out split).

## Commands

```bash
pnpm eval                                         # regression replay + gate (every change)
pnpm eval --live --suite capability --runs 5      # capability measurement (real model, costs money)
pnpm eval --ablation <dim>                        # paired A/B of a harness switch
pnpm eval --task plan-then-implement --ablation system-update   # the prompt-update A/B
pnpm eval --suite capability --ablation verify-stop --runs 5    # the verify-before-stop A/B
pnpm eval --analyze latest                        # transcript digest of failing runs → analysis.md
pnpm eval --analyze latest --all-runs             # include passing runs (weekly reading)
evals/harbor/run-subset.sh && python3 evals/harbor/summarize.py
```

`marvis eval <flags>` is the same runner, for when `marvis` is on your PATH; it spawns
`evals/dist/cli.js` from the checkout it finds, so it works only in one.

## Cadence

- **Every change:** `pnpm eval`.
- **Changes to prompt, tools, or loop behaviour:** put the change behind a switch,
  run `--ablation` or `--live --suite capability`, and decide on the paired CI,
  not on the means. Run the held-out suites once before landing.
- **Weekly:** read 10–20 transcripts (`--analyze --all-runs`, Harbor `agent/hc-sessions/`) and
  update the tallies.
- **Every 2–4 weeks:** re-cluster failure modes and retire or add tasks.
- **Promotion:** a capability task at pass^5 ≥ 0.9 on two consecutive measurements
  moves to `regression` (record its cassette, then update the baseline).
- **Saturation:** when the capability suite passes more than 80%, add harder tasks
  from the failure tally. A suite at 100% can't show improvement.
- **Harbor:** report infra errors separately from agent failures (`summarize.py`)
  and note the container resource config next to any score.
- **Live runs and sleep:** a live run or ablation takes tens of minutes, and a
  Mac that sleeps mid-stream turns the run into a provider timeout. Such runs
  are recorded as infra errors and left out of the rates (the report says how
  many), but they still cost the measurement its `n`: run on power, under
  `caffeinate -dis`. On battery with the lid closed, `caffeinate` does not help.
