import { describe, expect, it } from 'vitest';

import { diffSides, editDiff, lineSegments, lineTokens, parsePatch, patchHunks, writeDiff } from './diff';

describe('editDiff', () => {
  it('marks changed lines and keeps shared ones as context', () => {
    const d = editDiff('a\nb\nc\n', 'a\nB\nc\n');
    expect(d.lines).toEqual([
      { kind: 'ctx', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'B' },
      { kind: 'ctx', text: 'c' },
    ]);
    expect([d.added, d.removed]).toEqual([1, 1]);
  });

  it('appending after an unterminated last line only adds lines', () => {
    const d = editDiff('4. last step', '4. last step\n\n- appended');
    expect(d.lines).toEqual([
      { kind: 'ctx', text: '4. last step' },
      { kind: 'add', text: '' },
      { kind: 'add', text: '- appended' },
    ]);
    expect([d.added, d.removed]).toEqual([2, 0]);
  });

  it('handles strings without trailing newlines', () => {
    const d = editDiff('first line', 'first line (edited)');
    expect(d.lines.map((l) => [l.kind, l.text])).toEqual([
      ['del', 'first line'],
      ['add', 'first line (edited)'],
    ]);
  });

  it('numbers lines from where the edit starts in the file', () => {
    const d = editDiff('a\nb\nc\n', 'a\nB\nB2\nc\n', 41);
    expect(d.lines.map((l) => [l.kind, l.oldNo, l.newNo])).toEqual([
      ['ctx', 41, 41],
      ['del', 42, undefined],
      ['add', undefined, 42],
      ['add', undefined, 43],
      ['ctx', 43, 44],
    ]);
  });

  it('marks the words that changed in a replaced line, pairing removed and added lines in order', () => {
    const d = editDiff('const a = foo(1);\nkeep\n', 'const b = foo(2);\nkeep\n');
    const [del, add] = d.lines;
    expect(del!.changes).toEqual([
      [6, 7],
      [14, 15],
    ]);
    expect(add!.changes).toEqual([
      [6, 7],
      [14, 15],
    ]);
  });

  it('marks text appended to a line', () => {
    const [del, add] = editDiff('first line', 'first line (edited)').lines;
    expect(del!.changes).toBeUndefined();
    expect(add!.changes).toEqual([[10, 19]]);
  });

  it('leaves a rewritten line whole: little in common is not worth marking', () => {
    const d = editDiff('return computeTotal(items);\n', 'throw new Error("nope");\n');
    expect(d.lines.every((l) => l.changes === undefined)).toBe(true);
  });
});

describe('writeDiff', () => {
  it('shows every line as added, numbered from the top of the new file', () => {
    expect(writeDiff('x\ny\n')).toEqual({
      lines: [
        { kind: 'add', text: 'x', newNo: 1 },
        { kind: 'add', text: 'y', newNo: 2 },
      ],
      added: 2,
      removed: 0,
    });
  });
});

describe('syntax colours on a diff', () => {
  const tok = (content: string, color?: string) => (color ? { content, style: { '--shiki-light': color } } : { content });

  it('takes removed lines from the before side and the rest from the after side', () => {
    const d = editDiff('a\nold\nz\n', 'a\nnew\nz\n');
    expect(diffSides(d)).toEqual({ before: 'a\nold\nz', after: 'a\nnew\nz' });
    const before = [[tok('a')], [tok('old', '#b')], [tok('z')]];
    const after = [[tok('a', '#1')], [tok('new', '#2')], [tok('zz')]];
    expect(lineTokens(d, before, after)).toEqual([
      [tok('a', '#1')],
      [tok('old', '#b')],
      [tok('new', '#2')],
      undefined, // tokens that don't spell the line are dropped
    ]);
  });

  it('cuts a line at token and changed-range boundaries', () => {
    expect(lineSegments('const b = 2', [tok('const', '#k'), tok(' b = '), tok('2', '#n')], [[6, 7], [10, 11]])).toEqual([
      { text: 'const', style: { '--shiki-light': '#k' } },
      { text: ' ' },
      { text: 'b', changed: true },
      { text: ' = ' },
      { text: '2', style: { '--shiki-light': '#n' }, changed: true },
    ]);
    expect(lineSegments('plain', undefined, undefined)).toEqual([{ text: 'plain' }]);
  });
});

describe('parsePatch', () => {
  it('reads hunks with both sides numbered, dropping file headers', () => {
    const patch = [
      'diff --git a/a.ts b/a.ts',
      'index 1..2 100644',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -10,3 +10,4 @@ function f() {',
      ' keep',
      '-const a = 1;',
      '+const a = 2;',
      '+added',
      ' tail',
      '\\ No newline at end of file',
      '@@ -40 +41 @@',
      '-x',
      '+y',
      '',
    ].join('\n');
    const d = parsePatch(patch);
    expect([d.added, d.removed]).toEqual([3, 2]);
    expect(d.lines.map((l) => [l.kind, l.oldNo, l.newNo, l.text])).toEqual([
      ['hunk', undefined, undefined, '@@ -10,3 +10,4 @@ function f() {'],
      ['ctx', 10, 10, 'keep'],
      ['del', 11, undefined, 'const a = 1;'],
      ['add', undefined, 11, 'const a = 2;'],
      ['add', undefined, 12, 'added'],
      ['ctx', 12, 13, 'tail'],
      ['hunk', undefined, undefined, '@@ -40 +41 @@'],
      ['del', 40, undefined, 'x'],
      ['add', undefined, 41, 'y'],
    ]);
    // Words are marked within a replaced line, as in an edit.
    expect(d.lines[3]!.changes).toEqual([[10, 11]]);
    // Highlighting skips the hunk lines.
    expect(diffSides(d)).toEqual({ before: 'keep\nconst a = 1;\ntail\nx', after: 'keep\nconst a = 2;\nadded\ntail\ny' });
  });
});

describe('patchHunks', () => {
  it("gives each hunk's text from its @@ line, in parsePatch's order", () => {
    const patch = 'diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n@@ -9 +9 @@\n-c\n+d\n\\ No newline at end of file\n';
    expect(patchHunks(patch)).toEqual(['@@ -1 +1 @@\n-a\n+b\n', '@@ -9 +9 @@\n-c\n+d\n\\ No newline at end of file\n']);
    expect(parsePatch(patch).lines.filter((l) => l.kind === 'hunk')).toHaveLength(2);
    expect(patchHunks('')).toEqual([]);
  });
});
