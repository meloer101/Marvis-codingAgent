import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  GitCommandError,
  createPullRequest,
  gitApplyHunk,
  gitCommit,
  gitDiff,
  gitPush,
  gitRevert,
  gitStage,
  gitStatus,
  gitUnstage,
  parseNumstat,
  parseStatus,
  splitHunks,
} from './git.js';
import { WorkspacePathError } from './paths.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function repo(): Promise<{ root: string; run: (...args: string[]) => string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hc-git-')));
  dirs.push(root);
  const run = (...args: string[]): string =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
      cwd: root,
      encoding: 'utf8',
    });
  run('init', '-q', '-b', 'main');
  // The module's own commits use the repository's identity.
  run('config', 'user.name', 't');
  run('config', 'user.email', 't@t');
  run('config', 'commit.gpgsign', 'false');
  return { root, run };
}

describe('gitStatus', () => {
  it('lists changes against HEAD with their sides and line counts', async () => {
    const { root, run } = await repo();
    await writeFile(join(root, 'a.txt'), 'one\ntwo\n');
    await writeFile(join(root, 'gone.txt'), 'bye\n');
    await writeFile(join(root, 'old name.txt'), 'same\ncontent\nhere\n');
    run('add', '.');
    run('commit', '-q', '-m', 'init');

    await writeFile(join(root, 'a.txt'), 'one\nTWO\nthree\n');
    run('add', 'a.txt');
    await writeFile(join(root, 'a.txt'), 'one\nTWO\nthree\nfour\n'); // staged and unstaged
    run('rm', '-q', 'gone.txt');
    run('mv', 'old name.txt', 'new name.txt');
    await writeFile(join(root, 'new.txt'), 'x\ny\n');

    const status = await gitStatus(root);
    if (!status.repo) throw new Error('expected a repo');
    expect(status.branch).toBe('main');
    const byPath = Object.fromEntries(status.files.map((f) => [f.path, f]));
    expect(byPath['a.txt']).toEqual({ path: 'a.txt', staged: 'modified', unstaged: 'modified', added: 3, removed: 1 });
    expect(byPath['gone.txt']).toEqual({ path: 'gone.txt', staged: 'deleted', added: 0, removed: 1 });
    expect(byPath['new name.txt']).toMatchObject({ oldPath: 'old name.txt', staged: 'renamed' });
    expect(byPath['new.txt']).toEqual({ path: 'new.txt', unstaged: 'untracked', added: 2, removed: 0 });
  });

  it('keeps to the workspace directory, with paths relative to it', async () => {
    const { root, run } = await repo();
    await mkdir(join(root, 'pkg'));
    await writeFile(join(root, 'pkg', 'in.ts'), 'a\n');
    await writeFile(join(root, 'out.ts'), 'a\n');
    run('add', '.');
    run('commit', '-q', '-m', 'init');
    await writeFile(join(root, 'pkg', 'in.ts'), 'b\n');
    await writeFile(join(root, 'out.ts'), 'b\n');

    const status = await gitStatus(join(root, 'pkg'));
    expect(status.repo && status.files).toEqual([{ path: 'in.ts', unstaged: 'modified', added: 1, removed: 1 }]);
  });

  it('works before the first commit, and says when there is no repository', async () => {
    const { root } = await repo();
    await writeFile(join(root, 'first.txt'), 'hi\n');
    const status = await gitStatus(root);
    expect(status.repo && status.branch).toBe('main');
    expect(status.repo && status.files).toEqual([{ path: 'first.txt', unstaged: 'untracked', added: 1, removed: 0 }]);

    const plain = await realpath(await mkdtemp(join(tmpdir(), 'hc-nogit-')));
    dirs.push(plain);
    expect(await gitStatus(plain)).toEqual({ repo: false });
  });
});

describe('gitDiff', () => {
  it("shows a tracked file's changes and an untracked file as all added", async () => {
    const { root, run } = await repo();
    await writeFile(join(root, 'a.ts'), 'const a = 1;\n');
    run('add', '.');
    run('commit', '-q', '-m', 'init');
    await writeFile(join(root, 'a.ts'), 'const a = 2;\n');
    await writeFile(join(root, 'b.ts'), 'new file\n');

    const a = await gitDiff(root, 'a.ts');
    expect(a.kind === 'text' && a.patch).toContain('-const a = 1;\n+const a = 2;');
    const b = await gitDiff(root, 'b.ts');
    expect(b.kind === 'text' && b.patch).toContain('+new file');
  });

  it('withholds secrets, says binary, and refuses paths outside the workspace', async () => {
    const { root } = await repo();
    await writeFile(join(root, '.env'), 'KEY=secret\n');
    await writeFile(join(root, 'img.bin'), Buffer.from([0, 1, 2, 0, 3]));
    expect(await gitDiff(root, '.env')).toMatchObject({ kind: 'withheld' });
    expect(await gitDiff(root, 'img.bin')).toEqual({ kind: 'binary' });
    await expect(gitDiff(root, '../elsewhere')).rejects.toBeInstanceOf(WorkspacePathError);
    await expect(gitDiff(root, '/etc/passwd')).rejects.toBeInstanceOf(WorkspacePathError);
  });
});

