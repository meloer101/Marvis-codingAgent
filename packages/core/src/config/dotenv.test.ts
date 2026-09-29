import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseDotEnv, projectEnv, userDotEnvPath } from './dotenv.js';

describe('parseDotEnv', () => {
  it('reads KEY=value lines, strips one pair of quotes, skips comments and junk', () => {
    expect(parseDotEnv('# c\nA=1\nB="two words"\nC=\'3\'\n\nNOEQ\n=nokey\nD="\n')).toEqual({
      A: '1',
      B: 'two words',
      C: '3',
      D: '"',
    });
  });
});

describe('projectEnv', () => {
  let root: string;
  let home: string;
  let project: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'hc-env-'));
    home = join(root, 'home');
    project = join(root, 'project');
    await mkdir(join(home, '.agent'), { recursive: true });
    await mkdir(project);
    await writeFile(userDotEnvPath(home), 'SHARED_KEY=user\nBOTH=user\nSHELL_WINS=user\n');
    await writeFile(join(project, '.env'), 'OWN_KEY=project\nBOTH=project\nSHELL_WINS=project\n');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('layers the real environment over the project .env over ~/.agent/.env', () => {
    const base = { SHELL_WINS: 'shell' };
    const env = projectEnv(project, { base, home });
    expect(env).toMatchObject({ SHELL_WINS: 'shell', BOTH: 'project', OWN_KEY: 'project', SHARED_KEY: 'user' });
    expect(base).toEqual({ SHELL_WINS: 'shell' }); // untouched
  });

  it("gives another project the shared keys but not this project's", async () => {
    const other = join(root, 'other');
    await mkdir(other);
    const env = projectEnv(other, { base: {}, home });
    expect(env.SHARED_KEY).toBe('user');
    expect(env.OWN_KEY).toBeUndefined();
  });
});
