import { describe, expect, it } from 'vitest';

import type { SessionSnapshot, WireEvent } from '@harness-code/protocol';

import { SessionModel } from './sessionModel';

function snapshot(over: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return { id: 's1', modelRef: 'mock/m', mode: 'ask', transcript: [], running: false, lastSeq: 0, ...over };
}

function feed(model: SessionModel, events: WireEvent[], from = model.lastSeq + 1): void {
  events.forEach((e, i) => model.apply(from + i, e));
}

const usage = { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 };

describe('SessionModel', () => {
  it('folds one full run into user + assistant entries', () => {
    const m = new SessionModel(snapshot());
    feed(m, [
      { type: 'run_start', runId: 'r', input: 'hi' },
      { type: 'thinking_delta', text: 'hmm' },
      { type: 'text_delta', text: 'Hel' },
      { type: 'text_delta', text: 'lo' },
    ]);
    expect(m.state.running).toBe(true);
    expect(m.state.live).toMatchObject({ thinking: 'hmm', text: 'Hello' });

    feed(m, [{ type: 'run_end', runId: 'r', stopReason: 'end_turn', usage, sessionUsage: usage }]);
    const s = m.state;
    expect(s.running).toBe(false);
    expect(s.usage).toEqual(usage);
    expect(s.live).toEqual({ thinking: '', text: '', tools: [] });
    expect(s.entries).toMatchObject([
      { kind: 'user', text: 'hi' },
      { kind: 'assistant', thinking: 'hmm', text: 'Hello', tools: [] },
    ]);
  });

  it('commits a completed tool batch as its own entry', () => {
    const m = new SessionModel(snapshot());
    feed(m, [
      { type: 'run_start', runId: 'r', input: 'go' },
      { type: 'text_delta', text: 'looking' },
      { type: 'tool_call_start', id: 't1', name: 'bash', input: { command: 'ls' } },
    ]);
    expect(m.state.live.tools[0]).toMatchObject({ id: 't1', running: true });
    feed(m, [{ type: 'tool_call_end', id: 't1', name: 'bash', result: { content: 'a\nb' } }]);
    const s = m.state;
    expect(s.live.tools).toHaveLength(0);
    expect(s.entries.at(-1)).toMatchObject({
      kind: 'assistant',
      text: 'looking',
      tools: [{ id: 't1', running: false, result: { content: 'a\nb' } }],
    });
  });

  it('shows a message read mid-run where it was read: after the step, before the next', () => {
    const m = new SessionModel(snapshot());
    feed(m, [
      { type: 'run_start', runId: 'r', input: 'go' },
      { type: 'tool_call_start', id: 't1', name: 'bash', input: { command: 'ls' } },
      { type: 'tool_call_end', id: 't1', name: 'bash', result: { content: 'a' } },
      { type: 'user_input', text: 'use b instead', attachments: ['b.txt'] },
      { type: 'text_delta', text: 'ok, b' },
    ]);
    expect(m.state.entries).toMatchObject([
      { kind: 'user', text: 'go' },
      { kind: 'assistant', tools: [{ id: 't1' }] },
      { kind: 'user', text: 'use b instead', attachments: ['b.txt'] },
    ]);
    expect(m.state.live.text).toBe('ok, b');
  });

  it('drops duplicate and stale seqs', () => {
    const m = new SessionModel(snapshot({ lastSeq: 5 }));
    expect(m.apply(5, { type: 'run_start', runId: 'r', input: 'old' })).toBe(false);
    expect(m.apply(6, { type: 'run_start', runId: 'r', input: 'new' })).toBe(true);
    expect(m.apply(6, { type: 'run_start', runId: 'r', input: 'dup' })).toBe(false);
    expect(m.state.entries).toMatchObject([{ kind: 'user', text: 'new' }]);
  });

  it('tracks ask/plan ids and clears them on resolved', () => {
    const m = new SessionModel(snapshot());
    feed(m, [{ type: 'ask', askId: 'a1', toolName: 'bash', input: { command: 'rm x' }, reason: 'why' }]);
    expect(m.state.pendingAsk).toMatchObject({ toolName: 'bash' });
    expect(m.state.askId).toBe('a1');
    feed(m, [{ type: 'resolved', requestId: 'a1', by: 'user' }]);
    expect(m.state.pendingAsk).toBeNull();
    expect(m.state.askId).toBeNull();

    feed(m, [{ type: 'plan', planId: 'p1', title: 'T', body: 'B' }]);
    expect(m.state.planId).toBe('p1');
    feed(m, [{ type: 'resolved', requestId: 'p1', by: 'abort' }]);
    expect(m.state.pendingPlan).toBeNull();
  });

  it('turns run_error and aborts into notices', () => {
    const m = new SessionModel(snapshot());
    feed(m, [
      { type: 'run_start', runId: 'r', input: 'x' },
      { type: 'text_delta', text: 'partial' },
      { type: 'run_end', runId: 'r', stopReason: 'aborted', usage, sessionUsage: usage },
      { type: 'run_start', runId: 'r2', input: '/nope' },
      { type: 'run_error', runId: 'r2', message: 'unknown command "/nope"' },
    ]);
    expect(m.state.entries.map((e) => e.kind)).toEqual(['user', 'assistant', 'notice', 'user', 'notice']);
    expect(m.state.entries[2]).toMatchObject({ notice: { text: 'Interrupted.' } });
    expect(m.state.entries[4]).toMatchObject({ notice: { level: 'error' } });
    expect(m.state.running).toBe(false);
  });

  it('discards a failed attempt on turn_retry', () => {
    const m = new SessionModel(snapshot());
    feed(m, [
      { type: 'run_start', runId: 'r', input: 'x' },
      { type: 'context', usedTokens: 100, windowTokens: 1000, ratio: 0.1, breakdown: {} as never },
      { type: 'text_delta', text: 'broken' },
      { type: 'turn_retry', attempt: 1, maxAttempts: 3, delayMs: 10, message: 'overloaded' },
      { type: 'text_delta', text: 'good' },
    ]);
    expect(m.state.live.text).toBe('good');
    expect(m.state.context).toMatchObject({ ratio: 0.1 });
  });

  it('keeps committed entry identity while the live region streams', () => {
    const m = new SessionModel(snapshot());
    feed(m, [
      { type: 'run_start', runId: 'r', input: 'x' },
      { type: 'text_delta', text: 'a' },
    ]);
    const first = m.state.entries[0];
    feed(m, [{ type: 'text_delta', text: 'b' }]);
    expect(m.state.entries[0]).toBe(first);
  });

  it('opened mid-ask: updates the snapshot tool card instead of duplicating it', () => {
    const m = new SessionModel(
      snapshot({
        running: true,
        lastSeq: 10,
        transcript: [
          { type: 'message', ts: 1, message: { role: 'user', content: [{ type: 'text', text: 'go' }] } },
          {
            type: 'message',
            ts: 2,
            message: { role: 'assistant', content: [{ type: 'tool_use', id: 'w1', name: 'write', input: {} }] },
          },
        ],
      }),
    );
    feed(m, [
      { type: 'tool_call_start', id: 'w1', name: 'write', input: {} },
      { type: 'tool_call_end', id: 'w1', name: 'write', result: { content: 'ok' } },
      { type: 'text_delta', text: 'done' },
      { type: 'run_end', runId: 'r', stopReason: 'end_turn', usage, sessionUsage: usage },
    ]);
    const tools = m.state.entries.flatMap((e) => (e.kind === 'assistant' ? e.tools : []));
    expect(tools).toMatchObject([{ id: 'w1', running: false, result: { content: 'ok' } }]);
    expect(m.state.entries.at(-1)).toMatchObject({ kind: 'assistant', text: 'done', tools: [] });
  });

  it('opened mid-command: streams output into the snapshot card, then the result replaces it', () => {
    const m = new SessionModel(
      snapshot({
        running: true,
        lastSeq: 10,
        transcript: [
          { type: 'message', ts: 1, message: { role: 'user', content: [{ type: 'text', text: 'go' }] } },
          {
            type: 'message',
            ts: 2,
            message: { role: 'assistant', content: [{ type: 'tool_use', id: 'b1', name: 'bash', input: { command: 'make' } }] },
          },
        ],
      }),
    );
    const card = () => m.state.entries.flatMap((e) => (e.kind === 'assistant' ? e.tools : []))[0]!;
    feed(m, [{ type: 'tool_call_output', id: 'b1', text: 'too early\n' }]); // not running yet: dropped
    feed(m, [
      { type: 'tool_call_start', id: 'b1', name: 'bash', input: { command: 'make' } },
      { type: 'tool_call_output', id: 'b1', text: 'cc a.c\n' },
      { type: 'tool_call_output', id: 'b1', text: 'cc b.c\n' },
    ]);
    expect(card()).toMatchObject({ running: true, output: 'cc a.c\ncc b.c\n' });
    feed(m, [{ type: 'tool_call_end', id: 'b1', name: 'bash', result: { content: 'done' }, durationMs: 2100 }]);
    expect(card()).toEqual({ id: 'b1', name: 'bash', input: { command: 'make' }, running: false, result: { content: 'done' }, durationMs: 2100 });
  });

  it("opened mid-task: nests the sub-agent's calls in the snapshot card", () => {
    const m = new SessionModel(
      snapshot({
        running: true,
        lastSeq: 10,
        transcript: [
          {
            type: 'message',
            ts: 2,
            message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'task', input: { prompt: 'p' } }] },
          },
        ],
      }),
    );
    const card = () => m.state.entries.flatMap((e) => (e.kind === 'assistant' ? e.tools : []))[0]!;
    feed(m, [
      { type: 'tool_call_start', id: 't1', name: 'task', input: { prompt: 'p' } },
      { type: 'subagent_event', id: 't1', event: { type: 'tool_call_start', id: 'c1', name: 'read', input: { path: 'a' } } },
      { type: 'subagent_event', id: 't1', event: { type: 'tool_call_start', id: 'c2', name: 'read', input: { path: 'b' } } },
      { type: 'subagent_event', id: 't1', event: { type: 'tool_call_end', id: 'c1', name: 'read', result: { content: 'A' } } },
    ]);
    expect(card().children!.map((c) => [c.id, c.running])).toEqual([
      ['c1', false],
      ['c2', true],
    ]);
    feed(m, [{ type: 'tool_call_end', id: 't1', name: 'task', result: { content: 'report' } }]);
    expect(card().children!.map((c) => c.running)).toEqual([false, false]);
  });

  it('reset() replaces state from a snapshot, pending ask included', () => {
    const m = new SessionModel(snapshot());
    feed(m, [{ type: 'run_start', runId: 'r', input: 'x' }]);
    m.reset(
      snapshot({
        lastSeq: 40,
        running: true,
        pendingAsk: { askId: 'a9', toolName: 'edit', input: {}, reason: '' },
      }),
    );
    expect(m.lastSeq).toBe(40);
    expect(m.state).toMatchObject({ running: true, askId: 'a9', entries: [] });
  });
});

