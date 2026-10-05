/**
 * `doctor.run`: what Marvis makes of a workspace's setup, as a list of checks
 * — each fine, worth a look, broken, or just so, with what to do and where.
 *
 * The quick checks read files and look at the machine; none spends anything
 * or reaches the network. `connect` adds the two that do: the model's
 * provider asked for its list of models (which costs no tokens, and says
 * whether the key is taken and the model's name is known there), and each
 * MCP server started as a session would start it.
 *
 * Nothing secret goes back: a key is reported by where it comes from, an MCP
 * server's `${VAR}`s by name.
 */

import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join, relative } from 'node:path';

import {
  AGENT_DIR,
  DEFAULT_SETTINGS,
  ProviderRegistry,
  SkillCatalog,
  VERSION,
  discoverSkills,
  findStateRoot,
  isSandboxExecAvailable,
  parseModelRef,
  projectSettingsPath,
  userSettingsPath,
} from '@harness-code/core';
import type { Settings } from '@harness-code/core';
import type { DoctorCheck, DoctorGroup, DoctorReport, DoctorStatus, ProviderInfo } from '@harness-code/protocol';

import { agentsView } from './agents.js';
import { layeredSettings, mcpPaths, mcpTest, mcpView, memoryView, providersView } from './settings.js';
import type { SettingsPlace } from './settings.js';
import { skillsView } from './skills.js';

/** What the doctor asks of the server around a workspace — each optional: the CLI has less to say. */
export interface DoctorEnvironment {
  /** Why sessions can't use auto mode, when they can't. */
  autoModeProblem?: () => Promise<string | undefined>;
  /** node-pty loads: the terminal panel works. */
  terminals?: () => Promise<boolean>;
  /** The system's folder chooser can be shown. */
  folderPicker?: () => Promise<boolean>;
  /** The editors files can be opened in, by name. */
  editors?: () => Promise<string[]>;
  /** Where the workspace's sessions are recorded. */
  stateDir?: string;
  /** The model sessions start on whatever the settings say (`marvis web --model`, `--mock`). */
  modelOverride?: { ref: string; mock?: boolean };
  /** For the provider check (tests). */
  fetchImpl?: typeof fetch;
  mcpConnectTimeoutMs?: number;
}

/** Past this, an instruction file given whole to every session is a lot of context. */
const LARGE_INSTRUCTIONS = 40 * 1024;
const MIN_NODE: [number, number] = [20, 10];

export async function doctorReport(place: SettingsPlace, env: DoctorEnvironment = {}, opts: { connect?: boolean } = {}): Promise<DoctorReport> {
  const connect = opts.connect === true;
  const tilde = (path: string): string => (path === place.home || path.startsWith(`${place.home}/`) ? `~${path.slice(place.home.length)}` : path);
  const settings = await layeredSettings(place);
  const groups = await Promise.all([
    modelGroup(place, settings, env, connect, tilde),
    settingsGroup(place, tilde),
    permissionsGroup(settings, env),
    mcpGroup(place, env, connect, tilde),
    extensionsGroup(place, settings, tilde),
    environmentGroup(place, env, tilde),
  ]);
  return { groups, connected: connect, at: Date.now() };
}

