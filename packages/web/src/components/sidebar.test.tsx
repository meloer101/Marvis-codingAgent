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

function renderSidebar(
  onScreen: { activeId: string | null; shown?: string[] } = { activeId: null },
  sessions: SessionSummary[] = [
    row('s1', 'aaa', 'fix the login flake'),
    row('s2', 'bbb', 'write the docs', { pending: true }),
    row('s3', 'aaa', 'old experiment', { archived: true }),
  ],
) {
  const sync = {
    updateSession: vi.fn(async () => null),
    deleteSession: vi.fn(async () => {}),
    removeWorkspace: vi.fn(async () => {}),
    setAddProjectOpen: vi.fn(),
  };
  useAppStore.setState({
    status: 'open',
    workspaces: [ws('aaa', 'alpha'), ws('bbb', 'beta')],
    sessions,
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

describe('SessionSidebar selection', () => {
  // Shown top to bottom: alpha — s1, s4; beta — s2, s5.
  const many = (): SessionSummary[] => [
    row('s1', 'aaa', 'fix the login flake', { mtimeMs: 4 }),
    row('s4', 'aaa', 'add the usage page', { mtimeMs: 3 }),
    row('s2', 'bbb', 'write the docs', { mtimeMs: 2 }),
    row('s5', 'bbb', 'run the evals', { mtimeMs: 1, running: true }),
  ];
  const link = (title: string) => screen.getByRole('link', { name: new RegExp(title) });
  const isSelected = (title: string) => link(title).hasAttribute('data-selected');

  it('⇧-click selects from the session on screen across projects, and deletes them one by one', async () => {
    window.location.hash = '#/s/s1';
    const sync = renderSidebar({ activeId: 's1', shown: ['s1'] }, many());
    fireEvent.click(link('write the docs'), { shiftKey: true });
    expect(window.location.hash).toBe('#/s/s1'); // selecting opens nothing
    expect(['fix the login flake', 'add the usage page', 'write the docs'].every(isSelected)).toBe(true);
    expect(isSelected('run the evals')).toBe(false);
    expect(screen.getByText('3 selected')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Delete…/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Delete 3 sessions?')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(sync.deleteSession).toHaveBeenCalledTimes(3));
    expect(sync.deleteSession.mock.calls.map((c) => (c as unknown[])[0])).toEqual(['s1', 's4', 's2']);
    await waitFor(() => expect(window.location.hash).toBe('#/new/aaa')); // the session on screen went
    expect(screen.queryByText('3 selected')).toBeNull();
  });

  it('⌘-click adds and drops one at a time; a plain click or Esc lets go', () => {
    renderSidebar({ activeId: null }, many());
    fireEvent.click(link('add the usage page'), { metaKey: true });
    fireEvent.click(link('write the docs'), { metaKey: true });
    expect(screen.getByText('2 selected')).toBeTruthy();
    fireEvent.click(link('add the usage page'), { ctrlKey: true });
    expect(screen.getByText('1 selected')).toBeTruthy();
    expect(isSelected('write the docs')).toBe(true);

    fireEvent.keyDown(link('write the docs'), { key: 'Escape' });
    expect(screen.queryByText(/selected$/)).toBeNull();

    fireEvent.click(link('write the docs'), { metaKey: true });
    fireEvent.click(link('fix the login flake'));
    expect(screen.queryByText(/selected$/)).toBeNull();
  });

  it('keeps running sessions, and offers the selection in a selected row’s menu', async () => {
    const sync = renderSidebar({ activeId: null }, many());
    fireEvent.click(link('write the docs'), { metaKey: true });
    fireEvent.click(link('run the evals'), { shiftKey: true });
    const trigger = screen.getByLabelText('run the evals actions');
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    fireEvent.click(await screen.findByText('Delete 2 sessions…'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('1 of them is running and stays.')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(sync.deleteSession).toHaveBeenCalledWith('s2'));
    expect(sync.deleteSession).toHaveBeenCalledTimes(1);
  });

  it('opens the confirmation with ⌫ from the list, and Esc in it keeps the selection', async () => {
    renderSidebar({ activeId: null }, many());
    fireEvent.click(link('fix the login flake'), { metaKey: true });
    fireEvent.click(link('add the usage page'), { metaKey: true });
    fireEvent.keyDown(link('add the usage page'), { key: 'Backspace' });
    const dialog = await screen.findByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByText('2 selected')).toBeTruthy();
  });
});
