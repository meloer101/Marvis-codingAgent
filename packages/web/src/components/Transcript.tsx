import { memo, useMemo, useState } from 'react';
import { AlertTriangle, ArrowDown, Brain, Check, ChevronRight, Circle, FileText, Info, Loader2, X } from 'lucide-react';

import type { Notice } from '@harness-code/core';
import type { Entry, LiveSnapshot, ToolItem } from '@harness-code/protocol';

import { Markdown } from '@/components/Markdown';
import { toolView } from '@/components/tools/registry';
import { Button } from '@/components/ui/button';
import { useStickToBottom } from '@/hooks/useStickToBottom';
import { briefNotice, transcriptRows } from '@/lib/rows';
import type { SessionViewState } from '@/lib/sessionModel';
import { cn } from '@/lib/utils';

export function Transcript({ view }: { view: SessionViewState }) {
  const { entries, live, running } = view;
  const { ref, onScroll, atBottom, scrollToBottom } = useStickToBottom<HTMLDivElement>(
    `${entries.length}:${live.text.length}:${live.thinking.length}:${live.tools.length}:${running}`,
  );
  const liveEmpty = live.text === '' && live.thinking === '' && live.tools.length === 0;
  const rows = useMemo(() => transcriptRows(entries), [entries]);
  const conversationEmpty = rows.every((r) => r.kind === 'details');

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={ref} onScroll={onScroll} className="h-full overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-6">
          {rows.map((row) =>
            row.kind === 'entry' ? (
              <EntryRow key={row.key} entry={row.entry} />
            ) : (
              <SessionDetails key={row.key} notices={row.notices} />
            ),
          )}
          {conversationEmpty && liveEmpty && !running && (
            <p className="py-16 text-center font-serif text-[15px] text-muted-foreground italic">
              Send a message to start.
            </p>
          )}
          {!liveEmpty && <AssistantBlock thinking={live.thinking} text={live.text} tools={live.tools} streaming />}
          {running && liveEmpty && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin text-primary" />
              <span className="font-serif italic">Working…</span>
            </div>
          )}
        </div>
      </div>
      {!atBottom && (
        <Button
          size="sm"
          variant="secondary"
          className="absolute bottom-3 left-1/2 -translate-x-1/2 shadow-md"
          onClick={scrollToBottom}
        >
          <ArrowDown />
          Jump to bottom
        </Button>
      )}
    </div>
  );
}

/** Committed rows never change identity, so memo skips them while the live region streams. */
const EntryRow = memo(function EntryRow({ entry }: { entry: Entry }) {
  return (
    <div
      className="animate-rise"
      style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 80px' }}
    >
      {entry.kind === 'user' ? (
        <UserMessage text={entry.text} {...(entry.attachments ? { attachments: entry.attachments } : {})} />
      ) : entry.kind === 'assistant' ? (
        <AssistantBlock thinking={entry.thinking} text={entry.text} tools={entry.tools} />
      ) : (
        <NoticeRow notice={entry.notice} />
      )}
    </div>
  );
});

export function UserMessage({ text, attachments }: { text: string; attachments?: readonly string[] }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-card px-4 py-3 text-sm shadow-xs">
      {text && <div className="whitespace-pre-wrap">{text}</div>}
      {attachments && attachments.length > 0 && <AttachmentChips paths={attachments} />}
    </div>
  );
}

