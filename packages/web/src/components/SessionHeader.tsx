import { useEffect, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Folder, GitBranch, PanelRight, SquareTerminal, X } from 'lucide-react';

import { fmtTokens, fmtUSD } from '@harness-code/core/browser';
import type { SessionWorktree } from '@harness-code/protocol';

import { UsagePopover } from '@/components/UsagePanel';
import { togglePanel, usePanel } from '@/lib/panel';
import { toggleTerminal, useTerminalPanel } from '@/lib/terminalPanel';
import type { SessionViewState } from '@/lib/sessionModel';
import { useAppStore } from '@/lib/store';
import { useSync } from '@/lib/syncContext';
import { cn } from '@/lib/utils';

/**
 * Where the session runs and what it is called — the title renames in place —
 * and what it has spent so far, with the context breakdown behind it. What the
 * next message runs under (mode, model, effort) lives in the composer. In a
 * split, the pane without the focus is muted, and each pane has a close button.
 */
export function SessionHeader({ view, pane }: { view: SessionViewState; pane?: { focused: boolean; onClose: () => void } }) {
  const workspace = useAppStore((s) => s.workspaces.find((w) => w.id === view.workspaceId));
  const title = useAppStore((s) => s.sessions.find((r) => r.id === view.id)?.title);
  const worktreeGone = useAppStore((s) => s.sessions.find((r) => r.id === view.id)?.worktree?.missing === true);
  return (
    <header
      className={cn(
        'flex h-12 shrink-0 items-center gap-2 overflow-hidden border-b px-4 text-sm transition-colors',
        pane && !pane.focused && 'bg-muted/40 text-muted-foreground',
      )}
    >
      {workspace && <ProjectChip name={workspace.name} root={workspace.root} />}
      {view.worktree && <BranchChip worktree={view.worktree} gone={worktreeGone} />}
      {workspace && title !== undefined && <span className="text-muted-foreground/60">/</span>}
      {title !== undefined && <SessionTitle id={view.id} title={title} />}
      <div className="flex-1" />
      <SpendButton view={view} />
      {(!pane || pane.focused) && (
        <>
          <TerminalToggle />
          <PanelToggle />
        </>
      )}
      {pane && (
        <button
          type="button"
          onClick={pane.onClose}
          aria-label="Close this pane"
          title="Close this pane"
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      )}
    </header>
  );
}

/** Shows and hides the terminal under the session (Ctrl+`). */
function TerminalToggle() {
  const { open } = useTerminalPanel();
  return (
    <button
      type="button"
      onClick={toggleTerminal}
      aria-label="Terminal"
      aria-pressed={open}
      title={`${open ? 'Hide' : 'Show'} the terminal (Ctrl+\`)`}
      className={cn(
        'flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
        open && 'bg-accent text-foreground',
      )}
    >
      <SquareTerminal className="size-4" />
    </button>
  );
}

/** Opens and closes the side panel (⌥⌘B). */
function PanelToggle() {
  const open = usePanel() !== null;
  return (
    <button
      type="button"
      onClick={togglePanel}
      aria-label="Side panel"
      aria-pressed={open}
      title={`${open ? 'Hide' : 'Show'} changes (⌥⌘B)`}
      className={cn(
        'flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
        open && 'bg-accent text-foreground',
      )}
    >
      <PanelRight className="size-4" />
    </button>
  );
}

/** Which project a session runs in. */
export function ProjectChip({ name, root }: { name: string; root: string }) {
  return (
    <span className="flex min-w-0 shrink items-center gap-1.5 text-xs font-medium" title={root}>
      <Folder className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="max-w-40 truncate">{name}</span>
    </span>
  );
}

/** The branch a session works on in a worktree of its own. */
function BranchChip({ worktree, gone }: { worktree: SessionWorktree; gone: boolean }) {
  return (
    <span
      className={cn(
        'flex min-w-0 shrink items-center gap-1 rounded-md bg-primary/10 px-1.5 py-0.5 text-primary',
        gone && 'bg-muted text-muted-foreground',
      )}
      title={
        gone
          ? `Its worktree was removed when it was archived; ${worktree.branch} is checked out again when it next runs`
          : `Works in a worktree of its own, branched from ${worktree.base}: ${worktree.path}`
      }
    >
      <GitBranch className="size-3 shrink-0" />
      <span className="max-w-48 truncate font-mono text-[11px]">{worktree.branch}</span>
    </span>
  );
}

/** Click to rename: Enter or leaving the field saves (empty goes back to the first message), Esc cancels. */
function SessionTitle({ id, title }: { id: string; title: string }) {
  const sync = useSync();
  const [editing, setEditing] = useState<string | null>(null);
  // The palette's "Rename session".
  const renameAsked = useAppStore((s) => s.request?.sessionId === id && s.request.kind === 'rename');
  useEffect(() => {
    if (!renameAsked) return;
    sync.takeRequest();
    setEditing(title);
  }, [renameAsked]);

  const done = (value: string): void => {
    setEditing(null);
    if (value.trim() !== title) void sync.updateSession(id, { title: value });
  };

  if (editing !== null) {
    const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
      if (e.nativeEvent.isComposing) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        done(editing);
      } else if (e.key === 'Escape') {
        e.preventDefault(); // cancels the rename; must not also stop a run
        e.stopPropagation();
        setEditing(null);
      }
    };
    return (
      <input
        autoFocus
        aria-label="Session title"
        value={editing}
        onChange={(e) => setEditing(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => done(editing)}
        onFocus={(e) => e.target.select()}
        className="h-7 w-full max-w-md min-w-0 rounded-md border border-primary/45 bg-background px-2 text-[13px] ring-2 ring-primary/20 outline-none"
      />
    );
  }
  return (
    <button
      type="button"
      onClick={() => setEditing(title)}
      title="Rename"
      className="min-w-0 cursor-text truncate rounded-md px-1.5 py-1 text-left text-[13px] font-medium transition-colors hover:bg-accent"
    >
      {title}
    </button>
  );
}

/** Session tokens and cost; opens the context and usage breakdown. */
function SpendButton({ view }: { view: SessionViewState }) {
  const { usage, context } = view;
  if (!usage) return null;
  return (
    <UsagePopover context={context} usage={usage} modelRef={view.modelRef} side="bottom">
      <button
        type="button"
        aria-label="Usage"
        title="Context and usage"
        className="flex h-7 shrink-0 cursor-pointer items-center gap-3 rounded-md px-2 font-mono text-[11px] text-muted-foreground tabular-nums transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 data-[state=open]:bg-accent"
      >
        <span>
          ↑{fmtTokens(usage.inputTokens)} ↓{fmtTokens(usage.outputTokens)}
        </span>
        {usage.costUSD !== undefined && (
          <span>
            {usage.estimated ? '~' : ''}
            {fmtUSD(usage.costUSD)}
          </span>
        )}
      </button>
    </UsagePopover>
  );
}
