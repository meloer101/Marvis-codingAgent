import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ScriptedProvider } from '../provider/mock.js';
import type { Message } from '../provider/types.js';
import {
  COMPACTION_MARKER,
  PRUNED_TOOL_RESULT_PREFIX,
  applyToolOutputOffload,
  compactMessages,
  createCompactor,
  ensureInvariants,
  extractCompactionInvariants,
  parseGoalAndPriorDigest,
  pruneToolOutputs,
  selectRecentUserMessages,
  splitForCompaction,
} from './compactor.js';
import { heuristicTokenCount } from './tokenizer.js';
import { ToolOutputStore } from './tool-output.js';

const goal = (text: string): Message => ({ role: 'user', content: [{ type: 'text', text }] });

/** One turn: assistant asks for a tool, user returns the result. */
function toolTurn(n: number): Message[] {
  return [
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: `c${n}`, name: 'read', input: { path: `f${n}.ts` } }],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', toolUseId: `c${n}`, content: `contents of f${n}.ts` }],
    },
  ];
}

function history(turns: number): Message[] {
  const msgs: Message[] = [goal('fix the parser bug')];
  for (let i = 1; i <= turns; i++) msgs.push(...toolTurn(i));
  return msgs;
}

const ctx = { turn: 1, cwd: '/tmp', messages: [] };

describe('splitForCompaction', () => {
  it('cuts on turn boundaries, keeping the last N turns', () => {
    const split = splitForCompaction(history(10), 3);
    expect(split).toBeDefined();
    expect(split!.keptTurns).toBe(3);
    // 3 kept turns * 2 messages each
    expect(split!.tail).toHaveLength(6);
    expect(split!.tail[0]?.role).toBe('assistant');
    expect(split!.middle).toHaveLength((10 - 3) * 2);
  });

  it('never splits an assistant tool_use from its tool_result', () => {
    const split = splitForCompaction(history(8), 3)!;
    for (const seg of [split.middle, split.tail]) {
      for (let i = 0; i < seg.length; i++) {
        const uses = seg[i]?.content.filter((b) => b.type === 'tool_use') ?? [];
        if (uses.length > 0) {
          const next = seg[i + 1];
          expect(next?.content.some((b) => b.type === 'tool_result')).toBe(true);
        }
      }
    }
  });

  it('returns undefined when there are not enough turns', () => {
    expect(splitForCompaction(history(3), 3)).toBeUndefined();
    expect(splitForCompaction([goal('hi')], 3)).toBeUndefined();
  });

  it('keeps a fresh user prompt as its own turn boundary', () => {
    const msgs: Message[] = [
      goal('first task'),
      ...toolTurn(1),
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      goal('second task'),
      ...toolTurn(2),
      ...toolTurn(3),
      ...toolTurn(4),
    ];
    const split = splitForCompaction(msgs, 3)!;
    // "second task" is the 4th-from-last group, so it lands in middle, not tail
    expect(split.tail[0]?.role).toBe('assistant');
    expect(split.middle.some((m) => m.content.some((b) => b.type === 'text' && b.text === 'second task'))).toBe(true);
  });
});

describe('compactMessages / parseGoalAndPriorDigest', () => {
  it('merges the verbatim goal and digest into one head, then the tail', () => {
    const tail = [...toolTurn(9), ...toolTurn(10)];
    const out = compactMessages('fix the parser bug', 'DIGEST BODY', tail);
    expect(out).toHaveLength(1 + tail.length);
    const headText = out[0]?.content[0];
    expect(headText).toMatchObject({ type: 'text' });
    expect((headText as { text: string }).text).toContain('fix the parser bug');
    expect((headText as { text: string }).text).toContain('DIGEST BODY');
    expect(out[1]).toEqual(tail[0]);
  });

  it('round-trips the goal and prior digest back out of a compacted head', () => {
    const head = compactMessages('original goal', 'prior digest text', [])[0]!;
    const parsed = parseGoalAndPriorDigest(head);
    expect(parsed.goal.trim()).toBe('original goal');
    expect(parsed.priorDigest?.trim()).toBe('prior digest text');
  });

  it('treats an uncompacted head as goal-only', () => {
    expect(parseGoalAndPriorDigest(goal('just a goal'))).toEqual({ goal: 'just a goal' });
  });
});

