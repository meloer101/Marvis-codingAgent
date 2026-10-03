/**
 * `SessionSync` — glue between the socket and the store.
 *
 *  - **Viewing is not acting.** Opening a session loads its preview (the log
 *    on disk, or the live snapshot) and subscribes only if it already has a
 *    live host. The first thing that acts on it — a message, a mode change,
 *    the `/` menu — resumes it on the server (`session.open`) and subscribes.
 *    So browsing old sessions never spawns their `AgentSession`s and MCP
 *    processes.
 *  - **Leaving releases.** A session the tab stopped showing is unsubscribed
 *    after `releaseMs` (unless it's running or waiting on the user), which
 *    lets the server close its idle host; its model stays for a fast return.
 *  - Events land in the model immediately (cheap) but are published to the
 *    store at most once per animation frame, all dirty sessions in one
 *    `setState` (opencode's 16 ms flush).
 *  - The sidebar list follows the server's `session_upsert` / `_removed`
 *    pushes, which cover every session — including ones this tab never
 *    opened (lib/sessionList.ts).
 *  - On every (re)connect: reload server info + the session list and
 *    resubscribe each session from its `lastSeq` — the server replays the gap
 *    or answers `reset` with a fresh snapshot.
 */

import type { ImageInput, PermissionMode, ReasoningEffort } from '@harness-code/core';
import type {
  AskDecision,
  DirEntry,
  DirSuggestion,
  EditorId,
  FileContent,
  FileMatch,
  GitCommitResult,
  GitDiff,
  MethodParams,
  MethodResult,
  PushEvent,
  QueuedMessage,
  SessionSnapshot,
  SessionSummary,
  SessionTrace,
  StatsSummary,
  TerminalInfo,
  WireEvent,
  Workspace,
  WorkspaceInspection,
} from '@harness-code/protocol';

import { checkoutKey, checkoutParams } from './checkout';

/** What the settings page asks the server. */
export type SettingsMethod =
  | 'settings.get'
  | 'settings.setRules'
  | 'settings.setAutoMode'
  | 'settings.setBackgroundProcesses'
  | 'autoMode.denials'
  | 'session.retryDenied'
  | 'memory.list'
  | 'memory.read'
  | 'memory.write'
  | 'memory.delete'
  | 'mcp.list'
  | 'mcp.login'
  | 'mcp.logout';

export type McpLoginPush = Extract<PushEvent, { type: 'mcp_login' }>;
import type { Checkout } from './checkout';
import { RpcClient, RpcError } from './rpc';
import type { ConnectionStatus, RpcClientOptions } from './rpc';
import { applySessionPush, mergeSessionList } from './sessionList';
import { SessionModel } from './sessionModel';
import { useAppStore } from './store';
import type { CommandSurface } from './slash';
import type { AppState } from './store';

export interface SyncOptions {
  url: string;
  token: string;
  store?: {
    getState(): AppState;
    setState(partial: Partial<AppState> | ((s: AppState) => Partial<AppState>)): void;
  };
  scheduleFrame?: (fn: () => void) => void;
  createSocket?: RpcClientOptions['createSocket'];
  /** How long a session the tab left stays subscribed. Default 15 s. */
  releaseMs?: number;
}

const RELEASE_MS = 15_000;

/** Where a terminal's output goes (`SessionSync.attachTerminal`). */
export interface TerminalView {
  /** Start over from what the terminal kept — on attach, and after a reconnect. */
  onReset(scrollback: string, exitCode?: number): void;
  onData(data: string): void;
  onExit(exitCode: number): void;
  /** The terminal is no more (closed elsewhere, or the server restarted). */
  onGone(): void;
}

export class SessionSync {
  readonly rpc: RpcClient;
  #store: NonNullable<SyncOptions['store']>;
  #scheduleFrame: (fn: () => void) => void;
  #models = new Map<string, SessionModel>();
  /** View loads in flight (`open`). */
  #opening = new Map<string, Promise<void>>();
  /** Resumes in flight (`#ensureLive`). */
  #starting = new Map<string, Promise<void>>();
  /** Sessions this socket is subscribed to (each has a live host). */
  #subscribed = new Set<string>();
  /** Sessions a view is showing right now. */
  #viewing = new Set<string>();
  #releaseTimers = new Map<string, ReturnType<typeof setTimeout>>();
  #releaseMs: number;
  /** Sessions whose open was cut off by a dropped socket; retried on reconnect. */
  #retryOpen = new Set<string>();
  #dirty = new Set<string>();
  #frameQueued = false;
  /** The server boot the held session rows came from (`ServerInfo.bootId`). */
  #bootId: string | null = null;
  /** The terminal views showing output, by terminal (one view per terminal per tab). */
  #terms = new Map<string, TerminalView>();
  /** Checkouts whose git state something shows, and how many things (by `checkoutKey`). */
  #gitWatch = new Map<string, { checkout: Checkout; count: number }>();
  readonly #mcpLogins = new Set<(event: McpLoginPush) => void>();
  /** `git.status` calls in flight, and checkouts that changed again meanwhile. */
  #gitLoading = new Map<string, Promise<void>>();
  #gitAgain = new Set<string>();

