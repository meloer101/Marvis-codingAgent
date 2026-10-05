import { useEffect, useState } from 'react';
import { Check, ExternalLink, LoaderCircle, Plug } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useSync } from '@/lib/syncContext';
import { platform } from '@/platform';

type State = { kind: 'idle' } | { kind: 'waiting'; url: string } | { kind: 'done' } | { kind: 'failed'; error: string };

/**
 * A connector the session couldn't use for want of a sign-in, as the
 * transcript shows it: a Sign in button where a terminal says to run
 * `marvis mcp login` (the notice's text). Signing in connects it for the
 * open sessions before their next message.
 */
export function McpAuthNotice({ server, workspaceId }: { server: string; workspaceId: string | undefined }) {
  const sync = useSync();
  const [state, setState] = useState<State>({ kind: 'idle' });
  const waiting = state.kind === 'waiting';

  useEffect(() => {
    if (!waiting) return;
    return sync.onMcpLogin((event) => {
      if (event.workspaceId !== workspaceId || event.name !== server) return;
      setState(event.error ? { kind: 'failed', error: event.error } : { kind: 'done' });
    });
  }, [sync, workspaceId, server, waiting]);

  const signIn = async (): Promise<void> => {
    if (!workspaceId) return;
    try {
      const result = await sync.settingsCall('mcp.login', { workspaceId, name: server });
      if ('url' in result) {
        setState({ kind: 'waiting', url: result.url });
        platform.openExternal(result.url);
      } else {
        setState({ kind: 'done' });
      }
    } catch (err) {
      setState({ kind: 'failed', error: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div className="flex flex-col gap-1 text-xs">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Plug className="size-3.5 shrink-0 text-warning" />
        <span className="text-warning">
          <span className="font-medium">{server}</span> needs you to sign in before Marvis can use it.
        </span>
        {state.kind === 'waiting' ? (
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <LoaderCircle className="size-3 animate-spin text-primary" />
            Finish signing in in your browser
            <a
              href={state.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-0.5 text-primary hover:underline"
            >
              Open again
              <ExternalLink className="size-3" />
            </a>
          </span>
        ) : state.kind === 'done' ? (
          <span className="flex items-center gap-1 text-success">
            <Check className="size-3" />
            Signed in — it’s connected from your next message
          </span>
        ) : (
          workspaceId && (
            <Button size="xs" onClick={() => void signIn()}>
              Sign in
            </Button>
          )
        )}
      </div>
      {state.kind === 'failed' && <p className="pl-[22px] text-destructive">{state.error}</p>}
    </div>
  );
}
