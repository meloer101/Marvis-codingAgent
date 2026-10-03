/**
 * A session's own git worktree (`session.start {worktree}`): a new branch off
 * a base, checked out apart from the project's checkout, so two sessions — or
 * a session and the user — can change one project at once without stepping
 * on each other.
 *
 *  - **Where.** `~/.agent/worktrees/<repo>-<hash>/<slug>`, outside the
 *    project, so no second checkout nests inside it for searches, editors or
 *    `git status` to trip over. Core treats a linked worktree as the same
 *    project (`findStateRoot`): its sessions are logged, and read their
 *    settings, memory and MCP servers, where the main checkout's are.
 *  - **The branch** is `hc/<words of the first message>-<4 hex>`, made with
 *    `--no-track`: started from `origin/main` it would otherwise track it, and
 *    a push would aim at `main`.
 *  - **`.worktreeinclude`**, at the repository's top, lists in `.gitignore`
 *    syntax the ignored files a new worktree gets a copy of — `.env`, local
 *    config — which a checkout never brings.
 *  - **Lifecycle.** Archiving a session removes its worktree and keeps the
 *    branch; its next run checks the branch out in a new one. Deleting it
 *    removes the worktree, and the branch when git agrees it is merged.
 */

import { createHash, randomBytes } from 'node:crypto';
import { access, cp, mkdir, realpath, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';

import { AGENT_DIR } from '@harness-code/core';
import type { SessionWorktreeMeta } from '@harness-code/core';
import type { GitBranches } from '@harness-code/protocol';

import { GitCommandError, git, prefixOf } from './git.js';

/** The file at a repository's top naming ignored files a new worktree gets copies of. */
export const WORKTREE_INCLUDE_FILE = '.worktreeinclude';
/** Creating a worktree checks out every file: give it longer than a status. */
const CHECKOUT_TIMEOUT_MS = 120_000;
const MAX_BRANCHES = 200;

/** The local branches a worktree can start from: the checked-out one, then the most recently committed. */
export async function gitBranches(root: string): Promise<GitBranches> {
  if ((await prefixOf(root)) === null) return { repo: false };
  let current: string | null = null;
  try {
    current = (await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim() || null;
  } catch {
    // Detached.
  }
  const { stdout } = await git(root, [
    'for-each-ref',
    '--sort=-committerdate',
    `--count=${MAX_BRANCHES}`,
    '--format=%(refname:short)',
    'refs/heads',
  ]);
  // The branch checked out first: what a worktree most often starts from.
  const branches = stdout.split('\n').filter(Boolean);
  return { repo: true, current, branches: current && branches.includes(current) ? [current, ...branches.filter((b) => b !== current)] : branches };
}

/** Where `root`'s repository keeps its worktrees: one directory per repository under `~/.agent/worktrees`. */
async function worktreesHome(top: string, home: string): Promise<string> {
  const real = await realpath(top);
  const hash = createHash('sha256').update(real).digest('hex').slice(0, 10);
  const name = (basename(real) || 'repo').replace(/[^\w.-]+/g, '_');
  return join(home, AGENT_DIR, 'worktrees', `${name}-${hash}`);
}

/** A branch-name-safe slug of a message's first few words; empty when it has none in ASCII. */
export function slugFrom(text: string): string {
  const words =
    text
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .match(/[a-z0-9]+/g) ?? [];
  let slug = '';
  for (const word of words.slice(0, 5)) {
    const next = slug ? `${slug}-${word}` : word;
    if (next.length > 32) break;
    slug = next;
  }
  return slug || words[0]?.slice(0, 32) || '';
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function branchExists(top: string, branch: string): Promise<boolean> {
  const { code } = await git(top, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { okCodes: [1] });
  return code === 0;
}

/** The repository's top and the workspace's place in it; a GitCommandError outside a repository. */
async function locate(root: string): Promise<{ top: string; prefix: string }> {
  const prefix = await prefixOf(root);
  if (prefix === null) throw new GitCommandError('The project is not a git repository.');
  const top = (await git(root, ['rev-parse', '--show-toplevel'])).stdout.trim();
  return { top, prefix };
}

export interface CreatedWorktree {
  meta: SessionWorktreeMeta;
  /** Where the session works: the worktree, at the workspace's place in the repository. */
  cwd: string;
}

/**
 * Make a worktree for a new session of workspace `root`: a new branch off
 * `base`, named after `hint` (the first message), with the files
 * `.worktreeinclude` names copied in.
 */
export async function createWorktree(
  root: string,
  opts: { base: string; hint?: string; home?: string },
): Promise<CreatedWorktree> {
  const { top, prefix } = await locate(root);
  try {
    await git(top, ['rev-parse', '--verify', '--quiet', `${opts.base}^{commit}`]);
  } catch {
    throw new GitCommandError(`There is no branch or commit "${opts.base}" to start from.`);
  }
  const parent = await worktreesHome(top, opts.home ?? homedir());
  const slug = slugFrom(opts.hint ?? '') || 'session';
  let branch = '';
  let path = '';
  for (let attempt = 0; ; attempt++) {
    const id = `${slug}-${randomBytes(2).toString('hex')}`;
    branch = `hc/${id}`;
    path = join(parent, id);
    if (!(await branchExists(top, branch)) && !(await exists(path))) break;
    if (attempt === 5) throw new GitCommandError('Could not find a free name for the worktree.');
  }
  await mkdir(parent, { recursive: true });
  await git(top, ['worktree', 'add', '--quiet', '--no-track', '-b', branch, path, opts.base], {
    timeout: CHECKOUT_TIMEOUT_MS,
  });
  await copyIncluded(top, path).catch(() => {
    // The worktree works without them; what's missing shows when it's used.
  });
  const meta = { path, branch, base: opts.base };
  return { meta, cwd: worktreeCwd(meta, prefix) };
}

/** Where a session works in its worktree: the workspace's place in the repository (`prefix`). */
export function worktreeCwd(meta: SessionWorktreeMeta, prefix: string): string {
  return prefix ? join(meta.path, prefix.replace(/\/$/, '').split('/').join(sep)) : meta.path;
}

/** The workspace's place in its repository (`''` at the top, else `sub/dir/`); `''` outside one. */
export async function workspacePrefix(root: string): Promise<string> {
  return (await prefixOf(root)) ?? '';
}

/**
 * Check a session's worktree out again after it was removed (archived): its
 * branch in a new worktree at the same place, or — the branch gone — a new
 * branch off the base. Resolves once the directory is there.
 */
export async function restoreWorktree(root: string, meta: SessionWorktreeMeta): Promise<void> {
  if (await exists(meta.path)) return;
  const { top } = await locate(root);
  // A worktree deleted by hand is still registered, and blocks its path.
  await git(top, ['worktree', 'prune']);
  await mkdir(dirname(meta.path), { recursive: true });
  const args = (await branchExists(top, meta.branch))
    ? ['worktree', 'add', '--quiet', meta.path, meta.branch]
    : ['worktree', 'add', '--quiet', '--no-track', '-b', meta.branch, meta.path, meta.base];
  await git(top, args, { timeout: CHECKOUT_TIMEOUT_MS });
  await copyIncluded(top, meta.path).catch(() => {});
}

/** How many files a session's worktree has changed and not committed; 0 when it is gone. */
export async function worktreeChanges(meta: SessionWorktreeMeta): Promise<number> {
  if (!(await exists(meta.path))) return 0;
  const { stdout } = await git(meta.path, ['status', '--porcelain', '--untracked-files=all']);
  return stdout.split('\n').filter(Boolean).length;
}

/**
 * Remove a session's worktree — whatever it holds — and, with `deleteBranch`,
 * its branch, if git agrees it is merged (`branch -d`): a branch with work of
 * its own stays.
 */
export async function removeWorktree(
  root: string,
  meta: SessionWorktreeMeta,
  opts: { deleteBranch?: boolean; home?: string } = {},
): Promise<void> {
  const { top } = await locate(root);
  if (await exists(meta.path)) {
    try {
      await git(top, ['worktree', 'remove', '--force', meta.path], { timeout: CHECKOUT_TIMEOUT_MS });
    } catch (err) {
      // Not (or no longer) a worktree git knows: only ever delete what is under our own directory.
      const parent = await worktreesHome(top, opts.home ?? homedir());
      if (relative(parent, meta.path).startsWith('..')) throw err;
      await rm(meta.path, { recursive: true, force: true });
    }
  }
  await git(top, ['worktree', 'prune']).catch(() => {});
  if (opts.deleteBranch) await git(top, ['branch', '-d', '--quiet', meta.branch]).catch(() => {});
}

/**
 * Copy into a new worktree at `path` the ignored files of `top` that
 * `.worktreeinclude` names: what git ignores only — the patterns pick local
 * files, never ones a checkout already brings.
 */
async function copyIncluded(top: string, path: string): Promise<void> {
  const list = join(top, WORKTREE_INCLUDE_FILE);
  if (!(await exists(list))) return;
  const named = (
    await git(top, ['ls-files', '-z', '--others', '--ignored', '--directory', `--exclude-from=${list}`])
  ).stdout
    .split('\0')
    .filter(Boolean);
  if (named.length === 0) return;
  const ignored = (await git(top, ['check-ignore', '-z', '--stdin'], { input: named.join('\0'), okCodes: [1] })).stdout
    .split('\0')
    .filter(Boolean);
  for (const rel of ignored) {
    const target = join(path, rel);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(top, rel), target, { recursive: true, force: false, errorOnExist: false });
  }
}
