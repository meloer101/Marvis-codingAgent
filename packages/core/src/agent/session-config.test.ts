import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildSessionConfig } from './session-config.js';

describe('buildSessionConfig env', () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'hc-session-config-'));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('reads provider keys from the env it is given, and hands that env to the session', async () => {
    const env = { DEEPSEEK_API_KEY: 'sk-from-this-project' };
    const config = await buildSessionConfig({ cwd, modelRef: 'deepseek/deepseek-flash', env });
    expect(config.model.ref).toBe('deepseek/deepseek-flash');
    expect(config.env).toBe(env);
  });

  it('does not fall back to process.env when given an env without the key', async () => {
    const saved = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = 'sk-from-another-project';
    try {
      await expect(buildSessionConfig({ cwd, modelRef: 'deepseek/deepseek-flash', env: {} })).rejects.toThrow(
        /needs an API key/,
      );
    } finally {
      if (saved === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = saved;
    }
  });
});
