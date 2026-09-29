import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './App';
import { useAppStore } from './lib/store';
import { SessionSync } from './lib/sync';
import { SyncProvider } from './lib/syncContext';

function renderApp() {
  // Never started: no socket, so the view stays on whatever the store holds.
  const sync = new SessionSync({ url: 'ws://unused/ws', token: 't' });
  return render(
    <SyncProvider sync={sync}>
      <App />
    </SyncProvider>,
  );
}

afterEach(() => {
  cleanup();
  window.location.hash = '';
  useAppStore.setState({ status: 'closed', info: null, sessions: [], views: {}, error: null, paletteOpen: false });
});

describe('App', () => {
  it('shows the empty state on the home route', () => {
    renderApp();
    expect(screen.getByText(/bound for the browser/)).toBeTruthy();
  });

  it('shows the reconnecting banner while the socket is down', () => {
    useAppStore.setState({ status: 'reconnecting' });
    renderApp();
    expect(screen.getByText(/reconnecting/)).toBeTruthy();
  });

  it('renders a session view from the store on a session route', () => {
    useAppStore.setState({
      status: 'open',
      views: {
        abc: {
          id: 'abc',
          modelRef: 'mock/mock-model',
          mode: 'ask',
          entries: [
            { kind: 'user', id: 0, text: 'hello there' },
            { kind: 'assistant', id: 1, thinking: '', text: 'General Kenobi', tools: [] },
          ],
          live: { thinking: '', text: '', tools: [] },
          pendingAsk: null,
          pendingPlan: null,
          running: false,
          hydrating: false,
          effortLevels: [],
          queue: [],
          askId: null,
          planId: null,
        },
      },
    });
    renderApp();
    act(() => {
      window.location.hash = '#/s/abc';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(screen.getByText('hello there')).toBeTruthy();
    expect(screen.getByText('General Kenobi')).toBeTruthy();
    expect(screen.getByLabelText('Model').textContent).toBe('mock-model');
  });

  it('⌘K opens the palette; a session found there opens on Enter', () => {
    useAppStore.setState({
      workspaces: [
        { id: 'aaa', root: '/code/alpha', name: 'alpha', projectRoot: '/code/alpha', lastUsedAt: 1, defaults: { model: 'm', mode: 'ask', modes: ['ask'], effortLevels: [] } },
      ],
      sessions: [
        { id: 's1', workspaceId: 'aaa', title: 'fix the login flake', mtimeMs: 1, live: false, running: false, pending: false, pinned: false, archived: false, rev: 1 },
        { id: 's2', workspaceId: 'aaa', title: 'write the release notes', mtimeMs: 2, live: false, running: false, pending: false, pinned: false, archived: false, rev: 1 },
      ],
    });
    renderApp();
    act(() => {
      fireEvent.keyDown(window, { key: 'k', metaKey: true });
    });
    const input = screen.getByLabelText('Command');
    expect(screen.getByRole('option', { selected: true }).textContent).toContain('New session');
    fireEvent.change(input, { target: { value: 'release' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(window.location.hash).toBe('#/s/s2');
    expect(screen.queryByLabelText('Command')).toBeNull();
  });

  it('⇧⌘O starts a new session', () => {
    window.location.hash = '#/s/abc';
    renderApp();
    act(() => {
      fireEvent.keyDown(window, { key: 'O', metaKey: true, shiftKey: true });
    });
    expect(window.location.hash).toBe('#/');
  });
});
