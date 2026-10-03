import { useEffect, useMemo, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import {
  Archive,
  ArchiveRestore,
  ChartColumn,
  ChevronRight,
  Columns2,
  Copy,
  FolderPlus,
  GitBranch,
  Loader2,
  MessageSquarePlus,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react';

import type { SessionSummary, Workspace } from '@harness-code/protocol';

import { NotifyToggle } from '@/components/NotifyToggle';
import { ThemeToggle } from '@/components/ThemeToggle';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { ContextActions, DropdownActions } from '@/components/ui/menu';
import type { MenuAction } from '@/components/ui/menu';
import { relativeTime } from '@/lib/format';
import { routeToHash } from '@/lib/route';
import { closePane, focusPane, openBeside, sessionHash } from '@/lib/split';
import { loadSeen, markSeen, rowStatus, sidebarGroups } from '@/lib/sidebar';
import type { RowStatus, SidebarGroup } from '@/lib/sidebar';
import { useAppStore } from '@/lib/store';
import { useSync } from '@/lib/syncContext';
import { cn } from '@/lib/utils';
import { platform } from '@/platform';

const COLLAPSED_KEY = 'hc.sidebar.collapsed';

/**
 * Sessions grouped by project (most recently used project first), each group
 * folding away and carrying its own "+" for a new session there. Inside a
 * group: pinned first, then newest; archived only on request. Rows rename in
 * place (double-click) and carry a ⋯ / right-click menu. The search box
 * filters every project at once. A row opens in the focused pane of a split;
 * ⌥-click (or "Open beside") opens it next to the session on screen.
 */
export function SessionSidebar({
  activeId,
  shown = activeId ? [activeId] : [],
  onNew,
}: {
  /** The session with the focus. */
  activeId: string | null;
  /** Every session on screen (two in a split), left to right. */
  shown?: readonly string[];
  onNew: () => void;
}) {
  const sync = useSync();
  const workspaces = useAppStore((s) => s.workspaces);
  const sessions = useAppStore((s) => s.sessions);
  const connected = useAppStore((s) => s.status === 'open');
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState<ReadonlySet<string>>(new Set());
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(loadCollapsed);
  const [seen, setSeen] = useState(loadSeen);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<SessionSummary | null>(null);
  const [removing, setRemoving] = useState<Workspace | null>(null);
  useTick(60_000); // relative times move on by themselves

  // The sessions on screen count as seen, up to their latest change.
  const onScreen = sessions.filter((s) => shown.includes(s.id));
  const onScreenKey = onScreen.map((s) => `${s.id}@${s.mtimeMs}`).join(' ');
  useEffect(() => {
    if (onScreen.length > 0) setSeen((prev) => onScreen.reduce((acc, s) => markSeen(acc, s.id, s.mtimeMs), prev));
  }, [onScreenKey]);

  const groups = useMemo(
    () => sidebarGroups(workspaces, sessions, { query, showArchived }),
    [workspaces, sessions, query, showArchived],
  );
  const searching = query.trim() !== '';

  const flip = (set: ReadonlySet<string>, id: string): Set<string> => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };
  const toggleCollapsed = (id: string): void => {
    const next = flip(collapsed, id);
    setCollapsed(next);
    platform.storage.set(COLLAPSED_KEY, JSON.stringify([...next]));
  };

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
      <div className="flex items-baseline gap-2 px-4 pt-4 pb-3">
        <span className="font-serif text-[17px] font-semibold tracking-[-0.01em]">
          hc<span className="text-brass">·</span>web
        </span>
        <span className="font-mono text-[10px] tracking-[0.14em] text-muted-foreground uppercase">console</span>
      </div>
      <div className="flex flex-col gap-2 px-3 pb-2">
        <button
          type="button"
          onClick={onNew}
          disabled={!connected}
          className="flex w-full items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm font-medium shadow-xs transition-colors hover:bg-sidebar-accent disabled:pointer-events-none disabled:opacity-50"
        >
          <MessageSquarePlus className="size-4 text-primary" />
          <span className="flex-1 text-left">New session</span>
          <kbd className="font-mono text-[10px] text-muted-foreground">⇧⌘O</kbd>
        </button>
        <label className="flex items-center gap-2 rounded-md border bg-background/60 px-2 py-1 focus-within:border-primary/45 focus-within:ring-2 focus-within:ring-primary/20">
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query !== '') {
                e.preventDefault(); // clears the search; must not also stop a run
                setQuery('');
              }
            }}
            placeholder="Search sessions"
            aria-label="Search sessions"
            className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
          />
          {query !== '' ? (
            <button type="button" aria-label="Clear search" onClick={() => setQuery('')}>
              <X className="size-3.5 text-muted-foreground" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => sync.setPaletteOpen(true)}
              title="Command palette — every action and session"
              aria-label="Command palette"
              className="rounded border bg-muted/60 px-1 font-mono text-[9px] leading-4 text-muted-foreground transition-colors hover:text-foreground"
            >
              ⌘K
            </button>
          )}
        </label>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 pt-1 pb-3">
        {searching && groups.length === 0 && (
          <p className="px-2 py-6 text-center font-serif text-[13px] text-muted-foreground italic">
            No session matches “{query.trim()}”.
          </p>
        )}
        {groups.map((group) => (
          <ProjectGroup
            key={group.workspace.id}
            group={group}
            open={searching || !collapsed.has(group.workspace.id)}
            onToggle={() => toggleCollapsed(group.workspace.id)}
            archivedShown={showArchived.has(group.workspace.id)}
            onToggleArchived={() => setShowArchived(flip(showArchived, group.workspace.id))}
            onRemove={() => setRemoving(group.workspace)}
          >
            {group.rows.map((row) => (
              <SessionRow
                key={row.id}
                row={row}
                active={row.id === activeId}
                pane={shown.indexOf(row.id)}
                canOpenBeside={activeId !== null && row.id !== activeId}
                status={rowStatus(row, seen[row.id], shown.includes(row.id))}
                renaming={renaming === row.id}
                onStartRename={() => setRenaming(row.id)}
                onRename={(title) => {
                  setRenaming(null);
                  if (title.trim() !== row.title) void sync.updateSession(row.id, { title });
                }}
                onCancelRename={() => setRenaming(null)}
                onDelete={() => setDeleting(row)}
              />
            ))}
          </ProjectGroup>
        ))}
        {!searching && (
          <button
            type="button"
            onClick={() => sync.setAddProjectOpen(true)}
            disabled={!connected}
            className="mt-2 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground disabled:opacity-50"
          >
            <FolderPlus className="size-3.5" />
            Add project
          </button>
        )}
      </nav>

      <div className="flex items-center justify-between border-t px-3 py-2">
        <div className="flex items-center gap-0.5">
          <ThemeToggle />
          <NotifyToggle />
          <a
            href={routeToHash({ kind: 'stats' })}
            title="Usage — tokens, cost and calls across sessions"
            aria-label="Usage"
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          >
            <ChartColumn className="size-3.5" />
          </a>
        </div>
        <span
          className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground"
          title={connected ? 'Connected' : 'Disconnected'}
        >
          <span className={cn('size-1.5 rounded-full', connected ? 'bg-success' : 'bg-brass')} />
          {connected ? 'live' : 'offline'}
        </span>
      </div>

      <DeleteSessionDialog
        session={deleting}
        onClose={() => setDeleting(null)}
        onConfirm={(row) => {
          setDeleting(null);
          void sync.deleteSession(row.id).then(() => {
            const pane = shown.indexOf(row.id);
            if (pane === -1) return;
            if (shown.length > 1) closePane(pane);
            else window.location.hash = routeToHash({ kind: 'new', workspaceId: row.workspaceId });
          });
        }}
      />
      <RemoveProjectDialog
        workspace={removing}
        onClose={() => setRemoving(null)}
        onConfirm={(workspace) => {
          setRemoving(null);
          void sync.removeWorkspace(workspace.id);
        }}
      />
    </aside>
  );
}

