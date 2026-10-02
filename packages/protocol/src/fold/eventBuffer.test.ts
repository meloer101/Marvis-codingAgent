import { describe, expect, it } from 'vitest';

import type { AgentEvent } from '@harness-code/core';

import { EventBuffer } from './eventBuffer.js';
import { LIVE_OUTPUT_CHARS, appendOutput } from './reducer.js';

function start(id: string, name = 'bash'): AgentEvent {
  return { type: 'tool_call_start', id, name, input: { command: 'ls' } };
}
function end(id: string, name = 'bash'): AgentEvent {
  return { type: 'tool_call_end', id, name, result: { content: 'ok' } };
}

describe('EventBuffer', () => {
  it('sets a batch boundary only when the last in-flight tool completes', () => {
    const b = new EventBuffer();
    b.onEvent(start('a'));
    b.onEvent(start('b'));
    expect(b.hasBatchBoundary()).toBe(false);

    b.onEvent(end('a')); // b still running
    expect(b.hasBatchBoundary()).toBe(false);
    expect(b.hasRunningTool()).toBe(true);

    b.onEvent(end('b'));
    expect(b.hasBatchBoundary()).toBe(true);
    expect(b.hasRunningTool()).toBe(false);
    expect(b.snapshot().tools.map((t) => t.running)).toEqual([false, false]);
  });

  it('keeps what a running tool prints until its result replaces it, with the duration', () => {
    const b = new EventBuffer();
    b.onEvent(start('a'));
    b.onEvent({ type: 'tool_call_output', id: 'a', text: 'one\n' });
    b.onEvent({ type: 'tool_call_output', id: 'a', text: 'two\n' });
    b.onEvent({ type: 'tool_call_output', id: 'nope', text: 'stray' });
    expect(b.snapshot().tools[0]!.output).toBe('one\ntwo\n');
    b.onEvent({ ...end('a'), durationMs: 1200 } as AgentEvent);
    const [tool] = b.snapshot().tools;
    expect(tool!.output).toBeUndefined();
    expect(tool!.durationMs).toBe(1200);
    expect(tool!.result?.content).toBe('ok');
  });

  it("nests a task's sub-agent calls in it, and settles any left running when it ends", () => {
    const b = new EventBuffer();
    b.onEvent(start('t', 'task'));
    const sub = (event: unknown): AgentEvent => ({ type: 'subagent_event', id: 't', event }) as AgentEvent;
    b.onEvent(sub({ type: 'tool_call_start', id: 'c1', name: 'read', input: { path: 'a' } }));
    b.onEvent(sub({ type: 'tool_call_start', id: 'c2', name: 'grep', input: { pattern: 'x' } }));
    const before = b.snapshot().tools[0]!.children!;
    b.onEvent(sub({ type: 'tool_call_end', id: 'c1', name: 'read', result: { content: 'A' }, durationMs: 4 }));
    const after = b.snapshot().tools[0]!.children!;
    expect(after.map((c) => [c.id, c.running, c.result?.content])).toEqual([
      ['c1', false, 'A'],
      ['c2', true, undefined],
    ]);
    // New objects for what changed, the same for what didn't.
    expect(after[0]).not.toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    b.onEvent(end('t', 'task'));
    expect(b.snapshot().tools[0]!.children!.map((c) => c.running)).toEqual([false, false]);
  });

  it('keeps only the tail of long output, cut at a line start', () => {
    const line = 'x'.repeat(99) + '\n';
    const out = appendOutput(line.repeat(LIVE_OUTPUT_CHARS / 100), 'last\n');
    expect(out.length).toBeLessThanOrEqual(LIVE_OUTPUT_CHARS + 2);
    expect(out.startsWith('…\nxxx')).toBe(true);
    expect(out.endsWith('\nlast\n')).toBe(true);
  });

  it('reset clears the boundary and the tool ledger', () => {
    const b = new EventBuffer();
    b.onEvent(start('a'));
    b.onEvent(end('a'));
    expect(b.hasBatchBoundary()).toBe(true);

    b.reset();
    expect(b.hasBatchBoundary()).toBe(false);
    expect(b.hasRunningTool()).toBe(false);
    expect(b.snapshot()).toEqual({ thinking: '', text: '', tools: [] });

    // a later batch can set the boundary again
    b.onEvent(start('b'));
    b.onEvent(end('b'));
    expect(b.hasBatchBoundary()).toBe(true);
  });

  it('ignores tool_call_end for an unknown id (already committed)', () => {
    const b = new EventBuffer();
    b.onEvent(start('a'));
    b.onEvent(end('a'));
    b.reset();

    b.onEvent(end('a')); // stale completion from the committed batch
    expect(b.hasBatchBoundary()).toBe(false);
    expect(b.hasRunningTool()).toBe(false);
  });

  it('turn_retry drops only the failed turn’s deltas', () => {
    const b = new EventBuffer();
    const context: AgentEvent = {
      type: 'context',
      usedTokens: 1,
      windowTokens: 10,
      ratio: 0.1,
      breakdown: { system: 0, skills: 0, projectMemory: 0, toolSchemas: 0, history: 1, total: 1 },
    };
    b.onEvent(context);
    b.onEvent({ type: 'text_delta', text: 'turn one. ' }); // not yet committed
    b.onEvent(context); // next model call begins
    b.onEvent({ type: 'thinking_delta', text: 'hmm' });
    b.onEvent({ type: 'text_delta', text: 'half an ans' });
    b.onEvent({ type: 'turn_retry', attempt: 1, maxAttempts: 2, delayMs: 0, message: 'dropped' });
    b.onEvent({ type: 'text_delta', text: 'the answer' });

    expect(b.snapshot()).toMatchObject({ thinking: '', text: 'turn one. the answer' });
  });

  describe('takeDirty', () => {
    it('is false with no events, true after a change, and clears on read', () => {
      const b = new EventBuffer();
      expect(b.takeDirty()).toBe(false);

      b.onEvent({ type: 'text_delta', text: 'hi' });
      expect(b.takeDirty()).toBe(true);
      expect(b.takeDirty()).toBe(false); // cleared

      b.onEvent(start('a'));
      expect(b.takeDirty()).toBe(true);
    });

    it('a context event alone does not mark the buffer dirty', () => {
      const b = new EventBuffer();
      b.onEvent({
        type: 'context',
        usedTokens: 1,
        windowTokens: 10,
        ratio: 0.1,
        breakdown: { system: 0, skills: 0, projectMemory: 0, toolSchemas: 0, history: 1, total: 1 },
      });
      expect(b.takeDirty()).toBe(false);
    });

    it('reset clears the dirty flag', () => {
      const b = new EventBuffer();
      b.onEvent({ type: 'text_delta', text: 'hi' });
      b.reset();
      expect(b.takeDirty()).toBe(false);
    });
  });

  describe('takeCompletedBatch', () => {
    it('returns null while a tool is still in flight', () => {
      const b = new EventBuffer();
      b.onEvent(start('a'));
      b.onEvent(start('b'));
      b.onEvent(end('a')); // b still running

      expect(b.takeCompletedBatch()).toBeNull();
    });

    it('returns null before any batch boundary has been reached', () => {
      const b = new EventBuffer();
      b.onEvent({ type: 'text_delta', text: 'hi' });

      expect(b.takeCompletedBatch()).toBeNull();
    });

    it('returns the live snapshot and resets once the batch completes', () => {
      const b = new EventBuffer();
      b.onEvent({ type: 'text_delta', text: 'ans' });
      b.onEvent(start('a'));
      b.onEvent(end('a'));

      const batch = b.takeCompletedBatch();
      expect(batch).toMatchObject({ text: 'ans', tools: [{ id: 'a', running: false }] });

      // consumed: state is reset, a second call has nothing to hand back
      expect(b.hasBatchBoundary()).toBe(false);
      expect(b.snapshot()).toEqual({ thinking: '', text: '', tools: [] });
      expect(b.takeCompletedBatch()).toBeNull();
    });
  });
});
