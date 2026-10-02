import { mkdtemp, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SessionState } from '../agent/session.js';
import { editTool } from './edit.js';
import { readTool } from './read.js';
import type { ToolContext } from './types.js';

describe('editTool', () => {
  let cwd: string;
  let ctx: ToolContext;

  beforeEach(async () => {
    // realpath: os.tmpdir() is a symlink on macOS; assertInsideWorkspace()
    // realpaths everything, so `cwd` needs to be canonical too.
    cwd = await realpath(await mkdtemp(join(tmpdir(), 'hc-edit-')));
    ctx = { cwd, session: new SessionState() };
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('refuses to edit a file that has not been read', async () => {
    await writeFile(join(cwd, 'a.txt'), 'foo bar', 'utf8');
    const result = await editTool.execute(
      { path: 'a.txt', oldString: 'foo', newString: 'baz' },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(await readFile(join(cwd, 'a.txt'), 'utf8')).toBe('foo bar');
  });

  it('replaces a unique match after the file has been read', async () => {
    await writeFile(join(cwd, 'a.txt'), 'foo bar', 'utf8');
    await readTool.execute({ path: 'a.txt' }, ctx);
    const result = await editTool.execute(
      { path: 'a.txt', oldString: 'foo', newString: 'baz' },
      ctx,
    );
    expect(result.isError).toBeUndefined();
    expect(await readFile(join(cwd, 'a.txt'), 'utf8')).toBe('baz bar');
  });

  it('tells a frontend the line the replacement starts at, but not the model', async () => {
    await writeFile(join(cwd, 'a.txt'), 'one\ntwo\nthree\nfour\n', 'utf8');
    await readTool.execute({ path: 'a.txt' }, ctx);
    const exact = await editTool.execute({ path: 'a.txt', oldString: 'three\n', newString: '3\n' }, ctx);
    expect(exact.display).toEqual({ startLine: 3 });
    expect(exact.content).not.toContain('3');
    // A fuzzy match reports where it landed too.
    const fuzzy = await editTool.execute({ path: 'a.txt', oldString: '  four\n', newString: '4\n' }, ctx);
    expect(fuzzy.display).toEqual({ startLine: 4 });
    // Several places at once: no single line to give.
    await writeFile(join(cwd, 'b.txt'), 'x\nx\n', 'utf8');
    await readTool.execute({ path: 'b.txt' }, ctx);
    const all = await editTool.execute({ path: 'b.txt', oldString: 'x', newString: 'y', replaceAll: true }, ctx);
    expect(all.display).toBeUndefined();
  });

  it('rejects an ambiguous match unless replaceAll is set', async () => {
    await writeFile(join(cwd, 'a.txt'), 'foo foo', 'utf8');
    await readTool.execute({ path: 'a.txt' }, ctx);
    const ambiguous = await editTool.execute(
      { path: 'a.txt', oldString: 'foo', newString: 'baz' },
      ctx,
    );
    expect(ambiguous.isError).toBe(true);
    expect(await readFile(join(cwd, 'a.txt'), 'utf8')).toBe('foo foo');

    const replaced = await editTool.execute(
      { path: 'a.txt', oldString: 'foo', newString: 'baz', replaceAll: true },
      ctx,
    );
    expect(replaced.isError).toBeUndefined();
    expect(await readFile(join(cwd, 'a.txt'), 'utf8')).toBe('baz baz');
  });

  it('rejects an edit when the file changed on disk since it was read', async () => {
    await writeFile(join(cwd, 'a.txt'), 'foo bar', 'utf8');
    await readTool.execute({ path: 'a.txt' }, ctx);
    // Simulate an external modification: same content, newer mtime.
    await utimes(join(cwd, 'a.txt'), new Date(), new Date(Date.now() + 60_000));

    const result = await editTool.execute(
      { path: 'a.txt', oldString: 'foo', newString: 'baz' },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/read it again/i);
    expect(await readFile(join(cwd, 'a.txt'), 'utf8')).toBe('foo bar');
  });

  it('allows a second consecutive edit without a re-read', async () => {
    await writeFile(join(cwd, 'a.txt'), 'foo bar baz', 'utf8');
    await readTool.execute({ path: 'a.txt' }, ctx);
    await editTool.execute({ path: 'a.txt', oldString: 'foo', newString: 'FOO' }, ctx);
    const second = await editTool.execute({ path: 'a.txt', oldString: 'baz', newString: 'BAZ' }, ctx);
    expect(second.isError).toBeUndefined();
    expect(await readFile(join(cwd, 'a.txt'), 'utf8')).toBe('FOO bar BAZ');
  });

  it('reports an error when oldString is not found', async () => {
    await writeFile(join(cwd, 'a.txt'), 'foo bar', 'utf8');
    await readTool.execute({ path: 'a.txt' }, ctx);
    const result = await editTool.execute(
      { path: 'a.txt', oldString: 'nope', newString: 'x' },
      ctx,
    );
    expect(result.isError).toBe(true);
  });

  describe('when oldString has no exact match', () => {
    async function editFile(content: string, oldString: string, newString: string, replaceAll?: boolean) {
      await writeFile(join(cwd, 'a.txt'), content, 'utf8');
      await readTool.execute({ path: 'a.txt' }, ctx);
      const result = await editTool.execute({ path: 'a.txt', oldString, newString, replaceAll }, ctx);
      return { result, after: await readFile(join(cwd, 'a.txt'), 'utf8') };
    }

    it('matches ignoring trailing whitespace and says so', async () => {
      const { result, after } = await editFile('a\nfoo();   \nb\n', 'foo();\n', 'bar();\n');
      expect(result.isError).toBeUndefined();
      expect(result.content).toContain('ignoring trailing whitespace');
      expect(after).toBe('a\nbar();\nb\n');
    });

    it('matches ignoring indentation', async () => {
      const { result, after } = await editFile(
        'function f() {\n    return 1;\n}\n',
        '\treturn 1;\n}',
        '    return 2;\n}',
      );
      expect(result.content).toContain('leading and trailing whitespace');
      expect(after).toBe('function f() {\n    return 2;\n}\n');
    });

    it('matches smart quotes and dashes against ASCII', async () => {
      const { result, after } = await editFile(
        "const s = 'a - b';\n",
        'const s = \u2018a \u2013 b\u2019;',
        "const s = 'c';",
      );
      expect(result.content).toContain('Unicode');
      expect(after).toBe("const s = 'c';\n");
    });

    it('keeps CRLF line endings when the match came through the loose tier', async () => {
      const { after } = await editFile('x\r\nold1\r\nold2\r\ny\r\n', 'old1\nold2', 'new1\nnew2');
      expect(after).toBe('x\r\nnew1\r\nnew2\r\ny\r\n');
    });

    it('still refuses a loose match that is ambiguous', async () => {
      const { result, after } = await editFile('  foo\nfoo  \n', 'foo', 'bar');
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/matches 2 places/);
      expect(after).toBe('  foo\nfoo  \n');
    });

    it('does not loosen replaceAll', async () => {
      const { result } = await editFile('foo  \nfoo  \n', 'foo\n', 'bar\n', true);
      expect(result.isError).toBe(true);
    });

    it('points at the closest line when nothing matches', async () => {
      const { result } = await editFile(
        'const total = items.reduce((a, b) => a + b, 0);\n',
        'const total = items.reduce((acc, b) => acc + b, 0);',
        'x',
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain('line 1');
    });
  });

  it('inserts newString literally, without $-pattern expansion', async () => {
    await writeFile(join(cwd, 'a.txt'), 'price: X', 'utf8');
    await readTool.execute({ path: 'a.txt' }, ctx);
    await editTool.execute({ path: 'a.txt', oldString: 'X', newString: "$& and $'" }, ctx);
    expect(await readFile(join(cwd, 'a.txt'), 'utf8')).toBe("price: $& and $'");
  });
});
