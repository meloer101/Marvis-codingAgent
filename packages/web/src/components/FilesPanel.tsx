import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ChevronRight, File, Folder, FolderOpen, Search, SquareArrowOutUpRight } from 'lucide-react';

import type { DirEntry, FileContent, FileMatch } from '@harness-code/protocol';

import { CopyButton } from '@/components/CopyButton';
import { DiffView } from '@/components/DiffView';
import { checkoutKey } from '@/lib/checkout';
import type { Checkout } from '@/lib/checkout';
import { fileLines } from '@/lib/diff';
import { langForPath } from '@/lib/highlight';
import { openFile, useOpenedFile } from '@/lib/panel';
import { workspaceRelative } from '@/lib/sessionFiles';
import { useAppStore } from '@/lib/store';
import { useSync } from '@/lib/syncContext';
import { cn } from '@/lib/utils';

/**
 * A checkout's files — the project's, or a session's worktree: a tree, folder
 * by folder, or what a search finds; a file opens in a viewer here (line
 * numbers, syntax colours) that also opens it in an editor on this machine.
 * What `.gitignore` leaves out and secrets aren't listed.
 */
export function FilesPanel({ checkout }: { checkout: Checkout }) {
  const opened = useOpenedFile();
  return opened ? (
    <FileViewer checkout={checkout} path={opened.path} line={opened.line} />
  ) : (
    <FileBrowser checkout={checkout} />
  );
}

function FileBrowser({ checkout }: { checkout: Checkout }) {
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
      void sync.searchFiles(checkout, q).then((m) => !cancelled && setMatches(m));
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [sync, checkoutKey(checkout), query]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mx-3 mb-2 flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-background pr-1.5 pl-2 focus-within:ring-2 focus-within:ring-ring/30">
        <Search className="size-[13px] shrink-0 text-faint" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find a file"
          aria-label="Find a file"
          className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-faint"
        />
      </div>
      <div className="mx-3 mb-3 min-h-0 flex-1 overflow-y-auto rounded-lg bg-background py-1">
        {matches ? (
          matches.length === 0 ? (
            <p className="px-6 py-10 text-center text-[13px] text-muted-foreground">No file matches.</p>
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
          <FolderEntries checkout={checkout} dir="" depth={0} />
        )}
      </div>
    </div>
  );
}

/** A folder's entries, loaded when shown and again when the project's files change. */
function FolderEntries({ checkout, dir, depth }: { checkout: Checkout; dir: string; depth: number }) {
  const sync = useSync();
  const rev = useAppStore((s) => s.gitRev[checkout.workspaceId] ?? 0);
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    void sync.listDir(checkout, dir).then((e) => !cancelled && setEntries(e));
    return () => {
      cancelled = true;
    };
  }, [sync, checkoutKey(checkout), dir, rev]);
  if (!entries) return depth === 0 ? <p className="px-4 py-2 text-xs text-muted-foreground">Loading…</p> : null;
  if (entries.length === 0 && depth === 0) {
    return <p className="px-6 py-10 text-center text-[13px] text-muted-foreground">No files.</p>;
  }
  return (
    <ul>
      {entries.map((e) => {
        const path = dir ? `${dir}/${e.name}` : e.name;
        return (
          <li key={e.name}>
            {e.dir ? (
              <FolderRow checkout={checkout} path={path} name={e.name} depth={depth} />
            ) : (
              <FileRow path={path} label={e.name} depth={depth} />
            )}
          </li>
        );
      })}
    </ul>
  );
}

function FolderRow({ checkout, path, name, depth }: { checkout: Checkout; path: string; name: string; depth: number }) {
  const [open, setOpen] = useState(false);
  const Icon = open ? FolderOpen : Folder;
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        style={{ paddingLeft: 12 + depth * 14 }}
        className="flex w-full items-center gap-1.5 py-1 pr-3 text-left text-xs transition-colors hover:bg-subtle"
      >
        <ChevronRight className={cn('size-3 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{name}</span>
      </button>
      {open && <FolderEntries checkout={checkout} dir={path} depth={depth + 1} />}
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
      className="flex w-full items-center gap-1.5 py-1 pr-3 text-left font-mono text-xs transition-colors hover:bg-subtle"
    >
      <File className="size-3.5 shrink-0 text-faint" />
      <span className="truncate">{label}</span>
    </button>
  );
}

/**
 * One file, read fresh when opened and when the project's files change. A
 * path from a tool call may be absolute: it is made relative to the checkout.
 */
function FileViewer({ checkout, path: given, line }: { checkout: Checkout; path: string; line?: number | undefined }) {
  const sync = useSync();
  const path = workspaceRelative(given, checkout.root);
  const rev = useAppStore((s) => s.gitRev[checkout.workspaceId] ?? 0);
  const editors = useAppStore((s) => s.info?.editors ?? []);
  const [state, setState] = useState<{ file: FileContent } | { error: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    sync.readFile(checkout, path).then(
      (file) => !cancelled && setState({ file }),
      (err: unknown) => !cancelled && setState({ error: err instanceof Error ? err.message : String(err) }),
    );
    return () => {
      cancelled = true;
    };
  }, [sync, checkoutKey(checkout), path, rev]);
  const lines = useMemo(() => (state && 'file' in state && state.file.kind === 'text' ? fileLines(state.file.content) : null), [state]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 px-3 pb-2">
        <button
          type="button"
          onClick={() => openFile(null)}
          aria-label="Back to the files"
          title="Back to the files"
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
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
            onClick={() => void sync.openInEditor(checkout, path, e.id, line)}
            title={`Open in ${e.name}${line ? ` at line ${line}` : ''}`}
            className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
          >
            <SquareArrowOutUpRight className="size-3" />
            {e.name}
          </button>
        ))}
      </div>
      <div className="mx-3 mb-3 min-h-0 flex-1 overflow-y-auto rounded-lg bg-background">
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
