/**
 * `AgentSession` — the stateful, multi-turn orchestrator.
 *
 * Three related objects, disambiguated:
 *
 *  - `SessionState` (`session.ts`) — the in-memory read ledger + todo list.
 *  - `SessionRecorder` (`session.ts`) — appends messages to the on-disk `.jsonl`.
 *  - `AgentSession` (this file) — the *live* orchestrator that owns the
 *    provider, permission engine, skills, sub-agents, MCP hub, compactor,
 *    recorder and trace, and runs turns on request.
 *
 * `AgentLoop` stays per-turn and stateless; this class is what turns it into a
 * multi-turn session the CLI (one-shot / REPL) and the TUI both drive through
 * the same renderer-agnostic surface. It deliberately never touches process
 * signals — SIGINT is 100% the frontend's job (`abort()` is the API here).
 */

import { randomUUID } from 'node:crypto';
import { open, realpath, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { resolveBudgets } from '../config/budgets.js';
import type { ResolvedBudgets } from '../config/budgets.js';
import {
  AGENT_DIR,
  findProjectRoot,
  loadSettings,
  resolveProjectMemoryDir,
  resolveStateDirs,
  writeUserSettings,
} from '../config/settings.js';
import type { AutoModeConfig, Settings } from '../config/settings.js';
import { createCompactor } from '../context/compactor.js';
import { loadProjectMemory } from '../context/memory.js';
import type { ProjectMemory } from '../context/memory.js';
import { estimateRequestTokens } from '../context/tokenizer.js';
import { fmtBreakdown, fmtBytes, fmtTokens } from '../util/format.js';
import {
  AutoModeClassifier,
  AutoModeState,
  applySubagentReview,
  collectAutoModeSetupContext,
  createPermissionEngine,
  createPermissionHooks,
  defaultPlanYesMode,
  draftAutoModeEnvironment as runAutoModeSetupDraft,
  isAutoModeAvailable,
  isSandboxExecAvailable,
  nonInteractiveAskHandler,
} from '../permissions/index.js';
import type {
  AskHandler,
  AutoModeAvailability,
  AutoModeDenial,
  AutoModeHookOptions,
  ClassifyResult,
  PermissionEngine,
  PermissionMode,
} from '../permissions/index.js';
import { BackgroundProcesses, builtinTools, createBackgroundTools, createBashTool, exitPlanModeTool, readTool } from '../tools/index.js';
import type { BackgroundProcessEvent, BackgroundProcessInfo } from '../tools/index.js';
import { isPdf } from '../tools/pdf.js';
import { PathEscapeError, assertInsideWorkspace, isInUploads } from '../permissions/paths.js';
import { attachedFileBlock, joinMessages } from './attachments.js';
import { ToolRegistry } from '../tools/registry.js';
import type { AnyToolSpec } from '../tools/types.js';
import { SkillCatalog, createSkillTool, createListSkillsTool, discoverSkills } from '../skills/index.js';
import type { Skill } from '../skills/index.js';
import {
  MemoryCatalog,
  MemoryWriteBuffer,
  builtinMemoryDir,
  createMemoryTool,
  discoverMemory,
  emptyMemoryManifest,
} from '../memory/index.js';
import {
  createTaskTool,
  discoverAgents,
  runSubagent,
  subagentToolSpecs,
} from '../subagents/index.js';
import type { AgentDefinition } from '../subagents/index.js';
import { McpHub, loadMcpConfig, resolveResources } from '../mcp/index.js';
import type { McpHubChanges, McpServerStatus } from '../mcp/index.js';
import { AGENT_CONVENTIONS, buildAgentSystemPrompt, buildSubagentSystemPrompt } from './prompt.js';
import { systemUpdateSegments } from './system-update.js';
import { AgentLoop, usableContextWindow } from './loop.js';
import type { AgentEvent, AgentLoopOptions, AgentRunResult, ToolCallEndEvent, ToolCallStartEvent } from './loop.js';
import { mergeHooks } from './hooks.js';
import type { AgentHooks } from './hooks.js';
import { createToolGuardrailHooks } from './guardrails.js';
import { createVerifyBeforeStopHooks } from './verify-stop.js';
import type { ActiveSkill, AgentControl } from './control.js';
import {
  SessionRecorder,
  SessionState,
  findSessionDir,
  loadSession,
  rebuildSessionState,
  sessionArtifactsDir,
} from './session.js';
import { TraceRecorder } from '../telemetry/trace.js';
import { ToolOutputStore } from '../context/tool-output.js';
import { IMAGE_MEDIA_TYPES, addUsage } from '../provider/types.js';
import type { ContentBlock, ImageBlock, Message, SystemSegment, Usage } from '../provider/types.js';
import { ProviderRegistry } from '../provider/router.js';
import type { ResolvedModel } from '../provider/router.js';
import { effortOptions, estimateCostUSD, mapEffort } from '../provider/capabilities.js';
import type { ReasoningEffort } from '../provider/types.js';
import type { ContextBreakdown } from '../context/budget.js';

// ---------------------------------------------------------------------------
// Notices: the cold, structured status channel
// ---------------------------------------------------------------------------

export type NoticeLevel = 'info' | 'warn' | 'error';

export type NoticeKind =
  | 'session-start'
  | 'project-memory'
  | 'skills-discovered'
  | 'agents-discovered'
  | 'mcp-status'
  /** An MCP server needs the user to sign in; `data` is `{ server }`. */
  | 'mcp-auth'
  | 'permission-mode'
  | 'mode-changed'
  | 'model-changed'
  | 'effort-changed'
  | 'skill-loaded'
  | 'memory'
  | 'sandbox-warn'
  | 'compaction'
  | 'context-warn'
  | 'provider-retry'
  | 'resource'
  | 'subagent'
  | 'auto-mode'
  | 'capabilities'
  | 'error';

export interface Notice {
  kind: NoticeKind;
  level: NoticeLevel;
  text: string;
  data?: unknown;
}

/** A context-window snapshot, exposed after each turn and to the TUI meter. */
export interface ContextSnapshot {
  usedTokens: number;
  windowTokens: number;
  ratio: number;
  breakdown?: ContextBreakdown;
}

/** A `/name` slash command backed by an MCP prompt. */
export interface SlashCommandInfo {
  /** The bare command name, without the leading slash. */
  command: string;
  server: string;
  name: string;
}

/** Skills or sub-agents that came, went or changed, by name. */
export interface NamedChanges {
  added: string[];
  removed: string[];
  changed: string[];
}

/** What `reloadCapabilities` took up; each part only when something in it changed. */
export interface CapabilityChanges {
  skills?: NamedChanges;
  agents?: NamedChanges;
  mcp?: McpHubChanges & {
    /** Servers connected (again) that couldn't be reached, and why. */
    failed: Array<{ name: string; error: string; needsAuth?: true }>;
  };
}

/** A file attached to a message that the session may not read — refused before anything is sent. */
export class AttachmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttachmentError';
  }
}

/**
 * The message a user's `/skill-name` becomes: it asks the model to load the
 * skill through the `skill` tool, so the load takes the normal path (active
 * skill, `allowed-tools` narrowing), with what followed the command as the task.
 */
export function skillInvocation(name: string, args = ''): string {
  const task = args.trim();
  return `Load the "${name}" skill and follow its instructions.${task ? `\n\n${task}` : ''}`;
}

/** Past this, a file is for the agent to read in parts, not to attach whole. */
export const MAX_ATTACHMENT_BYTES = 256 * 1024;

/** An image put in a message: base64, no `data:` prefix. */
export type ImageInput = Omit<ImageBlock, 'type'>;

/** At most this many images in one message. */
export const MAX_IMAGES = 8;
/** Past this (decoded), an image is too big to send. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** What a run is given beside its text (`AgentSession.runTurn`). */
export interface RunTurnOptions {
  signal?: AbortSignal;
  attachments?: readonly string[];
  images?: readonly ImageInput[];
  takeInput?: () => readonly SteeringInput[];
}

