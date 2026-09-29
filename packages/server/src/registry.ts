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

import { AgentSession, UNTITLED_SESSION } from '@harness-code/core';
import { listSessionIds, loadTranscript, readSessionMeta, readSessionSummary } from '@harness-code/core';
import type { AgentSessionConfig, PermissionMode, ReasoningEffort, SessionMeta } from '@harness-code/core';
import type { PushEvent, SessionSnapshot, SessionSummary } from '@harness-code/protocol';

import { SessionHost } from './host.js';

/** Builds an `AgentSessionConfig` for a new or resumed session. */
export type SessionConfigFactory = (opts: {
  model?: string;
  mode?: PermissionMode;
  effort?: ReasoningEffort;
  resumeId?: string;
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
  buildConfig: SessionConfigFactory;
  /** Defaults for `session.preview` when the session is not live. */
  previewDefaults: () => Promise<{ modelRef: string; mode: PermissionMode }>;
}

/** Receives every session-list change (`registry.onChange`). */
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
  readonly #buildConfig: SessionConfigFactory;
  readonly #previewDefaults: SessionRegistryOptions['previewDefaults'];
  readonly #hosts = new Map<string, SessionHost>();
  readonly #listeners = new Set<RegistryListener>();
  /** Stamps every summary row computed; see `SessionSummary.rev`. */
  #rev = 0;

  constructor(opts: SessionRegistryOptions) {
    this.#cwd = opts.cwd;
    this.#agentDir = opts.agentDir;
    this.#buildConfig = opts.buildConfig;
    this.#previewDefaults = opts.previewDefaults;
  }

  get(id: string): SessionHost | undefined {
    return this.#hosts.get(id);
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
  async list(): Promise<SessionSummary[]> {
    const rev = ++this.#rev;
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
    return {
      id,
      mtimeMs: disk?.mtimeMs ?? Date.now(),
      title,
      live: host !== undefined,
      running: host?.running ?? false,
      pending: host?.pending ?? false,
      rev,
    };
  }

  /** Push `id`'s current row (or its removal) to every `onChange` listener. */
  #announce(id: string): void {
    if (this.#listeners.size === 0) return;
    const rev = ++this.#rev;
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

  async create(opts: { model?: string; mode?: PermissionMode }): Promise<SessionSnapshot> {
    const host = await this.#spawn({ ...opts });
    this.#announce(host.id);
    return host.snapshot();
  }

  /**
   * Return the live snapshot if the session is in memory, else resume it from
   * disk with the model, mode and effort its metadata recorded. A recorded
   * model that no longer resolves (provider removed, key gone) falls back to
   * the defaults rather than making the session unopenable.
   */
  async open(opts: { id: string }): Promise<SessionSnapshot> {
    const live = this.#hosts.get(opts.id);
    if (live) return live.snapshot();
    const meta = await readSessionMeta(this.#agentDir, opts.id);
    const mode = restoredMode(meta);
    const resume = {
      resumeId: opts.id,
      ...(mode ? { mode } : {}),
      ...(meta?.effort ? { effort: meta.effort } : {}),
    };
    let config: AgentSessionConfig;
    try {
      config = await this.#buildConfig(meta?.model ? { ...resume, model: meta.model } : resume);
    } catch (err) {
      if (!meta?.model) throw err;
      config = await this.#buildConfig(resume);
    }
    const host = await this.#start(config, { hasMeta: meta !== null });
    this.#announce(host.id);
    return host.snapshot();
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
      return {
        id: opts.id,
        modelRef: meta?.model ?? defaults.modelRef,
        mode: restoredMode(meta) ?? defaults.mode,
        transcript,
        running: false,
        lastSeq: 0,
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') throw new SessionPreviewNotFoundError(opts.id);
      throw err;
    }
  }

  async close(id: string): Promise<void> {
    const host = this.#hosts.get(id);
    if (!host) return;
    this.#hosts.delete(id);
    await host.close();
    this.#announce(id);
  }

  async shutdown(): Promise<void> {
    const hosts = [...this.#hosts.values()];
    this.#hosts.clear();
    await Promise.all(hosts.map((h) => h.close()));
  }

  async #spawn(opts: { model?: string; mode?: PermissionMode }): Promise<SessionHost> {
    return this.#start(await this.#buildConfig(opts), { hasMeta: false });
  }

  async #start(config: AgentSessionConfig, opts: { hasMeta: boolean }): Promise<SessionHost> {
    const host: SessionHost = new SessionHost({
      agentDir: this.#agentDir,
      cwd: this.#cwd,
      hasMeta: opts.hasMeta,
      onSummaryChange: () => this.#announce(host.id),
    });
    const session = await AgentSession.create({
      ...config,
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
