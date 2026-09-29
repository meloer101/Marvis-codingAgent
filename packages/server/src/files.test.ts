import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FileIndex, fuzzyScore, listFiles } from './files.js';

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
