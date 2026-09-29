import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MAX_MEMORY_FILE_BYTES, loadProjectMemory } from './memory.js';

describe('loadProjectMemory', () => {
  let root: string;
  let sub: string;
  let fakeHome: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'hc-mem-')));
    await mkdir(join(root, '.git'), { recursive: true }); // makes `root` the project root
    sub = join(root, 'packages', 'core');
    await mkdir(sub, { recursive: true });
    fakeHome = await realpath(await mkdtemp(join(tmpdir(), 'hc-home-')));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(fakeHome, { recursive: true, force: true });
  });

  it('returns empty when there are no memory files', async () => {
    const mem = await loadProjectMemory(sub, { homeDir: fakeHome });
    expect(mem.text).toBe('');
    expect(mem.sources).toEqual([]);
  });

  it('collects AGENTS.md / CLAUDE.md from the project root down to cwd, outermost first', async () => {
    await writeFile(join(root, 'AGENTS.md'), 'root rules', 'utf8');
    await writeFile(join(sub, 'CLAUDE.md'), 'core rules', 'utf8');

    const mem = await loadProjectMemory(sub, { homeDir: fakeHome });

    expect(mem.sources).toEqual([join(root, 'AGENTS.md'), join(sub, 'CLAUDE.md')]);
    expect(mem.text.indexOf('root rules')).toBeLessThan(mem.text.indexOf('core rules'));
    expect(mem.text).toContain(`## ${join(root, 'AGENTS.md')}`);
  });

  it('includes both filenames when both exist in one directory', async () => {
    await writeFile(join(root, 'AGENTS.md'), 'a', 'utf8');
    await writeFile(join(root, 'CLAUDE.md'), 'c', 'utf8');

    const mem = await loadProjectMemory(root, { homeDir: fakeHome });

    expect(mem.sources).toEqual([join(root, 'AGENTS.md'), join(root, 'CLAUDE.md')]);
  });

  it('prepends ~/.agent memory', async () => {
    await mkdir(join(fakeHome, '.agent'), { recursive: true });
    await writeFile(join(fakeHome, '.agent', 'AGENTS.md'), 'global', 'utf8');
    await writeFile(join(root, 'AGENTS.md'), 'local', 'utf8');

    const mem = await loadProjectMemory(root, { homeDir: fakeHome });

    expect(mem.sources[0]).toBe(join(fakeHome, '.agent', 'AGENTS.md'));
    expect(mem.sources[1]).toBe(join(root, 'AGENTS.md'));
  });

  it('truncates a file over the size ceiling', async () => {
    await writeFile(join(root, 'AGENTS.md'), 'x'.repeat(MAX_MEMORY_FILE_BYTES + 500), 'utf8');

    const mem = await loadProjectMemory(root, { homeDir: fakeHome });

    expect(mem.text).toMatch(/truncated/);
    expect(mem.text.length).toBeLessThan(MAX_MEMORY_FILE_BYTES + 200);
  });

  it('caps a CJK file in bytes, not characters, without splitting a character', async () => {
    // 3 bytes per character: the file is ~2× the ceiling in bytes but under it in characters.
    await writeFile(join(root, 'AGENTS.md'), '记'.repeat(MAX_MEMORY_FILE_BYTES * (2 / 3)), 'utf8');

    const mem = await loadProjectMemory(root, { homeDir: fakeHome });

    expect(mem.text).toMatch(/truncated/);
    expect(Buffer.byteLength(mem.text, 'utf8')).toBeLessThan(MAX_MEMORY_FILE_BYTES + 400);
    expect(mem.text).not.toContain('�');
  });

  it('skips an empty memory file', async () => {
    await writeFile(join(root, 'AGENTS.md'), '   \n  ', 'utf8');
    const mem = await loadProjectMemory(root, { homeDir: fakeHome });
    expect(mem.sources).toEqual([]);
  });
});
