import { useEffect, useRef, useState } from 'react';
import { Loader2, WifiOff, X } from 'lucide-react';
import type { SessionSummary } from '@harness-code/protocol';

import { AddProjectDialog } from '@/components/AddProjectDialog';
import { ArchiveConflictDialog } from '@/components/ArchiveConflictDialog';
import { CommandPalette } from '@/components/CommandPalette';
import { DraftView } from '@/components/DraftView';
import { HelpDialog } from '@/components/HelpDialog';
import { SessionSidebar } from '@/components/SessionSidebar';
import { SessionView } from '@/components/SessionView';
import { attentionChanges, documentTitle, notificationsOn } from '@/lib/attention';
import { parseRoute, routeToHash } from '@/lib/route';
import type { Route } from '@/lib/route';
import { allCommands } from '@/lib/slash';
import { useAppStore } from '@/lib/store';
import { useSync } from '@/lib/syncContext';
import { togglePanel } from '@/lib/panel';
import { toggleTerminal } from '@/lib/terminalPanel';
import { toggleVerbose } from '@/lib/verbose';
import { platform } from '@/platform';

function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = (): void => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

/**
 * Keeps the tab title on what waits for the user, and notifies (while the app
 * is not in front) when a session starts waiting on them or finishes a run.
 */
function useAttention(): void {
  const sessions = useAppStore((s) => s.sessions);
  const prev = useRef<SessionSummary[] | null>(null);
  useEffect(() => {
    document.title = documentTitle(sessions);
    const before = prev.current;
    prev.current = sessions;
    if (!before || !notificationsOn()) return;
    for (const change of attentionChanges(before, sessions)) {
      platform.notify(change.kind === 'needs-you' ? 'Waiting for you' : 'Finished', {
        body: change.title,
        tag: `hc:${change.id}:${change.kind}`,
        onClick: () => {
          window.location.hash = routeToHash({ kind: 'session', id: change.id });
        },
      });
    }
  }, [sessions]);
}

export function App() {
  const sync = useSync();
  const route = useRoute();
  const activeId = route.kind === 'session' ? route.id : null;
  useAttention();

  /**
   * A new session starts as a draft — in the project of the session on screen,
   * else the most recently used one; it exists once its first message is sent.
   */
  const newSession = (): void => {
    const workspaceId = activeId ? useAppStore.getState().views[activeId]?.workspaceId : undefined;
    window.location.hash = routeToHash(workspaceId ? { kind: 'new', workspaceId } : { kind: 'home' });
  };

  // Global keys: the command palette, a new session, the side panel, the
  // terminal (Ctrl+`) and the verbose transcript (Ctrl+O, as in the TUI — Ctrl
  // on a Mac too) anywhere, Esc stops the active run. The composer's menus and the pending dock swallow their
  // own Escape, and an Escape that closes a dialog or the palette never aborts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        sync.setPaletteOpen(!useAppStore.getState().paletteOpen);
        return;
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        sync.setPaletteOpen(false);
        newSession();
        return;
      }
      // By the key's place: Option+B types "∫" on a Mac.
      if (mod && e.altKey && !e.shiftKey && e.code === 'KeyB') {
        e.preventDefault();
        togglePanel();
        return;
      }
      if (e.ctrlKey && !e.metaKey && !e.altKey && e.code === 'Backquote') {
        e.preventDefault();
        toggleTerminal();
        return;
      }
      if (e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        toggleVerbose();
        return;
      }
      // An Escape typed into a terminal is the shell's, not a Stop.
      const inTerminal = e.target instanceof Element && e.target.closest('.xterm') !== null;
      if (e.key === 'Escape' && activeId && !e.defaultPrevented && !inTerminal) {
        const { views, helpOpen, addProjectOpen, paletteOpen } = useAppStore.getState();
        if (!helpOpen && !addProjectOpen && !paletteOpen && views[activeId]?.running) void sync.abort(activeId);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="flex h-full">
      <SessionSidebar activeId={activeId} onNew={newSession} />
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ConnectionBanner />
        <ErrorBanner />
        {activeId ? (
          <SessionView key={activeId} id={activeId} onNewSession={newSession} />
        ) : (
          <DraftView {...(route.kind === 'new' ? { workspaceId: route.workspaceId } : {})} />
        )}
      </main>
      <Help activeId={activeId} />
      <AddProjectDialog />
      <ArchiveConflictDialog />
      <CommandPalette activeId={activeId} onNewSession={newSession} />
    </div>
  );
}

/** The commands listed are the active session's (its MCP prompts differ per session). */
function Help({ activeId }: { activeId: string | null }) {
  const sync = useSync();
  const open = useAppStore((s) => s.helpOpen);
  const mcp = useAppStore((s) => (activeId ? s.slash[activeId] : undefined));
  const skills = useAppStore((s) => (activeId ? s.skills[activeId] : undefined));
  if (!open) return null;
  return <HelpDialog commands={allCommands(mcp ?? [], skills ?? [])} onClose={() => sync.setHelpOpen(false)} />;
}

function ConnectionBanner() {
  const status = useAppStore((s) => s.status);
  if (status === 'open' || status === 'closed') return null;
  if (status === 'unauthorized') {
    return (
      <div className="flex items-center gap-2 border-b border-destructive/25 bg-destructive/10 px-4 py-2 text-xs text-destructive">
        <WifiOff className="size-3.5" />
        The server rejected this page's token — it has probably restarted. Open the URL that <code>hc web</code> printed.
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 border-b border-brass/25 bg-brass-subtle/60 px-4 py-2 text-xs text-brass-strong">
      <Loader2 className="size-3.5 animate-spin" />
      {status === 'connecting' ? 'Connecting…' : 'Connection lost — reconnecting…'}
    </div>
  );
}

function ErrorBanner() {
  const sync = useSync();
  const error = useAppStore((s) => s.error);
  if (!error) return null;
  return (
    <div className="flex items-center gap-2 border-b border-destructive/25 bg-destructive/10 px-4 py-2 text-xs text-destructive">
      <span className="flex-1">{error}</span>
      <button
        type="button"
        onClick={() => sync.dismissError()}
        aria-label="Dismiss"
        className="rounded p-0.5 transition-colors hover:bg-destructive/10"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
