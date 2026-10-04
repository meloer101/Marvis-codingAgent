import { useEffect, useRef, useState } from 'react';
import { Check, ChevronRight, ExternalLink, LoaderCircle, Pencil, Plug, Plus, TriangleAlert, X } from 'lucide-react';

import type { McpServerEntry, McpServerInfo, McpTestResult, McpView } from '@harness-code/protocol';

import { Button } from '@/components/ui/button';
import { joinCommandLine, parseMcpJson, splitCommandLine } from '@/lib/mcpEntry';
import { platform } from '@/platform';
import { useSync } from '@/lib/syncContext';
import { cn } from '@/lib/utils';

import { Card, Code, DeleteButton, ErrorLine, FIELD, Field, PathNote, Problems, SectionIntro, Segmented, errorText, useLoaded } from './common';

type Scope = 'user' | 'project';
type Test = 'running' | McpTestResult;

const keyOf = (scope: Scope, name: string): string => `${scope}:${name}`;

/**
 * The MCP servers sessions here connect to, as their files name them: added
 * — filled in, or pasted as the JSON a server's docs give — changed,
 * removed, and tried (connecting as a session would, listing its tools);
 * and signing in to the ones that use OAuth: the page to authorize at opens
 * in a new tab, and the list follows once it's done.
 */