describe('extractCompactionInvariants / ensureInvariants', () => {
  it('picks up a user prohibition and a Denied tool_result', () => {
    const msgs: Message[] = [
      goal('fix the bug. 不要碰 secrets/'),
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'c1', name: 'bash', input: {} }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            toolUseId: 'c1',
            content: 'Denied: path outside workspace',
            isError: true,
          },
        ],
      },
    ];
    const inv = extractCompactionInvariants(msgs);
    expect(inv.some((s) => s.includes('不要碰 secrets/'))).toBe(true);
    expect(inv.some((s) => s.startsWith('Denied:'))).toBe(true);
  });

  it('prepends missing invariants and leaves a complete digest alone', () => {
    expect(ensureInvariants('keep', [])).toBe('keep');
    expect(ensureInvariants('already 不要碰 secrets/ here', ['不要碰 secrets/'])).toBe(
      'already 不要碰 secrets/ here',
    );
    const out = ensureInvariants('## 任务状态\nok', ['不要碰 secrets/']);
    expect(out).toContain('不要碰 secrets/');
    expect(out.indexOf('不要碰 secrets/')).toBeLessThan(out.indexOf('任务状态'));
  });
});

describe('createCompactor', () => {
  it('summarizes the middle and returns [head+digest, ...tail]', async () => {
    const provider = new ScriptedProvider([{ text: '## 任务状态\n- 原始目标：fix the parser bug\n## 协作与风格备忘\n- 与用户协作：无偏差' }]);
    const onCompact = createCompactor({
      provider,
      model: 'm',
      conventions: '<code_style>baseline</code_style>',
      minCompactTokens: 0,
    });

    const result = await onCompact(history(10), { usedTokens: 1, windowTokens: 1, ratio: 1 }, ctx);

    expect(result).toBeDefined();
    expect(result!.keptTurns).toBe(3);
    expect(result!.messages).toHaveLength(1 + 6);
    const headText = (result!.messages[0]?.content[0] as { text: string }).text;
    expect(headText).toContain('fix the parser bug');
    expect(headText).toContain('协作与风格备忘');
    expect(headText.includes(COMPACTION_MARKER.trim())).toBe(true);
    expect(provider.requests[0]?.messages[0]?.content[0]).toMatchObject({ type: 'text' });
  });

  it('asks for the digest on the turn prefix when warmPrefix is on', async () => {
    const provider = new ScriptedProvider([{ text: 'digest' }]);
    const onCompact = createCompactor({
      provider,
      model: 'm',
      conventions: 'c',
      minCompactTokens: 0,
      warmPrefix: true,
      summaryEffort: 'low',
    });
    const system = [{ id: 'identity', text: 'You are a coding agent.' }];
    const tools = [{ name: 'read', description: 'Read a file', inputSchema: { type: 'object' } }];

    await onCompact(history(10), { usedTokens: 1, windowTokens: 1, ratio: 1 }, {
      ...ctx,
      system,
      tools,
    });

    const req = provider.requests[0]!;
    // Same prefix as the turn: same system, same tools, history verbatim.
    expect(req.system).toEqual(system);
    expect(req.tools).toEqual(tools);
    expect(req.toolChoice).toBe('none');
    expect(req.reasoningEffort).toBe('low');
    expect(req.temperature).toBeUndefined();
    // head + (10 - 3 kept) turns * 2 messages + the trailing instruction.
    expect(req.messages).toHaveLength(1 + 14 + 1);
    expect(req.messages[0]).toEqual(history(10)[0]);
    const instruction = (req.messages.at(-1)?.content[0] as { text: string }).text;
    expect(instruction).toContain('以上全部对话历史');
  });

  it('falls back to the flattened prompt when the turn passed no prefix', async () => {
    const provider = new ScriptedProvider([{ text: 'digest' }]);
    const onCompact = createCompactor({
      provider,
      model: 'm',
      conventions: 'c',
      minCompactTokens: 0,
      warmPrefix: true,
    });

    await onCompact(history(10), { usedTokens: 1, windowTokens: 1, ratio: 1 }, ctx);

    const req = provider.requests[0]!;
    expect(req.messages).toHaveLength(1);
    expect(req.tools).toBeUndefined();
    expect((req.messages[0]?.content[0] as { text: string }).text).toContain('contents of f1.ts');
  });

  it('feeds the prior digest back in on a second compaction', async () => {
    const provider = new ScriptedProvider([
      { text: 'digest v1' },
      { text: 'digest v2' },
    ]);
    const onCompact = createCompactor({ provider, model: 'm', conventions: 'c', minCompactTokens: 0 });

    const first = await onCompact(history(10), { usedTokens: 1, windowTokens: 1, ratio: 1 }, ctx);
    const grown = [...first!.messages, ...toolTurn(11), ...toolTurn(12), ...toolTurn(13), ...toolTurn(14)];
    await onCompact(grown, { usedTokens: 1, windowTokens: 1, ratio: 1 }, ctx);

    const secondPrompt = (provider.requests[1]?.messages[0]?.content[0] as { text: string }).text;
    expect(secondPrompt).toContain('digest v1');
  });

  it('returns undefined (never throws) when the summarizer fails', async () => {
    const provider = new ScriptedProvider([]); // out of turns -> throws
    const skips: string[] = [];
    const onCompact = createCompactor({
      provider,
      model: 'm',
      conventions: 'c',
      minCompactTokens: 0,
      onSkip: (r) => skips.push(r),
    });

    const result = await onCompact(history(10), { usedTokens: 1, windowTokens: 1, ratio: 1 }, ctx);

    expect(result).toBeUndefined();
    expect(skips[0]).toContain('compaction skipped');
  });

  it('skips when the compactable history is below the minimum', async () => {
    const provider = new ScriptedProvider([{ text: 'unreached' }]);
    const onCompact = createCompactor({ provider, model: 'm', conventions: 'c', minCompactTokens: 1_000_000 });

    const result = await onCompact(history(10), { usedTokens: 1, windowTokens: 1, ratio: 1 }, ctx);

    expect(result).toBeUndefined();
    expect(provider.callCount).toBe(0);
  });

  it('keeps a user prohibition in the digest even when the summarizer drops it', async () => {
    const provider = new ScriptedProvider([
      { text: '## 任务状态\n- 进展：did stuff\n## 协作与风格备忘\n- 无偏差' },
    ]);
    const onCompact = createCompactor({
      provider,
      model: 'm',
      conventions: 'c',
      minCompactTokens: 0,
    });
    // Prohibition sits in the compactable middle, not the verbatim goal/tail.
    const msgs: Message[] = [
      goal('fix the parser'),
      { role: 'assistant', content: [{ type: 'text', text: 'got it' }] },
      { role: 'user', content: [{ type: 'text', text: '顺便说：不要碰 secrets/' }] },
      ...history(10).slice(1),
    ];
    const result = await onCompact(msgs, { usedTokens: 1, windowTokens: 1, ratio: 1 }, ctx);
    const headText = (result!.messages[0]?.content[0] as { text: string }).text;
    expect(headText).toContain('不要碰 secrets/');
  });

  it('returns a prune-only result when history is too short to summarize', async () => {
    // Newest result fills the protect window; the older huge one is reclaimed.
    const big = 'x'.repeat(80_000);
    const recent = 'r'.repeat(2_000);
    const msgs: Message[] = [
      goal('task'),
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'c1', name: 'bash', input: {} },
          { type: 'tool_use', id: 'c2', name: 'bash', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolUseId: 'c1', content: big },
          { type: 'tool_result', toolUseId: 'c2', content: recent },
        ],
      },
    ];
    const provider = new ScriptedProvider([{ text: 'should not be called' }]);
    const onCompact = createCompactor({
      provider,
      model: 'm',
      conventions: 'c',
      keepTurns: 3,
      pruneProtectTokens: heuristicTokenCount(recent),
      pruneMinReclaimTokens: 100,
    });

    const result = await onCompact(msgs, { usedTokens: 1, windowTokens: 1, ratio: 1 }, ctx);

    expect(provider.callCount).toBe(0);
    expect(result).toBeDefined();
    const results = result!.messages[2]!.content.filter((b) => b.type === 'tool_result');
    expect((results[0] as { content: string }).content).toContain(PRUNED_TOOL_RESULT_PREFIX);
    expect((results[1] as { content: string }).content).toBe(recent);
  });

  it('feeds a pruned middle to the summarizer', async () => {
    const big = 'y'.repeat(60_000);
    const msgs: Message[] = [goal('task')];
    for (let i = 1; i <= 6; i++) {
      msgs.push({
        role: 'assistant',
        content: [{ type: 'tool_use', id: `c${i}`, name: 'bash', input: { i } }],
      });
      msgs.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            toolUseId: `c${i}`,
            // Oldest three are huge; newest three are tiny so the protect
            // window fills on the newest alone and the big ones get pruned.
            content: i <= 3 ? big : `small-${i}`,
          },
        ],
      });
    }
    const provider = new ScriptedProvider([{ text: 'digest after prune' }]);
    const onCompact = createCompactor({
      provider,
      model: 'm',
      conventions: 'c',
      keepTurns: 2,
      minCompactTokens: 0,
      // Only the newest tool_result stays; everything older (incl. the huge ones) is pruned.
      pruneProtectTokens: 1,
      pruneMinReclaimTokens: 100,
    });

    const result = await onCompact(msgs, { usedTokens: 1, windowTokens: 1, ratio: 1 }, ctx);

    expect(result).toBeDefined();
    expect(provider.callCount).toBe(1);
    const prompt = (provider.requests[0]?.messages[0]?.content[0] as { text: string }).text;
    expect(prompt).toContain(PRUNED_TOOL_RESULT_PREFIX);
    expect(prompt).not.toContain(big);
  });
});

