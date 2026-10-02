import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { Entry, ToolItem } from '@harness-code/protocol';

import { Transcript } from '@/components/Transcript';
import type { SessionViewState } from '@/lib/sessionModel';
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

  it('stay folded when the command succeeds', () => {
    render(<Transcript view={view({ entries: bash({ result: { content: 'ok\n' }, durationMs: 300 }) })} />);
    expect(screen.getByRole('button', { name: /make test/ }).textContent).toContain('300ms');
    expect(screen.queryByText('ok')).toBeNull();
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
