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
  BackgroundProcessInfo,
  ContextSnapshot,
  ImageInput,
  StatsRollup,
  TraceEvent,
  TraceSummary,
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
  /** The editors on this machine a file can be opened in (`editor.open`). */
  editors: EditorInfo[];
  capabilities: {
    /** Terminals can be opened (`terminal.*`): node-pty loaded on this machine. */
    terminal: boolean;
    /** The system's folder chooser can be shown on this machine (`fs.pickDir`). */
    pickFolder?: boolean;
  };
}

/** A terminal running in a workspace (`terminal.*`). */
export interface TerminalInfo {
  id: string;
  workspaceId: string;
  /** The shell's name ("zsh"); a client shows the title the shell sets, when it sets one. */
  title: string;
  cwd: string;
  createdAt: number;
  /** The shell's exit code, once it has exited; the terminal stays until closed. */
  exitCode?: number;
}

export type EditorId = 'vscode' | 'cursor' | 'zed';

export interface EditorInfo {
  id: EditorId;
  /** "VS Code", "Cursor", "Zed". */
  name: string;
}

/** One entry of a workspace folder (`fs.list`). */
export interface DirEntry {
  name: string;
  dir: boolean;
}

/** A workspace file's contents (`fs.read`). */
export type FileContent =
  | { kind: 'text'; content: string }
  | { kind: 'binary' }
  /** Too big, a secret, missing, or linking outside the workspace. */
  | { kind: 'withheld'; reason: string };

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

/** A project `marvis web` hosts sessions for. */
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
  /** The session works in a git worktree of its own, on this branch; `missing` once archiving removed it. */
  worktree?: { branch: string; missing?: boolean };
  /**
   * Server-wide, increasing with every row the server computes (per boot):
   * of two rows for one session, the higher `rev` is the newer state.
   */
  rev: number;
}

/**
 * A message sent while a run was going, waiting: to be sent when the run
 * ends, or — `steer` — to be read by the agent at its next step.
 */
export interface QueuedMessage {
  id: string;
  text: string;
  /** Workspace files to read into it (`@path`). */
  attachments?: string[];
  /** Images in it. */
  images?: ImageInput[];
  /** Read at the run's next step, not after it (sent as a message if the run ends first). */
  steer?: boolean;
}

/** An installed skill, for the `/` menu (`/name` loads it). */
export interface SkillInfo {
  name: string;
  description: string;
}

/** A file matching an `@` query (`fs.search`). */
export interface FileMatch {
  /** Relative to the workspace root, `/`-separated. */
  path: string;
}

/** How a file differs, on one side of the index. */
export type GitChange = 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'typechange' | 'untracked' | 'conflicted';

/** One changed file in a workspace (`git.status`). */
export interface GitFile {
  /** Relative to the workspace root, `/`-separated. */
  path: string;
  /** Where a rename or copy came from. */
  oldPath?: string;
  /** Staged change (index vs HEAD), if any. */
  staged?: GitChange;
  /** Unstaged change (work tree vs index), if any; `untracked` for a new file git doesn't track. */
  unstaged?: GitChange;
  /** Lines added / removed against HEAD, staged and unstaged together; absent for a binary file. */
  added?: number;
  removed?: number;
  binary?: boolean;
}

/** A workspace's git state: its changes against HEAD, under the workspace directory. */
export type GitStatus =
  | { repo: false }
  | {
      repo: true;
      /** Null on a detached HEAD. */
      branch: string | null;
      upstream?: string;
      ahead: number;
      behind: number;
      files: GitFile[];
    };

/** One file's changes against HEAD, as `git diff` prints them (`git.diff`). */
export type GitDiff =
  | { kind: 'text'; patch: string }
  | { kind: 'binary' }
  /** Too big to show, or a secret the server won't send. */
  | { kind: 'withheld'; reason: string };

/** A commit just made (`git.commit`). */
export interface GitCommitResult {
  /** Abbreviated hash. */
  sha: string;
  /** The message's first line. */
  summary: string;
}

/** A repository's local branches, for picking what a worktree starts from (`git.branches`). */
export type GitBranches =
  | { repo: false }
  | {
      repo: true;
      /** The branch the project's checkout is on; null when HEAD is detached. */
      current: string | null;
      /** Most recently committed first; empty in a repository without commits. */
      branches: string[];
    };

/** The git worktree a session works in, apart from the project's checkout (`session.start {worktree}`). */
export interface SessionWorktree {
  /** The branch made for it. */
  branch: string;
  /** What the branch started from. */
  base: string;
  /** The worktree's top directory. */
  path: string;
  /** Where in it the session works: the workspace's place in the repository. */
  cwd: string;
  /** It was removed (archiving does that); the session's next run checks the branch out again. */
  missing?: boolean;
}

/** One session's trace, folded (`stats.summary`), with the workspace it belongs to. */
export type SessionStats = TraceSummary & { workspaceId: string };

/** What every session's trace adds up to (`stats.summary`), and each one's. */
export interface StatsSummary {
  rollup: StatsRollup;
  /** Newest first. */
  sessions: SessionStats[];
}

/** One session's trace (`session.trace`): every event, and what they add up to. */
export interface SessionTrace {
  events: TraceEvent[];
  summary: TraceSummary;
}

