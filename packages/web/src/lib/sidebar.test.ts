import type { SessionSummary, Workspace } from '@harness-code/protocol';
import { describe, expect, it } from 'vitest';

import { markSeen, rangeBetween, rowStatus, sidebarGroups } from './sidebar';

const ws = (id: string): Workspace => ({
  id,
  root: `/code/${id}`,
  name: id,
  projectRoot: `/code/${id}`,
  lastUsedAt: 1,
  defaults: { model: 'm', mode: 'ask', modes: ['ask'], effortLevels: [] },
});

const row = (id: string, workspaceId: string, over: Partial<SessionSummary> = {}): SessionSummary => ({
  id,
  workspaceId,
  title: id,
  mtimeMs: 1,
  live: false,
  running: false,
  pending: false,
  pinned: false,
  archived: false,
  rev: 1,
  ...over,
});

describe('sidebarGroups', () => {
  const workspaces = [ws('b'), ws('a')]; // server order: most recently used first
  const sessions = [
    row('old', 'a', { mtimeMs: 1 }),
    row('new', 'a', { mtimeMs: 5 }),
    row('pinned', 'a', { mtimeMs: 2, pinned: true }),
    row('put away', 'a', { mtimeMs: 9, archived: true }),
    row('other', 'b', { mtimeMs: 3 }),
  ];

  it('groups by project in server order: pinned first, then newest; archived counted, not shown', () => {
    const groups = sidebarGroups(workspaces, sessions);
    expect(groups.map((g) => g.workspace.id)).toEqual(['b', 'a']);
    expect(groups[1]!.rows.map((r) => r.id)).toEqual(['pinned', 'new', 'old']);
    expect(groups[1]!.archivedCount).toBe(1);
  });

  it('shows archived sessions of the projects that ask for them', () => {
    const groups = sidebarGroups(workspaces, sessions, { showArchived: new Set(['a']) });
    expect(groups[1]!.rows.map((r) => r.id)).toEqual(['pinned', 'put away', 'new', 'old']);
  });

  it('keeps projects without sessions, except while searching', () => {
    expect(sidebarGroups([ws('empty')], []).map((g) => g.rows)).toEqual([[]]);
    const found = sidebarGroups(workspaces, sessions, { query: '  NEW ' });
    expect(found.map((g) => [g.workspace.id, g.rows.map((r) => r.id)])).toEqual([['a', ['new']]]);
  });
});

describe('rangeBetween', () => {
  const order = ['a', 'b', 'c', 'd'];
  it('runs from the anchor to the row clicked, either way, both included', () => {
    expect(rangeBetween(order, 'b', 'd')).toEqual(['b', 'c', 'd']);
    expect(rangeBetween(order, 'd', 'b')).toEqual(['b', 'c', 'd']);
    expect(rangeBetween(order, 'c', 'c')).toEqual(['c']);
  });

  it('is just the row clicked without an anchor on show, and nothing for a row not on show', () => {
    expect(rangeBetween(order, null, 'c')).toEqual(['c']);
    expect(rangeBetween(order, 'folded', 'c')).toEqual(['c']);
    expect(rangeBetween(order, 'a', 'gone')).toEqual([]);
  });
});

describe('rowStatus', () => {
  it('puts waiting on you before running before unread', () => {
    expect(rowStatus(row('x', 'a', { pending: true, running: true, mtimeMs: 9 }), 1, false)).toBe('pending');
    expect(rowStatus(row('x', 'a', { running: true, mtimeMs: 9 }), 1, false)).toBe('running');
    expect(rowStatus(row('x', 'a', { mtimeMs: 9 }), 1, false)).toBe('unread');
  });

  it('is unread only when seen here before, changed since, and not on screen', () => {
    expect(rowStatus(row('x', 'a', { mtimeMs: 9 }), undefined, false)).toBe('idle'); // never shown here
    expect(rowStatus(row('x', 'a', { mtimeMs: 9 }), 9, false)).toBe('idle');
    expect(rowStatus(row('x', 'a', { mtimeMs: 9 }), 1, true)).toBe('idle'); // on screen
  });
});

describe('markSeen', () => {
  it('only moves forward', () => {
    const seen = markSeen({}, 'x', 5);
    expect(markSeen(seen, 'x', 3)).toBe(seen);
    expect(markSeen(seen, 'x', 7)).toEqual({ x: 7 });
  });
});
