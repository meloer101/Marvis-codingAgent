import { emitKeypressEvents } from 'node:readline';
import { PassThrough, Writable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { displayWidth, menuCapable, menuTitle, selectMenu } from './menu.js';
import type { MenuOption, MenuTerminal } from './menu.js';

const UP = '\x1b[A';
const DOWN = '\x1b[B';
const ENTER = '\r';
const ESC = '\x1b';
const CTRL_C = '\x03';
const BACKSPACE = '\x7f';

const tick = (ms = 15): Promise<void> => new Promise((r) => setTimeout(r, ms));
const strip = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]|\r/g, '');

/** A fake TTY: keys are written to `input`, everything drawn lands in `out()`. */
function terminal(columns = 80) {
  const input = new PassThrough() as unknown as NodeJS.ReadStream & PassThrough;
  Object.assign(input, {
    isTTY: true,
    isRaw: false,
    setRawMode(mode: boolean) {
      (this as { isRaw: boolean }).isRaw = mode;
      return this;
    },
  });
  const chunks: string[] = [];
  const output = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  }) as unknown as NodeJS.WriteStream;
  Object.assign(output, { isTTY: true, columns });
  // A lone Esc is only recognised after readline's escape timeout; keep it short.
  emitKeypressEvents(input, { escapeCodeTimeout: 10 } as never);
  const term: MenuTerminal = { input, output };
  return {
    term,
    input,
    press: async (data: string): Promise<void> => {
      input.write(data);
      await tick();
    },
    out: (): string => chunks.join(''),
    text: (): string => strip(chunks.join('')),
  };
}

type Choice = 'yes' | 'always' | 'no';
const OPTIONS: MenuOption<Choice>[] = [
  { value: 'yes', label: 'Yes' },
  { value: 'always', label: "Yes, and don't ask again" },
  { value: 'no', label: 'No, and tell the agent what to do differently', hint: '(esc)', input: true },
];

function open(t: ReturnType<typeof terminal>, extra: Partial<Parameters<typeof selectMenu>[0]> = {}) {
  return selectMenu<Choice>({
    header: [menuTitle('Bash requires approval'), '    npm test', '', 'Do you want to proceed?'],
    options: OPTIONS,
    terminal: t.term,
    ...(extra as object),
  });
}

afterEach(() => vi.restoreAllMocks());

