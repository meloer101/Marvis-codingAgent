import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { clearUserAutoMode, writeUserSettings } from './settings.js';

const tmpDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('writeUserSettings', () => {
  it('replaces autoMode arrays instead of concatenating them', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'hc-user-settings-'));
    tmpDirs.push(homeDir);
    await writeUserSettings({ autoMode: { environment: ['$defaults', 'Org: a'] } }, { homeDir });
    await writeUserSettings({ autoMode: { environment: ['$defaults', 'Org: b'] } }, { homeDir });
    const raw = JSON.parse(await readFile(join(homeDir, '.agent', 'settings.json'), 'utf8')) as {
      autoMode: { environment: string[] };
    };
    expect(raw.autoMode.environment).toEqual(['$defaults', 'Org: b']);
  });

  it('clearUserAutoMode drops only the autoMode block', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'hc-user-settings-'));
    tmpDirs.push(homeDir);
    await writeUserSettings({ model: 'ollama/qwen', autoMode: { classifyAllShell: true } }, { homeDir });
    await clearUserAutoMode({ homeDir });
    const raw = JSON.parse(await readFile(join(homeDir, '.agent', 'settings.json'), 'utf8')) as {
      model?: string;
      autoMode?: unknown;
    };
    expect(raw.model).toBe('ollama/qwen');
    expect(raw.autoMode).toBeUndefined();
  });
});
