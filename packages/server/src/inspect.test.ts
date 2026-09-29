import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { expandHome, inspectDirectory, suggestDirs } from './inspect.js';

let home: string;
beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'hc-inspect-home-')));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('inspectDirectory', () => {
  it('refuses what cannot be a project', async () => {
    await writeFile(join(home, 'file.txt'), 'x');
    expect((await inspectDirectory(join(home, 'nope'), { home })).problem).toMatch(/No such directory/);
    expect((await inspectDirectory(join(home, 'file.txt'), { home })).problem).toMatch(/Not a directory/);
    expect((await inspectDirectory('~', { home })).problem).toMatch(/home directory is too broad/);
    expect((await inspectDirectory('/', { home })).problem).toMatch(/filesystem root/);
  });

  it('reads a git project: its MCP servers without secrets, and settings worth a look', async () => {
    const repo = join(home, 'code', 'repo');
    await mkdir(join(repo, '.git'), { recursive: true });
    await mkdir(join(repo, '.agent'));
    await writeFile(
      join(repo, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          fs: { command: 'npx', args: ['-y', 'server-filesystem', '.'] },
          api: { type: 'http', url: 'https://api.example/mcp?key=${API_KEY}' },
        },
      }),
    );
    await writeFile(
      join(repo, '.agent', 'settings.json'),
      JSON.stringify({
        permissions: { mode: 'yolo', allow: ['Bash(npm:*)'] },
        providers: { deepseek: { baseUrl: 'https://proxy.example/v1' } },
      }),
    );
    const found = await inspectDirectory('~/code/repo', { home });
    expect(found).toMatchObject({ exists: true, root: repo, projectRoot: repo, git: true, needsMarker: false });
    expect(found.problem).toBeUndefined();
    expect(found.mcpServers).toEqual([
      { name: 'fs', transport: 'stdio', command: 'npx -y server-filesystem .' },
      { name: 'api', transport: 'http', url: 'https://api.example/mcp?key=' },
    ]);
    expect(found.warnings.join('\n')).toMatch(/YOLO/);
    expect(found.warnings.join('\n')).toMatch(/pre-approve 1 kind/);
    expect(found.warnings.join('\n')).toMatch(/proxy\.example/);
  });

  it('asks for a marker where a plain folder would share the home state dir', async () => {
    await mkdir(join(home, '.agent'));
    await mkdir(join(home, 'notes'));
    const found = await inspectDirectory(join(home, 'notes'), { home });
    expect(found).toMatchObject({ needsMarker: true, projectRoot: join(home, 'notes'), git: false });
    expect(found.problem).toBeUndefined();
  });
});

describe('suggestDirs', () => {
  it('completes the last segment, hides dot-dirs unless asked, marks git repos', async () => {
    await mkdir(join(home, 'projects', 'alpha', '.git'), { recursive: true });
    await mkdir(join(home, 'projects', 'Alpine'));
    await mkdir(join(home, 'projects', '.hidden'));
    await writeFile(join(home, 'projects', 'apple.txt'), 'x');

    const al = await suggestDirs('~/projects/al', { home });
    expect(al.map((s) => [s.label, s.git])).toEqual([
      ['~/projects/alpha', true],
      ['~/projects/Alpine', false],
    ]);
    expect((await suggestDirs('~/projects/', { home })).map((s) => s.label)).toEqual([
      '~/projects/alpha',
      '~/projects/Alpine',
    ]);
    expect((await suggestDirs('~/projects/.h', { home })).map((s) => s.label)).toEqual(['~/projects/.hidden']);
    expect(await suggestDirs('~/missing/x', { home })).toEqual([]);
    expect((await suggestDirs('', { home })).map((s) => s.label)).toEqual(['~/projects']);
    expect(expandHome('~/x', '/h')).toBe('/h/x');
  });
});
