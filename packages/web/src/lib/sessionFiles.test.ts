import { describe, expect, it } from 'vitest';

import type { Entry, ToolItem } from '@harness-code/protocol';

import { sessionFiles, workspaceRelative } from './sessionFiles';

const call = (name: string, path: string, over: Partial<ToolItem> = {}): ToolItem => ({
  id: `${name}:${path}`,
  name,
  input: { path },
  running: false,
  result: { content: 'ok' },
  ...over,
});

describe('sessionFiles', () => {
  it("gathers the session's writes and edits, a sub-agent's included, relative to the workspace", () => {
    const entries: Entry[] = [
      {
        kind: 'assistant',
        id: 0,
        thinking: '',
        text: '',
        tools: [
          call('edit', '/w/src/a.ts'),
          call('write', './notes.md'),
          call('read', 'src/b.ts'),
          call('edit', 'src/failed.ts', { result: { content: 'oldString not found', isError: true } }),
          { ...call('task', ''), input: {}, children: [call('write', 'src/sub.ts')] },
        ],
      },
    ];
    const live = { thinking: '', text: '', tools: [call('edit', 'src/live.ts', { running: true, result: undefined } as never)] };
    expect([...sessionFiles(entries, live, '/w')].sort()).toEqual(['notes.md', 'src/a.ts', 'src/live.ts', 'src/sub.ts']);
  });

  it('leaves paths outside the workspace as they are', () => {
    expect(workspaceRelative('/elsewhere/x.ts', '/w')).toBe('/elsewhere/x.ts');
    expect(workspaceRelative('/wider/x.ts', '/w')).toBe('/wider/x.ts');
    expect(workspaceRelative('src\\win.ts', '/w')).toBe('src/win.ts');
  });
});
