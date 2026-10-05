/**
 * Per-tool rendering (opencode-style: a renderer per tool name, a generic
 * fallback for everything else — MCP tools included). Each renderer turns a
 * `ToolItem` into a header summary, optional header meta, and an expandable
 * body; `toolPreview` is the same idea for a call that hasn't run yet (the
 * permission dock), so an edit is reviewed as a diff, not a file path.
 */

import { Suspense, lazy, type ReactNode } from 'react';
import { FileSearch, Server } from 'lucide-react';

import { describeToolInput } from '@harness-code/core/browser';
import type { ToolItem } from '@harness-code/protocol';

import { Markdown } from '@/components/Markdown';
import { TodoList } from '@/components/TodoList';
import { TerminalOutput } from '@/components/tools/TerminalOutput';
import { bashOutcome, fmtDuration } from '@/lib/format';
import { parseTodos } from '@/lib/todos';
import { openFile, openProcess } from '@/lib/panel';
import { cn } from '@/lib/utils';

const EditDiffPanel = lazy(() =>
  import('@/components/tools/diffPanels').then((m) => ({ default: m.EditDiffPanel })),
);
const EditDiffMeta = lazy(() =>
  import('@/components/tools/diffPanels').then((m) => ({ default: m.EditDiffMeta })),
);
const WriteDiffPanel = lazy(() =>
  import('@/components/tools/diffPanels').then((m) => ({ default: m.WriteDiffPanel })),
);
const WriteDiffMeta = lazy(() =>
  import('@/components/tools/diffPanels').then((m) => ({ default: m.WriteDiffMeta })),
);
const EditPreviewPanel = lazy(() =>
  import('@/components/tools/diffPanels').then((m) => ({ default: m.EditPreviewPanel })),
);
const WritePreviewPanel = lazy(() =>
  import('@/components/tools/diffPanels').then((m) => ({ default: m.WritePreviewPanel })),
);

const diffFallback = <div className="px-3 py-2 text-xs text-muted-foreground">Loading diff…</div>;

export interface ToolView {
  /** Header text after the tool name. */
  summary: ReactNode;
  /** Right-aligned header extras (diff stat, counts). */
  meta?: ReactNode;
  /** Expanded content; null when there's nothing to expand. */
  body: ReactNode | null;
  defaultOpen: boolean;
}

type Rec = Record<string, unknown>;
const rec = (input: unknown): Rec => (input && typeof input === 'object' ? (input as Rec) : {});
const str = (r: Rec, k: string): string | undefined => (typeof r[k] === 'string' ? (r[k] as string) : undefined);
const num = (r: Rec, k: string): number | undefined => (typeof r[k] === 'number' ? (r[k] as number) : undefined);


function Output({ tool }: { tool: ToolItem }) {
  const content = tool.result?.content;
  if (!content) return null;
  return (
    <pre
      className={cn(
        'max-h-80 overflow-auto px-3 pt-2 pb-2.5 font-mono text-xs leading-[1.55] whitespace-pre-wrap text-muted-foreground',
        tool.result?.isError && 'text-destructive',
      )}
    >
      {content}
    </pre>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono">{children}</span>;
}

/** Under a file tool's body: open the file in the side panel's viewer, at a line. */
function OpenFileBar({ path, line }: { path: string; line?: number | undefined }) {
  if (!path) return null;
  return (
    <div className="pointer-events-none absolute right-1.5 bottom-1.5 opacity-0 transition-opacity group-hover/card:pointer-events-auto group-hover/card:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100">
      <button
        type="button"
        onClick={() => openFile(path, line)}
        className="flex items-center gap-1 rounded-md bg-background px-1.5 py-0.5 text-[11px] text-muted-foreground shadow-xs transition-colors hover:text-foreground"
      >
        <FileSearch className="size-3" />
        Open file{line ? ` at line ${line}` : ''}
      </button>
    </div>
  );
}

/** Under a background command's card: its output in the side panel's Processes tab. */
function OpenProcessBar({ id }: { id: string }) {
  return (
    <div className="flex justify-end px-2 py-1">
      <button
        type="button"
        onClick={() => openProcess(id)}
        className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-faint transition-colors hover:bg-muted hover:text-foreground"
      >
        <Server className="size-3" />
        Show {id}’s output
      </button>
    </div>
  );
}

/** The id a background command was started as, from `bash`'s result. */
function backgroundId(content: string): string | undefined {
  return /^Started in the background as (bg\d+)/.exec(content)?.[1];
}

function Badge({ tone, children }: { tone: 'destructive' | 'primary'; children: ReactNode }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded px-1.5 font-mono text-[11px]',
        tone === 'destructive' && 'bg-destructive/10 text-destructive',
        tone === 'primary' && 'bg-primary/10 text-primary',
      )}
    >
      {children}
    </span>
  );
}

function Duration({ ms }: { ms: number }) {
  return <span className="shrink-0 font-mono text-[11px] text-faint tabular-nums">{fmtDuration(ms)}</span>;
}

