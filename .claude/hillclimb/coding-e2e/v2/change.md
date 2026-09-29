Give throwaway files a home in the system temp dir and stop asking the agent to delete them (removes the "scratch file → rm refused → retry" chain)

**Where it came from.** A fresh analyzer read train transcripts only (10 cases × 3 reps) and bucketed all 58 train denials by root cause. It checked each one by replaying the refused command through the lab's permission engine with that run's allow rules.

| bucket | denials | runs | kind |
|---|---|---|---|
| A. deleting its own scratch files at the end (`rm`, `unlink`, `find -delete`, `git clean`, `node -e unlinkSync`), 3–5 variants per run | 22 | 7 | agent behaviour; the `rm` ask itself stays |
| B. `node -e` for an ad-hoc probe | 8 | 8 | deliberate ask; steerable |
| C. heredoc / `$(...)` to create a scratch file or temp dir | 5 | 5 | deliberate ask; steerable |
| D. `cd <workspace> && <allowed cmd>`: only the `cd` fails | 11 | 6 | engine false positive (next round) |
| E. `awk` / `sed -n` slicing | 5 | 2 | deliberate ask |
| F. other (python3 not allowed, `cd` outside, ...) | 7 | 5 | deliberate ask |

A–C are one chain, 35 of 58 (60%):
1. Inline code gets refused, and the refusal says "write the code to a file".
2. The agent writes the file into the workspace.
3. `<working_style>` then says "before finishing, remove any scratch file you created".
4. `rm` is never auto-approved, so it's refused. The agent retries variants, and 3 runs dodged the refusal with a self-deleting `node cleanup.js`.

Cited:
- `concurrency-limit-bug_rep1` [28]: "I could not remove my scratch file `verify.mjs` — the sandbox denies `rm` (and inline `node -e`), so please delete it".
- `recover-before-probe_rep2` [49]: "clean up the scratch script /tmp/hc-recover.mjs (outside workspace but remove anyway)", then `rm -f /tmp/hc-recover.mjs` was refused.
- `recover-before-probe_rep1` [38] shows the target behaviour already working: `node /tmp/orders-backup.mjs data /tmp/orders-backup`.

**The change.** One hypothesis: the agent has no sanctioned place for throwaway files, yet it is told to delete them.
- The environment segment names the scratch dir (`os.tmpdir()`). File tools (`allowScratch`) and the macOS sandbox already allow writes there.
- `<working_style>` now says throwaway files go there, get created with `write`, and are run by full path instead of via `node -e` / `python -c` / heredoc / `$(...)`. Nothing there needs deleting. A leftover workspace file is named in the summary, not deleted over and over. The old "before finishing, remove any scratch file" sentence is removed.
- The engine's refusal for unreviewable commands points at the same directory.
- The pnpm-eval harness pins `scratchDir: '/tmp'`, next to its pinned `platform`, so recorded cassettes stay machine-independent. That keeps CI's `pnpm eval` replay deterministic once cassettes are re-recorded.

**Nothing is loosened.** `rm`, inline code, heredocs and `$(...)` ask exactly as before.

**Checks in the lab:**
- `packages/core`: 795 passed, 1 skipped; `tsc -b` clean.
- The system prompt changed, so the `pnpm eval` cassettes no longer match: `evals/src/harness.test.ts` has 2 replay tests failing, and `pnpm eval` too. **If v2 is kept, merging needs `pnpm eval --record` (live DeepSeek, cents) to re-record the cassettes and the baseline.**

**Expected effect:**
- Train: 20–28 of 58 denials removed, taking 1.93/run to about 1.0–1.3/run.
- Worst case, only bucket A responds: about −0.5/run, right at the ±0.55 noise floor.
- Mechanism indicator: runs that write into the temp dir, and runs with refused delete attempts.

**Risks:**
- `pass`: a deliverable put in the temp dir by mistake. The prompt says task outputs stay in the workspace.
- A temp-dir script importing the workspace relatively, costing a turn.
- Concurrent reps sharing `$TMPDIR` names, also costing a turn.
- Watch as a side check: the `scratch-sprawl` grader, since the explicit cleanup rule is gone.
