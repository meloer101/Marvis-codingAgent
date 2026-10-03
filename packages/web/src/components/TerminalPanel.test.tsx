import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TerminalInfo } from '@harness-code/protocol';

import { TerminalPanel } from './TerminalPanel';
import { useAppStore } from '@/lib/store';
import type { SessionSync } from '@/lib/sync';
import { SyncProvider } from '@/lib/syncContext';
import { setTerminalOpen } from '@/lib/terminalPanel';

// xterm.js needs a real browser; the panel's own behaviour is what's tested here.
vi.mock('@/components/XTermView', () => ({
  XTermView: ({ id, visible }: { id: string; visible: boolean }) => (
    <div data-testid="xterm" data-id={id} data-visible={String(visible)} />
  ),
}));

afterEach(() => {
  cleanup();
  act(() => setTerminalOpen(false));
  useAppStore.setState({ info: null, terminals: {} });
});

const term = (id: string, over: Partial<TerminalInfo> = {}): TerminalInfo => ({
  id,
  workspaceId: 'w1',
  title: 'zsh',
  cwd: '/proj',
  createdAt: 0,
  ...over,
});

function renderPanel(terminal = true) {
  const sync = {
    loadTerminals: vi.fn(async () => {}),
    createTerminal: vi.fn(async () => {
      const t = term(`t${(useAppStore.getState().terminals['w1']?.length ?? 0) + 1}`);
      useAppStore.setState((s) => ({ terminals: { ...s.terminals, w1: [...(s.terminals['w1'] ?? []), t] } }));
      return t;
    }),
    closeTerminal: vi.fn(async () => {}),
  };
  useAppStore.setState({ info: { capabilities: { terminal } } as never });
  render(
    <SyncProvider sync={sync as unknown as SessionSync}>
      <TerminalPanel workspaceId="w1" />
    </SyncProvider>,
  );
  return sync;
}

describe('TerminalPanel', () => {
  it('shows nothing until opened, then starts a shell in a project without one', async () => {
    const sync = renderPanel();
    expect(screen.queryByRole('region', { name: 'Terminal' })).toBeNull();
    act(() => useAppStore.setState({ terminals: { w1: [] } }));
    await act(async () => setTerminalOpen(true));
    expect(sync.loadTerminals).toHaveBeenCalledWith('w1');
    expect(sync.createTerminal).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('tab', { name: /zsh 1/ })).toBeTruthy();
  });

  it('switches between tabs, keeping every view mounted, and closes one', async () => {
    const sync = renderPanel();
    act(() => useAppStore.setState({ terminals: { w1: [term('a'), term('b', { exitCode: 1 })] } }));
    await act(async () => setTerminalOpen(true));
    expect(sync.createTerminal).not.toHaveBeenCalled();
    const views = () => screen.getAllByTestId('xterm').map((v) => [v.dataset['id'], v.dataset['visible']]);
    expect(views()).toEqual([
      ['a', 'false'],
      ['b', 'true'],
    ]);
    expect(screen.getByRole('tab', { name: /zsh 2/ }).textContent).toContain('exited');
    fireEvent.click(screen.getByRole('tab', { name: /zsh 1/ }));
    expect(views()).toEqual([
      ['a', 'true'],
      ['b', 'false'],
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Close zsh 1' }));
    expect(sync.closeTerminal).toHaveBeenCalledWith('a');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'New terminal' })));
    expect(sync.createTerminal).toHaveBeenCalledTimes(1);
  });

  it('says why when this server has no terminals', async () => {
    const sync = renderPanel(false);
    act(() => useAppStore.setState({ terminals: { w1: [] } }));
    await act(async () => setTerminalOpen(true));
    expect(screen.getByText(/couldn’t be loaded/)).toBeTruthy();
    expect(sync.createTerminal).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'New terminal' })).toBeNull();
  });
});
