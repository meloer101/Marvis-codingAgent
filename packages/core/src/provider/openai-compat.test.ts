import { describe, expect, it, vi } from 'vitest';

import { jsonFetch, sseFetch, sseFrames } from './mock.js';
import {
  OpenAICompatProvider,
  heuristicTokenCount,
  normalizeStopReason,
  toOpenAIMessages,
} from './openai-compat.js';
import { DEFAULT_CAPABILITIES } from './capabilities.js';
import { ProviderError, drainStream } from './types.js';
import type { Message, ModelRequest, StreamEvent } from './types.js';

function provider(fetchImpl: typeof fetch, overrides = {}) {
  return new OpenAICompatProvider({
    id: 'test',
    baseUrl: 'https://example.test/v1',
    apiKey: 'sk-test-key',
    fetchImpl,
    maxRetries: 0,
    capabilityOverrides: { '*': overrides },
  });
}

const ask: ModelRequest = {
  model: 'test-model',
  system: [{ id: 'identity', text: 'You are a coding agent.' }],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
};

function delta(d: unknown, finish?: string) {
  return { choices: [{ index: 0, delta: d, finish_reason: finish ?? null }] };
}

describe('OpenAICompatProvider streaming', () => {
  it('streams text and reports usage', async () => {
    const p = provider(
      sseFetch(
        sseFrames([
          delta({ role: 'assistant', content: '' }),
          delta({ content: 'Hello' }),
          delta({ content: ' world' }),
          delta({}, 'stop'),
          { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } },
        ]),
      ),
    );

    const events: StreamEvent[] = [];
    for await (const ev of p.stream(ask)) events.push(ev);

    const texts = events.filter((e) => e.type === 'text_delta').map((e) => e.text);
    expect(texts).toEqual(['Hello', ' world']);

    const end = events.at(-1);
    expect(end?.type).toBe('message_end');
    if (end?.type !== 'message_end') throw new Error('unreachable');
    expect(end.response.content).toEqual([{ type: 'text', text: 'Hello world' }]);
    expect(end.response.stopReason).toBe('end_turn');
    expect(end.response.usage).toMatchObject({ inputTokens: 12, outputTokens: 3 });
    expect(end.response.usage.estimated).toBeUndefined();
  });

  it('maps a reasoning channel onto thinking blocks', async () => {
    const p = provider(
      sseFetch(
        sseFrames([
          delta({ reasoning_content: 'Let me think. ' }),
          delta({ reasoning_content: 'Done.' }),
          delta({ content: 'Answer' }),
          delta({}, 'stop'),
        ]),
      ),
    );

    const res = await drainStream(p.stream(ask));
    expect(res.content).toEqual([
      { type: 'thinking', text: 'Let me think. Done.' },
      { type: 'text', text: 'Answer' },
    ]);
  });

  it('treats a returned tool call as tool_use even when finish_reason says stop', async () => {
    // Several endpoints report `stop` alongside tool calls. Believing the field
    // over the payload would end the turn with the tool never run.
    const p = provider(
      sseFetch(
        sseFrames([
          delta({
            tool_calls: [
              { index: 0, id: 'c1', function: { name: 'read', arguments: '{"path":"a.ts"}' } },
            ],
          }),
          delta({}, 'stop'),
        ]),
      ),
    );

    const res = await drainStream(p.stream(ask));
    expect(res.stopReason).toBe('tool_use');
    expect(res.content).toEqual([
      expect.objectContaining({ type: 'tool_use', name: 'read', input: { path: 'a.ts' } }),
    ]);
  });

  it('accepts content delivered as a parts array', async () => {
    const p = provider(
      sseFetch(sseFrames([delta({ content: [{ type: 'text', text: 'part' }] }), delta({}, 'stop')])),
    );
    const res = await drainStream(p.stream(ask));
    expect(res.content).toEqual([{ type: 'text', text: 'part' }]);
  });

  it('reads cached-token counts under each of the field names in use', async () => {
    for (const [usage, expected] of [
      [{ prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 60 } }, 60],
      [{ prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 40 }, 40],
      [{ prompt_tokens: 100, completion_tokens: 5, cache_read_input_tokens: 25 }, 25],
    ] as const) {
      const p = provider(sseFetch(sseFrames([delta({ content: 'x' }, 'stop'), { choices: [], usage }])));
      const res = await drainStream(p.stream(ask));
      expect(res.usage.cachedInputTokens).toBe(expected);
    }
  });

  it('estimates usage when the endpoint reports none', async () => {
    const p = provider(sseFetch(sseFrames([delta({ content: 'hello there' }, 'stop')])));
    const res = await drainStream(p.stream(ask));
    expect(res.usage.estimated).toBe(true);
    expect(res.usage.outputTokens).toBeGreaterThan(0);
    expect(res.usage.inputTokens).toBeGreaterThan(0);
  });

  it('ignores a malformed SSE frame instead of failing the turn', async () => {
    const p = provider(
      sseFetch([
        'data: {"choices":[{"delta":{"content":"a"}}]}\n\n',
        'data: {not json\n\n',
        'data: {"choices":[{"delta":{"content":"b"},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    const res = await drainStream(p.stream(ask));
    expect(res.content).toEqual([{ type: 'text', text: 'ab' }]);
  });

  it('raises an error delivered inside a 200 stream', async () => {
    const p = provider(
      sseFetch(sseFrames([{ error: { message: 'upstream is overloaded', type: 'server_error' } }])),
    );
    await expect(drainStream(p.stream(ask))).rejects.toThrow(/overloaded/);
  });

  it('fails loudly on a stream that carries no completion chunks', async () => {
    const p = provider(sseFetch(['data: [DONE]\n\n']));
    await expect(drainStream(p.stream(ask))).rejects.toMatchObject({ kind: 'protocol' });
  });

  it('sends stream_options only where the endpoint understands it', async () => {
    const seen: unknown[] = [];
    const spy: typeof fetch = (async (_url: string, init: RequestInit) => {
      seen.push(JSON.parse(String(init.body)));
      return sseFetch(sseFrames([delta({ content: 'x' }, 'stop')]))('', {});
    }) as unknown as typeof fetch;

    await drainStream(provider(spy).stream(ask));
    expect(seen[0]).toMatchObject({ stream_options: { include_usage: true } });

    await drainStream(provider(spy, { streamUsage: false }).stream(ask));
    expect(seen[1]).not.toHaveProperty('stream_options');
  });
});

describe('OpenAICompatProvider fallbacks', () => {
  it('falls back to prompt-encoded tool calling when tools are unsupported', async () => {
    const bodies: Record<string, unknown>[] = [];
    const spy: typeof fetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return sseFetch(
        sseFrames([
          delta({ content: 'Looking.\n<tool_call>{"name":"read","arguments":{"path":"a.ts"}}</tool_call>' }),
          delta({}, 'stop'),
        ]),
      )('', {});
    }) as unknown as typeof fetch;

    const p = provider(spy, { nativeTools: false });
    const res = await drainStream(
      p.stream({
        ...ask,
        tools: [{ name: 'read', description: 'Read a file', inputSchema: { type: 'object' } }],
      }),
    );

    // The tools go into the prompt, not the `tools` parameter.
    expect(bodies[0]).not.toHaveProperty('tools');
    expect(JSON.stringify(bodies[0]?.['messages'])).toContain('<tool_call>');

    expect(res.stopReason).toBe('tool_use');
    expect(res.content).toEqual([
      { type: 'text', text: 'Looking.\n' },
      expect.objectContaining({ name: 'read', input: { path: 'a.ts' } }),
    ]);
  });

  it('synthesizes a stream for endpoints that cannot stream', async () => {
    const p = provider(
      jsonFetch({
        model: 'test-model',
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: 'ok',
              tool_calls: [{ id: 'c1', function: { name: 'read', arguments: '{"path":"a"}' } }],
            },
          },
        ],
        usage: { prompt_tokens: 9, completion_tokens: 2 },
      }),
      { streaming: false },
    );

    const events: StreamEvent[] = [];
    for await (const ev of p.stream(ask)) events.push(ev);

    expect(events.map((e) => e.type)).toEqual([
      'message_start',
      'text_delta',
      'tool_use_start',
      'tool_use_delta',
      'tool_use_end',
      'message_end',
    ]);
  });
});

