/**
 * The projects one `marvis web` hosts, remembered across restarts in
 * `~/.agent/web/workspaces.json`. A workspace's id is derived from its root
 * path, so the same directory is always the same workspace.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { ensureDir, writePrivate } from './instance.js';

export interface WorkspaceRecord {
  id: string;
  /** Absolute, symlinks resolved. */
  root: string;
  addedAt: number;
  lastUsedAt: number;
}

export interface WorkspaceStore {
  load(): Promise<WorkspaceRecord[]>;
  save(records: WorkspaceRecord[]): Promise<void>;
}

/** The stable id for a workspace root: a short digest of the path. */
export function workspaceId(root: string): string {
  return createHash('sha256').update(root).digest('hex').slice(0, 12);
}

/** `<webStateDir>/workspaces.json`. */
export function workspacesFile(webStateDir: string): string {
  return join(webStateDir, 'workspaces.json');
}

/** Workspaces kept in a JSON file (atomic writes, user-only permissions). */
export function fileWorkspaceStore(path: string): WorkspaceStore {
  return {
    async load() {
      try {
        const parsed = JSON.parse(await readFile(path, 'utf8')) as { v?: unknown; workspaces?: unknown };
        if (parsed.v !== 1 || !Array.isArray(parsed.workspaces)) return [];
        return parsed.workspaces.filter(isRecord);
      } catch {
        return []; // none yet, or unreadable: start from the launch directory
      }
    },
    async save(records) {
      await ensureDir(dirname(path));
      await writePrivate(path, `${JSON.stringify({ v: 1, workspaces: records }, null, 2)}\n`);
    },
  };
}

/** Workspaces kept in memory only — `--mock` servers and tests. */
export function memoryWorkspaceStore(initial: WorkspaceRecord[] = []): WorkspaceStore {
  let records = [...initial];
  return {
    load: async () => [...records],
    save: async (next) => {
      records = [...next];
    },
  };
}

function isRecord(value: unknown): value is WorkspaceRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.root === 'string' &&
    typeof r.addedAt === 'number' &&
    typeof r.lastUsedAt === 'number'
  );
}
