import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { ResolvedModel } from '../../provider/router.js';
import { DEFAULT_ENVIRONMENT } from './rules.js';

const execFileAsync = promisify(execFile);

export async function collectAutoModeSetupContext(opts: {
  cwd: string;
  projectMemory?: string;
  allow?: readonly string[];
}): Promise<string> {
  const parts: string[] = [];
  for (const name of ['README.md', 'README', 'AGENTS.md', 'CLAUDE.md']) {
    try {
      const text = await readFile(join(opts.cwd, name), 'utf8');
      if (text.trim() !== '') {
        parts.push(`<file name="${name}">\n${text.slice(0, 8_000)}\n</file>`);
      }
    } catch {
      // optional
    }
  }
  if (opts.projectMemory && opts.projectMemory.trim() !== '') {
    parts.push(`<project_memory>\n${opts.projectMemory.trim().slice(0, 8_000)}\n</project_memory>`);
  }
  const remotes = await gitRemotes(opts.cwd);
  if (remotes) parts.push(`<git_remotes>\n${remotes}\n</git_remotes>`);
  if (opts.allow && opts.allow.length > 0) {
    parts.push(`<permissions.allow>\n${opts.allow.join('\n')}\n</permissions.allow>`);
  }
  return parts.join('\n\n');
}

async function gitRemotes(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['remote', '-v'], { cwd, timeout: 5_000 });
    const text = stdout.trim();
    return text === '' ? undefined : text;
  } catch {
    return undefined;
  }
}

const SETUP_PROMPT = `You draft the auto-mode environment block for a coding agent.

Given the project files, remotes, and allow-list below, fill in the environment labels.
Output ONLY a JSON array of strings, each "Label: value". Use these labels, in this order.
Leave the value empty after the colon when you cannot tell. Do not invent secrets.

${DEFAULT_ENVIRONMENT.map((e) => `- ${e.split(':')[0]}`).join('\n')}
`;

export async function draftAutoModeEnvironment(
  model: ResolvedModel,
  context: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const res = await model.provider.complete({
    model: model.model,
    system: [{ id: 'auto_mode_setup', text: SETUP_PROMPT }],
    messages: [{ role: 'user', content: [{ type: 'text', text: context || '(no project files found)' }] }],
    maxOutputTokens: 2048,
    temperature: 0,
    ...(signal ? { signal } : {}),
  });
  const text = res.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  return parseEnvironmentDraft(text);
}

/** Pull a JSON string array out of model output, or treat each non-empty line as an entry. */
export function parseEnvironmentDraft(text: string): string[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
      }
    } catch {
      // fall through to line split
    }
  }
  return text
    .split('\n')
    .map((l) => l.replace(/^\s*[-*]\s*/, '').trim())
    .filter((l) => l.includes(':'));
}

export function appendCustomRule(list: string[] | undefined, entry: string): string[] {
  const trimmed = entry.trim();
  if (trimmed === '') return list ? [...list] : [];
  if (list === undefined || list.length === 0) return ['$defaults', trimmed];
  return [...list, trimmed];
}
