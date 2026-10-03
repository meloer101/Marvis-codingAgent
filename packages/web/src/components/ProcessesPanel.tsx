import { useEffect, useState } from 'react';
import { ChevronRight, LoaderCircle, Square } from 'lucide-react';

import type { SessionProcess } from '@harness-code/protocol';

import { TerminalText } from '@/components/tools/TerminalOutput';
import { useStickToBottom } from '@/hooks/useStickToBottom';
import { fmtDuration } from '@/lib/format';
import { useOpenedProcess } from '@/lib/panel';
import { useSync } from '@/lib/syncContext';
import { cn } from '@/lib/utils';

/**
 * The commands a session started in the background (`run_in_background`):
 * each with how it is and for how long, open to what it printed — following
 * the tail while it runs — and a Stop for the ones still going.
 */
export function ProcessesPanel({ sessionId, processes }: { sessionId: string; processes: readonly SessionProcess[] }) {
  const asked = useOpenedProcess();
  // Open: the one asked for, else the newest still running, else the newest.
  const [open, setOpen] = useState<string | null>(
    () => asked ?? [...processes].reverse().find((p) => p.status === 'running')?.id ?? processes.at(-1)?.id ?? null,
  );
  useEffect(() => {
    if (asked) setOpen(asked);
  }, [asked]);

  if (processes.length === 0) {
    return (
      <p className="px-6 py-16 text-center text-[13px] text-muted-foreground">
        No background commands — a dev server or watcher the agent starts with <code>run_in_background</code>{' '}
        keeps running here.
      </p>
    );
  }
  const running = processes.filter((p) => p.status === 'running').length;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p className="shrink-0 pr-3 pb-2 pl-5 font-mono text-[11px] text-faint">
        {running} running · {processes.length - running} ended
      </p>
      <ul className="mx-3 mb-3 min-h-0 flex-1 overflow-y-auto rounded-lg bg-background py-1">
        {[...processes].reverse().map((p) => (
          <Process
            key={p.id}
            sessionId={sessionId}
            process={p}
            open={open === p.id}
            onToggle={() => setOpen(open === p.id ? null : p.id)}
          />
        ))}
      </ul>
    </div>
  );
}

function Process({
  sessionId,
  process: p,
  open,
  onToggle,
}: {
  sessionId: string;
  process: SessionProcess;
  open: boolean;
  onToggle: () => void;
}) {
  const sync = useSync();
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = useTicking(p.status === 'running');
  const stop = async (): Promise<void> => {
    setStopping(true);
    try {
      await sync.killProcess(sessionId, p.id);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStopping(false);
    }
  };
  return (
    <li>
      <div className="flex items-center gap-2 px-3 py-1.5">
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs"
        >
          <ChevronRight className={cn('size-3 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
          <StatusDot process={p} />
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{p.id}</span>
          <span className="min-w-0 truncate font-mono" title={p.command}>
            {p.command}
          </span>
        </button>
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums" title={statusText(p)}>
          {p.status === 'running' ? fmtDuration(now - p.startedAt) : statusText(p)}
        </span>
        {p.status === 'running' && (
          <button
            type="button"
            onClick={() => void stop()}
            disabled={stopping}
            aria-label={`Stop ${p.id}`}
            title="Stop it, and what it started"
            className="flex shrink-0 items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium transition-colors hover:text-destructive disabled:opacity-50"
          >
            {stopping ? <LoaderCircle className="size-3 animate-spin" /> : <Square className="size-2.5 fill-current" />}
            Stop
          </button>
        )}
      </div>
      {error && <p className="px-3 pb-1.5 text-[11px] text-destructive">{error}</p>}
      {open && <Output process={p} />}
    </li>
  );
}

/** What it printed, following the tail while it runs (unless scrolled up). */
function Output({ process: p }: { process: SessionProcess }) {
  const { ref, onScroll } = useStickToBottom<HTMLDivElement>(p.output.length);
  return (
    <div ref={ref} onScroll={onScroll} className="mx-2 mb-2 max-h-96 overflow-auto rounded-md bg-subtle">
      {p.cwd && <p className="px-3 pt-2 font-mono text-[11px] text-muted-foreground">in {p.cwd}/</p>}
      {p.output ? (
        <TerminalText text={p.output} />
      ) : (
        <p className="px-3 py-2 font-mono text-[11px] text-muted-foreground">(nothing printed yet)</p>
      )}
    </div>
  );
}

function StatusDot({ process: p }: { process: SessionProcess }) {
  return (
    <span
      aria-label={statusText(p)}
      className={cn(
        'size-1.5 shrink-0 rounded-full',
        p.status === 'running'
          ? 'animate-pulse bg-primary'
          : p.status === 'exited' && p.exitCode === 0
            ? 'bg-success'
            : p.status === 'exited'
              ? 'bg-destructive'
              : 'bg-muted-foreground/50',
      )}
    />
  );
}

function statusText(p: SessionProcess): string {
  if (p.status === 'running') return 'running';
  if (p.status === 'killed') return 'stopped';
  return p.exitCode === null || p.exitCode === undefined ? 'ended' : `exit ${p.exitCode}`;
}

/** `Date.now()`, again every second while `on`. */
function useTicking(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}