/** A message the user sent while a run was going, for the run to take in (`runTurn`'s `takeInput`). */
export interface SteeringInput {
  text: string;
  /** Workspace files read into it, as for a message's (checked when it was sent). */
  attachments?: readonly string[];
  /** Images in it (checked when it was sent). */
  images?: readonly ImageInput[];
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface AgentSessionConfig {
  cwd: string;
  model: ResolvedModel;
  /**
   * Where provider keys (the session's own lookups: auto-mode classifier,
   * summarizer, sub-agent models) and MCP `${VAR}`s come from. Default
   * `process.env`; see `BuildSessionConfigOptions.env`.
   */
  env?: NodeJS.ProcessEnv;
  /** Cheaper model for compaction summaries. Defaults to `settings.smallModel`, then `model`. */
  summarizerModel?: ResolvedModel;
  settings: Settings;
  budgets: ResolvedBudgets;

  mode?: PermissionMode;
  /** Reasoning-effort level for reasoning-capable models. Defaults to the model's own default, else `high`. */
  reasoningEffort?: ReasoningEffort;
  /** Mode to switch to after a plan is approved. Defaults to `settings` then auto/acceptEdits. */
  planApprovedMode?: PermissionMode;
  allow?: string[];
  ask?: string[];
  deny?: string[];

  // Subsystem switches (all default true).
  skills?: boolean;
  subagents?: boolean;
  mcp?: boolean;
  compact?: boolean;
  recorder?: boolean;
  trace?: boolean;
  /** Persistent cross-session memory (`memory` tool + `<available_memory>`). */
  memory?: boolean;
  /** Override `os.homedir()` for `~/.agent/memory` (tests). */
  homeDir?: string;
  /** Override packaged builtin memory dir (tests). */
  builtinMemoryDir?: string;

  /** Continue a previous session (id, messages, read ledger). */
  resumeId?: string;
  /** Overrides `<projectRoot>/.agent` for recorder/trace output (eval harness). */
  agentDir?: string;
  /** Platform string for the system prompt. Defaults to `process.platform`. */
  platform?: string;
  /** Pre-loaded project memory; `null` skips loading, `undefined` loads it. */
  projectMemory?: { text: string; sources: string[] } | null;
  /** Escape hatch for ablations / tests; merged last into each `AgentLoop`. */
  loopOverrides?: Partial<AgentLoopOptions>;
  /**
   * Send the model back once to check its work against the task before a run
   * that changed something ends. Defaults to `settings.verifyBeforeStop`, then
   * off.
   */
  verifyBeforeStop?: boolean;

  // Injected seams ----------------------------------------------------------
  /**
   * Resolves the ref `setModel` switches to. Defaults to the session's own
   * provider registry (settings + `env`); tests and `--mock` inject scripted
   * models.
   */
  resolveModel?: (ref: string) => ResolvedModel;
  /** Permission `ask` handler. Defaults to `nonInteractiveAskHandler` (deny). */
  askHandler?: AskHandler;
  /** Plan approval. Absent = `exit_plan_mode` writes the plan and ends the run. */
  confirm?: (req: {
    title: string;
    body: string;
  }) => Promise<{ approved: boolean; feedback?: string; mode?: PermissionMode }>;
  /** Hot path: per-token deltas and tool events, forwarded verbatim. */
  onEvent?: (e: AgentEvent) => void;
  /** Cold path: structured status lines. */
  onNotice?: (n: Notice) => void;
  /** Background commands (`settings.backgroundProcesses`) starting, printing and ending — outside any run, too. */
  onProcessEvent?: (e: BackgroundProcessEvent) => void;
}

interface SessionInit {
  memory: ProjectMemory;
  agents: AgentDefinition[];
  hub: McpHub;
  mcpToolSpecs: AnyToolSpec[];
  mcpPrompts: Map<string, { server: string; name: string }>;
  skillCatalog: SkillCatalog;
  memoryCatalog: MemoryCatalog;
  memoryBuffer: MemoryWriteBuffer;
  /** What the tool guardrails ask of a tool's name — rebuilt when the tools change. */
  readOnlyTools: { lookup: (name: string) => boolean };
  engine: PermissionEngine;
  planApprovedMode: PermissionMode;
  planApprovedModeIsExplicit: boolean;
  recorder: SessionRecorder | undefined;
  trace: TraceRecorder | undefined;
  session: SessionState;
  messages: Message[];
  hooks: AgentHooks;
  compactHook: AgentHooks | undefined;
  /** Point compaction at the session's new model (`setModel`). */
  retargetCompactor: ((model: ResolvedModel) => void) | undefined;
  toolOutputStore: ToolOutputStore | undefined;
  registry: ProviderRegistry;
  budgetOverrides: Partial<AgentLoopOptions>;
  autoState?: AutoModeState;
  autoClassifier?: AutoModeClassifier;
  autoAvailable: AutoModeAvailability;
  autoHook?: AutoModeHookOptions;
}

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

export class AgentSession {
  readonly id: string;

  readonly #config: AgentSessionConfig;
  readonly #cwd: string;
  readonly #platform: string;
  #model: ResolvedModel;
  readonly #registry: ProviderRegistry;
  readonly #engine: PermissionEngine;
  readonly #planApprovedMode: PermissionMode;
  readonly #planApprovedModeIsExplicit: boolean;
  readonly #memory: ProjectMemory;
  // Skills, sub-agents and MCP servers are taken up again between runs (`reloadCapabilities`).
  #agents: AgentDefinition[];
  readonly #hub: McpHub;
  #mcpToolSpecs: AnyToolSpec[];
  #mcpPrompts: Map<string, { server: string; name: string }>;
  #skillCatalog: SkillCatalog;
  readonly #readOnlyTools: { lookup: (name: string) => boolean };
  readonly #memoryCatalog: MemoryCatalog;
  readonly #memoryBuffer: MemoryWriteBuffer;
  /** Commands `bash` started in the background; only with `settings.backgroundProcesses`. */
  readonly #background: BackgroundProcesses | undefined;
  readonly #recorder: SessionRecorder | undefined;
  readonly #trace: TraceRecorder | undefined;
  readonly #hooks: AgentHooks;
  readonly #compactHook: AgentHooks | undefined;
  readonly #retargetCompactor: ((model: ResolvedModel) => void) | undefined;
  readonly #toolOutputStore: ToolOutputStore | undefined;
  readonly #budgetOverrides: Partial<AgentLoopOptions>;
  readonly #autoState: AutoModeState | undefined;
  readonly #autoClassifier: AutoModeClassifier | undefined;
  readonly #autoAvailable: AutoModeAvailability;
  #pendingRetryNotes: string[] = [];
  readonly #control: AgentControl;

  #session: SessionState;
  #messages: Message[];
  #effort: ReasoningEffort | undefined;
  #taskTool: AnyToolSpec | undefined;
  #activeSkills: ActiveSkill[] = [];
  #sessionUsage: Usage | undefined;
  #lastContext: ContextSnapshot | undefined;
  #contextWarned = false;
  #abortController: AbortController | undefined;
  #closed = false;
  /** A run is going: a reload waits for it to end. */
  #running = false;
  /** A reload asked for while a run went. */
  #reloadPending: { retryFailed: boolean } | undefined;
  /** The reload going, if one is: the next waits for it. */
  #reloading: Promise<CapabilityChanges | undefined> | undefined;
  /** The last reason a reload couldn't read the config, so it's said once, not every run. */
  #reloadProblem: string | undefined;

  private constructor(config: AgentSessionConfig, init: SessionInit) {
    this.id = init.recorder?.id ?? init.trace?.id ?? config.resumeId ?? randomUUID();
    this.#config = config;
    this.#cwd = config.cwd;
    this.#platform = config.platform ?? process.platform;
    this.#model = config.model;
    // Reasoning-capable models start at their declared default effort (falling
    // back to `high`); non-reasoning models carry none. A configured effort is
    // kept even then: sub-agents on reasoning models inherit it.
    this.#effort = config.reasoningEffort ?? effortOptions(config.model.capabilities).initial;
    this.#registry = init.registry;
    this.#engine = init.engine;
    this.#planApprovedMode = init.planApprovedMode;
    this.#planApprovedModeIsExplicit = init.planApprovedModeIsExplicit;
    this.#memory = init.memory;
    this.#agents = init.agents;
    this.#hub = init.hub;
    this.#mcpToolSpecs = init.mcpToolSpecs;
    this.#mcpPrompts = init.mcpPrompts;
    this.#skillCatalog = init.skillCatalog;
    this.#readOnlyTools = init.readOnlyTools;
    this.#memoryCatalog = init.memoryCatalog;
    this.#memoryBuffer = init.memoryBuffer;
    this.#background =
      config.settings.backgroundProcesses === true
        ? new BackgroundProcesses({
            root: config.cwd,
            ...(config.onProcessEvent ? { onEvent: config.onProcessEvent } : {}),
          })
        : undefined;
    this.#recorder = init.recorder;
    this.#trace = init.trace;
    this.#session = init.session;
    this.#messages = init.messages;
    this.#hooks = init.hooks;
    this.#compactHook = init.compactHook;
    this.#retargetCompactor = init.retargetCompactor;
    this.#toolOutputStore = init.toolOutputStore;
    this.#budgetOverrides = init.budgetOverrides;
    this.#autoState = init.autoState;
    this.#autoClassifier = init.autoClassifier;
    this.#autoAvailable = init.autoAvailable;

    if (init.autoHook) {
      init.autoHook.onUsage = (u) => this.#foldClassifierUsage(u);
    }

    const notice = (n: Notice): void => this.#config.onNotice?.(n);
    const engine = this.#engine;
    const activeSkills = this.#activeSkills;
    this.#control = {
      get mode(): PermissionMode {
        return engine.getMode();
      },
      get activeSkills(): readonly ActiveSkill[] {
        return activeSkills;
      },
      activateSkill: (skill: ActiveSkill): void => {
        if (this.#activeSkills.some((s) => s.name === skill.name)) return;
        this.#activeSkills.push(skill);
        notice({
          kind: 'skill-loaded',
          level: 'info',
          text:
            `skill loaded: ${skill.name}` +
            (skill.allowedTools
              ? ` — tools now limited to: ${skill.allowedTools.join(' ')}`
              : ''),
        });
      },
      exitPlanMode: (mode?: PermissionMode): PermissionMode => {
        const next = mode ?? this.#planApprovedMode;
        this.setMode(next);
        return this.#engine.getMode();
      },
      ...(config.confirm ? { confirm: config.confirm } : {}),
    };

    this.#taskTool = this.#createTaskTool(init.agents);
  }

