#!/usr/bin/env bash
# Run `hc` on the Terminal-Bench 2.0 subset via Harbor (local Docker).
#
#   evals/harbor/run-subset.sh [extra harbor run args...]
#   HC_BENCH_LIST=evals/harbor/heldout.txt evals/harbor/run-subset.sh   # held-out set
#   HC_BENCH_WAIT_OFFPEAK=1 evals/harbor/run-subset.sh                  # wait for the cheap window
#
# Afterwards: python3 evals/harbor/summarize.py   (infra errors vs agent failures)
#
# Prereqs:
#   * Docker running
#   * `uv tool install harbor`
#   * `pnpm bundle` (writes dist-bundle/hc.mjs)
#   * an API key for the chosen model exported (default: DEEPSEEK_API_KEY)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"

MODEL="${HC_BENCH_MODEL:-deepseek/deepseek-v4-pro}"
KEY_ENV="${HC_BENCH_KEY_ENV:-DEEPSEEK_API_KEY}"
CONCURRENCY="${HC_BENCH_CONCURRENCY:-4}"
JOBS_DIR="${HC_BENCH_JOBS_DIR:-$repo/evals/harbor/.jobs}"
LIST="${HC_BENCH_LIST:-$here/subset.txt}"

if [[ ! -f "$repo/dist-bundle/hc.mjs" ]]; then
  echo "dist-bundle/hc.mjs missing — run 'pnpm bundle' first" >&2
  exit 1
fi
if [[ -z "${!KEY_ENV:-}" ]]; then
  echo "\$$KEY_ENV is not set (needed for model $MODEL)" >&2
  exit 1
fi

# subset.txt holds bare names; the dataset namespaces them as
# terminal-bench/<name>, and -i matches on that full name. (Plain `while read`
# loop, not `mapfile` — macOS ships bash 3.2.)
task_args=()
n_tasks=0
while IFS= read -r t; do
  case "$t" in ''|\#*) continue ;; esac
  case "$t" in */*) task_args+=(-i "$t") ;; *) task_args+=(-i "terminal-bench/$t") ;; esac
  n_tasks=$((n_tasks + 1))
done < "$LIST"

# DeepSeek bills peak (Mon-Fri 01:00-04:00 and 06:00-10:00 UTC) at roughly twice
# the off-peak rate, and a full sweep is long enough for that to matter.
peak_seconds_left() {
  local day hour
  day=$(date -u +%u)
  hour=$(date -u +%H)
  # 10#: keep leading-zero hours out of octal.
  if [[ $day -ge 6 ]]; then echo 0; return; fi
  if [[ $((10#$hour)) -ge 1 && $((10#$hour)) -lt 4 ]]; then
    echo $(( (4 - 10#$hour) * 3600 - 10#$(date -u +%M) * 60 ))
  elif [[ $((10#$hour)) -ge 6 && $((10#$hour)) -lt 10 ]]; then
    echo $(( (10 - 10#$hour) * 3600 - 10#$(date -u +%M) * 60 ))
  else
    echo 0
  fi
}

wait_s=$(peak_seconds_left)
if [[ $wait_s -gt 0 ]]; then
  if [[ "${HC_BENCH_WAIT_OFFPEAK:-}" == "1" ]]; then
    echo "peak pricing for another $((wait_s / 60)) min — waiting for the off-peak window"
    sleep "$wait_s"
  else
    echo "note: peak pricing for another $((wait_s / 60)) min (~2x). HC_BENCH_WAIT_OFFPEAK=1 waits it out." >&2
  fi
fi

echo "hc @ terminal-bench-2  |  list=$(basename "$LIST")  model=$MODEL  tasks=$n_tasks  concurrency=$CONCURRENCY"

exec env PYTHONPATH="$here" harbor run \
  -d terminal-bench/terminal-bench-2 \
  -a hc_agent:HcAgent \
  -m "$MODEL" \
  "${task_args[@]}" \
  -n "$CONCURRENCY" \
  -o "$JOBS_DIR" \
  -y \
  --ae "$KEY_ENV=${!KEY_ENV}" \
  "$@"
