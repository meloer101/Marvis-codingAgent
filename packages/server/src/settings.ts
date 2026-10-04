/**
 * What the web's settings page reads and writes, for one workspace: the
 * permission rules in the user's and the project's `.agent/settings.json`,
 * the user's auto-mode rules, the instruction files and memories sessions
 * start with, and the MCP servers they connect to — added, changed, removed
 * and tried, and signed in to with OAuth (docs/web.md, "Settings").
 *
 * Nothing secret goes back: settings are read for their rules alone (a
 * settings file can hold provider keys), and an MCP server is shown as its
 * file has it, `${VAR}`s unexpanded, never its headers or env (to edit one,
 * a literal value is left out, and kept when saved back). Writes go
 * through core's writers, which won't overwrite a file that doesn't parse.
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import {
  AGENT_DIR,
  DEFAULT_ALLOW_RULES,
  DEFAULT_SETTINGS,
  DOTENV_FILE,
  FileOAuthStore,
  MCP_CONFIG_FILE,
  MEMORY_DIR,
  McpConnection,
  ProviderRegistry,
  defaultRulesFor,
  deleteMemoryFile,
  findStateRoot,
  listMemoryFiles,
  loadSettings,
  loginToServer,
  parseDotEnv,
  parseMcpConfig,
  parseMemoryFile,
  parseModelRef,
  parseRule,
  projectSettingsPath,
  providerKeyVars,
  readMemoryFile,
  rebuildMemoryIndex,
  resolveProjectMemoryDir,
  safeResolve,
  setDotEnvVar,
  userDotEnvPath,
  userSettingsPath,
  validateScopeType,
  writeMemoryFile,
  writeProjectSettings,
  writeUserSettings,
} from '@harness-code/core';
import type { McpHttpServerConfig, McpServerConfig, Settings } from '@harness-code/core';
import { AUTO_MODE_GROUPS } from '@harness-code/protocol';
import type {
  AutoModeGroup,
  InstructionFileInfo,
  McpServerEntry,
  McpServerInfo,
  McpTestResult,
  McpView,
  MemoryFileInfo,
  MemoryTarget,
  MemoryView,
  PermissionRuleList,
  PermissionRules,
  ProviderInfo,
  ProvidersView,
  SettingsView,
} from '@harness-code/protocol';

import { ConflictError, InvalidRequestError } from './host.js';

/** Where a workspace's settings are, and what its MCP `${VAR}`s expand from. */
export interface SettingsPlace {
  /** The workspace's root. */
  root: string;
  /** Its project root: where its instruction files are. */
  projectRoot: string;
  home: string;
  env: NodeJS.ProcessEnv;
}

type Json = Record<string, unknown>;

