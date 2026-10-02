import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FileIndex, fuzzyScore, listFiles, readWorkspaceFile } from './files.js';
import { WorkspacePathError } from './paths.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tree(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'hc-files-'));
  dirs.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

describe('fuzzyScore', () => {
  it('ranks a file-name match over a path match over a scattered one', () => {
    const paths = ['src/components/Composer.tsx', 'docs/composer-notes/readme.md', 'src/com/po/ser.ts', 'src/lib/sync.ts'];
    const ranked = paths
      .map((p) => ({ p, s: fuzzyScore(p, 'composer') }))
      .filter((x) => x.s !== null)
      .sort((a, b) => b.s! - a.s!)
      .map((x) => x.p);
    expect(ranked).toEqual(['src/components/Composer.tsx', 'docs/composer-notes/readme.md', 'src/com/po/ser.ts']);
    expect(fuzzyScore('src/lib/sync.ts', 'composer')).toBeNull();
  });

  it('finds scattered initials, preferring word starts', () => {
    expect(fuzzyScore('src/lib/sessionModel.ts', 'smts')).not.toBeNull();
    expect(fuzzyScore('packages/server/src/host.ts', 'psh')!).toBeGreaterThan(fuzzyScore('packages/server/src/xpsxh.ts', 'psh')!);
  });
});

describe('FileIndex', () => {
  it('outside git: walks the tree, skipping dependencies and secrets', async () => {
    const root = await tree({
      'src/app.ts': '',
      'src/app.test.ts': '',
      'node_modules/x/index.js': '',
      '.env': 'SECRET=1',
      'README.md': '',
    });
    expect((await listFiles(root)).sort()).toEqual(['.env', 'README.md', 'src/app.test.ts', 'src/app.ts']);
    const index = new FileIndex();
    expect((await index.search(root, '')).map((m) => m.path)).toEqual(['README.md', 'src/app.ts', 'src/app.test.ts']);
    expect((await index.search(root, 'app')).map((m) => m.path)).toEqual(['src/app.ts', 'src/app.test.ts']);
  });

  it('in git: follows .gitignore, untracked files included', async () => {
    const root = await tree({ 'kept.ts': '', 'ignored.log': '', '.gitignore': '*.log\n' });
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['add', 'kept.ts'], { cwd: root });
    await writeFile(join(root, 'new.ts'), '');
    expect((await listFiles(root)).sort()).toEqual(['.gitignore', 'kept.ts', 'new.ts']);
  });

  it('reuses a listing for a few seconds', async () => {
    const root = await tree({ 'a.ts': '' });
    let now = 0;
    const index = new FileIndex({ now: () => now });
    expect(await index.search(root, 'b')).toEqual([]);
    await writeFile(join(root, 'b.ts'), '');
    expect(await index.search(root, 'b')).toEqual([]);
    now = 60_000;
    expect(await index.search(root, 'b')).toEqual([{ path: 'b.ts' }]);
  });
});

describe('FileIndex.list', () => {
  it('lists a folder one level down, folders first, without ignored files or secrets', async () => {
    const root = await tree({
      'README.md': '',
      'src/b.ts': '',
      'src/a.ts': '',
      'src/lib/deep.ts': '',
      '.env': 'KEY=1',
      'dist/out.js': '',
      '.gitignore': 'dist/\n',
    });
    execFileSync('git', ['init', '-q'], { cwd: root });
    const index = new FileIndex();
    expect(await index.list(root, '')).toEqual([
      { name: 'src', dir: true },
      { name: '.gitignore', dir: false },
      { name: 'README.md', dir: false },
    ]);
    expect(await index.list(root, 'src')).toEqual([
      { name: 'lib', dir: true },
      { name: 'a.ts', dir: false },
      { name: 'b.ts', dir: false },
    ]);
    await expect(index.list(root, '../up')).rejects.toBeInstanceOf(WorkspacePathError);
  });

  it('sees new files once told the listing is stale', async () => {
    const root = await tree({ 'a.ts': '' });
    const index = new FileIndex();
    expect((await index.list(root, '')).map((e) => e.name)).toEqual(['a.ts']);
    await writeFile(join(root, 'b.ts'), '');
    expect((await index.list(root, '')).map((e) => e.name)).toEqual(['a.ts']);
    index.invalidate(root);
    expect((await index.list(root, '')).map((e) => e.name)).toEqual(['a.ts', 'b.ts']);
  });
});

describe('readWorkspaceFile', () => {
  it('reads text, and withholds binaries, big files, secrets and missing files', async () => {
    const root = await tree({ 'a.ts': 'const a = 1;\n', '.env': 'KEY=1', 'big.txt': 'x'.repeat(1024 * 1024 + 1) });
    await writeFile(join(root, 'img.bin'), Buffer.from([1, 0, 2]));
    expect(await readWorkspaceFile(root, 'a.ts')).toEqual({ kind: 'text', content: 'const a = 1;\n' });
    expect(await readWorkspaceFile(root, 'img.bin')).toEqual({ kind: 'binary' });
    expect(await readWorkspaceFile(root, 'big.txt')).toMatchObject({ kind: 'withheld', reason: expect.stringMatching(/Too big/) });
    expect(await readWorkspaceFile(root, '.env')).toMatchObject({ kind: 'withheld', reason: expect.stringMatching(/secret/) });
    expect(await readWorkspaceFile(root, 'gone.ts')).toEqual({ kind: 'withheld', reason: 'No such file.' });
    await expect(readWorkspaceFile(root, '../outside')).rejects.toBeInstanceOf(WorkspacePathError);
  });

  it('follows no link out of the workspace, nor to a secret inside it', async () => {
    const root = await realpath(await tree({ '.env': 'KEY=1', 'ok.ts': 'fine' }));
    const outside = await tree({ 'secret.txt': 'nope' });
    await symlink(join(outside, 'secret.txt'), join(root, 'escape.txt'));
    await symlink(join(root, '.env'), join(root, 'config.txt'));
    await symlink(join(root, 'ok.ts'), join(root, 'alias.ts'));
    expect(await readWorkspaceFile(root, 'escape.txt')).toMatchObject({ kind: 'withheld', reason: expect.stringMatching(/outside/) });
    expect(await readWorkspaceFile(root, 'config.txt')).toMatchObject({ kind: 'withheld', reason: expect.stringMatching(/secret/) });
    expect(await readWorkspaceFile(root, 'alias.ts')).toEqual({ kind: 'text', content: 'fine' });
  });
});
