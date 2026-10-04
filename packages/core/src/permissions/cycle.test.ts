import { describe, expect, it } from 'vitest';

import {
  defaultPlanYesMode,
  nextPermissionMode,
  permissionModeCycle,
  planApprovalLabel,
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

describe('defaultPlanYesMode', () => {
  it('uses auto when available, otherwise acceptEdits', () => {
    expect(defaultPlanYesMode(true)).toBe('auto');
    expect(defaultPlanYesMode(false)).toBe('acceptEdits');
  });
});

describe('planApprovalLabel', () => {
  it('names the mode approval actually switches to', () => {
    expect(planApprovalLabel('auto')).toBe('yes, and use auto mode');
    expect(planApprovalLabel('acceptEdits')).toBe('yes, auto-accept edits');
    expect(planApprovalLabel('ask')).toBe('yes, manually approve edits');
    expect(planApprovalLabel('yolo')).toMatch(/yolo/);
    expect(planApprovalLabel('readOnly')).toBe('yes, and switch to readOnly mode');
  });
});
