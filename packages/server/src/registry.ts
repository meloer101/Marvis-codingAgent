/**
 * `SessionRegistry` — the workspace's live sessions plus a view over the ones
 * on disk. One registry per server (one `cwd`). It owns the `SessionHost`
 * lifecycle: create a new session, open (resuming from disk when it is not
 * already live), close one, or shut them all down.
 *
 * Session config assembly is injected as `buildConfig` so the server and the
 * CLI build sessions identically (via core's `buildSessionConfig`), and so
 * tests and `--mock` can substitute a `ScriptedProvider`.
 */

import { access, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  AgentSession,
  UNTITLED_SESSION,
  sessionArtifactsDir,
  sessionMetaPath,
  sessionPath,
  tracePath,
  updateSessionMeta,
} from '@harness-code/core';
import { listSessionIds, loadTranscript, readSessionMeta, readSessionSummary } from '@harness-code/core';
import type {
  AgentSessionConfig,
  EffortOptions,
  ImageInput,
  PermissionMode,
  ReasoningEffort,
  SessionMeta,
  SessionWorktreeMeta,
} from '@harness-code/core';
import type { PushEvent, SessionSnapshot, SessionSummary, SessionWorktree } from '@harness-code/protocol';

import { GitCommandError } from './git.js';
import { BusyError, ConflictError, InvalidRequestError, SessionHost } from './host.js';
import {
  createWorktree,
  removeWorktree,
  restoreWorktree,
  workspacePrefix,
  worktreeChanges,
  worktreeCwd,
} from './worktrees.js';

/** Builds an `AgentSessionConfig` for a new or resumed session. */
export type SessionConfigFactory = (opts: {
  model?: string;
  mode?: PermissionMode;
  effort?: ReasoningEffort;
  resumeId?: string;
  /** Where the session works, when not the workspace's root: a place in its worktree. */
  cwd?: string;
}) => Promise<AgentSessionConfig>;

/**
 * Modes a resumed session gets back from its metadata. `yolo` and `auto` stop
 * asking before acting, so they are never re-entered implicitly: a session
 * left in one of them resumes in the default mode.
 */
const RESTORABLE_MODES: ReadonlySet<PermissionMode> = new Set(['ask', 'plan', 'acceptEdits', 'readOnly']);

function restoredMode(meta: SessionMeta | null): PermissionMode | undefined {
  return meta?.mode && RESTORABLE_MODES.has(meta.mode) ? meta.mode : undefined;
}

export interface SessionRegistryOptions {
  cwd: string;
  agentDir: string;
  /** Stamped on every summary and snapshot; empty outside a workspace (tests). */
  workspaceId?: string;
  /**
   * Hands out `rev`s. Registries of one server share a counter so that revs
   * compare across workspaces; a registry on its own counts for itself.
   */
  nextRev?: () => number;
  buildConfig: SessionConfigFactory;
  /** Defaults for `session.preview` when the session is not live. */
  previewDefaults: () => Promise<{ modelRef: string; mode: PermissionMode }>;
  /**
   * The effort levels (and starting level) of a model ref, for previews and for
   * checking a requested effort before a session exists. Omitted: no model
   * offers effort.
   */
  effortFor?: (modelRef: string) => Promise<EffortOptions> | EffortOptions;
  /** Close a host nobody watches or waits on after this long idle. Default 10 minutes. */
  idleMs?: number;
  /** How often to look for idle hosts; `0` turns the sweep off (tests call `sweep()`). Default 1 minute. */
  sweepMs?: number;
  /** The home directory sessions' worktrees go under (`~/.agent/worktrees`); `os.homedir()` by default. */
  home?: string;
  /**
   * Remove every session's worktree (and merged branch) on shutdown: for
   * `--mock`, whose sessions vanish with its temp dir.
   */
  dropWorktrees?: boolean;
}

/** Where a session works (`checkoutOf`). */
export interface SessionCheckout {
  cwd: string;
  worktree?: SessionWorktreeMeta;
  /** Its worktree was removed; it comes back with the session's next run. */
  missing?: boolean;
}

const DEFAULT_IDLE_MS = 10 * 60_000;
const DEFAULT_SWEEP_MS = 60_000;

/** How long file-change notices are gathered before one goes out. */
const FILES_CHANGED_MS = 250;