function check(id: string, label: string, status: DoctorStatus, detail: string, more: Pick<DoctorCheck, 'fix' | 'section'> = {}): DoctorCheck {
  return { id, label, status, detail, ...more };
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function keyOrigin(p: ProviderInfo, tilde: (path: string) => string, place: SettingsPlace): string {
  switch (p.keySource) {
    case 'user':
      return `from ${tilde(join(place.home, AGENT_DIR, '.env'))} (${p.keySourceVar})`;
    case 'project':
      return `from the project's .env (${p.keySourceVar})`;
    case 'environment':
      return `from the environment Marvis started in (${p.keySourceVar})`;
    case 'settings':
      return 'written in a settings.json';
    default:
      return '';
  }
}

// ── The model ──────────────────────────────────────────────────────────

async function modelGroup(
  place: SettingsPlace,
  settings: Settings,
  env: DoctorEnvironment,
  connect: boolean,
  tilde: (path: string) => string,
): Promise<DoctorGroup> {
  const checks: DoctorCheck[] = [];
  if (env.modelOverride?.mock) {
    checks.push(check('model.default', 'Default model', 'info', `${env.modelOverride.ref} — scripted answers (marvis web --mock): no provider, no key`));
    return { id: 'model', title: 'Model', checks };
  }
  const view = await providersView(place);
  const ref = env.modelOverride?.ref ?? settings.model ?? DEFAULT_SETTINGS.model ?? '';
  const whose = env.modelOverride
    ? "this server's --model"
    : view.modelSource === 'project'
      ? "the project's settings"
      : view.modelSource === 'user'
        ? 'your settings'
        : 'the built-in default';
  const registry = new ProviderRegistry({ settings, env: place.env, ...(env.fetchImpl ? { fetchImpl: env.fetchImpl } : {}) });

  let providerId: string;
  let modelId: string;
  try {
    ({ provider: providerId, model: modelId } = parseModelRef(ref, settings.defaultProvider ?? 'openai'));
    registry.config(providerId);
  } catch (err) {
    checks.push(
      check('model.default', 'Default model', 'error', `“${ref}”, from ${whose}, can't be used: ${err instanceof Error ? err.message : String(err)}`, {
        fix: 'Pick a model as provider/model in Settings › Models.',
        section: 'models',
      }),
    );
    return { id: 'model', title: 'Model', checks };
  }
  checks.push(check('model.default', 'Default model', 'ok', `${ref} — from ${whose}`, { section: 'models' }));

  const provider = view.providers.find((p) => p.id === providerId);
  const label = provider?.label ?? providerId;
  if (provider?.keySource) {
    checks.push(
      check('model.key', `${label} API key`, provider.keySource === 'settings' ? 'warn' : 'ok', `Set, ${keyOrigin(provider, tilde, place)}`, {
        ...(provider.keySource === 'settings' ? { fix: 'A key in a settings file is easy to share by mistake: keep it in ~/.agent/.env (Settings › Models saves it there).' } : {}),
        section: 'models',
      }),
    );
  } else if (provider?.requiresKey) {
    checks.push(
      check('model.key', `${label} API key`, 'error', `None set — sessions on ${ref} can't start`, {
        fix: `Paste one in Settings › Models, or set ${provider.keyVar ?? 'its variable'} in your environment.`,
        section: 'models',
      }),
    );
  } else {
    checks.push(check('model.key', `${label} API key`, 'info', `${label} takes none: it runs at ${provider?.baseUrl ?? 'its own address'}`, { section: 'models' }));
  }

  if (connect && (provider?.keySource || !provider?.requiresKey)) {
    const result = await registry.check(providerId);
    if (result.ok) {
      const listed = result.models;
      if (listed && listed.length > 0 && !listed.includes(modelId)) {
        checks.push(
          check('model.connection', `${label} connection`, 'warn', `${label} answered and took the key, but doesn't list “${modelId}” among its ${plural(listed.length, 'model')}`, {
            fix: `If sessions fail with “model not found”, check the name in Settings › Models. Listed: ${listed.slice(0, 8).join(', ')}${listed.length > 8 ? ', …' : ''}`,
            section: 'models',
          }),
        );
      } else {
        checks.push(
          check('model.connection', `${label} connection`, 'ok', `${label} answered${provider?.keySource ? ' and took the key' : ''}${listed ? `, listing ${plural(listed.length, 'model')}` : ''}`),
        );
      }
    } else if (result.problem === 'rejected') {
      checks.push(check('model.connection', `${label} connection`, 'error', result.message, { fix: 'Paste a key that works in Settings › Models.', section: 'models' }));
    } else if (result.problem === 'unreachable') {
      checks.push(
        check('model.connection', `${label} connection`, 'error', result.message, {
          fix: provider?.requiresKey ? 'Check the network, or a proxy set for it.' : `Start ${label}, or pick another model in Settings › Models.`,
          section: 'models',
        }),
      );
    } else if (result.problem === 'unexpected') {
      checks.push(check('model.connection', `${label} connection`, 'warn', `${result.message} — the key couldn't be checked this way`));
    }
  }

  if (settings.smallModel) {
    checks.push(await auxiliaryModel('model.small', 'Model for summaries', settings.smallModel, settings, view));
  }
  return { id: 'model', title: 'Model', checks };
}

/** A model besides the default (summaries, a sub-agent's): whether its provider is known and has what it needs. */
async function auxiliaryModel(id: string, label: string, ref: string, settings: Settings, view: { providers: ProviderInfo[] }): Promise<DoctorCheck> {
  let providerId: string;
  try {
    providerId = parseModelRef(ref, settings.defaultProvider ?? 'openai').provider;
  } catch (err) {
    return check(id, label, 'error', `“${ref}” can't be used: ${err instanceof Error ? err.message : String(err)}`, { section: 'models' });
  }
  const p = view.providers.find((x) => x.id === providerId);
  if (!p) return check(id, label, 'error', `${ref}: there's no provider “${providerId}”`, { section: 'models' });
  if (p.requiresKey && !p.keySource) {
    return check(id, label, 'error', `${ref}: ${p.label} has no API key`, { fix: 'Paste one in Settings › Models.', section: 'models' });
  }
  return check(id, label, 'ok', ref);
}

// ── Settings files ─────────────────────────────────────────────────────

async function settingsFile(id: string, label: string, path: string, tilde: (p: string) => string, whose: string): Promise<DoctorCheck> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return check(id, label, 'info', `${tilde(path)} isn't there: ${whose}`, { section: 'permissions' });
  }
  try {
    if (text.trim() !== '') {
      const value: unknown = JSON.parse(text);
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('not a JSON object');
    }
    return check(id, label, 'ok', `${tilde(path)} reads`, { section: 'permissions' });
  } catch (err) {
    return check(id, label, 'error', `${tilde(path)} doesn't parse: ${err instanceof Error ? err.message : String(err)}`, {
      fix: 'Fix it or delete it: until it parses, sessions run on the built-in settings alone — its rules, model and keys unread.',
      section: 'permissions',
    });
  }
}

