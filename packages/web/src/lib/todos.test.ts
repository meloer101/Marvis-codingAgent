import { describe, expect, it } from 'vitest';

import type { Entry, ToolItem } from '@harness-code/protocol';

import { latestTodos } from './todos';

const todo = (id: string, todos: unknown, over: Partial<ToolItem> = {}): ToolItem => ({
  id,
  name: 'todo',
  input: { todos },
  running: false,
  result: { content: 'ok' },
  ...over,
});
const step = (id: number, tools: ToolItem[]): Entry => ({ kind: 'assistant', id, thinking: '', text: '', tools });
const noLive = { thinking: '', text: '', tools: [] };

describe('latestTodos', () => {
  it("is the last todo call's list, the streaming step first", () => {
    const entries = [
      step(0, [todo('a', [{ id: '1', content: 'old', status: 'pending' }])]),
      step(1, [{ id: 'r', name: 'read', input: {}, running: false }]),
      step(2, [todo('b', [{ id: '1', content: 'plan', status: 'in_progress' }])]),
    ];
    expect(latestTodos(entries, noLive)).toEqual([{ id: '1', content: 'plan', status: 'in_progress' }]);
    const live = { ...noLive, tools: [todo('c', [{ id: '1', content: 'plan', status: 'completed' }], { running: true, result: undefined } as never)] };
    expect(latestTodos(entries, live)?.[0]?.status).toBe('completed');
  });

  it('skips a failed call and malformed items, and is null before any', () => {
    const entries = [
      step(0, [todo('a', [{ content: 'kept' }, { status: 'pending' }, 'junk'])]),
      step(1, [todo('b', 'not a list'), todo('c', [{ content: 'bad' }], { result: { content: 'invalid', isError: true } })]),
    ];
    expect(latestTodos(entries, noLive)).toEqual([{ content: 'kept', status: 'pending' }]);
    expect(latestTodos([], noLive)).toBeNull();
  });
});
