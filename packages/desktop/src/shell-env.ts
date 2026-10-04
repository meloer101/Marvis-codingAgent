/**
 * The user's login-shell environment, for an app opened from the Finder or the
 * Dock. Such an app starts with launchd's bare environment — PATH is
 * `/usr/bin:/bin:/usr/sbin:/sbin`, and nothing the shell profile exports (nvm's
 * node, Homebrew, `DEEPSEEK_API_KEY`) is there — while the sessions it hosts
 * run `bash`, `git` and the project's own tools, and read provider keys from
 * the real environment first. So, as VS Code does, ask the login shell once at
 * startup and adopt what it prints.
 */

import { execFile } from 'node:child_process';
import { userInfo } from 'node:os';

/** Brackets `env -0`'s output, so whatever the profile prints around it is ignored. */
const MARK = '__MARVIS_SHELL_ENV__';

/** Per shell and per process: never worth carrying over. */
const SKIP = new Set(['_', 'PWD', 'OLDPWD', 'SHLVL']);

/** `env -0` output between the marks, as a map; null when the marks are missing. */
export function parseShellEnv(stdout: string): Record<string, string> | null {
  const start = stdout.indexOf(MARK);
  const end = stdout.lastIndexOf(MARK);
  if (start === -1 || end <= start) return null;
  const env: Record<string, string> = {};
  for (const entry of stdout.slice(start + MARK.length, end).split('\0')) {
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    const key = entry.slice(0, eq);
    if (!SKIP.has(key)) env[key] = entry.slice(eq + 1);
  }
  return env;
}

/** The shell to ask: `$SHELL`, else the account's, else zsh (the Mac default). */
export function loginShell(env: NodeJS.ProcessEnv = process.env): string {
  if (env['SHELL']) return env['SHELL'];
  try {
    const { shell } = userInfo();
    if (shell) return shell;
  } catch {
    // no passwd entry — fall through
  }
  return '/bin/zsh';
}

/**
 * Run the login shell interactively (`-ilc`, so both `.zprofile` and `.zshrc`
 * apply) and read its environment; null when it fails or takes too long — the
 * app then keeps the environment it was started with.
 */
export function readLoginShellEnv(timeoutMs = 10_000): Promise<Record<string, string> | null> {
  const shell = loginShell();
  const script = `printf '%s' '${MARK}'; command env -0; printf '%s' '${MARK}'`;
  return new Promise((resolve) => {
    execFile(
      shell,
      ['-ilc', script],
      {
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        // oh-my-zsh would otherwise stop to offer an update.
        env: { ...process.env, DISABLE_AUTO_UPDATE: 'true' },
      },
      (err, stdout) => resolve(err && !stdout ? null : parseShellEnv(stdout)),
    );
  });
}
