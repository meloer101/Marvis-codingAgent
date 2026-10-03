import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  STATE_DIR_ENV,
  findMarkedProjectRoot,
  findProjectRoot,
  findStateRoot,
  linkedWorktreeMain,
  legacyStateDir,
  loadSettings,
  resolveProjectMemoryDir,
  resolveStateDir,
  resolveStateDirs,
  stateHome,
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

  it("goes under ~/.agent/projects for a project too, out of its repository; its memory stays in it", async () => {
    const repo = join(base, 'repo');
    await mkdir(join(repo, '.git'), { recursive: true });
    await mkdir(join(repo, 'src'));
    const cwd = join(repo, 'src');
    const state = await resolveStateDir(cwd, { env: {}, homeDir: home });
    expect(state.startsWith(join(home, '.agent', 'projects', 'repo-'))).toBe(true);
    expect(state).toBe(await stateHome(repo, home)); // the project's, wherever in it the session runs
    expect(await resolveProjectMemoryDir(cwd, home)).toBe(join(repo, '.agent', 'memory'));
  });

  it("still looks where earlier versions logged a project's sessions: <projectRoot>/.agent", async () => {
    const repo = join(base, 'repo');
    await mkdir(join(repo, '.git'), { recursive: true });
    await mkdir(join(repo, 'src'));
    const cwd = join(repo, 'src');
    expect(await legacyStateDir(cwd, { env: {} })).toBe(join(repo, '.agent'));
    expect(await resolveStateDirs(cwd, { env: {}, homeDir: home })).toEqual([
      await stateHome(repo, home),
      join(repo, '.agent'),
    ]);
    // Nowhere else to look outside a project, or when the state dir is named.
    const loose = join(base, 'app');
    await mkdir(loose);
    expect(await legacyStateDir(loose, { env: {} })).toBeUndefined();
    expect(await resolveStateDirs(repo, { env: { [STATE_DIR_ENV]: '/logs/state' } })).toEqual(['/logs/state']);
  });

  it('goes under ~/.agent/projects for a directory that is not a project', async () => {
    const loose = join(base, 'app');
    await mkdir(loose);
    expect(await findMarkedProjectRoot(loose)).toBeUndefined();
    expect(await findProjectRoot(loose)).toBe(loose); // unchanged: config is still read from cwd
    const state = await resolveStateDir(loose, { env: {}, homeDir: home });
    expect(state.startsWith(join(home, '.agent', 'projects', 'app-'))).toBe(true);
    expect(state).toBe(await stateHome(loose, home));
    expect(await resolveProjectMemoryDir(loose, home)).toBe(join(state, 'memory'));
  });

  it('keeps two same-named directories apart', async () => {
    await mkdir(join(base, 'a', 'app'), { recursive: true });
    await mkdir(join(base, 'b', 'app'), { recursive: true });
    const a = await stateHome(join(base, 'a', 'app'), home);
    const b = await stateHome(join(base, 'b', 'app'), home);
    expect(a).not.toBe(b);
  });

  it(`honours ${STATE_DIR_ENV} over both`, async () => {
    const repo = join(base, 'repo');
    await mkdir(join(repo, '.git'), { recursive: true });
    const env = { [STATE_DIR_ENV]: '/logs/agent/hc-state' };
    expect(await resolveStateDir(repo, { env, homeDir: home })).toBe('/logs/agent/hc-state');
    expect(await resolveStateDir(repo, { env: { [STATE_DIR_ENV]: 'state' } })).toBe(join(repo, 'state'));
  });

  describe('in a linked worktree', () => {
    const git = (cwd: string, ...args: string[]): string =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
        cwd,
        encoding: 'utf8',
      });

    /** A repository with a commit, a sub-directory, and a worktree of it outside (under `home`, as `marvis web` puts them). */
    async function repoWithWorktree(): Promise<{ repo: string; wt: string }> {
      const repo = join(base, 'repo');
      await mkdir(join(repo, 'pkg'), { recursive: true });
      await writeFile(join(repo, 'pkg', 'a.txt'), 'a\n');
      git(repo, 'init', '-q', '-b', 'main');
      git(repo, 'add', '.');
      git(repo, 'commit', '-q', '-m', 'init');
      const wt = join(home, '.agent', 'worktrees', 'repo-x', 'wt');
      await mkdir(join(home, '.agent', 'worktrees', 'repo-x'), { recursive: true });
      git(repo, 'worktree', 'add', '-q', '-b', 'hc/wt', wt);
      return { repo, wt };
    }

    it("is a project root of its own, sharing its main checkout's state", async () => {
      const { repo, wt } = await repoWithWorktree();
      expect(await linkedWorktreeMain(wt)).toBe(repo);
      expect(await linkedWorktreeMain(repo)).toBeUndefined();
      // Before: its `.git` is a file, so the search went on up — to the home directory's `.agent`.
      expect(await findMarkedProjectRoot(join(wt, 'pkg'))).toBe(wt);
      expect(await findProjectRoot(wt)).toBe(wt);
      expect(await findStateRoot(join(wt, 'pkg'))).toBe(repo);
      expect(await resolveStateDir(wt, { env: {}, homeDir: home })).toBe(await stateHome(repo, home));
      expect(await resolveProjectMemoryDir(join(wt, 'pkg'), home)).toBe(join(repo, '.agent', 'memory'));
    });

    it('reads the project settings of the main checkout', async () => {
      const { repo, wt } = await repoWithWorktree();
      await mkdir(join(repo, '.agent'), { recursive: true });
      await writeFile(join(repo, '.agent', 'settings.json'), JSON.stringify({ model: 'x/main-model' }));
      const { settings, sources } = await loadSettings(wt);
      expect(settings.model).toBe('x/main-model');
      expect(sources).toContain(join(repo, '.agent', 'settings.json'));
    });

    it('maps a marked sub-directory to the same one in the main checkout', async () => {
      const { repo, wt } = await repoWithWorktree();
      await mkdir(join(wt, 'pkg', '.agent'), { recursive: true });
      expect(await findProjectRoot(join(wt, 'pkg'))).toBe(join(wt, 'pkg'));
      expect(await findStateRoot(join(wt, 'pkg'))).toBe(join(repo, 'pkg'));
    });

    it('leaves a submodule-style .git file alone', async () => {
      const outer = join(base, 'outer');
      await mkdir(join(outer, '.git', 'modules', 'sub'), { recursive: true });
      await mkdir(join(outer, 'sub'));
      await writeFile(join(outer, 'sub', '.git'), 'gitdir: ../.git/modules/sub\n');
      expect(await linkedWorktreeMain(join(outer, 'sub'))).toBeUndefined();
      expect(await findMarkedProjectRoot(join(outer, 'sub'))).toBe(outer);
      expect(await findStateRoot(join(outer, 'sub'))).toBe(outer);
    });
  });
});
