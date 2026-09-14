import { describe, expect, it } from 'vitest';

import { emptyUsage } from '../../provider/types.js';
import { applySubagentReview, SUBAGENT_UNREVIEWED } from './review.js';

describe('applySubagentReview', () => {
  const usage = emptyUsage();

  it('prepends a flag when the classifier blocks the return', () => {
    const out = applySubagentReview('all good', {
      decision: 'deny',
      label: 'Remote Repoint',
      reason: 'pushed to a new remote',
      usage,
      countsTowardThreshold: true,
    }, 'explore');
    expect(out).toMatch(/^\[security warning: sub-agent "explore"/);
    expect(out).toContain('[Remote Repoint]');
    expect(out).toContain('all good');
  });

  it('marks the report untrusted when review itself failed', () => {
    const out = applySubagentReview('body', {
      decision: 'deny',
      reason: 'auto mode cannot determine the safety of this action (scripted/x: boom)',
      usage,
      countsTowardThreshold: false,
    }, 'explore');
    expect(out.startsWith(SUBAGENT_UNREVIEWED)).toBe(true);
    expect(out).toContain('body');
  });

  it('leaves an allowed report unchanged', () => {
    expect(
      applySubagentReview('body', {
        decision: 'allow',
        reason: 'ok',
        usage,
        countsTowardThreshold: false,
      }, 'explore'),
    ).toBe('body');
  });
});
