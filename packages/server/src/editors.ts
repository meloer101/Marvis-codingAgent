/**
 * The editors on this machine a file can be opened in, at a line: VS Code,
 * Cursor and Zed, by their command-line tool when it's on the PATH, else (on
 * a Mac) by the installed app — its URL scheme, or Zed's bundled CLI.
 */

import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

import type { EditorId, EditorInfo } from '@harness-code/protocol';

interface Launch {
  command: string;
  args: string[];
}

export interface Editor extends EditorInfo {
  launch(file: string, line?: number): Launch;
}

const SPECS: Array<{ id: EditorId; name: string; bin: string; app: string; scheme?: string; appCli?: string }> = [
  { id: 'vscode', name: 'VS Code', bin: 'code', app: 'Visual Studio Code.app', scheme: 'vscode' },
  { id: 'cursor', name: 'Cursor', bin: 'cursor', app: 'Cursor.app', scheme: 'cursor' },
  { id: 'zed', name: 'Zed', bin: 'zed', app: 'Zed.app', appCli: 'Contents/MacOS/cli' },
];

async function usable(path: string, mode = constants.F_OK): Promise<boolean> {
  try {
    await access(path, mode);
    return true;
  } catch {
    return false;
  }
}

/** Where `bin` is on the PATH, if it is. */
export async function onPath(bin: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  for (const dir of (env['PATH'] ?? '').split(delimiter)) {
    if (dir && (await usable(join(dir, bin), constants.X_OK))) return join(dir, bin);
  }
  return null;
}

const at = (file: string, line?: number): string => (line ? `${file}:${line}` : file);

export async function detectEditors(
  opts: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; home?: string } = {},
): Promise<Editor[]> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const appDirs = ['/Applications', join(opts.home ?? homedir(), 'Applications')];
  const found: Editor[] = [];
  for (const spec of SPECS) {
    const cli = await onPath(spec.bin, env);
    if (cli) {
      // VS Code and Cursor take -g file:line; Zed takes file:line as it is.
      found.push({
        id: spec.id,
        name: spec.name,
        launch: (file, line) => ({ command: cli, args: spec.id === 'zed' ? [at(file, line)] : ['-g', at(file, line)] }),
      });
      continue;
    }
    if (platform !== 'darwin') continue;
    for (const dir of appDirs) {
      const app = join(dir, spec.app);
      if (!(await usable(app))) continue;
      if (spec.scheme) {
        const scheme = spec.scheme;
        found.push({
          id: spec.id,
          name: spec.name,
          launch: (file, line) => ({ command: 'open', args: [`${scheme}://file${encodeURI(file)}:${line ?? 1}`] }),
        });
      } else if (spec.appCli && (await usable(join(app, spec.appCli), constants.X_OK))) {
        const appCli = join(app, spec.appCli);
        found.push({ id: spec.id, name: spec.name, launch: (file, line) => ({ command: appCli, args: [at(file, line)] }) });
      }
      break;
    }
  }
  return found;
}

/** Start the editor and let it go: it outlives the request, and the server. */
export function openInEditor(editor: Editor, file: string, line?: number): void {
  const { command, args } = editor.launch(file, line);
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}
