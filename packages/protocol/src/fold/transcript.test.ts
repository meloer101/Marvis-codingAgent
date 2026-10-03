import { describe, expect, it } from 'vitest';

import { attachedFileBlock, attachedFilePath } from '@harness-code/core/browser';

import { entriesFromTranscript } from './transcript.js';

describe('entriesFromTranscript', () => {
  it("puts back how long a call ran, a task's sub-agent calls and a write's replaced file", () => {
    const entries = entriesFromTranscript([
      {
        type: 'message',
        ts: 1,
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 't1', name: 'task', input: { prompt: 'look' } },
            { type: 'tool_use', id: 'w1', name: 'write', input: { path: 'a', content: 'new' } },
          ],
        },
      },
      {
        type: 'tool_display',
        ts: 2,
        toolUseId: 't1',
        durationMs: 1200,
        subagent: [{ id: 's1', name: 'read', input: { path: 'a' }, result: { content: 'old' }, durationMs: 3 }],
      },
      { type: 'tool_display', ts: 3, toolUseId: 'w1', display: { before: 'old' }, durationMs: 4 },
      {
        type: 'message',
        ts: 4,
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', toolUseId: 't1', content: 'report' },
            { type: 'tool_result', toolUseId: 'w1', content: 'Wrote 3 bytes' },
          ],
        },
      },
    ]);
    expect(entries[0]).toMatchObject({
      tools: [
        {
          id: 't1',
          durationMs: 1200,
          children: [{ id: 's1', name: 'read', running: false, result: { content: 'old' }, durationMs: 3 }],
          result: { content: 'report' },
        },
        { id: 'w1', durationMs: 4, result: { content: 'Wrote 3 bytes', display: { before: 'old' } } },
      ],
    });
  });

  it('rebuilds entries and attaches tool results to their cards', () => {
    const entries = entriesFromTranscript([
      { type: 'message', ts: 1, message: { role: 'user', content: [{ type: 'text', text: 'fix it' }] } },
      {
        type: 'message',
        ts: 2,
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', text: 'plan' },
            { type: 'text', text: 'Running tests.' },
            { type: 'tool_use', id: 't1', name: 'bash', input: { command: 'npm test' } },
          ],
        },
      },
      {
        type: 'message',
        ts: 3,
        message: { role: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: 'FAIL', isError: true }] },
      },
      { type: 'compaction', ts: 4, tokensBefore: 9000, tokensAfter: 1200 },
      { type: 'message', ts: 5, message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } },
    ]);
    expect(entries.map((e) => e.kind)).toEqual(['user', 'assistant', 'notice', 'assistant']);
    expect(entries.map((e) => e.id)).toEqual([0, 1, 2, 3]);
    expect(entries[1]).toMatchObject({
      thinking: 'plan',
      text: 'Running tests.',
      tools: [{ id: 't1', running: false, result: { content: 'FAIL', isError: true } }],
    });
    expect(entries[2]).toMatchObject({ notice: { kind: 'compaction' } });
  });

  it('puts back what a result carried for display, whichever is recorded first', () => {
    const edit = (id: string) => ({ type: 'tool_use' as const, id, name: 'edit', input: {} });
    const result = (id: string) => ({ type: 'tool_result' as const, toolUseId: id, content: 'Replaced 1 occurrence(s)' });
    const entries = entriesFromTranscript([
      { type: 'message', ts: 1, message: { role: 'assistant', content: [edit('a'), edit('b')] } },
      { type: 'tool_display', ts: 2, toolUseId: 'a', display: { startLine: 7 } },
      { type: 'message', ts: 3, message: { role: 'user', content: [result('a'), result('b')] } },
      { type: 'tool_display', ts: 4, toolUseId: 'b', display: { startLine: 40 } },
    ]);
    const tools = entries[0]!.kind === 'assistant' ? entries[0]!.tools : [];
    expect(tools.map((t) => t.result?.display)).toEqual([{ startLine: 7 }, { startLine: 40 }]);
  });

  it('shows attached files as the message\'s attachments, not as its text', () => {
    const block = attachedFileBlock('src/a "b".ts', '     1\tconst a = 1;');
    const entries = entriesFromTranscript([
      {
        type: 'message',
        ts: 1,
        message: { role: 'user', content: [{ type: 'text', text: block }, { type: 'text', text: 'look at @src/a' }] },
      },
    ]);
    expect(entries).toEqual([{ kind: 'user', id: 0, text: 'look at @src/a', attachments: ['src/a "b".ts'] }]);
    // Text that merely looks like the tag stays text.
    expect(attachedFilePath('<attached_file path="x">no newline</attached_file>')).toBeNull();
  });
});
