import { useState } from 'react';
import type { ReactNode } from 'react';
import { FileText, Pencil, TriangleAlert } from 'lucide-react';

import type { MemoryFileInfo, MemoryTarget } from '@harness-code/protocol';

import { Button } from '@/components/ui/button';
import { fmtBytes } from '@/lib/trace';
import { useSync } from '@/lib/syncContext';

import { Card, Code, DeleteButton, ErrorLine, FileEditor, PathNote, SectionIntro, useLoaded } from './common';

function keyOf(target: MemoryTarget): string {
  return target.kind === 'instructions' ? `i:${target.scope}:${target.name}` : `m:${target.scope}:${target.path}`;
}

/**
 * What sessions start with, from your side: your instruction file, given to
 * the model whole, and your memories, looked up when they matter — each
 * opened in place to edit, a memory deleted once confirmed. A project's
 * `AGENTS.md` and memories are its own files, as in Claude Code.
 */
export function MemorySection({ workspaceId }: { workspaceId: string }) {
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

  return (
    <div className="flex flex-col gap-4">
      <SectionIntro title="Memory">
        Sessions read these as they start. Instruction files are given to the model whole; memories are listed by name
        and description, and read when they matter — the agent writes them as it learns. These are yours, for every
        project; a project’s own are its <Code>AGENTS.md</Code> and the memories in its <Code>.agent/memory/</Code>.
      </SectionIntro>
      <Card label="Your instructions" title="Your instructions">
        <ul className="flex flex-col divide-y">
          {data.instructions.filter((file) => file.scope === 'user').map((file) => {
            const target: MemoryTarget = { kind: 'instructions', scope: file.scope, name: file.name };
            return (
              <li key={keyOf(target)} className="flex flex-col gap-2 py-2 first:pt-0 last:pb-0">
                <div className="flex items-center gap-2 text-xs">
                  <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="shrink-0 font-medium">{file.name}</span>
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
      <Memories
        dir={data.dirs.global}
        memories={data.memories.filter((m) => m.scope === 'global')}
        editingKey={editing}
        onEdit={(m) => setEditing(keyOf({ kind: 'memory', scope: m.scope, path: m.path }))}
        onDelete={(m) => remove({ kind: 'memory', scope: m.scope, path: m.path })}
        editor={editor}
      />
    </div>
  );
}

function Memories({
  dir,
  memories,
  editingKey,
  onEdit,
  onDelete,
  editor,
}: {
  dir: string;
  memories: MemoryFileInfo[];
  editingKey: string | null;
  onEdit: (m: MemoryFileInfo) => void;
  onDelete: (m: MemoryFileInfo) => Promise<void>;
  editor: (target: MemoryTarget) => ReactNode;
}) {
  return (
    <Card label="Your memories" title="Your memories" path={dir}>
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
      </span>
      {!editing && (
        <span className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover/memory:opacity-100 focus-within:opacity-100">
          <Button size="icon-xs" variant="ghost" aria-label={`Edit ${memory.name}`} title="Edit" onClick={onEdit}>
            <Pencil />
          </Button>
          <DeleteButton name={memory.name} onDelete={onDelete} />
        </span>
      )}
    </div>
  );
}

/** A memory store file's text, edited in place. */
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
  return (
    <FileEditor
      load={() => sync.settingsCall('memory.read', { workspaceId, target }).then((r) => r.text)}
      loadKey={`${workspaceId}:${keyOf(target)}`}
      onSave={onSave}
      onCancel={onCancel}
    />
  );
}
