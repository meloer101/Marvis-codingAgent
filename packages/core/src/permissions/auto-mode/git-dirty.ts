import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { inspectBash } from '../bash-ast.js';

const execFileAsync = promisify(execFile);

const GIT_DESTRUCTIVE_SUB = new Set(['reset', 'checkout', 'restore', 'clean', 'stash']);

/**
 * True when the command could throw away uncommitted work, so the classifier
 * should see a porcelain git-status snapshot.
 */
export function needsDirtyTreeSnapshot(command: string): boolean {
  const inspected = inspectBash(command);
  if (inspected.hardDenyReason) {
    // Still worth a snapshot for rm -rf of the workspace even when hard-denied
    // elsewhere — the engine already denied those. Classifier never sees them.
    return false;
  }
  for (const argv of inspected.segments) {
    const cmd = baseCmd(argv[0] ?? '');
    if (cmd === 'rm' && hasRecursiveForce(argv)) return true;
    if (cmd !== 'git') continue;
    const sub = argv[1];
    if (!sub || !GIT_DESTRUCTIVE_SUB.has(sub)) continue;
    if (sub === 'reset' && argv.includes('--hard')) return true;
    if (sub === 'checkout' && argv.includes('--')) return true;
    if (sub === 'restore' && argv.some((a) => a === '.' || a === '--worktree' || a === '--staged')) {
      return true;
    }
    if (sub === 'clean' && argv.some((a) => a === '-f' || a === '-fd' || a === '-fx' || a.startsWith('-f'))) {
      return true;
    }
    if (sub === 'stash' && (argv[2] === 'drop' || argv[2] === 'clear')) return true;
  }
  return false;
}

export async function readDirtyTree(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['status', '--porcelain', '--untracked-files=all'],
      { cwd, timeout: 5_000, maxBuffer: 256 * 1024 },
    );
    const lines = stdout.split('\n').map((l) => l.trimEnd()).filter((l) => l !== '');
    if (lines.length === 0) return '(clean working tree)';
    const staged = lines.filter((l) => l[0] && l[0] !== ' ' && l[0] !== '?').length;
    const modified = lines.filter((l) => l[1] && l[1] !== ' ' && l[0] !== '?').length;
    const untracked = lines.filter((l) => l.startsWith('??')).length;
    const head = `${lines.length} path(s): ${staged} staged, ${modified} modified, ${untracked} untracked`;
    const body = lines.slice(0, 40).join('\n');
    const more = lines.length > 40 ? `\n… ${lines.length - 40} more` : '';
    return `${head}\n${body}${more}`;
  } catch {
    return '(git status unavailable)';
  }
}

function baseCmd(cmd: string): string {
  const n = cmd.replace(/\\/g, '/');
  return n.split('/').pop() ?? n;
}

function hasRecursiveForce(argv: string[]): boolean {
  const flags = argv.filter((a) => a.startsWith('-') && a !== '-');
  const joined = flags.join('');
  return (joined.includes('r') || joined.includes('R')) && joined.includes('f');
}
