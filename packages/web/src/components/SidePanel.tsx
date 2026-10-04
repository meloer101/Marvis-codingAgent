import { useMemo, useState } from 'react';

import { ChangesPanel } from '@/components/ChangesPanel';
import { FilesPanel } from '@/components/FilesPanel';
import { ProcessesPanel } from '@/components/ProcessesPanel';
import { PanelCloser, SlideRegion } from '@/components/Regions';
import { TodoList } from '@/components/TodoList';
import { TracePanel } from '@/components/TracePanel';
import { checkoutKey } from '@/lib/checkout';
import type { Checkout } from '@/lib/checkout';
import { setPanel, usePanel } from '@/lib/panel';
import type { PanelTab } from '@/lib/panel';
import { sessionFiles } from '@/lib/sessionFiles';
import type { SessionViewState } from '@/lib/sessionModel';
import { useAppStore } from '@/lib/store';
import { latestTodos } from '@/lib/todos';
import { cn } from '@/lib/utils';

const TABS: Array<{ tab: PanelTab; label: string }> = [
  { tab: 'changes', label: 'Changes' },
  { tab: 'files', label: 'Files' },
  { tab: 'tasks', label: 'Tasks' },
  { tab: 'trace', label: 'Trace' },
  { tab: 'processes', label: 'Processes' },
];

/**
 * The panel to the right of a session: the changes and files where it works —
 * its project's checkout, or its worktree — the agent's task list, its trace
 * and its background commands. An auxiliary zone, so it sits on grey; what
 * can be acted on in it is white. It slides open and shut (⌥⌘B).
 */
export function SidePanel({ view, checkout }: { view: SessionViewState; checkout: Checkout | undefined }) {
  const current = usePanel();
  // While it closes, it keeps showing the tab it closed on.
  const [last, setLast] = useState<PanelTab>(current ?? 'changes');
  if (current && current !== last) setLast(current);
  const tab = current ?? last;
  const root = checkout?.root;
  const sessionPaths = useMemo(
    () => (tab === 'changes' && root ? sessionFiles(view.entries, view.live, root) : undefined),
    [tab, root, view.entries, view.live],
  );
  const changed = useAppStore((s) => {
    const status = checkout ? s.git[checkoutKey(checkout)] : undefined;
    return status?.repo ? status.files.length : 0;
  });
  return (
    <SlideRegion open={current !== null} width="min(440px, 42vw)" aria-label="Side panel" className="@container flex flex-col bg-muted">
      <div className="titlebar flex h-11 shrink-0 items-center gap-0.5 pr-1.5 pl-3">
        <div role="tablist" className="flex min-w-0 items-center gap-0.5 overflow-hidden">
          {/* Processes once the session has started one in the background. */}
          {TABS.filter(({ tab: t }) => t !== 'processes' || tab === t || (view.processes?.length ?? 0) > 0).map(({ tab: t, label }) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              aria-label={label}
              onClick={() => setPanel(t)}
              className={cn(
                'flex shrink-0 items-center gap-[5px] rounded-md px-2 py-1 text-[13px] transition-colors',
                tab === t ? 'bg-background font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {label}
              {t === 'changes' && changed > 0 && <span className="font-mono text-[11px] font-normal text-faint">{changed}</span>}
              {t === 'processes' && <RunningCount view={view} />}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <PanelCloser />
      </div>
      {/* Each tab scrolls itself: Changes keeps its commit box in view. */}
      <div className="flex min-h-0 flex-1 flex-col">
        {(tab === 'changes' || tab === 'files') && checkout?.missing && <WorktreeGone />}
        {tab === 'changes' && checkout && !checkout.missing && (
          <ChangesPanel checkout={checkout} sessionId={view.id} {...(sessionPaths ? { sessionPaths } : {})} />
        )}
        {tab === 'files' && checkout && !checkout.missing && <FilesPanel checkout={checkout} />}
        {tab === 'tasks' && <TasksTab view={view} />}
        {tab === 'trace' && <TracePanel sessionId={view.id} running={view.running} />}
        {tab === 'processes' && <ProcessesPanel sessionId={view.id} processes={view.processes ?? []} />}
      </div>
    </SlideRegion>
  );
}

/** How many of its background commands are still going, beside the tab's name. */
function RunningCount({ view }: { view: SessionViewState }) {
  const n = view.processes?.filter((p) => p.status === 'running').length ?? 0;
  return n > 0 ? <span className="font-mono text-[11px] font-normal text-primary tabular-nums">{n}</span> : null;
}

/** An archived session's worktree was removed; its branch keeps what was committed. */
function WorktreeGone() {
  return (
    <p className="px-6 py-16 text-center text-[13px] text-muted-foreground">
      This session’s worktree was removed when it was archived. Its branch is kept, and checked out again when the
      session next runs.
    </p>
  );
}

/** The agent's task list as it stands, whole. */
function TasksTab({ view }: { view: SessionViewState }) {
  const todos = useMemo(() => latestTodos(view.entries, view.live), [view.entries, view.live]);
  if (!todos || todos.length === 0) {
    return (
      <p className="px-6 py-16 text-center text-[13px] text-muted-foreground">
        No task list yet — the agent keeps one for longer work.
      </p>
    );
  }
  const done = todos.filter((t) => t.status === 'completed').length;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 pt-1 pb-3 text-xs">
      <p className="px-2 text-[11px] font-medium tracking-[0.02em] text-faint">
        {done} of {todos.length} done
      </p>
      <div className="rounded-lg bg-background px-3 py-2.5">
        <TodoList todos={todos} />
      </div>
    </div>
  );
}
