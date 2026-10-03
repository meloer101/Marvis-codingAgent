import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { detectFolderPicker, oneAtATime } from './picker.js';
import type { Run, RunResult } from './picker.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'hc-picker-'));
  dirs.push(d);
  return d;
}

async function executable(path: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, '#!/bin/sh\n');
  await chmod(path, 0o755);
}

/** A runner that records what it was asked to run and answers with `result`. */
function runner(result: Partial<RunResult>) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const run: Run = async (command, args) => {
    calls.push({ command, args });
    return { code: 0, stdout: '', stderr: '', ...result };
  };
  return { run, calls };
}

describe('detectFolderPicker', () => {
  it("on a Mac, asks osascript to choose a folder from home, the prompt as an argument, not as script", async () => {
    const bin = await scratch();
    await executable(join(bin, 'osascript'));
    const { run, calls } = runner({ stdout: '/Users/me/code/app/\n' });
    const picker = await detectFolderPicker({ platform: 'darwin', home: '/Users/me', run, osascript: join(bin, 'osascript') });
    expect(await picker!.pick('Choose "a" folder')).toBe('/Users/me/code/app');
    const { command, args } = calls[0]!;
    expect(command).toBe(join(bin, 'osascript'));
    expect(args.filter((a) => a !== '-e').at(-2)).toBe('Choose "a" folder');
    expect(args.at(-1)).toBe('/Users/me');
    const script = args.filter((_, i) => args[i - 1] === '-e');
    expect(script.join('\n')).toContain('choose folder');
    expect(script.some((line) => line.includes('Choose "a" folder'))).toBe(false);
  });

  it("reads osascript's -128 as cancelled, and other failures as errors", async () => {
    const bin = await scratch();
    await executable(join(bin, 'osascript'));
    const cancelled = runner({ code: 1, stderr: 'execution error: User canceled. (-128)' });
    const picker = await detectFolderPicker({ platform: 'darwin', run: cancelled.run, osascript: join(bin, 'osascript') });
    expect(await picker!.pick('x')).toBeNull();

    const broken = runner({ code: 1, stderr: 'execution error: Not authorized. (-1743)' });
    const failing = await detectFolderPicker({ platform: 'darwin', run: broken.run, osascript: join(bin, 'osascript') });
    await expect(failing!.pick('x')).rejects.toThrow('Not authorized');
  });

  it('has none on a Mac without osascript', async () => {
    expect(await detectFolderPicker({ platform: 'darwin', osascript: '/nowhere/osascript' })).toBeNull();
  });

  it('on a Linux desktop, uses zenity (else kdialog); exit 1 is a cancel', async () => {
    const bin = await scratch();
    await executable(join(bin, 'kdialog'));
    const { run, calls } = runner({ code: 1 });
    const kde = await detectFolderPicker({ platform: 'linux', env: { PATH: bin, DISPLAY: ':0' }, home: '/home/me', run });
    expect(await kde!.pick('Pick')).toBeNull();
    expect(calls[0]).toEqual({ command: join(bin, 'kdialog'), args: ['--getexistingdirectory', '/home/me', '--title', 'Pick'] });

    await executable(join(bin, 'zenity'));
    const picked = runner({ stdout: '/home/me/app\n' });
    const gnome = await detectFolderPicker({ platform: 'linux', env: { PATH: bin, WAYLAND_DISPLAY: 'wayland-0' }, home: '/home/me', run: picked.run });
    expect(await gnome!.pick('Pick')).toBe('/home/me/app');
    expect(picked.calls[0]!.command).toBe(join(bin, 'zenity'));
    expect(picked.calls[0]!.args).toContain('--directory');
  });

  it('has none on a Linux without a desktop session, or without a dialog tool', async () => {
    const bin = await scratch();
    await executable(join(bin, 'zenity'));
    expect(await detectFolderPicker({ platform: 'linux', env: { PATH: bin } })).toBeNull();
    expect(await detectFolderPicker({ platform: 'linux', env: { PATH: await scratch(), DISPLAY: ':0' } })).toBeNull();
  });

  it("on Windows, asks PowerShell's folder dialog, the prompt's quotes doubled; nothing printed is a cancel", async () => {
    const { run, calls } = runner({ stdout: '' });
    const picker = await detectFolderPicker({ platform: 'win32', run });
    expect(await picker!.pick("Pick hc's folder")).toBeNull();
    expect(calls[0]!.command).toBe('powershell.exe');
    expect(calls[0]!.args.at(-1)).toContain("$d.Description = 'Pick hc''s folder'");
  });
});

describe('oneAtATime', () => {
  it('shows one chooser: asking while it is open waits for its answer', async () => {
    let answer!: (path: string | null) => void;
    const pick = vi.fn(() => new Promise<string | null>((resolve) => (answer = resolve)));
    const picker = oneAtATime({ pick });
    const first = picker.pick('a');
    const second = picker.pick('b');
    answer('/code/app');
    expect(await first).toBe('/code/app');
    expect(await second).toBe('/code/app');
    expect(pick).toHaveBeenCalledTimes(1);
    answer = () => {};
    void picker.pick('c');
    expect(pick).toHaveBeenCalledTimes(2);
  });
});
