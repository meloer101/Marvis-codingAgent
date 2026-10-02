import { CheckCircle2, Circle, CircleDot } from 'lucide-react';

import type { Todo } from '@/lib/todos';
import { cn } from '@/lib/utils';

export function TodoIcon({ status }: { status: Todo['status'] }) {
  return status === 'completed' ? (
    <CheckCircle2 className="mt-px size-3.5 shrink-0 text-success" />
  ) : status === 'in_progress' ? (
    <CircleDot className="mt-px size-3.5 shrink-0 text-primary" />
  ) : (
    <Circle className="mt-px size-3.5 shrink-0 text-muted-foreground" />
  );
}

/** A task list, done items struck through. */
export function TodoList({ todos, className }: { todos: readonly Todo[]; className?: string }) {
  return (
    <ul className={cn('space-y-1', className)}>
      {todos.map((t, i) => (
        <li key={t.id ?? i} className="flex items-start gap-2">
          <TodoIcon status={t.status} />
          <span className={cn(t.status === 'completed' && 'text-muted-foreground line-through')}>{t.content}</span>
        </li>
      ))}
    </ul>
  );
}
