import { describe, expect, it } from 'vitest';

import { attachedFileBlock, attachedFilePath } from '@harness-code/core/browser';

import { entriesFromTranscript } from './transcript.js';

describe('entriesFromTranscript', () => {
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
