/**
 * A terminal option menu for the readline frontends, matching the TUI's: numbered
 * rows with a ❯ on the highlighted one; ↑/↓ (or Ctrl+P/N) move, Enter confirms,
 * a number picks that row, Esc cancels. A row can double as a text field ("No,
 * and tell the agent what to do differently") — while it is highlighted, typing
 * fills it, digits included.
 *
 * It borrows the terminal for the duration: the keypress listeners already on
 * stdin (a live readline `Interface` has one) are set aside and put back, raw
 * mode and flow are restored, and only the option rows are ever redrawn — each
 * kept to a single screen row, so the cursor-up arithmetic can't drift.
 * Terminals that can't do this (`TERM=dumb`, a piped stdout) get `menuCapable`
 * false and the caller falls back to a typed answer.
 */

import { emitKeypressEvents } from 'node:readline';
import type { Key } from 'node:readline';

export interface MenuOption<V extends string = string> {
  value: V;
  label: string;
  /** Dim text after the label, e.g. `(esc)`. */
  hint?: string;
  /** The row doubles as a text field. */
  input?: boolean;
}

/** `null` = cancelled (Esc, Ctrl+C, or the signal fired). */
export type MenuResult<V extends string> = { value: V; text?: string } | null;

export interface MenuTerminal {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
}

/**
 * How long readline waits after a lone ESC to see whether it starts an arrow-key
 * sequence. Its 500ms default makes Esc feel dead in a menu; 100ms still spans
 * the gap between the bytes of one sequence, even over ssh.
 */
export const ESCAPE_TIMEOUT_MS = 100;

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const ACCENT = '\x1b[36m';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

/** Bold `? title` line, the heading style the REPL's prompts use. */
export function menuTitle(title: string): string {
  return `${BOLD}? ${title}${RESET}`;
}

/**
 * Whether the arrow-key menu can run here: a real terminal on both ends that
 * takes raw mode and cursor movement. Mirrors when the TUI is refused (dumb
 * terminal, the legacy Windows console), since those are the same terminals.
 */
export function menuCapable(
  t: MenuTerminal = { input: process.stdin, output: process.stdout },
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return (
    t.input.isTTY === true &&
    t.output.isTTY === true &&
    typeof t.input.setRawMode === 'function' &&
    env['TERM'] !== 'dumb' &&
    !(platform === 'win32' && !env['WT_SESSION'])
  );
}

// -- display width --------------------------------------------------------------

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

function charWidth(ch: string): number {
  const cp = ch.codePointAt(0)!;
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (
    (cp >= 0x300 && cp <= 0x36f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    cp === 0x2060 ||
    cp === 0xfeff
  ) {
    return 0;
  }
  return isWide(cp) ? 2 : 1;
}

/** Columns `s` occupies on screen (fullwidth CJK counts 2). */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += charWidth(ch);
  return w;
}

/** `s` cut to at most `max` columns, ending in `…` when anything was dropped. */
function fit(s: string, max: number): string {
  if (displayWidth(s) <= max) return s;
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = charWidth(ch);
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return `${out}…`;
}

/** The last `max` columns of `s`, so the end of what is being typed stays in view. */
function tail(s: string, max: number): string {
  const chars = [...s];
  let out = '';
  let w = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    const cw = charWidth(chars[i]!);
    if (w + cw > max) break;
    out = chars[i]! + out;
    w += cw;
  }
  return out;
}

// -- the menu -------------------------------------------------------------------

