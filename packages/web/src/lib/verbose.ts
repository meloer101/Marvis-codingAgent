import { useSyncExternalStore } from 'react';

import { platform } from '@/platform';

/**
 * Whether the transcript shows every tool call on its own (verbose) or folds
 * runs of exploration calls into one line (the default). Ctrl+O toggles it, as
 * in the TUI; persisted via platform storage.
 */
const KEY = 'hc.verbose';

let current = platform.storage.get(KEY) === '1';
const listeners = new Set<() => void>();

export function setVerbose(verbose: boolean): void {
  current = verbose;
  if (verbose) platform.storage.set(KEY, '1');
  else platform.storage.remove(KEY);
  listeners.forEach((l) => l());
}

export function toggleVerbose(): void {
  setVerbose(!current);
}

export function useVerbose(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}
