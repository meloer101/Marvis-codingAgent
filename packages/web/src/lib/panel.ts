import { useSyncExternalStore } from 'react';

import { platform } from '@/platform';

/**
 * The side panel to the right of a session: which tab is showing, or null
 * when it's closed — kept across reloads; ⌥⌘B (Ctrl+Alt+B) toggles it — and
 * the file the Files tab has open.
 */
export type PanelTab = 'changes' | 'files' | 'tasks' | 'trace' | 'processes';

const KEY = 'hc.panel';
const TABS: readonly PanelTab[] = ['changes', 'files', 'tasks', 'trace', 'processes'];

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

/** A workspace file to show in the Files tab, at a line. */
export interface OpenedFile {
  path: string;
  line?: number;
}

let opened: OpenedFile | null = null;

/** Show `path` in the Files tab (opening the panel there); null goes back to the tree. */
export function openFile(path: string | null, line?: number): void {
  opened = path === null ? null : { path, ...(line !== undefined ? { line } : {}) };
  if (path !== null) setPanel('files');
  else listeners.forEach((l) => l());
}

let process: string | null = null;

/** Show background command `id` in the Processes tab, opening the panel there. */
export function openProcess(id: string): void {
  process = id;
  setPanel('processes');
}

/** The background command the Processes tab was last asked to show. */
export function useOpenedProcess(): string | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => process,
  );
}

export function useOpenedFile(): OpenedFile | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => opened,
  );
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
