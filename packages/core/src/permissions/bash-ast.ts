import { homedir } from 'node:os';
import { posix } from 'node:path';

import { parse } from 'shell-quote';
import type { ParseEntry } from 'shell-quote';

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);

/**
 * Inline-eval flags for general-purpose interpreters, keyed by command name.
 * Unlike a shell's `-c` (same grammar as everything else in this file, so
 * genuinely safe to recurse into — see `nestedShellCommand`), the payload
 * behind these flags is a different language entirely. Shell-parsing a
 * Python or JS string with `shell-quote` doesn't review it — it produces
 * tokens that only coincidentally look like a shell command — so these are
 * refused as unreviewable rather than given a false sense of having been
 * checked. `yolo`, which reviews nothing, lets them through (`engine.ts`).
 */
const INLINE_EVAL_FLAGS: Record<string, string[]> = {
  python: ['-c'],
  python3: ['-c'],
  perl: ['-e'],
  ruby: ['-e'],
  node: ['-e', '--eval', '-p', '--print'],
};

export interface BashInspection {
  segments: string[][];
  hardDenyReason?: string;
  /**
   * Set with `hardDenyReason` when the refusal is only that the command could
   * not be *reviewed* — command substitution, a shape `shell-quote` cannot
   * parse (heredocs, subshells), inline interpreter code — as opposed to it
   * being destructive. A mode that reviews nothing (`yolo`) has no reason to
   * refuse these; destructive refusals hold in every mode.
   */
  unreviewable?: boolean;
  /** `>` / `>>` in the command — even `echo hi > file` is a write. */
  hasWriteRedirect?: boolean;
}

export interface InspectOptions {
  /**
   * The workspace root. An absolute path strictly inside it is not a
   * catastrophic `rm -rf` target (the agent cleaning up its own scratch dir);
   * the root itself still is. Without it every absolute path outside `/tmp` is.
   */
  workspaceRoot?: string;
}

type Token = ParseEntry;

