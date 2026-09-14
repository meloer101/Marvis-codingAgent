import { describe, expect, it } from 'vitest';

import {
  defaultPlanYesMode,
  nextPermissionMode,
  offerAutoSwitch,
  permissionModeCycle,
} from './cycle.js';

describe('permissionModeCycle', () => {
  it('is ask → acceptEdits → plan when auto and yolo are off', () => {
    expect(permissionModeCycle()).toEqual(['ask', 'acceptEdits', 'plan']);
    expect(nextPermissionMode('ask')).toBe('acceptEdits');
    expect(nextPermissionMode('acceptEdits')).toBe('plan');
    expect(nextPermissionMode('plan')).toBe('ask');
  });

  it('puts auto last so one press from auto returns to ask', () => {
    const cycle = permissionModeCycle({ includeAuto: true });
    expect(cycle).toEqual(['ask', 'acceptEdits', 'plan', 'auto']);
    expect(nextPermissionMode('auto', { includeAuto: true })).toBe('ask');
  });

  it('inserts yolo before auto when the session started in yolo', () => {
    expect(permissionModeCycle({ includeYolo: true, includeAuto: true })).toEqual([
      'ask',
      'acceptEdits',
      'plan',
      'yolo',
      'auto',
    ]);
    expect(nextPermissionMode('plan', { includeYolo: true, includeAuto: false })).toBe('yolo');
    expect(nextPermissionMode('yolo', { includeYolo: true, includeAuto: true })).toBe('auto');
  });

  it('drops out-of-cycle modes (readOnly) back to ask', () => {
    expect(nextPermissionMode('readOnly', { includeAuto: true })).toBe('ask');
  });
});

describe('offerAutoSwitch', () => {
  const base = { mode: 'ask' as const, autoAvailable: true, toolName: 'bash' };

  it('is offered for bash in ask/acceptEdits when auto is available and not forced', () => {
    expect(offerAutoSwitch(base)).toBe(true);
    expect(offerAutoSwitch({ ...base, mode: 'acceptEdits' })).toBe(true);
  });

  it('is hidden when auto is off, the tool is not bash, or an ask rule forced the prompt', () => {
    expect(offerAutoSwitch({ ...base, autoAvailable: false })).toBe(false);
    expect(offerAutoSwitch({ ...base, toolName: 'write' })).toBe(false);
    expect(offerAutoSwitch({ ...base, forcedByRule: true })).toBe(false);
    expect(offerAutoSwitch({ ...base, mode: 'plan' })).toBe(false);
    expect(offerAutoSwitch({ ...base, mode: 'auto' })).toBe(false);
  });
});

describe('defaultPlanYesMode', () => {
  it('uses auto when available, otherwise acceptEdits', () => {
    expect(defaultPlanYesMode(true)).toBe('auto');
    expect(defaultPlanYesMode(false)).toBe('acceptEdits');
  });
});
