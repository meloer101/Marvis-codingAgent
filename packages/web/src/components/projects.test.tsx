import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Workspace, WorkspaceInspection } from '@harness-code/protocol';

import { AddProjectDialog } from './AddProjectDialog';
import { DraftView } from './DraftView';
import { useAppStore } from '@/lib/store';
import type { SessionSync } from '@/lib/sync';
import { SyncProvider } from '@/lib/syncContext';

afterEach(() => {
  cleanup();
  window.location.hash = '';
  useAppStore.setState({ status: 'closed', workspaces: [], sessions: [], models: {}, branches: {}, addProjectOpen: false, error: null });
  window.localStorage.clear();
});

const workspace = (id: string, name: string, over: Partial<Workspace['defaults']> = {}): Workspace => ({
  id,
  root: `/code/${name}`,
  name,
  projectRoot: `/code/${name}`,
  lastUsedAt: 1,
  defaults: {
    model: 'deepseek/deepseek-flash',
    mode: 'ask',
    modes: ['ask', 'plan', 'acceptEdits'],
    effort: 'high',
    effortLevels: ['low', 'high', 'max'],
    ...over,
  },
});

function fakeSync(over: Record<string, unknown> = {}) {
  return {
    startSession: vi.fn(async () => 'new-session'),
    setHelpOpen: vi.fn(),
    setAddProjectOpen: vi.fn((open: boolean) => useAppStore.setState({ addProjectOpen: open })),
    suggestDirs: vi.fn(async () => []),
    inspectPath: vi.fn(async () => null),
    addWorkspace: vi.fn(async () => null),
    loadModels: vi.fn(async () => {}),
    loadBranches: vi.fn(async () => {}),
    showError: vi.fn(),
    ...over,
  };
}

/** Radix opens its menus on pointerdown. */
function openMenu(label: string): void {
  fireEvent.pointerDown(screen.getByLabelText(label), { button: 0, ctrlKey: false, pointerType: 'mouse' });
}

