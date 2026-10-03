import { useSyncExternalStore } from 'react';

import { platform } from '@/platform';

/**
 * The terminal panel under a session: whether it shows (Ctrl+` toggles it)
 * and how tall it is. Both kept across reloads.
 */
const OPEN_KEY = 'hc.terminal';
const HEIGHT_KEY = 'hc.terminal.height';
export const MIN_HEIGHT = 120;
const DEFAULT_HEIGHT = 280;

const readHeight = (): number => {
  const n = Number(platform.storage.get(HEIGHT_KEY));
  return Number.isFinite(n) && n >= MIN_HEIGHT ? n : DEFAULT_HEIGHT;
};

let state = { open: platform.storage.get(OPEN_KEY) === '1', height: readHeight() };
const listeners = new Set<() => void>();
const emit = (): void => listeners.forEach((l) => l());

export function setTerminalOpen(open: boolean): void {
  state = { ...state, open };
  if (open) platform.storage.set(OPEN_KEY, '1');
  else platform.storage.remove(OPEN_KEY);
  emit();
}

export function toggleTerminal(): void {
  setTerminalOpen(!state.open);
}

export function setTerminalHeight(height: number): void {
  state = { ...state, height: Math.max(MIN_HEIGHT, Math.round(height)) };
  platform.storage.set(HEIGHT_KEY, String(state.height));
  emit();
}

export function useTerminalPanel(): { open: boolean; height: number } {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
  );
}
