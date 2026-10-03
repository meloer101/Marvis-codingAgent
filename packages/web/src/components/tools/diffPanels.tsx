import { useMemo, type ReactNode } from 'react';

import type { ToolItem } from '@harness-code/protocol';

import { CodeBlock } from '@/components/CodeBlock';
import { DiffStat, DiffView } from '@/components/DiffView';
import { editDiff, replaceDiff, writeDiff } from '@/lib/diff';
import { langForPath } from '@/lib/highlight';

function ErrorOutput({ tool }: { tool: ToolItem }) {
  const content = tool.result?.content;
  if (!content || !tool.result?.isError) return null;
  return (
    <pre className="max-h-80 overflow-auto border-t px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-destructive">
      {content}
    </pre>
  );
}

export function EditDiffPanel({
  tool,
  path,
  oldString,
  newString,
}: {
  tool: ToolItem;
  path: string;
  oldString: string;
  newString: string;
}) {
  const startLine = tool.result?.display?.startLine;
  const diff = useMemo(() => editDiff(oldString, newString, startLine), [oldString, newString, startLine]);
  return (
    <>
      <DiffView diff={diff} lang={langForPath(path) ?? undefined} />
      <ErrorOutput tool={tool} />
    </>
  );
}

export function EditDiffMeta({ oldString, newString }: { oldString: string; newString: string }) {
  const diff = useMemo(() => editDiff(oldString, newString), [oldString, newString]);
  return <DiffStat diff={diff} />;
}

/** What a `write` did: against the file it replaced when that is known (`display.before`), else the whole file as new. */
function useWriteDiff(content: string, before: string | undefined) {
  return useMemo(() => (before !== undefined ? replaceDiff(before, content) : writeDiff(content)), [content, before]);
}

export function WriteDiffPanel({ tool, path, content }: { tool: ToolItem; path: string; content: string }) {
  const diff = useWriteDiff(content, tool.result?.display?.before);
  return (
    <>
      {diff.lines.length > 0 ? (
        <DiffView diff={diff} lang={langForPath(path) ?? undefined} />
      ) : (
        <p className="px-3 py-2 text-xs text-muted-foreground">Written as it was — nothing changed.</p>
      )}
      <ErrorOutput tool={tool} />
    </>
  );
}

export function WriteDiffMeta({ tool, content }: { tool: ToolItem; content: string }) {
  const diff = useWriteDiff(content, tool.result?.display?.before);
  return <DiffStat diff={diff} />;
}

export function EditPreviewPanel({
  path,
  oldString,
  newString,
  replaceAll,
}: {
  path: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}) {
  const diff = useMemo(() => editDiff(oldString, newString), [oldString, newString]);
  return (
    <div className="overflow-hidden rounded-md border bg-background">
      <div className="flex items-center gap-2 border-b px-3 py-1.5 font-mono text-xs">
        <span className="min-w-0 flex-1 truncate">{path}</span>
        {replaceAll === true && <span className="text-[10px] text-muted-foreground">replace all</span>}
        <DiffStat diff={diff} />
      </div>
      <DiffView diff={diff} lang={langForPath(path) ?? undefined} className="max-h-64" />
    </div>
  );
}

/** A `write` waiting on approval: what it would change in the file it replaces (`before`), else the new file. */
export function WritePreviewPanel({ path, content, before }: { path: string; content: string; before?: string | undefined }) {
  const diff = useWriteDiff(content, before);
  return (
    <div className="overflow-hidden rounded-md border bg-background">
      <div className="flex items-center gap-2 border-b px-3 py-1.5 font-mono text-xs">
        <span className="min-w-0 flex-1 truncate">{path}</span>
        {before !== undefined && <span className="text-[10px] text-muted-foreground">replaces the file</span>}
        <DiffStat diff={diff} />
      </div>
      {before !== undefined ? (
        <DiffView diff={diff} lang={langForPath(path) ?? undefined} className="max-h-64" />
      ) : (
        <CodeBlock
          code={content}
          lang={langForPath(path) ?? undefined}
          className="my-0 max-h-64 overflow-auto rounded-none border-0"
        />
      )}
    </div>
  );
}

export function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono">{children}</span>;
}
