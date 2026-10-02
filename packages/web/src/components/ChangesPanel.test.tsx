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

function renderPanel(
  gitDiff = vi.fn(async () => ({ kind: 'text' as const, patch: '@@ -1 +1 @@\n-let a = 1;\n+let a = 2;\n' })),
  sessionPaths?: ReadonlySet<string>,
) {
  const release = vi.fn();
  const sync = {
    watchGit: vi.fn(() => release),
    loadGitStatus: vi.fn(async () => {}),
    gitDiff,
    gitStage: vi.fn(async () => {}),
    gitUnstage: vi.fn(async () => {}),
    gitRevert: vi.fn(async () => {}),
    gitCommit: vi.fn(async () => ({ sha: 'abc1234', summary: 'Fix math' })),
    gitPush: vi.fn(async () => {}),
    gitCreatePr: vi.fn(async () => ({ url: 'https://github.com/o/r/pull/7' })),
  };
  render(
    <SyncProvider sync={sync as unknown as SessionSync}>
      <ChangesPanel workspaceId="w1" {...(sessionPaths ? { sessionPaths } : {})} />
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
    expect(screen.getByText('3 changed')).toBeTruthy();
    const math = screen.getByRole('button', { name: /math\.ts/, expanded: false });
    expect(math.textContent).toContain('M');
    expect(math.textContent).toContain('+3');
    expect(screen.getByRole('button', { name: /logo\.png/, expanded: false }).textContent).toContain('binary');
    cleanup();
    expect(release).toHaveBeenCalled();
  });

  it("opens a file to its diff, and fetches it again when the project's files change", async () => {
    const { gitDiff } = renderPanel();
    act(() => useAppStore.setState({ git: { w1: status } }));
    fireEvent.click(screen.getByRole('button', { name: /math\.ts/, expanded: false }));
    expect(await screen.findByText('@@ -1 +1 @@')).toBeTruthy();
    expect(gitDiff).toHaveBeenCalledWith('w1', 'src/math.ts');
    await act(async () => useAppStore.setState({ gitRev: { w1: 1 } }));
    expect(gitDiff).toHaveBeenCalledTimes(2);
  });

  it("narrows to the files this session's edits and writes touched", () => {
    renderPanel(undefined, new Set(['src/math.ts']));
    act(() => useAppStore.setState({ git: { w1: status } }));
    expect(screen.getByRole('radio', { name: /All/ }).textContent).toContain('3');
    const mine = screen.getByRole('radio', { name: /This session/ });
    expect(mine.textContent).toContain('1');
    fireEvent.click(mine);
    expect(screen.getByRole('button', { name: /math\.ts/, expanded: false })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /new\.txt/, expanded: false })).toBeNull();
  });

  it('says so outside a repository, and when nothing changed', () => {
    renderPanel();
    act(() => useAppStore.setState({ git: { w1: { repo: false } } }));
    expect(screen.getByText('Not a git repository.')).toBeTruthy();
    act(() => useAppStore.setState({ git: { w1: { ...status, files: [] } } }));
    expect(screen.getByText('No changes.')).toBeTruthy();
  });
});

describe('changing git state from the panel', () => {
  it('stages what is not fully staged and unstages what is, both ends of a rename', () => {
    const { sync } = renderPanel();
    act(() =>
      useAppStore.setState({
        git: { w1: { ...status, files: [...status.files, { path: 'new.ts', oldPath: 'old.ts', staged: 'renamed' }] } },
      }),
    );
    fireEvent.click(screen.getByRole('checkbox', { name: 'Stage new.txt' }));
    expect(sync.gitStage).toHaveBeenCalledWith('w1', ['new.txt']);
    // Partly staged: staging takes the rest.
    expect(screen.getByRole('checkbox', { name: 'Stage src/math.ts' }).getAttribute('aria-checked')).toBe('mixed');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Stage src/math.ts' }));
    expect(sync.gitStage).toHaveBeenLastCalledWith('w1', ['src/math.ts']);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Stage new.ts' }));
    expect(sync.gitUnstage).toHaveBeenCalledWith('w1', ['new.ts', 'old.ts']);
  });

  it('discards a change only once confirmed, saying when that deletes the file', () => {
    const { sync } = renderPanel();
    act(() => useAppStore.setState({ git: { w1: status } }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes to new.txt' }));
    expect(screen.getByText(/so it is deleted/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(sync.gitRevert).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes to src/math.ts' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(sync.gitRevert).toHaveBeenCalledWith('w1', ['src/math.ts']);
  });

  it('commits what is staged with ⌘↵, or the files shown when nothing is', async () => {
    const { sync } = renderPanel();
    act(() => useAppStore.setState({ git: { w1: status } }));
    const box = screen.getByRole('textbox', { name: 'Commit message' });
    expect((screen.getByRole('button', { name: /Commit 2 staged/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(box, { target: { value: 'Fix math' } });
    await act(async () => fireEvent.keyDown(box, { key: 'Enter', metaKey: true }));
    expect(sync.gitCommit).toHaveBeenCalledWith('w1', 'Fix math', undefined);
    expect(screen.getByRole('status').textContent).toContain('Committed abc1234');
    expect((box as HTMLTextAreaElement).value).toBe('');

    act(() => useAppStore.setState({ git: { w1: { ...status, files: [{ path: 'new.txt', unstaged: 'untracked' }] } } }));
    fireEvent.change(box, { target: { value: 'Add it' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /Commit 1 file/ })));
    expect(sync.gitCommit).toHaveBeenLastCalledWith('w1', 'Add it', ['new.txt']);
  });

  it("pushes, opens a pull request, and shows git's reason when something fails", async () => {
    const { sync } = renderPanel();
    act(() => useAppStore.setState({ git: { w1: status } }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /Push/ })));
    expect(sync.gitPush).toHaveBeenCalledWith('w1');
    fireEvent.click(screen.getByRole('button', { name: /Pull request/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Pull request title' }), { target: { value: 'Fix math' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Create' })));
    expect(sync.gitCreatePr).toHaveBeenCalledWith('w1', { title: 'Fix math' });
    expect(screen.getByText('github.com/o/r/pull/7')).toBeTruthy();

    sync.gitPush.mockRejectedValueOnce(new Error('rejected: non-fast-forward'));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /Push/ })));
    expect(screen.getByRole('alert').textContent).toContain('non-fast-forward');
  });

  it('publishes a branch without an upstream, and holds the pull request until then', () => {
    renderPanel();
    const { upstream: _, ...unpublished } = status;
    act(() => useAppStore.setState({ git: { w1: unpublished } }));
    expect(screen.getByRole('button', { name: /Publish/ })).toBeTruthy();
    expect((screen.getByRole('button', { name: /Pull request/ }) as HTMLButtonElement).disabled).toBe(true);
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
