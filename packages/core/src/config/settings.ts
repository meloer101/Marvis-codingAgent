/**
 * Layered settings.
 *
 * Three layers, most specific last: built-in defaults, the user's
 * `~/.agent/settings.json`, then the project's `.agent/settings.json`. A project
 * can point at a different endpoint or model without the user editing globals,
 * and neither file has to exist.
 *
 * This file grows in later phases (permission rules, MCP servers, skill paths).
 * The merge strategy is fixed here so those additions inherit it.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';

import { DEFAULT_ALLOW_RULES } from '../permissions/defaults.js';
import type { PermissionConfig } from '../permissions/types.js';
import type { RouterSettings } from '../provider/router.js';
import type { ReasoningEffort } from '../provider/types.js';

export interface AutoModeConfig {
  /** Classifier model (`provider/model`). Falls back to the session model. */
  model?: string;
  environment?: string[];
  allow?: string[];
  soft_deny?: string[];
  hard_deny?: string[];
  classifyAllShell?: boolean;
  injectionProbe?: boolean;
}

export interface Settings extends RouterSettings {
  /** `provider/model` used when none is given on the command line. */
  model?: string;
  /** Cheaper model for summarization and other background work. */
  smallModel?: string;
  /**
   * More `provider/model` refs for a model picker (the web's) to offer,
   * besides `model`, `smallModel` and the built-in lineup (`MODEL_CATALOG`).
   */
  models?: string[];
  /**
   * Context tokens to plan against, when the model's window is larger than the
   * span it stays reliable over. Warn / compact / stop ratios are computed
   * against this; the model's real window still decides overflow. Defaults to
   * the model's `qualityContextWindow`, else its full window.
   */
  contextBudgetTokens?: number;
  maxTurns?: number;
  maxCostUSD?: number;
  /** Stop once cumulative input+output tokens exceed this. */
  maxTokens?: number;
  /** Per-request output cap; also the space reserved out of the context window. */
  maxOutputTokens?: number;
  temperature?: number;
  /** Reasoning-effort level for reasoning-capable models. Overridable per run with `--effort`. */
  reasoningEffort?: ReasoningEffort;
  /** Usable-window fraction at which history is auto-compacted. Loop default 0.92. */
  contextCompactRatio?: number;
  /** Trailing turns kept verbatim through a compaction. Compactor default 3. */
  compactKeepTurns?: number;
  /** Turn budget for a dispatched sub-agent. Default 20. */
  subagentMaxTurns?: number;
  /**
   * Signature-level tool-loop guardrails (repeated failing calls, same tool
   * failing across args, unchanging read-only results). Default enabled; set
   * `false` to disable for a project/user.
   */
  toolGuardrails?: boolean;
  /**
   * Before a run that changed files or ran commands ends, send the model back
   * once to check the result against the task's stated requirements
   * (`agent/verify-stop.ts`). Default off: a paired eval (2026-09-27) showed
   * its cost (4–8 extra turns) but no gain yet on the tasks it was measured on.
   */
  verifyBeforeStop?: boolean;
  /** Per-session telemetry trace (`traces/` in the state dir). Default enabled; `--no-trace` overrides per run. */
  telemetry?: { enabled?: boolean };
  /** TUI presentation hints. `theme` is a v1 stub: dark is the default, auto/light land later. */
  tui?: { theme?: 'dark' | 'light' | 'auto'; hideAutoModeSetup?: boolean };
  permissions?: PermissionConfig;
  /**
   * When auto mode is available, non-read-only bash in plan mode goes to the
   * classifier instead of being denied. Default true.
   */
  useAutoModeDuringPlan?: boolean;
  autoMode?: AutoModeConfig;
  /**
   * Let `bash` start commands in the background (`run_in_background`), read
   * with `bash_output` and stopped with `bash_kill`. Off by default: it
   * changes the tools the model is shown. Sessions started after it changes
   * take it up.
   */
  backgroundProcesses?: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  model: 'deepseek/deepseek-flash',
  maxTurns: 50,
  temperature: 0,
  permissions: {
    mode: 'ask',
    allow: [...DEFAULT_ALLOW_RULES],
    ask: [],
    deny: [],
  },
  useAutoModeDuringPlan: true,
};

export const AGENT_DIR = '.agent';
export const SETTINGS_FILE = 'settings.json';

export interface LoadedSettings {
  settings: Settings;
  /** Files that were actually read, in application order. For `marvis doctor`. */
  sources: string[];
}

