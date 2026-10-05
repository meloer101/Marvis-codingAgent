import { useState } from 'react';
import type { ReactNode } from 'react';
import { Copy, Eye, FolderOpen, LoaderCircle, MoreHorizontal, Pencil, Plus, Puzzle, Trash2, TriangleAlert } from 'lucide-react';

import type { SkillEntryInfo, SkillsView } from '@harness-code/protocol';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { DropdownActions } from '@/components/ui/menu';
import type { MenuAction } from '@/components/ui/menu';
import { useAppStore } from '@/lib/store';
import { useSync } from '@/lib/syncContext';
import { cn } from '@/lib/utils';

import { Card, Code, ErrorLine, FIELD, Field, FileEditor, PathNote, SectionIntro, Segmented, errorText, useLoaded } from './common';

const keyOf = (scope: SkillEntryInfo['scope'], name: string): string => `${scope}:${name}`;

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
 * Your skills — `~/.agent/skills/`, for every project — and the ones Marvis
 * ships with, as Claude Code keeps them: a project's own skills are files in
 * its `.agent/skills/`, written there like any other, so they aren't managed
 * here. Each opens in place to edit (a built-in one to read, or copy to
 * yours); one is added from a folder or a Git repository, or written new
 * from a template.
 */
export function SkillsSection({ workspaceId }: { workspaceId: string }) {
  const sync = useSync();
  const { data, error, set } = useLoaded(() => sync.settingsCall('skills.list', { workspaceId }), workspaceId);
  /** The skill whose SKILL.md is open, by `scope:name`. */
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  if (!data) return error ? <ErrorLine error={error} /> : <p className="text-xs text-muted-foreground">Reading your skills…</p>;

  const write = async (name: string, text: string): Promise<void> => {
    set(await sync.settingsCall('skills.write', { workspaceId, scope: 'user', name, text }));
    setOpen(null);
  };
  const remove = async (name: string): Promise<void> => {
    set(await sync.settingsCall('skills.delete', { workspaceId, scope: 'user', name }));
  };
  /** A built-in skill copied to yours — its folder whole — and opened to change. */
  const copy = async (skill: SkillEntryInfo): Promise<void> => {
    setCopyError(null);
    try {
      set((await sync.settingsCall('skills.import', { workspaceId, scope: 'user', source: skill.dir })).view);
      setOpen(keyOf('user', skill.name));
    } catch (err) {
      setCopyError(errorText(err));
    }
  };

  const yours = data.skills.filter((s) => s.scope === 'user');
  const builtin = data.skills.filter((s) => s.scope === 'builtin');
  const editor = (s: SkillEntryInfo) =>
    open === keyOf(s.scope, s.name) && (
      <FileEditor
        load={() => sync.settingsCall('skills.read', { workspaceId, scope: s.scope, name: s.name }).then((r) => r.text)}
        loadKey={`${workspaceId}:${keyOf(s.scope, s.name)}`}
        readOnly={s.scope === 'builtin'}
        {...(s.scope === 'user' ? { onSave: (text: string) => write(s.name, text) } : {})}
        onCancel={() => setOpen(null)}
        note={s.scope === 'user' ? `${s.dir}/SKILL.md` : 'A built-in skill: copy it to yours to change it.'}
      />
    );

  return (
    <div className="flex flex-col gap-4">
      <SectionIntro title="Skills">
        Instructions the agent loads when a task calls for them: it’s told each skill’s name and description, and reads the
        rest when it needs it. Type <Code>/name</Code> in a message to load one yourself. These are yours, for every project; a
        project’s own skills are files in its <Code>.agent/skills/</Code>, written there like any other.
      </SectionIntro>
      <Card
        label="Your skills"
        title="Your skills"
        aside={
          <Button size="xs" variant="outline" onClick={() => setAdding(true)}>
            <Plus />
            Add skill
          </Button>
        }
      >
        {yours.length === 0 ? (
          <p className="text-xs text-muted-foreground">None yet — import one from a folder or a Git repository, or write your own.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {yours.map((s) => (
              <SkillRow
                key={s.name}
                skill={s}
                shadowedBy="this project has a skill of the same name, which is used"
                actions={[
                  { label: 'Edit SKILL.md', icon: <Pencil />, onSelect: () => setOpen(keyOf(s.scope, s.name)) },
                ]}
                onRemove={() => remove(s.name)}
              >
                {editor(s)}
              </SkillRow>
            ))}
          </ul>
        )}
      </Card>
      {builtin.length > 0 && (
        <Card label="Built in" title="Built in" aside={<span className="text-[11px] text-faint">ship with Marvis</span>}>
          <ul className="flex flex-col gap-1.5">
            {builtin.map((s) => (
              <SkillRow
                key={s.name}
                skill={s}
                shadowedBy="one of yours or this project’s has its name, and is used"
                actions={[
                  { label: 'Read SKILL.md', icon: <Eye />, onSelect: () => setOpen(keyOf(s.scope, s.name)) },
                  ...(s.shadowed ? [] : [{ label: 'Copy to yours, to change it', icon: <Copy />, onSelect: () => void copy(s) }]),
                ]}
              >
                {editor(s)}
              </SkillRow>
            ))}
          </ul>
          <ErrorLine error={copyError} />
        </Card>
      )}
      <div className="flex px-1">
        <PathNote path={data.dirs.user} />
      </div>
      <Dialog open={adding} onOpenChange={setAdding}>
        {adding && (
          <AddSkill
            workspaceId={workspaceId}
            onView={set}
            onDone={(view, created) => {
              set(view);
              setAdding(false);
              if (created) setOpen(keyOf('user', created));
            }}
          />
        )}
      </Dialog>
    </div>
  );
}

