import { useSyncExternalStore } from 'react';

import { platform } from '@/platform';

/**
 * Whether the session sidebar shows — kept across reloads. Its toggle stays in
 * the window's top-left corner: on the sidebar while it is open, in the main
 * header once it is closed.
 */
const KEY = 'hc.sidebar.hidden';

let open = platform.storage.get(KEY) !== '1';
const listeners = new Set<() => void>();

export function setSidebarOpen(next: boolean): void {
  open = next;
  if (next) platform.storage.remove(KEY);
  else platform.storage.set(KEY, '1');
  listeners.forEach((l) => l());
}

export function toggleSidebar(): void {
  setSidebarOpen(!open);
}

export function useSidebarOpen(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => open,
  );
}
