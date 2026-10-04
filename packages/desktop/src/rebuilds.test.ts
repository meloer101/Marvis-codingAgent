import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { backendDirs, sourceRoot, watchRebuilds } from './rebuilds.js';
import type { RebuildWatch } from './rebuilds.js';

let dir: string;
let watcher: RebuildWatch | undefined;

async function checkout(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'marvis-rebuilds-'));
  await writeFile(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
  for (const name of ['core', 'server', 'web']) await mkdir(join(dir, 'packages', name, 'dist'), { recursive: true });
  await writeFile(join(dir, 'packages/web/dist/index.html'), '<script src="/assets/index-aaa.js"></script>');
  return dir;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(async () => {
  watcher?.close();
  watcher = undefined;
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('sourceRoot', () => {
  it('finds the checkout a build sits in', async () => {
    const root = await checkout();
    expect(sourceRoot(join(root, 'packages/server/dist'))).toBe(root);
  });

  it('is undefined outside one (the packaged app)', () => {
    expect(sourceRoot(tmpdir())).toBeUndefined();
  });
});

describe('backendDirs', () => {
  it("lists the built server packages' dist directories", async () => {
    const root = await checkout();
    expect(backendDirs(root)).toEqual([join(root, 'packages/core/dist'), join(root, 'packages/server/dist')]);
  });
});

describe('watchRebuilds', () => {
  it('reports a new web bundle once, and not the same one written again', async () => {
    const root = await checkout();
    const onWeb = vi.fn();
    const webDir = join(root, 'packages/web/dist');
    watcher = watchRebuilds({ webDir, onWeb, onBackend: () => {}, settleMs: 50 });
    await pause(100);

    await writeFile(join(webDir, 'index.html'), '<script src="/assets/index-aaa.js"></script>');
    await pause(250);
    expect(onWeb).not.toHaveBeenCalled();

    await writeFile(join(webDir, 'assets.txt'), 'x');
    await writeFile(join(webDir, 'index.html'), '<script src="/assets/index-bbb.js"></script>');
    await pause(250);
    expect(onWeb).toHaveBeenCalledTimes(1);
  });

  it('reports a server rebuild once it settles', async () => {
    const root = await checkout();
    const onBackend = vi.fn();
    watcher = watchRebuilds({ backendDirs: backendDirs(root), onWeb: () => {}, onBackend, backendSettleMs: 300 });
    await pause(100);

    for (let i = 0; i < 5; i++) await writeFile(join(root, 'packages/server/dist', `file${i}.js`), `// ${i}`);
    await pause(900);
    expect(onBackend).toHaveBeenCalled();
  });

  it('ignores what was written before the watch began', async () => {
    const root = await checkout();
    await writeFile(join(root, 'packages/core/dist/index.js'), '// old build');
    const onBackend = vi.fn();
    watcher = watchRebuilds({ backendDirs: backendDirs(root), onWeb: () => {}, onBackend, backendSettleMs: 300 });
    await pause(900);
    expect(onBackend).not.toHaveBeenCalled();
  });
});