/** A JSON file's object, `{}` when there is no file, or why it couldn't be read. */
async function readJsonFile(path: string): Promise<{ value: Json } | { problem: string }> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { value: {} };
    return { problem: `${path}: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (text.trim() === '') return { value: {} };
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { problem: `${path}: not a JSON object` };
    }
    return { value: value as Json };
  } catch (err) {
    return { problem: `${path}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function rulesOf(settings: Json): PermissionRules {
  const p = (settings.permissions ?? {}) as Json;
  return { allow: strings(p.allow), ask: strings(p.ask), deny: strings(p.deny) };
}

export async function settingsView(place: SettingsPlace, autoModeUnavailable?: string): Promise<SettingsView> {
  const userPath = userSettingsPath(place.home);
  const projectPath = await projectSettingsPath(place.root);
  const [user, project] = await Promise.all([readJsonFile(userPath), readJsonFile(projectPath)]);
  const problems: string[] = [];
  const userSettings = 'value' in user ? user.value : (problems.push(user.problem), {});
  const projectSettings = 'value' in project ? project.value : (problems.push(project.problem), {});
  const autoMode = (userSettings.autoMode ?? {}) as Json;
  const rules: Partial<Record<AutoModeGroup, string[]>> = {};
  for (const group of AUTO_MODE_GROUPS) if (Array.isArray(autoMode[group])) rules[group] = strings(autoMode[group]);
  return {
    user: { path: userPath, rules: rulesOf(userSettings) },
    project: { path: projectPath, rules: rulesOf(projectSettings) },
    builtinAllow: [...DEFAULT_ALLOW_RULES],
    backgroundProcesses: {
      user: userSettings.backgroundProcesses === true,
      project: projectSettings.backgroundProcesses === true,
    },
    autoMode: {
      ...(autoModeUnavailable ? { unavailable: autoModeUnavailable } : {}),
      rules,
      builtin: Object.fromEntries(AUTO_MODE_GROUPS.map((g) => [g, [...defaultRulesFor(g)]])) as Record<
        AutoModeGroup,
        string[]
      >,
    },
    problems,
  };
}

/** Replace one rule list in the user's or the project's settings; every rule must parse. */
export async function setRules(
  place: SettingsPlace,
  scope: 'user' | 'project',
  list: PermissionRuleList,
  rules: string[],
): Promise<void> {
  const clean = [...new Set(rules.map((r) => r.trim()))];
  for (const rule of clean) {
    try {
      parseRule(rule);
    } catch (err) {
      throw new InvalidRequestError(err instanceof Error ? err.message : String(err));
    }
  }
  const patch = { permissions: { [list]: clean } };
  await written(() =>
    scope === 'user' ? writeUserSettings(patch, { homeDir: place.home }) : writeProjectSettings(place.root, patch),
  );
}

/** Replace one auto-mode group in the user's settings; `null` drops it, back to the built-in rules. */
export async function setAutoModeGroup(place: SettingsPlace, group: AutoModeGroup, rules: string[] | null): Promise<void> {
  const clean = rules === null ? undefined : [...new Set(rules.map((r) => r.trim()).filter(Boolean))];
  await written(() => writeUserSettings({ autoMode: { [group]: clean } }, { homeDir: place.home }));
}

/** Background commands on (`true`) or off (the key dropped) in the user's settings. */
export async function setBackgroundProcesses(place: SettingsPlace, enabled: boolean): Promise<void> {
  await written(() => writeUserSettings({ backgroundProcesses: enabled ? true : undefined }, { homeDir: place.home }));
}

/** A settings file that doesn't parse is the user's to fix: say so, as a bad request. */
async function written(write: () => Promise<unknown>): Promise<void> {
  try {
    await write();
  } catch (err) {
    if (err instanceof Error && /not valid JSON/.test(err.message)) throw new InvalidRequestError(err.message);
    throw err;
  }
}

// ── Models: providers and their keys ──────────────────────────────────

/** The settings sessions of `place` run with, both files layered; the built-in ones when a file doesn't parse. */
async function layeredSettings(place: SettingsPlace): Promise<Settings> {
  try {
    return (await loadSettings(place.root, { homeDir: place.home })).settings;
  } catch {
    return DEFAULT_SETTINGS; // the caller's `problems` say which file
  }
}

/**
 * Which of the environments `place.env` has `variable` from. It is filled from
 * the real one, then the project's `.env`, then the user's (`projectEnv`), so a
 * value neither file gives came from the first.
 */
async function envLayerOf(place: SettingsPlace, variable: string): Promise<'environment' | 'project' | 'user'> {
  const value = place.env[variable];
  const inFile = async (path: string): Promise<boolean> =>
    parseDotEnv(await readFile(path, 'utf8').catch(() => ''))[variable] === value;
  if (await inFile(join(place.root, DOTENV_FILE))) return 'project';
  return (await inFile(userDotEnvPath(place.home))) ? 'user' : 'environment';
}

/** The providers sessions of `place` can use and where each one's key comes from — never the key. */
export async function providersView(place: SettingsPlace): Promise<ProvidersView> {
  const userPath = userSettingsPath(place.home);
  const projectPath = await projectSettingsPath(place.root);
  const [user, project] = await Promise.all([readJsonFile(userPath), readJsonFile(projectPath)]);
  const problems = [user, project].flatMap((file) => ('problem' in file ? [file.problem] : []));
  const settings = await layeredSettings(place);
  const registry = new ProviderRegistry({ settings, env: place.env });

  const providers: ProviderInfo[] = [];
  for (const id of registry.list()) {
    let cfg: ReturnType<ProviderRegistry['config']>;
    try {
      cfg = registry.config(id);
    } catch {
      continue; // named in settings without a base URL: not usable, so not offered
    }
    const takesKey = cfg.requiresKey === true || (cfg.apiKeyEnv?.length ?? 0) > 0;
    const origin = registry.keyOrigin(id);
    providers.push({
      id,
      label: cfg.label,
      baseUrl: cfg.baseUrl,
      requiresKey: cfg.requiresKey === true,
      ...(takesKey ? { keyVar: cfg.apiKeyEnv?.[0] ?? providerKeyVars(id, cfg)[0]! } : {}),
      ...(origin === undefined
        ? {}
        : 'settings' in origin
          ? { keySource: 'settings' as const }
          : { keySource: await envLayerOf(place, origin.variable), keySourceVar: origin.variable }),
    });
  }
  const modelOf = (file: typeof user): boolean =>
    'value' in file && typeof file.value.model === 'string' && file.value.model.trim() !== '';
  return {
    providers,
    envPath: userDotEnvPath(place.home),
    model: settings.model ?? '',
    ...(modelOf(project) ? { modelSource: 'project' as const } : modelOf(user) ? { modelSource: 'user' as const } : {}),
    settingsPath: userPath,
    problems,
  };
}

/**
 * Save `providerId`'s key in the user's `~/.agent/.env`, for every project —
 * or remove it from there (`null`). An environment that already has the key
 * (the real one, the project's `.env`) still wins: the view says which is used.
 */
export async function setProviderKey(place: SettingsPlace, providerId: string, key: string | null): Promise<void> {
  const provider = (await providersView(place)).providers.find((p) => p.id === providerId);
  if (!provider) throw new InvalidRequestError(`there is no provider "${providerId}"`);
  if (!provider.keyVar) throw new InvalidRequestError(`${provider.label} takes no API key`);
  await setDotEnvVar(userDotEnvPath(place.home), provider.keyVar, key ?? undefined);
}

/** Set the model new sessions start on in the user's settings; an empty one goes back to the built-in default. */
export async function setDefaultModel(place: SettingsPlace, model: string): Promise<void> {
  let ref: string | undefined;
  if (model.trim() !== '') {
    const settings = await layeredSettings(place);
    try {
      const parsed = parseModelRef(model.trim(), settings.defaultProvider ?? 'openai');
      new ProviderRegistry({ settings, env: place.env }).config(parsed.provider);
      ref = `${parsed.provider}/${parsed.model}`;
    } catch (err) {
      throw new InvalidRequestError(err instanceof Error ? err.message : String(err));
    }
  }
  await written(() => writeUserSettings({ model: ref }, { homeDir: place.home }));
}

// ── Memory ────────────────────────────────────────────────────────────

const INSTRUCTION_NAMES = ['AGENTS.md', 'CLAUDE.md'] as const;

async function memoryDirs(place: SettingsPlace): Promise<{ global: string; project: string }> {
  return {
    global: join(place.home, AGENT_DIR, MEMORY_DIR),
    project: await resolveProjectMemoryDir(place.root, place.home),
  };
}

function instructionsDir(place: SettingsPlace, scope: 'user' | 'project'): string {
  return scope === 'user' ? join(place.home, AGENT_DIR) : place.projectRoot;
}

async function sizeOf(path: string): Promise<number | undefined> {
  try {
    const s = await stat(path);
    return s.isFile() ? s.size : undefined;
  } catch {
    return undefined;
  }
}

export async function memoryView(place: SettingsPlace): Promise<MemoryView> {
  const dirs = await memoryDirs(place);
  const instructions: InstructionFileInfo[] = [];
  for (const scope of ['user', 'project'] as const) {
    const dir = instructionsDir(place, scope);
    const found: InstructionFileInfo[] = [];
    for (const name of INSTRUCTION_NAMES) {
      const path = join(dir, name);
      const bytes = await sizeOf(path);
      if (bytes !== undefined) found.push({ scope, name, path, bytes });
    }
    instructions.push(...(found.length > 0 ? found : [{ scope, name: 'AGENTS.md' as const, path: join(dir, 'AGENTS.md') }]));
  }
  const memories: MemoryFileInfo[] = [];
  for (const scope of ['project', 'global'] as const) {
    const dir = dirs[scope];
    for (const path of await listMemoryFiles(dir)) {
      const raw = await readMemoryFile(dir, path);
      if (raw === undefined) continue;
      const bytes = Buffer.byteLength(raw, 'utf8');
      const parsed = parseMemoryFile(raw, path);
      if (parsed.ok) {
        const { name, description, type } = parsed.entry;
        const problem = validateScopeType(scope, type);
        memories.push({ scope, path, name, description, type, bytes, ...(problem ? { problem } : {}) });
      } else {
        const [type = '', file = path] = path.split('/');
        memories.push({ scope, path, name: file.replace(/\.md$/, ''), description: '', type, bytes, problem: parsed.reason });
      }
    }
  }
  return { instructions, memories, dirs };
}

async function memoryFile(place: SettingsPlace, target: MemoryTarget): Promise<string> {
  if (target.kind === 'instructions') return join(instructionsDir(place, target.scope), target.name);
  const dir = (await memoryDirs(place))[target.scope];
  try {
    return safeResolve(dir, target.path);
  } catch (err) {
    throw new InvalidRequestError(err instanceof Error ? err.message : String(err));
  }
}

export async function readMemory(place: SettingsPlace, target: MemoryTarget): Promise<string> {
  try {
    return await readFile(await memoryFile(place, target), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

/** Write an instructions file, or a memory that parses as one — then the store's `MEMORY.md` again. */
export async function writeMemory(place: SettingsPlace, target: MemoryTarget, text: string): Promise<void> {
  if (target.kind === 'instructions') {
    const path = await memoryFile(place, target);
    await mkdir(resolve(path, '..'), { recursive: true });
    await writeFile(path, text.endsWith('\n') || text === '' ? text : `${text}\n`, 'utf8');
    return;
  }
  const parsed = parseMemoryFile(text, target.path);
  if (!parsed.ok) throw new InvalidRequestError(parsed.reason);
  const scopeProblem = validateScopeType(target.scope, parsed.entry.type);
  if (scopeProblem) throw new InvalidRequestError(scopeProblem);
  const dir = (await memoryDirs(place))[target.scope];
  try {
    await writeMemoryFile(dir, parsed.entry.path, parsed.entry);
  } catch (err) {
    throw new InvalidRequestError(err instanceof Error ? err.message : String(err));
  }
  await rebuildMemoryIndex(dir);
}

export async function deleteMemory(place: SettingsPlace, target: MemoryTarget): Promise<void> {
  if (target.kind === 'instructions') throw new InvalidRequestError('instruction files are edited, not deleted here');
  const dir = (await memoryDirs(place))[target.scope];
  await deleteMemoryFile(dir, (await memoryFile(place, target)).slice(dir.length + 1));
  await rebuildMemoryIndex(dir);
}

// ── MCP ───────────────────────────────────────────────────────────────

function mcpPaths(place: SettingsPlace, stateRoot: string | undefined): { user: string; project: string } {
  return {
    user: join(place.home, AGENT_DIR, MCP_CONFIG_FILE),
    project: join(stateRoot ?? resolve(place.root), MCP_CONFIG_FILE),
  };
}

/** Where OAuth tokens are kept: the same place sessions look (`mcpAuthRoot`). */
function authRoot(place: SettingsPlace): string {
  return join(place.home, AGENT_DIR, 'mcp-auth');
}

interface McpEntry {
  info: Omit<McpServerInfo, 'auth' | 'signedIn' | 'shadowed'>;
  config: McpServerConfig | undefined;
}

/** Each config file's servers: as written, for display, and parsed with the workspace's environment, for use. */
async function mcpEntries(place: SettingsPlace): Promise<{ entries: McpEntry[]; problems: string[]; paths: { user: string; project: string } }> {
  const paths = mcpPaths(place, await findStateRoot(place.root));
  const entries: McpEntry[] = [];
  const problems: string[] = [];
  for (const scope of ['user', 'project'] as const) {
    const path = paths[scope];
    const read = await readJsonFile(path);
    if (!('value' in read)) {
      problems.push(read.problem);
      continue;
    }
    const servers = read.value.mcpServers;
    if (servers === undefined) continue;
    let configs: McpServerConfig[] = [];
    try {
      configs = parseMcpConfig(JSON.stringify(read.value), path, { env: place.env, cwd: place.root });
    } catch (err) {
      problems.push(err instanceof Error ? err.message : String(err));
    }
    if (typeof servers !== 'object' || servers === null) continue;
    for (const [name, raw] of Object.entries(servers as Json)) {
      const entry = (typeof raw === 'object' && raw !== null ? raw : {}) as Json;
      const config = configs.find((c) => c.name === name);
      const target =
        typeof entry.url === 'string'
          ? entry.url
          : [typeof entry.command === 'string' ? entry.command : '', ...strings(entry.args)].join(' ').trim();
      entries.push({
        info: { name, scope, transport: config?.transport ?? (typeof entry.url === 'string' ? 'http' : 'stdio'), target },
        config,
      });
    }
  }
  return { entries, problems, paths };
}

function authOf(config: McpServerConfig | undefined): McpServerInfo['auth'] {
  if (!config || config.transport === 'stdio') return 'none';
  const header = Object.keys(config.headers).some((h) => h.toLowerCase() === 'authorization');
  if (config.auth === 'oauth') return 'oauth';
  if (config.auth === 'none') return header ? 'header' : 'none';
  return header ? 'header' : 'oauth';
}

export async function mcpView(place: SettingsPlace): Promise<McpView> {
  const { entries, problems, paths } = await mcpEntries(place);
  const projectNames = new Set(entries.filter((e) => e.info.scope === 'project').map((e) => e.info.name));
  const servers: McpServerInfo[] = [];
  for (const { info, config } of entries) {
    const auth = authOf(config);
    const signedIn =
      auth === 'oauth' && config && config.transport !== 'stdio'
        ? (await new FileOAuthStore(config.url, authRoot(place)).tokens()) !== undefined
        : undefined;
    servers.push({
      ...info,
      auth,
      ...(signedIn !== undefined ? { signedIn } : {}),
      ...(info.scope === 'user' && projectNames.has(info.name) ? { shadowed: true } : {}),
    });
  }
  return { servers, userPath: paths.user, projectPath: paths.project, problems };
}

/** The server sessions use by that name — the project's over the user's — when it signs in with OAuth. */
async function oauthServer(place: SettingsPlace, name: string): Promise<McpHttpServerConfig> {
  const { entries } = await mcpEntries(place);
  const entry = entries.filter((e) => e.info.name === name).at(-1);
  if (!entry?.config) throw new InvalidRequestError(`no usable MCP server "${name}"`);
  if (entry.config.transport === 'stdio' || authOf(entry.config) !== 'oauth') {
    throw new InvalidRequestError(`MCP server "${name}" doesn't sign in with OAuth`);
  }
  return entry.config;
}

/**
 * Sign in to an OAuth MCP server. Settles as soon as there's a page to
 * authorize at (`{url}`; `done` reports how it ends), or once it's known the
 * tokens it has still work.
 */
export async function mcpLogin(
  place: SettingsPlace,
  name: string,
  done: (error?: string) => void,
): Promise<{ url: string } | { status: 'authorized' | 'already-authorized' }> {
  const config = await oauthServer(place, name);
  return new Promise((resolvePromise, reject) => {
    let waiting = false;
    loginToServer(config, {
      storeRoot: authRoot(place),
      returnTo: 'Marvis',
      log: () => {},
      onAuthorize: (url) => {
        waiting = true;
        resolvePromise({ url: url.toString() });
      },
    }).then(
      (result) => (waiting ? done() : resolvePromise({ status: result.status })),
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        if (waiting) done(message);
        else reject(new InvalidRequestError(message));
      },
    );
  });
}

export async function mcpLogout(place: SettingsPlace, name: string): Promise<void> {
  const config = await oauthServer(place, name);
  await new FileOAuthStore(config.url, authRoot(place)).clear();
}

/** What an entry says of itself, beside which the rest of it is kept as it is. */
const ENTRY_KEYS = ['type', 'command', 'args', 'env', 'url', 'headers', 'auth'];

/** An env or header value, shown only when the secret it carries is in a `${VAR}` — `null` for a literal. */
function shownValues(value: unknown): Record<string, string | null> | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const out: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(value as Json)) {
    if (typeof v === 'string') out[k] = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(v) ? v : null;
  }
  return out;
}

/** One scope's `.mcp.json`: where it is, and its object — `bad_request` when it doesn't parse, so it's never written over. */
async function mcpFile(place: SettingsPlace, scope: 'user' | 'project'): Promise<{ path: string; doc: Json; servers: Json }> {
  const path = mcpPaths(place, await findStateRoot(place.root))[scope];
  const read = await readJsonFile(path);
  if (!('value' in read)) throw new InvalidRequestError(read.problem);
  const servers = read.value.mcpServers ?? {};
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) {
    throw new InvalidRequestError(`${path}: "mcpServers" must be an object`);
  }
  return { path, doc: read.value, servers: servers as Json };
}

