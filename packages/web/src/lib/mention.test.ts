import { describe, expect, it } from 'vitest';

import { insertMention, mentionAt, presentAttachments, removeMention } from './mention';

describe('mentions', () => {
  it('finds the @word at the caret, only at the start of a word', () => {
    expect(mentionAt('look at @src/co', 15)).toEqual({ start: 8, query: 'src/co' });
    expect(mentionAt('@', 1)).toEqual({ start: 0, query: '' });
    expect(mentionAt('mail me@home', 12)).toBeNull();
    expect(mentionAt('@src/a done', 11)).toBeNull(); // the caret is past it
    expect(mentionAt('see @a and @b', 6)).toEqual({ start: 4, query: 'a' });
  });

  it('inserts the path with a space after, keeping what follows', () => {
    expect(insertMention('look at @co', { start: 8, query: 'co' }, 'src/Composer.tsx')).toEqual({
      text: 'look at @src/Composer.tsx ',
      caret: 26,
    });
    expect(insertMention('@co then', { start: 0, query: 'co' }, 'a.ts')).toEqual({ text: '@a.ts then', caret: 6 });
  });

  it('keeps an attachment while its @path is in the text, and removes it with its chip', () => {
    const attached = ['a.ts', 'src/b (1).ts'];
    expect(presentAttachments('fix @a.ts and @src/b (1).ts', attached)).toEqual(['a.ts', 'src/b (1).ts']);
    expect(presentAttachments('fix @a.tsx', attached)).toEqual([]);
    expect(removeMention('fix @a.ts and @a.ts now', 'a.ts')).toBe('fix and now');
    expect(removeMention('@a.ts', 'a.ts')).toBe('');
  });
});