/** Receives every session-list change (`registry.onChange`), and file-change notices. */
export type RegistryListener = (event: PushEvent) => void;

/** Title of a live session that has neither a log nor a first message yet. */
const NEW_SESSION_TITLE = '(new session)';

/** Thrown when `session.preview` names a session with no on-disk transcript. */
export class SessionPreviewNotFoundError extends Error {
  constructor(id: string) {
    super(`no session on disk "${id}"`);
    this.name = 'SessionPreviewNotFoundError';
  }
}

export class SessionRegistry {
  readonly #cwd: string;
  readonly #agentDir: string;
  readonly #workspaceId: string;
  readonly #nextRev: () => number;
  readonly #buildConfig: SessionConfigFactory;
  readonly #previewDefaults: SessionRegistryOptions['previewDefaults'];
  readonly #effortFor: NonNullable<SessionRegistryOptions['effortFor']>;
  readonly #hosts = new Map<string, SessionHost>();
  /** Resumes in flight, so two opens of one session share one `AgentSession`. */
  readonly #resuming = new Map<string, Promise<SessionHost>>();
  readonly #listeners = new Set<RegistryListener>();
  #filesTimer: ReturnType<typeof setTimeout> | undefined;
  /** The counter behind `#nextRev` when none is shared. */
  #rev = 0;
  readonly #idleMs: number;
  readonly #sweepTimer: ReturnType<typeof setInterval> | undefined;
  readonly #home: string | undefined;
  readonly #dropWorktrees: boolean;
  /** The workspace's place in its repository, for finding it in a worktree. */
  #prefix: Promise<string> | undefined;

  constructor(opts: SessionRegistryOptions) {
    this.#cwd = opts.cwd;
    this.#agentDir = opts.agentDir;
    this.#workspaceId = opts.workspaceId ?? '';
    this.#nextRev = opts.nextRev ?? (() => ++this.#rev);
    this.#buildConfig = opts.buildConfig;
    this.#previewDefaults = opts.previewDefaults;
    this.#effortFor = opts.effortFor ?? (() => ({ levels: [], initial: undefined }));
    this.#idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
    this.#home = opts.home;
    this.#dropWorktrees = opts.dropWorktrees === true;
    const sweepMs = opts.sweepMs ?? DEFAULT_SWEEP_MS;
    if (sweepMs > 0) {
      this.#sweepTimer = setInterval(() => this.sweep(), sweepMs);
      this.#sweepTimer.unref?.();
    }
  }

  get(id: string): SessionHost | undefined {
    return this.#hosts.get(id);
  }

