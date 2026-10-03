import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { buildSandboxProfile, wrapCommand } from './macos-sandbox.js';

describe('buildSandboxProfile', () => {
  it('keeps harmless device writes open (git opens /dev/null read-write)', () => {
    const profile = buildSandboxProfile('/Users/m/project');
    expect(profile).toContain('(literal "/dev/null")');
    expect(profile).toContain('(regex #"^/dev/fd/")');
  });

  it.runIf(process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec'))(
    'lets a real sandboxed shell write /dev/null but not outside the workspace',
    () => {
      const profile = buildSandboxProfile(tmpdir());
      const run = (cmd: string) =>
        spawnSync('/usr/bin/sandbox-exec', ['-p', profile, '/bin/sh', '-c', cmd], { encoding: 'utf8' });
      expect(run('echo hi > /dev/null && echo ok').stdout.trim()).toBe('ok');
      expect(run('touch /usr/local/hc-sandbox-probe 2>/dev/null || echo denied').stdout.trim()).toBe('denied');
    },
  );

  it('denies file-write everywhere and re-allows it under the workspace', () => {
    const profile = buildSandboxProfile('/Users/m/project');
    expect(profile).toContain('(deny file-write* (subpath "/"))');
    expect(profile).toContain('(allow file-write* (subpath "/Users/m/project"))');
  });

  it('leaves reads, network, and process-exec at the default allow', () => {
    const profile = buildSandboxProfile('/Users/m/project');
    expect(profile).toContain('(allow default)');
    expect(profile).not.toMatch(/deny\s+file-read/);
    expect(profile).not.toMatch(/deny\s+network/);
    expect(profile).not.toMatch(/deny\s+process-exec/);
  });

  it('also allows writes under any extra writable paths given', () => {
    const profile = buildSandboxProfile('/Users/m/project', ['/tmp']);
    expect(profile).toContain('(allow file-write* (subpath "/tmp"))');
  });

  it('escapes double quotes and backslashes in paths', () => {
    const profile = buildSandboxProfile('/Users/m/weird "path"');
    expect(profile).toContain('(allow file-write* (subpath "/Users/m/weird \\"path\\""))');
  });
});

describe('wrapCommand', () => {
  it('leaves the command unwrapped when sandboxing is unavailable', () => {
    const result = wrapCommand(['-c', 'echo hi'], '/workspace', false);
    expect(result).toEqual({ cmd: '/bin/sh', args: ['-c', 'echo hi'] });
  });

  it('wraps with sandbox-exec and an inline profile when available', () => {
    const result = wrapCommand(['-c', 'echo hi'], '/workspace', true);
    expect(result.cmd).toBe('/usr/bin/sandbox-exec');
    expect(result.args[0]).toBe('-p');
    expect(result.args[1]).toContain('/workspace');
    expect(result.args.slice(2)).toEqual(['/bin/sh', '-c', 'echo hi']);
  });

  it('allows writes under the workspace and temp dirs by their resolved paths too', async () => {
    const { writableRoots } = await import('./macos-sandbox.js');
    const { realpathSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const roots = writableRoots(tmpdir());
    expect(roots).toContain(tmpdir());
    expect(roots).toContain(realpathSync(tmpdir()));
  });

  it("lets git in a linked worktree write the repository's .git", async () => {
    const { linkedWorktreeGitDir, writableRoots } = await import('./macos-sandbox.js');
    const { execFileSync } = await import('node:child_process');
    const { mkdtemp, realpath, rm, writeFile, mkdir } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const base = await realpath(await mkdtemp(join(tmpdir(), 'hc-sbx-')));
    try {
      const git = (cwd: string, ...args: string[]): string =>
        execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
          cwd,
          encoding: 'utf8',
        });
      const repo = join(base, 'repo');
      await mkdir(join(repo, 'src'), { recursive: true });
      await writeFile(join(repo, 'src', 'a.txt'), 'a\n');
      git(repo, 'init', '-q', '-b', 'main');
      git(repo, 'add', '.');
      git(repo, 'commit', '-q', '-m', 'init');
      const wt = join(base, 'wt');
      git(repo, 'worktree', 'add', '-q', '-b', 'feature', wt);
      expect(linkedWorktreeGitDir(join(wt, 'src'))).toBe(join(repo, '.git'));
      expect(writableRoots(join(wt, 'src'))).toContain(join(repo, '.git'));
      // The main checkout's .git is inside its workspace already.
      expect(linkedWorktreeGitDir(join(repo, 'src'))).toBeUndefined();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
