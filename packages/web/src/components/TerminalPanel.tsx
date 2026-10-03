import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { Plus, SquareTerminal, X } from 'lucide-react';

import type { Checkout } from '@/lib/checkout';
import { useAppStore } from '@/lib/store';
import { useSync } from '@/lib/syncContext';
import { MIN_HEIGHT, setTerminalHeight, setTerminalOpen, useTerminalPanel } from '@/lib/terminalPanel';
import { cn } from '@/lib/utils';

const XTermView = lazy(() => import('@/components/XTermView').then((m) => ({ default: m.XTermView })));

/** A character cell of the terminal font, to size a new shell before the view measures itself. */
const CELL = { width: 7.2, height: 17 };

/**
 * The project's terminals, under the session: a tab per shell (+ for another,
 * × to end one), the one chosen showing. A new one starts where the session
 * works — its worktree, if it has one (and it's there). They run on the server, so they
 * outlive the page; each tab keeps its view mounted so its scrollback stays.
 */
export function TerminalPanel({ checkout }: { checkout: Checkout }) {
  const { workspaceId } = checkout;
  const sync = useSync();
  const { open, height } = useTerminalPanel();
  const available = useAppStore((s) => s.info?.capabilities?.terminal ?? false);
  const terminals = useAppStore((s) => s.terminals[workspaceId]);
  const [active, setActive] = useState<string | null>(null);
  const [titles, setTitles] = useState<Record<string, string>>({});
  const body = useRef<HTMLDivElement>(null);
  const creating = useRef(false);

  useEffect(() => {
    if (open) void sync.loadTerminals(workspaceId);
  }, [sync, workspaceId, open]);

  const create = async (): Promise<void> => {
    if (creating.current) return;
    creating.current = true;
    const rect = body.current?.getBoundingClientRect();
    const cols = Math.max(20, Math.floor((rect?.width ?? 800) / CELL.width) - 2);
    const rows = Math.max(5, Math.floor((rect?.height ?? 240) / CELL.height));
    // An archived session's worktree is gone: a new shell starts in the project folder.
    const t = await sync.createTerminal(checkout.missing ? { workspaceId } : checkout, cols, rows);
    creating.current = false;
    if (t) setActive(t.id);
  };

  // Opening the panel on a project without a terminal starts one.
  useEffect(() => {
    if (open && available && terminals && terminals.length === 0) void create();
  }, [open, available, terminals?.length]);

  // Keep a tab chosen: the newest when the chosen one goes.
  const shown = terminals?.some((t) => t.id === active) ? active : (terminals?.at(-1)?.id ?? null);

  if (!open) return null;

  const onDrag = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const startY = e.clientY;
    const startH = height;
    const move = (ev: PointerEvent): void => setTerminalHeight(startH + (startY - ev.clientY));
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <section
      aria-label="Terminal"
      style={{ height: `min(${height}px, 70vh)`, minHeight: MIN_HEIGHT }}
      className="relative flex shrink-0 flex-col border-t bg-background"
    >
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize the terminal"
        onPointerDown={onDrag}
        className="absolute -top-1 right-0 left-0 z-10 h-2 cursor-row-resize"
      />
      <div className="flex h-8 shrink-0 items-center gap-0.5 border-b px-2">
        <div role="tablist" className="flex min-w-0 items-center gap-0.5 overflow-x-auto">
          {terminals?.map((t, i) => (
            <div
              key={t.id}
              className={cn(
                'group flex h-6 shrink-0 items-center gap-1 rounded-md pr-0.5 pl-2 text-xs transition-colors',
                t.id === shown ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
              )}
            >
              <button type="button" role="tab" aria-selected={t.id === shown} onClick={() => setActive(t.id)} className="flex items-center gap-1.5">
                <SquareTerminal className="size-3.5 shrink-0" />
                <span className="max-w-40 truncate font-mono text-[11px]">{titles[t.id] || `${t.title} ${i + 1}`}</span>
                {t.exitCode !== undefined && <span className="text-[11px] text-muted-foreground">exited</span>}
              </button>
              <button
                type="button"
                onClick={() => void sync.closeTerminal(t.id)}
                aria-label={`Close ${t.title} ${i + 1}`}
                title="Close the terminal"
                className="rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-accent focus-visible:opacity-100"
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
        {available && (
          <button
            type="button"
            onClick={() => void create()}
            aria-label="New terminal"
            title="New terminal"
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Plus className="size-3.5" />
          </button>
        )}
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => setTerminalOpen(false)}
          aria-label="Hide the terminal"
          title="Hide the terminal (Ctrl+`)"
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <div ref={body} className="relative min-h-0 flex-1">
        {!available ? (
          <p className="px-6 py-8 text-center text-[13px] text-muted-foreground">
            Terminals need node-pty, which couldn’t be loaded on this machine.
          </p>
        ) : (
          <Suspense fallback={<p className="px-4 py-3 text-xs text-muted-foreground">Loading the terminal…</p>}>
            {terminals?.map((t) => (
              <XTermView
                key={t.id}
                id={t.id}
                visible={t.id === shown}
                onTitle={(title) => setTitles((all) => ({ ...all, [t.id]: title }))}
              />
            ))}
          </Suspense>
        )}
      </div>
    </section>
  );
}
