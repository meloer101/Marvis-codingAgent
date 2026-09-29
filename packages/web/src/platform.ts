/**
 * The seam between the web UI and its host. v1 only
 * runs in a browser; an Electron shell would provide its own `Platform` and
 * everything above this file stays unchanged.
 */

export interface PlatformStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export type NotifyPermission = 'granted' | 'denied' | 'default' | 'unsupported';

export interface NotifyOptions {
  body?: string;
  /** Notifications sharing a tag replace each other — how several open tabs show just one. */
  tag?: string;
  /** Runs after the notification brings the app to the front. */
  onClick?: () => void;
}

export interface Platform {
  /** Open a URL outside the app (new tab in a browser, system browser in Electron). */
  openExternal(url: string): void;
  /**
   * Surface a system notification — only while the app is not in front, and
   * only once permission was granted (`requestNotifyPermission`).
   */
  notify(title: string, opts?: NotifyOptions): void;
  notifyPermission(): NotifyPermission;
  /** Ask for permission. Browsers (Safari above all) only allow this from a click. */
  requestNotifyPermission(): Promise<NotifyPermission>;
  /** Durable per-user key/value storage (composer drafts, UI prefs). */
  storage: PlatformStorage;
}

/** `localStorage` can throw (private mode, blocked site data) — degrade to no-ops. */
function browserStorage(): PlatformStorage {
  return {
    get(key) {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        // storage unavailable — drop the write
      }
    },
    remove(key) {
      try {
        window.localStorage.removeItem(key);
      } catch {
        // storage unavailable — nothing to remove
      }
    },
  };
}

export function createBrowserPlatform(): Platform {
  return {
    openExternal(url) {
      window.open(url, '_blank', 'noopener,noreferrer');
    },
    notify(title, opts = {}) {
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
      if (document.visibilityState === 'visible' && document.hasFocus()) return;
      const n = new Notification(title, {
        ...(opts.body !== undefined ? { body: opts.body } : {}),
        ...(opts.tag !== undefined ? { tag: opts.tag } : {}),
      });
      n.onclick = () => {
        window.focus();
        opts.onClick?.();
        n.close();
      };
    },
    notifyPermission() {
      return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
    },
    async requestNotifyPermission() {
      if (typeof Notification === 'undefined') return 'unsupported';
      return Notification.requestPermission();
    },
    storage: browserStorage(),
  };
}

export const platform: Platform = createBrowserPlatform();
