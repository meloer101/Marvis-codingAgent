/**
 * Verify-before-stop: the first time a run that changed something is about to
 * end, send the model back once to check its work against the task as stated.
 *
 * In the 2026-09 Terminal-Bench run every agent failure was the model declaring
 * itself done, and 8 of 18 were done without adequate checking: output correct
 * but a format rule the task spelled out left unmet, a "doesn't change clean
 * input" check run on one sample, a deliverable never executed because no
 * engine was installed, a threshold cleared by a hair on the agent's own split.
 * The model had verified *something* each time — its own idea of the task. This
 * gate points it back at the user's words (hermes-agent's `verification_stop`
 * is the same idea).
 *
 * Stateless: whether this run was already gated is read off the history — the
 * latest non-tool-result user message is either the user's request or this
 * gate's own prompt. Runs that only read or answered are left alone.
 */

import type { Message } from '../provider/types.js';
import type { AgentHooks } from './hooks.js';

export const VERIFY_STOP_MARKER = '[verify before finishing]';

/** Tools whose use means the run changed something worth checking. */
const CHANGING_TOOLS = new Set(['write', 'edit', 'bash']);

export const VERIFY_STOP_PROMPT = `${VERIFY_STOP_MARKER} Before you finish, check the result against the task as the user stated it, not only against your own tests.
1. Re-read the request and list every explicit requirement: files and paths to produce, formats and exact syntax, names and signatures, numeric thresholds, constraints on method or tools, and anything that must stay unchanged.
2. For each one, point to evidence from this session that it holds (a command you ran and what it printed), or check it now. A test you wrote covers only the cases it tests; a threshold met by a small margin on your own data is not met.
3. If a requirement can't be checked because a tool is missing, get one (install it, or write a small checker) rather than reasoning it through.
Fix whatever fails. Then give your final answer; if everything already held, say so in a line or two with the evidence.`;

function isToolResultMessage(m: Message): boolean {
  return m.role === 'user' && m.content.some((b) => b.type === 'tool_result');
}

/**
 * The index of the message that opened this run's task — the latest user
 * message that is not a tool result — or -1 when there is none.
 */
function taskStart(messages: readonly Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'user' && !isToolResultMessage(m)) return i;
  }
  return -1;
}

export function createVerifyBeforeStopHooks(): AgentHooks {
  return {
    onBeforeStop(_finalMessage, ctx) {
      const start = taskStart(ctx.messages);
      if (start === -1) return undefined;
      const opener = ctx.messages[start]!;
      const openerText = opener.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
      // Already sent back once for this task.
      if (openerText.startsWith(VERIFY_STOP_MARKER)) return undefined;
      const changed = ctx.messages
        .slice(start + 1)
        .some(
          (m) =>
            m.role === 'assistant' &&
            m.content.some((b) => b.type === 'tool_use' && CHANGING_TOOLS.has(b.name)),
        );
      return changed ? { continue: VERIFY_STOP_PROMPT } : undefined;
    },
  };
}
