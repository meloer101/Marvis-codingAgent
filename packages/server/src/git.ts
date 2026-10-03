/**
 * A workspace's git state, for the web's Changes panel: what changed against
 * HEAD under the workspace directory, and one file's diff.
 *
 * Everything runs `git` in the workspace directory with optional locks off, so
 * a status taken while the agent runs git itself never fights it for the index
 * lock. Paths come back relative to the workspace (which may be a
 * subdirectory of the repository), `/`-separated. A file the permission engine
 * treats as a secret is listed, but its diff is withheld.
 */

import { execFile } from 'node:child_process';
import { open, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { isSensitivePath } from '@harness-code/core';
import type { GitChange, GitCommitResult, GitDiff, GitFile, GitStatus } from '@harness-code/protocol';

import { workspacePath } from './paths.js';

/** git's empty tree: the base for a repository without commits yet. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
/** A diff bigger than this isn't worth sending to a browser panel. */
const MAX_PATCH_BYTES = 1024 * 1024;
/** Untracked files up to this size get their lines counted. */
const MAX_COUNTED_BYTES = 512 * 1024;
const TIMEOUT_MS = 10_000;
/** Commits (hooks), pushes and pull requests (the network). */
const SLOW_TIMEOUT_MS = 120_000;

/** A git (or gh) command that failed; the message is what it printed about why. */
export class GitCommandError extends Error {
  /** The exit code, or a Node error code (`ENOENT`, `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`). */
  readonly code: number | string | undefined;
  constructor(message: string, code?: number | string) {
    super(message);
    this.name = 'GitCommandError';
    this.code = code;
  }
}

interface Run {
  stdout: string;
  stderr: string;
  /** The exit code; git uses 1 for "there are differences" in some modes. */
  code: number;
}

export interface RunOptions {
  maxBuffer?: number;
  okCodes?: number[];
  /** Commits run hooks and pushes talk to a remote: give them longer. */
  timeout?: number;
  /** Written to the command's stdin. */
  input?: string;
}

/** Never prompts: no terminal, no credentials asked for — a command that needs them fails. */
function run(command: string, cwd: string, args: string[], opts: RunOptions = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      {
        cwd,
        timeout: opts.timeout ?? TIMEOUT_MS,
        maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
        env: {
          ...process.env,
          GIT_OPTIONAL_LOCKS: '0',
          GIT_TERMINAL_PROMPT: '0',
          GH_PROMPT_DISABLED: '1',
          NO_COLOR: '1',
          LC_ALL: 'C',
        },
      },
      (err, stdout, stderr) => {
        const raw = (err as { code?: unknown } | null)?.code;
        const code = typeof raw === 'number' ? raw : 0;
        if (err && !opts.okCodes?.includes(code)) {
          const why = stderr.trim() || stdout.trim() || err.message;
          reject(new GitCommandError(why, typeof raw === 'string' || typeof raw === 'number' ? raw : undefined));
        } else {
          resolve({ stdout, stderr, code });
        }
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

export function git(cwd: string, args: string[], opts: RunOptions = {}): Promise<Run> {
  return run('git', cwd, ['-c', 'core.quotepath=off', '-c', 'color.ui=false', ...args], opts);
}

/** The workspace's path inside its repository (`''` at the root, else `sub/dir/`); null outside one. */
export async function prefixOf(root: string): Promise<string | null> {
  try {
    return (await git(root, ['rev-parse', '--show-prefix'])).stdout.trim();
  } catch {
    return null;
  }
}

async function base(root: string): Promise<string> {
  try {
    await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    return 'HEAD';
  } catch {
    return EMPTY_TREE;
  }
}

const CHANGE: Record<string, GitChange> = {
  M: 'modified',
  T: 'typechange',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  U: 'conflicted',
};

export async function gitStatus(root: string): Promise<GitStatus> {
  const prefix = await prefixOf(root);
  if (prefix === null) return { repo: false };
  const [status, numstat] = await Promise.all([
    git(root, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--', '.']),
    base(root).then((b) => git(root, ['diff', b, '--numstat', '-z', '--relative', '--no-ext-diff', '--', '.'])),
  ]);
  const parsed = parseStatus(status.stdout, prefix);
  const stats = parseNumstat(numstat.stdout);
  const files = await Promise.all(
    parsed.files.map(async (f): Promise<GitFile> => {
      const stat = stats.get(f.path) ?? (f.unstaged === 'untracked' ? await countLines(join(root, f.path)) : undefined);
      return stat ? { ...f, ...stat } : f;
    }),
  );
  return { repo: true, branch: parsed.branch, ...(parsed.upstream ? { upstream: parsed.upstream } : {}), ahead: parsed.ahead, behind: parsed.behind, files };
}

/** `git status --porcelain=v2 -z --branch`, with paths made relative to the workspace. */
export function parseStatus(
  out: string,
  prefix: string,
): { branch: string | null; upstream?: string; ahead: number; behind: number; files: GitFile[] } {
  const rel = (p: string): string => (p.startsWith(prefix) ? p.slice(prefix.length) : p);
  const records = out.split('\0');
  let branch: string | null = null;
  let upstream: string | undefined;
  let ahead = 0;
  let behind = 0;
  const files: GitFile[] = [];
  const sides = (xy: string): Pick<GitFile, 'staged' | 'unstaged'> => {
    const staged = CHANGE[xy[0]!];
    const unstaged = CHANGE[xy[1]!];
    return { ...(staged ? { staged } : {}), ...(unstaged ? { unstaged } : {}) };
  };
  for (let i = 0; i < records.length; i++) {
    const r = records[i]!;
    if (r === '') continue;
    if (r.startsWith('# branch.head ')) {
      const head = r.slice('# branch.head '.length);
      branch = head === '(detached)' ? null : head;
    } else if (r.startsWith('# branch.upstream ')) {
      upstream = r.slice('# branch.upstream '.length);
    } else if (r.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(r);
      if (m) [ahead, behind] = [Number(m[1]), Number(m[2])];
    } else if (r.startsWith('1 ')) {
      // 1 XY sub mH mI mW hH hI path
      const f = fields(r, 8);
      files.push({ path: rel(f.rest), ...sides(f.parts[1]!) });
    } else if (r.startsWith('2 ')) {
      // 2 XY sub mH mI mW hH hI Xscore path, then the original path as the next record
      const f = fields(r, 9);
      const oldPath = records[++i] ?? '';
      files.push({ path: rel(f.rest), oldPath: rel(oldPath), ...sides(f.parts[1]!) });
    } else if (r.startsWith('u ')) {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      files.push({ path: rel(fields(r, 10).rest), staged: 'conflicted', unstaged: 'conflicted' });
    } else if (r.startsWith('? ')) {
      files.push({ path: rel(r.slice(2)), unstaged: 'untracked' });
    }
  }
  return { branch, ...(upstream ? { upstream } : {}), ahead, behind, files };
}

/** The first `n` space-separated fields, and the rest (a path, which may contain spaces). */
function fields(record: string, n: number): { parts: string[]; rest: string } {
  const parts: string[] = [];
  let at = 0;
  for (let k = 0; k < n; k++) {
    const sp = record.indexOf(' ', at);
    parts.push(record.slice(at, sp));
    at = sp + 1;
  }
  return { parts, rest: record.slice(at) };
}

/** `git diff --numstat -z`: lines added and removed per path (a rename counts under its new path). */
export function parseNumstat(out: string): Map<string, { added: number; removed: number } | { binary: true }> {
  const stats = new Map<string, { added: number; removed: number } | { binary: true }>();
  const records = out.split('\0');
  for (let i = 0; i < records.length; i++) {
    const r = records[i]!;
    if (r === '') continue;
    const [a, d, path] = r.split('\t');
    // A rename leaves the path empty and puts the old and new paths in the next two records.
    const target = path === '' ? ((i += 2), records[i] ?? '') : (path ?? '');
    stats.set(target, a === '-' ? { binary: true } : { added: Number(a), removed: Number(d) });
  }
  return stats;
}

/** An untracked file counts as all added: its lines, or binary. Too big or unreadable: no count. */
async function countLines(path: string): Promise<{ added: number; removed: number } | { binary: true } | undefined> {
  try {
    const handle = await open(path, 'r');
    try {
      const { size } = await handle.stat();
      if (size > MAX_COUNTED_BYTES) return undefined;
      const buf = Buffer.alloc(size);
      await handle.read(buf, 0, size, 0);
      if (buf.subarray(0, 8192).includes(0)) return { binary: true };
      const text = buf.toString('utf8');
      const lines = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
      return { added: lines, removed: 0 };
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

/** Which changes a diff shows: against HEAD (all), staged (HEAD → index), or unstaged (index → work tree). */
export type DiffSide = 'all' | 'staged' | 'unstaged';

export async function gitDiff(root: string, path: string, side: DiffSide = 'all'): Promise<GitDiff> {
  const rel = workspacePath(path);
  if (isSensitivePath(rel)) return { kind: 'withheld', reason: 'This looks like a secret, so its contents stay on disk.' };
  if ((await prefixOf(root)) === null) return { kind: 'withheld', reason: 'Not a git repository.' };
  const flags = ['--no-color', '--no-ext-diff', '--relative'];
  const against = side === 'staged' ? ['--cached'] : side === 'unstaged' ? [] : [await base(root)];
  let patch: string;
  try {
    patch = (await git(root, ['diff', ...against, ...flags, '--', rel], { maxBuffer: MAX_PATCH_BYTES })).stdout;
    if (patch === '' && side === 'all') {
      // Untracked: against nothing. `--no-index` exits 1 when the files differ.
      const untracked = (await git(root, ['ls-files', '--others', '--exclude-standard', '--', rel])).stdout.trim();
      if (untracked !== '') {
        patch = (
          await git(root, ['diff', '--no-index', ...flags, '--', '/dev/null', rel], {
            maxBuffer: MAX_PATCH_BYTES,
            okCodes: [1],
          })
        ).stdout;
      }
    }
  } catch (err) {
    if ((err as { code?: unknown }).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      return { kind: 'withheld', reason: 'Too big to show here.' };
    }
    throw err;
  }
  if (/^Binary files .* differ$/m.test(patch)) return { kind: 'binary' };
  return { kind: 'text', patch };
}

// -- changing things ----------------------------------------------------------

/** A one-file patch split into its header (`diff --git`, `---`, `+++`…) and its hunks, each from its `@@` line. */
export function splitHunks(patch: string): { header: string; hunks: string[] } {
  const lines = patch.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const first = lines.findIndex((l) => l.startsWith('@@ '));
  if (first === -1) return { header: patch, hunks: [] };
  const hunks: string[] = [];
  for (const line of lines.slice(first)) {
    if (line.startsWith('@@ ')) hunks.push(`${line}\n`);
    else hunks[hunks.length - 1] += `${line}\n`;
  }
  return { header: `${lines.slice(0, first).join('\n')}\n`, hunks };
}

/**
 * Stage, unstage or discard one hunk of a file, as it was shown (`hunk`, from
 * its `@@` line): staging and discarding take it from the unstaged changes,
 * unstaging from the staged ones. The diff is taken again first, and a hunk
 * no longer in it — the file changed since — is refused rather than guessed
 * at. Never a secret's.
 */
export async function gitApplyHunk(
  root: string,
  path: string,
  hunk: string,
  action: 'stage' | 'unstage' | 'discard',
): Promise<void> {
  const rel = workspacePath(path);
  if (isSensitivePath(rel)) throw new GitCommandError(`${rel} looks like a secret, so it isn't changed from here.`);
  // Paths relative to the repository's top, applied there: a workspace may be a subdirectory.
  const top = (await git(root, ['rev-parse', '--show-toplevel'])).stdout.trim();
  const flags = ['--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/'];
  const patch = (
    await git(root, ['diff', ...(action === 'unstage' ? ['--cached'] : []), ...flags, '--', rel], {
      maxBuffer: MAX_PATCH_BYTES,
    })
  ).stdout;
  const { header, hunks } = splitHunks(patch);
  const wanted = hunk.endsWith('\n') ? hunk : `${hunk}\n`;
  if (!hunks.includes(wanted)) {
    throw new GitCommandError('That part of the file has changed since it was shown — look at it again.');
  }
  await git(
    top,
    ['apply', '--whitespace=nowarn', ...(action === 'discard' ? [] : ['--cached']), ...(action === 'stage' ? [] : ['-R']), '-'],
    { input: header + wanted },
  );
}

/** Stage `paths` as they are on disk: changes, new files and deletions alike. */
export async function gitStage(root: string, paths: readonly string[]): Promise<void> {
  await git(root, ['add', '-A', '--', ...paths.map(workspacePath)]);
}

/** Take `paths` out of the index again, keeping the work tree as it is. */
export async function gitUnstage(root: string, paths: readonly string[]): Promise<void> {
  const rel = paths.map(workspacePath);
  if ((await base(root)) === 'HEAD') await git(root, ['restore', '--staged', '--', ...rel]);
  else await git(root, ['rm', '--cached', '-r', '-q', '--', ...rel]);
}

/**
 * Throw away every change to `paths`, staged or not: a file HEAD has goes back
 * to it (a renamed one to its old name), and one it doesn't — untracked or
 * newly added — is deleted. A secret is never deleted: it can't be got back.
 */
export async function gitRevert(root: string, paths: readonly string[]): Promise<void> {
  const wanted = new Set(paths.map(workspacePath));
  const status = await gitStatus(root);
  if (!status.repo) throw new GitCommandError('Not a git repository.');
  const restore: string[] = [];
  const remove: string[] = [];
  for (const f of status.files) {
    if (!wanted.has(f.path)) continue;
    const isNew = f.unstaged === 'untracked' || f.staged === 'added' || f.staged === 'copied';
    if (f.oldPath !== undefined && f.staged === 'renamed') {
      restore.push(f.oldPath);
      remove.push(f.path);
    } else if (isNew) {
      remove.push(f.path);
    } else {
      restore.push(f.path);
    }
  }
  const secret = remove.find((p) => isSensitivePath(p));
  if (secret) throw new GitCommandError(`${secret} looks like a secret, so it won't be deleted from here — remove it yourself.`);
  if (restore.length > 0) await git(root, ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...restore]);
  for (const p of remove) {
    // Out of the index if it's there, then off the disk.
    await git(root, ['rm', '--cached', '-q', '--ignore-unmatch', '--', p]);
    await rm(join(root, p), { force: true });
  }
}

/**
 * Commit what is staged, staging `paths` first when given. Hooks run;
 * nothing prompts. Like `git commit`, it takes everything staged in the
 * repository, under the workspace or not.
 */
export async function gitCommit(root: string, message: string, opts: { paths?: readonly string[] } = {}): Promise<GitCommitResult> {
  if (message.trim() === '') throw new GitCommandError('A commit needs a message.');
  if (opts.paths?.length) await gitStage(root, opts.paths);
  await git(root, ['commit', '-q', '-m', message], { timeout: SLOW_TIMEOUT_MS });
  const sha = (await git(root, ['rev-parse', '--short', 'HEAD'])).stdout.trim();
  return { sha, summary: message.trim().split('\n')[0]! };
}

/** Push the branch — setting its upstream on `origin` the first time. */
export async function gitPush(root: string): Promise<void> {
  const status = await gitStatus(root);
  if (!status.repo) throw new GitCommandError('Not a git repository.');
  if (status.branch === null) throw new GitCommandError('HEAD is detached: check out a branch to push.');
  if (status.upstream) {
    await git(root, ['push'], { timeout: SLOW_TIMEOUT_MS });
    return;
  }
  const remotes = (await git(root, ['remote'])).stdout.split('\n').filter(Boolean);
  const remote = remotes.includes('origin') ? 'origin' : remotes[0];
  if (!remote) throw new GitCommandError('This repository has no remote to push to.');
  await git(root, ['push', '-u', remote, status.branch], { timeout: SLOW_TIMEOUT_MS });
}

/**
 * Open a pull request for the branch with the GitHub CLI; resolves with its
 * URL. `base` (a worktree's) is the branch to merge into, when it is a local
 * branch; else the repository's default.
 */
export async function createPullRequest(
  root: string,
  pr: { title: string; body?: string; draft?: boolean; base?: string },
): Promise<{ url: string }> {
  const args = ['pr', 'create', '--title', pr.title, '--body', pr.body ?? ''];
  if (pr.draft) args.push('--draft');
  if (pr.base && (await git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${pr.base}`], { okCodes: [1] })).code === 0) {
    args.push('--base', pr.base);
  }
  try {
    const { stdout } = await run('gh', root, args, { timeout: SLOW_TIMEOUT_MS });
    const url = stdout.trim().split('\n').filter(Boolean).at(-1) ?? '';
    return { url };
  } catch (err) {
    if (err instanceof GitCommandError && err.code === 'ENOENT') {
      throw new GitCommandError('The GitHub CLI (gh) is not installed — see https://cli.github.com.');
    }
    throw err;
  }
}
