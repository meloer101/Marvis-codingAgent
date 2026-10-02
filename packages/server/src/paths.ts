/**
 * Paths a client names inside a workspace: workspace-relative, `/`-separated,
 * and never climbing out of it.
 */

import { realpath } from 'node:fs/promises';
import { isAbsolute, normalize, sep } from 'node:path';

/** Not a path inside the workspace (absolute, or climbing out of it). */
export class WorkspacePathError extends Error {
  constructor(path: string) {
    super(`not a path in the workspace: ${path}`);
    this.name = 'WorkspacePathError';
  }
}

/** A workspace-relative path, checked to stay inside it. */
export function workspacePath(path: string): string {
  const p = normalize(path).replace(/\\/g, '/');
  if (isAbsolute(p) || p === '..' || p.startsWith('../') || p === '.' || p === '') throw new WorkspacePathError(path);
  return p;
}

/** Whether `abs`, links resolved, is inside `root` (links resolved too). */
export async function staysInside(root: string, abs: string): Promise<boolean> {
  const [realRoot, real] = await Promise.all([realpath(root), realpath(abs)]);
  return real === realRoot || real.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep);
}
