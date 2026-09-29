/**
 * The server hands the auth token over as `#token=…` on the URL it prints. On
 * load we move it into `localStorage` — so reloads, new tabs and bookmarks keep
 * working (`hc web` keeps one token across restarts, on a fixed port, so the
 * origin and the token both stay put) — and scrub it from the address bar so
 * it doesn't end up in screenshots, history, or a copied link.
 */

const KEY = 'hc.token';

export interface TokenEnv {
  location: { hash: string; pathname: string; search: string };
  history: { replaceState(data: unknown, unused: string, url?: string): void };
  storage: { getItem(key: string): string | null; setItem(key: string, value: string): void };
}

export function takeToken(env: TokenEnv = defaultEnv()): string | null {
  const match = /^#token=([0-9a-fA-F]+)$/.exec(env.location.hash);
  if (match?.[1]) {
    const token = match[1];
    try {
      env.storage.setItem(KEY, token);
    } catch {
      // storage blocked — the token still works for this page load
    }
    env.history.replaceState(null, '', `${env.location.pathname}${env.location.search}#/`);
    return token;
  }
  try {
    return env.storage.getItem(KEY);
  } catch {
    return null;
  }
}

function defaultEnv(): TokenEnv {
  return {
    location: window.location,
    history: window.history,
    storage: {
      // A tab opened before the token moved to localStorage still has it here.
      getItem: (key) => window.localStorage.getItem(key) ?? window.sessionStorage.getItem(key),
      setItem: (key, value) => window.localStorage.setItem(key, value),
    },
  };
}