export function inspectBash(command: string, opts: InspectOptions = {}): BashInspection {
  const trimmed = command.trim();
  if (!trimmed) {
    return { segments: [], hardDenyReason: 'Empty command is not allowed' };
  }

  // Past this point a command we cannot parse is refused as unreviewable, so
  // first make sure nothing destructive hides inside it.
  const unreviewable = (reason: string): BashInspection =>
    destructiveInRawText(command, opts) ?? { segments: [], hardDenyReason: reason, unreviewable: true };

  if (/\$\(/.test(command) || command.includes('`')) {
    return unreviewable('Command substitution is not allowed');
  }

  // A heredoc body is data for the command reading it — or a script, when
  // that command is a shell — and neither can be reviewed as a command line.
  if (/<<(?!<)/.test(command)) {
    return unreviewable('Unable to safely parse this command');
  }

  let tokens: Token[];
  try {
    tokens = parse(separateLines(command)) as Token[];
  } catch {
    return unreviewable('Unable to safely parse this command');
  }

  if (tokens.length === 0) {
    return { segments: [], hardDenyReason: 'Empty command is not allowed' };
  }
  if (tokens.some((t) => typeof t === 'object' && t !== null && 'comment' in t)) {
    // comments are fine; strip them
    tokens = tokens.filter((t) => !(typeof t === 'object' && t !== null && 'comment' in t));
  }

  const segments = splitSegments(tokens);
  if (segments.length === 0) {
    return unreviewable('Unable to safely parse this command');
  }

  // Refusals that hold in every mode — destructive commands, and piping into a
  // shell — outrank the unreviewable ones, so a command that is both is never
  // let through by a mode that relaxes the latter.
  const destructive =
    redirectToSsh(tokens) ??
    pipeToShell(segments) ??
    segments.map((argv) => destructiveSegment(argv, opts)).find((r) => r !== undefined);
  const inline = destructive ? undefined : segments.map(inlineEvalSegment).find((r) => r !== undefined);

  const extra: string[][] = [];
  let hasWriteRedirect = tokensHaveWriteRedirect(tokens);
  for (const argv of segments) {
    const inner = nestedShellCommand(argv);
    if (inner) {
      const nested = inspectBash(inner, opts);
      if (nested.hardDenyReason && !destructive) {
        return {
          segments,
          hardDenyReason: nested.hardDenyReason,
          ...(nested.unreviewable ? { unreviewable: true } : {}),
        };
      }
      extra.push(...nested.segments);
      if (nested.hasWriteRedirect) hasWriteRedirect = true;
    }
  }

  return {
    segments: extra.length > 0 ? [...segments, ...extra] : segments,
    ...(destructive ? { hardDenyReason: destructive } : {}),
    ...(inline ? { hardDenyReason: inline, unreviewable: true } : {}),
    ...(hasWriteRedirect ? { hasWriteRedirect: true } : {}),
  };
}

/**
 * `shell-quote` treats a newline as plain whitespace, so `ls\nrm -rf src` came
 * out as the single read-only command `ls rm -rf src` — while the shell runs
 * both lines. Turn every newline outside quotes into a `;` so each line is its
 * own segment; a backslash-newline is a line continuation and becomes a space.
 * Newlines inside quotes (a multi-line string argument) are left alone.
 */
function separateLines(command: string): string {
  let out = '';
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (c === '\\' && quote !== "'") {
      const next = command[i + 1];
      if (next === '\n') {
        out += ' ';
      } else if (next !== undefined) {
        out += c + next;
      } else {
        out += c;
      }
      i++;
      continue;
    }
    if (quote) {
      if (c === quote) quote = undefined;
      out += c;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    out += c === '\n' ? ' ; ' : c;
  }
  return out;
}

/**
 * The every-mode checks, run over the raw text of a command that could not be
 * parsed. Split on the shell's command separators and on the substitution and
 * quoting characters, each piece is treated as an argv — rough, but it only
 * has to find `rm -rf /`-shaped and `.ssh`-touching words, and erring toward a
 * refusal is the safe direction.
 */
function destructiveInRawText(command: string, opts: InspectOptions): BashInspection | undefined {
  const piped = /\|\s*(?:sudo\s+)?(?:\S*\/)?(sh|bash|zsh|dash|ksh)\b/.exec(command);
  if (piped) return { segments: [], hardDenyReason: `Piping into ${piped[1]} is not allowed` };
  for (const piece of command.split(/[;&|\n]|\$\(|`/)) {
    const argv = piece.split(/[\s()"']+/).filter((w) => w !== '');
    const reason = destructiveSegment(argv, opts);
    if (reason) return { segments: [], hardDenyReason: reason };
  }
  return undefined;
}

function tokensHaveWriteRedirect(tokens: Token[]): boolean {
  return tokens.some((t, i) => {
    if (typeof t !== 'object' || t === null || !('op' in t)) return false;
    // `2>/dev/null` discards output; it writes nothing.
    if (t.op === '>' || t.op === '>>') return tokens[i + 1] !== '/dev/null';
    // `>&word` writes stdout+stderr to the file `word`; only `>&2` / `>&-`
    // (fd duplication / close) leave the filesystem alone.
    if (t.op === '>&') {
      const next = tokens[i + 1];
      return !(typeof next === 'string' && /^(\d+|-)$/.test(next));
    }
    return false;
  });
}

function splitSegments(tokens: Token[]): string[][] {
  const segments: string[][] = [];
  let current: string[] = [];
  const push = (): void => {
    if (current.length > 0) {
      segments.push(current);
      current = [];
    }
  };

  for (const token of tokens) {
    if (typeof token === 'string') {
      current.push(token);
      continue;
    }
    if ('op' in token) {
      if (token.op === 'glob') {
        current.push((token as { pattern: string }).pattern);
        continue;
      }
      if (token.op === '>' || token.op === '>>' || token.op === '<' || token.op === '>&' || token.op === '<&') {
        // keep going; destination is the next string token, still same command
        continue;
      }
      if (token.op === '(' || token.op === ')') {
        return []; // unhandled grouping — fail closed
      }
      push();
    }
  }
  push();
  return segments;
}

function redirectToSsh(tokens: Token[]): string | undefined {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (typeof token !== 'object' || token === null || !('op' in token)) continue;
    if (token.op !== '>' && token.op !== '>>') continue;
    const dest = tokens[i + 1];
    if (typeof dest === 'string' && isSshPath(dest)) {
      return `Writing to ${dest} is not allowed`;
    }
  }
  return undefined;
}

function pipeToShell(segments: string[][]): string | undefined {
  if (segments.length < 2) return undefined;
  for (let i = 1; i < segments.length; i++) {
    const cmd = segments[i]?.[0];
    if (cmd && SHELLS.has(baseCmd(cmd))) {
      return `Piping into ${baseCmd(cmd)} is not allowed`;
    }
  }
  return undefined;
}

function destructiveSegment(argv: string[], opts: InspectOptions): string | undefined {
  if (argv.length === 0) return undefined;
  const cmd = baseCmd(argv[0] ?? '');

  for (const arg of argv) {
    if (isSshPath(arg)) {
      return `Accessing ${arg} is not allowed`;
    }
  }

  const catastrophic = (a: string): boolean => isCatastrophicRmTarget(a, opts.workspaceRoot);
  if (cmd === 'rm' && hasRecursiveForce(argv) && argv.slice(1).some(catastrophic)) {
    return `Refusing recursive delete of ${argv.slice(1).filter(catastrophic).join(', ')}`;
  }

  if (cmd === 'chmod' && argv.includes('777') && argv.some((a) => a === '/' || a === '/*')) {
    return 'chmod 777 / is not allowed';
  }

  return undefined;
}

function inlineEvalSegment(argv: string[]): string | undefined {
  const cmd = baseCmd(argv[0] ?? '');
  const evalFlags = INLINE_EVAL_FLAGS[cmd];
  if (evalFlags && argv.some((a) => evalFlags.includes(a))) {
    return `Running inline code via ${cmd} is not allowed — write it to a file and run that instead.`;
  }
  return undefined;
}

function nestedShellCommand(argv: string[]): string | undefined {
  const cmd = baseCmd(argv[0] ?? '');
  if (!SHELLS.has(cmd)) return undefined;
  const cIndex = argv.findIndex((a) => a === '-c');
  if (cIndex === -1) return undefined;
  return argv[cIndex + 1];
}

function hasRecursiveForce(argv: string[]): boolean {
  const flags = argv.filter((a) => a.startsWith('-') && a !== '-');
  const joined = flags.join('');
  return (joined.includes('r') || joined.includes('R')) && joined.includes('f');
}

function isCatastrophicRmTarget(arg: string, workspaceRoot?: string): boolean {
  if (arg.startsWith('-')) return false;
  if (workspaceRoot && arg.startsWith('/')) {
    // Strictly inside the workspace is the agent's own business; the root
    // itself, or a path that `..`s back out, is not.
    const root = posix.resolve(workspaceRoot);
    if (posix.resolve(arg).startsWith(`${root}/`)) return false;
  }
  const home = homedir();
  if (arg === '/' || arg === '/*' || arg === '~' || arg === '$HOME' || arg === home) return true;
  if (arg === '~/' || arg === `${home}/`) return true;
  // outside-ish: absolute path that is not clearly a relative workspace path
  if (arg.startsWith('~/') || arg.startsWith('$HOME/')) return true;
  if (arg.startsWith('/') && arg !== '/tmp' && !arg.startsWith('/tmp/')) {
    // /tmp/x is not catastrophic in the hard-deny sense for rm of workspace-like dirs;
    // plan: only / , $HOME, or workspace-outside. inspectBash has no workspace, so
    // absolute paths other than /tmp are treated as outside.
    if (arg === '/' || posix.resolve(arg) === '/') return true;
    if (home && (arg === home || arg.startsWith(home + '/'))) return true;
    return true;
  }
  return false;
}

function isSshPath(arg: string): boolean {
  const n = arg.replace(/\\/g, '/');
  return (
    n === '~/.ssh' ||
    n.startsWith('~/.ssh/') ||
    n.includes('/.ssh/') ||
    n.endsWith('/.ssh') ||
    n.startsWith('$HOME/.ssh')
  );
}

function baseCmd(cmd: string): string {
  const n = cmd.replace(/\\/g, '/');
  const base = n.split('/').pop() ?? n;
  return base;
}
