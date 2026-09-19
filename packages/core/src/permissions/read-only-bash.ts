/**
 * Commands that make no workspace change.
 *
 * These are allowed in every permission mode (a write redirect, or a flag that
 * turns a reader into a writer or an exec, takes a command out of the set), and
 * a compound command is allowed when every segment is either read-only or
 * matched by an allow rule — which is what makes `npm test 2>&1 | tail` work
 * off a `Bash(npm:*)` rule. "Read-only" is about the filesystem, not about
 * secrecy: the engine checks the arguments for sensitive paths separately.
 */

export const READ_ONLY_BASH_COMMANDS = new Set([
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'pwd',
  'echo',
  'which',
  'file',
  'stat',
  'du',
  'df',
  'tree',
  'rg',
  'grep',
  'find',
]);

const FIND_WRITE_FLAGS = new Set([
  '-delete',
  '-exec',
  '-execdir',
  '-ok',
  '-okdir',
  '-fprint',
  '-fprint0',
  '-fprintf',
  '-fls',
]);

const GIT_READONLY_SUB = new Set(['status', 'log', 'diff', 'show', 'rev-parse']);

/**
 * Flags that turn an otherwise read-only binary into a writer or an exec:
 * `rg --pre` runs a program per file, `tree -o` / `-R` write files,
 * `file -C` compiles a magic file.
 */
const UNSAFE_ARG: Record<string, (arg: string) => boolean> = {
  rg: (a) => a === '--pre' || a.startsWith('--pre='),
  tree: (a) => /^-[^-]*[oR]/.test(a),
  file: (a) => a === '--compile' || /^-[^-]*C/.test(a),
};

export function isReadOnlyBashCommand(
  segments: string[][],
  opts: { hasWriteRedirect?: boolean } = {},
): boolean {
  if (opts.hasWriteRedirect) return false;
  if (segments.length === 0) return false;
  return segments.every(isReadOnlySegment);
}

/** One segment of a pipeline / `&&` chain, on its own. */
export function isReadOnlyBashSegment(argv: string[]): boolean {
  return isReadOnlySegment(argv);
}

function isReadOnlySegment(argv: string[]): boolean {
  if (argv.length === 0) return false;
  const cmd = baseCmd(argv[0] ?? '');
  if (cmd === 'git') return isReadOnlyGit(argv);
  if (cmd === 'find') return argv.every((a) => !FIND_WRITE_FLAGS.has(a));
  if (!READ_ONLY_BASH_COMMANDS.has(cmd)) return false;
  const unsafe = UNSAFE_ARG[cmd];
  return unsafe === undefined || !argv.slice(1).some(unsafe);
}

function isReadOnlyGit(argv: string[]): boolean {
  const sub = argv[1];
  if (!sub || sub.startsWith('-')) return false;
  if (GIT_READONLY_SUB.has(sub)) {
    // `--output=<file>` writes the diff/log to disk; `--ext-diff` runs the
    // configured external diff program.
    return !argv
      .slice(2)
      .some((a) => a === '--output' || a.startsWith('--output=') || a === '--ext-diff');
  }
  if (sub === 'branch') {
    const rest = argv.slice(2);
    if (rest.some((a) => !a.startsWith('-'))) return false;
    return !rest.some(
      (a) =>
        a === '-d' ||
        a === '-D' ||
        a === '-m' ||
        a === '-M' ||
        a === '-c' ||
        a === '-C' ||
        a === '--delete' ||
        a === '--move' ||
        a === '--copy',
    );
  }
  if (sub === 'remote') {
    const rest = argv.slice(2);
    return rest.length === 0 || rest.every((a) => a === '-v' || a === '--verbose');
  }
  return false;
}

function baseCmd(cmd: string): string {
  const n = cmd.replace(/\\/g, '/');
  return n.split('/').pop() ?? n;
}
