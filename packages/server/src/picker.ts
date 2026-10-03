/**
 * The system's own folder chooser — Finder's on a Mac — shown by the server
 * for the page. A browser never hands a page a folder's path, but this server
 * runs on the user's machine (as the editors it opens files in do), so it can
 * ask the desktop: `choose folder` through osascript on a Mac, zenity or
 * kdialog on a Linux desktop, the Windows folder dialog through PowerShell.
 */

import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { homedir } from 'node:os';

import { onPath } from './editors.js';

export interface FolderPicker {
  /** Show the chooser; the folder picked, or null when it was cancelled. */
  pick(prompt: string): Promise<string | null>;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a command to its end (no shell); a non-zero exit is a result, not a rejection. */
export type Run = (command: string, args: string[]) => Promise<RunResult>;

const run: Run = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8', maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && typeof err.code !== 'number') return reject(err);
      resolve({ code: typeof err?.code === 'number' ? err.code : 0, stdout, stderr });
    });
  });

/** A chosen path as the dialogs print it: one line, without the trailing slash Finder adds. */
function chosen(stdout: string): string | null {
  const line = stdout.split('\n')[0]?.trim() ?? '';
  if (line === '') return null;
  return line.length > 1 ? line.replace(/[/\\]+$/, '') : line;
}

/** osascript says `User canceled. (-128)` when the dialog is dismissed. */
const cancelledOnMac = (r: RunResult): boolean => r.code !== 0 && /-128/.test(r.stderr);

/**
 * The chooser this machine has, or null: none on a Linux without a desktop
 * session or without zenity / kdialog.
 */
export async function detectFolderPicker(
  opts: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; home?: string; run?: Run; osascript?: string } = {},
): Promise<FolderPicker | null> {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const exec = opts.run ?? run;

  const picker = (command: string, args: (prompt: string) => string[], cancelled: (r: RunResult) => boolean): FolderPicker => ({
    async pick(prompt) {
      const result = await exec(command, args(prompt));
      if (result.code === 0) return chosen(result.stdout);
      if (cancelled(result)) return null;
      throw new Error(result.stderr.trim() || `${command} exited with code ${result.code}`);
    },
  });

  if (platform === 'darwin') {
    const osascript = opts.osascript ?? '/usr/bin/osascript';
    if (!(await executable(osascript))) return null;
    // `activate` brings the dialog in front of the browser; the prompt comes in as an argument, never as script.
    const script = [
      'on run argv',
      'activate',
      'POSIX path of (choose folder with prompt (item 1 of argv) default location (POSIX file (item 2 of argv)))',
      'end run',
    ];
    return picker(osascript, (prompt) => [...script.flatMap((line) => ['-e', line]), prompt, home], cancelledOnMac);
  }

  if (platform === 'win32') {
    // The prompt goes in as a single-quoted PowerShell string, its quotes doubled.
    const command = (prompt: string): string =>
      [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
        `$d.Description = '${prompt.replace(/'/g, "''")}'`,
        '$d.ShowNewFolderButton = $true',
        "if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath }",
      ].join('; ');
    // Cancelling prints nothing and exits 0: `chosen` reads that as null.
    return picker('powershell.exe', (prompt) => ['-NoProfile', '-STA', '-NonInteractive', '-Command', command(prompt)], () => false);
  }

  if (!env['DISPLAY'] && !env['WAYLAND_DISPLAY']) return null;
  const zenity = await onPath('zenity', env);
  if (zenity) {
    return picker(zenity, (prompt) => ['--file-selection', '--directory', `--title=${prompt}`, `--filename=${home}/`], (r) => r.code === 1);
  }
  const kdialog = await onPath('kdialog', env);
  if (kdialog) {
    return picker(kdialog, (prompt) => ['--getexistingdirectory', home, '--title', prompt], (r) => r.code === 1);
  }
  return null;
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** One dialog at a time: asking again while one is open waits for that one's answer. */
export function oneAtATime(picker: FolderPicker): FolderPicker {
  let open: Promise<string | null> | null = null;
  return {
    pick(prompt) {
      open ??= picker.pick(prompt).finally(() => {
        open = null;
      });
      return open;
    },
  };
}
