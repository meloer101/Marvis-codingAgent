import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, Minimize2, RefreshCw, TriangleAlert, X } from 'lucide-react';

import { fmtTokens } from '@harness-code/core/browser';
import type { SessionTrace } from '@harness-code/protocol';

import { useSync } from '@/lib/syncContext';
import { fmtCost, fmtDuration, fmtPartialCost } from '@/lib/format';
import { fmtBytes, traceRuns } from '@/lib/trace';
import type { TraceRow, TraceRun } from '@/lib/trace';
import { cn } from '@/lib/utils';

/**
 * A session's trace: what it added up to, then each run as a waterfall — a
 * row per model call (violet) and tool call (teal), placed on the run's span
 * by when it started and how long it took, with failures, compactions and
 * provider errors marked. Read again when a run ends.
 */
export function TracePanel({ sessionId, running }: { sessionId: string; running: boolean }) {
  const sync = useSync();
  const [trace, setTrace] = useState<SessionTrace | null | 'error'>(null);
  const [rev, setRev] = useState(0);
  useEffect(() => {
    let cancelled = false;
    sync.loadTrace(sessionId).then(
      (t) => !cancelled && setTrace(t),
      () => !cancelled && setTrace('error'),
    );
    return () => {
      cancelled = true;
    };
  }, [sync, sessionId, running, rev]);
  const runs = useMemo(() => (trace && trace !== 'error' ? traceRuns(trace.events) : []), [trace]);

  if (trace === null) return <p className="px-4 py-3 text-xs text-muted-foreground">Reading the trace…</p>;
  if (trace === 'error') return <p className="px-4 py-3 text-xs text-destructive">The trace couldn’t be read.</p>;
  if (runs.length === 0) {
    return (
      <p className="px-6 py-16 text-center text-[13px] text-muted-foreground">
        No trace yet — model and tool calls are recorded as the session runs (unless telemetry is off).
      </p>
    );
  }
  const s = trace.summary;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-col gap-1 pr-3 pb-2 pl-5 font-mono text-[11px] text-faint">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate">
            {runs.length} {runs.length === 1 ? 'run' : 'runs'} · {s.turns} model {s.turns === 1 ? 'call' : 'calls'} ·{' '}
            {s.toolCalls} tool {s.toolCalls === 1 ? 'call' : 'calls'}
            {s.wallMs > 0 && ` · ${fmtDuration(s.wallMs)}`}
          </span>
          <button
            type="button"
            onClick={() => setRev((r) => r + 1)}
            aria-label="Refresh"
            title="Refresh"
            className="rounded-md p-1 transition-colors hover:bg-background hover:text-foreground"
          >
            <RefreshCw className="size-3" />
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span title="Input / output tokens">
            ↑{fmtTokens(s.inputTokens)} ↓{fmtTokens(s.outputTokens)}
          </span>
          <span title="Share of input tokens served from the provider's cache">{Math.round(s.cacheHitRate * 100)}% cached</span>
          <span title={s.costPartial ? 'Some calls had no price' : 'Cost'}>{fmtPartialCost(s.costUSD, s.costPartial)}</span>
          <span className="flex-1" />
          <Legend />
        </div>
      </div>
      <div className="mx-3 mb-3 min-h-0 flex-1 overflow-y-auto rounded-lg bg-background py-1">
        {runs.map((run, i) => (
          <RunBlock key={run.startedAt} run={run} n={i + 1} defaultOpen={i === runs.length - 1} />
        ))}
      </div>
    </div>
  );
}

function Legend() {
  return (
    <span className="flex items-center gap-2 font-sans">
      <span className="flex items-center gap-1">
        <span className="size-2 rounded-sm bg-chart-1" />
        Model call
      </span>
      <span className="flex items-center gap-1">
        <span className="size-2 rounded-sm bg-chart-2" />
        Tool call
      </span>
    </span>
  );
}

