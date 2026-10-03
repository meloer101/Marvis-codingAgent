import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SessionStats, StatsSummary } from '@harness-code/protocol';

import { StatsView } from './StatsView';
import { TracePanel } from './TracePanel';
import { useAppStore } from '@/lib/store';
import type { SessionSync } from '@/lib/sync';
import { SyncProvider } from '@/lib/syncContext';

afterEach(() => {
  cleanup();
  useAppStore.setState({ status: 'closed', workspaces: [], sessions: [] });
});

const session = (id: string, costUSD: number, daysAgo: number): SessionStats => ({
  id,
  workspaceId: 'w1',
  startedAt: Date.now() - daysAgo * 86_400_000,
  model: 'x/m',
  turns: 3,
  toolCalls: 4,
  deniedToolCalls: 0,
  salvagedToolCalls: 0,
  inputTokens: 1000,
  outputTokens: 100,
  cachedInputTokens: 500,
  costUSD,
  costPartial: false,
  tokensEstimated: false,
  cacheHitRate: 0.5,
  wallMs: 1000,
  subagentRuns: 0,
  compactions: 0,
});

const summary = (sessions: SessionStats[]): StatsSummary => ({
  sessions,
  rollup: {
    sessions: sessions.length,
    totalTurns: 6,
    totalToolCalls: 8,
    totalDeniedToolCalls: 1,
    totalSalvagedToolCalls: 0,
    totalInputTokens: 2000,
    totalOutputTokens: 200,
    totalCachedInputTokens: 1000,
    totalCostUSD: 0.5,
    sessionsWithPartialCost: 0,
    totalSubagentRuns: 0,
    totalCompactions: 0,
    avgTurnsPerSession: 3,
    avgCostPerSession: 0.25,
    overallCacheHitRate: 0.5,
    byModel: [{ model: 'x/m', sessions: 2, turns: 6, inputTokens: 2000, outputTokens: 200, cachedInputTokens: 1000, costUSD: 0.5, costPartial: false }],
    span: { from: 0, to: 0 },
  },
});

describe('StatsView', () => {
  it('adds up the range, charts cost per day with a table view, and lists the costliest sessions first', async () => {
    const loadStats = vi.fn(async () => summary([session('cheap', 0.1, 0), session('dear', 0.4, 2)]));
    useAppStore.setState({
      status: 'open',
      workspaces: [{ id: 'w1', root: '/p', name: 'proj', projectRoot: '/p', lastUsedAt: 0, defaults: {} as never }],
      sessions: [{ id: 'dear', workspaceId: 'w1', title: 'big refactor', mtimeMs: 0, live: false, running: false, pending: false, pinned: false, archived: false, rev: 1 }],
    });
    render(
      <SyncProvider sync={{ loadStats } as unknown as SessionSync}>
        <StatsView />
      </SyncProvider>,
    );
    expect((await screen.findByRole('region', { name: 'Totals' })).textContent).toContain('Cost$0.500');
    expect(loadStats).toHaveBeenCalledWith({ since: expect.any(Number) });
    expect(screen.getByText('1 denied')).toBeTruthy();
    const rows = screen.getByRole('region', { name: 'Sessions' }).querySelectorAll('tbody tr');
    expect(rows[0]?.textContent).toContain('big refactor');
    // A column's tooltip, on focus as on hover.
    const columns = screen.getByRole('region', { name: 'Cost per day' }).querySelectorAll('button[aria-label]');
    expect(columns).toHaveLength(30);
    act(() => (columns[29] as HTMLButtonElement).focus());
    expect(screen.getByRole('tooltip').textContent).toContain('$0.100');
    fireEvent.click(screen.getByRole('button', { name: /Table/ }));
    expect(screen.getByRole('region', { name: 'Cost per day' }).querySelectorAll('tbody tr')).toHaveLength(2);

    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'w1' } });
    fireEvent.click(screen.getByRole('radio', { name: 'All time' }));
    await act(async () => {});
    expect(loadStats).toHaveBeenLastCalledWith({ workspaceId: 'w1' });
  });
});

describe('TracePanel', () => {
  it("draws a session's runs: model and tool calls, failures marked", async () => {
    const loadTrace = vi.fn(async () => ({
      events: [
        { type: 'run_start', ts: 0, sessionId: 's', model: 'x/m', cwd: '/' },
        { type: 'model_call', ts: 1000, turn: 1, model: 'x/m', latencyMs: 1000, stopReason: 'tool_use', inputTokens: 1200, outputTokens: 30, cachedInputTokens: 0 },
        { type: 'tool_call', ts: 1500, turn: 1, id: 't', name: 'bash', inputSummary: '{"command":"npm test"}', durationMs: 400, isError: true, outputBytes: 9 },
        { type: 'run_end', ts: 2000, stopReason: 'end_turn', turns: 1, wallMs: 2000, inputTokens: 1200, outputTokens: 30, cachedInputTokens: 0 },
      ],
      summary: { ...session('s', 0, 0), turns: 1, toolCalls: 1 },
    }));
    render(
      <SyncProvider sync={{ loadTrace } as unknown as SessionSync}>
        <TracePanel sessionId="s" running={false} />
      </SyncProvider>,
    );
    expect(await screen.findByText('Run 1')).toBeTruthy();
    expect(screen.getByText('failed')).toBeTruthy();
    expect(screen.getByText('↑1.2k ↓30')).toBeTruthy();
    expect(screen.getByText('Model call')).toBeTruthy(); // the legend
  });
});
