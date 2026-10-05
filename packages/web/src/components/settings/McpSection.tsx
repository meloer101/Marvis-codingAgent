import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, ChevronRight, ExternalLink, LoaderCircle, MoreHorizontal, Plus, TriangleAlert, X } from 'lucide-react';

import type { McpServerEntry, McpServerInfo, McpTestResult, McpView } from '@harness-code/protocol';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { DropdownActions } from '@/components/ui/menu';
import type { MenuAction } from '@/components/ui/menu';
import { CATALOG, catalogAt, connectorHint, connectorName, transportOf } from '@/lib/mcpCatalog';
import type { CatalogConnector } from '@/lib/mcpCatalog';
import { joinCommandLine, parseMcpJson, splitCommandLine } from '@/lib/mcpEntry';
import { platform } from '@/platform';
import { useSync } from '@/lib/syncContext';
import { cn } from '@/lib/utils';

import { Card, Code, ErrorLine, FIELD, Field, PathNote, Problems, SectionIntro, Segmented, errorText, useLoaded } from './common';

type Scope = 'user' | 'project';

/** What's known of a connector: being tried, connected, wanting a sign-in (perhaps in the browser now), or not reached. */
type Status =
  | { kind: 'checking' }
  | { kind: 'connected'; tools: Array<{ name: string; description?: string }> }
  | { kind: 'sign-in'; error?: string }
  | { kind: 'waiting'; url: string }
  | { kind: 'failed'; error: string };

type DialogState = { kind: 'add' } | { kind: 'advanced' } | { kind: 'edit'; scope: Scope; name: string };

const keyOf = (scope: Scope, name: string): string => `${scope}:${name}`;

/**
 * Connectors — the MCP servers sessions here connect to — as Claude's
 * settings show them: what's connected, each tried as the page opens; a
 * catalog that adds one in a click and opens the browser when it signs in;
 * and any other by its URL, signed in to at once when it asks. A command
 * to run, headers, JSON from a server's docs or the project's own file are
 * one step further, in the same dialog.
 */
