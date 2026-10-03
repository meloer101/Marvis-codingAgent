import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import {
  Activity,
  Archive,
  ArchiveRestore,
  BookOpen,
  ChartColumn,
  ChartPie,
  Columns2,
  Cpu,
  FolderPlus,
  FolderTree,
  Gauge,
  GitCompareArrows,
  GitFork,
  Keyboard,
  ListChecks,
  ListCollapse,
  ListTree,
  MessageSquare,
  Minimize2,
  Monitor,
  Moon,
  PanelRightClose,
  Pencil,
  Pin,
  PinOff,
  Plug,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Sparkle,
  Square,
  SquareTerminal,
  Sun,
} from 'lucide-react';

import type { PermissionMode } from '@harness-code/core';

import { EFFORT_LABELS, MODES } from '@/components/ComposerControls';
import { relativeTime } from '@/lib/format';
import { filterPalette } from '@/lib/palette';
import type { PaletteGroup, PaletteItem } from '@/lib/palette';
import { panesOf, routeToHash, useRoute } from '@/lib/route';
import { closePane, openBeside, openSession } from '@/lib/split';
import { useAppStore } from '@/lib/store';
import { useSync } from '@/lib/syncContext';
import { setTheme, useTheme } from '@/lib/theme';
import type { Theme } from '@/lib/theme';
import { cn } from '@/lib/utils';
import { setPanel, usePanel } from '@/lib/panel';
import { setTerminalOpen, useTerminalPanel } from '@/lib/terminalPanel';
import { setVerbose, useVerbose } from '@/lib/verbose';

const FALLBACK_MODES: readonly PermissionMode[] = ['ask', 'acceptEdits', 'plan', 'readOnly'];
const GROUPS: readonly PaletteGroup[] = ['New', 'This session', 'Sessions', 'App'];
const THEMES: Record<Theme, { label: string; icon: typeof Sun }> = {
  system: { label: 'System', icon: Monitor },
  light: { label: 'Light', icon: Sun },
  dark: { label: 'Dark', icon: Moon },
};

/** ⌘K: every action, session and project, one query away. */
export function CommandPalette({ activeId, onNewSession }: { activeId: string | null; onNewSession: () => void }) {
  const sync = useSync();
  const open = useAppStore((s) => s.paletteOpen);
  if (!open) return null;
  return <Palette activeId={activeId} onNewSession={onNewSession} onClose={() => sync.setPaletteOpen(false)} />;
}