/** Files attached to a message, as small mono chips. */
export function AttachmentChips({ paths, onRemove }: { paths: readonly string[]; onRemove?: (path: string) => void }) {
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Attached files">
      {paths.map((p) => (
        <li
          key={p}
          title={p}
          className="flex max-w-72 items-center gap-1 rounded-md border bg-muted/50 py-0.5 pr-1.5 pl-1.5 font-mono text-[11px] text-muted-foreground"
        >
          <FileText className="size-3 shrink-0" />
          <span className="truncate">{p}</span>
          {onRemove && (
            <button
              type="button"
              onClick={() => onRemove(p)}
              aria-label={`Detach ${p}`}
              className="-mr-0.5 rounded p-0.5 transition-colors hover:bg-accent hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

function AssistantBlock({
  thinking,
  text,
  tools,
  streaming = false,
}: LiveSnapshot & { streaming?: boolean }) {
  return (
    <div className="flex flex-col gap-2 text-sm">
      {thinking && <Thinking text={thinking} active={streaming && text === '' && tools.length === 0} />}
      {text && (
        <div className={cn(streaming && tools.length === 0 && 'md-streaming')}>
          <Markdown text={text} streaming={streaming} />
        </div>
      )}
      {tools.map((t) => (
        <ToolCard key={t.id} tool={t} />
      ))}
    </div>
  );
}

function Thinking({ text, active }: { text: string; active: boolean }) {
  return (
    <details className="group text-muted-foreground">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs select-none">
        <ChevronRight className="size-3 transition-transform group-open:rotate-90" />
        <Brain className="size-3 text-brass" />
        {active ? 'Thinking…' : 'Thinking'}
      </summary>
      <div className="mt-1.5 border-l-2 border-brass/30 pl-3 font-serif text-[13px] leading-relaxed whitespace-pre-wrap italic">
        {text}
      </div>
    </details>
  );
}

function ToolCard({ tool }: { tool: ToolItem }) {
  const isError = tool.result?.isError === true;
  const view = toolView(tool);
  // Follow the renderer's default (errors open, small diffs open…) until the
  // user toggles — including defaults that change after mount, like an error
  // result arriving.
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = (toggled ?? view.defaultOpen) && view.body !== null;

  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border bg-card text-xs shadow-xs',
        isError && 'border-destructive/40',
      )}
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-accent/60"
        onClick={() => setToggled(!open)}
        disabled={view.body === null}
      >
        {tool.running ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
        ) : !tool.result ? (
          // Not run (yet): e.g. restored from a snapshot while its ask is pending.
          <Circle className="size-3.5 shrink-0 text-muted-foreground" />
        ) : isError ? (
          <X className="size-3.5 shrink-0 text-destructive" />
        ) : (
          <Check className="size-3.5 shrink-0 text-success" />
        )}
        <span className="shrink-0 font-mono text-[11px] font-medium">{tool.name}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{view.summary}</span>
        {view.meta}
        {view.body !== null && (
          <ChevronRight className={cn('size-3 shrink-0 transition-transform', open && 'rotate-90')} />
        )}
      </button>
      {open && <div className="border-t bg-muted/40">{view.body}</div>}
    </div>
  );
}

/**
 * The startup diagnostics as one quiet line — "skills 2 · memory 1 · mcp 1/1
 * ready" — that opens to the full notices. It starts open, and takes the
 * warning colour, when one of them is a warning or an error (an MCP server
 * that failed to start should not hide behind a disclosure).
 */
function SessionDetails({ notices }: { notices: Notice[] }) {
  const worst = notices.some((n) => n.level === 'error')
    ? 'error'
    : notices.some((n) => n.level === 'warn')
      ? 'warn'
      : 'info';
  const brief = notices.map(briefNotice).filter((b): b is string => b !== null);
  const Icon = worst === 'info' ? Info : AlertTriangle;
  return (
    <details
      open={worst !== 'info'}
      className={cn(
        'group text-xs',
        worst === 'error' ? 'text-destructive' : worst === 'warn' ? 'text-brass' : 'text-muted-foreground',
      )}
    >
      <summary className="flex cursor-pointer list-none items-center gap-1.5 select-none">
        <ChevronRight className="size-3 shrink-0 transition-transform group-open:rotate-90" />
        <Icon className="size-3.5 shrink-0" />
        <span className="shrink-0">Session details</span>
        {brief.length > 0 && <span className="truncate font-mono text-[11px] opacity-80">{brief.join(' · ')}</span>}
      </summary>
      <div className="mt-2 ml-1.5 flex flex-col gap-1 border-l pl-3">
        {notices.map((n, i) => (
          <NoticeRow key={i} notice={n} />
        ))}
      </div>
    </details>
  );
}

function NoticeRow({ notice }: { notice: Notice }) {
  if (notice.kind === 'compaction') {
    return (
      <div className="flex items-center gap-3 py-1 font-mono text-[10px] tracking-wide text-muted-foreground uppercase">
        <span className="h-px flex-1 bg-border" />
        {notice.text}
        <span className="h-px flex-1 bg-border" />
      </div>
    );
  }
  const Icon = notice.level === 'info' ? Info : AlertTriangle;
  return (
    <div
      className={cn(
        'flex items-start gap-2 text-xs',
        notice.level === 'error'
          ? 'text-destructive'
          : notice.level === 'warn'
            ? 'text-brass'
            : 'text-muted-foreground',
      )}
    >
      <Icon className="mt-px size-3.5 shrink-0" />
      <span className="whitespace-pre-wrap">{notice.text}</span>
    </div>
  );
}
