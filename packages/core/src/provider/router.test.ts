import { describe, expect, it } from 'vitest';

import { BUILTIN_PROVIDERS, ProviderRegistry, modelEffort, parseModelRef, providerKeyVars } from './router.js';
import {
  DEFAULT_REASONING_EFFORTS,
  effortOptions,
  estimateCostUSD,
  mapEffort,
  resolveCapabilities,
} from './capabilities.js';
import { ProviderError } from './types.js';

describe('parseModelRef', () => {
  it('splits provider from model', () => {
    expect(parseModelRef('deepseek/deepseek-chat')).toEqual({
      provider: 'deepseek',
      model: 'deepseek-chat',
    });
  });

  it('splits on the first slash so aggregator ids survive', () => {
    expect(parseModelRef('openrouter/anthropic/claude-sonnet-4')).toEqual({
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4',
    });
  });

  it('keeps tags that contain a colon', () => {
    expect(parseModelRef('ollama/qwen2.5-coder:7b')).toEqual({
      provider: 'ollama',
      model: 'qwen2.5-coder:7b',
    });
  });

  it('falls back to the default provider when none is given', () => {
    expect(parseModelRef('gpt-4o', 'openai')).toEqual({ provider: 'openai', model: 'gpt-4o' });
  });

  it('rejects empty and truncated references', () => {
    expect(() => parseModelRef('')).toThrow(ProviderError);
    expect(() => parseModelRef('deepseek/')).toThrow(/no model/);
  });
});

