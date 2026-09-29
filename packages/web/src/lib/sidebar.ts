/**
 * The sidebar as data: sessions grouped by project, filtered, ordered, with
 * what each row should say about itself. Pure, so the rules are testable
 * apart from the rendering.
 */

import type { SessionSummary, Workspace } from '@harness-code/protocol';

import { platform } from '@/platform';

export interface SidebarGroup {
  workspace: Workspace;
  /** What to show: pinned first, then newest first; archived ones only when asked for. */
  rows: SessionSummary[];
  /** Archived sessions in this project (matching the search, if any). */
  archivedCount: number;
}

/**
 * One group per project, in the server's order (most recently used first).
 * With a `query`, only sessions whose title contains it (any case), and only
 * projects that have some.
 */
export function sidebarGroups(
  workspaces: readonly Workspace[],
  sessions: readonly SessionSummary[],
  opts: { query?: string; showArchived?: ReadonlySet<string> } = {},
): SidebarGroup[] {
  const query = opts.query?.trim().toLowerCase() ?? '';
  const byWorkspace = new Map<string, SessionSummary[]>();
  for (const s of sessions) {
    if (query && !s.title.toLowerCase().includes(query)) continue;
    const list = byWorkspace.get(s.workspaceId);
    if (list) list.push(s);
    else byWorkspace.set(s.workspaceId, [s]);
  }
  const groups: SidebarGroup[] = [];
  for (const workspace of workspaces) {
    const all = byWorkspace.get(workspace.id) ?? [];
    if (query && all.length === 0) continue;
    const archived = all.filter((s) => s.archived);
    const shown = opts.showArchived?.has(workspace.id) ? all : all.filter((s) => !s.archived);
    const rows = [...shown].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.mtimeMs - a.mtimeMs);
    groups.push({ workspace, rows, archivedCount: archived.length });
  }
  return groups;
}

/** What a row's right edge shows, most urgent first. */
export type RowStatus = 'pending' | 'running' | 'unread' | 'idle';

/**
 * Unread: something happened in a session since this browser last showed it
 * — a run finished while you looked elsewhere. Sessions never shown here
 * (made in another tab, or before this) are not unread.
 */
export function rowStatus(row: SessionSummary, seenAt: number | undefined, active: boolean): RowStatus {
  if (row.pending) return 'pending';
  if (row.running) return 'running';
  if (!active && seenAt !== undefined && row.mtimeMs > seenAt) return 'unread';
  return 'idle';
}

const SEEN_KEY = 'hc.seen';
const SEEN_LIMIT = 500;

/** When each session was last shown in this browser (its `mtimeMs` then), per session id. */
export function loadSeen(): Record<string, number> {
  try {
    const raw = platform.storage.get(SEEN_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

/** Record that `id` has been seen up to `mtimeMs`; keeps the newest `SEEN_LIMIT` entries. */
export function markSeen(seen: Record<string, number>, id: string, mtimeMs: number): Record<string, number> {
  if ((seen[id] ?? -1) >= mtimeMs) return seen;
  const next = { ...seen, [id]: mtimeMs };
  const ids = Object.keys(next);
  if (ids.length > SEEN_LIMIT) {
    for (const old of ids.sort((a, b) => next[a]! - next[b]!).slice(0, ids.length - SEEN_LIMIT)) delete next[old];
  }
  platform.storage.set(SEEN_KEY, JSON.stringify(next));
  return next;
}
