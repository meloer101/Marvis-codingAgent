import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GitStatus } from '@harness-code/protocol';

import { ChangesPanel, changeLetter } from './ChangesPanel';
import { useAppStore } from '@/lib/store';
import type { SessionSync } from '@/lib/sync';
import { SyncProvider } from '@/lib/syncContext';

afterEach(() => {
  cleanup();
  useAppStore.setState({ git: {}, gitRev: {} });
});

const status: GitStatus = {
  repo: true,
  branch: 'feature',
  upstream: 'origin/feature',
  ahead: 2,
  behind: 0,
  files: [
    { path: 'src/math.ts', staged: 'modified', unstaged: 'modified', added: 3, removed: 1 },
    { path: 'new.txt', unstaged: 'untracked', added: 2, removed: 0 },
    { path: 'logo.png', staged: 'added', binary: true },
  ],
};

function renderPanel(gitDiff = vi.fn(async () => ({ kind: 'text' as const, patch: '@@ -1 +1 @@\n-let a = 1;\n+let a = 2;\n' }))) {
  const release = vi.fn();
  const sync = { watchGit: vi.fn(() => release), loadGitStatus: vi.fn(async () => {}), gitDiff };
  render(
    <SyncProvider sync={sync as unknown as SessionSync}>
      <ChangesPanel workspaceId="w1" />
    </SyncProvider>,
  );
  return { sync, release, gitDiff };
}

describe('ChangesPanel', () => {
  it('watches the workspace while shown, and lists the branch and each changed file', () => {
    const { sync, release } = renderPanel();
    expect(sync.watchGit).toHaveBeenCalledWith('w1');
    expect(screen.getByText('Reading git…')).toBeTruthy();
    act(() => useAppStore.setState({ git: { w1: status } }));
    expect(screen.getByText('feature')).toBeTruthy();
    expect(screen.getByText('↑2')).toBeTruthy();
    expect(screen.getByText('3 files changed')).toBeTruthy();
    const math = screen.getByRole('button', { name: /math\.ts/ });
    expect(math.textContent).toContain('M');
    expect(math.textContent).toContain('+3');
    expect(screen.getByRole('button', { name: /logo\.png/ }).textContent).toContain('binary');
    cleanup();
    expect(release).toHaveBeenCalled();
  });

  it("opens a file to its diff, and fetches it again when the project's files change", async () => {
    const { gitDiff } = renderPanel();
    act(() => useAppStore.setState({ git: { w1: status } }));
    fireEvent.click(screen.getByRole('button', { name: /math\.ts/ }));
    expect(await screen.findByText('@@ -1 +1 @@')).toBeTruthy();
    expect(gitDiff).toHaveBeenCalledWith('w1', 'src/math.ts');
    await act(async () => useAppStore.setState({ gitRev: { w1: 1 } }));
    expect(gitDiff).toHaveBeenCalledTimes(2);
  });

  it('says so outside a repository, and when nothing changed', () => {
    renderPanel();
    act(() => useAppStore.setState({ git: { w1: { repo: false } } }));
    expect(screen.getByText('Not a git repository.')).toBeTruthy();
    act(() => useAppStore.setState({ git: { w1: { ...status, files: [] } } }));
    expect(screen.getByText('No changes.')).toBeTruthy();
  });
});

describe('changeLetter', () => {
  it('picks the most telling side', () => {
    expect(changeLetter({ path: 'a', unstaged: 'untracked' }).letter).toBe('U');
    expect(changeLetter({ path: 'a', staged: 'modified', unstaged: 'deleted' }).letter).toBe('D');
    expect(changeLetter({ path: 'a', staged: 'renamed', oldPath: 'b' }).letter).toBe('R');
    expect(changeLetter({ path: 'a', staged: 'conflicted', unstaged: 'conflicted' }).letter).toBe('!');
  });
});
