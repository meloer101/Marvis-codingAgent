/**
 * OS-level backstop for the bash tool, on top of (not instead of) the
 * text-review path in `bash-ast.ts`. Everything upstream of this file is
 * "does this command look safe before we spawn it" — this is the one place
 * that asks the OS to enforce something itself, so a pattern our AST review
 * never anticipated still can't write outside the workspace.
 *
 * Scoped to exactly what it's for: workspace read-write, everything else
 * read-only. Reads, network, and process-exec are left alone — a
 * from-scratch Seatbelt profile that also tries to lock those down is far
 * more likely to break ordinary tool use (DNS lookups, dynamic linking,
 * spawning subprocesses) than to add real value here. macOS only —
 * `sandbox-exec` (Seatbelt) has no equivalent on this project's other
 * target platforms, so elsewhere this degrades to the unsandboxed spawn
 * that's always been there.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const SANDBOX_EXEC_PATH = '/usr/bin/sandbox-exec';

let cachedAvailable: boolean | undefined;

/** Whether `sandbox-exec` is available on this machine. Checked once and memoized — this can't change mid-run. */
export function isSandboxExecAvailable(): boolean {
  if (cachedAvailable === undefined) {
    cachedAvailable = process.platform === 'darwin' && existsSync(SANDBOX_EXEC_PATH);
  }
  return cachedAvailable;
}

/** Pure string builder — no filesystem or platform checks, so it's testable everywhere. */
export function buildSandboxProfile(workspaceRoot: string, extraWritablePaths: readonly string[] = []): string {
  const allowClauses = [workspaceRoot, ...extraWritablePaths]
    .map((p) => `(allow file-write* (subpath "${escapeProfilePath(p)}"))`)
    .join('\n');
  return `(version 1)\n(allow default)\n(deny file-write* (subpath "/"))\n${DEVICE_WRITES}\n${allowClauses}`;
}

/**
 * Character devices that ordinary commands open for writing and that can't
 * persist anything: without these, `git` (and anything else that opens
 * `/dev/null` read-write) dies with "could not open '/dev/null' ...
 * Operation not permitted", and redirects to the terminal fail.
 */
const DEVICE_WRITES =
  '(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") ' +
  '(regex #"^/dev/tty") (regex #"^/dev/fd/"))';

function escapeProfilePath(p: string): string {
  return p.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export interface WrappedCommand {
  cmd: string;
  args: string[];
}

/**
 * Wraps a `/bin/sh` invocation with `sandbox-exec` when available, confining
 * writes to `workspaceRoot` and the OS temp dir (real tools routinely need
 * scratch space there). `available` defaults to the real Darwin-only check
 * but is injectable so the wrapping logic itself is testable on any CI
 * platform, independent of whether `sandbox-exec` actually exists there.
 */
export function wrapCommand(
  shellArgs: readonly string[],
  workspaceRoot: string,
  available: boolean = isSandboxExecAvailable(),
): WrappedCommand {
  if (!available) return { cmd: '/bin/sh', args: [...shellArgs] };
  const [root, ...extra] = writableRoots(workspaceRoot);
  const profile = buildSandboxProfile(root!, extra);
  return { cmd: SANDBOX_EXEC_PATH, args: ['-p', profile, '/bin/sh', ...shellArgs] };
}

/**
 * The paths writes are allowed under, each also by its resolved path. Seatbelt
 * matches `subpath` against the real path, and on macOS both `tmpdir()`
 * (`/var/folders/…`) and `/tmp` are symlinks into `/private` — so an allow
 * clause naming them as given matched nothing, and every write in a workspace
 * under the temp dir (every eval run) or to the temp dir itself was refused.
 */
export function writableRoots(workspaceRoot: string): string[] {
  const roots = new Set<string>();
  const gitDir = linkedWorktreeGitDir(workspaceRoot);
  for (const p of [workspaceRoot, tmpdir(), '/tmp', ...(gitDir ? [gitDir] : [])]) {
    roots.add(p);
    try {
      roots.add(realpathSync(p));
    } catch {
      // A root that doesn't exist can't be written to anyway.
    }
  }
  return [...roots];
}

/**
 * The repository's `.git` when `workspaceRoot` is in a linked worktree: git
 * keeps a worktree's index, refs and objects there, outside the worktree, so
 * without it `git add` and `git commit` in the worktree were refused — where
 * the same commands in the main checkout write its `.git`, inside the workspace.
 */
export function linkedWorktreeGitDir(workspaceRoot: string): string | undefined {
  for (let dir = resolve(workspaceRoot); ; dir = dirname(dir)) {
    let gitFile: string;
    try {
      gitFile = readFileSync(join(dir, '.git'), 'utf8');
    } catch (err) {
      // A `.git` directory: an ordinary checkout, whose `.git` is in the workspace already.
      if ((err as NodeJS.ErrnoException).code === 'EISDIR') return undefined;
      if (dirname(dir) === dir) return undefined;
      continue;
    }
    const match = /^gitdir:\s*(.+?)\s*$/m.exec(gitFile);
    if (!match) return undefined;
    const gitDir = resolve(dir, match[1]!);
    try {
      return resolve(gitDir, readFileSync(join(gitDir, 'commondir'), 'utf8').trim());
    } catch {
      return undefined; // a submodule: its gitdir has no commondir
    }
  }
}