describe('selectMenu', () => {
  it('prints the header, numbered options with ❯ on the first, and the key hint', async () => {
    const t = terminal();
    const p = open(t);
    await tick();
    const text = t.text();
    expect(text).toContain('? Bash requires approval');
    expect(text).toContain('npm test');
    expect(text).toContain('Do you want to proceed?');
    expect(text).toContain('❯ 1. Yes');
    expect(text).toContain("  2. Yes, and don't ask again");
    expect(text).toContain('  3. No, and tell the agent what to do differently (esc)');
    expect(text).toContain('↑/↓ to select · Enter to confirm · Esc to cancel');
    await t.press(ENTER);
    await p;
  });

  it('confirms the first option on a bare Enter', async () => {
    const t = terminal();
    const p = open(t);
    await tick();
    await t.press(ENTER);
    expect(await p).toEqual({ value: 'yes' });
  });

  it('moves with ↑/↓ and Ctrl+P/N, wrapping, and redraws in place', async () => {
    const t = terminal();
    const p = open(t);
    await tick();
    await t.press(DOWN);
    // 3 option rows + blank + hint = 5 rows to climb back over.
    expect(t.out()).toContain('\x1b[5A');
    expect(t.text()).toContain('❯ 2. Yes, and don\'t ask again');
    await t.press(UP);
    await t.press(UP);
    await t.press('\x0e'); // Ctrl+N wraps 3 → 1
    await t.press(DOWN);
    await t.press(ENTER);
    expect(await p).toEqual({ value: 'always' });
  });

  it('picks a row directly by number', async () => {
    const t = terminal();
    const p = open(t);
    await tick();
    await t.press('2');
    expect(await p).toEqual({ value: 'always' });
  });

  it('only focuses a field row by its number, then takes typed text, digits included', async () => {
    const t = terminal();
    const p = open(t);
    await tick();
    await t.press('3');
    expect(t.text()).toContain('Type your feedback');
    await t.press('use 1 space ');
    expect(t.text()).toContain('use 1 space');
    await t.press(BACKSPACE);
    await t.press(BACKSPACE);
    await t.press(ENTER);
    expect(await p).toEqual({ value: 'no', text: 'use 1 spac' });
  });

  it('takes CJK feedback', async () => {
    const t = terminal();
    const p = open(t);
    await tick();
    await t.press(UP);
    await t.press('改用 rg');
    await t.press(ENTER);
    expect(await p).toEqual({ value: 'no', text: '改用 rg' });
  });

  it('confirms the field row with no text as a bare answer', async () => {
    const t = terminal();
    const p = open(t);
    await tick();
    await t.press(UP);
    await t.press(ENTER);
    expect(await p).toEqual({ value: 'no' });
  });

  it('cancels on Esc, even mid-feedback', async () => {
    const t = terminal();
    const p = open(t);
    await tick();
    await t.press('3');
    await t.press('nope');
    await t.press(ESC);
    await tick(40);
    expect(await p).toBeNull();
  });

  it('starts on `initialIndex`', async () => {
    const t = terminal();
    const p = open(t, { initialIndex: 2 });
    await tick();
    expect(t.text()).toContain('❯ 3. No');
    await t.press(ESC);
    await tick(40);
    await p;
  });

  it('ignores number keys past the last option and unrelated letters', async () => {
    const t = terminal();
    const p = open(t);
    await tick();
    await t.press('9');
    await t.press('y');
    await t.press('n');
    await t.press(ENTER);
    expect(await p).toEqual({ value: 'yes' });
  });

  it('cuts every row to one screen row so redraws stay aligned', async () => {
    const t = terminal(30);
    const p = selectMenu({
      header: [],
      options: [{ value: 'a', label: 'A very long label that would certainly wrap on a narrow terminal' }],
      terminal: t.term,
    });
    await tick();
    const row = t.text().split('\n').find((l) => l.includes('1.'))!;
    expect(displayWidth(row)).toBeLessThanOrEqual(29);
    expect(row).toContain('…');
    await t.press(ENTER);
    await p;
  });

  it('swaps the menu for a one-line record of the answer', async () => {
    const t = terminal();
    const p = open(t);
    await tick();
    await t.press('3');
    await t.press('use rg');
    await t.press(ENTER);
    await p;
    expect(t.text().trimEnd().split('\n').pop()).toBe(
      '  → No, and tell the agent what to do differently: use rg',
    );
    expect(t.out()).toMatch(/\x1b\[\?25h$/); // cursor back
  });

  it('borrows the keyboard from readline and gives it back', async () => {
    const t = terminal();
    const rlListener = vi.fn();
    t.input.on('keypress', rlListener);
    t.input.setRawMode(true); // readline already has the terminal raw
    const p = open(t);
    await tick();
    await t.press(DOWN);
    expect(rlListener).not.toHaveBeenCalled();
    await t.press(ENTER);
    await p;
    expect(t.input.listeners('keypress')).toEqual([rlListener]);
    expect(t.input.isRaw).toBe(true); // it was raw before, so it stays raw
    await t.press('x');
    expect(rlListener).toHaveBeenCalledOnce();
  });

  it('puts a terminal that was cooked back to cooked and pauses stdin it woke up', async () => {
    const t = terminal();
    const p = open(t);
    await tick();
    expect(t.input.isRaw).toBe(true);
    await t.press(ENTER);
    await p;
    expect(t.input.isRaw).toBe(false);
    expect(t.input.isPaused()).toBe(true);
  });

  it('settles as cancelled when the signal fires, and stops listening', async () => {
    const t = terminal();
    const ac = new AbortController();
    const p = open(t, { signal: ac.signal });
    await tick();
    ac.abort();
    expect(await p).toBeNull();
    expect(t.input.listenerCount('keypress')).toBe(0);
  });

  it('resolves cancelled without drawing if the signal is already aborted', async () => {
    const t = terminal();
    expect(await open(t, { signal: AbortSignal.abort() })).toBeNull();
    expect(t.out()).toBe('');
  });

  it('cancels on Ctrl+C and hands the interrupt on to the process', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const t = terminal();
    const p = open(t);
    await tick();
    await t.press(CTRL_C);
    expect(await p).toBeNull();
    expect(kill).toHaveBeenCalledWith(process.pid, 'SIGINT');
  });
});

describe('menuCapable', () => {
  const fake = (inTty: boolean, outTty: boolean): MenuTerminal =>
    ({
      input: { isTTY: inTty, setRawMode: () => {} },
      output: { isTTY: outTty },
    }) as unknown as MenuTerminal;

  it('needs a TTY on both ends', () => {
    expect(menuCapable(fake(true, true), {}, 'linux')).toBe(true);
    expect(menuCapable(fake(false, true), {}, 'linux')).toBe(false);
    expect(menuCapable(fake(true, false), {}, 'linux')).toBe(false);
  });

  it('refuses a dumb terminal and the legacy Windows console', () => {
    expect(menuCapable(fake(true, true), { TERM: 'dumb' }, 'linux')).toBe(false);
    expect(menuCapable(fake(true, true), {}, 'win32')).toBe(false);
    expect(menuCapable(fake(true, true), { WT_SESSION: 'x' }, 'win32')).toBe(true);
  });
});

describe('displayWidth', () => {
  it('counts fullwidth CJK as two columns', () => {
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('改用')).toBe(4);
    expect(displayWidth('a改')).toBe(3);
  });
});