describe('pruneToolOutputs', () => {
  it('keeps recent tool outputs and prunes older ones past the protect window', () => {
    const oldBig = 'a'.repeat(50_000);
    // Recent alone must fill the protect window so older content is pruned.
    const recent = 'b'.repeat(5_000);
    const msgs: Message[] = [
      goal('g'),
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'old', name: 'bash', input: {} },
          { type: 'tool_use', id: 'new', name: 'bash', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolUseId: 'old', content: oldBig },
          { type: 'tool_result', toolUseId: 'new', content: recent },
        ],
      },
    ];
    const out = pruneToolOutputs(msgs, {
      protectTokens: heuristicTokenCount(recent),
      minReclaimTokens: 100,
    });
    expect(out.reclaimedTokens).toBeGreaterThan(0);
    const results = out.messages[2]!.content.filter((b) => b.type === 'tool_result');
    expect(results[0]).toMatchObject({
      type: 'tool_result',
      content: expect.stringContaining(PRUNED_TOOL_RESULT_PREFIX),
    });
    expect(results[1]).toMatchObject({ type: 'tool_result', content: recent });
  });

  it('never prunes protected tools (skill)', () => {
    const big = 's'.repeat(50_000);
    const msgs: Message[] = [
      goal('g'),
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'sk', name: 'skill', input: { name: 'x' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: 'sk', content: big }],
      },
    ];
    const out = pruneToolOutputs(msgs, { protectTokens: 10, minReclaimTokens: 10 });
    expect(out.reclaimedTokens).toBe(0);
    expect(out.messages).toBe(msgs);
  });

  it('leaves history unchanged when reclaimable tokens are below the minimum', () => {
    const msgs: Message[] = [
      goal('g'),
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'c1', name: 'bash', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: 'c1', content: 'tiny' }],
      },
    ];
    const out = pruneToolOutputs(msgs, { protectTokens: 0, minReclaimTokens: 20_000 });
    expect(out.reclaimedTokens).toBe(0);
    expect(out.messages).toBe(msgs);
  });

  it('does not re-prune already pruned placeholders', () => {
    const placeholder = `${PRUNED_TOOL_RESULT_PREFIX} bash, 999 chars] Cleared.`;
    const msgs: Message[] = [
      goal('g'),
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'c1', name: 'bash', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: 'c1', content: placeholder }],
      },
    ];
    const out = pruneToolOutputs(msgs, { protectTokens: 0, minReclaimTokens: 1 });
    expect(out.reclaimedTokens).toBe(0);
    expect((out.messages[2]!.content[0] as { content: string }).content).toBe(placeholder);
  });

  it('reports reclaimable tokens roughly matching the cleared content', () => {
    const body = 'z'.repeat(40_000);
    const msgs: Message[] = [
      goal('g'),
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'c1', name: 'read', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: 'c1', content: body }],
      },
    ];
    const out = pruneToolOutputs(msgs, { protectTokens: 0, minReclaimTokens: 100 });
    expect(out.reclaimedTokens).toBe(heuristicTokenCount(body));
  });
});

