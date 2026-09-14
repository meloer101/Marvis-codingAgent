import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from 'ink-testing-library';

import type { ToolResult } from '@harness-code/core';

import { MeterBar, ModeBar, ToolCard } from './display.js';
import { DARK } from '../theme.js';

afterEach(cleanup);

describe('ModeBar', () => {
  it('labels ask / acceptEdits / plan / auto / yolo the way the status line reads', () => {
    const frame = (mode: 'ask' | 'acceptEdits' | 'plan' | 'auto' | 'yolo') =>
      render(
        <ModeBar mode={mode} modelRef="deepseek/v4" cwd="/tmp/proj" theme={DARK} />,
      ).lastFrame() ?? '';
    expect(frame('ask')).toContain('⏸ ask mode on');
    expect(frame('acceptEdits')).toContain('⏵⏵ accept edits on');
    expect(frame('plan')).toContain('⏸ plan mode on');
    expect(frame('auto')).toContain('⏵⏵ auto mode on');
    expect(frame('yolo')).toContain('⏵⏵ yolo on');
  });
});

describe('MeterBar', () => {
  it('shows token counts and cost', () => {
    const { lastFrame } = render(
      <MeterBar
        usage={{ inputTokens: 1200, outputTokens: 300, cachedInputTokens: 1000, costUSD: 0.0042 }}
        context={undefined}
        theme={DARK}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('↑1.2k');
    expect(frame).toContain('↓300');
    expect(frame).toContain('$0.00420');
  });

  it('renders nothing without usage', () => {
    const { lastFrame } = render(<MeterBar usage={undefined} context={undefined} theme={DARK} />);
    expect(lastFrame() ?? '').toBe('');
  });

  it('renders a context progress bar with percentage and used/window', () => {
    const { lastFrame } = render(
      <MeterBar
        usage={{ inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 }}
        context={{ usedTokens: 16000, windowTokens: 200000, ratio: 0.08 }}
        theme={DARK}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('ctx [');
    expect(frame).toContain('8%');
    expect(frame).toContain('16.0k/200.0k');
  });
});

describe('ToolCard', () => {
  const result: ToolResult = { content: 'secret output' };
  const tool = { id: 'c1', name: 'bash', input: { command: 'ls' }, running: false, result };

  it('hides output when collapsed', () => {
    const { lastFrame } = render(<ToolCard tool={tool} expanded={false} theme={DARK} />);
    expect(lastFrame() ?? '').not.toContain('secret output');
  });

  it('shows output when expanded', () => {
    const { lastFrame } = render(<ToolCard tool={tool} expanded theme={DARK} />);
    expect(lastFrame() ?? '').toContain('secret output');
  });

  it('always shows an error result', () => {
    const { lastFrame } = render(
      <ToolCard
        tool={{ ...tool, result: { content: 'boom', isError: true } }}
        expanded={false}
        theme={DARK}
      />,
    );
    expect(lastFrame() ?? '').toContain('boom');
  });
});