export async function loadSettings(
  cwd = process.cwd(),
  opts: { homeDir?: string } = {},
): Promise<LoadedSettings> {
  const userPath = userSettingsPath(opts.homeDir);
  const projectPath = await projectSettingsPath(cwd);
  const candidates = [userPath, projectPath];

  let settings: Settings = { ...DEFAULT_SETTINGS };
  const sources: string[] = [];

  for (const path of candidates) {
    let layer = await readSettingsFile(path);
    if (!layer) continue;
    // A repo must not ship auto-mode config that authorizes itself. Project
    // `.agent/settings.json` may still *disable* auto mode.
    if (path === projectPath && path !== userPath) {
      layer = sanitizeProjectLayer(layer);
    }
    settings = mergeSettings(settings, layer);
    sources.push(path);
  }

  return { settings, sources };
}

/**
 * Strip the auto-mode knobs a project file is not allowed to set. `disableAutoMode`
 * is kept so a repo can turn the feature off for everyone who clones it.
 */
export function sanitizeProjectLayer(layer: Settings): Settings {
  const next: Settings = { ...layer };
  delete next.autoMode;
  if (next.permissions?.mode === 'auto') {
    const { mode: _dropped, ...rest } = next.permissions;
    next.permissions = rest;
  }
  return next;
}

async function readSettingsFile(path: string): Promise<Settings | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return undefined; // Absent is the normal case, not an error.
  }
  try {
    return JSON.parse(raw) as Settings;
  } catch (err) {
    throw new Error(
      `${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Shallow for scalars, per-key merge for the two record-shaped fields. Deep
 * merging everything would make it impossible for a project to *replace* a
 * provider definition rather than extend it.
 */
export function mergeSettings(base: Settings, layer: Settings): Settings {
  const merged: Settings = { ...base, ...layer };
  if (base.providers || layer.providers) {
    merged.providers = { ...base.providers };
    for (const [id, cfg] of Object.entries(layer.providers ?? {})) {
      merged.providers[id] = { ...(base.providers?.[id] ?? {}), ...cfg };
    }
  }
  if (base.capabilities || layer.capabilities) {
    merged.capabilities = { ...base.capabilities, ...layer.capabilities };
  }
  if (base.permissions || layer.permissions) {
    const disable =
      base.permissions?.disableAutoMode === 'disable' ||
      layer.permissions?.disableAutoMode === 'disable'
        ? ('disable' as const)
        : (layer.permissions?.disableAutoMode ?? base.permissions?.disableAutoMode);
    merged.permissions = {
      mode: layer.permissions?.mode ?? base.permissions?.mode,
      planApprovedMode: layer.permissions?.planApprovedMode ?? base.permissions?.planApprovedMode,
      allow: [...(base.permissions?.allow ?? []), ...(layer.permissions?.allow ?? [])],
      ask: [...(base.permissions?.ask ?? []), ...(layer.permissions?.ask ?? [])],
      deny: [...(base.permissions?.deny ?? []), ...(layer.permissions?.deny ?? [])],
      ...(disable ? { disableAutoMode: disable } : {}),
    };
  }
  if (layer.useAutoModeDuringPlan !== undefined) {
    merged.useAutoModeDuringPlan = layer.useAutoModeDuringPlan;
  }
  if (base.autoMode || layer.autoMode) {
    // A rule list neither layer set must stay absent: `resolveAutoModeRules`
    // reads `undefined` as "use the built-in rules" but `[]` as "no rules".
    const list = (key: 'environment' | 'allow' | 'soft_deny' | 'hard_deny') => {
      const b = base.autoMode?.[key];
      const l = layer.autoMode?.[key];
      return b === undefined && l === undefined ? {} : { [key]: [...(b ?? []), ...(l ?? [])] };
    };
    const model = layer.autoMode?.model ?? base.autoMode?.model;
    const classifyAllShell = layer.autoMode?.classifyAllShell ?? base.autoMode?.classifyAllShell;
    const injectionProbe = layer.autoMode?.injectionProbe ?? base.autoMode?.injectionProbe;
    merged.autoMode = {
      ...(model !== undefined ? { model } : {}),
      ...(classifyAllShell !== undefined ? { classifyAllShell } : {}),
      ...(injectionProbe !== undefined ? { injectionProbe } : {}),
      ...list('environment'),
      ...list('allow'),
      ...list('soft_deny'),
      ...list('hard_deny'),
    };
  }
  if (base.tui || layer.tui) {
    merged.tui = { ...base.tui, ...layer.tui };
  }
  return merged;
}

/** Path of the user-level settings file (`~/.agent/settings.json`). */
export function userSettingsPath(homeDir = homedir()): string {
  return join(homeDir, AGENT_DIR, SETTINGS_FILE);
}

/**
 * Patch `~/.agent/settings.json` (create it if missing). Array fields in
 * `autoMode` are replaced, not concatenated — callers pass the full list they
 * want persisted. Project settings are never written here.
 */
export async function writeUserSettings(
  patch: Settings,
  opts?: { homeDir?: string },
): Promise<string> {
  return patchSettingsFile(userSettingsPath(opts?.homeDir), patch);
}

/** Path of project `cwd`'s settings file (`<state root>/.agent/settings.json`), as `loadSettings` reads it. */
export async function projectSettingsPath(cwd: string): Promise<string> {
  return join((await findStateRoot(cwd)) ?? resolve(cwd), AGENT_DIR, SETTINGS_FILE);
}

/**
 * Patch project `cwd`'s `.agent/settings.json` (create it if missing), merged
 * as `writeUserSettings` merges. `autoMode` is refused: `loadSettings` drops
 * it from the project layer, so a repository can't authorize itself.
 */
export async function writeProjectSettings(cwd: string, patch: Settings): Promise<string> {
  if (patch.autoMode) throw new Error('auto mode is configured per user, not per project');
  return patchSettingsFile(await projectSettingsPath(cwd), patch);
}

async function patchSettingsFile(path: string, patch: Settings): Promise<string> {
  let text: string | undefined;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    // First write.
  }
  let existing: Settings = {};
  if (text !== undefined && text.trim() !== '') {
    // Never write over a file that doesn't parse: that would lose what's in it.
    try {
      existing = JSON.parse(text) as Settings;
    } catch (err) {
      throw new Error(`${path} is not valid JSON (${err instanceof Error ? err.message : String(err)}); fix it first`);
    }
  }
  const next: Settings = { ...existing, ...patch };
  if (patch.permissions) {
    next.permissions = { ...existing.permissions, ...patch.permissions };
  }
  if (patch.autoMode) {
    next.autoMode = { ...existing.autoMode, ...patch.autoMode };
  }
  if (patch.tui) {
    next.tui = { ...existing.tui, ...patch.tui };
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return path;
}

/** Remove the `autoMode` block from `~/.agent/settings.json`. Other keys stay. */
export async function clearUserAutoMode(opts?: { homeDir?: string }): Promise<string> {
  const path = userSettingsPath(opts?.homeDir);
  let existing: Settings = {};
  try {
    existing = JSON.parse(await readFile(path, 'utf8')) as Settings;
  } catch {
    return path;
  }
  delete existing.autoMode;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(existing, null, 2)}\n`, 'utf8');
  return path;
}

