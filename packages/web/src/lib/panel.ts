import { useSyncExternalStore } from 'react';

import { platform } from '@/platform';

/**
 * The side panel to the right of a session: which tab is showing, or null
 * when it's closed. Kept across reloads; ⌥⌘B (Ctrl+Alt+B) toggles it.
 */
export type PanelTab = 'changes';

const KEY = 'hc.panel';
const TABS: readonly PanelTab[] = ['changes'];

const read = (): PanelTab | null => {
  const v = platform.storage.get(KEY);
  return TABS.find((t) => t === v) ?? null;
};

let current: PanelTab | null = read();
/** The tab to come back to when the panel reopens. */
let last: PanelTab = current ?? 'changes';
const listeners = new Set<() => void>();

export function setPanel(tab: PanelTab | null): void {
  current = tab;
  if (tab) {
    last = tab;
    platform.storage.set(KEY, tab);
  } else {
    platform.storage.remove(KEY);
  }
  listeners.forEach((l) => l());
}

/** Close the panel, or open it on its last tab. */
export function togglePanel(): void {
  setPanel(current ? null : last);
}

export function usePanel(): PanelTab | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}
