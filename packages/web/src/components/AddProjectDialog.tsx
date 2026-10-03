import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { AlertTriangle, FolderGit2, FolderOpen, LoaderCircle, Plug } from 'lucide-react';

import type { DirSuggestion, WorkspaceInspection } from '@harness-code/protocol';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { routeToHash } from '@/lib/route';
import { useAppStore } from '@/lib/store';
import { useSync } from '@/lib/syncContext';
import { cn } from '@/lib/utils';

const SUGGEST_MS = 120;
const INSPECT_MS = 250;

/**
 * "Add project", from wherever it is offered: the system's folder chooser
 * where there is one (`sync.addProject`), then the new session page of the
 * project it added or found.
 */
export function useAddProject(): () => void {
  const sync = useSync();
  return () =>
    void sync.addProject().then((workspace) => {
      if (workspace) window.location.hash = routeToHash({ kind: 'new', workspaceId: workspace.id });
    });
}

/**
 * Add a project: a path field with directory completion — or a folder picked
 * in the system's chooser, which opens it here when it wants a look — and, read from disk
 * before anything is started — what adding it means. A project's `.mcp.json`
 * starts its servers with every session and its settings can turn approvals
 * off, so when there is any of that the button says "Trust and add".
 */
export function AddProjectDialog() {
  const sync = useSync();
  const open = useAppStore((s) => s.addProjectOpen);
  return (
    <Dialog open={open} onOpenChange={(next) => sync.setAddProjectOpen(next)}>
      {open && <AddProjectForm onDone={() => sync.setAddProjectOpen(false)} />}
    </Dialog>
  );
}

