import { describe, expect, it } from 'vitest';

import { AutoModeState, CONSECUTIVE_DENY_LIMIT, CUMULATIVE_DENY_LIMIT } from './state.js';

function denial(id: string) {
  return { id, toolName: 'bash', input: { command: id }, reason: 'nope', at: 0 };
}

describe('AutoModeState', () => {
  it('pauses after three consecutive counted denials and resumes on approval', () => {
    const s = new AutoModeState();
    expect(s.recordDenial(denial('a'))).toBe('ok');
    expect(s.recordDenial(denial('b'))).toBe('ok');
    expect(s.recordDenial(denial('c'))).toBe('pause');
    expect(s.paused).toBe(true);
    expect(s.consecutiveDenials).toBe(0);
    expect(s.cumulativeDenials).toBe(CONSECUTIVE_DENY_LIMIT);
    s.resumeFromApproval();
    expect(s.paused).toBe(false);
    expect(s.consecutiveDenials).toBe(0);
  });

  it('clears the consecutive count on any allow, and clears cumulative only when that threshold trips', () => {
    const s = new AutoModeState();
    s.recordDenial(denial('a'));
    s.recordAllow();
    expect(s.consecutiveDenials).toBe(0);
    expect(s.cumulativeDenials).toBe(1);
    s.recordDenial(denial('b'));
    expect(s.consecutiveDenials).toBe(1);
    expect(s.cumulativeDenials).toBe(2);
  });

  it('pauses at 20 cumulative denials and zeros that counter', () => {
    const s = new AutoModeState();
    for (let i = 0; i < CUMULATIVE_DENY_LIMIT - 1; i++) {
      s.recordAllow();
      expect(s.recordDenial(denial(String(i)))).toBe('ok');
    }
    expect(s.recordDenial(denial('last'))).toBe('pause');
    expect(s.paused).toBe(true);
    expect(s.cumulativeDenials).toBe(0);
  });
});
