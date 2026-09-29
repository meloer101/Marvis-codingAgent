import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { startServer } from './index.js';
import { callRunningServer } from './remote.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function repo(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  await mkdir(join(dir, '.git'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

describe('callRunningServer', () => {
  it('adds a project to a running server with its token, and is refused without it', async () => {
    const [launch, other] = [await repo('hc-remote-a-'), await repo('hc-remote-b-')];
    const server = await startServer({ cwd: launch, mock: true });
    cleanups.push(() => server.close());

    const added = await callRunningServer(server.port, server.token, 'workspace.add', { path: other });
    expect(added.root).toBe(other);
    const listed = await callRunningServer(server.port, server.token, 'workspace.list', undefined);
    expect(listed.map((w) => w.root).sort()).toEqual([launch, other].sort());

    await expect(callRunningServer(server.port, 'not-the-token', 'workspace.list', undefined)).rejects.toThrow(
      /invalid token/,
    );
  });
});
