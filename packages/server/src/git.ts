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
import { open } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';

import { isSensitivePath } from '@harness-code/core';
import type { GitChange, GitDiff, GitFile, GitStatus } from '@harness-code/protocol';

/** git's empty tree: the base for a repository without commits yet. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
/** A diff bigger than this isn't worth sending to a browser panel. */
const MAX_PATCH_BYTES = 1024 * 1024;
/** Untracked files up to this size get their lines counted. */
const MAX_COUNTED_BYTES = 512 * 1024;
const TIMEOUT_MS = 10_000;

/** Not a path inside the workspace (absolute, or climbing out of it). */
export class GitPathError extends Error {
  constructor(path: string) {
    super(`not a path in the workspace: ${path}`);
    this.name = 'GitPathError';
  }
}

interface Run {
  stdout: string;
  /** The exit code; git uses 1 for "there are differences" in some modes. */
  code: number;
}

function git(cwd: string, args: string[], opts: { maxBuffer?: number; okCodes?: number[] } = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=off', '-c', 'color.ui=false', ...args],
      {
        cwd,
        timeout: TIMEOUT_MS,
        maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      },
      (err, stdout) => {
        const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 0;
        if (err && !opts.okCodes?.includes(code)) reject(err);
        else resolve({ stdout, code });
      },
    );
  });
}

/** The workspace's path inside its repository (`''` at the root, else `sub/dir/`); null outside one. */
async function prefixOf(root: string): Promise<string | null> {
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

/** A workspace-relative path, checked to stay inside it. */
export function workspacePath(path: string): string {
  const p = normalize(path).replace(/\\/g, '/');
  if (isAbsolute(p) || p === '..' || p.startsWith('../') || p === '.' || p === '') throw new GitPathError(path);
  return p;
}

export async function gitDiff(root: string, path: string): Promise<GitDiff> {
  const rel = workspacePath(path);
  if (isSensitivePath(rel)) return { kind: 'withheld', reason: 'This looks like a secret, so its contents stay on disk.' };
  if ((await prefixOf(root)) === null) return { kind: 'withheld', reason: 'Not a git repository.' };
  const flags = ['--no-color', '--no-ext-diff', '--relative'];
  let patch: string;
  try {
    patch = (await git(root, ['diff', await base(root), ...flags, '--', rel], { maxBuffer: MAX_PATCH_BYTES })).stdout;
    if (patch === '') {
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
