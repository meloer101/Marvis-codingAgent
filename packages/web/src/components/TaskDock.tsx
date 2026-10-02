import { useMemo, useState } from 'react';
import { ChevronRight, ListChecks } from 'lucide-react';

import { TodoList } from '@/components/TodoList';
import { usePanel } from '@/lib/panel';
import type { SessionViewState } from '@/lib/sessionModel';
import { latestTodos } from '@/lib/todos';
import { cn } from '@/lib/utils';

/**
 * The agent's task list, docked above the composer while any of it is left
 * (and the side panel isn't showing it): one line — progress and the task in
 * hand — that opens to the whole list.
 */
export function TaskDock({ view }: { view: SessionViewState }) {
  const [open, setOpen] = useState(false);
  const panel = usePanel();
  const todos = useMemo(() => latestTodos(view.entries, view.live), [view.entries, view.live]);
  // The side panel's Tasks tab shows the list already.
  if (panel === 'tasks') return null;
  if (!todos || todos.length === 0 || todos.every((t) => t.status === 'completed')) return null;
  const done = todos.filter((t) => t.status === 'completed').length;
  const current = todos.find((t) => t.status === 'in_progress') ?? todos.find((t) => t.status === 'pending');
  return (
    <section aria-label="Tasks" className="animate-rise rounded-lg border bg-card text-xs shadow-xs">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full min-w-0 items-center gap-2 rounded-lg px-3 py-1.5 text-left transition-colors hover:bg-accent/60"
      >
        <ListChecks className="size-3.5 shrink-0 text-primary" />
        <span className="shrink-0 font-medium">Tasks</span>
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">
          {done}/{todos.length}
        </span>
        {!open && current && <span className="min-w-0 flex-1 truncate text-muted-foreground">{current.content}</span>}
        <ChevronRight className={cn('ml-auto size-3 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
      </button>
      {open && <TodoList todos={todos} className="max-h-60 overflow-y-auto border-t px-3 py-2" />}
    </section>
  );
}
