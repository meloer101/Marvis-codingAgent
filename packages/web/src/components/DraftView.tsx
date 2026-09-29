import { useState } from 'react';
import { AlertTriangle, ChevronDown, Folder, Loader2 } from 'lucide-react';

import { nextPermissionMode } from '@harness-code/core/browser';
import type { PermissionMode, ReasoningEffort } from '@harness-code/core';
import type { Workspace } from '@harness-code/protocol';

import { Composer } from '@/components/Composer';
import { EffortPicker, ModeChip, ModelPicker } from '@/components/ComposerControls';
import { UserMessage } from '@/components/Transcript';
import { relativeTime } from '@/lib/format';
import { routeToHash } from '@/lib/route';
import { allCommands, clientCommand } from '@/lib/slash';
import type { CommandSurface } from '@/lib/slash';
import { useAppStore } from '@/lib/store';
import { useSync } from '@/lib/syncContext';

const BUILTIN_COMMANDS = allCommands([]);
const ADD_PROJECT = '__add__';
const RECENT = 5;

/**
 * A session that doesn't exist yet: the home screen, in one project (the
 * route's, else the most recently used). Nothing is created until the first
 * message is sent (`session.start`), with the project, mode, model and effort
 * picked here; while the session starts (MCP servers connecting can take a
 * moment) the message already shows, then the view becomes the session's own.
 */
export function DraftView({ workspaceId }: { workspaceId?: string }) {
  const sync = useSync();
  const workspaces = useAppStore((s) => s.workspaces);
  const connected = useAppStore((s) => s.status === 'open');
  const workspace = workspaces.find((w) => w.id === workspaceId) ?? workspaces[0];
  const models = useAppStore((s) => (workspace ? s.models[workspace.id] : undefined));
  // Choices reset with the project: its modes, models and their effort levels differ.
  const [choice, setChoice] = useState<{
    workspaceId?: string;
    mode?: PermissionMode;
    model?: string;
    effort?: ReasoningEffort;
  }>({});
  const [starting, setStarting] = useState<{ text: string; attachments: string[] } | null>(null);
  const own = choice.workspaceId === workspace?.id ? choice : {};
  const mode = own.mode ?? workspace?.defaults.mode ?? 'ask';
  const modes = workspace?.defaults.modes ?? [mode];
  // A model picked here brings its own effort levels and key status (a ref
  // typed with /model that the list doesn't know: none, until it runs).
  const picked = own.model ? models?.find((m) => m.ref === own.model) : undefined;
  const modelRef = own.model ?? workspace?.defaults.model ?? '';
  const effortLevels = own.model ? (picked?.effortLevels ?? []) : (workspace?.defaults.effortLevels ?? []);
  const effort = own.effort ?? (own.model ? picked?.defaultEffort : workspace?.defaults.effort);
  const keyProblem = own.model ? picked?.problem : workspace?.defaults.keyProblem;
  const choose = (patch: typeof choice): void => setChoice({ ...own, workspaceId: workspace?.id, ...patch });
  /** The picker a command opened (`/model`, …). */
  const [surface, setSurface] = useState<CommandSurface | null>(null);
  const control = (which: CommandSurface) => ({
    open: surface === which,
    onOpenChange: (open: boolean) => setSurface(open ? which : null),
  });

  const send = async (text: string, attachments: string[]): Promise<boolean> => {
    const action = clientCommand(text, { effortLevels, modes });
    switch (action?.kind) {
      case undefined:
        break;
      case 'help':
        sync.setHelpOpen(true);
        return true;
      case 'clear':
        return true; // already a clean slate
      case 'open':
        if (action.surface === 'usage' || action.surface === 'skills') {
          sync.showError(`/${action.surface === 'usage' ? 'cost' : 'skills'} is for a session that has started.`);
          return false;
        }
        if (action.surface === 'model' && workspace) void sync.loadModels(workspace.id);
        setSurface(action.surface);
        return true;
      case 'model':
        choose({ model: action.ref, effort: undefined });
        return true;
      case 'effort':
        choose({ effort: action.effort });
        return true;
      case 'mode':
        choose({ mode: action.mode });
        return true;
      case 'error':
        sync.showError(action.message);
        return false;
    }
    setStarting({ text, attachments });
    const id = await sync.startSession(text, {
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(workspace ? { workspaceId: workspace.id } : {}),
      mode,
      ...(own.model ? { model: own.model } : {}),
      ...(effort && effortLevels.includes(effort) ? { effort } : {}),
    });
    if (!id) {
      setStarting(null);
      return false;
    }
    // Replace, so Back doesn't land on a draft that has become this session.
    window.history.replaceState(null, '', routeToHash({ kind: 'session', id }));
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    return true;
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4 text-sm">
        {workspace && <ProjectPicker workspaces={workspaces} current={workspace} />}
        <span className="text-muted-foreground/60">/</span>
        <span className="text-[13px] font-medium text-muted-foreground">New session</span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {starting === null ? (
          <Welcome workspace={workspace} />
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-6">
            <UserMessage text={starting.text} attachments={starting.attachments} />
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin text-primary" />
              <span className="font-serif italic">Starting the session…</span>
            </div>
          </div>
        )}
      </div>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-6 pt-2 pb-5">
        {keyProblem && starting === null && <KeyProblem message={keyProblem} />}
        <Composer
          key={`draft-${workspace?.id ?? ''}`}
          sessionId={`new-${workspace?.id ?? ''}`}
          running={false}
          disabled={!connected || starting !== null || !workspace || workspace.missing === true}
          commands={BUILTIN_COMMANDS}
          onSend={send}
          onAbort={() => {}}
          {...(workspace ? { onSearchFiles: (query: string) => sync.searchFiles(workspace.id, query) } : {})}
          onCycleMode={() => choose({ mode: nextPermissionMode(mode, { includeAuto: modes.includes('auto') }) })}
          controls={
            workspace && (
              <>
                <ModeChip mode={mode} modes={modes} onChange={(m) => choose({ mode: m })} {...control('mode')} />
                <ModelPicker
                  modelRef={modelRef}
                  models={models}
                  onOpen={() => void sync.loadModels(workspace.id)}
                  // The effort goes back to the new model's own default.
                  onChange={(m) => choose({ model: m, effort: undefined })}
                  {...control('model')}
                />
                <EffortPicker
                  effort={effort}
                  levels={effortLevels}
                  onChange={(e) => choose({ effort: e })}
                  {...control('effort')}
                />
              </>
            )
          }
        />
      </div>
    </div>
  );
}

