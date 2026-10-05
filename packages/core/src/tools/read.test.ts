import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makePdf } from '../../test/make-pdf.js';
import { SessionState } from '../agent/session.js';
import { readTool } from './read.js';
import type { ToolContext } from './types.js';

describe('readTool', () => {
  let cwd: string;
  let ctx: ToolContext;

  beforeEach(async () => {
    // realpath: on macOS, os.tmpdir() is itself a symlink, and
    // assertInsideWorkspace() realpaths everything it resolves — so `cwd` has
    // to be canonical too, or a raw `join(cwd, ...)` won't string-match what
    // the tool records into the session.
    cwd = await realpath(await mkdtemp(join(tmpdir(), 'hc-read-')));
    ctx = { cwd, session: new SessionState() };
  });

  afterEach(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(cwd, { recursive: true, force: true });
  });

  it('numbers lines like cat -n and records the read', async () => {
    await writeFile(join(cwd, 'a.txt'), 'one\ntwo\nthree', 'utf8');
    const result = await readTool.execute({ path: 'a.txt' }, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('1\tone');
    expect(result.content).toContain('3\tthree');
    expect(ctx.session.hasRead(join(cwd, 'a.txt'))).toBe(true);
  });

  it('paginates with offset/limit and reports what was omitted', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n');
    await writeFile(join(cwd, 'b.txt'), lines, 'utf8');
    const result = await readTool.execute({ path: 'b.txt', offset: 3, limit: 2 }, ctx);
    expect(result.content).toContain('3\tline3');
    expect(result.content).toContain('4\tline4');
    expect(result.content).not.toContain('line5');
    expect(result.content).toMatch(/more line\(s\); pass offset 5/);
  });

  it('reports an error for a missing file instead of throwing', async () => {
    const result = await readTool.execute({ path: 'missing.txt' }, ctx);
    expect(result.isError).toBe(true);
  });

  it('refuses to read a path outside the workspace', async () => {
    // Not `../secret`: this workspace sits in the temp dir, which the file
    // tools accept as scratch space.
    const result = await readTool.execute({ path: '/etc/hosts' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/escapes the workspace/);
  });

  it('clamps a single very long line instead of dumping it whole', async () => {
    await writeFile(join(cwd, 'min.js'), `${'x'.repeat(500_000)}\nshort line`, 'utf8');
    const result = await readTool.execute({ path: 'min.js' }, ctx);
    expect(result.content.length).toBeLessThan(10_000);
    expect(result.content).toMatch(/\+\d+ chars on this line/);
    expect(result.content).toContain('short line');
  });

  it('refuses a binary file and says what to use instead', async () => {
    await writeFile(join(cwd, 'blob.bin'), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0x14, 0]));
    const result = await readTool.execute({ path: 'blob.bin' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/binary file/);
    expect(ctx.session.hasRead(join(cwd, 'blob.bin'))).toBe(false);
  });

  describe('a PDF', () => {
    it('comes back as the text of its pages, whatever its name', async () => {
      await writeFile(join(cwd, 'report.dat'), makePdf(['Quarterly revenue grew', 'Costs fell']));
      const result = await readTool.execute({ path: 'report.dat' }, ctx);
      expect(result.isError).toBeUndefined();
      expect(result.content).toMatch(/^PDF, 2 pages\./);
      expect(result.content).toContain('--- Page 1 ---\nQuarterly revenue grew');
      expect(result.content).toContain('--- Page 2 ---\nCosts fell');
      expect(result.content).not.toMatch(/more page/);
      expect(ctx.session.hasRead(join(cwd, 'report.dat'))).toBe(true);
    });

    it('reads the first pages of a long one and says how to go on', async () => {
      const pages = Array.from({ length: 14 }, (_, i) => `Text of page ${i + 1}`);
      await writeFile(join(cwd, 'long.pdf'), makePdf(pages));
      const first = await readTool.execute({ path: 'long.pdf' }, ctx);
      expect(first.content).toContain('Text of page 10');
      expect(first.content).not.toContain('Text of page 11');
      expect(first.content).toContain('4 more page(s); pass pages "11-14" to continue.');

      const rest = await readTool.execute({ path: 'long.pdf', pages: '12-' }, ctx);
      expect(rest.content).toContain('--- Page 12 ---');
      expect(rest.content).toContain('Text of page 14');
      expect(rest.content).not.toContain('Text of page 11');
    });

    it('refuses a range it cannot read', async () => {
      await writeFile(join(cwd, 'short.pdf'), makePdf(['one', 'two']));
      expect((await readTool.execute({ path: 'short.pdf', pages: '5' }, ctx)).content).toMatch(/has 2 pages/);
      expect((await readTool.execute({ path: 'short.pdf', pages: 'all' }, ctx)).isError).toBe(true);
      const big = makePdf(Array.from({ length: 30 }, (_, i) => `p${i}`));
      await writeFile(join(cwd, 'big.pdf'), big);
      expect((await readTool.execute({ path: 'big.pdf', pages: '1-25' }, ctx)).content).toMatch(/at most 20 pages/);
    });

    it('says so when the pages have no text (a scan)', async () => {
      await writeFile(join(cwd, 'scan.pdf'), makePdf(['']));
      const result = await readTool.execute({ path: 'scan.pdf' }, ctx);
      expect(result.content).toContain('(no text on this page)');
      expect(result.content).toMatch(/No text layer/);
    });
  });
});
