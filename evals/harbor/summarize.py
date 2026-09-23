#!/usr/bin/env python3
"""Summarize Harbor trial results, separating infrastructure noise from agent failures.

    python3 evals/harbor/summarize.py [jobs_dir]      # default: evals/harbor/.jobs

Anthropic's "Quantifying infrastructure noise in agentic coding evals" found
container resources alone swing Terminal-Bench scores by several points. So a
trial that never got a fair attempt — the environment failed to start, the
provider was unreachable or out of balance — is reported as `infra` and kept
out of the agent's pass rate, instead of silently counting as a failure.

Buckets:
  pass          verifier reward >= 1
  agent-fail    the agent ran and the verifier said no
  agent-timeout the agent ran out of wall time (an agent outcome, shown apart)
  infra         setup/provider/verifier-infrastructure error, or no verdict at all

Stdlib only; reads the `result.json` Harbor writes per trial.
"""

from __future__ import annotations

import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

INFRA_EXCEPTIONS = {
    "EnvironmentStartTimeoutError",
    "AgentSetupTimeoutError",
    "VerifierTimeoutError",
    "NetworkConnectionError",
    "AgentAuthenticationError",
    "ModelNotFoundError",
    "ApiRateLimitError",
    "ApiUsageLimitError",
    "ApiInternalServerError",
    "ApiOverloadedError",
    "ApiConnectionClosedError",
    "ApiResponseStalledError",
    "ApiProviderResourceNotFoundError",
}
AGENT_TIMEOUT = {"AgentTimeoutError"}


def classify(result: dict) -> tuple[str, str]:
    exc = (result.get("exception_info") or {}).get("exception_type") or ""
    rewards = (result.get("verifier_result") or {}).get("rewards") or {}
    reward = rewards.get("reward")
    if reward is None and rewards:
        reward = min(rewards.values())
    if exc in INFRA_EXCEPTIONS:
        return "infra", exc
    if reward is not None and reward >= 1:
        return "pass", exc
    if exc in AGENT_TIMEOUT:
        return "agent-timeout", exc
    if reward is None:
        # No verdict and no recognised agent-side cause: the trial never got a fair run.
        return "infra", exc or "no verifier result"
    return "agent-fail", exc


def trial_results(jobs_dir: Path):
    for path in sorted(jobs_dir.rglob("result.json")):
        try:
            data = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        # Job-level result.json files have no task_name — skip them.
        if isinstance(data, dict) and "task_name" in data and "trial_name" in data:
            yield path, data


def main(argv: list[str]) -> int:
    repo = Path(__file__).resolve().parents[2]
    jobs_dir = Path(argv[1]) if len(argv) > 1 else repo / "evals" / "harbor" / ".jobs"
    if not jobs_dir.is_dir():
        print(f"no jobs directory at {jobs_dir}", file=sys.stderr)
        return 2

    by_task: dict[str, Counter] = defaultdict(Counter)
    causes: Counter = Counter()
    stops: Counter = Counter()
    envs: Counter = Counter()
    failures: list[tuple[str, str, str, Path]] = []
    for path, r in trial_results(jobs_dir):
        task = r["task_name"].split("/")[-1]
        bucket, exc = classify(r)
        by_task[task][bucket] += 1
        if bucket == "infra":
            causes[exc] += 1
        meta = (r.get("agent_result") or {}).get("metadata") or {}
        if bucket in ("agent-fail", "agent-timeout"):
            stops[meta.get("hc_stop_reason") or exc or "unknown"] += 1
            failures.append((task, bucket, meta.get("hc_stop_reason") or exc or "", path.parent))
        env_cfg = ((r.get("config") or {}).get("environment")) or {}
        envs[json.dumps({k: v for k, v in env_cfg.items() if v not in (None, [], {})}, sort_keys=True)] += 1

    if not by_task:
        print(f"no trial result.json files under {jobs_dir}", file=sys.stderr)
        return 1

    buckets = ["pass", "agent-fail", "agent-timeout", "infra"]
    total = Counter()
    print(f"| task | {' | '.join(buckets)} |")
    print(f"| --- | {' | '.join('---' for _ in buckets)} |")
    for task in sorted(by_task):
        c = by_task[task]
        total.update(c)
        print(f"| {task} | {' | '.join(str(c[b]) for b in buckets)} |")

    fair = total["pass"] + total["agent-fail"] + total["agent-timeout"]
    trials = fair + total["infra"]
    print()
    print(f"trials: {trials} · infra (excluded): {total['infra']} ({total['infra'] / trials:.0%})")
    if fair:
        print(f"agent pass rate over fair trials: {total['pass']}/{fair} = {total['pass'] / fair:.0%}")
    if causes:
        print("infra causes: " + ", ".join(f"{k} ×{v}" for k, v in causes.most_common()))
    if stops:
        print("agent failure stop reasons: " + ", ".join(f"{k} ×{v}" for k, v in stops.most_common()))
    print("environment config(s): " + "; ".join(f"{k} ×{v}" for k, v in envs.most_common()))
    if failures:
        print("\nagent failures to read (python3 evals/harbor/digest.py <jobs_dir> for their transcripts):")
        for task, bucket, stop, trial_dir in failures:
            print(f"  {task:32} {bucket:14} {stop:12} {trial_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
