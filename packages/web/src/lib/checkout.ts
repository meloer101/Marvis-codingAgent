/**
 * The directory the side panel and the terminal look at: a project's
 * checkout, or the git worktree a session works in. A worktree's every
 * `fs.*` and `git.*` call carries the session's id, and the server answers
 * for the worktree; the project's carry none.
 */

import { useMemo } from 'react';

import type { SessionWorktree, Workspace } from '@harness-code/protocol';

import { useAppStore } from './store';

export interface Checkout {
  workspaceId: string;
  /** Set for a session's worktree. */
  sessionId?: string;
  /** Where file paths are relative to: the project's root, or where the session works in its worktree. */
  root: string;
  /** The worktree was removed (archiving does that) and comes back with the session's next run. */
  missing?: boolean;
}

/** What a checkout's git state is kept under in the store. */
export function checkoutKey(c: Pick<Checkout, 'workspaceId' | 'sessionId'>): string {
  return c.sessionId ? `${c.workspaceId}/${c.sessionId}` : c.workspaceId;
}

/** The RPC params naming a checkout. */
export function checkoutParams(c: Pick<Checkout, 'workspaceId' | 'sessionId'>): { workspaceId: string; sessionId?: string } {
  return c.sessionId ? { workspaceId: c.workspaceId, sessionId: c.sessionId } : { workspaceId: c.workspaceId };
}

/** Where session `sessionId` works: its worktree when it has one, else its project's checkout. */
export function sessionCheckout(
  workspace: Pick<Workspace, 'id' | 'root'>,
  sessionId: string,
  worktree: SessionWorktree | undefined,
): Checkout {
  return worktree
    ? { workspaceId: workspace.id, sessionId, root: worktree.cwd }
    : { workspaceId: workspace.id, root: workspace.root };
}

/**
 * Where the session on screen works, once its project is known. Whether its
 * worktree is there follows the session's list row, which archiving and the
 * next run update.
 */
export function useSessionCheckout(view: {
  id: string;
  workspaceId?: string | undefined;
  worktree?: SessionWorktree | undefined;
}): Checkout | undefined {
  const workspace = useAppStore((s) => s.workspaces.find((w) => w.id === view.workspaceId));
  const missing = useAppStore((s) => s.sessions.find((r) => r.id === view.id)?.worktree?.missing === true);
  const { id, worktree } = view;
  return useMemo(() => {
    if (!workspace) return undefined;
    const checkout = sessionCheckout(workspace, id, worktree);
    return worktree && missing ? { ...checkout, missing: true } : checkout;
  }, [workspace?.id, workspace?.root, id, worktree?.cwd, missing]);
}
