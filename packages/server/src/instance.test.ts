import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { startServer } from './index.js';
import type { RunningServer } from './index.js';
import {
  clearInstance,
  findRunningInstance,
  loadOrCreateToken,
  rotateToken,
  webStateDir,
  writeInstance,
} from './instance.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function home(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'hc-instance-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

describe('persisted token', () => {
  it('is created once, private to the user, and survives restarts', async () => {
    const dir = webStateDir(await home());
    const token = await loadOrCreateToken(dir);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(await loadOrCreateToken(dir)).toBe(token);
    if (process.platform !== 'win32') {
      expect((await stat(join(dir, 'token'))).mode & 0o777).toBe(0o600);
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
    }
  });

  it('is replaced by a rotation, and a damaged file gets a fresh one', async () => {
    const dir = webStateDir(await home());
    const first = await loadOrCreateToken(dir);
    const second = await rotateToken(dir);
    expect(second).not.toBe(first);
    expect(await loadOrCreateToken(dir)).toBe(second);
    await writeFile(join(dir, 'token'), 'not a token\n');
    const third = await loadOrCreateToken(dir);
    expect(third).toMatch(/^[0-9a-f]{64}$/);
    expect(third).not.toBe(second);
  });
});

describe('running instance', () => {
  async function serve(): Promise<RunningServer> {
    const cwd = await home();
    const server = await startServer({ cwd, mock: true });
    cleanups.push(() => server.close());
    return server;
  }

  it('is found while its server answers the health check with the recorded boot', async () => {
    const dir = webStateDir(await home());
    const server = await serve();
    const record = { pid: process.pid, port: server.port, version: 'x', bootId: server.bootId, cwd: '/w', startedAt: 1 };
    await writeInstance(dir, record);
    expect(await findRunningInstance(dir)).toEqual(record);

    // A record left by an older boot on the same port is not this server.
    await writeInstance(dir, { ...record, bootId: 'an-older-boot' });
    expect(await findRunningInstance(dir)).toBeNull();
  });

  it('is ignored when its process is gone or nothing listens', async () => {
    const dir = webStateDir(await home());
    await writeInstance(dir, { pid: 2 ** 30, port: 1, version: 'x', bootId: 'b', cwd: '/w', startedAt: 1 });
    expect(await findRunningInstance(dir)).toBeNull();
    await writeInstance(dir, { pid: process.pid, port: 1, version: 'x', bootId: 'b', cwd: '/w', startedAt: 1 });
    expect(await findRunningInstance(dir, 300)).toBeNull();
  });

  it('is cleared only by the process it describes', async () => {
    const dir = webStateDir(await home());
    await writeInstance(dir, { pid: 4242, port: 1, version: 'x', bootId: 'b', cwd: '/w', startedAt: 1 });
    await clearInstance(dir, process.pid);
    expect(JSON.parse(await readFile(join(dir, 'server.json'), 'utf8')).pid).toBe(4242);
    await clearInstance(dir, 4242);
    await expect(readFile(join(dir, 'server.json'), 'utf8')).rejects.toThrow();
  });
});
