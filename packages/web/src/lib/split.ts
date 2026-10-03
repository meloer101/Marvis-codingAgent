import { useSyncExternalStore } from 'react';

import { panesOf, parseRoute, routeShowing, routeToHash } from './route';

/**
 * Split view: two sessions side by side (`#/s/<left>/<right>`). One pane has
 * the focus — the last one clicked or typed in. The side panel and the
 * terminal show beside it, Esc and the command palette act on it, and a
 * session opened from the sidebar or the palette takes its place.
 */

let focused = 0;
const listeners = new Set<() => void>();

/** The focused pane: 0 on the left, 1 on the right (always 0 without a split). */
export function useFocusedPane(): number {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => focused,
  );
}

export function focusPane(pane: number): void {
  if (pane === focused) return;
  focused = pane;
  listeners.forEach((l) => l());
}

/** Where opening session `id` goes from the sidebar or the palette: the focused pane. */
export function sessionHash(id: string): string {
  const route = parseRoute(window.location.hash);
  const panes = panesOf(route);
  return routeToHash(routeShowing(route, id, Math.min(focused, Math.max(0, panes.length - 1))));
}

/** Open session `id` from a list: focus its pane if it shows, else show it in the focused one. */
export function openSession(id: string): void {
  const shown = panesOf(parseRoute(window.location.hash)).indexOf(id);
  if (shown !== -1) focusPane(shown);
  else window.location.hash = sessionHash(id);
}

/** Show session `id` beside the focused one (replacing the other pane's), and focus it. */
export function openBeside(id: string): void {
  const route = parseRoute(window.location.hash);
  const pane = panesOf(route).length === 0 ? 0 : 1 - Math.min(focused, 1);
  window.location.hash = routeToHash(routeShowing(route, id, pane));
  focusPane(panesOf(routeShowing(route, id, pane)).indexOf(id));
}

/** Close pane `pane` of a split: the other session fills the view. */
export function closePane(pane: number): void {
  const panes = panesOf(parseRoute(window.location.hash));
  const rest = panes.filter((_, i) => i !== pane);
  if (rest.length === panes.length || !rest[0]) return;
  focusPane(0);
  window.location.hash = routeToHash({ kind: 'session', id: rest[0] });
}
