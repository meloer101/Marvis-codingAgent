import { useEffect, useState } from 'react';
import { AlertTriangle, ChevronDown, Folder, LoaderCircle } from 'lucide-react';

import { nextPermissionMode } from '@harness-code/core/browser';
import type { ImageInput, PermissionMode, ReasoningEffort } from '@harness-code/core';
import type { Workspace } from '@harness-code/protocol';

import { useAddProject } from '@/components/AddProjectDialog';
import { Composer } from '@/components/Composer';
import { EffortPicker, ModeChip, ModelPicker, WorktreePicker } from '@/components/ComposerControls';
import { ContextButton } from '@/components/UsagePanel';
import { MainHeader, SidebarOpener } from '@/components/Regions';
import { UserMessage } from '@/components/Transcript';
import { relativeTime } from '@/lib/format';
import { routeToHash } from '@/lib/route';
import { allCommands, clientCommand } from '@/lib/slash';
import type { CommandSurface } from '@/lib/slash';
import { useAppStore } from '@/lib/store';
import { useSync } from '@/lib/syncContext';
import { saveWorkPlace, savedWorkPlace, usableWorkPlace } from '@/lib/workPlace';
import type { WorkPlace } from '@/lib/workPlace';

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
  const branches = useAppStore((s) => (workspace ? s.branches[workspace.id] : undefined));
  // Choices reset with the project: its modes, models and their effort levels differ.
  const [choice, setChoice] = useState<{
    workspaceId?: string;
    mode?: PermissionMode;
    model?: string;
    effort?: ReasoningEffort;
  }>({});
  const [starting, setStarting] = useState<{ text: string; attachments: string[]; images: ImageInput[] } | null>(null);
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
  // Where it works is remembered per project.
  const workspaceKey = workspace?.id;
  const [placeChoice, setPlaceChoice] = useState<{ workspaceId: string; place: WorkPlace } | null>(null);
  const remembered: WorkPlace = !workspaceKey
    ? { kind: 'local' }
    : placeChoice?.workspaceId === workspaceKey
      ? placeChoice.place
      : savedWorkPlace(workspaceKey);
  const place = usableWorkPlace(remembered, branches);
  const choosePlace = (next: WorkPlace): void => {
    if (!workspaceKey) return;
    saveWorkPlace(workspaceKey, next);
    setPlaceChoice({ workspaceId: workspaceKey, place: next });
  };
  // The model list tells the meter the window before anything is sent; the
  // branches say whether a worktree can be made, and from what.
  useEffect(() => {
    if (!workspaceKey) return;
    void sync.loadModels(workspaceKey);
    void sync.loadBranches(workspaceKey);
  }, [workspaceKey]);
  const modelInfo = models?.find((m) => m.ref === modelRef);
  /** The picker a command opened (`/model`, …). */
  const [surface, setSurface] = useState<CommandSurface | null>(null);
  const control = (which: CommandSurface) => ({
    open: surface === which,
    onOpenChange: (open: boolean) => setSurface(open ? which : null),
  });

  const send = async (text: string, attachments: string[], opts: { images?: ImageInput[] } = {}): Promise<boolean> => {
    const images = opts.images ?? [];
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
    setStarting({ text, attachments, images });
    const id = await sync.startSession(text, {
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(images.length > 0 ? { images } : {}),
      ...(workspace ? { workspaceId: workspace.id } : {}),
      mode,
      ...(own.model ? { model: own.model } : {}),
      ...(effort && effortLevels.includes(effort) ? { effort } : {}),
      ...(place.kind === 'worktree' ? { worktree: { base: place.base } } : {}),
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
      <MainHeader>
        <SidebarOpener workspaceId={workspace?.id} />
        {workspace && <ProjectPicker workspaces={workspaces} current={workspace} />}
        {workspace && <span className="text-faint">/</span>}
        <span className="text-sm font-semibold">New session</span>
      </MainHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {starting === null ? (
          <Welcome workspace={workspace} />
        ) : (
          <div className="mx-auto flex max-w-[700px] flex-col gap-5 px-5 pt-8 pb-4">
            <UserMessage text={starting.text} attachments={starting.attachments} images={starting.images} />
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <LoaderCircle className="size-3 animate-spin text-primary" />
              <span>
                {place.kind === 'worktree' ? `Making a worktree off ${place.base}…` : 'Starting the session…'}
              </span>
            </div>
          </div>
        )}
      </div>
      <div className="mx-auto flex w-full max-w-[700px] flex-col gap-2 px-5 pt-2 pb-4">
        {keyProblem && starting === null && <KeyProblem message={keyProblem} />}
        <Composer
          key={`draft-${workspace?.id ?? ''}`}
          sessionId={`new-${workspace?.id ?? ''}`}
          running={false}
          disabled={!connected || starting !== null || !workspace || workspace.missing === true}
          commands={BUILTIN_COMMANDS}
          onSend={send}
          onAbort={() => {}}
          imagesProblem={modelInfo && !modelInfo.vision ? `${modelInfo.ref} can't see images` : undefined}
          {...(workspace ? { onSearchFiles: (query: string) => sync.searchFiles({ workspaceId: workspace.id }, query) } : {})}
          onCycleMode={() => choose({ mode: nextPermissionMode(mode, { includeAuto: modes.includes('auto') }) })}
          {...(workspace ? { trailing: <ContextButton modelRef={modelRef} {...(modelInfo ? { model: modelInfo } : {})} /> } : {})}
          controls={
            workspace && (
              <>
                <WorktreePicker
                  place={place}
                  branches={branches}
                  onOpen={() => void sync.loadBranches(workspace.id)}
                  onChange={choosePlace}
                />
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
  const addProject = useAddProject();
  return (
    <span className="relative flex shrink-0 items-center" title={current.root}>
      <Folder className="pointer-events-none absolute left-2 size-[13px] text-muted-foreground" aria-hidden />
      <select
        aria-label="Project"
        value={current.id}
        onChange={(e) => {
          if (e.target.value === ADD_PROJECT) addProject();
          else window.location.hash = routeToHash({ kind: 'new', workspaceId: e.target.value });
        }}
        className="h-[27px] max-w-44 cursor-pointer appearance-none truncate rounded-md bg-muted pr-7 pl-7 text-xs font-medium transition-colors hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
      >
        {workspaces.map((w) => (
          <option key={w.id} value={w.id} disabled={w.missing === true}>
            {w.name}
            {w.missing ? ' (missing)' : ''}
          </option>
        ))}
        <option value={ADD_PROJECT}>Add project…</option>
      </select>
      <ChevronDown className="pointer-events-none absolute top-1/2 right-2 size-3 -translate-y-1/2 text-muted-foreground" />
    </span>
  );
}

function Welcome({ workspace }: { workspace: Workspace | undefined }) {
  const sessions = useAppStore((s) => s.sessions);
  const recent = workspace
    ? sessions.filter((s) => s.workspaceId === workspace.id && !s.archived).slice(0, RECENT)
    : [];
  return (
    <div className="mx-auto flex h-full max-w-[700px] flex-col justify-end gap-8 px-5 pb-6">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-xl leading-[26px] font-semibold">
          {workspace ? (
            <>
              What are we working on in <span>{workspace.name}</span>?
            </>
          ) : (
            'Marvis'
          )}
        </h1>
        {workspace ? (
          <p className="flex min-w-0 items-baseline gap-1 text-[13px] text-muted-foreground">
            <span className="shrink-0">A new session works in</span>
            <span className="min-w-0 truncate font-mono text-xs text-foreground [direction:rtl]" title={workspace.root}>
              <span dir="ltr">{workspace.root}</span>
            </span>
          </p>
        ) : (
          <p className="text-[13px] text-muted-foreground">A coding agent, bound for the browser.</p>
        )}
      </div>
      {recent.length > 0 && (
        <div className="flex flex-col gap-px">
          <p className="px-2 pb-1 text-[11px] font-medium tracking-[0.02em] text-faint">Recent</p>
          <ul className="flex flex-col gap-px">
            {recent.map((s) => (
              <li key={s.id}>
                <a
                  href={routeToHash({ kind: 'session', id: s.id })}
                  className="flex h-7 items-center gap-2 rounded-md px-2 text-[13px] text-muted-foreground transition-colors hover:bg-subtle hover:text-foreground"
                >
                  <span className="min-w-0 flex-1 truncate">{s.title}</span>
                  <span className="shrink-0 font-mono text-[11px] text-faint">{relativeTime(s.mtimeMs)}</span>
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
    <div className="flex animate-rise-lg items-start gap-2 rounded-lg bg-warning-subtle px-3.5 py-2.5 text-xs">
      <AlertTriangle className="mt-px size-3.5 shrink-0 text-warning" />
      <span>
        {message} To share a key across projects, put it in <code className="font-mono">~/.agent/.env</code>.
      </span>
    </div>
  );
}
