import { useState } from 'react';
import { Copy, Eye, FolderOpen, LoaderCircle, Pencil, Plus, Puzzle, TriangleAlert } from 'lucide-react';

import type { SkillEntryInfo, SkillScope, SkillsView } from '@harness-code/protocol';

import { Button } from '@/components/ui/button';
import { useAppStore } from '@/lib/store';
import { useSync } from '@/lib/syncContext';
import { cn } from '@/lib/utils';

import { Card, Code, DeleteButton, ErrorLine, FIELD, Field, FileEditor, SectionIntro, Segmented, errorText, useLoaded } from './common';

type Writable = 'user' | 'project';

const keyOf = (scope: SkillScope, name: string): string => `${scope}:${name}`;

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A YAML scalar for a frontmatter line: as it is when that's safe, double-quoted (JSON's quoting is YAML's) when not. */
function yamlScalar(text: string): string {
  return /^[A-Za-z0-9(][^:#\n"'{}[\]]*$/.test(text) && !/\s$/.test(text) ? text : JSON.stringify(text);
}

/** What a new skill starts as: its frontmatter, and a body to write. */
export function skillTemplate(name: string, description: string): string {
  const title = name
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
  return `---
name: ${name}
description: ${yamlScalar(description)}
---

# ${title}

Write what the agent should do once it loads this skill: the steps to take, the
conventions to follow, and the files beside this one to read (\`references/…\`)
or run (\`scripts/…\`) when they help.
`;
}

/**
 * The skills sessions here can load — the project's, yours and the built-in
 * ones, the first of a name used — each opened in place to edit (a built-in
 * one to read), and deleted once confirmed; a new one written from a
 * template, or skills copied in from a folder or a Git repository.
 */
export function SkillsSection({ workspaceId, projectName }: { workspaceId: string; projectName: string }) {
  const sync = useSync();
  const { data, error, set } = useLoaded(() => sync.settingsCall('skills.list', { workspaceId }), workspaceId);
  const [editing, setEditing] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  if (!data) return error ? <ErrorLine error={error} /> : <p className="text-xs text-muted-foreground">Reading the skills…</p>;

  const write = async (scope: Writable, name: string, text: string): Promise<void> => {
    set(await sync.settingsCall('skills.write', { workspaceId, scope, name, text }));
    setEditing(null);
  };
  const remove = async (scope: Writable, name: string): Promise<void> => {
    set(await sync.settingsCall('skills.delete', { workspaceId, scope, name }));
  };
  /** A built-in skill copied to yours — its folder whole — and opened to change. */
  const copy = async (skill: SkillEntryInfo): Promise<void> => {
    setCopyError(null);
    try {
      set((await sync.settingsCall('skills.import', { workspaceId, scope: 'user', source: skill.dir })).view);
      setEditing(keyOf('user', skill.name));
    } catch (err) {
      setCopyError(errorText(err));
    }
  };

  const groups: Array<{ scope: SkillScope; title: string }> = [
    { scope: 'project', title: `This project · ${projectName}` },
    { scope: 'user', title: 'Yours · every project' },
    { scope: 'builtin', title: 'Built in · ship with Marvis' },
  ];
  return (
    <div className="flex flex-col gap-4">
      <SectionIntro title="Skills">
        Instructions the agent loads when a task calls for them: sessions are told each skill’s name and description, and read
        the rest of its <Code>SKILL.md</Code> — and the files beside it — when it’s needed. Type <Code>/name</Code> in a message to
        load one yourself. The project’s win over yours of the same name, and yours over the built-in ones. Open sessions take
        a change up before their next message.
      </SectionIntro>
      <AddSkill
        workspaceId={workspaceId}
        projectName={projectName}
        onView={set}
        onCreated={(view, scope, name) => {
          set(view);
          setEditing(keyOf(scope, name));
        }}
      />
      {groups.map(({ scope, title }) => {
        const skills = data.skills.filter((s) => s.scope === scope);
        if (scope === 'builtin' && skills.length === 0) return null;
        return (
          <Card
            key={scope}
            label={title}
            title={
              <>
                Skills <span className="font-normal text-muted-foreground">· {title}</span>
              </>
            }
            path={data.dirs[scope]}
          >
            {skills.length === 0 ? (
              <p className="text-xs text-muted-foreground">None yet.</p>
            ) : (
              <ul className="flex flex-col divide-y">
                {skills.map((s) => {
                  const key = keyOf(s.scope, s.name);
                  const writable = s.scope !== 'builtin';
                  return (
                    <li key={key} className="flex flex-col gap-2 py-2 first:pt-0 last:pb-0">
                      <SkillRow
                        skill={s}
                        editing={editing === key}
                        onEdit={() => setEditing(key)}
                        {...(writable ? { onDelete: () => remove(s.scope as Writable, s.name) } : { onCopy: () => void copy(s) })}
                      />
                      {editing === key && (
                        <FileEditor
                          load={() => sync.settingsCall('skills.read', { workspaceId, scope: s.scope, name: s.name }).then((r) => r.text)}
                          loadKey={`${workspaceId}:${key}`}
                          readOnly={!writable}
                          {...(writable ? { onSave: (text: string) => write(s.scope as Writable, s.name, text) } : {})}
                          onCancel={() => setEditing(null)}
                          note={writable ? `${s.dir}/SKILL.md` : 'A built-in skill: copy it to yours to change it.'}
                        />
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {scope === 'builtin' && <ErrorLine error={copyError} />}
          </Card>
        );
      })}
    </div>
  );
}

function SkillRow({
  skill: s,
  editing,
  onEdit,
  onDelete,
  onCopy,
}: {
  skill: SkillEntryInfo;
  editing: boolean;
  onEdit: () => void;
  onDelete?: () => Promise<void>;
  onCopy?: () => void;
}) {
  return (
    <div className="group/skill flex items-start gap-2 text-xs">
      <Puzzle className={cn('mt-0.5 size-3.5 shrink-0 text-muted-foreground', s.shadowed && 'opacity-60')} />
      <span className={cn('flex min-w-0 flex-1 flex-col gap-0.5', s.shadowed && 'opacity-60')}>
        <span className="flex items-center gap-2">
          <span className="truncate font-mono font-medium">{s.name}</span>
          {s.shadowed && <span className="shrink-0 text-[11px] text-muted-foreground">one of the same name above is used</span>}
        </span>
        {s.description && <span className="line-clamp-2 text-muted-foreground">{s.description}</span>}
        {s.problem && (
          <span className="flex items-center gap-1 text-[11px] text-warning">
            <TriangleAlert className="size-3 shrink-0" />
            Sessions skip it: {s.problem}
          </span>
        )}
      </span>
      {!editing && (
        <span className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover/skill:opacity-100 focus-within:opacity-100">
          {onDelete ? (
            <Button size="icon-xs" variant="ghost" aria-label={`Edit ${s.name}`} title="Edit" onClick={onEdit}>
              <Pencil />
            </Button>
          ) : (
            <>
              <Button size="icon-xs" variant="ghost" aria-label={`Read ${s.name}`} title="Read" onClick={onEdit}>
                <Eye />
              </Button>
              {onCopy && !s.shadowed && (
                <Button size="xs" variant="ghost" onClick={onCopy} title="Copy it to yours, to change it — yours is then the one used">
                  <Copy />
                  Copy to yours
                </Button>
              )}
            </>
          )}
          {onDelete && <DeleteButton name={s.name} onDelete={onDelete} />}
        </span>
      )}
    </div>
  );
}

/**
 * Where a skill comes from: written here from a template, or copied in from
 * a folder — picked in the system's chooser, or typed — or a Git URL.
 */
function AddSkill({
  workspaceId,
  projectName,
  onView,
  onCreated,
}: {
  workspaceId: string;
  projectName: string;
  onView: (view: SkillsView) => void;
  onCreated: (view: SkillsView, scope: Writable, name: string) => void;
}) {
  const sync = useSync();
  const canPick = useAppStore((s) => s.info?.capabilities?.pickFolder === true);
  const picking = useAppStore((s) => s.pickingFolder);
  const [scope, setScope] = useState<Writable>('user');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState<'create' | 'import' | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The last import asked to replace skills here: the source to import again with `replace`. */
  const [conflict, setConflict] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const create = async (): Promise<void> => {
    const n = name.trim();
    setError(null);
    if (!NAME_RE.test(n) || n.length > 64) return setError('A name is lowercase letters and digits, words joined by single hyphens: pdf-forms');
    if (description.trim() === '') return setError('Say what it does and when to use it: that’s what the agent reads to pick it');
    setBusy('create');
    try {
      const view = await sync.settingsCall('skills.write', { workspaceId, scope, name: n, text: skillTemplate(n, description.trim()), create: true });
      setCreating(false);
      setName('');
      setDescription('');
      onCreated(view, scope, n);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const importFrom = async (from: string, replace = false): Promise<void> => {
    if (from.trim() === '') return;
    setError(null);
    setDone(null);
    setConflict(null);
    setBusy('import');
    try {
      const result = await sync.settingsCall('skills.import', { workspaceId, scope, source: from.trim(), ...(replace ? { replace } : {}) });
      onView(result.view);
      setSource('');
      setDone(
        `Added ${result.imported.join(', ')}.` + (result.skipped.length > 0 ? ` Skipped ${result.skipped.join('; ')}.` : ''),
      );
    } catch (err) {
      const message = errorText(err);
      setError(message);
      if (/here already/.test(message)) setConflict(from);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card label="Add a skill" title="Add a skill">
      <div className="flex flex-col gap-3 rounded-md bg-background p-3">
        <Segmented
          label="Where"
          value={scope}
          onChange={setScope}
          disabled={busy !== null}
          options={[
            { id: 'user', label: 'Yours · every project' },
            { id: 'project', label: `This project · ${projectName}` },
          ]}
        />
        <Field label="From a folder or a Git repository" hint="a folder with a SKILL.md, or one with skills inside it">
          <form
            className="flex items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              void importFrom(source);
            }}
          >
            <input
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="~/Downloads/pdf  or  https://github.com/anthropics/skills/tree/main/skills/pdf"
              spellCheck={false}
              autoComplete="off"
              disabled={busy !== null}
              aria-label="Folder or Git URL"
              className={cn(FIELD, 'flex-1')}
            />
            {canPick && (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={busy !== null || picking}
                title="Open the system’s folder chooser"
                onClick={() =>
                  void sync.pickFolder().then((picked) => {
                    if (picked) void importFrom(picked);
                  })
                }
              >
                {picking ? <LoaderCircle className="animate-spin" /> : <FolderOpen />}
                Choose…
              </Button>
            )}
            <Button type="submit" size="sm" disabled={busy !== null || source.trim() === ''}>
              {busy === 'import' && <LoaderCircle className="animate-spin" />}
              {busy === 'import' && /^https:/i.test(source.trim()) ? 'Cloning…' : 'Import'}
            </Button>
          </form>
        </Field>

        {creating ? (
          <form
            aria-label="New skill"
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
            onKeyDown={(e) => e.key === 'Escape' && setCreating(false)}
          >
            <Field label="Name" hint="its folder’s name, and what /name loads" className="w-60">
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="release-notes"
                spellCheck={false}
                autoComplete="off"
                disabled={busy !== null}
                className={FIELD}
              />
            </Field>
            <Field label="Description" hint="what it does, and when the agent should use it">
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void create();
                  }
                }}
                rows={2}
                placeholder="Write release notes from the commits since the last tag. Use when asked for a changelog or release notes."
                disabled={busy !== null}
                className="w-full resize-y rounded-md bg-subtle px-2.5 py-1.5 text-xs leading-relaxed outline-none placeholder:text-faint focus-visible:ring-2 focus-visible:ring-ring/30"
              />
            </Field>
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-faint">Its SKILL.md opens to write once it’s made.</span>
              <span className="flex-1" />
              <Button type="button" size="xs" variant="ghost" onClick={() => setCreating(false)}>
                Cancel
              </Button>
              <Button type="submit" size="xs" disabled={busy !== null}>
                {busy === 'create' && <LoaderCircle className="animate-spin" />}
                Create
              </Button>
            </div>
          </form>
        ) : (
          <Button type="button" size="xs" variant="secondary" className="w-fit" onClick={() => setCreating(true)} disabled={busy !== null}>
            <Plus />
            Write a new skill
          </Button>
        )}

        {(error || done) && (
          <div className="flex flex-wrap items-center gap-2">
            {error ? <ErrorLine error={error} /> : <p className="text-xs text-success">{done}</p>}
            {conflict && (
              <Button size="xs" variant="secondary" onClick={() => void importFrom(conflict, true)} disabled={busy !== null}>
                Replace
              </Button>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
