import type { PermissionMode } from './types.js';

export interface ModeCycleOptions {
  /** Include `yolo` only when the session started in yolo. */
  includeYolo?: boolean;
  /** Include `auto` when the classifier is available. */
  includeAuto?: boolean;
}

/**
 * Shift+Tab order: ask → acceptEdits → plan → [yolo] → [auto] → ask.
 * Auto is last so one press from auto returns to ask.
 */
export function permissionModeCycle(opts: ModeCycleOptions = {}): PermissionMode[] {
  const cycle: PermissionMode[] = ['ask', 'acceptEdits', 'plan'];
  if (opts.includeYolo) cycle.push('yolo');
  if (opts.includeAuto) cycle.push('auto');
  return cycle;
}

export function nextPermissionMode(
  current: PermissionMode,
  opts: ModeCycleOptions = {},
): PermissionMode {
  const cycle = permissionModeCycle(opts);
  const i = cycle.indexOf(current);
  if (i === -1) return 'ask';
  return cycle[(i + 1) % cycle.length] ?? 'ask';
}

/** Whether the permission prompt should offer “yes, and switch to auto mode”. */
export function offerAutoSwitch(opts: {
  mode: PermissionMode;
  autoAvailable: boolean;
  toolName: string;
  forcedByRule?: boolean;
}): boolean {
  if (!opts.autoAvailable) return false;
  if (opts.mode !== 'ask' && opts.mode !== 'acceptEdits') return false;
  if (opts.toolName.toLowerCase() !== 'bash') return false;
  if (opts.forcedByRule) return false;
  return true;
}

/** Default destination for “[y] approve plan” when the user has not set planApprovedMode. */
export function defaultPlanYesMode(autoAvailable: boolean): PermissionMode {
  return autoAvailable ? 'auto' : 'acceptEdits';
}