  #createTaskTool(agents: AgentDefinition[]): AnyToolSpec | undefined {
    return agents.length > 0
      ? createTaskTool({ agents, run: (def, subPrompt, runCtx) => this.#runSubagent(def, subPrompt, runCtx) })
      : undefined;
  }

  // -- construction ---------------------------------------------------------

  static async create(config: AgentSessionConfig): Promise<AgentSession> {
    const cwd = config.cwd;
    const settings = config.settings;
    const platform = config.platform ?? process.platform;
    const notify = (n: Notice): void => config.onNotice?.(n);
    const registry = new ProviderRegistry({ settings, ...(config.env ? { env: config.env } : {}) });

    const memory =
      config.projectMemory !== undefined
        ? (config.projectMemory ?? { text: '', sources: [] })
        : await loadProjectMemory(cwd);
    if (memory.sources.length > 0) {
      const rel = memory.sources.map((s) => resolve(s).replace(`${cwd}/`, ''));
      notify({ kind: 'project-memory', level: 'info', text: `project memory: ${rel.join(', ')}` });
    }

    const { skills, counts } =
      config.skills === false
        ? { skills: [], counts: { project: 0, user: 0, builtin: 0 } }
        : await discoverSkills(cwd, {
            onSkip: (reason) =>
              notify({ kind: 'skills-discovered', level: 'info', text: `skipped ${reason}` }),
          });
    const skillCatalog = new SkillCatalog(skills);
    if (skillCatalog.size > 0) {
      notify({
        kind: 'skills-discovered',
        level: 'info',
        text:
          `skills: ${skillCatalog.size} discovered ` +
          `(project ${counts.project}, user ${counts.user}, builtin ${counts.builtin})` +
          (skillCatalog.dropped.length > 0
            ? ` — ${skillCatalog.dropped.length} not advertised (manifest budget)`
            : ''),
      });
    }

    const projectRoot = await findProjectRoot(cwd);
    const memoryEnabled = config.memory !== false;
    const discoveredMemory =
      memoryEnabled
        ? await discoverMemory(cwd, {
            ...(config.homeDir ? { homeDir: config.homeDir } : {}),
            ...(config.builtinMemoryDir ? { builtinDir: config.builtinMemoryDir } : {}),
            onSkip: (reason) =>
              notify({ kind: 'memory', level: 'info', text: `skipped ${reason}` }),
          })
        : { entries: [], counts: { project: 0, global: 0, builtin: 0 } };
    const memoryCatalog = new MemoryCatalog(discoveredMemory.entries);
    if (memoryEnabled && memoryCatalog.size > 0) {
      const mc = discoveredMemory.counts;
      notify({
        kind: 'memory',
        level: 'info',
        text:
          `memory: ${memoryCatalog.size} discovered ` +
          `(project ${mc.project}, global ${mc.global}, builtin ${mc.builtin})` +
          (memoryCatalog.dropped.length > 0
            ? ` — ${memoryCatalog.dropped.length} not advertised (manifest budget)`
            : ''),
      });
    }
    const memoryBuffer = new MemoryWriteBuffer({
      global: join(config.homeDir ?? homedir(), AGENT_DIR, 'memory'),
      project: await resolveProjectMemoryDir(cwd, config.homeDir),
      ...(memoryEnabled ? { builtin: config.builtinMemoryDir ?? builtinMemoryDir() } : {}),
    });

    const { agents } =
      config.subagents === false
        ? { agents: [] }
        : await discoverAgents(cwd, {
            onSkip: (reason) =>
              notify({ kind: 'agents-discovered', level: 'info', text: `skipped ${reason}` }),
          });
    if (agents.length > 0) {
      notify({
        kind: 'agents-discovered',
        level: 'info',
        text: `agents: ${agents.length} available (${agents.map((a) => a.name).join(', ')})`,
      });
    }

    const mcpEnabled = config.mcp !== false;
    const mcpConfig = mcpEnabled
      ? await loadMcpConfig(cwd, config.env ? { env: config.env } : {})
      : { servers: [], sources: [] };
    const hub = new McpHub(mcpConfig.servers);
    const mcpToolSpecs = hub.empty ? [] : await hub.toolSpecs();
    if (!hub.empty) {
      const s = hub.status();
      const ok = s.filter((x) => x.state === 'ready');
      // One that wants a sign-in gets a notice of its own, which says how.
      const failed = s.filter((x) => x.state === 'failed' && !x.needsAuth);
      notify({
        kind: 'mcp-status',
        level: 'info',
        text:
          `mcp: ${ok.length}/${s.length} server${s.length === 1 ? '' : 's'} ready, ` +
          `${mcpToolSpecs.length} tool${mcpToolSpecs.length === 1 ? '' : 's'}` +
          (failed.length > 0
            ? ` — unavailable: ${failed
                .map((x) => `${x.name} (${x.error ?? 'failed'})`)
                .join(', ')}`
            : ''),
      });
      for (const x of s) if (x.needsAuth) notify(mcpAuthNotice(x.name));
    }
    const mcpPrompts = await mcpPromptCommands(hub);

    // A session resumed is logged where it was started — for one from an
    // earlier version, that is still the project's own `.agent/`.
    const stateDirs = config.agentDir
      ? ([config.agentDir] as const)
      : await resolveStateDirs(cwd, config.homeDir ? { homeDir: config.homeDir } : {});
    const agentDir =
      (config.resumeId !== undefined ? await findSessionDir(stateDirs, config.resumeId) : undefined) ?? stateDirs[0];
    const recorder =
      config.recorder === false ? undefined : new SessionRecorder(agentDir, config.resumeId);
    const traceOn = config.trace !== false && settings.telemetry?.enabled !== false;
    const trace = traceOn ? new TraceRecorder(agentDir, recorder?.id ?? randomUUID()) : undefined;
    const priorMessages =
      config.resumeId !== undefined ? await loadSession(agentDir, config.resumeId) : [];
    const session =
      config.resumeId !== undefined
        ? await rebuildSessionState(agentDir, config.resumeId, cwd)
        : new SessionState();

    const permissions = settings.permissions ?? {};
    const autoAvailable = isAutoModeAvailable(settings, registry, config.model.ref);
    let mode = config.mode ?? permissions.mode ?? 'ask';
    if (mode === 'auto' && !autoAvailable.available) {
      notify({
        kind: 'auto-mode',
        level: 'warn',
        text: `auto mode unavailable: ${autoAvailable.reason}`,
      });
      mode = 'ask';
    }
    const explicitPlanApproved = config.planApprovedMode ?? permissions.planApprovedMode;
    let planApprovedMode = explicitPlanApproved ?? defaultPlanYesMode(autoAvailable.available);
    // Keep planApprovedMode equal to the mode approval will actually land in —
    // UIs label the approve button and set their mode indicator from it.
    if (planApprovedMode === 'auto' && !autoAvailable.available) {
      notify({
        kind: 'auto-mode',
        level: 'warn',
        text: `planApprovedMode "auto" unavailable (${autoAvailable.reason}); approved plans switch to acceptEdits`,
      });
      planApprovedMode = 'acceptEdits';
    }
    const engine = createPermissionEngine({
      workspaceRoot: cwd,
      mode,
      allow: [...(permissions.allow ?? []), ...(config.allow ?? [])],
      ask: [...(permissions.ask ?? []), ...(config.ask ?? [])],
      deny: [...(permissions.deny ?? []), ...(config.deny ?? [])],
      classifyAllShell: settings.autoMode?.classifyAllShell === true,
      useAutoModeDuringPlan: autoAvailable.available && settings.useAutoModeDuringPlan !== false,
    });
    notify({ kind: 'permission-mode', level: 'info', text: `permission mode: ${mode}` });

    const autoState = autoAvailable.available ? new AutoModeState() : undefined;
    const autoClassifier = autoAvailable.available
      ? new AutoModeClassifier({
          model:
            autoAvailable.modelRef === config.model.ref
              ? config.model
              : registry.resolve(autoAvailable.modelRef),
          autoMode: settings.autoMode,
        })
      : undefined;
    const autoHookHolder: { current?: AutoModeHookOptions } = {};
    if (autoClassifier && autoState) {
      autoHookHolder.current = {
        classifier: autoClassifier,
        state: autoState,
        ...(memory.text ? { projectMemory: memory.text } : {}),
        injectionProbe: settings.autoMode?.injectionProbe === true,
        onNotice: (n) =>
          notify({
            kind: 'auto-mode',
            level: n.kind === 'denied' || n.kind === 'paused' ? 'warn' : 'info',
            text: n.text,
          }),
      };
    }

    if (!isSandboxExecAvailable()) {
      notify({
        kind: 'sandbox-warn',
        level: 'warn',
        text:
          'bash sandbox: unavailable — commands run without OS-level workspace confinement ' +
          "(sandbox-exec is macOS-only); the permission engine's review is still in effect.",
      });
    }

    // Without a dedicated summarizer, compaction runs on the session's model —
    // and follows it when `setModel` switches.
    const dedicatedSummarizer =
      config.summarizerModel ??
      (settings.smallModel ? registry.resolve(settings.smallModel) : undefined);
    // One store per session for full tool outputs: the loop's output cap and the
    // compactor's pruning both write here, numbered from one counter.
    const toolOutputStore = recorder
      ? new ToolOutputStore(toolOutputDir(sessionArtifactsDir(agentDir, recorder.id), cwd, recorder.id), cwd)
      : undefined;
    const compactorFor = (sessionModel: ResolvedModel): NonNullable<AgentHooks['onCompact']> => {
      const summarizer = dedicatedSummarizer ?? sessionModel;
      return createCompactor({
        provider: summarizer.provider,
        model: summarizer.model,
        conventions: AGENT_CONVENTIONS,
        // Replaying the turn's own prefix only pays off on the model
        // whose cache is holding it.
        warmPrefix: summarizer.ref === sessionModel.ref,
        // A digest is transcription, not deliberation.
        ...(summarizer.capabilities.reasoning ? { summaryEffort: 'low' as const } : {}),
        ...(config.budgets.compactKeepTurns !== undefined
          ? { keepTurns: config.budgets.compactKeepTurns }
          : {}),
        ...(toolOutputStore ? { offloadStore: toolOutputStore } : {}),
        onSkip: (reason) => notify({ kind: 'compaction', level: 'info', text: reason }),
      });
    };
    let onCompact = config.compact === false ? undefined : compactorFor(config.model);
    const compactHook: AgentHooks | undefined = onCompact
      ? { onCompact: (...args) => onCompact!(...args) }
      : undefined;
    const retargetCompactor = onCompact
      ? (model: ResolvedModel): void => {
          onCompact = compactorFor(model);
        }
      : undefined;
    const askHandler = config.askHandler ?? nonInteractiveAskHandler;
    const guardrailsEnabled = settings.toolGuardrails !== false;
    const readOnlyTools = {
      lookup: sessionReadOnlyLookup({
        backgroundProcesses: settings.backgroundProcesses === true,
        skills: skillCatalog.size > 0,
        task: agents.length > 0,
        mcp: mcpToolSpecs,
      }),
    };
    const guardrailHook = guardrailsEnabled
      ? createToolGuardrailHooks({ isReadOnly: (name) => readOnlyTools.lookup(name) })
      : undefined;
    const verifyHook =
      (config.verifyBeforeStop ?? settings.verifyBeforeStop) === true
        ? createVerifyBeforeStopHooks()
        : undefined;
    const hooks = mergeHooks(
      createPermissionHooks(engine, askHandler, autoHookHolder.current),
      guardrailHook,
      compactHook,
      verifyHook,
    );

    const budgetOverrides: Partial<AgentLoopOptions> = {
      ...(config.budgets.maxTurns !== undefined ? { maxTurns: config.budgets.maxTurns } : {}),
      ...(config.budgets.contextBudgetTokens !== undefined
        ? { contextBudgetTokens: config.budgets.contextBudgetTokens }
        : {}),
      ...(config.budgets.contextCompactRatio !== undefined
        ? { contextCompactRatio: config.budgets.contextCompactRatio }
        : {}),
      ...(config.budgets.maxCostUSD !== undefined
        ? { maxCostUSD: config.budgets.maxCostUSD }
        : {}),
      ...(config.budgets.maxTokens !== undefined ? { maxTokens: config.budgets.maxTokens } : {}),
      ...(config.budgets.maxOutputTokens !== undefined
        ? { maxOutputTokens: config.budgets.maxOutputTokens }
        : {}),
      ...(config.budgets.temperature !== undefined
        ? { temperature: config.budgets.temperature }
        : {}),
    };

    const sessionInstance = new AgentSession(config, {
      memory,
      agents,
      hub,
      mcpToolSpecs,
      mcpPrompts,
      skillCatalog,
      memoryCatalog,
      memoryBuffer,
      readOnlyTools,
      engine,
      planApprovedMode,
      planApprovedModeIsExplicit: explicitPlanApproved !== undefined,
      recorder,
      trace,
      session,
      messages: priorMessages,
      hooks,
      compactHook,
      retargetCompactor,
      toolOutputStore,
      registry,
      budgetOverrides,
      autoAvailable,
      ...(autoState ? { autoState } : {}),
      ...(autoClassifier ? { autoClassifier } : {}),
      ...(autoHookHolder.current ? { autoHook: autoHookHolder.current } : {}),
    });

    const modeLabel = `${config.model.ref} · mode ${mode}`;
    notify({
      kind: 'session-start',
      level: 'info',
      text: `session ${sessionInstance.id} · cwd ${cwd} · ${modeLabel}`,
    });
    return sessionInstance;
  }

  // -- accessors ------------------------------------------------------------

  get mode(): PermissionMode {
    return this.#engine.getMode();
  }

  /** Current reasoning-effort level, or `undefined` when the model has no reasoning channel. */
  get effort(): ReasoningEffort | undefined {
    return this.#model.capabilities.reasoning ? this.#effort : undefined;
  }

  /** Effort levels this model accepts (Faster→Smarter); empty for non-reasoning models. */
  get effortLevels(): readonly ReasoningEffort[] {
    return effortOptions(this.#model.capabilities).levels;
  }

  get activeSkills(): readonly ActiveSkill[] {
    return this.#activeSkills;
  }

  get contextSnapshot(): ContextSnapshot | undefined {
    return this.#lastContext;
  }

  get sessionUsage(): Usage | undefined {
    return this.#sessionUsage;
  }

  get messages(): readonly Message[] {
    return this.#messages;
  }

  get engine(): PermissionEngine {
    return this.#engine;
  }

  get autoModeAvailable(): boolean {
    return this.#autoAvailable.available;
  }

  get autoModeUnavailableReason(): string | undefined {
    return this.#autoAvailable.available ? undefined : this.#autoAvailable.reason;
  }

  get recentDenials(): readonly AutoModeDenial[] {
    return this.#autoState?.recentDenials ?? [];
  }

  get planApprovedMode(): PermissionMode {
    return this.#planApprovedMode;
  }

  get planApprovedModeIsExplicit(): boolean {
    return this.#planApprovedModeIsExplicit;
  }

  get autoModeCumulativeDenials(): number {
    return this.#autoState?.cumulativeDenials ?? 0;
  }

  /** Auto mode stopped deciding after repeated denials: calls ask until one is approved. */
  get autoModePaused(): boolean {
    return this.#autoState?.paused === true;
  }

  /**
   * The settings files changed (the web's settings page wrote them): take up
   * their permission rules and auto-mode config, for this session and the
   * sub-agents it starts from now on. What "always allow" granted this
   * session stays; the mode stays as it is.
   */
  async reloadSettings(): Promise<void> {
    const { settings } = await loadSettings(this.#cwd, this.#config.homeDir ? { homeDir: this.#config.homeDir } : {});
    const permissions = settings.permissions ?? {};
    this.#engine.setRules({
      allow: [...(permissions.allow ?? []), ...(this.#config.allow ?? [])],
      ask: [...(permissions.ask ?? []), ...(this.#config.ask ?? [])],
      deny: [...(permissions.deny ?? []), ...(this.#config.deny ?? [])],
    });
    const current = this.#config.settings;
    if (settings.permissions) current.permissions = settings.permissions;
    else delete current.permissions;
    if (settings.autoMode) current.autoMode = settings.autoMode;
    else delete current.autoMode;
    this.#autoClassifier?.setAutoMode(settings.autoMode);
  }

  /**
   * The skills, sub-agents or MCP servers may have changed (the web's
   * settings page wrote them, or a file was edited): find them again and take
   * up what changed — a skill's or sub-agent's new text, an MCP server added,
   * dropped or changed (only those reconnect; with `retryFailed`, one that
   * had failed is tried again). The next run has them; a `capabilities`
   * notice says what changed. While a run goes it waits for the run to end
   * (resolving `undefined`); every run starts with a check of its own, too.
   */
  reloadCapabilities(opts: { retryFailed?: boolean } = {}): Promise<CapabilityChanges | undefined> {
    if (this.#closed) return Promise.resolve(undefined);
    if (this.#running) {
      this.#reloadPending = { retryFailed: opts.retryFailed === true || this.#reloadPending?.retryFailed === true };
      return Promise.resolve(undefined);
    }
    return this.#reload({ retryFailed: opts.retryFailed === true });
  }

  /** One reload at a time: each waits for the one before. */
  #reload(opts: { retryFailed: boolean }): Promise<CapabilityChanges | undefined> {
    const next = (this.#reloading ?? Promise.resolve(undefined))
      .catch(() => undefined)
      .then(() => this.#refreshCapabilities(opts));
    this.#reloading = next;
    return next;
  }

  async #refreshCapabilities(opts: { retryFailed: boolean }): Promise<CapabilityChanges | undefined> {
    if (this.#closed) return undefined;
    const config = this.#config;
    const changes: CapabilityChanges = {};
    const problems: string[] = [];

    if (config.skills !== false) {
      try {
        const { skills } = await discoverSkills(this.#cwd);
        const diff = diffNamed(this.#skillCatalog.list(), skills);
        if (diff) {
          this.#skillCatalog = new SkillCatalog(skills);
          changes.skills = diff;
        }
      } catch (err) {
        problems.push(`skills: ${errorText(err)}`);
      }
    }

    if (config.subagents !== false) {
      try {
        const { agents } = await discoverAgents(this.#cwd);
        const diff = diffNamed(this.#agents, agents);
        if (diff) {
          this.#agents = agents;
          this.#taskTool = this.#createTaskTool(agents);
          changes.agents = diff;
        }
      } catch (err) {
        problems.push(`sub-agents: ${errorText(err)}`);
      }
    }

    if (config.mcp !== false) {
      try {
        const { servers } = await loadMcpConfig(this.#cwd, config.env ? { env: config.env } : {});
        const diff = await this.#hub.reconfigure(servers, { retryFailed: opts.retryFailed });
        const touched = [...diff.added, ...diff.changed, ...diff.retried];
        if (touched.length > 0 || diff.removed.length > 0) {
          this.#mcpToolSpecs = this.#hub.empty ? [] : await this.#hub.toolSpecs();
          this.#mcpPrompts = await mcpPromptCommands(this.#hub);
          const failed = this.#hub
            .status()
            .filter((s) => touched.includes(s.name) && s.state === 'failed')
            .map((s) => ({ name: s.name, error: s.error ?? 'failed', ...(s.needsAuth ? { needsAuth: s.needsAuth } : {}) }));
          changes.mcp = { ...diff, failed };
        }
      } catch (err) {
        problems.push(`MCP: ${errorText(err)}`);
      }
    }

    // A config that can't be read is said once, until it changes or reads again.
    const problem = problems.length > 0 ? problems.join('; ') : undefined;
    if (problem !== this.#reloadProblem && problem !== undefined) {
      config.onNotice?.({ kind: 'capabilities', level: 'warn', text: `couldn't take up changes — ${problem}` });
    }
    this.#reloadProblem = problem;

    if (!changes.skills && !changes.agents && !changes.mcp) return undefined;
    this.#readOnlyTools.lookup = sessionReadOnlyLookup({
      backgroundProcesses: this.#background !== undefined,
      skills: this.#skillCatalog.size > 0,
      task: this.#agents.length > 0,
      mcp: this.#mcpToolSpecs,
    });
    const failed = changes.mcp?.failed ?? [];
    config.onNotice?.({
      kind: 'capabilities',
      level: failed.some((f) => !f.needsAuth) ? 'warn' : 'info',
      text: describeCapabilityChanges(changes, this.#hub.status()),
      data: changes,
    });
    for (const f of failed) if (f.needsAuth) config.onNotice?.(mcpAuthNotice(f.name));
    return changes;
  }

  get autoModeEnvironmentConfigured(): boolean {
    const env = this.#config.settings.autoMode?.environment;
    return env !== undefined && env.length > 0;
  }

  get hideAutoModeSetup(): boolean {
    return this.#config.settings.tui?.hideAutoModeSetup === true;
  }

  get autoModeConfig(): AutoModeConfig {
    return this.#config.settings.autoMode ?? {};
  }

  async patchUserAutoMode(patch: AutoModeConfig): Promise<string> {
    const next = { ...this.#config.settings.autoMode, ...patch };
    const path = await writeUserSettings(
      { autoMode: next },
      this.#config.homeDir ? { homeDir: this.#config.homeDir } : {},
    );
    this.#config.settings.autoMode = next;
    this.#autoClassifier?.setAutoMode(next);
    return path;
  }

  async dismissAutoModeSetupHint(): Promise<void> {
    await writeUserSettings(
      { tui: { ...this.#config.settings.tui, hideAutoModeSetup: true } },
      this.#config.homeDir ? { homeDir: this.#config.homeDir } : {},
    );
    this.#config.settings.tui = { ...this.#config.settings.tui, hideAutoModeSetup: true };
  }

  async draftAutoModeEnvironment(signal?: AbortSignal): Promise<string[]> {
    const context = await collectAutoModeSetupContext({
      cwd: this.#cwd,
      ...(this.#memory.text ? { projectMemory: this.#memory.text } : {}),
      allow: this.#config.settings.permissions?.allow ?? [],
    });
    let model = this.#model;
    if (this.#autoAvailable.available && this.#autoAvailable.modelRef !== this.#model.ref) {
      model = this.#registry.resolve(this.#autoAvailable.modelRef);
    }
    return runAutoModeSetupDraft(model, context, signal);
  }

  /** Authorize one retry of a previously denied auto-mode call on the next turn. */
  retryDenied(id: string): boolean {
    const d = this.#autoState?.markRetry(id);
    if (!d) return false;
    this.#pendingRetryNotes.push(
      `The user authorized a retry of the denied ${d.toolName} call. You may issue that exact call again.`,
    );
    return true;
  }

  get mcpStatus(): McpServerStatus[] {
    return this.#hub.status();
  }

  listSlashCommands(): SlashCommandInfo[] {
    return [...this.#mcpPrompts.entries()].map(([command, ref]) => ({
      command,
      server: ref.server,
      name: ref.name,
    }));
  }

  /** Installed skills (name + description), for a `/skills` list or picker. */
  listSkills(): { name: string; description: string }[] {
    return this.#skillCatalog.list().map((s) => ({ name: s.name, description: s.description }));
  }

  // -- control --------------------------------------------------------------

  /**
   * Take the conversation back to its first `keepMessages` messages, as the
   * log has them: the model's history, the read ledger and the log (a
   * `rewind` event) all forget what came after. Files the agent changed stay
   * as they are. Not while a turn runs; needs the recorder.
   */
  async rewind(keepMessages: number): Promise<void> {
    if (this.#abortController) throw new Error('A run is going: stop it before rewinding');
    const recorder = this.#recorder;
    if (!recorder) throw new Error('This session is not recorded, so it cannot be rewound');
    await recorder.recordRewind(keepMessages);
    this.#messages = await loadSession(recorder.agentDir, this.id);
    this.#session = await rebuildSessionState(recorder.agentDir, this.id, this.#cwd);
  }

  /** Abort an in-flight turn. Never touches process signals. */
  abort(): void {
    this.#abortController?.abort();
  }

  setMode(mode: PermissionMode): void {
    if (mode === 'auto' && !this.#autoAvailable.available) {
      this.#config.onNotice?.({
        kind: 'auto-mode',
        level: 'warn',
        text: `auto mode unavailable: ${this.#autoAvailable.reason}`,
      });
      mode = 'ask';
    }
    const prev = this.#engine.getMode();
    if (prev === mode) return;
    this.#engine.setMode(mode);
    this.#config.onNotice?.({
      kind: 'mode-changed',
      level: 'info',
      text: `mode: ${prev} → ${mode}`,
    });
  }

  /** Set the reasoning-effort level for subsequent turns (no-op on non-reasoning models). */
  setEffort(effort: ReasoningEffort): void {
    if (!this.#model.capabilities.reasoning) return;
    const prev = this.#effort;
    if (prev === effort) return;
    this.#effort = effort;
    this.#config.onNotice?.({
      kind: 'effort-changed',
      level: 'info',
      text: `effort: ${prev ?? 'none'} → ${effort}`,
    });
  }

  /** The model's ref (`provider/model`) — what `setModel` last switched to. */
  get modelRef(): string {
    return this.#model.ref;
  }

  /**
   * Switch the model for subsequent turns; the history carries over as it is.
   * The effort is kept when the new model offers it, else it moves to the
   * nearest level the model has (its default when there was none). Throws when
   * `ref` can't be resolved (an unknown provider, a missing key). Not meant for
   * the middle of a turn: callers keep it between runs.
   *
   * Compaction follows the new model unless a summarizer of its own is set; the
   * auto-mode classifier keeps the model it started with.
   */
  setModel(ref: string): void {
    if (ref === this.#model.ref) return;
    const next = (this.#config.resolveModel ?? ((r: string) => this.#registry.resolve(r)))(ref);
    const prev = this.#model;
    this.#model = next;
    // The cached prefix belongs to the old model: start the new one from a
    // fresh system head instead of appending updates to a head it never saw.
    this.#sessionSystem = undefined;
    this.#retargetCompactor?.(next);
    this.#config.onNotice?.({
      kind: 'model-changed',
      level: 'info',
      text: `model: ${prev.ref} → ${next.ref}`,
    });

    const { levels, initial } = effortOptions(next.capabilities, this.#config.settings.reasoningEffort);
    const current = this.#effort;
    if (levels.length > 0 && (current === undefined || current === 'off' || !levels.includes(current))) {
      const folded =
        current === undefined || current === 'off' ? initial! : mapEffort(current, { effortLevels: levels });
      this.#effort = folded;
      this.#config.onNotice?.({
        kind: 'effort-changed',
        level: 'info',
        text: `effort: ${current ?? 'none'} → ${folded}`,
      });
    }

    // The meter reads the last turn's fill against the new model's window.
    if (this.#lastContext) {
      const budgets = { ...this.#budgetOverrides, ...this.#config.loopOverrides };
      const windowTokens = usableContextWindow(next.capabilities, {
        ...(budgets.contextBudgetTokens !== undefined ? { contextBudgetTokens: budgets.contextBudgetTokens } : {}),
        ...(budgets.maxOutputTokens !== undefined ? { maxOutputTokens: budgets.maxOutputTokens } : {}),
      });
      const { usedTokens } = this.#lastContext;
      this.#lastContext = { ...this.#lastContext, windowTokens, ratio: usedTokens / windowTokens };
      if (this.#lastContext.ratio < 0.8) this.#contextWarned = false;
    }
  }

  /**
   * Refuse attachments the session may not read: outside the workspace (and
   * not an upload), not a regular file, or denied by a rule or the
   * sensitive-file stance. Throws `AttachmentError` naming the first one. A
   * binary or big file passes: it goes as its path, for the agent to read.
   */
  async checkAttachments(paths: readonly string[]): Promise<void> {
    for (const path of paths) await this.#checkAttachment(path);
  }

  /** One attachment's resolved path and size, or an `AttachmentError` saying why not. */
  async #checkAttachment(path: string): Promise<{ abs: string; size: number }> {
    const refuse = (why: string): never => {
      throw new AttachmentError(`Can't attach ${path}: ${why}`);
    };
    const verdict = await this.#engine.evaluate({ toolName: 'read', input: { path }, readOnly: true });
    // An `ask` would be answered yes: attaching the file is the asking.
    if (verdict.decision === 'deny') refuse(verdict.reason ?? 'denied');
    let abs = '';
    try {
      abs = await assertInsideWorkspace(this.#cwd, path);
    } catch (err) {
      // A file the user uploaded lives outside the workspace, where `read` reaches.
      const upload = isAbsolute(path) && (await isInUploads(path)) ? await realpath(path).catch(() => null) : null;
      if (upload !== null) abs = upload;
      else refuse(err instanceof PathEscapeError ? 'it is outside the workspace' : String(err));
    }
    const info = await stat(abs).catch(() => null);
    if (!info) refuse('no such file');
    if (!info!.isFile()) refuse('not a file');
    return { abs, size: info!.size };
  }

  /**
   * Refuse images the session can't send: the model doesn't see images, too
   * many, too big, or not a format it takes. Throws `AttachmentError`.
   */
  checkImages(images: readonly ImageInput[]): void {
    if (images.length === 0) return;
    if (!this.#model.capabilities.vision) {
      throw new AttachmentError(`${this.#model.ref} can't see images; switch to a model that can`);
    }
    if (images.length > MAX_IMAGES) throw new AttachmentError(`At most ${MAX_IMAGES} images in a message`);
    for (const img of images) {
      if (!(IMAGE_MEDIA_TYPES as readonly string[]).includes(img.mediaType)) {
        throw new AttachmentError(`Can't send a ${img.mediaType} image: PNG, JPEG, GIF or WebP only`);
      }
      const bytes = Math.floor((img.data.length * 3) / 4);
      if (bytes > MAX_IMAGE_BYTES) {
        throw new AttachmentError(`An image is ${Math.round(bytes / 1024 / 1024)} MB; ${MAX_IMAGE_BYTES / 1024 / 1024} MB at most`);
      }
    }
  }

  /**
   * Read the files attached to a message with the `read` tool — they enter the
   * read ledger like any read, recorded so a resumed session remembers them —
   * and return one block per file for the front of the message. Text that
   * fits and PDFs (their first pages) go whole; anything else goes as its
   * path and what it is, for the agent to read as it needs.
   */
  async #readAttachments(paths: readonly string[]): Promise<string[]> {
    const checked = [];
    for (const path of paths) checked.push({ path, ...(await this.#checkAttachment(path)) });
    const blocks: string[] = [];
    for (const { path, abs, size } of checked) {
      const kind = await sniffAttachment(abs, size);
      let unread: string | undefined;
      if (kind === 'text' || kind === 'pdf') {
        const result = await readTool.execute({ path }, { cwd: this.#cwd, session: this.#session });
        // A long PDF's first pages would crowd the message: it goes as its path.
        const tooLong = kind === 'pdf' && !result.isError && result.content.length > MAX_INLINE_PDF_CHARS;
        if (!result.isError && !tooLong) {
          // The content rides in the message; the record is for the ledger.
          await this.#recorder?.recordToolCall({
            id: `attach-${randomUUID()}`,
            name: 'read',
            input: { path },
            result: { content: '(attached to the user message)' },
          });
          blocks.push(attachedFileBlock(path, result.content));
          continue;
        }
        if (kind === 'text') throw new AttachmentError(`Can't attach ${path}: ${result.content}`);
        if (tooLong) {
          blocks.push(attachedFileBlock(path, pdfReference(size, result.content)));
          continue;
        }
        unread = result.content;
      }
      blocks.push(attachedFileBlock(path, attachmentReference(kind, size, unread)));
    }
    return blocks;
  }

  /**
   * Run one turn with `input`, then stop. Returns the full accumulated history.
   * `attachments` are workspace files read into the message ahead of its text,
   * `images` go between them and the text.
   * `takeInput` hands over what the user said since (steering) whenever the
   * loop can take it in — after a step's tool results, or as the run would end.
   */
  async runTurn(input: string, opts?: RunTurnOptions): Promise<AgentRunResult> {
    if (this.#closed) throw new Error('AgentSession is closed');
    this.checkImages(opts?.images ?? []);
    this.#running = true;
    try {
      // What changed since the last run — through the settings page, or a file
      // edited by hand or by the agent — is this run's to use.
      const pending = this.#reloadPending;
      this.#reloadPending = undefined;
      await this.#reload({ retryFailed: pending?.retryFailed === true });
      return await this.#runTurn(input, opts);
    } finally {
      this.#running = false;
      // Asked for while the run went: taken up now, for the `/` menu's sake, not at the next run.
      const asked = this.#reloadPending;
      this.#reloadPending = undefined;
      if (asked) void this.#reload(asked).catch(() => {});
    }
  }

  async #runTurn(input: string, opts?: RunTurnOptions): Promise<AgentRunResult> {
    const images = opts?.images ?? [];
    const attached = opts?.attachments?.length ? await this.#readAttachments(opts.attachments) : [];

    let effectiveText = input;
    if (this.#pendingRetryNotes.length > 0) {
      const notes = this.#pendingRetryNotes.splice(0).join('\n');
      effectiveText = `${notes}\n\n${effectiveText}`;
    }
    if (!this.#hub.empty) {
      const { context, notes } = await resolveResources(this.#hub, input);
      for (const n of notes) {
        this.#config.onNotice?.({ kind: 'resource', level: 'info', text: `@resource ${n}` });
      }
      // Prepend onto effectiveText, not input, so pending retry notes survive.
      if (context.length > 0) effectiveText = `${context.join('\n\n')}\n\n${effectiveText}`;
    }

    const userMessage: Message = {
      role: 'user',
      content: [
        ...attached.map((text) => ({ type: 'text' as const, text })),
        ...images.map((img) => ({ type: 'image' as const, ...img })),
        { type: 'text', text: effectiveText },
      ],
    };
    await this.#recorder?.recordMessage(userMessage);

    const startedAt = Date.now();
    await this.#trace?.append({
      type: 'run_start',
      ts: startedAt,
      sessionId: this.id,
      model: this.#model.ref,
      cwd: this.#cwd,
      mode: this.#engine.getMode(),
      resumed: this.#config.resumeId !== undefined,
    });

    const controller = new AbortController();
    this.#abortController = controller;
    const onExternalAbort = (): void => controller.abort();
    if (opts?.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    try {
      const takeInput = opts?.takeInput;
      const result = await this.#buildLoop(
        controller.signal,
        takeInput ? () => this.#steeringBlocks(takeInput()) : undefined,
      ).run([...this.#messages, userMessage]);

      await this.#trace?.append({
        type: 'run_end',
        ts: Date.now(),
        stopReason: result.stopReason,
        turns: result.turns,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cachedInputTokens: result.usage.cachedInputTokens,
        ...(result.usage.costUSD !== undefined ? { costUSD: result.usage.costUSD } : {}),
        wallMs: Date.now() - startedAt,
      });

      this.#messages = result.messages;
      this.#sessionUsage = this.#sessionUsage
        ? addUsage(this.#sessionUsage, result.usage)
        : result.usage;
      return result;
    } finally {
      opts?.signal?.removeEventListener('abort', onExternalAbort);
      this.#abortController = undefined;
    }
  }

  /**
   * What the user said mid-run, as blocks for the loop — the files first, then
   * the messages' text as one, as a message would carry them — announced as one
   * `user_input`. An attachment that can't be read any more becomes a note
   * rather than failing the run.
   */
  async #steeringBlocks(items: readonly SteeringInput[]): Promise<ContentBlock[] | undefined> {
    if (items.length === 0) return undefined;
    const files = items.flatMap((i) => i.attachments ?? []);
    let attached: string[] = [];
    if (files.length > 0) {
      try {
        attached = await this.#readAttachments(files);
      } catch (err) {
        attached = [`[${err instanceof Error ? err.message : String(err)}]`];
      }
    }
    // Each item's `[Image #N]` still names its own image once they're one message.
    const text = joinMessages(items);
    // Checked when sent; a model switched since that can't see them gets `[image]`.
    const images = items.flatMap((i) => i.images ?? []);
    this.#onEvent({
      type: 'user_input',
      text,
      ...(files.length > 0 ? { attachments: files } : {}),
      ...(images.length > 0 ? { images } : {}),
    });
    return [
      ...attached.map((t) => ({ type: 'text' as const, text: t })),
      ...images.map((img) => ({ type: 'image' as const, ...img })),
      { type: 'text', text },
    ];
  }

  /** Manually compact history now. Returns the token savings, or null when nothing compacted. */
  async compactNow(): Promise<{ tokensBefore: number; tokensAfter: number } | null> {
    const onCompact = this.#compactHook?.onCompact;
    if (!onCompact) return null;
    const before = estimateRequestTokens({ messages: this.#messages });
    const result = await onCompact(
      this.#messages,
      { usedTokens: before, windowTokens: before, ratio: 1 },
      { turn: 0, cwd: this.#cwd, messages: this.#messages },
    );
    if (!result || result.messages.length === 0) return null;
    const after = estimateRequestTokens({ messages: result.messages });
    this.#messages = result.messages;
    if (result.usage) {
      this.#sessionUsage = this.#sessionUsage
        ? addUsage(this.#sessionUsage, result.usage)
        : result.usage;
    }
    await this.#recorder?.recordCompaction([...result.messages], {
      tokensBefore: before,
      tokensAfter: after,
      keptTurns: result.keptTurns ?? 0,
    });
    this.#config.onNotice?.({
      kind: 'compaction',
      level: 'info',
      text: `context compacted: ${fmtTokens(before)} → ${fmtTokens(after)} tokens (kept last ${
        result.keptTurns ?? 0
      } turns)`,
    });
    return { tokensBefore: before, tokensAfter: after };
  }

  /**
   * Resolve a `/name` slash command to the message it stands for: an MCP
   * prompt's body, else a skill's invocation (`skillInvocation`). Null if it
   * names neither.
   */
  async expandSlash(text: string): Promise<string | null> {
    if (!text.startsWith('/')) return null;
    const [cmd, ...rest] = text.slice(1).split(/\s+/);
    const ref = cmd ? this.#mcpPrompts.get(cmd) : undefined;
    if (!ref) {
      const skill = cmd ? this.#skillCatalog.get(cmd) : undefined;
      return skill ? skillInvocation(skill.name, text.slice(1 + cmd!.length)) : null;
    }
    const conn = this.#hub.connection(ref.server);
    const body = await conn?.getPrompt(ref.name, rest.length > 0 ? { input: rest.join(' ') } : {});
    return body ?? null;
  }

  /** The commands `bash` started in the background, oldest first; empty unless `settings.backgroundProcesses`. */
  get processes(): BackgroundProcessInfo[] {
    return this.#background?.list() ?? [];
  }

  /** What background command `id` printed (what's kept of it), for a frontend; the agent's reads stay as they are. */
  processOutput(id: string): { process: BackgroundProcessInfo; text: string } | undefined {
    return this.#background?.output(id);
  }

  /** Stop background command `id` and what it started; resolves once it ended, undefined for an unknown id. */
  killProcess(id: string): Promise<BackgroundProcessInfo | undefined> {
    return this.#background?.kill(id) ?? Promise.resolve(undefined);
  }

  /** Idempotent teardown: stop background commands, flush staged memories, close MCP connections. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#background?.killAll();
    try {
      if (this.#config.memory !== false) {
        const { written, forgotten } = await this.#memoryBuffer.flush();
        if (written.length > 0 || forgotten.length > 0) {
          this.#config.onNotice?.({
            kind: 'memory',
            level: 'info',
            text: `Saved ${written.length} memories, removed ${forgotten.length}.`,
          });
        }
      }
    } finally {
      await this.#hub.closeAll();
    }
  }

  // -- internals ------------------------------------------------------------

  #buildLoop(signal: AbortSignal, takeInput?: () => Promise<ContentBlock[] | undefined>): AgentLoop {
    const activeMode = this.#engine.getMode();
    const background = this.#background;
    const specs: AnyToolSpec[] = [
      // With background commands on, `bash` takes `run_in_background` and two
      // tools follow it; off (the default), the list is as it always was.
      ...(background
        ? [
            ...builtinTools().map((t) => (t.name === 'bash' ? (createBashTool(background) as AnyToolSpec) : t)),
            ...createBackgroundTools(background),
          ]
        : builtinTools()),
      // Registered in every mode on purpose: the tool list is part of the
      // cached prefix, so adding and removing a tool on each mode switch
      // invalidates it. The permission engine refuses the call outside plan
      // mode (with a reason the model can act on).
      exitPlanModeTool,
      ...(this.#skillCatalog.size > 0 ? [createSkillTool(this.#skillCatalog)] : []),
      // Only when the manifest token cap left skills out — otherwise the manifest
      // already lists every skill and this tool would just duplicate it.
      ...(this.#skillCatalog.dropped.length > 0
        ? [createListSkillsTool(this.#skillCatalog)]
        : []),
      ...(this.#config.memory !== false ? [createMemoryTool(this.#memoryBuffer)] : []),
      ...(this.#taskTool ? [this.#taskTool] : []),
      ...this.#mcpToolSpecs,
    ];
    const system = buildAgentSystemPrompt({
      cwd: this.#cwd,
      platform: this.#platform,
      mode: activeMode,
      ...(this.#memory.text ? { projectMemory: this.#memory.text } : {}),
      ...(this.#skillCatalog.manifest()
        ? { skillsManifest: this.#skillCatalog.manifest() }
        : {}),
      ...(this.#config.memory !== false
        ? { memoryManifest: this.#memoryCatalog.manifest() ?? emptyMemoryManifest() }
        : {}),
      mcpUnavailable: this.#hub
        .status()
        .filter((s) => s.state === 'failed')
        .map((s) => ({ name: s.name, ...(s.needsAuth ? { needsAuth: true } : {}), ...(s.error ? { error: s.error } : {}) })),
    });
    // The system prompt changes mid-session whenever the mode, the loaded
    // skills or memory do. Rewriting the head invalidates the cached prefix for
    // the whole conversation; on a model that reads the last system message we
    // keep the head as first sent and append the new text instead.
    const inHistory = this.#model.capabilities.systemPromptUpdate === 'in-history';
    const head = this.#sessionSystem;
    // Only the segments that changed — appending the whole prompt would
    // duplicate it in context and cost more than the rewrite it replaces.
    const update = inHistory && head ? systemUpdateSegments(head, system) : undefined;
    if (!inHistory || head === undefined) this.#sessionSystem = system;

    return new AgentLoop({
      model: this.#model,
      tools: new ToolRegistry(specs),
      cwd: this.#cwd,
      system: inHistory && head !== undefined ? head : system,
      ...(update ? { systemUpdate: update } : {}),
      recorder: this.#recorder,
      ...(this.#trace ? { trace: this.#trace } : {}),
      session: this.#session,
      hooks: this.#hooks,
      ...(this.#toolOutputStore ? { toolOutputStore: this.#toolOutputStore } : {}),
      control: this.#control,
      signal,
      ...this.#budgetOverrides,
      ...(this.effort ? { reasoningEffort: this.effort } : {}),
      ...(takeInput ? { takeInput } : {}),
      onEvent: this.#onEvent,
      ...this.#config.loopOverrides,
    });
  }

  /**
   * The system prompt as first sent this session — the head an implicit prompt
   * cache is anchored on. Only set for models that take updates in history.
   */
  #sessionSystem: SystemSegment[] | undefined;

  #onEvent = (event: AgentEvent): void => {
    if (event.type === 'context') {
      this.#lastContext = {
        usedTokens: event.usedTokens,
        windowTokens: event.windowTokens,
        ratio: event.ratio,
        breakdown: event.breakdown,
      };
      if (event.ratio >= 0.8 && !this.#contextWarned) {
        this.#contextWarned = true;
        this.#config.onNotice?.({
          kind: 'context-warn',
          level: 'warn',
          text:
            `context ${fmtTokens(event.usedTokens)}/${fmtTokens(event.windowTokens)} ` +
            `(${Math.round(event.ratio * 100)}%) [${fmtBreakdown(event.breakdown)}] — approaching the window limit. ` +
            `History is compacted automatically near ~92%${
              this.#config.compact === false ? ' (disabled by --no-compact)' : ''
            }.`,
        });
      }
    } else if (event.type === 'compaction') {
      this.#config.onNotice?.({
        kind: 'compaction',
        level: 'info',
        text:
          `context compacted: ${fmtTokens(event.tokensBefore)} → ${fmtTokens(event.tokensAfter)} tokens ` +
          `(kept last ${event.keptTurns} turn${event.keptTurns === 1 ? '' : 's'})`,
      });
    } else if (event.type === 'turn_retry') {
      this.#config.onNotice?.({
        kind: 'provider-retry',
        level: 'warn',
        text:
          `provider: model call failed — retrying (${event.attempt}/${event.maxAttempts}) ` +
          `in ${(event.delayMs / 1000).toFixed(1)}s: ${event.message}`,
      });
    }
    this.#config.onEvent?.(event);
  };

  #autoNotice(n: { kind: 'denied' | 'paused' | 'resumed'; text: string }): void {
    this.#config.onNotice?.({
      kind: 'auto-mode',
      level: n.kind === 'denied' || n.kind === 'paused' ? 'warn' : 'info',
      text: n.text,
    });
  }