/** Output only when it's an error — for tools whose body is something else. */
function ErrorOutput({ tool }: { tool: ToolItem }) {
  return tool.result?.isError ? (
    <div>
      <Output tool={tool} />
    </div>
  ) : null;
}

/** Renders calls nested in a call (a sub-agent's, in its `task` card) — supplied by the transcript. */
export type RenderCalls = (tools: ToolItem[]) => ReactNode;

type Renderer = (tool: ToolItem, input: Rec, renderCalls?: RenderCalls) => ToolView;

const renderers: Record<string, Renderer> = {
  bash: (tool, input) => {
    const summary = <Mono>{str(input, 'command') ?? ''}</Mono>;
    // Running: what it has printed so far, open and following the tail.
    if (!tool.result) {
      return {
        summary,
        body: tool.output ? <TerminalOutput text={tool.output} live /> : null,
        defaultOpen: tool.running,
      };
    }
    const started = input.run_in_background === true && !tool.result.isError ? backgroundId(tool.result.content) : undefined;
    if (started) {
      return {
        summary,
        meta: <Badge tone="primary">background · {started}</Badge>,
        body: <OpenProcessBar id={started} />,
        defaultOpen: false,
      };
    }
    const { output, exitCode, timedOut } = bashOutcome(tool.result.content);
    const failed = tool.result.isError === true;
    return {
      summary,
      meta: (
        <>
          {exitCode !== undefined && <Badge tone="destructive">exit {exitCode}</Badge>}
          {timedOut && <Badge tone="destructive">timed out</Badge>}
          {tool.durationMs !== undefined && <Duration ms={tool.durationMs} />}
        </>
      ),
      body: output && output !== '(no output)' ? <TerminalOutput text={output} error={failed && exitCode === undefined && !timedOut} /> : null,
      // Folded to the command once it's done, however short its output: a click opens it. A failed one opens.
      defaultOpen: failed,
    };
  },

  bash_output: (tool, input) => {
    const id = str(input, 'id') ?? '';
    const content = tool.result?.content ?? '';
    // "bg1 is running." and then what's new.
    const [status = '', ...rest] = content.split('\n');
    const output = rest.join('\n');
    return {
      summary: <Mono>{id}</Mono>,
      meta: tool.result && !tool.result.isError ? <span className="shrink-0 text-[11px] text-faint">{status.replace(/^bg\d+ /, '').replace(/\.$/, '')}</span> : undefined,
      body: tool.result?.isError ? <Output tool={tool} /> : output && output !== '(no new output)' ? <TerminalOutput text={output} /> : null,
      defaultOpen: false,
    };
  },

  bash_kill: (tool, input) => ({
    summary: <Mono>{str(input, 'id') ?? ''}</Mono>,
    meta: tool.result ? <span className="shrink-0 text-[11px] text-faint">{tool.result.content.replace(/^bg\d+ /, '').replace(/\.$/, '')}</span> : undefined,
    body: tool.result?.isError ? <Output tool={tool} /> : null,
    defaultOpen: false,
  }),

  edit: (tool, input) => {
    const oldString = str(input, 'oldString') ?? '';
    const newString = str(input, 'newString') ?? '';
    return {
      summary: <Mono>{str(input, 'path') ?? ''}</Mono>,
      meta: (
        <Suspense fallback={null}>
          <EditDiffMeta oldString={oldString} newString={newString} />
        </Suspense>
      ),
      body: (
        <>
          <Suspense fallback={diffFallback}>
            <EditDiffPanel tool={tool} path={str(input, 'path') ?? ''} oldString={oldString} newString={newString} />
          </Suspense>
          <OpenFileBar path={str(input, 'path') ?? ''} line={tool.result?.display?.startLine} />
        </>
      ),
      // Folded to its line and +/- count, whatever its size: the diff is a click away. A failed one opens.
      defaultOpen: tool.result?.isError === true,
    };
  },

  write: (tool, input) => {
    const content = str(input, 'content') ?? '';
    return {
      summary: <Mono>{str(input, 'path') ?? ''}</Mono>,
      meta: (
        <Suspense fallback={null}>
          <WriteDiffMeta tool={tool} content={content} />
        </Suspense>
      ),
      body: (
        <>
          <Suspense fallback={diffFallback}>
            <WriteDiffPanel tool={tool} path={str(input, 'path') ?? ''} content={content} />
          </Suspense>
          <OpenFileBar path={str(input, 'path') ?? ''} />
        </>
      ),
      defaultOpen: tool.result?.isError === true,
    };
  },

  read: (tool, input) => {
    const offset = num(input, 'offset');
    const limit = num(input, 'limit');
    const range = offset || limit ? `:${offset ?? 1}${limit ? `–${(offset ?? 1) + limit - 1}` : ''}` : '';
    return {
      summary: (
        <Mono>
          {str(input, 'path') ?? ''}
          {range}
        </Mono>
      ),
      body: tool.result?.content ? (
        <>
          <Output tool={tool} />
          {!tool.result.isError && <OpenFileBar path={str(input, 'path') ?? ''} line={offset} />}
        </>
      ) : null,
      defaultOpen: tool.result?.isError === true,
    };
  },

  grep: (tool, input) => {
    const where = [str(input, 'path'), str(input, 'glob')].filter(Boolean).join(' ');
    return {
      summary: (
        <>
          <Mono>/{str(input, 'pattern') ?? ''}/</Mono>
          {where && <span className="text-muted-foreground/70"> in {where}</span>}
        </>
      ),
      body: tool.result?.content ? <Output tool={tool} /> : null,
      defaultOpen: tool.result?.isError === true,
    };
  },

  glob: (tool, input) => ({
    summary: <Mono>{str(input, 'pattern') ?? ''}</Mono>,
    body: tool.result?.content ? <Output tool={tool} /> : null,
    defaultOpen: tool.result?.isError === true,
  }),

  // Folded: the task dock above the composer shows the list as it stands.
  todo: (tool) => {
    const todos = parseTodos(tool.input) ?? [];
    const done = todos.filter((t) => t.status === 'completed').length;
    return {
      summary: `${done}/${todos.length} done`,
      body: (
        <>
          <TodoList todos={todos} className="px-3 py-2" />
          <ErrorOutput tool={tool} />
        </>
      ),
      defaultOpen: tool.result?.isError === true,
    };
  },

  // The prompt, the sub-agent's calls as it makes them (open while it works),
  // then its report.
  task: (tool, input, renderCalls) => {
    const calls = tool.children ?? [];
    return {
      summary: str(input, 'description') ?? str(input, 'subagent_type') ?? 'sub-agent',
      meta: (
        <>
          {str(input, 'subagent_type') && (
            <span className="shrink-0 rounded bg-muted px-1.5 font-mono text-[11px] text-muted-foreground">
              {str(input, 'subagent_type')}
            </span>
          )}
          {calls.length > 0 && (
            <span className="shrink-0 font-mono text-[11px] text-faint tabular-nums">
              {calls.length} {calls.length === 1 ? 'call' : 'calls'}
            </span>
          )}
          {tool.durationMs !== undefined && <Duration ms={tool.durationMs} />}
        </>
      ),
      body: (
        <div className="space-y-2 px-3 py-2">
          <p className="text-[11px] whitespace-pre-wrap text-muted-foreground">{str(input, 'prompt')}</p>
          {calls.length > 0 && renderCalls && <div className="border-l pl-3">{renderCalls(calls)}</div>}
          {tool.result?.content &&
            (tool.result.isError ? <Output tool={tool} /> : <Markdown text={tool.result.content} className="text-xs" />)}
        </div>
      ),
      defaultOpen: tool.running && calls.length > 0,
    };
  },

  exit_plan_mode: (tool, input) => ({
    summary: str(input, 'title') ?? 'Plan',
    body: (
      <div className="px-3 py-2">
        <Markdown text={str(input, 'plan') ?? ''} className="text-xs" />
        {tool.result?.content && (
          <p className="mt-2 pt-1 text-[11px] text-faint">{tool.result.content}</p>
        )}
      </div>
    ),
    defaultOpen: false,
  }),
};

