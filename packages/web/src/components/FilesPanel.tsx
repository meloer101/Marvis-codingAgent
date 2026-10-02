import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ChevronRight, File, Folder, FolderOpen, Search, SquareArrowOutUpRight } from 'lucide-react';

import type { DirEntry, FileContent, FileMatch } from '@harness-code/protocol';

import { CopyButton } from '@/components/CopyButton';
import { DiffView } from '@/components/DiffView';
import { fileLines } from '@/lib/diff';
import { langForPath } from '@/lib/highlight';
import { openFile, useOpenedFile } from '@/lib/panel';
import { workspaceRelative } from '@/lib/sessionFiles';
import { useAppStore } from '@/lib/store';
import { useSync } from '@/lib/syncContext';
import { cn } from '@/lib/utils';

/**
 * The project's files: a tree, folder by folder, or what a search finds; a
 * file opens in a viewer here (line numbers, syntax colours) that also opens
 * it in an editor on this machine. What `.gitignore` leaves out and secrets
 * aren't listed.
 */
export function FilesPanel({ workspaceId }: { workspaceId: string }) {
  const opened = useOpenedFile();
  return opened ? (
    <FileViewer workspaceId={workspaceId} path={opened.path} line={opened.line} />
  ) : (
    <FileBrowser workspaceId={workspaceId} />
  );
}

function FileBrowser({ workspaceId }: { workspaceId: string }) {
  const sync = useSync();
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<FileMatch[] | null>(null);
  useEffect(() => {
    const q = query.trim();
    if (q === '') {
      setMatches(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      void sync.searchFiles(workspaceId, q).then((m) => !cancelled && setMatches(m));
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [sync, workspaceId, query]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
        <Search className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find a file"
          aria-label="Find a file"
          className="min-w-0 flex-1 bg-transparent py-1 text-xs outline-none placeholder:text-muted-foreground"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {matches ? (
          matches.length === 0 ? (
            <p className="px-6 py-10 text-center font-serif text-sm text-muted-foreground italic">No file matches.</p>
          ) : (
            <ul>
              {matches.map((m) => (
                <li key={m.path}>
                  <FileRow path={m.path} label={m.path} depth={0} />
                </li>
              ))}
            </ul>
          )
        ) : (
          <FolderEntries workspaceId={workspaceId} dir="" depth={0} />
        )}
      </div>
    </div>
  );
}

/** A folder's entries, loaded when shown and again when the project's files change. */
function FolderEntries({ workspaceId, dir, depth }: { workspaceId: string; dir: string; depth: number }) {
  const sync = useSync();
  const rev = useAppStore((s) => s.gitRev[workspaceId] ?? 0);
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    void sync.listDir(workspaceId, dir).then((e) => !cancelled && setEntries(e));
    return () => {
      cancelled = true;
    };
  }, [sync, workspaceId, dir, rev]);
  if (!entries) return depth === 0 ? <p className="px-4 py-2 text-xs text-muted-foreground">Loading…</p> : null;
  if (entries.length === 0 && depth === 0) {
    return <p className="px-6 py-10 text-center font-serif text-sm text-muted-foreground italic">No files.</p>;
  }
  return (
    <ul>
      {entries.map((e) => {
        const path = dir ? `${dir}/${e.name}` : e.name;
        return (
          <li key={e.name}>
            {e.dir ? (
              <FolderRow workspaceId={workspaceId} path={path} name={e.name} depth={depth} />
            ) : (
              <FileRow path={path} label={e.name} depth={depth} />
            )}
          </li>
        );
      })}
    </ul>
  );
}

function FolderRow({ workspaceId, path, name, depth }: { workspaceId: string; path: string; name: string; depth: number }) {
  const [open, setOpen] = useState(false);
  const Icon = open ? FolderOpen : Folder;
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        style={{ paddingLeft: 12 + depth * 14 }}
        className="flex w-full items-center gap-1.5 py-1 pr-3 text-left text-xs transition-colors hover:bg-accent/60"
      >
        <ChevronRight className={cn('size-3 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
        <Icon className="size-3.5 shrink-0 text-brass" />
        <span className="truncate">{name}</span>
      </button>
      {open && <FolderEntries workspaceId={workspaceId} dir={path} depth={depth + 1} />}
    </>
  );
}

function FileRow({ path, label, depth }: { path: string; label: string; depth: number }) {
  return (
    <button
      type="button"
      onClick={() => openFile(path)}
      title={path}
      style={{ paddingLeft: 12 + depth * 14 + 15 }}
      className="flex w-full items-center gap-1.5 py-1 pr-3 text-left font-mono text-[11px] transition-colors hover:bg-accent/60"
    >
      <File className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{label}</span>
    </button>
  );
}

/**
 * One file, read fresh when opened and when the project's files change. A
 * path from a tool call may be absolute: it is made relative to the project.
 */
function FileViewer({ workspaceId, path: given, line }: { workspaceId: string; path: string; line?: number | undefined }) {
  const sync = useSync();
  const root = useAppStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.root);
  const path = root ? workspaceRelative(given, root) : given;
  const rev = useAppStore((s) => s.gitRev[workspaceId] ?? 0);
  const editors = useAppStore((s) => s.info?.editors ?? []);
  const [state, setState] = useState<{ file: FileContent } | { error: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    sync.readFile(workspaceId, path).then(
      (file) => !cancelled && setState({ file }),
      (err: unknown) => !cancelled && setState({ error: err instanceof Error ? err.message : String(err) }),
    );
    return () => {
      cancelled = true;
    };
  }, [sync, workspaceId, path, rev]);
  const lines = useMemo(() => (state && 'file' in state && state.file.kind === 'text' ? fileLines(state.file.content) : null), [state]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
        <button
          type="button"
          onClick={() => openFile(null)}
          aria-label="Back to the files"
          title="Back to the files"
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
        </button>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={path}>
          {path}
        </span>
        <CopyButton text={path} label="Copy path" />
        {editors.map((e) => (
          <button
            key={e.id}
            type="button"
            onClick={() => void sync.openInEditor(workspaceId, path, e.id, line)}
            title={`Open in ${e.name}${line ? ` at line ${line}` : ''}`}
            className="flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <SquareArrowOutUpRight className="size-3" />
            {e.name}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!state ? (
          <p className="px-4 py-3 text-xs text-muted-foreground">Reading…</p>
        ) : 'error' in state ? (
          <p className="px-4 py-3 text-xs text-destructive">{state.error}</p>
        ) : state.file.kind === 'binary' ? (
          <p className="px-4 py-3 text-xs text-muted-foreground">A binary file — nothing to show as text.</p>
        ) : state.file.kind === 'withheld' ? (
          <p className="px-4 py-3 text-xs text-muted-foreground">{state.file.reason}</p>
        ) : lines && lines.lines.length > 0 ? (
          <DiffView diff={lines} lang={langForPath(path) ?? undefined} focusLine={line} className="max-h-none" />
        ) : (
          <p className="px-4 py-3 text-xs text-muted-foreground">An empty file.</p>
        )}
      </div>
    </div>
  );
}
