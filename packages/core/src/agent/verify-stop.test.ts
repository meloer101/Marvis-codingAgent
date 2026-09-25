import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { DEFAULT_CAPABILITIES } from '../provider/capabilities.js';
import { ScriptedProvider } from '../provider/mock.js';
import { userText } from '../provider/types.js';
import type { Message } from '../provider/types.js';
import { ToolRegistry } from '../tools/registry.js';
import type { ToolSpec } from '../tools/types.js';
import { AgentLoop } from './loop.js';
import { VERIFY_STOP_MARKER, createVerifyBeforeStopHooks } from './verify-stop.js';

const gate = createVerifyBeforeStopHooks();
const ctx = (messages: Message[]) => ({ turn: 1, cwd: '/tmp', messages });
const final: Message = { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] };
const call = (name: string, id = 'c1'): Message[] => [
  { role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] },
  { role: 'user', content: [{ type: 'tool_result', toolUseId: id, content: 'ok' }] },
];

describe('verify-before-stop gate', () => {
  it('sends a run that changed something back once, pointing at the task', async () => {
    const d = await gate.onBeforeStop!(final, ctx([userText('make x'), ...call('write'), final]));
    expect(d?.continue?.startsWith(VERIFY_STOP_MARKER)).toBe(true);
    expect(d?.continue).toMatch(/as the user stated it/);
  });

  it('leaves a run that only read or answered alone', async () => {
    expect(await gate.onBeforeStop!(final, ctx([userText('what is x?'), final]))).toBeUndefined();
    expect(
      await gate.onBeforeStop!(final, ctx([userText('explain x'), ...call('read'), ...call('grep', 'c2'), final])),
    ).toBeUndefined();
  });

  it('does not gate the same task twice', async () => {
    const first = await gate.onBeforeStop!(final, ctx([userText('make x'), ...call('bash'), final]));
    const history = [
      userText('make x'),
      ...call('bash'),
      final,
      userText(first!.continue!),
      ...call('bash', 'c2'),
      final,
    ];
    expect(await gate.onBeforeStop!(final, ctx(history))).toBeUndefined();
  });

  it('gates the next task of the same session again', async () => {
    const history = [
      userText('make x'),
      ...call('edit'),
      final,
      userText(`${VERIFY_STOP_MARKER} …`),
      final,
      userText('now make y'),
      ...call('write', 'c3'),
      final,
    ];
    expect((await gate.onBeforeStop!(final, ctx(history)))?.continue).toBeDefined();
  });
});

describe('verify-before-stop in the loop', () => {
  const writeTool: ToolSpec<unknown> = {
    name: 'write',
    description: 'test',
    schema: z.object({}),
    readOnly: false,
    concurrencySafe: false,
    async execute() {
      return { content: 'wrote' };
    },
  };

  it('costs exactly one extra model call, and the check lands in history', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: 'write', input: {} }] },
      { text: 'Done.' },
      { text: 'Checked: the file exists and matches the requested format.' },
    ]);
    const loop = new AgentLoop({
      model: {
        provider,
        providerId: provider.id,
        model: 'm',
        ref: `${provider.id}/m`,
        capabilities: DEFAULT_CAPABILITIES,
      },
      tools: new ToolRegistry([writeTool]),
      cwd: '/tmp',
      hooks: createVerifyBeforeStopHooks(),
    });

    const result = await loop.run([userText('write the file')]);

    expect(result.stopReason).toBe('end_turn');
    expect(provider.callCount).toBe(3);
    const prompts = result.messages.filter(
      (m) => m.role === 'user' && m.content.some((b) => b.type === 'text' && b.text.startsWith(VERIFY_STOP_MARKER)),
    );
    expect(prompts).toHaveLength(1);
    expect(result.messages.at(-1)?.content[0]).toMatchObject({ type: 'text', text: expect.stringMatching(/^Checked/) });
  });
});
