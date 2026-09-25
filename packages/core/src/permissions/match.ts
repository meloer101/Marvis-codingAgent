import type { PermissionRule } from './types.js';

/** Collapse `.//foo` and `./foo` into a posix-ish relative form. Does not resolve `..`. */
export function normalizeRelPath(path: string): string {
  let s = path.replace(/\\/g, '/');
  if (s.startsWith('./')) s = s.slice(2);
  s = s.replace(/\/+/g, '/');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

/**
 * A path that still contains `..` segments or is absolute is not a workspace-relative
 * glob candidate — those must be rejected by the path cage, not matched by `**`.
 */
export function isWorkspaceRelCandidate(path: string): boolean {
  const n = normalizeRelPath(path);
  if (n.startsWith('/') || n === '..' || n.startsWith('../')) return false;
  const parts = n.split('/');
  return !parts.includes('..');
}

export function globToRegExp(glob: string): RegExp {
  const n = normalizeRelPath(glob);
  let re = '';
  for (let i = 0; i < n.length; i++) {
    if (n.startsWith('**/', i)) {
      re += '(?:.*/)?';
      i += 2;
      continue;
    }
    if (n.startsWith('**', i) && i + 2 === n.length) {
      re += '.*';
      i += 1;
      continue;
    }
    const c = n[i] ?? '';
    if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += escapeRegex(c);
  }
  return new RegExp(`^${re}$`);
}

export function matchPathGlob(relPath: string, pattern: string): boolean {
  if (!isWorkspaceRelCandidate(relPath)) return false;
  return globToRegExp(pattern).test(normalizeRelPath(relPath));
}

/**
 * Match a parsed argv against a Bash(specifier) pattern.
 *
 * `git status:*` is Claude Code's prefix form: the command `git status`, alone
 * or followed by any arguments. The prefix ends on a word boundary, so
 * `Bash(node:*)` covers `node x.js` but not `nodemon`. Any other `*` matches
 * any run of characters. These are command lines, not paths: a `*` here must
 * match `/` — with path-glob semantics `Bash(node:*)` silently failed to cover
 * `node transform.js data/input.csv`.
 */
export function matchBashPattern(argv: string[], pattern: string): boolean {
  const joined = argv.join(' ');
  if (pattern.endsWith(':*')) {
    const prefix = pattern.slice(0, -2).trim();
    return joined === prefix || joined.startsWith(`${prefix} `);
  }
  const re = pattern
    .split('*')
    .map((part) => escapeRegex(part))
    .join('.*');
  return new RegExp(`^${re}$`).test(joined);
}

export function ruleMatchesTool(rule: PermissionRule, toolName: string): boolean {
  return rule.tool === toolName.toLowerCase();
}

export function ruleMatchesPath(rule: PermissionRule, toolName: string, relPath: string): boolean {
  if (!ruleMatchesTool(rule, toolName)) return false;
  if (rule.pattern === undefined) return isWorkspaceRelCandidate(relPath);
  return matchPathGlob(relPath, rule.pattern);
}

/**
 * Match an `mcp__server__tool` call against a rule. MCP rules are whole-name
 * (no `(specifier)`): `mcp__github` matches every tool on that server,
 * `mcp__github__create_issue` matches just the one, and a bare `mcp` matches
 * any MCP tool.
 */
export function ruleMatchesMcp(rule: PermissionRule, toolName: string): boolean {
  if (rule.pattern !== undefined) return false;
  const t = toolName.toLowerCase();
  const r = rule.tool;
  return r === t || t.startsWith(`${r}__`);
}

/**
 * Match a `webfetch` call against a rule. A bare `WebFetch` matches any URL;
 * `WebFetch(domain:example.com)` matches that host or any subdomain of it
 * (so `docs.example.com` matches `domain:example.com`). An unparseable URL or a
 * non-`domain:` specifier never matches a specified rule.
 */
export function ruleMatchesWebFetch(rule: PermissionRule, url: string): boolean {
  if (!ruleMatchesTool(rule, 'webfetch')) return false;
  if (rule.pattern === undefined) return true;
  const m = rule.pattern.match(/^domain:(.+)$/i);
  if (!m) return false;
  const domain = (m[1] ?? '').trim().toLowerCase().replace(/^\*\./, '');
  if (!domain) return false;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === domain || host.endsWith(`.${domain}`);
}

export function ruleMatchesBash(rule: PermissionRule, argv: string[]): boolean {
  if (!ruleMatchesTool(rule, 'bash')) return false;
  if (rule.pattern === undefined) return true;
  return matchBashPattern(argv, rule.pattern);
}

function escapeRegex(s: string): string {
  return s.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
}
