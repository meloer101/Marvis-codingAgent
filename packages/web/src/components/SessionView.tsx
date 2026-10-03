import { useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { LoaderCircle } from 'lucide-react';

import { nextPermissionMode } from '@harness-code/core/browser';
import type { ImageInput, PermissionMode } from '@harness-code/core';

import { Composer } from '@/components/Composer';
import { EffortPicker, ModeChip, ModelPicker, WhereChip } from '@/components/ComposerControls';
import { PendingDock } from '@/components/PendingDock';
import { QueuedMessages } from '@/components/QueuedMessages';
import { TaskDock } from '@/components/TaskDock';
import { SessionHeader } from '@/components/SessionHeader';
import { SkillsDialog } from '@/components/SkillsDialog';
import { Transcript } from '@/components/Transcript';
import type { MessageActions } from '@/components/Transcript';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { ContextButton } from '@/components/UsagePanel';
import { useSessionCheckout } from '@/lib/checkout';
import type { Checkout } from '@/lib/checkout';
import type { UserMessageData } from '@/lib/rows';
import type { SessionViewState } from '@/lib/sessionModel';
import { openSession } from '@/lib/split';
import { allCommands, clientCommand } from '@/lib/slash';
import type { CommandSurface, SlashCommand } from '@/lib/slash';
import { useAppStore } from '@/lib/store';
import { useSync } from '@/lib/syncContext';

const FALLBACK_MODES: readonly PermissionMode[] = ['ask', 'acceptEdits', 'plan', 'readOnly', 'yolo'];

/** One pane of a split view: whether it has the focus, and closing it. */
export interface PaneProps {
  focused: boolean;
  /** Its place in the split, from the left. */
  index: number;
  onClose: () => void;
}

/**
 * A session: header, transcript and composer, with what docks above it. The
 * side panel and the terminal beside it are `SessionArea`'s, for the session
 * with the focus.
 */
export function SessionView({ id, onNewSession, pane }: { id: string; onNewSession: () => void; pane?: PaneProps }) {
  const sync = useSync();
  const view = useAppStore((s) => s.views[id]);
  const connected = useAppStore((s) => s.status === 'open');
  const mcp = useAppStore((s) => s.slash[id]);
  const skills = useAppStore((s) => s.skills[id]);
  const commands = useMemo(() => allCommands(mcp ?? [], skills ?? []), [mcp, skills]);
  const modes = useSessionModes(view);
  const checkout = useSessionCheckout({ id, workspaceId: view?.workspaceId, worktree: view?.worktree });
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

  /** Edit a message the conversation goes on after: asked first, since what follows leaves it. */
  const [rewinding, setRewinding] = useState<{ userMessage: number; message: UserMessageData } | null>(null);
  const actions = useMemo<MessageActions>(() => {
    const edit = async (userMessage: number, message: UserMessageData): Promise<void> => {
      if (await sync.rewind(id, userMessage)) sync.putInComposer(id, message);
    };
    return {
      onEdit: (userMessage, message, later) =>
        later ? setRewinding({ userMessage, message }) : void edit(userMessage, message),
      onFork: (userMessage, message) =>
        void sync.fork(id, userMessage).then((forkId) => {
          if (!forkId) return;
          sync.putInComposer(forkId, message);
          openSession(forkId);
        }),
      onRegenerate: (userMessage, message) =>
        void sync.rewind(id, userMessage).then((ok) => {
          if (ok) void sync.send(id, message.text, message.attachments, { images: message.images });
        }),
    };
  }, [sync, id]);
  const confirmRewind = (): void => {
    const target = rewinding;
    setRewinding(null);
    if (target) void sync.rewind(id, target.userMessage).then((ok) => ok && sync.putInComposer(id, target.message));
  };

  /** Client-side commands never reach the server — see lib/slash.ts. */
  const send = async (
    text: string,
    attachments: string[],
    opts: { steer?: boolean; images?: ImageInput[] } = {},
  ): Promise<boolean> => {
    if (!view) return false;
    const action = clientCommand(text, { effortLevels: view.effortLevels, modes });
    switch (action?.kind) {
      case undefined:
        return sync.send(id, text, attachments, opts);
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
      <div className="flex flex-1 items-center justify-center gap-2 text-[13px] text-muted-foreground">
        <LoaderCircle className="size-3.5 animate-spin text-primary" />
        Loading session…
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <SessionHeader view={view} {...(pane ? { pane } : {})} />
        <Transcript view={view} actions={actions} />
        <div className="mx-auto flex w-full max-w-[700px] flex-col gap-2 px-5 pt-2 pb-4">
          <TaskDock view={view} />
          <PendingDock view={view} />
          <QueuedMessages
            queue={view.queue}
            onEdit={(queuedId) => void sync.unqueue(id, queuedId, { edit: true })}
            onRemove={(queuedId) => void sync.unqueue(id, queuedId)}
          />
          <SessionComposer
            view={view}
            checkout={checkout}
            autoFocus={!pane || pane.focused}
            modes={modes}
            onSend={send}
            inputRef={composerRef}
            commands={commands}
            connected={connected}
            surface={surface}
            onSurface={setSurface}
          />
        </div>
      </div>
      <Dialog open={rewinding !== null} onOpenChange={(open) => !open && setRewinding(null)}>
        {rewinding && (
          <DialogContent
            title="Take the conversation back to here?"
            description="This message and everything after it leave the conversation; the message goes back in the composer to change. Files the agent changed stay as they are."
          >
            <div className="flex justify-end gap-2 px-5 pt-3 pb-5">
              <Button variant="ghost" size="sm" onClick={() => setRewinding(null)}>
                Cancel
              </Button>
              <Button size="sm" onClick={confirmRewind}>
                Rewind and edit
              </Button>
            </div>
          </DialogContent>
        )}
      </Dialog>
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
  checkout,
  autoFocus,
  modes,
  onSend,
  inputRef,
  commands,
  connected,
  surface,
  onSurface,
}: {
  view: SessionViewState;
  /** Where `@` looks for files: where the session works. */
  checkout: Checkout | undefined;
  autoFocus: boolean;
  modes: readonly PermissionMode[];
  onSend: (text: string, attachments: string[], opts?: { steer?: boolean; images?: ImageInput[] }) => Promise<boolean>;
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
  const modelInfo = models?.find((m) => m.ref === view.modelRef);
  // The meter shows the model's window until the first reply measures the
  // context, and the composer whether the model can see images.
  const workspaceKey = view.workspaceId;
  const needModels = models === undefined;
  useEffect(() => {
    if (needModels && workspaceKey) void sync.loadModels(workspaceKey);
  }, [needModels, workspaceKey]);
  const imagesProblem = modelInfo && !modelInfo.vision ? `${modelInfo.ref} can't see images` : undefined;
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
      autoFocus={autoFocus}
      imagesProblem={imagesProblem}
      running={view.running}
      disabled={!connected || view.hydrating}
      commands={commands}
      onSend={onSend}
      onAbort={() => void sync.abort(id)}
      onCommandMenu={() => void sync.prepareCommands(id)}
      {...(checkout ? { onSearchFiles: (query: string) => sync.searchFiles(checkout, query) } : {})}
      onCycleMode={() => setMode(nextPermissionMode(view.mode, { includeAuto: modes.includes('auto') }))}
      inputRef={inputRef}
      {...(restored !== undefined ? { restored } : {})}
      onRestored={() => sync.takeRestored(id)}
      controls={
        <>
          <WhereChip worktree={view.worktree} />
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
      trailing={
        <ContextButton
          context={view.context}
          usage={view.usage}
          modelRef={view.modelRef}
          {...(modelInfo ? { model: modelInfo } : {})}
          {...control('usage')}
        />
      }
    />
  );
}
