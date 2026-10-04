import { useEffect, useRef, useState } from 'react';
import { Bot, Copy, Eye, FileCode, LoaderCircle, Pencil, Plus, TriangleAlert } from 'lucide-react';

import type { AgentEntryInfo, AgentFields, AgentScope, AgentsView } from '@harness-code/protocol';

import { Button } from '@/components/ui/button';
import { SelectChip } from '@/components/ui/select-chip';
import { useAppStore } from '@/lib/store';
import { useSync } from '@/lib/syncContext';
import { cn } from '@/lib/utils';

import { Card, Code, DeleteButton, ErrorLine, FIELD, Field, FileEditor, SectionIntro, Segmented, errorText, useLoaded } from './common';

type Writable = 'user' | 'project';

/** What's open: a new sub-agent's form in a scope, one's form, its file, or a built-in one read. */
type Open = { kind: 'new'; scope: Writable } | { kind: 'form' | 'file'; scope: AgentScope; name: string };

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The tools a new sub-agent is given until changed: it reads, and changes nothing. */
const STARTING_TOOLS = ['read', 'glob', 'grep'];

/** What each built-in tool lets a sub-agent do, in a few words. */
const TOOL_HINTS: Record<string, string> = {
  read: 'read files',
  glob: 'find files by name',
  grep: 'search in files',
  write: 'write files',
  edit: 'edit files',
  bash: 'run commands',
  todo: 'keep a to-do list',
  webfetch: 'fetch web pages',
};

function toolsSummary(tools: readonly string[] | undefined): string {
  if (!tools) return 'all tools';
  if (tools.length === 0) return 'no tools';
  return tools.join(' · ');
}

/**
 * The sub-agents sessions here can send with the task tool — the project's,
 * yours and the built-in ones, the first of a name used: each written and
 * changed with a form (its tools picked from the built-in ones, a model and
 * an effort of its own, its instructions) or as its file, and deleted once
 * confirmed; a built-in one read, or copied to yours to change.
 */
