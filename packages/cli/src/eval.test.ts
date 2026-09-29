import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { findEvalsCheckout, locateEvalRunner } from './eval.js';

describe('hc eval: finding the checkout', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hc-eval-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function checkout(root: string, name = '@harness-code/evals'): Promise<void> {
    await mkdir(join(root, 'evals'), { recursive: true });
    await writeFile(join(root, 'evals', 'package.json'), JSON.stringify({ name }));
  }

  it('walks up from a start directory to the checkout', async () => {
    await checkout(dir);
    const deep = join(dir, 'packages', 'cli', 'dist');
    await mkdir(deep, { recursive: true });
    expect(findEvalsCheckout([deep])).toBe(dir);
  });

  it("tries the next start when the first isn't inside a checkout", async () => {
    const repo = join(dir, 'repo');
    const elsewhere = join(dir, 'elsewhere');
    await checkout(repo);
    await mkdir(elsewhere);
    expect(findEvalsCheckout([elsewhere, repo])).toBe(repo);
  });

  it("does not take another project's evals/ for this one", async () => {
    await checkout(dir, 'some-other-evals');
    expect(findEvalsCheckout([dir])).toBeUndefined();
  });

  it('asks for a build when the runner is not compiled, and finds it once it is', async () => {
    await checkout(dir);
    expect(locateEvalRunner([dir])).toMatchObject({ error: expect.stringMatching(/pnpm build/) });
    await mkdir(join(dir, 'evals', 'dist'));
    await writeFile(join(dir, 'evals', 'dist', 'cli.js'), '');
    expect(locateEvalRunner([dir])).toEqual({ cli: join(dir, 'evals', 'dist', 'cli.js'), root: dir });
  });
});
