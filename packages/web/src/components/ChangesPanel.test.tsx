import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GitStatus } from '@harness-code/protocol';

import { ChangesPanel, changeLetter } from './ChangesPanel';
import { clearReview } from '@/lib/review';
import { useAppStore } from '@/lib/store';
import type { SessionSync } from '@/lib/sync';
import { SyncProvider } from '@/lib/syncContext';


const W1 = { workspaceId: 'w1', root: '/proj' };
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
  sessionId?: string,
) {
  const release = vi.fn();
  const sync = {
    watchGit: vi.fn(() => release),
    loadGitStatus: vi.fn(async () => {}),
    gitDiff,
    gitStage: vi.fn(async () => {}),
    gitUnstage: vi.fn(async () => {}),
    gitRevert: vi.fn(async () => {}),
    gitApplyHunk: vi.fn(async () => {}),
    gitCommit: vi.fn(async () => ({ sha: 'abc1234', summary: 'Fix math' })),
    gitPush: vi.fn(async () => {}),
    gitCreatePr: vi.fn(async () => ({ url: 'https://github.com/o/r/pull/7' })),
    send: vi.fn(async () => true),
  };
  render(
    <SyncProvider sync={sync as unknown as SessionSync}>
      <ChangesPanel checkout={W1} {...(sessionId ? { sessionId } : {})} {...(sessionPaths ? { sessionPaths } : {})} />
    </SyncProvider>,
  );
  return { sync, release, gitDiff };
}

