import { useMemo } from 'react';
import { FolderTree, GitCompareArrows, ListChecks, X } from 'lucide-react';

import { ChangesPanel } from '@/components/ChangesPanel';
import { FilesPanel } from '@/components/FilesPanel';
import { TodoList } from '@/components/TodoList';
import { setPanel, usePanel } from '@/lib/panel';
import type { PanelTab } from '@/lib/panel';
import { sessionFiles } from '@/lib/sessionFiles';
import type { SessionViewState } from '@/lib/sessionModel';
import { useAppStore } from '@/lib/store';
import { latestTodos } from '@/lib/todos';
import { cn } from '@/lib/utils';

const TABS: Array<{ tab: PanelTab; label: string; icon: typeof X }> = [
  { tab: 'changes', label: 'Changes', icon: GitCompareArrows },
  { tab: 'files', label: 'Files', icon: FolderTree },
  { tab: 'tasks', label: 'Tasks', icon: ListChecks },
];

/** The panel to the right of a session: its project's changes and files, and the agent's task list. */
export function SidePanel({ view }: { view: SessionViewState }) {
  const tab = usePanel();
  const root = useAppStore((s) => s.workspaces.find((w) => w.id === view.workspaceId)?.root);
  const sessionPaths = useMemo(
    () => (tab === 'changes' && root ? sessionFiles(view.entries, view.live, root) : undefined),
    [tab, root, view.entries, view.live],
  );
  if (!tab) return null;
  return (
    <aside aria-label="Side panel" className="flex w-[min(460px,42vw)] shrink-0 flex-col border-l bg-background">
      <div className="flex h-12 shrink-0 items-center gap-1 border-b px-2">
        <div role="tablist" className="flex items-center gap-0.5">
          {TABS.map(({ tab: t, label, icon: Icon }) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setPanel(t)}
              className={cn(
                'flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors',
                tab === t ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
              )}
            >
              <Icon className="size-3.5" />
              {label}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => setPanel(null)}
          aria-label="Close panel"
          title="Close panel (⌥⌘B)"
          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>
      {/* Each tab scrolls itself: Changes keeps its commit box in view. */}
      <div className="flex min-h-0 flex-1 flex-col">
        {tab === 'changes' && view.workspaceId && (
          <ChangesPanel workspaceId={view.workspaceId} sessionId={view.id} {...(sessionPaths ? { sessionPaths } : {})} />
        )}
        {tab === 'files' && view.workspaceId && <FilesPanel workspaceId={view.workspaceId} />}
        {tab === 'tasks' && <TasksTab view={view} />}
      </div>
    </aside>
  );
}

/** The agent's task list as it stands, whole. */
function TasksTab({ view }: { view: SessionViewState }) {
  const todos = useMemo(() => latestTodos(view.entries, view.live), [view.entries, view.live]);
  if (!todos || todos.length === 0) {
    return (
      <p className="px-6 py-16 text-center font-serif text-sm text-muted-foreground italic">
        No task list yet — the agent keeps one for longer work.
      </p>
    );
  }
  const done = todos.filter((t) => t.status === 'completed').length;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 py-3 text-xs">
      <p className="font-mono text-[10px] tracking-[0.12em] text-muted-foreground uppercase">
        {done} of {todos.length} done
      </p>
      <TodoList todos={todos} />
    </div>
  );
}
