/**
 * The files of a workspace: a fuzzy search over them (`@` mentions), its
 * folders one level at a time and a file's contents (the Files tab).
 *
 * The list comes from `git ls-files` (tracked plus untracked, minus what
 * `.gitignore` excludes) where the workspace is in a repository, else from a
 * walk that skips the usual build and dependency directories. It is cached per
 * root for a few seconds — long enough for the keystrokes of one mention —
 * and never includes a file the permission engine would refuse to read as a
 * secret (`.env`, keys).
 */

import { execFile } from 'node:child_process';
import { open, readdir, realpath } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { isSensitivePath } from '@harness-code/core';
import type { DirEntry, FileContent, FileMatch } from '@harness-code/protocol';

import { staysInside, workspacePath } from './paths.js';

/** Files bigger than this aren't sent to a browser. */
const MAX_READ_BYTES = 1024 * 1024;

/** How long a listing is reused. */
const TTL_MS = 10_000;
/** A walk stops here; a workspace this big is a repository in practice. */
const MAX_FILES = 50_000;
const DEFAULT_LIMIT = 50;
/** Never walked into (outside git, which has `.gitignore` for this). */
const SKIP_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '.pnpm-store',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
  '.venv',
  'venv',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.gradle',
  '.idea',
  '.agent',
]);

export class FileIndex {
  readonly #cache = new Map<string, { at: number; files: Promise<string[]> }>();
  readonly #now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.#now = opts.now ?? Date.now;
  }

  /** Files under `root` matching `query`, best first; with an empty query, the shallowest. */
  async search(root: string, query: string, limit = DEFAULT_LIMIT): Promise<FileMatch[]> {
    const files = await this.#files(root);
    const q = query.trim();
    if (q === '') {
      return [...files]
        .sort((a, b) => depth(a) - depth(b) || a.length - b.length || a.localeCompare(b))
        .slice(0, limit)
        .map((path) => ({ path }));
    }
    const scored: Array<{ path: string; score: number }> = [];
    for (const path of files) {
      const score = fuzzyScore(path, q);
      if (score !== null) scored.push({ path, score });
    }
    scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    return scored.slice(0, limit).map(({ path }) => ({ path }));
  }

  /** The entries directly in `dir` (`''` for the root): folders first, then files, each by name. */
  async list(root: string, dir: string): Promise<DirEntry[]> {
    const prefix = dir === '' ? '' : `${workspacePath(dir)}/`;
    const dirs = new Set<string>();
    const files: string[] = [];
    for (const path of await this.#files(root)) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) files.push(rest);
      else dirs.add(rest.slice(0, slash));
    }
    const byName = (a: string, b: string): number => a.localeCompare(b);
    return [
      ...[...dirs].sort(byName).map((name) => ({ name, dir: true })),
      ...files.sort(byName).map((name) => ({ name, dir: false })),
    ];
  }

  /** Forget `root`'s listing — its files changed. */
  invalidate(root: string): void {
    this.#cache.delete(root);
  }

  /** Forget every listing. */
  clear(): void {
    this.#cache.clear();
  }

  #files(root: string): Promise<string[]> {
    const hit = this.#cache.get(root);
    if (hit && this.#now() - hit.at < TTL_MS) return hit.files;
    const files = listFiles(root).then((all) => all.filter((f) => !isSensitivePath(f)));
    this.#cache.set(root, { at: this.#now(), files });
    files.catch(() => this.#cache.delete(root));
    return files;
  }
}

/**
 * A workspace file's text. Withheld: a secret (by its name or what it links
 * to), a link out of the workspace, a folder, anything over 1 MB, or a file
 * that isn't there.
 */
