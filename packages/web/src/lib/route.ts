/**
 * Routing is just the URL hash (docs/web.md, "The web app"): `#/` is the draft
 * for a new session in the most recently used project, `#/new/<workspace>` one
 * in a given project, `#/s/<id>` a session. No router library — this also
 * works unchanged under a `file://` desktop shell later.
 *
 * The server hands the token over as `#token=…` on first load; `token.ts`
 * strips it, and until then anything that is not a route parses as home.
 */

export type Route =
  | { kind: 'home' }
  | { kind: 'new'; workspaceId: string }
  | { kind: 'session'; id: string };

export function parseRoute(hash: string): Route {
  const session = /^#\/s\/([^/?#]+)\/?$/.exec(hash);
  if (session?.[1]) return { kind: 'session', id: decodeURIComponent(session[1]) };
  const draft = /^#\/new\/([^/?#]+)\/?$/.exec(hash);
  if (draft?.[1]) return { kind: 'new', workspaceId: decodeURIComponent(draft[1]) };
  return { kind: 'home' };
}

export function routeToHash(route: Route): string {
  switch (route.kind) {
    case 'session':
      return `#/s/${encodeURIComponent(route.id)}`;
    case 'new':
      return `#/new/${encodeURIComponent(route.workspaceId)}`;
    case 'home':
      return '#/';
  }
}