describe('ChangesPanel', () => {
  it('watches the workspace while shown, and lists the branch and each changed file', () => {
    const { sync, release } = renderPanel();
    expect(sync.watchGit).toHaveBeenCalledWith(W1);
    expect(screen.getByText('Reading git…')).toBeTruthy();
    act(() => useAppStore.setState({ git: { w1: status } }));
    expect(screen.getByText('feature')).toBeTruthy();
    expect(screen.getByTitle('Commits ahead of / behind its upstream').textContent).toBe('↑2');
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
    // Partly staged: its staged and its unstaged changes, apart.
    expect(await screen.findAllByText('@@ -1 +1 @@')).toHaveLength(2);
    expect(screen.getByRole('region', { name: 'Staged changes' })).toBeTruthy();
    expect(gitDiff).toHaveBeenCalledWith(W1, 'src/math.ts', 'staged');
    expect(gitDiff).toHaveBeenCalledWith(W1, 'src/math.ts', 'unstaged');
    await act(async () => useAppStore.setState({ gitRev: { w1: 1 } }));
    expect(gitDiff).toHaveBeenCalledTimes(4);
  });

  it("narrows to the files this session's edits and writes touched", () => {
    renderPanel(undefined, new Set(['src/math.ts']));
    act(() => useAppStore.setState({ git: { w1: status } }));
    expect(screen.getByRole('radio', { name: 'All, 3' })).toBeTruthy();
    const mine = screen.getByRole('radio', { name: 'This session, 1' });
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
    expect(sync.gitStage).toHaveBeenCalledWith(W1, ['new.txt']);
    // Partly staged: staging takes the rest.
    expect(screen.getByRole('checkbox', { name: 'Stage src/math.ts' }).getAttribute('aria-checked')).toBe('mixed');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Stage src/math.ts' }));
    expect(sync.gitStage).toHaveBeenLastCalledWith(W1, ['src/math.ts']);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Stage new.ts' }));
    expect(sync.gitUnstage).toHaveBeenCalledWith(W1, ['new.ts', 'old.ts']);
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
    expect(sync.gitRevert).toHaveBeenCalledWith(W1, ['src/math.ts']);
  });

  it('commits what is staged with ⌘↵, or the files shown when nothing is', async () => {
    const { sync } = renderPanel();
    act(() => useAppStore.setState({ git: { w1: status } }));
    const box = screen.getByRole('textbox', { name: 'Commit message' });
    expect((screen.getByRole('button', { name: /Commit 2 staged/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(box, { target: { value: 'Fix math' } });
    await act(async () => fireEvent.keyDown(box, { key: 'Enter', metaKey: true }));
    expect(sync.gitCommit).toHaveBeenCalledWith(W1, 'Fix math', undefined);
    expect(screen.getByRole('status').textContent).toContain('Committed abc1234');
    expect((box as HTMLTextAreaElement).value).toBe('');

    act(() => useAppStore.setState({ git: { w1: { ...status, files: [{ path: 'new.txt', unstaged: 'untracked' }] } } }));
    fireEvent.change(box, { target: { value: 'Add it' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /Commit 1 file/ })));
    expect(sync.gitCommit).toHaveBeenLastCalledWith(W1, 'Add it', ['new.txt']);
  });

  it("pushes, opens a pull request, and shows git's reason when something fails", async () => {
    const { sync } = renderPanel();
    act(() => useAppStore.setState({ git: { w1: status } }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /Push/ })));
    expect(sync.gitPush).toHaveBeenCalledWith(W1);
    fireEvent.click(screen.getByRole('button', { name: /Pull request/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Pull request title' }), { target: { value: 'Fix math' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Create' })));
    expect(sync.gitCreatePr).toHaveBeenCalledWith(W1, { title: 'Fix math' });
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

describe('hunks', () => {
  it('stages or discards an unstaged hunk, and unstages a staged one', async () => {
    const { sync } = renderPanel();
    act(() => useAppStore.setState({ git: { w1: status } }));
    fireEvent.click(screen.getByRole('button', { name: /math\.ts/, expanded: false }));
    const unstaged = await screen.findByRole('region', { name: 'Unstaged changes' });
    const staged = screen.getByRole('region', { name: 'Staged changes' });
    const hunk = '@@ -1 +1 @@\n-let a = 1;\n+let a = 2;\n';

    fireEvent.click(within(unstaged).getByRole('button', { name: 'Stage' }));
    expect(sync.gitApplyHunk).toHaveBeenLastCalledWith(W1, 'src/math.ts', hunk, 'stage');
    // Discarding takes a second click.
    fireEvent.click(within(unstaged).getByRole('button', { name: 'Discard' }));
    expect(sync.gitApplyHunk).toHaveBeenCalledTimes(1);
    fireEvent.click(within(unstaged).getByRole('button', { name: 'Discard?' }));
    expect(sync.gitApplyHunk).toHaveBeenLastCalledWith(W1, 'src/math.ts', hunk, 'discard');
    fireEvent.click(within(staged).getByRole('button', { name: 'Unstage' }));
    expect(sync.gitApplyHunk).toHaveBeenLastCalledWith(W1, 'src/math.ts', hunk, 'unstage');
    expect(within(staged).queryByRole('button', { name: 'Stage' })).toBeNull();
  });

  it('are a file at a time for a new file', async () => {
    renderPanel(vi.fn(async () => ({ kind: 'text' as const, patch: '@@ -0,0 +1,2 @@\n+x\n+y\n' })));
    act(() => useAppStore.setState({ git: { w1: status } }));
    fireEvent.click(screen.getByRole('button', { name: /new\.txt/, expanded: false }));
    await screen.findByText('@@ -0,0 +1,2 @@');
    expect(screen.queryByRole('button', { name: 'Stage' })).toBeNull();
  });
});

describe('review comments', () => {
  afterEach(() => {
    clearReview('s1');
    localStorage.clear();
  });

  it("are left on a diff line's number and sent to the session's agent as one message", async () => {
    const { sync } = renderPanel(undefined, undefined, 's1');
    act(() => useAppStore.setState({ git: { w1: status } }));
    fireEvent.click(screen.getByRole('button', { name: /math\.ts/, expanded: false }));
    // Line 1 was removed (old side) and added (new side): comment on the new one —
    // in the unstaged changes only, the staged side's numbers being the index's.
    const lineOnes = await within(await screen.findByRole('region', { name: 'Unstaged changes' })).findAllByRole('button', {
      name: 'Comment on line 1',
    });
    expect(within(screen.getByRole('region', { name: 'Staged changes' })).queryByRole('button', { name: /Comment on line/ })).toBeNull();
    fireEvent.click(lineOnes.at(-1)!);
    const box = screen.getByRole('textbox', { name: 'Review comment' });
    fireEvent.change(box, { target: { value: 'Why 2?' } });
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    expect(screen.getByText('Why 2?')).toBeTruthy();
    expect(screen.getByText('1 review comment')).toBeTruthy();

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send to agent' })));
    expect(sync.send).toHaveBeenCalledWith('s1', expect.stringContaining('`src/math.ts` line 1:\n> let a = 2;\nWhy 2?'));
    expect(screen.queryByText('1 review comment')).toBeNull();
  });

  it('are offered only for a session', async () => {
    renderPanel();
    act(() => useAppStore.setState({ git: { w1: status } }));
    fireEvent.click(screen.getByRole('button', { name: /math\.ts/, expanded: false }));
    await screen.findAllByText('@@ -1 +1 @@');
    expect(screen.queryByRole('button', { name: /Comment on line/ })).toBeNull();
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