function RunBlock({ run, n, defaultOpen }: { run: TraceRun; n: number; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const time = new Date(run.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return (
    <section>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-[11px] text-faint transition-colors hover:bg-subtle"
      >
        <ChevronRight className={cn('size-3 shrink-0 transition-transform', open && 'rotate-90')} />
        <span className="font-sans text-xs font-medium text-foreground">Run {n}</span>
        <span>{time}</span>
        <span className="min-w-0 flex-1 truncate">{run.model.replace(/^[^/]*\//, '')}</span>
        <span>{fmtDuration(run.wallMs)}</span>
        {run.stopReason && run.stopReason !== 'end_turn' && <span className="text-destructive">{run.stopReason}</span>}
        {run.costUSD !== undefined && <span>{fmtCost(run.costUSD)}</span>}
      </button>
      {open && (
        <ul className="pb-1.5">
          {run.rows.map((row, i) => (
            <Row key={i} row={row} />
          ))}
          {run.rows.length === 0 && <li className="px-8 py-1 text-[11px] text-muted-foreground">Nothing recorded.</li>}
        </ul>
      )}
    </section>
  );
}

/** One row: what it was, its bar on the run's span, how long it took. */
function Row({ row }: { row: TraceRow }) {
  const track = (bar: string, at: number, span: number) => (
    <span className="relative h-2 min-w-0 flex-1 rounded-sm bg-subtle">
      <span
        className={cn('absolute top-0 h-2 rounded-sm', bar)}
        style={{ left: `${at * 100}%`, width: `max(${span * 100}%, 3px)` }}
      />
    </span>
  );
  const line = 'flex items-center gap-2 px-3 py-0.5 pl-8 text-[11px]';
  switch (row.kind) {
    case 'model':
      return (
        <li
          className={line}
          title={[
            row.model,
            `↑${row.inputTokens.toLocaleString()} in (${row.cachedInputTokens.toLocaleString()} cached) · ↓${row.outputTokens.toLocaleString()} out`,
            row.ttftMs !== undefined ? `first token after ${fmtDuration(row.ttftMs)}` : '',
            row.costUSD !== undefined ? fmtCost(row.costUSD) : '',
            `stopped: ${row.stopReason}`,
          ]
            .filter(Boolean)
            .join('\n')}
        >
          <span className="w-36 shrink-0 truncate font-mono">
            model <span className="text-muted-foreground">↑{fmtTokens(row.inputTokens)} ↓{fmtTokens(row.outputTokens)}</span>
          </span>
          {track('bg-chart-1', row.at, row.span)}
          <span className="w-12 shrink-0 text-right font-mono text-muted-foreground tabular-nums">
            {row.durationMs !== undefined ? fmtDuration(row.durationMs) : ''}
          </span>
        </li>
      );
    case 'tool':
      return (
        <li className={line} title={`${row.name} ${row.input}\n${fmtBytes(row.outputBytes)} out`}>
          <span className="flex w-36 shrink-0 items-center gap-1 overflow-hidden font-mono">
            {(row.failed || row.denied) && <X className="size-3 shrink-0 text-destructive" aria-hidden />}
            <span className="shrink-0">{row.name}</span>
            {row.denied ? (
              <span className="shrink-0 font-sans text-destructive">denied</span>
            ) : row.failed ? (
              <span className="shrink-0 font-sans text-destructive">failed</span>
            ) : (
              <span className="truncate text-muted-foreground">{row.input.replace(/^\{|\}$/g, '')}</span>
            )}
          </span>
          {track('bg-chart-2', row.at, row.span)}
          <span className="w-12 shrink-0 text-right font-mono text-muted-foreground tabular-nums">{fmtDuration(row.durationMs)}</span>
        </li>
      );
    case 'compaction':
      return (
        <li className={cn(line, 'text-muted-foreground')}>
          <Minimize2 className="size-3 shrink-0" />
          <span className="font-mono">
            compacted {fmtTokens(row.tokensBefore)} → {fmtTokens(row.tokensAfter)}
          </span>
        </li>
      );
    case 'error':
      return (
        <li className={cn(line, 'text-destructive')} title={row.message}>
          <TriangleAlert className="size-3 shrink-0" />
          <span className="min-w-0 truncate">
            {row.scope} error{row.retried ? ' · retried' : ''}: {row.message}
          </span>
        </li>
      );
  }
}
