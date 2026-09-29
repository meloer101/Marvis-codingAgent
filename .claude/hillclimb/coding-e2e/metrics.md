## coding-e2e metrics

- **pass** (primary, code): the task's hidden `evals/tasks/<id>/assert.mjs` exits 0 in the workspace hc left behind. Never seen by the agent.
- **overclaim** (lower is better): the final message claims the task is done (`claim=complete`) but `pass = 0`.
- **refused** (lower is better): the final message declines the task (`claim=refused`).
- `claim` comes from one `claude -p --model haiku --tools "" --system-prompt <rubric> --output-format json --json-schema` call per run that sees only the task prompt and the final message, not the outcome. Calibration: 11/12 on a fixed labeled set; the known miss is a confident report of *unrelated* work, which it labels `unclear`.

Side-channel: `turns`, `tool_calls`, `denied_calls` (refused by hc's permission engine), token counts and `cost_usd` from hc's own JSON result (DeepSeek, real spend, hc's estimate); `latency_s` is hc's wall time.

**`judge $ ref` is the Claude API list price of the judge call as `claude -p` reports it (`total_cost_usd`). It is a reference value only: the judge runs on a Claude subscription, which is not charged per call.**

Not scored (kept in `errors.jsonl`): DeepSeek auth/quota/rate-limit/network/server errors after hc's own retries, wall-clock timeouts, judge failures. hc errors of other kinds (context length, protocol, bad request) and runs that hit `--max-turns` are scored like any other run.

## Hill-climb goal (from 2026-09-29)

- **Target:** `denied_calls` per run, lower is better: tool calls hc's permission engine refused. Baseline 1.88/run, 13.4% of all tool calls. Paired 95% half-width at 19 × 3: ±0.55/run; on the 9-case test split about ±0.8.
- **Guardrails:** `pass` >= 53/57 and no case falls from 3/3 to <=1/3; `overclaim` <= 1. `turns`, `cost_usd` and `latency_s` are reported but not targeted.
- **Split:** 10 train / 9 test, seeded (20260929), stratified by group. The analyzer reads train transcripts only; the headline is test.
- **Caveat:** the baseline breakdown of denials by cause was computed over all 19 cases *before* the split. Any change motivated by that breakdown, not by train transcripts, is marked as such in its change.md.

## Noise, measured (after round 1)

v1 changed only the `.env` template check, which none of the 10 train cases touch, so on train it is a no-change control. Train `denied_calls` still moved from 1.93 to 3.17 per run. Re-estimated from the v1-vs-baseline pairing, the half-width on `denied_calls` is about ±1.1/run over all 19 cases (±1.6 train, ±1.4 test), twice the first estimate. The cause is strategy variance with a heavy tail: in `simple-perf-fix`, all 3 baseline runs finished without a verification script (0 denials), while all 3 v1 runs wrote one and then made 5–7 refused attempts to delete it.

**Mechanism indicator: refused deletes.** Refused tool calls whose input deletes a file (`rm`, `rmdir`, `unlink`, `-delete`, `git clean`, `unlinkSync`, `rmSync`), counted from each run's full `trace.jsonl`. Baseline: 49 of 107 denials, in 17/57 runs. It is shown next to the target in the status table. It is computed from the traces on disk (`baseline/runs/*/trace.jsonl`), not stored on the result rows.
