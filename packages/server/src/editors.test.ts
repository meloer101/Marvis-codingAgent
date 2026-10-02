import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { detectEditors } from './editors.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'hc-editors-'));
  dirs.push(d);
  return d;
}

async function executable(path: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, '#!/bin/sh\n');
  await chmod(path, 0o755);
}

describe('detectEditors', () => {
  it('uses the command-line tools on the PATH, each its own way to a line', async () => {
    const bin = await scratch();
    await executable(join(bin, 'code'));
    await executable(join(bin, 'zed'));
    const editors = await detectEditors({ env: { PATH: bin }, platform: 'linux', home: bin });
    expect(editors.map((e) => e.id)).toEqual(['vscode', 'zed']);
    expect(editors[0]!.launch('/w/a.ts', 12)).toEqual({ command: join(bin, 'code'), args: ['-g', '/w/a.ts:12'] });
    expect(editors[1]!.launch('/w/a.ts')).toEqual({ command: join(bin, 'zed'), args: ['/w/a.ts'] });
  });

  it("falls back to a Mac's installed apps: a URL scheme, or Zed's bundled CLI", async () => {
    const home = await scratch();
    await mkdir(join(home, 'Applications', 'Cursor.app'), { recursive: true });
    await executable(join(home, 'Applications', 'Zed.app', 'Contents', 'MacOS', 'cli'));
    const editors = await detectEditors({ env: { PATH: '' }, platform: 'darwin', home });
    const byId = Object.fromEntries(editors.map((e) => [e.id, e]));
    // /Applications may hold a real VS Code on this machine; what's under the fake home is certain.
    expect(byId['cursor']!.launch('/w/my file.ts', 3)).toEqual({ command: 'open', args: ['cursor://file/w/my%20file.ts:3'] });
    expect(byId['zed']!.launch('/w/a.ts', 3).args).toEqual(['/w/a.ts:3']);
    expect(await detectEditors({ env: { PATH: '' }, platform: 'linux', home })).toEqual([]);
  });
});
