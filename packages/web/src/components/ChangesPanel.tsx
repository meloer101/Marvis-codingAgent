import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, FileSearch, GitBranch, Loader2, RefreshCw, Square, SquareCheck, SquareMinus, Undo2 } from 'lucide-react';

import type { GitDiff, GitFile } from '@harness-code/protocol';

import { CommitBox } from '@/components/CommitBox';
import { DiffView } from '@/components/DiffView';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { parsePatch } from '@/lib/diff';
import { isNewFile, pathsOf } from '@/lib/gitFiles';
import { langForPath } from '@/lib/highlight';
import { openFile } from '@/lib/panel';
import { useAppStore } from '@/lib/store';
import { useSync } from '@/lib/syncContext';
import { cn } from '@/lib/utils';

/**
 * The project's changes against HEAD: the branch, then one row per changed
 * file that opens to its diff — all of them, or only those this session's
 * edits and writes touched (`sessionPaths`) — each to stage or throw away,
 * and a footer to commit, push and open a pull request. Fresh whenever a
 * session may have changed files (`git_changed`), and on reconnect.
 */
export function ChangesPanel({ workspaceId, sessionPaths }: { workspaceId: string; sessionPaths?: ReadonlySet<string> }) {
  const sync = useSync();
  const status = useAppStore((s) => s.git[workspaceId]);
  const [scope, setScope] = useState<'all' | 'session'>('all');
  const [reverting, setReverting] = useState<GitFile | null>(null);
  useEffect(() => sync.watchGit(workspaceId), [sync, workspaceId]);
  const mine = useMemo(
    () =>
      status?.repo && sessionPaths
        ? status.files.filter((f) => sessionPaths.has(f.path) || (f.oldPath !== undefined && sessionPaths.has(f.oldPath)))
        : [],
    [status, sessionPaths],
  );

  if (!status) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        Reading git…
      </div>
    );
  }
  if (!status.repo) {
    return <p className="px-6 py-16 text-center font-serif text-sm text-muted-foreground italic">Not a git repository.</p>;
  }
  const files = scope === 'session' ? mine : status.files;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2 text-xs text-muted-foreground">
        <GitBranch className="size-3.5 shrink-0" />
        <span className="truncate font-mono text-foreground" title={status.upstream ? `tracking ${status.upstream}` : undefined}>
          {status.branch ?? 'detached HEAD'}
        </span>
        {(status.ahead > 0 || status.behind > 0) && (
          <span className="shrink-0 font-mono text-[10px] tabular-nums" title="Commits ahead of / behind its upstream">
            {status.ahead > 0 && `↑${status.ahead}`}
            {status.ahead > 0 && status.behind > 0 && ' '}
            {status.behind > 0 && `↓${status.behind}`}
          </span>
        )}
        <span className="flex-1" />
        {sessionPaths ? (
          <div role="radiogroup" aria-label="Which changes" className="flex shrink-0 rounded-md border p-0.5">
            <ScopeButton on={scope === 'all'} onClick={() => setScope('all')} label="All" count={status.files.length} />
            <ScopeButton
              on={scope === 'session'}
              onClick={() => setScope('session')}
              label="This session"
              count={mine.length}
              title="Files this session's edits and writes changed (not what its commands did)"
            />
          </div>
        ) : (
          <span className="shrink-0">{status.files.length === 0 ? 'clean' : `${status.files.length} changed`}</span>
        )}
        <button
          type="button"
          onClick={() => void sync.loadGitStatus(workspaceId)}
          aria-label="Refresh"
          title="Refresh"
          className="rounded p-1 transition-colors hover:bg-accent hover:text-foreground"
        >
          <RefreshCw className="size-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {files.length === 0 ? (
          <p className="px-6 py-16 text-center font-serif text-sm text-muted-foreground italic">
            {scope === 'session' && status.files.length > 0 ? 'This session has not edited any of these files.' : 'No changes.'}
          </p>
        ) : (
          <ul>
            {files.map((f) => (
              <ChangedFile
                key={f.path}
                workspaceId={workspaceId}
                file={f}
                onStage={(stage) =>
                  void (stage ? sync.gitStage(workspaceId, pathsOf(f)) : sync.gitUnstage(workspaceId, pathsOf(f)))
                }
                onRevert={() => setReverting(f)}
              />
            ))}
          </ul>
        )}
      </div>
      <CommitBox workspaceId={workspaceId} status={status} files={files} />
      <RevertDialog
        file={reverting}
        onClose={() => setReverting(null)}
        onConfirm={(f) => {
          setReverting(null);
          void sync.gitRevert(workspaceId, pathsOf(f));
        }}
      />
    </div>
  );
}

