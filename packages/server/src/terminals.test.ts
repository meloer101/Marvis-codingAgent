import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { SCROLLBACK_CHARS, TerminalManager, TerminalNotFoundError, loadPty, userShell } from './terminals.js';
import type { Pty, SpawnPty } from './terminals.js';

/** A pty the test drives: what the shell "prints", and what was written to it. */
function fakePty() {
  let onData: (d: string) => void = () => {};
  let onExit: (e: { exitCode: number }) => void = () => {};
  const pty: Pty & { written: string[]; size: [number, number]; killed: boolean } = {
    written: [],
    size: [0, 0],
    killed: false,
    onData: (l) => (onData = l),
    onExit: (l) => (onExit = l),
    write: (d) => pty.written.push(d),
    resize: (c, r) => (pty.size = [c, r]),
    kill: () => (pty.killed = true),
  };
  return { pty, print: (d: string) => onData(d), exit: (code: number) => onExit({ exitCode: code }) };
}

function manager() {
  const ptys: Array<ReturnType<typeof fakePty>> = [];
  const spawned: Array<Parameters<SpawnPty>> = [];
  const spawn: SpawnPty = (...args) => {
    spawned.push(args);
    const p = fakePty();
    ptys.push(p);
    return p.pty;
  };
  const changes: string[] = [];
  const terminals = new TerminalManager({ spawn, onChange: (w) => changes.push(w), env: { SHELL: '/bin/zsh', HOME: '/h' } });
  return { terminals, ptys, spawned, changes };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

describe('TerminalManager', () => {
  it("starts the user's login shell in the workspace, sized, and lists it", async () => {
    const { terminals, spawned, changes } = manager();
    const t = await terminals.create('w1', '/proj', 100, 30);
    expect(t).toMatchObject({ workspaceId: 'w1', title: 'zsh', cwd: '/proj' });
    expect(t.id).toMatch(/^term-[0-9a-f]{12}$/);
    const [shell, args, opts] = spawned[0]!;
    expect([shell, args, opts.cols, opts.rows, opts.cwd]).toEqual(['/bin/zsh', ['-l'], 100, 30, '/proj']);
    expect(opts.env).toMatchObject({ HOME: '/h', TERM: 'xterm-256color', COLORTERM: 'truecolor' });
    expect(changes).toEqual(['w1']);
    expect(terminals.list('w1').map((x) => x.id)).toEqual([t.id]);
    expect(terminals.list('w2')).toEqual([]);
  });

  it('gathers output into one frame, keeps it for a tab that attaches later, and forwards keys and sizes', async () => {
    const { terminals, ptys } = manager();
    const { id } = await terminals.create('w1', '/proj', 80, 24);
    const out: unknown[] = [];
    const a = terminals.attach(id, (o) => out.push(o));
    expect(a.scrollback).toBe('');
    ptys[0]!.print('he');
    ptys[0]!.print('llo\r\n');
    await settle();
    expect(out).toEqual([{ data: 'hello\r\n' }]);
    // A second tab (or a reconnect) gets what came before, then the stream.
    expect(terminals.attach(id, () => {}).scrollback).toBe('hello\r\n');
    terminals.input(id, 'ls\r');
    terminals.resize(id, 120, 40);
    expect(ptys[0]!.pty.written).toEqual(['ls\r']);
    expect(ptys[0]!.pty.size).toEqual([120, 40]);
    a.detach();
    ptys[0]!.print('more');
    await settle();
    expect(out).toHaveLength(1);
  });

  it('keeps only the last stretch of output', async () => {
    const { terminals, ptys } = manager();
    const { id } = await terminals.create('w1', '/proj', 80, 24);
    for (let i = 0; i < 5; i++) {
      ptys[0]!.print(String(i).repeat(SCROLLBACK_CHARS / 2));
      await settle();
    }
    const kept = terminals.attach(id, () => {}).scrollback;
    expect(kept.length).toBeLessThanOrEqual(SCROLLBACK_CHARS);
    expect(kept.endsWith('4')).toBe(true);
    expect(kept.includes('0')).toBe(false);
  });

  it('says when the shell exits, keeps the terminal until closed, and closes a workspace’s', async () => {
    const { terminals, ptys, changes } = manager();
    const a = await terminals.create('w1', '/proj', 80, 24);
    const b = await terminals.create('w1', '/proj', 80, 24);
    const out: unknown[] = [];
    terminals.attach(a.id, (o) => out.push(o));
    ptys[0]!.print('bye');
    ptys[0]!.exit(3);
    expect(out).toEqual([{ data: 'bye' }, { exitCode: 3 }]);
    expect(terminals.list('w1')[0]).toMatchObject({ id: a.id, exitCode: 3 });
    terminals.input(a.id, 'ignored');
    expect(ptys[0]!.pty.written).toEqual([]);
    expect(changes).toEqual(['w1', 'w1', 'w1']);

    terminals.closeWorkspace('w1');
    expect(ptys[1]!.pty.killed).toBe(true);
    expect(terminals.list('w1')).toEqual([]);
    expect(() => terminals.input(b.id, 'x')).toThrow(TerminalNotFoundError);
  });

  it('refuses to start one where node-pty could not be loaded', async () => {
    const terminals = new TerminalManager({ spawn: null, onChange: vi.fn() });
    expect(await terminals.available()).toBe(false);
    await expect(terminals.create('w1', '/proj', 80, 24)).rejects.toThrow(/not available/);
  });
});

describe('userShell', () => {
  it('starts a POSIX shell as a login shell, anything else as it is', () => {
    expect(userShell({ SHELL: '/opt/homebrew/bin/fish' }, 'darwin')).toEqual({ shell: '/opt/homebrew/bin/fish', args: ['-l'] });
    expect(userShell({ SHELL: '/usr/bin/nu' }, 'linux')).toEqual({ shell: '/usr/bin/nu', args: [] });
    expect(userShell({}, 'linux')).toEqual({ shell: '/bin/bash', args: ['-l'] });
    expect(userShell({ COMSPEC: 'C:\\cmd.exe' }, 'win32')).toEqual({ shell: 'C:\\cmd.exe', args: [] });
  });
});

describe('a real terminal', async () => {
  const spawn = await loadPty();
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it.skipIf(!spawn)('runs a command in the workspace and reports its exit', async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), 'hc-term-')));
    dirs.push(cwd);
    const terminals = new TerminalManager({ spawn, onChange: () => {}, env: { ...process.env, SHELL: '/bin/sh' } });
    const { id } = await terminals.create('w1', cwd, 80, 24);
    let out = '';
    const exited = new Promise<number>((resolve) => {
      terminals.attach(id, (o) => ('data' in o ? (out += o.data) : resolve(o.exitCode)));
    });
    terminals.input(id, 'pwd; tput cols; exit 7\r');
    expect(await exited).toBe(7);
    expect(out).toContain(cwd);
    expect(out).toContain('80');
    terminals.shutdown();
  });
});
