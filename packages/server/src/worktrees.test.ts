/**
 * A session's own git worktree: made off a base on a new branch under
 * `~/.agent/worktrees`, with `.worktreeinclude`'s ignored files copied in;
 * removed when the session is archived (branch kept) and checked out again
 * when it runs; gone with the session.
 */

import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_CAPABILITIES, ScriptedProvider, readSessionMeta, resolveStateDir } from '@harness-code/core';
import type { AgentSessionConfig, ResolvedModel } from '@harness-code/core';
import { afterEach, describe, expect, it } from 'vitest';

import { ConflictError } from './host.js';
import { WorkspaceHub } from './hub.js';
import type { WorkspaceSetupFactory } from './hub.js';
import { memoryWorkspaceStore } from './workspaces.js';
import {
  createWorktree,
  gitBranches,
  removeWorktree,
  restoreWorktree,
  slugFrom,
  worktreeChanges,
} from './worktrees.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** A repository on `main` with one commit, an ignored `.env` and `.worktreeinclude` naming it. */
async function repo(): Promise<string> {
  const root = await tempDir('hc-wt-repo-');
  git(root, 'init', '-q', '-b', 'main');
  await mkdir(join(root, 'app'));
  await writeFile(join(root, 'app', 'index.ts'), 'export {};\n');
  await writeFile(join(root, '.gitignore'), '.env\n.agent/\nnotes.txt\n');
  await writeFile(join(root, '.worktreeinclude'), '.env\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  await writeFile(join(root, '.env'), 'KEY=1\n');
  await writeFile(join(root, 'notes.txt'), 'ignored, but not named\n');
  return root;
}

describe('slugFrom', () => {
  it('takes the first words of a message, ASCII only, at most 32 characters', () => {
    expect(slugFrom('Fix the login bug, please')).toBe('fix-the-login-bug-please');
    expect(slugFrom('Rename `getUserById` across the whole codebase now')).toBe('rename-getuserbyid-across-the');
    expect(slugFrom('Café déjà vu')).toBe('cafe-deja-vu');
    expect(slugFrom('修一下登录')).toBe('');
  });
});

describe('worktrees', () => {
  it('lists local branches, the checked-out one first', async () => {
    const root = await repo();
    git(root, 'branch', 'feature');
    const branches = await gitBranches(root);
    expect(branches).toEqual({ repo: true, current: 'main', branches: ['main', 'feature'] });
    expect(await gitBranches(await tempDir('hc-wt-plain-'))).toEqual({ repo: false });
  });

  it('makes a branch off the base in a worktree under ~/.agent/worktrees, with the included files', async () => {
    const root = await repo();
    const home = await tempDir('hc-wt-home-');
    const { meta, cwd } = await createWorktree(join(root, 'app'), { base: 'main', hint: 'Fix the login bug', home });
    expect(meta.branch).toMatch(/^hc\/fix-the-login-bug-[0-9a-f]{4}$/);
    expect(meta.base).toBe('main');
    expect(meta.path.startsWith(join(home, '.agent', 'worktrees', ''))).toBe(true);
    expect(cwd).toBe(join(meta.path, 'app'));
    expect(git(meta.path, 'branch', '--show-current')).toBe(meta.branch);
    // Untracking: a push publishes the branch rather than aiming at main.
    expect(() => git(meta.path, 'rev-parse', '--abbrev-ref', '@{upstream}')).toThrow();
    expect(await readFile(join(meta.path, '.env'), 'utf8')).toBe('KEY=1\n');
    expect(await exists(join(meta.path, 'notes.txt'))).toBe(false);
    expect(await worktreeChanges(meta)).toBe(0);
  });

  it('refuses a base that does not exist', async () => {
    const root = await repo();
    await expect(createWorktree(root, { base: 'nope', home: await tempDir('hc-wt-home-') })).rejects.toThrow(/nope/);
  });

  it('removes a worktree keeping its branch, checks it out again, and deletes a merged branch', async () => {
    const root = await repo();
    const home = await tempDir('hc-wt-home-');
    const { meta } = await createWorktree(root, { base: 'main', hint: 'work', home });
    await writeFile(join(meta.path, 'new.txt'), 'x\n');
    expect(await worktreeChanges(meta)).toBe(1);
    git(meta.path, 'add', '.');
    git(meta.path, 'commit', '-q', '-m', 'work');

    await removeWorktree(root, meta, { home });
    expect(await exists(meta.path)).toBe(false);
    expect(git(root, 'branch', '--list', meta.branch)).toContain(meta.branch);

    await restoreWorktree(root, meta);
    expect(await readFile(join(meta.path, 'new.txt'), 'utf8')).toBe('x\n');
    expect(await readFile(join(meta.path, '.env'), 'utf8')).toBe('KEY=1\n');

    // Unmerged work keeps its branch; merged, it goes.
    await removeWorktree(root, meta, { deleteBranch: true, home });
    expect(git(root, 'branch', '--list', meta.branch)).toContain(meta.branch);
    git(root, 'merge', '-q', '--ff-only', meta.branch);
    await removeWorktree(root, meta, { deleteBranch: true, home });
    expect(git(root, 'branch', '--list', meta.branch)).toBe('');
  });
});

describe('a session in a worktree', () => {
  function scriptedModel(): ResolvedModel {
    const provider = new ScriptedProvider([{ text: 'done' }, { text: 'done again' }]);
    return { provider, providerId: provider.id, model: 'm', ref: `${provider.id}/m`, capabilities: { ...DEFAULT_CAPABILITIES } };
  }

  /** Scripted sessions that record to disk, in the cwd they are given. */
  const setups: WorkspaceSetupFactory = async (root) => {
    const agentDir = await resolveStateDir(root);
    return {
      projectRoot: root,
      agentDir,
      buildConfig: async (o): Promise<AgentSessionConfig> => ({
        cwd: o.cwd ?? root,
        model: scriptedModel(),
        settings: {},
        budgets: {},
        mode: 'yolo',
        skills: false,
        subagents: false,
        mcp: false,
        memory: false,
        recorder: true,
        trace: false,
        projectMemory: null,
        ...(o.resumeId ? { resumeId: o.resumeId } : {}),
      }),
      previewDefaults: async () => ({ modelRef: 'scripted/m', mode: 'yolo' }),
      effortFor: () => ({ levels: [], initial: undefined }),
      defaults: async () => ({ model: 'scripted/m', mode: 'yolo', modes: ['yolo'], effortLevels: [] }),
      models: async () => [],
    };
  };

  async function runToEnd(hub: WorkspaceHub, id: string): Promise<void> {
    const host = hub.host(id)!;
    await new Promise<void>((resolve) => {
      const unsub = host.addListener((f) => {
        if (f.t === 'evt' && (f.event.type === 'run_end' || f.event.type === 'run_error')) {
          unsub();
          resolve();
        }
      });
      if (!host.running) resolve();
    });
  }

  it('works there, is logged with the project, and goes away with archive and delete', async () => {
    const root = await repo();
    const home = await tempDir('hc-wt-home-');
    const hub = new WorkspaceHub({ store: memoryWorkspaceStore(), setup: setups, sweepMs: 0, home, pty: null });
    cleanups.push(() => hub.shutdown());
    const workspaceId = await hub.init(root);

    const { snapshot } = await hub.start({ workspaceId, text: 'Add a feature', worktree: { base: 'main' } });
    const worktree = snapshot.worktree!;
    expect(worktree.branch).toMatch(/^hc\/add-a-feature-/);
    await runToEnd(hub, snapshot.id);
    expect((await readSessionMeta(await resolveStateDir(root), snapshot.id))?.worktree).toEqual({
      path: worktree.path,
      branch: worktree.branch,
      base: 'main',
    });
    expect(worktree.cwd).toBe(worktree.path);
    expect((await hub.list()).find((r) => r.id === snapshot.id)?.worktree).toEqual({ branch: worktree.branch });

    // Files and git answer for the worktree, not the project's checkout.
    await writeFile(join(worktree.path, 'feature.txt'), 'new\n');
    const status = await hub.gitStatus(workspaceId, snapshot.id);
    expect(status).toMatchObject({ repo: true, branch: worktree.branch, files: [{ path: 'feature.txt' }] });
    expect(await hub.gitStatus(workspaceId)).toMatchObject({ repo: true, branch: 'main', files: [] });
    expect(await hub.readFile(workspaceId, 'feature.txt', snapshot.id)).toEqual({ kind: 'text', content: 'new\n' });

    // Archiving would lose the change: only when forced.
    await expect(hub.update(snapshot.id, { archived: true })).rejects.toBeInstanceOf(ConflictError);
    await hub.update(snapshot.id, { archived: true, force: true });
    expect(await exists(worktree.path)).toBe(false);
    expect(hub.host(snapshot.id)).toBeUndefined();
    expect((await hub.preview(snapshot.id)).worktree).toMatchObject({ branch: worktree.branch, missing: true });
    expect((await hub.list()).find((r) => r.id === snapshot.id)?.worktree).toEqual({ branch: worktree.branch, missing: true });
    expect(await hub.gitStatus(workspaceId, snapshot.id)).toEqual({ repo: false });

    // Acting on it checks the branch out again.
    const reopened = await hub.open(snapshot.id);
    expect(reopened.worktree).toMatchObject({ path: worktree.path });
    expect(await exists(join(worktree.path, 'app', 'index.ts'))).toBe(true);

    await hub.delete(snapshot.id);
    expect(await exists(worktree.path)).toBe(false);
    expect(git(root, 'branch', '--list', worktree.branch)).toBe('');
  });

  it("forks into a worktree of its own, branched from the other's branch", async () => {
    const root = await repo();
    const home = await tempDir('hc-wt-home-');
    const hub = new WorkspaceHub({ store: memoryWorkspaceStore(), setup: setups, sweepMs: 0, home, pty: null });
    cleanups.push(() => hub.shutdown());
    const workspaceId = await hub.init(root);
    const { snapshot } = await hub.start({ workspaceId, text: 'Add a feature', worktree: { base: 'main' } });
    await runToEnd(hub, snapshot.id);
    const source = snapshot.worktree!;
    await writeFile(join(source.path, 'done.txt'), 'x\n');
    git(source.path, 'add', '.');
    git(source.path, 'commit', '-q', '-m', 'progress');

    const forkId = await hub.fork(snapshot.id);
    const fork = await hub.preview(forkId);
    expect(fork.worktree?.branch).not.toBe(source.branch);
    expect(fork.worktree?.base).toBe(source.branch);
    expect(await readFile(join(fork.worktree!.path, 'done.txt'), 'utf8')).toBe('x\n');
    expect(fork.transcript.filter((t) => t.type === 'message')).toHaveLength(2);
    expect((await hub.list()).find((r) => r.id === forkId)?.title).toBe('Add a feature · fork');

    // As far as before its first message: an empty conversation.
    const empty = await hub.fork(snapshot.id, 0);
    expect((await hub.preview(empty)).transcript).toEqual([]);
  });

  it('leaves nothing behind when the session fails to start', async () => {
    const root = await repo();
    const home = await tempDir('hc-wt-home-');
    const hub = new WorkspaceHub({ store: memoryWorkspaceStore(), setup: setups, sweepMs: 0, home, pty: null });
    cleanups.push(() => hub.shutdown());
    const workspaceId = await hub.init(root);
    await expect(
      hub.start({ workspaceId, text: 'go', attachments: ['missing.txt'], worktree: { base: 'main' } }),
    ).rejects.toThrow();
    expect(git(root, 'worktree', 'list').split('\n')).toHaveLength(1);
    expect(git(root, 'branch', '--list', 'hc/*')).toBe('');
  });
});