function RevertDialog({
  file,
  onClose,
  onConfirm,
}: {
  file: GitFile | null;
  onClose: () => void;
  onConfirm: (file: GitFile) => void;
}) {
  return (
    <Dialog open={file !== null} onOpenChange={(open) => !open && onClose()}>
      {file && (
        <DialogContent
          title="Discard these changes?"
          description={
            isNewFile(file)
              ? 'The last commit doesn’t have this file, so it is deleted. This can’t be undone.'
              : 'The file goes back to how the last commit has it, staged and unstaged changes alike. This can’t be undone.'
          }
        >
          <div className="flex flex-col gap-4 px-5 pt-3 pb-5">
            <p className="truncate rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs">
              {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Button variant="destructive" size="sm" onClick={() => onConfirm(file)}>
                {isNewFile(file) ? 'Delete file' : 'Discard'}
              </Button>
            </div>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}

function ScopeButton({
  on,
  onClick,
  label,
  count,
  title,
}: {
  on: boolean;
  onClick: () => void;
  label: string;
  count: number;
  title?: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={onClick}
      title={title}
      className={cn(
        'rounded px-1.5 py-0.5 text-[11px] transition-colors',
        on ? 'bg-accent font-medium text-foreground' : 'hover:text-foreground',
      )}
    >
      {label} <span className="font-mono text-[10px] tabular-nums opacity-70">{count}</span>
    </button>
  );
}

/** One letter for a file's change, the most telling of its two sides. */
export function changeLetter(file: GitFile): { letter: string; tone: string; label: string } {
  const sides = [file.staged, file.unstaged];
  if (sides.includes('conflicted')) return { letter: '!', tone: 'text-destructive', label: 'conflicted' };
  if (file.unstaged === 'untracked') return { letter: 'U', tone: 'text-success', label: 'untracked' };
  if (sides.includes('deleted')) return { letter: 'D', tone: 'text-destructive', label: 'deleted' };
  if (sides.includes('added')) return { letter: 'A', tone: 'text-success', label: 'added' };
  if (sides.includes('renamed') || sides.includes('copied')) return { letter: 'R', tone: 'text-primary', label: 'renamed' };
  return { letter: 'M', tone: 'text-brass', label: 'modified' };
}

function ChangedFile({
  workspaceId,
  file,
  onStage,
  onRevert,
}: {
  workspaceId: string;
  file: GitFile;
  onStage: (stage: boolean) => void;
  onRevert: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { letter, tone, label } = changeLetter(file);
  const slash = file.path.lastIndexOf('/');
  const name = file.path.slice(slash + 1);
  const dir = slash === -1 ? '' : file.path.slice(0, slash);
  const sides = [file.staged && `staged: ${file.staged}`, file.unstaged && `unstaged: ${file.unstaged}`].filter(Boolean).join(' · ');
  // Fully staged, partly (staged with more changes since), or not at all.
  const staged = file.staged !== undefined && file.staged !== 'conflicted';
  const partly = staged && file.unstaged !== undefined;
  const StageIcon = !staged ? Square : partly ? SquareMinus : SquareCheck;
  return (
    <li className="group border-b">
      <div className="flex min-w-0 items-center transition-colors hover:bg-accent/60">
        <button
          type="button"
          role="checkbox"
          aria-checked={!staged ? false : partly ? 'mixed' : true}
          aria-label={`Stage ${file.path}`}
          title={!staged ? 'Stage' : partly ? 'Partly staged — stage the rest' : 'Unstage'}
          onClick={() => onStage(!staged || partly)}
          className={cn(
            'shrink-0 py-1.5 pr-1 pl-2.5 transition-colors hover:text-foreground',
            staged ? 'text-primary' : 'text-muted-foreground/70',
          )}
        >
          <StageIcon className="size-3.5" />
        </button>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
          className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-1 pl-1 text-left text-xs"
        >
          <ChevronRight className={cn('size-3 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
          <span className={cn('w-3 shrink-0 text-center font-mono text-[11px] font-semibold', tone)} title={sides || label} aria-label={label}>
            {letter}
          </span>
          <span className="min-w-0 truncate font-mono text-[11px]">
            {name}
            {dir && <span className="text-muted-foreground"> {dir}</span>}
          </span>
          <span className="flex-1" />
          <span className="shrink-0 font-mono text-[10px] tabular-nums">
            {file.binary ? (
              <span className="text-muted-foreground">binary</span>
            ) : (
              <>
                {(file.added ?? 0) > 0 && <span className="text-success">+{file.added}</span>}
                {(file.added ?? 0) > 0 && (file.removed ?? 0) > 0 && ' '}
                {(file.removed ?? 0) > 0 && <span className="text-destructive">−{file.removed}</span>}
              </>
            )}
          </span>
        </button>
        {!(file.staged === 'deleted' || file.unstaged === 'deleted') && (
          <button
            type="button"
            onClick={() => openFile(file.path)}
            aria-label={`Open ${file.path}`}
            title="Open the file"
            className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100"
          >
            <FileSearch className="size-3.5" />
          </button>
        )}
        <button
          type="button"
          onClick={onRevert}
          aria-label={`Discard changes to ${file.path}`}
          title="Discard changes"
          className="mr-1.5 shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-accent hover:text-destructive focus-visible:opacity-100"
        >
          <Undo2 className="size-3.5" />
        </button>
      </div>
      {open && <FileDiff workspaceId={workspaceId} path={file.path} />}
    </li>
  );
}

/** A file's diff, fetched when opened and again after each `git_changed`; the last one stays meanwhile. */
function FileDiff({ workspaceId, path }: { workspaceId: string; path: string }) {
  const sync = useSync();
  const rev = useAppStore((s) => s.gitRev[workspaceId] ?? 0);
  const [state, setState] = useState<{ diff: GitDiff } | { error: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    sync.gitDiff(workspaceId, path).then(
      (diff) => !cancelled && setState({ diff }),
      (err: unknown) => !cancelled && setState({ error: err instanceof Error ? err.message : String(err) }),
    );
    return () => {
      cancelled = true;
    };
  }, [sync, workspaceId, path, rev]);
  const lines = useMemo(
    () => (state && 'diff' in state && state.diff.kind === 'text' ? parsePatch(state.diff.patch) : null),
    [state],
  );

  if (!state) return <p className="px-9 py-2 text-xs text-muted-foreground">Loading diff…</p>;
  if ('error' in state) return <p className="px-9 py-2 text-xs text-destructive">{state.error}</p>;
  const { diff } = state;
  if (diff.kind === 'binary') return <p className="px-9 py-2 text-xs text-muted-foreground">Binary file — no text diff.</p>;
  if (diff.kind === 'withheld') return <p className="px-9 py-2 text-xs text-muted-foreground">{diff.reason}</p>;
  if (!lines || lines.lines.length === 0) {
    return <p className="px-9 py-2 text-xs text-muted-foreground">No content changes (mode or rename only).</p>;
  }
  return <DiffView diff={lines} lang={langForPath(path) ?? undefined} className="max-h-none border-t bg-muted/20" />;
}
