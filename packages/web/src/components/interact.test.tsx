import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from '../App';
import { Composer } from './Composer';
import { PendingDock } from './PendingDock';
import { allCommands } from '@/lib/slash';
import type { SessionViewState } from '@/lib/sessionModel';
import { useAppStore } from '@/lib/store';
import type { SessionSync } from '@/lib/sync';
import { SyncProvider } from '@/lib/syncContext';

afterEach(() => {
  cleanup();
  window.location.hash = '';
  useAppStore.setState({ status: 'closed', info: null, sessions: [], views: {}, slash: {}, error: null, helpOpen: false });
});

function renderComposer(overrides: Partial<Parameters<typeof Composer>[0]> = {}) {
  const onSend = vi.fn(async () => true);
  const onAbort = vi.fn();
  render(
    <Composer
      sessionId="s1"
      running={false}
      disabled={false}
      commands={allCommands([{ command: 'review', server: 'gh', name: 'review' }])}
      onSend={onSend}
      onAbort={onAbort}
      {...overrides}
    />,
  );
  return { textarea: screen.getByRole('textbox') as HTMLTextAreaElement, onSend, onAbort };
}

describe('Composer', () => {
  it('sends on Enter and keeps Shift+Enter as a newline', () => {
    const { textarea, onSend } = renderComposer();
    fireEvent.change(textarea, { target: { value: 'hello' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('hello');
  });

  it('does not send on the Enter that confirms an IME candidate', () => {
    const { textarea, onSend } = renderComposer();
    fireEvent.change(textarea, { target: { value: '你好' } });
    fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('opens the / menu, filters it, and completes with Enter', () => {
    const { textarea, onSend } = renderComposer();
    fireEvent.change(textarea, { target: { value: '/' } });
    expect(screen.getByText('/help')).toBeTruthy();
    expect(screen.getByText('/review')).toBeTruthy();

    fireEvent.change(textarea, { target: { value: '/comp' } });
    expect(screen.queryByText('/help')).toBeNull();
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled(); // completed, not sent
    expect(textarea.value).toBe('/compact ');
  });

  it('Escape closes the menu without reaching the window (which would abort)', () => {
    const onWindowEsc = vi.fn();
    window.addEventListener('keydown', onWindowEsc);
    const { textarea } = renderComposer();
    fireEvent.change(textarea, { target: { value: '/' } });
    fireEvent.keyDown(textarea, { key: 'Escape' });
    expect(screen.queryByText('/help')).toBeNull();
    expect(onWindowEsc).not.toHaveBeenCalled();
    window.removeEventListener('keydown', onWindowEsc);
  });

  it('swaps send for stop while running', () => {
    const { onAbort } = renderComposer({ running: true });
    fireEvent.click(screen.getByLabelText('Stop'));
    expect(onAbort).toHaveBeenCalled();
  });
});

function dockView(over: Partial<SessionViewState> = {}): SessionViewState {
  return {
    id: 's1',
    modelRef: 'm',
    mode: 'ask',
    entries: [],
    live: { thinking: '', text: '', tools: [] },
    pendingAsk: {
      toolName: 'bash',
      input: { command: 'npm test' },
      reason: 'bash needs approval',
      alwaysAllow: '`npm test` commands',
    },
    pendingPlan: null,
    running: true,
    hydrating: false,
    askId: 'a1',
    planId: null,
    ...over,
  };
}

function renderDock(view: SessionViewState) {
  const sync = { answerAsk: vi.fn(async () => {}), answerPlan: vi.fn(async () => {}) };
  const { container } = render(
    <SyncProvider sync={sync as unknown as SessionSync}>
      <PendingDock view={view} />
    </SyncProvider>,
  );
  const dock = container.querySelector('div[tabindex]')!;
  return { ...sync, dock };
}

describe('PendingDock', () => {
  it('answers with y / a / n like the TUI', () => {
    const sync = renderDock(dockView());
    const { dock } = sync;
    fireEvent.keyDown(dock, { key: 'y' });
    expect(sync.answerAsk).toHaveBeenCalledWith('s1', 'a1', 'once');
    fireEvent.keyDown(dock, { key: 'a' });
    expect(sync.answerAsk).toHaveBeenCalledWith('s1', 'a1', 'always');
    fireEvent.keyDown(dock, { key: 'n' });
    expect(sync.answerAsk).toHaveBeenCalledWith('s1', 'a1', 'deny', '');
    fireEvent.keyDown(dock, { key: 'Escape' });
    expect(sync.answerAsk).toHaveBeenCalledTimes(4);
  });

  it('names what "always allow" covers, and leaves it out when the ask offers nothing', () => {
    const offered = renderDock(dockView());
    expect(screen.getByRole('button', { name: /Always allow npm test commands/ })).toBeTruthy();
    cleanup();

    const sync = renderDock(
      dockView({ pendingAsk: { toolName: 'bash', input: { command: 'sudo make install' }, reason: 'r' } }),
    );
    expect(screen.queryByText(/Always allow/)).toBeNull();
    fireEvent.keyDown(sync.dock, { key: 'a' });
    expect(sync.answerAsk).not.toHaveBeenCalled();
    expect(offered.answerAsk).not.toHaveBeenCalled();
  });

  it('passes typed feedback along with a deny', () => {
    const sync = renderDock(dockView());
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'too risky' } });
    fireEvent.click(screen.getByText(/Deny/));
    expect(sync.answerAsk).toHaveBeenCalledWith('s1', 'a1', 'deny', 'too risky');
  });

  it('ignores shortcut keys typed into the feedback box', () => {
    const sync = renderDock(dockView());
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'y' });
    expect(sync.answerAsk).not.toHaveBeenCalled();
  });

  it('approves and rejects a plan with feedback', () => {
    const sync = renderDock(
      dockView({
        pendingAsk: null,
        askId: null,
        pendingPlan: { title: 'Plan', body: '1. do it' },
        planId: 'p1',
      }),
    );
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'smaller steps' } });
    fireEvent.click(screen.getByText(/Revise/));
    expect(sync.answerPlan).toHaveBeenCalledWith('s1', 'p1', false, 'smaller steps');
    fireEvent.click(screen.getByText(/Yes, auto-accept edits/));
    expect(sync.answerPlan).toHaveBeenCalledWith('s1', 'p1', true);
  });

  it('Revise with nothing typed asks for the note instead of sending an empty one', () => {
    const sync = renderDock(
      dockView({ pendingAsk: null, askId: null, pendingPlan: { title: 'Plan', body: '1. do it' }, planId: 'p1' }),
    );
    fireEvent.keyDown(sync.dock, { key: 'e' });
    expect(sync.answerPlan).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole('textbox'));
  });

  it('Esc in the feedback box denies with the note and never reaches the window', () => {
    const onWindowKey = vi.fn();
    window.addEventListener('keydown', onWindowKey);
    const sync = renderDock(dockView());
    const box = screen.getByRole('textbox');
    fireEvent.change(box, { target: { value: 'not on main' } });
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(sync.answerAsk).toHaveBeenCalledWith('s1', 'a1', 'deny', 'not on main');
    expect(onWindowKey).not.toHaveBeenCalled();
    window.removeEventListener('keydown', onWindowKey);
  });

  it('⌘Enter in the plan note sends the plan back with it', () => {
    const sync = renderDock(
      dockView({ pendingAsk: null, askId: null, pendingPlan: { title: 'Plan', body: '1. do it' }, planId: 'p1' }),
    );
    const box = screen.getByRole('textbox');
    fireEvent.change(box, { target: { value: 'split step 2' } });
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    expect(sync.answerPlan).toHaveBeenCalledWith('s1', 'p1', false, 'split step 2');
  });

  it('takes focus for its keys, but not from a text box the user is typing in', () => {
    const idle = renderDock(dockView());
    expect(document.activeElement).toBe(idle.dock);
    cleanup();

    const composer = document.createElement('textarea');
    document.body.append(composer);
    composer.value = 'yes and also';
    composer.focus();
    renderDock(dockView());
    expect(document.activeElement).toBe(composer);
    composer.remove();
  });

  it('uses the auto-mode offer rule from core (bash only, ask/acceptEdits only)', () => {
    useAppStore.setState({ info: { modes: ['ask', 'auto'] } as never });
    renderDock(dockView());
    expect(screen.getByText(/Yes, auto mode/)).toBeTruthy();
    cleanup();
    renderDock(dockView({ pendingAsk: { toolName: 'write', input: { path: 'a' }, reason: 'r' } }));
    expect(screen.queryByText(/Yes, auto mode/)).toBeNull();
  });

  it('labels y from the session-resolved yesMode and lets the session apply it', () => {
    const sync = renderDock(
      dockView({
        pendingAsk: null,
        askId: null,
        pendingPlan: { title: 'Plan', body: '1. do it', yesMode: 'yolo' },
        planId: 'p1',
      }),
    );
    expect(screen.queryByText(/auto mode/)).toBeNull();
    fireEvent.keyDown(sync.dock, { key: 'y' });
    expect(screen.getByText(/skip all permission prompts \(yolo\)/i)).toBeTruthy();
    expect(sync.answerPlan).toHaveBeenCalledWith('s1', 'p1', true);
  });

  it('approves a plan into ask mode with m', () => {
    const sync = renderDock(
      dockView({
        pendingAsk: null,
        askId: null,
        pendingPlan: { title: 'Plan', body: '1. do it' },
        planId: 'p1',
      }),
    );
    fireEvent.click(screen.getByText(/Yes, approve manually/));
    expect(sync.answerPlan).toHaveBeenCalledWith('s1', 'p1', true, undefined, 'ask');
  });
});

