/**
 * Terminal output → styled spans. Commands rarely colour output that isn't a
 * terminal, but some do (`ls --color=always`, test runners, anything with
 * FORCE_COLOR), and their escapes would otherwise show as noise. SGR colours
 * and weights are kept; every other escape (cursor moves, OSC titles and
 * links) is dropped. A carriage return erases the line it ends, the way a
 * progress bar redraws itself.
 */

export interface AnsiStyle {
  /** One of the 16 palette colours (`ansi-<n>` classes), or a CSS colour. */
  fg?: number | string;
  bg?: number | string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

export interface AnsiSpan {
  text: string;
  style: AnsiStyle;
}

// CSI (ESC [ … final byte), OSC (ESC ] … BEL or ESC \), and lone two-byte escapes.
const ESCAPE = /\x1b\[([0-9;?]*)([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-Z\\-_]/g;

/** True when there is anything to interpret — the common case is plain text. */
export function hasAnsi(text: string): boolean {
  return text.includes('\x1b') || text.includes('\r');
}

export function parseAnsi(input: string): AnsiSpan[] {
  const text = collapseCarriageReturns(input);
  const spans: AnsiSpan[] = [];
  let style: AnsiStyle = {};
  let last = 0;
  const push = (chunk: string): void => {
    if (!chunk) return;
    const prev = spans.at(-1);
    if (prev && prev.style === style) prev.text += chunk;
    else spans.push({ text: chunk, style });
  };
  for (const m of text.matchAll(ESCAPE)) {
    push(text.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[2] === 'm') style = applySgr(style, m[1] ?? '');
  }
  push(text.slice(last));
  return spans;
}

/** "50%\r100%\n" → "100%\n": what a terminal leaves on screen. A trailing "\r\n" is just a line end. */
function collapseCarriageReturns(text: string): string {
  if (!text.includes('\r')) return text;
  return text
    .split('\n')
    .map((line) => {
      const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
      const cut = trimmed.lastIndexOf('\r');
      return cut === -1 ? trimmed : trimmed.slice(cut + 1);
    })
    .join('\n');
}

function applySgr(prev: AnsiStyle, params: string): AnsiStyle {
  const codes = params === '' ? [0] : params.split(';').map((p) => Number(p) || 0);
  const next: AnsiStyle = { ...prev };
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i]!;
    if (c === 0) for (const k of Object.keys(next) as Array<keyof AnsiStyle>) delete next[k];
    else if (c === 1) next.bold = true;
    else if (c === 2) next.dim = true;
    else if (c === 3) next.italic = true;
    else if (c === 4) next.underline = true;
    else if (c === 22) (delete next.bold, delete next.dim);
    else if (c === 23) delete next.italic;
    else if (c === 24) delete next.underline;
    else if (c >= 30 && c <= 37) next.fg = c - 30;
    else if (c >= 90 && c <= 97) next.fg = c - 90 + 8;
    else if (c === 39) delete next.fg;
    else if (c >= 40 && c <= 47) next.bg = c - 40;
    else if (c >= 100 && c <= 107) next.bg = c - 100 + 8;
    else if (c === 49) delete next.bg;
    else if (c === 38 || c === 48) {
      const [color, used] = extendedColor(codes, i + 1);
      if (color !== undefined) next[c === 38 ? 'fg' : 'bg'] = color;
      i += used;
    }
  }
  return next;
}

/** `5;n` (256 colours) or `2;r;g;b` (true colour), starting at `at`. Returns the colour and how many codes it took. */
function extendedColor(codes: number[], at: number): [number | string | undefined, number] {
  if (codes[at] === 5) {
    const n = codes[at + 1] ?? 0;
    if (n < 16) return [n, 2];
    if (n >= 232) {
      const v = 8 + (n - 232) * 10;
      return [`rgb(${v},${v},${v})`, 2];
    }
    const k = n - 16;
    const level = (x: number): number => (x === 0 ? 0 : 55 + x * 40);
    return [`rgb(${level(Math.floor(k / 36))},${level(Math.floor(k / 6) % 6)},${level(k % 6)})`, 2];
  }
  if (codes[at] === 2) {
    const [r = 0, g = 0, b = 0] = codes.slice(at + 1, at + 4);
    return [`rgb(${r},${g},${b})`, 4];
  }
  return [undefined, 0];
}