/** Permission rules as a settings file lists them: `Tool` or `Tool(specifier)`. */
export interface PermissionRules {
  allow: string[];
  ask: string[];
  deny: string[];
}

export type PermissionRuleList = keyof PermissionRules;

/** What the auto-mode classifier is told, group by group. */
export const AUTO_MODE_GROUPS = ['environment', 'allow', 'soft_deny', 'hard_deny'] as const;
export type AutoModeGroup = (typeof AUTO_MODE_GROUPS)[number];

/** The settings a workspace's sessions run with that the settings page edits (`settings.get`). */
export interface SettingsView {
  /** `~/.agent/settings.json`: every project's. */
  user: { path: string; rules: PermissionRules };
  /** The project's `.agent/settings.json`. */
  project: { path: string; rules: PermissionRules };
  /** What every session allows before these rules: read-only tools and commands. */
  builtinAllow: string[];
  autoMode: {
    /** Why sessions here can't use auto mode, when they can't. */
    unavailable?: string;
    /**
     * Each group as `~/.agent/settings.json` has it (auto mode is set per
     * user, never per project): a missing group is the built-in rules, and
     * `$defaults` in a list splices them in there.
     */
    rules: Partial<Record<AutoModeGroup, string[]>>;
    builtin: Record<AutoModeGroup, string[]>;
  };
  /**
   * Whether sessions may start commands in the background
   * (`backgroundProcesses`), as each file says; either turns it on. Off by
   * default: it changes the tools the model is shown.
   */
  backgroundProcesses: { user: boolean; project: boolean };
  /** Settings files that couldn't be read, `path: reason`: left out above, and never written over. */
  problems: string[];
}

/** A model provider, as the settings page shows it. Its key is never part of this. */
export interface ProviderInfo {
  /** The `provider` of a `provider/model` ref. */
  id: string;
  label: string;
  baseUrl: string;
  /** It can't be used without a key; a local runtime needs none. */
  requiresKey: boolean;
  /** The variable `providers.setKey` saves its key under in `~/.agent/.env`; absent for one that takes none. */
  keyVar?: string;
  /**
   * Where the key in use comes from, absent when there is none: the real
   * `environment`, the `project`'s `.env`, the `user`'s `~/.agent/.env` (the
   * one `providers.setKey` writes), or a literal in `settings`. The first that
   * has it wins, in that order after `settings`.
   */
  keySource?: 'settings' | 'environment' | 'project' | 'user';
  /** The variable that key is in, for the three that are environments. */
  keySourceVar?: string;
}

/** The providers a workspace's sessions can use, and the model new ones start on (`providers.list`). */
export interface ProvidersView {
  providers: ProviderInfo[];
  /** `~/.agent/.env`: where keys set here are saved, for every project. */
  envPath: string;
  /** The model new sessions start on. */
  model: string;
  /** Which settings say so — the project's win over yours; absent for the built-in default. */
  modelSource?: 'project' | 'user';
  /** `~/.agent/settings.json`: where `providers.setModel` writes. */
  settingsPath: string;
  /** Settings files that couldn't be read, `path: reason`. */
  problems: string[];
}

/** A call auto mode refused in a live session. */
export interface AutoModeDenialInfo {
  id: string;
  toolName: string;
  /** The call, in a line. */
  summary: string;
  reason: string;
  at: number;
  /** A retry was allowed: the agent hears so on its next turn. */
  retry?: boolean;
}

/** A live session's auto-mode denials (`autoMode.denials`), newest first. */
export interface SessionDenials {
  sessionId: string;
  workspaceId: string;
  /** Auto mode stopped deciding after repeated denials: calls ask until one is approved. */
  paused: boolean;
  denials: AutoModeDenialInfo[];
}

/**
 * A file the memory section edits: an instructions file (`AGENTS.md` or
 * `CLAUDE.md`, in `~/.agent/` or at the project's root) or an entry in a
 * memory store (`~/.agent/memory/` or the project's `.agent/memory/`).
 */
export type MemoryTarget =
  | { kind: 'instructions'; scope: 'user' | 'project'; name: 'AGENTS.md' | 'CLAUDE.md' }
  | { kind: 'memory'; scope: 'global' | 'project'; path: string };

export interface InstructionFileInfo {
  scope: 'user' | 'project';
  name: 'AGENTS.md' | 'CLAUDE.md';
  path: string;
  /** Absent when there is no such file yet. */
  bytes?: number;
}

export interface MemoryFileInfo {
  scope: 'global' | 'project';
  /** From the store's top, e.g. `feedback/no-mocks.md`. */
  path: string;
  name: string;
  description: string;
  type: string;
  bytes: number;
  /** Why sessions skip it: its frontmatter doesn't parse, or says too little. */
  problem?: string;
}

/** What sessions in a workspace remember and are told (`memory.list`). */
export interface MemoryView {
  /** Per scope, the instruction files there — or `AGENTS.md`, not yet written. */
  instructions: InstructionFileInfo[];
  memories: MemoryFileInfo[];
  dirs: { global: string; project: string };
}

