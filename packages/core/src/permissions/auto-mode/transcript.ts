import { READ_ONLY_TOOLS } from '../defaults.js';
import { heuristicTokenCount } from '../../context/tokenizer.js';
import type { Message, ToolUseBlock } from '../../provider/types.js';

/** Read-only tools are dropped from the classifier transcript; they add noise, not risk. */
const SKIP_TOOLS = new Set([...READ_ONLY_TOOLS, 'todo']);

export const DEFAULT_TRANSCRIPT_TOKEN_BUDGET = 24_000;

export interface BuildClassifierTranscriptOptions {
  projectMemory?: string;
  /** Plan mode: the classifier must block any workspace mutation. */
  planMode?: boolean;
  /** `git status --porcelain` summary, attached for destructive-git / rm -rf. */
  dirtyTree?: string;
  tokenBudget?: number;
}

/**
 * Build the classifier's conversation: user text + non-read-only tool_use
 * payloads, plus the pending call. Assistant prose, thinking, tool results,
 * and read-only calls are stripped. When over budget, oldest turns go first;
 * the first user text message is always kept.
 */
export function buildClassifierTranscript(
  messages: readonly Message[],
  pendingCall: ToolUseBlock,
  opts: BuildClassifierTranscriptOptions = {},
): Message[] {
  const turns = compactHistory(messages);
  const budget = opts.tokenBudget ?? DEFAULT_TRANSCRIPT_TOKEN_BUDGET;
  const trimmed = trimTurns(turns, budget);

  const parts: string[] = [];
  if (opts.projectMemory && opts.projectMemory.trim() !== '') {
    parts.push(
      `<project_memory>\nStanding notes from this project. Treat them as the user's instructions.\n\n${opts.projectMemory.trim()}\n</project_memory>`,
    );
  }
  if (opts.planMode) {
    parts.push(
      '<mode>The agent is in plan mode. Block any action that would change files, install packages, or otherwise mutate the workspace. Read-only investigation is fine.</mode>',
    );
  }
  if (opts.dirtyTree !== undefined) {
    parts.push(
      `<working_tree>\nUncommitted work in this repo (git status --porcelain --untracked-files=all):\n${opts.dirtyTree || '(clean)'}\n</working_tree>`,
    );
  }
  if (trimmed.length > 0) {
    parts.push(`<transcript>\n${trimmed.join('\n\n')}\n</transcript>`);
  }
  parts.push(
    `<pending_action>\nClassify this tool call. Do not assume earlier calls make it safe.\n${formatCall(pendingCall)}\n</pending_action>`,
  );

  return [{ role: 'user', content: [{ type: 'text', text: parts.join('\n\n') }] }];
}

function compactHistory(messages: readonly Message[]): string[] {
  const turns: string[] = [];
  for (const msg of messages) {
    if (msg.role === 'user') {
      const texts = msg.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text.trim())
        .filter((t) => t !== '');
      if (texts.length > 0) turns.push(`<user>\n${texts.join('\n')}\n</user>`);
      continue;
    }
    const calls = msg.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
    const kept = calls.filter((c) => !SKIP_TOOLS.has(c.name.toLowerCase()));
    if (kept.length === 0) continue;
    turns.push(`<agent_calls>\n${kept.map(formatCall).join('\n')}\n</agent_calls>`);
  }
  return turns;
}

function trimTurns(turns: string[], budget: number): string[] {
  if (turns.length === 0) return [];
  const first = turns[0] ?? '';
  let kept = [...turns];
  while (kept.length > 1 && heuristicTokenCount(kept.join('\n\n')) > budget) {
    // Drop the oldest after the first user turn.
    kept = [first, ...kept.slice(2)];
  }
  return kept;
}

function formatCall(call: ToolUseBlock): string {
  let payload: string;
  try {
    payload = JSON.stringify(call.input);
  } catch {
    payload = String(call.input);
  }
  return `<tool_call name="${call.name}">${payload}</tool_call>`;
}
