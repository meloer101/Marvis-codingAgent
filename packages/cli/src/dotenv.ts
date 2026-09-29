import { resolve as resolvePath } from 'node:path';

import { loadDotEnv, userDotEnvPath } from '@harness-code/core';

export { loadDotEnv };

/**
 * Load `.env` once the command's options are known: the workspace's (`--cwd`)
 * first, then the invocation directory's, then the user's `~/.agent/.env`, each
 * only for what is still unset. Loading at import time read only the
 * invocation directory, so `hc agent --cwd ../other` ran with the wrong
 * project's settings.
 */
export function loadDotEnvFor(
  cwdOption: unknown,
  env: NodeJS.ProcessEnv = process.env,
  home?: string,
): void {
  const invocation = resolvePath(process.cwd(), '.env');
  const workspace = typeof cwdOption === 'string' ? resolvePath(cwdOption, '.env') : invocation;
  loadDotEnv(workspace, env);
  if (workspace !== invocation) loadDotEnv(invocation, env);
  loadDotEnv(userDotEnvPath(home), env);
}
