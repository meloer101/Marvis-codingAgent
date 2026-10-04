import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SessionState } from '../agent/session.js';
import { isSandboxExecAvailable } from '../permissions/macos-sandbox.js';
import { isSensitivePath } from '../permissions/paths.js';
import { bashTool } from './bash.js';
import type { ToolContext } from './types.js';

describe('bashTool', () => {
  let cwd: string;
  let ctx: ToolContext;

  beforeEach(async () => {
    // realpath: os.tmpdir() is a symlink on macOS; assertInsideWorkspace()
    // realpaths everything, so `cwd` needs to be canonical too.
    cwd = await realpath(await mkdtemp(join(tmpdir(), 'hc-bash-')));
    ctx = { cwd, session: new SessionState() };
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('returns stdout on success', async () => {
    const result = await bashTool.execute({ command: 'echo hello' }, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.content.trim()).toBe('hello');
  });

  it('can still write inside the workspace, whether or not the OS sandbox is active', async () => {
    // On macOS this runs through wrapCommand()'s sandbox-exec path (see
    // macos-sandbox.test.ts); on any other platform — including this
    // project's ubuntu-latest CI — sandbox-exec isn't available and it
    // falls back to a plain spawn. Either way, a write inside the workspace
    // must succeed: the whole point of the profile is to scope writes to
    // this directory, not to block them here too.
    const { readFile } = await import('node:fs/promises');
    const result = await bashTool.execute({ command: 'echo hello > out.txt' }, ctx);
    expect(result.isError).toBeUndefined();
    expect((await readFile(join(cwd, 'out.txt'), 'utf8')).trim()).toBe('hello');
  });

  it('streams output as it comes, whole characters only, and returns all of it', async () => {
    const chunks: string[] = [];
    // A three-byte character split across two writes, then stderr. Octal
    // escapes: dash's printf (Linux /bin/sh) has no `\x`.
    const result = await bashTool.execute(
      { command: "printf '\\344\\275'; sleep 0.05; printf '\\240 ok\\n'; echo err >&2" },
      { ...ctx, onOutput: (t) => chunks.push(t) },
    );
    expect(result.content).toBe('你 ok\nerr\n');
    expect(chunks.join('')).toBe(result.content);
    expect(chunks.join('')).not.toContain('\ufffd');
  });

  it('reports a non-zero exit code as an error', async () => {
    const result = await bashTool.execute({ command: 'exit 3' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('exit code 3');
  });

  it('kills a command that exceeds the timeout', async () => {
    const result = await bashTool.execute({ command: 'sleep 5', timeoutMs: 100 }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('timed out');
  }, 10_000);

  // A process the shell started; reaped by init once the shell is gone, so poll.
  const gone = async (pid: number): Promise<boolean> => {
    for (let i = 0; i < 40; i++) {
      try {
        process.kill(pid, 0);
      } catch {
        return true;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  };

  it('on a timeout stops what the shell started too, and returns on time', async () => {
    for (const command of ['sleep 30 | cat', 'cd . && sleep 30']) {
      const started = Date.now();
      const result = await bashTool.execute({ command, timeoutMs: 200 }, ctx);
      expect(result.content, command).toContain('timed out');
      expect(Date.now() - started, command).toBeLessThan(5_000);
    }
    const result = await bashTool.execute({ command: 'sleep 30 & echo $!; wait', timeoutMs: 200 }, ctx);
    expect(await gone(Number(result.content.trim().split('\n')[0]))).toBe(true);
  }, 20_000);

  it('on an abort stops the command and what it started', async () => {
    const ac = new AbortController();
    let out = '';
    const result = await bashTool.execute(
      { command: 'sleep 30 & echo $!; wait' },
      {
        ...ctx,
        signal: ac.signal,
        onOutput: (t) => {
          out += t;
          if (out.includes('\n')) ac.abort();
        },
      },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('aborted');
    expect(await gone(Number(out.trim()))).toBe(true);
  }, 10_000);

  it('truncates very large output and reports how much was omitted', async () => {
    const result = await bashTool.execute(
      { command: 'node -e "process.stdout.write(\'x\'.repeat(50000))"' },
      ctx,
    );
    expect(result.content).toMatch(/characters.*omitted/);
    expect(result.content.length).toBeLessThan(50_000);
  });

  it('refuses a cwd outside the workspace without spawning', async () => {
    const result = await bashTool.execute({ command: 'echo pwned', cwd: '..' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/escapes the workspace/);
  });

  it('does not leak API keys into the child environment', async () => {
    const prev = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-test-should-not-leak';
    try {
      const result = await bashTool.execute(
        { command: 'node -e "process.stdout.write(process.env.OPENAI_API_KEY ?? \'\')"' },
        ctx,
      );
      expect(result.isError).toBeUndefined();
      // Empty stdout renders as the tool's own "(no output)" placeholder, not "".
      expect(result.content.trim()).toBe('(no output)');
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prev;
    }
  });

  describe('grep and rg skip secret files', () => {
    // Sensitive and look-alike names side by side; `isSensitivePath` decides
    // which should be found, so the globs cannot drift from it unnoticed.
    const NAMES = [
      '.env',
      'sub/.env.local',
      '.envrc',
      'id_rsa',
      'keys/id_rsa.pub',
      'keys/server.pem',
      'keys/CERT.PEM',
      'config/Credentials.json',
      'aws_credentials',
      'secrets.json',
      'secret.json',
      'environment.ts',
      'secrets.ts',
      'pem.txt',
      'src/app.ts',
    ];
    const visible = NAMES.filter((n) => !isSensitivePath(n)).sort();

    beforeEach(async () => {
      for (const name of NAMES) {
        await mkdir(join(cwd, dirname(name)), { recursive: true });
        await writeFile(join(cwd, name), 'KEY=value\n', 'utf8');
      }
    });

    const found = (output: string): string[] =>
      output
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => l.replace(/^\.\//, ''))
        .sort();

    it('in a recursive grep that names no file', async () => {
      const result = await bashTool.execute({ command: 'grep -rl KEY .' }, ctx);
      expect(result.isError).toBeUndefined();
      expect(found(result.content)).toEqual(visible);
    });

    it('in a grep that names the file', async () => {
      const result = await bashTool.execute({ command: 'grep -l KEY .env src/app.ts' }, ctx);
      expect(found(result.content)).toEqual(['src/app.ts']);
    });

    it('keeps grep exit status: no match is still exit 1', async () => {
      const result = await bashTool.execute({ command: 'grep nothing src/app.ts' }, ctx);
      expect(result.content).toContain('[exit code 1]');
    });

    // Probed outside the tool: inside it, `command -v rg` finds the guard's function.
    const hasRg = spawnSync('rg', ['--version']).error === undefined;

    it.skipIf(!hasRg)('in rg, which searches hidden files only when told to', async () => {
      const result = await bashTool.execute({ command: 'rg -l --hidden KEY .' }, ctx);
      expect(found(result.content)).toEqual(visible);
    });
  });

  describe('OS sandbox and symlinked paths', () => {
    it('writes in a workspace given by its unresolved temp-dir path, and to the temp dir', async () => {
      // No realpath here: this is the /var/folders/… path the eval harness
      // passes. Seatbelt matches real paths, so an unresolved allow clause
      // used to refuse every write.
      const raw = await mkdtemp(join(tmpdir(), 'hc-bash-raw-'));
      try {
        const ctxRaw: ToolContext = { cwd: raw, session: new SessionState() };
        const inWorkspace = await bashTool.execute({ command: 'mkdir -p out && echo x > out/o.txt && cat out/o.txt' }, ctxRaw);
        expect(inWorkspace.isError, inWorkspace.content).toBeUndefined();
        const probe = join(tmpdir(), `hc-bash-probe-${process.pid}.txt`);
        const inTmp = await bashTool.execute({ command: `echo t > ${probe} && cat ${probe} && rm ${probe}` }, ctxRaw);
        expect(inTmp.isError, inTmp.content).toBeUndefined();
      } finally {
        await rm(raw, { recursive: true, force: true });
      }
    });

    it.runIf(isSandboxExecAvailable())('still refuses a write outside the workspace and the temp dir', async () => {
      // The account's real home: `$HOME` is a directory under the temp dir while tests run.
      const outside = join(userInfo().homedir, `.hc-sandbox-probe-${process.pid}`);
      const result = await bashTool.execute({ command: `echo x > ${outside}` }, ctx);
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/not permitted/i);
    });
  });
});

