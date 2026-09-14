import { describe, expect, it } from 'vitest';

import {
  critiqueUserMessage,
  customAutoModeEntries,
  formatAutoModeConfig,
  formatDefaultRules,
} from './auto-mode.js';

describe('formatDefaultRules', () => {
  it('prints every built-in group', () => {
    const text = formatDefaultRules();
    expect(text).toContain('## environment');
    expect(text).toContain('## allow');
    expect(text).toContain('## soft_deny');
    expect(text).toContain('## hard_deny');
    expect(text).toContain('Organization:');
    expect(text).toContain('Git Destructive:');
  });

  it('filters by label prefix', () => {
    const text = formatDefaultRules('Git');
    expect(text).toContain('Git Destructive:');
    expect(text).toContain('Git Push Destination:');
    expect(text).not.toContain('Organization:');
  });
});

describe('formatAutoModeConfig', () => {
  it('expands $defaults in the printed lists', () => {
    const json = formatAutoModeConfig({
      model: 'ollama/qwen',
      autoMode: { environment: ['$defaults', 'Trusted repo: git@ex.com/app.git'] },
    });
    const parsed = JSON.parse(json) as {
      environment: string[];
      usesDefaults: { environment: boolean; allow: boolean };
    };
    expect(parsed.usesDefaults.environment).toBe(true);
    expect(parsed.usesDefaults.allow).toBe(true);
    expect(parsed.environment.some((e) => e.startsWith('Organization:'))).toBe(true);
    expect(parsed.environment).toContain('Trusted repo: git@ex.com/app.git');
    expect(json).not.toContain('$defaults');
  });
});

describe('customAutoModeEntries', () => {
  it('drops $defaults and empty groups', () => {
    expect(
      customAutoModeEntries({
        environment: ['$defaults', 'Org: us'],
        allow: ['$defaults'],
        hard_deny: ['Never: do this'],
      }),
    ).toEqual([
      { group: 'environment', entries: ['Org: us'] },
      { group: 'hard_deny', entries: ['Never: do this'] },
    ]);
  });
});

describe('critiqueUserMessage', () => {
  it('renders groups as markdown lists', () => {
    expect(critiqueUserMessage([{ group: 'allow', entries: ['Local: ok'] }])).toContain('## allow');
    expect(critiqueUserMessage([{ group: 'allow', entries: ['Local: ok'] }])).toContain('- Local: ok');
  });
});
