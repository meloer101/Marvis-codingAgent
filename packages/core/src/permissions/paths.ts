import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export class PathEscapeError extends Error {
  readonly target: string;

  constructor(target: string, detail?: string) {
    super(detail ?? `Path escapes the workspace: ${target}`);
    this.name = 'PathEscapeError';
    this.target = target;
  }
}

export function isInsideWorkspace(workspaceRoot: string, target: string): boolean {
  const root = workspaceRoot.endsWith(sep) ? workspaceRoot.slice(0, -1) : workspaceRoot;
  return target === root || target.startsWith(root + sep);
}

export interface WorkspacePathOptions {
  /**
   * Also accept a path inside the system temp directory (`os.tmpdir()`, and
   * `/tmp`). The `bash` sandbox already lets commands write there; the file
   * tools opt in so the agent can keep scratch files out of the workspace
   * instead of having to leave them in it.
   */
  allowScratch?: boolean;
}

let scratchRootsPromise: Promise<string[]> | undefined;

/** The temp directories scratch files may live in, symlinks resolved (`/tmp` is `/private/tmp` on macOS). */
export function scratchRoots(): Promise<string[]> {
  scratchRootsPromise ??= Promise.all(
    [tmpdir(), '/tmp'].map((p) => realpath(p).catch(() => undefined)),
  ).then((roots) => [...new Set(roots.filter((r): r is string => r !== undefined && r !== '/'))]);
  return scratchRootsPromise;
}

/**
 * Where files the user uploads with a message are saved (`agent/uploads.ts`):
 * a folder of the system temp directory, symlinks resolved. Inside scratch, so
 * the file tools reach it; the permission engine lets them read it in any mode.
 */
export async function uploadsRoot(): Promise<string> {
  const base = await realpath(tmpdir()).catch(() => tmpdir());
  return join(base, 'hc-uploads');
}

/** Whether `target` (absolute, or relative to `cwd`) resolves to an uploaded file. */
export async function isInUploads(target: string, cwd = process.cwd()): Promise<boolean> {
  const resolved = await realpathExistingOrJoin(isAbsolute(target) ? resolve(target) : resolve(cwd, target));
  return isInsideWorkspace(await uploadsRoot(), resolved);
}

/** Whether `target` (absolute, or relative to `cwd`) resolves inside a scratch root. */
export async function isInScratch(target: string, cwd = process.cwd()): Promise<boolean> {
  const resolved = await realpathExistingOrJoin(isAbsolute(target) ? resolve(target) : resolve(cwd, target));
  return (await scratchRoots()).some((root) => isInsideWorkspace(root, resolved));
}

/**
 * Resolve `target` against the workspace, following symlinks. Files that do not
 * exist yet are resolved via the nearest existing ancestor so `../` and
 * symlink hops cannot sneak a create outside the cage.
 */
export async function resolveInWorkspace(
  workspaceRoot: string,
  target: string,
  opts: WorkspacePathOptions = {},
): Promise<string> {
  const root = await realpath(workspaceRoot);
  const abs = isAbsolute(target) ? resolve(target) : resolve(root, target);
  const resolved = await realpathExistingOrJoin(abs);
  if (isInsideWorkspace(root, resolved)) return resolved;
  if (opts.allowScratch && (await scratchRoots()).some((r) => isInsideWorkspace(r, resolved))) {
    return resolved;
  }
  throw new PathEscapeError(target);
}

export async function assertInsideWorkspace(
  workspaceRoot: string,
  target: string,
  opts: WorkspacePathOptions = {},
): Promise<string> {
  return resolveInWorkspace(workspaceRoot, target, opts);
}

export async function relativeToWorkspace(workspaceRoot: string, target: string): Promise<string> {
  const root = await realpath(workspaceRoot);
  const resolved = await resolveInWorkspace(workspaceRoot, target);
  const rel = relative(root, resolved);
  return rel.split(sep).join('/');
}

async function realpathExistingOrJoin(abs: string): Promise<string> {
  try {
    return await realpath(abs);
  } catch {
    const tail: string[] = [];
    let current = abs;
    for (;;) {
      tail.unshift(basename(current));
      const parent = dirname(current);
      if (parent === current) {
        return abs;
      }
      try {
        const parentReal = await realpath(parent);
        return join(parentReal, ...tail);
      } catch {
        current = parent;
      }
    }
  }
}

