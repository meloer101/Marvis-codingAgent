import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SessionSummary, Workspace } from '@harness-code/protocol';

import { SessionSidebar } from './SessionSidebar';
import { focusPane, useFocusedPane } from '@/lib/split';
import { useAppStore } from '@/lib/store';
import type { SessionSync } from '@/lib/sync';
import { SyncProvider } from '@/lib/syncContext';

afterEach(() => {
  cleanup();
  focusPane(0);
  window.location.hash = '';
  useAppStore.setState({ status: 'closed', workspaces: [], sessions: [] });
  window.localStorage.clear();
});

const ws = (id: string, name: string): Workspace => ({
  id,
  root: `/code/${name}`,
  name,
  projectRoot: `/code/${name}`,
  lastUsedAt: 1,
  defaults: { model: 'm', mode: 'ask', modes: ['ask'], effortLevels: [] },
});
const row = (id: string, workspaceId: string, title: string, over: Partial<SessionSummary> = {}): SessionSummary => ({
  id,
  workspaceId,
  title,
  mtimeMs: Date.now(),
  live: false,
  running: false,
  pending: false,
  pinned: false,
  archived: false,
  rev: 1,
  ...over,
});

function renderSidebar(onScreen: { activeId: string | null; shown?: string[] } = { activeId: null }) {
  const sync = {
    updateSession: vi.fn(async () => null),
    deleteSession: vi.fn(async () => {}),
    removeWorkspace: vi.fn(async () => {}),
    setAddProjectOpen: vi.fn(),
  };
  useAppStore.setState({
    status: 'open',
    workspaces: [ws('aaa', 'alpha'), ws('bbb', 'beta')],
    sessions: [
      row('s1', 'aaa', 'fix the login flake'),
      row('s2', 'bbb', 'write the docs', { pending: true }),
      row('s3', 'aaa', 'old experiment', { archived: true }),
    ],
  });
  render(
    <SyncProvider sync={sync as unknown as SessionSync}>
      <SessionSidebar {...onScreen} onNew={() => {}} />
    </SyncProvider>,
  );
  return sync;
}

describe('SessionSidebar in split view', () => {
  it('opens a row beside the session on screen with ⌥-click, and focuses one already on screen', () => {
    window.location.hash = '#/s/s1';
    renderSidebar({ activeId: 's1', shown: ['s1'] });
    const docs = screen.getByRole('link', { name: /write the docs/ });
    expect(docs.getAttribute('href')).toBe('#/s/s2'); // a plain click: in the focused pane
    fireEvent.click(docs, { altKey: true });
    expect(window.location.hash).toBe('#/s/s1/s2');
    cleanup();

    let pane = -1;
    const Probe = () => {
      pane = useFocusedPane();
      return null;
    };
    render(<Probe />);
    expect(pane).toBe(1); // the new pane has the focus
    renderSidebar({ activeId: 's2', shown: ['s1', 's2'] });
    fireEvent.click(screen.getByRole('link', { name: /fix the login flake/ }));
    expect(window.location.hash).toBe('#/s/s1/s2'); // still both
    expect(pane).toBe(0);
  });
});

describe('SessionSidebar', () => {
  it('groups sessions under their projects, archived ones folded away', () => {
    renderSidebar();
    const alpha = screen.getByText('alpha').closest('section')!;
    expect(within(alpha).getByText('fix the login flake')).toBeTruthy();
    expect(within(alpha).queryByText('old experiment')).toBeNull();
    fireEvent.click(within(alpha).getByText('Archived (1)'));
    expect(within(alpha).getByText('old experiment')).toBeTruthy();
    const beta = screen.getByText('beta').closest('section')!;
    expect(within(beta).getByTitle('Waiting for you')).toBeTruthy();
    expect(within(beta).getByLabelText('New session in beta').getAttribute('href')).toBe('#/new/bbb');
  });

  it('filters every project by title, and folds a project away', () => {
    renderSidebar();
    fireEvent.change(screen.getByLabelText('Search sessions'), { target: { value: 'docs' } });
    expect(screen.queryByText('alpha')).toBeNull();
    expect(screen.getByText('write the docs')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Search sessions'), { target: { value: '' } });
    fireEvent.click(screen.getByText('alpha'));
    expect(screen.queryByText('fix the login flake')).toBeNull();
  });

  it('renames in place: double-click, type, Enter', async () => {
    const sync = renderSidebar();
    fireEvent.doubleClick(screen.getByText('fix the login flake'));
    const input = screen.getByLabelText('Session title');
    fireEvent.change(input, { target: { value: 'Login flake' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(sync.updateSession).toHaveBeenCalledWith('s1', { title: 'Login flake' }));
  });

  it('deletes only after the confirmation', async () => {
    const sync = renderSidebar();
    const trigger = screen.getByLabelText('fix the login flake actions');
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    fireEvent.click(await screen.findByText('Delete…'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('fix the login flake')).toBeTruthy();
    expect(sync.deleteSession).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(sync.deleteSession).toHaveBeenCalledWith('s1'));
  });
});
