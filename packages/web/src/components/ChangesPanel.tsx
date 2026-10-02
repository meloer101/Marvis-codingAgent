import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, GitBranch, Loader2, RefreshCw } from 'lucide-react';

import type { GitDiff, GitFile } from '@harness-code/protocol';

import { DiffView } from '@/components/DiffView';
import { parsePatch } from '@/lib/diff';
import { langForPath } from '@/lib/highlight';
import { useAppStore } from '@/lib/store';
import { useSync } from '@/lib/syncContext';
import { cn } from '@/lib/utils';

/**
 * The project's changes against HEAD: the branch, then one row per changed
 * file that opens to its diff. Fresh whenever a session may have changed
 * files (`git_changed`), and on reconnect.
 */
export function ChangesPanel({ workspaceId }: { workspaceId: string }) {
  const sync = useSync();
  const status = useAppStore((s) => s.git[workspaceId]);
  useEffect(() => sync.watchGit(workspaceId), [sync, workspaceId]);

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
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2 text-xs text-muted-foreground">
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
        <span className="shrink-0">
          {status.files.length === 0 ? 'clean' : `${status.files.length} ${status.files.length === 1 ? 'file' : 'files'} changed`}
        </span>
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
      {status.files.length === 0 ? (
        <p className="px-6 py-16 text-center font-serif text-sm text-muted-foreground italic">No changes.</p>
      ) : (
        <ul>
          {status.files.map((f) => (
            <ChangedFile key={f.path} workspaceId={workspaceId} file={f} />
          ))}
        </ul>
      )}
    </div>
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

function ChangedFile({ workspaceId, file }: { workspaceId: string; file: GitFile }) {
  const [open, setOpen] = useState(false);
  const { letter, tone, label } = changeLetter(file);
  const slash = file.path.lastIndexOf('/');
  const name = file.path.slice(slash + 1);
  const dir = slash === -1 ? '' : file.path.slice(0, slash);
  const sides = [file.staged && `staged: ${file.staged}`, file.unstaged && `unstaged: ${file.unstaged}`].filter(Boolean).join(' · ');
  return (
    <li className="border-b">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
        className="flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-accent/60"
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
