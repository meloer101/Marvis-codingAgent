import { useState } from 'react';

import { useSync } from '@/lib/syncContext';
import { cn } from '@/lib/utils';

import { Card, ErrorLine, Problems, SectionIntro, errorText, useLoaded } from './common';

/**
 * Tools that change what the model is shown, so they're off until turned on
 * — for now, background commands. Sessions started afterwards have them.
 */
export function ToolsSection({ workspaceId }: { workspaceId: string }) {
  const sync = useSync();
  const { data, error, set } = useLoaded(() => sync.settingsCall('settings.get', { workspaceId }), workspaceId);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!data) return error ? <ErrorLine error={error} /> : <p className="text-xs text-muted-foreground">Reading the settings…</p>;

  const { user, project } = data.backgroundProcesses;
  const toggle = async (): Promise<void> => {
    setBusy(true);
    try {
      set(await sync.settingsCall('settings.setBackgroundProcesses', { workspaceId, enabled: !user }));
      setFailed(null);
    } catch (err) {
      setFailed(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-4">
      <SectionIntro title="Tools">
        These change the tools the model is shown, so they stay off until you turn them on. A session keeps the tools it
        started with: one started afterwards is the first to have the change.
      </SectionIntro>
      <Problems problems={data.problems} />
      <Card label="Background commands" title="Background commands" path={data.user.path}>
        <div className="flex items-start gap-4">
          <p className="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground">
            The agent can start a command — a dev server, a watcher, a long build — and leave it running:{' '}
            <code className="font-mono">bash</code> takes <code className="font-mono">run_in_background</code>, and{' '}
            <code className="font-mono">bash_output</code> and <code className="font-mono">bash_kill</code> read and
            stop it. The session’s Processes tab shows each one, and stops it too.
            {project && <span className="mt-1 block text-foreground">On in this project’s settings, whatever yours say.</span>}
          </p>
          <button
            type="button"
            role="switch"
            aria-checked={user}
            aria-label="Background commands"
            disabled={busy}
            onClick={() => void toggle()}
            className={cn(
              'relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none disabled:opacity-60',
              user ? 'bg-ink' : 'bg-border-strong',
            )}
          >
            <span
              className={cn(
                'absolute top-0.5 left-0.5 size-4 rounded-full bg-background shadow-xs transition-transform',
                user && 'translate-x-4',
              )}
            />
          </button>
        </div>
        <ErrorLine error={failed} />
      </Card>
    </div>
  );
}
