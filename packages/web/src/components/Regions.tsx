import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Plus } from 'lucide-react';

import { togglePanel, usePanel } from '@/lib/panel';
import { routeToHash } from '@/lib/route';
import { toggleSidebar, useSidebarOpen } from '@/lib/sidebarOpen';
import { useAppStore } from '@/lib/store';
import { cn } from '@/lib/utils';

/**
 * The window's regions and their toggles (DESIGN.md, "Each toggle stays in its
 * corner"): the sidebar's sits top-left, the side panel's top-right — on the
 * region itself while it is open, in the main header once it is closed.
 */

/** A bare icon button in a header: 15px icon, grey until hovered. */
export const headerIconButton =
  'relative flex shrink-0 items-center justify-center rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground aria-pressed:bg-muted aria-pressed:text-foreground [&_svg]:size-[15px]';

/** An icon in the sidebar's footer: grey, with a grey fill for the page on screen. */
export const footerIcon =
  'flex shrink-0 items-center justify-center rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40 aria-[current=page]:bg-muted aria-[current=page]:text-foreground [&_svg]:size-3.5';

/** The top bar of the main area: 44px, no rule under it — the sheet goes on. */
export function MainHeader({ children, className }: { children: ReactNode; className?: string }) {
  const sidebarOpen = useSidebarOpen();
  return (
    <header
      className={cn(
        'titlebar flex h-11 shrink-0 items-center gap-2 overflow-hidden pr-3 text-[13px]',
        sidebarOpen ? 'pl-5' : 'pl-2.5',
        className,
      )}
    >
      {children}
    </header>
  );
}

/** Closes the sidebar, from its own top-left corner. */
export function SidebarCloser() {
  return (
    <button
      type="button"
      onClick={toggleSidebar}
      aria-label="Hide sidebar"
      title="Hide sidebar"
      className={cn(headerIconButton, 'clear-window-buttons')}
    >
      <PanelLeftClose />
    </button>
  );
}

/**
 * With the sidebar closed, its toggle and an icon-only New session take its
 * corner of the main header; an amber dot on the toggle says a session waits.
 */
export function SidebarOpener({ workspaceId }: { workspaceId?: string | undefined }) {
  const open = useSidebarOpen();
  const waiting = useAppStore((s) => s.sessions.filter((r) => r.pending).length);
  const connected = useAppStore((s) => s.status === 'open');
  if (open) return null;
  return (
    <>
      <button
        type="button"
        onClick={toggleSidebar}
        aria-label={waiting > 0 ? `Show sidebar — ${waiting} waiting for you` : 'Show sidebar'}
        title={waiting > 0 ? `Show sidebar — ${waiting} waiting for you` : 'Show sidebar'}
        className={cn(headerIconButton, 'clear-window-buttons')}
      >
        <PanelLeftOpen />
        {waiting > 0 && (
          <span className="absolute top-1 right-1 size-1.5 rounded-full bg-warning-dot ring-2 ring-background" />
        )}
      </button>
      <a
        href={routeToHash(workspaceId ? { kind: 'new', workspaceId } : { kind: 'home' })}
        aria-label="New session"
        title="New session (⇧⌘O)"
        aria-disabled={!connected}
        className={cn(
          'mr-1.5 flex size-[26px] shrink-0 items-center justify-center rounded-md bg-muted text-foreground transition-colors hover:bg-muted/70',
          !connected && 'pointer-events-none opacity-40',
        )}
      >
        <Plus className="size-3.5" />
      </a>
    </>
  );
}

/** Opens the side panel from the main header's top-right corner while it is closed. */
export function PanelOpener() {
  const open = usePanel() !== null;
  if (open) return null;
  return (
    <button type="button" onClick={togglePanel} aria-label="Show side panel" title="Show side panel (⌥⌘B)" className={headerIconButton}>
      <PanelRightOpen />
    </button>
  );
}

/** Closes the side panel, from its own top-right corner. */
export function PanelCloser() {
  return (
    <button type="button" onClick={togglePanel} aria-label="Close panel" title="Close panel (⌥⌘B)" className={headerIconButton}>
      <PanelRightClose />
    </button>
  );
}

/**
 * A region that slides open and shut at the window's edge: opens over 320ms
 * easing out, closes over 200ms easing in, and the main area reflows with it.
 * It keeps its children while it closes; on first paint it is simply there.
 */
export function SlideRegion({
  open,
  width,
  className,
  children,
  ...rest
}: {
  open: boolean;
  /** A CSS length — the region's width when open. */
  width: string;
  className?: string;
  children: ReactNode;
  'aria-label'?: string;
}) {
  const [present, setPresent] = useState(open);
  // Only a toggle animates; what was open at load is just there.
  const initial = useRef(open);
  const toggled = useRef(false);
  if (open !== initial.current) toggled.current = true;
  useEffect(() => {
    if (open) {
      setPresent(true);
      return;
    }
    const timer = setTimeout(() => setPresent(false), 200);
    return () => clearTimeout(timer);
  }, [open]);
  if (!open && !present) return null;
  return (
    <div
      {...rest}
      style={{ '--region-w': width } as CSSProperties}
      data-open={open}
      inert={!open}
      className={cn(
        'h-full w-(--region-w) shrink-0 overflow-hidden data-[open=false]:w-0',
        toggled.current &&
          'transition-[width] duration-320 ease-out-quint starting:w-0 data-[open=false]:duration-200 data-[open=false]:ease-in',
      )}
    >
      <div className={cn('h-full w-(--region-w)', className)}>{children}</div>
    </div>
  );
}
