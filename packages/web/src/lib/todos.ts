/**
 * The session's task list: what the agent last passed to `todo` (it sends the
 * whole list every time). Derived from the transcript, so a reload shows it too.
 */

import type { Entry, LiveSnapshot, ToolItem } from '@harness-code/protocol';

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface Todo {
  id?: string;
  content: string;
  status: TodoStatus;
}

/** A `todo` call's list, or null when it has none or the call failed. */
export function todosOf(tool: ToolItem): Todo[] | null {
  if (tool.name !== 'todo' || tool.result?.isError) return null;
  return parseTodos(tool.input);
}

/** The list in a `todo` call's input, skipping malformed items; null without one. */
export function parseTodos(input: unknown): Todo[] | null {
  const todos = (input as { todos?: unknown } | null)?.todos;
  if (!Array.isArray(todos)) return null;
  return todos.flatMap((t: unknown) => {
    const { id, content, status } = (t ?? {}) as Record<string, unknown>;
    if (typeof content !== 'string') return [];
    const s: TodoStatus = status === 'completed' || status === 'in_progress' ? status : 'pending';
    return [{ ...(typeof id === 'string' ? { id } : {}), content, status: s }];
  });
}

/** The latest list, the streaming step included; null before the first `todo` call. */
export function latestTodos(entries: readonly Entry[], live: LiveSnapshot): Todo[] | null {
  for (let i = live.tools.length - 1; i >= 0; i--) {
    const todos = todosOf(live.tools[i]!);
    if (todos) return todos;
  }
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.kind !== 'assistant') continue;
    for (let j = e.tools.length - 1; j >= 0; j--) {
      const todos = todosOf(e.tools[j]!);
      if (todos) return todos;
    }
  }
  return null;
}
