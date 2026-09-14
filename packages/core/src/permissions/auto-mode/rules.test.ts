import { describe, expect, it } from 'vitest';

import { resolveAutoModeRules, listUsesDefaults, DEFAULT_ALLOW, DEFAULT_HARD_DENY } from './rules.js';

describe('resolveAutoModeRules', () => {
  it('uses the built-in lists when autoMode is omitted', () => {
    const resolved = resolveAutoModeRules({});
    expect(resolved.allow).toEqual([...DEFAULT_ALLOW]);
    expect(resolved.hard_deny).toEqual([...DEFAULT_HARD_DENY]);
    expect(resolved.allow.some((r) => r.startsWith('Browser'))).toBe(false);
    expect(resolved.soft_deny.some((r) => r.startsWith('Tmux') || r.startsWith('Sandbox Network'))).toBe(
      false,
    );
  });

  it('splices $defaults at the written position and replaces the group when omitted from the array', () => {
    const resolved = resolveAutoModeRules({
      autoMode: {
        allow: ['$defaults', 'Local Lab: extra allow'],
        hard_deny: ['Custom Hard: never this'],
      },
    });
    expect(resolved.allow[0]).toMatch(/^Security Discussion:/);
    expect(resolved.allow.at(-1)).toBe('Local Lab: extra allow');
    expect(resolved.allow.length).toBe(DEFAULT_ALLOW.length + 1);
    expect(resolved.hard_deny).toEqual(['Custom Hard: never this']);
    expect(listUsesDefaults(['$defaults', 'x'])).toBe(true);
    expect(listUsesDefaults(['only custom'])).toBe(false);
    expect(listUsesDefaults(undefined)).toBe(true);
  });
});
