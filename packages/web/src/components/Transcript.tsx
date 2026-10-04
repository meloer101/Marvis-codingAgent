import { createContext, memo, useContext, useMemo, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  Check,
  ChevronRight,
  Circle,
  FileText,
  GitFork,
  Info,
  LoaderCircle,
  Pencil,
  RefreshCw,
  RotateCcw,
  X,
} from 'lucide-react';

import type { ImageInput, Notice } from '@harness-code/core';
import { describeToolInput } from '@harness-code/core/browser';
import type { Entry, ToolItem } from '@harness-code/protocol';

import { CopyButton } from '@/components/CopyButton';
import { ImageThumbs } from '@/components/ImageThumbs';
import { Markdown } from '@/components/Markdown';
import { toolView } from '@/components/tools/registry';
import { Button } from '@/components/ui/button';
import { useStickToBottom } from '@/hooks/useStickToBottom';
import {
  briefNotice,
  exploreSummary,
  lastUserMessage,
  transcriptRows,
  turnParts,
  turnText,
  userMessageData,
  withLive,
} from '@/lib/rows';
import type { Part, Step, UserMessageData } from '@/lib/rows';
import type { SessionViewState } from '@/lib/sessionModel';
import { cn } from '@/lib/utils';
import { useVerbose } from '@/lib/verbose';

/**
 * What can be done with a user message, counted from 0 as the transcript shows
 * them (`userMessage`): taken back to change (`onEdit` — `later` says the
 * conversation goes on after it), forked into a new session from before it,
 * or sent again in place of what followed (`onRegenerate`).
 */
export interface MessageActions {
  onEdit: (userMessage: number, message: UserMessageData, later: boolean) => void;
  onFork: (userMessage: number, message: UserMessageData) => void;
  onRegenerate: (userMessage: number, message: UserMessageData) => void;
}

const ActionsContext = createContext<{ actions: MessageActions; running: boolean } | null>(null);

/**
 * With `actions`, user messages can be edited (the conversation taken back to
 * them) and forked, and the last one sent again: Retry after a run that
 * failed or was stopped, Regenerate after one that answered.
 */
