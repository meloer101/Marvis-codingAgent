import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from '../App';
import { Composer } from './Composer';
import { PendingDock } from './PendingDock';
import { QueuedMessages } from './QueuedMessages';
import { SkillsDialog } from './SkillsDialog';
import { allCommands } from '@/lib/slash';
import type { SessionViewState } from '@/lib/sessionModel';
import { useAppStore } from '@/lib/store';
import type { SessionSync } from '@/lib/sync';
import { SyncProvider } from '@/lib/syncContext';
import { composerBox, composerEditor, composerText, pressInComposer, typeInComposer } from '@/test/composer';

afterEach(() => {
  cleanup();
  localStorage.clear(); // composer drafts
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
  return { box: composerBox(), onSend, onAbort };
}

describe('Composer images', () => {
  const png = () => new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' });

  it('puts a pasted image where the caret is, and sends it numbered in the text', async () => {
    const { box, onSend } = renderComposer();
    typeInComposer('before');
    fireEvent.paste(box, { clipboardData: { files: [png()], getData: () => '' } });
    expect(await screen.findByRole('button', { name: 'Open Image #1' })).toBeTruthy();
    pressInComposer({ key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('before\n\n[Image #1]', [], {
      steer: false,
      images: [{ mediaType: 'image/png', data: 'iVBORw==' }],
    });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Open Image #1' })).toBeNull());
  });

  it("won't take images for a model that can't see them", async () => {
    const { box, onSend } = renderComposer({ imagesProblem: "mock/mini can't see images" });
    expect((screen.getByLabelText('Attach files') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.paste(box, { clipboardData: { files: [png()], getData: () => '' } });
    expect((await screen.findByRole('alert')).textContent).toBe("mock/mini can't see images");
    expect(screen.queryByRole('button', { name: 'Open Image #1' })).toBeNull();
    pressInComposer({ key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('uploads any other file, shows it while it goes up, and sends its path', async () => {
    let finish: (f: { path: string; name: string; size: number }) => void = () => {};
    const onUpload = vi.fn(() => new Promise<{ path: string; name: string; size: number }>((r) => (finish = r)));
    const { box, onSend } = renderComposer({ onUpload });
    const pdf = new File(['%PDF-1.4'], 'report.pdf', { type: 'application/pdf' });
    fireEvent.drop(box, { dataTransfer: { files: [pdf], types: ['Files'] } });
    expect(await screen.findByLabelText('Uploading')).toBeTruthy();
    await waitFor(() => expect(onUpload).toHaveBeenCalledWith('report.pdf', 'JVBERi0xLjQ='));
    pressInComposer({ key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled(); // still uploading
    await act(async () => finish({ path: '/tmp/hc-uploads/x/report.pdf', name: 'report.pdf', size: 8 }));
    expect(screen.getByLabelText('Attached files').textContent).toContain('report.pdf');
    pressInComposer({ key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('', ['/tmp/hc-uploads/x/report.pdf'], { steer: false, images: [] });
  });

  it('says why an upload failed, and drops its chip', async () => {
    const onUpload = vi.fn(async () => {
      throw new Error('too big');
    });
    const { box } = renderComposer({ onUpload });
    fireEvent.drop(box, { dataTransfer: { files: [new File(['x'], 'a.bin')], types: ['Files'] } });
    expect((await screen.findByRole('alert')).textContent).toBe("Couldn't attach a.bin: too big");
    expect(screen.queryByLabelText('Attached files')).toBeNull();
  });
});

describe('Composer', () => {
  it('sends Markdown on Enter; Shift+Enter starts a new paragraph, or item in a list', () => {
    const { onSend } = renderComposer();
    typeInComposer('hello');
    pressInComposer({ key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    act(() => {
      composerEditor().chain().insertContent('steps').toggleBulletList().run();
    });
    pressInComposer({ key: 'Enter', shiftKey: true });
    act(() => {
      composerEditor().commands.insertContent('next');
    });
    pressInComposer({ key: 'Enter', shiftKey: true });
    pressInComposer({ key: 'Enter', shiftKey: true }); // an empty item: out of the list
    act(() => {
      composerEditor().commands.insertContent('done');
    });
    pressInComposer({ key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('hello\n\n- steps\n- next\n\ndone', [], { steer: false, images: [] });
  });

  it('does not send on the Enter that confirms an IME candidate', () => {
    const { onSend } = renderComposer();
    typeInComposer('你好');
    pressInComposer({ key: 'Enter', isComposing: true });
    pressInComposer({ key: 'Enter', keyCode: 229 });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('opens the / menu with commands and blocks at the start, filters it, and completes with Enter', () => {
    const { onSend } = renderComposer();
    typeInComposer('/');
    expect(screen.getByText('/help')).toBeTruthy();
    expect(screen.getByText('/review')).toBeTruthy();
    expect(screen.getByText('Bulleted list')).toBeTruthy();

    typeInComposer('/comp');
    expect(screen.queryByText('/help')).toBeNull();
    pressInComposer({ key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled(); // completed, not sent
    expect(composerText()).toBe('/compact');
  });

  it('offers only blocks for a / after the start, and turns the line into the one picked', () => {
    renderComposer();
    typeInComposer('steps /num');
    expect(screen.queryByText('/help')).toBeNull();
    expect(screen.queryByText('Commands')).toBeNull();
    pressInComposer({ key: 'Enter' });
    expect(composerText()).toBe('1. steps');
  });

  it('Enter on a command typed out in full sends it; on a partial one it completes', () => {
    const { onSend } = renderComposer();
    typeInComposer('/help');
    pressInComposer({ key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('/help', [], { steer: false, images: [] });
  });

  it('Escape closes the menu without reaching the window (which would abort)', () => {
    const onWindowEsc = vi.fn();
    window.addEventListener('keydown', onWindowEsc);
    renderComposer();
    typeInComposer('/');
    pressInComposer({ key: 'Escape' });
    expect(screen.queryByText('/help')).toBeNull();
    expect(onWindowEsc).not.toHaveBeenCalled();
    window.removeEventListener('keydown', onWindowEsc);
  });

  it('shows Stop while running; Enter steers what is sent meanwhile, ⌥Enter and Queue wait for the turn', async () => {
    const { onSend, onAbort } = renderComposer({ running: true });
    expect(screen.queryByLabelText('Queue')).toBeNull(); // nothing typed yet
    expect(screen.queryByLabelText('Send now')).toBeNull();
    fireEvent.click(screen.getByLabelText('Stop'));
    expect(onAbort).toHaveBeenCalled();
    typeInComposer('next');
    fireEvent.click(screen.getByLabelText('Queue'));
    expect(onSend).toHaveBeenLastCalledWith('next', [], { steer: false, images: [] });
    await waitFor(() => expect(composerText()).toBe(''));
    typeInComposer('use tabs');
    pressInComposer({ key: 'Enter' });
    expect(onSend).toHaveBeenLastCalledWith('use tabs', [], { steer: true, images: [] });
    await waitFor(() => expect(composerText()).toBe(''));
    typeInComposer('afterwards');
    pressInComposer({ key: 'Enter', altKey: true });
    expect(onSend).toHaveBeenLastCalledWith('afterwards', [], { steer: false, images: [] });
  });

  it('puts what comes back in front of the draft, once: Markdown, mentions and images where they were', () => {
    const onRestored = vi.fn();
    const image = { mediaType: 'image/png' as const, data: 'iVBORw==' };
    const { onSend } = renderComposer({
      restored: { text: '- queued @a.ts\n\n[Image #1]', attachments: ['a.ts', '/tmp/hc-uploads/x/notes.md'], images: [image] },
      onRestored,
    });
    expect(composerText()).toBe('- queued @a.ts\n\n[Image #1]');
    expect(screen.getByRole('button', { name: 'Open Image #1' })).toBeTruthy();
    expect(screen.getByLabelText('Attached files').textContent).toContain('notes.md'); // an upload: a chip
    expect(onRestored).toHaveBeenCalledTimes(1);
    pressInComposer({ key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('- queued @a.ts\n\n[Image #1]', ['a.ts', '/tmp/hc-uploads/x/notes.md'], {
      steer: false,
      images: [image],
    });
  });

  it('@ opens the file menu; a picked file is attached while its mention stays in the text', async () => {
    const onSearchFiles = vi.fn(async (q: string) =>
      [{ path: 'src/Composer.tsx' }, { path: 'src/lib/sync.ts' }].filter((f) => f.path.toLowerCase().includes(q)),
    );
    const { onSend } = renderComposer({ onSearchFiles });
    typeInComposer('look at @comp');
    const option = await screen.findByRole('option');
    expect(option.textContent).toContain('Composer.tsx');
    expect(onSearchFiles).toHaveBeenLastCalledWith('comp');
    pressInComposer({ key: 'Enter' });
    expect(composerText()).toBe('look at @src/Composer.tsx');
    expect(onSend).not.toHaveBeenCalled(); // Enter picked the file

    pressInComposer({ key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('look at @src/Composer.tsx', ['src/Composer.tsx'], { steer: false, images: [] });
  });

  it('keeps the draft — text, mentions and uploads — across a remount', async () => {
    const onUpload = vi.fn(async () => ({ path: '/tmp/hc-uploads/y/a.csv', name: 'a.csv', size: 3 }));
    const first = renderComposer({ onUpload, restored: { text: 'fix @a.ts **now**', attachments: ['a.ts'] } });
    fireEvent.drop(first.box, { dataTransfer: { files: [new File(['a,b'], 'a.csv')], types: ['Files'] } });
    await screen.findByText('a.csv');
    await waitFor(() => expect(screen.queryByLabelText('Uploading')).toBeNull());
    cleanup();
    const { onSend } = renderComposer({ onUpload });
    expect(composerText()).toBe('fix @a.ts **now**');
    expect(screen.getByLabelText('Attached files').textContent).toContain('a.csv');
    pressInComposer({ key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('fix @a.ts **now**', ['a.ts', '/tmp/hc-uploads/y/a.csv'], { steer: false, images: [] });
  });

  it('reads a draft kept from before the editor: its text, and its @ files as mentions', () => {
    localStorage.setItem('hc.draft.s1', 'look at @a.ts\nthen ship');
    localStorage.setItem('hc.draftFiles.s1', '["a.ts"]');
    const { onSend } = renderComposer();
    pressInComposer({ key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('look at @a.ts\nthen ship', ['a.ts'], { steer: false, images: [] });
    expect(localStorage.getItem('hc.draftFiles.s1')).toBeNull();
  });

  it('Shift+Tab cycles the mode instead of moving focus; in a nested list it takes the item out a level', () => {
    const onCycleMode = vi.fn();
    renderComposer({ onCycleMode });
    pressInComposer({ key: 'Tab', shiftKey: true });
    expect(onCycleMode).toHaveBeenCalledTimes(1);
    act(() => {
      const editor = composerEditor();
      editor.commands.setContent('<ul><li><p>a</p><ul><li><p>b</p></li></ul></li></ul>');
      // The caret after "b" (not in the empty paragraph that trails the list).
      let end = 0;
      editor.state.doc.descendants((node, pos) => {
        if (node.isText && node.text === 'b') end = pos + 1;
      });
      editor.chain().focus().setTextSelection(end).run();
    });
    pressInComposer({ key: 'Tab', shiftKey: true });
    expect(onCycleMode).toHaveBeenCalledTimes(1);
    expect(composerText()).toBe('- a\n- b');
  });
});

describe('QueuedMessages', () => {
  it('puts what the agent reads at its next step above what waits for the turn to end', () => {
    render(
      <QueuedMessages
        queue={[
          { id: 'q1', text: 'afterwards' },
          { id: 'q2', text: 'use tabs', steer: true },
        ]}
        onEdit={() => {}}
        onRemove={() => {}}
      />,
    );
    const text = screen.getByRole('region', { name: 'Queued messages' }).textContent ?? '';
    expect(text.indexOf('Next step')).toBeLessThan(text.indexOf('use tabs'));
    expect(text.indexOf('use tabs')).toBeLessThan(text.indexOf('Queued · sent when this turn ends'));
    expect(text.indexOf('Queued · sent when this turn ends')).toBeLessThan(text.indexOf('afterwards'));
  });

  it('lists what waits, each to edit or remove', () => {
    const onEdit = vi.fn();
    const onRemove = vi.fn();
    render(
      <QueuedMessages
        queue={[
          { id: 'q1', text: 'first' },
          { id: 'q2', text: 'second' },
        ]}
        onEdit={onEdit}
        onRemove={onRemove}
      />,
    );
    expect(screen.getByText('first')).toBeTruthy();
    fireEvent.click(screen.getAllByLabelText('Edit queued message')[1]!);
    fireEvent.click(screen.getAllByLabelText('Remove queued message')[0]!);
    expect(onEdit).toHaveBeenCalledWith('q2');
    expect(onRemove).toHaveBeenCalledWith('q1');
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
    effortLevels: [],
    queue: [],
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
    expect(screen.queryByRole('textbox')).toBeNull(); // the note waits to be asked for
    fireEvent.click(screen.getByRole('button', { name: 'Add a note' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'too risky' } });
    fireEvent.click(screen.getByText(/Deny/));
    expect(sync.answerAsk).toHaveBeenCalledWith('s1', 'a1', 'deny', 'too risky');
  });

  it('ignores shortcut keys typed into the feedback box', () => {
    const sync = renderDock(dockView());
    fireEvent.click(screen.getByRole('button', { name: 'Add a note' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Add a note' }));
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

    for (const typed of [false, true]) {
      // A plain text box, and the composer's editor (a contenteditable).
      const box = document.createElement(typed ? 'div' : 'textarea');
      if (box instanceof HTMLTextAreaElement) box.value = 'yes and also';
      else {
        box.setAttribute('contenteditable', 'true');
        box.tabIndex = 0;
        box.textContent = 'yes and also';
      }
      document.body.append(box);
      box.focus();
      renderDock(dockView());
      expect(document.activeElement).toBe(box);
      cleanup();
      box.remove();
    }
  });

  it('asks about a call with allow once / always allow / deny only — never a switch to auto mode', () => {
    useAppStore.setState({ info: { modes: ['ask', 'auto'] } as never });
    const sync = renderDock(dockView());
    expect(screen.queryByText(/auto mode/)).toBeNull();
    fireEvent.keyDown(sync.dock, { key: 's' });
    expect(sync.answerAsk).not.toHaveBeenCalled();
  });

  it('offers auto mode beside plan approval when available and not already where approval lands', () => {
    useAppStore.setState({ info: { modes: ['ask', 'auto'] } as never });
    const plan = { pendingAsk: null, askId: null, planId: 'p1' };
    const sync = renderDock(dockView({ ...plan, pendingPlan: { title: 'Plan', body: '1. do it', yesMode: 'acceptEdits' } }));
    fireEvent.click(screen.getByText(/Yes, and use auto mode/));
    expect(sync.answerPlan).toHaveBeenCalledWith('s1', 'p1', true, undefined, 'auto');
    fireEvent.keyDown(sync.dock, { key: 's' });
    expect(sync.answerPlan).toHaveBeenCalledTimes(2);
    cleanup();

    renderDock(dockView({ ...plan, pendingPlan: { title: 'Plan', body: '1. do it', yesMode: 'auto' } }));
    expect(screen.getAllByText(/auto mode/)).toHaveLength(1);
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
      setPaletteOpen: vi.fn((open: boolean) => useAppStore.setState({ paletteOpen: open })),
      takeRequest: vi.fn(),
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

  it('Cmd/Ctrl+Shift+O opens a draft for a new session, creating nothing yet', () => {
    const sync = renderApp(dockView({ pendingAsk: null, askId: null, running: false }));
    fireEvent.keyDown(window, { key: 'o', metaKey: true, shiftKey: true });
    expect(window.location.hash).toBe('#/');
    expect(sync.create).not.toHaveBeenCalled();
  });

  it('Ctrl+` shows and hides the terminal; an Escape typed into it stops nothing', () => {
    const sync = renderApp(dockView({ pendingAsk: null, askId: null, running: true }));
    fireEvent.keyDown(window, { key: '`', code: 'Backquote', ctrlKey: true });
    expect(localStorage.getItem('hc.terminal')).toBe('1');
    fireEvent.keyDown(window, { key: '`', code: 'Backquote', ctrlKey: true });
    expect(localStorage.getItem('hc.terminal')).toBeNull();
    const shell = document.createElement('div');
    shell.className = 'xterm';
    const input = document.createElement('textarea');
    shell.append(input);
    document.body.append(shell);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(sync.abort).not.toHaveBeenCalled();
    shell.remove();
  });

  it('Ctrl+O switches the transcript to verbose and back; ⌘O does not', () => {
    renderApp(dockView({ pendingAsk: null, askId: null, running: false }));
    fireEvent.keyDown(window, { key: 'o', ctrlKey: true });
    expect(localStorage.getItem('hc.verbose')).toBe('1');
    fireEvent.keyDown(window, { key: 'o', metaKey: true });
    expect(localStorage.getItem('hc.verbose')).toBe('1');
    fireEvent.keyDown(window, { key: 'o', ctrlKey: true });
    expect(localStorage.getItem('hc.verbose')).toBeNull();
  });

  it('the Escape that closes the palette does not stop the run', () => {
    const sync = renderApp(dockView({ pendingAsk: null, askId: null, running: true }));
    act(() => useAppStore.setState({ paletteOpen: true }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(sync.abort).not.toHaveBeenCalled();
    act(() => useAppStore.setState({ paletteOpen: false }));
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

  it('hands focus back to the composer once a prompt is answered', async () => {
    const view = dockView();
    renderApp(view);
    expect(document.activeElement?.getAttribute('tabindex')).toBe('-1'); // the dock
    act(() => useAppStore.setState({ views: { s1: { ...view, pendingAsk: null, askId: null } } }));
    // The editor takes focus on the next frame.
    await waitFor(() => expect(document.activeElement).toBe(composerBox()));
  });
});

describe('SkillsDialog', () => {
  it('lists the skills, filters them, and picks one', () => {
    const onPick = vi.fn();
    const skills = Array.from({ length: 8 }, (_, i) => ({ name: `skill-${i}`, description: `does thing ${i}` }));
    render(<SkillsDialog skills={[...skills, { name: 'pdf', description: 'Work with PDF files' }]} onPick={onPick} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Filter skills'), { target: { value: 'pdf' } });
    expect(screen.queryByText('/skill-0')).toBeNull();
    fireEvent.click(screen.getByText('/pdf'));
    expect(onPick).toHaveBeenCalledWith('pdf');
  });
});