describe('applyToolOutputOffload', () => {
  it('writes pruned bodies to disk and points the placeholder at a readable path', async () => {
    const body = 'z'.repeat(40_000);
    const msgs: Message[] = [
      goal('g'),
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'c1', name: 'read', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: 'c1', content: body }],
      },
    ];
    const pruned = pruneToolOutputs(msgs, { protectTokens: 0, minReclaimTokens: 100 });
    const dir = await mkdtemp(join(tmpdir(), 'hc-toolout-'));
    const cwd = join(dir, '..');
    const offloaded = await applyToolOutputOffload(pruned, { store: new ToolOutputStore(dir, cwd) });

    const result = offloaded.messages[2]!.content[0] as { content: string };
    expect(result.content).toContain(PRUNED_TOOL_RESULT_PREFIX);
    expect(result.content).toMatch(/Use the read tool to retrieve the original output/);
    const match = result.content.match(/→\s+(\S+\.txt)/);
    expect(match).toBeTruthy();
    const rel = match![1]!;
    const written = await readFile(join(cwd, rel), 'utf8');
    expect(written).toBe(body);
  });

  it('falls back to the re-call placeholder when a write fails, without throwing', async () => {
    const body = 'z'.repeat(40_000);
    const msgs: Message[] = [
      goal('g'),
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'c1', name: 'bash', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: 'c1', content: body }],
      },
    ];
    const pruned = pruneToolOutputs(msgs, { protectTokens: 0, minReclaimTokens: 100 });
    const dir = await mkdtemp(join(tmpdir(), 'hc-toolout-'));
    const offloaded = await applyToolOutputOffload(pruned, {
      store: new ToolOutputStore(dir, tmpdir(), async () => {
        throw new Error('ENOSPC');
      }),
    });

    const result = offloaded.messages[2]!.content[0] as { content: string };
    expect(result.content).toContain(PRUNED_TOOL_RESULT_PREFIX);
    expect(result.content).toMatch(/Re-call the tool/);
    expect(result.content).not.toMatch(/→/);
  });
});

