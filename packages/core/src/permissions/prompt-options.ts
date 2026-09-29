/**
 * The choices a person is offered when a tool call or a plan needs approval.
 * One list, shared by every interactive frontend (the TUI's option menu and the
 * REPL's), so they read and number the same way.
 */

import type { PermissionMode } from './types.js';
import { planApprovalLabel } from './cycle.js';
import type { AlwaysAllow } from './always-allow.js';

export interface PromptOption<V extends string = string> {
  value: V;
  label: string;
  /** Dim text after the label, e.g. `(esc)`. */
  hint?: string;
  /** The row doubles as a text field: the person types their reason into it. */
  input?: boolean;
}

export type AskChoice = 'once' | 'always' | 'auto' | 'deny';
export type PlanChoice = 'yes' | 'manual' | 'no';

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * How a tool is named in a prompt: builtins capitalized ("Bash"), namespaced
 * MCP names (`mcp__linear__list_issues`) left exactly as they are.
 */
export function toolDisplayName(toolName: string): string {
  return toolName.includes('__') ? toolName : capitalize(toolName);
}

/**
 * Options for a tool-permission prompt. `always` is what "don't ask again"
 * would cover (an {@link AlwaysAllow} label); without one the row is left out.
 */
export function askOptions(opts: { always?: string | undefined; offerAuto?: boolean }): PromptOption<AskChoice>[] {
  return [
    { value: 'once', label: 'Yes' },
    ...(opts.always !== undefined
      ? [{ value: 'always' as const, label: `Yes, and don't ask again for ${opts.always} this session` }]
      : []),
    ...(opts.offerAuto
      ? [{ value: 'auto' as const, label: 'Yes, and switch to auto mode' }]
      : []),
    {
      value: 'deny',
      label: 'No, and tell the agent what to do differently',
      hint: '(esc)',
      input: true,
    },
  ];
}

/** Options for a plan-approval prompt; `yesMode` is the mode approving lands in. */
export function planOptions(yesMode: PermissionMode): PromptOption<PlanChoice>[] {
  return [
    { value: 'yes', label: capitalize(planApprovalLabel(yesMode)) },
    // When approving already lands in `ask`, a second "manually approve" row would repeat it.
    ...(yesMode === 'ask'
      ? []
      : [{ value: 'manual' as const, label: 'Yes, manually approve edits' }]),
    {
      value: 'no',
      label: 'No, keep planning — tell the agent what to change',
      hint: '(esc)',
      input: true,
    },
  ];
}