describe('parsers', () => {
  it('reads porcelain v2 records, renames and branch headers', () => {
    const out = [
      '# branch.oid abc',
      '# branch.head feature',
      '# branch.upstream origin/feature',
      '# branch.ab +2 -1',
      '1 .M N... 100644 100644 100644 aaa bbb sub/with space.ts',
      '2 R. N... 100644 100644 100644 aaa bbb R100 sub/new.ts',
      'sub/old.ts',
      'u UU N... 100644 100644 100644 100644 a b c sub/conflict.ts',
      '? sub/fresh.ts',
      '? elsewhere.ts',
      '',
    ].join('\0');
    expect(parseStatus(out, 'sub/')).toEqual({
      branch: 'feature',
      upstream: 'origin/feature',
      ahead: 2,
      behind: 1,
      files: [
        { path: 'with space.ts', unstaged: 'modified' },
        { path: 'new.ts', oldPath: 'old.ts', staged: 'renamed' },
        { path: 'conflict.ts', staged: 'conflicted', unstaged: 'conflicted' },
        { path: 'fresh.ts', unstaged: 'untracked' },
        { path: 'elsewhere.ts', unstaged: 'untracked' },
      ],
    });
  });

  it('reads numstat, renames and binaries included', () => {
    const out = ['3\t1\ta.ts', '0\t0\t', 'old.ts', 'new.ts', '-\t-\timg.png', ''].join('\0');
    expect([...parseNumstat(out)]).toEqual([
      ['a.ts', { added: 3, removed: 1 }],
      ['new.ts', { added: 0, removed: 0 }],
      ['img.png', { binary: true }],
    ]);
  });
});

const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

describe('changing git state', () => {
  async function committed() {
    const r = await repo();
    await writeFile(join(r.root, 'a.txt'), 'one\n');
    await writeFile(join(r.root, 'b.txt'), 'two\n');
    r.run('add', '.');
    r.run('commit', '-q', '-m', 'init');
    return r;
  }
  const files = async (root: string) => {
    const s = await gitStatus(root);
    return s.repo ? s.files.map((f) => [f.path, f.staged ?? null, f.unstaged ?? null]) : [];
  };

  it('stages and unstages files, new ones and deletions included', async () => {
    const { root } = await committed();
    await writeFile(join(root, 'a.txt'), 'ONE\n');
    await writeFile(join(root, 'new.txt'), 'x\n');
    await rm(join(root, 'b.txt'));
    await gitStage(root, ['a.txt', 'new.txt', 'b.txt']);
    expect(await files(root)).toEqual([
      ['a.txt', 'modified', null],
      ['b.txt', 'deleted', null],
      ['new.txt', 'added', null],
    ]);
    await gitUnstage(root, ['a.txt', 'new.txt']);
    expect(await files(root)).toEqual([
      ['a.txt', null, 'modified'],
      ['b.txt', 'deleted', null],
      ['new.txt', null, 'untracked'],
    ]);
  });

  it('reverts to HEAD, deleting what HEAD lacks, but never a secret', async () => {
    const { root, run } = await committed();
    await writeFile(join(root, 'a.txt'), 'changed\n');
    run('add', 'a.txt');
    await writeFile(join(root, 'scratch.txt'), 'tmp\n');
    await writeFile(join(root, 'staged-new.txt'), 'tmp\n');
    run('add', 'staged-new.txt');
    run('mv', 'b.txt', 'renamed.txt');
    await gitRevert(root, ['a.txt', 'scratch.txt', 'staged-new.txt', 'renamed.txt']);
    expect(await files(root)).toEqual([]);
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('one\n');
    expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('two\n');
    expect(await exists(join(root, 'scratch.txt'))).toBe(false);

    await writeFile(join(root, '.env'), 'KEY=1\n');
    await expect(gitRevert(root, ['.env'])).rejects.toThrow(/secret/);
    expect(await exists(join(root, '.env'))).toBe(true);
  });

  it('commits what is staged, or the files it is given; a message is required', async () => {
    const { root, run } = await committed();
    await writeFile(join(root, 'a.txt'), 'ONE\n');
    await writeFile(join(root, 'b.txt'), 'TWO\n');
    await gitStage(root, ['a.txt']);
    const first = await gitCommit(root, 'Change a\n\nbody');
    expect(first.summary).toBe('Change a');
    expect(run('rev-parse', '--short', 'HEAD').trim()).toBe(first.sha);
    expect(await files(root)).toEqual([['b.txt', null, 'modified']]);
    await expect(gitCommit(root, '   ')).rejects.toBeInstanceOf(GitCommandError);
    await gitCommit(root, 'The rest', { paths: ['b.txt'] });
    expect(await files(root)).toEqual([]);
    await expect(gitCommit(root, 'Nothing')).rejects.toBeInstanceOf(GitCommandError);
  });

  it('pushes, setting the upstream the first time', async () => {
    const { root, run } = await committed();
    const remote = await realpath(await mkdtemp(join(tmpdir(), 'hc-remote-')));
    dirs.push(remote);
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main'], { cwd: remote });
    await expect(gitPush(root)).rejects.toThrow(/no remote/);
    run('remote', 'add', 'origin', remote);
    await gitPush(root);
    const status = await gitStatus(root);
    expect(status.repo && [status.upstream, status.ahead]).toEqual(['origin/main', 0]);
    await writeFile(join(root, 'a.txt'), 'again\n');
    await gitCommit(root, 'Again', { paths: ['a.txt'] });
    const ahead = await gitStatus(root);
    expect(ahead.repo && ahead.ahead).toBe(1);
    await gitPush(root);
    expect(execFileSync('git', ['log', '-1', '--format=%s', 'main'], { cwd: remote, encoding: 'utf8' }).trim()).toBe('Again');
  });

  it('says plainly when the GitHub CLI is missing', async () => {
    const { root } = await committed();
    const path = process.env['PATH'];
    process.env['PATH'] = '';
    try {
      await expect(createPullRequest(root, { title: 'x' })).rejects.toThrow(/GitHub CLI \(gh\) is not installed/);
    } finally {
      process.env['PATH'] = path;
    }
  });
});