/**
 * Nearest ancestor holding a `.agent` directory or a `.git` directory. Falls
 * back to `cwd`, so the tool works in a directory that is not a repository.
 */
export async function findProjectRoot(cwd = process.cwd()): Promise<string> {
  return (await findMarkedProjectRoot(cwd)) ?? resolve(cwd);
}

/**
 * Nearest ancestor holding a `.agent` or `.git` directory, or the top of a
 * linked worktree (whose `.git` is a file); `undefined` when there is none.
 */
export async function findMarkedProjectRoot(cwd = process.cwd()): Promise<string | undefined> {
  const { stat } = await import('node:fs/promises');
  let dir = resolve(cwd);

  for (;;) {
    const agent = await stat(join(dir, AGENT_DIR)).catch(() => undefined);
    if (agent?.isDirectory()) return dir;
    const git = await stat(join(dir, '.git')).catch(() => undefined);
    if (git?.isDirectory()) return dir;
    if (git?.isFile() && (await linkedWorktreeMain(dir)) !== undefined) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * The main checkout of the repository `dir` is a linked worktree of (`git
 * worktree add`), when `dir` is the top of one: its `.git` is a file naming a
 * gitdir whose `commondir` leads back to the repository's `.git`. Undefined for
 * anything else — a plain checkout, a submodule (its gitdir has no
 * `commondir`), a worktree of a bare repository (there is no main checkout).
 */
export async function linkedWorktreeMain(dir: string): Promise<string | undefined> {
  let gitFile: string;
  try {
    gitFile = await readFile(join(dir, '.git'), 'utf8');
  } catch {
    return undefined; // none, or a directory
  }
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(gitFile);
  if (!match) return undefined;
  const gitDir = resolve(dir, match[1]!);
  let common: string;
  try {
    common = resolve(gitDir, (await readFile(join(gitDir, 'commondir'), 'utf8')).trim());
  } catch {
    return undefined;
  }
  return basename(common) === '.git' ? dirname(common) : undefined;
}

/**
 * Where a project's own state lives — its settings, memory, MCP servers,
 * session logs: the marked project root, except inside a linked worktree,
 * which shares its main checkout's (the same directory there). A worktree is
 * the same project on another branch; what it checks out — instructions,
 * skills, agents, plans — still comes from `findProjectRoot`.
 */
export async function findStateRoot(cwd = process.cwd()): Promise<string | undefined> {
  const { stat } = await import('node:fs/promises');
  const root = await findMarkedProjectRoot(cwd);
  if (root === undefined) return undefined;
  // The checkout `root` is in: the first directory up from it with a `.git`.
  for (let dir = root; ; ) {
    const main = await linkedWorktreeMain(dir);
    if (main !== undefined) return join(main, relative(dir, root));
    if (await stat(join(dir, '.git')).then(() => true, () => false)) return root;
    const parent = dirname(dir);
    if (parent === dir) return root;
    dir = parent;
  }
}

/**
 * Names the directory runtime state goes to — session logs, traces, offloaded
 * tool output — overriding where it would otherwise go. For harnesses that run
 * `hc` inside someone else's workspace (Harbor points it at its log dir), where
 * a `.agent/` in the task directory is something the agent finds, reads, and
 * can commit.
 */
export const STATE_DIR_ENV = 'HC_STATE_DIR';

/**
 * Where Marvis keeps a directory's runtime state — session logs, traces,
 * offloaded tool output: `~/.agent/projects/<name>-<hash>/`, keyed by the
 * directory's real path. Out of the project itself, so a session log (which
 * holds tool output) is never something `git add -A` picks up, and running in
 * an arbitrary directory doesn't leave a `.agent/` behind in it.
 */
export async function stateHome(dir: string, homeDir = homedir()): Promise<string> {
  const real = await realpath(dir).catch(() => resolve(dir));
  const hash = createHash('sha256').update(real).digest('hex').slice(0, 10);
  const name = (basename(real) || 'root').replace(/[^\w.-]+/g, '_');
  return join(homeDir, AGENT_DIR, 'projects', `${name}-${hash}`);
}

/**
 * The directory session logs and traces are written under: `$HC_STATE_DIR` when
 * set; otherwise the `stateHome` of the project (in a linked worktree, of its
 * main checkout — `findStateRoot`), or of `cwd` itself outside a project.
 */
export async function resolveStateDir(
  cwd = process.cwd(),
  opts: { env?: NodeJS.ProcessEnv; homeDir?: string } = {},
): Promise<string> {
  const override = (opts.env ?? process.env)[STATE_DIR_ENV];
  if (override) return resolve(cwd, override);
  return stateHome((await findStateRoot(cwd)) ?? cwd, opts.homeDir);
}

/**
 * Where versions up to 0.1 logged a project's sessions and traces:
 * `<projectRoot>/.agent`, inside the repository. Nothing new is written there;
 * what is there is still listed, resumed and traced. Undefined outside a
 * project, and under `$HC_STATE_DIR`.
 */
export async function legacyStateDir(
  cwd = process.cwd(),
  opts: { env?: NodeJS.ProcessEnv } = {},
): Promise<string | undefined> {
  if ((opts.env ?? process.env)[STATE_DIR_ENV]) return undefined;
  const root = await findStateRoot(cwd);
  return root === undefined ? undefined : join(root, AGENT_DIR);
}

/**
 * Every directory a session of `cwd` may be logged in: where they are written
 * (`resolveStateDir`) first, then where an earlier version left them
 * (`legacyStateDir`).
 */
export async function resolveStateDirs(
  cwd = process.cwd(),
  opts: { env?: NodeJS.ProcessEnv; homeDir?: string } = {},
): Promise<[string, ...string[]]> {
  const legacy = await legacyStateDir(cwd, opts);
  return [await resolveStateDir(cwd, opts), ...(legacy === undefined ? [] : [legacy])];
}

/**
 * Where project-scoped memory lives: `<projectRoot>/.agent/memory` inside a
 * project (shared by its linked worktrees, `findStateRoot`), otherwise under
 * `stateHome` — never a fresh `.agent/` in a directory that is not a project.
 */
export async function resolveProjectMemoryDir(cwd = process.cwd(), homeDir?: string): Promise<string> {
  const root = await findStateRoot(cwd);
  return join(root ? join(root, AGENT_DIR) : await stateHome(cwd, homeDir), 'memory');
}
