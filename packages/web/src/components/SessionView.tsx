import { useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { Loader2 } from 'lucide-react';

import { nextPermissionMode } from '@harness-code/core/browser';
import type { PermissionMode } from '@harness-code/core';

import { Composer } from '@/components/Composer';
import { EffortPicker, ModeChip, ModelPicker } from '@/components/ComposerControls';
import { PendingDock } from '@/components/PendingDock';
import { QueuedMessages } from '@/components/QueuedMessages';
import { SessionHeader } from '@/components/SessionHeader';
import { SkillsDialog } from '@/components/SkillsDialog';
import { Transcript } from '@/components/Transcript';
import { ContextButton } from '@/components/UsagePanel';
import type { SessionViewState } from '@/lib/sessionModel';
import { allCommands, clientCommand } from '@/lib/slash';
import type { CommandSurface, SlashCommand } from '@/lib/slash';
import { useAppStore } from '@/lib/store';
import { useSync } from '@/lib/syncContext';

const FALLBACK_MODES: readonly PermissionMode[] = ['ask', 'acceptEdits', 'plan', 'readOnly', 'yolo'];

export function SessionView({ id, onNewSession }: { id: string; onNewSession: () => void }) {
  const sync = useSync();
  const view = useAppStore((s) => s.views[id]);
  const connected = useAppStore((s) => s.status === 'open');
  const mcp = useAppStore((s) => s.slash[id]);
  const skills = useAppStore((s) => s.skills[id]);
  const commands = useMemo(() => allCommands(mcp ?? [], skills ?? []), [mcp, skills]);
  const modes = useSessionModes(view);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const requestId = view ? (view.askId ?? view.planId) : null;
  const hadRequest = useRef(false);
  /** The picker or dialog a command opened (`/model`, `/skills`, …). */
  const [surface, setSurface] = useState<CommandSurface | null>(null);

  useEffect(() => {
    void sync.open(id);
    return () => sync.release(id);
  }, [sync, id]);

  // The palette asked for a picker or dialog here.
  const request = useAppStore((s) => (s.request?.sessionId === id ? s.request.kind : null));
  useEffect(() => {
    if (request === null || request === 'rename') return;
    sync.takeRequest();
    if (request === 'skills') void sync.prepareCommands(id);
    setSurface(request);
  }, [request]);

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

  /** Client-side commands never reach the server — see lib/slash.ts. */
  const send = async (text: string, attachments: string[]): Promise<boolean> => {
    if (!view) return false;
    const action = clientCommand(text, { effortLevels: view.effortLevels, modes });
    switch (action?.kind) {
      case undefined:
        return sync.send(id, text, attachments);
      case 'help':
        sync.setHelpOpen(true);
        return true;
      case 'clear':
        onNewSession();
        return true;
      case 'open':
        if (action.surface === 'model' && view.workspaceId) void sync.loadModels(view.workspaceId);
        if (action.surface === 'skills') void sync.prepareCommands(id);
        setSurface(action.surface);
        return true;
      case 'model':
        void sync.setModel(id, action.ref);
        return true;
      case 'effort':
        void sync.setEffort(id, action.effort);
        return true;
      case 'mode':
        void sync.setMode(id, action.mode);
        return true;
      case 'error':
        sync.showError(action.message);
        return false;
    }
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
        <SessionComposer
          view={view}
          modes={modes}
          onSend={send}
          inputRef={composerRef}
          commands={commands}
          connected={connected}
          surface={surface}
          onSurface={setSurface}
        />
      </div>
      {surface === 'skills' && (
        <SkillsDialog
          skills={skills}
          onClose={() => setSurface(null)}
          onPick={(name) => {
            setSurface(null);
            sync.prefill(id, `/${name} `);
          }}
        />
      )}
    </div>
  );
}

/** The modes a session can switch to: its workspace's (auto only where available). */
function useSessionModes(view: SessionViewState | undefined): readonly PermissionMode[] {
  const workspaceModes = useAppStore((s) => s.workspaces.find((w) => w.id === view?.workspaceId)?.defaults.modes);
  const serverModes = useAppStore((s) => s.info?.modes);
  return workspaceModes ?? serverModes ?? FALLBACK_MODES;
}

function SessionComposer({
  view,
  modes,
  onSend,
  inputRef,
  commands,
  connected,
  surface,
  onSurface,
}: {
  view: SessionViewState;
  modes: readonly PermissionMode[];
  onSend: (text: string, attachments: string[]) => Promise<boolean>;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  commands: SlashCommand[];
  connected: boolean;
  surface: CommandSurface | null;
  onSurface: (surface: CommandSurface | null) => void;
}) {
  const sync = useSync();
  const { id } = view;
  const models = useAppStore((s) => (view.workspaceId ? s.models[view.workspaceId] : undefined));
  const restored = useAppStore((s) => s.restored[view.id]);
  /** A picker a command opened, closed by the picker as usual. */
  const control = (which: CommandSurface) => ({
    open: surface === which,
    onOpenChange: (open: boolean) => onSurface(open ? which : null),
  });

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
      {...(view.workspaceId ? { onSearchFiles: (query: string) => sync.searchFiles(view.workspaceId!, query) } : {})}
      onCycleMode={() => setMode(nextPermissionMode(view.mode, { includeAuto: modes.includes('auto') }))}
      inputRef={inputRef}
      {...(restored !== undefined ? { restored } : {})}
      onRestored={() => sync.takeRestored(id)}
      controls={
        <>
          <ModeChip mode={view.mode} modes={modes} onChange={setMode} {...control('mode')} />
          <ModelPicker
            modelRef={view.modelRef}
            models={models}
            onOpen={() => view.workspaceId && void sync.loadModels(view.workspaceId)}
            onChange={(model) => void sync.setModel(id, model)}
            {...(view.running ? { disabledReason: 'The model can be switched once this run ends' } : {})}
            {...control('model')}
          />
          <EffortPicker
            effort={view.effort}
            levels={view.effortLevels}
            onChange={(effort) => void sync.setEffort(id, effort)}
            {...control('effort')}
          />
        </>
      }
      trailing={<ContextButton context={view.context} usage={view.usage} modelRef={view.modelRef} {...control('usage')} />}
    />
  );
}
