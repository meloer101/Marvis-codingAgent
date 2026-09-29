/**
 * `WorkspaceHub` — every project one `hc web` hosts. It owns a
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
import { basename, join } from 'node:path';

import { AGENT_DIR, STATE_DIR_ENV, projectEnv, resolveStateDir } from '@harness-code/core';
import type { EffortOptions, PermissionMode } from '@harness-code/core';
import type {
  PushEvent,
  SessionSnapshot,
  SessionSummary,
  Workspace,
  WorkspaceDefaults,
  WorkspaceInspection,
} from '@harness-code/protocol';

import { BusyError, InvalidRequestError } from './host.js';
import type { SessionHost } from './host.js';
import { inspectDirectory } from './inspect.js';
import { SessionPreviewNotFoundError, SessionRegistry } from './registry.js';
import type { RegistryListener, SessionConfigFactory } from './registry.js';
import { workspaceId } from './workspaces.js';
import type { WorkspaceRecord, WorkspaceStore } from './workspaces.js';

/** Everything a workspace's registry needs, and what `workspace.list` says about it. */
export interface WorkspaceSetup {
  /** Where its `.agent/` settings live. */
  projectRoot: string;
  /** Where its sessions are recorded. */
  agentDir: string;
  buildConfig: SessionConfigFactory;
  previewDefaults: () => Promise<{ modelRef: string; mode: PermissionMode }>;
  effortFor: (modelRef: string) => Promise<EffortOptions> | EffortOptions;
  defaults: () => Promise<WorkspaceDefaults>;
  /** Release what the setup made (a `--mock` temp dir). */
  dispose?: () => Promise<void>;
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
  #rev = 0;
  readonly #sweepTimer: ReturnType<typeof setInterval> | undefined;

  constructor(opts: WorkspaceHubOptions) {
    this.#store = opts.store;
    this.#setup = opts.setup;
    this.#idleMs = opts.idleMs;
    this.#home = opts.home;
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

  /** What adding `path` as a workspace would mean (nothing is changed). */
  async inspect(path: string): Promise<WorkspaceInspection> {
    const found = await inspectDirectory(path, this.#home !== undefined ? { home: this.#home } : {});
    if (found.problem || !found.root) return found;
    const root = found.root;
    // One state dir for every project: more workspaces would only mix their sessions.
    if (process.env[STATE_DIR_ENV] && this.#entries.size > 0 && !this.#entries.has(workspaceId(root))) {
      return { ...found, problem: `${STATE_DIR_ENV} is set, so every project would share one state directory` };
    }
    const agentDir = found.needsMarker
      ? join(root, AGENT_DIR)
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

  async update(
    id: string,
    patch: { title?: string; pinned?: boolean; archived?: boolean },
  ): Promise<SessionSummary> {
    return (await this.#registryOf(id)).update(id, patch);
  }

  async delete(id: string): Promise<void> {
    await (await this.#registryOf(id)).delete(id);
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
      workspaceId: record.id,
      nextRev: () => ++this.#rev,
      buildConfig: setup.buildConfig,
      previewDefaults: setup.previewDefaults,
      effortFor: setup.effortFor,
      ...(this.#idleMs !== undefined ? { idleMs: this.#idleMs } : {}),
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
