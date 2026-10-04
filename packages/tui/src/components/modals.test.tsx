import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';

import { PermissionModal, PlanModal } from './modals.js';
import { DARK } from '../theme.js';

afterEach(cleanup);

const DOWN = '\u001B[B';
const ENTER = '\r';
const ESC = '\u001B';
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 60));

const ASK = {
  toolName: 'bash',
  input: { command: 'git push origin main' },
  reason: 'bash needs approval',
  alwaysAllow: '`git push` commands',
};

async function mountAsk() {
  const onAnswer = vi.fn();
  const app = render(<PermissionModal ask={ASK} theme={DARK} onAnswer={onAnswer} />);
  await settle();
  const press = async (data: string): Promise<void> => {
    app.stdin.write(data);
    await settle();
  };
  return { ...app, onAnswer, press };
}

describe('PermissionModal', () => {
  it('lays out title, the command, the question and numbered choices', async () => {
    const { lastFrame } = await mountAsk();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Bash command');
    expect(frame).toContain('git push origin main');
    expect(frame).toContain('bash needs approval');
    expect(frame).toContain('Do you want to proceed?');
    expect(frame).toContain('❯ 1. Yes');
    expect(frame).toContain("2. Yes, and don't ask again for `git push` commands this session");
    expect(frame).toContain('3. No, and tell the agent what to do differently (esc)');
    expect(frame).not.toContain('auto mode');
  });

  it('allows once on a bare Enter — no typing "yes"', async () => {
    const { press, onAnswer } = await mountAsk();
    await press(ENTER);
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith('once', undefined);
  });

  it('leaves out "don\'t ask again" when the ask offers nothing to allow', async () => {
    const { alwaysAllow: _omitted, ...ask } = ASK;
    const app = render(<PermissionModal ask={ask} theme={DARK} onAnswer={vi.fn()} />);
    await settle();
    const frame = app.lastFrame() ?? '';
    expect(frame).not.toContain("don't ask again");
    expect(frame).toContain('2. No, and tell the agent what to do differently');
  });

  it('allows for the session on 2', async () => {
    const { press, onAnswer } = await mountAsk();
    await press('2');
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith('always', undefined);
  });

  it('denies on Esc without feedback', async () => {
    const { press, onAnswer } = await mountAsk();
    await press(ESC);
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith('deny');
  });

  it('denies with the user’s explanation from the last row', async () => {
    const { press, onAnswer } = await mountAsk();
    await press(DOWN);
    await press(DOWN);
    await press('use --force-with-lease');
    await press(ENTER);
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith('deny', 'use --force-with-lease');
  });

  it('does not treat the old y/a/n hotkeys as answers', async () => {
    const { press, onAnswer } = await mountAsk();
    await press('y');
    await press('a');
    await press('n');
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it('clips a long command and says how many lines are hidden', async () => {
    const command = Array.from({ length: 20 }, (_, i) => `echo line-${i}`).join('\n');
    const { lastFrame } = render(
      <PermissionModal
        ask={{ ...ASK, input: { command } }}
        theme={DARK}
        onAnswer={() => {}}
      />,
    );
    await settle();
    expect(lastFrame()).toContain('echo line-11');
    expect(lastFrame()).not.toContain('echo line-12');
    expect(lastFrame()).toContain('… 8 more lines');
  });
});

const PLAN = { title: 'Refactor the parser', body: 'Step one.\n\nStep two.' };

describe('PlanModal', () => {
  it('offers the approval destinations and a keep-planning row', async () => {
    const { lastFrame } = render(
      <PlanModal plan={PLAN} theme={DARK} yesMode="acceptEdits" onAnswer={() => {}} />,
    );
    await settle();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Refactor the parser');
    expect(frame).toContain('Would you like to proceed?');
    expect(frame).toContain('❯ 1. Yes, auto-accept edits');
    expect(frame).toContain('2. Yes, manually approve edits');
    expect(frame).toContain('3. No, keep planning');
  });

  it('offers auto mode as its own row when it is available', async () => {
    const onAnswer = vi.fn();
    const app = render(
      <PlanModal plan={PLAN} theme={DARK} yesMode="acceptEdits" autoAvailable onAnswer={onAnswer} />,
    );
    await settle();
    const frame = app.lastFrame() ?? '';
    expect(frame).toContain('2. Yes, and use auto mode');
    expect(frame).toContain('3. Yes, manually approve edits');
    app.stdin.write('2');
    await settle();
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith('auto', undefined);
  });

  it('does not repeat "manually approve" when that is already the destination', async () => {
    const { lastFrame } = render(
      <PlanModal plan={PLAN} theme={DARK} yesMode="ask" onAnswer={() => {}} />,
    );
    await settle();
    const frame = lastFrame() ?? '';
    expect(frame.match(/manually approve edits/g)).toHaveLength(1);
    expect(frame).toContain('2. No, keep planning');
  });

  it('approves on Enter, and revises with feedback from the last row', async () => {
    const onAnswer = vi.fn();
    const app = render(
      <PlanModal plan={PLAN} theme={DARK} yesMode="acceptEdits" onAnswer={onAnswer} />,
    );
    await settle();
    app.stdin.write(ENTER);
    await settle();
    expect(onAnswer).toHaveBeenLastCalledWith('yes', undefined);

    app.stdin.write('3');
    await settle();
    app.stdin.write('split step two');
    await settle();
    app.stdin.write(ENTER);
    await settle();
    expect(onAnswer).toHaveBeenLastCalledWith('no', 'split step two');
  });

  it('keeps planning on Esc', async () => {
    const onAnswer = vi.fn();
    const app = render(<PlanModal plan={PLAN} theme={DARK} yesMode="acceptEdits" onAnswer={onAnswer} />);
    await settle();
    app.stdin.write(ESC);
    await settle();
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith('no');
  });
});