export async function readWorkspaceFile(root: string, path: string): Promise<FileContent> {
  const rel = workspacePath(path);
  if (isSensitivePath(rel)) return { kind: 'withheld', reason: 'This looks like a secret, so its contents stay on disk.' };
  const abs = join(root, rel);
  try {
    if (!(await staysInside(root, abs))) return { kind: 'withheld', reason: 'It links to somewhere outside the project.' };
    if (isSensitivePath(relative(await realpath(root), await realpath(abs)))) {
      return { kind: 'withheld', reason: 'It links to a secret, so its contents stay on disk.' };
    }
    const handle = await open(abs, 'r');
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) return { kind: 'withheld', reason: 'Not a file.' };
      if (stats.size > MAX_READ_BYTES) {
        return { kind: 'withheld', reason: `Too big to show here (${(stats.size / 1024 / 1024).toFixed(1)} MB).` };
      }
      const buf = Buffer.alloc(stats.size);
      await handle.read(buf, 0, stats.size, 0);
      if (buf.subarray(0, 8192).includes(0)) return { kind: 'binary' };
      return { kind: 'text', content: buf.toString('utf8') };
    } finally {
      await handle.close();
    }
  } catch (err) {
    if ((err as { code?: unknown }).code === 'ENOENT') return { kind: 'withheld', reason: 'No such file.' };
    throw err;
  }
}

/** Workspace-relative, `/`-separated file paths. */
export async function listFiles(root: string): Promise<string[]> {
  try {
    return await gitFiles(root);
  } catch {
    return walk(root);
  }
}

function gitFiles(root: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { cwd: root, maxBuffer: 64 * 1024 * 1024, timeout: 5000 },
      (err, stdout) => {
        if (err) reject(err);
        // Deleted but still tracked files are listed too; a stale entry only
        // costs a failed attachment, which says why.
        else resolve([...new Set(stdout.split('\0').filter((f) => f !== ''))]);
      },
    );
  });
}

async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  const queue: string[] = [''];
  while (queue.length > 0 && out.length < MAX_FILES) {
    const rel = queue.shift()!;
    let entries;
    try {
      entries = await readdir(join(root, rel), { withFileTypes: true });
    } catch {
      continue; // unreadable: skip it
    }
    for (const entry of entries) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) queue.push(path);
      } else if (entry.isFile()) {
        out.push(path);
        if (out.length >= MAX_FILES) break;
      }
    }
  }
  return out;
}

function depth(path: string): number {
  let n = 0;
  for (const ch of path) if (ch === '/') n++;
  return n;
}

const BOUNDARY = new Set(['/', '-', '_', '.', ' ']);

/**
 * How well `path` matches `query` (higher is better), or null when it doesn't:
 * the query's characters must appear in order. A substring of the file name
 * beats one of the path, which beats a scattered match; runs of consecutive
 * characters, word starts and a short path add to it.
 */
export function fuzzyScore(path: string, query: string): number | null {
  const p = path.toLowerCase();
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (q === '') return 0;
  const baseStart = p.lastIndexOf('/') + 1;
  const base = p.slice(baseStart);
  let score: number;
  const inBase = base.indexOf(q);
  if (inBase !== -1) {
    score = 100 + (inBase === 0 ? 40 : 0) + (base.length === q.length || base.startsWith(`${q}.`) ? 40 : 0);
  } else if (p.includes(q)) {
    const at = p.indexOf(q);
    score = 60 + (at === 0 || BOUNDARY.has(p[at - 1]!) ? 15 : 0);
  } else {
    score = 0;
    let from = 0;
    let prev = -2;
    let run = 0;
    for (const ch of q) {
      const found = p.indexOf(ch, from);
      if (found === -1) return null;
      if (found === prev + 1) {
        run++;
        score += 3 + run;
      } else {
        run = 0;
        score -= Math.min(found - from, 8) * 0.5;
      }
      if (found === 0 || BOUNDARY.has(p[found - 1]!)) score += 5;
      if (found >= baseStart) score += 1;
      prev = found;
      from = found + 1;
    }
  }
  return score - p.length * 0.05;
}