describe('hunks', () => {
  /** A committed file of 30 numbered lines, then two changes far enough apart to be two hunks. */
  async function twoHunks(sub = ''): Promise<{ root: string; run: (...args: string[]) => string; file: string; dir: string }> {
    const { root, run } = await repo();
    const dir = join(root, sub);
    await mkdir(dir, { recursive: true });
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    const file = join(dir, 'f.txt');
    await writeFile(file, `${lines.join('\n')}\n`);
    run('add', '.');
    run('commit', '-q', '-m', 'init');
    lines[1] = 'line 2 changed';
    lines[27] = 'line 28 changed';
    await writeFile(file, `${lines.join('\n')}\n`);
    return { root, run, file, dir };
  }

  const hunksOf = async (root: string, side: 'staged' | 'unstaged') => {
    const diff = await gitDiff(root, 'f.txt', side);
    return diff.kind === 'text' ? splitHunks(diff.patch).hunks : [];
  };

  it('splits a patch into its header and hunks', () => {
    const { header, hunks } = splitHunks('diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n@@ -9 +9 @@\n-c\n+d\n\\ No newline at end of file\n');
    expect(header).toBe('diff --git a/f b/f\n--- a/f\n+++ b/f\n');
    expect(hunks).toEqual(['@@ -1 +1 @@\n-a\n+b\n', '@@ -9 +9 @@\n-c\n+d\n\\ No newline at end of file\n']);
  });

  it('stages one hunk, unstages it, and discards the other', async () => {
    const { root, file } = await twoHunks();
    const unstaged = await hunksOf(root, 'unstaged');
    expect(unstaged).toHaveLength(2);

    await gitApplyHunk(root, 'f.txt', unstaged[0]!, 'stage');
    expect((await gitStatus(root)).repo && (await gitStatus(root))).toMatchObject({ files: [{ path: 'f.txt', staged: 'modified', unstaged: 'modified' }] });
    const staged = await hunksOf(root, 'staged');
    expect(staged).toHaveLength(1);
    expect(staged[0]).toContain('+line 2 changed');
    expect(await hunksOf(root, 'unstaged')).toHaveLength(1);

    await gitApplyHunk(root, 'f.txt', staged[0]!, 'unstage');
    expect(await hunksOf(root, 'staged')).toHaveLength(0);

    const second = (await hunksOf(root, 'unstaged'))[1]!;
    await gitApplyHunk(root, 'f.txt', second, 'discard');
    const text = await readFile(file, 'utf8');
    expect(text).toContain('line 2 changed');
    expect(text).toContain('line 28\n');
  });

  it('refuses a hunk that is no longer there', async () => {
    const { root, file } = await twoHunks();
    const [first] = await hunksOf(root, 'unstaged');
    await writeFile(file, (await readFile(file, 'utf8')).replace('line 2 changed', 'line 2 changed again'));
    await expect(gitApplyHunk(root, 'f.txt', first!, 'stage')).rejects.toThrow(/changed since/);
  });

  it('works in a workspace that is a subdirectory of the repository', async () => {
    const { dir } = await twoHunks('pkg/app');
    const [first] = await hunksOf(dir, 'unstaged');
    await gitApplyHunk(dir, 'f.txt', first!, 'stage');
    expect(await hunksOf(dir, 'staged')).toHaveLength(1);
  });
});
