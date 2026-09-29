/**
 * What "Yes, and don't ask again" adds for a call the person just approved.
 *
 * It used to add the whole tool: approving one `npm test` allowed every Bash
 * command for the rest of the session. Now a command gets a rule for its own
 * prefix (`Bash(npm test:*)`), a fetch a rule for its host, and nothing
 * broader. Where a prefix would reach further than what was approved — `rm`,
 * `curl`, `cd`, a wrapper like `time` — the rule is the exact command; where
 * even that can't hold (a shell, `xargs`, `sudo`, a loop) the option is not
 * offered. The same idea as codex's prefix amendments (`execpolicy/src/amend.rs`).
 */

import { inspectBash } from './bash-ast.js';
import { isReadOnlyBashSegment } from './read-only-bash.js';
import { toolDisplayName } from './prompt-options.js';

export interface AlwaysAllow {
  /** Allow rules to add, in the settings syntax. */
  rules: string[];
  /** What they cover, for the prompt: "`npm test` commands". */
  label: string;
}

/** Beyond this many rules the option would be a paragraph; approve once instead. */
const MAX_RULES = 3;

/**
 * No rule at all. Shells and `eval` run whatever they are handed; `xargs` and
 * `parallel` take their commands from stdin, which a rule on this segment
 * doesn't see; `sudo` is out of scope. Loop and `if` keywords only show up
 * because the parser splits compound commands into segments.
 */
const NO_RULE = new Set([
  'sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh',
  'eval', 'exec', 'source', '.',
  'xargs', 'parallel',
  'sudo', 'su', 'doas',
  'for', 'while', 'until', 'do', 'done', 'if', 'then', 'else', 'elif', 'fi',
  'case', 'esac', 'function', '{', '}', '!', '[[',
]);

/**
 * The exact command only. Destructive commands and ones that reach the network
 * or another machine: a prefix would allow any target. Wrappers: `time:*` is
 * any command at all. `cd` / `pushd`: `cd:*` lets a later `cat` read a file
 * the sensitive-path check can't see (`cd .git && cat config`). `find`: asked
 * about only with `-exec` / `-delete`.
 */
const EXACT_ONLY = new Set([
  'rm', 'rmdir', 'dd', 'mkfs', 'shred', 'truncate', 'kill', 'killall', 'pkill',
  'chmod', 'chown', 'chgrp', 'find',
  'curl', 'wget', 'ssh', 'scp', 'sftp', 'rsync', 'nc', 'ncat', 'telnet', 'ftp', 'http', 'https', 'xh', 'open',
  'time', 'timeout', 'nice', 'ionice', 'nohup', 'env', 'watch', 'command', 'builtin', 'caffeinate', 'stdbuf',
  'cd', 'pushd',
]);

/** Tools whose first word is a subcommand: the rule keeps it (`git push`, not `git`). */
const SUBCOMMAND = new Set([
  'git', 'npm', 'pnpm', 'yarn', 'bun', 'deno', 'npx', 'pnpx', 'bunx', 'corepack',
  'cargo', 'go', 'rustup', 'docker', 'podman', 'kubectl', 'helm', 'gh', 'brew', 'apt', 'apt-get',
  'pip', 'pip3', 'uv', 'poetry', 'pipx', 'conda', 'mvn', 'gradle', 'gradlew', 'dotnet', 'swift',
  'terraform', 'aws', 'gcloud', 'az', 'composer', 'bundle', 'mix', 'flutter', 'dart',
  'turbo', 'nx', 'systemctl', 'hc',
]);

/** Subcommands that run something else: the rule keeps that too (`pnpm run build`). */
const RUNS_TARGET = new Set(['run', 'exec', 'x', 'dlx']);

/** A prefix of just the interpreter is any code; the rule keeps the script or `-m` module. */
const INTERPRETER = new Set([
  'python', 'python2', 'python3', 'node', 'ruby', 'perl', 'php', 'lua', 'Rscript',
  'tsx', 'ts-node', 'osascript', 'pwsh', 'powershell', 'java',
]);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

interface BashRule {
  /** The words the rule names (joined as the engine joins argv). */
  words: string;
  /** `words` followed by any arguments, or exactly `words`. */
  prefix: boolean;
}

export function alwaysAllowFor(toolName: string, input: unknown): AlwaysAllow | undefined {
  const tool = toolName.toLowerCase();
  const rec = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  if (tool === 'bash') return typeof rec.command === 'string' ? bashAlwaysAllow(rec.command) : undefined;
  if (tool === 'webfetch') {
    const host = typeof rec.url === 'string' ? hostOf(rec.url) : undefined;
    return host ? { rules: [`WebFetch(domain:${host})`], label: `fetches from ${host}` } : undefined;
  }
  const name = toolDisplayName(toolName);
  return { rules: [name], label: name };
}

function bashAlwaysAllow(command: string): AlwaysAllow | undefined {
  const inspected = inspectBash(command);
  // Unreviewable or refused: allow rules never apply to it, so one would not stick.
  if (inspected.hardDenyReason || inspected.segments.length === 0) return undefined;

  // The segments that needed approval; a `| tail` rides along on its own. When
  // they are all read-only, an ask rule forced the prompt — cover every one.
  const needed = inspected.segments.filter((argv) => inspected.hasWriteRedirect || !isReadOnlyBashSegment(argv));
  const rules: BashRule[] = [];
  for (const argv of needed.length > 0 ? needed : inspected.segments) {
    const rule = bashRuleFor(argv);
    if (!rule) return undefined;
    if (!rules.some((r) => r.words === rule.words && r.prefix === rule.prefix)) rules.push(rule);
  }
  if (rules.length > MAX_RULES) return undefined;
  return {
    rules: rules.map((r) => `Bash(${r.words}${r.prefix ? ':*' : ''})`),
    label: describe(rules),
  };
}

/** The rule for one segment, or undefined when none is safe to offer. */
function bashRuleFor(argv: readonly string[]): BashRule | undefined {
  // Leading `VAR=value` assignments stay in the rule: it must match them too.
  let start = 0;
  while (start < argv.length && ASSIGNMENT.test(argv[start]!)) start++;
  const cmd = argv[start];
  if (cmd === undefined) return undefined;
  const name = cmd.replace(/\\/g, '/').split('/').pop() ?? cmd;
  if (NO_RULE.has(name)) return undefined;

  const words = (n: number): BashRule => ({ words: argv.slice(0, start + n).join(' '), prefix: true });
  const exact = (): BashRule | undefined => {
    const all = argv.join(' ');
    // An exact rule has no escape for `*`: `ls *.ts` would become a wildcard.
    return all.includes('*') ? undefined : { words: all, prefix: false };
  };
  const isWord = (i: number): boolean => {
    const w = argv[start + i];
    return w !== undefined && w !== '' && !w.startsWith('-');
  };

  if (EXACT_ONLY.has(name)) return exact();
  if (SUBCOMMAND.has(name)) {
    if (!isWord(1)) return exact();
    if (!RUNS_TARGET.has(argv[start + 1]!)) return words(2);
    return isWord(2) ? words(3) : exact();
  }
  if (INTERPRETER.has(name)) {
    if (isWord(1)) return words(2);
    if (argv[start + 1] === '-m' && isWord(2)) return words(3);
    return exact();
  }
  return words(1);
}

/** "`cd web` and `pnpm build` commands" — a prefix rule reads as "… commands". */
function describe(rules: readonly BashRule[]): string {
  const parts = rules.map((r) => `\`${r.words}\``);
  const list = parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return rules.some((r) => r.prefix) ? `${list} commands` : list;
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}