describe('recent user messages kept verbatim', () => {
  const pressure = { usedTokens: 1, windowTokens: 1, ratio: 1 };
  const headOf = (msgs: Message[]) => (msgs[0]!.content[0] as { text: string }).text;

  /** Goal, then `before` tool turns, a user correction, then `after` tool turns. */
  function withCorrection(correction: string, before: number, after: number): Message[] {
    const msgs = history(before);
    msgs.push(goal(correction));
    for (let i = before + 1; i <= before + after; i++) msgs.push(...toolTurn(i));
    return msgs;
  }

  it('keeps a user message from the compacted span even when the digest drops it', async () => {
    const provider = new ScriptedProvider([{ text: 'digest without the correction' }]);
    const onCompact = createCompactor({ provider, model: 'm', conventions: 'c', minCompactTokens: 0 });

    const result = await onCompact(withCorrection('use tabs, not spaces', 3, 5), pressure, ctx);

    const head = headOf(result!.messages);
    expect(head).toContain('use tabs, not spaces');
    const parsed = parseGoalAndPriorDigest(result!.messages[0]!);
    expect(parsed.goal).toBe('fix the parser bug');
    expect(parsed.priorDigest).toBe('digest without the correction');
    expect(parsed.recentUserMessages).toEqual(['use tabs, not spaces']);
  });

  it('carries kept messages through a second compaction', async () => {
    const provider = new ScriptedProvider([{ text: 'digest one' }, { text: 'digest two' }]);
    const onCompact = createCompactor({ provider, model: 'm', conventions: 'c', minCompactTokens: 0 });

    const first = await onCompact(withCorrection('first correction', 3, 5), pressure, ctx);
    const next = [...first!.messages, goal('second correction')];
    for (let i = 20; i < 25; i++) next.push(...toolTurn(i));
    const second = await onCompact(next, pressure, ctx);

    const parsed = parseGoalAndPriorDigest(second!.messages[0]!);
    expect(parsed.priorDigest).toBe('digest two');
    expect(parsed.recentUserMessages).toEqual(['first correction', 'second correction']);
  });

  it('adds no section when the compacted span has no user prompts', async () => {
    const provider = new ScriptedProvider([{ text: 'digest' }]);
    const onCompact = createCompactor({ provider, model: 'm', conventions: 'c', minCompactTokens: 0 });
    const result = await onCompact(history(10), pressure, ctx);
    expect(parseGoalAndPriorDigest(result!.messages[0]!).recentUserMessages).toBeUndefined();
  });

  it('keeps the newest within budget, cutting the one that crosses it', () => {
    const big = 'old '.repeat(4_000);
    const kept = selectRecentUserMessages(
      ['oldest'],
      [goal(big), ...toolTurn(1), goal('newest')],
      500,
    );
    expect(kept).toHaveLength(2);
    expect(kept[1]).toBe('newest');
    expect(kept[0]).toMatch(/characters .*omitted/);
    expect(heuristicTokenCount(kept.join(''))).toBeLessThan(600);
  });

  it('keeps none when the budget is 0', () => {
    expect(selectRecentUserMessages(['a'], [goal('b')], 0)).toEqual([]);
  });
});

