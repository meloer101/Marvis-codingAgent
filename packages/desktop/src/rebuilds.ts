/**
 * Noticing `pnpm build` while the app runs from a source checkout (`pnpm desktop`,
 * or the app `pnpm desktop:install` links to the checkout): a new web bundle
 * reloads the window, a new server build asks to restart. The packaged app's
 * files never change, so there it costs nothing.
 */

import { watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** The packages the server runs on, whose `dist/` a rebuild rewrites. */
const BACKEND_PACKAGES = ['core', 'protocol', 'server', 'desktop'];

/** The checkout `from` sits in (the directory with `pnpm-workspace.yaml`), or undefined in the packaged app. */
export function sourceRoot(from: string): string | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml')) && existsSync(join(dir, 'packages'))) return dir;
    if (dirname(dir) === dir) return undefined;
  }
}

/** The `dist/` directories of the server's packages in checkout `root`. */
export function backendDirs(root: string): string[] {
  return BACKEND_PACKAGES.map((name) => join(root, 'packages', name, 'dist')).filter((dir) => existsSync(dir));
}

/** The newest modification time among the files under `dirs` — what a rebuild moves forward. */
export async function latestChange(dirs: readonly string[]): Promise<number> {
  let latest = 0;
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = await readdir(dir, { recursive: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      try {
        const info = await stat(join(dir, entry));
        if (info.isFile() && info.mtimeMs > latest) latest = info.mtimeMs;
      } catch {
        // removed mid-build
      }
    }
  }
  return latest;
}

export interface RebuildWatch {
  close(): void;
}

/**
 * Call `onWeb` when the web bundle in `webDir` is replaced by a different one
 * (its `index.html` names the hashed assets, so a new build changes it), and
 * `onBackend` when files under `backendDirs` change. Both settle first: a build
 * writes many files, and is reported once it has been quiet for `settleMs`.
 */
export function watchRebuilds(opts: {
  webDir?: string | undefined;
  backendDirs?: readonly string[];
  onWeb(): void;
  onBackend(): void;
  /** Quiet time before a web bundle counts as written. */
  settleMs?: number;
  /** Quiet time before a server build counts as done: `tsc -b` writes one package after another. */
  backendSettleMs?: number;
}): RebuildWatch {
  const settleMs = opts.settleMs ?? 600;
  const backendSettleMs = opts.backendSettleMs ?? 2500;
  const watchers: FSWatcher[] = [];
  const timers = new Set<NodeJS.Timeout>();

  const settled = (run: () => void, ms = settleMs) => {
    let timer: NodeJS.Timeout | undefined;
    return () => {
      if (timer) {
        clearTimeout(timer);
        timers.delete(timer);
      }
      timer = setTimeout(() => {
        if (timer) timers.delete(timer);
        run();
      }, ms);
      timers.add(timer);
    };
  };

  const add = (dir: string, recursive: boolean, listener: () => void) => {
    try {
      const watcher = watch(dir, { recursive, persistent: false }, listener);
      watcher.on('error', () => {}); // the directory went away: nothing more to see
      watchers.push(watcher);
    } catch {
      // not there (yet): nothing to watch
    }
  };

  if (opts.webDir) {
    const index = join(opts.webDir, 'index.html');
    let last: string | undefined;
    void readFile(index, 'utf8').then(
      (text) => (last ??= text),
      () => {},
    );
    add(
      opts.webDir,
      false,
      settled(() => {
        void readFile(index, 'utf8').then(
          (text) => {
            // Mid-build (emptied) or the same bundle written again: nothing to show.
            if (text === last) return;
            last = text;
            opts.onWeb();
          },
          () => {},
        );
      }),
    );
  }

  // FSEvents may also report what happened just before the watch began: only
  // a file newer than what was there at the start is a rebuild.
  const dirs = opts.backendDirs ?? [];
  let built = latestChange(dirs);
  const backend = settled(() => {
    const before = built;
    built = latestChange(dirs);
    void Promise.all([before, built]).then(([was, now]) => {
      if (now > was) opts.onBackend();
    });
  }, backendSettleMs);
  for (const dir of dirs) add(dir, true, backend);

  return {
    close() {
      for (const watcher of watchers) watcher.close();
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}