/** A skill as a white row: its name and description, why sessions skip it, and a ⋯ of what can be done with it. */
function SkillRow({
  skill: s,
  shadowedBy,
  actions,
  onRemove,
  children,
}: {
  skill: SkillEntryInfo;
  /** What to say when a skill of the same name before it is the one used. */
  shadowedBy: string;
  actions: MenuAction[];
  /** Yours: delete its folder, once confirmed. */
  onRemove?: () => Promise<void>;
  /** Its SKILL.md, when open. */
  children?: ReactNode;
}) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const menu: MenuAction[] = [
    ...actions,
    ...(onRemove ? [{ label: 'Remove', icon: <Trash2 />, destructive: true, separated: true, onSelect: () => setConfirming(true) }] : []),
  ];
  return (
    <li className="flex flex-col rounded-md bg-background">
      <div className="flex items-start gap-3 px-3 py-2.5">
        <span
          aria-hidden
          className={cn('flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground', s.shadowed && 'opacity-60')}
        >
          <Puzzle className="size-3.5" />
        </span>
        <div className={cn('flex min-w-0 flex-1 flex-col gap-0.5', s.shadowed && 'opacity-60')}>
          <span className="flex items-baseline gap-2">
            <span className="truncate text-[13px] font-medium">{s.name}</span>
            {s.shadowed && <span className="shrink-0 text-[11px] text-faint">{shadowedBy}</span>}
          </span>
          {s.description && <span className="line-clamp-2 text-xs text-muted-foreground">{s.description}</span>}
          {s.problem && (
            <span className="flex items-center gap-1 text-[11px] text-warning">
              <TriangleAlert className="size-3 shrink-0" />
              Sessions skip it: {s.problem}
            </span>
          )}
        </div>
        {confirming ? (
          <span className="flex shrink-0 items-center gap-1.5 text-xs">
            <span className="text-muted-foreground">Delete its folder?</span>
            <Button
              size="xs"
              variant="destructive"
              onClick={() =>
                void onRemove?.().then(
                  () => setConfirming(false),
                  (err: unknown) => {
                    setError(errorText(err));
                    setConfirming(false);
                  },
                )
              }
            >
              Remove
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </span>
        ) : (
          <DropdownActions
            label={`More for ${s.name}`}
            actions={menu}
            trigger={
              <Button size="icon-xs" variant="ghost" className="text-muted-foreground">
                <MoreHorizontal />
              </Button>
            }
          />
        )}
      </div>
      {error && <p className="px-3 pb-2 pl-[52px] text-[11px] text-destructive">{error}</p>}
      {children && <div className="px-3 pb-3">{children}</div>}
    </li>
  );
}

/**
 * Add a skill to yours: imported from a folder — picked in the system's
 * chooser, or typed — or a Git URL; or written new from a template, whose
 * SKILL.md then opens to write.
 */