describe('DraftView', () => {
  it('offers a worktree off one of the branches, and remembers the choice for the project', async () => {
    const sync = fakeSync();
    useAppStore.setState({
      status: 'open',
      workspaces: [workspace('aaa', 'alpha')],
      branches: { aaa: { repo: true, current: 'main', branches: ['main', 'feature/login'] } },
    });
    const draft = (
      <SyncProvider sync={sync as unknown as SessionSync}>
        <DraftView workspaceId="aaa" />
      </SyncProvider>
    );
    const { unmount } = render(draft);
    expect(sync.loadBranches).toHaveBeenCalledWith('aaa');
    expect(screen.getByLabelText('Where it works').textContent).toBe('Local');
    openMenu('Where it works');
    expect(await screen.findByText('Edits your checkout directly — on main')).toBeTruthy();
    fireEvent.click(await screen.findByText('feature/login'));
    expect(screen.getByLabelText('Where it works').textContent).toBe('Worktreefeature/login');
    const box = screen.getByRole('textbox');
    fireEvent.change(box, { target: { value: 'fix it' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() =>
      expect(sync.startSession).toHaveBeenCalledWith('fix it', {
        workspaceId: 'aaa',
        mode: 'ask',
        effort: 'high',
        worktree: { base: 'feature/login' },
      }),
    );
    unmount();

    // The next draft there starts from the same choice; a branch since deleted falls back to the current one.
    act(() => useAppStore.setState({ branches: { aaa: { repo: true, current: 'main', branches: ['main'] } } }));
    render(draft);
    expect(screen.getByLabelText('Where it works').textContent).toBe('Worktreemain');
  });

  it('offers no worktree outside a repository', () => {
    useAppStore.setState({ status: 'open', workspaces: [workspace('aaa', 'alpha')], branches: { aaa: { repo: false } } });
    render(
      <SyncProvider sync={fakeSync() as unknown as SessionSync}>
        <DraftView workspaceId="aaa" />
      </SyncProvider>,
    );
    expect(screen.queryByLabelText('Where it works')).toBeNull();
  });

  it("starts the session in the route's project, with the mode and effort picked", async () => {
    const sync = fakeSync();
    useAppStore.setState({
      status: 'open',
      workspaces: [workspace('aaa', 'alpha'), workspace('bbb', 'beta', { effortLevels: [], effort: undefined })],
      sessions: [
        { id: 's1', workspaceId: 'aaa', title: 'fix the login flake', mtimeMs: 1, live: false, running: false, pending: false, pinned: false, archived: false, rev: 1 },
        { id: 's2', workspaceId: 'bbb', title: 'elsewhere', mtimeMs: 1, live: false, running: false, pending: false, pinned: false, archived: false, rev: 1 },
      ],
    });
    render(
      <SyncProvider sync={sync as unknown as SessionSync}>
        <DraftView workspaceId="aaa" />
      </SyncProvider>,
    );
    expect(screen.getByText('alpha', { selector: 'span' })).toBeTruthy(); // "What are we working on in alpha?"
    expect(screen.getByText('fix the login flake')).toBeTruthy();
    expect(screen.queryByText('elsewhere')).toBeNull(); // another project's session
    expect((screen.getByLabelText('Project') as HTMLSelectElement).value).toBe('aaa');

    openMenu('Permission mode');
    fireEvent.click(await screen.findByText('Plan'));
    openMenu('Reasoning effort');
    fireEvent.click(await screen.findByText('Max'));
    const box = screen.getByRole('textbox');
    fireEvent.change(box, { target: { value: 'hello' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() =>
      expect(sync.startSession).toHaveBeenCalledWith('hello', { workspaceId: 'aaa', mode: 'plan', effort: 'max' }),
    );
  });

  it('starts on the model picked, with that model\'s effort levels and key status', async () => {
    const sync = fakeSync();
    useAppStore.setState({
      status: 'open',
      workspaces: [workspace('aaa', 'alpha')],
      models: {
        aaa: [
          { ref: 'deepseek/deepseek-flash', contextWindow: 1, maxOutputTokens: 1, effortLevels: ['low', 'high', 'max'], defaultEffort: 'high' },
          { ref: 'moonshot/kimi-k2', contextWindow: 1, maxOutputTokens: 1, effortLevels: [] },
        ],
      },
    });
    render(
      <SyncProvider sync={sync as unknown as SessionSync}>
        <DraftView workspaceId="aaa" />
      </SyncProvider>,
    );
    openMenu('Model');
    expect(sync.loadModels).toHaveBeenCalledWith('aaa');
    fireEvent.click(await screen.findByText('moonshot/kimi-k2'));
    expect(screen.queryByLabelText('Reasoning effort')).toBeNull(); // kimi has no reasoning
    const box = screen.getByRole('textbox');
    fireEvent.change(box, { target: { value: 'hi' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() =>
      expect(sync.startSession).toHaveBeenCalledWith('hi', { workspaceId: 'aaa', mode: 'ask', model: 'moonshot/kimi-k2' }),
    );
  });

  it('/mode and /effort set the draft\'s choices; /cost waits for a session', async () => {
    const sync = fakeSync();
    useAppStore.setState({ status: 'open', workspaces: [workspace('aaa', 'alpha')] });
    render(
      <SyncProvider sync={sync as unknown as SessionSync}>
        <DraftView workspaceId="aaa" />
      </SyncProvider>,
    );
    const box = screen.getByRole('textbox') as HTMLTextAreaElement;
    for (const line of ['/mode plan', '/effort max']) {
      fireEvent.change(box, { target: { value: line } });
      fireEvent.keyDown(box, { key: 'Enter' });
      await waitFor(() => expect(box.value).toBe(''));
    }
    expect(screen.getByLabelText('Permission mode').textContent).toBe('Plan');
    fireEvent.change(box, { target: { value: '/cost' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(sync.showError).toHaveBeenCalled());
    expect(box.value).toBe('/cost'); // kept, as it wasn't done
    fireEvent.change(box, { target: { value: 'go' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() =>
      expect(sync.startSession).toHaveBeenCalledWith('go', { workspaceId: 'aaa', mode: 'plan', effort: 'max' }),
    );
  });

  it('shows why the default model cannot run in this project', () => {
    useAppStore.setState({
      status: 'open',
      workspaces: [workspace('aaa', 'alpha', { keyProblem: 'DeepSeek needs an API key.' })],
    });
    render(
      <SyncProvider sync={fakeSync() as unknown as SessionSync}>
        <DraftView />
      </SyncProvider>,
    );
    expect(screen.getByText(/DeepSeek needs an API key\./)).toBeTruthy();
    expect(screen.getByText(/~\/\.agent\/\.env/)).toBeTruthy();
  });
});

describe('AddProjectDialog', () => {
  const inspection = (over: Partial<WorkspaceInspection> = {}): WorkspaceInspection => ({
    path: '/code/gamma',
    exists: true,
    isDirectory: true,
    root: '/code/gamma',
    projectRoot: '/code/gamma',
    git: true,
    needsMarker: false,
    mcpServers: [],
    warnings: [],
    ...over,
  });

  function open(sync: ReturnType<typeof fakeSync>) {
    useAppStore.setState({ status: 'open', addProjectOpen: true });
    render(
      <SyncProvider sync={sync as unknown as SessionSync}>
        <AddProjectDialog />
      </SyncProvider>,
    );
    return screen.getByLabelText('Project folder') as HTMLInputElement;
  }

  it('shows what trusting a project means, then adds it and opens a draft there', async () => {
    const sync = fakeSync({
      inspectPath: vi.fn(async () =>
        inspection({
          mcpServers: [{ name: 'fs', transport: 'stdio', command: 'npx -y server-filesystem .' }],
          warnings: ['Its settings start sessions in YOLO mode: nothing asks before running.'],
        }),
      ),
      addWorkspace: vi.fn(async () => workspace('ccc', 'gamma')),
    });
    const input = open(sync);
    fireEvent.change(input, { target: { value: '~/code/gamma' } });
    await screen.findByText('npx -y server-filesystem .');
    expect(screen.getByText(/YOLO mode/)).toBeTruthy();
    const button = await screen.findByRole('button', { name: 'Trust and add' });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    await waitFor(() => expect(sync.addWorkspace).toHaveBeenCalledWith('~/code/gamma', {}));
    await waitFor(() => expect(window.location.hash).toBe('#/new/ccc'));
    expect(useAppStore.getState().addProjectOpen).toBe(false);
  });

  it('asks to create .agent/ for a plain folder, and refuses what cannot be a project', async () => {
    const answers: Record<string, WorkspaceInspection> = {
      '~/notes': inspection({ path: '/home/notes', root: '/home/notes', git: false, needsMarker: true }),
      '~': inspection({ problem: 'Your home directory is too broad for a project: pick a folder inside it' }),
    };
    const sync = fakeSync({
      inspectPath: vi.fn(async (path: string) => answers[path] ?? null),
      addWorkspace: vi.fn(async () => workspace('ddd', 'notes')),
    });
    const input = open(sync);
    fireEvent.change(input, { target: { value: '~' } });
    await screen.findByText(/too broad/);
    expect((screen.getByRole('button', { name: 'Add project' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(input, { target: { value: '~/notes' } });
    await screen.findByText(/creates/);
    const add = screen.getByRole('button', { name: 'Add project' }) as HTMLButtonElement;
    await waitFor(() => expect(add.disabled).toBe(false));
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    await waitFor(() => expect(sync.addWorkspace).toHaveBeenCalledWith('~/notes', { createMarker: true }));
  });
});
