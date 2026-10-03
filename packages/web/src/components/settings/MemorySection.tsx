import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { FileText, Pencil, Trash2, TriangleAlert } from 'lucide-react';

import type { MemoryFileInfo, MemoryTarget } from '@harness-code/protocol';

import { Button } from '@/components/ui/button';
import { fmtBytes } from '@/lib/trace';
import { useSync } from '@/lib/syncContext';
import { cn } from '@/lib/utils';

import { Card, ErrorLine, PathNote, SectionIntro, errorText, useLoaded } from './common';

const ARM_MS = 4000;

function keyOf(target: MemoryTarget): string {
  return target.kind === 'instructions' ? `i:${target.scope}:${target.name}` : `m:${target.scope}:${target.path}`;
}

/**
 * What sessions start with: the instruction files they're given whole, and
 * the memories they can look up — each opened in place to edit, a memory
 * deleted once confirmed.
 */
export function MemorySection({ workspaceId, projectName }: { workspaceId: string; projectName: string }) {
  const sync = useSync();
  const { data, error, set } = useLoaded(() => sync.settingsCall('memory.list', { workspaceId }), workspaceId);
  const [editing, setEditing] = useState<string | null>(null);
  if (!data) return error ? <ErrorLine error={error} /> : <p className="text-xs text-muted-foreground">Reading the memory…</p>;

  const write = async (target: MemoryTarget, text: string): Promise<void> => {
    set(await sync.settingsCall('memory.write', { workspaceId, target, text }));
    setEditing(null);
  };
  const remove = async (target: MemoryTarget): Promise<void> => {
    set(await sync.settingsCall('memory.delete', { workspaceId, target }));
  };
  const editor = (target: MemoryTarget) =>
    editing === keyOf(target) ? (
      <Editor workspaceId={workspaceId} target={target} onSave={(text) => write(target, text)} onCancel={() => setEditing(null)} />
    ) : null;

  const scopeName = { user: 'Yours', global: 'Yours', project: 'This project' } as const;
  return (
    <div className="flex flex-col gap-4">
      <SectionIntro title="Memory">
        Sessions read these as they start. Instruction files are given to the model whole; memories are listed by name
        and description, and read when they matter — the agent writes them as it learns.
      </SectionIntro>
      <Card label="Instructions" title="Instructions">
        <ul className="flex flex-col divide-y">
          {data.instructions.map((file) => {
            const target: MemoryTarget = { kind: 'instructions', scope: file.scope, name: file.name };
            return (
              <li key={keyOf(target)} className="flex flex-col gap-2 py-2 first:pt-0 last:pb-0">
                <div className="flex items-center gap-2 text-xs">
                  <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="shrink-0 font-medium">
                    {scopeName[file.scope]}{' '}
                    <span className="font-normal text-muted-foreground">· {file.scope === 'user' ? 'every project' : projectName}</span>
                  </span>
                  <PathNote path={file.path} />
                  <span className="flex-1" />
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                    {file.bytes !== undefined ? fmtBytes(file.bytes) : 'not written yet'}
                  </span>
                  {editing !== keyOf(target) && (
                    <Button size="xs" variant="outline" onClick={() => setEditing(keyOf(target))}>
                      <Pencil />
                      {file.bytes !== undefined ? 'Edit' : 'Write'}
                    </Button>
                  )}
                </div>
                {editor(target)}
              </li>
            );
          })}
        </ul>
      </Card>
      {(['project', 'global'] as const).map((scope) => (
        <Memories
          key={scope}
          title={scope === 'project' ? `This project · ${projectName}` : 'Yours · every project'}
          dir={data.dirs[scope]}
          memories={data.memories.filter((m) => m.scope === scope)}
          editingKey={editing}
          onEdit={(m) => setEditing(keyOf({ kind: 'memory', scope: m.scope, path: m.path }))}
          onDelete={(m) => remove({ kind: 'memory', scope: m.scope, path: m.path })}
          editor={editor}
        />
      ))}
    </div>
  );
}

