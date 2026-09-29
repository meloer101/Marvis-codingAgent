import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from 'ink-testing-library';

import { Markdown } from './render.js';
import { DARK } from '../theme.js';

afterEach(cleanup);

describe('Markdown', () => {
  it('renders headings, bold, emphasis and inline code', () => {
    const { lastFrame } = render(
      <Markdown text={'# Title\n\nSome **bold** and *em* text with `code`.'} theme={DARK} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Title');
    expect(frame).toContain('bold');
    expect(frame).toContain('em');
    expect(frame).toContain('code');
  });

  it('closes bold between CJK punctuation and text, where CommonMark leaves the markers raw', () => {
    const { lastFrame } = render(
      <Markdown text={'**注意：**这个文件会被覆盖，这是**「重点」**内容'} theme={DARK} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('注意：');
    expect(frame).not.toContain('*');
  });

  it('renders list items with bullets', () => {
    const { lastFrame } = render(<Markdown text={'- one\n- two'} theme={DARK} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('• one');
    expect(frame).toContain('• two');
  });

  it('formats inline markup inside list items (not as literal markdown)', () => {
    const { lastFrame } = render(<Markdown text={'- some **bold** and `code`'} theme={DARK} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('• some');
    expect(frame).toContain('bold');
    expect(frame).toContain('code');
    expect(frame).not.toContain('**bold**');
    expect(frame).not.toContain('`code`');
  });

  it('renders a code block as dim monospace lines', () => {
    const { lastFrame } = render(<Markdown text={'```\nline1\nline2\n```'} theme={DARK} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('line1');
    expect(frame).toContain('line2');
  });
});