function AddSkill({
  workspaceId,
  onView,
  onDone,
}: {
  workspaceId: string;
  onView: (view: SkillsView) => void;
  /** Added: `created` names one written new, to open. */
  onDone: (view: SkillsView, created?: string) => void;
}) {
  const sync = useSync();
  const canPick = useAppStore((s) => s.info?.capabilities?.pickFolder === true);
  const picking = useAppStore((s) => s.pickingFolder);
  const [how, setHow] = useState<'import' | 'write'>('import');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The last import asked to replace skills of yours: the source to import again with `replace`. */
  const [conflict, setConflict] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<string | null>(null);

  const create = async (): Promise<void> => {
    const n = name.trim();
    setError(null);
    if (!NAME_RE.test(n) || n.length > 64) return setError('A name is lowercase letters and digits, words joined by single hyphens: pdf-forms');
    if (description.trim() === '') return setError('Say what it does and when to use it: that’s what the agent reads to pick it');
    setBusy(true);
    try {
      const view = await sync.settingsCall('skills.write', { workspaceId, scope: 'user', name: n, text: skillTemplate(n, description.trim()), create: true });
      onDone(view, n);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  const importFrom = async (from: string, replace = false): Promise<void> => {
    if (from.trim() === '') return;
    setError(null);
    setSkipped(null);
    setConflict(null);
    setBusy(true);
    try {
      const result = await sync.settingsCall('skills.import', { workspaceId, scope: 'user', source: from.trim(), ...(replace ? { replace } : {}) });
      if (result.skipped.length === 0) return onDone(result.view);
      // Some came in, some didn't: say which, and stay.
      onView(result.view);
      setSource('');
      setSkipped(`Added ${result.imported.join(', ') || 'none'}. Skipped ${result.skipped.join('; ')}.`);
    } catch (err) {
      const message = errorText(err);
      setError(message);
      if (/here already/.test(message)) setConflict(from);
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogContent title="Add a skill" description="Yours, for every project.">
      <div className="flex flex-col gap-3 px-5 pt-4 pb-5">
        <Segmented
          label="How"
          value={how}
          onChange={(v) => {
            setHow(v);
            setError(null);
          }}
          disabled={busy}
          options={[
            { id: 'import', label: 'Import' },
            { id: 'write', label: 'Write a new one' },
          ]}
        />
        {how === 'import' ? (
          <form
            aria-label="Import a skill"
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void importFrom(source);
            }}
          >
            <Field label="From a folder or a Git repository" hint="one with a SKILL.md, or with skills inside it">
              <input
                autoFocus
                value={source}
                onChange={(e) => setSource(e.target.value)}
                placeholder="~/Downloads/pdf  or  https://github.com/anthropics/skills/tree/main/skills/pdf"
                spellCheck={false}
                autoComplete="off"
                disabled={busy}
                aria-label="Folder or Git URL"
                className={cn(FIELD, 'h-8')}
              />
            </Field>
            <div className="flex flex-wrap items-center gap-2">
              {canPick && (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={busy || picking}
                  title="Open the system’s folder chooser"
                  onClick={() =>
                    void sync.pickFolder().then((picked) => {
                      if (picked) void importFrom(picked);
                    })
                  }
                >
                  {picking ? <LoaderCircle className="animate-spin" /> : <FolderOpen />}
                  Choose a folder…
                </Button>
              )}
              <span className="flex-1" />
              {conflict && (
                <Button type="button" size="sm" variant="secondary" onClick={() => void importFrom(conflict, true)} disabled={busy}>
                  Replace
                </Button>
              )}
              <Button type="submit" size="sm" disabled={busy || source.trim() === ''}>
                {busy && <LoaderCircle className="animate-spin" />}
                {busy && /^https:/i.test(source.trim()) ? 'Cloning…' : 'Import'}
              </Button>
            </div>
          </form>
        ) : (
          <form
            aria-label="New skill"
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <Field label="Name" hint="its folder’s name, and what /name loads">
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="release-notes"
                spellCheck={false}
                autoComplete="off"
                disabled={busy}
                className={cn(FIELD, 'h-8')}
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
                rows={3}
                placeholder="Write release notes from the commits since the last tag. Use when asked for a changelog or release notes."
                disabled={busy}
                className="w-full resize-y rounded-md bg-subtle px-2.5 py-1.5 text-xs leading-relaxed outline-none placeholder:text-faint focus-visible:ring-2 focus-visible:ring-ring/30"
              />
            </Field>
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-faint">Its SKILL.md opens to write once it’s made.</span>
              <span className="flex-1" />
              <Button type="submit" size="sm" disabled={busy}>
                {busy && <LoaderCircle className="animate-spin" />}
                Create
              </Button>
            </div>
          </form>
        )}
        <ErrorLine error={error} />
        {skipped && <p className="text-xs text-muted-foreground">{skipped}</p>}
      </div>
    </DialogContent>
  );
}
