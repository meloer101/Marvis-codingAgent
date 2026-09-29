import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadDotEnv, loadDotEnvFor } from './dotenv.js';

describe('.env loading', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hc-dotenv-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('parses KEY=value lines, quotes and comments, and never overrides a set variable', async () => {
    const path = join(dir, '.env');
    await writeFile(path, '# comment\nA=1\nB="two words"\nC=\'3\'\n\nNOEQ\nD=from-file\n');
    const env: NodeJS.ProcessEnv = { D: 'from-env' };
    loadDotEnv(path, env);
    expect(env).toEqual({ A: '1', B: 'two words', C: '3', D: 'from-env' });
  });

  it("loads the --cwd workspace's .env, then fills gaps from the invocation directory's", async () => {
    const workspace = join(dir, 'ws');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(workspace);
    await writeFile(join(workspace, '.env'), 'KEY=workspace\nONLY_WS=1\n');
    await writeFile(join(dir, '.env'), 'KEY=invocation\nONLY_INV=1\n');
    const env: NodeJS.ProcessEnv = {};
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      loadDotEnvFor(workspace, env);
    } finally {
      process.chdir(cwd);
    }
    expect(env).toEqual({ KEY: 'workspace', ONLY_WS: '1', ONLY_INV: '1' });
  });
});
