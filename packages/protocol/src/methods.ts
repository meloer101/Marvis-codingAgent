/**
 * The RPC method table: one entry per `ClientFrame.method`, each pairing a
 * zod schema (validates `params` — the server uses this exact schema) with a
 * result type (a phantom type-only marker; never assigned a runtime value).
 * `Call` derives a type-safe `call(method, params)` signature from the same
 * table, so client and server can never disagree about a method's shape.
 *
 * Method list, params, and results define the web frontend's RPC contract;
 * `SessionSummary` / `SessionSnapshot` carry `transcript: TranscriptItem[]`,
 * the full display history (distinct from the model's context window).
 */

import { z } from 'zod';

import type {
  ContextSnapshot,
  ModelDescription,
  PermissionMode,
  ReasoningEffort,
  SlashCommandInfo,
  TranscriptItem,
  Usage,
} from '@harness-code/core';

// ---------------------------------------------------------------------------
// Result-only interfaces
// ---------------------------------------------------------------------------

export interface ServerInfo {
  version: string;
  /** New on every server start: a changed id means `rev`s restarted from zero. */
  bootId: string;
  cwd: string;
  projectRoot: string;
  defaultModel: string;
  /** The permission mode a new session starts in (settings, else `ask`). */
  defaultMode: PermissionMode;
  models: string[];
  modes: PermissionMode[];
}

/** Where a new session in a workspace starts, and what its model offers. */
export interface WorkspaceDefaults {
  /** `provider/model` new sessions use. */
  model: string;
  /** The permission mode they start in. */
  mode: PermissionMode;
  /** Modes on offer (`auto` only where it is available). */
  modes: PermissionMode[];
  /** The default model's starting effort; absent without reasoning. */
  effort?: ReasoningEffort;
  effortLevels: ReasoningEffort[];
  /** Why the default model can't be used as configured (typically a missing API key). */
  keyProblem?: string;
}

/**
 * One model the picker offers (`model.list`): windows, effort levels and
 * price from the capability table, and why it can't run here, if it can't.
 */
export type ModelInfo = ModelDescription;

/** A project `hc web` hosts sessions for. */
export interface Workspace {
  /** Stable: derived from the root path. */
  id: string;
  /** The directory sessions run in. */
  root: string;
  /** Display name (the directory's name). */
  name: string;
  /** Where its `.agent/` settings live (the nearest ancestor with `.git`/`.agent`, else the root). */
  projectRoot: string;
  lastUsedAt: number;
  /** The directory no longer exists; its sessions are unavailable until it does. */
  missing?: boolean;
  defaults: WorkspaceDefaults;
}

/** What adding a directory as a workspace would mean (`workspace.inspect`) — read from disk, nothing started. */
export interface WorkspaceInspection {
  /** The path asked about, `~` expanded and made absolute. */
  path: string;
  exists: boolean;
  isDirectory: boolean;
  /** The directory with symlinks resolved — the root it would have. */
  root?: string;
  /** Where its `.agent/` settings live. */
  projectRoot?: string;
  git: boolean;
  /**
   * It has no project marker of its own and would share a state dir with
   * other such directories: adding it creates `<root>/.agent/` (`createMarker`).
   */
  needsMarker: boolean;
  /** Already a workspace, or inside one (their sessions are the same). */
  workspace?: { id: string; name: string };
  /** Why it can't be added. */
  problem?: string;
  /** Servers its `.mcp.json` would start with every session — what runs, never secrets. */
  mcpServers: Array<{ name: string; transport: 'stdio' | 'http' | 'sse'; command?: string; url?: string }>;
  /** Project settings worth reading before trusting it (YOLO default, pre-approved calls, redirected providers). */
  warnings: string[];
}

/** One completion for a directory path. */
export interface DirSuggestion {
  path: string;
  /** The path with the home directory shown as `~`. */
  label: string;
  git: boolean;
}

/** One row of `session.list` — cheap enough to compute for every session on disk. */
export interface SessionSummary {
  id: string;
  /** The workspace the session belongs to. */
  workspaceId: string;
  mtimeMs: number;
  /** First user message, truncated. */
  title: string;
  /** Has a `SessionHost` in memory. */
  live: boolean;
  running: boolean;
  /** Waiting on an ask/plan — the sidebar badge. */
  pending: boolean;
  /** Kept at the top of its workspace's list. */
  pinned: boolean;
  /** Put away: listed only on request. */
  archived: boolean;
  /**
   * Server-wide, increasing with every row the server computes (per boot):
   * of two rows for one session, the higher `rev` is the newer state.
   */
  rev: number;
}

/** A message sent while a run was going, waiting to be sent when it ends. */
export interface QueuedMessage {
  id: string;
  text: string;
}

/** What `session.send` did: started a run, or queued the message behind the one going. */
export type SendResult = { runId: string } | { queued: QueuedMessage };