function ProjectGroup({
  group,
  open,
  onToggle,
  archivedShown,
  onToggleArchived,
  onRemove,
  children,
}: {
  group: SidebarGroup;
  open: boolean;
  onToggle: () => void;
  archivedShown: boolean;
  onToggleArchived: () => void;
  onRemove: () => void;
  children: ReactNode;
}) {
  const { workspace, rows, archivedCount } = group;
  const actions: MenuAction[] = [
    { label: 'Copy path', icon: <Copy />, onSelect: () => void navigator.clipboard?.writeText(workspace.root) },
    { label: 'Remove from list…', icon: <X />, onSelect: onRemove, separated: true },
  ];
  const hoverOnly =
    'rounded p-0.5 text-muted-foreground opacity-0 transition-opacity group-hover/project:opacity-100 hover:text-foreground focus-visible:opacity-100 data-[state=open]:opacity-100';
  return (
    <section className="mb-2">
      <div className="group/project flex items-center gap-1 rounded-md pr-1 hover:bg-sidebar-accent/60">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          title={workspace.missing ? `${workspace.root} (missing)` : workspace.root}
          className="flex min-w-0 flex-1 items-center gap-1 px-1.5 py-1 text-left"
        >
          <ChevronRight
            className={cn('size-3 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')}
          />
          <span
            className={cn(
              'truncate font-mono text-[11px] font-medium tracking-wide text-muted-foreground uppercase',
              workspace.missing && 'line-through',
            )}
          >
            {workspace.name}
          </span>
        </button>
        <a
          href={routeToHash({ kind: 'new', workspaceId: workspace.id })}
          aria-label={`New session in ${workspace.name}`}
          title={`New session in ${workspace.name}`}
          className={hoverOnly}
        >
          <Plus className="size-3.5" />
        </a>
        <DropdownActions
          label={`${workspace.name} actions`}
          actions={actions}
          trigger={
            <button type="button" className={hoverOnly}>
              <MoreHorizontal className="size-3.5" />
            </button>
          }
        />
      </div>
      {open && (
        <ul className="mt-0.5 space-y-0.5">
          {children}
          {rows.length === 0 && archivedCount === 0 && (
            <li className="py-1 pl-6 font-serif text-[12px] text-muted-foreground italic">No sessions yet</li>
          )}
          {archivedCount > 0 && (
            <li>
              <button
                type="button"
                onClick={onToggleArchived}
                className="flex items-center gap-1.5 py-0.5 pl-6 text-[11px] text-muted-foreground hover:text-foreground"
              >
                <Archive className="size-3" />
                {archivedShown ? 'Hide archived' : `Archived (${archivedCount})`}
              </button>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

function SessionRow({
  row,
  active,
  pane,
  canOpenBeside,
  status,
  renaming,
  onStartRename,
  onRename,
  onCancelRename,
  onDelete,
}: {
  row: SessionSummary;
  /** It has the focus. */
  active: boolean;
  /** The pane it shows in (-1: not on screen). */
  pane: number;
  canOpenBeside: boolean;
  status: RowStatus;
  renaming: boolean;
  onStartRename: () => void;
  onRename: (title: string) => void;
  onCancelRename: () => void;
  onDelete: () => void;
}) {
  const sync = useSync();
  if (renaming) return <RenameRow title={row.title} onDone={onRename} onCancel={onCancelRename} />;

  const update = (patch: { pinned?: boolean; archived?: boolean }) => () => void sync.updateSession(row.id, patch);
  const actions: MenuAction[] = [
    { label: 'Rename', icon: <Pencil />, onSelect: onStartRename },
    row.pinned
      ? { label: 'Unpin', icon: <PinOff />, onSelect: update({ pinned: false }) }
      : { label: 'Pin', icon: <Pin />, onSelect: update({ pinned: true }) },
    row.archived
      ? { label: 'Unarchive', icon: <ArchiveRestore />, onSelect: update({ archived: false }) }
      : { label: 'Archive', icon: <Archive />, onSelect: update({ archived: true }) },
    ...(canOpenBeside ? [{ label: 'Open beside', icon: <Columns2 />, onSelect: () => openBeside(row.id) }] : []),
    { label: 'Copy session id', icon: <Copy />, onSelect: () => void navigator.clipboard?.writeText(row.id) },
    { label: 'Delete…', icon: <Trash2 />, onSelect: onDelete, destructive: true, separated: true },
  ];

  return (
    <ContextActions actions={actions}>
      <li className="group/row relative">
        <a
          href={sessionHash(row.id)}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey) return; // the browser's own: a new tab or window
            if (e.altKey && canOpenBeside) {
              e.preventDefault();
              openBeside(row.id);
            } else if (pane !== -1) {
              e.preventDefault();
              focusPane(pane);
            }
          }}
          onDoubleClick={(e) => {
            e.preventDefault();
            onStartRename();
          }}
          title={canOpenBeside ? '⌥-click to open beside' : undefined}
          className={cn(
            'flex items-center gap-2 rounded-md py-1.5 pr-2 pl-6 text-[13px] transition-colors hover:bg-sidebar-accent',
            active && 'bg-sidebar-accent font-medium text-sidebar-accent-foreground',
            !active && pane !== -1 && 'bg-sidebar-accent/50',
            row.archived && 'text-muted-foreground',
          )}
        >
          {row.pinned && <Pin className="absolute left-2 size-3 text-muted-foreground" aria-label="Pinned" />}
          {row.worktree && (
            <span className="flex shrink-0" title={`On ${row.worktree.branch}, in a worktree of its own`}>
              <GitBranch className="size-3 text-muted-foreground" aria-label={`In a worktree, on ${row.worktree.branch}`} />
            </span>
          )}
          <span className="min-w-0 flex-1 truncate">{row.title || 'Untitled session'}</span>
          <span className="shrink-0 group-hover/row:invisible">
            <RowStatusMark status={status} mtimeMs={row.mtimeMs} />
          </span>
        </a>
        <span className="absolute top-1/2 right-1 -translate-y-1/2">
          <DropdownActions
            label={`${row.title} actions`}
            actions={actions}
            trigger={
              <button
                type="button"
                className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity group-hover/row:opacity-100 hover:bg-background/60 hover:text-foreground focus-visible:opacity-100 data-[state=open]:opacity-100"
              >
                <MoreHorizontal className="size-3.5" />
              </button>
            }
          />
        </span>
      </li>
    </ContextActions>
  );
}

function RowStatusMark({ status, mtimeMs }: { status: RowStatus; mtimeMs: number }) {
  switch (status) {
    case 'pending':
      return <span className="block size-2 rounded-full bg-brass" title="Waiting for you" />;
    case 'running':
      return <Loader2 className="size-3.5 animate-spin text-primary" aria-label="Running" />;
    case 'unread':
      return <span className="block size-2 rounded-full bg-primary" title="New since you last looked" />;
    case 'idle':
      return <span className="font-mono text-[10px] text-muted-foreground">{relativeTime(mtimeMs)}</span>;
  }
}

/** Rename in place: Enter or leaving the field saves (empty goes back to the first message), Esc cancels. */
function RenameRow({ title, onDone, onCancel }: { title: string; onDone: (title: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(title);
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      onDone(value);
    } else if (e.key === 'Escape') {
      e.preventDefault(); // cancels the rename; must not also stop a run
      e.stopPropagation();
      onCancel();
    }
  };
  return (
    <li className="px-1">
      <input
        autoFocus
        aria-label="Session title"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => onDone(value)}
        onFocus={(e) => e.target.select()}
        className="w-full rounded-md border border-primary/45 bg-background px-2 py-1 pl-5 text-[13px] ring-2 ring-primary/20 outline-none"
      />
    </li>
  );
}

function DeleteSessionDialog({
  session,
  onClose,
  onConfirm,
}: {
  session: SessionSummary | null;
  onClose: () => void;
  onConfirm: (session: SessionSummary) => void;
}) {
  return (
    <Dialog open={session !== null} onOpenChange={(open) => !open && onClose()}>
      {session && (
        <DialogContent
          title="Delete this session?"
          description={
            session.worktree
              ? `Its conversation, metadata, offloaded output and trace are removed for good — and its worktree, with any uncommitted changes. Its branch ${session.worktree.branch} goes too if it was merged.`
              : 'Its conversation, metadata, offloaded output and trace are removed for good.'
          }
        >
          <div className="flex flex-col gap-4 px-5 pt-3 pb-5">
            <p className="truncate rounded-md border bg-muted/40 px-3 py-2 text-sm">{session.title}</p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Button variant="destructive" size="sm" onClick={() => onConfirm(session)}>
                Delete
              </Button>
            </div>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}

function RemoveProjectDialog({
  workspace,
  onClose,
  onConfirm,
}: {
  workspace: Workspace | null;
  onClose: () => void;
  onConfirm: (workspace: Workspace) => void;
}) {
  return (
    <Dialog open={workspace !== null} onOpenChange={(open) => !open && onClose()}>
      {workspace && (
        <DialogContent
          title={`Remove ${workspace.name} from hc web?`}
          description="Its sessions and files stay where they are; add the project again to see them."
        >
          <div className="flex flex-col gap-4 px-5 pt-3 pb-5">
            <p className="truncate rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs">{workspace.root}</p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Button size="sm" onClick={() => onConfirm(workspace)}>
                Remove
              </Button>
            </div>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}

function loadCollapsed(): Set<string> {
  try {
    const raw = platform.storage.get(COLLAPSED_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

/** Re-render every `ms` (relative times). */
function useTick(ms: number): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), ms);
    return () => clearInterval(timer);
  }, [ms]);
}
