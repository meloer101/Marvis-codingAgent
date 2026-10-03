/**
 * `WorkspaceHub` — every project one `marvis web` hosts. It owns a
 * `SessionRegistry` per workspace and is the one place that knows which
 * workspace a session belongs to.
 *
 *  - **Setup per workspace.** Each workspace gets its own cwd, state dir,
 *    environment, settings and session config (`WorkspaceSetup`), built by the
 *    caller: the real assembly, the `--mock` script, or a test's.
 *  - **One rev counter, one list stamp.** Summary `rev`s come from a counter
 *    the registries share, and `list` stamps every workspace's rows at once, so
 *    a client can compare any two rows (web `lib/sessionList.ts`).
 *  - **Routing by session id.** Live hosts first, then a remembered index,
 *    then a look on disk in each workspace.
 *  - **One sweep** closes idle hosts in every registry.
 *  - **Two directories, one state dir** (a repo and a subdirectory of it)
 *    would list the same sessions twice: such a directory is the workspace
 *    already covering it.
 */

import { mkdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import { AGENT_DIR, STATE_DIR_ENV, projectEnv, resolveStateDir, rollupStats, stateHome } from '@harness-code/core';
import type { EffortOptions, PermissionMode } from '@harness-code/core';
import type {
  AutoModeGroup,
  DirEntry,
  EditorId,
  EditorInfo,
  FileContent,
  FileMatch,
  GitBranches,
  GitDiff,
  GitStatus,
  McpView,
  MemoryTarget,
  MemoryView,
  ModelInfo,
  PermissionRuleList,
  PushEvent,
  SessionDenials,
  SettingsView,
  SessionSnapshot,
  SessionSummary,
  SessionTrace,
  StatsSummary,
  TerminalInfo,
  Workspace,
  WorkspaceDefaults,
  WorkspaceInspection,
} from '@harness-code/protocol';

import { detectEditors, openInEditor } from './editors.js';
import type { Editor } from './editors.js';
import { detectFolderPicker, oneAtATime } from './picker.js';
import type { FolderPicker } from './picker.js';
import { FileIndex, readWorkspaceFile } from './files.js';
import { gitDiff, gitStatus } from './git.js';
import type { DiffSide } from './git.js';
import { BusyError, InvalidRequestError } from './host.js';
import type { SessionHost } from './host.js';
import { inspectDirectory } from './inspect.js';
import { SessionPreviewNotFoundError, SessionRegistry } from './registry.js';
import type { RegistryListener, SessionCheckout, SessionConfigFactory } from './registry.js';
import { workspacePath } from './paths.js';
import {
  deleteMemory,
  mcpLogin,
  mcpLogout,
  mcpView,
  memoryView,
  readMemory,
  setAutoModeGroup,
  setBackgroundProcesses,
  setRules,
  settingsView,
  writeMemory,
} from './settings.js';
import type { SettingsPlace } from './settings.js';
import { TerminalManager, loadPty } from './terminals.js';
import type { SpawnPty } from './terminals.js';
import { workspaceId } from './workspaces.js';
import { gitBranches } from './worktrees.js';
import type { WorkspaceRecord, WorkspaceStore } from './workspaces.js';

/** Everything a workspace's registry needs, and what `workspace.list` says about it. */
export interface WorkspaceSetup {
  /** Where its `.agent/` settings live. */
  projectRoot: string;
  /** Where its sessions are recorded. */
  agentDir: string;
  /** Where an earlier version recorded them (`legacyStateDir`): still listed and opened from there. */
  legacyDir?: string;
  buildConfig: SessionConfigFactory;
  previewDefaults: () => Promise<{ modelRef: string; mode: PermissionMode }>;
  effortFor: (modelRef: string) => Promise<EffortOptions> | EffortOptions;
  defaults: () => Promise<WorkspaceDefaults>;
  /** The models its sessions can be given (`model.list`). */
  models: () => Promise<ModelInfo[]>;
  /** Release what the setup made (a `--mock` temp dir). */
  dispose?: () => Promise<void>;
  /** Its sessions' worktrees go away with the server (`--mock`: their sessions do). */
  dropWorktrees?: boolean;
  /** The environment its MCP `${VAR}`s expand from; `projectEnv(root)` by default. */
  env?: NodeJS.ProcessEnv;
  /** Why its sessions can't use auto mode, when they can't. */
  autoModeProblem?: () => Promise<string | undefined>;
}

export type WorkspaceSetupFactory = (root: string) => Promise<WorkspaceSetup>;

export interface WorkspaceHubOptions {
  store: WorkspaceStore;
  setup: WorkspaceSetupFactory;
  /** Passed to every registry. */
  idleMs?: number;
  /** How often to sweep every registry for idle hosts; `0` turns it off. Default 1 minute. */
  sweepMs?: number;
  /** The home directory (tests). */
  home?: string;
  /** The editors files can be opened in (tests); found on the machine by default. */
  editors?: () => Promise<Editor[]>;
  /** The folder chooser (tests); the system's by default, when it has one. */
  folderPicker?: () => Promise<FolderPicker | null>;
  /** How terminals start (tests); node-pty by default, when it loads. */
  pty?: SpawnPty | null;
}

/** A request named a workspace this server doesn't host. The WS layer maps it to `not_found`. */
export class WorkspaceNotFoundError extends Error {
  constructor(id: string) {
    super(`no workspace "${id}"`);
    this.name = 'WorkspaceNotFoundError';
  }
}

interface Entry {
  record: WorkspaceRecord;
  setup: WorkspaceSetup;
  registry: SessionRegistry;
  missing: boolean;
}

const DEFAULT_SWEEP_MS = 60_000;

export class WorkspaceHub {
  readonly #store: WorkspaceStore;
  readonly #setup: WorkspaceSetupFactory;
  readonly #idleMs: number | undefined;
  readonly #home: string | undefined;
  readonly #entries = new Map<string, Entry>();
  readonly #listeners = new Set<RegistryListener>();
  /** Session id → workspace id, learned from lists, creations and lookups. */
  readonly #sessionIndex = new Map<string, string>();
  readonly #files = new FileIndex();
  readonly #findEditors: () => Promise<Editor[]>;
  readonly #findFolderPicker: () => Promise<FolderPicker | null>;
  #folderPicker: Promise<FolderPicker | null> | undefined;
  /** Every workspace's terminals. */
  readonly terminals: TerminalManager;
  #editors: Promise<Editor[]> | undefined;
  #rev = 0;
  readonly #sweepTimer: ReturnType<typeof setInterval> | undefined;

  constructor(opts: WorkspaceHubOptions) {
    this.#store = opts.store;
    this.#setup = opts.setup;
    this.#idleMs = opts.idleMs;
    this.#home = opts.home;
    this.#findEditors = opts.editors ?? (() => detectEditors());
    this.#findFolderPicker = opts.folderPicker ?? (() => detectFolderPicker(this.#home ? { home: this.#home } : {}));
    this.terminals = new TerminalManager({
      spawn: opts.pty !== undefined ? opts.pty : loadPty(),
      onChange: (workspace) => this.#forward(workspace, { type: 'terminals', workspaceId: workspace, terminals: this.terminals.list(workspace) }),
    });
    const sweepMs = opts.sweepMs ?? DEFAULT_SWEEP_MS;
    if (sweepMs > 0) {
      this.#sweepTimer = setInterval(() => this.sweep(), sweepMs);
      this.#sweepTimer.unref?.();
    }
  }

  /**
   * Open the remembered workspaces, and make `launchDir` one (or find the one
   * covering it) as the most recently used. Resolves with its id.
   */
  async init(launchDir: string): Promise<string> {
    for (const record of await this.#store.load()) {
      if (!this.#entries.has(record.id)) await this.#open(record);
    }
    const entry = await this.#ensure(launchDir);
    await this.#touch(entry);
    return entry.record.id;
  }

  onChange(listener: RegistryListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Every workspace with its defaults, most recently used first. */
  async workspaces(): Promise<Workspace[]> {
    const entries = [...this.#entries.values()].sort((a, b) => b.record.lastUsedAt - a.record.lastUsedAt);
    return Promise.all(entries.map((e) => this.#describe(e)));
  }

  async workspace(id: string): Promise<Workspace> {
    const entry = this.#entries.get(id);
    if (!entry) throw new WorkspaceNotFoundError(id);
    return this.#describe(entry);
  }

  /** The models a session in workspace `id` (default: the most recently used) can be given. */
  async models(id?: string): Promise<ModelInfo[]> {
    return this.#target(id).setup.models();
  }

  /**
   * Files in workspace `id` matching `query`, for `@` mentions — in session
   * `sessionId`'s worktree when it has one, as every file and git call below.
   */
  async searchFiles(id: string, query: string, limit?: number, sessionId?: string): Promise<FileMatch[]> {
    const checkout = await this.#checkout(id, sessionId);
    return checkout ? this.#files.search(checkout.cwd, query, limit) : [];
  }

  /** The entries of a folder in workspace `id` (`''` for its root). */
  async listDir(id: string, dir: string, sessionId?: string): Promise<DirEntry[]> {
    const checkout = await this.#checkout(id, sessionId);
    return checkout ? this.#files.list(checkout.cwd, dir) : [];
  }

  /** A file of workspace `id`, for the Files tab. */
  async readFile(id: string, path: string, sessionId?: string): Promise<FileContent> {
    const checkout = await this.#checkout(id, sessionId);
    return checkout ? readWorkspaceFile(checkout.cwd, path) : { kind: 'withheld', reason: this.#goneReason(id) };
  }

  /** The editors on this machine, looked for once. */
  async editors(): Promise<EditorInfo[]> {
    return (await this.#editorList()).map(({ id, name }) => ({ id, name }));
  }

  /** Open a file of workspace `id` in `editorId`, at `line`. */
  async openInEditor(id: string, path: string, editorId: EditorId, line?: number, sessionId?: string): Promise<void> {
    const checkout = await this.#requireCheckout(id, sessionId);
    const editor = (await this.#editorList()).find((e) => e.id === editorId);
    if (!editor) throw new InvalidRequestError(`${editorId} isn't installed here`);
    openInEditor(editor, join(checkout.cwd, workspacePath(path)), line);
  }

  #editorList(): Promise<Editor[]> {
    this.#editors ??= this.#findEditors().catch(() => []);
    return this.#editors;
  }

  /** Whether this machine can show its folder chooser (`pickFolder`). */
  async canPickFolder(): Promise<boolean> {
    return (await this.#picker()) !== null;
  }

  /** Show the system's folder chooser; the folder picked, or null when it was cancelled. */
  async pickFolder(): Promise<{ path: string | null }> {
    const picker = await this.#picker();
    if (!picker) throw new InvalidRequestError('this machine has no folder chooser to show');
    return { path: await picker.pick('Choose a project folder for Marvis') };
  }

  #picker(): Promise<FolderPicker | null> {
    this.#folderPicker ??= this.#findFolderPicker().then(
      (found) => (found ? oneAtATime(found) : null),
      () => null,
    );
    return this.#folderPicker;
  }

  /** Start a terminal in workspace `id`'s root (or session `sessionId`'s worktree). */
  async createTerminal(id: string, cols: number, rows: number, sessionId?: string): Promise<TerminalInfo> {
    const checkout = await this.#requireCheckout(id, sessionId);
    return this.terminals.create(id, checkout.cwd, cols, rows);
  }

  /** Workspace `id`'s changes against HEAD. */
  async gitStatus(id: string, sessionId?: string): Promise<GitStatus> {
    const checkout = await this.#checkout(id, sessionId);
    return checkout ? gitStatus(checkout.cwd) : { repo: false };
  }

  /** One file's changes in workspace `id`: all, or the staged or unstaged ones. */
  async gitDiff(id: string, path: string, sessionId?: string, side?: DiffSide): Promise<GitDiff> {
    const checkout = await this.#checkout(id, sessionId);
    return checkout ? gitDiff(checkout.cwd, path, side) : { kind: 'withheld', reason: this.#goneReason(id) };
  }

  /** The local branches of workspace `id`'s repository, for a worktree to start from. */
  async gitBranches(id: string): Promise<GitBranches> {
    const entry = this.#present(id);
    return entry ? gitBranches(entry.record.root) : { repo: false };
  }

  /**
   * Change workspace `id`'s git state — stage, commit, push… — then tell every
   * tab its status changed.
   */
  async gitChange<T>(
    id: string,
    change: (root: string, checkout: SessionCheckout) => Promise<T>,
    sessionId?: string,
  ): Promise<T> {
    const checkout = await this.#requireCheckout(id, sessionId);
    try {
      return await change(checkout.cwd, checkout);
    } finally {
      this.#forward(id, { type: 'git_changed', workspaceId: id });
    }
  }

  /** Workspace `id`, or undefined when its directory is gone; throws for an unknown id. */
  #present(id: string): Entry | undefined {
    const entry = this.#entries.get(id);
    if (!entry) throw new WorkspaceNotFoundError(id);
    return entry.missing ? undefined : entry;
  }

  /**
   * Where a request about workspace `id` looks: session `sessionId`'s
   * checkout (its worktree, if it has one) or the workspace's root; undefined
   * when that directory is gone. Throws for an unknown workspace.
   */
  async #checkout(id: string, sessionId?: string): Promise<SessionCheckout | undefined> {
    const entry = this.#present(id);
    if (!entry) return undefined;
    if (sessionId === undefined) return { cwd: entry.record.root };
    const checkout = await entry.registry.checkoutOf(sessionId);
    return checkout.missing ? undefined : checkout;
  }

  async #requireCheckout(id: string, sessionId?: string): Promise<SessionCheckout> {
    const checkout = await this.#checkout(id, sessionId);
    if (!checkout) throw new InvalidRequestError(this.#goneReason(id).replace(/\.$/, ''));
    return checkout;
  }

  #goneReason(id: string): string {
    return this.#entries.get(id)?.missing
      ? 'The project folder is missing.'
      : "This session's worktree was removed when it was archived; it comes back when the session runs again.";
  }

  /** What adding `path` as a workspace would mean (nothing is changed). */
  async inspect(path: string): Promise<WorkspaceInspection> {
    const found = await inspectDirectory(path, this.#home !== undefined ? { home: this.#home } : {});
    if (found.problem || !found.root) return found;
    const root = found.root;
    // One state dir for every project: more workspaces would only mix their sessions.
    if (process.env[STATE_DIR_ENV] && this.#entries.size > 0 && !this.#entries.has(workspaceId(root))) {
      return { ...found, problem: `${STATE_DIR_ENV} is set, so every project would share one state directory` };
    }
    // With its marker made, the directory is a project of its own, recorded under its own name.
    const agentDir = found.needsMarker
      ? await stateHome(root)
      : await resolveStateDir(root, { env: projectEnv(root, this.#home !== undefined ? { home: this.#home } : {}) });
    const covering =
      this.#entries.get(workspaceId(root)) ?? [...this.#entries.values()].find((e) => e.setup.agentDir === agentDir);
    return covering
      ? { ...found, workspace: { id: covering.record.id, name: nameOf(covering.record.root) } }
      : found;
  }

  /**
   * Host `path` as a workspace, or return the one already covering it. A
   * directory that `needsMarker` gets its `.agent/` only with `createMarker`.
   */
  async add(path: string, opts: { createMarker?: boolean } = {}): Promise<Workspace> {
    const found = await this.inspect(path);
    if (found.problem || !found.root) throw new InvalidRequestError(found.problem ?? `can't add ${path}`);
    const known = found.workspace && this.#entries.get(found.workspace.id);
    if (known) {
      await this.#touch(known);
      this.#announceWorkspaces();
      return this.#describe(known);
    }
    if (found.needsMarker) {
      if (!opts.createMarker) {
        throw new InvalidRequestError(
          `${found.root} is not a project of its own; adding it creates ${join(found.root, AGENT_DIR)}`,
        );
      }
      await mkdir(join(found.root, AGENT_DIR), { recursive: true });
    }
    const entry = await this.#ensure(found.root);
    await this.#touch(entry);
    this.#announceWorkspaces();
    return this.#describe(entry);
  }

  /** Stop hosting a workspace: its live sessions close, its files stay. */
  async remove(id: string): Promise<void> {
    const entry = this.#entries.get(id);
    if (!entry) throw new WorkspaceNotFoundError(id);
    if (this.#entries.size === 1) throw new InvalidRequestError('the last workspace stays');
    if (entry.registry.hasRunning()) throw new BusyError(`a session in ${nameOf(entry.record.root)} is running`);
    this.#entries.delete(id);
    this.terminals.closeWorkspace(id);
    for (const [session, workspace] of this.#sessionIndex) if (workspace === id) this.#sessionIndex.delete(session);
    await this.#save();
    await entry.registry.shutdown();
    await entry.setup.dispose?.();
    this.#announceWorkspaces();
  }

  /** Every workspace's sessions, newest first, all stamped with one `rev`. */
  async list(): Promise<SessionSummary[]> {
    const stamp = ++this.#rev;
    const rows = (await Promise.all([...this.#entries.values()].map((e) => e.registry.list(stamp)))).flat();
    for (const row of rows) this.#sessionIndex.set(row.id, row.workspaceId);
    return rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  async create(opts: {
    workspaceId?: string;
    model?: string;
    mode?: PermissionMode;
    effort?: Parameters<SessionRegistry['create']>[0]['effort'];
  }): Promise<SessionSnapshot> {
    const { workspaceId: target, ...rest } = opts;
    const entry = this.#target(target);
    const snapshot = await entry.registry.create(rest);
    this.#sessionIndex.set(snapshot.id, entry.record.id);
    await this.#touch(entry);
    return snapshot;
  }

  async start(
    opts: { workspaceId?: string } & Parameters<SessionRegistry['start']>[0],
  ): Promise<{ snapshot: SessionSnapshot; runId: string }> {
    const { workspaceId: target, ...rest } = opts;
    const entry = this.#target(target);
    const started = await entry.registry.start(rest);
    this.#sessionIndex.set(started.snapshot.id, entry.record.id);
    await this.#touch(entry);
    return started;
  }

  async open(id: string): Promise<SessionSnapshot> {
    return (await this.#registryOf(id)).open({ id });
  }

  async preview(id: string): Promise<SessionSnapshot> {
    return (await this.#registryOf(id)).preview({ id });
  }

  /** Archiving removes the session's worktree: the terminals opened in it close too. */
  async update(
    id: string,
    patch: { title?: string; pinned?: boolean; archived?: boolean; force?: boolean },
  ): Promise<SessionSummary> {
    const registry = await this.#registryOf(id);
    const worktree = patch.archived === true ? (await registry.checkoutOf(id)).worktree : undefined;
    const row = await registry.update(id, patch);
    if (worktree) this.terminals.closeUnder(worktree.path);
    return row;
  }

  /** Session `id`'s trace, from whichever workspace has it. */
  async trace(id: string): Promise<SessionTrace> {
    return (await this.#registryOf(id)).trace(id);
  }

  /** What the traces of workspace `id`'s sessions — or every workspace's — add up to, from `since` on. */
  async stats(id?: string, since?: number): Promise<StatsSummary> {
    const entries = id !== undefined ? [this.#entries.get(id) ?? this.#throwMissing(id)] : [...this.#entries.values()];
    const sessions = (await Promise.all(entries.map((e) => e.registry.stats(since)))).flat();
    sessions.sort((a, b) => b.startedAt - a.startedAt);
    return { rollup: rollupStats(sessions), sessions };
  }

  #throwMissing(id: string): never {
    throw new WorkspaceNotFoundError(id);
  }

  // -- settings (the settings page; ./settings.ts) ---------------------------

  /** Where workspace `id`'s settings, memories and MCP servers are. */
  #place(id: string): SettingsPlace {
    const entry = this.#entries.get(id) ?? this.#throwMissing(id);
    const home = this.#home ?? homedir();
    const root = entry.record.root;
    return {
      root,
      projectRoot: entry.setup.projectRoot,
      home,
      env: entry.setup.env ?? projectEnv(root, this.#home !== undefined ? { home: this.#home } : {}),
    };
  }

  async settings(id: string): Promise<SettingsView> {
    const entry = this.#entries.get(id) ?? this.#throwMissing(id);
    return settingsView(this.#place(id), await entry.setup.autoModeProblem?.());
  }

  /**
   * Replace a rule list in the user's settings (every workspace's) or the
   * project's; the live sessions it applies to take it up at once.
   */
  async setRules(id: string, scope: 'user' | 'project', list: PermissionRuleList, rules: string[]): Promise<SettingsView> {
    await setRules(this.#place(id), scope, list, rules);
    await this.#reloadSettings(scope === 'user' ? undefined : id);
    return this.settings(id);
  }

  async setAutoMode(id: string, group: AutoModeGroup, rules: string[] | null): Promise<SettingsView> {
    await setAutoModeGroup(this.#place(id), group, rules);
    await this.#reloadSettings();
    return this.settings(id);
  }

  /** Background commands on or off for the user; sessions started afterwards have it (the tools a session shows the model stay as they started). */
  async setBackgroundProcesses(id: string, enabled: boolean): Promise<SettingsView> {
    await setBackgroundProcesses(this.#place(id), enabled);
    return this.settings(id);
  }

  /** Every live session — workspace `id`'s, or all — reads its settings again. */
  async #reloadSettings(id?: string): Promise<void> {
    const entries = id !== undefined ? [this.#entries.get(id) ?? this.#throwMissing(id)] : [...this.#entries.values()];
    await Promise.all(entries.flatMap((e) => e.registry.live().map((host) => host.reloadSettings().catch(() => {}))));
  }

  /** Live sessions auto mode refused something in (or paused in) — workspace `id`'s, or all — the latest first. */
  denials(id?: string): SessionDenials[] {
    const out: SessionDenials[] = [];
    for (const [workspaceId, entry] of this.#entries) {
      if (id !== undefined && workspaceId !== id) continue;
      for (const host of entry.registry.live()) {
        const { paused, denials } = host.denials();
        if (denials.length > 0 || paused) out.push({ sessionId: host.id, workspaceId, paused, denials });
      }
    }
    return out.sort((a, b) => (b.denials[0]?.at ?? 0) - (a.denials[0]?.at ?? 0));
  }

  async memory(id: string): Promise<MemoryView> {
    return memoryView(this.#place(id));
  }

  async readMemory(id: string, target: MemoryTarget): Promise<string> {
    return readMemory(this.#place(id), target);
  }

  async writeMemory(id: string, target: MemoryTarget, text: string): Promise<MemoryView> {
    await writeMemory(this.#place(id), target, text);
    return this.memory(id);
  }

  async deleteMemory(id: string, target: MemoryTarget): Promise<MemoryView> {
    await deleteMemory(this.#place(id), target);
    return this.memory(id);
  }

  async mcp(id: string): Promise<McpView> {
    return mcpView(this.#place(id));
  }

  /** Sign in to MCP server `name` (`mcp.login`); every tab hears how a sign-in in a browser ends. */
  mcpLogin(id: string, name: string): ReturnType<typeof mcpLogin> {
    return mcpLogin(this.#place(id), name, (error) =>
      this.#forward(id, { type: 'mcp_login', workspaceId: id, name, ...(error ? { error } : {}) }),
    );
  }

  async mcpLogout(id: string, name: string): Promise<McpView> {
    await mcpLogout(this.#place(id), name);
    return this.mcp(id);
  }

  /** Fork session `id` (`SessionRegistry.fork`) in its own workspace; resolves with the new id. */
  async fork(id: string, userMessage?: number): Promise<string> {
    const registry = await this.#registryOf(id);
    const forkId = await registry.fork(id, userMessage);
    for (const [workspace, entry] of this.#entries) if (entry.registry === registry) this.#sessionIndex.set(forkId, workspace);
    return forkId;
  }

  async delete(id: string): Promise<void> {
    const registry = await this.#registryOf(id);
    const { worktree } = await registry.checkoutOf(id);
    await registry.delete(id);
    if (worktree) this.terminals.closeUnder(worktree.path);
    this.#sessionIndex.delete(id);
  }

  async close(id: string): Promise<void> {
    for (const e of this.#entries.values()) {
      if (e.registry.get(id)) return e.registry.close(id);
    }
  }

  /** The live host of session `id`, in whichever workspace. */
  host(id: string): SessionHost | undefined {
    for (const e of this.#entries.values()) {
      const host = e.registry.get(id);
      if (host) return host;
    }
    return undefined;
  }

  sweep(now = Date.now()): void {
    for (const e of this.#entries.values()) e.registry.sweep(now);
  }

  async shutdown(): Promise<void> {
    if (this.#sweepTimer) clearInterval(this.#sweepTimer);
    this.terminals.shutdown();
    const entries = [...this.#entries.values()];
    await Promise.all(entries.map((e) => e.registry.shutdown()));
    await Promise.all(entries.map((e) => e.setup.dispose?.()));
  }

  // -- internals ----------------------------------------------------------------

  /** Where a new session goes: the workspace named, else the most recently used one that exists. */
  #target(id: string | undefined): Entry {
    if (id !== undefined) {
      const entry = this.#entries.get(id);
      if (!entry) throw new WorkspaceNotFoundError(id);
      if (entry.missing) throw new InvalidRequestError(`${entry.record.root} no longer exists`);
      return entry;
    }
    const entry = [...this.#entries.values()]
      .filter((e) => !e.missing)
      .sort((a, b) => b.record.lastUsedAt - a.record.lastUsedAt)[0];
    if (!entry) throw new InvalidRequestError('no workspace to start a session in');
    return entry;
  }

  /** The registry session `id` belongs to; `not_found` when no workspace has it. */
  async #registryOf(id: string): Promise<SessionRegistry> {
    for (const e of this.#entries.values()) if (e.registry.get(id)) return e.registry;
    const indexed = this.#entries.get(this.#sessionIndex.get(id) ?? '');
    if (indexed && (await indexed.registry.has(id))) return indexed.registry;
    for (const e of this.#entries.values()) {
      if (e !== indexed && (await e.registry.has(id))) {
        this.#sessionIndex.set(id, e.record.id);
        return e.registry;
      }
    }
    throw new SessionPreviewNotFoundError(id);
  }

  /** The workspace for directory `dir`, adding it if new; a directory whose state dir another covers maps to that one. */
  async #ensure(dir: string): Promise<Entry> {
    const root = await realpath(dir);
    const id = workspaceId(root);
    const known = this.#entries.get(id);
    if (known) return known;
    const setup = await this.#setup(root);
    const twin = [...this.#entries.values()].find((e) => e.setup.agentDir === setup.agentDir);
    if (twin) {
      await setup.dispose?.();
      return twin;
    }
    const now = Date.now();
    const entry = await this.#open({ id, root, addedAt: now, lastUsedAt: now }, setup);
    await this.#save();
    return entry;
  }

  async #open(record: WorkspaceRecord, prepared?: WorkspaceSetup): Promise<Entry> {
    const setup = prepared ?? (await this.#setup(record.root));
    const registry = new SessionRegistry({
      cwd: record.root,
      agentDir: setup.agentDir,
      ...(setup.legacyDir ? { legacyDir: setup.legacyDir } : {}),
      workspaceId: record.id,
      nextRev: () => ++this.#rev,
      buildConfig: setup.buildConfig,
      previewDefaults: setup.previewDefaults,
      effortFor: setup.effortFor,
      ...(this.#idleMs !== undefined ? { idleMs: this.#idleMs } : {}),
      ...(this.#home !== undefined ? { home: this.#home } : {}),
      ...(setup.dropWorktrees ? { dropWorktrees: true } : {}),
      sweepMs: 0, // the hub sweeps every registry on one timer
    });
    registry.onChange((event) => this.#forward(record.id, event));
    const entry: Entry = { record, setup, registry, missing: !(await isDirectory(record.root)) };
    this.#entries.set(record.id, entry);
    return entry;
  }

  /** Push the whole workspace list (after an add or a remove). */
  #announceWorkspaces(): void {
    if (this.#listeners.size === 0) return;
    void this.workspaces().then(
      (workspaces) => {
        for (const listener of this.#listeners) listener({ type: 'workspaces', workspaces });
      },
      () => {
        // The next workspace.list (every reconnect) is the fallback.
      },
    );
  }

  #forward(workspace: string, event: PushEvent): void {
    if (event.type === 'session_upsert') this.#sessionIndex.set(event.summary.id, workspace);
    // Files came or went — in the workspace or one of its worktrees: the
    // listings behind the Files tab and `@` are stale.
    if (event.type === 'git_changed') this.#files.clear();
    for (const listener of this.#listeners) listener(event);
  }

  async #describe(entry: Entry): Promise<Workspace> {
    return {
      id: entry.record.id,
      root: entry.record.root,
      name: nameOf(entry.record.root),
      projectRoot: entry.setup.projectRoot,
      lastUsedAt: entry.record.lastUsedAt,
      ...(entry.missing ? { missing: true } : {}),
      defaults: await entry.setup.defaults(),
    };
  }

  async #touch(entry: Entry): Promise<void> {
    // Strictly newer than every other: two touches in one millisecond still order.
    const newest = Math.max(0, ...[...this.#entries.values()].map((e) => e.record.lastUsedAt));
    entry.record.lastUsedAt = Math.max(Date.now(), newest + 1);
    // Recency only orders the list: a failed write must not fail the request.
    await this.#save().catch(() => {});
  }

  async #save(): Promise<void> {
    await this.#store.save([...this.#entries.values()].map((e) => e.record));
  }
}

function nameOf(root: string): string {
  return basename(root) || root;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
