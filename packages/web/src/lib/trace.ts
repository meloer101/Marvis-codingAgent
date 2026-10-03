/**
 * A session's trace (`session.trace`) shaped for the Trace tab: one block per
 * run, and in it one row per model call, tool call, compaction or error, each
 * placed on the run's span by when it started and how long it took — the
 * waterfall the tab draws.
 */

import type { TraceEvent } from '@harness-code/core';

export type TraceRow =
  | {
      kind: 'model';
      /** Offset and length on the run's span, 0–1. */
      at: number;
      span: number;
      durationMs?: number;
      model: string;
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens: number;
      ttftMs?: number;
      costUSD?: number;
      stopReason: string;
    }
  | {
      kind: 'tool';
      at: number;
      span: number;
      durationMs: number;
      name: string;
      input: string;
      outputBytes: number;
      failed: boolean;
      denied: boolean;
    }
  | { kind: 'compaction'; at: number; tokensBefore: number; tokensAfter: number }
  | { kind: 'error'; at: number; scope: 'provider' | 'tool'; message: string; retried: boolean };

export interface TraceRun {
  startedAt: number;
  /** How long it ran; until the last event when it never ended (or is still going). */
  wallMs: number;
  model: string;
  /** Why it stopped; absent while it runs, or when it never ended. */
  stopReason?: string;
  costUSD?: number;
  rows: TraceRow[];
}

/** The runs a session's trace records, oldest first. */
export function traceRuns(events: readonly TraceEvent[]): TraceRun[] {
  const runs: Array<{ start: number; end?: number; model: string; stop?: string; cost?: number; events: TraceEvent[] }> = [];
  for (const e of events) {
    if (e.type === 'run_start') runs.push({ start: e.ts, model: e.model, events: [] });
    else if (e.type === 'classifier' || e.type === 'subagent' || e.type === 'context') continue;
    else {
      // Events before any run_start (an old trace): a run of their own.
      if (runs.length === 0) runs.push({ start: e.ts, model: '', events: [] });
      const run = runs[runs.length - 1]!;
      if (e.type === 'run_end') {
        run.end = e.ts;
        run.stop = e.stopReason;
        if (e.costUSD !== undefined) run.cost = e.costUSD;
      } else {
        run.events.push(e);
      }
    }
  }
  return runs.map((run) => {
    const last = Math.max(run.start, ...run.events.map((e) => e.ts));
    const wallMs = Math.max(1, (run.end ?? last) - run.start);
    const place = (ts: number, durationMs = 0): { at: number; span: number } => {
      const at = Math.min(1, Math.max(0, (ts - durationMs - run.start) / wallMs));
      return { at, span: Math.min(1 - at, Math.max(0, durationMs / wallMs)) };
    };
    const rows: TraceRow[] = run.events.flatMap((e): TraceRow[] => {
      switch (e.type) {
        case 'model_call':
          return [
            {
              kind: 'model',
              ...place(e.ts, e.latencyMs),
              ...(e.latencyMs !== undefined ? { durationMs: e.latencyMs } : {}),
              model: e.model,
              inputTokens: e.inputTokens,
              outputTokens: e.outputTokens,
              cachedInputTokens: e.cachedInputTokens,
              ...(e.ttftMs !== undefined ? { ttftMs: e.ttftMs } : {}),
              ...(e.costUSD !== undefined ? { costUSD: e.costUSD } : {}),
              stopReason: e.stopReason,
            },
          ];
        case 'tool_call':
          return [
            {
              kind: 'tool',
              ...place(e.ts, e.durationMs),
              durationMs: e.durationMs,
              name: e.name,
              input: e.inputSummary,
              outputBytes: e.outputBytes,
              failed: e.isError,
              denied: e.denied === true,
            },
          ];
        case 'compaction':
          return [{ kind: 'compaction', at: place(e.ts).at, tokensBefore: e.tokensBefore, tokensAfter: e.tokensAfter }];
        case 'error':
          return [{ kind: 'error', at: place(e.ts).at, scope: e.scope, message: e.message, retried: e.willRetry === true }];
        default:
          return [];
      }
    });
    return {
      startedAt: run.start,
      wallMs,
      model: run.model,
      ...(run.stop !== undefined ? { stopReason: run.stop } : {}),
      ...(run.cost !== undefined ? { costUSD: run.cost } : {}),
      rows,
    };
  });
}

/** `1.2 KB`, `340 B`. */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
