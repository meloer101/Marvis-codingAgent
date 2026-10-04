import { describe, expect, it } from 'vitest';

import { isAppUrl, lastProject, pageUrl } from './launch.js';

const record = (root: string, lastUsedAt: number) => ({ id: root, root, addedAt: 0, lastUsedAt });

describe('lastProject', () => {
  it('picks the most recently used project', async () => {
    const records = [record('/a', 1), record('/b', 3), record('/c', 2)];
    expect(await lastProject(records, async () => true)).toBe('/b');
  });

  it('skips projects whose folder is gone', async () => {
    const records = [record('/a', 1), record('/gone', 3)];
    expect(await lastProject(records, async (p) => p !== '/gone')).toBe('/a');
  });

  it('has none on a first launch', async () => {
    expect(await lastProject([], async () => true)).toBeUndefined();
  });
});

describe('isAppUrl', () => {
  it('accepts the page on its port, by either host name', () => {
    expect(isAppUrl(pageUrl(4317, 'abc'), 4317)).toBe(true);
    expect(isAppUrl('http://localhost:4317/settings', 4317)).toBe(true);
  });

  it('rejects other ports, hosts and schemes', () => {
    expect(isAppUrl('http://127.0.0.1:5173/', 4317)).toBe(false);
    expect(isAppUrl('https://127.0.0.1:4317/', 4317)).toBe(false);
    expect(isAppUrl('https://github.com/', 4317)).toBe(false);
    expect(isAppUrl('not a url', 4317)).toBe(false);
  });
});