describe('compaction request that overflows the summarizer', () => {
  const pressure = { usedTokens: 1, windowTokens: 1, ratio: 1 };
  const overflow = { error: { kind: 'context_length' as const, message: 'maximum context length exceeded', retryable: false } };

  it('drops the oldest turns and retries, and says so', async () => {
    const notes: string[] = [];
    const provider = new ScriptedProvider([overflow, { text: 'digest' }]);
    const onCompact = createCompactor({
      provider, model: 'm', conventions: 'c', minCompactTokens: 0, onSkip: (r) => notes.push(r),
    });
    const result = await onCompact(history(12), pressure, ctx);
    expect(result).toBeDefined();
    expect(provider.callCount).toBe(2);
    const [first, second] = provider.requests;
    expect(second!.messages[0]!.content[0]).toMatchObject({ type: 'text' });
    // Cold path: the flattened span shrank.
    const len = (r: typeof first) => JSON.stringify(r!.messages).length;
    expect(len(second)).toBeLessThan(len(first));
    expect(notes.join('\n')).toMatch(/oldest 3 turn\(s\) did not fit/);
  });

  it('gives up at once on an error that is not an overflow', async () => {
    const provider = new ScriptedProvider([{ error: { kind: 'server', message: 'boom', retryable: false } }]);
    const onCompact = createCompactor({ provider, model: 'm', conventions: 'c', minCompactTokens: 0 });
    expect(await onCompact(history(12), pressure, ctx)).toBeUndefined();
    expect(provider.callCount).toBe(1);
  });

  it('stops retrying after a bounded number of attempts', async () => {
    const provider = new ScriptedProvider([overflow, overflow, overflow, overflow, overflow, overflow]);
    const onCompact = createCompactor({ provider, model: 'm', conventions: 'c', minCompactTokens: 0 });
    expect(await onCompact(history(40), pressure, ctx)).toBeUndefined();
    expect(provider.callCount).toBe(5);
  });
});

