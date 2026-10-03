import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SessionSnapshot, SessionSummary } from '@harness-code/protocol';

import { ArchiveConflictDialog } from './ArchiveConflictDialog';
import { SessionHeader } from './SessionHeader';
import { SidePanel } from './SidePanel';
import { setPanel } from '@/lib/panel';
import { stateFromSnapshot } from '@/lib/sessionModel';
import { useAppStore } from '@/lib/store';
import type { SessionSync } from '@/lib/sync';
import { SyncProvider } from '@/lib/syncContext';

afterEach(() => {
  cleanup();
  act(() => setPanel(null));
  useAppStore.setState({ workspaces: [], sessions: [], archiveConflict: null });
});

const worktree = { branch: 'hc/fix-login-1a2b', base: 'main', path: '/home/.agent/worktrees/proj-x/fix-login-1a2b', cwd: '/home/.agent/worktrees/proj-x/fix-login-1a2b' };

const row = (over: Partial<SessionSummary> = {}): SessionSummary => ({
  id: 's1',
  workspaceId: 'w1',
  title: 'Fix the login bug',
  mtimeMs: 1,
  live: false,
  running: false,
  pending: false,
  pinned: false,
  archived: false,
  worktree: { branch: worktree.branch },
  rev: 1,
  ...over,
});

const snapshot: SessionSnapshot = {
  id: 's1',
  workspaceId: 'w1',
  modelRef: 'mock/m',
  mode: 'ask',
  transcript: [],
  running: false,
  lastSeq: 0,
  worktree,
};

function withSync(node: React.ReactNode, sync: Record<string, unknown> = {}) {
  return <SyncProvider sync={sync as unknown as SessionSync}>{node}</SyncProvider>;
}

describe('a session in a worktree', () => {
  it('shows its branch in the header, muted once archiving removed the worktree', () => {
    useAppStore.setState({
      workspaces: [{ id: 'w1', root: '/proj', name: 'proj', projectRoot: '/proj', lastUsedAt: 0, defaults: {} as never }],
      sessions: [row()],
    });
    render(withSync(<SessionHeader view={stateFromSnapshot(snapshot)} />));
    const chip = screen.getByText(worktree.branch).parentElement!;
    expect(chip.title).toContain('branched from main');
    act(() => useAppStore.setState({ sessions: [row({ archived: true, worktree: { branch: worktree.branch, missing: true } })] }));
    expect(screen.getByText(worktree.branch).parentElement!.title).toContain('checked out again');
  });

  it('says where its changes went while the worktree is gone', () => {
    act(() => setPanel('changes'));
    render(
      withSync(
        <SidePanel view={stateFromSnapshot(snapshot)} checkout={{ workspaceId: 'w1', sessionId: 's1', root: worktree.cwd, missing: true }} />,
      ),
    );
    expect(screen.getByText(/worktree was removed when it was archived/)).toBeTruthy();
  });

  it('archives over uncommitted changes only once confirmed', () => {
    const sync = { updateSession: vi.fn(async () => null), dismissArchiveConflict: vi.fn(() => useAppStore.setState({ archiveConflict: null })) };
    useAppStore.setState({
      sessions: [row()],
      archiveConflict: { id: 's1', reason: 'its worktree has 2 uncommitted changes, which archiving would throw away' },
    });
    render(withSync(<ArchiveConflictDialog />, sync));
    expect(screen.getByText(/^Its worktree has 2 uncommitted changes, which archiving would throw away\./)).toBeTruthy();
    expect(screen.getByText(/stays on its branch hc\/fix-login-1a2b/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Discard and archive' }));
    expect(sync.updateSession).toHaveBeenCalledWith('s1', { archived: true, force: true });
    expect(sync.dismissArchiveConflict).toHaveBeenCalled();
  });
});