async function settingsGroup(place: SettingsPlace, tilde: (p: string) => string): Promise<DoctorGroup> {
  // The project's files by where they are in it.
  const inProject = (path: string): string => {
    const rel = relative(place.root, path);
    return rel.startsWith('..') || isAbsolute(rel) ? tilde(path) : rel;
  };
  return {
    id: 'settings',
    title: 'Settings files',
    checks: await Promise.all([
      settingsFile('settings.user', 'Your settings', userSettingsPath(place.home), tilde, 'the built-in settings apply'),
      settingsFile('settings.project', "The project's settings", await projectSettingsPath(place.root), inProject, 'yours apply as they are'),
    ]),
  };
}

// ── Permissions ────────────────────────────────────────────────────────

async function permissionsGroup(settings: Settings, env: DoctorEnvironment): Promise<DoctorGroup> {
  const checks: DoctorCheck[] = [];
  const mode = settings.permissions?.mode ?? 'ask';
  const autoProblem = await env.autoModeProblem?.();
  if (mode === 'yolo') {
    checks.push(
      check('permissions.mode', 'Mode new sessions start in', 'warn', 'YOLO: nothing asks before it runs — commands, writes, fetches', {
        fix: 'Fine in a sandbox or a throwaway checkout; otherwise start in Ask or Auto, set in a settings.json (permissions.mode).',
        section: 'permissions',
      }),
    );
  } else if (mode === 'auto' && autoProblem) {
    checks.push(check('permissions.mode', 'Mode new sessions start in', 'warn', `Auto, which isn't available (${autoProblem}): sessions start in Ask`, { section: 'auto-mode' }));
  } else {
    const names: Record<string, string> = { ask: 'Ask: calls that change things ask first', acceptEdits: 'Accept edits: file edits run, the rest asks', plan: 'Plan: it reads and plans, changing nothing', auto: 'Auto: a classifier decides what needs asking' };
    checks.push(check('permissions.mode', 'Mode new sessions start in', 'ok', names[mode] ?? mode, { section: 'permissions' }));
  }
  const rules = settings.permissions ?? {};
  checks.push(
    check(
      'permissions.rules',
      'Permission rules',
      'info',
      `${plural(rules.allow?.length ?? 0, 'allow rule')} (the built-in ones included), ${plural(rules.ask?.length ?? 0, 'ask rule')}, ${plural(rules.deny?.length ?? 0, 'deny rule')}`,
      { section: 'permissions' },
    ),
  );
  checks.push(
    autoProblem
      ? check('permissions.auto', 'Auto mode', 'info', `Unavailable: ${autoProblem}`, { section: 'auto-mode' })
      : check('permissions.auto', 'Auto mode', 'ok', 'Available', { section: 'auto-mode' }),
  );
  checks.push(
    isSandboxExecAvailable()
      ? check('permissions.sandbox', 'Command sandbox', 'ok', 'Commands run confined to the workspace (sandbox-exec)')
      : check('permissions.sandbox', 'Command sandbox', 'warn', 'Unavailable on this system: commands run without OS-level confinement — the permission rules still apply', {
          fix: 'The sandbox is macOS’s sandbox-exec; elsewhere, keep sessions in Ask or Auto for commands.',
        }),
  );
  return { id: 'permissions', title: 'Permissions', checks };
}

