import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  STATE_DIR_ENV,
  findMarkedProjectRoot,
  findProjectRoot,
  looseDirHome,
  resolveProjectMemoryDir,
  resolveStateDir,
} from './settings.js';

describe('state directory', () => {
  let base: string;
  let home: string;

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'hc-state-')));
    home = join(base, 'home');
    await mkdir(home);
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('stays in <projectRoot>/.agent inside a project', async () => {
    const repo = join(base, 'repo');
    await mkdir(join(repo, '.git'), { recursive: true });
    await mkdir(join(repo, 'src'));
    const cwd = join(repo, 'src');
    expect(await resolveStateDir(cwd, { env: {}, homeDir: home })).toBe(join(repo, '.agent'));
    expect(await resolveProjectMemoryDir(cwd, home)).toBe(join(repo, '.agent', 'memory'));
  });

  it('goes under ~/.agent/projects for a directory that is not a project', async () => {
    const loose = join(base, 'app');
    await mkdir(loose);
    expect(await findMarkedProjectRoot(loose)).toBeUndefined();
    expect(await findProjectRoot(loose)).toBe(loose); // unchanged: config is still read from cwd
    const state = await resolveStateDir(loose, { env: {}, homeDir: home });
    expect(state.startsWith(join(home, '.agent', 'projects', 'app-'))).toBe(true);
    expect(state).toBe(await looseDirHome(loose, home));
    expect(await resolveProjectMemoryDir(loose, home)).toBe(join(state, 'memory'));
  });

  it('keeps two same-named directories apart', async () => {
    await mkdir(join(base, 'a', 'app'), { recursive: true });
    await mkdir(join(base, 'b', 'app'), { recursive: true });
    const a = await looseDirHome(join(base, 'a', 'app'), home);
    const b = await looseDirHome(join(base, 'b', 'app'), home);
    expect(a).not.toBe(b);
  });

  it(`honours ${STATE_DIR_ENV} over both`, async () => {
    const repo = join(base, 'repo');
    await mkdir(join(repo, '.git'), { recursive: true });
    const env = { [STATE_DIR_ENV]: '/logs/agent/hc-state' };
    expect(await resolveStateDir(repo, { env, homeDir: home })).toBe('/logs/agent/hc-state');
    expect(await resolveStateDir(repo, { env: { [STATE_DIR_ENV]: 'state' } })).toBe(join(repo, 'state'));
  });
});