function Palette({
  activeId,
  onNewSession,
  onClose,
}: {
  activeId: string | null;
  onNewSession: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const items = usePaletteItems(activeId, onNewSession);
  const shown = useMemo(() => filterPalette(items, query), [items, query]);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    // Guarded: jsdom has no scrollIntoView.
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  const run = (item: PaletteItem | undefined, alt = false): void => {
    if (!item) return;
    onClose();
    (alt && item.altRun ? item.altRun : item.run)();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (shown.length === 0) return;
      setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(shown[active], e.altKey);
    }
  };

  const grouped = query.trim() === '';
  return (
    <DialogPrimitive.Root open onOpenChange={(open) => !open && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-foreground/20 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed top-[14vh] left-1/2 z-50 flex max-h-[min(34rem,72vh)] w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 flex-col overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-2xl outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
        >
          <DialogPrimitive.Title className="sr-only">Command palette</DialogPrimitive.Title>
          <label className="flex items-center gap-2.5 border-b px-4 py-3">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Type a command, or search sessions…"
              aria-label="Command"
              aria-controls="palette-list"
              aria-activedescendant={shown[active] ? `palette-${shown[active].id}` : undefined}
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
            <kbd className="font-mono text-[10px] text-muted-foreground">esc</kbd>
          </label>
          <ul id="palette-list" ref={listRef} role="listbox" aria-label="Commands" className="min-h-0 overflow-y-auto p-1.5">
            {shown.length === 0 && (
              <li className="px-3 py-6 text-center font-serif text-[13px] text-muted-foreground italic">Nothing matches.</li>
            )}
            {shown.map((item, i) => {
              const heading = grouped && shown[i - 1]?.group !== item.group ? item.group : null;
              const Icon = item.icon;
              return (
                <li key={item.id} role="presentation">
                  {heading && (
                    <p className="px-2.5 pt-2.5 pb-1 font-mono text-[10px] tracking-[0.12em] text-muted-foreground uppercase">
                      {heading}
                    </p>
                  )}
                  <div
                    id={`palette-${item.id}`}
                    role="option"
                    aria-selected={i === active}
                    onMouseMove={() => i !== active && setActive(i)}
                    onClick={(e) => run(item, e.altKey)}
                    className={cn(
                      'flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px]',
                      i === active && 'bg-accent text-accent-foreground',
                    )}
                  >
                    {Icon ? <Icon className="size-3.5 shrink-0 text-muted-foreground" /> : <span className="size-3.5 shrink-0" />}
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {item.altRun && i === active && (
                      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">⌥↵ beside</span>
                    )}
                    {item.hint && <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{item.hint}</span>}
                  </div>
                </li>
              );
            })}
          </ul>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** Everything the palette offers right now, in group order. */
function usePaletteItems(activeId: string | null, onNewSession: () => void): PaletteItem[] {
  const sync = useSync();
  const view = useAppStore((s) => (activeId ? s.views[activeId] : undefined));
  const row = useAppStore((s) => (activeId ? s.sessions.find((r) => r.id === activeId) : undefined));
  const sessions = useAppStore((s) => s.sessions);
  const workspaces = useAppStore((s) => s.workspaces);
  const models = useAppStore((s) => (view?.workspaceId ? s.models[view.workspaceId] : undefined));
  const theme = useTheme();
  const verbose = useVerbose();
  const panel = usePanel();
  const terminalOpen = useTerminalPanel().open;
  const panes = panesOf(useRoute());
  const workspaceId = view?.workspaceId;

  // The models to switch to: fresh each time the palette opens.
  useEffect(() => {
    if (workspaceId) void sync.loadModels(workspaceId);
  }, [workspaceId]);

  return useMemo(() => {
    const items: PaletteItem[] = [];
    const go = (hash: string) => () => {
      window.location.hash = hash;
    };

    items.push({ id: 'new', group: 'New', label: 'New session', hint: '⇧⌘O', icon: Plus, run: onNewSession });
    for (const w of workspaces) {
      if (w.missing) continue;
      items.push({
        id: `new-in-${w.id}`,
        group: 'New',
        label: `New session in ${w.name}`,
        keywords: w.root,
        icon: Plus,
        run: go(routeToHash({ kind: 'new', workspaceId: w.id })),
      });
    }
    items.push({ id: 'add-project', group: 'New', label: 'Add project…', icon: FolderPlus, run: () => sync.setAddProjectOpen(true) });

    if (view && activeId) {
      const id = activeId;
      const group = 'This session' as const;
      const modes = workspaces.find((w) => w.id === view.workspaceId)?.defaults.modes ?? FALLBACK_MODES;
      if (view.running) items.push({ id: 'stop', group, label: 'Stop the run', hint: 'esc', icon: Square, run: () => void sync.abort(id) });
      items.push({ id: 'rename', group, label: 'Rename session', icon: Pencil, run: () => sync.request(id, 'rename') });
      if (row) {
        items.push(
          row.pinned
            ? { id: 'unpin', group, label: 'Unpin session', icon: PinOff, run: () => void sync.updateSession(id, { pinned: false }) }
            : { id: 'pin', group, label: 'Pin session', icon: Pin, run: () => void sync.updateSession(id, { pinned: true }) },
          row.archived
            ? { id: 'unarchive', group, label: 'Unarchive session', icon: ArchiveRestore, run: () => void sync.updateSession(id, { archived: false }) }
            : { id: 'archive', group, label: 'Archive session', icon: Archive, run: () => void sync.updateSession(id, { archived: true }) },
        );
      }
      items.push(
        { id: 'compact', group, label: 'Compact the context', hint: '/compact', icon: Minimize2, run: () => void sync.send(id, '/compact') },
        {
          id: 'fork',
          group,
          label: 'Fork session',
          keywords: 'copy branch duplicate conversation',
          icon: GitFork,
          run: () => void sync.fork(id).then((forkId) => forkId && openSession(forkId)),
        },
        { id: 'usage', group, label: 'Context and usage', hint: '/cost', keywords: 'cost tokens', icon: ChartPie, run: () => sync.request(id, 'usage') },
        { id: 'skills', group, label: 'Skills…', hint: '/skills', icon: Sparkle, run: () => sync.request(id, 'skills') },
      );
      for (const m of modes) {
        if (m === view.mode) continue;
        const { label, icon } = MODES[m];
        items.push({ id: `mode-${m}`, group, label: `Mode: ${label}`, keywords: 'permission mode', icon, run: () => void sync.setMode(id, m) });
      }
      for (const m of models ?? []) {
        if (m.ref === view.modelRef || m.problem || view.running) continue;
        items.push({ id: `model-${m.ref}`, group, label: `Model: ${m.ref}`, keywords: 'switch model', icon: Cpu, run: () => void sync.setModel(id, m.ref) });
      }
      for (const level of view.effortLevels) {
        if (level === view.effort) continue;
        items.push({
          id: `effort-${level}`,
          group,
          label: `Effort: ${EFFORT_LABELS[level]}`,
          keywords: 'reasoning effort',
          icon: Gauge,
          run: () => void sync.setEffort(id, level),
        });
      }
    }

    const names = new Map(workspaces.map((w) => [w.id, w.name]));
    const others = sessions.filter((s) => s.id !== activeId);
    for (const s of [...others.filter((s) => !s.archived), ...others.filter((s) => s.archived)]) {
      items.push({
        id: `session-${s.id}`,
        group: 'Sessions',
        label: s.title,
        hint: `${names.get(s.workspaceId) ?? ''} · ${relativeTime(s.mtimeMs)}${s.archived ? ' · archived' : ''}`,
        keywords: names.get(s.workspaceId) ?? '',
        icon: MessageSquare,
        run: () => openSession(s.id),
        ...(activeId ? { altRun: () => openBeside(s.id) } : {}),
      });
    }
    if (panes.length > 1 && activeId) {
      const other = panes.indexOf(activeId) === 0 ? 1 : 0;
      items.push({ id: 'split-close', group: 'App', label: 'Close the other pane', keywords: 'split view unsplit', icon: Columns2, run: () => closePane(other) });
    }

    items.push({
      id: 'settings',
      group: 'App',
      label: 'Settings',
      keywords: 'preferences configuration',
      icon: Settings,
      run: go(routeToHash({ kind: 'settings', section: 'permissions' })),
    });
    items.push({
      id: 'settings-permissions',
      group: 'App',
      label: 'Permission rules',
      keywords: 'settings allow ask deny auto mode denials',
      icon: ShieldCheck,
      run: go(routeToHash({ kind: 'settings', section: 'permissions' })),
    });
    items.push({
      id: 'settings-mcp',
      group: 'App',
      label: 'MCP servers',
      keywords: 'settings oauth sign in login',
      icon: Plug,
      run: go(routeToHash({ kind: 'settings', section: 'mcp' })),
    });
    items.push({
      id: 'settings-memory',
      group: 'App',
      label: 'Memory and instructions',
      keywords: 'settings agents.md claude.md memories',
      icon: BookOpen,
      run: go(routeToHash({ kind: 'settings', section: 'memory' })),
    });
    items.push({
      id: 'stats',
      group: 'App',
      label: 'Usage and stats',
      keywords: 'cost tokens trace telemetry spend',
      icon: ChartColumn,
      run: go(routeToHash({ kind: 'stats' })),
    });
    if (view && activeId) {
      items.push({
        id: 'trace',
        group: 'App',
        label: 'Show the trace',
        keywords: 'timeline calls latency tokens',
        icon: Activity,
        run: () => setPanel('trace'),
      });
    }
    for (const t of ['system', 'light', 'dark'] as const) {
      if (t === theme) continue;
      items.push({ id: `theme-${t}`, group: 'App', label: `Theme: ${THEMES[t].label}`, keywords: 'appearance', icon: THEMES[t].icon, run: () => setTheme(t) });
    }
    items.push(
      terminalOpen
        ? { id: 'terminal-hide', group: 'App', label: 'Hide the terminal', hint: '⌃`', keywords: 'shell console', icon: SquareTerminal, run: () => setTerminalOpen(false) }
        : { id: 'terminal-show', group: 'App', label: 'Show the terminal', hint: '⌃`', keywords: 'shell console', icon: SquareTerminal, run: () => setTerminalOpen(true) },
    );
    if (panel !== 'changes') {
      items.push({ id: 'panel-changes', group: 'App', label: 'Show changes', hint: panel ? undefined : '⌥⌘B', keywords: 'git diff panel status', icon: GitCompareArrows, run: () => setPanel('changes') });
    }
    if (panel !== 'files') {
      items.push({ id: 'panel-files', group: 'App', label: 'Show files', keywords: 'browse tree open file panel', icon: FolderTree, run: () => setPanel('files') });
    }
    if (panel !== 'tasks') {
      items.push({ id: 'panel-tasks', group: 'App', label: 'Show tasks', keywords: 'todo panel plan', icon: ListChecks, run: () => setPanel('tasks') });
    }
    if (panel) {
      items.push({ id: 'panel-close', group: 'App', label: 'Hide the side panel', hint: '⌥⌘B', keywords: 'changes tasks', icon: PanelRightClose, run: () => setPanel(null) });
    }
    items.push(
      verbose
        ? { id: 'fold', group: 'App', label: 'Fold exploration calls', hint: '⌃O', keywords: 'transcript compact verbose', icon: ListCollapse, run: () => setVerbose(false) }
        : { id: 'verbose', group: 'App', label: 'Show every tool call', hint: '⌃O', keywords: 'transcript verbose expand', icon: ListTree, run: () => setVerbose(true) },
    );
    items.push({
      id: 'help',
      group: 'App',
      label: 'Commands and keyboard shortcuts',
      hint: '/help',
      keywords: 'help keys',
      icon: Keyboard,
      run: () => sync.setHelpOpen(true),
    });
    // Group order, whatever order they were pushed in.
    return GROUPS.flatMap((g) => items.filter((i) => i.group === g));
  }, [view, activeId, row, sessions, workspaces, models, theme, verbose, panel, terminalOpen, onNewSession, sync, panes.join('/')]);
}