export interface SessionSnapshot {
  id: string;
  /** The workspace the session belongs to; absent only from hosts built outside a workspace (tests). */
  workspaceId?: string;
  modelRef: string;
  mode: PermissionMode;
  /** Full display history (distinct from the model's context window). */
  transcript: TranscriptItem[];
  usage?: Usage;
  context?: ContextSnapshot;
  running: boolean;
  pendingAsk?: {
    askId: string;
    toolName: string;
    input: unknown;
    reason: string;
    forcedByRule?: boolean;
    alwaysAllow?: string;
  };
  pendingPlan?: { planId: string; title: string; body: string; yesMode?: PermissionMode };
  /** Messages waiting for the run to end, oldest first; absent when none. */
  queue?: QueuedMessage[];
  /** Current reasoning effort; absent when the model has no reasoning channel. */
  effort?: ReasoningEffort;
  /** Levels the model offers, Faster→Smarter; empty (or absent) without reasoning. */
  effortLevels?: ReasoningEffort[];
  lastSeq: number;
  /**
   * Identifies the live host behind this snapshot; absent from a disk-only
   * preview. A session resumed after its host was closed gets a new epoch and
   * its `seq` starts over, so `seq`s only compare within one epoch.
   */
  epoch?: string;
}

export type SubscribeResult = { lastSeq: number } | { reset: true; snapshot: SessionSnapshot };

export type AskDecision = 'once' | 'always' | 'deny' | 'auto';

// ---------------------------------------------------------------------------
// Method table
// ---------------------------------------------------------------------------

/**
 * Tied to core's `PermissionMode` via `z.ZodType<PermissionMode>` so the
 * schema fails to typecheck the moment the two definitions drift, without
 * ever importing `PermissionMode` as a runtime value.
 */
const permissionModeSchema: z.ZodType<PermissionMode> = z.enum([
  'ask',
  'plan',
  'acceptEdits',
  'readOnly',
  'yolo',
  'auto',
]);

/** Tied to core's `ReasoningEffort` the same way. */
const reasoningEffortSchema: z.ZodType<ReasoningEffort> = z.enum([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
]);

/**
 * Session ids end up in file paths (`sessions/<id>.jsonl`): only the characters
 * a generated id uses get through, so no request can reach outside a sessions
 * directory.
 */
const sessionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, 'not a session id');
/** Workspace ids are hex digests. */
const workspaceIdSchema = z.string().regex(/^[0-9a-f]{1,64}$/, 'not a workspace id');
const pathSchema = z.string().min(1).max(4096);

interface MethodSpec<P = unknown, R = unknown> {
  /** Validates `ClientFrame.params` for this method — same schema on client and server. */
  params: z.ZodType<P>;
  /** Phantom marker carrying the result type. Never assigned; read only via `MethodResult`. */
  result?: R;
}

function method<P, R>(params: z.ZodType<P>): MethodSpec<P, R> {
  return { params };
}

