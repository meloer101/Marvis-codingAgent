import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { clearUserAutoMode, loadSettings, writeProjectSettings, writeUserSettings } from './settings.js';

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

  it('never writes over a file that does not parse', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'hc-user-settings-'));
    tmpDirs.push(homeDir);
    await mkdir(join(homeDir, '.agent'), { recursive: true });
    await writeFile(join(homeDir, '.agent', 'settings.json'), '{"model": "a",', 'utf8');
    await expect(writeUserSettings({ model: 'b' }, { homeDir })).rejects.toThrow(/not valid JSON/);
    expect(await readFile(join(homeDir, '.agent', 'settings.json'), 'utf8')).toBe('{"model": "a",');
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

describe('writeProjectSettings', () => {
  it('patches the project layer loadSettings reads, permissions merged', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'hc-project-settings-'));
    const homeDir = await mkdtemp(join(tmpdir(), 'hc-user-settings-'));
    tmpDirs.push(cwd, homeDir);
    await mkdir(join(cwd, '.agent'), { recursive: true });
    await writeProjectSettings(cwd, { permissions: { allow: ['Bash(npm test:*)'] } });
    await writeProjectSettings(cwd, { permissions: { deny: ['Write(dist/**)'] } });
    const raw = JSON.parse(await readFile(join(cwd, '.agent', 'settings.json'), 'utf8')) as unknown;
    expect(raw).toEqual({ permissions: { allow: ['Bash(npm test:*)'], deny: ['Write(dist/**)'] } });
    const { settings } = await loadSettings(cwd, { homeDir });
    expect(settings.permissions?.deny).toContain('Write(dist/**)');
  });

  it('refuses auto-mode config', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'hc-project-settings-'));
    tmpDirs.push(cwd);
    await expect(writeProjectSettings(cwd, { autoMode: { allow: ['x'] } })).rejects.toThrow(/per user/);
  });
});