export function Transcript({ view, actions }: { view: SessionViewState; actions?: MessageActions }) {
  const { entries, live, running } = view;
  const { ref, onScroll, atBottom, scrollToBottom } = useStickToBottom<HTMLDivElement>(
    `${entries.length}:${live.text.length}:${live.thinking.length}:${live.tools.length}:${running}`,
  );
  const verbose = useVerbose();
  const liveEmpty = live.text === '' && live.thinking === '' && live.tools.length === 0;
  const committed = useMemo(() => transcriptRows(entries), [entries]);
  const rows = useMemo(() => withLive(committed, live, entries.length), [committed, live, entries.length]);
  const conversationEmpty = committed.every((r) => r.kind === 'details');
  const last = useMemo(() => (actions ? lastUserMessage(entries, running) : null), [entries, running, actions]);
  // Which user message each user entry is, and whether anything follows it.
  const ordinals = useMemo(() => {
    const out = new Map<number, { userMessage: number; later: boolean }>();
    let n = 0;
    entries.forEach((e, i) => {
      if (e.kind === 'user') out.set(e.id, { userMessage: n++, later: i < entries.length - 1 });
    });
    return out;
  }, [entries]);
  const context = useMemo(() => (actions ? { actions, running } : null), [actions, running]);
  // The reply that can be had again sits under the last turn, beside its copy button.
  const regenerate = last && actions && last.answered && !last.failed ? last : null;
  const lastTurnKey = useMemo(() => rows.findLast((r) => r.kind === 'turn')?.key, [rows]);

  return (
    <ActionsContext.Provider value={context}>
    <div className="relative min-h-0 flex-1">
      <div ref={ref} onScroll={onScroll} className="h-full overflow-y-auto">
        <div className="mx-auto flex max-w-[700px] flex-col gap-5 px-5 pt-8 pb-4">
          {rows.map((row) =>
            row.kind === 'entry' ? (
              <EntryRow key={row.key} entry={row.entry} ordinal={row.entry.kind === 'user' ? ordinals.get(row.entry.id) : undefined} />
            ) : row.kind === 'turn' ? (
              <TurnRow
                key={row.key}
                steps={row.steps}
                verbose={verbose}
                regenerate={row.key === lastTurnKey ? regenerate : null}
              />
            ) : (
              <SessionDetails key={row.key} notices={row.notices} />
            ),
          )}
          {conversationEmpty && liveEmpty && !running && (
            <p className="py-16 text-center text-[13px] text-muted-foreground">
              Send a message to start.
            </p>
          )}
          {last && actions && (last.failed || !last.answered) && (
            <div className="flex animate-rise items-center gap-2">
              <Button size="sm" variant="secondary" onClick={() => actions.onRegenerate(last.userMessage, last)}>
                <RotateCcw />
                Retry
              </Button>
              <span className="text-xs text-faint">Sends your last message again, in place of the failed attempt.</span>
            </div>
          )}
          {running && liveEmpty && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <LoaderCircle className="size-3 animate-spin text-primary" />
              <span>Working…</span>
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
    </ActionsContext.Provider>
  );
}

const ROW_STYLE = { contentVisibility: 'auto', containIntrinsicSize: 'auto 80px' } as const;

/** Committed rows never change identity, so memo skips them while the live region streams. */
const EntryRow = memo(function EntryRow({
  entry,
  ordinal,
}: {
  entry: Entry;
  ordinal?: { userMessage: number; later: boolean } | undefined;
}) {
  return (
    <div className="animate-rise" style={ROW_STYLE}>
      {entry.kind === 'user' ? (
        <UserMessage
          text={entry.text}
          {...(entry.attachments ? { attachments: entry.attachments } : {})}
          {...(entry.images ? { images: entry.images } : {})}
          actions={ordinal && <UserMessageActions entry={entry} {...ordinal} />}
        />
      ) : entry.kind === 'notice' ? (
        <NoticeRow notice={entry.notice} />
      ) : null}
    </div>
  );
});

/**
 * One assistant turn: its steps' thinking, text and tool calls, with runs of
 * exploration calls folded into a line unless `verbose`. Only the turn that is
 * streaming gets new steps, so the others skip re-rendering; parts keep their
 * keys when the streaming step commits, so a card opened mid-run stays open.
 */
const TurnRow = memo(
  function TurnRow({
    steps,
    verbose,
    regenerate,
  }: {
    steps: readonly Step[];
    verbose: boolean;
    /** The last turn, once it answered: the message to send again in its place. */
    regenerate: RegenerateTarget | null;
  }) {
    const ctx = useContext(ActionsContext);
    const parts = useMemo(() => turnParts(steps, verbose), [steps, verbose]);
    const streaming = steps.some((s) => s.streaming);
    const reply = useMemo(() => (streaming ? '' : turnText(steps)), [steps, streaming]);
    return (
      <div className="group/turn flex flex-col gap-3 text-sm leading-[1.57]" style={ROW_STYLE}>
        {parts.map((part) => (
          <div key={part.key} className="animate-rise">
            <PartView part={part} />
          </div>
        ))}
        {(reply || regenerate) && (
          <div
            className={cn(
              '-ml-1 flex h-5 items-center gap-2 text-faint transition-opacity',
              // Under older turns the copy button waits for the pointer.
              !regenerate && 'opacity-0 group-hover/turn:opacity-100 focus-within:opacity-100',
            )}
          >
            {reply && <CopyButton text={reply} label="Copy reply" />}
            {regenerate && ctx && (
              <button
                type="button"
                onClick={() => ctx.actions.onRegenerate(regenerate.userMessage, regenerate)}
                title="Send your last message again, in place of this reply"
                className="flex items-center gap-1 rounded-md px-1 py-0.5 text-xs text-faint transition-colors hover:bg-muted hover:text-foreground"
              >
                <RotateCcw className="size-[13px]" />
                Regenerate
              </button>
            )}
          </div>
        )}
      </div>
    );
  },
  (a, b) =>
    a.verbose === b.verbose &&
    a.regenerate === b.regenerate &&
    a.steps.length === b.steps.length &&
    a.steps.every((s, i) => s === b.steps[i]),
);

type RegenerateTarget = NonNullable<ReturnType<typeof lastUserMessage>>;

function PartView({ part }: { part: Part }) {
  switch (part.kind) {
    case 'thinking':
      return <Thinking text={part.text} active={part.active} />;
    case 'text':
      return (
        <div className={cn(part.streaming && 'md-streaming')}>
          <Markdown text={part.text} streaming={part.streaming} />
        </div>
      );
    case 'tool':
      return <ToolCard tool={part.tool} />;
    case 'explore':
      return <ExploreGroup parts={part.parts} />;
  }
}

/** Edit and fork a user message, beside its copy button — not while a run goes. */
function UserMessageActions({
  entry,
  userMessage,
  later,
}: {
  entry: Extract<Entry, { kind: 'user' }>;
  userMessage: number;
  later: boolean;
}) {
  const ctx = useContext(ActionsContext);
  if (!ctx || ctx.running) return null;
  const message = userMessageData(entry);
  const button = 'rounded-md p-1 text-faint transition-colors hover:bg-background hover:text-foreground';
  return (
    <>
      <button
        type="button"
        onClick={() => ctx.actions.onEdit(userMessage, message, later)}
        aria-label="Edit message"
        title="Edit — take the conversation back to here"
        className={button}
      >
        <Pencil className="size-3.5" />
      </button>
      <button
        type="button"
        onClick={() => ctx.actions.onFork(userMessage, message)}
        aria-label="Fork from here"
        title="Fork — a new session with the conversation up to here"
        className={button}
      >
        <GitFork className="size-3.5" />
      </button>
    </>
  );
}

export function UserMessage({
  text,
  attachments,
  images,
  actions,
}: {
  text: string;
  attachments?: readonly string[];
  images?: readonly ImageInput[];
  /** More buttons for its top-right corner (edit, fork), shown on hover with copy. */
  actions?: ReactNode;
}) {
  return (
    <div className="group/user relative flex flex-col gap-2 rounded-lg bg-muted px-3.5 py-2.5 text-sm leading-[1.57]">
      {images && images.length > 0 && <ImageThumbs images={images} />}
      {text && <div className="pr-16 whitespace-pre-wrap">{text}</div>}
      <div className="absolute top-1.5 right-1.5 flex items-center gap-0.5 opacity-0 group-hover/user:opacity-100 focus-within:opacity-100">
        {actions}
        {text && <CopyButton text={text} label="Copy message" />}
      </div>
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
          className="flex max-w-72 items-center gap-1 rounded-md bg-background/70 py-0.5 pr-1.5 pl-1.5 font-mono text-[11px] text-muted-foreground"
        >
          <FileText className="size-3 shrink-0" />
          <span className="truncate">{p}</span>
          {onRemove && (
            <button
              type="button"
              onClick={() => onRemove(p)}
              aria-label={`Detach ${p}`}
              className="-mr-0.5 rounded p-0.5 transition-colors hover:bg-muted hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

function Thinking({ text, active }: { text: string; active: boolean }) {
  return (
    <details className="group text-faint">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs transition-colors select-none hover:text-muted-foreground">
        <ChevronRight className="size-3 transition-transform group-open:rotate-90" />
        {active ? 'Thinking…' : 'Thinking'}
      </summary>
      <div className="mt-1.5 border-l-2 pl-3 text-[13px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
        {text}
      </div>
    </details>
  );
}

/** A sub-agent's calls inside its `task` card, lookups folded as in a turn. */
function CallList({ tools }: { tools: ToolItem[] }) {
  const verbose = useVerbose();
  const parts = useMemo(() => turnParts([{ id: 0, thinking: '', text: '', tools }], verbose), [tools, verbose]);
  return (
    <div className="flex flex-col gap-1.5">
      {parts.map((part) => (
        <PartView key={part.key} part={part} />
      ))}
    </div>
  );
}

const renderCalls = (tools: ToolItem[]): ReactNode => <CallList tools={tools} />;

const ToolCard = memo(function ToolCard({ tool }: { tool: ToolItem }) {
  const isError = tool.result?.isError === true;
  const view = toolView(tool, renderCalls);
  // Follow the renderer's default (errors open, small diffs open…) until the
  // user toggles — including defaults that change after mount, like an error
  // result arriving.
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = (toggled ?? view.defaultOpen) && view.body !== null;

  return (
    <div className={cn('group/card relative overflow-hidden rounded-lg bg-subtle text-xs', isError && 'border border-destructive/40')}>
      <button
        type="button"
        className="group/head flex h-8 w-full items-center gap-2 px-2.5 text-left font-mono"
        onClick={() => setToggled(!open)}
        disabled={view.body === null}
        aria-expanded={view.body === null ? undefined : open}
      >
        {tool.running ? (
          <LoaderCircle className="size-3 shrink-0 animate-spin text-primary" />
        ) : !tool.result ? (
          // Not run (yet): e.g. restored from a snapshot while its ask is pending.
          <Circle className="size-3 shrink-0 text-faint" />
        ) : isError ? (
          <X className="size-3 shrink-0 text-destructive" />
        ) : (
          <Check className="size-3 shrink-0 text-success" />
        )}
        <span className="shrink-0 font-medium">{tool.name}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{view.summary}</span>
        {view.meta}
        {view.body !== null && (
          <ChevronRight
            className={cn(
              'size-3 shrink-0 text-faint opacity-0 transition group-hover/head:opacity-100',
              open && 'rotate-90',
            )}
          />
        )}
      </button>
      {open && <div>{view.body}</div>}
    </div>
  );
});

/**
 * A run of exploration calls as one quiet line — "Read 3 files, searched for 2
 * patterns" — that opens to the calls themselves (and the thinking between
 * them). While one runs, the line names what it is looking at.
 */
const ExploreGroup = memo(
  function ExploreGroup({ parts }: { parts: Extract<Part, { kind: 'explore' }>['parts'] }) {
    const [open, setOpen] = useState(false);
    const tools = parts.flatMap((p) => (p.kind === 'tool' ? [p.tool] : []));
    const current = tools.findLast((t) => t.running);
    const failed = tools.filter((t) => t.result?.isError).length;
    return (
      <div className="text-xs">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex w-full min-w-0 items-center gap-1.5 py-0.5 text-left text-faint transition-colors hover:text-muted-foreground"
        >
          <ChevronRight className={cn('size-3 shrink-0 transition-transform', open && 'rotate-90')} />
          {current && <LoaderCircle className="size-3 shrink-0 animate-spin text-primary" />}
          <span className="shrink-0">{exploreSummary(tools)}</span>
          {current && (
            <span className="min-w-0 truncate font-mono text-[11px] opacity-80">
              {describeToolInput(current.name, current.input)}
            </span>
          )}
          {failed > 0 && <span className="shrink-0 text-destructive">· {failed} failed</span>}
        </button>
        {open && (
          <div className="mt-2 ml-1.5 flex flex-col gap-2 border-l pl-3">
            {parts.map((p) =>
              p.kind === 'tool' ? (
                <ToolCard key={p.key} tool={p.tool} />
              ) : (
                <Thinking key={p.key} text={p.text} active={p.active} />
              ),
            )}
          </div>
        )}
      </div>
    );
  },
  (a, b) =>
    a.parts.length === b.parts.length &&
    a.parts.every((p, i) => {
      const q = b.parts[i]!;
      return p.kind === 'tool' ? q.kind === 'tool' && q.tool === p.tool : q.kind === 'thinking' && q.text === p.text && q.active === p.active;
    }),
);

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
        worst === 'error' ? 'text-destructive' : worst === 'warn' ? 'text-warning' : 'text-faint',
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
      <div className="flex items-center gap-3 py-1 text-[11px] font-medium tracking-[0.02em] text-faint">
        <span className="h-px flex-1 bg-border" />
        {notice.text}
        <span className="h-px flex-1 bg-border" />
      </div>
    );
  }
  // Skills, sub-agents or MCP servers taken up mid-session.
  const Icon = notice.level !== 'info' ? AlertTriangle : notice.kind === 'capabilities' ? RefreshCw : Info;
  return (
    <div
      className={cn(
        'flex items-start gap-2 text-xs',
        notice.level === 'error'
          ? 'text-destructive'
          : notice.level === 'warn'
            ? 'text-warning'
            : 'text-muted-foreground',
      )}
    >
      <Icon className="mt-px size-3.5 shrink-0" />
      <span className="whitespace-pre-wrap">{notice.text}</span>
    </div>
  );
}