export function AgentsSection({ workspaceId, projectName }: { workspaceId: string; projectName: string }) {
  const sync = useSync();
  const { data, error, set } = useLoaded(() => sync.settingsCall('agents.list', { workspaceId }), workspaceId);
  const [open, setOpen] = useState<Open | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  useEffect(() => {
    // For the model field's suggestions.
    void sync.loadModels(workspaceId);
  }, [sync, workspaceId]);
  if (!data) return error ? <ErrorLine error={error} /> : <p className="text-xs text-muted-foreground">Reading the sub-agents…</p>;

  const isOpen = (kind: Open['kind'], scope: AgentScope, name?: string): boolean =>
    open !== null && open.kind === kind && open.scope === scope && (open.kind === 'new' || open.name === name);

  const remove = async (scope: Writable, name: string): Promise<void> => {
    set(await sync.settingsCall('agents.delete', { workspaceId, scope, name }));
  };
  /** A built-in one copied to yours, opened to change. */
  const copy = async (name: string): Promise<void> => {
    setCopyError(null);
    try {
      const { fields } = await sync.settingsCall('agents.get', { workspaceId, scope: 'builtin', name });
      if (!fields) throw new Error(`"${name}" doesn't parse`);
      set(await sync.settingsCall('agents.save', { workspaceId, scope: 'user', name, fields }));
      setOpen({ kind: 'form', scope: 'user', name });
    } catch (err) {
      setCopyError(errorText(err));
    }
  };

  const groups: Array<{ scope: AgentScope; title: string }> = [
    { scope: 'project', title: `This project · ${projectName}` },
    { scope: 'user', title: 'Yours · every project' },
    { scope: 'builtin', title: 'Built in · ship with Marvis' },
  ];
  return (
    <div className="flex flex-col gap-4">
      <SectionIntro title="Sub-agents">
        Helpers the agent hands a self-contained job to with its <Code>task</Code> tool — a search, a plan, a review. Each
        works in a context of its own, with the tools you give it, and only its report comes back; the agent picks one by its
        description. The project’s win over yours of the same name, and yours over the built-in ones. Open sessions take a
        change up before their next message.
      </SectionIntro>
      {groups.map(({ scope, title }) => {
        const agents = data.agents.filter((a) => a.scope === scope);
        const writable = scope !== 'builtin';
        return (
          <Card
            key={scope}
            label={title}
            title={
              <>
                Sub-agents <span className="font-normal text-muted-foreground">· {title}</span>
              </>
            }
            path={data.dirs[scope]}
            aside={
              writable &&
              !isOpen('new', scope) && (
                <Button size="xs" variant="outline" onClick={() => setOpen({ kind: 'new', scope })}>
                  <Plus />
                  New sub-agent
                </Button>
              )
            }
          >
            {writable && isOpen('new', scope) && (
              <div className="mb-3">
                <AgentForm
                  workspaceId={workspaceId}
                  view={data}
                  scope={scope}
                  onSaved={(view) => {
                    set(view);
                    setOpen(null);
                  }}
                  onCancel={() => setOpen(null)}
                />
              </div>
            )}
            {agents.length === 0 ? (
              !isOpen('new', scope) && <p className="text-xs text-muted-foreground">None yet.</p>
            ) : (
              <ul className="flex flex-col divide-y">
                {agents.map((a) => (
                  <li key={a.name} className="flex flex-col gap-2 py-2 first:pt-0 last:pb-0">
                    <AgentRow
                      agent={a}
                      busy={open !== null && open.kind !== 'new' && open.scope === scope && open.name === a.name}
                      onForm={() => setOpen({ kind: 'form', scope, name: a.name })}
                      onFile={() => setOpen({ kind: 'file', scope, name: a.name })}
                      {...(writable ? { onDelete: () => remove(scope, a.name) } : { onCopy: () => void copy(a.name) })}
                    />
                    {isOpen('form', scope, a.name) && writable && (
                      <AgentForm
                        workspaceId={workspaceId}
                        view={data}
                        scope={scope}
                        editing={a.name}
                        onSaved={(view) => {
                          set(view);
                          setOpen(null);
                        }}
                        onCancel={() => setOpen(null)}
                        onEditFile={() => setOpen({ kind: 'file', scope, name: a.name })}
                      />
                    )}
                    {isOpen('file', scope, a.name) && (
                      <FileEditor
                        load={() => sync.settingsCall('agents.get', { workspaceId, scope, name: a.name }).then((r) => r.text)}
                        loadKey={`${workspaceId}:${scope}:${a.name}`}
                        readOnly={!writable}
                        {...(writable
                          ? {
                              onSave: async (text: string) => {
                                set(await sync.settingsCall('agents.write', { workspaceId, scope, name: a.name, text }));
                                setOpen(null);
                              },
                            }
                          : {})}
                        onCancel={() => setOpen(null)}
                        note={writable ? a.path : 'A built-in sub-agent: copy it to yours to change it.'}
                      />
                    )}
                  </li>
                ))}
              </ul>
            )}
            {scope === 'builtin' && <ErrorLine error={copyError} />}
          </Card>
        );
      })}
    </div>
  );
}

function AgentRow({
  agent: a,
  busy,
  onForm,
  onFile,
  onDelete,
  onCopy,
}: {
  agent: AgentEntryInfo;
  /** Its form or file is open below it. */
  busy: boolean;
  onForm: () => void;
  onFile: () => void;
  onDelete?: () => Promise<void>;
  onCopy?: () => void;
}) {
  const chip = 'shrink-0 rounded bg-muted px-1 font-mono text-[11px] text-muted-foreground';
  return (
    <div className="group/agent flex items-start gap-2 text-xs">
      <Bot className={cn('mt-0.5 size-3.5 shrink-0 text-muted-foreground', a.shadowed && 'opacity-60')} />
      <span className={cn('flex min-w-0 flex-1 flex-col gap-0.5', a.shadowed && 'opacity-60')}>
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate font-mono font-medium">{a.name}</span>
          {!a.problem && (
            <>
              <span className={chip} title="The tools it can use">
                {toolsSummary(a.tools)}
              </span>
              {a.model && (
                <span className={chip} title="Its model">
                  {a.model}
                </span>
              )}
              {a.effort && (
                <span className={chip} title="Its reasoning effort">
                  effort {a.effort}
                </span>
              )}
            </>
          )}
          {a.shadowed && <span className="shrink-0 text-[11px] text-muted-foreground">one of the same name above is used</span>}
        </span>
        {a.description && <span className="line-clamp-2 text-muted-foreground">{a.description}</span>}
        {a.problem && (
          <span className="flex items-center gap-1 text-[11px] text-warning">
            <TriangleAlert className="size-3 shrink-0" />
            Sessions skip it: {a.problem}
          </span>
        )}
      </span>
      {!busy && (
        <span className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover/agent:opacity-100 focus-within:opacity-100">
          {onDelete ? (
            <>
              {!a.problem && (
                <Button size="icon-xs" variant="ghost" aria-label={`Edit ${a.name}`} title="Edit" onClick={onForm}>
                  <Pencil />
                </Button>
              )}
              <Button size="icon-xs" variant="ghost" aria-label={`Edit ${a.name}'s file`} title="Edit the file" onClick={onFile}>
                <FileCode />
              </Button>
              <DeleteButton name={a.name} onDelete={onDelete} />
            </>
          ) : (
            <>
              <Button size="icon-xs" variant="ghost" aria-label={`Read ${a.name}`} title="Read" onClick={onFile}>
                <Eye />
              </Button>
              {!a.shadowed && (
                <Button size="xs" variant="ghost" onClick={onCopy} title="Copy it to yours, to change it — yours is then the one used">
                  <Copy />
                  Copy to yours
                </Button>
              )}
            </>
          )}
        </span>
      )}
    </div>
  );
}