export function selectMenu<V extends string>(opts: {
  /** Lines printed once above the options (title, detail, the question). */
  header: readonly string[];
  options: readonly MenuOption<V>[];
  /** Row highlighted first; defaults to the first. */
  initialIndex?: number;
  signal?: AbortSignal;
  terminal?: MenuTerminal;
}): Promise<MenuResult<V>> {
  const { input, output } = opts.terminal ?? { input: process.stdin, output: process.stdout };
  const { options, signal } = opts;
  const count = options.length;

  return new Promise<MenuResult<V>>((resolve) => {
    if (signal?.aborted || count === 0) {
      resolve(null);
      return;
    }

    let index = Math.min(Math.max(0, opts.initialIndex ?? 0), count - 1);
    let draft = '';
    let rows = 0;
    let done = false;

    const write = (s: string): void => {
      output.write(s);
    };
    const room = (): number => Math.max(20, (output.columns || 80) - 1);

    // Every row is cut to `room()`, so each is exactly one screen row.
    const frame = (): string[] => {
      const lines: string[] = [];
      const numWidth = String(count).length;
      options.forEach((opt, i) => {
        const selected = i === index;
        const prefix = `${selected ? '❯' : ' '} ${String(i + 1).padStart(numWidth)}. `;
        const typing = selected && opt.input === true && draft !== '';
        const space = room() - displayWidth(prefix);
        const body = typing ? `${tail(draft, space - 1)}█` : fit(opt.label, space);
        const spare = space - displayWidth(body);
        const hint =
          !typing && opt.hint && spare > displayWidth(opt.hint) + 1 ? ` ${opt.hint}` : '';
        const text = `${prefix}${body}`;
        lines.push(
          selected
            ? `${ACCENT}${text}${RESET}${DIM}${hint}${RESET}`
            : `${text}${DIM}${hint}${RESET}`,
        );
      });
      lines.push('');
      const help = options[index]!.input
        ? 'Type your feedback · Enter to confirm · Esc to cancel'
        : '↑/↓ to select · Enter to confirm · Esc to cancel';
      lines.push(`${DIM}${fit(help, room())}${RESET}`);
      return lines;
    };

    const draw = (): void => {
      const lines = frame();
      if (rows > 0) write(`\x1b[${rows}A\r\x1b[J`);
      write(`${lines.join('\n')}\n`);
      rows = lines.length;
    };

    // Take over the keyboard: park whoever is listening (a readline Interface
    // handles its own line editing off the same events), then put them back.
    emitKeypressEvents(input, { escapeCodeTimeout: ESCAPE_TIMEOUT_MS } as never);
    const parked = input.listeners('keypress') as ((...args: unknown[]) => void)[];
    for (const l of parked) input.removeListener('keypress', l);
    const wasRaw = input.isRaw === true;
    const wasFlowing = input.readableFlowing;
    if (!wasRaw) input.setRawMode(true);
    input.resume();

    const showCursor = (): void => {
      output.write(SHOW_CURSOR);
    };
    process.once('exit', showCursor);

    const finish = (result: MenuResult<V>, interrupt = false): void => {
      if (done) return;
      done = true;
      input.removeListener('keypress', onKey);
      signal?.removeEventListener('abort', onAbort);
      process.removeListener('exit', showCursor);
      for (const l of parked) input.on('keypress', l);
      if (!wasRaw) input.setRawMode(false);
      if (wasFlowing !== true) input.pause();

      // Swap the menu for one dim line recording what was chosen.
      let summary = 'cancelled';
      if (result) {
        const chosen = options.find((o) => o.value === result.value);
        summary = `${chosen?.label ?? result.value}${result.text ? `: ${result.text}` : ''}`;
      }
      if (rows > 0) write(`\x1b[${rows}A\r\x1b[J`);
      write(`${DIM}  → ${fit(summary, room() - 4)}${RESET}\n${SHOW_CURSOR}`);
      resolve(result);
      // Raw mode swallowed the Ctrl+C the terminal would have turned into a
      // signal; send it on so the run is aborted the way it always is.
      if (interrupt) process.kill(process.pid, 'SIGINT');
    };

    const onAbort = (): void => finish(null);

    const onKey = (str: string | undefined, key: Key | undefined): void => {
      if (done || !key) return;
      if (key.ctrl && key.name === 'c') return finish(null, true);
      if (key.name === 'escape') return finish(null);
      if (key.name === 'up' || (key.ctrl && key.name === 'p')) {
        index = (index - 1 + count) % count;
        return draw();
      }
      if (key.name === 'down' || (key.ctrl && key.name === 'n')) {
        index = (index + 1) % count;
        return draw();
      }
      const current = options[index]!;
      if (key.name === 'return' || key.name === 'enter') {
        const text = current.input ? draft.trim() : '';
        return finish({ value: current.value, ...(text ? { text } : {}) });
      }
      if (current.input) {
        if (key.name === 'backspace' || key.name === 'delete') {
          draft = [...draft].slice(0, -1).join('');
          return draw();
        }
        if (str && !key.ctrl && !key.meta && str >= ' ' && str !== '\x7f') {
          draft += str;
          return draw();
        }
        return;
      }
      if (str && /^[1-9]$/.test(str)) {
        const n = Number(str) - 1;
        const target = options[n];
        if (!target) return;
        // A field row is only focused by its number — the text still has to be typed.
        if (target.input) {
          index = n;
          return draw();
        }
        return finish({ value: target.value });
      }
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    input.on('keypress', onKey);

    for (const line of opts.header) write(`${line}\n`);
    write(HIDE_CURSOR);
    draw();
  });
}
