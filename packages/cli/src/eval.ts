/**
 * `hc eval`: the eval suite, the same program as `pnpm eval`. The runner, its
 * tasks and their cassettes live in the repo's `evals/` and are spawned, never
 * imported, so none of it ships in the `hc` binary — which also means the
 * command works only where a source checkout can be found.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const EVALS_PACKAGE = '@harness-code/evals';

function isEvalsPackage(dir: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'evals', 'package.json'), 'utf8')) as { name?: unknown };
    return pkg.name === EVALS_PACKAGE;
  } catch {
    return false;
  }
}

/**
 * The checkout whose `evals/` is this harness's, walking up from each start
 * directory in turn: `hc` itself first (a checkout's `packages/cli/dist` or
 * `dist-bundle`), then the working directory (an installed `hc` run inside one).
 * Matched on the package name, so another project's `evals/` is not mistaken for it.
 */
export function findEvalsCheckout(starts: readonly string[]): string | undefined {
  for (const start of starts) {
    let dir = resolve(start);
    for (;;) {
      if (isEvalsPackage(dir)) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return undefined;
}

/** The runner script to spawn, or why there is none. */
export function locateEvalRunner(starts: readonly string[]): { cli: string; root: string } | { error: string } {
  const root = findEvalsCheckout(starts);
  if (root === undefined) {
    return {
      error:
        'the eval suite ships only in a source checkout of harness-code (its evals/ directory); ' +
        'run hc eval from inside one',
    };
  }
  const cli = join(root, 'evals', 'dist', 'cli.js');
  if (!existsSync(cli)) return { error: `the eval runner is not built (${cli} is missing); run \`pnpm build\` in ${root}` };
  return { cli, root };
}

/** Run the eval runner with `args`, output straight to this terminal; resolves to its exit code. */
export function runEvalRunner(cli: string, root: string, args: readonly string[]): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: root, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code, signal) => resolvePromise(code ?? (signal ? 1 : 0)));
  });
}
