import { useEffect, useMemo, useRef } from 'react';
import type { RefObject } from 'react';
import { Loader2 } from 'lucide-react';

import { nextPermissionMode } from '@harness-code/core/browser';
import type { PermissionMode } from '@harness-code/core';

import { Composer } from '@/components/Composer';
import { EffortPicker, ModeChip, ModelPicker } from '@/components/ComposerControls';
import { PendingDock } from '@/components/PendingDock';
import { QueuedMessages } from '@/components/QueuedMessages';
import { SessionHeader } from '@/components/SessionHeader';
import { Transcript } from '@/components/Transcript';
import { ContextButton } from '@/components/UsagePanel';
import type { SessionViewState } from '@/lib/sessionModel';
import { allCommands } from '@/lib/slash';
import { useAppStore } from '@/lib/store';
import { useSync } from '@/lib/syncContext';

const FALLBACK_MODES: readonly PermissionMode[] = ['ask', 'acceptEdits', 'plan', 'readOnly', 'yolo'];

export function SessionView({ id, onNewSession }: { id: string; onNewSession: () => void }) {
  const sync = useSync();
  const view = useAppStore((s) => s.views[id]);
  const connected = useAppStore((s) => s.status === 'open');
  const mcp = useAppStore((s) => s.slash[id]);
  const commands = useMemo(() => allCommands(mcp ?? []), [mcp]);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const requestId = view ? (view.askId ?? view.planId) : null;
  const hadRequest = useRef(false);

  useEffect(() => {
    void sync.open(id);
    return () => sync.release(id);
  }, [sync, id]);

  // Answering a prompt unmounts the dock, which drops focus to <body>; hand it
  // back to the composer so the next message can be typed straight away.
  useEffect(() => {
    if (requestId) {
      hadRequest.current = true;
      return;
    }
    if (!hadRequest.current) return;
    hadRequest.current = false;
    const active = document.activeElement;
    if (!active || active === document.body) composerRef.current?.focus();
  }, [requestId]);

  /** `/help` and `/clear` never reach the server — see lib/slash.ts. */
  const send = async (text: string): Promise<boolean> => {
    const command = /^\/(\S+)\s*$/.exec(text.trim())?.[1];
    if (command === 'help') {
      sync.setHelpOpen(true);
      return true;
    }
    if (command === 'clear') {
      onNewSession();
      return true;
    }
    return sync.send(id, text);
  };

  if (!view) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Loading session…
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <SessionHeader view={view} />
      <Transcript view={view} />
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-6 pt-2 pb-5">
        <PendingDock view={view} />
        <QueuedMessages
          queue={view.queue}
          onEdit={(queuedId) => void sync.unqueue(id, queuedId, { edit: true })}
          onRemove={(queuedId) => void sync.unqueue(id, queuedId)}
        />
        <SessionComposer view={view} onSend={send} inputRef={composerRef} commands={commands} connected={connected} />
      </div>
    </div>
  );
}

function SessionComposer({
  view,
  onSend,
  inputRef,
  commands,
  connected,
}: {
  view: SessionViewState;
  onSend: (text: string) => Promise<boolean>;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  commands: ReturnType<typeof allCommands>;
  connected: boolean;
}) {
  const sync = useSync();
  const { id } = view;
  const workspaceModes = useAppStore((s) => s.workspaces.find((w) => w.id === view.workspaceId)?.defaults.modes);
  const serverModes = useAppStore((s) => s.info?.modes);
  const models = useAppStore((s) => (view.workspaceId ? s.models[view.workspaceId] : undefined));
  const restored = useAppStore((s) => s.restored[view.id]);
  const modes = workspaceModes ?? serverModes ?? FALLBACK_MODES;

  const setMode = (mode: PermissionMode): void => void sync.setMode(id, mode);
  return (
    <Composer
      key={id}
      sessionId={id}
      running={view.running}
      disabled={!connected || view.hydrating}
      commands={commands}
      onSend={onSend}
      onAbort={() => void sync.abort(id)}
      onCommandMenu={() => void sync.prepareCommands(id)}
      onCycleMode={() => setMode(nextPermissionMode(view.mode, { includeAuto: modes.includes('auto') }))}
      inputRef={inputRef}
      {...(restored !== undefined ? { restored } : {})}
      onRestored={() => sync.takeRestored(id)}
      controls={
        <>
          <ModeChip mode={view.mode} modes={modes} onChange={setMode} />
          <ModelPicker
            modelRef={view.modelRef}
            models={models}
            onOpen={() => view.workspaceId && void sync.loadModels(view.workspaceId)}
            onChange={(model) => void sync.setModel(id, model)}
            {...(view.running ? { disabledReason: 'The model can be switched once this run ends' } : {})}
          />
          <EffortPicker effort={view.effort} levels={view.effortLevels} onChange={(effort) => void sync.setEffort(id, effort)} />
        </>
      }
      trailing={<ContextButton context={view.context} usage={view.usage} modelRef={view.modelRef} />}
    />
  );
}