describe('global shortcuts', () => {
  function renderApp(view: SessionViewState) {
    const sync = {
      open: vi.fn(async () => {}),
      release: vi.fn(),
      prepareCommands: vi.fn(async () => {}),
      create: vi.fn(async () => 'new-id'),
      abort: vi.fn(async () => {}),
      send: vi.fn(async () => true),
      setHelpOpen: vi.fn(),
      dismissError: vi.fn(),
    };
    window.location.hash = '#/s/s1';
    useAppStore.setState({ status: 'open', views: { s1: view } });
    render(
      <SyncProvider sync={sync as unknown as SessionSync}>
        <App />
      </SyncProvider>,
    );
    return sync;
  }

  it('Escape stops a running session', () => {
    const sync = renderApp(dockView({ pendingAsk: null, askId: null, running: true }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(sync.abort).toHaveBeenCalledWith('s1');
  });

  it('Escape does nothing when the session is idle', () => {
    const sync = renderApp(dockView({ pendingAsk: null, askId: null, running: false }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(sync.abort).not.toHaveBeenCalled();
  });

  it('Cmd/Ctrl+K opens a draft for a new session, creating nothing yet', () => {
    const sync = renderApp(dockView({ pendingAsk: null, askId: null, running: false }));
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(window.location.hash).toBe('#/');
    expect(sync.create).not.toHaveBeenCalled();
  });

  it('the Escape that closes help does not stop the run', () => {
    const sync = renderApp(dockView({ pendingAsk: null, askId: null, running: true }));
    act(() => useAppStore.setState({ helpOpen: true }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(sync.setHelpOpen).toHaveBeenCalledWith(false);
    expect(sync.abort).not.toHaveBeenCalled();
  });

  it("help lists the active session's MCP commands, not another session's", () => {
    renderApp(dockView({ pendingAsk: null, askId: null, running: false }));
    act(() =>
      useAppStore.setState({
        helpOpen: true,
        slash: {
          other: [{ command: 'deploy', server: 'ops', name: 'deploy' }],
          s1: [{ command: 'review', server: 'gh', name: 'review' }],
        },
      }),
    );
    expect(screen.getAllByText('/review').length).toBeGreaterThan(0);
    expect(screen.queryByText('/deploy')).toBeNull();
  });

  it('hands focus back to the composer once a prompt is answered', () => {
    const view = dockView();
    renderApp(view);
    expect(document.activeElement?.getAttribute('tabindex')).toBe('-1'); // the dock
    act(() => useAppStore.setState({ views: { s1: { ...view, pendingAsk: null, askId: null } } }));
    expect(document.activeElement).toBe(screen.getByPlaceholderText(/Running…/));
  });
});
