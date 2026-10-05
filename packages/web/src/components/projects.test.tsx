import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProvidersView, Workspace, WorkspaceInspection } from '@harness-code/protocol';

import { AddProjectDialog } from './AddProjectDialog';
import { DraftView } from './DraftView';
import { useAppStore } from '@/lib/store';
import type { SessionSync } from '@/lib/sync';
import { SyncProvider } from '@/lib/syncContext';
import { composerText, pressInComposer, typeInComposer } from '@/test/composer';

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
    typeInComposer('fix it');
    pressInComposer({ key: 'Enter' });
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
    typeInComposer('hello');
    pressInComposer({ key: 'Enter' });
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
    typeInComposer('hi');
    pressInComposer({ key: 'Enter' });
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
    for (const line of ['/mode plan', '/effort max']) {
      typeInComposer(line);
      pressInComposer({ key: 'Enter' });
      await waitFor(() => expect(composerText()).toBe(''));
    }
    expect(screen.getByLabelText('Permission mode').textContent).toBe('Plan');
    typeInComposer('/cost');
    // `/cost` typed out in full: Enter sends it, it isn't completed.
    pressInComposer({ key: 'Enter' });
    await waitFor(() => expect(sync.showError).toHaveBeenCalled());
    expect(composerText()).toBe('/cost'); // kept, as it wasn't done
    typeInComposer('go');
    pressInComposer({ key: 'Enter' });
    await waitFor(() =>
      expect(sync.startSession).toHaveBeenCalledWith('go', { workspaceId: 'aaa', mode: 'plan', effort: 'max' }),
    );
  });

  const providers = (over: Partial<ProvidersView> = {}): ProvidersView => ({
    providers: [
      { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', requiresKey: true, keyVar: 'DEEPSEEK_API_KEY' },
    ],
    envPath: '/home/me/.agent/.env',
    model: 'deepseek/deepseek-flash',
    settingsPath: '/home/me/.agent/settings.json',
    problems: [],
    ...over,
  });

  it('asks for the API key the default model lacks, and saves it for every project', async () => {
    useAppStore.setState({
      status: 'open',
      workspaces: [workspace('aaa', 'alpha', { model: 'deepseek/deepseek-flash', keyProblem: 'DeepSeek needs an API key.' })],
    });
    const settingsCall = vi.fn(async (method: string) => {
      if (method === 'providers.setKey') {
        // The server pushes the workspaces' new state: the model can run now.
        useAppStore.setState({ workspaces: [workspace('aaa', 'alpha', { model: 'deepseek/deepseek-flash' })] });
      }
      return providers();
    });
    const sync = fakeSync({ settingsCall });
    render(
      <SyncProvider sync={sync as unknown as SessionSync}>
        <DraftView />
      </SyncProvider>,
    );
    const field = (await screen.findByLabelText('DeepSeek API key')) as HTMLInputElement;
    expect(field.type).toBe('password');
    expect(screen.getByText('DeepSeek needs an API key')).toBeTruthy();
    expect(screen.getByText('~/.agent/.env')).toBeTruthy();
    expect((screen.getByText('Other providers') as HTMLAnchorElement).getAttribute('href')).toBe('#/settings/models');
    expect((screen.getByText('Save key').closest('button') as HTMLButtonElement).disabled).toBe(true); // nothing typed

    fireEvent.change(field, { target: { value: '  sk-test-key  ' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() =>
      expect(settingsCall).toHaveBeenCalledWith('providers.setKey', { workspaceId: 'aaa', provider: 'deepseek', key: 'sk-test-key' }),
    );
    await waitFor(() => expect(screen.queryByLabelText('DeepSeek API key')).toBeNull()); // nothing left to ask
    expect(sync.loadModels).toHaveBeenCalledWith('aaa');
    expect(document.body.textContent).not.toContain('sk-test-key');
  });

  it('says what is wrong when it is not a missing key, with the way to the settings', async () => {
    useAppStore.setState({
      status: 'open',
      workspaces: [workspace('aaa', 'alpha', { model: 'nowhere/m', keyProblem: 'Unknown provider "nowhere".' })],
    });
    render(
      <SyncProvider sync={fakeSync({ settingsCall: vi.fn(async () => providers()) }) as unknown as SessionSync}>
        <DraftView />
      </SyncProvider>,
    );
    expect(screen.getByText(/Unknown provider "nowhere"\./)).toBeTruthy();
    expect(screen.getByText(/~\/\.agent\/\.env/)).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Other providers')).toBeTruthy());
    expect(screen.queryByPlaceholderText('Paste the key')).toBeNull();
  });
});
