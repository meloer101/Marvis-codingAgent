/**
 * Where a new session works — the project's checkout, or a git worktree of
 * its own branched off a base — as the draft last had it in each project,
 * kept across reloads.
 */

import type { GitBranches } from '@harness-code/protocol';

import { platform } from '@/platform';

export type WorkPlace = { kind: 'local' } | { kind: 'worktree'; base: string };

const key = (workspaceId: string): string => `hc.workPlace.${workspaceId}`;

/** What the draft in `workspaceId` last chose; the project folder by default. */
export function savedWorkPlace(workspaceId: string): WorkPlace {
  const v = platform.storage.get(key(workspaceId));
  return v?.startsWith('wt:') && v.length > 3 ? { kind: 'worktree', base: v.slice(3) } : { kind: 'local' };
}

export function saveWorkPlace(workspaceId: string, place: WorkPlace): void {
  if (place.kind === 'local') platform.storage.remove(key(workspaceId));
  else platform.storage.set(key(workspaceId), `wt:${place.base}`);
}

/**
 * A remembered choice against the branches there are now: a base that is
 * gone falls back to the checked-out branch; no repository (or nothing to
 * branch from), to the project folder. Unchanged while the branches load.
 */
export function usableWorkPlace(place: WorkPlace, branches: GitBranches | undefined): WorkPlace {
  if (place.kind === 'local' || !branches) return place;
  if (!branches.repo || branches.branches.length === 0) return { kind: 'local' };
  if (branches.branches.includes(place.base)) return place;
  return { kind: 'worktree', base: branches.current ?? branches.branches[0]! };
}
