/**
 * Per-tool rendering (opencode-style: a renderer per tool name, a generic
 * fallback for everything else — MCP tools included). Each renderer turns a
 * `ToolItem` into a header summary, optional header meta, and an expandable
 * body; `toolPreview` is the same idea for a call that hasn't run yet (the
 * permission dock), so an edit is reviewed as a diff, not a file path.
 */

import { Suspense, lazy, type ReactNode } from 'react';
import { FileSearch } from 'lucide-react';

import { describeToolInput } from '@harness-code/core/browser';
import type { ToolItem } from '@harness-code/protocol';

import { CodeBlock } from '@/components/CodeBlock';
import { Markdown } from '@/components/Markdown';
import { TodoList } from '@/components/TodoList';
import { TerminalOutput } from '@/components/tools/TerminalOutput';
import { bashOutcome, fmtDuration } from '@/lib/format';
import { parseTodos } from '@/lib/todos';
import { openFile } from '@/lib/panel';
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

/** Small diffs open by default; big ones stay folded (line-count heuristic, no `diff` import). */
const OPEN_DIFF_LINES = 40;

function roughLineCount(...parts: string[]): number {
  return parts.reduce((n, p) => n + p.split('\n').length, 0);
}

function Output({ tool }: { tool: ToolItem }) {
  const content = tool.result?.content;
  if (!content) return null;
  return (
    <pre
      className={cn(
        'max-h-80 overflow-auto px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap',
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
    <div className="flex justify-end border-t px-2 py-1">
      <button
        type="button"
        onClick={() => openFile(path, line)}
        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <FileSearch className="size-3" />
        Open file{line ? ` at line ${line}` : ''}
      </button>
    </div>
  );
}

function Badge({ tone, children }: { tone: 'destructive'; children: ReactNode }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded px-1.5 font-mono text-[10px]',
        tone === 'destructive' && 'bg-destructive/10 text-destructive',
      )}
    >
      {children}
    </span>
  );
}

function Duration({ ms }: { ms: number }) {
  return <span className="shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">{fmtDuration(ms)}</span>;
}

/** Output only when it's an error — for tools whose body is something else. */
function ErrorOutput({ tool }: { tool: ToolItem }) {
  return tool.result?.isError ? (
    <div className="border-t">
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
      defaultOpen: failed,
    };
  },

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
      defaultOpen:
        tool.result?.isError === true || roughLineCount(oldString, newString) <= OPEN_DIFF_LINES,
    };
  },

  write: (tool, input) => {
    const content = str(input, 'content') ?? '';
    return {
      summary: <Mono>{str(input, 'path') ?? ''}</Mono>,
      meta: (
        <Suspense fallback={null}>
          <WriteDiffMeta content={content} />
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
      defaultOpen: tool.result?.isError === true || roughLineCount(content) <= OPEN_DIFF_LINES,
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
            <span className="shrink-0 rounded bg-muted px-1.5 font-mono text-[10px] text-muted-foreground">
              {str(input, 'subagent_type')}
            </span>
          )}
          {calls.length > 0 && (
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">
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
          <p className="mt-2 border-t pt-2 text-[11px] text-muted-foreground">{tool.result.content}</p>
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
          <div className="border-t">
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
export function toolPreview(toolName: string, input: unknown): ReactNode {
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
          <WritePreviewPanel path={str(r, 'path') ?? ''} content={str(r, 'content') ?? ''} />
        </Suspense>
      );
    case 'bash':
      return <CodeBlock code={str(r, 'command') ?? ''} lang="bash" className="my-0" />;
    default: {
      const summary = describeToolInput(toolName, input);
      return summary ? (
        <pre className="max-h-40 overflow-auto rounded-md bg-muted/60 px-3 py-2 font-mono text-xs whitespace-pre-wrap">
          {summary}
        </pre>
      ) : null;
    }
  }
}