function genericView(tool: ToolItem): ToolView {
  return {
    summary: <Mono>{describeToolInput(tool.name, tool.input)}</Mono>,
    body: (
      <>
        <pre className="max-h-40 overflow-auto px-3 py-2 font-mono text-[11px] text-muted-foreground">
          {JSON.stringify(tool.input, null, 2)}
        </pre>
        {tool.result?.content && (
          <div>
            <Output tool={tool} />
          </div>
        )}
      </>
    ),
    defaultOpen: tool.result?.isError === true,
  };
}

export function toolView(tool: ToolItem, renderCalls?: RenderCalls): ToolView {
  const render = renderers[tool.name];
  return render ? render(tool, rec(tool.input), renderCalls) : genericView(tool);
}

/** What the permission dock shows for a call that hasn't run yet. */
export function toolPreview(toolName: string, input: unknown, opts: { before?: string | undefined } = {}): ReactNode {
  const r = rec(input);
  switch (toolName) {
    case 'edit':
      return (
        <Suspense fallback={diffFallback}>
          <EditPreviewPanel
            path={str(r, 'path') ?? ''}
            oldString={str(r, 'oldString') ?? ''}
            newString={str(r, 'newString') ?? ''}
            replaceAll={r['replaceAll'] === true}
          />
        </Suspense>
      );
    case 'write':
      return (
        <Suspense fallback={diffFallback}>
          <WritePreviewPanel path={str(r, 'path') ?? ''} content={str(r, 'content') ?? ''} before={opts.before} />
        </Suspense>
      );
    case 'bash':
      return (
        <pre className="max-h-40 overflow-auto rounded-md bg-background px-2.5 py-[7px] font-mono text-xs leading-[1.55] whitespace-pre-wrap">
          $ {str(r, 'command') ?? ''}
        </pre>
      );
    default: {
      const summary = describeToolInput(toolName, input);
      return summary ? (
        <pre className="max-h-40 overflow-auto rounded-md bg-background px-2.5 py-[7px] font-mono text-xs whitespace-pre-wrap">
          {summary}
        </pre>
      ) : null;
    }
  }
}
