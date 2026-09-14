import { describe, expect, it } from 'vitest';

import { buildClassifierTranscript } from './transcript.js';
import type { Message, ToolUseBlock } from '../../provider/types.js';

const pending: ToolUseBlock = {
  type: 'tool_use',
  id: 'p1',
  name: 'bash',
  input: { command: 'git push --force' },
};

describe('buildClassifierTranscript', () => {
  it('keeps user text and non-read-only tool_use, drops assistant prose, thinking, results, and reads', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'please ship it' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', text: 'I should look around' },
          { type: 'text', text: 'I will inspect the repo' },
          { type: 'tool_use', id: '1', name: 'read', input: { path: 'src/a.ts' } },
          { type: 'tool_use', id: '2', name: 'bash', input: { command: 'git status' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: '1', content: 'file body' }],
      },
      { role: 'user', content: [{ type: 'text', text: 'do not push' }] },
    ];

    const [msg] = buildClassifierTranscript(messages, pending, {
      projectMemory: 'use 2-space indent',
    });
    const text = msg?.content[0]?.type === 'text' ? msg.content[0].text : '';
    expect(text).toContain('<project_memory>');
    expect(text).toContain('use 2-space indent');
    expect(text).toContain('please ship it');
    expect(text).toContain('do not push');
    expect(text).toContain('git status');
    expect(text).toContain('git push --force');
    expect(text).not.toContain('I will inspect the repo');
    expect(text).not.toContain('I should look around');
    expect(text).not.toContain('file body');
    expect(text).not.toContain('src/a.ts');
  });

  it('always keeps the first user message when trimming', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'FIRST' }] },
      { role: 'user', content: [{ type: 'text', text: 'x'.repeat(4000) }] },
      { role: 'user', content: [{ type: 'text', text: 'y'.repeat(4000) }] },
    ];
    const [msg] = buildClassifierTranscript(messages, pending, { tokenBudget: 50 });
    const text = msg?.content[0]?.type === 'text' ? msg.content[0].text : '';
    expect(text).toContain('FIRST');
  });
});