export function McpSection({ workspaceId, projectName }: { workspaceId: string; projectName: string }) {
  const sync = useSync();
  const { data, error, set, reload } = useLoaded(() => sync.settingsCall('mcp.list', { workspaceId }), workspaceId);
  /** Sign-ins waiting on the browser: the server's name → the page to authorize at. */
  const [waiting, setWaiting] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<Record<string, string>>({});
  /** The form open: adding, or changing the server of this key. */
  const [form, setForm] = useState<'add' | string | null>(null);
  const [tests, setTests] = useState<Record<string, Test>>({});

  useEffect(
    () =>
      sync.onMcpLogin((event) => {
        if (event.workspaceId !== workspaceId) return;
        setWaiting(({ [event.name]: _, ...rest }) => rest);
        setFailed(({ [event.name]: _, ...rest }) => (event.error ? { ...rest, [event.name]: event.error } : rest));
        // What a test found before signing in is out of date.
        setTests((t) => Object.fromEntries(Object.entries(t).filter(([k]) => !k.endsWith(`:${event.name}`))));
        reload();
      }),
    [sync, workspaceId, reload],
  );

  if (!data) return error ? <ErrorLine error={error} /> : <p className="text-xs text-muted-foreground">Reading the MCP servers…</p>;

  const login = async (name: string): Promise<void> => {
    setFailed(({ [name]: _, ...rest }) => rest);
    try {
      const result = await sync.settingsCall('mcp.login', { workspaceId, name });
      if ('url' in result) {
        setWaiting((w) => ({ ...w, [name]: result.url }));
        platform.openExternal(result.url);
      } else {
        reload();
      }
    } catch (err) {
      setFailed((f) => ({ ...f, [name]: errorText(err) }));
    }
  };
  const logout = async (name: string): Promise<void> => {
    try {
      set(await sync.settingsCall('mcp.logout', { workspaceId, name }));
    } catch (err) {
      setFailed((f) => ({ ...f, [name]: errorText(err) }));
    }
  };
  const test = async (scope: Scope, name: string): Promise<void> => {
    const key = keyOf(scope, name);
    setTests((t) => ({ ...t, [key]: 'running' }));
    let result: McpTestResult;
    try {
      result = await sync.settingsCall('mcp.test', { workspaceId, scope, name });
    } catch (err) {
      result = { ok: false, error: errorText(err) };
    }
    setTests((t) => ({ ...t, [key]: result }));
  };
  const remove = async (scope: Scope, name: string): Promise<void> => {
    set(await sync.settingsCall('mcp.remove', { workspaceId, scope, name }));
    setTests(({ [keyOf(scope, name)]: _, ...rest }) => rest);
  };
  const saved = (view: McpView, scope: Scope, names: string[], previous?: string): void => {
    set(view);
    setForm(null);
    if (previous !== undefined) setTests(({ [keyOf(scope, previous)]: _, ...rest }) => rest);
    // Tried at once: a server added is one that should be seen to work.
    for (const name of names) void test(scope, name);
  };

  return (
    <div className="flex flex-col gap-4">
      <SectionIntro title="MCP servers">
        Tools from outside Marvis: each server runs as a command, or is reached at a URL. They’re kept in your{' '}
        <Code>~/.agent/.mcp.json</Code> and the project’s <Code>.mcp.json</Code> — the project’s wins when both name one.
        Open sessions take a change up before their next message, connecting only the servers that changed — and, after a
        sign-in, those that had failed.
      </SectionIntro>
      <Problems problems={data.problems} />
      <Card
        label="MCP servers"
        title="MCP servers"
        aside={
          form !== 'add' && (
            <Button size="xs" variant="outline" onClick={() => setForm('add')}>
              <Plus />
              Add server
            </Button>
          )
        }
      >
        {form === 'add' && (
          <div className="mb-3">
            <ServerForm
              workspaceId={workspaceId}
              projectName={projectName}
              onSaved={(view, scope, names) => saved(view, scope, names)}
              onProgress={set}
              onCancel={() => setForm(null)}
            />
          </div>
        )}
        {data.servers.length === 0 ? (
          form !== 'add' && (
            <p className="text-xs text-muted-foreground">
              None yet. Add one — a server’s docs usually give the JSON to paste.
            </p>
          )
        ) : (
          <ul className="flex flex-col divide-y">
            {data.servers.map((s) => {
              const key = keyOf(s.scope, s.name);
              return (
                <li key={key} className={cn('flex flex-col gap-1.5 py-2 first:pt-0 last:pb-0')}>
                  <Server
                    server={s}
                    waitingAt={waiting[s.name]}
                    error={failed[s.name]}
                    test={tests[key]}
                    editing={form === key}
                    onLogin={() => void login(s.name)}
                    onLogout={() => void logout(s.name)}
                    onTest={() => void test(s.scope, s.name)}
                    onEdit={() => setForm(key)}
                    onDelete={() => remove(s.scope, s.name)}
                  />
                  {form === key && (
                    <ServerForm
                      workspaceId={workspaceId}
                      projectName={projectName}
                      editing={{ scope: s.scope, name: s.name }}
                      onSaved={(view, scope, names) => saved(view, scope, names, s.name)}
                      onProgress={set}
                      onCancel={() => setForm(null)}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <div className="mt-3 flex flex-col gap-0.5 pt-1">
          <PathNote path={data.userPath} />
          <PathNote path={data.projectPath} />
        </div>
      </Card>
    </div>
  );
}

function Server({
  server: s,
  waitingAt,
  error,
  test,
  editing,
  onLogin,
  onLogout,
  onTest,
  onEdit,
  onDelete,
}: {
  server: McpServerInfo;
  waitingAt: string | undefined;
  error: string | undefined;
  test: Test | undefined;
  editing: boolean;
  onLogin: () => void;
  onLogout: () => void;
  onTest: () => void;
  onEdit: () => void;
  onDelete: () => Promise<void>;
}) {
  return (
    <div className="group/server flex flex-col gap-1 text-xs">
      <div className="flex items-center gap-2">
        <Plug className={cn('size-3.5 shrink-0 text-muted-foreground', s.shadowed && 'opacity-60')} />
        <span className={cn('shrink-0 font-mono font-medium', s.shadowed && 'opacity-60')}>{s.name}</span>
        <span className="shrink-0 rounded bg-muted px-1 text-[11px] text-muted-foreground">
          {s.scope === 'user' ? 'yours' : 'project'} · {s.transport}
        </span>
        <span
          className={cn('min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground', s.shadowed && 'opacity-60')}
          title={s.target}
        >
          {s.target}
        </span>
        {!editing && (
          <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/server:opacity-100 focus-within:opacity-100">
            {!s.shadowed && (
              <Button size="xs" variant="ghost" onClick={onTest} disabled={test === 'running'} title="Connect as a session would, and list its tools">
                Test
              </Button>
            )}
            <Button size="icon-xs" variant="ghost" aria-label={`Edit ${s.name}`} title="Edit" onClick={onEdit}>
              <Pencil />
            </Button>
            <DeleteButton name={s.name} onDelete={onDelete} />
          </span>
        )}
        <span className="flex shrink-0 items-center gap-1.5">
          {s.shadowed ? (
            <span className="text-[11px] text-muted-foreground">the project’s is used</span>
          ) : s.auth === 'header' ? (
            <span className="text-[11px] text-muted-foreground" title="An Authorization header set in .mcp.json">
              signs in with a header
            </span>
          ) : s.auth === 'oauth' ? (
            waitingAt ? (
              <>
                <LoaderCircle className="size-3 animate-spin text-primary" />
                <span className="text-[11px] text-muted-foreground">waiting for the browser</span>
                <a
                  href={waitingAt}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-0.5 text-[11px] text-primary hover:underline"
                >
                  open it again
                  <ExternalLink className="size-3" />
                </a>
              </>
            ) : s.signedIn ? (
              <>
                <span className="flex items-center gap-1 text-[11px] text-success">
                  <Check className="size-3" />
                  signed in
                </span>
                <Button size="xs" variant="ghost" onClick={onLogout}>
                  Sign out
                </Button>
              </>
            ) : (
              <Button size="xs" variant="outline" onClick={onLogin}>
                Sign in
              </Button>
            )
          ) : null}
        </span>
      </div>
      {error && <ErrorLine error={error} />}
      {test && <TestLine test={test} />}
    </div>
  );
}

/** What trying a server found: its tools, folded; or why it couldn't be reached. */
function TestLine({ test }: { test: Test }) {
  const [open, setOpen] = useState(false);
  if (test === 'running') {
    return (
      <p className="flex items-center gap-1.5 pl-[22px] text-[11px] text-muted-foreground">
        <LoaderCircle className="size-3 animate-spin" />
        Connecting…
      </p>
    );
  }
  if (!test.ok) {
    return (
      <p className={cn('flex items-start gap-1.5 pl-[22px] text-[11px]', test.needsAuth ? 'text-warning' : 'text-destructive')}>
        <TriangleAlert className="mt-px size-3 shrink-0" />
        <span className="min-w-0 break-words">
          {test.needsAuth ? 'It needs signing in: Sign in, then test it again.' : `Couldn’t connect: ${test.error}`}
        </span>
      </p>
    );
  }
  const n = test.tools.length;
  return (
    <div className="flex flex-col gap-1 pl-[22px]">
      <button
        type="button"
        aria-expanded={open}
        disabled={n === 0}
        onClick={() => setOpen((o) => !o)}
        className="flex w-fit items-center gap-1 text-[11px] text-success disabled:cursor-default"
      >
        <Check className="size-3" />
        Connected · {n === 0 ? 'no tools' : `${n} tool${n === 1 ? '' : 's'}`}
        {n > 0 && <ChevronRight className={cn('size-3 text-muted-foreground transition-transform', open && 'rotate-90')} />}
      </button>
      {open && (
        <ul className="flex flex-col gap-0.5 rounded-md bg-background px-2 py-1.5">
          {test.tools.map((t) => (
            <li key={t.name} className="flex min-w-0 gap-2 text-[11px]">
              <span className="shrink-0 font-mono">{t.name}</span>
              {t.description && (
                <span className="truncate text-muted-foreground" title={t.description}>
                  {t.description}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface Row {
  id: number;
  key: string;
  value: string;
  /** Saved as `null`: the file's value, never sent to the page. */
  kept: boolean;
}

let rowIds = 0;
function rowsOf(values: Record<string, string | null> | undefined): Row[] {
  return Object.entries(values ?? {}).map(([key, value]) => ({ id: ++rowIds, key, value: value ?? '', kept: value === null }));
}

function valuesOf(rows: readonly Row[], what: string): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const r of rows) {
    const key = r.key.trim();
    if (key === '' && r.value === '' && !r.kept) continue;
    if (key === '') throw new Error(`A ${what} needs a name`);
    if (Object.hasOwn(out, key)) throw new Error(`Two ${what}s are named ${key}`);
    out[key] = r.kept ? null : r.value;
  }
  return out;
}

const PASTE_EXAMPLE = `{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    }
  }
}`;

/**
 * Add a server — filled in, or pasted as JSON, one or several — or change
 * one. Env and header values the file has as literals aren't shown: left
 * as they are, they stay.
 */
function ServerForm({
  workspaceId,
  projectName,
  editing,
  onSaved,
  onProgress,
  onCancel,
}: {
  workspaceId: string;
  projectName: string;
  /** The server changed, when not adding one. */
  editing?: { scope: Scope; name: string };
  onSaved: (view: McpView, scope: Scope, names: string[]) => void;
  /** Some of several pasted were added before one couldn't be. */
  onProgress: (view: McpView) => void;
  onCancel: () => void;
}) {
  const sync = useSync();
  const [loaded, setLoaded] = useState(!editing);
  const [how, setHow] = useState<'form' | 'json'>('form');
  const [scope, setScope] = useState<Scope>(editing?.scope ?? 'user');
  const [name, setName] = useState(editing?.name ?? '');
  const [transport, setTransport] = useState<McpServerEntry['transport']>('stdio');
  const [commandLine, setCommandLine] = useState('');
  const [env, setEnv] = useState<Row[]>([]);
  const [url, setUrl] = useState('');
  const [headers, setHeaders] = useState<Row[]>([]);
  const [auth, setAuth] = useState<'' | 'oauth' | 'none'>('');
  const [json, setJson] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const editingRef = useRef(editing);

  useEffect(() => {
    const target = editingRef.current;
    if (!target) return;
    let cancelled = false;
    sync.settingsCall('mcp.get', { workspaceId, scope: target.scope, name: target.name }).then(
      (entry) => {
        if (cancelled) return;
        setTransport(entry.transport);
        setCommandLine(entry.command !== undefined ? joinCommandLine([entry.command, ...(entry.args ?? [])]) : '');
        setEnv(rowsOf(entry.env));
        setUrl(entry.url ?? '');
        setHeaders(rowsOf(entry.headers));
        setAuth(entry.auth ?? '');
        setLoaded(true);
      },
      (err: unknown) => !cancelled && setError(errorText(err)),
    );
    return () => {
      cancelled = true;
    };
  }, [sync, workspaceId]);

  const fromForm = (): McpServerEntry => {
    const n = name.trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(n)) throw new Error('Name it with letters, digits, - and _ (up to 64)');
    if (transport === 'stdio') {
      const words = splitCommandLine(commandLine);
      if (words.length === 0) throw new Error('Give the command it runs');
      return { name: n, transport, command: words[0]!, ...(words.length > 1 ? { args: words.slice(1) } : {}), env: valuesOf(env, 'variable') };
    }
    if (url.trim() === '') throw new Error('Give its URL');
    return { name: n, transport, url: url.trim(), headers: valuesOf(headers, 'header'), ...(auth ? { auth } : {}) };
  };

  const save = async (): Promise<void> => {
    setError(null);
    let servers: McpServerEntry[];
    try {
      servers = how === 'json' ? parseMcpJson(json) : [fromForm()];
    } catch (err) {
      setError(errorText(err));
      return;
    }
    setBusy(true);
    let view: McpView | undefined;
    const done: string[] = [];
    try {
      for (const server of servers) {
        view = await sync.settingsCall('mcp.save', { workspaceId, scope, server, ...(editing ? { previousName: editing.name } : {}) });
        done.push(server.name);
      }
      onSaved(view!, scope, done);
    } catch (err) {
      const which = servers.length > 1 ? `${servers[done.length]!.name}: ` : '';
      setError(`${done.length > 0 ? `Added ${done.join(', ')}. ` : ''}${which}${errorText(err)}`);
      if (view) onProgress(view);
      if (done.length > 0 && how === 'json') {
        // What's left to add, to fix and add again.
        const left = servers.slice(done.length);
        setJson(JSON.stringify({ mcpServers: Object.fromEntries(left.map(({ name: n, ...rest }) => [n, rest])) }, null, 2));
      }
    } finally {
      setBusy(false);
    }
  };

  const disabled = busy || !loaded;
  return (
    <form
      aria-label={editing ? `Edit ${editing.name}` : 'Add an MCP server'}
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
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {!editing && (
          <Segmented
            label="How"
            value={how}
            onChange={setHow}
            disabled={busy}
            options={[
              { id: 'form', label: 'Fill in' },
              { id: 'json', label: 'Paste JSON' },
            ]}
          />
        )}
        {editing ? (
          <span className="text-[11px] text-muted-foreground">
            In {scope === 'user' ? 'your' : 'the project’s'} <Code>.mcp.json</Code>
          </span>
        ) : (
          <Segmented
            label="Where"
            value={scope}
            onChange={setScope}
            disabled={busy}
            options={[
              { id: 'user', label: 'Yours · every project' },
              { id: 'project', label: `This project · ${projectName}` },
            ]}
          />
        )}
      </div>

      {how === 'json' ? (
        <Field label="JSON" hint="as a server’s docs give it for Claude Code, Cursor or VS Code — one server or several">
          <textarea
            autoFocus
            value={json}
            onChange={(e) => setJson(e.target.value)}
            placeholder={PASTE_EXAMPLE}
            rows={9}
            spellCheck={false}
            disabled={busy}
            className="w-full resize-y rounded-md bg-subtle p-2 font-mono text-xs leading-relaxed outline-none placeholder:text-faint focus-visible:ring-2 focus-visible:ring-ring/40"
          />
        </Field>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Name" className="w-44">
              <input
                autoFocus={!editing}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="filesystem"
                spellCheck={false}
                autoComplete="off"
                disabled={disabled}
                className={FIELD}
              />
            </Field>
            <div className="flex flex-col gap-1">
              <span className="text-[11px] font-medium text-muted-foreground">Runs as</span>
              <Segmented
                label="Runs as"
                value={transport}
                onChange={setTransport}
                disabled={disabled}
                options={[
                  { id: 'stdio', label: 'A command' },
                  { id: 'http', label: 'HTTP' },
                  { id: 'sse', label: 'SSE' },
                ]}
              />
            </div>
          </div>
          {transport === 'stdio' ? (
            <>
              <Field label="Command" hint="as you’d type it in a terminal; it runs in the project’s folder">
                <input
                  value={commandLine}
                  onChange={(e) => setCommandLine(e.target.value)}
                  placeholder="npx -y @modelcontextprotocol/server-filesystem ."
                  spellCheck={false}
                  autoComplete="off"
                  disabled={disabled}
                  className={FIELD}
                />
              </Field>
              <ValueRows label="Environment" what="variable" rows={env} onChange={setEnv} keyPlaceholder="API_KEY" disabled={disabled} />
            </>
          ) : (
            <>
              <Field label="URL">
                <input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder={transport === 'sse' ? 'https://mcp.example.com/sse' : 'https://mcp.example.com/mcp'}
                  spellCheck={false}
                  autoComplete="off"
                  disabled={disabled}
                  className={FIELD}
                />
              </Field>
              <ValueRows label="Headers" what="header" rows={headers} onChange={setHeaders} keyPlaceholder="Authorization" valuePlaceholder="Bearer ${API_TOKEN}" disabled={disabled} />
              <div className="flex flex-col gap-1">
                <span className="text-[11px] font-medium text-muted-foreground">Signs in</span>
                <Segmented
                  label="Signs in"
                  value={auth === '' ? 'auto' : auth}
                  onChange={(v) => setAuth(v === 'auto' ? '' : v)}
                  disabled={disabled}
                  options={[
                    { id: 'auto', label: 'OAuth, unless a header authorizes' },
                    { id: 'oauth', label: 'OAuth' },
                    { id: 'none', label: 'Headers only' },
                  ]}
                />
              </div>
            </>
          )}
        </>
      )}

      {scope === 'project' && (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          The project’s <Code>.mcp.json</Code> is usually committed: keep a secret out of it as <Code>{'${VAR}'}</Code>, set in the
          project’s <Code>.env</Code> or your <Code>~/.agent/.env</Code>.
        </p>
      )}

      <div className="flex items-center gap-2">
        <ErrorLine error={error} />
        <span className="flex-1" />
        <Button type="button" size="xs" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="xs" disabled={disabled || (how === 'json' && json.trim() === '')}>
          {busy && <LoaderCircle className="animate-spin" />}
          {editing ? 'Save' : 'Add'}
        </Button>
      </div>
    </form>
  );
}

/** Named values — env variables, headers — a row each, with one to add. */
function ValueRows({
  label,
  what,
  rows,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
  disabled,
}: {
  label: string;
  what: string;
  rows: Row[];
  onChange: (rows: Row[]) => void;
  keyPlaceholder: string;
  valuePlaceholder?: string;
  disabled?: boolean;
}) {
  const update = (id: number, patch: Partial<Row>): void => onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] font-medium text-muted-foreground">
        {label}
        <span className="font-normal text-faint"> · a secret is best a {'${VAR}'}, set in an .env</span>
      </span>
      {rows.map((r, i) => (
        <div key={r.id} className="flex items-center gap-1.5">
          <input
            aria-label={`${label} ${i + 1} name`}
            value={r.key}
            onChange={(e) => update(r.id, { key: e.target.value })}
            placeholder={keyPlaceholder}
            spellCheck={false}
            autoComplete="off"
            disabled={disabled}
            className={cn(FIELD, 'w-[38%]')}
          />
          <input
            aria-label={`${label} ${i + 1} value`}
            value={r.value}
            onChange={(e) => update(r.id, { value: e.target.value, kept: false })}
            placeholder={r.kept ? 'set — type to replace it' : valuePlaceholder}
            spellCheck={false}
            autoComplete="off"
            disabled={disabled}
            className={cn(FIELD, 'flex-1')}
          />
          <button
            type="button"
            aria-label={`Remove ${r.key || what}`}
            title="Remove"
            disabled={disabled}
            onClick={() => onChange(rows.filter((x) => x.id !== r.id))}
            className="rounded p-0.5 text-muted-foreground hover:text-destructive"
          >
            <X className="size-[13px]" />
          </button>
        </div>
      ))}
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange([...rows, { id: ++rowIds, key: '', value: '', kept: false }])}
        className="flex w-fit items-center gap-1 rounded px-0.5 text-[11px] text-muted-foreground hover:text-foreground"
      >
        <Plus className="size-3" />
        Add a {what}
      </button>
    </div>
  );
}
