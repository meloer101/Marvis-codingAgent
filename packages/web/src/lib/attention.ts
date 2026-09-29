/**
 * What deserves the user's attention while they look elsewhere: a session
 * starting to wait on them, or finishing a run. Derived from successive states
 * of the sidebar list (which the server keeps current through pushes), so it
 * covers every session, open in this tab or not.
 */

import type { SessionSummary } from '@harness-code/protocol';

import { platform } from '@/platform';

export interface Attention {
  id: string;
  title: string;
  kind: 'needs-you' | 'finished';
}

/**
 * Transitions from `prev` to `next` worth a notification. Rows `prev` didn't
 * have are not news: the first load, or a session another tab just created.
 */
export function attentionChanges(prev: SessionSummary[], next: SessionSummary[]): Attention[] {
  const before = new Map(prev.map((s) => [s.id, s]));
  const out: Attention[] = [];
  for (const s of next) {
    const was = before.get(s.id);
    if (!was) continue;
    if (s.pending && !was.pending) out.push({ id: s.id, title: s.title, kind: 'needs-you' });
    else if (was.running && !s.running && !s.pending) out.push({ id: s.id, title: s.title, kind: 'finished' });
  }
  return out;
}

const APP = 'hc web';

/** The tab title: how many sessions wait on the user, else whether any is working. */
export function documentTitle(sessions: SessionSummary[]): string {
  const waiting = sessions.filter((s) => s.pending).length;
  if (waiting > 0) return `(${waiting}) Waiting for you · ${APP}`;
  if (sessions.some((s) => s.running)) return `Working… · ${APP}`;
  return APP;
}

const PREF = 'hc.notify';

/** Notifications are on once permission is granted, unless the user turned them off. */
export function notificationsOn(): boolean {
  return platform.notifyPermission() === 'granted' && platform.storage.get(PREF) !== 'off';
}

export function setNotificationsOn(on: boolean): void {
  platform.storage.set(PREF, on ? 'on' : 'off');
}
