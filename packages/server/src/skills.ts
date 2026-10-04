/**
 * The skills sessions in a workspace load, for the settings page: listed as
 * discovery finds them — the project's `.agent/skills/`, then yours in
 * `~/.agent/skills/`, then the ones Marvis ships with, a name used where it
 * is first found — with the folders it skips and why; a SKILL.md read and
 * written, a skill deleted, and skills copied in from a folder on this
 * machine or a Git repository.
 *
 * Writes go only to the project's and yours: the built-in ones are read.
 */

import { execFile } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { AGENT_DIR, builtinSkillsDir, parseSkill, skillNameOf } from '@harness-code/core';
import type { SkillEntryInfo, SkillScope, SkillsImportResult, SkillsView } from '@harness-code/protocol';

import { ConflictError, InvalidRequestError } from './host.js';
import type { SettingsPlace } from './settings.js';

const SKILL_FILE = 'SKILL.md';
/** How far below an imported folder skills are looked for (`skills/<name>/` is two). */
const IMPORT_DEPTH = 3;
/** Folders looked into at most, for one import: a home directory picked by mistake ends soon. */
const IMPORT_VISITS = 2000;
const CLONE_TIMEOUT_MS = 120_000;

export function skillDirs(place: Pick<SettingsPlace, 'projectRoot' | 'home'>): Record<SkillScope, string> {
  return {
    project: join(place.projectRoot, AGENT_DIR, 'skills'),
    user: join(place.home, AGENT_DIR, 'skills'),
    builtin: builtinSkillsDir().replace(/[/\\]$/, ''),
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

export async function skillsView(place: Pick<SettingsPlace, 'projectRoot' | 'home'>): Promise<SkillsView> {
  const dirs = skillDirs(place);
  const used = new Set<string>();
  const skills: SkillEntryInfo[] = [];
  for (const scope of ['project', 'user', 'builtin'] as const) {
    let names: string[];
    try {
      names = (await readdir(dirs[scope], { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
    } catch {
      continue; // no skills there: the usual case
    }
    for (const name of names) {
      const dir = join(dirs[scope], name);
      const raw = await readOptional(join(dir, SKILL_FILE));
      if (raw === undefined) continue; // a folder without a SKILL.md is not a skill
      const parsed = parseSkill({ raw, dirName: name, dir, source: scope });
      if (parsed.ok) {
        skills.push({ name, description: parsed.skill.description, scope, dir, ...(used.has(name) ? { shadowed: true } : {}) });
        used.add(name);
      } else {
        skills.push({ name, description: '', scope, dir, problem: parsed.reason });
      }
    }
  }
  return { skills, dirs };
}

function skillDir(place: Pick<SettingsPlace, 'projectRoot' | 'home'>, scope: SkillScope, name: string): string {
  // The method's schema keeps `name` one path segment; this is the belt to those braces.
  if (name === '' || name === '.' || name === '..' || /[/\\\0]/.test(name)) throw new InvalidRequestError(`not a skill folder: "${name}"`);
  return join(skillDirs(place)[scope], name);
}

export async function readSkill(place: Pick<SettingsPlace, 'projectRoot' | 'home'>, scope: SkillScope, name: string): Promise<string> {
  const text = await readOptional(join(skillDir(place, scope, name), SKILL_FILE));
  if (text === undefined) throw new InvalidRequestError(`no skill "${name}" in ${skillDirs(place)[scope]}`);
  return text;
}

/** Write a skill's SKILL.md, its folder made if missing; it must parse as a skill named for its folder. */
export async function writeSkill(
  place: Pick<SettingsPlace, 'projectRoot' | 'home'>,
  scope: 'user' | 'project',
  name: string,
  text: string,
  opts: { create?: boolean } = {},
): Promise<void> {
  const dir = skillDir(place, scope, name);
  const parsed = parseSkill({ raw: text, dirName: name, dir, source: scope });
  if (!parsed.ok) throw new InvalidRequestError(parsed.reason);
  if (opts.create && (await exists(dir))) throw new ConflictError(`there's a skill "${name}" in ${dirname(dir)} already`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, SKILL_FILE), text.endsWith('\n') ? text : `${text}\n`, 'utf8');
}

/** Delete a skill's folder and everything in it (a link to one: the link). */
export async function deleteSkill(place: Pick<SettingsPlace, 'projectRoot' | 'home'>, scope: 'user' | 'project', name: string): Promise<void> {
  const dir = skillDir(place, scope, name);
  if (!(await exists(dir))) throw new InvalidRequestError(`no skill "${name}" in ${dirname(dir)}`);
  await rm(dir, { recursive: true, force: true });
}

/** The folders at or below `root` with a SKILL.md — not looking inside one, nor in `.git`, `node_modules` or any hidden folder. */
async function skillFolders(root: string): Promise<string[]> {
  const found: string[] = [];
  let visits = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (++visits > IMPORT_VISITS) return;
    if ((await readOptional(join(dir, SKILL_FILE))) !== undefined) {
      found.push(dir);
      return;
    }
    if (depth >= IMPORT_DEPTH) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.filter((x) => x.isDirectory() && !x.name.startsWith('.') && x.name !== 'node_modules').sort((a, b) => a.name.localeCompare(b.name))) {
      await walk(join(dir, e.name), depth + 1);
    }
  };
  await walk(root, 0);
  return found;
}

/** What to clone for an https Git URL, and the folder in it a GitHub `/tree/<branch>/<path>` (or `/blob/…/SKILL.md`) URL names. */
export function gitSource(source: string): { url: string; ref?: string; path?: string; repo: string } {
  let parsed: URL;
  try {
    parsed = new URL(source);
  } catch {
    throw new InvalidRequestError(`not a URL: "${source}"`);
  }
  if (parsed.protocol !== 'https:') throw new InvalidRequestError('a Git URL here starts with https://');
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parsed.hostname === 'github.com' && parts.length >= 2) {
    const [owner, repoPart] = parts as [string, string];
    const repo = repoPart.replace(/\.git$/, '');
    const url = `https://github.com/${owner}/${repo}.git`;
    const kind = parts[2];
    if ((kind === 'tree' || kind === 'blob') && parts[3]) {
      let rest = parts.slice(4).map((p) => decodeURIComponent(p));
      if (kind === 'blob' && rest.at(-1) === SKILL_FILE) rest = rest.slice(0, -1);
      return { url, ref: decodeURIComponent(parts[3]), repo, ...(rest.length > 0 ? { path: rest.join('/') } : {}) };
    }
    return { url, repo };
  }
  return { url: source, repo: (parts.at(-1) ?? 'repo').replace(/\.git$/, '') || 'repo' };
}

function git(args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      'git',
      args,
      // Never a prompt for a password nobody will see: a private repository fails instead.
      { timeout: CLONE_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 4 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (!err) return resolvePromise();
        const why = String(stderr).trim().split('\n').filter(Boolean).at(-1) ?? err.message;
        reject(new InvalidRequestError(`couldn't clone it: ${why.replace(/^fatal:\s*/, '')}`));
      },
    );
  });
}

