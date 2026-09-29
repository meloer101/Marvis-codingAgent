/**
 * `.env` files, layered. The real environment always wins; then the project's
 * own `.env`; then the user's `~/.agent/.env`, for the keys every project
 * shares. Each layer only fills variables the ones before it left unset —
 * `.env` is a convenience default, never an override.
 *
 * A server hosting sessions for several projects builds one environment per
 * project with `projectEnv` instead of loading files into `process.env`, so a
 * project's `.env` never leaks into another's sessions.
 *
 * The format is hand-rolled rather than a dependency: `KEY=value` per line,
 * `#` comments, one pair of matching quotes stripped.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { AGENT_DIR } from './settings.js';

export const DOTENV_FILE = '.env';

export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (key !== '') out[key] = value;
  }
  return out;
}

/** Fill `env` with the variables of the `.env` at `path` that it doesn't have yet. A missing file is fine. */
export function loadDotEnv(path: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return env; // no .env file; that is the normal case, not an error
  }
  for (const [key, value] of Object.entries(parseDotEnv(raw))) {
    if (env[key] === undefined) env[key] = value;
  }
  return env;
}

/** `~/.agent/.env` — keys shared by every project (`home` is injectable for tests). */
export function userDotEnvPath(home: string = homedir()): string {
  return join(home, AGENT_DIR, DOTENV_FILE);
}

/**
 * The environment sessions in `dir` run with: `base` (the real environment),
 * then `dir/.env`, then `~/.agent/.env`. A new object; `base` is left alone.
 */
export function projectEnv(
  dir: string,
  opts: { base?: NodeJS.ProcessEnv; home?: string } = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...(opts.base ?? process.env) };
  loadDotEnv(join(dir, DOTENV_FILE), env);
  loadDotEnv(userDotEnvPath(opts.home), env);
  return env;
}