function AddProjectForm({ onDone }: { onDone: () => void }) {
  const sync = useSync();
  const [path, setPath] = useState(() => useAppStore.getState().addProjectPath);
  const canPick = useAppStore((s) => s.info?.capabilities?.pickFolder === true);
  const picking = useAppStore((s) => s.pickingFolder);
  const [suggestions, setSuggestions] = useState<DirSuggestion[]>([]);
  const [active, setActive] = useState(-1);
  const [inspection, setInspection] = useState<WorkspaceInspection | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [adding, setAdding] = useState(false);
  const latest = useRef(path);
  latest.current = path;

  // Completion follows the text as typed (the home directory's folders when empty).
  useEffect(() => {
    const timer = setTimeout(() => {
      void sync.suggestDirs(path).then((found) => {
        if (latest.current !== path) return;
        setSuggestions(found.filter((s) => s.label !== path && s.path !== path));
        setActive(-1);
      });
    }, SUGGEST_MS);
    return () => clearTimeout(timer);
  }, [sync, path]);

  // …and so does the preview of what adding it would mean.
  useEffect(() => {
    if (path.trim() === '') {
      setInspection(null);
      return;
    }
    setInspecting(true);
    const timer = setTimeout(() => {
      void sync.inspectPath(path).then((found) => {
        if (latest.current !== path) return;
        setInspection(found);
        setInspecting(false);
      });
    }, INSPECT_MS);
    return () => clearTimeout(timer);
  }, [sync, path]);

  const covered = inspection?.workspace;
  const trust = !!inspection && (inspection.mcpServers.length > 0 || inspection.warnings.length > 0);
  const ready = !!inspection && !inspection.problem && !inspecting && !adding;

  const go = (workspaceId: string): void => {
    onDone();
    window.location.hash = routeToHash({ kind: 'new', workspaceId });
  };

  const submit = async (): Promise<void> => {
    if (!ready || !inspection) return;
    if (covered) return go(covered.id);
    setAdding(true);
    const added = await sync.addWorkspace(path, inspection.needsMarker ? { createMarker: true } : {});
    setAdding(false);
    if (added) go(added.id);
  };

  const pick = (s: DirSuggestion): void => {
    setPath(`${s.label}/`);
    setActive(-1);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.nativeEvent.isComposing) return;
    if (suggestions.length > 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : suggestions.length - 1;
      setActive((i) => (i + step + suggestions.length) % suggestions.length);
      return;
    }
    const highlighted = suggestions[active];
    if (highlighted && (e.key === 'Tab' || e.key === 'Enter')) {
      e.preventDefault();
      pick(highlighted);
      return;
    }
    if (e.key === 'Tab' && suggestions.length === 1) {
      e.preventDefault();
      pick(suggestions[0]!);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <DialogContent
      title="Add a project"
      description="Sessions run in the project's folder, with its settings, MCP servers and .env."
    >
      <div className="flex flex-col gap-3 overflow-y-auto px-5 pt-4 pb-5">
        <div className="relative flex gap-1.5">
          <input
            autoFocus
            value={path}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="~/code/my-project"
            spellCheck={false}
            aria-label="Project folder"
            aria-autocomplete="list"
            className="min-w-0 flex-1 rounded-md bg-subtle px-3 py-2 font-mono text-[13px] outline-none placeholder:text-faint focus:ring-2 focus:ring-ring/30"
          />
          {canPick && (
            <Button
              variant="secondary"
              className="h-auto"
              disabled={picking}
              onClick={() =>
                void sync.pickFolder().then((picked) => {
                  if (picked) setPath(picked);
                })
              }
              title="Choose a folder in Finder"
            >
              {picking ? <LoaderCircle className="animate-spin" /> : <FolderOpen />}
              Choose…
            </Button>
          )}
          {suggestions.length > 0 && (
            <ul
              role="listbox"
              className="absolute top-full right-0 left-0 z-10 mt-1 max-h-56 overflow-y-auto rounded-md border bg-popover py-1 shadow-lg"
            >
              {suggestions.map((s, i) => (
                <li key={s.path} role="option" aria-selected={i === active}>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pick(s)}
                    className={cn(
                      'flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-xs hover:bg-accent',
                      i === active && 'bg-accent',
                    )}
                  >
                    {s.git ? (
                      <FolderGit2 className="size-3.5 shrink-0 text-primary" />
                    ) : (
                      <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <span className="truncate">{s.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <Preview inspection={inspection} inspecting={inspecting} />

        <div className="mt-1 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onDone}>
            Cancel
          </Button>
          <Button size="sm" disabled={!ready} onClick={() => void submit()}>
            {adding && <LoaderCircle className="animate-spin" />}
            {covered ? 'Open project' : trust ? 'Trust and add' : 'Add project'}
          </Button>
        </div>
      </div>
    </DialogContent>
  );
}

function Preview({ inspection, inspecting }: { inspection: WorkspaceInspection | null; inspecting: boolean }) {
  if (!inspection) {
    return inspecting ? (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <LoaderCircle className="size-3.5 animate-spin" /> Looking…
      </p>
    ) : null;
  }
  if (inspection.problem) {
    return <p className="text-xs text-destructive">{inspection.problem}</p>;
  }
  if (inspection.workspace) {
    return (
      <p className="text-xs text-muted-foreground">
        Already a project: <span className="font-medium text-foreground">{inspection.workspace.name}</span>
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2 rounded-lg bg-subtle p-3 text-xs">
      <div className="flex items-center gap-2">
        {inspection.git ? (
          <FolderGit2 className="size-3.5 text-primary" />
        ) : (
          <FolderOpen className="size-3.5 text-muted-foreground" />
        )}
        <span className="truncate font-mono" title={inspection.root}>
          {inspection.root}
        </span>
        <span className="ml-auto shrink-0 text-muted-foreground">{inspection.git ? 'git repository' : 'folder'}</span>
      </div>
      {inspection.needsMarker && (
        <p className="text-muted-foreground">
          Not a project folder yet: adding it creates <code className="font-mono">.agent/</code> in it, where its
          sessions are kept.
        </p>
      )}
      {inspection.mcpServers.length > 0 && (
        <div>
          <p className="mb-1 flex items-center gap-1.5 font-medium">
            <Plug className="size-3.5 text-muted-foreground" /> Starts with every session
          </p>
          <ul className="flex flex-col gap-0.5">
            {inspection.mcpServers.map((s) => (
              <li key={s.name} className="flex gap-2 font-mono">
                <span className="shrink-0 font-medium">{s.name}</span>
                <span className="truncate text-muted-foreground" title={s.command ?? s.url}>
                  {s.command ?? s.url}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {inspection.warnings.map((w) => (
        <p key={w} className="flex items-start gap-1.5 text-warning">
          <AlertTriangle className="mt-px size-3.5 shrink-0" />
          {w}
        </p>
      ))}
    </div>
  );
}
