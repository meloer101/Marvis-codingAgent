import { SENSITIVE_FILE_GLOBS } from './paths.js';

const ENV_ALLOWLIST = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'TERM',
  'TERMINFO',
  'TMPDIR',
  'TMP',
  'TEMP',
  'PWD',
  'NODE_ENV',
  'COLORTERM',
  'TERM_PROGRAM',
  'TZ',
]);

const SECRET_KEY = /key|token|secret|password|passwd|credential/i;

export function isSecretEnvKey(key: string): boolean {
  return SECRET_KEY.test(key);
}

/** Copy a tight env allowlist, never passing API keys or tokens to child processes. */
export function sandboxedEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of ENV_ALLOWLIST) {
    const value = source[key];
    if (value !== undefined && !isSecretEnvKey(key)) out[key] = value;
  }
  return out;
}

/** `.env*` → `.[Ee][Nn][Vv]*`: grep's `--exclude` has no case-insensitive form. */
function caseInsensitiveGlob(glob: string): string {
  return glob.replace(/[a-z]/gi, (c) => `[${c.toUpperCase()}${c.toLowerCase()}]`);
}

/**
 * Shell functions that make `grep` and `rg` skip sensitive files
 * ({@link SENSITIVE_FILE_GLOBS}). The engine refuses a command that names
 * `.env`, but `grep -rn KEY .` names no file, writes nothing, and would print
 * the keys: only the search itself knows which files it opens. GNU and BSD
 * grep both match `--exclude` against basenames, files named on the command
 * line included. Only the command's own calls are covered — not a binary that
 * `xargs` or `find -exec` runs, which the engine never counts as read-only.
 * One line, so an error in the command reports its line number off by one.
 */
const SECRET_SEARCH_GUARD =
  `grep() { command grep ${SENSITIVE_FILE_GLOBS.map((g) => `--exclude='${caseInsensitiveGlob(g)}'`).join(' ')} "$@"; }; ` +
  `rg() { command rg ${SENSITIVE_FILE_GLOBS.map((g) => `--iglob='!${g}'`).join(' ')} "$@"; }`;

/** `command` with {@link SECRET_SEARCH_GUARD} ahead of it, for `sh -c`. */
export function guardSecretSearch(command: string): string {
  return `${SECRET_SEARCH_GUARD}\n${command}`;
}