// ── MCP servers ────────────────────────────────────────────────────────

/** Each file's entries as written — read here only for the `${VAR}`s they name, never sent. */
async function rawMcpEntries(place: SettingsPlace): Promise<Record<'user' | 'project', Record<string, unknown>>> {
  const paths = mcpPaths(place, await findStateRoot(place.root));
  const read = async (path: string): Promise<Record<string, unknown>> => {
    try {
      const doc = JSON.parse(await readFile(path, 'utf8')) as { mcpServers?: unknown };
      return typeof doc.mcpServers === 'object' && doc.mcpServers !== null ? (doc.mcpServers as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };
  return { user: await read(paths.user), project: await read(paths.project) };
}

/** The `${VAR}` names in an entry's strings. */
function variablesIn(entry: unknown): string[] {
  const names = new Set<string>();
  const walk = (v: unknown): void => {
    if (typeof v === 'string') for (const m of v.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) names.add(m[1]!);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (typeof v === 'object' && v !== null) Object.values(v).forEach(walk);
  };
  walk(entry);
  return [...names];
}

/** Whether `command` runs from here: a path that's executable, or a name found on `PATH`. */
async function runnable(command: string, path: string | undefined): Promise<boolean> {
  const executable = async (file: string): Promise<boolean> => {
    try {
      await access(file, constants.X_OK);
      return (await stat(file)).isFile();
    } catch {
      return false;
    }
  };
  if (command.includes('/') || isAbsolute(command)) return executable(command);
  for (const dir of (path ?? '').split(delimiter).filter(Boolean)) {
    if (await executable(join(dir, command))) return true;
  }
  return false;
}

async function mcpGroup(place: SettingsPlace, env: DoctorEnvironment, connect: boolean, tilde: (p: string) => string): Promise<DoctorGroup> {
  const view = await mcpView(place);
  const raw = await rawMcpEntries(place);
  const checks: DoctorCheck[] = view.problems.map((p, i) =>
    check(`mcp.problem.${i}`, 'MCP config', 'error', tilde(p), { fix: "Fix the file: until then, sessions don't start its servers.", section: 'mcp' }),
  );
  const servers = view.servers.filter((s) => !s.shadowed);
  if (servers.length === 0 && checks.length === 0) {
    checks.push(check('mcp.none', 'MCP servers', 'info', 'None configured', { section: 'mcp' }));
  }
  const results = await Promise.all(
    servers.map(async (s): Promise<DoctorCheck> => {
      const id = `mcp.${s.scope}.${s.name}`;
      const label = `${s.name} (${s.scope === 'user' ? 'yours' : "the project's"})`;
      const entry = raw[s.scope][s.name] as { command?: unknown; env?: Record<string, unknown> } | undefined;
      const unset = variablesIn(entry).filter((v) => !place.env[v]);
      if (unset.length > 0) {
        return check(id, label, 'warn', `Uses ${unset.map((v) => `\${${v}}`).join(', ')}, ${unset.length === 1 ? "which isn't" : "which aren't"} set`, {
          fix: "Set it in the project's .env or your ~/.agent/.env — it expands to nothing until then.",
          section: 'mcp',
        });
      }
      if (s.transport === 'stdio' && typeof entry?.command === 'string') {
        const pathVar = typeof entry.env?.PATH === 'string' ? entry.env.PATH : process.env.PATH;
        if (!(await runnable(entry.command, pathVar))) {
          return check(id, label, 'error', `Runs “${entry.command}”, which isn't ${entry.command.includes('/') ? 'an executable file' : 'on the PATH'}`, {
            fix: 'Install it, or give its full path in the server’s command.',
            section: 'mcp',
          });
        }
      }
      if (s.auth === 'oauth' && !s.signedIn) {
        return check(id, label, 'warn', `${s.target} — needs signing in`, { fix: 'Sign in from Settings › Connectors.', section: 'mcp' });
      }
      if (!connect) return check(id, label, 'info', `${s.transport} · ${s.target} — not started by this check`, { section: 'mcp' });
      const result = await mcpTest(place, s.scope, s.name, env.mcpConnectTimeoutMs !== undefined ? { connectTimeoutMs: env.mcpConnectTimeoutMs } : {});
      return result.ok
        ? check(id, label, 'ok', `Connected · ${plural(result.tools.length, 'tool')}`, { section: 'mcp' })
        : check(id, label, result.needsAuth ? 'warn' : 'error', result.needsAuth ? 'It needs signing in' : `Couldn't connect: ${result.error}`, {
            fix: result.needsAuth ? 'Sign in from Settings › Connectors.' : 'Edit or check it again in Settings › Connectors.',
            section: 'mcp',
          });
    }),
  );
  return { id: 'mcp', title: 'MCP servers', checks: [...checks, ...results] };
}

// ── Skills, sub-agents, memory ─────────────────────────────────────────

async function extensionsGroup(place: SettingsPlace, settings: Settings, tilde: (p: string) => string): Promise<DoctorGroup> {
  const checks: DoctorCheck[] = [];
  const [skills, agents, memory, providers] = await Promise.all([skillsView(place), agentsView(place), memoryView(place), providersView(place)]);

  const usable = skills.skills.filter((s) => !s.problem && !s.shadowed);
  const by = (scope: string): number => usable.filter((s) => s.scope === scope).length;
  checks.push(check('skills.count', 'Skills', 'ok', `${plural(usable.length, 'skill')}: ${by('project')} the project's, ${by('user')} yours, ${by('builtin')} built in`, { section: 'skills' }));
  for (const s of skills.skills.filter((x) => x.problem)) {
    checks.push(check(`skills.${s.scope}.${s.name}`, `Skill ${s.name}`, 'warn', `Skipped: ${s.problem}`, { fix: 'Edit or delete it in Settings › Skills.', section: 'skills' }));
  }
  // The model is told only as many as fit the list's cap; the rest it finds by asking.
  const { skills: found } = await discoverSkills(place.root, { homeDir: place.home });
  const dropped = new SkillCatalog(found).dropped;
  if (dropped.length > 0) {
    checks.push(
      check('skills.dropped', 'Skills the model is told of', 'warn', `${plural(dropped.length, 'skill')} past the list's size cap: ${dropped.join(', ')}`, {
        fix: 'They still load by name (/name), or when the model lists them; shorter descriptions fit more.',
        section: 'skills',
      }),
    );
  }

  const agentsUsable = agents.agents.filter((a) => !a.problem && !a.shadowed);
  checks.push(check('agents.count', 'Sub-agents', 'ok', `${plural(agentsUsable.length, 'sub-agent')}: ${agentsUsable.map((a) => a.name).join(', ') || 'none'}`, { section: 'agents' }));
  for (const a of agents.agents.filter((x) => x.problem)) {
    checks.push(check(`agents.${a.scope}.${a.name}`, `Sub-agent ${a.name}`, 'warn', `Skipped: ${a.problem}`, { fix: 'Edit or delete it in Settings › Sub-agents.', section: 'agents' }));
  }
  for (const a of agentsUsable.filter((x) => x.model)) {
    const c = await auxiliaryModel(`agents.model.${a.name}`, `Sub-agent ${a.name}'s model`, a.model!, settings, providers);
    if (c.status !== 'ok') checks.push({ ...c, fix: c.fix ?? 'Change its model in Settings › Sub-agents.', section: 'agents' });
  }

  const written = memory.instructions.filter((f) => f.bytes !== undefined);
  checks.push(
    check(
      'memory.instructions',
      'Instruction files',
      'info',
      written.length === 0 ? 'None written: sessions start with no AGENTS.md or CLAUDE.md' : written.map((f) => `${tilde(f.path)} (${Math.ceil(f.bytes! / 1024)} KB)`).join(', '),
      { section: 'memory' },
    ),
  );
  for (const f of written.filter((x) => x.bytes! > LARGE_INSTRUCTIONS)) {
    checks.push(
      check(`memory.large.${f.scope}.${f.name}`, `${f.name} (${f.scope === 'user' ? 'yours' : "the project's"})`, 'warn', `${Math.ceil(f.bytes! / 1024)} KB, given whole to every session`, {
        fix: 'Move what only some tasks need into memories or a skill: those are read when they matter.',
        section: 'memory',
      }),
    );
  }
  for (const m of memory.memories.filter((x) => x.problem)) {
    checks.push(check(`memory.${m.scope}.${m.path}`, `Memory ${m.name}`, 'warn', `Skipped: ${m.problem}`, { fix: 'Edit or delete it in Settings › Memory.', section: 'memory' }));
  }
  return { id: 'extensions', title: 'Skills, sub-agents and memory', checks };
}

// ── This machine ───────────────────────────────────────────────────────

function run(command: string, args: string[], cwd?: string): Promise<string | undefined> {
  return new Promise((resolvePromise) => {
    execFile(command, args, { timeout: 5000, ...(cwd ? { cwd } : {}) }, (err, stdout) => resolvePromise(err ? undefined : String(stdout).trim()));
  });
}

async function environmentGroup(place: SettingsPlace, env: DoctorEnvironment, tilde: (p: string) => string): Promise<DoctorGroup> {
  const checks: DoctorCheck[] = [];
  const [git, inRepo, rg, terminals, picker, editors] = await Promise.all([
    run('git', ['--version']),
    run('git', ['rev-parse', '--is-inside-work-tree'], place.root),
    run('rg', ['--version']),
    env.terminals?.(),
    env.folderPicker?.(),
    env.editors?.(),
  ]);
  checks.push(check('env.marvis', 'Marvis', 'info', `${VERSION} · ${process.platform} ${process.arch}`));
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  const nodeOk = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
  checks.push(
    nodeOk
      ? check('env.node', 'Node.js', 'ok', process.versions.node)
      : check('env.node', 'Node.js', 'error', `${process.versions.node}: Marvis needs ${MIN_NODE.join('.')} or later`, { fix: 'Update Node.js.' }),
  );
  checks.push(
    git
      ? check('env.git', 'git', 'ok', git.replace(/^git version /, ''))
      : check('env.git', 'git', 'error', "Not installed: the Changes panel, commits and worktrees need it", { fix: 'Install git.' }),
  );
  if (git) {
    checks.push(
      inRepo === 'true'
        ? check('env.repo', 'This project', 'ok', `${tilde(place.root)} is a git repository`)
        : check('env.repo', 'This project', 'info', `${tilde(place.root)} isn't a git repository: no Changes panel, and no worktrees for sessions`),
    );
  }
  checks.push(
    rg
      ? check('env.rg', 'ripgrep', 'ok', rg.split('\n')[0]!.replace(/^ripgrep /, ''))
      : check('env.rg', 'ripgrep', 'info', "Not installed: the grep tool searches without it, more slowly", { fix: 'Install ripgrep (rg) for faster searches.' }),
  );
  if (terminals !== undefined) {
    checks.push(
      terminals
        ? check('env.terminal', 'Terminal panel', 'ok', 'Available (node-pty)')
        : check('env.terminal', 'Terminal panel', 'warn', "node-pty couldn't be loaded: the terminal panel is unavailable", { fix: 'Reinstall Marvis so node-pty is built for this Node.js.' }),
    );
  }
  if (picker !== undefined) {
    checks.push(check('env.picker', 'Folder chooser', picker ? 'ok' : 'info', picker ? 'Add project opens the system’s chooser' : 'Not on this machine: Add project takes a typed path'));
  }
  if (editors !== undefined) {
    checks.push(check('env.editors', 'Editors', 'info', editors.length > 0 ? `Files open in ${editors.join(', ')}` : 'None found: files open in the page only'));
  }
  if (env.stateDir) checks.push(check('env.state', 'Sessions kept in', 'info', tilde(env.stateDir)));
  return { id: 'environment', title: 'Marvis and this machine', checks };
}
