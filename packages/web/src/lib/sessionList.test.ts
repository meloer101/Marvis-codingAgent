import type { SessionSummary } from '@harness-code/protocol';
import { describe, expect, it } from 'vitest';

import { applySessionPush, mergeSessionList } from './sessionList';

const row = (id: string, rev: number, over: Partial<SessionSummary> = {}): SessionSummary => ({
  id,
  mtimeMs: 1000,
  title: id,
  live: false,
  running: false,
  pending: false,
  rev,
  ...over,
});

describe('applySessionPush', () => {
  it('inserts, replaces and removes rows, newest first', () => {
    let list = [row('a', 1, { mtimeMs: 10 })];
    list = applySessionPush(list, { type: 'session_upsert', summary: row('b', 2, { mtimeMs: 20 }) });
    expect(list.map((s) => s.id)).toEqual(['b', 'a']);
    list = applySessionPush(list, { type: 'session_upsert', summary: row('a', 3, { mtimeMs: 30, running: true }) });
    expect(list.map((s) => [s.id, s.running])).toEqual([
      ['a', true],
      ['b', false],
    ]);
    list = applySessionPush(list, { type: 'session_removed', id: 'b', rev: 4 });
    expect(list.map((s) => s.id)).toEqual(['a']);
  });

  it('drops a push older than the row it would replace', () => {
    const list = [row('a', 5, { running: true })];
    expect(applySessionPush(list, { type: 'session_upsert', summary: row('a', 4) })).toBe(list);
    expect(applySessionPush(list, { type: 'session_removed', id: 'a', rev: 3 })).toBe(list);
  });
});

describe('mergeSessionList', () => {
  it('keeps a row pushed while the list was being built', () => {
    // The list was stamped rev 7; the push for `a` (rev 8) came after it.
    const held = [row('a', 8, { running: true })];
    const merged = mergeSessionList(held, [row('a', 7), row('b', 7)], false);
    expect(merged.find((s) => s.id === 'a')?.running).toBe(true);
    expect(merged.map((s) => s.id).sort()).toEqual(['a', 'b']);
  });

  it('drops held rows the list no longer has, unless they are newer than it', () => {
    const held = [row('gone', 3), row('brand-new', 9)];
    const merged = mergeSessionList(held, [row('kept', 7)], false);
    expect(merged.map((s) => s.id).sort()).toEqual(['brand-new', 'kept']);
  });

  it('replaces everything after a server restart, whatever the revs say', () => {
    const held = [row('a', 500, { running: true }), row('old', 400)];
    expect(mergeSessionList(held, [row('a', 1)], true)).toEqual([row('a', 1)]);
  });
});