export function McpSection({ workspaceId, projectName }: { workspaceId: string; projectName: string }) {
  const sync = useSync();
  const { data, error, set, reload } = useLoaded(() => sync.settingsCall('mcp.list', { workspaceId }), workspaceId);
  const [status, setStatus] = useState<Record<string, Status>>({});
  const [dialog, setDialog] = useState<DialogState | null>(null);
  /** Catalog connectors being added (`null`), or why one couldn't be. */
  const [adding, setAdding] = useState<Record<string, string | null>>({});
  /** Servers already tried (or being signed in to), so the list coming back doesn't try them again. */
  const tried = useRef(new Set<string>());
  const servers = useRef<McpServerInfo[]>([]);
  servers.current = data?.servers ?? [];

  const put = useCallback((key: string, s: Status | undefined) => {
    setStatus(({ [key]: _, ...rest }) => (s ? { ...rest, [key]: s } : rest));
  }, []);

  const check = useCallback(
    async (scope: Scope, name: string): Promise<McpTestResult> => {
      const key = keyOf(scope, name);
      tried.current.add(key);
      put(key, { kind: 'checking' });
      let result: McpTestResult;
      try {
        result = await sync.settingsCall('mcp.test', { workspaceId, scope, name });
      } catch (err) {
        result = { ok: false, error: errorText(err) };
      }
      put(
        key,
        result.ok
          ? { kind: 'connected', tools: result.tools }
          : result.needsAuth
            ? { kind: 'sign-in' }
            : { kind: 'failed', error: result.error },
      );
      return result;
    },
    [sync, workspaceId, put],
  );

  const signIn = useCallback(
    async (scope: Scope, name: string): Promise<void> => {
      const key = keyOf(scope, name);
      tried.current.add(key);
      try {
        const result = await sync.settingsCall('mcp.login', { workspaceId, name });
        if ('url' in result) {
          put(key, { kind: 'waiting', url: result.url });
          platform.openExternal(result.url);
        } else {
          reload();
          void check(scope, name);
        }
      } catch (err) {
        put(key, { kind: 'sign-in', error: errorText(err) });
      }
    },
    [sync, workspaceId, put, reload, check],
  );

  // Each connector is tried as it first shows up: the list says what's
  // configured, only connecting says whether it works.
  useEffect(() => {
    for (const s of data?.servers ?? []) {
      if (!s.shadowed && !tried.current.has(keyOf(s.scope, s.name))) void check(s.scope, s.name);
    }
  }, [data, check]);

  useEffect(
    () =>
      sync.onMcpLogin((event) => {
        if (event.workspaceId !== workspaceId) return;
        const s = servers.current.find((x) => x.name === event.name && !x.shadowed);
        if (!s) return reload();
        if (event.error) return put(keyOf(s.scope, s.name), { kind: 'sign-in', error: event.error });
        reload();
        void check(s.scope, s.name);
      }),
    [sync, workspaceId, reload, check, put],
  );

  if (!data) return error ? <ErrorLine error={error} /> : <p className="text-xs text-muted-foreground">Reading your connectors…</p>;

  const forget = (scope: Scope, name: string): void => {
    tried.current.delete(keyOf(scope, name));
    put(keyOf(scope, name), undefined);
  };

  const addFromCatalog = async (c: CatalogConnector): Promise<void> => {
    setAdding((a) => ({ ...a, [c.id]: null }));
    try {
      const view = await sync.settingsCall('mcp.save', {
        workspaceId,
        scope: 'user',
        server: { name: c.id, transport: c.transport, url: c.url, headers: {} },
      });
      // Tried below, not by the list coming back.
      tried.current.add(keyOf('user', c.id));
      set(view);
      setAdding(({ [c.id]: _, ...rest }) => rest);
      if (c.signIn) await signIn('user', c.id);
      else await check('user', c.id);
    } catch (err) {
      setAdding((a) => ({ ...a, [c.id]: errorText(err) }));
    }
  };

  /** Saved from the dialog: tried at once, and — added by URL — signed in to straight away when it asks. */
  const saved = (view: McpView, scope: Scope, names: string[], opts: { previous?: string; signIn?: boolean } = {}): void => {
    if (opts.previous !== undefined) forget(scope, opts.previous);
    for (const name of names) tried.current.add(keyOf(scope, name));
    set(view);
    setDialog(null);
    for (const name of names) {
      void check(scope, name).then((result) => {
        if (opts.signIn && !result.ok && result.needsAuth) void signIn(scope, name);
      });
    }
  };

  const remove = async (s: McpServerInfo): Promise<void> => {
    set(await sync.settingsCall('mcp.remove', { workspaceId, scope: s.scope, name: s.name }));
    forget(s.scope, s.name);
  };
  const signOut = async (s: McpServerInfo): Promise<void> => {
    set(await sync.settingsCall('mcp.logout', { workspaceId, name: s.name }));
    void check(s.scope, s.name);
  };

  const added = (c: CatalogConnector): boolean => data.servers.some((s) => catalogAt(s.target)?.id === c.id);

  return (
    <div className="flex flex-col gap-4">
      <SectionIntro title="Connectors">
        Let Marvis use the tools you work in — docs, issues, designs. Each connector is an MCP server; open sessions take
        up a change before their next message.
      </SectionIntro>
      <Problems problems={data.problems} />
      <Card
        label="Your connectors"
        title="Your connectors"
        aside={
          <Button size="xs" variant="outline" onClick={() => setDialog({ kind: 'add' })}>
            <Plus />
            Add connector
          </Button>
        }
      >
        {data.servers.length === 0 ? (
          <p className="text-xs text-muted-foreground">None yet — pick one below, or add any MCP server by its URL.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {data.servers.map((s) => (
              <ConnectorRow
                key={keyOf(s.scope, s.name)}
                server={s}
                status={status[keyOf(s.scope, s.name)]}
                onSignIn={() => void signIn(s.scope, s.name)}
                onCheck={() => void check(s.scope, s.name)}
                onSignOut={() => void signOut(s)}
                onEdit={() => setDialog({ kind: 'edit', scope: s.scope, name: s.name })}
                onRemove={() => remove(s)}
              />
            ))}
          </ul>
        )}
      </Card>
      <Card label="Discover" title="Discover" aside={<span className="text-[11px] text-faint">added for every project</span>}>
        <ul className="grid grid-cols-1 gap-1.5 @lg:grid-cols-2">
          {CATALOG.map((c) => (
            <CatalogTile
              key={c.id}
              connector={c}
              added={added(c)}
              adding={adding[c.id] === null}
              error={adding[c.id] ?? null}
              onAdd={() => void addFromCatalog(c)}
            />
          ))}
        </ul>
      </Card>
      <div className="flex flex-col gap-0.5 px-1">
        <PathNote path={data.userPath} />
        <PathNote path={data.projectPath} />
      </div>
      <Dialog open={dialog !== null} onOpenChange={(open) => !open && setDialog(null)}>
        {dialog?.kind === 'add' && (
          <AddByUrl
            workspaceId={workspaceId}
            taken={data.servers.filter((s) => s.scope === 'user').map((s) => s.name)}
            onSaved={(view, name) => saved(view, 'user', [name], { signIn: true })}
            onAdvanced={() => setDialog({ kind: 'advanced' })}
          />
        )}
        {(dialog?.kind === 'advanced' || dialog?.kind === 'edit') && (
          <DialogContent
            title={dialog.kind === 'edit' ? `Edit ${dialog.name}` : 'Add a connector'}
            description={
              dialog.kind === 'edit'
                ? undefined
                : 'A command to run, a URL with headers, or the JSON a server’s docs give.'
            }
            className="max-w-xl"
          >
            <ServerForm
              workspaceId={workspaceId}
              projectName={projectName}
              {...(dialog.kind === 'edit' ? { editing: { scope: dialog.scope, name: dialog.name } } : {})}
              onSaved={(view, scope, names) =>
                saved(view, scope, names, dialog.kind === 'edit' ? { previous: dialog.name } : {})
              }
              onProgress={set}
              onCancel={() => setDialog(null)}
            />
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}

/** A connector's tile: the catalog's colour and initial, or a grey one with the server's. */
function Tile({ name, color }: { name: string; color?: string | undefined }) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex size-7 shrink-0 items-center justify-center rounded-md text-[13px] font-semibold',
        // A dark brand colour (Notion's) would sink into the dark theme's fill.
        color ? 'text-white dark:ring-1 dark:ring-white/15 dark:ring-inset' : 'bg-muted text-muted-foreground',
      )}
      style={color ? { backgroundColor: color } : undefined}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

function ConnectorRow({
  server: s,
  status,
  onSignIn,
  onCheck,
  onSignOut,
  onEdit,
  onRemove,
}: {
  server: McpServerInfo;
  status: Status | undefined;
  onSignIn: () => void;
  onCheck: () => void;
  onSignOut: () => void;
  onEdit: () => void;
  onRemove: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const known = catalogAt(s.target);
  const hint = connectorHint(s.target);
  const actions: MenuAction[] = [
    ...(s.shadowed ? [] : [{ label: 'Check again', onSelect: onCheck }]),
    ...(s.signedIn ? [{ label: 'Sign out', onSelect: onSignOut }] : []),
    { label: 'Edit…', onSelect: onEdit },
    {
      label: 'Remove',
      destructive: true,
      separated: true,
      onSelect: () => void onRemove().then(() => setRemoveError(null), (err: unknown) => setRemoveError(errorText(err))),
    },
  ];
  const tools = status?.kind === 'connected' ? status.tools : [];
  const problem = status?.kind === 'failed' ? status.error : status?.kind === 'sign-in' ? status.error : removeError ?? undefined;

  return (
    <li className={cn('flex flex-col rounded-md bg-background', s.shadowed && 'opacity-60')}>
      <div className="flex min-h-12 items-center gap-3 px-3 py-2">
        <Tile name={known?.name ?? s.name} color={known?.color} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            <span className="truncate text-[13px] font-medium">{known?.name ?? s.name}</span>
            {s.scope === 'project' && <span className="shrink-0 text-[11px] text-faint">this project</span>}
          </div>
          <p
            className={cn('truncate text-xs text-faint', !known && 'font-mono text-[11px]')}
            title={known ? undefined : s.target}
          >
            {known?.description ?? s.target}
          </p>
        </div>
        <span className="flex shrink-0 items-center gap-2 text-xs">
          {s.shadowed ? (
            <span className="text-faint">the project’s is used</span>
          ) : !status || status.kind === 'checking' ? (
            <span className="flex items-center gap-1.5 text-faint">
              <LoaderCircle className="size-3 animate-spin" />
              Checking…
            </span>
          ) : status.kind === 'connected' ? (
            <button
              type="button"
              aria-expanded={open}
              disabled={tools.length === 0}
              onClick={() => setOpen((o) => !o)}
              className="flex items-center gap-1 text-success disabled:cursor-default"
            >
              <Check className="size-3" />
              Connected · {tools.length === 0 ? 'no tools' : `${tools.length} tool${tools.length === 1 ? '' : 's'}`}
              {tools.length > 0 && (
                <ChevronRight className={cn('size-3 text-faint transition-transform', open && 'rotate-90')} />
              )}
            </button>
          ) : status.kind === 'sign-in' ? (
            <>
              <span className="text-warning">Needs sign-in</span>
              <Button size="xs" onClick={onSignIn}>
                Sign in
              </Button>
            </>
          ) : status.kind === 'waiting' ? (
            <>
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <LoaderCircle className="size-3 animate-spin text-primary" />
                Finish signing in in your browser
              </span>
              <a
                href={status.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-0.5 text-primary hover:underline"
              >
                Open again
                <ExternalLink className="size-3" />
              </a>
            </>
          ) : (
            <span className="flex items-center gap-1 text-destructive">
              <TriangleAlert className="size-3" />
              Couldn’t connect
            </span>
          )}
          <DropdownActions
            label={`More for ${known?.name ?? s.name}`}
            actions={actions}
            trigger={
              <Button size="icon-xs" variant="ghost" className="text-muted-foreground">
                <MoreHorizontal />
              </Button>
            }
          />
        </span>
      </div>
      {problem && (
        <p className="-mt-1 px-3 pb-2.5 pl-[52px] text-[11px] leading-relaxed break-words text-destructive">
          {problem}
          {status?.kind === 'failed' && hint && <span className="block text-muted-foreground">{hint}</span>}
        </p>
      )}
      {open && tools.length > 0 && (
        <ul className="flex flex-col gap-0.5 px-3 pb-2.5 pl-[52px]">
          {tools.map((t) => (
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
    </li>
  );
}

function CatalogTile({
  connector: c,
  added,
  adding,
  error,
  onAdd,
}: {
  connector: CatalogConnector;
  added: boolean;
  adding: boolean;
  error: string | null;
  onAdd: () => void;
}) {
  return (
    <li className="flex flex-col gap-1 rounded-md bg-background px-3 py-2.5">
      <div className="flex items-start gap-3">
        <Tile name={c.name} color={c.color} />
        <div className="min-w-0 flex-1">
          <span className="text-[13px] font-medium">{c.name}</span>
          <p className="text-xs leading-snug text-muted-foreground">{c.description}</p>
        </div>
        {added ? (
          <span className="flex h-6 shrink-0 items-center gap-1 text-xs text-success">
            <Check className="size-3" />
            Added
          </span>
        ) : (
          <Button
            size="icon-xs"
            variant="secondary"
            aria-label={`Add ${c.name}`}
            title={c.signIn ? 'Add, then sign in' : 'Add'}
            disabled={adding}
            onClick={onAdd}
          >
            {adding ? <LoaderCircle className="animate-spin" /> : <Plus />}
          </Button>
        )}
      </div>
      {error && <p className="pl-10 text-[11px] text-destructive">{error}</p>}
    </li>
  );
}

/**
 * Add a connector by its URL — all most servers need. Named after what's
 * typed, or after the URL's host; the sign-in, when it asks for one, follows
 * on its own.
 */
function AddByUrl({
  workspaceId,
  taken,
  onSaved,
  onAdvanced,
}: {
  workspaceId: string;
  /** Names your file has already. */
  taken: readonly string[];
  onSaved: (view: McpView, name: string) => void;
  onAdvanced: () => void;
}) {
  const sync = useSync();
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const name = connectorName(label, url);

  const submit = async (): Promise<void> => {
    setError(null);
    const target = url.trim();
    if (!/^https?:\/\/\S+$/i.test(target)) return setError('Give the server’s address: https://…');
    if (!name) return setError('Give it a name');
    if (taken.includes(name)) return setError(`You have a connector named ${name} already`);
    setBusy(true);
    try {
      const view = await sync.settingsCall('mcp.save', {
        workspaceId,
        scope: 'user',
        server: { name, transport: transportOf(target), url: target, headers: {} },
      });
      onSaved(view, name);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <DialogContent title="Add a connector" description="Connect any MCP server Marvis can reach at a URL.">
      <form
        aria-label="Add a connector"
        className="flex flex-col gap-3 px-5 pt-4 pb-5"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Server URL" hint="its docs give it">
          <input
            autoFocus
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://mcp.example.com/mcp"
            spellCheck={false}
            autoComplete="off"
            disabled={busy}
            className={cn(FIELD, 'h-8')}
          />
        </Field>
        <Field label="Name" hint="optional">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={connectorName('', url) ?? 'example'}
            spellCheck={false}
            autoComplete="off"
            disabled={busy}
            className={cn(FIELD, 'h-8 font-sans')}
          />
        </Field>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          If it asks you to sign in, your browser opens next. Add only servers you trust: their tools run with what you
          let Marvis do.
        </p>
        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            onClick={onAdvanced}
            className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            A command, headers or JSON…
          </button>
          <span className="flex-1" />
          <ErrorLine error={error} />
          <Button type="submit" size="sm" disabled={busy || url.trim() === ''}>
            {busy && <LoaderCircle className="animate-spin" />}
            Continue
          </Button>
        </div>
      </form>
    </DialogContent>
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
      className="flex min-h-0 flex-col gap-3 overflow-y-auto px-5 pt-4 pb-5"
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
