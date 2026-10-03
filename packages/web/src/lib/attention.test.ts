import type { SessionSummary } from '@harness-code/protocol';
import { describe, expect, it } from 'vitest';

import { attentionChanges, documentTitle } from './attention';

const row = (id: string, over: Partial<SessionSummary> = {}): SessionSummary => ({
  id,
  workspaceId: 'w1',
  mtimeMs: 1,
  title: `title ${id}`,
  live: true,
  running: false,
  pending: false,
  pinned: false,
  archived: false,
  rev: 1,
  ...over,
});

describe('attentionChanges', () => {
  it('reports a session starting to wait on the user, and one finishing a run', () => {
    const prev = [row('a', { running: true }), row('b', { running: true })];
    const next = [row('a', { running: true, pending: true }), row('b')];
    expect(attentionChanges(prev, next)).toEqual([
      { id: 'a', title: 'title a', kind: 'needs-you' },
      { id: 'b', title: 'title b', kind: 'finished' },
    ]);
  });

  it('stays quiet about rows it had not seen, and about states that did not change', () => {
    expect(attentionChanges([], [row('new', { pending: true })])).toEqual([]);
    const waiting = [row('a', { running: true, pending: true })];
    expect(attentionChanges(waiting, waiting)).toEqual([]);
  });

  it('does not call a run finished while it still waits on the user', () => {
    const prev = [row('a', { running: true })];
    expect(attentionChanges(prev, [row('a', { pending: true })])).toEqual([
      { id: 'a', title: 'title a', kind: 'needs-you' },
    ]);
  });
});

describe('documentTitle', () => {
  it('counts sessions waiting on the user first, then shows work in progress', () => {
    expect(documentTitle([row('a', { pending: true }), row('b', { pending: true }), row('c', { running: true })])).toBe(
      '(2) Waiting for you · Marvis',
    );
    expect(documentTitle([row('a', { running: true })])).toBe('Working… · Marvis');
    expect(documentTitle([row('a')])).toBe('Marvis');
  });
});
