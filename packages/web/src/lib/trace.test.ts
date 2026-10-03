import { describe, expect, it } from 'vitest';

import type { TraceEvent } from '@harness-code/core';

import { fmtCost } from './format';
import { traceRuns } from './trace';

const usage = { inputTokens: 100, outputTokens: 10, cachedInputTokens: 50 };

describe('traceRuns', () => {
  it('places each call on its run by when it started and how long it took', () => {
    const events: TraceEvent[] = [
      { type: 'run_start', ts: 1000, sessionId: 's', model: 'x/m', cwd: '/' },
      { type: 'model_call', ts: 3000, turn: 1, model: 'x/m', latencyMs: 2000, stopReason: 'tool_use', ...usage },
      { type: 'tool_call', ts: 4000, turn: 1, id: 't', name: 'bash', inputSummary: '{"command":"ls"}', durationMs: 1000, isError: false, outputBytes: 12 },
      { type: 'context', ts: 4000, turn: 2, usedTokens: 1, windowTokens: 2, ratio: 0.5, breakdown: {} as never },
      { type: 'error', ts: 4500, turn: 2, scope: 'provider', message: 'busy', willRetry: true },
      { type: 'model_call', ts: 5000, turn: 2, model: 'x/m', latencyMs: 500, costUSD: 0.01, stopReason: 'end_turn', ...usage },
      { type: 'run_end', ts: 5000, stopReason: 'end_turn', turns: 2, wallMs: 4000, costUSD: 0.01, ...usage },
      { type: 'run_start', ts: 9000, sessionId: 's', model: 'x/m', cwd: '/' },
    ];
    const [first, second] = traceRuns(events);
    expect(first).toMatchObject({ startedAt: 1000, wallMs: 4000, stopReason: 'end_turn', costUSD: 0.01 });
    expect(first!.rows.map((r) => r.kind)).toEqual(['model', 'tool', 'error', 'model']);
    expect(first!.rows[0]).toMatchObject({ at: 0, span: 0.5 });
    expect(first!.rows[1]).toMatchObject({ at: 0.5, span: 0.25, name: 'bash' });
    expect(first!.rows[2]).toMatchObject({ retried: true });
    // A run still going: no end, no stop reason.
    expect(second).toMatchObject({ startedAt: 9000, rows: [] });
    expect(second!.stopReason).toBeUndefined();
  });

  it('formats a sum spent with more places the smaller it is', () => {
    expect([0, 0.0042, 0.512, 12.4, 1204].map(fmtCost)).toEqual(['$0', '$0.0042', '$0.512', '$12.40', '$1,204.00']);
  });
});
