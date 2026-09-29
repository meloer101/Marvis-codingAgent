import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from 'ink-testing-library';

import type { ReasoningEffort } from '@harness-code/core';

import { EffortPicker } from './EffortPicker.js';
import { DARK } from '../theme.js';

afterEach(cleanup);

// DeepSeek's picker: the whole ladder the user sees, not the three it sends.
const LADDER: readonly ReasoningEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

describe('EffortPicker', () => {
  it('lays the full seven-level ladder out on one row', () => {
    const frame = render(<EffortPicker value="xhigh" levels={LADDER} theme={DARK} />).lastFrame() ?? '';
    const row = frame.split('\n').find((l) => l.includes('minimal'));
    expect(row).toBeDefined();
    for (const level of LADDER) expect(row).toContain(level);
  });
});
