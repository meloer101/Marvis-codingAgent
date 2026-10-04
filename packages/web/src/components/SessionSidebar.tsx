import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';
import {
  Archive,
  ArchiveRestore,
  ChartColumn,
  ChevronRight,
  Columns2,
  Copy,
  FolderPlus,
  GitBranch,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings,
  Trash2,
  X,
} from 'lucide-react';

import type { SessionSummary, Workspace } from '@harness-code/protocol';

import { useAddProject } from '@/components/AddProjectDialog';
import { NotifyToggle } from '@/components/NotifyToggle';
import { SidebarCloser, SlideRegion, footerIcon } from '@/components/Regions';
import { ThemeToggle } from '@/components/ThemeToggle';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { ContextActions, DropdownActions } from '@/components/ui/menu';
import type { MenuAction } from '@/components/ui/menu';
import { relativeTime } from '@/lib/format';
import { routeToHash, useRoute } from '@/lib/route';
import { closePane, focusPane, openBeside, sessionHash } from '@/lib/split';
import { loadSeen, markSeen, rowStatus, sidebarGroups } from '@/lib/sidebar';
import type { RowStatus, SidebarGroup } from '@/lib/sidebar';
import { useSidebarOpen } from '@/lib/sidebarOpen';
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

  const fresh = useFreshRows(sessions);
  const addProject = useAddProject();
  const picking = useAppStore((s) => s.pickingFolder);
  const route = useRoute();

  return (
    <SlideRegion open={useSidebarOpen()} width="248px">
      <aside aria-label="Sessions" className="flex h-full flex-col border-r bg-background">
      <div className="titlebar flex h-11 shrink-0 items-center gap-1 pr-3 pl-2.5">
        <SidebarCloser />
        <span className="text-sm font-semibold">
          Marvis
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onNew}
          disabled={!connected}
          title="New session (⇧⌘O)"
          className="flex h-[26px] items-center gap-1 rounded-md bg-muted px-1.5 text-xs font-medium transition-colors hover:bg-muted/70 disabled:pointer-events-none disabled:opacity-40"
        >
          <Plus className="size-3.5" />
          New
        </button>
      </div>
      <div className="px-2.5">
        <label className="flex h-7 items-center gap-1.5 rounded-md bg-subtle pr-1.5 pl-2 focus-within:ring-2 focus-within:ring-ring/30">
          <Search className="size-[13px] shrink-0 text-faint" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query !== '') {
                e.preventDefault(); // clears the search; must not also stop a run
                setQuery('');
              }
            }}
            placeholder="Search"
            aria-label="Search sessions"
            className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-faint"
          />
          {query !== '' ? (
            <button type="button" aria-label="Clear search" onClick={() => setQuery('')}>
              <X className="size-3.5 text-faint" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => sync.setPaletteOpen(true)}
              title="Command palette — every action and session"
              aria-label="Command palette"
              className="font-mono text-[11px] text-faint transition-colors hover:text-foreground"
            >
              ⌘K
            </button>
          )}
        </label>
      </div>

      <nav className="mt-3 flex-1 overflow-y-auto px-2 pb-3">
        {searching && groups.length === 0 && (
          <p className="px-2 py-6 text-center text-[13px] text-muted-foreground">No session matches “{query.trim()}”.</p>
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
                riseDelay={fresh.get(row.id)}
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
            onClick={addProject}
            disabled={!connected || picking}
            className="mt-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-faint transition-colors hover:bg-subtle hover:text-foreground disabled:opacity-40"
          >
            {picking ? <LoaderCircle className="size-[13px] animate-spin" /> : <FolderPlus className="size-[13px]" />}
            {picking ? 'Choosing a folder…' : 'Add project'}
          </button>
        )}
      </nav>

      <div className="flex h-10 shrink-0 items-center gap-0.5 pr-3.5 pl-2.5">
        <ThemeToggle />
        <NotifyToggle />
        <a
          href={routeToHash({ kind: 'stats' })}
          title="Usage — tokens, cost and calls across sessions"
          aria-label="Usage"
          aria-current={route.kind === 'stats' ? 'page' : undefined}
          className={footerIcon}
        >
          <ChartColumn />
        </a>
        <a
          href={routeToHash({ kind: 'settings', section: 'permissions' })}
          title="Settings — permissions, auto mode, memory, MCP servers, skills, sub-agents"
          aria-label="Settings"
          aria-current={route.kind === 'settings' ? 'page' : undefined}
          className={footerIcon}
        >
          <Settings />
        </a>
        <div className="flex-1" />
        <span className="flex items-center gap-1.5 pr-1 text-[11px] text-faint">
          <span className={cn('size-1.5 rounded-full', connected ? 'bg-success' : 'bg-warning-dot')} />
          {connected ? 'Connected' : 'Offline'}
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
    </SlideRegion>
  );
}

/**
 * Sessions that turn up after the list first loaded, each with the delay its
 * rise starts after: 140ms apart when several arrive together.
 */
