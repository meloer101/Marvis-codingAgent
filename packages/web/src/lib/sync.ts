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

import type { PermissionMode, ReasoningEffort } from '@harness-code/core';
import type {
  AskDecision,
  DirSuggestion,
  FileMatch,
  PushEvent,
  QueuedMessage,
  SessionSnapshot,
  SessionSummary,
  WireEvent,
  Workspace,
  WorkspaceInspection,
} from '@harness-code/protocol';

import { RpcClient, RpcError } from './rpc';
import type { ConnectionStatus, RpcClientOptions } from './rpc';
import { applySessionPush, mergeSessionList } from './sessionList';
import { SessionModel } from './sessionModel';
import { useAppStore } from './store';
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
      workspaceId?: string;
      model?: string;
      mode?: PermissionMode;
      effort?: ReasoningEffort;
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

  async send(id: string, text: string, attachments: string[] = []): Promise<boolean> {
    try {
      await this.#act(id, () =>
        this.rpc.call('session.send', { id, text, ...(attachments.length > 0 ? { attachments } : {}) }),
      );
      return true;
    } catch (err) {
      this.#fail(err);
      return false;
    }
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
      return {
        restored: {
          ...s.restored,
          [id]: before
            ? { text: `${before.text}\n\n${message.text}`, attachments: [...before.attachments, ...attachments] }
            : { text: message.text, attachments },
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

  /** MCP prompt commands for the `/` menu; absent until loaded, never fatal. */
  async #loadSlash(id: string): Promise<void> {
    try {
      const commands = await this.rpc.call('session.slashCommands', { id });
      this.#store.setState((s) => ({ slash: { ...s.slash, [id]: commands } }));
    } catch {
      // The menu falls back to the built-in commands.
    }
  }

  setHelpOpen(open: boolean): void {
    this.#store.setState({ helpOpen: open });
  }

  setAddProjectOpen(open: boolean): void {
    this.#store.setState({ addProjectOpen: open });
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
  async searchFiles(workspaceId: string, query: string): Promise<FileMatch[]> {
    try {
      return await this.rpc.call('fs.search', { workspaceId, query, limit: 30 });
    } catch {
      return [];
    }
  }

  async suggestDirs(prefix: string): Promise<DirSuggestion[]> {
    try {
      return await this.rpc.call('fs.suggestDirs', { prefix });
    } catch {
      return [];
    }
  }

  // -- session management -------------------------------------------------------

  /** Rename, pin or archive; the new row also arrives as a push. */
  async updateSession(
    id: string,
    patch: { title?: string; pinned?: boolean; archived?: boolean },
  ): Promise<SessionSummary | null> {
    try {
      return await this.rpc.call('session.update', { id, ...patch });
    } catch (err) {
      this.#fail(err);
      return null;
    }
  }

  deleteSession(id: string): Promise<void> {
    return this.#run(this.rpc.call('session.delete', { id }));
  }

  dismissError(): void {
    this.#store.setState({ error: null });
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