  #foldClassifierUsage(usage: Usage): void {
    const costUSD =
      this.#autoClassifier?.pricing !== undefined
        ? estimateCostUSD(usage, this.#autoClassifier.pricing)
        : usage.costUSD;
    const folded: Usage = costUSD !== undefined ? { ...usage, costUSD } : usage;
    this.#sessionUsage = this.#sessionUsage ? addUsage(this.#sessionUsage, folded) : folded;
    void this.#trace?.append({
      type: 'classifier',
      ts: Date.now(),
      model: this.#autoClassifier?.ref ?? 'unknown',
      inputTokens: folded.inputTokens,
      outputTokens: folded.outputTokens,
      cachedInputTokens: folded.cachedInputTokens,
      ...(costUSD !== undefined ? { costUSD } : {}),
    });
  }

  #childAutoHook(
    def: AgentDefinition,
    subPrompt: string,
  ): AutoModeHookOptions | undefined {
    if (!this.#autoClassifier || !this.#autoState) return undefined;
    return {
      classifier: this.#autoClassifier,
      state: this.#autoState,
      ...(this.#memory.text ? { projectMemory: this.#memory.text } : {}),
      injectionProbe: this.#config.settings.autoMode?.injectionProbe === true,
      parentMessages: () => this.#messages,
      delegation: { name: 'task', input: { subagent_type: def.name, prompt: subPrompt } },
      onNotice: (n) => this.#autoNotice(n),
      onUsage: (u) => this.#foldClassifierUsage(u),
    };
  }

  async #runSubagent(
    def: AgentDefinition,
    subPrompt: string,
    runCtx: { signal?: AbortSignal; onEvent?: (event: ToolCallStartEvent | ToolCallEndEvent) => void },
  ): Promise<import('../subagents/types.js').SubagentResult> {
    const childModel = def.model ? this.#registry.resolve(def.model) : this.#model;
    const permissions = this.#config.settings.permissions ?? {};
    const childEngine = createPermissionEngine({
      workspaceRoot: this.#cwd,
      mode: this.#engine.getMode(),
      allow: [...(permissions.allow ?? []), ...(this.#config.allow ?? [])],
      ask: [...(permissions.ask ?? []), ...(this.#config.ask ?? [])],
      deny: [...(permissions.deny ?? []), ...(this.#config.deny ?? [])],
      classifyAllShell: this.#config.settings.autoMode?.classifyAllShell === true,
      useAutoModeDuringPlan:
        this.#autoAvailable.available && this.#config.settings.useAutoModeDuringPlan !== false,
    });
    const childTools = subagentToolSpecs(builtinTools(), def);
    const notice = (text: string): void =>
      this.#config.onNotice?.({ kind: 'subagent', level: 'info', text });
    const childAuto = this.#childAutoHook(def, subPrompt);

    notice(`  ⤷ ${def.name}: dispatched`);
    const result = await runSubagent({
      model: childModel,
      tools: childTools,
      system: buildSubagentSystemPrompt({
        cwd: this.#cwd,
        platform: this.#platform,
        role: def.body,
        ...(this.#memory.text ? { projectMemory: this.#memory.text } : {}),
        ...(this.#engine.getMode() === 'auto' ? { mode: 'auto' } : {}),
      }),
      hooks: mergeHooks(
        createPermissionHooks(childEngine, nonInteractiveAskHandler, childAuto),
        this.#config.settings.toolGuardrails !== false
          ? createToolGuardrailHooks({ isReadOnly: readOnlyLookup(childTools) })
          : undefined,
        this.#compactHook,
      ),
      cwd: this.#cwd,
      prompt: subPrompt,
      maxTurns: this.#config.budgets.subagentMaxTurns ?? 20,
      ...(this.#config.budgets.maxOutputTokens !== undefined
        ? { maxOutputTokens: this.#config.budgets.maxOutputTokens }
        : {}),
      ...(this.#config.budgets.temperature !== undefined
        ? { temperature: this.#config.budgets.temperature }
        : {}),
      // The definition's own effort wins; otherwise the sub-agent inherits the
      // session's, mapped by the provider to what the child model accepts.
      ...(childModel.capabilities.reasoning && (def.effort ?? this.#effort)
        ? { reasoningEffort: (def.effort ?? this.#effort)! }
        : {}),
      ...(this.#config.budgets.contextCompactRatio !== undefined
        ? { contextCompactRatio: this.#config.budgets.contextCompactRatio }
        : {}),
      ...(runCtx.signal ? { signal: runCtx.signal } : {}),
      onEvent: (ev) => {
        if (ev.type === 'tool_call_start') {
          notice(`  ⤷ ${def.name}: ${ev.name} ${JSON.stringify(ev.input)}`);
        }
        if (ev.type === 'tool_call_start' || ev.type === 'tool_call_end') runCtx.onEvent?.(ev);
      },
    });
    notice(
      `  ⤷ ${def.name}: done (${result.turns} turn${result.turns === 1 ? '' : 's'}, ` +
        `${fmtTokens(result.usage.inputTokens + result.usage.outputTokens)} tokens)`,
    );
    this.#sessionUsage = this.#sessionUsage
      ? addUsage(this.#sessionUsage, result.usage)
      : result.usage;
    await this.#trace?.append({
      type: 'subagent',
      ts: Date.now(),
      turn: 0,
      name: def.name,
      turns: result.turns,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cachedInputTokens: result.usage.cachedInputTokens,
      ...(result.usage.costUSD !== undefined ? { costUSD: result.usage.costUSD } : {}),
      stopReason: result.stopReason,
    });

    if (!this.#autoClassifier || this.#engine.getMode() !== 'auto') {
      return result;
    }

    let review: ClassifyResult | undefined;
    try {
      review = await this.#autoClassifier.classify(
        {
          type: 'tool_use',
          id: 'subagent-return',
          name: 'task',
          input: { subagent_type: def.name, prompt: subPrompt, report: result.report },
        },
        result.messages,
        {
          cwd: this.#cwd,
          mode: this.#engine.getMode(),
          ...(this.#memory.text ? { projectMemory: this.#memory.text } : {}),
          ...(runCtx.signal ? { signal: runCtx.signal } : {}),
          parentMessages: this.#messages,
          delegation: { name: 'task', input: { subagent_type: def.name, prompt: subPrompt } },
        },
      );
      this.#foldClassifierUsage(review.usage);
    } catch {
      review = undefined;
    }
    return { ...result, report: applySubagentReview(result.report, review, def.name) };
  }
}

type AttachmentKind = 'text' | 'pdf' | 'big-text' | 'binary';

/** What an attached file is, by its first 8 KB: a NUL means not text, whatever the extension says. */
async function sniffAttachment(path: string, size: number): Promise<AttachmentKind> {
  const handle = await open(path, 'r');
  try {
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    const head = buf.subarray(0, bytesRead);
    if (isPdf(head)) return 'pdf';
    if (head.includes(0)) return 'binary';
    return size > MAX_ATTACHMENT_BYTES ? 'big-text' : 'text';
  } finally {
    await handle.close();
  }
}

/** A PDF's text up to this goes in the message; longer, it goes as its path. */
const MAX_INLINE_PDF_CHARS = 40_000;

/** The body of a PDF too long to inline: how many pages, and how to read them. */
function pdfReference(size: number, read: string): string {
  const pages = /^PDF, (\d+) pages?\./.exec(read)?.[1];
  return (
    `(Not inlined: a PDF of ${fmtBytes(size)}${pages ? `, ${pages} pages` : ''}, too long to put in the message. ` +
    'Read it with the read tool, a range of `pages` at a time.)'
  );
}

/** The body of an attached file that goes as its path: what it is, and how to read it. */
function attachmentReference(kind: AttachmentKind, size: number, unread?: string): string {
  switch (kind) {
    case 'big-text':
      return `(Not inlined: ${fmtBytes(size)} of text. Read it with the read tool, a part at a time with offset/limit.)`;
    case 'pdf':
      return `(Not inlined: a PDF of ${fmtBytes(size)} that read could not open${unread ? ` — ${unread}` : ''}. Try bash, e.g. \`pdftotext\`.)`;
    default:
      return (
        `(Not inlined: a binary file of ${fmtBytes(size)}. Inspect it with bash — e.g. \`file\`, \`unzip -l\`, ` +
        'or on macOS `textutil -convert txt -stdout` for .docx/.rtf.)'
      );
  }
}

/**
 * Where a session's full tool outputs go: the system temp directory, which
 * the file tools accept — the state dir is under the home directory, and its
 * paths are ones the model can't read. Its artifact directory only when that
 * is inside the workspace (`$HC_STATE_DIR` there, a session an earlier version
 * logged in the project).
 */
function toolOutputDir(artifactsDir: string, cwd: string, sessionId: string): string {
  const rel = relative(resolve(cwd), artifactsDir);
  return rel.startsWith('..') || isAbsolute(rel) ? join(tmpdir(), 'hc-toolout', sessionId) : artifactsDir;
}

/** Build an `isReadOnly(name)` lookup from the specs a session or sub-agent will run. */
function readOnlyLookup(specs: readonly { name: string; readOnly: boolean }[]): (name: string) => boolean {
  const map = new Map(specs.map((s) => [s.name, s.readOnly]));
  return (name) => map.get(name) ?? false;
}

/** The guardrails' read-only lookup over everything a session's runs offer the model. */
function sessionReadOnlyLookup(tools: {
  backgroundProcesses: boolean;
  skills: boolean;
  task: boolean;
  mcp: readonly AnyToolSpec[];
}): (name: string) => boolean {
  return readOnlyLookup([
    ...builtinTools(),
    // Polling a background command that printed nothing new is a same-result read like any other.
    ...(tools.backgroundProcesses
      ? ([
          { name: 'bash_output', readOnly: true },
          { name: 'bash_kill', readOnly: true },
        ] as AnyToolSpec[])
      : []),
    ...(tools.skills ? [{ name: 'skill', readOnly: true } as AnyToolSpec] : []),
    ...(tools.task ? [{ name: 'task', readOnly: false } as AnyToolSpec] : []),
    ...tools.mcp,
  ]);
}

/** `/name` commands for the MCP servers' prompts: `server:name` always, the bare name for the first server to have it. */
async function mcpPromptCommands(hub: McpHub): Promise<Map<string, { server: string; name: string }>> {
  const commands = new Map<string, { server: string; name: string }>();
  if (hub.empty) return commands;
  for (const { server, prompt } of await hub.prompts()) {
    commands.set(`${server}:${prompt.name}`, { server, name: prompt.name });
    if (!commands.has(prompt.name)) commands.set(prompt.name, { server, name: prompt.name });
  }
  return commands;
}

/** How two lists of named things differ, or `undefined` when they don't. */
function diffNamed<T extends { name: string }>(before: readonly T[], after: readonly T[]): NamedChanges | undefined {
  const was = new Map(before.map((x) => [x.name, JSON.stringify(x)]));
  const is = new Map(after.map((x) => [x.name, JSON.stringify(x)]));
  const added = after.filter((x) => !was.has(x.name)).map((x) => x.name);
  const removed = before.filter((x) => !is.has(x.name)).map((x) => x.name);
  const changed = after.filter((x) => was.has(x.name) && was.get(x.name) !== is.get(x.name)).map((x) => x.name);
  return added.length + removed.length + changed.length > 0 ? { added, removed, changed } : undefined;
}

/** A reload's notice: what came, went and changed, per kind — and the MCP servers that couldn't be reached. */
function describeCapabilityChanges(changes: CapabilityChanges, status: readonly McpServerStatus[]): string {
  const list = (verb: string, names: readonly string[], label?: (name: string) => string): string[] =>
    names.length > 0 ? [`${verb} ${names.map((n) => (label ? label(n) : n)).join(', ')}`] : [];
  const named = (what: string, c: NamedChanges): string =>
    `${what}: ${[...list('added', c.added), ...list('changed', c.changed), ...list('removed', c.removed)].join('; ')}`;
  const tools = (name: string): string => {
    const s = status.find((x) => x.name === name);
    return s?.state === 'ready' ? `${name} (${s.toolCount} tool${s.toolCount === 1 ? '' : 's'})` : name;
  };
  const parts: string[] = [];
  if (changes.skills) parts.push(named('skills', changes.skills));
  if (changes.agents) parts.push(named('sub-agents', changes.agents));
  if (changes.mcp) {
    const m = changes.mcp;
    const bits = [
      ...list('added', m.added, tools),
      ...list('reconnected', [...m.changed, ...m.retried], tools),
      ...list('removed', m.removed),
    ];
    if (bits.length > 0) parts.push(`MCP: ${bits.join('; ')}`);
  }
  const failed = (changes.mcp?.failed ?? []).filter((f) => !f.needsAuth);
  return (
    `picked up changes — ${parts.join(' · ')}` +
    (failed.length > 0 ? ` — unavailable: ${failed.map((f) => `${f.name} (${f.error})`).join(', ')}` : '')
  );
}

/**
 * An MCP server that needs the user to sign in. The text is for a terminal,
 * where a session started before the sign-in doesn't connect it; the web
 * shows a Sign in button instead (`data.server`), and connects open sessions
 * once it's done.
 */
function mcpAuthNotice(server: string): Notice {
  return {
    kind: 'mcp-auth',
    level: 'warn',
    text: `MCP server ${server} needs you to sign in — run: marvis mcp login ${server}, then start a new session`,
    data: { server },
  };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
