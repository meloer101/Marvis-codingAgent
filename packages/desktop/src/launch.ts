/**
 * What the app starts with, kept apart from Electron so it can be tested: the
 * project the server opens first, and the page's address.
 */

import { stat } from 'node:fs/promises';

import type { WorkspaceRecord } from '@harness-code/server';

/** `marvis web`'s port (packages/cli/src/index.ts): the server on it is the one either finds again. */
export const DEFAULT_PORT = 4317;

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The remembered project used most recently that still exists — the server
 * starts with it, as `marvis web` starts with the directory it was run in.
 * Undefined on a first launch (or when every remembered folder is gone).
 */
export async function lastProject(
  records: readonly WorkspaceRecord[],
  exists: (path: string) => Promise<boolean> = isDir,
): Promise<string | undefined> {
  const recent = [...records].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  for (const record of recent) {
    if (await exists(record.root)) return record.root;
  }
  return undefined;
}

/** The page, authenticated by the token in its fragment (never sent to the server in a request line). */
export function pageUrl(port: number, token: string): string {
  return `http://127.0.0.1:${port}/#token=${token}`;
}

/** Whether `url` is the page itself (any route of it), as opposed to a link out of the app. */
export function isAppUrl(url: string, port: number): boolean {
  try {
    const { protocol, hostname, port: p } = new URL(url);
    return protocol === 'http:' && (hostname === '127.0.0.1' || hostname === 'localhost') && p === String(port);
  } catch {
    return false;
  }
}
