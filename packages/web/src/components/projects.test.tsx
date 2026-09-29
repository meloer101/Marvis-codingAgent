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
  useAppStore.setState({ status: 'closed', workspaces: [], sessions: [], addProjectOpen: false, error: null });
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
    ...over,
  };
}

describe('DraftView', () => {
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

    fireEvent.change(screen.getByLabelText('Permission mode'), { target: { value: 'plan' } });
    fireEvent.change(screen.getByLabelText('Reasoning effort'), { target: { value: 'max' } });
    const box = screen.getByRole('textbox');
    fireEvent.change(box, { target: { value: 'hello' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() =>
      expect(sync.startSession).toHaveBeenCalledWith('hello', { workspaceId: 'aaa', mode: 'plan', effort: 'max' }),
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
