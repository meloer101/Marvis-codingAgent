import { useEffect, useState } from 'react';
import { Check, ExternalLink, LoaderCircle, Plug } from 'lucide-react';

import type { McpServerInfo } from '@harness-code/protocol';

import { Button } from '@/components/ui/button';
import { platform } from '@/platform';
import { useSync } from '@/lib/syncContext';
import { cn } from '@/lib/utils';

import { Card, ErrorLine, PathNote, Problems, errorText, useLoaded } from './common';

/**
 * The MCP servers sessions here connect to, as their files name them, and
 * signing in to the ones that use OAuth: the page to authorize at opens in a
 * new tab, and the list follows once it's done.
 */
export function McpSection({ workspaceId }: { workspaceId: string }) {
  const sync = useSync();
  const { data, error, set, reload } = useLoaded(() => sync.settingsCall('mcp.list', { workspaceId }), workspaceId);
  /** Sign-ins waiting on the browser: the server's name → the page to authorize at. */
  const [waiting, setWaiting] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<Record<string, string>>({});

  useEffect(
    () =>
      sync.onMcpLogin((event) => {
        if (event.workspaceId !== workspaceId) return;
        setWaiting(({ [event.name]: _, ...rest }) => rest);
        setFailed(({ [event.name]: _, ...rest }) => (event.error ? { ...rest, [event.name]: event.error } : rest));
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

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs leading-relaxed text-muted-foreground">
        Servers come from your <code className="font-mono">~/.agent/.mcp.json</code> and the project’s{' '}
        <code className="font-mono">.mcp.json</code>; the project’s wins when both name one. Sessions connect as they start,
        so one started after signing in is the first to use it.
      </p>
      <Problems problems={data.problems} />
      <Card label="MCP servers" title="MCP servers">
        {data.servers.length === 0 ? (
          <p className="text-xs text-muted-foreground">None configured.</p>
        ) : (
          <ul className="flex flex-col divide-y">
            {data.servers.map((s) => (
              <Server
                key={`${s.scope}:${s.name}`}
                server={s}
                waitingAt={waiting[s.name]}
                error={failed[s.name]}
                onLogin={() => void login(s.name)}
                onLogout={() => void logout(s.name)}
              />
            ))}
          </ul>
        )}
        <div className="mt-3 flex flex-col gap-0.5 border-t pt-2">
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
  onLogin,
  onLogout,
}: {
  server: McpServerInfo;
  waitingAt: string | undefined;
  error: string | undefined;
  onLogin: () => void;
  onLogout: () => void;
}) {
  return (
    <li className={cn('flex flex-col gap-1 py-2 text-xs first:pt-0 last:pb-0', s.shadowed && 'opacity-60')}>
      <div className="flex items-center gap-2">
        <Plug className="size-3.5 shrink-0 text-brass" />
        <span className="shrink-0 font-mono font-medium">{s.name}</span>
        <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">
          {s.scope === 'user' ? 'yours' : 'project'} · {s.transport}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground" title={s.target}>
          {s.target}
        </span>
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
    </li>
  );
}
