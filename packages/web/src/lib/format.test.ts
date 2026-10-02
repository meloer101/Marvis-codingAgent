import { describe, expect, it } from 'vitest';

import { bashOutcome, fmtDuration } from './format';

describe('fmtDuration', () => {
  it('reads as ms, seconds, then minutes', () => {
    expect([340, 2_430, 65_000].map(fmtDuration)).toEqual(['340ms', '2.4s', '1m 05s']);
  });
});

describe('bashOutcome', () => {
  it('takes the exit code or timeout off the end of a bash result', () => {
    expect(bashOutcome('boom\n[exit code 2]')).toEqual({ output: 'boom', exitCode: 2 });
    expect(bashOutcome('\n[command timed out after 100ms]')).toEqual({ output: '', timedOut: true });
    expect(bashOutcome('all good\n')).toEqual({ output: 'all good\n' });
    expect(bashOutcome('Could not run command: ENOENT')).toEqual({ output: 'Could not run command: ENOENT' });
  });
});
