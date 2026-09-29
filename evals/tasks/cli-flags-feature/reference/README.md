# logq

Query JSON-lines log files from the terminal. Each line of the log is one event:

```json
{"ts":"2026-09-01T08:15:09.114Z","level":"info","svc":"api","msg":"POST /orders 201","reqId":"r-8812","durationMs":48}
```

`ts` is an ISO-8601 UTC timestamp, `level` is one of `debug`, `info`, `warn`,
`error`, `svc` is the service that logged it. Events may carry extra fields.

## Usage

```
logq [options] <file>
```

| Option            | Description                                                   |
| ----------------- | ------------------------------------------------------------- |
| `--level <level>` | only events at this level or above (`debug` < `info` < `warn` < `error`) |
| `--svc <name>`    | only events from this service                                 |
| `--since <time>`  | only events at or after `<time>`: a UTC date (`2026-09-01`, midnight UTC), an ISO time (`2026-09-01T10:00:00Z`), or a span back from now (`30m`, `2h`, `7d`) |
| `--json`          | print each matching event as one line of JSON (all fields, unchanged) instead of the table |
| `-h`, `--help`    | show the help                                                 |

`<file>` is the log to read; `-` reads standard input. Options can be combined
and given in any order. Matching events are printed as a table, oldest first as
they appear in the file:

```
$ logq examples/events.jsonl --level warn --svc worker
TIME (UTC)           LEVEL  SERVICE   MESSAGE
2026-09-01 08:47:55  WARN   worker    job export-7731 retried (attempt 2)
2026-09-02 02:10:44  WARN   worker    disk usage at 81%
2026-09-02 10:45:00  ERROR  worker    job import-118 failed: invalid CSV header
2026-09-02 10:45:00  WARN   worker    job import-118 moved to dead-letter queue
```

Exit codes: `0` success, `1` the file cannot be read, `2` invalid arguments
(including a `--since` value in none of the formats above).

Relative `--since` values count back from the current time; set `LOGQ_NOW`
(an ISO timestamp) to pin "now", e.g. in tests.

## Development

```sh
npm test
```
