import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseDotEnv, projectEnv, setDotEnvVar, userDotEnvPath } from './dotenv.js';

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

describe('setDotEnvVar', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hc-env-set-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('makes the file, private, with the folder it is in', async () => {
    const path = join(dir, 'home', '.agent', '.env');
    await setDotEnvVar(path, 'DEEPSEEK_API_KEY', 'sk-one');
    expect(await readFile(path, 'utf8')).toBe('DEEPSEEK_API_KEY=sk-one\n');
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('replaces a variable where it was, adds a new one last, and leaves every other line alone', async () => {
    const path = join(dir, '.env');
    await writeFile(path, '# keys\nA=1\nKEY=old\n\nB="two words"\nKEY=again\n', { mode: 0o644 });
    await setDotEnvVar(path, 'KEY', 'new');
    await setDotEnvVar(path, 'OTHER', 'x');
    expect(await readFile(path, 'utf8')).toBe('# keys\nA=1\nKEY=new\n\nB="two words"\nOTHER=x\n');
    expect(parseDotEnv(await readFile(path, 'utf8'))).toEqual({ A: '1', KEY: 'new', B: 'two words', OTHER: 'x' });
    // It holds keys now, whatever it was made as.
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('removes a variable, and does nothing for one that is not there or a file that is not', async () => {
    const path = join(dir, '.env');
    await writeFile(path, 'A=1\nKEY=k\n');
    await setDotEnvVar(path, 'KEY', undefined);
    expect(await readFile(path, 'utf8')).toBe('A=1\n');
    await setDotEnvVar(path, 'NEVER', undefined);
    expect(await readFile(path, 'utf8')).toBe('A=1\n');
    await setDotEnvVar(join(dir, 'none', '.env'), 'KEY', undefined);
    await expect(stat(join(dir, 'none'))).rejects.toThrow();
  });

  it('refuses what would not be one line of a .env', async () => {
    const path = join(dir, '.env');
    await expect(setDotEnvVar(path, 'KEY', 'a\nB=injected')).rejects.toThrow(/one line/);
    await expect(setDotEnvVar(path, 'NOT A NAME', 'x')).rejects.toThrow(/variable name/);
  });
});
