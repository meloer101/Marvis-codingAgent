import { describe, expect, it } from 'vitest';

import type { Entry, ToolItem } from '@harness-code/protocol';

import { exploreSummary, retryTarget, transcriptRows, turnParts, turnText, withLive } from './rows';
import type { Step } from './rows';

let n = 0;
function tool(name: string, input: unknown = {}, over: Partial<ToolItem> = {}): ToolItem {
  return { id: `t${n++}`, name, input, running: false, result: { content: 'ok' }, ...over };
}
function step(id: number, over: Partial<Step> = {}): Step {
  return { id, thinking: '', text: '', tools: [], ...over };
}
const kinds = (steps: Step[], verbose = false) => turnParts(steps, verbose).map((p) => p.kind);

describe('turn rows', () => {
  it('join consecutive assistant entries; a user message or notice starts a new one', () => {
    const a = (id: number) => ({ kind: 'assistant', id, thinking: '', text: 'x', tools: [] }) as Entry;
    const rows = transcriptRows([
      { kind: 'user', id: 0, text: 'hi' },
      a(1),
      a(2),
      { kind: 'notice', id: 3, notice: { kind: 'context-warn', level: 'warn', text: 'full' } } as Entry,
      a(4),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(['entry', 'turn', 'entry', 'turn']);
    expect(rows[1]!.kind === 'turn' && rows[1]!.steps.map((s) => s.id)).toEqual([1, 2]);
  });

  it('the streaming step continues the last turn, keeping the other rows', () => {
    const rows = transcriptRows([{ kind: 'user', id: 0, text: 'hi' }, { kind: 'assistant', id: 1, thinking: '', text: 'a', tools: [] }]);
    const live = withLive(rows, { thinking: '', text: 'b', tools: [] }, 2);
    expect(live[0]).toBe(rows[0]);
    const turn = live[1]!;
    expect(turn.kind === 'turn' && turn.key).toBe('turn-1');
    expect(turn.kind === 'turn' && turn.steps.map((s) => [s.id, s.streaming ?? false])).toEqual([
      [1, false],
      [2, true],
    ]);
    expect(withLive(rows, { thinking: '', text: '', tools: [] }, 2)).toBe(rows);
    // After a user message it starts its own turn, keyed by the id it will commit with.
    const fresh = withLive(transcriptRows([{ kind: 'user', id: 0, text: 'hi' }]), { thinking: 'hm', text: '', tools: [] }, 1);
    expect(fresh.at(-1)!.key).toBe('turn-1');
  });
});

describe('turnParts', () => {
  it('folds two or more exploration calls across steps, with the thinking between them', () => {
    const steps = [
      step(1, { thinking: 'look first', tools: [tool('read', { path: 'a.ts' })] }),
      step(2, { thinking: 'and grep', tools: [tool('grep', { pattern: 'x' }), tool('read', { path: 'b.ts' })] }),
      step(3, { thinking: 'got it', text: 'Here is the answer.' }),
    ];
    const parts = turnParts(steps, false);
    expect(parts.map((p) => p.kind)).toEqual(['thinking', 'explore', 'thinking', 'text']);
    const group = parts[1]!;
    expect(group.kind === 'explore' && group.parts.map((p) => p.kind)).toEqual(['tool', 'thinking', 'tool', 'tool']);
    expect(kinds(steps, true)).toEqual(['thinking', 'tool', 'thinking', 'tool', 'tool', 'thinking', 'text']);
  });

  it('leaves a lone exploration call as its own card, and breaks groups at text and other tools', () => {
    expect(kinds([step(1, { tools: [tool('read'), tool('bash')] })])).toEqual(['tool', 'tool']);
    expect(kinds([step(1, { tools: [tool('read'), tool('read'), tool('edit'), tool('read')] })])).toEqual([
      'explore',
      'tool',
      'tool',
    ]);
    expect(kinds([step(1, { tools: [tool('read')] }), step(2, { text: 'so', tools: [tool('grep')] })])).toEqual([
      'tool',
      'text',
      'tool',
    ]);
  });

  it('keys parts by step and tool, so the group keeps its key as it grows', () => {
    const first = tool('read');
    const a = turnParts([step(1, { tools: [first, tool('grep')] })], false);
    const b = turnParts([step(1, { tools: [first, tool('grep')] }), step(2, { tools: [tool('glob')], streaming: true })], false);
    expect(a.map((p) => p.key)).toEqual([`explore:${first.id}`]);
    expect(b.map((p) => p.key)).toEqual([`explore:${first.id}`]);
  });

  it('marks thinking active and text streaming only while they are the step’s latest output', () => {
    const [thinking] = turnParts([step(1, { thinking: 'hm', streaming: true })], false);
    expect(thinking).toMatchObject({ kind: 'thinking', active: true });
    const parts = turnParts([step(1, { thinking: 'hm', text: 'so', streaming: true })], false);
    expect(parts.map((p) => (p.kind === 'thinking' ? p.active : p.kind === 'text' ? p.streaming : null))).toEqual([false, true]);
  });
});

describe('exploreSummary', () => {
  it('counts distinct files and searches (grep or glob), in the order they first appear', () => {
    expect(
      exploreSummary([
        tool('grep', { pattern: 'a' }),
        tool('read', { path: 'a.ts' }),
        tool('read', { path: 'a.ts', offset: 40 }),
        tool('read', { path: 'b.ts' }),
        tool('grep', { pattern: 'b' }),
        tool('glob', { pattern: '*.md' }),
      ]),
    ).toBe('Searched for 3 patterns, read 2 files');
    expect(exploreSummary([tool('read', { path: 'a' }), tool('webfetch', { url: 'u' })])).toBe('Read 1 file, fetched 1 page');
  });
});

describe('retryTarget', () => {
  const user: Entry = { kind: 'user', id: 0, text: 'fix it', attachments: ['a.ts'] };
  const reply: Entry = { kind: 'assistant', id: 1, thinking: '', text: 'done', tools: [] };
  const failed: Entry = { kind: 'notice', id: 2, notice: { kind: 'error', level: 'error', text: 'provider down' } };

  it('offers the last message after a run that failed or was stopped, or got no reply', () => {
    expect(retryTarget([user, reply, failed], false)).toEqual({ text: 'fix it', attachments: ['a.ts'], images: [] });
    expect(retryTarget([user], false)).toEqual({ text: 'fix it', attachments: ['a.ts'], images: [] });
  });

  it('offers nothing once a run answered, while one is going, or before any message', () => {
    expect(retryTarget([user, reply], false)).toBeNull();
    expect(retryTarget([user, failed], true)).toBeNull();
    expect(retryTarget([], false)).toBeNull();
    // An earlier failure doesn't count once a later message got its answer.
    expect(retryTarget([user, failed, { ...user, id: 3, text: 'again' }, { ...reply, id: 4 }], false)).toBeNull();
  });
});

describe('turnText', () => {
  it("joins a turn's text, step by step, leaving out steps with none", () => {
    expect(turnText([step(1, { text: 'Looking.\n' }), step(2, { tools: [tool('read')] }), step(3, { text: 'Found it.' })])).toBe(
      'Looking.\n\nFound it.',
    );
  });
});
