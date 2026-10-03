/**
 * A home directory of its own for the test run. Session logs, traces, settings
 * and worktrees go under `~/.agent`; a test must never read the developer's,
 * or leave anything behind in it. Set before the workers start, so they and
 * what they spawn inherit it.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let home: string | undefined;

export function setup(): void {
  home = mkdtempSync(join(tmpdir(), 'marvis-test-home-'));
  process.env['HOME'] = home;
  process.env['USERPROFILE'] = home;
}

export function teardown(): void {
  if (home) rmSync(home, { recursive: true, force: true });
}