function Memories({
  title,
  dir,
  memories,
  editingKey,
  onEdit,
  onDelete,
  editor,
}: {
  title: string;
  dir: string;
  memories: MemoryFileInfo[];
  editingKey: string | null;
  onEdit: (m: MemoryFileInfo) => void;
  onDelete: (m: MemoryFileInfo) => Promise<void>;
  editor: (target: MemoryTarget) => ReactNode;
}) {
  return (
    <Card
      label={title}
      title={
        <>
          Memories <span className="font-normal text-muted-foreground">· {title}</span>
        </>
      }
      path={dir}
    >
      {memories.length === 0 ? (
        <p className="text-xs text-muted-foreground">None yet.</p>
      ) : (
        <ul className="flex flex-col divide-y">
          {memories.map((m) => {
            const target: MemoryTarget = { kind: 'memory', scope: m.scope, path: m.path };
            return (
              <li key={m.path} className="flex flex-col gap-2 py-2 first:pt-0 last:pb-0">
                <MemoryRow memory={m} editing={editingKey === keyOf(target)} onEdit={() => onEdit(m)} onDelete={() => onDelete(m)} />
                {editor(target)}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function MemoryRow({
  memory,
  editing,
  onEdit,
  onDelete,
}: {
  memory: MemoryFileInfo;
  editing: boolean;
  onEdit: () => void;
  onDelete: () => Promise<void>;
}) {
  // Delete arms first: a second click within a few seconds confirms.
  const [armed, setArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), ARM_MS);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <div className="group/memory flex items-start gap-2 text-xs">
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <span className="truncate font-medium">{memory.name}</span>
          <span className="shrink-0 rounded bg-muted px-1 font-mono text-[11px] text-muted-foreground">{memory.type || '?'}</span>
        </span>
        {memory.description && <span className="text-muted-foreground">{memory.description}</span>}
        {memory.problem && (
          <span className="flex items-center gap-1 text-[11px] text-warning">
            <TriangleAlert className="size-3 shrink-0" />
            Sessions skip it: {memory.problem}
          </span>
        )}
        <ErrorLine error={error} />
      </span>
      {!editing && (
        <span className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover/memory:opacity-100 focus-within:opacity-100">
          <Button size="icon-xs" variant="ghost" aria-label={`Edit ${memory.name}`} title="Edit" onClick={onEdit}>
            <Pencil />
          </Button>
          <button
            type="button"
            aria-label={armed ? `Confirm deleting ${memory.name}` : `Delete ${memory.name}`}
            title={armed ? 'Click again to delete' : 'Delete'}
            onClick={() => {
              if (!armed) return setArmed(true);
              setArmed(false);
              onDelete().then(
                () => setError(null),
                (err: unknown) => setError(errorText(err)),
              );
            }}
            className={cn(
              'flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] transition-colors',
              armed ? 'bg-destructive/10 text-destructive' : 'text-muted-foreground hover:text-destructive',
            )}
          >
            <Trash2 className="size-3" />
            {armed && 'Delete?'}
          </button>
        </span>
      )}
    </div>
  );
}

/** A file's text in a mono field, read when it opens; Save writes it back. */
function Editor({
  workspaceId,
  target,
  onSave,
  onCancel,
}: {
  workspaceId: string;
  target: MemoryTarget;
  onSave: (text: string) => Promise<void>;
  onCancel: () => void;
}) {
  const sync = useSync();
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // The target is a fresh object each render: read again when what it names changes.
  const key = keyOf(target);
  const targetRef = useRef(target);
  targetRef.current = target;
  useEffect(() => {
    let cancelled = false;
    sync.settingsCall('memory.read', { workspaceId, target: targetRef.current }).then(
      (r) => !cancelled && setText(r.text),
      (err: unknown) => !cancelled && setError(errorText(err)),
    );
    return () => {
      cancelled = true;
    };
  }, [sync, workspaceId, key]);
  const save = async (): Promise<void> => {
    if (text === null) return;
    setSaving(true);
    try {
      await onSave(text);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="flex flex-col gap-2 rounded-md bg-background p-2">
      <textarea
        aria-label="File text"
        value={text ?? ''}
        disabled={text === null}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void save();
          }
          if (e.key === 'Escape') onCancel();
        }}
        rows={Math.min(24, Math.max(8, (text ?? '').split('\n').length + 1))}
        placeholder={text === null ? 'Reading…' : undefined}
        spellCheck={false}
        className="w-full resize-y rounded-md bg-subtle p-2 font-mono text-xs leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      />
      <div className="flex items-center gap-2">
        <ErrorLine error={error} />
        <span className="flex-1" />
        <Button size="xs" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="xs" onClick={() => void save()} disabled={text === null || saving}>
          Save
        </Button>
      </div>
    </div>
  );
}

