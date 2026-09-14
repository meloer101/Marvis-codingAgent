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

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

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
  /** Per-session telemetry trace under `.agent/traces`. Default enabled; `--no-trace` overrides per run. */
  telemetry?: { enabled?: boolean };
  /** TUI presentation hints. `theme` is a v1 stub: dark is the default, auto/light land later. */
  tui?: { theme?: 'dark' | 'light' | 'auto' };
  permissions?: PermissionConfig;
  /**
   * When auto mode is available, non-read-only bash in plan mode goes to the
   * classifier instead of being denied. Default true.
   */
  useAutoModeDuringPlan?: boolean;
  autoMode?: AutoModeConfig;
}

export const DEFAULT_SETTINGS: Settings = {
  model: 'deepseek/deepseek-v4-flash',
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
  /** Files that were actually read, in application order. For `hc doctor`. */
  sources: string[];
}

export async function loadSettings(cwd = process.cwd()): Promise<LoadedSettings> {
  const userPath = join(homedir(), AGENT_DIR, SETTINGS_FILE);
  const projectPath = join(await findProjectRoot(cwd), AGENT_DIR, SETTINGS_FILE);
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
    merged.autoMode = {
      model: layer.autoMode?.model ?? base.autoMode?.model,
      classifyAllShell: layer.autoMode?.classifyAllShell ?? base.autoMode?.classifyAllShell,
      injectionProbe: layer.autoMode?.injectionProbe ?? base.autoMode?.injectionProbe,
      environment: [...(base.autoMode?.environment ?? []), ...(layer.autoMode?.environment ?? [])],
      allow: [...(base.autoMode?.allow ?? []), ...(layer.autoMode?.allow ?? [])],
      soft_deny: [...(base.autoMode?.soft_deny ?? []), ...(layer.autoMode?.soft_deny ?? [])],
      hard_deny: [...(base.autoMode?.hard_deny ?? []), ...(layer.autoMode?.hard_deny ?? [])],
    };
  }
  return merged;
}

/**
 * Nearest ancestor holding a `.agent` directory or a `.git` directory. Falls
 * back to `cwd`, so the tool works in a directory that is not a repository.
 */
export async function findProjectRoot(cwd = process.cwd()): Promise<string> {
  const { stat } = await import('node:fs/promises');
  let dir = resolve(cwd);

  for (;;) {
    for (const marker of [AGENT_DIR, '.git']) {
      try {
        const s = await stat(join(dir, marker));
        if (s.isDirectory()) return dir;
      } catch {
        // keep looking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return resolve(cwd);
    dir = parent;
  }
}
