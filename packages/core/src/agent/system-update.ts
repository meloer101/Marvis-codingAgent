/**
 * Mid-session system-prompt changes, expressed as a delta.
 *
 * The system prompt is not static: the mode block appears and disappears,
 * skills load, memory changes. Rewriting the head to say so is correct but
 * expensive — the head anchors the prompt cache, so changing it re-processes
 * the entire conversation behind it. Models that read the *last* system
 * message (`capabilities.systemPromptUpdate === 'in-history'`) can be told
 * about the change further down instead.
 *
 * What to put in that message is the part worth getting right. Measured on
 * DeepSeek flash (`scripts/deepseek-probe.mjs` probe 6), for one turn after a
 * mode switch:
 *
 *   history   rewrite head   append whole prompt   append only the delta
 *   short     $0.000097      $0.000275             $0.000040
 *   long      $0.000515      $0.000279             $0.000045
 *
 * Appending the whole prompt duplicates it in the context and is *worse* than
 * rewriting on a short history. Appending only the segments that changed is
 * ~2x cheaper than rewriting on a short history and ~11x on a long one, which
 * is what this module builds.
 */

import type { SystemSegment } from '../provider/types.js';

/** Opens the update so the model reads it as an amendment, not a second brief. */
const HEADER =
  '[system update] The following supersedes the correspondingly-named sections of the ' +
  'system prompt above. Everything not mentioned here still applies.';

/**
 * The segments to append so that `head` plus the result means the same as
 * `current`. Returns `undefined` when the two already agree — the common case,
 * and the one where nothing should be sent.
 *
 * A segment that disappeared (leaving plan mode drops `plan_mode`) cannot be
 * un-said by omission, so it is cancelled explicitly.
 */
export function systemUpdateSegments(
  head: readonly SystemSegment[],
  current: readonly SystemSegment[],
): SystemSegment[] | undefined {
  const headById = new Map(head.map((s) => [s.id, s.text]));
  const currentIds = new Set(current.map((s) => s.id));

  const changed = current.filter((s) => headById.get(s.id) !== s.text);
  const dropped = head.filter((s) => !currentIds.has(s.id));
  if (changed.length === 0 && dropped.length === 0) return undefined;

  const parts: SystemSegment[] = [{ id: 'system_update', text: HEADER }];
  for (const seg of changed) parts.push({ id: seg.id, text: seg.text });
  for (const seg of dropped) {
    parts.push({
      id: `${seg.id}_removed`,
      text: `The "${seg.id}" section above no longer applies. Disregard it entirely.`,
    });
  }
  return parts;
}