export const methods = {
  'server.info': method<void, ServerInfo>(z.void()),
  'session.list': method<void, SessionSummary[]>(z.void()),
  'workspace.list': method<void, Workspace[]>(z.void()),
  'workspace.inspect': method<{ path: string }, WorkspaceInspection>(z.object({ path: pathSchema })),
  /**
   * Add a directory as a workspace (or return the one already covering it).
   * `createMarker` confirms creating `<root>/.agent/` where `needsMarker` says so.
   */
  'workspace.add': method<{ path: string; createMarker?: boolean }, Workspace>(
    z.object({ path: pathSchema, createMarker: z.boolean().optional() }),
  ),
  /** Stop hosting a workspace (its files stay). `busy` while one of its sessions runs; the last one stays. */
  'workspace.remove': method<{ id: string }, void>(z.object({ id: workspaceIdSchema })),
  /**
   * The models a session in `workspaceId` (default: the most recently used
   * workspace) can be given: its default model first, then `settings.models`,
   * the small model and the built-in lineup.
   */
  'model.list': method<{ workspaceId?: string }, ModelInfo[]>(z.object({ workspaceId: workspaceIdSchema.optional() })),
  /** Directories completing a path prefix (`~` allowed), for the add dialog. */
  'fs.suggestDirs': method<{ prefix: string }, DirSuggestion[]>(z.object({ prefix: z.string().max(4096) })),
  /** Created in `workspaceId` (default: the most recently used workspace). */
  'session.create': method<
    { workspaceId?: string; model?: string; mode?: PermissionMode; effort?: ReasoningEffort },
    SessionSnapshot
  >(
    z.object({
      workspaceId: workspaceIdSchema.optional(),
      model: z.string().optional(),
      mode: permissionModeSchema.optional(),
      effort: reasoningEffortSchema.optional(),
    }),
  ),
  /**
   * Create a session and send its first message in one step — how a draft
   * becomes a session, so nothing is created until there is something to say.
   * The snapshot is taken before the message is sent: subscribing from seq 0
   * replays the startup notices and then the run.
   */
  'session.start': method<
    { text: string; workspaceId?: string; model?: string; mode?: PermissionMode; effort?: ReasoningEffort },
    { snapshot: SessionSnapshot; runId: string }
  >(
    z.object({
      text: z.string(),
      workspaceId: workspaceIdSchema.optional(),
      model: z.string().optional(),
      mode: permissionModeSchema.optional(),
      effort: reasoningEffortSchema.optional(),
    }),
  ),
  'session.open': method<{ id: string }, SessionSnapshot>(z.object({ id: sessionIdSchema })),
  /** Disk transcript only — no MCP / `AgentSession.create`. Used to render old sessions fast. */
  'session.preview': method<{ id: string }, SessionSnapshot>(z.object({ id: sessionIdSchema })),
  /** Replays the gap after `sinceSeq` when `epoch` (if given) is still the live host's; else `reset`. */
  'session.subscribe': method<{ id: string; sinceSeq?: number; epoch?: string }, SubscribeResult>(
    z.object({ id: sessionIdSchema, sinceSeq: z.number().optional(), epoch: z.string().optional() }),
  ),
  'session.unsubscribe': method<{ id: string }, void>(z.object({ id: sessionIdSchema })),
  /**
   * Send a message: it starts a run, or — while one is going — waits in the
   * session's queue and is sent when the run ends (every client sees the
   * queue, as `queue` events).
   */
  'session.send': method<{ id: string; text: string }, SendResult>(
    z.object({ id: sessionIdSchema, text: z.string() }),
  ),
  /**
   * Stop the run; a pending prompt settles as a deny. The queue is emptied too:
   * what was waiting comes back, for the client that stopped to put it back
   * in its composer.
   */
  'session.abort': method<{ id: string }, { unqueued: QueuedMessage[] }>(z.object({ id: sessionIdSchema })),
  /** Take a queued message back before it is sent (to drop or edit it); null when it already went. */
  'session.unqueue': method<{ id: string; queuedId: string }, QueuedMessage | null>(
    z.object({ id: sessionIdSchema, queuedId: z.string().max(128) }),
  ),
  'session.setMode': method<{ id: string; mode: PermissionMode }, void>(
    z.object({ id: sessionIdSchema, mode: permissionModeSchema }),
  ),
  /**
   * Switch the session's model; the history carries over and the next message
   * goes to the new one. `busy` while a run is going; `bad_request` for a model
   * that can't be resolved (unknown provider, missing key).
   */
  'session.setModel': method<{ id: string; model: string }, void>(
    z.object({ id: sessionIdSchema, model: z.string().min(1).max(256) }),
  ),
  /**
   * Change the reasoning effort; it applies from the next message (a run in
   * progress keeps the level it started with). `bad_request` for a level the
   * model doesn't offer, or a model without reasoning.
   */
  'session.setEffort': method<{ id: string; effort: ReasoningEffort }, void>(
    z.object({ id: sessionIdSchema, effort: reasoningEffortSchema }),
  ),
  'session.compact': method<
    { id: string },
    { tokensBefore: number; tokensAfter: number } | null
  >(z.object({ id: sessionIdSchema })),
  'session.slashCommands': method<{ id: string }, SlashCommandInfo[]>(z.object({ id: sessionIdSchema })),
  'session.close': method<{ id: string }, void>(z.object({ id: sessionIdSchema })),
  /**
   * Rename, pin or archive a session; answers with its new row (also pushed).
   * An empty title goes back to the one taken from its first message.
   */
  'session.update': method<
    { id: string; title?: string; pinned?: boolean; archived?: boolean },
    SessionSummary
  >(
    z.object({
      id: sessionIdSchema,
      title: z.string().max(200).optional(),
      pinned: z.boolean().optional(),
      archived: z.boolean().optional(),
    }),
  ),
  /**
   * Delete a session for good: its log, metadata, offloaded output and trace.
   * `busy` while it runs; a live, idle one is closed first.
   */
  'session.delete': method<{ id: string }, void>(z.object({ id: sessionIdSchema })),
  'ask.answer': method<
    { sessionId: string; askId: string; decision: AskDecision; feedback?: string },
    void
  >(
    z.object({
      sessionId: sessionIdSchema,
      askId: z.string(),
      decision: z.enum(['once', 'always', 'deny', 'auto']),
      feedback: z.string().optional(),
    }),
  ),
  'plan.answer': method<
    { sessionId: string; planId: string; approved: boolean; feedback?: string; mode?: PermissionMode },
    void
  >(
    z.object({
      sessionId: sessionIdSchema,
      planId: z.string(),
      approved: z.boolean(),
      feedback: z.string().optional(),
      mode: permissionModeSchema.optional(),
    }),
  ),
} satisfies Record<string, MethodSpec>;

export type MethodName = keyof typeof methods;
export type MethodParams<M extends MethodName> = z.infer<(typeof methods)[M]['params']>;
export type MethodResult<M extends MethodName> = NonNullable<(typeof methods)[M]['result']>;

/**
 * A type-safe `call(method, params)` — `params` is required unless `M`'s
 * params type is `void`, so no-arg methods like `server.info` can be called
 * as `call('server.info')`.
 */
export interface Call {
  <M extends MethodName>(
    method: M,
    ...args: MethodParams<M> extends void ? [] : [params: MethodParams<M>]
  ): Promise<MethodResult<M>>;
}