function entryIn(servers: Json, name: string, path: string): Json {
  const entry = Object.hasOwn(servers, name) ? servers[name] : undefined;
  if (typeof entry !== 'object' || entry === null) throw new InvalidRequestError(`${path} has no MCP server "${name}"`);
  return entry as Json;
}

/** An MCP server's entry in the user's or the project's file, to edit — literal env and header values left out. */
export async function mcpGet(place: SettingsPlace, scope: 'user' | 'project', name: string): Promise<McpServerEntry> {
  const { path, servers } = await mcpFile(place, scope);
  const entry = entryIn(servers, name, path);
  let transport: McpServerEntry['transport'] = typeof entry.url === 'string' ? 'http' : 'stdio';
  try {
    transport = parseMcpConfig(JSON.stringify({ mcpServers: { [name]: entry } }), path, { env: place.env }).at(0)?.transport ?? transport;
  } catch {
    // As much of it as can be shown: saving it again says what's wrong.
  }
  const env = shownValues(entry.env);
  const headers = shownValues(entry.headers);
  return {
    name,
    transport,
    ...(typeof entry.command === 'string' ? { command: entry.command } : {}),
    ...(Array.isArray(entry.args) ? { args: strings(entry.args) } : {}),
    ...(env ? { env } : {}),
    ...(typeof entry.url === 'string' ? { url: entry.url } : {}),
    ...(headers ? { headers } : {}),
    ...(entry.auth === 'oauth' || entry.auth === 'none' ? { auth: entry.auth } : {}),
  };
}

