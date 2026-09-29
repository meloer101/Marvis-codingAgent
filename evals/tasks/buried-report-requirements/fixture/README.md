# payments-logs

Scripts for looking at the payments service's application log.

`logs/` holds the aggregated log, one file per month. Every instance of the
service appends lines of the form

    <timestamp> <LEVEL> <message>

The timestamp is ISO 8601 in the instance's own local time, with its UTC
offset: `2026-09-03T23:58:12+08:00`, `2026-09-03T10:58:12-05:00` and
`2026-09-03T15:58:12Z` are the same moment. LEVEL is `INFO`, `WARN` or `ERROR`.
Stack traces and the odd operational marker end up in the same file.
