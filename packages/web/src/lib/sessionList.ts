/**
 * The sidebar's session list as pure functions over `SessionSummary[]`.
 *
 * Rows arrive two ways: a full `session.list` (on every connect) and
 * `session_upsert` / `session_removed` pushes as sessions change. Either can
 * arrive after the other was computed, so every row carries the server's
 * `rev` and a row is only ever replaced by a newer one — a list built before
 * a push can't roll that push back.
 */

import type { PushEvent, SessionSummary } from '@harness-code/protocol';

function newestFirst(rows: SessionSummary[]): SessionSummary[] {
  return rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** The pushes that change the session list. */
export type SessionPush = Extract<PushEvent, { type: 'session_upsert' | 'session_removed' }>;

/** Apply one pushed change. Stale pushes (an older `rev` than the row held) are dropped. */
export function applySessionPush(list: SessionSummary[], event: SessionPush): SessionSummary[] {
  const id = event.type === 'session_upsert' ? event.summary.id : event.id;
  const rev = event.type === 'session_upsert' ? event.summary.rev : event.rev;
  const current = list.find((s) => s.id === id);
  if (current && current.rev > rev) return list;
  const rest = list.filter((s) => s.id !== id);
  return event.type === 'session_upsert' ? newestFirst([...rest, event.summary]) : rest;
}

/**
 * Merge a fresh `session.list` into the rows held. Within one server boot, a
 * held row newer than the list (pushed while the list was being built)
 * survives it; after a restart (`bootChanged`: `rev`s began again at zero)
 * the list replaces everything.
 */
export function mergeSessionList(
  held: SessionSummary[],
  incoming: SessionSummary[],
  bootChanged: boolean,
): SessionSummary[] {
  if (bootChanged) return newestFirst([...incoming]);
  const listRev = incoming.reduce((max, s) => Math.max(max, s.rev), 0);
  const rows = new Map(incoming.map((s) => [s.id, s]));
  for (const row of held) {
    const fresh = rows.get(row.id);
    if (fresh ? row.rev > fresh.rev : row.rev > listRev) rows.set(row.id, row);
  }
  return newestFirst([...rows.values()]);
}