function useFreshRows(sessions: readonly SessionSummary[]): ReadonlyMap<string, number> {
  const known = useRef<Set<string> | null>(null);
  const fresh = useRef(new Map<string, number>());
  if (known.current === null) {
    if (sessions.length > 0) known.current = new Set(sessions.map((s) => s.id));
  } else {
    let n = 0;
    for (const s of sessions) {
      if (known.current.has(s.id)) continue;
      known.current.add(s.id);
      fresh.current.set(s.id, n++ * 140);
    }
  }
  return fresh.current;
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
    'rounded p-0.5 text-faint opacity-0 transition-opacity group-hover/project:opacity-100 hover:text-foreground focus-visible:opacity-100 data-[state=open]:opacity-100';
  return (
    <section className="mb-1 flex flex-col gap-px">
      <div className="group/project flex items-center gap-0.5 pr-1">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          title={workspace.missing ? `${workspace.root} (missing)` : workspace.root}
          className="flex min-w-0 flex-1 items-center gap-1 px-2 pt-2 pb-1 text-left"
        >
          <span
            className={cn(
              'truncate text-[11px] font-medium tracking-[0.02em] text-faint transition-colors group-hover/project:text-muted-foreground',
              workspace.missing && 'line-through',
            )}
          >
            {workspace.name}
          </span>
          {!open && <ChevronRight className="size-3 shrink-0 text-faint" />}
        </button>
        <a
          href={routeToHash({ kind: 'new', workspaceId: workspace.id })}
          aria-label={`New session in ${workspace.name}`}
          title={`New session in ${workspace.name}`}
          className={cn(hoverOnly, 'mt-1')}
        >
          <Plus className="size-3.5" />
        </a>
        <DropdownActions
          label={`${workspace.name} actions`}
          actions={actions}
          trigger={
            <button type="button" className={cn(hoverOnly, 'mt-1')}>
              <MoreHorizontal className="size-3.5" />
            </button>
          }
        />
      </div>
      {open && (
        <ul className="flex flex-col gap-px">
          {children}
          {rows.length === 0 && archivedCount === 0 && <li className="px-2 py-1 text-[12px] text-faint">No sessions yet</li>}
          {archivedCount > 0 && (
            <li>
              <button
                type="button"
                onClick={onToggleArchived}
                className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-faint hover:text-foreground"
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
  riseDelay,
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
  /** It arrived after the list loaded: rise in, after this many ms. */
  riseDelay: number | undefined;
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
      <li
        className={cn('group/row relative', riseDelay !== undefined && 'animate-rise')}
        style={riseDelay ? ({ '--rise-delay': `${riseDelay}ms` } as CSSProperties) : undefined}
      >
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
          aria-current={active ? 'page' : undefined}
          className={cn(
            'flex h-7 items-center gap-2 rounded-md px-2 text-[13px] text-muted-foreground transition-colors hover:bg-subtle hover:text-foreground',
            active && 'bg-muted font-medium text-foreground hover:bg-muted',
            !active && pane !== -1 && 'bg-subtle text-foreground',
            row.archived && 'text-faint',
          )}
        >
          {row.pinned && <Pin className="size-3 shrink-0 text-faint" aria-label="Pinned" />}
          {row.worktree && (
            <span className="flex shrink-0" title={`On ${row.worktree.branch}, in a worktree of its own`}>
              <GitBranch className="size-3 text-faint" aria-label={`In a worktree, on ${row.worktree.branch}`} />
            </span>
          )}
          <span className="min-w-0 flex-1 truncate">{row.title || 'Untitled session'}</span>
          <span className="flex shrink-0 items-center group-hover/row:invisible">
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
                className="rounded p-0.5 text-faint opacity-0 transition-opacity group-hover/row:opacity-100 hover:text-foreground focus-visible:opacity-100 data-[state=open]:opacity-100"
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
      return <span className="mx-[3px] block size-1.5 rounded-full bg-warning-dot" title="Waiting for you" />;
    case 'running':
      return <LoaderCircle className="size-3 animate-spin text-primary" aria-label="Running" />;
    case 'unread':
      return <span className="mx-[3px] block size-1.5 rounded-full bg-primary" title="New since you last looked" />;
    case 'idle':
      return <span className="font-mono text-[11px] text-faint">{relativeTime(mtimeMs)}</span>;
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
    <li>
      <input
        autoFocus
        aria-label="Session title"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => onDone(value)}
        onFocus={(e) => e.target.select()}
        className="h-7 w-full rounded-md bg-background px-2 text-[13px] ring-2 ring-ring/40 outline-none"
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
            <p className="truncate rounded-md bg-subtle px-3 py-2 text-[13px]">{session.title}</p>
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
          title={`Remove ${workspace.name} from Marvis?`}
          description="Its sessions and files stay where they are; add the project again to see them."
        >
          <div className="flex flex-col gap-4 px-5 pt-3 pb-5">
            <p className="truncate rounded-md bg-subtle px-3 py-2 font-mono text-xs">{workspace.root}</p>
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
