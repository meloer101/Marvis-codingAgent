Treat `cd <workspace root>` as a no-op in the permission engine, so `cd /abs/workspace && npm test` is judged as `npm test`

**Where it came from.** It's the round-2 analyzer's "next round" item: bucket D, an engine false positive. After round 2 it is the largest remaining cause.
- **Train, v2:** 16 of 33 denials were `cd <workspace root> && <allowed or read-only command>`, where the only failing segment is the `cd`.
- **All 19 cases, v2:** 23 of 50 denials. This is a count only; no test transcripts were read.
- **Pass risk:** the analyzer cited `reconcile-totals-diagnosis_rep2` [12], where `cd <ws> && cat data/transactions.csv` was denied. At [31] the agent concluded "Bash is blocked in this mode, so I verified by recomputing every account by hand", so it skipped running the check.

**The change.** In `evaluateBash`, a segment that is exactly `cd <path>` is dropped before the allow and read-only checks, but only when `<path>` resolves to the workspace root itself (symlinks resolved on both sides, so `/var/…` and `/private/var/…` both match). A `cd` that is the whole command is allowed.
- **Still asks:** `cd` into a subdirectory (`cd .git && cat config` would walk around the sensitive-path check), `cd ~`, `cd -`, `cd $X`, and `cd` anywhere else.
- **Unchanged:** deny rules, ask rules and the sensitive-file check still see the `cd` segment. `cd <root> && cat .env` is still denied, and `cd <root> && rm …` still asks.
- **Tests:** a new engine test covers all of the above. Permissions: 191 passed.

**Expected effect.**
- The mechanism indicator, refused `cd <workspace root>` commands, should go from 23 to 0.
- `denied_calls` should drop by about 0.4/run (0.88 → about 0.5), which is inside the ±1.0 noise at 3 reps. The indicator is what shows whether the change worked.
- It could help pass, since runs no longer conclude that bash is blocked.

**Risk.** Low. It is a pure no-op path, and nothing it allows could not be done by the same command without the `cd`.