describe('OpenAICompatProvider errors', () => {
  const cases: Array<[number, string, string]> = [
    [401, '{"error":{"message":"invalid api key"}}', 'auth'],
    [404, '{"error":{"message":"model not found"}}', 'not_found'],
    [402, '{"error":{"message":"Insufficient Balance"}}', 'quota'],
    [429, '{"error":{"message":"slow down"}}', 'rate_limit'],
    [500, '{"error":{"message":"boom"}}', 'server'],
    [400, '{"error":{"message":"maximum context length exceeded"}}', 'context_length'],
    [400, '{"error":{"message":"unknown parameter"}}', 'bad_request'],
  ];

  for (const [status, body, kind] of cases) {
    it(`maps HTTP ${status} to ${kind}`, async () => {
      const p = provider(jsonFetch(JSON.parse(body), status));
      const err = await drainStream(p.stream(ask)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).kind).toBe(kind);
    });
  }

  it('does not retry a spent account', async () => {
    let calls = 0;
    const counting: typeof fetch = (async (u: string, init: RequestInit) => {
      calls++;
      return jsonFetch({ error: { message: 'Insufficient Balance' } }, 402)(u, init);
    }) as unknown as typeof fetch;
    const p = new OpenAICompatProvider({
      id: 'test',
      baseUrl: 'https://example.test/v1',
      fetchImpl: counting,
      maxRetries: 3,
    });
    const err = (await drainStream(p.stream(ask)).catch((e: unknown) => e)) as ProviderError;
    expect(err.retryable).toBe(false);
    expect(calls).toBe(1);
  });

  it('raises a load-shedding finish reason instead of ending the turn', async () => {
    const p = provider(
      sseFetch(sseFrames([delta({ content: 'partial' }), delta({}, 'insufficient_system_resource')])),
    );
    const err = (await drainStream(p.stream(ask)).catch((e: unknown) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.retryable).toBe(true);
    expect(err.message).toMatch(/insufficient_system_resource/);
  });

  it('retries an empty completion rather than reporting an empty turn', async () => {
    const p = provider(sseFetch(sseFrames([delta({ role: 'assistant', content: '' }, 'stop')])));
    const err = (await drainStream(p.stream(ask)).catch((e: unknown) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toBe('protocol');
    expect(err.retryable).toBe(true);
  });

  it('re-sends with an empty reasoning field when the endpoint demands one', async () => {
    const bodies: Record<string, unknown>[] = [];
    const spy: typeof fetch = (async (u: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      if (bodies.length === 1) {
        return jsonFetch(
          {
            error: {
              message:
                'The reasoning_content in the thinking mode must be passed back to the API.',
            },
          },
          400,
        )(u, init);
      }
      return sseFetch(sseFrames([delta({ content: 'ok' }, 'stop')]))(u, init);
    }) as unknown as typeof fetch;

    const p = provider(spy, { reasoning: true, reasoningReplay: 'text' });
    const res = await drainStream(
      p.stream({
        ...ask,
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hi' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'no thinking here' }] },
          { role: 'user', content: [{ type: 'text', text: 'again' }] },
        ],
      }),
    );

    expect(res.stopReason).toBe('end_turn');
    const first = bodies[0]?.['messages'] as Array<Record<string, unknown>>;
    const second = bodies[1]?.['messages'] as Array<Record<string, unknown>>;
    // [0] system, [1] user, [2] the assistant turn with no thinking of its own.
    expect(first[2]).not.toHaveProperty('reasoning_content');
    expect(second[2]).toHaveProperty('reasoning_content', '');
  });

  it('keeps credentials out of error details', async () => {
    const p = provider(
      jsonFetch({ error: { message: 'bad', received: 'sk-abcdefghijklmnop' } }, 400),
    );
    const err = (await drainStream(p.stream(ask)).catch((e: unknown) => e)) as ProviderError;
    expect(err.detail).not.toContain('abcdefghijklmnop');
    expect(err.detail).toContain('sk-***');
  });

  it('retries a rate limit and then succeeds', async () => {
    let calls = 0;
    const flaky: typeof fetch = (async () => {
      calls++;
      if (calls === 1) {
        return new Response('{"error":{"message":"slow down"}}', {
          status: 429,
          headers: { 'retry-after': '0' },
        });
      }
      return sseFetch(sseFrames([delta({ content: 'ok' }, 'stop')]))('', {});
    }) as unknown as typeof fetch;

    const p = new OpenAICompatProvider({
      id: 'test',
      baseUrl: 'https://example.test/v1',
      fetchImpl: flaky,
      maxRetries: 2,
    });

    const res = await drainStream(p.stream(ask));
    expect(calls).toBe(2);
    expect(res.content).toEqual([{ type: 'text', text: 'ok' }]);
  });

  it('attaches Retry-After to a rate_limit error when retries are exhausted', async () => {
    const fetchImpl: typeof fetch = (async () =>
      new Response('{"error":{"message":"slow down"}}', {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '2' },
      })) as unknown as typeof fetch;
    const p = provider(fetchImpl);
    const err = (await drainStream(p.stream(ask)).catch((e: unknown) => e)) as ProviderError;
    expect(err.kind).toBe('rate_limit');
    expect(err.retryAfterMs).toBe(2000);
  });

  it('marks a 400 whose message says overloaded as retryable', async () => {
    const p = provider(jsonFetch({ error: { message: 'The engine is overloaded, try again later' } }, 400));
    const err = (await drainStream(p.stream(ask)).catch((e: unknown) => e)) as ProviderError;
    expect(err.kind).toBe('bad_request');
    expect(err.retryable).toBe(true);
  });

  it('propagates an abort without retrying', async () => {
    const controller = new AbortController();
    const hang: typeof fetch = (async (_u: string, init: RequestInit) => {
      controller.abort();
      throw Object.assign(new Error('aborted'), { name: 'AbortError', cause: init.signal });
    }) as unknown as typeof fetch;

    const p = new OpenAICompatProvider({
      id: 'test',
      baseUrl: 'https://example.test/v1',
      fetchImpl: hang,
      maxRetries: 3,
    });

    const err = (await drainStream(p.stream({ ...ask, signal: controller.signal })).catch(
      (e: unknown) => e,
    )) as ProviderError;
    expect(err.kind).toBe('aborted');
  });
});

