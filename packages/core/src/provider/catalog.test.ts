import { describe, expect, it } from 'vitest';

import { MODEL_CATALOG, describeModel, offeredModels } from './catalog.js';
import { ProviderRegistry } from './router.js';

describe('offeredModels', () => {
  it('puts the default first, then settings, then the lineup, without repeats', () => {
    expect(
      offeredModels({
        defaultModel: 'openai/gpt-5',
        models: ['moonshot/kimi-k2', ' openai/gpt-5 ', ''],
        smallModel: 'deepseek/deepseek-flash',
      }),
    ).toEqual(['openai/gpt-5', 'moonshot/kimi-k2', 'deepseek/deepseek-flash', ...MODEL_CATALOG.slice(1)]);
  });
});

describe('describeModel', () => {
  it('reads windows, effort and price from the capability table', () => {
    const registry = new ProviderRegistry({ env: { DEEPSEEK_API_KEY: 'k' } });
    const info = describeModel('deepseek/deepseek-flash', {}, registry);
    expect(info).toMatchObject({
      ref: 'deepseek/deepseek-flash',
      contextWindow: 1_000_000,
      qualityContextWindow: 256_000,
      defaultEffort: 'high',
      pricing: { inputPerMTok: 0.3 },
    });
    expect(info.effortLevels).toContain('ultra');
    expect(info.problem).toBeUndefined();
  });

  it('says which DeepSeek model sees images: flash does, pro does not', () => {
    const registry = new ProviderRegistry({ env: { DEEPSEEK_API_KEY: 'k' } });
    expect(describeModel('deepseek/deepseek-flash', {}, registry).vision).toBe(true);
    expect(describeModel('deepseek/deepseek-v4-flash', {}, registry).vision).toBe(true);
    expect(describeModel('deepseek/deepseek-v4-pro', {}, registry).vision).toBeUndefined();
  });

  it('says why a model cannot run, without failing', () => {
    const registry = new ProviderRegistry({ env: {} });
    expect(describeModel('deepseek/deepseek-flash', {}, registry).problem).toMatch(/DEEPSEEK_API_KEY/);
    expect(describeModel('nowhere/model', {}, registry).problem).toMatch(/Unknown provider/);
    expect(describeModel('openai/gpt-4o', {}, registry)).toMatchObject({ effortLevels: [], contextWindow: 128_000 });
  });
});
