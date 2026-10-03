import { SessionView } from '@/components/SessionView';
import { SidePanel } from '@/components/SidePanel';
import { TerminalPanel } from '@/components/TerminalPanel';
import { useSessionCheckout } from '@/lib/checkout';
import { closePane, focusPane } from '@/lib/split';
import { useAppStore } from '@/lib/store';
import { cn } from '@/lib/utils';

/**
 * The sessions on screen — one, or two side by side (split view) — with the
 * terminal under them and the side panel at the right edge, both for the one
 * with the focus. A pane takes the focus when it is clicked or typed in.
 */
export function SessionArea({
  panes,
  focused,
  onNewSession,
}: {
  /** Session ids, left to right. */
  panes: readonly string[];
  focused: number;
  onNewSession: () => void;
}) {
  const activeId = panes[focused] ?? panes[0] ?? '';
  const view = useAppStore((s) => s.views[activeId]);
  const checkout = useSessionCheckout({ id: activeId, workspaceId: view?.workspaceId, worktree: view?.worktree });
  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex min-h-0 min-w-0 flex-1">
          {panes.map((id, i) => (
            <div
              key={`pane-${i}`}
              data-pane={i}
              onPointerDownCapture={() => focusPane(i)}
              onFocusCapture={() => focusPane(i)}
              className={cn('flex min-h-0 min-w-0 flex-1', i > 0 && 'border-l')}
            >
              <SessionView
                key={id}
                id={id}
                onNewSession={onNewSession}
                {...(panes.length > 1 ? { pane: { focused: i === focused, index: i, onClose: () => closePane(i) } } : {})}
              />
            </div>
          ))}
        </div>
        {checkout && <TerminalPanel checkout={checkout} />}
      </div>
      {view && <SidePanel view={view} checkout={checkout} />}
    </div>
  );
}
