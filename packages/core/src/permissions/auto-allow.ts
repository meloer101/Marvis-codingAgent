import type { PermissionRule } from './types.js';

/**
 * Allow rules that are too coarse to keep once auto mode's classifier is
 * reviewing commands. Filtered at evaluate-time; the stored list is unchanged.
 */
const INTERPRETER = /^(python[0-9.]*|node(js)?|ruby|perl|php|lua|sh|bash|zsh|dash|ksh)(\*|:\*)?$/i;
const PKG_RUN = /^(npm|pnpm|yarn|bun)(\s+run)(:\*|\*|$)/i;
const MAKE = /^make(\*|:\*|:|\s|$)/i;

export function isDroppedAutoAllow(rule: PermissionRule, classifyAllShell: boolean): boolean {
  if (rule.tool === 'task') return true;
  if (rule.tool !== 'bash') return false;
  if (classifyAllShell) return true;
  if (rule.pattern === undefined || rule.pattern === '*') return true;
  const pattern = rule.pattern;
  if (INTERPRETER.test(pattern)) return true;
  if (PKG_RUN.test(pattern)) return true;
  if (MAKE.test(pattern)) return true;
  return false;
}
