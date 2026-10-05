/**
 * What a directory would bring as a workspace, for the "add project" dialog —
 * read from disk, nothing started: whether it can be one, where its sessions
 * would live, and what trusting it means. A project's `.mcp.json` runs its
 * commands as soon as a session starts, and its settings can switch off
 * approvals or point a provider (and the key sent with it) at another host.
 *
 * Also directory completion for the path field.
 */

import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';

import { AGENT_DIR, MCP_CONFIG_FILE, SETTINGS_FILE, findMarkedProjectRoot, parseMcpConfig } from '@harness-code/core';
import type { DirSuggestion, WorkspaceInspection } from '@harness-code/protocol';

/** `~` and `~/…` → the home directory. */
export function expandHome(path: string, home: string = homedir()): string {
  if (path === '~') return home;
  if (path.startsWith('~/')) return join(home, path.slice(2));
  return path;
}

/** The facts about `path` that don't depend on which workspaces exist. */
export async function inspectDirectory(
  path: string,
  opts: { home?: string } = {},
): Promise<Omit<WorkspaceInspection, 'workspace'>> {
  const home = opts.home ?? homedir();
  const abs = resolve(expandHome(path.trim(), home));
  const base = { path: abs, exists: false, isDirectory: false, git: false, needsMarker: false, mcpServers: [], warnings: [] };

  let root: string;
  try {
    const st = await stat(abs);
    if (!st.isDirectory()) return { ...base, exists: true, problem: 'Not a directory' };
    root = await realpath(abs);
  } catch {
    return { ...base, problem: 'No such directory' };
  }
  const found = { ...base, exists: true, isDirectory: true, root };
  const realHome = await realpath(home).catch(() => resolve(home));
  if (root === sep || root === dirname(root)) return { ...found, problem: 'The filesystem root is too broad for a project' };
  if (root === realHome) {
    return { ...found, problem: 'Your home directory is too broad for a project: pick a folder inside it' };
  }

  // A directory with no `.git`/`.agent` of its own under a home that is a
  // repository would be taken for part of a project rooted at home, and share
  // its state dir with every other such directory: it gets its own `.agent/`.
  // (`~/.agent` alone no longer marks home: `findMarkedProjectRoot`.)
  const marked = await findMarkedProjectRoot(root);
  const needsMarker = marked === realHome;
  const projectRoot = needsMarker || marked === undefined ? root : marked;
  const git = !needsMarker && marked !== undefined && (await isDirectory(join(marked, '.git')));

  const warnings: string[] = [];
  const mcpServers = await projectMcpServers(projectRoot, warnings);
  await settingsWarnings(projectRoot, warnings);

  return { ...found, projectRoot, git, needsMarker, mcpServers, warnings };
}

/** The project's own `.mcp.json` servers: names and what they run — `${VAR}`s left blank, so no secret travels. */
async function projectMcpServers(projectRoot: string, warnings: string[]): Promise<WorkspaceInspection['mcpServers']> {
  const path = join(projectRoot, MCP_CONFIG_FILE);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  try {
    return parseMcpConfig(raw, path, { env: {} }).map((s) =>
      s.transport === 'stdio'
        ? { name: s.name, transport: s.transport, command: [s.command, ...s.args].join(' ') }
        : { name: s.name, transport: s.transport, url: s.url },
    );
  } catch (err) {
    warnings.push(`Its ${MCP_CONFIG_FILE} can't be read: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/** Project settings that change what trusting it means. */
async function settingsWarnings(projectRoot: string, warnings: string[]): Promise<void> {
  let settings: {
    permissions?: { mode?: unknown; allow?: unknown };
    providers?: Record<string, { baseUrl?: unknown }>;
  };
  try {
    settings = JSON.parse(await readFile(join(projectRoot, AGENT_DIR, SETTINGS_FILE), 'utf8')) as typeof settings;
  } catch {
    return;
  }
  if (settings.permissions?.mode === 'yolo') {
    warnings.push('Its settings start sessions in YOLO mode: nothing asks before running.');
  }
  const allow = settings.permissions?.allow;
  if (Array.isArray(allow) && allow.length > 0) {
    warnings.push(`Its settings pre-approve ${allow.length} kind${allow.length === 1 ? '' : 's'} of tool call.`);
  }
  for (const [id, provider] of Object.entries(settings.providers ?? {})) {
    if (typeof provider?.baseUrl === 'string') {
      warnings.push(`Its settings send ${id} requests, with your ${id} key, to ${provider.baseUrl}.`);
    }
  }
}

/**
 * Directories completing `prefix` (`~` allowed): the children of its directory
 * part whose names start with its last segment, hidden ones only when asked
 * for with a leading dot. Git repositories are marked.
 */
export async function suggestDirs(
  prefix: string,
  opts: { home?: string; limit?: number } = {},
): Promise<DirSuggestion[]> {
  const home = opts.home ?? homedir();
  const limit = opts.limit ?? 20;
  const text = prefix.trim() === '' ? '~/' : prefix.trim();
  const expanded = expandHome(text, home);
  // Decided on the text as typed: expanding `~/` loses its trailing slash.
  const endsWithSlash = text.endsWith('/');
  const dir = resolve(endsWithSlash ? expanded : dirname(expanded));
  const partial = endsWithSlash ? '' : basename(expanded);

  let names: string[];
  try {
    names = (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => e.name);
  } catch {
    return [];
  }
  const wantHidden = partial.startsWith('.');
  const lower = partial.toLowerCase();
  const matches = names
    .filter((n) => (wantHidden || !n.startsWith('.')) && n.toLowerCase().startsWith(lower))
    .sort((a, b) => a.localeCompare(b));

  const out: DirSuggestion[] = [];
  for (const name of matches) {
    const path = join(dir, name);
    if (!(await isDirectory(path))) continue; // a symlink to a file
    out.push({ path, label: tildify(path, home), git: await isDirectory(join(path, '.git')) });
    if (out.length >= limit) break;
  }
  return out;
}

function tildify(path: string, home: string): string {
  return path === home ? '~' : path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