const BODY_PLACEHOLDER = `What it does once it's sent, and what it reports. For example:

Run the project's tests that cover the change you're given, and fix what fails.
- Find the test command in package.json or the README.
- Change only test files unless a failure is a real bug; then say so.

Report: what failed, what you changed, and anything still failing.`;

/** A sub-agent's fields: new in `scope`, or — `editing` — the one of that name, read first. */
function AgentForm({
  workspaceId,
  view,
  scope,
  editing,
  onSaved,
  onCancel,
  onEditFile,
}: {
  workspaceId: string;
  view: AgentsView;
  scope: Writable;
  editing?: string;
  onSaved: (view: AgentsView) => void;
  onCancel: () => void;
  onEditFile?: () => void;
}) {
  const sync = useSync();
  const models = useAppStore((s) => s.models[workspaceId]);
  const [loaded, setLoaded] = useState(editing === undefined);
  const [name, setName] = useState(editing ?? '');
  const [description, setDescription] = useState('');
  const [limited, setLimited] = useState(true);
  // A new one starts as a look-around: what the built-in explore has.
  const [tools, setTools] = useState<string[]>(() => view.tools.filter((t) => STARTING_TOOLS.includes(t.name)).map((t) => t.name));
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const editingRef = useRef(editing);
  const offeredRef = useRef(view.tools);

  useEffect(() => {
    const target = editingRef.current;
    if (target === undefined) return;
    let cancelled = false;
    sync.settingsCall('agents.get', { workspaceId, scope, name: target }).then(
      ({ fields }) => {
        if (cancelled) return;
        if (!fields) return setError('Its file doesn’t parse: edit the file instead.');
        setDescription(fields.description);
        setLimited(fields.tools !== undefined);
        setTools(fields.tools ?? offeredRef.current.map((t) => t.name));
        setModel(fields.model ?? '');
        setEffort(fields.effort ?? '');
        setBody(fields.body);
        setLoaded(true);
      },
      (err: unknown) => !cancelled && setError(errorText(err)),
    );
    return () => {
      cancelled = true;
    };
  }, [sync, workspaceId, scope]);

  const save = async (): Promise<void> => {
    const n = name.trim();
    setError(null);
    if (!NAME_RE.test(n) || n.length > 64) return setError('A name is lowercase letters and digits, words joined by single hyphens: test-runner');
    if (description.trim() === '') return setError('Say what it’s for and when to send it: that’s how the agent picks it');
    if (body.trim() === '') return setError('Write its instructions');
    const fields: AgentFields = {
      description: description.trim(),
      ...(limited ? { tools } : {}),
      ...(model.trim() ? { model: model.trim() } : {}),
      ...(effort ? { effort } : {}),
      body,
    };
    setBusy(true);
    try {
      onSaved(await sync.settingsCall('agents.save', { workspaceId, scope, name: n, fields, ...(editing !== undefined ? { previousName: editing } : {}) }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const offered = new Set(view.tools.map((t) => t.name));
  // A name its file gives that isn't a built-in tool: kept, and shown so it can be dropped.
  const others = tools.filter((t) => !offered.has(t));
  const toggle = (tool: string): void => setTools((ts) => (ts.includes(tool) ? ts.filter((t) => t !== tool) : [...ts, tool]));
  const disabled = busy || !loaded;
  return (
    <form
      aria-label={editing ? `Edit ${editing}` : 'New sub-agent'}
      className="flex flex-col gap-3 rounded-md bg-background p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel();
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void save();
        }
      }}
    >
      <Field label="Name" hint="what the agent sends it by" className="w-60">
        <input
          autoFocus={editing === undefined}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="test-runner"
          spellCheck={false}
          autoComplete="off"
          disabled={disabled}
          className={FIELD}
        />
      </Field>
      <Field label="Description" hint="what it’s for, and when to send it — the agent picks one by this">
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          placeholder="Runs the tests a change touches and fixes what fails. Send it after editing code, with the files you changed."
          disabled={disabled}
          className="w-full resize-y rounded-md bg-subtle px-2.5 py-1.5 text-xs leading-relaxed outline-none placeholder:text-faint focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-60"
        />
      </Field>
      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] font-medium text-muted-foreground">
          Tools<span className="font-normal text-faint"> · it never gets the task tool: a sub-agent sends none of its own</span>
        </span>
        <Segmented
          label="Tools"
          value={limited ? 'only' : 'all'}
          onChange={(v) => setLimited(v === 'only')}
          disabled={disabled}
          options={[
            { id: 'only', label: 'Only these' },
            { id: 'all', label: 'All the session’s built-in tools' },
          ]}
        />
        {limited && (
          <div role="group" aria-label="Its tools" className="grid grid-cols-1 gap-x-4 gap-y-1 pt-0.5 @md:grid-cols-2 @3xl:grid-cols-3">
            {/* The ones that only look first, then those that change things. */}
            {[...view.tools].sort((a, b) => Number(b.readOnly) - Number(a.readOnly)).map((t) => (
              <label key={t.name} className="flex min-w-0 cursor-pointer items-center gap-1.5 text-xs">
                <input type="checkbox" className="accent-ink" checked={tools.includes(t.name)} onChange={() => toggle(t.name)} disabled={disabled} />
                <span className="font-mono">{t.name}</span>
                <span className="truncate text-[11px] text-muted-foreground">
                  {TOOL_HINTS[t.name] ?? ''}
                  {!t.readOnly && <span className="text-faint"> · changes things</span>}
                </span>
              </label>
            ))}
            {others.map((t) => (
              <label key={t} className="flex min-w-0 cursor-pointer items-center gap-1.5 text-xs">
                <input type="checkbox" className="accent-ink" checked onChange={() => toggle(t)} disabled={disabled} />
                <span className="font-mono">{t}</span>
                <span className="truncate text-[11px] text-warning">not a tool sessions have</span>
              </label>
            ))}
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Model" hint="blank: the session’s" className="min-w-60 flex-1">
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            list={`agent-models-${workspaceId}`}
            placeholder="the session’s model"
            spellCheck={false}
            autoComplete="off"
            disabled={disabled}
            className={FIELD}
          />
          <datalist id={`agent-models-${workspaceId}`}>
            {(models ?? []).map((m) => (
              <option key={m.ref} value={m.ref} />
            ))}
          </datalist>
        </Field>
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-muted-foreground">Effort</span>
          <SelectChip label="Effort" value={effort} onChange={setEffort}>
            <option value="">the session’s</option>
            {view.efforts.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </SelectChip>
        </div>
      </div>
      <Field label="Instructions" hint="its role: what to do, how, and what to report">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={Math.min(20, Math.max(8, body.split('\n').length + 1))}
          placeholder={BODY_PLACEHOLDER}
          spellCheck={false}
          disabled={disabled}
          className="w-full resize-y rounded-md bg-subtle p-2 font-mono text-xs leading-relaxed outline-none placeholder:text-faint focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-60"
        />
      </Field>
      <div className="flex items-center gap-2">
        {onEditFile && (
          <Button type="button" size="xs" variant="ghost" onClick={onEditFile} className="text-muted-foreground">
            <FileCode />
            Edit the file instead
          </Button>
        )}
        <ErrorLine error={error} />
        <span className="flex-1" />
        <Button type="button" size="xs" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="xs" disabled={disabled}>
          {busy && <LoaderCircle className="animate-spin" />}
          {editing !== undefined ? 'Save' : 'Create'}
        </Button>
      </div>
    </form>
  );
}