describe('ProviderRegistry', () => {
  it('resolves a built-in provider using its documented env var', () => {
    const reg = new ProviderRegistry({ env: { DEEPSEEK_API_KEY: 'sk-x' } });
    const resolved = reg.resolve('deepseek/deepseek-v4-flash');

    expect(resolved.providerId).toBe('deepseek');
    expect(resolved.model).toBe('deepseek-v4-flash');
    expect(resolved.capabilities.promptCache).toBe('implicit');
  });

  it("says where a provider's key comes from, never the key", () => {
    const settings = { providers: { openai: { apiKey: 'sk-literal' } } };
    const reg = new ProviderRegistry({ settings, env: { KIMI_API_KEY: 'sk-kimi', HC_GROQ_API_KEY: 'gsk' } });
    expect(reg.keyOrigin('openai')).toEqual({ settings: true });
    expect(reg.keyOrigin('moonshot')).toEqual({ variable: 'KIMI_API_KEY' }); // its second name
    expect(reg.keyOrigin('groq')).toEqual({ variable: 'HC_GROQ_API_KEY' }); // the one every provider has
    expect(reg.keyOrigin('deepseek')).toBeUndefined();
    expect(JSON.stringify(['openai', 'moonshot', 'groq'].map((id) => reg.keyOrigin(id)))).not.toMatch(/sk-|gsk/);
    expect(providerKeyVars('deepseek', BUILTIN_PROVIDERS['deepseek']!)).toEqual(['HC_DEEPSEEK_API_KEY', 'DEEPSEEK_API_KEY']);
  });

  it('needs no credentials for a local runtime', () => {
    const reg = new ProviderRegistry({ env: {} });
    expect(() => reg.resolve('ollama/qwen2.5-coder:7b')).not.toThrow();
  });

  it('explains what to set when a key is missing', () => {
    const reg = new ProviderRegistry({ env: {} });
    const err = (() => {
      try {
        reg.resolve('deepseek/deepseek-chat');
        return undefined;
      } catch (e) {
        return e as ProviderError;
      }
    })();

    expect(err?.kind).toBe('auth');
    expect(err?.message).toContain('DEEPSEEK_API_KEY');
  });

  it('lets the environment override a base URL without touching settings', () => {
    const reg = new ProviderRegistry({
      env: { HC_OLLAMA_BASE_URL: 'http://gpu-box:11434/v1' },
    });
    expect(reg.config('ollama').baseUrl).toBe('http://gpu-box:11434/v1');
  });

  it('accepts a user-defined provider that is not built in', () => {
    const reg = new ProviderRegistry({
      env: {},
      settings: {
        providers: {
          'my-proxy': { label: 'Internal proxy', baseUrl: 'http://proxy.internal/v1' },
        },
      },
    });

    expect(reg.resolve('my-proxy/whatever').providerId).toBe('my-proxy');
    expect(reg.list()).toContain('my-proxy');
  });

  it('names the known providers when asked for an unknown one', () => {
    const reg = new ProviderRegistry({ env: {} });
    expect(() => reg.resolve('nope/x')).toThrow(/Known providers/);
  });

  it('reuses one provider instance per endpoint', () => {
    const reg = new ProviderRegistry({ env: { DEEPSEEK_API_KEY: 'sk-x' } });
    expect(reg.resolve('deepseek/a').provider).toBe(reg.resolve('deepseek/b').provider);
  });

  it('applies capability overrides from settings', () => {
    const reg = new ProviderRegistry({
      env: {},
      settings: { capabilities: { 'ollama/*': { contextWindow: 131_072 } } },
    });
    expect(reg.resolve('ollama/qwen3').capabilities.contextWindow).toBe(131_072);
  });

  it('gives every built-in provider a base URL', () => {
    for (const [id, cfg] of Object.entries(BUILTIN_PROVIDERS)) {
      expect(cfg.baseUrl, id).toMatch(/^https?:\/\//);
      expect(cfg.label, id).toBeTruthy();
    }
  });
});

describe('resolveCapabilities', () => {
  it('turns on text-channel tool call salvage for DeepSeek models behind any provider', () => {
    expect(resolveCapabilities('deepseek', 'deepseek-flash').textToolCallSalvage).toBe(true);
    expect(resolveCapabilities('openrouter', 'deepseek/deepseek-v4-flash').textToolCallSalvage).toBe(true);
    expect(resolveCapabilities('vllm', 'deepseek-ai/DeepSeek-V4-Flash').textToolCallSalvage).toBe(true);
    expect(resolveCapabilities('openai', 'gpt-5').textToolCallSalvage).toBeUndefined();
  });

  it('marks DeepSeek V4 models as supporting a reasoning channel', () => {
    // Thinking is an effort level (low/high/max) on deepseek-v4-pro/-flash
    // rather than a separate reasoning-only model id, unlike the retired
    // deepseek-reasoner, which rejected temperature and parallel tool calls.
    expect(resolveCapabilities('deepseek', 'deepseek-v4-pro').reasoning).toBe(true);
    expect(resolveCapabilities('deepseek', 'deepseek-v4-flash').reasoning).toBe(true);
  });

  it('gives deepseek-flash the V4.1 envelope, and its alias the same one', () => {
    const flash = resolveCapabilities('deepseek', 'deepseek-flash');
    expect(flash.contextWindow).toBe(1_000_000);
    expect(flash.maxOutputTokens).toBe(384_000);
    // The picker shows the whole ladder; `effortMap` folds it onto low/high/max.
    expect(flash.effortLevels).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    expect(flash.defaultEffort).toBe('high');
    expect(flash.reasoningReplay).toBe('text');
    // `deepseek-v4-flash` is DeepSeek's transitional alias for the same model.
    expect(resolveCapabilities('deepseek', 'deepseek-v4-flash')).toEqual(flash);
  });

  it('keeps an unrecognized DeepSeek id on the V4 provider defaults', () => {
    const caps = resolveCapabilities('deepseek', 'deepseek-v5-something');
    expect(caps.reasoning).toBe(true);
    expect(caps.contextWindow).toBe(1_000_000);
    expect(caps.reasoningReplay).toBe('text');
  });

  it('knows local runtimes do not report streamed usage', () => {
    expect(resolveCapabilities('ollama', 'qwen2.5-coder:7b').streamUsage).toBe(false);
    expect(resolveCapabilities('llamacpp', 'anything').nativeTools).toBe(false);
  });

  it('layers overrides most-specific last', () => {
    const caps = resolveCapabilities('ollama', 'qwen3', {
      '*': { contextWindow: 1 },
      'ollama/*': { contextWindow: 2 },
      'ollama/qwen3': { contextWindow: 3 },
    });
    expect(caps.contextWindow).toBe(3);
  });

  it('falls back to safe defaults for an unknown endpoint', () => {
    const caps = resolveCapabilities('my-proxy', 'mystery-model');
    expect(caps.nativeTools).toBe(true);
    expect(caps.contextWindow).toBeGreaterThan(0);
  });

  it('enables allowed_tools tool_choice only on OpenAI, not DeepSeek', () => {
    expect(resolveCapabilities('openai', 'gpt-4o').allowedToolsChoice).toBe(true);
    expect(resolveCapabilities('deepseek', 'deepseek-v4-flash').allowedToolsChoice).toBeFalsy();
  });
});

describe('estimateCostUSD', () => {
  it('bills cached input at the cached rate', () => {
    const pricing = { inputPerMTok: 1, outputPerMTok: 2, cachedInputPerMTok: 0.1 };
    const cost = estimateCostUSD(
      { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 900_000 },
      pricing,
    );
    // 100k fresh at $1/M + 900k cached at $0.10/M
    expect(cost).toBeCloseTo(0.1 + 0.09, 6);
  });

  it('returns undefined when pricing is unknown', () => {
    expect(
      estimateCostUSD({ inputTokens: 10, outputTokens: 10, cachedInputTokens: 0 }, undefined),
    ).toBeUndefined();
  });

  it('picks the off-peak rates outside the provider peak window', () => {
    const pricing = {
      inputPerMTok: 1,
      outputPerMTok: 2,
      offPeak: { inputPerMTok: 0.5, outputPerMTok: 1 },
    };
    const usage = { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 0 };
    // DeepSeek peak: Mon–Fri 01:00–04:00 and 06:00–10:00 UTC.
    const wedPeak = new Date('2026-09-16T02:00:00Z');
    const wedOffPeak = new Date('2026-09-16T05:00:00Z');
    const satSameHour = new Date('2026-09-19T02:00:00Z');
    expect(estimateCostUSD(usage, pricing, wedPeak)).toBeCloseTo(1, 6);
    expect(estimateCostUSD(usage, pricing, wedOffPeak)).toBeCloseTo(0.5, 6);
    expect(estimateCostUSD(usage, pricing, satSameHour)).toBeCloseTo(0.5, 6);
  });
});

describe('mapEffort', () => {
  it("sends DeepSeek's published mapping for every level the user can pick", () => {
    // api-docs.deepseek.com/zh-cn/guides/thinking_mode — request effort → actual effort.
    const table = {
      minimal: 'low',
      low: 'low',
      medium: 'high',
      high: 'high',
      xhigh: 'high',
      max: 'max',
      ultra: 'max',
    } as const;
    for (const model of ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-other']) {
      const caps = resolveCapabilities('deepseek', model);
      expect(caps.effortLevels).toEqual(Object.keys(table));
      for (const [picked, sent] of Object.entries(table)) {
        expect(mapEffort(picked as keyof typeof table, caps)).toBe(sent);
      }
    }
  });

  it('folds a level outside the declared subset onto the nearest one, ties to the smarter', () => {
    const subset = { effortLevels: ['low', 'high', 'max'] } as const;
    expect(mapEffort('minimal', subset)).toBe('low');
    expect(mapEffort('low', subset)).toBe('low');
    expect(mapEffort('medium', subset)).toBe('high');
    expect(mapEffort('high', subset)).toBe('high');
    expect(mapEffort('xhigh', subset)).toBe('max');
    expect(mapEffort('max', subset)).toBe('max');
    expect(mapEffort('ultra', subset)).toBe('max');
  });

  it('prefers the model\'s explicit map over the nearest-level fold', () => {
    const caps = { effortLevels: ['low', 'high', 'max'], effortMap: { xhigh: 'high' } } as const;
    expect(mapEffort('xhigh', caps)).toBe('high');
    // No entry for medium: falls through to the fold.
    expect(mapEffort('medium', caps)).toBe('high');
  });

  it('passes the level through when a model declares no subset', () => {
    expect(mapEffort('medium', {})).toBe('medium');
  });

  it('does not offer ultra where no provider publishes it', () => {
    expect(resolveCapabilities('openai', 'gpt-5').effortLevels).toBeUndefined();
    expect(DEFAULT_REASONING_EFFORTS).not.toContain('ultra');
  });
});

describe('effortOptions', () => {
  it('offers nothing on a model without reasoning, whatever was preferred', () => {
    expect(effortOptions({ reasoning: false }, 'high')).toEqual({ levels: [], initial: undefined });
  });

  it("starts at the preferred level, else the model's default, else high", () => {
    const deepseek = resolveCapabilities('deepseek', 'deepseek-flash');
    expect(effortOptions(deepseek).levels).toContain('ultra');
    expect(effortOptions(deepseek).initial).toBe('high');
    expect(effortOptions(deepseek, 'max').initial).toBe('max');
    expect(effortOptions({ reasoning: true })).toEqual({ levels: DEFAULT_REASONING_EFFORTS, initial: 'high' });
  });
});

describe('modelEffort', () => {
  it('answers for a ref without credentials, honouring settings', () => {
    const none = new ProviderRegistry({ env: {} });
    expect(() => none.resolve('deepseek/deepseek-flash')).toThrow(); // no key
    expect(modelEffort('deepseek/deepseek-flash', {}).levels).toHaveLength(7);
    expect(modelEffort('deepseek/deepseek-flash', { reasoningEffort: 'low' }).initial).toBe('low');
    expect(modelEffort('moonshot/kimi-k2', {})).toEqual({ levels: [], initial: undefined });
    expect(
      modelEffort('local/thinker', { capabilities: { 'local/thinker': { reasoning: true, defaultEffort: 'medium' } } }),
    ).toEqual({ levels: DEFAULT_REASONING_EFFORTS, initial: 'medium' });
  });
});