const SENSITIVE_BASENAME = /^(id_rsa(\.pub)?|.+\.pem)$/i;

/**
 * Committed templates that document which variables exist, without values:
 * reading or editing one is ordinary work. Only these exact names — `.env`,
 * `.env.local`, `.env.production` and every other `.env*` stay protected.
 */
const ENV_TEMPLATE = /^\.env\.(example|sample|template)$/i;

export function isSensitivePath(relPosix: string): boolean {
  const n = relPosix.replace(/\\/g, '/').replace(/^\.\//, '');
  const parts = n.split('/');
  const base = parts[parts.length - 1] ?? '';

  if (base.startsWith('.env') && !ENV_TEMPLATE.test(base)) return true;
  if (n === '.git/config' || n.endsWith('/.git/config')) return true;
  if (SENSITIVE_BASENAME.test(base)) return true;
  if (/credential/i.test(base)) return true;
  if (/^secrets?\.json$/i.test(base)) return true;
  return false;
}

/**
 * {@link isSensitivePath} as basename globs, matched case-insensitively, for
 * searches that choose their own files — `grep -r`, `rg`, the `grep` tool —
 * where no argument names the secret and so no argument check can catch it.
 * `.git/config` has no basename form and is left out.
 */
export const SENSITIVE_FILE_GLOBS: readonly string[] = [
  '.env*',
  'id_rsa',
  'id_rsa.pub',
  '*.pem',
  '*credential*',
  'secret.json',
  'secrets.json',
];

/**
 * Arguments of a shell command that name a sensitive file (`.env`, `id_rsa`,
 * `*.pem`, …). Used to keep `cat .env` out of the read-only fast path: nothing
 * about reading a secret is harmless just because it writes nothing.
 *
 * Deliberately generous about what counts as a path — an unrecognized argument
 * is cheap to check and the cost of missing one is a leaked credential. Values
 * attached to flags (`--env-file=.env`) are checked too.
 */
export function sensitiveBashArgs(segments: readonly (readonly string[])[]): string[] {
  const hits: string[] = [];
  for (const argv of segments) {
    for (const raw of argv.slice(1)) {
      const arg = raw.startsWith('-') && raw.includes('=') ? raw.slice(raw.indexOf('=') + 1) : raw;
      if (arg === '' || arg.startsWith('-')) continue;
      const cleaned = arg.replace(/^['"]|['"]$/g, '');
      if (isSensitivePath(cleaned)) hits.push(cleaned);
    }
  }
  return hits;
}

const PROTECTED_DIR_NAMES = new Set([
  '.git',
  '.vscode',
  '.idea',
  '.husky',
  '.cargo',
  '.devcontainer',
  '.yarn',
  '.mvn',
]);

const PROTECTED_FILES = new Set([
  '.gitignore',
  '.gitattributes',
  '.gitmodules',
  '.mailmap',
  '.git-blame-ignore-revs',
  '.mcp.json',
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  '.pnpmfile.cjs',
  '.pnpmrc',
  '.nvmrc',
  '.node-version',
  '.python-version',
  '.ruby-version',
  '.tool-versions',
  '.editorconfig',
  '.prettierrc',
  '.prettierignore',
  '.eslintrc',
  '.eslintignore',
  '.stylelintrc',
  '.babelrc',
  'Dockerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'compose.yaml',
  'Makefile',
  'Justfile',
  'justfile',
  'tsconfig.json',
  'jsconfig.json',
]);

/**
 * Paths the permission engine will not auto-approve for write/edit.
 * `.agent/plans/` is the one exception (plan files).
 */
export function isProtectedPath(relPosix: string): boolean {
  const n = relPosix.replace(/\\/g, '/').replace(/^\.\//, '');
  if (n === '.agent/plans' || n.startsWith('.agent/plans/')) return false;
  if (n === '.agent' || n.startsWith('.agent/')) return true;
  if (n === '.config/git' || n.startsWith('.config/git/')) return true;
  const parts = n.split('/');
  if (parts.some((p) => PROTECTED_DIR_NAMES.has(p))) return true;
  const base = parts[parts.length - 1] ?? '';
  if (PROTECTED_FILES.has(base)) return true;
  return (
    base.startsWith('.prettierrc.') ||
    base.startsWith('.eslintrc.') ||
    base.startsWith('.stylelintrc.') ||
    base.startsWith('.babelrc.')
  );
}
