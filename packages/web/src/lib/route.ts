/**
 * Routing is just the URL hash (docs/web.md, "The web app"): `#/` is the draft
 * for a new session in the most recently used project, `#/new/<workspace>` one
 * in a given project, `#/s/<id>` a session, `#/s/<id>/<id>` two side by
 * side (split view), `#/stats` the usage page and `#/settings/<section>` the
 * settings. No router library — this also works unchanged under a `file://`
 * desktop shell later.
 *
 * The server hands the token over as `#token=…` on first load; `token.ts`
 * strips it, and until then anything that is not a route parses as home.
 */

import { useEffect, useState } from 'react';

/** The settings page's sections, each its own address. */
export const SETTINGS_SECTIONS = ['models', 'permissions', 'auto-mode', 'memory', 'mcp', 'tools'] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export type Route =
  | { kind: 'home' }
  | { kind: 'new'; workspaceId: string }
  /** Usage across the recorded sessions. */
  | { kind: 'stats' }
  | { kind: 'settings'; section: SettingsSection }
  /** `split`: a second session, shown to the right. */
  | { kind: 'session'; id: string; split?: string };

export function parseRoute(hash: string): Route {
  const session = /^#\/s\/([^/?#]+)(?:\/([^/?#]+))?\/?$/.exec(hash);
  if (session?.[1]) {
    const id = decodeURIComponent(session[1]);
    const split = session[2] ? decodeURIComponent(session[2]) : undefined;
    return split && split !== id ? { kind: 'session', id, split } : { kind: 'session', id };
  }
  const draft = /^#\/new\/([^/?#]+)\/?$/.exec(hash);
  if (draft?.[1]) return { kind: 'new', workspaceId: decodeURIComponent(draft[1]) };
  if (/^#\/stats\/?$/.test(hash)) return { kind: 'stats' };
  const settings = /^#\/settings(?:\/([a-z-]+))?\/?$/.exec(hash);
  if (settings) {
    const section = SETTINGS_SECTIONS.find((s) => s === settings[1]) ?? 'permissions';
    return { kind: 'settings', section };
  }
  return { kind: 'home' };
}

export function routeToHash(route: Route): string {
  switch (route.kind) {
    case 'session':
      return route.split
        ? `#/s/${encodeURIComponent(route.id)}/${encodeURIComponent(route.split)}`
        : `#/s/${encodeURIComponent(route.id)}`;
    case 'new':
      return `#/new/${encodeURIComponent(route.workspaceId)}`;
    case 'stats':
      return '#/stats';
    case 'settings':
      return `#/settings/${route.section}`;
    case 'home':
      return '#/';
  }
}

/** The route in the address bar, following it. */
export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = (): void => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

/** The sessions a route shows, left to right. */
export function panesOf(route: Route): string[] {
  if (route.kind !== 'session') return [];
  return route.split ? [route.id, route.split] : [route.id];
}

/**
 * `route` with session `id` in pane `pane` (0 on the left, 1 on the right)
 * and the other pane kept — a split when there was none, for pane 1. A
 * session already in the other pane moves rather than showing twice.
 */
export function routeShowing(route: Route, id: string, pane: number): Route {
  const [left, right] = panesOf(route);
  if (pane === 1) return left && left !== id ? { kind: 'session', id: left, split: id } : { kind: 'session', id };
  return right && right !== id ? { kind: 'session', id, split: right } : { kind: 'session', id };
}
