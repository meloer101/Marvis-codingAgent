import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

/**
 * Minimal `.env` loader: `KEY=value` per line, `#` comments, optional quotes.
 * Hand-rolled instead of pulling in `dotenv` — the format is small and this
 * avoids one more dependency for something this simple. Variables already
 * present in the real environment win, matching the usual dotenv convention:
 * `.env` is a convenience default, not an override.
 */
export function loadDotEnv(path: string, env: NodeJS.ProcessEnv = process.env): void {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return; // no .env file; that is the normal case, not an error
  }
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key !== '' && env[key] === undefined) {
      env[key] = value;
    }
  }
}

/**
 * Load `.env` once the command's options are known: the workspace's (`--cwd`)
 * first, then the invocation directory's for anything still unset. Loading at
 * import time read only the invocation directory, so `hc agent --cwd ../other`
 * ran with the wrong project's settings.
 */
export function loadDotEnvFor(cwdOption: unknown, env: NodeJS.ProcessEnv = process.env): void {
  const invocation = resolvePath(process.cwd(), '.env');
  const workspace = typeof cwdOption === 'string' ? resolvePath(cwdOption, '.env') : invocation;
  loadDotEnv(workspace, env);
  if (workspace !== invocation) loadDotEnv(invocation, env);
}

