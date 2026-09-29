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

Exit codes: `0` success, `1` the file cannot be read, `2` invalid arguments.

## Development

```sh
npm test
```