/** The values to write: each given one, or — `null` — the one the file has. */
function valuesToWrite(given: Record<string, string | null> | undefined, old: unknown, what: string): Record<string, string> {
  const kept = (typeof old === 'object' && old !== null ? old : {}) as Json;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(given ?? {})) {
    if (v !== null) out[k] = v;
    else if (typeof kept[k] === 'string') out[k] = kept[k];
    else throw new InvalidRequestError(`there's no ${what} "${k}" to keep: give it a value`);
  }
  return out;
}

async function writeMcpFile(path: string, scope: 'user' | 'project', doc: Json): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // Yours can hold tokens: made readable by you alone. The project's is for committing.
  await writeFile(path, `${JSON.stringify(doc, null, 2)}\n`, { encoding: 'utf8', ...(scope === 'user' ? { mode: 0o600 } : {}) });
}

/**
 * Add an MCP server to the user's or the project's `.mcp.json`, or — with
 * `previousName` — change that one, keeping what its entry has beyond what
 * an entry says and, for a `null` env or header value, the value it had.
 */
export async function mcpSave(
  place: SettingsPlace,
  scope: 'user' | 'project',
  server: McpServerEntry,
  previousName?: string,
): Promise<void> {
  const { path, doc, servers } = await mcpFile(place, scope);
  const old = previousName !== undefined ? entryIn(servers, previousName, path) : {};
  if (server.name !== previousName && Object.hasOwn(servers, server.name)) {
    throw new ConflictError(`${path} has an MCP server named "${server.name}" already`);
  }
  const next: Json = { type: server.transport };
  if (server.transport === 'stdio') {
    const command = server.command?.trim() ?? '';
    if (command === '') throw new InvalidRequestError('a stdio server needs the command it runs');
    next.command = command;
    if (server.args && server.args.length > 0) next.args = server.args;
    const env = valuesToWrite(server.env, old.env, 'variable');
    if (Object.keys(env).length > 0) next.env = env;
  } else {
    const url = server.url?.trim() ?? '';
    if (!/^(?:https?:\/\/|\$\{)/i.test(url)) throw new InvalidRequestError(`not an http(s) URL: "${url}"`);
    next.url = url;
    const headers = valuesToWrite(server.headers, old.headers, 'header');
    if (Object.keys(headers).length > 0) next.headers = headers;
    if (server.auth) next.auth = server.auth;
  }
  for (const [k, v] of Object.entries(old)) if (!ENTRY_KEYS.includes(k)) next[k] = v;

  // In its place, when it was there: a file's order is its writer's.
  const entries = Object.entries(servers);
  const at = previousName !== undefined ? entries.findIndex(([k]) => k === previousName) : -1;
  if (at >= 0) entries[at] = [server.name, next];
  else entries.push([server.name, next]);
  const updated: Json = { ...doc, mcpServers: Object.fromEntries(entries) };
  try {
    parseMcpConfig(JSON.stringify(updated), path, { env: place.env, cwd: place.root });
  } catch (err) {
    throw new InvalidRequestError(err instanceof Error ? err.message : String(err));
  }
  await writeMcpFile(path, scope, updated);
}

/** Take an MCP server out of its file (its stored sign-in stays: another entry may share its URL). */
export async function mcpRemove(place: SettingsPlace, scope: 'user' | 'project', name: string): Promise<void> {
  const { path, doc, servers } = await mcpFile(place, scope);
  entryIn(servers, name, path);
  const { [name]: _, ...rest } = servers;
  await writeMcpFile(path, scope, { ...doc, mcpServers: rest });
}

/** Connect to one file's MCP server as a session would, with the workspace's environment; list its tools; let it go. */
export async function mcpTest(
  place: SettingsPlace,
  scope: 'user' | 'project',
  name: string,
  opts: { connectTimeoutMs?: number } = {},
): Promise<McpTestResult> {
  const { entries, problems } = await mcpEntries(place);
  const entry = entries.find((e) => e.info.scope === scope && e.info.name === name);
  if (!entry) throw new InvalidRequestError(`no MCP server "${name}" in ${scope === 'user' ? 'your' : "the project's"} ${MCP_CONFIG_FILE}`);
  if (!entry.config) return { ok: false, error: problems.join('; ') || `MCP server "${name}" doesn't parse` };
  const connection = new McpConnection(entry.config, { connectTimeoutMs: opts.connectTimeoutMs ?? 30_000 });
  try {
    const tools = await connection.listTools();
    if (connection.state !== 'ready') {
      return connection.needsAuth
        ? { ok: false, error: 'it needs signing in', needsAuth: true }
        : { ok: false, error: connection.error ?? "it couldn't be reached" };
    }
    return { ok: true, tools: tools.map((t) => ({ name: t.name, ...(t.description ? { description: t.description } : {}) })) };
  } finally {
    await connection.close();
  }
}