/** Clone what an https Git URL names, shallowly, into a temporary folder; the folder to import from, and its removal. */
async function cloneSource(source: string): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const { url, ref, path, repo } = gitSource(source);
  const tmp = await mkdtemp(join(tmpdir(), 'marvis-skills-'));
  const cleanup = (): Promise<void> => rm(tmp, { recursive: true, force: true });
  try {
    const checkout = join(tmp, repo);
    await git(['clone', '--depth', '1', ...(ref ? ['--branch', ref] : []), '--', url, checkout]);
    const root = path ? resolve(checkout, path) : checkout;
    if (relative(checkout, root).startsWith('..')) throw new InvalidRequestError(`not a folder in the repository: "${path}"`);
    if (!(await exists(root))) throw new InvalidRequestError(`the repository has no folder "${path}"`);
    return { root, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

/**
 * Copy skills in from a folder on this machine or an https Git URL: the
 * folder's own skill, or every one below it. Each is copied whole — scripts,
 * references and all, never a `.git` or `node_modules` — to a folder named
 * for it; `conflict` for one this scope has already, unless `replace`.
 */
export async function importSkills(
  place: Pick<SettingsPlace, 'projectRoot' | 'home'>,
  scope: 'user' | 'project',
  source: string,
  opts: { replace?: boolean } = {},
): Promise<Omit<SkillsImportResult, 'view'>> {
  const trimmed = source.trim();
  let root: string;
  let cleanup: (() => Promise<void>) | undefined;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    ({ root, cleanup } = await cloneSource(trimmed));
  } else {
    root = trimmed === '~' || trimmed.startsWith('~/') ? join(place.home, trimmed.slice(1)) : trimmed;
    if (!isAbsolute(root)) throw new InvalidRequestError("a folder's full path, or an https Git URL");
    root = resolve(root);
    if (!(await exists(root))) throw new InvalidRequestError(`there's no folder ${root}`);
  }
  try {
    const target = skillDirs(place)[scope];
    const skills: Array<{ name: string; dir: string }> = [];
    const skipped: string[] = [];
    for (const dir of await skillFolders(root)) {
      const raw = (await readOptional(join(dir, SKILL_FILE))) ?? '';
      // Named as it calls itself: a repository that is one skill is cloned to a folder named for the repository.
      const name = skillNameOf(raw) ?? basename(dir);
      const parsed = parseSkill({ raw, dirName: name, dir, source: scope });
      if (!parsed.ok) skipped.push(`${basename(dir)}: ${parsed.reason}`);
      else if (skills.some((s) => s.name === name)) skipped.push(`${relative(root, dir) || basename(dir)}: another "${name}" came first`);
      else skills.push({ name, dir });
    }
    if (skills.length === 0) {
      throw new InvalidRequestError(
        skipped.length > 0 ? `no skill there parses — ${skipped.join('; ')}` : `there's no ${SKILL_FILE} in ${trimmed}, nor in the folders below it`,
      );
    }
    for (const s of skills) {
      const dest = join(target, s.name);
      const from = resolve(s.dir);
      if (from === dest || from.startsWith(dest + sep) || dest.startsWith(from + sep)) {
        throw new InvalidRequestError(`"${s.name}" is in ${target} already: it can't be copied over itself`);
      }
    }
    const here = [];
    for (const s of skills) if (await exists(join(target, s.name))) here.push(s.name);
    if (here.length > 0 && !opts.replace) {
      throw new ConflictError(`${here.length === 1 ? 'a skill named' : 'skills named'} ${here.map((n) => `"${n}"`).join(', ')} ${here.length === 1 ? 'is' : 'are'} here already`);
    }
    await mkdir(target, { recursive: true });
    for (const s of skills) {
      const dest = join(target, s.name);
      await rm(dest, { recursive: true, force: true });
      await cp(s.dir, dest, {
        recursive: true,
        filter: (src) => {
          const name = basename(src);
          return name !== '.git' && name !== 'node_modules';
        },
      });
    }
    return { imported: skills.map((s) => s.name), skipped };
  } finally {
    await cleanup?.();
  }
}
