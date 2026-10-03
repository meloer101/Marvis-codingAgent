import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { heuristicTokenCount } from './tokenizer.js';
import { ToolOutputStore, capToolOutput } from './tool-output.js';

describe('ToolOutputStore', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await realpath(await mkdtemp(join(tmpdir(), 'hc-toolout-')));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('returns a workspace-relative path the content was written to', async () => {
    const store = new ToolOutputStore(join(cwd, '.agent', 'sessions', 's1'), cwd);
    const rel = await store.save('hello');
    expect(rel).toBe('.agent/sessions/s1/toolout-0.txt');
    expect(await readFile(join(cwd, rel!), 'utf8')).toBe('hello');
  });

  it('never reuses a number, across concurrent saves or files already on disk', async () => {
    const dir = join(cwd, 'out');
    const first = new ToolOutputStore(dir, cwd);
    await first.save('a');
    // A resumed session builds a new store over the same directory.
    const second = new ToolOutputStore(dir, cwd);
    const paths = await Promise.all(['b', 'c', 'd'].map((s) => second.save(s)));
    expect(paths).toEqual(['out/toolout-1.txt', 'out/toolout-2.txt', 'out/toolout-3.txt']);
    expect(await readFile(join(cwd, 'out/toolout-0.txt'), 'utf8')).toBe('a');
  });

  it('returns the absolute path of a file outside the workspace', async () => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'hc-toolout-out-')));
    try {
      const store = new ToolOutputStore(outside, cwd);
      expect(await store.save('x')).toBe(join(outside, 'toolout-0.txt'));
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('returns undefined instead of throwing when the write fails', async () => {
    const store = new ToolOutputStore(cwd, cwd, async () => {
      throw new Error('ENOSPC');
    });
    expect(await store.save('x')).toBeUndefined();
  });
});

describe('capToolOutput', () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n');

  it('leaves output within the budget untouched', async () => {
    const text = lines(10);
    expect(await capToolOutput(text, { maxTokens: 10_000 })).toBe(text);
  });

  it('keeps the start and the end within the budget, under a header', async () => {
    const text = lines(5_000);
    const out = await capToolOutput(text, { maxTokens: 1_000 });
    expect(out).toMatch(/^\[Output truncated: ~\d+ tokens, 5000 lines;/);
    expect(out).toContain('line 0 ');
    expect(out).toContain('line 4999 ');
    expect(out).toContain('narrower query');
    // Budget plus the header and the line-snapping slack.
    expect(heuristicTokenCount(out)).toBeLessThan(1_000 * 1.1);
  });

  it('saves the full text and names the file', async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), 'hc-toolout-')));
    try {
      const text = lines(5_000);
      const out = await capToolOutput(text, {
        maxTokens: 1_000,
        store: new ToolOutputStore(join(cwd, 'art'), cwd),
      });
      expect(out).toContain('Full output saved to art/toolout-0.txt');
      expect(await readFile(join(cwd, 'art/toolout-0.txt'), 'utf8')).toBe(text);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('sizes the kept text by tokens, so dense CJK output is not kept at 4x the budget', async () => {
    const text = '中文输出'.repeat(20_000);
    const out = await capToolOutput(text, { maxTokens: 1_000 });
    expect(heuristicTokenCount(out)).toBeLessThan(1_000 * 1.1);
  });
});

