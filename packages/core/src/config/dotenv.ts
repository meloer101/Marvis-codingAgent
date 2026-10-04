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
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

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

/** The variable a `.env` line sets, as `parseDotEnv` reads it; undefined for a comment or a line that sets none. */
function lineKey(rawLine: string): string | undefined {
  const line = rawLine.trim();
  if (line === '' || line.startsWith('#')) return undefined;
  const eq = line.indexOf('=');
  return eq === -1 ? undefined : line.slice(0, eq).trim() || undefined;
}

/**
 * Set `name` in the `.env` at `path` — or, with `undefined`, remove it —
 * leaving every other line as it is. The file holds keys: it is written
 * whole, then moved into place, readable by its owner only.
 */
export async function setDotEnvVar(path: string, name: string, value: string | undefined): Promise<void> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`"${name}" is not a variable name`);
  if (value !== undefined && /[\r\n]/.test(value)) throw new Error('a value is one line');
  let text = '';
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n');
  const kept = lines.filter((line) => lineKey(line) !== name);
  if (value === undefined && kept.length === lines.length) return; // nothing to remove
  // Replaced where it was, so a file keeps its order; a new one goes last.
  const at = lines.findIndex((line) => lineKey(line) === name);
  if (value !== undefined) kept.splice(at === -1 ? kept.length : Math.min(at, kept.length), 0, `${name}=${value}`);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, kept.length > 0 ? `${kept.join('\n')}\n` : '', { encoding: 'utf8', mode: 0o600 });
  await chmod(tmp, 0o600); // `mode` above is masked by the umask
  await rename(tmp, path);
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