describe('message translation', () => {
  it('emits tool results before any new user text', async () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'read a.ts' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', text: 'internal' },
          { type: 'text', text: 'sure' },
          { type: 'tool_use', id: 'c1', name: 'read', input: { path: 'a.ts' }, rawInput: '{"path":"a.ts"}' },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolUseId: 'c1', content: 'file body' },
          { type: 'text', text: 'now summarize' },
        ],
      },
    ];

    const out = toOpenAIMessages([{ id: 's', text: 'sys' }], messages, DEFAULT_CAPABILITIES);

    expect(out.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user']);
    expect(out[2]?.tool_calls?.[0]).toMatchObject({
      id: 'c1',
      function: { name: 'read', arguments: '{"path":"a.ts"}' },
    });
    // Thinking is display-only unless the model asks for it back.
    expect(JSON.stringify(out)).not.toContain('internal');
  });

  it('replays reasoning where the endpoint requires it back', () => {
    const caps = { ...DEFAULT_CAPABILITIES, reasoning: true, reasoningReplay: 'text' as const };
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', text: 'internal' },
          { type: 'tool_use', id: 'c1', name: 'read', input: {} },
        ],
      },
    ];

    const out = toOpenAIMessages(undefined, messages, caps);

    expect(out[1]?.reasoning_content).toBe('internal');
    // Tool-only turns carry `""`, never null — DeepSeek 400s on a null content.
    expect(out[1]?.content).toBe('');
  });

  it('keeps a reasoning-only turn instead of dropping it', () => {
    const caps = { ...DEFAULT_CAPABILITIES, reasoning: true, reasoningReplay: 'text' as const };
    const messages: Message[] = [
      { role: 'assistant', content: [{ type: 'thinking', text: 'just thought' }] },
    ];

    expect(toOpenAIMessages(undefined, messages, caps)).toEqual([
      { role: 'assistant', content: '', reasoning_content: 'just thought' },
    ]);
    // Without replay the turn has nothing to say on the wire and is skipped.
    expect(toOpenAIMessages(undefined, messages, DEFAULT_CAPABILITIES)).toEqual([]);
  });

  it('can fill in an empty reasoning field for turns that never had one', () => {
    const caps = { ...DEFAULT_CAPABILITIES, reasoning: true, reasoningReplay: 'text' as const };
    const messages: Message[] = [
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ];

    expect(toOpenAIMessages(undefined, messages, caps)[0]?.reasoning_content).toBeUndefined();
    expect(
      toOpenAIMessages(undefined, messages, caps, { emptyReasoningFallback: true })[0]
        ?.reasoning_content,
    ).toBe('');
  });

  it('substitutes a placeholder for empty tool output', () => {
    const out = toOpenAIMessages(
      undefined,
      [{ role: 'user', content: [{ type: 'tool_result', toolUseId: 'c1', content: '' }] }],
      DEFAULT_CAPABILITIES,
    );
    expect(out[0]?.content).toBe('(no output)');
  });

  it('delivers a system update late in the history, leaving the head alone', () => {
    const caps = {
      ...DEFAULT_CAPABILITIES,
      systemPromptUpdate: 'in-history' as const,
    };
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'first' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      { role: 'user', content: [{ type: 'text', text: 'second' }] },
    ];

    const out = toOpenAIMessages([{ id: 's', text: 'head' }], messages, caps, {
      systemUpdate: [{ id: 's', text: 'revised' }],
    });

    // Head untouched (that is the cached prefix), update just before the last turn.
    expect(out.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'system', 'user']);
    expect(out[0]?.content).toBe('head');
    expect(out[3]?.content).toBe('revised');
    expect(out[4]?.content).toBe('second');
  });

  it('never splits tool calls from their results when placing an update', () => {
    const caps = { ...DEFAULT_CAPABILITIES, systemPromptUpdate: 'in-history' as const };
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'c1', name: 'read', input: {} }],
      },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'c1', content: 'body' }] },
    ];

    const out = toOpenAIMessages(undefined, messages, caps, {
      systemUpdate: [{ id: 's', text: 'revised' }],
    });

    // A system message between the assistant and its tool reply is a 400.
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'system']);
  });

  it('still delivers a system update when there is no history yet', () => {
    const caps = { ...DEFAULT_CAPABILITIES, systemPromptUpdate: 'in-history' as const };
    const out = toOpenAIMessages([{ id: 's', text: 'head' }], [], caps, {
      systemUpdate: [{ id: 's', text: 'revised' }],
    });
    expect(out.map((m) => m.content)).toEqual(['head', 'revised']);
  });

  it('uses the developer role where the model requires it', () => {
    const out = toOpenAIMessages([{ id: 's', text: 'sys' }], [], {
      ...DEFAULT_CAPABILITIES,
      developerRole: true,
    });
    expect(out[0]?.role).toBe('developer');
  });
});

