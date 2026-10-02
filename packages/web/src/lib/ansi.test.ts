import { describe, expect, it } from 'vitest';

import { hasAnsi, parseAnsi } from './ansi';

describe('parseAnsi', () => {
  it('keeps plain text as one unstyled span', () => {
    expect(hasAnsi('just text\n')).toBe(false);
    expect(parseAnsi('just text\n')).toEqual([{ text: 'just text\n', style: {} }]);
  });

  it('turns SGR codes into styles, and a reset clears them', () => {
    const spans = parseAnsi('\x1b[1;31mFAIL\x1b[0m src/a.test.ts \x1b[32m✓\x1b[39m done');
    expect(spans).toEqual([
      { text: 'FAIL', style: { bold: true, fg: 1 } },
      { text: ' src/a.test.ts ', style: {} },
      { text: '✓', style: { fg: 2 } },
      { text: ' done', style: {} },
    ]);
  });

  it('reads bright, 256-colour and true-colour codes', () => {
    expect(parseAnsi('\x1b[94mx')[0]!.style).toEqual({ fg: 12 });
    expect(parseAnsi('\x1b[38;5;9mx')[0]!.style).toEqual({ fg: 9 });
    expect(parseAnsi('\x1b[38;5;196mx')[0]!.style).toEqual({ fg: 'rgb(255,0,0)' });
    expect(parseAnsi('\x1b[48;2;10;20;30;1mx')[0]!.style).toEqual({ bg: 'rgb(10,20,30)', bold: true });
  });

  it('drops cursor moves, OSC titles and hyperlinks', () => {
    const text = parseAnsi('\x1b[2K\x1b[1Gline\x1b]0;title\x07 \x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\')
      .map((s) => s.text)
      .join('');
    expect(text).toBe('line link');
  });

  it('keeps what a carriage return redraws last, and treats \\r\\n as a line end', () => {
    expect(parseAnsi('10%\r50%\r100%\nnext\r\n')[0]!.text).toBe('100%\nnext\n');
  });
});
