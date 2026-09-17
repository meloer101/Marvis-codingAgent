/**
 * Workspace helpers for graders: list files, match simple globs, and diff the
 * post-run workspace against the task's pristine fixture.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Never part of the deliverable: VCS, installed deps, the harness's own state dir. */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.agent']);

/** Every file under `root`, as sorted posix paths relative to it. */
export async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(join(dir, e.name), r);
      } else if (e.isFile()) {
        out.push(r);
      }
    }
  };
  await walk(root, '');
  return out.sort();
}

/** `*` = one path segment, `**` = any depth, `?` = one char. Anchored. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}

export interface FileChange {
  path: string;
  status: 'added' | 'removed' | 'modified';
  added: number;
  removed: number;
}

async function lines(path: string): Promise<string[]> {
  const body = await readFile(path, 'utf8');
  return body === '' ? [] : body.replace(/\n$/, '').split('\n');
}

/** Lines added/removed between two versions of a file (LCS; multiset past a size cap). */
export function lineDelta(a: string[], b: string[]): { added: number; removed: number } {
  const n = a.length;
  const m = b.length;
  let common: number;
  if (n * m <= 4_000_000) {
    let prev = new Uint32Array(m + 1);
    let cur = new Uint32Array(m + 1);
    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) {
        cur[j] = a[i - 1] === b[j - 1] ? (prev[j - 1] as number) + 1 : Math.max(prev[j] as number, cur[j - 1] as number);
      }
      [prev, cur] = [cur, prev];
    }
    common = prev[m] as number;
  } else {
    const counts = new Map<string, number>();
    for (const l of a) counts.set(l, (counts.get(l) ?? 0) + 1);
    common = 0;
    for (const l of b) {
      const k = counts.get(l) ?? 0;
      if (k > 0) {
        common++;
        counts.set(l, k - 1);
      }
    }
  }
  return { added: m - common, removed: n - common };
}

/** Every file that differs between the fixture and the post-run workspace. */
export async function diffWorkspace(fixtureDir: string, workDir: string): Promise<FileChange[]> {
  const before = new Set(await listFiles(fixtureDir));
  const after = new Set(await listFiles(workDir));
  const changes: FileChange[] = [];
  for (const p of after) {
    if (!before.has(p)) {
      changes.push({ path: p, status: 'added', added: (await lines(join(workDir, p))).length, removed: 0 });
    }
  }
  for (const p of before) {
    const orig = await lines(join(fixtureDir, p));
    if (!after.has(p)) {
      changes.push({ path: p, status: 'removed', added: 0, removed: orig.length });
      continue;
    }
    const { added, removed } = lineDelta(orig, await lines(join(workDir, p)));
    if (added + removed > 0) changes.push({ path: p, status: 'modified', added, removed });
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}