/** The project a new session starts in; picking another opens its draft. "Add project…" is the last option. */
function ProjectPicker({ workspaces, current }: { workspaces: Workspace[]; current: Workspace }) {
  const sync = useSync();
  return (
    <span className="relative flex items-center" title={current.root}>
      <Folder className="pointer-events-none absolute left-2 size-3.5 text-muted-foreground" aria-hidden />
      <select
        aria-label="Project"
        value={current.id}
        onChange={(e) => {
          if (e.target.value === ADD_PROJECT) sync.setAddProjectOpen(true);
          else window.location.hash = routeToHash({ kind: 'new', workspaceId: e.target.value });
        }}
        className="h-7 max-w-44 cursor-pointer appearance-none truncate rounded-md border bg-card pr-7 pl-7 text-xs font-medium shadow-xs transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
      >
        {workspaces.map((w) => (
          <option key={w.id} value={w.id} disabled={w.missing === true}>
            {w.name}
            {w.missing ? ' (missing)' : ''}
          </option>
        ))}
        <option value={ADD_PROJECT}>Add project…</option>
      </select>
      <ChevronDown className="pointer-events-none absolute top-1/2 right-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
    </span>
  );
}

function Welcome({ workspace }: { workspace: Workspace | undefined }) {
  const sessions = useAppStore((s) => s.sessions);
  const recent = workspace
    ? sessions.filter((s) => s.workspaceId === workspace.id && !s.archived).slice(0, RECENT)
    : [];
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 px-6 text-center">
      <div className="flex flex-col items-center gap-2">
        <span className="font-serif text-[34px] font-semibold tracking-[-0.02em]">
          hc<span className="text-brass">·</span>web
        </span>
        <p className="max-w-72 font-serif text-[15px] leading-relaxed text-muted-foreground italic">
          {workspace ? (
            <>
              What are we working on in <span className="font-medium text-foreground not-italic">{workspace.name}</span>?
            </>
          ) : (
            'A coding agent, bound for the browser.'
          )}
        </p>
      </div>
      {recent.length > 0 && (
        <div className="w-full max-w-sm text-left">
          <p className="mb-1.5 font-mono text-[10px] tracking-[0.14em] text-muted-foreground uppercase">Recent</p>
          <ul className="flex flex-col">
            {recent.map((s) => (
              <li key={s.id}>
                <a
                  href={routeToHash({ kind: 'session', id: s.id })}
                  className="flex items-center gap-3 rounded-md px-2 py-1.5 text-[13px] transition-colors hover:bg-accent"
                >
                  <span className="min-w-0 flex-1 truncate">{s.title}</span>
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{relativeTime(s.mtimeMs)}</span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** The default model can't run here as configured — usually a key this project's environment lacks. */
function KeyProblem({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-brass/40 bg-brass-subtle/60 px-3 py-2 text-xs text-brass-strong">
      <AlertTriangle className="mt-px size-3.5 shrink-0" />
      <span>
        {message} To share a key across projects, put it in <code className="font-mono">~/.agent/.env</code>.
      </span>
    </div>
  );
}