describe('normalizeStopReason', () => {
  it('normalizes the variants endpoints actually send', () => {
    expect(normalizeStopReason('tool_calls', true)).toBe('tool_use');
    expect(normalizeStopReason('function_call', true)).toBe('tool_use');
    expect(normalizeStopReason('length', false)).toBe('max_tokens');
    expect(normalizeStopReason('content_filter', false)).toBe('content_filter');
    expect(normalizeStopReason('stop', false)).toBe('end_turn');
    expect(normalizeStopReason(undefined, false)).toBe('end_turn');
    expect(normalizeStopReason(null, true)).toBe('tool_use');
  });
});

describe('heuristicTokenCount', () => {
  it('weights CJK more densely than ASCII', () => {
    const ascii = heuristicTokenCount('a'.repeat(100));
    const cjk = heuristicTokenCount('中'.repeat(100));
    expect(cjk).toBeGreaterThan(ascii);
    expect(heuristicTokenCount('')).toBe(0);
  });
});

describe('request shaping', () => {
  it('renames max tokens for models that demand the newer field', async () => {
    const bodies: Record<string, unknown>[] = [];
    const spy: typeof fetch = (async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return sseFetch(sseFrames([delta({ content: 'x' }, 'stop')]))('', {});
    }) as unknown as typeof fetch;

    await drainStream(provider(spy).stream({ ...ask, maxOutputTokens: 100 }));
    expect(bodies[0]).toHaveProperty('max_tokens', 100);

    await drainStream(
      provider(spy, { developerRole: true }).stream({ ...ask, maxOutputTokens: 100 }),
    );
    expect(bodies[1]).toHaveProperty('max_completion_tokens', 100);
  });

  it('omits temperature for models that reject it', async () => {
    const bodies: Record<string, unknown>[] = [];
    const spy: typeof fetch = (async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return sseFetch(sseFrames([delta({ content: 'x' }, 'stop')]))('', {});
    }) as unknown as typeof fetch;

    await drainStream(provider(spy, { fixedTemperature: true }).stream({ ...ask, temperature: 0.7 }));
    expect(bodies[0]).not.toHaveProperty('temperature');
  });

  it('caps requested output tokens at the model ceiling', async () => {
    const bodies: Record<string, unknown>[] = [];
    const spy: typeof fetch = (async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return sseFetch(sseFrames([delta({ content: 'x' }, 'stop')]))('', {});
    }) as unknown as typeof fetch;

    await drainStream(provider(spy, { maxOutputTokens: 4096 }).stream({ ...ask, maxOutputTokens: 999_999 }));
    expect(bodies[0]).toHaveProperty('max_tokens', 4096);
  });

  it('maps reasoning effort onto the levels the model accepts', async () => {
    const bodies: Record<string, unknown>[] = [];
    const spy: typeof fetch = (async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return sseFetch(sseFrames([delta({ content: 'x' }, 'stop')]))('', {});
    }) as unknown as typeof fetch;

    const deepseekish = {
      reasoning: true,
      effortLevels: ['low', 'high', 'max'] as const,
      thinkingParam: true,
    };
    await drainStream(provider(spy, deepseekish).stream({ ...ask, reasoningEffort: 'medium' }));
    expect(bodies[0]).toMatchObject({
      reasoning_effort: 'high',
      thinking: { type: 'enabled' },
    });

    // `off` is not a level: the switch says disabled and no effort goes out.
    await drainStream(provider(spy, deepseekish).stream({ ...ask, reasoningEffort: 'off' }));
    expect(bodies[1]).toMatchObject({ thinking: { type: 'disabled' } });
    expect(bodies[1]).not.toHaveProperty('reasoning_effort');

    // Endpoints without the switch get the effort alone...
    await drainStream(
      provider(spy, { reasoning: true }).stream({ ...ask, reasoningEffort: 'medium' }),
    );
    expect(bodies[2]).toHaveProperty('reasoning_effort', 'medium');
    expect(bodies[2]).not.toHaveProperty('thinking');

    // ...and a model with no reasoning channel gets neither.
    await drainStream(provider(spy).stream({ ...ask, reasoningEffort: 'high' }));
    expect(bodies[3]).not.toHaveProperty('reasoning_effort');
  });

  it('sends a system update only to models that take updates in history', async () => {
    const bodies: Record<string, unknown>[] = [];
    const spy: typeof fetch = (async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return sseFetch(sseFrames([delta({ content: 'x' }, 'stop')]))('', {});
    }) as unknown as typeof fetch;

    const req = { ...ask, systemUpdate: [{ id: 'identity', text: 'revised prompt' }] };

    await drainStream(provider(spy, { systemPromptUpdate: 'in-history' }).stream(req));
    const withUpdate = bodies[0]?.['messages'] as Array<Record<string, unknown>>;
    expect(withUpdate.filter((m) => m['role'] === 'system')).toHaveLength(2);

    // A `rewrite` model must not see it: the caller puts new text in `system`.
    await drainStream(provider(spy).stream(req));
    const without = bodies[1]?.['messages'] as Array<Record<string, unknown>>;
    expect(without.filter((m) => m['role'] === 'system')).toHaveLength(1);
    expect(JSON.stringify(without)).not.toContain('revised prompt');
  });

  it('sends the authorization header', async () => {
    const headers: Array<Record<string, string>> = [];
    const spy: typeof fetch = (async (_u: string, init: RequestInit) => {
      headers.push(init.headers as Record<string, string>);
      return sseFetch(sseFrames([delta({ content: 'x' }, 'stop')]))('', {});
    }) as unknown as typeof fetch;

    await drainStream(provider(spy).stream(ask));
    expect(headers[0]?.['authorization']).toBe('Bearer sk-test-key');
  });
});