// `entriesFromTranscript` moved to `@harness-code/protocol`; its unit test now
// lives in `packages/protocol/src/fold/transcript.test.ts`.

describe('SessionModel effort', () => {
  it('takes effort and levels from the snapshot, then follows effort events', () => {
    const m = new SessionModel(snapshot({ effort: 'high', effortLevels: ['low', 'high', 'max'] }));
    expect(m.state).toMatchObject({ effort: 'high', effortLevels: ['low', 'high', 'max'] });
    feed(m, [{ type: 'effort', effort: 'max' }]);
    expect(m.state.effort).toBe('max');
    // Other events keep the levels (they live outside the shared fold state).
    feed(m, [{ type: 'mode', mode: 'plan' }]);
    expect(m.state).toMatchObject({ mode: 'plan', effort: 'max', effortLevels: ['low', 'high', 'max'] });
  });

  it('has no effort and no levels for a model without reasoning', () => {
    const m = new SessionModel(snapshot());
    expect(m.state.effort).toBeUndefined();
    expect(m.state.effortLevels).toEqual([]);
  });

  it('follows a model switch: its levels, its effort (or none) and the meter against its window', () => {
    const m = new SessionModel(snapshot({ effort: 'high', effortLevels: ['low', 'high'] }));
    const context = { usedTokens: 50, windowTokens: 100, ratio: 0.5 };
    feed(m, [{ type: 'model', modelRef: 'other/plain', effortLevels: [], context }]);
    expect(m.state).toMatchObject({ modelRef: 'other/plain', effortLevels: [], context });
    expect(m.state.effort).toBeUndefined();
    feed(m, [{ type: 'model', modelRef: 'mock/m', effortLevels: ['low', 'max'], effort: 'max' }]);
    expect(m.state).toMatchObject({ modelRef: 'mock/m', effortLevels: ['low', 'max'], effort: 'max', context });
  });

  it('follows the queue from the snapshot and its events', () => {
    const m = new SessionModel(snapshot({ running: true, queue: [{ id: 'q1', text: 'later' }] }));
    expect(m.state.queue).toEqual([{ id: 'q1', text: 'later' }]);
    feed(m, [{ type: 'queue', queue: [] }]);
    expect(m.state.queue).toEqual([]);
    feed(m, [{ type: 'notice', notice: { kind: 'error', level: 'info', text: 'x' } }]);
    expect(m.state.queue).toEqual([]); // folding other events keeps it
  });
});
