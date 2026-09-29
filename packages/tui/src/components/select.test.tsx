import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';

import { SelectMenu } from './select.js';
import type { SelectOption } from './select.js';
import { DARK } from '../theme.js';

afterEach(cleanup);

const DOWN = '\u001B[B';
const UP = '\u001B[A';
const ENTER = '\r';
const ESC = '\u001B';
const BACKSPACE = '\u007F';

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 60));

type Choice = 'yes' | 'always' | 'no';
const OPTIONS: SelectOption<Choice>[] = [
  { value: 'yes', label: 'Yes' },
  { value: 'always', label: 'Yes, and do not ask again' },
  { value: 'no', label: 'No, and tell the agent what to do differently', hint: '(esc)', input: true },
];

async function mount(options: readonly SelectOption<Choice>[] = OPTIONS) {
  const onSelect = vi.fn();
  const onCancel = vi.fn();
  const app = render(
    <SelectMenu options={options} theme={DARK} onSelect={onSelect} onCancel={onCancel} />,
  );
  await settle();
  const press = async (data: string): Promise<void> => {
    app.stdin.write(data);
    await settle();
  };
  return { ...app, onSelect, onCancel, press };
}

describe('SelectMenu', () => {
  it('numbers the options and points at the first', async () => {
    const { lastFrame } = await mount();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('❯ 1. Yes');
    expect(frame).toContain('  2. Yes, and do not ask again');
    expect(frame).toContain('  3. No, and tell the agent what to do differently (esc)');
    expect(frame).toContain('Enter to confirm');
  });

  it('moves the pointer with ↑/↓, wrapping at both ends, and Enter confirms it', async () => {
    const { lastFrame, press, onSelect } = await mount();
    await press(DOWN);
    expect(lastFrame()).toContain('❯ 2. Yes, and do not ask again');
    await press(UP);
    await press(UP);
    expect(lastFrame()).toContain('❯ 3. No');
    await press(DOWN);
    expect(lastFrame()).toContain('❯ 1. Yes');
    await press(DOWN);
    await press(ENTER);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('always', undefined);
  });

  it('answers a plain Enter with the first option', async () => {
    const { press, onSelect } = await mount();
    await press(ENTER);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('yes', undefined);
  });

  it('picks a row directly by its number', async () => {
    const { press, onSelect } = await mount();
    await press('2');
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('always');
  });

  it('only focuses a field row by its number — it still needs text and Enter', async () => {
    const { lastFrame, press, onSelect } = await mount();
    await press('3');
    expect(onSelect).not.toHaveBeenCalled();
    expect(lastFrame()).toContain('❯ 3. No');
    expect(lastFrame()).toContain('Type your feedback');
  });

  it('collects feedback on the field row, digits included, and submits it trimmed', async () => {
    const { lastFrame, press, onSelect } = await mount();
    await press('3');
    await press('use 1 space ');
    expect(lastFrame()).toContain('use 1 space');
    await press(BACKSPACE);
    await press(BACKSPACE);
    expect(lastFrame()).toContain('use 1 spac');
    await press(ENTER);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('no', 'use 1 spac');
  });

  it('confirms the field row with no text as a bare answer', async () => {
    const { press, onSelect } = await mount();
    await press(UP);
    await press(ENTER);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('no', undefined);
  });

  it('cancels on Esc from any row, even mid-feedback', async () => {
    const { press, onCancel, onSelect } = await mount();
    await press('3');
    await press('nope');
    await press(ESC);
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('ignores number keys past the last option', async () => {
    const { press, onSelect } = await mount();
    await press('9');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('scrolls a long list with the pointer and says how much is hidden', async () => {
    const many: SelectOption<string>[] = Array.from({ length: 20 }, (_, i) => ({
      value: `s${i}`,
      label: `session-${i}`,
    }));
    const onSelect = vi.fn();
    const app = render(
      <SelectMenu options={many} theme={DARK} maxVisible={5} onSelect={onSelect} onCancel={() => {}} />,
    );
    await settle();
    expect(app.lastFrame()).toContain('session-0');
    expect(app.lastFrame()).not.toContain('session-6');
    expect(app.lastFrame()).toContain('↓ 15 more');
    for (let i = 0; i < 12; i++) {
      app.stdin.write(DOWN);
      await settle();
    }
    expect(app.lastFrame()).toContain('❯ 13. session-12');
    expect(app.lastFrame()).toContain('↑ ');
    app.stdin.write(ENTER);
    await settle();
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('s12', undefined);
  });

  it('lets Esc out of an empty list', async () => {
    const onCancel = vi.fn();
    const app = render(<SelectMenu options={[]} theme={DARK} onSelect={() => {}} onCancel={onCancel} />);
    await settle();
    app.stdin.write(DOWN);
    app.stdin.write(ENTER);
    app.stdin.write(ESC);
    await settle();
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
