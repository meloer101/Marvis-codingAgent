import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SessionProcess, SessionSnapshot } from '@harness-code/protocol';

import { ProcessesPanel } from './ProcessesPanel';
import { Transcript } from './Transcript';
import { setPanel, usePanel } from '@/lib/panel';
import { SessionModel } from '@/lib/sessionModel';
import type { SessionSync } from '@/lib/sync';
import { SyncProvider } from '@/lib/syncContext';

afterEach(() => {
  cleanup();
  act(() => setPanel(null));
});

const proc = (over: Partial<SessionProcess>): SessionProcess => ({
  id: 'bg1',
  command: 'npm run dev',
  cwd: '',
  startedAt: Date.now() - 5000,
  status: 'running',
  output: '',
  ...over,
});

describe('background commands in the session model', () => {
  it('start from the snapshot and follow the events, between runs too', () => {
    const snapshot: SessionSnapshot = {
      id: 's1',
      modelRef: 'm',
      mode: 'ask',
      transcript: [],
      running: false,
      lastSeq: 0,
      processes: [proc({ output: 'ready\n' })],
    };
    const model = new SessionModel(snapshot);
    model.apply(1, { type: 'process_output', id: 'bg1', text: 'GET / 200\n' });
    model.apply(2, { type: 'process_start', process: { id: 'bg2', command: 'tsc -w', cwd: 'web', startedAt: 1, status: 'running' } });
    model.apply(3, { type: 'process_end', process: { id: 'bg1', command: 'npm run dev', cwd: '', startedAt: 1, status: 'killed', endedAt: 2 } });
    expect(model.state.processes).toEqual([
      expect.objectContaining({ id: 'bg1', status: 'killed', output: 'ready\nGET / 200\n' }),
      expect.objectContaining({ id: 'bg2', status: 'running', output: '' }),
    ]);
  });
});

describe('ProcessesPanel', () => {
  it('lists them newest first, opens one to what it printed, and stops it', async () => {
    const killProcess = vi.fn(async () => {});
    render(
      <SyncProvider sync={{ killProcess } as unknown as SessionSync}>
        <ProcessesPanel
          sessionId="s1"
          processes={[proc({ output: 'listening on :5173\n' }), proc({ id: 'bg2', command: 'false', status: 'exited', exitCode: 1 })]}
        />
      </SyncProvider>,
    );
    expect(screen.getByText('1 running · 1 ended')).toBeTruthy();
    const rows = screen.getAllByRole('listitem');
    expect(within(rows[0]!).getByText('exit 1')).toBeTruthy();
    // The one still running is open.
    expect(screen.getByText('listening on :5173')).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Stop bg1' })));
    expect(killProcess).toHaveBeenCalledWith('s1', 'bg1');
    expect(screen.queryByRole('button', { name: 'Stop bg2' })).toBeNull();
  });
});

describe('a background bash card', () => {
  it('says it runs in the background, and opens the Processes tab on it', () => {
    let tab: ReturnType<typeof usePanel> = null;
    function Probe() {
      tab = usePanel();
      return null;
    }
    render(
      <>
        <Probe />
        <Transcript
          view={{
            id: 's1',
            modelRef: 'm',
            mode: 'ask',
            entries: [
              {
                kind: 'assistant',
                id: 0,
                thinking: '',
                text: '',
                tools: [
                  {
                    id: 't',
                    name: 'bash',
                    input: { command: 'npm run dev', run_in_background: true },
                    running: false,
                    result: { content: 'Started in the background as bg1 (pid 42). Read what it prints with bash_output, stop it with bash_kill.' },
                  },
                ],
              },
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
          }}
        />
      </>,
    );
    const header = screen.getByRole('button', { name: /npm run dev/ });
    expect(header.textContent).toContain('background · bg1');
    fireEvent.click(header);
    fireEvent.click(screen.getByRole('button', { name: 'Show bg1’s output' }));
    expect(tab).toBe('processes');
  });
});

