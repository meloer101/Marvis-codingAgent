import { describe, expect, it } from 'vitest';

import { systemUpdateSegments } from './system-update.js';

const seg = (id: string, text: string) => ({ id, text });

describe('systemUpdateSegments', () => {
  it('says nothing when the prompt has not changed', () => {
    const head = [seg('identity', 'You are hc.'), seg('environment', 'cwd: /w')];
    expect(systemUpdateSegments(head, [...head])).toBeUndefined();
  });

  it('carries only the segments that changed, not the whole prompt', () => {
    const head = [seg('identity', 'You are hc.'), seg('environment', 'cwd: /w')];
    const current = [seg('identity', 'You are hc.'), seg('environment', 'cwd: /other')];

    const update = systemUpdateSegments(head, current);

    expect(update?.map((s) => s.id)).toEqual(['system_update', 'environment']);
    expect(update?.map((s) => s.text).join('\n')).toContain('cwd: /other');
    expect(update?.map((s) => s.text).join('\n')).not.toContain('You are hc.');
  });

  it('appends a section that appeared', () => {
    const head = [seg('identity', 'You are hc.')];
    const current = [seg('identity', 'You are hc.'), seg('plan_mode', 'Plan only.')];

    expect(systemUpdateSegments(head, current)?.map((s) => s.id)).toEqual([
      'system_update',
      'plan_mode',
    ]);
  });

  it('cancels a section that disappeared — omission cannot un-say it', () => {
    const head = [seg('identity', 'You are hc.'), seg('plan_mode', 'Plan only. Never write.')];
    const current = [seg('identity', 'You are hc.')];

    const update = systemUpdateSegments(head, current);

    expect(update?.map((s) => s.id)).toEqual(['system_update', 'plan_mode_removed']);
    const text = update?.map((s) => s.text).join('\n') ?? '';
    expect(text).toContain('"plan_mode"');
    expect(text).toContain('no longer applies');
  });
});