  /** Whether any of its live sessions is in the middle of a run. */
  hasRunning(): boolean {
    for (const host of this.#hosts.values()) if (host.running) return true;
    return false;
  }

  /** Whether `id` is one of this registry's sessions: live, being resumed, or logged on disk. */
  async has(id: string): Promise<boolean> {
    if (this.#hosts.has(id) || this.#resuming.has(id)) return true;
    try {
      await access(sessionPath(this.#agentDir, id));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Subscribe to session-list changes: a row whenever a session is created,
   * starts or ends a run, waits on or resolves a prompt, or is closed.
   */
  onChange(listener: RegistryListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Every session on disk merged with live in-memory state (live/running/
   * pending), plus any live session not yet flushed to disk, newest first.
   * All rows share one `rev`, taken before reading anything: a change pushed
   * while the list is being built outranks it.
   */
  async list(stamp?: number): Promise<SessionSummary[]> {
    const rev = stamp ?? this.#nextRev();
    const ids = new Set((await listSessionIds(this.#agentDir)).map((s) => s.id));
    for (const id of this.#hosts.keys()) ids.add(id);
    const rows: SessionSummary[] = [];
    for (const id of ids) {
      const row = await this.#summary(id, rev);
      if (row) rows.push(row);
    }
    return rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  /** One session's list row — its log merged with live state — or `null` if it exists nowhere. */
  async #summary(id: string, rev: number): Promise<SessionSummary | null> {
    const host = this.#hosts.get(id);
    let disk: Awaited<ReturnType<typeof readSessionSummary>> | null = null;
    try {
      disk = await readSessionSummary(this.#agentDir, id);
    } catch {
      // Not on disk (yet), or vanished/unreadable since it was listed.
    }
    if (!disk && !host) return null;
    const title =
      disk && disk.title !== UNTITLED_SESSION ? disk.title : (host?.title ?? disk?.title ?? NEW_SESSION_TITLE);
    const worktree = host?.worktree ?? disk?.meta?.worktree;
    const worktreeGone = !host && worktree !== undefined && !(await exists(worktree.path));
    return {
      id,
      workspaceId: this.#workspaceId,
      mtimeMs: disk?.mtimeMs ?? Date.now(),
      title,
      live: host !== undefined,
      running: host?.running ?? false,
      pending: host?.pending ?? false,
      pinned: disk?.meta?.pinned === true,
      archived: disk?.meta?.archived === true,
      ...(worktree ? { worktree: { branch: worktree.branch, ...(worktreeGone ? { missing: true } : {}) } } : {}),
      rev,
    };
  }

  /**
   * Tell listeners this workspace's files may have changed — at most once per
   * `FILES_CHANGED_MS`, however many tool calls ended in between.
   */
  #filesChanged(): void {
    const workspaceId = this.#workspaceId;
    if (!workspaceId || this.#filesTimer) return;
    this.#filesTimer = setTimeout(() => {
      this.#filesTimer = undefined;
      for (const listener of this.#listeners) listener({ type: 'git_changed', workspaceId });
    }, FILES_CHANGED_MS);
    this.#filesTimer.unref?.();
  }

  /** Push `id`'s current row (or its removal) to every `onChange` listener. */
  #announce(id: string): void {
    if (this.#listeners.size === 0) return;
    const rev = this.#nextRev();
    void this.#summary(id, rev).then(
      (summary) => {
        const event: PushEvent = summary ? { type: 'session_upsert', summary } : { type: 'session_removed', id, rev };
        for (const listener of this.#listeners) listener(event);
      },
      () => {
        // A row that can't be computed now is recomputed on the next change or list.
      },
    );
  }

  async create(opts: { model?: string; mode?: PermissionMode; effort?: ReasoningEffort }): Promise<SessionSnapshot> {
    await this.#checkEffort(opts.model, opts.effort);
    const host = await this.#spawn({ ...opts });
    this.#announce(host.id);
    return host.snapshot();
  }

  /**
   * Create a session and send `text` as its first message (`session.start`) —
   * with `worktree`, in a git worktree of its own on a new branch off `base`,
   * named after the message.
   */
  async start(opts: {
    text: string;
    attachments?: readonly string[];
    images?: readonly ImageInput[];
    model?: string;
    mode?: PermissionMode;
    effort?: ReasoningEffort;
    worktree?: { base: string };
  }): Promise<{ snapshot: SessionSnapshot; runId: string }> {
    const { text, attachments = [], images = [], worktree, ...spawnOpts } = opts;
    await this.#checkEffort(spawnOpts.model, spawnOpts.effort);
    const host = await this.#spawn(spawnOpts, worktree ? { base: worktree.base, hint: text } : undefined);
    try {
      await host.checkAttachments(attachments);
      host.checkImages(images);
    } catch (err) {
      // Nothing was said yet: the session leaves nothing behind.
      this.#hosts.delete(host.id);
      await host.close();
      if (host.worktree) await this.#dropWorktree(host.worktree);
      throw err;
    }
    this.#announce(host.id);
    const snapshot = await host.snapshot();
    const { runId } = host.run(text, attachments, images);
    return { snapshot, runId };
  }

  /** The live snapshot, resuming the session from disk first if it has no host. */
  async open(opts: { id: string }): Promise<SessionSnapshot> {
    return (await this.ensure(opts.id)).snapshot();
  }

  /**
   * The session's live host, resuming it from disk if it has none. Concurrent
   * calls for one session share a single resume. Viewing a session never gets
   * here (that is `preview`); the first call that acts on it does.
   */
  ensure(id: string): Promise<SessionHost> {
    const live = this.#hosts.get(id);
    if (live) return Promise.resolve(live);
    const inflight = this.#resuming.get(id);
    if (inflight) return inflight;
    const resumed = this.#resume(id).finally(() => this.#resuming.delete(id));
    this.#resuming.set(id, resumed);
    return resumed;
  }

  /**
   * Resume with the model, mode and effort the session's metadata recorded. A
   * recorded model that no longer resolves (provider removed, key gone) falls
   * back to the defaults rather than making the session unopenable.
   */
  async #resume(id: string): Promise<SessionHost> {
    const meta = await readSessionMeta(this.#agentDir, id);
    const mode = restoredMode(meta);
    // A session archived since has no worktree: check its branch out again.
    const worktree = meta?.worktree;
    if (worktree) {
      try {
        await restoreWorktree(this.#cwd, worktree);
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        throw new InvalidRequestError(`couldn't check out this session's worktree (${worktree.branch}) again: ${why}`);
      }
    }
    const cwd = worktree ? worktreeCwd(worktree, await this.#workspacePrefix()) : undefined;
    // The recorded effort only carries over to a model that offers it (a
    // fallback model may not have DeepSeek's `ultra`, say).
    const configFor = async (model: string | undefined): Promise<AgentSessionConfig> => {
      const ref = model ?? (await this.#previewDefaults()).modelRef;
      const { levels } = await this.#effortFor(ref);
      const effort = meta?.effort && levels.includes(meta.effort) ? meta.effort : undefined;
      return this.#buildConfig({
        resumeId: id,
        ...(model ? { model } : {}),
        ...(mode ? { mode } : {}),
        ...(effort ? { effort } : {}),
        ...(cwd ? { cwd } : {}),
      });
    };
    let config: AgentSessionConfig;
    try {
      config = await configFor(meta?.model);
    } catch (err) {
      if (!meta?.model) throw err;
      config = await configFor(undefined);
    }
    const host = await this.#start(config, {
      hasMeta: meta !== null,
      ...(cwd && worktree ? { cwd, worktree } : {}),
    });
    this.#announce(host.id);
    return host;
  }

  /**
   * Where session `id` works: its worktree, if it has one (`missing` once
   * removed), else the workspace's root — also for an id this workspace
   * doesn't know, so a request can't reach any other directory.
   */
  async checkoutOf(id: string): Promise<SessionCheckout> {
    const host = this.#hosts.get(id);
    if (host) return host.worktree && host.cwd ? { cwd: host.cwd, worktree: host.worktree } : { cwd: this.#cwd };
    const worktree = (await readSessionMeta(this.#agentDir, id))?.worktree;
    if (!worktree) return { cwd: this.#cwd };
    const cwd = worktreeCwd(worktree, await this.#workspacePrefix());
    return { cwd, worktree, ...((await exists(worktree.path)) ? {} : { missing: true }) };
  }

  /** A session's worktree as the UI sees it: where in it the session works, and `missing` once it was removed. */
  async #describeWorktree(worktree: SessionWorktreeMeta): Promise<SessionWorktree> {
    const cwd = worktreeCwd(worktree, await this.#workspacePrefix());
    return { ...worktree, cwd, ...((await exists(worktree.path)) ? {} : { missing: true }) };
  }

  #workspacePrefix(): Promise<string> {
    this.#prefix ??= workspacePrefix(this.#cwd);
    return this.#prefix;
  }

  /**
   * Close every host that nobody is subscribed to, that isn't running or
   * waiting on a prompt, and that has been idle for `idleMs`: each holds an
   * `AgentSession` and its MCP processes, and closing it also flushes the
   * session's memory writes. Its log stays on disk; the next action resumes it.
   */
  sweep(now = Date.now()): void {
    for (const [id, host] of this.#hosts) {
      if (host.listenerCount > 0 || host.running || host.pending) continue;
      if (host.idleFor(now) >= this.#idleMs) void this.close(id);
    }
  }

  /**
   * Cheap snapshot for the UI: live host when in memory, else transcript from
   * disk without spawning `AgentSession` (no MCP connect). Model and mode come
   * from the session's metadata, as `open` will restore them.
   */
  async preview(opts: { id: string }): Promise<SessionSnapshot> {
    const live = this.#hosts.get(opts.id);
    if (live) return live.snapshot();
    try {
      const transcript = await loadTranscript(this.#agentDir, opts.id);
      const [defaults, meta] = await Promise.all([
        this.#previewDefaults(),
        readSessionMeta(this.#agentDir, opts.id),
      ]);
      const modelRef = meta?.model ?? defaults.modelRef;
      const { levels, initial } = await this.#effortFor(modelRef);
      const effort = meta?.effort && levels.includes(meta.effort) ? meta.effort : initial;
      return {
        id: opts.id,
        ...(this.#workspaceId ? { workspaceId: this.#workspaceId } : {}),
        modelRef,
        mode: restoredMode(meta) ?? defaults.mode,
        transcript,
        running: false,
        lastSeq: 0,
        effortLevels: [...levels],
        ...(effort ? { effort } : {}),
        ...(meta?.worktree ? { worktree: await this.#describeWorktree(meta.worktree) } : {}),
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') throw new SessionPreviewNotFoundError(opts.id);
      throw err;
    }
  }

  /**
   * Rename, pin or archive `id` (its metadata sidecar); resolves with its new
   * row, which is also pushed. An empty title clears it, so the list goes
   * back to the first message.
   */
  async update(
    id: string,
    patch: { title?: string; pinned?: boolean; archived?: boolean; force?: boolean },
  ): Promise<SessionSummary> {
    if (!(await this.has(id))) throw new SessionPreviewNotFoundError(id);
    if (patch.archived === true) await this.#putAwayWorktree(id, patch.force === true);
    const title = patch.title?.replace(/\s+/g, ' ').trim();
    await updateSessionMeta(this.#agentDir, id, {
      ...(patch.title !== undefined ? { title: title || undefined } : {}),
      ...(patch.pinned !== undefined ? { pinned: patch.pinned || undefined } : {}),
      ...(patch.archived !== undefined ? { archived: patch.archived || undefined } : {}),
    });
    this.#announce(id);
    const row = await this.#summary(id, this.#nextRev());
    if (!row) throw new SessionPreviewNotFoundError(id);
    return row;
  }

  /**
   * Archiving removes the session's worktree — its branch stays, for the next
   * run to check out again. Not while it runs; not over uncommitted changes
   * unless `force`. A live host working there is closed first.
   */
  async #putAwayWorktree(id: string, force: boolean): Promise<void> {
    const host = this.#hosts.get(id);
    const worktree = host?.worktree ?? (await readSessionMeta(this.#agentDir, id))?.worktree;
    if (!worktree || !(await exists(worktree.path))) return;
    if (host?.running || host?.pending) throw new BusyError('the session is running; stop it first');
    if (!force) {
      const changes = await worktreeChanges(worktree);
      if (changes > 0) {
        throw new ConflictError(
          `its worktree has ${changes} uncommitted change${changes === 1 ? '' : 's'}, which archiving would throw away`,
        );
      }
    }
    if (host) await this.close(id);
    await removeWorktree(this.#cwd, worktree, this.#home ? { home: this.#home } : {});
    this.#filesChanged();
  }

  /** Remove a worktree and its branch (if merged): the session it was made for is gone. */
  async #dropWorktree(worktree: SessionWorktreeMeta): Promise<void> {
    await removeWorktree(this.#cwd, worktree, { deleteBranch: true, ...(this.#home ? { home: this.#home } : {}) }).catch(
      () => {
        // Left for `git worktree prune` and `git branch -d` by hand.
      },
    );
  }

  /**
   * Delete `id` for good: log, metadata, offloaded tool output, trace, and its
   * worktree. Not while it runs; a live, idle session is closed first — its
   * writers would otherwise recreate what was just removed.
   */
  async delete(id: string): Promise<void> {
    await this.#resuming.get(id)?.catch(() => {});
    if (!(await this.has(id))) throw new SessionPreviewNotFoundError(id);
    const host = this.#hosts.get(id);
    if (host?.running) throw new BusyError('the session is running; stop it first');
    const worktree = host?.worktree ?? (await readSessionMeta(this.#agentDir, id))?.worktree;
    if (host) {
      this.#hosts.delete(id);
      await host.close();
    }
    const metaPath = sessionMetaPath(this.#agentDir, id);
    const leftovers = (await readdir(dirname(metaPath)).catch(() => [] as string[]))
      .filter((name) => name.startsWith(`${id}.meta.json.`) && name.endsWith('.tmp'))
      .map((name) => join(dirname(metaPath), name));
    await Promise.all(
      [sessionPath(this.#agentDir, id), metaPath, tracePath(this.#agentDir, id), ...leftovers].map((path) =>
        rm(path, { force: true }),
      ),
    );
    await rm(sessionArtifactsDir(this.#agentDir, id), { recursive: true, force: true });
    if (worktree) await this.#dropWorktree(worktree);
    this.#announce(id);
  }

  async close(id: string): Promise<void> {
    const host = this.#hosts.get(id);
    if (!host) return;
    this.#hosts.delete(id);
    await host.close();
    this.#announce(id);
  }

  async shutdown(): Promise<void> {
    if (this.#sweepTimer) clearInterval(this.#sweepTimer);
    const hosts = [...this.#hosts.values()];
    this.#hosts.clear();
    await Promise.all(hosts.map((h) => h.close()));
    if (this.#dropWorktrees) {
      const ids = new Set([...(await listSessionIds(this.#agentDir)).map((s) => s.id)]);
      const worktrees = hosts.flatMap((h) => (h.worktree ? [h.worktree] : []));
      for (const id of ids) {
        const worktree = (await readSessionMeta(this.#agentDir, id))?.worktree;
        if (worktree && !worktrees.some((w) => w.path === worktree.path)) worktrees.push(worktree);
      }
      for (const worktree of worktrees) await this.#dropWorktree(worktree);
    }
  }

  /** A new session: in the workspace's root, or in a worktree made for it (removed again if the session fails to start). */
  async #spawn(
    opts: { model?: string; mode?: PermissionMode; effort?: ReasoningEffort },
    worktree?: { base: string; hint: string },
  ): Promise<SessionHost> {
    if (!worktree) return this.#start(await this.#buildConfig(opts), { hasMeta: false });
    let made: Awaited<ReturnType<typeof createWorktree>>;
    try {
      made = await createWorktree(this.#cwd, { ...worktree, ...(this.#home ? { home: this.#home } : {}) });
    } catch (err) {
      if (err instanceof GitCommandError) throw new InvalidRequestError(`couldn't make a worktree: ${err.message}`);
      throw err;
    }
    try {
      if (!(await exists(made.cwd))) {
        throw new InvalidRequestError(`${worktree.base} has no ${made.cwd.slice(made.meta.path.length + 1)} to work in`);
      }
      const config = await this.#buildConfig({ ...opts, cwd: made.cwd });
      return await this.#start(config, { hasMeta: false, cwd: made.cwd, worktree: made.meta });
    } catch (err) {
      await this.#dropWorktree(made.meta);
      throw err;
    }
  }

  /** Refuse an effort the new session's model (`model`, else the default) doesn't offer. */
  async #checkEffort(model: string | undefined, effort: ReasoningEffort | undefined): Promise<void> {
    if (effort === undefined) return;
    const ref = model ?? (await this.#previewDefaults()).modelRef;
    const { levels } = await this.#effortFor(ref);
    if (levels.length === 0) throw new InvalidRequestError(`${ref} has no reasoning effort to set`);
    if (!levels.includes(effort)) {
      throw new InvalidRequestError(`"${effort}" is not an effort level of ${ref} (${levels.join(', ')})`);
    }
  }

  async #start(
    config: AgentSessionConfig,
    opts: { hasMeta: boolean; cwd?: string; worktree?: SessionWorktreeMeta },
  ): Promise<SessionHost> {
    const host: SessionHost = new SessionHost({
      agentDir: this.#agentDir,
      cwd: opts.cwd ?? this.#cwd,
      ...(opts.worktree ? { worktree: opts.worktree } : {}),
      ...(this.#workspaceId ? { workspaceId: this.#workspaceId } : {}),
      hasMeta: opts.hasMeta,
      onSummaryChange: () => this.#announce(host.id),
      onFilesChanged: () => this.#filesChanged(),
    });
    const session = await AgentSession.create({
      ...config,
      // Logged where this registry lists them, wherever the session works.
      agentDir: config.agentDir ?? this.#agentDir,
      askHandler: host.ask,
      confirm: host.confirm,
      onEvent: host.onAgentEvent,
      onNotice: host.onNotice,
    });
    host.attach(session, config.model.ref);
    this.#hosts.set(host.id, host);
    return host;
  }
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}
