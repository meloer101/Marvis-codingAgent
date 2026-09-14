/**
 * Commands that make no workspace change — auto (and plan-with-auto) can
 * allow them without a classifier round-trip. Anything else, including the
 * same binary with a write redirect, is not read-only.
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

const FIND_WRITE_FLAGS = new Set(['-delete', '-exec', '-execdir', '-ok', '-okdir']);

const GIT_READONLY_SUB = new Set(['status', 'log', 'diff', 'show', 'rev-parse']);

export function isReadOnlyBashCommand(
  segments: string[][],
  opts: { hasWriteRedirect?: boolean } = {},
): boolean {
  if (opts.hasWriteRedirect) return false;
  if (segments.length === 0) return false;
  return segments.every(isReadOnlySegment);
}

function isReadOnlySegment(argv: string[]): boolean {
  if (argv.length === 0) return false;
  const cmd = baseCmd(argv[0] ?? '');
  if (cmd === 'git') return isReadOnlyGit(argv);
  if (cmd === 'find') return argv.every((a) => !FIND_WRITE_FLAGS.has(a));
  return READ_ONLY_BASH_COMMANDS.has(cmd);
}

function isReadOnlyGit(argv: string[]): boolean {
  const sub = argv[1];
  if (!sub || sub.startsWith('-')) return false;
  if (GIT_READONLY_SUB.has(sub)) return true;
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