/** An MCP server a workspace's sessions connect to (`mcp.list`). */
export interface McpServerInfo {
  name: string;
  /** Whose `.mcp.json` names it: `~/.agent/.mcp.json`, or the project's. */
  scope: 'user' | 'project';
  transport: 'stdio' | 'http' | 'sse';
  /** The command line or URL as the file has it, `${VAR}`s unexpanded. */
  target: string;
  /** How it signs in: not at all (stdio), with a header the file sets, or with OAuth. */
  auth: 'none' | 'header' | 'oauth';
  /** OAuth: tokens are stored for it. */
  signedIn?: boolean;
  /** The project's server of the same name is the one used. */
  shadowed?: boolean;
}

export interface McpView {
  servers: McpServerInfo[];
  userPath: string;
  projectPath: string;
  /** Config files that couldn't be read, `path: reason`. */
  problems: string[];
}

/**
 * An MCP server's entry in its file, as it can be edited (`mcp.get`,
 * `mcp.save`). An env or header value the file has as a literal — a secret,
 * perhaps — comes back `null` and is never sent: saved as `null`, the file
 * keeps it. One that only names `${VAR}`s is shown as it is.
 */
export interface McpServerEntry {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  /** stdio: the command it runs, and its arguments. */
  command?: string;
  args?: string[];
  env?: Record<string, string | null>;
  /** http/sse: where it is, and the headers sent with each request. */
  url?: string;
  headers?: Record<string, string | null>;
  /** How it signs in, when not left to decide: OAuth unless a header sets `Authorization`. */
  auth?: 'oauth' | 'none';
}

/** What connecting to an MCP server as a session would found (`mcp.test`). */
export type McpTestResult =
  | { ok: true; tools: Array<{ name: string; description?: string }> }
  | { ok: false; error: string; needsAuth?: boolean };

/** Where a skill is: the project's `.agent/skills/`, your `~/.agent/skills/`, or among those Marvis ships with. */
export type SkillScope = 'project' | 'user' | 'builtin';

/** A skill as the settings page lists it (`skills.list`). */
export interface SkillEntryInfo {
  /** Its folder's name — the skill's, when its SKILL.md parses. */
  name: string;
  description: string;
  scope: SkillScope;
  /** Its folder. */
  dir: string;
  /** A skill of the same name before it — the project's, then yours, then the built-in ones — is the one used. */
  shadowed?: boolean;
  /** Why sessions skip it: its SKILL.md doesn't parse, or says too little. */
  problem?: string;
}

export interface SkillsView {
  skills: SkillEntryInfo[];
  /** Where each scope's skills are, a folder for each. */
  dirs: Record<SkillScope, string>;
}

/** What `skills.import` brought in. */
export interface SkillsImportResult {
  view: SkillsView;
  /** The skills copied in, by name. */
  imported: string[];
  /** Folders with a SKILL.md that weren't: `name: why`. */
  skipped: string[];
}

/** Where a sub-agent is defined: the project's `.agent/agents/`, your `~/.agent/agents/`, or among those Marvis ships with. */
export type AgentScope = 'project' | 'user' | 'builtin';

/** What a sub-agent's file says, as the settings page edits it (`agents.get`, `agents.save`). */
export interface AgentFields {
  /** What it's for: the agent picks a sub-agent by this. */
  description: string;
  /** The built-in tools it may use; omitted: all the session has. Empty: none. */
  tools?: string[];
  /** `provider/model`; omitted: the session's. */
  model?: string;
  /** Reasoning effort; omitted: the session's. */
  effort?: string;
  /** Its role instructions. */
  body: string;
}

/** A sub-agent as the settings page lists it (`agents.list`). */
export interface AgentEntryInfo {
  /** Its file's name, without `.md` — the sub-agent's, when the file parses. */
  name: string;
  scope: AgentScope;
  /** Its file. */
  path: string;
  description: string;
  tools?: string[];
  model?: string;
  effort?: string;
  /** One of the same name before it — the project's, then yours, then the built-in ones — is the one used. */
  shadowed?: boolean;
  /** Why sessions skip it: its file doesn't parse, or says too little. */
  problem?: string;
}

export interface AgentsView {
  agents: AgentEntryInfo[];
  /** Where each scope's sub-agents are, a `<name>.md` for each. */
  dirs: Record<AgentScope, string>;
  /** The built-in tools a sub-agent can be given (never `task`: it can't send sub-agents of its own). */
  tools: Array<{ name: string; readOnly: boolean }>;
  /** The reasoning efforts a definition may ask for. */
  efforts: string[];
}

/** A background command and the tail of what it printed (`SessionSnapshot.processes`). */
export type SessionProcess = BackgroundProcessInfo & { output: string };

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
    /** A `write` over an existing file: the file as it is now. */
    before?: string;
  };
  pendingPlan?: { planId: string; title: string; body: string; yesMode?: PermissionMode };
  /** Messages waiting for the run to end, oldest first; absent when none. */
  queue?: QueuedMessage[];
  /** Current reasoning effort; absent when the model has no reasoning channel. */
  effort?: ReasoningEffort;
  /** Levels the model offers, Faster→Smarter; empty (or absent) without reasoning. */
  effortLevels?: ReasoningEffort[];
  /** The worktree the session works in; absent for one in the project's checkout. */
  worktree?: SessionWorktree;
  /** The commands it started in the background, oldest first; absent when none. */
  processes?: SessionProcess[];
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
const terminalIdSchema = z.string().regex(/^[a-z0-9-]{1,64}$/, 'not a terminal id');
const terminalSizeSchema = z.number().int().min(1).max(1000);
/** The files a git change applies to: workspace-relative paths. */
const gitPathsSchema = z.object({
  workspaceId: workspaceIdSchema,
  sessionId: sessionIdSchema.optional(),
  paths: z.array(pathSchema).min(1).max(1000),
});
/** Files attached to a message (`@path`): workspace-relative paths. */
const attachmentsSchema = z.array(pathSchema).max(20);
/**
 * Images in a message: base64 (5 MB decoded at most, checked again against the
 * model and the count by the session), PNG, JPEG, GIF or WebP.
 */
