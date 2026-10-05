import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Entry, ToolItem } from '@harness-code/protocol';

import { TaskDock } from '@/components/TaskDock';
import { Transcript } from '@/components/Transcript';
import type { SessionViewState } from '@/lib/sessionModel';
import { setPanel } from '@/lib/panel';
import type { McpLoginPush, SessionSync } from '@/lib/sync';
import { SyncProvider } from '@/lib/syncContext';
import { platform } from '@/platform';
import { setVerbose } from '@/lib/verbose';

afterEach(() => {
  cleanup();
  setVerbose(false);
});

function view(over: Partial<SessionViewState> = {}): SessionViewState {
  return {
    id: 's1',
    modelRef: 'm',
    mode: 'ask',
    entries: [],
    live: { thinking: '', text: '', tools: [] },
    pendingAsk: null,
    pendingPlan: null,
    running: false,
    hydrating: false,
    effortLevels: [],
    queue: [],
    askId: null,
    planId: null,
    ...over,
  };
}

describe('Transcript connector sign-in', () => {
  it('offers a Sign in where a terminal says to run marvis mcp login, and says when it is done', async () => {
    const open = vi.spyOn(platform, 'openExternal').mockImplementation(() => {});
    const listeners = new Set<(e: McpLoginPush) => void>();
    const settingsCall = vi.fn(async () => ({ url: 'https://mcp.notion.com/authorize' }));
    const sync = {
      settingsCall,
      onMcpLogin: (fn: (e: McpLoginPush) => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    } as unknown as SessionSync;
    render(
      <SyncProvider sync={sync}>
        <Transcript
          view={view({
            workspaceId: 'w1',
            entries: [
              {
                kind: 'notice',
                id: 1,
                notice: {
                  kind: 'mcp-auth',
                  level: 'warn',
                  text: 'MCP server notion needs you to sign in — run: marvis mcp login notion, then start a new session',
                  data: { server: 'notion' },
                },
              },
            ],
          })}
        />
      </SyncProvider>,
    );
    expect(screen.queryByText(/marvis mcp login/)).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Sign in' })));
    expect(settingsCall).toHaveBeenCalledWith('mcp.login', { workspaceId: 'w1', name: 'notion' });
    expect(open).toHaveBeenCalledWith('https://mcp.notion.com/authorize');
    await act(async () => listeners.forEach((fn) => fn({ type: 'mcp_login', workspaceId: 'w1', name: 'notion' })));
    expect(screen.getByText(/Signed in/)).toBeTruthy();
    vi.restoreAllMocks();
  });
});

describe('Transcript compaction divider', () => {
  it('renders a horizontal rule and token summary for compaction notices', () => {
    const { container } = render(
      <Transcript
        view={view({
          entries: [
            {
              kind: 'notice',
              id: 0,
              notice: {
                kind: 'compaction',
                level: 'info',
                text: 'Context compacted (9,000 → 1,200 tokens)',
              },
            },
          ],
        })}
      />,
    );
    expect(screen.getByText('Context compacted (9,000 → 1,200 tokens)')).toBeTruthy();
    const rule = container.querySelector('.h-px.flex-1.bg-border');
    expect(rule).toBeTruthy();
  });
});

describe('exploration calls', () => {
  const read = (id: string, path: string, over: Partial<ToolItem> = {}): ToolItem => ({
    id,
    name: 'read',
    input: { path },
    running: false,
    result: { content: `contents of ${path}` },
    ...over,
  });
  const entries: Entry[] = [
    { kind: 'user', id: 0, text: 'look around' },
    { kind: 'assistant', id: 1, thinking: '', text: '', tools: [read('a', 'src/a.ts')] },
    {
      kind: 'assistant',
      id: 2,
      thinking: '',
      text: '',
      tools: [{ id: 'g', name: 'grep', input: { pattern: 'TODO' }, running: false, result: { content: 'no matches', isError: true } }],
    },
    { kind: 'assistant', id: 3, thinking: '', text: 'All clear.', tools: [] },
  ];

  it('fold into one line that opens to the calls, and Verbose shows every card', () => {
    render(<Transcript view={view({ entries })} />);
    const line = screen.getByRole('button', { name: /Read 1 file, searched for 1 pattern/ });
    expect(line.textContent).toContain('1 failed');
    expect(screen.queryByText('src/a.ts')).toBeNull();
    fireEvent.click(line);
    expect(screen.getByText('src/a.ts')).toBeTruthy();
    expect(screen.getByText('/TODO/')).toBeTruthy();

    act(() => setVerbose(true));
    expect(screen.queryByRole('button', { name: /Read 1 file/ })).toBeNull();
    expect(screen.getByText('src/a.ts')).toBeTruthy();
  });

  it('name the call still running, and carry on into the streaming step', () => {
    render(
      <Transcript
        view={view({
          entries: entries.slice(0, 2),
          live: { thinking: '', text: '', tools: [read('b', 'src/b.ts', { running: true, result: undefined } as never)] },
          running: true,
        })}
      />,
    );
    const line = screen.getByRole('button', { name: /Read 2 files/ });
    expect(line.textContent).toContain('src/b.ts');
    expect(line.querySelector('.animate-spin')).toBeTruthy();
  });
});

describe('bash cards', () => {
  const bash = (over: Partial<ToolItem>): Entry[] => [
    { kind: 'assistant', id: 0, thinking: '', text: '', tools: [{ id: 'b', name: 'bash', input: { command: 'make test' }, running: false, ...over }] },
  ];

  it('show the output while the command runs, colours kept', () => {
    const { container } = render(
      <Transcript view={view({ entries: bash({ running: true, output: 'building\n\x1b[31mFAIL\x1b[0m a.test\n' }) })} />,
    );
    expect(container.textContent).toContain('building');
    const fail = screen.getByText('FAIL');
    expect(fail.style.color).toBe('var(--ansi-1)');
    expect(container.textContent).not.toContain('\x1b');
  });

  it('put a failing exit code and the duration in the header, and open on failure', () => {
    render(
      <Transcript view={view({ entries: bash({ result: { content: '1 failed\n[exit code 1]', isError: true }, durationMs: 2400 }) })} />,
    );
    const header = screen.getByRole('button', { name: /make test/ });
    expect(header.textContent).toContain('exit 1');
    expect(header.textContent).toContain('2.4s');
    expect(screen.getByText('1 failed')).toBeTruthy();
    expect(screen.queryByText(/\[exit code/)).toBeNull();
  });

  it('fold the output of a command that succeeded, however short, until it is opened', () => {
    render(<Transcript view={view({ entries: bash({ result: { content: 'ok\n' }, durationMs: 300 }) })} />);
    const header = screen.getByRole('button', { name: /make test/ });
    expect(header.textContent).toContain('300ms');
    expect(screen.queryByText('ok')).toBeNull();
    fireEvent.click(header);
    expect(screen.getByText('ok')).toBeTruthy();
  });
});

describe('task cards', () => {
  const call = (id: string, name: string, input: unknown, over: Partial<ToolItem> = {}): ToolItem => ({
    id,
    name,
    input,
    running: false,
    result: { content: `${name} ok` },
    ...over,
  });
  const task = (over: Partial<ToolItem>): Entry[] => [
    {
      kind: 'assistant',
      id: 0,
      thinking: '',
      text: '',
      tools: [{ id: 't', name: 'task', input: { subagent_type: 'explore', description: 'Find X', prompt: 'where is X' }, running: false, ...over }],
    },
  ];

  it("open on the sub-agent's calls while it works, lookups folded", () => {
    render(
      <Transcript
        view={view({
          entries: task({
            running: true,
            children: [
              call('a', 'read', { path: 'a.ts' }),
              call('b', 'grep', { pattern: 'X' }),
              call('c', 'bash', { command: 'ls src' }, { running: true, result: undefined } as never),
            ],
          }),
        })}
      />,
    );
    const header = screen.getByRole('button', { name: /Find X/ });
    expect(header.textContent).toContain('3 calls');
    expect(screen.getByRole('button', { name: /Read 1 file, searched for 1 pattern/ })).toBeTruthy();
    expect(screen.getByText('ls src')).toBeTruthy();
  });

  it('fold to the report once done', () => {
    render(
      <Transcript
        view={view({ entries: task({ children: [call('a', 'read', { path: 'a.ts' })], result: { content: 'X is in a.ts' }, durationMs: 4200 }) })}
      />,
    );
    const header = screen.getByRole('button', { name: /Find X/ });
    expect(header.textContent).toContain('1 call');
    expect(header.textContent).toContain('4.2s');
    expect(screen.queryByText('where is X')).toBeNull();
  });
});

describe('TaskDock', () => {
  const withTodos = (todos: Array<{ content: string; status: string }>): Entry[] => [
    { kind: 'assistant', id: 0, thinking: '', text: '', tools: [{ id: 't', name: 'todo', input: { todos }, running: false, result: { content: '' } }] },
  ];

  it('shows progress and the task in hand, opening to the whole list', () => {
    render(
      <TaskDock
        view={view({
          entries: withTodos([
            { content: 'Read the code', status: 'completed' },
            { content: 'Fix the bug', status: 'in_progress' },
            { content: 'Add a test', status: 'pending' },
          ]),
        })}
      />,
    );
    const line = screen.getByRole('button', { name: /Tasks/ });
    expect(line.textContent).toContain('1/3');
    expect(line.textContent).toContain('Fix the bug');
    expect(screen.queryByText('Add a test')).toBeNull();
    fireEvent.click(line);
    expect(screen.getByText('Add a test')).toBeTruthy();
    expect(screen.getByText('Read the code').className).toContain('line-through');
  });

  it("steps aside while the side panel's Tasks tab shows the list", () => {
    act(() => setPanel('tasks'));
    const { container } = render(<TaskDock view={view({ entries: withTodos([{ content: 'Fix the bug', status: 'in_progress' }]) })} />);
    expect(container.textContent).toBe('');
    act(() => setPanel(null));
    expect(container.textContent).toContain('Fix the bug');
  });

  it('goes away once everything is done', () => {
    const { container } = render(<TaskDock view={view({ entries: withTodos([{ content: 'All of it', status: 'completed' }]) })} />);
    expect(container.textContent).toBe('');
  });
});

describe('copy and retry', () => {
  it('copies a finished reply as markdown', async () => {
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    render(
      <Transcript
        view={view({
          entries: [
            { kind: 'user', id: 0, text: 'hi' },
            { kind: 'assistant', id: 1, thinking: '', text: 'Hello **there**.', tools: [] },
          ],
        })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Copy reply' }));
    expect(writeText).toHaveBeenCalledWith('Hello **there**.');
    fireEvent.click(screen.getByRole('button', { name: 'Copy message' }));
    expect(writeText).toHaveBeenLastCalledWith('hi');
  });

  const actions = () => ({ onEdit: vi.fn(), onFork: vi.fn(), onRegenerate: vi.fn() });

  it('offers to send the last message again after a failed run, in place of it', () => {
    const a = actions();
    const entries: Entry[] = [
      { kind: 'user', id: 0, text: 'fix it', attachments: ['a.ts'] },
      { kind: 'notice', id: 1, notice: { kind: 'error', level: 'error', text: 'provider down' } },
    ];
    const { rerender } = render(<Transcript view={view({ entries })} actions={a} />);
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    expect(a.onRegenerate).toHaveBeenCalledWith(0, expect.objectContaining({ text: 'fix it', attachments: ['a.ts'], images: [] }));
    rerender(<Transcript view={view({ entries, running: true })} actions={a} />);
    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull();
  });

  it('regenerates the last reply, and edits or forks from any message — not while a run goes', () => {
    const a = actions();
    const entries: Entry[] = [
      { kind: 'user', id: 0, text: 'first', images: [{ mediaType: 'image/png', data: 'x' }] },
      { kind: 'assistant', id: 1, thinking: '', text: 'one', tools: [] },
      { kind: 'user', id: 2, text: 'second' },
      { kind: 'assistant', id: 3, thinking: '', text: 'two', tools: [] },
    ];
    const { rerender } = render(<Transcript view={view({ entries })} actions={a} />);
    fireEvent.click(screen.getByRole('button', { name: /Regenerate/ }));
    expect(a.onRegenerate).toHaveBeenCalledWith(1, expect.objectContaining({ text: 'second' }));
    const edits = screen.getAllByRole('button', { name: 'Edit message' });
    fireEvent.click(edits[0]!);
    expect(a.onEdit).toHaveBeenCalledWith(0, { text: 'first', attachments: [], images: [{ mediaType: 'image/png', data: 'x' }] }, true);
    fireEvent.click(screen.getAllByRole('button', { name: 'Fork from here' })[1]!);
    expect(a.onFork).toHaveBeenCalledWith(1, { text: 'second', attachments: [], images: [] });
    rerender(<Transcript view={view({ entries, running: true })} actions={a} />);
    expect(screen.queryByRole('button', { name: 'Edit message' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Regenerate/ })).toBeNull();
  });
});
