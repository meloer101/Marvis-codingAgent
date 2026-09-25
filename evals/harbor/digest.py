#!/usr/bin/env python3
"""Turn each Harbor trial's `hc` session into a turn-by-turn timeline for error analysis.

    python3 evals/harbor/digest.py [jobs_dir] [--all] [-o out.md]

The Harbor counterpart of `pnpm eval --analyze`: read every trial yourself,
note the *first* thing that went wrong, and tally it in the failure-mode table
of docs/ROADMAP.md. Failing trials only by default; `--all` includes passes
(worth reading too — a pass that ran to the turn limit is still a failure mode).

Reads the trial's session log — `<trial>/agent/hc-state/sessions/<id>.jsonl`, or
`agent/hc-sessions/` for runs from before hc_agent.py pointed `HC_STATE_DIR` at
the log dir — and the trial's `result.json`. Each assistant turn becomes one
block: what it said, the tool calls it made, and a one-line view of each result,
with errors and denials marked. Stdlib only.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from summarize import classify, trial_results

TEXT_CLIP = 300
INPUT_CLIP = 200
RESULT_CLIP = 160


def clip(s: str, n: int) -> str:
    s = " ".join(s.split())
    return s if len(s) <= n else s[: n - 1] + "…"


def input_summary(name: str, args: object) -> str:
    if not isinstance(args, dict):
        return clip(json.dumps(args, ensure_ascii=False), INPUT_CLIP)
    # The argument that says what the call is about, when there is an obvious one.
    for key in ("command", "path", "pattern", "url", "query"):
        if isinstance(args.get(key), str):
            rest = {k: v for k, v in args.items() if k != key}
            extra = f"  {clip(json.dumps(rest, ensure_ascii=False), 60)}" if rest else ""
            return clip(args[key], INPUT_CLIP) + extra
    return clip(json.dumps(args, ensure_ascii=False), INPUT_CLIP)


def session_file(trial_dir: Path) -> Path | None:
    for sub in ("hc-state/sessions", "hc-sessions"):
        files = sorted((trial_dir / "agent" / sub).glob("*.jsonl"))
        if files:
            return files[-1]
    return None


def timeline(session: Path) -> list[str]:
    events = []
    for line in session.read_text(errors="replace").splitlines():
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue

    lines: list[str] = []
    turn = 0
    for ev in events:
        if ev.get("type") == "compaction":
            lines.append(f"- *(compaction: {ev.get('tokensBefore')} → {ev.get('tokensAfter')} tokens)*")
            continue
        if ev.get("type") != "message":
            continue
        msg = ev.get("message") or {}
        blocks = msg.get("content") or []
        if msg.get("role") == "assistant":
            turn += 1
            text = " ".join(b.get("text", "") for b in blocks if b.get("type") == "text").strip()
            calls = [b for b in blocks if b.get("type") == "tool_use"]
            lines.append(f"**t{turn}**" + (f" {clip(text, TEXT_CLIP)}" if text else ""))
            for c in calls:
                lines.append(f"  - `{c.get('name')}` {input_summary(c.get('name', ''), c.get('input'))}")
        elif msg.get("role") == "user":
            for b in blocks:
                if b.get("type") == "tool_result":
                    content = b.get("content") or ""
                    flag = "⛔ " if content.startswith("Denied:") else ("❌ " if b.get("isError") else "")
                    first = content.strip().splitlines()[0] if content.strip() else "(no output)"
                    lines.append(f"    → {flag}{clip(first, RESULT_CLIP)}")
                elif b.get("type") == "text" and turn > 0:
                    lines.append(f"- *user:* {clip(b.get('text', ''), TEXT_CLIP)}")
    return lines


def main(argv: list[str]) -> int:
    args = [a for a in argv[1:] if not a.startswith("-")]
    include_all = "--all" in argv
    out_path = None
    if "-o" in argv:
        out_path = Path(argv[argv.index("-o") + 1])
        args = [a for a in args if Path(a) != out_path]

    repo = Path(__file__).resolve().parents[2]
    jobs_dir = Path(args[0]) if args else repo / "evals" / "harbor" / ".jobs"
    if not jobs_dir.is_dir():
        print(f"no jobs directory at {jobs_dir}", file=sys.stderr)
        return 2

    parts: list[str] = [f"# Harbor transcript digest — `{jobs_dir}`", ""]
    shown = 0
    for path, r in trial_results(jobs_dir):
        bucket, exc = classify(r)
        if bucket == "pass" and not include_all:
            continue
        meta = (r.get("agent_result") or {}).get("metadata") or {}
        agent = r.get("agent_result") or {}
        task = r["task_name"].split("/")[-1]
        cost = agent.get("cost_usd")
        parts.append(f"## {task} — {bucket}")
        parts.append(
            f"stop `{meta.get('hc_stop_reason')}` · {meta.get('hc_turns')} turns"
            + (f" · ${cost:.3f}" if isinstance(cost, (int, float)) else "")
            + (f" · exception `{exc}`" if exc else "")
            + f" · `{path.parent}`"
        )
        parts.append("")
        session = session_file(path.parent)
        if session is None:
            parts.append("*(no session log — trial predates hc-sessions, or hc never started)*")
        else:
            parts.extend(timeline(session))
        parts.append("")
        parts.append("**First thing that went wrong:** _…_  **Failure mode:** _…_")
        parts.append("")
        shown += 1

    if shown == 0:
        parts.append("(no trials to show — pass `--all` to include passing trials)")
    text = "\n".join(parts) + "\n"
    if out_path:
        out_path.write_text(text)
        print(f"wrote {out_path} ({shown} trial(s))")
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