const imagesSchema: z.ZodType<ImageInput[]> = z
  .array(
    z.object({
      mediaType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
      data: z.string().min(1).max(7_000_000).regex(/^[A-Za-z0-9+/]+={0,2}$/, 'not base64'),
    }),
  )
  .max(8);
/** A worktree of its own for a new session, branched off `base` (a branch or commit). */
const worktreeSchema = z.object({ base: z.string().min(1).max(256).regex(/^[^-\s][^\s]*$/, 'not a branch name') });

const memoryTargetSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('instructions'),
    scope: z.enum(['user', 'project']),
    name: z.enum(['AGENTS.md', 'CLAUDE.md']),
  }),
  z.object({
    kind: z.literal('memory'),
    scope: z.enum(['global', 'project']),
    path: z.string().regex(/^[A-Za-z0-9_-]+\/[A-Za-z0-9._-]+\.md$/, 'not a memory path'),
  }),
]);
const mcpNameSchema = z.string().min(1).max(128);
const mcpScopeSchema = z.enum(['user', 'project']);
/** Secrets and values a server is given: `null` keeps the one its file has. */
const mcpValuesSchema = z.record(z.string().min(1).max(256), z.string().max(16 * 1024).nullable());
const mcpServerEntrySchema = z.object({
  // What a tool's name can carry: sessions call its tools `mcp__<name>__<tool>`.
  name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'a server name is letters, digits, - and _'),
  transport: z.enum(['stdio', 'http', 'sse']),
  command: z.string().max(4096).optional(),
  args: z.array(z.string().max(4096)).max(200).optional(),
  env: mcpValuesSchema.optional(),
  url: z.string().max(4096).optional(),
  headers: mcpValuesSchema.optional(),
  auth: z.enum(['oauth', 'none']).optional(),
});
const agentFieldsSchema = z.object({
  description: z.string().max(1024),
  tools: z.array(z.string().min(1).max(64)).max(64).optional(),
  model: z.string().max(256).optional(),
  effort: z.string().max(16).optional(),
  body: z.string().max(128 * 1024),
});
/** A sub-agent's file name without `.md`, as it is on disk. */
const agentFileSchema = z.string().min(1).max(255).regex(/^(?!\.\.?$)[^/\\\0]+$/, 'not a sub-agent file');
/** A skill's folder as it is on disk — one whose SKILL.md doesn't parse may be named otherwise. */
const skillDirSchema = z.string().min(1).max(255).regex(/^(?!\.\.?$)[^/\\\0]+$/, 'not a skill folder');
const skillNameSchema = z
  .string()
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'a skill name is lowercase letters and digits, words joined by single hyphens');
const agentNameSchema = z
  .string()
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'a sub-agent name is lowercase letters and digits, words joined by single hyphens');

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
  /**
   * Files in a workspace matching `query` (fuzzy, best first), for `@`
   * mentions. Ignored files (`.gitignore`) and secrets (`.env`, keys) are left
   * out.
   */
  'fs.search': method<{ workspaceId: string; sessionId?: string; query: string; limit?: number }, FileMatch[]>(
    z.object({
      workspaceId: workspaceIdSchema,
      sessionId: sessionIdSchema.optional(),
      query: z.string().max(512),
      limit: z.number().int().min(1).max(200).optional(),
    }),
  ),
  /** The terminals open in a workspace, oldest first. */
  'terminal.list': method<{ workspaceId: string }, TerminalInfo[]>(z.object({ workspaceId: workspaceIdSchema })),
  /** Start the user's shell in the workspace's root (or the session's worktree), sized `cols` × `rows`. */
  'terminal.create': method<{ workspaceId: string; sessionId?: string; cols: number; rows: number }, TerminalInfo>(
    z.object({
      workspaceId: workspaceIdSchema,
      sessionId: sessionIdSchema.optional(),
      cols: terminalSizeSchema,
      rows: terminalSizeSchema,
    }),
  ),
  /**
   * Receive a terminal's output on this socket (`{t:'term'}` frames), starting
   * with what it kept of the output so far.
   */
  'terminal.attach': method<{ id: string }, { scrollback: string; exitCode?: number }>(
    z.object({ id: terminalIdSchema }),
  ),
  'terminal.detach': method<{ id: string }, void>(z.object({ id: terminalIdSchema })),
  /** Keystrokes and pastes, as the terminal would get them. */
  'terminal.input': method<{ id: string; data: string }, void>(
    z.object({ id: terminalIdSchema, data: z.string().max(1024 * 1024) }),
  ),
  'terminal.resize': method<{ id: string; cols: number; rows: number }, void>(
    z.object({ id: terminalIdSchema, cols: terminalSizeSchema, rows: terminalSizeSchema }),
  ),
  /** End the shell (if it still runs) and forget the terminal. */
  'terminal.close': method<{ id: string }, void>(z.object({ id: terminalIdSchema })),
  /**
   * A workspace folder's entries (`dir` relative to its root, `''` for the
   * root): folders first. What `.gitignore` leaves out and secrets aren't listed.
   */
  'fs.list': method<{ workspaceId: string; sessionId?: string; dir: string }, DirEntry[]>(
    z.object({ workspaceId: workspaceIdSchema, sessionId: sessionIdSchema.optional(), dir: z.string().max(4096) }),
  ),
  /** A workspace file's text; binary, over 1 MB, a secret or outside the workspace: withheld. */
  'fs.read': method<{ workspaceId: string; sessionId?: string; path: string }, FileContent>(
    z.object({ workspaceId: workspaceIdSchema, sessionId: sessionIdSchema.optional(), path: pathSchema }),
  ),
  /** Open a workspace file in an editor on this machine, at a line. */
  'editor.open': method<{ workspaceId: string; sessionId?: string; path: string; line?: number; editor: EditorId }, void>(
    z.object({
      workspaceId: workspaceIdSchema,
      sessionId: sessionIdSchema.optional(),
      path: pathSchema,
      line: z.number().int().min(1).optional(),
      editor: z.enum(['vscode', 'cursor', 'zed']),
    }),
  ),
  /**
   * The workspace's changes against HEAD — with `sessionId`, those of the
   * checkout that session works in: its worktree, if it has one. Every `git.*`
   * and `fs.*` call takes `sessionId` the same way.
   */
  'git.status': method<{ workspaceId: string; sessionId?: string }, GitStatus>(
    z.object({ workspaceId: workspaceIdSchema, sessionId: sessionIdSchema.optional() }),
  ),
  /**
   * One file's changes (`path` relative to the workspace root): against HEAD,
   * or just its `staged` (HEAD → index) or `unstaged` (index → work tree) ones.
   */
  'git.diff': method<
    { workspaceId: string; sessionId?: string; path: string; side?: 'all' | 'staged' | 'unstaged' },
    GitDiff
  >(
    z.object({
      workspaceId: workspaceIdSchema,
      sessionId: sessionIdSchema.optional(),
      path: pathSchema,
      side: z.enum(['all', 'staged', 'unstaged']).optional(),
    }),
  ),
  /**
   * Stage, unstage or discard one hunk of a file — its text as `git.diff`
   * showed it, from its `@@` line: staging and discarding take it from the
   * unstaged changes, unstaging from the staged ones. `bad_request` when the
   * file changed since and that hunk is no longer there.
   */
  'git.applyHunk': method<
    { workspaceId: string; sessionId?: string; path: string; hunk: string; action: 'stage' | 'unstage' | 'discard' },
    void
  >(
    z.object({
      workspaceId: workspaceIdSchema,
      sessionId: sessionIdSchema.optional(),
      path: pathSchema,
      hunk: z.string().min(1).max(1024 * 1024),
      action: z.enum(['stage', 'unstage', 'discard']),
    }),
  ),
  /** Stage files as they are on disk (changes, new files, deletions). */
  'git.stage': method<{ workspaceId: string; sessionId?: string; paths: string[] }, void>(gitPathsSchema),
  /** Take files out of the index, keeping the work tree. */
  'git.unstage': method<{ workspaceId: string; sessionId?: string; paths: string[] }, void>(gitPathsSchema),
  /**
   * Throw away every change to files: back to HEAD, or deleted when HEAD
   * doesn't have them (never a secret).
   */
  'git.revert': method<{ workspaceId: string; sessionId?: string; paths: string[] }, void>(gitPathsSchema),
  /** Commit what is staged, staging `paths` first when given (the files shown, when nothing was staged). */
  'git.commit': method<{ workspaceId: string; sessionId?: string; message: string; paths?: string[] }, GitCommitResult>(
    z.object({
      workspaceId: workspaceIdSchema,
      sessionId: sessionIdSchema.optional(),
      message: z.string().min(1).max(20_000),
      paths: z.array(pathSchema).min(1).max(1000).optional(),
    }),
  ),
  /** Push the branch, setting its upstream the first time. */
  'git.push': method<{ workspaceId: string; sessionId?: string }, void>(
    z.object({ workspaceId: workspaceIdSchema, sessionId: sessionIdSchema.optional() }),
  ),
  /** The repository's local branches, for picking what a new session's worktree starts from. */
  'git.branches': method<{ workspaceId: string }, GitBranches>(z.object({ workspaceId: workspaceIdSchema })),
  /** Open a pull request for the branch with `gh` (into a worktree's base, for a session with one); answers its URL. */
  'git.createPr': method<
    { workspaceId: string; sessionId?: string; title: string; body?: string; draft?: boolean },
    { url: string }
  >(
    z.object({
      workspaceId: workspaceIdSchema,
      sessionId: sessionIdSchema.optional(),
      title: z.string().min(1).max(500),
      body: z.string().max(60_000).optional(),
      draft: z.boolean().optional(),
    }),
  ),
  /** Directories completing a path prefix (`~` allowed), for the add dialog. */
  'fs.suggestDirs': method<{ prefix: string }, DirSuggestion[]>(z.object({ prefix: z.string().max(4096) })),
  /**
   * Show the system's folder chooser (Finder's on a Mac) on the machine the
   * server runs on; the folder picked, or null when it was cancelled.
   */
  'fs.pickDir': method<void, { path: string | null }>(z.void()),
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
   * replays the startup notices and then the run. With `worktree`, the session
   * works in a git worktree of its own, on a new branch off `base`.
   */
  'session.start': method<
    {
      text: string;
      attachments?: string[];
      images?: ImageInput[];
      workspaceId?: string;
      model?: string;
      mode?: PermissionMode;
      effort?: ReasoningEffort;
      worktree?: { base: string };
    },
    { snapshot: SessionSnapshot; runId: string }
  >(
    z.object({
      text: z.string(),
      attachments: attachmentsSchema.optional(),
      images: imagesSchema.optional(),
      workspaceId: workspaceIdSchema.optional(),
      model: z.string().optional(),
      mode: permissionModeSchema.optional(),
      effort: reasoningEffortSchema.optional(),
      worktree: worktreeSchema.optional(),
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
   * session's queue (every client sees the queue, as `queue` events) and is
   * sent when the run ends; with `steer`, the agent reads it at the run's next
   * step instead (a `user_input` event marks where). A `/command` always waits
   * for the run to end. `attachments` are workspace files read into it; one
   * the session may not read is `bad_request`, before anything is sent.
   */
  'session.send': method<
    { id: string; text: string; attachments?: string[]; images?: ImageInput[]; steer?: boolean },
    SendResult
  >(
    z.object({
      id: sessionIdSchema,
      text: z.string(),
      attachments: attachmentsSchema.optional(),
      images: imagesSchema.optional(),
      steer: z.boolean().optional(),
    }),
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
  /**
   * Take the conversation back to just before its `userMessage`-th user
   * message (0-based, as the transcript shows them): what came after leaves
   * the model's history and the transcript (a `rewound` event carries the new
   * one); files the agent changed stay as they are. `busy` while a run goes.
   */
  'session.rewind': method<{ id: string; userMessage: number }, void>(
    z.object({ id: sessionIdSchema, userMessage: z.number().int().min(0) }),
  ),
  /**
   * Start a new session with this one's conversation — whole, or as far as
   * just before its `userMessage`-th user message. A session in a worktree
   * forks into a worktree of its own, branched from the other's branch.
   */
  'session.fork': method<{ id: string; userMessage?: number }, { id: string }>(
    z.object({ id: sessionIdSchema, userMessage: z.number().int().min(0).optional() }),
  ),
  /** A session's trace — model calls, tool calls, compactions, runs — and its summary; empty when it has none. */
  'session.trace': method<{ id: string }, SessionTrace>(z.object({ id: sessionIdSchema })),
  /**
   * What the recorded sessions' traces add up to — tokens, cost, calls, by
   * model — in one workspace or all of them, from `since` (epoch ms) on.
   */
  'stats.summary': method<{ workspaceId?: string; since?: number }, StatsSummary>(
    z.object({ workspaceId: workspaceIdSchema.optional(), since: z.number().int().min(0).optional() }),
  ),
  /** The permission rules and auto-mode config a workspace's sessions run with. */
  'settings.get': method<{ workspaceId: string }, SettingsView>(z.object({ workspaceId: workspaceIdSchema })),
  /**
   * Replace one rule list in the user's settings or the project's; every
   * live session it applies to takes it up at once. `bad_request` for a rule
   * that doesn't parse, or a settings file that doesn't.
   */
  'settings.setRules': method<
    { workspaceId: string; scope: 'user' | 'project'; list: PermissionRuleList; rules: string[] },
    SettingsView
  >(
    z.object({
      workspaceId: workspaceIdSchema,
      scope: z.enum(['user', 'project']),
      list: z.enum(['allow', 'ask', 'deny']),
      rules: z.array(z.string().min(1).max(1000)).max(500),
    }),
  ),
  /** Replace one auto-mode group in the user's settings — `null`: back to the built-in rules. Live sessions take it up. */
  'settings.setAutoMode': method<
    { workspaceId: string; group: AutoModeGroup; rules: string[] | null },
    SettingsView
  >(
    z.object({
      workspaceId: workspaceIdSchema,
      group: z.enum(AUTO_MODE_GROUPS),
      rules: z.array(z.string().min(1).max(2000)).max(200).nullable(),
    }),
  ),
  /** Turn background commands on or off in the user's settings; sessions started afterwards have it. */
  'settings.setBackgroundProcesses': method<{ workspaceId: string; enabled: boolean }, SettingsView>(
    z.object({ workspaceId: workspaceIdSchema, enabled: z.boolean() }),
  ),
  /** The model providers a workspace's sessions can use, where each one's key comes from, and the default model. */
  'providers.list': method<{ workspaceId: string }, ProvidersView>(z.object({ workspaceId: workspaceIdSchema })),
  /**
   * Save a provider's API key in the user's `~/.agent/.env` — every project's —
   * or, with `null`, remove it from there. Sessions started afterwards use it;
   * every page hears the workspaces' new state. The key is never sent back.
   * `bad_request` for a provider that takes no key.
   */
  'providers.setKey': method<{ workspaceId: string; provider: string; key: string | null }, ProvidersView>(
    z.object({
      workspaceId: workspaceIdSchema,
      provider: z.string().min(1).max(64),
      // One printable token: what a key is, and what a `.env` line can hold.
      key: z
        .string()
        .min(1)
        .max(512)
        .regex(/^[\x21-\x7e]+$/, 'not an API key: one run of printable characters, no spaces')
        .nullable(),
    }),
  ),
  /**
   * Set the model new sessions start on (`model` in the user's settings) —
   * `provider/model` — or, with an empty string, go back to the built-in
   * default. `bad_request` for an unknown provider.
   */
  'providers.setModel': method<{ workspaceId: string; model: string }, ProvidersView>(
    z.object({ workspaceId: workspaceIdSchema, model: z.string().max(256) }),
  ),
  /** The live sessions auto mode refused something in — in one workspace, or all — newest denial first. */
  'autoMode.denials': method<{ workspaceId?: string }, SessionDenials[]>(
    z.object({ workspaceId: workspaceIdSchema.optional() }),
  ),
  /** Let the agent try a call auto mode refused once more: it's told so on its next turn. `bad_request` once the denial is gone. */
  'session.retryDenied': method<{ id: string; denialId: string }, void>(
    z.object({ id: sessionIdSchema, denialId: z.string().min(1).max(128) }),
  ),
  /** The instruction files and memories sessions in a workspace start with. */
  'memory.list': method<{ workspaceId: string }, MemoryView>(z.object({ workspaceId: workspaceIdSchema })),
  'memory.read': method<{ workspaceId: string; target: MemoryTarget }, { text: string }>(
    z.object({ workspaceId: workspaceIdSchema, target: memoryTargetSchema }),
  ),
  /**
   * Write an instructions file or a memory (made if missing). A memory must
   * parse as one — frontmatter with a description and a type its folder
   * allows — or it's `bad_request`. Sessions read them as they start.
   */
  'memory.write': method<{ workspaceId: string; target: MemoryTarget; text: string }, MemoryView>(
    z.object({ workspaceId: workspaceIdSchema, target: memoryTargetSchema, text: z.string().max(64 * 1024) }),
  ),
  'memory.delete': method<{ workspaceId: string; target: MemoryTarget }, MemoryView>(
    z.object({ workspaceId: workspaceIdSchema, target: memoryTargetSchema }),
  ),
  /** The MCP servers a workspace's sessions connect to, and whether each is signed in. */
  'mcp.list': method<{ workspaceId: string }, McpView>(z.object({ workspaceId: workspaceIdSchema })),
  /**
   * Sign in to an OAuth MCP server: answers with the page to authorize at
   * (an `mcp_login` push follows when that's done or failed), or at once
   * when its tokens still work. Sessions started afterwards connect with it.
   */
  'mcp.login': method<
    { workspaceId: string; name: string },
    { url: string } | { status: 'authorized' | 'already-authorized' }
  >(z.object({ workspaceId: workspaceIdSchema, name: mcpNameSchema })),
  /** Forget an MCP server's OAuth tokens. */
  'mcp.logout': method<{ workspaceId: string; name: string }, McpView>(
    z.object({ workspaceId: workspaceIdSchema, name: mcpNameSchema }),
  ),
  /** An MCP server's entry in the user's or the project's file, to edit: literal env and header values left out. */
  'mcp.get': method<{ workspaceId: string; scope: 'user' | 'project'; name: string }, McpServerEntry>(
    z.object({ workspaceId: workspaceIdSchema, scope: mcpScopeSchema, name: mcpNameSchema }),
  ),
  /**
   * Add an MCP server to `~/.agent/.mcp.json` or the project's `.mcp.json` —
   * or, with `previousName`, change the one of that name there, renaming it
   * when the names differ. An env or header value of `null` keeps the one the
   * file has. The entry must parse as a server, and a file that doesn't parse
   * is never written over (`bad_request`); `conflict` for a name the file
   * has already. Sessions started afterwards connect to it.
   */
  'mcp.save': method<
    { workspaceId: string; scope: 'user' | 'project'; server: McpServerEntry; previousName?: string },
    McpView
  >(
    z.object({
      workspaceId: workspaceIdSchema,
      scope: mcpScopeSchema,
      server: mcpServerEntrySchema,
      previousName: mcpNameSchema.optional(),
    }),
  ),
  /** Take an MCP server out of its file. */
  'mcp.remove': method<{ workspaceId: string; scope: 'user' | 'project'; name: string }, McpView>(
    z.object({ workspaceId: workspaceIdSchema, scope: mcpScopeSchema, name: mcpNameSchema }),
  ),
  /** Connect to an MCP server as a session would, list its tools, and let it go. */
  'mcp.test': method<{ workspaceId: string; scope: 'user' | 'project'; name: string }, McpTestResult>(
    z.object({ workspaceId: workspaceIdSchema, scope: mcpScopeSchema, name: mcpNameSchema }),
  ),
  /** The skills sessions in a workspace can load — the project's, yours and the built-in ones — and those they skip. */
  'skills.list': method<{ workspaceId: string }, SkillsView>(z.object({ workspaceId: workspaceIdSchema })),
  'skills.read': method<{ workspaceId: string; scope: SkillScope; name: string }, { text: string }>(
    z.object({ workspaceId: workspaceIdSchema, scope: z.enum(['project', 'user', 'builtin']), name: skillDirSchema }),
  ),
  /**
   * Write a skill's SKILL.md, its folder made if missing — with `create`,
   * `conflict` when there is one. It must parse as a skill named for its
   * folder (`bad_request`). Sessions started afterwards see it.
   */
  'skills.write': method<
    { workspaceId: string; scope: 'user' | 'project'; name: string; text: string; create?: boolean },
    SkillsView
  >(
    z.object({
      workspaceId: workspaceIdSchema,
      scope: mcpScopeSchema,
      name: skillNameSchema,
      text: z.string().max(256 * 1024),
      create: z.boolean().optional(),
    }),
  ),
  /** Delete a skill's folder, everything in it. */
  'skills.delete': method<{ workspaceId: string; scope: 'user' | 'project'; name: string }, SkillsView>(
    z.object({ workspaceId: workspaceIdSchema, scope: mcpScopeSchema, name: skillDirSchema }),
  ),
  /**
   * Copy skills in from `source`: a folder on this machine (absolute) or an
   * https Git URL — a GitHub `…/tree/<branch>/<path>` one names a folder in
   * it. A folder with a SKILL.md is one skill; otherwise every skill below
   * it, a few levels down. `conflict` when one is here already, unless
   * `replace`.
   */
  'skills.import': method<
    { workspaceId: string; scope: 'user' | 'project'; source: string; replace?: boolean },
    SkillsImportResult
  >(
    z.object({
      workspaceId: workspaceIdSchema,
      scope: mcpScopeSchema,
      source: z.string().min(1).max(4096),
      replace: z.boolean().optional(),
    }),
  ),
  /** The sub-agents sessions in a workspace can send — the project's, yours and the built-in ones — and those they skip. */
  'agents.list': method<{ workspaceId: string }, AgentsView>(z.object({ workspaceId: workspaceIdSchema })),
  /** A sub-agent's file, and — when it parses — what it says, to edit. */
  'agents.get': method<{ workspaceId: string; scope: AgentScope; name: string }, { text: string; fields?: AgentFields }>(
    z.object({ workspaceId: workspaceIdSchema, scope: z.enum(['project', 'user', 'builtin']), name: agentFileSchema }),
  ),
  /**
   * Write a sub-agent from its fields — new, or, with `previousName`, over
   * that one (renamed when the names differ), keeping what else its
   * frontmatter had. `conflict` for a name taken here; `bad_request` for
   * what wouldn't parse. Sessions started afterwards can send it.
   */
  'agents.save': method<
    { workspaceId: string; scope: 'user' | 'project'; name: string; fields: AgentFields; previousName?: string },
    AgentsView
  >(
    z.object({
      workspaceId: workspaceIdSchema,
      scope: mcpScopeSchema,
      name: agentNameSchema,
      fields: agentFieldsSchema,
      previousName: agentFileSchema.optional(),
    }),
  ),
  /** Write a sub-agent's file as it is; it must parse as one named for its file (`bad_request`). */
  'agents.write': method<{ workspaceId: string; scope: 'user' | 'project'; name: string; text: string }, AgentsView>(
    z.object({ workspaceId: workspaceIdSchema, scope: mcpScopeSchema, name: agentNameSchema, text: z.string().max(128 * 1024) }),
  ),
  'agents.delete': method<{ workspaceId: string; scope: 'user' | 'project'; name: string }, AgentsView>(
    z.object({ workspaceId: workspaceIdSchema, scope: mcpScopeSchema, name: agentFileSchema }),
  ),
  /** Stop a command the session started in the background, and what it started; answers once it has ended. */
  'session.killProcess': method<{ id: string; processId: string }, BackgroundProcessInfo>(
    z.object({ id: sessionIdSchema, processId: z.string().regex(/^bg\d{1,6}$/, 'not a process id') }),
  ),
  'session.compact': method<
    { id: string },
    { tokensBefore: number; tokensAfter: number } | null
  >(z.object({ id: sessionIdSchema })),
  'session.slashCommands': method<{ id: string }, SlashCommandInfo[]>(z.object({ id: sessionIdSchema })),
  /** The session's skills; sending `/name [task]` asks the model to load one. */
  'session.skills': method<{ id: string }, SkillInfo[]>(z.object({ id: sessionIdSchema })),
  'session.close': method<{ id: string }, void>(z.object({ id: sessionIdSchema })),
  /**
   * Rename, pin or archive a session; answers with its new row (also pushed).
   * An empty title goes back to the one taken from its first message.
   * Archiving removes the session's worktree, keeping its branch: `conflict`
   * when it has uncommitted changes, unless `force` (they are lost).
   */
  'session.update': method<
    { id: string; title?: string; pinned?: boolean; archived?: boolean; force?: boolean },
    SessionSummary
  >(
    z.object({
      id: sessionIdSchema,
      title: z.string().max(200).optional(),
      pinned: z.boolean().optional(),
      archived: z.boolean().optional(),
      force: z.boolean().optional(),
    }),
  ),
  /**
   * Delete a session for good: its log, metadata, offloaded output and trace,
   * and its worktree (the branch too, if merged). `busy` while it runs; a
   * live, idle one is closed first.
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
