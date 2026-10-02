import { afterEach, describe, expect, it } from 'vitest';

import { addComment, clearReview, removeComment, reviewMessage, updateComment } from './review';
import type { ReviewComment } from './review';

afterEach(() => {
  clearReview('s1');
  localStorage.clear();
});

const stored = (): ReviewComment[] => JSON.parse(localStorage.getItem('hc.review.s1') ?? '[]') as ReviewComment[];

describe('review comments', () => {
  it('are kept per session across reloads, edited and removed in place', () => {
    addComment('s1', { path: 'a.ts', side: 'new', line: 3, excerpt: 'let x = 1;', body: 'Use const.' });
    addComment('s1', { path: 'a.ts', side: 'new', line: 9, excerpt: 'y()', body: 'Why?' });
    expect(stored().map((c) => c.body)).toEqual(['Use const.', 'Why?']);
    const [first] = stored();
    updateComment('s1', first!.id, 'Make it const.');
    removeComment('s1', stored()[1]!.id);
    expect(stored().map((c) => c.body)).toEqual(['Make it const.']);
    clearReview('s1');
    expect(localStorage.getItem('hc.review.s1')).toBeNull();
  });

  it('become one message, file by file and line by line, each line quoted', () => {
    const c = (path: string, side: 'old' | 'new', line: number, excerpt: string, body: string): ReviewComment => ({
      id: `${path}${line}`,
      path,
      side,
      line,
      excerpt,
      body,
    });
    expect(
      reviewMessage([
        c('src/b.ts', 'new', 2, '', 'Stray blank line.'),
        c('src/a.ts', 'new', 12, 'let sum = 0; // running total', 'Drop the comment.'),
        c('src/a.ts', 'old', 4, 'return total;', '  Keep this return.  '),
      ]),
    ).toBe(
      [
        'Review comments on the current changes (3 comments) — please address each:',
        '',
        '`src/a.ts` removed line 4:',
        '> return total;',
        'Keep this return.',
        '',
        '`src/a.ts` line 12:',
        '> let sum = 0; // running total',
        'Drop the comment.',
        '',
        '`src/b.ts` line 2:',
        '> (blank line)',
        'Stray blank line.',
      ].join('\n'),
    );
  });
});
