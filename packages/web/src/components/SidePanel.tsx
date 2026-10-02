import { GitCompareArrows, X } from 'lucide-react';

import { ChangesPanel } from '@/components/ChangesPanel';
import { setPanel, usePanel } from '@/lib/panel';
import type { PanelTab } from '@/lib/panel';
import type { SessionViewState } from '@/lib/sessionModel';
import { cn } from '@/lib/utils';

const TABS: Array<{ tab: PanelTab; label: string; icon: typeof X }> = [
  { tab: 'changes', label: 'Changes', icon: GitCompareArrows },
];

/** The panel to the right of a session: its project's changes, and more tabs to come. */
export function SidePanel({ view }: { view: SessionViewState }) {
  const tab = usePanel();
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
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'changes' && view.workspaceId && <ChangesPanel workspaceId={view.workspaceId} />}
      </div>
    </aside>
  );
}