  constructor(opts: SyncOptions) {
    this.#store = opts.store ?? useAppStore;
    this.#releaseMs = opts.releaseMs ?? RELEASE_MS;
    this.#scheduleFrame =
      opts.scheduleFrame ??
      ((fn) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => fn()) : setTimeout(fn, 16)));
    this.rpc = new RpcClient({
      url: opts.url,
      token: opts.token,
      onEvent: (id, seq, event) => this.#onEvent(id, seq, event),
      onPush: (event) => this.#onPush(event),
      onTerm: (frame) => {
        const view = this.#terms.get(frame.id);
        if (!view) return;
        if ('data' in frame) view.onData(frame.data);
        else view.onExit(frame.exitCode);
      },
      onStatus: (status) => this.#onStatus(status),
      ...(opts.createSocket ? { createSocket: opts.createSocket } : {}),
    });
  }

  start(): void {
    this.rpc.connect();
  }

  stop(): void {
    for (const timer of this.#releaseTimers.values()) clearTimeout(timer);
    this.#releaseTimers.clear();
    this.rpc.close();
  }

  // -- actions ----------------------------------------------------------------

  /**
   * Show a session: its preview (the disk log, or the live snapshot when it has
   * a host) and, if it is live, a subscription. Never resumes it — see
   * `#ensureLive`. Idempotent while it stays subscribed.
   */
  open(id: string): Promise<void> {
    this.#viewing.add(id);
    this.#cancelRelease(id);
    if (this.#subscribed.has(id)) return Promise.resolve();
    const inflight = this.#opening.get(id);
    if (inflight) return inflight;
    const p = (async () => {
      try {
        let snapshot: SessionSnapshot;
        try {
          snapshot = await this.rpc.call('session.preview', { id });
        } catch (err) {
          // Nothing on disk yet: a live session that hasn't run (or no session).
          if (!(err instanceof RpcError && err.code === 'not_found')) throw err;
          snapshot = await this.rpc.call('session.open', { id });
        }
        this.#adopt(id, snapshot);
        if (snapshot.epoch) await this.#subscribe(id);
      } catch (err) {
        // Cut off mid-open, the session has no model (the view waits on
        // "Loading session…" forever) or a stale one: start it over once the
        // socket is back.
        if (err instanceof RpcError && err.code === 'disconnected') this.#retryOpen.add(id);
        this.#fail(err);
      } finally {
        this.#opening.delete(id);
      }
    })();
    this.#opening.set(id, p);
    return p;
  }

  /**
   * The view stopped showing `id`. Its subscription is dropped after
   * `releaseMs` — later if it is running or waiting on the user — so the
   * server can close its host once idle. The model stays for a fast return.
   */
  release(id: string): void {
    this.#viewing.delete(id);
    this.#cancelRelease(id);
    const later = (): void => {
      this.#releaseTimers.delete(id);
      if (this.#viewing.has(id) || !this.#subscribed.has(id)) return;
      const view = this.#models.get(id)?.state;
      if (view && (view.running || view.askId || view.planId)) {
        this.#releaseTimers.set(id, setTimeout(later, this.#releaseMs));
        return;
      }
      this.#subscribed.delete(id);
      this.rpc.call('session.unsubscribe', { id }).catch(() => {
        // Gone with the socket anyway.
      });
    };
    this.#releaseTimers.set(id, setTimeout(later, this.#releaseMs));
  }

  /** Get the session's `/` menu ready: MCP prompts need its live host. */
  prepareCommands(id: string): Promise<void> {
    return this.#run(this.#ensureLive(id));
  }

  async create(opts: { model?: string; mode?: PermissionMode; effort?: ReasoningEffort } = {}): Promise<string | null> {
    try {
      const snapshot = await this.rpc.call('session.create', opts);
      // A fresh session's only events before the snapshot are its startup
      // notices (skills, MCP, project memory) — which the snapshot doesn't
      // carry. Subscribe from seq 0 so they replay into the transcript.
      this.#models.set(snapshot.id, new SessionModel({ ...snapshot, lastSeq: 0 }));
      this.#publish(snapshot.id);
      await this.#subscribe(snapshot.id);
      void this.#loadSlash(snapshot.id);
      return snapshot.id;
    } catch (err) {
      this.#fail(err);
      return null;
    }
  }

  /**
   * Turn a draft into a session: create it and send its first message in one
   * call. Resolves with the new id (null on failure, the error shown).
   */
  async startSession(
    text: string,
    opts: {
      attachments?: string[];
      images?: ImageInput[];
      workspaceId?: string;
      model?: string;
      mode?: PermissionMode;
      effort?: ReasoningEffort;
      /** Work in a worktree of its own, on a new branch off `base`. */
      worktree?: { base: string };
    } = {},
  ): Promise<string | null> {
    try {
      const { snapshot } = await this.rpc.call('session.start', { text, ...opts });
      // The snapshot predates the message; everything since — the startup
      // notices, then the run — replays from seq 0.
      this.#models.set(snapshot.id, new SessionModel({ ...snapshot, lastSeq: 0 }));
      this.#publish(snapshot.id);
      await this.#subscribe(snapshot.id);
      void this.#loadSlash(snapshot.id);
      return snapshot.id;
    } catch (err) {
      this.#fail(err);
      return null;
    }
  }

  /**
   * Send a message: it starts a run, or waits for the one going to end — or,
   * with `steer`, for the agent to read it at the run's next step.
   */
  async send(
    id: string,
    text: string,
    attachments: string[] = [],
    opts: { steer?: boolean; images?: ImageInput[] } = {},
  ): Promise<boolean> {
    try {
      await this.#act(id, () =>
        this.rpc.call('session.send', {
          id,
          text,
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(opts.images?.length ? { images: opts.images } : {}),
          ...(opts.steer ? { steer: true } : {}),
        }),
      );
      return true;
    } catch (err) {
      this.#fail(err);
      return false;
    }
  }

  /**
   * Take the conversation back to just before its `userMessage`-th user
   * message (the new transcript arrives as a `rewound` event). False, with the
   * reason in the banner, when it couldn't.
   */
  async rewind(id: string, userMessage: number): Promise<boolean> {
    try {
      await this.#act(id, () => this.rpc.call('session.rewind', { id, userMessage }));
      return true;
    } catch (err) {
      this.#fail(err);
      return false;
    }
  }

  /** A new session with this one's conversation, whole or as far as before a user message; null on failure. */
  async fork(id: string, userMessage?: number): Promise<string | null> {
    try {
      const forked = await this.rpc.call('session.fork', { id, ...(userMessage !== undefined ? { userMessage } : {}) });
      return forked.id;
    } catch (err) {
      this.#fail(err);
      return null;
    }
  }

  /** A session's trace; rejects when it can't be asked (the caller shows why). */
  loadTrace(id: string): Promise<SessionTrace> {
    return this.rpc.call('session.trace', { id });
  }

  /** What the traces add up to — one workspace's or every one's — from `since` on; rejects when it can't be asked. */
  loadStats(opts: { workspaceId?: string; since?: number } = {}): Promise<StatsSummary> {
    return this.rpc.call('stats.summary', opts);
  }

  /** Stop a background command of session `id`'s; rejects with why it couldn't (the panel shows it). */
  async killProcess(id: string, processId: string): Promise<void> {
    await this.rpc.call('session.killProcess', { id, processId });
  }

  /** One of the settings page's calls (`components/settings/`); rejects with why it couldn't be made. */
  settingsCall<M extends SettingsMethod>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> {
    // None of these takes no params, so the call's rest-args form always wants exactly one.
    const call = this.rpc.call.bind(this.rpc) as (method: M, params: MethodParams<M>) => Promise<MethodResult<M>>;
    return call(method, params);
  }

  /** Hear how sign-ins begun with `mcp.login` end; returns the release. */
  onMcpLogin(listener: (event: McpLoginPush) => void): () => void {
    this.#mcpLogins.add(listener);
    return () => this.#mcpLogins.delete(listener);
  }

  /** Put a message in a session's composer, ahead of its draft (to edit and send it again). */
  putInComposer(id: string, message: { text: string; attachments: string[]; images: ImageInput[] }): void {
    this.#restore(id, { id: '', text: message.text, ...(message.attachments.length ? { attachments: message.attachments } : {}), ...(message.images.length ? { images: message.images } : {}) });
  }

  /** Stop the run; whatever was queued behind it goes back to the composer. */
  async abort(id: string): Promise<void> {
    try {
      const { unqueued } = await this.rpc.call('session.abort', { id });
      for (const q of unqueued) this.#restore(id, q);
    } catch (err) {
      this.#fail(err);
    }
  }

  /** Take a message out of the queue: dropped, or back into the composer to `edit`. */
  async unqueue(id: string, queuedId: string, opts: { edit?: boolean } = {}): Promise<void> {
    try {
      const taken = await this.rpc.call('session.unqueue', { id, queuedId });
      if (taken && opts.edit) this.#restore(id, taken);
    } catch (err) {
      this.#fail(err);
    }
  }

  /** The composer took the restored text. */
  takeRestored(id: string): void {
    this.#store.setState((s) => {
      const { [id]: _taken, ...rest } = s.restored;
      return { restored: rest };
    });
  }

  #restore(id: string, message: QueuedMessage): void {
    this.#store.setState((s) => {
      const before = s.restored[id];
      const attachments = message.attachments ?? [];
      const images = [...(before?.images ?? []), ...(message.images ?? [])];
      return {
        restored: {
          ...s.restored,
          [id]: {
            ...(before
              ? { text: `${before.text}\n\n${message.text}`, attachments: [...before.attachments, ...attachments] }
              : { text: message.text, attachments }),
            ...(images.length > 0 ? { images } : {}),
          },
        },
      };
    });
  }

  setMode(id: string, mode: PermissionMode): Promise<void> {
    return this.#run(this.#act(id, () => this.rpc.call('session.setMode', { id, mode })));
  }

  setEffort(id: string, effort: ReasoningEffort): Promise<void> {
    return this.#run(this.#act(id, () => this.rpc.call('session.setEffort', { id, effort })));
  }

  setModel(id: string, model: string): Promise<void> {
    return this.#run(this.#act(id, () => this.rpc.call('session.setModel', { id, model })));
  }

  /** Refresh the models a workspace offers (settings may have changed); the last list stays meanwhile. */
  async loadModels(workspaceId: string): Promise<void> {
    try {
      const models = await this.rpc.call('model.list', { workspaceId });
      this.#store.setState((s) => ({ models: { ...s.models, [workspaceId]: models } }));
    } catch (err) {
      this.#fail(err);
    }
  }

  answerAsk(sessionId: string, askId: string, decision: AskDecision, feedback?: string): Promise<void> {
    return this.#run(
      this.rpc.call('ask.answer', { sessionId, askId, decision, ...(feedback ? { feedback } : {}) }),
    );
  }

  answerPlan(
    sessionId: string,
    planId: string,
    approved: boolean,
    feedback?: string,
    mode?: PermissionMode,
  ): Promise<void> {
    return this.#run(
      this.rpc.call('plan.answer', {
        sessionId,
        planId,
        approved,
        ...(feedback ? { feedback } : {}),
        ...(mode ? { mode } : {}),
      }),
    );
  }

  /** MCP prompt commands and skills for the `/` menu; absent until loaded, never fatal. */
  async #loadSlash(id: string): Promise<void> {
    await Promise.all([
      this.rpc.call('session.slashCommands', { id }).then(
        (commands) => this.#store.setState((s) => ({ slash: { ...s.slash, [id]: commands } })),
        () => {}, // the menu falls back to the built-in commands
      ),
      this.rpc.call('session.skills', { id }).then(
        (skills) => this.#store.setState((s) => ({ skills: { ...s.skills, [id]: skills } })),
        () => {},
      ),
    ]);
  }

  /** Put `text` at the start of the session's composer (`/skills` picks a skill). */
  prefill(id: string, text: string): void {
    this.#store.setState((s) => ({ restored: { ...s.restored, [id]: { text, attachments: [], inline: true } } }));
  }

  setHelpOpen(open: boolean): void {
    this.#store.setState({ helpOpen: open });
  }

  setAddProjectOpen(open: boolean): void {
    this.#store.setState({ addProjectOpen: open });
  }

  setPaletteOpen(open: boolean): void {
    this.#store.setState({ paletteOpen: open });
  }

  /** Ask the view of `sessionId` to open a picker or dialog, or to rename it. */
  request(sessionId: string, kind: CommandSurface | 'rename'): void {
    this.#store.setState({ request: { sessionId, kind } });
  }

  /** The view took the request. */
  takeRequest(): void {
    this.#store.setState({ request: null });
  }

  // -- workspaces ---------------------------------------------------------------

  /** Host `path` as a project (or get the one covering it); null on failure, the error shown. */
  async addWorkspace(path: string, opts: { createMarker?: boolean } = {}): Promise<Workspace | null> {
    try {
      const workspace = await this.rpc.call('workspace.add', { path, ...opts });
      this.#store.setState((s) => ({
        workspaces: [workspace, ...s.workspaces.filter((w) => w.id !== workspace.id)],
      }));
      return workspace;
    } catch (err) {
      this.#fail(err);
      return null;
    }
  }

  removeWorkspace(id: string): Promise<void> {
    return this.#run(this.rpc.call('workspace.remove', { id }));
  }

  /** What adding `path` would mean; null when it can't be asked (offline). Never an error banner: it runs as you type. */
  async inspectPath(path: string): Promise<WorkspaceInspection | null> {
    try {
      return await this.rpc.call('workspace.inspect', { path });
    } catch {
      return null;
    }
  }

  /** Files matching an `@` query; empty when it can't be asked. Never an error banner: it runs as you type. */
  async searchFiles(checkout: Pick<Checkout, 'workspaceId' | 'sessionId'>, query: string): Promise<FileMatch[]> {
    try {
      return await this.rpc.call('fs.search', { ...checkoutParams(checkout), query, limit: 30 });
    } catch {
      return [];
    }
  }

  /** The branches a new session's worktree can start from, into the store; kept as it was when they can't be read. */
  async loadBranches(workspaceId: string): Promise<void> {
    try {
      const branches = await this.rpc.call('git.branches', { workspaceId });
      this.#store.setState((s) => ({ branches: { ...s.branches, [workspaceId]: branches } }));
    } catch {
      // The draft offers no worktree until they load.
    }
  }

  async suggestDirs(prefix: string): Promise<DirSuggestion[]> {
    try {
      return await this.rpc.call('fs.suggestDirs', { prefix });
    } catch {
      return [];
    }
  }

  // -- terminals ---------------------------------------------------------------

  /** Fetch a workspace's terminals into the store (pushes keep them current after). */
  async loadTerminals(workspaceId: string): Promise<void> {
    try {
      const terminals = await this.rpc.call('terminal.list', { workspaceId });
      this.#store.setState((s) => ({ terminals: { ...s.terminals, [workspaceId]: terminals } }));
    } catch {
      // The next push or reconnect brings them.
    }
  }

  /** Start a shell in the checkout; null (with the reason in the banner) when it can't. */
  async createTerminal(checkout: Pick<Checkout, 'workspaceId' | 'sessionId'>, cols: number, rows: number): Promise<TerminalInfo | null> {
    const { workspaceId } = checkout;
    try {
      const t = await this.rpc.call('terminal.create', { ...checkoutParams(checkout), cols, rows });
      // Into the list now, so the panel can show it before the push arrives.
      this.#store.setState((s) => {
        const held = s.terminals[workspaceId] ?? [];
        return held.some((x) => x.id === t.id) ? {} : { terminals: { ...s.terminals, [workspaceId]: [...held, t] } };
      });
      return t;
    } catch (err) {
      this.#fail(err);
      return null;
    }
  }

  /**
   * Show terminal `id`'s output in `view`: first what it kept (`onReset`),
   * then as it comes — again from the start after every reconnect. Returns
   * the release.
   */
  attachTerminal(id: string, view: TerminalView): () => void {
    this.#terms.set(id, view);
    void this.#attachTerm(id);
    return () => {
      if (this.#terms.get(id) !== view) return;
      this.#terms.delete(id);
      this.rpc.call('terminal.detach', { id }).catch(() => {});
    };
  }

  /** Keystrokes: sent as typed, in order; lost only with the socket. */
  terminalInput(id: string, data: string): void {
    this.rpc.call('terminal.input', { id, data }).catch(() => {});
  }

  terminalResize(id: string, cols: number, rows: number): void {
    this.rpc.call('terminal.resize', { id, cols, rows }).catch(() => {});
  }

  closeTerminal(id: string): Promise<void> {
    return this.#run(this.rpc.call('terminal.close', { id }));
  }

  async #attachTerm(id: string): Promise<void> {
    const view = this.#terms.get(id);
    if (!view) return;
    try {
      const { scrollback, exitCode } = await this.rpc.call('terminal.attach', { id });
      if (this.#terms.get(id) === view) view.onReset(scrollback, exitCode);
    } catch (err) {
      if (err instanceof RpcError && err.code === 'not_found' && this.#terms.get(id) === view) view.onGone();
      // Disconnected: the reconnect attaches again.
    }
  }

  // -- git --------------------------------------------------------------------

  /**
   * Keep a checkout's git status fresh (in the store's `git`, by
   * `checkoutKey`) while something shows it: loaded now, again on every
   * `git_changed` for its workspace and on reconnect. Returns the release.
   */
  watchGit(checkout: Checkout): () => void {
    const key = checkoutKey(checkout);
    const held = this.#gitWatch.get(key);
    this.#gitWatch.set(key, { checkout, count: (held?.count ?? 0) + 1 });
    void this.loadGitStatus(checkout);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const watch = this.#gitWatch.get(key);
      if (!watch || watch.count <= 1) this.#gitWatch.delete(key);
      else this.#gitWatch.set(key, { ...watch, count: watch.count - 1 });
    };
  }

  /** One load at a time per checkout; a change meanwhile loads once more after it. */
  loadGitStatus(checkout: Pick<Checkout, 'workspaceId' | 'sessionId'>): Promise<void> {
    const key = checkoutKey(checkout);
    const inFlight = this.#gitLoading.get(key);
    if (inFlight) {
      this.#gitAgain.add(key);
      return inFlight;
    }
    const load = (async () => {
      try {
        const status = await this.rpc.call('git.status', checkoutParams(checkout));
        this.#store.setState((s) => ({ git: { ...s.git, [key]: status } }));
      } catch {
        // Kept as it was; the next change or reconnect asks again.
      } finally {
        this.#gitLoading.delete(key);
        if (this.#gitAgain.delete(key)) void this.loadGitStatus(checkout);
      }
    })();
    this.#gitLoading.set(key, load);
    return load;
  }

  /** One file's changes — all, or the staged or unstaged ones; rejects when it can't be asked (the caller shows why). */
  gitDiff(
    checkout: Pick<Checkout, 'workspaceId' | 'sessionId'>,
    path: string,
    side: 'all' | 'staged' | 'unstaged' = 'all',
  ): Promise<GitDiff> {
    return this.rpc.call('git.diff', { ...checkoutParams(checkout), path, ...(side !== 'all' ? { side } : {}) });
  }

  /** Stage, unstage or discard one hunk (its text as the diff showed it); a failure goes to the banner. */
  gitApplyHunk(
    checkout: Pick<Checkout, 'workspaceId' | 'sessionId'>,
    path: string,
    hunk: string,
    action: 'stage' | 'unstage' | 'discard',
  ): Promise<void> {
    return this.#run(this.rpc.call('git.applyHunk', { ...checkoutParams(checkout), path, hunk, action }));
  }

  /** A checkout's folder entries; empty when it can't be asked. */
  async listDir(checkout: Pick<Checkout, 'workspaceId' | 'sessionId'>, dir: string): Promise<DirEntry[]> {
    try {
      return await this.rpc.call('fs.list', { ...checkoutParams(checkout), dir });
    } catch {
      return [];
    }
  }

  /** A checkout's file; rejects when it can't be asked (the caller shows why). */
  readFile(checkout: Pick<Checkout, 'workspaceId' | 'sessionId'>, path: string): Promise<FileContent> {
    return this.rpc.call('fs.read', { ...checkoutParams(checkout), path });
  }

  openInEditor(checkout: Pick<Checkout, 'workspaceId' | 'sessionId'>, path: string, editor: EditorId, line?: number): Promise<void> {
    return this.#run(
      this.rpc.call('editor.open', { ...checkoutParams(checkout), path, editor, ...(line !== undefined ? { line } : {}) }),
    );
  }

  // The status reloads on the git_changed push each change sends. Staging and
  // reverting fail into the banner; commit, push and pull request reject with
  // git's reason, for the panel to show where they were asked for.

  gitStage(checkout: Pick<Checkout, 'workspaceId' | 'sessionId'>, paths: string[]): Promise<void> {
    return this.#run(this.rpc.call('git.stage', { ...checkoutParams(checkout), paths }));
  }

  gitUnstage(checkout: Pick<Checkout, 'workspaceId' | 'sessionId'>, paths: string[]): Promise<void> {
    return this.#run(this.rpc.call('git.unstage', { ...checkoutParams(checkout), paths }));
  }

  gitRevert(checkout: Pick<Checkout, 'workspaceId' | 'sessionId'>, paths: string[]): Promise<void> {
    return this.#run(this.rpc.call('git.revert', { ...checkoutParams(checkout), paths }));
  }

  gitCommit(checkout: Pick<Checkout, 'workspaceId' | 'sessionId'>, message: string, paths?: string[]): Promise<GitCommitResult> {
    return this.rpc.call('git.commit', { ...checkoutParams(checkout), message, ...(paths ? { paths } : {}) });
  }

  gitPush(checkout: Pick<Checkout, 'workspaceId' | 'sessionId'>): Promise<void> {
    return this.rpc.call('git.push', checkoutParams(checkout));
  }

  gitCreatePr(
    checkout: Pick<Checkout, 'workspaceId' | 'sessionId'>,
    pr: { title: string; body?: string; draft?: boolean },
  ): Promise<{ url: string }> {
    return this.rpc.call('git.createPr', { ...checkoutParams(checkout), ...pr });
  }

  // -- session management -------------------------------------------------------

  /**
   * Rename, pin or archive; the new row also arrives as a push. Archiving a
   * session whose worktree has uncommitted changes asks first
   * (`archiveConflict`); `force` goes ahead and loses them.
   */
  async updateSession(
    id: string,
    patch: { title?: string; pinned?: boolean; archived?: boolean; force?: boolean },
  ): Promise<SessionSummary | null> {
    try {
      return await this.rpc.call('session.update', { id, ...patch });
    } catch (err) {
      if (err instanceof RpcError && err.code === 'conflict' && patch.archived) {
        this.#store.setState({ archiveConflict: { id, reason: err.message } });
      } else {
        this.#fail(err);
      }
      return null;
    }
  }

  /** The archive confirmation was answered (or dismissed). */
  dismissArchiveConflict(): void {
    this.#store.setState({ archiveConflict: null });
  }

  deleteSession(id: string): Promise<void> {
    return this.#run(this.rpc.call('session.delete', { id }));
  }

  dismissError(): void {
    this.#store.setState({ error: null });
  }

  /** Show `message` in the error banner (a command the page itself refused). */
  showError(message: string): void {
    this.#store.setState({ error: message });
  }

  // -- internals --------------------------------------------------------------

  /**
   * Run `call` against the session's live host, resuming it first; if the host
   * was closed in between (idled out), resume once more and retry.
   */
  async #act<T>(id: string, call: () => Promise<T>): Promise<T> {
    await this.#ensureLive(id);
    try {
      return await call();
    } catch (err) {
      if (!(err instanceof RpcError && err.code === 'not_found')) throw err;
      this.#subscribed.delete(id);
      await this.#ensureLive(id);
      return call();
    }
  }

  /** Resume the session on the server (if it has no host) and subscribe to it. */
  #ensureLive(id: string): Promise<void> {
    if (this.#subscribed.has(id)) return Promise.resolve();
    const inflight = this.#starting.get(id);
    if (inflight) return inflight;
    const p = (async () => {
      await this.#opening.get(id); // a view load in flight settles first
      if (this.#subscribed.has(id)) return;
      const model = this.#models.get(id);
      if (model) {
        model.setHydrating(true);
        this.#publish(id);
      }
      try {
        this.#adopt(id, await this.rpc.call('session.open', { id }));
        await this.#subscribe(id);
        void this.#loadSlash(id);
      } finally {
        this.#models.get(id)?.setHydrating(false);
        this.#publish(id);
      }
    })().finally(() => this.#starting.delete(id));
    this.#starting.set(id, p);
    return p;
  }

  /** Take `snapshot` as the session's state, creating its model if needed. */
  #adopt(id: string, snapshot: SessionSnapshot): void {
    const model = this.#models.get(id);
    if (model) model.reset(snapshot);
    else this.#models.set(id, new SessionModel(snapshot));
    this.#publish(id);
  }

  async #subscribe(id: string): Promise<void> {
    const model = this.#models.get(id);
    if (!model) return;
    const res = await this.rpc.call('session.subscribe', {
      id,
      sinceSeq: model.lastSeq,
      ...(model.epoch ? { epoch: model.epoch } : {}),
    });
    this.#subscribed.add(id);
    if ('reset' in res) {
      model.reset(res.snapshot);
      this.#publish(id);
    }
  }

  #cancelRelease(id: string): void {
    const timer = this.#releaseTimers.get(id);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.#releaseTimers.delete(id);
  }

  #onEvent(id: string, seq: number, event: WireEvent): void {
    const model = this.#models.get(id);
    if (!model || !model.apply(seq, event)) return;
    this.#publish(id);
  }

  #onPush(event: PushEvent): void {
    if (event.type === 'workspaces') {
      this.#store.setState({ workspaces: event.workspaces });
      return;
    }
    if (event.type === 'terminals') {
      this.#store.setState((s) => ({ terminals: { ...s.terminals, [event.workspaceId]: event.terminals } }));
      return;
    }
    if (event.type === 'mcp_login') {
      for (const listener of this.#mcpLogins) listener(event);
      return;
    }
    if (event.type === 'git_changed') {
      const { workspaceId } = event;
      this.#store.setState((s) => ({ gitRev: { ...s.gitRev, [workspaceId]: (s.gitRev[workspaceId] ?? 0) + 1 } }));
      // The project's checkout or any of its sessions' worktrees.
      for (const { checkout } of this.#gitWatch.values()) {
        if (checkout.workspaceId === workspaceId) void this.loadGitStatus(checkout);
      }
      return;
    }
    this.#store.setState((s) => ({ sessions: applySessionPush(s.sessions, event) }));
    if (event.type !== 'session_upsert') return;
    const { id, live } = event.summary;
    // Its host closed: this socket's subscription went with it.
    if (!live) this.#subscribed.delete(id);
    // It came alive elsewhere (another tab) while shown here: follow it live.
    else if (this.#viewing.has(id) && !this.#subscribed.has(id) && !this.#opening.has(id) && !this.#starting.has(id)) {
      void this.open(id);
    }
  }

  #onStatus(status: ConnectionStatus): void {
    this.#store.setState({ status });
    if (status === 'open') void this.#onConnected();
  }

  async #onConnected(): Promise<void> {
    try {
      const [info, workspaces, sessions] = await Promise.all([
        this.rpc.call('server.info'),
        this.rpc.call('workspace.list'),
        this.rpc.call('session.list'),
      ]);
      const bootChanged = info.bootId !== this.#bootId;
      this.#bootId = info.bootId;
      this.#store.setState((s) => ({
        info,
        workspaces,
        sessions: mergeSessionList(s.sessions, sessions, bootChanged),
      }));
    } catch (err) {
      this.#fail(err);
    }
    // The old socket's subscriptions died with it: make them again.
    const retry = new Set(this.#retryOpen);
    this.#retryOpen.clear();
    const resubscribe = [...this.#subscribed];
    this.#subscribed.clear();
    for (const id of resubscribe) {
      try {
        await this.#subscribe(id);
      } catch (err) {
        // The host is gone (the server restarted, or it idled out): a view
        // showing it falls back to the preview; the next action resumes it.
        if (err instanceof RpcError && err.code === 'not_found') {
          if (this.#viewing.has(id)) retry.add(id);
        } else {
          this.#fail(err);
        }
      }
    }
    for (const id of retry) void this.open(id);
    // Files may have changed while the socket was down.
    for (const { checkout } of this.#gitWatch.values()) void this.loadGitStatus(checkout);
    // Terminals carried on without us: attach again, from what they kept.
    for (const id of this.#terms.keys()) void this.#attachTerm(id);
    for (const workspaceId of Object.keys(this.#store.getState().terminals)) void this.loadTerminals(workspaceId);
  }

  /** Mark a session dirty and publish all dirty sessions on the next frame. */
  #publish(id: string): void {
    this.#dirty.add(id);
    if (this.#frameQueued) return;
    this.#frameQueued = true;
    this.#scheduleFrame(() => this.#flush());
  }

  #flush(): void {
    this.#frameQueued = false;
    if (this.#dirty.size === 0) return;
    const updates: AppState['views'] = {};
    for (const id of this.#dirty) {
      const model = this.#models.get(id);
      if (model) updates[id] = model.state;
    }
    this.#dirty.clear();
    this.#store.setState((s) => ({ views: { ...s.views, ...updates } }));
  }

  async #run(p: Promise<unknown>): Promise<void> {
    try {
      await p;
    } catch (err) {
      this.#fail(err);
    }
  }

  #fail(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.#store.setState({ error: message });
  }
}
