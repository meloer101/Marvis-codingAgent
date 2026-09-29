import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { fileWorkspaceStore, memoryWorkspaceStore, workspaceId } from './workspaces.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('workspace store', () => {
  it('derives one stable id per path', () => {
    expect(workspaceId('/a/b')).toBe(workspaceId('/a/b'));
    expect(workspaceId('/a/b')).not.toBe(workspaceId('/a/c'));
    expect(workspaceId('/a/b')).toMatch(/^[0-9a-f]{12}$/);
  });

  it('keeps records in a private file across instances, and reads junk as none', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hc-ws-store-'));
    dirs.push(dir);
    const path = join(dir, 'web', 'workspaces.json');
    const record = { id: 'abc', root: '/p', addedAt: 1, lastUsedAt: 2 };
    await fileWorkspaceStore(path).save([record]);
    expect(await fileWorkspaceStore(path).load()).toEqual([record]);
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ v: 1 });

    await writeFile(path, '{ not json');
    expect(await fileWorkspaceStore(path).load()).toEqual([]);
    await writeFile(path, JSON.stringify({ v: 1, workspaces: [record, { id: 1 }] }));
    expect(await fileWorkspaceStore(path).load()).toEqual([record]); // the malformed one is dropped
  });

  it('can live in memory only', async () => {
    const store = memoryWorkspaceStore();
    await store.save([{ id: 'x', root: '/x', addedAt: 1, lastUsedAt: 1 }]);
    expect(await store.load()).toHaveLength(1);
  });
});
