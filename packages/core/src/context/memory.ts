/**
 * Project memory: `AGENTS.md` / `CLAUDE.md` files loaded into the system prompt
 * as standing instructions from the developer.
 *
 * Discovery walks every directory from the project root (nearest ancestor with
 * a `.agent` or `.git` marker) down to the working directory, outermost first,
 * plus an optional `~/.agent/AGENTS.md` for user-global notes. Every file found
 * is included — a nested directory's notes extend the ones above rather than
 * replacing them. Loaded harness-side (like `loadSettings`), so it is not
 * subject to the `read` tool's workspace cage.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';

import { AGENT_DIR, findProjectRoot } from '../config/settings.js';

export const MEMORY_FILENAMES = ['AGENTS.md', 'CLAUDE.md'] as const;

/** Per-file ceiling, so one runaway CLAUDE.md cannot swallow the context budget. */
export const MAX_MEMORY_FILE_BYTES = 32 * 1024;

/**
 * Cap a memory file at {@link MAX_MEMORY_FILE_BYTES} of UTF-8, with a marker.
 * The cut is in bytes, not string indices (a CJK character is 3 bytes, so a
 * character cut let such a file through at up to 3× the ceiling), and backs
 * off to a character boundary so no character is split.
 */
export function capMemoryFile(text: string): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= MAX_MEMORY_FILE_BYTES) return text;
  let end = MAX_MEMORY_FILE_BYTES;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--; // continuation byte
  return `${bytes.subarray(0, end).toString('utf8')}\n\n[… truncated: file exceeds ${MAX_MEMORY_FILE_BYTES / 1024} KiB]`;
}

export interface ProjectMemory {
  /** Concatenated file bodies, each under a `## <path>` header. Empty when nothing was found. */
  text: string;
  /** Absolute paths of the files that were loaded, in order. */
  sources: string[];
}

/** Directories from `root` down to `leaf` (both inclusive), outermost first. */
function dirChain(root: string, leaf: string): string[] {
  const rel = relative(root, leaf);
  if (rel === '') return [root];
  if (rel.startsWith('..')) return [leaf]; // leaf is not under root — just the leaf
  const chain = [root];
  let cur = root;
  for (const part of rel.split(sep)) {
    cur = join(cur, part);
    chain.push(cur);
  }
  return chain;
}

export async function loadProjectMemory(
  cwd: string,
  opts: { homeDir?: string } = {},
): Promise<ProjectMemory> {
  const home = opts.homeDir ?? homedir();
  const root = await findProjectRoot(cwd);

  const seen = new Set<string>();
  const dirs = [join(home, AGENT_DIR), ...dirChain(root, cwd)].filter((d) =>
    seen.has(d) ? false : (seen.add(d), true),
  );

  const sections: string[] = [];
  const sources: string[] = [];
  for (const dir of dirs) {
    for (const name of MEMORY_FILENAMES) {
      const path = join(dir, name);
      let raw: string;
      try {
        raw = await readFile(path, 'utf8');
      } catch {
        continue; // absent is the normal case
      }
      const body = capMemoryFile(raw.trim());
      if (body === '') continue;
      sections.push(`## ${path}\n\n${body}`);
      sources.push(path);
    }
  }

  return { text: sections.join('\n\n'), sources };
}