describe('OpenAICompatProvider timeouts', () => {
  /** A fetch whose response streams one frame then hangs forever. */
  function hangingStreamFetch(): typeof fetch {
    return (async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(`data: ${JSON.stringify(delta({ content: 'partial' }))}\n\n`),
          );
          // never close, never enqueue again
        },
      });
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }) as unknown as typeof fetch;
  }

  /** A fetch whose body `.json()` never resolves. */
  function hangingJsonFetch(): typeof fetch {
    return (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start() {
            /* headers sent; body never arrives */
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch;
  }

  async function withNoUnhandledRejection<T>(fn: () => Promise<T>): Promise<T> {
    const seen: unknown[] = [];
    const onRej = (r: unknown) => seen.push(r);
    process.on('unhandledRejection', onRej);
    try {
      const out = await fn();
      // let any stray microtask/timer settle
      await new Promise((r) => setTimeout(r, 20));
      expect(seen).toEqual([]);
      return out;
    } finally {
      process.off('unhandledRejection', onRej);
    }
  }

  it('maps a mid-stream timeout to a retryable ProviderError', async () => {
    const p = provider(hangingStreamFetch(), {});
    (p as unknown as { cfg: { idleTimeoutMs: number } }).cfg.idleTimeoutMs = 30;

    const err = await withNoUnhandledRejection(() =>
      drainStream(p.stream(ask)).catch((e: unknown) => e),
    );
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe('network');
    expect((err as ProviderError).retryable).toBe(true);
  });

  it('maps a non-streaming body timeout to a retryable ProviderError', async () => {
    const p = provider(hangingJsonFetch(), { streaming: false });
    (p as unknown as { cfg: { idleTimeoutMs: number } }).cfg.idleTimeoutMs = 30;

    const err = await withNoUnhandledRejection(() =>
      drainStream(p.stream(ask)).catch((e: unknown) => e),
    );
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe('network');
    expect((err as ProviderError).retryable).toBe(true);
  });

  it('keeps a slow stream alive while keep-alive comments arrive', async () => {
    // A comment line carries no data, so only the idle deadline's refresh
    // distinguishes "the model is thinking" from "the connection is dead".
    const keepAliveThenAnswer: typeof fetch = (async () => {
      const enc = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (let i = 0; i < 4; i++) {
            controller.enqueue(enc.encode(': keep-alive\n\n'));
            await new Promise((r) => setTimeout(r, 20));
          }
          controller.enqueue(enc.encode(`data: ${JSON.stringify(delta({ content: 'hi' }, 'stop'))}\n\n`));
          controller.enqueue(enc.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch;

    const p = provider(keepAliveThenAnswer, {});
    // Shorter than the whole stream (4 × 20ms), longer than any one gap.
    (p as unknown as { cfg: { idleTimeoutMs: number } }).cfg.idleTimeoutMs = 50;

    const res = await drainStream(p.stream(ask));
    expect(res.content).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('lets an external abort win over the deadline', async () => {
    const controller = new AbortController();
    const p = provider(hangingStreamFetch(), {});
    (p as unknown as { cfg: { idleTimeoutMs: number } }).cfg.idleTimeoutMs = 10_000;
    setTimeout(() => controller.abort(), 15);

    const err = (await drainStream(p.stream({ ...ask, signal: controller.signal })).catch(
      (e: unknown) => e,
    )) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toBe('aborted');
    expect(err.retryable).toBe(false);
  });

  it('leaves no timer armed after a normal fast stream', async () => {
    vi.useFakeTimers();
    try {
      const p = provider(sseFetch(sseFrames([delta({ content: 'hi' }, 'stop')])));
      await drainStream(p.stream(ask));
      // The request deadline must have been cleared; nothing should be pending.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('OpenAICompatProvider tool_choice', () => {
  it('maps allowed_tools onto the OpenAI Chat Completions shape', async () => {
    const bodies: Record<string, unknown>[] = [];
    const spy: typeof fetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return sseFetch(sseFrames([delta({ content: 'ok' }, 'stop')]))('', {});
    }) as unknown as typeof fetch;

    const p = provider(spy);
    await drainStream(
      p.stream({
        ...ask,
        tools: [{ name: 'read', description: 'Read a file', inputSchema: { type: 'object' } }],
        toolChoice: { type: 'allowed_tools', mode: 'auto', names: ['read', 'grep'] },
      }),
    );

    expect(bodies[0]?.['tool_choice']).toEqual({
      type: 'allowed_tools',
      mode: 'auto',
      tools: [
        { type: 'function', function: { name: 'read' } },
        { type: 'function', function: { name: 'grep' } },
      ],
    });
    expect(bodies[0]?.['tools']).toEqual([
      {
        type: 'function',
        function: { name: 'read', description: 'Read a file', parameters: { type: 'object' } },
      },
    ]);
  });

  it('still maps a forced single tool by name', async () => {
    const bodies: Record<string, unknown>[] = [];
    const spy: typeof fetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return sseFetch(sseFrames([delta({ content: 'ok' }, 'stop')]))('', {});
    }) as unknown as typeof fetch;

    await drainStream(
      provider(spy).stream({
        ...ask,
        tools: [{ name: 'read', description: 'Read a file', inputSchema: { type: 'object' } }],
        toolChoice: { name: 'read' },
      }),
    );

    expect(bodies[0]?.['tool_choice']).toEqual({
      type: 'function',
      function: { name: 'read' },
    });
  });
});

describe('vitest sanity', () => {
  it('has fake timers available for later phases', () => {
    expect(vi).toBeDefined();
  });
});
